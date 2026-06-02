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
import { refreshCloudDomeScene, type CloudDomeHost } from './cloudDome';
import type { ChartSeries } from './charts';


//Visual config keys that the engine reacts to via updateConfig(). Editing any of these from the visual editor or via the YAML hot-
//reload pushes the change into the live engine without a full respawn. Anything outside this list either does not reach the engine
//(card-only state), or is an identity input handled separately (home coords flip the engine identity through `_engineIdentitySig`).
//
//The list is exhaustive on purpose: a missing key would let a slider drag the editor exposes leave the engine on stale values until
//the next natural respawn (page reload, dashboard edit, theme flip). The colour overrides and the legacy "pv-color" / "sun-color" /
//"cloud-color" / "battery-color" / "building-color" keys are deliberately absent, those were removed from the schema and no longer
//have a runtime effect.
export const VISUAL_CONFIG_KEYS = [
    'show-labels',
    'pv-power-entity',
    //PV layout, every change must reach the engine so the per-array shading geometry, the forecast and the calibration ratio
    //recompute against the new tilt / azimuth / kWp / inverter cap.
    'pv-arrays',
    'pv-tilt',
    'pv-azimuth',
    'pv-peak-kwp',
    'pv-inverter-max-kw',
    //map-style triggers a MapLibre setStyle(), the engine reloads the cloud disc, buildings and labels on the resulting `style.load`.
    'map-style',
    //Battery flat keys + the multi-bank array + the inverter-cutoff guard. Any of them changes the trainer guard or the chip wiring.
    'battery-soc-entity',
    'battery-power-entity',
    'battery-power-invert',
    'batteries',
    'inverter-cutoff-soc-pct',
    //Grid wiring: chips and flow leader paths follow these directly.
    'grid-import-entity',
    'grid-export-entity',
    'grid-power-entity',
    'grid-power-invert',
    //solar-radiation-entity, when set, feeds the engine sensor samples that override Open-Meteo for the live + past irradiance
    //values. A change must refresh the engine so the override (or its absence) is picked up immediately.
    'solar-radiation-entity',
    //building-radius / cluster-radius invalidate cache and refetch; opacity is a cheap paint-property update.
    'building-radius',
    'building-cluster-radius',
    'building-opacity',
    //Render budget + LiDAR-View visuals. The slider that drives lidar-view-point-size lives on the LiDAR-View itself so the engine
    //picks up the change immediately.
    'pixel-ratio',
    'shadows-enabled',
    'shadow-opacity',
    'lidar-precision',
    'lidar-view-point-size',
    //Timeline visibility + chart UX preferences.
    'timeline-enabled',
    'timeline-width-pct',
    'timeline-consumption-enabled',
    'date-format',
    'time-format',
    'auto-rotate-enabled',
    //lidar-local-ndsm-*: the 6 BYO-LiDAR keys. Any change must invalidate the engine sig so the shadow pipeline reruns against the
    //new provider config (toggle, URL or bbox).
    'lidar-local-ndsm-enabled',
    'lidar-local-ndsm-url',
    'lidar-local-ndsm-min-lat',
    'lidar-local-ndsm-max-lat',
    'lidar-local-ndsm-min-lon',
    'lidar-local-ndsm-max-lon',
    //camera-pitch-deg, camera-bearing-deg, camera-locked are NOT in this list: a slider drag would respawn the engine every frame,
    //which would teardown + rebuild the WebGL context for every pixel of input motion. The editor instead pushes the live preview
    //through engine.setCameraBearing / setCameraPitch / setCameraLocked and lets the new values bake into the config so the next
    //natural respawn (page reload, dashboard edit, theme flip) reads them out of _initialBearing / _initialPitch.
] as const;


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
//
//Memoization: the result is a pure function of (config, hass.config,
//window override) identities. Cached on the config identity with the
//hass.config and override pointers checked on read so a hass update
//that didn't touch coordinates returns the same object reference
//(allowing identity-based equality further upstream).
interface HomeCoordsCacheEntry
{
    hassCfg:    unknown;
    overrideId: unknown;
    result:     { lat: number; lon: number } | null;
}
const _homeCoordsCache = new WeakMap<HeliosConfig, HomeCoordsCacheEntry>();
let   _homeCoordsNoConfigCache: HomeCoordsCacheEntry | null = null;

export function getHomeCoords(
    config: HeliosConfig | undefined,
    hass:   any
): { lat: number; lon: number } | null
{
    const hassCfg    = hass?.config;
    const w          = window as unknown as { __heliosLocationOverride?: { lat: number; lon: number } };
    const overrideId = w.__heliosLocationOverride;

    if (config)
    {
        const cached = _homeCoordsCache.get(config);
        if (cached && cached.hassCfg === hassCfg && cached.overrideId === overrideId)
        {
            return cached.result;
        }
    }
    else if (_homeCoordsNoConfigCache
          && _homeCoordsNoConfigCache.hassCfg    === hassCfg
          && _homeCoordsNoConfigCache.overrideId === overrideId)
    {
        return _homeCoordsNoConfigCache.result;
    }

    const result = _resolveHomeCoords(config, hassCfg, overrideId);
    const entry: HomeCoordsCacheEntry = { hassCfg, overrideId, result };
    if (config) _homeCoordsCache.set(config, entry);
    else        _homeCoordsNoConfigCache = entry;
    return result;
}


function _resolveHomeCoords(
    config:     HeliosConfig | undefined,
    hassCfg:    any,
    overrideId: { lat: number; lon: number } | undefined
): { lat: number; lon: number } | null
{
    if (overrideId && typeof overrideId.lat === 'number' && typeof overrideId.lon === 'number'
          && isFinite(overrideId.lat) && isFinite(overrideId.lon))
    {
        return { lat: overrideId.lat, lon: overrideId.lon };
    }

    const cfgLat = parseConfigCoord(config?.['home-latitude']);
    const cfgLon = parseConfigCoord(config?.['home-longitude']);
    if (cfgLat !== null && cfgLon !== null
        && cfgLat >= -90  && cfgLat <= 90
        && cfgLon >= -180 && cfgLon <= 180)
    {
        return { lat: cfgLat, lon: cfgLon };
    }

    const lat = hassCfg?.latitude;
    const lon = hassCfg?.longitude;
    if (typeof lat !== 'number' || typeof lon !== 'number') return null;
    return { lat, lon };
}


//Cheap stable signature of the visual config, used to skip
//updateConfig() when nothing the engine cares about has changed.
//
//WeakMap cache on the config identity: the function is called once
//per Lit cycle (so once per overlay reprojection during auto-
//rotate). Without the cache the .map(...).join('|') allocated a
//fresh string of length ~300 characters per call, contributing to
//the GC churn during rotation.
const _configSigCache = new WeakMap<HeliosConfig, string>();

export function computeConfigSig(config: HeliosConfig | undefined): string
{
    if (!config)
    {
        return '';
    }
    const cached = _configSigCache.get(config);
    if (cached !== undefined) return cached;
    const sig = VISUAL_CONFIG_KEYS
        .map(k => `${k}=${config[k] ?? ''}`)
        .join('|');
    _configSigCache.set(config, sig);
    return sig;
}


//Structural surface the host card exposes to this module. Extends
//OverlaysHost so refreshOverlays(host) lands cleanly inside the
//engine onWeatherUpdate / onMapTransform callbacks; the rest is
//the engine + init lifecycle state the bootstrap mutates.
export interface InitHost extends OverlaysHost
{
    readonly config: HeliosConfig | undefined;
    readonly hass:   any;
    //Set by Home Assistant on the editor preview pane via `element.preview = true` (see `hui-card.ts:136`). Defaults to false on the
    //live dashboard tile. Drives the pool-key discriminator so a preview-mode mount never reuses a live-mode engine and vice versa.
    readonly preview?: boolean;

    _engine?:            HeliosEngine;
    _fetching:           boolean;
    _cloudCover:         number;
    _timeRange:          { start: Date; end: Date } | null;
    _isLiveMode:         boolean;
    _chartSeries:        ChartSeries | null;
    _shadowBusy:         boolean;
    _lidarExposureBusy:  boolean;

    _lastHomeKey:        string;
    _initInflight:       boolean;
    //performance.now() of the most recent engine spawn. Used by the
    //onContextLost recovery path to bail out when context losses
    //arrive faster than the engine can stabilise, which only happens
    //when the browser is thrashing its WebGL context pool. Re-spawning
    //at that cadence cascades into more losses, the throttle breaks
    //the loop and lets the existing engine settle.
    _lastEngineSpawnAt:  number;
    _visibilityObserver?: IntersectionObserver;
    //Document-level visibilitychange listener. Stored on the host
    //so disconnectedCallback can removeEventListener cleanly when
    //the card unmounts (each card has its own listener instance).
    _onVisibilityChange?: () => void;

    requestUpdate(): void;
}


//IntersectionObserver hook: pause every CSS animation and every SVG
//SMIL animation when the card scrolls out of the viewport, AND pause
//the engine's 60 s shadow-refresh timer + the dome re-projection on
//map moves. The rotation loop (a requestAnimationFrame in the engine)
//is left running because the browser auto-throttles rAF on hidden
//tabs and the card looks alive when the user scrolls back. The
//Page Visibility API is layered on top so a Helios card sitting in
//a hidden HA tab also goes quiet, not just one scrolled out of
//view of a focused tab.
export function initVisibilityObserver(host: InitHost): void
{
    if (host._visibilityObserver || typeof IntersectionObserver === 'undefined')
    {
        return;
    }
    //Combined paused state: invisible if the card is off-screen
    //(IntersectionObserver) OR the whole tab is hidden (Page
    //Visibility API). Either condition kills the heavy work; the
    //engine's own pause flag is updated when it exists (cheap, no
    //teardown).
    let intersecting = true;
    const applyState = () =>
    {
        const tabHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
        const paused    = !intersecting || tabHidden;
        setAnimationsPaused(host, paused);
        host._engine?.setPaused(paused);
    };
    host._visibilityObserver = new IntersectionObserver(entries =>
    {
        for (const entry of entries)
        {
            intersecting = entry.isIntersecting;
        }
        applyState();
    }, { threshold: 0 });
    host._visibilityObserver.observe(host as unknown as Element);
    if (typeof document !== 'undefined')
    {
        //One global listener per card. Removed in the card's disconnectedCallback via _onVisibilityChange below.
        host._onVisibilityChange = applyState;
        document.addEventListener('visibilitychange', host._onVisibilityChange);
    }
}


//Construct an engine. The shouldHaveEngine() gate has already
//absorbed visibility, editor-preview and tab-hidden debouncing
//upstream, so we go straight to initEngineNow(); a second debounce
//here would just add a 500 ms stall to legitimate first paints.
//Sets _initInflight so the updated() pass doesn't fire a second
//initEngine() while the rAF inside initEngineNow() is still in
//flight.
//Hard throttle: refuse to respawn the engine if the previous spawn
//is less than ENGINE_SPAWN_COOLDOWN_MS old. HA's editor preview can
//fire setConfig() bursts (10+ per second on rapid field edits) and
//each rapid respawn allocates a fresh MapLibre WebGL context that
//browsers' 8-16 slots can't keep up with, surfacing as "too many
//active WebGL contexts" errors. Spacing the spawns out lets the GPU
//slot from the previous engine actually release before we ask for
//another one. The threshold needs to cover one MapLibre teardown +
//browser GL slot release; 600 ms is safely above both on mid-range
//mobile while still feeling instant on a single edit.
const ENGINE_SPAWN_COOLDOWN_MS = 600;
const _pendingRespawnTimers = new WeakMap<InitHost, number>();

//Global spawn rate limit, across ALL helios-card instances. Even
//with the per-card cooldown, HA's dashboard edit mode can hold many
//helios-cards alive simultaneously and each one independently
//starting up still produces a burst that overruns the browser's
//WebGL slot pool. Anything beyond one fresh engine per 800 ms is
//rejected outright.
let _globalLastSpawnAt = 0;
const GLOBAL_SPAWN_COOLDOWN_MS = 800;

//Called from the card's disconnectedCallback so a pending deferred
//respawn can't fire after the card was torn down (which would spawn
//a new engine for a card that no longer has a shadow root).
export function cancelPendingRespawn(host: InitHost): void
{
    const t = _pendingRespawnTimers.get(host);
    if (t !== undefined)
    {
        window.clearTimeout(t);
        _pendingRespawnTimers.delete(host);
    }
}


//-----------------------------------------------------------------
//Engine pool: keeps engines alive across the destroy/create cycle Home Assistant performs on every editor `config-changed` commit.
//
//Diagnostic (see issue #162): HA does not simply detach + re-attach the same helios-card custom-element instance when the editor
//commits a change. It destroys the old element entirely and constructs a fresh one with the new config. The fresh element has no
//`_engine`, so the `updated()` pass takes the respawn branch and allocates a new WebGL context. Counted by `enginesCreated`: one
//cycle per slider release on a single-card dashboard, two on a dashboard that shows both the live tile and the editor preview.
//
//The pool short-circuits the cycle: instead of cleaning up on disconnect, we stash the engine into a module-level pool keyed by
//home coordinates. When a freshly-mounted helios-card hits `initEngineNow`, it tries to claim a matching engine from the pool
//first. If one is available we transplant its MapLibre container into the new shadow root via
//`HeliosEngine.transplantToContainer`, re-wire the engine callbacks against the new host, and skip the new-engine allocation
//entirely. Net: zero `enginesCreated` per editor commit on the steady state.
//
//Multi-card support: the pool stores a FIFO array per home key so two helios-cards at the same coordinates each get their own
//stash. A grace cleanup timer per entry destroys the engine if no claim arrives within `ENGINE_POOL_GRACE_MS` (real navigation
//away from the dashboard).

//Pool keying: a card running in HA's editor preview pane and a card mounted on the live dashboard never share an engine, they each
//have their own rendering pipeline and DOM presence simultaneously. Keying purely on `homeKey` would let a fresh preview steal the
//live dashboard's engine the first time the editor opens. The `mode` discriminator scopes the pool by (home, surface) so the
//preview pane only ever reuses ITS previous engine and the live dashboard only ever reuses ITS previous engine.
function poolKey(homeKey: string, mode: 'preview' | 'live'): string
{
    return `${homeKey}@${mode}`;
}


//Owner-handshake pool: an engine in the pool has a `lastOwner` reference. Claiming reassigns the owner; releasing is a no-op when
//the current owner is not the releaser (someone else has claimed it). Without the handshake, the natural race where Home Assistant
//constructs the new helios-card BEFORE removing the old one (see `hui-card.ts:121-166`) would have the old card's
//`disconnectedCallback` dispose an engine the new card has just taken ownership of.
interface PooledEngineEntry
{
    engine:       HeliosEngine;
    lastOwner:    object;
    disposeTimer: number;   // 0 means "actively owned, no dispose scheduled"
}

const _enginePool: Map<string, PooledEngineEntry> = new Map();
const ENGINE_POOL_GRACE_MS = 2500;


//Register an engine in the pool under (homeKey, mode). Called from `initEngineNow` immediately after `new HeliosEngine(...)` so the
//pool has the entry BEFORE any subsequent helios-card construction races against it. Also called after a successful claim so the
//new owner stays the registered one.
export function registerEngineInPool(homeKey: string, mode: 'preview' | 'live', engine: HeliosEngine, owner: object): void
{
    const key = poolKey(homeKey, mode);
    const existing = _enginePool.get(key);
    if (existing)
    {
        if (existing.disposeTimer !== 0) window.clearTimeout(existing.disposeTimer);
        if (existing.engine !== engine)
        {
            //A different engine for the same (home, mode) was already in the pool. The new registration wins; the displaced one
            //must be disposed so its WebGL context does not leak.
            existing.engine.cleanup();
        }
    }
    _enginePool.set(key, { engine, lastOwner: owner, disposeTimer: 0 });
}


//Attempt to claim a pooled engine for (homeKey, mode). Returns null when the pool has no matching entry, or when the calling host
//is already the registered owner (calling without intent to take over). The claim cancels any pending dispose timer and reassigns
//the owner so a subsequent release from the previous owner becomes a no-op.
export function claimEngineFromPool(homeKey: string, mode: 'preview' | 'live', claimant: object): HeliosEngine | null
{
    const key = poolKey(homeKey, mode);
    const entry = _enginePool.get(key);
    if (!entry) return null;
    if (entry.lastOwner === claimant) return null;
    if (entry.disposeTimer !== 0) window.clearTimeout(entry.disposeTimer);
    entry.lastOwner    = claimant;
    entry.disposeTimer = 0;
    return entry.engine;
}


//Called from `disconnectedCallback`. If `owner` is still the registered owner of this engine, schedule its dispose after the grace
//window so a remount within the grace can reclaim. If `owner` is no longer the registered owner (a remount already claimed),
//this is a no-op. If the engine is not in the pool at all, fall back to immediate cleanup so it does not leak.
export function releaseEngineFromPool(homeKey: string, mode: 'preview' | 'live', engine: HeliosEngine, owner: object): void
{
    const key = poolKey(homeKey, mode);
    const entry = _enginePool.get(key);
    if (!entry || entry.engine !== engine)
    {
        engine.cleanup();
        return;
    }
    if (entry.lastOwner !== owner)
    {
        //Someone else claimed; leave the engine in the pool, do not dispose.
        return;
    }
    entry.disposeTimer = window.setTimeout(() =>
    {
        const current = _enginePool.get(key);
        if (current && current.engine === engine && current.lastOwner === owner)
        {
            _enginePool.delete(key);
            engine.cleanup();
        }
    }, ENGINE_POOL_GRACE_MS);
}


//Returns whether `owner` is currently the registered pool owner for (homeKey, mode). Used by `helios-card.ts` to know whether the
//engine has already been claimed by a different mount before scheduling a release.
export function isCurrentPoolOwner(homeKey: string, mode: 'preview' | 'live', engine: HeliosEngine, owner: object): boolean
{
    const entry = _enginePool.get(poolKey(homeKey, mode));
    return entry !== undefined && entry.engine === engine && entry.lastOwner === owner;
}

export function initEngine(host: InitHost): void
{
    const now    = performance.now();
    const lastAt = host._lastEngineSpawnAt ?? 0;
    const delta  = now - lastAt;
    const sinceGlobalSpawn = now - _globalLastSpawnAt;
    //Either the per-card cooldown OR the global rate limit can force
    //a deferral. The global limit wins when several helios-cards on
    //the page race during a dashboard edit-mode transition.
    const needDefer = (delta < ENGINE_SPAWN_COOLDOWN_MS && lastAt > 0)
                   || sinceGlobalSpawn < GLOBAL_SPAWN_COOLDOWN_MS;
    if (needDefer)
    {
        //Coalesce rapid respawn requests into ONE deferred spawn that
        //fires after the cooldown elapses. Any prior pending respawn
        //is cleared so we never enqueue more than one wake-up; the
        //latest config wins.
        const prev = _pendingRespawnTimers.get(host);
        if (prev !== undefined) window.clearTimeout(prev);
        host._initInflight = true;
        const perCardWait = lastAt > 0 ? ENGINE_SPAWN_COOLDOWN_MS - delta : 0;
        const globalWait  = GLOBAL_SPAWN_COOLDOWN_MS - sinceGlobalSpawn;
        const wait        = Math.max(perCardWait, globalWait, 0) + 16;
        const t = window.setTimeout(() =>
        {
            _pendingRespawnTimers.delete(host);
            //Final check before crossing into the heavy spawn path:
            //if the card was unmounted while the cooldown ran, just
            //release the inflight flag and bail.
            const hostEl = host as unknown as { isConnected?: boolean };
            if (hostEl.isConnected === false)
            {
                host._initInflight = false;
                return;
            }
            initEngineNow(host);
        }, wait);
        _pendingRespawnTimers.set(host, t);
        return;
    }
    host._initInflight = true;
    _globalLastSpawnAt = now;
    initEngineNow(host);
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
        //isConnected gate: the rAF gap above can land after a HA
        //dashboard edit-mode unmount. Spawning an engine for a card
        //that's no longer in the DOM allocates a WebGL context with
        //no user-visible canvas and feeds the editor-mode cascade.
        const cardEl = host as unknown as {
            shadowRoot:  ShadowRoot | null;
            isConnected: boolean;
        };
        if (!cardEl.isConnected)
        {
            host._initInflight = false;
            return;
        }
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

        //Engine pool short-circuit: a previous helios-card instance at the same home coordinates and the same surface mode (preview
        //vs live dashboard tile) may already have an engine in the pool. Reuse it via DOM re-parenting and skip the heavy
        //`new HeliosEngine(...)` path entirely. See the pool header comment above for the diagnostic on why HA's editor preview
        //pane forces the per-commit rebuild.
        const homeKey = `${lat.toFixed(5)},${lon.toFixed(5)}`;
        const mode: 'preview' | 'live' = host.preview === true ? 'preview' : 'live';
        const pooled  = claimEngineFromPool(homeKey, mode, host);
        if (pooled)
        {
            //Re-parent the pooled engine's existing container DOM node into the slot Lit just rendered. The new shadow root ends
            //up holding the SAME element the previous instance was using, MapLibre's internal `_container` reference stays valid,
            //no private-field access needed. The handshake-style claim already cancelled the previous owner's pending dispose.
            pooled.reparentInto(container);
            host._engine = pooled;
            host._lastEngineSpawnAt = performance.now();
            wireEngineCallbacks(host);
            host._initInflight = false;
            //Re-register under our ownership so subsequent claims (next slider commit) find us as the lastOwner and the handshake
            //works correctly.
            registerEngineInPool(homeKey, mode, pooled, host);
            return;
        }

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
            //Container was checked above but the inter-frame gap below could land after a card disconnect. Re-check defensively so a torn-down card
            //never spawns a new engine.
            if (!host.config || !host.hass?.config)
            {
                host._initInflight = false;
                return;
            }
            host._engine = new HeliosEngine(container, host.config, [lon, lat], elevation);
            host._lastEngineSpawnAt = performance.now();
            wireEngineCallbacks(host);
            host._initInflight = false;
            //Eager registration: the new engine joins the pool as soon as it is created so a subsequent helios-card construction
            //(slider commit destroys + recreates the preview pane via `hui-card._loadElement`) can claim it before allocating
            //a fresh WebGL context. The previous attempt registered only at `disconnectedCallback`, by which point HA had
            //already called `setConfig` on the new element AND the new element's `updated()` ran one mount-debounce-window
            //later, well past the point where a claim would help. See `init.ts:_enginePool` comment block.
            registerEngineInPool(homeKey, mode, host._engine, host);
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
        //Per-layer cloud breakdown is now owned by the engine, it stashes low / mid / high alongside the effective coverage and projectCloudScene
        //reads them back to size the three concentric bands. The card only needs the aggregate for the cloud chip label.
        host._cloudCover         = data.cloudCover;
        host._timeRange          = data.timeRange;
        host._isLiveMode         = data.isLiveTime;
        //Pull the hourly series the chart canvas plots. Same cadence as the gradients above, since both consume the engine's hourly data refresh.
        host._chartSeries        = host._engine?.getTimelineSeries() ?? null;
        //First weather update is also our cue to ask the engine for the initial label layout, by this point the map has loaded its style and the
        //projection matrix is available. Subsequent transforms refresh via onMapTransform.
        refreshOverlays(host);
    };
    //Cloud-disc hover is wired directly on the SVG element via
    //@mousemove / @mouseleave (see the render path's solar-svg),
    //so the engine doesn't surface a hover callback for it.
    //rAF-coalesced overlay refresh. MapLibre fires move events
    //in bursts of 5-10 per frame during an inertial pan; without
    //coalescing, refreshOverlays + the dome re-projection both
    //ran several times per frame (sun arc reprojects 96 samples,
    //home silhouettes reproject all extrusion footprints, dome
    //reprojects 648 cells * 4 corners + 96 ribbon samples). With
    //the rAF gate, at most one full overlay pass per frame, no
    //matter how many move events MapLibre fires.
    let overlayRaf: number | null = null;
    //LiDAR-View and Shading-dome modes hide the regular HUD via
    //CSS opacity:0 + pointer-events:none. While in those modes
    //the projected sun arc, home silhouettes and chip anchors are
    //invisible but `refreshOverlays` still re-projects them on
    //every map transform under auto-rotate. That was the dominant
    //CPU sink while LiDAR view was active. Same idea for the dome
    //scenes when their corresponding mode is OFF: skipping the
    //refresh leaves the stale scene cached (the toggle path
    //re-runs it once on enter so the user sees up-to-date data).
    type ModeAwareHost = InitHost & {
        readonly _lidarViewMode?:   boolean;
        readonly _shadingDomeMode?: boolean;
        readonly _cloudDomeMode?:   boolean;
    };
    host._engine.onMapTransform = () =>
    {
        //If the card is paused (off-screen or in a hidden tab) the
        //browser still fires move events for tile-load completions,
        //but the user can't see anything, so skip the per-frame
        //work entirely. Comes back on the next render once the
        //IntersectionObserver re-enables the engine.
        if (host._engine?.isPaused()) return;
        if (overlayRaf !== null) return;
        overlayRaf = requestAnimationFrame(() =>
        {
            overlayRaf = null;
            const mh = host as ModeAwareHost;
            //In LiDAR-View the HUD is faded out: skip projecting
            //the sun arc, silhouettes, label layout, cloud scene.
            //Same gate for both dome scenes when their own mode
            //is OFF.
            if (!mh._lidarViewMode)
            {
                refreshOverlays(host);
            }
            if (mh._shadingDomeMode)
            {
                refreshShadingDomeScene(host as unknown as ShadingDomeHost);
            }
            if (mh._cloudDomeMode)
            {
                refreshCloudDomeScene(host as unknown as CloudDomeHost);
            }
        });
    };
    //WebGL context loss handler. NO LONGER auto-respawns: when the
    //browser kills our context (typically because the page hit the
    //per-origin cap of 8 to 16 WebGL contexts in editor preview
    //mode), respawning here used to fire ANOTHER getContext which
    //killed another live context, which dispatched another
    //context-lost event, looping until the editor session was
    //drowning in error spam.
    //
    //We just mark the engine as paused and let MapLibre's own
    //internal context-restored path (which kicks in when the user
    //leaves the editor / scrolls / refocuses the tab) bring it back.
    //If that fails, a manual config change (any user edit) will hit
    //the identity-change branch in updated() and spawn a fresh
    //engine from a clean slate, with no cascade in flight.
    host._engine.onContextLost = () =>
    {
        console.warn('[HELIOS] WebGL context lost. Auto-respawn disabled to avoid cascade in editor preview; the canvas will recover on the next user-driven config change.');
    };

    //LiDAR shadow compute: the engine fires these around its WMS round-trip + raster paint pass. The card surfaces a small spinner chip top-right so
    //the user has a clear "shadows are coming" signal during the few seconds the fetch takes on a cold start.
    host._engine.onShadowComputeStart = () =>
    {
        host._shadowBusy = true;
    };
    host._engine.onShadowComputeEnd = () =>
    {
        host._shadowBusy = false;
    };
    //Exposure compute busy flag: same pattern, used by the mode-bar
    //LiDAR button to swap to a spinner + lock mode-switching while
    //the irradiance fill is still computing.
    host._engine.onLidarExposureBusyChange = (busy: boolean): void =>
    {
        host._lidarExposureBusy = busy;
    };

}
