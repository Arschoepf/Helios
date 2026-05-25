//Card initialization subsystem: pure helpers for resolving the
//home coordinates and hashing the visual config, plus the engine
//bootstrap path (debounce wrapper + immediate construction) and
//the visibility observer that pauses animations when the card
//scrolls offscreen.
//
//LitElement lifecycle hooks (setConfig, connectedCallback,
//disconnectedCallback, updated) stay on the card class itself
//because HA + Lit invoke them directly on the element; they
//delegate the meaty work to the helpers here.

import type { HeliosConfig } from '../helios-config';
import { HeliosEngine } from '../helios-engine';
import { refreshOverlays, setAnimationsPaused, type OverlaysHost } from './overlays';
import { refreshShadingDomeScene, type ShadingDomeHost } from './shadingDome';
import type { ChartSeries } from './charts';


//Visual config keys that the engine reacts to via updateConfig().
//Anything outside this list (e.g. home coords, which is an identity
//input handled separately) is irrelevant for live updates.
export const VISUAL_CONFIG_KEYS = [
    'show-labels',
    'sun-color',
    'cloud-color',
    //pv-color is card-level; included so the sig changes and Lit
    //re-renders the chart. pv-power-entity triggers a fresh fetch.
    'pv-color',
    'pv-power-entity',
    //map-style triggers a MapLibre setStyle(), the engine reloads
    //the cloud disc, buildings and labels on the resulting
    //`style.load`.
    'map-style',
    'battery-soc-entity',
    'battery-power-entity',
    'battery-color',
    //solar-radiation-entity, when set, feeds the engine sensor
    //samples that override Open-Meteo for the live + past
    //irradiance values. A change must refresh the engine so
    //the override (or its absence) is picked up immediately.
    'solar-radiation-entity',
    //card-theme is card-level (light/dark skin) but must be in the
    //sig so Lit re-renders when the user toggles it.
    'card-theme',
    //building-radius / cluster-radius invalidate cache and refetch;
    //opacity / color are cheap paint-property updates.
    'building-radius',
    'building-cluster-radius',
    'building-opacity',
    'building-color',
    'pixel-ratio',
    //lidar-local-ndsm-*: the 6 BYO-LiDAR keys. Any change must
    //invalidate the engine sig so the shadow pipeline reruns
    //against the new provider config (toggle, URL or bbox).
    'lidar-local-ndsm-enabled',
    'lidar-local-ndsm-url',
    'lidar-local-ndsm-min-lat',
    'lidar-local-ndsm-max-lat',
    'lidar-local-ndsm-min-lon',
    'lidar-local-ndsm-max-lon'
] as const;


//Debounce window before an engine is actually constructed. The
//Home Assistant dashboard editor creates a fresh helios-card
//preview instance on every config edit, often spawning many
//short-lived instances per editing session. Each one would
//instantiate a MapLibre engine and claim a WebGL context;
//Safari mobile caps active contexts at ~8 and starts recycling
//past that, causing FPS drift and the iOS black-screen lockup.
//
//The fix: defer the actual engine construction by 500 ms.
//  - A card that's destroyed inside that window never spawns
//    an engine and never holds a WebGL context.
//  - A card that survives the window (the user's actual
//    dashboard card, or the stable editor preview the user is
//    looking at) gets its engine after a barely-perceptible
//    half-second delay.
const INIT_DEBOUNCE_MS = 500;


//Defensive parser for `home-latitude` / `home-longitude` raw values
//coming out of the card config. The config is typed `unknown`, so
//bare `Number()` is unsafe: `Number('')`, `Number(false)`, `Number([])`,
//`Number(null)` all return 0, which is a finite, in-range latitude
//(Atlantic Ocean off the Gulf of Guinea) and would silently win the
//range check in getHomeCoords. Accept numbers as-is and parse
//strings that look like a decimal number; reject everything else.
function parseConfigCoord(raw: unknown): number | null
{
    if (typeof raw === 'number')
    {
        return isFinite(raw) ? raw : null;
    }
    if (typeof raw === 'string')
    {
        const trimmed = raw.trim();
        if (trimmed === '') return null;
        const n = Number(trimmed);
        return isFinite(n) ? n : null;
    }
    return null;
}


//Resolves the home coordinates. Three-tier precedence, in order:
//  1. `window.__heliosLocationOverride` , the debug helper set via
//     the global `setHeliosLocation()` console function. Highest
//     priority so a developer can always force a location regardless
//     of card config.
//  2. The card config keys `home-latitude` / `home-longitude`.
//     Applied only when BOTH parse as numbers (or numeric strings)
//     that are finite and in valid range (lat -90..90, lon
//     -180..180). Anything else , including missing, partial, the
//     empty string, booleans or arrays which `Number()` would
//     happily coerce to 0 , is silently rejected so a half-edited
//     YAML never warps the card to {0,0}.
//  3. Home Assistant's configured home at
//     hass.config.{latitude,longitude}.
//Returns null only when none of the three has a usable pair.
export function getHomeCoords(
    config: HeliosConfig | undefined,
    hass:   any
): { lat: number; lon: number } | null
{
    const w = window as unknown as { __heliosLocationOverride?: { lat: number; lon: number } };
    const o = w.__heliosLocationOverride;
    if (o && typeof o.lat === 'number' && typeof o.lon === 'number'
          && isFinite(o.lat) && isFinite(o.lon))
    {
        return { lat: o.lat, lon: o.lon };
    }

    const cfgLat = parseConfigCoord(config?.['home-latitude']);
    const cfgLon = parseConfigCoord(config?.['home-longitude']);
    if (cfgLat !== null && cfgLon !== null
        && cfgLat >= -90  && cfgLat <= 90
        && cfgLon >= -180 && cfgLon <= 180)
    {
        return { lat: cfgLat, lon: cfgLon };
    }

    const lat = hass?.config?.latitude;
    const lon = hass?.config?.longitude;
    if (typeof lat !== 'number' || typeof lon !== 'number') return null;
    return { lat, lon };
}


//Cheap stable signature of the visual config, used to skip
//updateConfig() when nothing the engine cares about has changed.
export function computeConfigSig(config: HeliosConfig | undefined): string
{
    if (!config)
    {
        return '';
    }
    return VISUAL_CONFIG_KEYS
        .map(k => `${k}=${config[k] ?? ''}`)
        .join('|');
}


//Structural surface the host card exposes to this module. Extends
//OverlaysHost so refreshOverlays(host) lands cleanly inside the
//engine onWeatherUpdate / onMapTransform callbacks; the rest is
//the engine + init lifecycle state the bootstrap mutates.
export interface InitHost extends OverlaysHost
{
    readonly config: HeliosConfig | undefined;
    readonly hass:   any;

    _engine?:            HeliosEngine;
    _fetching:           boolean;
    _cloudCover:         number;
    _timeRange:          { start: Date; end: Date } | null;
    _isLiveMode:         boolean;
    _chartSeries:        ChartSeries | null;
    _shadowBusy:         boolean;

    _lastHomeKey:        string;
    _initInflight:       boolean;
    _initDebounceTimer?: number;
    _visibilityObserver?: IntersectionObserver;

    requestUpdate(): void;
}


//IntersectionObserver hook: pause every CSS animation and every SVG
//SMIL animation when the card scrolls out of the viewport. The
//rotation loop (a requestAnimationFrame in the engine) is left
//running because (a) the browser auto-throttles rAF on hidden
//tabs and (b) the card looks alive when the user scrolls back.
//Only the SVG overlay animations are paused, they're the ones
//that run continuously regardless of map state.
export function initVisibilityObserver(host: InitHost): void
{
    if (host._visibilityObserver || typeof IntersectionObserver === 'undefined')
    {
        return;
    }
    host._visibilityObserver = new IntersectionObserver(entries =>
    {
        for (const entry of entries)
        {
            setAnimationsPaused(host, !entry.isIntersecting);
        }
    }, { threshold: 0 });
    host._visibilityObserver.observe(host as unknown as Element);
}


//Schedule an engine construction. Cancels any pending debounce so a
//fresh call restarts the 500 ms clock; the actual heavy work runs in
//initEngineNow() once the timer fires.
export function initEngine(host: InitHost): void
{
    host._initInflight = true;

    if (host._initDebounceTimer !== undefined)
    {
        window.clearTimeout(host._initDebounceTimer);
    }
    host._initDebounceTimer = window.setTimeout(() =>
    {
        host._initDebounceTimer = undefined;
        initEngineNow(host);
    }, INIT_DEBOUNCE_MS);
}


//Build the MapLibre engine and wire all the engine-side callbacks
//back into card state. Runs once per (home, identity) tuple and
//replaces any previous engine instance. Bails out early if the
//container or hass.config isn't ready yet; the caller will retry on
//the next Lit cycle when those land.
export function initEngineNow(host: InitHost): void
{
    requestAnimationFrame(() =>
    {
        const cardEl = host as unknown as { shadowRoot: ShadowRoot | null };
        const container = cardEl.shadowRoot?.getElementById('map-container') as HTMLElement | null;
        if (!container || !host.config || !host.hass?.config)
        {
            host._initInflight = false;
            return;
        }
        const coords = getHomeCoords(host.config, host.hass);
        if (!coords)
        {
            host._initInflight = false;
            return;
        }
        const { lat, lon } = coords;
        //hass.config.elevation is the user-defined home altitude
        //(metres above sea level) from HA's General settings. It
        //may be undefined on older HA installs or unconfigured
        //instances; the engine and the auxiliary fetch both
        //handle that case by simply not sending &elevation= and
        //letting Open-Meteo fall back to its own DEM.
        const elevation = host.hass.config.elevation;

        const hadPreviousEngine = host._engine !== undefined;
        host._engine?.cleanup();
        host._engine = undefined;
        //Defensive: clear anything MapLibre left in the container
        //(canvas, telemetry div, marker root). Older revisions of
        //MapLibre occasionally left a dead canvas behind, which
        //would stack a second 3D context on top of the new one.
        while (container.firstChild)
        {
            container.removeChild(container.firstChild);
        }

        const spawnNewEngine = (): void =>
        {
            //Container was checked above but the inter-frame gap
            //below could land after a card disconnect. Re-check
            //defensively so a torn-down card never spawns a new
            //engine.
            if (!host.config || !host.hass?.config)
            {
                host._initInflight = false;
                return;
            }
            host._engine = new HeliosEngine(container, host.config, [lon, lat], elevation);
            wireEngineCallbacks(host);
            host._initInflight = false;
        };

        if (hadPreviousEngine)
        {
            //Firefox's WebGL context release isn't synchronous: when
            //we call WEBGL_lose_context.loseContext() in cleanup(),
            //the context stays in Firefox's pool for one more frame.
            //If we allocate the next engine in the same tick the new
            //MapLibre instance can fail to bind a context and end up
            //rendering a black canvas. Skipping one animation frame
            //gives Firefox time to release before the new request.
            //Chrome doesn't strictly need this but the extra ~16 ms
            //is invisible to the user (the editor preview was already
            //debounced upstream).
            requestAnimationFrame(spawnNewEngine);
            return;
        }

        spawnNewEngine();
    });
}


//Wires every engine-side callback into card state. Extracted so the
//two engine-spawn paths (immediate, and rAF-deferred after a previous
//engine cleanup) can share identical wiring. Assumes host._engine has
//just been assigned and is non-null.
function wireEngineCallbacks(host: InitHost): void
{
    if (!host._engine) return;

    //Ping Lit so the chrome that depends on engine readiness
    //(today: the LiDAR View button, which gates on the provider
    //resolver via host._engine.getActiveLidarSourceId()) flips to
    //its enabled state as soon as the engine lands, instead of
    //waiting for the next clock tick to trigger an unrelated
    //re-render. The engine instance itself isn't a @state
    //property so this nudge is the only signal Lit gets that it
    //became truthy.
    host.requestUpdate();

    host._engine.onFetchStart = () =>
    {
        host._fetching = true;
    };
    host._engine.onFetchEnd = () =>
    {
        host._fetching = false;
    };
    host._engine.onWeatherUpdate = data =>
    {
        //Per-layer cloud breakdown is now owned by the engine, it
        //stashes low / mid / high alongside the effective
        //coverage and projectCloudScene reads them back to size
        //the three concentric bands. The card only needs the
        //aggregate for the cloud chip label.
        host._cloudCover         = data.cloudCover;
        host._timeRange          = data.timeRange;
        host._isLiveMode         = data.isLiveTime;
        //Pull the hourly series the chart canvas plots. Same
        //cadence as the gradients above, since both consume the
        //engine's hourly data refresh.
        host._chartSeries        = host._engine?.getTimelineSeries() ?? null;
        //First weather update is also our cue to ask the engine
        //for the initial label layout, by this point the map has
        //loaded its style and the projection matrix is available.
        //Subsequent transforms refresh via onMapTransform.
        refreshOverlays(host);
    };
    //Cloud-disc hover is wired directly on the SVG element via
    //@mousemove / @mouseleave (see the render path's solar-svg),
    //so the engine doesn't surface a hover callback for it.
    host._engine.onMapTransform = () =>
    {
        refreshOverlays(host);
        //Shading-dome re-projection mirrors what refreshOverlays
        //does for the sun arc + clouds: matrix-multiply the cached
        //cell + arc inputs through the current frame's projection.
        //Cheap enough to call unconditionally; the helper exits
        //immediately when the dome isn't active.
        refreshShadingDomeScene(host as unknown as ShadingDomeHost);
    };
    //WebGL context loss recovery, iOS Safari recycles contexts
    //under memory pressure. The engine emits this hook from its
    //webglcontextlost listener; we tear down the dead engine and
    //re-init from scratch on the next animation frame so the user
    //never sees a stuck black canvas. _lastHomeKey is reset so
    //the identity-change branch of updated() takes the re-init
    //path.
    host._engine.onContextLost = () =>
    {
        host._lastHomeKey = '';
        if (!host._initInflight) initEngine(host);
    };

    //LiDAR shadow compute: the engine fires these around its WMS
    //round-trip + raster paint pass. The card surfaces a small
    //spinner chip top-right so the user has a clear "shadows are
    //coming" signal during the few seconds the fetch takes on a
    //cold start.
    host._engine.onShadowComputeStart = () =>
    {
        host._shadowBusy = true;
    };
    host._engine.onShadowComputeEnd = () =>
    {
        host._shadowBusy = false;
    };
}
