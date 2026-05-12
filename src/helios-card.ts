import { LitElement, html, svg, PropertyValues, TemplateResult, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import
{
    HeliosEngine,
    type HeliosConfig,
    DEFAULT_SUN_COLOR_HEX,
    DEFAULT_CLOUD_COLOR_HEX,
    DEFAULT_PV_COLOR_HEX,
    DEFAULT_BATTERY_COLOR_HEX
} from './helios-engine';
import { computePvPower } from './helios-sun';
import { pickTranslations } from './i18n';
import { heliosCardStyles } from './helios-card-css';
//Side-effect import: registers <helios-color-picker> and
//<helios-card-editor> as custom elements, plus exposes the cfgHex /
//formatDate helpers used by the card.
import { cfgHex, formatDate } from './helios-config';
import './helios-config';


//Custom-card registration

declare global
{
    interface Window
    {
        customCards?: Array<{
            type:        string;
            name:        string;
            description: string;
            preview?:    boolean;
        }>;
    }
}

//Card name and description in the HA card picker — shown before any
//hass instance is available, so we read the language from navigator.
const _bootI18n = pickTranslations(typeof navigator !== 'undefined' ? navigator.language : 'en');

window.customCards = window.customCards || [];
if (!window.customCards.some(c => c.type === 'helios-card'))
{
    window.customCards.push(
    {
        type:        'helios-card',
        name:        _bootI18n.cardName,
        description: _bootI18n.cardDescription,
        preview:     true
    });
}




//Main card


@customElement('helios-card')
export class HeliosCard extends LitElement
{
    //Visual depth-modulation bounds for the solar overlay. Each pair
    //is the FAR end (when the element is at the back of the day's
    //loop, furthest from the camera) and the NEAR end (when it's at
    //the front). Per-element values are linearly interpolated between
    //the two using the engine's nearness factor in [0..1].
    //
    //The arc spans 24 h, so its near and far ends differ by a
    //meaningful depth delta even with the camera fully locked. The
    //sun rides the arc, so its disc breathes between SUN_R_FAR (just
    //past the horizon) and SUN_R_NEAR (around the noon apex).
    private static readonly OUTLINE_FAR  = 1.5;
    private static readonly OUTLINE_NEAR = 5.0;
    private static readonly SEGMENT_FAR  = 1.0;
    private static readonly SEGMENT_NEAR = 4.0;
    //Sun disc enlarged so the irradiance fill is readable
    //without zooming in. The old radii (6 → 13 px) made the inner
    //fill smaller than ~9 px in diameter at apex, which is the
    //legibility floor for an annulus. The new range (10 → 20 px)
    //gives the fill 8 px of breathing room inside the outer rim
    //even at the back of the day's loop.
    private static readonly SUN_R_FAR    = 10.0;
    private static readonly SUN_R_NEAR   = 20.0;
    //Outer rim stroke width. Small enough to read as an outline,
    //wide enough to remain visible against the basemap without a
    //dark drop shadow.
    private static readonly SUN_RIM_WIDTH = 1.5;
    //Background fill opacity inside the rim. Low enough that the
    //"empty sun" at sunrise/sunset reads as faintly tinted glass
    //rather than a coloured spot, but high enough that the disc
    //is unmistakably present even at low altitudes.
    private static readonly SUN_FILL_OPACITY_BG = 0.20;

    //Below-horizon segments are rendered as dots whose diameter
    //IS the segment's stroke-width. We scale that down vs the
    //daytime stroke so the night portion of the loop reads as
    //a quieter, more discreet trace — its job is to indicate
    //where the sun goes, not to compete with the lit half.
    private static readonly NIGHT_STROKE_FACTOR = 0.5;

    @property({ attribute: false }) public hass!: any;
    @property({ attribute: false }) private config!: HeliosConfig;

    @state() private _engine?:        HeliosEngine;
    @state() private _now             = new Date();
    //Cloud-cover values shown in the on-ground disc tooltip. Recreated
    //after the v1.2 cleanup removed them — now they feed the
    //hover popup that appears above the disc rather than the (also
    //removed) sidebar pills.
    @state() private _cloudCover      = -1;
    @state() private _cloudLow        = -1;
    @state() private _cloudMid        = -1;
    @state() private _cloudHigh       = -1;
    //Hover state for the on-ground cloud-cover disc. The engine emits
    //pointer events on the disc layer; the card mirrors them here so
    //the render path stays declarative.
    @state() private _cloudHoverX     = 0;
    @state() private _cloudHoverY     = 0;
    @state() private _cloudHover      = false;
    //True when the cursor sits in the right half of the card.
    //Tooltip then anchors to the LEFT of the cursor instead of
    //the default right offset, so it can't overflow past the
    //card edge.
    @state() private _cloudHoverFlip  = false;
    //Screen-space layout of the always-visible cloud-cover percentage
    //label and its leader line, recomputed via engine.projectHome-
    //LabelLayout() whenever the map transform changes (engine fires
    //onMapTransform). null = layout not yet available (map still
    //loading) — the overlay is hidden in that case.
    @state() private _labelLayout:    {
        cloudLabel:        { x: number; y: number };
        pvLabel:           { x: number; y: number };
        batterySocLabel:   { x: number; y: number };
        batteryPowerLabel: { x: number; y: number };
        ringEdge:          { x: number; y: number };
        home:              { x: number; y: number };
    } | null = null;
    //Photovoltaic production state — populated when the user has set
    //a `pv-power-entity` config key. _pvCurrent holds the live value
    //read from hass.states; _pvHistory holds the time series fetched
    //from HA's history API for plotting on the dedicated graph.
    @state() private _pvCurrent: number | null = null;
    @state() private _pvUnit:    string        = '';
    @state() private _pvHistory: {
        times:  Date[];
        values: number[];
    } | null = null;
    private _pvFetchKey  = '';
    private _pvFetching  = false;
    //Rolling buffer of state samples — populated each time hass
    //emits a fresh state for the configured PV entity. Used to
    //compute a "last minute" instantaneous rate for cumulative
    //energy sensors, much fresher than the historical fetch which
    //only refreshes when the timeline range changes.
    private _pvSampleBuffer: Array<{ t: number; v: number }> = [];
    //Home-battery state — populated when the user has set at least
    //one of `battery-soc-entity` / `battery-power-entity`. The two
    //readings (live and historical) are kept on separate fields so
    //the chip can render either depending on the timeline mode (live
    //or scrub). Units are kept alongside the values so the chip can
    //format kW vs W without re-reading the state.
    @state() private _batterySoc:        number | null = null;
    @state() private _batteryPower:      number | null = null;
    @state() private _batteryPowerUnit:  string        = '';
    //Historical series for the active timeline range. Same shape as
    //_pvHistory, fetched via a single `history/history_during_period`
    //WS call that batches both battery entities (when both are set).
    //Cleared when the configured entity changes or when the time
    //range changes; null = not yet fetched / no entity configured.
    @state() private _batterySocHistory: {
        times:  Date[];
        values: number[];
    } | null = null;
    @state() private _batteryPowerHistory: {
        times:  Date[];
        values: number[];
    } | null = null;
    private _batteryFetchKey  = '';
    private _batteryFetching  = false;
    //Screen-space layout of the solar arc, sun, and incidence ray.
    //Recomputed via engine.projectSunScene() on every map transform
    //(camera animation) and every clock tick (the sun position
    //moves with time, so we refresh at the same 1 Hz cadence as
    //the date/time display in live mode). null = engine not ready
    //yet, the overlay is hidden.
    @state() private _sunScene: {
        arc:      Array<{
            x: number; y: number;
            irradiance: number; nearness: number; belowHorizon: boolean;
        }>;
        sun:      { x: number; y: number; irradiance: number; altitude: number; nearness: number };
        home:     { x: number; y: number };
        daylight: number;
    } | null = null;    
    @state() private _chartSeries: {
        times:      Date[];
        irradiance: number[];
        cloud:      number[];
    } | null = null;
    @state() private _fetching        = false;
    @state() private _timeRange:    { start: Date; end: Date } | null = null;
    @state() private _selectedTime: Date | null = null;
    @state() private _isLiveMode    = true;

    private _timer?:           number;
    private _lastApiKey        = '';
    private _lastHomeKey       = '';
    private _lastConfigSig     = '';
    private _initInflight      = false;

    //Visual config keys that the engine reacts to via updateConfig().
    //Anything outside this list (notably maptiler-api-key, which is an
    //identity input handled separately) is irrelevant for live updates.
    //Significantly trimmed: most visual styling is now hard-
    //coded to keep the new design coherent (uniform building colour
    //and opacity, no radial dot grid).
    private static readonly _VISUAL_CONFIG_KEYS = [
        'topography-color',
        'topography-alpha',
        'show-labels',
        'sun-color',
        'cloud-color',
        //pv-color is purely a card-level visual (the chart fill /
        //stroke) but we still include it so the config sig changes
        //and Lit re-renders the chart. pv-power-entity is included
        //too so changing it triggers a fresh history fetch.
        'pv-color',
        'pv-power-entity',
        //map-style triggers a MapLibre setStyle() inside updateConfig,
        //so the engine reloads the basemap (terrain, hillshade, cloud
        //disc, buildings and label visibility are all re-applied via
        //the resulting `style.load`).
        'map-style',
        //Battery overlay — soc and power entities feed the live chip
        //below the home; battery-color tints the chip border, text
        //and animated leader. Including them in the visual sig means
        //changing the entity in the editor triggers a re-render that
        //picks up the new readings on the next hass property update.
        'battery-soc-entity',
        'battery-power-entity',
        'battery-color',
        //card-theme is purely a card-level visual (it switches the
        //ha-card's class to flip CSS variables / chip colours
        //between the light and dark skins), but it must be in the
        //sig so Lit re-renders the card when the user toggles it
        //in the editor.
        'card-theme',
        //building-* drive the helios-buildings-* custom layers.
        //  radius / cluster-radius → invalidate cache and refetch
        //  opacity / color → cheap paint-property updates
        'building-radius',
        'building-cluster-radius',
        'building-opacity',
        'building-color',
        //performance-mode toggles terrain, hillshade and pixelRatio.
        'performance-mode',
        //terrain-detail picks the DEM maxzoom (smooth / fine).
        'terrain-detail'
    ] as const;

    //Cheap stable signature of the visual config — used to skip
    //updateConfig() when nothing the engine cares about has changed.
    private _computeConfigSig(): string
    {
        if (!this.config)
        {
            return '';
        }
        return HeliosCard._VISUAL_CONFIG_KEYS
            .map(k => `${k}=${this.config[k] ?? ''}`)
            .join('|');
    }


    //HA card lifecycle

    public setConfig(config: HeliosConfig): void
    {
        if (!config)
        {
            throw new Error('Invalid HELIOS configuration');
        }
        this.config = { ...config };
    }

    static getConfigElement(): HTMLElement
    {
        return document.createElement('helios-card-editor');
    }

    static getStubConfig(): HeliosConfig
    {
        return { 'maptiler-api-key': '' };
    }

    //Sizing for masonry view (legacy). 1 unit = 50 px so 12 ≈ 600 px,
    //matching the historical default height of the card.
    public getCardSize(): number
    {
        return 12;
    }

    //Sizing for sections view (current). 1 row ≈ 56 px and 1 col ≈ 30 px
    //(at section width 360 px). Default 9 columns x 11 rows ≈ 540 x 624 px.
    //
    //min_columns is kept at 6 (not 9) because Home Assistant will
    //refuse to render the card with an "Invalid configuration"
    //placeholder when the containing section happens to have fewer
    //than min_columns slots available. 6 is the sweet spot: still a
    //multiple of 3 (HA's recommended granularity), small enough to
    //fit any section, large enough that the 11-day timeline labels
    //stay readable when the user resizes down to that minimum.
    public getGridOptions(): {
        rows:        number;
        columns:     number;
        min_rows:    number;
        max_rows:    number;
        min_columns: number;
        max_columns: number;
    }
    {
        return {
            rows:        11,
            columns:     9,
            min_rows:    6,
            max_rows:    24,
            min_columns: 6,
            max_columns: 12
        };
    }

    public connectedCallback(): void
    {
        super.connectedCallback();
        this._tick();
        this._timer = window.setInterval(() => this._tick(), 1000);
        this._initVisibilityObserver();
        //Detect early whether we're rendered inside HA's dashboard
        //editor preview. The editor instantiates a fresh helios-card
        //on every config change and each engine takes a WebGL
        //context — Safari mobile caps at ~8 and starts recycling
        //past that, which is the root cause of the FPS drift and
        //iOS black-screen lockup. We skip the engine entirely for
        //preview cards (the dashboard card on the actual page keeps
        //its full rendering).
        this._isInEditorPreview = this._detectEditorPreview();
    }

    //Cached at connectedCallback time; does not change for the
    //lifetime of the card instance.
    private _isInEditorPreview = false;

    private _detectEditorPreview(): boolean
    {
        //Tag list collected from inspecting HA's dashboard editor
        //DOM: the modal dialog wrapping each preview, the element
        //editor, plus a couple of generic fallbacks. We walk every
        //ancestor (including across shadow-root boundaries via
        //node.host) until we hit one matching, or run out of hops.
        const EDITOR_TAGS = new Set([
            'hui-dialog-edit-card',
            'hui-card-element-editor',
            'hui-edit-card',
            'hui-card-editor'
        ]);
        let node: Node | null = this;
        let hops = 0;
        while (node && hops++ < 40)
        {
            if (node instanceof ShadowRoot)
            {
                node = node.host;
                continue;
            }
            if (node instanceof Element)
            {
                const tag = node.tagName?.toLowerCase();
                if (tag && EDITOR_TAGS.has(tag)) return true;
            }
            node = (node as Node).parentNode;
        }
        return false;
    }

    public disconnectedCallback(): void
    {
        super.disconnectedCallback();
        window.clearInterval(this._timer);
        this._visibilityObserver?.disconnect();
        this._visibilityObserver = undefined;
        //If the card is destroyed before the debounce fires, drop the
        //pending init entirely — no engine, no WebGL context, no leak.
        //This is the whole point of the debounce: short-lived editor
        //preview cards never get an engine.
        if (this._initDebounceTimer !== undefined)
        {
            window.clearTimeout(this._initDebounceTimer);
            this._initDebounceTimer = undefined;
            this._initInflight      = false;
        }
        //Flush any pending PV-calibration HA write synchronously
        //(best-effort) so we don't lose the most recent samples to
        //a stale timer that will never fire after disconnect.
        if (this._pvCalibHAWriteTimer !== undefined)
        {
            window.clearTimeout(this._pvCalibHAWriteTimer);
            this._pvCalibHAWriteTimer = undefined;
            void this._flushPvCalibToHA();
        }
        this._engine?.cleanup();
        this._engine = undefined;
    }

    //IntersectionObserver — pause every CSS animation and every SVG
    //SMIL animation when the card scrolls out of the viewport. The
    //rotation loop (a requestAnimationFrame in the engine) is left
    //running because (a) the browser auto-throttles rAF on hidden
    //tabs and (b) the card looks alive when the user scrolls back.
    //Only the SVG overlay animations are paused — they're the ones
    //that run continuously regardless of map state.
    private _visibilityObserver?: IntersectionObserver;

    private _initVisibilityObserver(): void
    {
        if (this._visibilityObserver || typeof IntersectionObserver === 'undefined')
        {
            return;
        }
        this._visibilityObserver = new IntersectionObserver(entries =>
        {
            for (const entry of entries)
            {
                this._setAnimationsPaused(!entry.isIntersecting);
            }
        }, { threshold: 0 });
        this._visibilityObserver.observe(this);
    }

    private _setAnimationsPaused(paused: boolean): void
    {
        this.classList.toggle('helios-paused', paused);
        //SMIL animations are not controlled by CSS animation-play-state.
        //Walk the shadow tree and call (un)pauseAnimations() on every
        //SVG root we find. Both methods are no-ops on browsers that
        //don't support them, so we don't need to feature-detect.
        const root = this.shadowRoot;
        if (!root) return;
        const svgs = root.querySelectorAll('svg');
        for (const svg of Array.from(svgs))
        {
            const s = svg as SVGSVGElement & {
                pauseAnimations?:  () => void;
                unpauseAnimations?: () => void;
            };
            try
            {
                if (paused) s.pauseAnimations?.();
                else        s.unpauseAnimations?.();
            }
            catch (_) {}
        }
    }

    //Engine init policy: re-init only when one of the *identity inputs*
    //changes (API key, home coordinates, map style). We resize the
    //existing engine when the container reflows — we never tear down
    //the MapLibre stack just because a sibling fragment re-rendered.
    //Doing so would trash the user's in-progress edits in the
    //dashboard editor.
    protected updated(_changedProperties: PropertyValues): void
    {
        if (!this.hass?.config || !this.config)
        {
            return;
        }

        const apiKey  = String(this.config['maptiler-api-key'] ?? '').trim();
        const lat     = this.hass.config.latitude;
        const lon     = this.hass.config.longitude;

        if (lat === undefined || lon === undefined || !apiKey)
        {
            return;
        }

        //First time hass is available — reconcile the local PV
        //calibration cache with HA's frontend/user_data storage so
        //we pull in any samples accumulated on another device
        //(or recover from a localStorage wipe).
        if (!this._pvCalibHARead)
        {
            void this._reconcilePvCalibWithHA();
        }

        const homeKey  = `${lat.toFixed(5)},${lon.toFixed(5)}`;

        const identityChanged =
            apiKey   !== this._lastApiKey ||
            homeKey  !== this._lastHomeKey;

        if (!this._engine || identityChanged)
        {
            if (this._initInflight)
            {
                return;
            }
            this._lastApiKey    = apiKey;
            this._lastHomeKey   = homeKey;
            this._lastConfigSig = this._computeConfigSig();
            this._initEngine();
            return;
        }

        //Identity stable — only push config tweaks down if the visual
        //config has actually changed. Without this guard we'd call
        //updateConfig() on every Lit re-render (e.g. every second from
        //the clock tick, or every time a @state changes), which would
        //rebuild the GeoJSON of thousands of points and freeze the page.
        const sig = this._computeConfigSig();
        if (sig !== this._lastConfigSig)
        {
            this._lastConfigSig = sig;
            this._engine.updateConfig(this.config);
        }

        //Photovoltaic production refresh — driven by changes in the
        //configured entity, the time range, or the hass states. The
        //refresh is cheap when nothing relevant changed (string-equal
        //fetch key short-circuits the WebSocket roundtrip).
        this._refreshPv();

        //Battery overlay refresh — pure live-state read, runs every
        //cycle. Cheap (no WS round-trip, no fetch) so we don't bother
        //gating on an entity-id signature like _refreshPv does.
        this._refreshBattery();
    }


    //Photovoltaic production
    //
    //When the user configures `pv-power-entity`, the card pulls two
    //flavours of data from Home Assistant:
    //  - the entity's current state (read synchronously from
    //    hass.states on every render cycle), shown as a chip below
    //    the home with a leader line back to the marker.
    //  - the entity's historical state changes over the active time
    //    range (fetched asynchronously via the history WebSocket
    //    command), plotted on the dedicated graph above the main
    //    timeline. Only past + current data is fetched — the future
    //    half of the timeline range is intentionally left blank
    //    because production data simply doesn't exist yet.

    private _refreshPv(): void
    {
        const entity = String(this.config?.['pv-power-entity'] ?? '').trim();

        if (!entity || !this.hass)
        {
            //Reset everything when the user clears the entity field
            //so the chip and graph immediately disappear instead of
            //sticking around with stale data.
            if (this._pvCurrent !== null || this._pvHistory !== null)
            {
                this._pvCurrent = null;
                this._pvHistory = null;
                this._pvUnit    = '';
            }
            this._pvFetchKey = '';
            return;
        }

        //Live state read — always cheap, runs on every Lit cycle.
        const stateObj = this.hass.states?.[entity];
        if (stateObj)
        {
            const v = parseFloat(stateObj.state);
            const next = isFinite(v) ? v : null;
            if (next !== this._pvCurrent)
            {
                this._pvCurrent = next;
            }
            const unit = stateObj.attributes?.unit_of_measurement ?? '';
            if (unit !== this._pvUnit)
            {
                this._pvUnit = unit;
            }

            //Append the freshly-read state to the rolling buffer if
            //the entity timestamp moved forward since last cycle.
            //We trim entries older than 5 min so the buffer stays
            //tiny even on entities that update many times per
            //second.
            if (next !== null)
            {
                const ts = stateObj.last_updated
                    ? new Date(stateObj.last_updated).getTime()
                    : Date.now();
                const buf = this._pvSampleBuffer;
                const last = buf.length > 0 ? buf[buf.length - 1] : null;
                if (!last || ts > last.t)
                {
                    buf.push({ t: ts, v: next });
                    const cutoff = Date.now() - 5 * 60 * 1000;
                    while (buf.length > 1 && buf[0].t < cutoff)
                    {
                        buf.shift();
                    }
                }
            }
        }
        else
        {
            if (this._pvCurrent !== null)
            {
                this._pvCurrent = null;
            }
            //Drop the buffer when the entity disappears so we don't
            //serve stale samples after the user clears the config.
            if (this._pvSampleBuffer.length > 0)
            {
                this._pvSampleBuffer = [];
            }
        }

        //History fetch — only when the (entity, range) tuple changes.
        //Without this guard we'd reissue the WebSocket command on
        //every Lit cycle (e.g. every clock tick) and the dashboard
        //would queue thousands of identical requests.
        if (!this._timeRange || this._pvFetching)
        {
            return;
        }
        const rangeKey = `${this._timeRange.start.getTime()}|${this._timeRange.end.getTime()}`;
        const fetchKey = `${entity}@${rangeKey}`;
        if (fetchKey === this._pvFetchKey)
        {
            return;
        }
        this._pvFetchKey = fetchKey;
        this._fetchPvHistory(entity, this._timeRange.start, this._timeRange.end);
    }

    //Battery overlay — pulls live state from hass.states on every Lit
    //cycle (no rolling buffer like PV — battery entities are typically
    //power sensors that already expose an instantaneous reading) and,
    //when at least one entity is configured AND the timeline range is
    //set, fetches a historical series so the chip can show what the
    //battery was doing at any past instant the user scrubs to. The
    //fetch is gated on a `(socEntity, powerEntity, range)` tuple so
    //we don't reissue the WS call on every render cycle.
    private _refreshBattery(): void
    {
        if (!this.hass)
        {
            return;
        }
        const socEntity   = String(this.config?.['battery-soc-entity']   ?? '').trim();
        const powerEntity = String(this.config?.['battery-power-entity'] ?? '').trim();

        //SoC — clamp to [0, 100] because some BMS entities momentarily
        //report 100.5 % during the absorption phase or briefly drop
        //negative around the calibration cycle, neither of which is
        //meaningful to the user.
        let nextSoc: number | null = null;
        if (socEntity)
        {
            const so = this.hass.states?.[socEntity];
            const v  = so ? parseFloat(so.state) : NaN;
            if (isFinite(v))
            {
                nextSoc = Math.max(0, Math.min(100, v));
            }
        }
        if (nextSoc !== this._batterySoc)
        {
            this._batterySoc = nextSoc;
        }

        //Power — keep the sign (positive = charging, negative =
        //discharging) verbatim from the entity. Unit is captured so
        //the chip renderer can format kW vs W; we don't normalise
        //here because the entity's own unit IS the source of truth
        //(some BMS expose W, others kW).
        let nextPower: number | null = null;
        let nextUnit:  string        = '';
        if (powerEntity)
        {
            const so = this.hass.states?.[powerEntity];
            const v  = so ? parseFloat(so.state) : NaN;
            if (isFinite(v))
            {
                nextPower = v;
                nextUnit  = so.attributes?.unit_of_measurement ?? '';
            }
        }
        if (nextPower !== this._batteryPower)
        {
            this._batteryPower = nextPower;
        }
        if (nextUnit !== this._batteryPowerUnit)
        {
            this._batteryPowerUnit = nextUnit;
        }

        //Drop history series and reset the fetch key when the user
        //clears all battery entity fields, so a stale graph doesn't
        //linger after the config goes blank.
        if (!socEntity && !powerEntity)
        {
            if (this._batterySocHistory !== null)   { this._batterySocHistory   = null; }
            if (this._batteryPowerHistory !== null) { this._batteryPowerHistory = null; }
            this._batteryFetchKey = '';
            return;
        }

        //History fetch — only when the (entities, range) tuple changed.
        //Without this guard we'd reissue the WS command on every Lit
        //cycle (e.g. every clock tick).
        if (!this._timeRange || this._batteryFetching)
        {
            return;
        }
        const rangeKey = `${this._timeRange.start.getTime()}|${this._timeRange.end.getTime()}`;
        const fetchKey = `${socEntity}+${powerEntity}@${rangeKey}`;
        if (fetchKey === this._batteryFetchKey)
        {
            return;
        }
        this._batteryFetchKey = fetchKey;
        this._fetchBatteryHistory(socEntity, powerEntity, this._timeRange.start, this._timeRange.end);
    }

    //Single-call history fetch for the battery overlay. Both entities
    //(when configured) are bundled into one `entity_ids` array so we
    //pay one WS roundtrip instead of two. Either side of the result
    //may end up empty (entity not yet existing, no state changes in
    //range, etc.) and that's fine — the chip will show only the side
    //that did return data.
    private async _fetchBatteryHistory(
        socEntity: string, powerEntity: string, start: Date, end: Date
    ): Promise<void>
    {
        if (!this.hass?.callWS)
        {
            return;
        }
        this._batteryFetching = true;
        try
        {
            //History only exists up to "now" — the future half of the
            //timeline has no battery data. Clamp the fetch end so we
            //don't waste a roundtrip on empty future buckets.
            const now = new Date();
            const fetchEnd = end > now ? now : end;
            if (start >= fetchEnd)
            {
                if (socEntity)   { this._batterySocHistory   = { times: [], values: [] }; }
                if (powerEntity) { this._batteryPowerHistory = { times: [], values: [] }; }
                return;
            }

            const ids: string[] = [];
            if (socEntity)   { ids.push(socEntity);   }
            if (powerEntity) { ids.push(powerEntity); }

            const result: any = await this.hass.callWS({
                type:             'history/history_during_period',
                start_time:       start.toISOString(),
                end_time:         fetchEnd.toISOString(),
                entity_ids:       ids,
                minimal_response: true,
                no_attributes:    true
            });

            const parseSeries = (arr: any[]): { times: Date[]; values: number[] } =>
            {
                const times:  Date[]   = [];
                const values: number[] = [];
                for (const item of arr ?? [])
                {
                    const stateStr =
                        typeof item?.s     === 'string' ? item.s :
                        typeof item?.state === 'string' ? item.state :
                        null;
                    if (stateStr === null
                        || stateStr === 'unavailable'
                        || stateStr === 'unknown'
                        || stateStr === '')
                    {
                        continue;
                    }
                    const v = parseFloat(stateStr);
                    if (!isFinite(v))
                    {
                        continue;
                    }
                    let ts: Date | null = null;
                    if (typeof item?.lu === 'number')
                    {
                        ts = new Date(item.lu * 1000);
                    }
                    else if (typeof item?.last_updated === 'string')
                    {
                        ts = new Date(item.last_updated);
                    }
                    else if (typeof item?.last_changed === 'string')
                    {
                        ts = new Date(item.last_changed);
                    }
                    if (!ts || isNaN(ts.getTime()))
                    {
                        continue;
                    }
                    times.push(ts);
                    values.push(v);
                }
                return { times, values };
            };

            if (socEntity)
            {
                const series = parseSeries(result?.[socEntity] ?? []);
                //Clamp SoC samples to [0, 100] in the history too — same
                //out-of-range tolerance as the live read.
                series.values = series.values.map(v => Math.max(0, Math.min(100, v)));
                this._batterySocHistory = series;
            }
            else
            {
                this._batterySocHistory = null;
            }
            if (powerEntity)
            {
                this._batteryPowerHistory = parseSeries(result?.[powerEntity] ?? []);
            }
            else
            {
                this._batteryPowerHistory = null;
            }
        }
        catch (e)
        {
            console.warn('[HELIOS] battery history fetch failed:', e);
            this._batterySocHistory   = { times: [], values: [] };
            this._batteryPowerHistory = { times: [], values: [] };
        }
        finally
        {
            this._batteryFetching = false;
        }
    }

    //Locate the history sample at or before `time` and return its
    //value, or null if the time falls outside the fetched window. A
    //60 s grace at the tail keeps "scrub to live" resolving cleanly
    //(same convention as the PV chip).
    private _batterySampleAtTime(
        hist: { times: Date[]; values: number[] } | null, time: Date
    ): number | null
    {
        if (!hist || hist.times.length === 0)
        {
            return null;
        }
        const tMs = time.getTime();
        const firstMs = hist.times[0].getTime();
        const lastMs  = hist.times[hist.times.length - 1].getTime();
        if (tMs < firstMs || tMs > lastMs + 60_000)
        {
            return null;
        }
        let idx = hist.times.length - 1;
        for (let i = 0; i < hist.times.length; i++)
        {
            if (hist.times[i].getTime() > tMs)
            {
                idx = i - 1;
                break;
            }
        }
        if (idx < 0) { idx = 0; }
        return hist.values[idx];
    }

    //Format a signed battery power value for the chip. Mirrors
    //_formatPvValue's W ↔ kW switching but always prefixes a sign so
    //the user can tell charging from discharging at a glance.
    private _formatBatteryPower(value: number, unit: string): string
    {
        const lu = (unit || '').trim().toLowerCase();
        const sign = value > 0 ? '+' : (value < 0 ? '−' : '');
        const abs  = Math.abs(value);

        if (lu === 'w' && abs >= 1000)
        {
            return `${sign}${(abs / 1000).toFixed(2)} kW`;
        }
        if (lu === 'w')
        {
            return `${sign}${Math.round(abs)} W`;
        }
        if (lu === 'kw')
        {
            return `${sign}${abs.toFixed(2)} kW`;
        }
        //Unknown unit — pass through verbatim so the user still
        //sees the configured entity's value with its own unit.
        return `${sign}${abs}${unit ? ' ' + unit : ''}`;
    }

    private async _fetchPvHistory(entityId: string, start: Date, end: Date): Promise<void>
    {
        if (!this.hass?.callWS)
        {
            return;
        }
        this._pvFetching = true;
        try
        {
            //History only exists up to "now" — anything past that is
            //the forecast half of the timeline and has no production
            //data. Clamp the fetch end so we don't waste a roundtrip
            //asking HA for empty future buckets.
            const now = new Date();
            const fetchEnd = end > now ? now : end;
            if (start >= fetchEnd)
            {
                this._pvHistory = { times: [], values: [] };
                return;
            }

            const result: any = await this.hass.callWS({
                type:             'history/history_during_period',
                start_time:       start.toISOString(),
                end_time:         fetchEnd.toISOString(),
                entity_ids:       [entityId],
                minimal_response: true,
                no_attributes:    true
            });

            const arr: any[] = (result && result[entityId]) ?? [];
            const times:  Date[]   = [];
            const values: number[] = [];

            for (const item of arr)
            {
                //HA's history payload uses a few different field
                //layouts depending on the requested options and the
                //version of the core; cover the common ones.
                const stateStr =
                    typeof item?.s === 'string'      ? item.s :
                    typeof item?.state === 'string'  ? item.state :
                    null;
                if (stateStr === null
                    || stateStr === 'unavailable'
                    || stateStr === 'unknown'
                    || stateStr === '')
                {
                    continue;
                }
                const v = parseFloat(stateStr);
                if (!isFinite(v))
                {
                    continue;
                }

                let ts: Date | null = null;
                if (typeof item?.lu === 'number')
                {
                    //minimal_response delivers epoch seconds as a float.
                    ts = new Date(item.lu * 1000);
                }
                else if (typeof item?.last_updated === 'string')
                {
                    ts = new Date(item.last_updated);
                }
                else if (typeof item?.last_changed === 'string')
                {
                    ts = new Date(item.last_changed);
                }
                if (!ts || isNaN(ts.getTime()))
                {
                    continue;
                }

                times.push(ts);
                values.push(v);
            }

            this._pvHistory = { times, values };
            //Refresh the calibration buffer with the new history slice.
            //Safe to call when _homeHourlyData isn't ready yet — the
            //helper bails out and tries again next time.
            this._updatePvCalibration();
        }
        catch (e)
        {
            console.warn('[HELIOS] PV history fetch failed:', e);
            this._pvHistory = { times: [], values: [] };
        }
        finally
        {
            this._pvFetching = false;
        }
    }


    //Engine setup

    //Debounce window before an engine is actually constructed. The
    //Home Assistant dashboard editor creates a fresh helios-card
    //preview instance on every config edit, and v1.2.2 telemetry
    //showed 24 card instances spun up during a single 5-edit
    //session — most of them destroyed in well under half a second.
    //Each card instance triggered a full MapLibre engine
    //instantiation, which created a WebGL context. Safari mobile
    //caps active contexts at ~8 and starts recycling under that
    //load — the root cause of the FPS drift and the iOS
    //black-screen lockup.
    //
    //The fix: defer the actual engine construction by 500 ms.
    //  - A card that's destroyed inside that window never spawns
    //    an engine and never holds a WebGL context.
    //  - A card that survives the window (the user's actual
    //    dashboard card, or the stable editor preview the user is
    //    looking at) gets its engine after a barely-perceptible
    //    half-second delay.
    private static readonly INIT_DEBOUNCE_MS = 500;
    private _initDebounceTimer?: number;

    private _initEngine(): void
    {
        //Hard skip: a card rendered inside HA's dashboard editor
        //preview never spawns an engine. Each preview instance would
        //claim a WebGL context that Safari mobile can't release fast
        //enough — root cause of the drift and the iOS black screen.
        //The actual dashboard card on the live page keeps its full
        //rendering.
        if (this._isInEditorPreview)
        {
            //Bump a counter so we can see in __heliosStats how many
            //preview cards the detection actually caught.
            try
            {
                const w = window as unknown as { __heliosStats?: { enginesSkippedAsPreview?: number } };
                if (w.__heliosStats)
                {
                    w.__heliosStats.enginesSkippedAsPreview =
                        (w.__heliosStats.enginesSkippedAsPreview ?? 0) + 1;
                }
            }
            catch (_) {}
            return;
        }
        this._initInflight = true;

        //Cancel any pending debounce — a fresh _initEngine() call
        //means the identity / config has just changed and we want
        //the timer to restart its 500 ms clock.
        if (this._initDebounceTimer !== undefined)
        {
            window.clearTimeout(this._initDebounceTimer);
        }
        this._initDebounceTimer = window.setTimeout(() =>
        {
            this._initDebounceTimer = undefined;
            this._initEngineNow();
        }, HeliosCard.INIT_DEBOUNCE_MS);
    }

    private _initEngineNow(): void
    {
        requestAnimationFrame(() =>
        {
            const container = this.shadowRoot?.getElementById('map-container') as HTMLElement | null;
            if (!container || !this.config || !this.hass?.config)
            {
                this._initInflight = false;
                return;
            }
            const apiKey = String(this.config['maptiler-api-key'] ?? '').trim();
            if (!apiKey)
            {
                this._initInflight = false;
                return;
            }
            const { latitude: lat, longitude: lon } = this.hass.config;
            if (lat === undefined || lon === undefined)
            {
                this._initInflight = false;
                return;
            }
            //hass.config.elevation is the user-defined home altitude
            //(metres above sea level) from HA's General settings. It
            //may be undefined on older HA installs or unconfigured
            //instances; the engine and the auxiliary fetch both
            //handle that case by simply not sending &elevation= and
            //letting Open-Meteo fall back to its own DEM.
            const elevation = this.hass.config.elevation;

            this._engine?.cleanup();
            //Defensive: clear anything MapLibre left in the container
            //(canvas, telemetry div, marker root). Older revisions of
            //MapLibre occasionally left a dead canvas behind, which
            //would stack a second 3D context on top of the new one.
            while (container.firstChild)
            {
                container.removeChild(container.firstChild);
            }
            this._engine = new HeliosEngine(container, this.config, [lon, lat], elevation);

            this._engine.onFetchStart = () =>
            {
                this._fetching = true;
            };
            this._engine.onFetchEnd = () =>
            {
                this._fetching = false;
            };
            this._engine.onWeatherUpdate = data =>
            {
                this._cloudCover         = data.cloudCover;
                this._cloudLow           = data.cloudLow;
                this._cloudMid           = data.cloudMid;
                this._cloudHigh          = data.cloudHigh;
                this._timeRange          = data.timeRange;
                this._isLiveMode         = data.isLiveTime;
                //Pull the hourly series the chart canvas plots. Same
                //cadence as the gradients above, since both consume
                //the engine's hourly data refresh.
                this._chartSeries        = this._engine?.getTimelineSeries() ?? null;
                //Fresh hourly cloud data — refresh the PV calibration
                //fit so the prediction line follows the latest weather.
                this._updatePvCalibration();
                //First weather update is also our cue to ask the
                //engine for the initial label layout — by this point
                //the map has loaded its style and the projection
                //matrix is available. Subsequent transforms refresh
                //via onMapTransform.
                this._refreshOverlays();
            };
            this._engine.onCloudHover = e =>
            {
                this._cloudHover  = e.hover;
                this._cloudHoverX = e.x;
                this._cloudHoverY = e.y;
                //If the cursor sits in the right half of the card,
                //pin the tooltip to the LEFT of the cursor instead
                //of the right, so it never overflows past the card
                //edge.
                const mc = this.renderRoot.querySelector('#map-container');
                const w  = (mc as HTMLElement | null)?.clientWidth ?? 0;
                this._cloudHoverFlip = w > 0 && e.x > w / 2;
            };
            this._engine.onMapTransform = () =>
            {
                this._refreshOverlays();
            };
            //WebGL context loss recovery — iOS Safari recycles
            //contexts under memory pressure. The engine emits this
            //hook from its webglcontextlost listener; we tear down
            //the dead engine and re-init from scratch on the next
            //animation frame so the user never sees a stuck black
            //canvas. The _lastApiKey / _lastHomeKey are reset so
            //the identity-change branch of updated() takes the
            //re-init path.
            this._engine.onContextLost = () =>
            {
                this._lastApiKey  = '';
                this._lastHomeKey = '';
                if (!this._initInflight) this._initEngine();
            };

            this._initInflight = false;
        });
    }

    //Pull fresh screen-space layouts from the engine for both the
    //cloud-cover percentage label and the solar-arc / sun / ray.
    //Called on every map transform broadcast by the engine, plus
    //once at first weather update (the engine's projection matrix
    //is only ready after the style has loaded), plus on every clock
    //tick when in live mode (the sun position depends on the time).
    private _refreshOverlays(): void
    {
        const layout = this._engine?.projectHomeLabelLayout() ?? null;
        this._labelLayout = layout;

        const t = this._selectedTime ?? this._now;
        this._sunScene = this._engine ? this._engine.projectSunScene(t) : null;
    }

    //Segments now share one fixed colour (the configured sun
    //colour). Depth perception comes entirely from the per-segment
    //stroke width modulated by `nearness`, kept untouched: it is the
    //2D-on-3D cue we explicitly chose not to overload with another
    //dimension. Irradiance is still kept on the segment shape — the
    //caller doesn't use it any more, but removing it would broaden
    //the change surface unnecessarily; we just stop *colouring* with
    //it.
    private _buildArcSegments(
        arc:   ReadonlyArray<{
            x: number; y: number;
            irradiance: number; nearness: number; belowHorizon: boolean;
        }>,
        sunColor: string
    ): Array<{
        x1: number; y1: number; x2: number; y2: number;
        color: string; nearness: number; belowHorizon: boolean;
    }>
    {
        const out: Array<{
            x1: number; y1: number; x2: number; y2: number;
            color: string; nearness: number; belowHorizon: boolean;
        }> = [];
        for (let i = 0; i < arc.length - 1; i++)
        {
            const a = arc[i];
            const b = arc[i + 1];
            out.push({
                x1: a.x, y1: a.y,
                x2: b.x, y2: b.y,
                color:        sunColor,
                nearness:     0.5 * (a.nearness + b.nearness),
                belowHorizon: a.belowHorizon || b.belowHorizon
            });
        }
        return out;
    }

    //Re-renders the card every second.
    //  - In live mode this advances both the clock display and the live
    //    cursor on the timeline (positioned from Date.now() on every render).
    //  - In scrubbed mode the clock shows the selected instant and the
    //    live cursor still continues to move underneath as wall-clock
    //    time progresses.
    private _tick(): void
    {
        this._now = new Date();
        //The sun moves with time, so refresh its screen-space
        //position too. The other parts of _refreshOverlays
        //(percentage label) are camera-driven and won't change
        //here, but recomputing them is cheap and keeps the code
        //path uniform.
        this._refreshOverlays();
    }


    //Timeline pointer interaction

    private _trackElement:   HTMLElement | null = null;
    private _trackPointerId: number | null      = null;

    private _onTimelinePointerDown(e: PointerEvent): void
    {
        if (!this._timeRange)
        {
            return;
        }
        const track = e.currentTarget as HTMLElement;
        track.setPointerCapture(e.pointerId);
        this._trackElement   = track;
        this._trackPointerId = e.pointerId;
        track.addEventListener('pointermove',   this._boundPointerMove);
        track.addEventListener('pointerup',     this._boundPointerUp);
        track.addEventListener('pointercancel', this._boundPointerUp);
        this._applyTimelinePointer(e);
    }

    private _boundPointerMove = (e: PointerEvent): void => this._onTimelinePointerMove(e);
    private _boundPointerUp   = (e: PointerEvent): void => this._onTimelinePointerUp(e);

    private _onTimelinePointerMove(e: PointerEvent): void
    {
        if (e.pointerId !== this._trackPointerId)
        {
            return;
        }
        this._applyTimelinePointer(e);
    }

    private _onTimelinePointerUp(e: PointerEvent): void
    {
        if (e.pointerId !== this._trackPointerId)
        {
            return;
        }
        const track = this._trackElement;
        if (track)
        {
            try
            {
                track.releasePointerCapture(e.pointerId);
            }
            catch (_) {}
            track.removeEventListener('pointermove',   this._boundPointerMove);
            track.removeEventListener('pointerup',     this._boundPointerUp);
            track.removeEventListener('pointercancel', this._boundPointerUp);
        }
        this._trackElement   = null;
        this._trackPointerId = null;
    }

    private _applyTimelinePointer(e: PointerEvent): void
    {
        if (!this._timeRange)
        {
            return;
        }
        const track   = e.currentTarget as HTMLElement;
        const rect    = track.getBoundingClientRect();
        const frac    = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const rangeMs = this._timeRange.end.getTime() - this._timeRange.start.getTime();
        const t       = new Date(this._timeRange.start.getTime() + frac * rangeMs);

        if (t.getMinutes() >= 30)
        {
            t.setHours(t.getHours() + 1);
        }
        t.setMinutes(0, 0, 0);

        if (this._selectedTime && this._selectedTime.getTime() === t.getTime())
        {
            return;
        }

        this._selectedTime = t;
        this._isLiveMode   = false;
        this._engine?.setSelectedTime(t);
    }

    private _resetToLive(): void
    {
        this._selectedTime = null;
        this._isLiveMode   = true;
        this._engine?.setSelectedTime(null);
    }


    //Timeline rendering

    //Build the SVG chart of the chart card: irradiance W/m² as a
    //gradient-filled area, cloud cover as a translucent grey area
    //layered on top, plus a scrub cursor line that mirrors the
    //selected instant (or "now" in live mode).
    //
    //The chart uses a fixed-resolution viewBox (1000 × 100) with
    //preserveAspectRatio="none", so it stretches horizontally
    //with the container while keeping vertical proportions intact.
    //All path coordinates are computed against this viewBox and
    //the browser handles the actual scaling.
    //Mirror chart.
    //
    //Two areas sharing a horizontal midline:
    //  - top half: irradiance W/m², "the sun pushes upward". Filled
    //    with the configured sun colour, gradient-faded toward the
    //    midline so the chart never feels flat.
    //  - bottom half: cloud cover %, "the clouds press down". Filled
    //    with the configured cloud colour, mirrored gradient.
    //
    //The metaphor maps the user's mental model: when the sun pushes
    //past what the clouds press in, production is high; when the
    //clouds reach further than the sun's push, production is low.
    //The two areas inhabit non-overlapping pixel rows, so we never
    //have to worry about z-order or transparency stacking.
    private _renderChart(): TemplateResult
    {
        const series = this._chartSeries;
        const range  = this._timeRange;
        if (!series || !range || series.times.length < 2)
        {
            return html`<svg class="hc-chart-svg" viewBox="0 0 1000 100" preserveAspectRatio="none"></svg>`;
        }

        const W      = 1000;
        const H      = 100;
        //Midline sits exactly halfway. The two halves get H/2 = 50
        //pixels of vertical resolution each — enough to read the
        //shape of a typical day at a glance.
        const MID    = H / 2;
        const HALF   = H / 2;

        const startMs = range.start.getTime();
        const rangeMs = range.end.getTime() - startMs;
        if (rangeMs <= 0)
        {
            return html`<svg class="hc-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"></svg>`;
        }

        const xOf = (t: Date): number =>
            ((t.getTime() - startMs) / rangeMs) * W;

        //Top area Y: 0 W/m² sits on the midline, 1000 W/m² sits at
        //the top edge of the SVG. Anything above clamps to the top.
        const yIrr = (w: number): number =>
            MID - Math.max(0, Math.min(1, w / 1000)) * HALF;

        //Bottom area Y: 0 % sits on the midline, 100 % sits at the
        //bottom edge. Pure linear (cloud cover is already 0..100).
        const yCloud = (pct: number): number =>
            MID + Math.max(0, Math.min(1, pct / 100)) * HALF;

        const irrPoints = series.times.map((t, i) =>
            `${xOf(t).toFixed(2)},${yIrr(series.irradiance[i] ?? 0).toFixed(2)}`);
        const cloudPoints = series.times.map((t, i) =>
            `${xOf(t).toFixed(2)},${yCloud(series.cloud[i] ?? 0).toFixed(2)}`);

        //Both areas close back to the midline (not the SVG edge),
        //so each half stays anchored to its own baseline.
        const x0 = xOf(series.times[0]);
        const xN = xOf(series.times[series.times.length - 1]);
        const irrArea = `M ${x0},${MID} L ${irrPoints.join(' L ')} L ${xN},${MID} Z`;
        const cloudArea = `M ${x0},${MID} L ${cloudPoints.join(' L ')} L ${xN},${MID} Z`;

        //Stroke-only paths layered on top of the filled areas to
        //accentuate the curve outline. Same point sequence as the
        //areas, minus the closing segment back to the midline so
        //we don't draw a horizontal line across the baseline.
        const irrLine   = `M ${irrPoints.join(' L ')}`;
        const cloudLine = `M ${cloudPoints.join(' L ')}`;

        const sunColor   = cfgHex(this.config?.['sun-color'],   DEFAULT_SUN_COLOR_HEX);
        const cloudColor = cfgHex(this.config?.['cloud-color'], DEFAULT_CLOUD_COLOR_HEX);

        //Day-boundary X positions in viewBox units (midnight of each
        //local day inside the time range). Drawn as faint dotted
        //vertical lines spanning the full chart height — same role
        //as the day chips on the midline, just visual separators.
        const startMsAbs = range.start.getTime();
        const endMsAbs   = range.end.getTime();
        const dayXs: number[] = [];
        const dCursor = new Date(range.start);
        dCursor.setHours(0, 0, 0, 0);
        while (dCursor.getTime() <= endMsAbs)
        {
            const next = new Date(dCursor);
            next.setDate(next.getDate() + 1);
            if (dCursor.getTime() > startMsAbs && dCursor.getTime() < endMsAbs)
            {
                dayXs.push(xOf(dCursor));
            }
            dCursor.setTime(next.getTime());
        }

        //Hour-boundary X positions, used to draw small vertical
        //ticks centred on the midline (one per hour). Midnights are
        //skipped — those already get a full-height day separator.
        const hourXs: number[] = [];
        const hCursor = new Date(range.start);
        hCursor.setMinutes(0, 0, 0);
        hCursor.setHours(hCursor.getHours() + 1);
        while (hCursor.getTime() <= endMsAbs)
        {
            if (hCursor.getTime() > startMsAbs && hCursor.getHours() !== 0)
            {
                hourXs.push(xOf(hCursor));
            }
            hCursor.setHours(hCursor.getHours() + 1);
        }
        const HOUR_TICK_HALF = 3;

        return html`
            <svg
                class="hc-chart-svg"
                viewBox="0 0 ${W} ${H}"
                preserveAspectRatio="none"
            >
                <path
                    d="${irrArea}"
                    fill="${sunColor}"
                    fill-opacity="0.5"
                ></path>
                <path
                    d="${cloudArea}"
                    fill="${cloudColor}"
                    fill-opacity="0.5"
                ></path>
                <path
                    class="hc-chart-line"
                    d="${irrLine}"
                    stroke="${sunColor}"
                ></path>
                <path
                    class="hc-chart-line"
                    d="${cloudLine}"
                    stroke="${cloudColor}"
                ></path>
                ${dayXs.map(x => svg`
                    <line
                        class="hc-day-sep"
                        x1="${x.toFixed(2)}" y1="0"
                        x2="${x.toFixed(2)}" y2="${H}"
                    ></line>
                `)}
                <line
                    class="hc-chart-mid"
                    x1="0" y1="${MID}"
                    x2="${W}" y2="${MID}"
                ></line>
                ${hourXs.map(x => svg`
                    <line
                        class="hc-hour-tick"
                        x1="${x.toFixed(2)}" y1="${MID - HOUR_TICK_HALF}"
                        x2="${x.toFixed(2)}" y2="${MID + HOUR_TICK_HALF}"
                    ></line>
                `)}
            </svg>
        `;
    }

    //Render the optional photovoltaic production graph that sits
    //above the main timeline chart. Same X axis as the main chart
    //(time range pulled from this._timeRange) so day boundaries and
    //the scrub cursor line up vertically across both blocks. The
    //curve is plotted from this._pvHistory (fetched via the HA
    //history WebSocket command); future data is intentionally left
    //blank — the curve naturally stops at the last recorded sample
    //since there's no production data after "now".
    private _renderPvChart(): TemplateResult
    {
        const range = this._timeRange;
        const hist  = this._pvHistory;
        const W     = 1000;
        const H     = 100;

        if (!range)
        {
            return html`<svg class="hc-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"></svg>`;
        }

        const startMs = range.start.getTime();
        const rangeMs = range.end.getTime() - startMs;
        if (rangeMs <= 0)
        {
            return html`<svg class="hc-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"></svg>`;
        }

        const pvColor = cfgHex(this.config?.['pv-color'], DEFAULT_PV_COLOR_HEX);

        //Day-boundary X positions, same computation as the main
        //chart so the dotted separators line up across the two.
        const endMsAbs = range.end.getTime();
        const dayXs: number[] = [];
        const dCursor = new Date(range.start);
        dCursor.setHours(0, 0, 0, 0);
        while (dCursor.getTime() <= endMsAbs)
        {
            const next = new Date(dCursor);
            next.setDate(next.getDate() + 1);
            if (dCursor.getTime() > startMs && dCursor.getTime() < endMsAbs)
            {
                dayXs.push(((dCursor.getTime() - startMs) / rangeMs) * W);
            }
            dCursor.setTime(next.getTime());
        }

        //If we have no history yet, render the empty frame (axis
        //grid + day separators) so the graph card never looks
        //"broken" while data is being fetched.
        //
        //If the entity reports a cumulative energy (Wh / kWh / MWh)
        //we differentiate it into a power-rate series so the curve
        //reflects production at each instant rather than the
        //ever-climbing daily total. The user said it best: "produc-
        //tion par minute, pas totale". Negative deltas (a daily
        //"energy today" sensor flipping back to 0 at midnight) are
        //treated as resets and dropped, and abnormally large gaps
        //are skipped to avoid smearing one big jump across an hour
        //of empty time.
        const lu = (this._pvUnit || '').toLowerCase();
        const isCumulativeEnergy = lu === 'wh' || lu === 'kwh' || lu === 'mwh';

        let rawTimes:  Date[]   = hist?.times  ?? [];
        let rawValues: number[] = hist?.values ?? [];

        if (isCumulativeEnergy && rawTimes.length >= 2)
        {
            const dTimes:  Date[]   = [];
            const dValues: number[] = [];
            for (let i = 1; i < rawTimes.length; i++)
            {
                const dtH = (rawTimes[i].getTime() - rawTimes[i - 1].getTime()) / 3_600_000;
                if (dtH <= 0 || dtH > 6)
                {
                    continue;
                }
                const dv = rawValues[i] - rawValues[i - 1];
                if (dv < 0)
                {
                    //Counter reset (typical for "energy today"
                    //sensors that zero out at midnight).
                    continue;
                }
                dTimes.push(rawTimes[i]);
                dValues.push(dv / dtH);
            }
            rawTimes  = dTimes;
            rawValues = dValues;
        }

        const samples: Array<{ t: Date; v: number }> = [];
        for (let i = 0; i < rawTimes.length; i++)
        {
            const t = rawTimes[i];
            const v = rawValues[i];
            if (t.getTime() < startMs || t.getTime() > endMsAbs)
            {
                continue;
            }
            if (!isFinite(v))
            {
                continue;
            }
            samples.push({ t, v });
        }

        const xOf = (t: Date): number =>
            ((t.getTime() - startMs) / rangeMs) * W;

        //Predicted PV for hours from "now" forward — uses the live
        //calibration scalar (W per percent of STC) learned from past
        //samples. Skipped silently when there aren't enough samples
        //yet to trust the fit (see _calibrateK / PV_CALIB_MIN_SAMPLES).
        const k = this._pvCalibK;
        const lat = this.hass?.config?.latitude;
        const lon = this.hass?.config?.longitude;
        const series = this._chartSeries;
        const predictedSamples: Array<{ t: Date; v: number }> = [];
        if (k !== null && series && typeof lat === 'number' && typeof lon === 'number')
        {
            const nowMs = Date.now();
            for (let i = 0; i < series.times.length; i++)
            {
                const tMs = series.times[i].getTime();
                if (tMs <  nowMs)   continue;             //future only
                if (tMs <  startMs) continue;
                if (tMs >  endMsAbs) continue;
                const pct = computePvPower(series.times[i], lat, lon, series.cloud[i] ?? 0);
                if (pct <= 0) continue;
                predictedSamples.push({ t: series.times[i], v: pct * k });
            }
        }

        //Auto-scale: the Y axis maps 0 to the bottom edge and the
        //series' running max to the top edge. With a min of 1 we
        //avoid division-by-zero when the series is all-zero (early
        //morning, prolonged outage) and keep the curve visibly
        //pinned to the baseline rather than silently disappearing.
        //Predicted samples also feed into yMax so the forecast line
        //doesn't clip when expected production exceeds anything
        //the user has produced lately.
        let yMax = 1;
        for (const s of samples)          { if (s.v > yMax) yMax = s.v; }
        for (const s of predictedSamples) { if (s.v > yMax) yMax = s.v; }
        const yOf = (v: number): number =>
            H - Math.max(0, Math.min(1, v / yMax)) * H;

        const points = samples.map(s =>
            `${xOf(s.t).toFixed(2)},${yOf(s.v).toFixed(2)}`);

        let area  = '';
        let line  = '';
        if (points.length >= 2)
        {
            const x0 = xOf(samples[0].t);
            const xN = xOf(samples[samples.length - 1].t);
            area = `M ${x0},${H} L ${points.join(' L ')} L ${xN},${H} Z`;
            line = `M ${points.join(' L ')}`;
        }

        let predictedLine = '';
        if (predictedSamples.length >= 2)
        {
            const pPoints = predictedSamples.map(s =>
                `${xOf(s.t).toFixed(2)},${yOf(s.v).toFixed(2)}`);
            predictedLine = `M ${pPoints.join(' L ')}`;
        }

        return html`
            <svg
                class="hc-chart-svg"
                viewBox="0 0 ${W} ${H}"
                preserveAspectRatio="none"
            >
                ${dayXs.map(x => svg`
                    <line
                        class="hc-day-sep"
                        x1="${x.toFixed(2)}" y1="0"
                        x2="${x.toFixed(2)}" y2="${H}"
                    ></line>
                `)}
                ${area ? svg`
                    <path
                        d="${area}"
                        fill="${pvColor}"
                        fill-opacity="0.5"
                    ></path>
                    <path
                        class="hc-chart-line"
                        d="${line}"
                        stroke="${pvColor}"
                    ></path>
                ` : nothing}
                ${predictedLine ? svg`
                    <path
                        class="hc-chart-line hc-chart-predicted"
                        d="${predictedLine}"
                        stroke="${pvColor}"
                    ></path>
                ` : nothing}
            </svg>
        `;
    }

    //The thin track now carries only the cursors. Day
    //separators live inside the chart card SVG (dotted vertical
    //lines) and the scrub time label has been promoted to a chip
    //above the chart card.
    private _renderTimelineTicks(): TemplateResult
    {
        if (!this._timeRange)
        {
            return html``;
        }

        const { start, end } = this._timeRange;
        const rangeMs = end.getTime() - start.getTime();
        const now     = new Date();
        const toPct   = (d: Date): number =>
            Math.max(0, Math.min(100, (d.getTime() - start.getTime()) / rangeMs * 100));

        const nowPct        = toPct(now);
        const showSelected  = !this._isLiveMode && this._selectedTime !== null;
        const selPct        = showSelected ? toPct(this._selectedTime!) : 0;

        return html`
            <div class="tb-cursor-now" style="left:${nowPct}%"></div>
            ${showSelected ? html`
                <div class="tb-cursor-sel" style="left:${selPct}%"></div>
            ` : nothing}
        `;
    }

    //Day labels rendered as small white chips overlaying the chart
    //card on its midline (between the irradiance and cloud halves).
    //Same chip styling as the on-map cloud and W/m² readouts, so all
    //three feel like the same family. Each chip is centred on the
    //middle of its day's segment in the time range.
    private _renderTimelineDayLabels(): TemplateResult
    {
        if (!this._timeRange)
        {
            return html``;
        }

        const { start, end } = this._timeRange;
        const rangeMs = end.getTime() - start.getTime();
        const now     = new Date();
        const toPct   = (d: Date): number =>
            Math.max(0, Math.min(100, (d.getTime() - start.getTime()) / rangeMs * 100));

        const today0 = new Date(now);
        today0.setHours(0, 0, 0, 0);

        const labels: TemplateResult[] = [];
        const cursor = new Date(start);
        cursor.setHours(0, 0, 0, 0);

        while (cursor.getTime() <= end.getTime())
        {
            const next = new Date(cursor);
            next.setDate(next.getDate() + 1);

            const segStart = Math.max(start.getTime(), cursor.getTime());
            const segEnd   = Math.min(end.getTime(),   next.getTime());

            if (segEnd > segStart)
            {
                const pStart   = toPct(new Date(segStart));
                const pEnd     = toPct(new Date(segEnd));
                const w        = pEnd - pStart;
                const dayDelta = Math.round((cursor.getTime() - today0.getTime()) / 86_400_000);
                const isToday  = dayDelta === 0;

                const label    = formatDate(cursor, this.config?.['date-format']);
                const centre   = pStart + w / 2;
                const labelPct = Math.min(Math.max(centre, 6), 94);

                labels.push(html`
                    <div
                        class="tb-day-label ${isToday ? 'tb-day-label-today' : ''}"
                        style="left:${labelPct}%"
                    >${label}</div>
                `);
            }

            cursor.setTime(next.getTime());
        }

        return html`<div class="tb-day-labels">${labels}</div>`;
    }

    private _formatSelTime(t: Date): string
    {
        const dateLabel = formatDate(t, this.config?.['date-format']);
        const is12h = String(this.config?.['time-format'] ?? '24h').toLowerCase() === '12h';
        //hourCycle is more authoritative than hour12 — some browser /
        //locale combinations silently ignore hour12: true and keep the
        //locale's preferred format (typically 24h for fr-FR), which
        //is the bug the user was hitting on the scrub chip.
        const timeLabel = t.toLocaleTimeString([], {
            hour:      '2-digit',
            minute:    '2-digit',
            hourCycle: is12h ? 'h12' : 'h23'
        } as Intl.DateTimeFormatOptions);
        return `${dateLabel} · ${timeLabel}`;
    }

    //Compute the production rate at an arbitrary historical time
    //(used when the user scrubs the timeline into the past). For
    //a cumulative entity we differentiate the two history samples
    //bracketing the requested instant; for a power entity we just
    //return the value of the closest historical sample. Returns
    //null when the requested time falls outside the fetched
    //history window — the chip is then hidden by the caller, which
    //is the right behaviour for the future half of the timeline
    //(no production data exists there yet).
    private _pvRateAtTime(time: Date): { value: number; unit: string } | null
    {
        const hist = this._pvHistory;
        if (!hist || hist.times.length === 0)
        {
            return null;
        }

        const tMs = time.getTime();
        const firstMs = hist.times[0].getTime();
        const lastMs  = hist.times[hist.times.length - 1].getTime();
        if (tMs < firstMs || tMs > lastMs + 60_000)
        {
            //Outside the history window. Allow a 60 s grace at the
            //tail so a "live" scrub to "now" still resolves.
            return null;
        }

        //Classification — same logic as _currentPvRate. Repeated
        //inline so each helper is self-contained.
        const entity   = String(this.config?.['pv-power-entity'] ?? '').trim();
        const stateObj = this.hass?.states?.[entity];
        const sc       = String(stateObj?.attributes?.state_class  ?? '').toLowerCase();
        const dc       = String(stateObj?.attributes?.device_class ?? '').toLowerCase();
        const u        = (this._pvUnit || '').trim();
        const lu       = u.toLowerCase();

        let isCumulative: boolean;
        if (sc === 'total_increasing' || sc === 'total') isCumulative = true;
        else if (sc === 'measurement') isCumulative = false;
        else if (dc === 'energy') isCumulative = true;
        else if (dc === 'power') isCumulative = false;
        else isCumulative = lu === 'wh' || lu === 'kwh' || lu === 'mwh';

        let rateUnit: string;
        if (lu === 'wh')       rateUnit = 'W';
        else if (lu === 'kwh') rateUnit = 'kW';
        else if (lu === 'mwh') rateUnit = 'MW';
        else                   rateUnit = u ? `${u}/h` : '';

        //Locate the index of the sample at or before `time` — linear
        //scan is fine for the ~96 samples a typical 4-day window
        //carries.
        let idx = hist.times.length - 1;
        for (let i = 0; i < hist.times.length; i++)
        {
            if (hist.times[i].getTime() > tMs)
            {
                idx = i - 1;
                break;
            }
        }
        if (idx < 0)
        {
            idx = 0;
        }

        if (!isCumulative)
        {
            //Power sensor: just return the historical value.
            return { value: hist.values[idx], unit: u };
        }

        //Cumulative: differentiate around the located index.
        let lo = idx;
        let hi = idx + 1 < hist.times.length ? idx + 1 : idx;
        if (lo === hi)
        {
            //At the boundary — fall back to the previous pair.
            lo = Math.max(0, idx - 1);
            hi = idx;
        }
        if (lo === hi)
        {
            //Single-sample history — no rate possible.
            return { value: 0, unit: rateUnit };
        }
        const dtH = (hist.times[hi].getTime() - hist.times[lo].getTime()) / 3_600_000;
        if (dtH <= 0)
        {
            return { value: 0, unit: rateUnit };
        }
        const dv = hist.values[hi] - hist.values[lo];
        if (dv < 0)
        {
            //Counter reset between the two samples → no production
            //(rate is meaningless across a midnight reset).
            return { value: 0, unit: rateUnit };
        }
        return { value: dv / dtH, unit: rateUnit };
    }

    //Compute the instantaneous PV production rate for "now".
    //
    //  - Cumulative entity (state_class total_increasing|total,
    //    device_class energy, or unit Wh/kWh/MWh) → differentiate
    //    over the rolling sample buffer (which is filled live each
    //    Lit cycle), anchored on the sample closest to ~60 s ago
    //    so the readout reflects the last minute of production.
    //  - Instantaneous entity (anything else) → the entity's own
    //    state value already IS the rate.
    //
    //Returns null when no usable rate can be derived (no entity,
    //no buffer yet, counter reset). The caller falls back to the
    //raw current state in that case so the chip stays populated.
    private _currentPvRate(): { value: number; unit: string } | null
    {
        if (this._pvCurrent === null)
        {
            return null;
        }

        const entity   = String(this.config?.['pv-power-entity'] ?? '').trim();
        const stateObj = this.hass?.states?.[entity];
        const sc       = String(stateObj?.attributes?.state_class  ?? '').toLowerCase();
        const dc       = String(stateObj?.attributes?.device_class ?? '').toLowerCase();
        const u        = (this._pvUnit || '').trim();
        const lu       = u.toLowerCase();

        //HA's classification taxonomy is authoritative when set;
        //fall back to the unit string for entities (custom
        //template sensors mostly) that omit state_class /
        //device_class.
        let isCumulative: boolean;
        if (sc === 'total_increasing' || sc === 'total')
        {
            isCumulative = true;
        }
        else if (sc === 'measurement')
        {
            isCumulative = false;
        }
        else if (dc === 'energy')
        {
            isCumulative = true;
        }
        else if (dc === 'power')
        {
            isCumulative = false;
        }
        else
        {
            isCumulative = lu === 'wh' || lu === 'kwh' || lu === 'mwh';
        }

        if (!isCumulative)
        {
            //Instantaneous sensor — the live state IS the rate.
            return { value: this._pvCurrent, unit: u };
        }

        //Choose the rate unit so the formatted readout reads as
        //power, not as energy-per-something. When the source unit
        //is unknown, append "/h" so the user still sees a sensible
        //label (e.g. "12 units/h") instead of a bare number.
        let rateUnit: string;
        if (lu === 'wh')       rateUnit = 'W';
        else if (lu === 'kwh') rateUnit = 'kW';
        else if (lu === 'mwh') rateUnit = 'MW';
        else                   rateUnit = u ? `${u}/h` : '';

        //Cumulative path: from this point on we MUST return a rate
        //object — never null. Showing the raw cumulative state on
        //the chip would be flat-out wrong for an "energy total"
        //sensor (e.g. lifetime kWh). When no rate can be derived
        //(entity static all night, no recent samples, no history),
        //we default to 0 — that's the truthful answer for a sensor
        //that hasn't moved.

        //Preferred path: use the rolling buffer of live samples. We
        //walk back from the newest to find the sample closest to
        //~60 s ago — that anchors the rate to a "last minute"
        //window the user explicitly asked for. If the buffer
        //doesn't cover a full minute (entity updates rarely), we
        //fall back to the oldest available sample.
        const buf = this._pvSampleBuffer;
        if (buf.length >= 2)
        {
            const last = buf[buf.length - 1];
            const target = last.t - 60_000;
            let prev = buf[0];
            for (const s of buf)
            {
                if (s.t <= target)
                {
                    prev = s;
                }
                else
                {
                    break;
                }
            }
            const dtH = (last.t - prev.t) / 3_600_000;
            if (dtH > 0)
            {
                const dv = last.v - prev.v;
                if (dv < 0)
                {
                    //Counter reset (e.g. "energy today" flipping to
                    //0 at midnight) — no meaningful rate. Drop the
                    //pre-reset samples so the next call works on a
                    //clean window.
                    this._pvSampleBuffer = [last];
                    return { value: 0, unit: rateUnit };
                }
                return { value: dv / dtH, unit: rateUnit };
            }
        }

        //Static-entity heuristic: if the entity hasn't moved for
        //a minute or more, the live state is the same as it was
        //60 s ago by definition — production rate is zero. This
        //resolves the "lifetime kWh sensor at night" case: the
        //cumulative value sits unchanged for hours, so any rate
        //we'd compute against the buffer's single sample would be
        //meaningless; the truthful answer is 0 W.
        const lastUpdatedMs = stateObj?.last_updated
            ? new Date(stateObj.last_updated).getTime()
            : null;
        if (lastUpdatedMs !== null && Date.now() - lastUpdatedMs >= 60_000)
        {
            return { value: 0, unit: rateUnit };
        }

        //Cold-start: the buffer hasn't accumulated two samples
        //yet (we just opened the dashboard) AND the entity has
        //changed in the last minute (otherwise the static check
        //above would have already returned). Diff the last two
        //historical samples so the chip is populated immediately
        //instead of waiting a full minute for a buffer to form.
        const hist = this._pvHistory;
        if (hist && hist.times.length >= 2)
        {
            const lastIdx = hist.times.length - 1;
            const prevIdx = lastIdx - 1;
            const dtH = (hist.times[lastIdx].getTime()
                       - hist.times[prevIdx].getTime()) / 3_600_000;
            if (dtH > 0)
            {
                const dv = hist.values[lastIdx] - hist.values[prevIdx];
                if (dv < 0)
                {
                    return { value: 0, unit: rateUnit };
                }
                return { value: dv / dtH, unit: rateUnit };
            }
        }

        //Default for a cumulative entity with no derivable rate
        //yet — better than misleading the user with the lifetime
        //total. Will quickly transition to a real rate as soon as
        //the buffer accumulates two samples (typically < 1 min on
        //a healthy production sensor).
        return { value: 0, unit: rateUnit };
    }

    //Convert a PV rate into watts. Used to drive animation speeds on
    //a unit-agnostic scale — the leader-line dash flow saturates at a
    //fixed wattage no matter what unit the user's sensor is in.
    private _pvNormalizeToWatts(value: number, unit: string): number
    {
        const lu = (unit || '').toLowerCase();
        if (lu === 'kw') return value * 1000;
        if (lu === 'mw') return value * 1_000_000;
        if (lu === 'w')  return value;
        //Other units (e.g. raw cumulative kWh that we couldn't
        //differentiate) — treat as 0 so the animation pauses
        //instead of mis-scaling.
        return 0;
    }


    //PV auto-calibration — maintains a rolling 14-day buffer of
    //(observedWatts, predictedNormalized) pairs aggregated per hour,
    //then fits a single scalar k via least squares so that
    //  observed ≈ k · predictedNormalized
    //
    //Storage layout:
    //  - SOURCE OF TRUTH: HA `frontend/set_user_data` (server-side,
    //    survives cache wipes / device switches / restarts, included
    //    in HA backups, per-user). Written debounced every 60 s so we
    //    don't hammer the WebSocket.
    //  - LOCAL CACHE: `window.localStorage` — read synchronously at
    //    boot for an instant first render, then reconciled with HA
    //    as soon as the WS connection is up.
    //
    //Once enough samples have accumulated (PV_CALIB_MIN_SAMPLES),
    //k is multiplied by future predicted-normalised values to draw
    //a forecast line on the PV chart. The user never has to enter
    //a "peak power" — the card learns the mapping from their own
    //history and adapts to seasonal drift via the rolling window.
    private static readonly PV_CALIB_TTL_MS         = 14 * 24 * 3_600_000;
    private static readonly PV_CALIB_MIN_SAMPLES    = 20;
    private static readonly PV_CALIB_HA_WRITE_MS    = 60_000;

    private _pvCalibK: number | null = null;
    private _pvCalibHARead = false;
    private _pvCalibHAWriteTimer?: number;
    private _pvCalibPendingSave: Array<{ t: number; o: number; p: number }> | null = null;

    private _pvCalibStorageKey(): string | null
    {
        const lat = this.hass?.config?.latitude;
        const lon = this.hass?.config?.longitude;
        if (typeof lat !== 'number' || typeof lon !== 'number') return null;
        return `helios-pv-calib:${lat.toFixed(3)}_${lon.toFixed(3)}`;
    }

    //Synchronous read from localStorage cache. Used at boot so the
    //first chart render already has whatever data we have locally;
    //HA reconciliation lands a few hundred ms later.
    private _loadPvCalibSamples(): Array<{ t: number; o: number; p: number }>
    {
        const key = this._pvCalibStorageKey();
        if (!key) return [];
        try
        {
            const raw = window.localStorage?.getItem(key);
            if (!raw) return [];
            const parsed = JSON.parse(raw) as Array<{ t: number; o: number; p: number }>;
            if (!Array.isArray(parsed)) return [];
            const cutoff = Date.now() - HeliosCard.PV_CALIB_TTL_MS;
            return parsed.filter(e => typeof e.t === 'number' && e.t >= cutoff
                                     && typeof e.o === 'number' && isFinite(e.o)
                                     && typeof e.p === 'number' && isFinite(e.p));
        }
        catch (_) { return []; }
    }

    //Save to localStorage immediately + schedule a debounced HA
    //write. Two destinations because they each cover a different
    //failure mode: localStorage gives us instant boot, HA gives us
    //device-portability + backup safety.
    private _savePvCalibSamples(samples: Array<{ t: number; o: number; p: number }>): void
    {
        const key = this._pvCalibStorageKey();
        if (!key) return;
        try { window.localStorage?.setItem(key, JSON.stringify(samples)); }
        catch (_) {}

        //Debounced HA write.
        this._pvCalibPendingSave = samples;
        if (this._pvCalibHAWriteTimer === undefined)
        {
            this._pvCalibHAWriteTimer = window.setTimeout(
                () => this._flushPvCalibToHA(),
                HeliosCard.PV_CALIB_HA_WRITE_MS
            );
        }
    }

    //Push the latest buffer to HA via frontend/set_user_data.
    //frontend/get_user_data + frontend/set_user_data accept arbitrary
    //string keys and store on the server under the current HA user's
    //profile (.storage/frontend.user_data_{user_id}). Per-user means
    //multi-account HA installs keep their calibrations separate,
    //which is the right default when different people may have
    //different PV setups.
    private async _flushPvCalibToHA(): Promise<void>
    {
        this._pvCalibHAWriteTimer = undefined;
        const samples = this._pvCalibPendingSave;
        const key     = this._pvCalibStorageKey();
        this._pvCalibPendingSave = null;
        if (!samples || !key) return;
        if (!this.hass?.callWS) return;
        try
        {
            await this.hass.callWS({
                type:  'frontend/set_user_data',
                key,
                value: samples
            });
        }
        catch (_) {}
    }

    //Pull the buffer from HA, merge with the local cache (HA wins
    //on conflict — it's the source of truth), recompute k. Called
    //once when hass becomes available; subsequent updates flow
    //through _updatePvCalibration / _savePvCalibSamples.
    private async _reconcilePvCalibWithHA(): Promise<void>
    {
        if (this._pvCalibHARead)            return;
        if (!this.hass?.callWS)             return;
        const key = this._pvCalibStorageKey();
        if (!key)                           return;
        this._pvCalibHARead = true;

        try
        {
            const result = await this.hass.callWS({
                type: 'frontend/get_user_data',
                key
            }) as { value?: unknown };

            const remote = Array.isArray(result?.value)
                ? (result.value as Array<{ t: number; o: number; p: number }>)
                    .filter(e => typeof e?.t === 'number'
                              && typeof e?.o === 'number' && isFinite(e.o)
                              && typeof e?.p === 'number' && isFinite(e.p))
                : [];

            const local  = this._loadPvCalibSamples();
            const cutoff = Date.now() - HeliosCard.PV_CALIB_TTL_MS;
            //Merge by hour-bucket timestamp; HA wins on conflict.
            const byTs = new Map<number, { t: number; o: number; p: number }>();
            for (const e of local)  { if (e.t >= cutoff) byTs.set(e.t, e); }
            for (const e of remote) { if (e.t >= cutoff) byTs.set(e.t, e); }
            const merged = Array.from(byTs.values()).sort((a, b) => a.t - b.t);

            //Persist the merged view back to localStorage (instant
            //read next boot) but DON'T trigger a fresh HA write —
            //HA already has these samples.
            try
            {
                const sKey = this._pvCalibStorageKey();
                if (sKey) window.localStorage?.setItem(sKey, JSON.stringify(merged));
            }
            catch (_) {}

            this._pvCalibK = this._calibrateK(merged);
            //Force a re-render so the PV chart picks up the newly
            //available prediction line if the threshold is crossed.
            this.requestUpdate();
        }
        catch (_)
        {
            //HA unreachable or schema error — keep using the local
            //cache. The next reconcile attempt happens at the next
            //card init.
        }
    }

    //Bucket the raw PV history into one (avg-watts) value per local
    //hour, handling cumulative-energy sensors via the same
    //differentiation logic the chart renderer uses.
    private _aggregatePvWattsPerHour(): Map<number, number>
    {
        const out  = new Map<number, number>();
        const hist = this._pvHistory;
        if (!hist || hist.times.length === 0) return out;

        const lu = (this._pvUnit || '').toLowerCase();
        const isCumulativeEnergy = lu === 'wh' || lu === 'kwh' || lu === 'mwh';

        let times:  Date[]   = hist.times;
        let values: number[] = hist.values;
        if (isCumulativeEnergy && times.length >= 2)
        {
            const dTimes:  Date[]   = [];
            const dValues: number[] = [];
            for (let i = 1; i < times.length; i++)
            {
                const dtH = (times[i].getTime() - times[i - 1].getTime()) / 3_600_000;
                if (dtH <= 0 || dtH > 6) continue;
                const dv = values[i] - values[i - 1];
                if (dv < 0) continue;
                dTimes.push(times[i]);
                dValues.push(dv / dtH);
            }
            times  = dTimes;
            values = dValues;
        }

        //Sum + count per hour bucket, then divide.
        const sums   = new Map<number, number>();
        const counts = new Map<number, number>();
        for (let i = 0; i < times.length; i++)
        {
            const ts = times[i].getTime();
            const v  = values[i];
            if (!isFinite(v)) continue;
            const w = this._pvNormalizeToWatts(v, this._pvUnit ?? '');
            //Floor to the hour boundary.
            const hourTs = Math.floor(ts / 3_600_000) * 3_600_000;
            sums.set  (hourTs, (sums.get(hourTs)   ?? 0) + w);
            counts.set(hourTs, (counts.get(hourTs) ?? 0) + 1);
        }
        for (const [hourTs, sum] of sums)
        {
            const c = counts.get(hourTs) ?? 1;
            out.set(hourTs, sum / c);
        }
        return out;
    }

    //Refresh the per-hour calibration buffer from the current
    //_pvHistory and _chartSeries, merge with the persisted buffer,
    //prune old entries, save, and recompute k. Called whenever either
    //input changes.
    private _updatePvCalibration(): void
    {
        const lat = this.hass?.config?.latitude;
        const lon = this.hass?.config?.longitude;
        if (typeof lat !== 'number' || typeof lon !== 'number') return;
        const series = this._chartSeries;
        if (!series || series.times.length === 0) return;

        const buckets = this._aggregatePvWattsPerHour();
        if (buckets.size === 0)
        {
            //Nothing to learn from this pass — recompute k from
            //whatever's still in localStorage so we don't lose it.
            this._pvCalibK = this._calibrateK(this._loadPvCalibSamples());
            return;
        }

        //Index hourly weather by hour-floor timestamp for O(1) lookup.
        const cloudByHour = new Map<number, number>();
        for (let i = 0; i < series.times.length; i++)
        {
            const hourTs = Math.floor(series.times[i].getTime() / 3_600_000) * 3_600_000;
            cloudByHour.set(hourTs, series.cloud[i] ?? 0);
        }

        const existing = this._loadPvCalibSamples();
        const byTs     = new Map<number, { t: number; o: number; p: number }>();
        for (const s of existing) byTs.set(s.t, s);

        for (const [hourTs, observedW] of buckets)
        {
            const cloud = cloudByHour.get(hourTs);
            if (cloud === undefined) continue;
            const tCentered = new Date(hourTs + 30 * 60_000);   //hour midpoint
            const predictedPct = computePvPower(tCentered, lat, lon, cloud);
            //Skip entries where there's no signal to learn from.
            if (predictedPct < 1)   continue;      //nighttime or near
            if (observedW    < 5)   continue;      //panels offline / pre-dawn noise
            byTs.set(hourTs, { t: hourTs, o: observedW, p: predictedPct });
        }

        //Prune old entries again before saving.
        const cutoff = Date.now() - HeliosCard.PV_CALIB_TTL_MS;
        const merged = Array.from(byTs.values())
            .filter(e => e.t >= cutoff)
            .sort((a, b) => a.t - b.t);

        this._savePvCalibSamples(merged);
        this._pvCalibK = this._calibrateK(merged);
    }

    private _calibrateK(samples: Array<{ t: number; o: number; p: number }>): number | null
    {
        if (samples.length < HeliosCard.PV_CALIB_MIN_SAMPLES) return null;
        let sumXY = 0, sumXX = 0;
        for (const s of samples)
        {
            sumXY += s.o * s.p;
            sumXX += s.p * s.p;
        }
        if (sumXX <= 0) return null;
        const k = sumXY / sumXX;
        //Sanity: a residential install peaks around 1 kW per kWp at
        //full sun. computePvPower saturates at 100, so a typical k
        //sits in [5, 250] (W per percent of STC). Reject anything
        //wildly outside — bad data or a misconfigured entity.
        if (!isFinite(k) || k <= 0 || k > 1000) return null;
        return k;
    }

    //Map a "rate" magnitude to an animation duration in seconds.
    //  rate <= 0           → 30 s        (paused — night / no production)
    //  rate  = saturation  → minDuration (fastest — full power)
    //
    //Ease-out cubic ramp: half-saturation already feels meaningfully
    //faster than the night baseline, which gives the user the
    //feeling of raw power pushing through the line. The minDuration
    //is exposed so callers can tune the saturated-end pace per
    //channel — the sun ray spans the full map and benefits from a
    //slightly slower flow than the PV leader, which is short and
    //local.
    private static _flowDuration(rate: number, saturation: number, minDuration: number = 0.4): number
    {
        if (!isFinite(rate) || rate <= 0)
        {
            return 30;
        }
        const f = Math.min(1, rate / saturation);
        const eased = 1 - Math.pow(1 - f, 3);
        return 30 - (30 - minDuration) * eased;
    }

    //Format a PV reading for the chip below the home. The display
    //auto-rescales W → kW when the magnitude crosses a threshold so
    //a 4500 W reading prints as "4.5 kW" rather than the noisier
    //"4500 W". Energy units (kWh / Wh) keep their native unit and
    //get a single decimal — daily totals usually sit in the 0–50 kWh
    //band where one decimal is the right amount of precision.
    private _formatPvValue(value: number, unit: string): string
    {
        const u = (unit || '').trim();
        const lu = u.toLowerCase();

        if (lu === 'w' && Math.abs(value) >= 1000)
        {
            return `${(value / 1000).toFixed(2)} kW`;
        }
        if (lu === 'w')
        {
            return `${Math.round(value)} W`;
        }
        if (lu === 'kw')
        {
            return `${value.toFixed(2)} kW`;
        }
        if (lu === 'wh')
        {
            if (Math.abs(value) >= 1000)
            {
                return `${(value / 1000).toFixed(1)} kWh`;
            }
            return `${Math.round(value)} Wh`;
        }
        if (lu === 'kwh' || lu === 'mwh')
        {
            return `${value.toFixed(1)} ${u}`;
        }
        //Fallback for arbitrary units — keep one decimal of precision
        //and let the entity's own unit string carry through.
        const formatted = Math.abs(value) >= 100 ? Math.round(value).toString() : value.toFixed(1);
        return u ? `${formatted} ${u}` : formatted;
    }


    //Render

    protected render(): TemplateResult
    {
        const t = pickTranslations(this.hass?.language);

        const apiKey    = String(this.config?.['maptiler-api-key'] ?? '').trim();
        const hasApiKey = apiKey.length > 0;


        //Date+time shown bottom-right: tracks the timeline cursor.
        //  - In live mode it follows wall-clock time (re-rendered every
        //    second by _tick).
        //  - In scrubbed mode it shows the selected instant exactly.
        //Both date and time follow the user-defined date format.
        const displayDate = !this._isLiveMode && this._selectedTime
            ? this._selectedTime
            : this._now;
        const displayDateLabel = formatDate(displayDate, this.config?.['date-format']);
        //time-format: '12h' or '24h' (default). hourCycle is more
        //authoritative than hour12, which some locales silently
        //ignore (fr-FR falls back to 24h regardless of hour12).
        const is12h = String(this.config?.['time-format'] ?? '24h').toLowerCase() === '12h';
        const displayTimeLabel = displayDate.toLocaleTimeString([], {
            hour:      '2-digit',
            minute:    '2-digit',
            second:    '2-digit',
            hourCycle: is12h ? 'h12' : 'h23'
        } as Intl.DateTimeFormatOptions);

        //Cloud-cover hover tooltip — shown above the on-ground disc
        //when the cursor enters its layer (engine emits onCloudHover).
        //Two-line content: total coverage on top, low/mid/high bands
        //below. The tooltip is positioned at (cloudHoverX, cloudHoverY)
        //which the engine reports in canvas pixel coordinates.
        const showCloudTooltip = this._cloudHover && this._cloudCover >= 0;
        const cloudPctRound    = Math.max(0, Math.round(this._cloudCover));
        const cloudHeadLine    = t.tooltip.cloudCover.replace('{0}', String(cloudPctRound));
        const cloudLowLine     = t.tooltip.cloudLow .replace('{0}', String(Math.round(Math.max(0, this._cloudLow))));
        const cloudMidLine     = t.tooltip.cloudMid .replace('{0}', String(Math.round(Math.max(0, this._cloudMid))));
        const cloudHighLine    = t.tooltip.cloudHigh.replace('{0}', String(Math.round(Math.max(0, this._cloudHigh))));

        //Always-visible cloud-cover percentage label, overlaid in HTML
        //above the home marker, with an SVG leader line tying it to
        //the on-ground 100 % ring. Both anchors come pre-projected
        //from the engine — see HeliosEngine.projectHomeLabelLayout().
        //The label is suppressed until both the layout (map ready)
        //and a cloud-cover value (data ready) are available.
        const layout         = this._labelLayout;
        const showLabel      = hasApiKey && layout !== null && this._cloudCover >= 0;

        //Photovoltaic production chip — sits where the cloud chip
        //used to live (above the home), tinted in the configured
        //production colour and tied to the home with an animated
        //leader line whose dashes flow from the house up to the
        //chip. Only renders when the user has set the optional
        //`pv-power-entity` config and the live state read produced
        //a finite numeric value.
        const pvEntityId   = String(this.config?.['pv-power-entity'] ?? '').trim();
        const pvColor      = cfgHex(this.config?.['pv-color'], DEFAULT_PV_COLOR_HEX);
        //When the user scrubs the timeline into the past, the chip
        //should reflect what the PV system actually produced at
        //that instant — same behaviour as the cloud / irradiance
        //chips. For future scrubs there's no PV data (production
        //hasn't happened yet); we hide the chip rather than
        //showing a stale or fake number.
        const pvScrubbing  = !this._isLiveMode && this._selectedTime !== null;
        const pvScrubFuture = pvScrubbing
            && this._selectedTime!.getTime() > Date.now() + 60_000;

        //The chip displays the *instantaneous* production at the
        //active timeline instant — live "now" by default, or the
        //scrub target when the user is exploring the past. For a
        //power sensor (W/kW) we plot the entity's own state /
        //historical sample; for a cumulative-energy sensor
        //(Wh/kWh) we differentiate over the rolling buffer (live)
        //or the bracketing pair of history samples (scrub). Either
        //way the chip never shows the lifetime cumulative total —
        //that figure is meaningless on a "current production"
        //readout.
        const pvRate = (pvEntityId !== '' && layout !== null)
            ? (pvScrubbing
                ? this._pvRateAtTime(this._selectedTime!)
                : (this._pvCurrent !== null ? this._currentPvRate() : null))
            : null;

        const showPvLabel = hasApiKey
            && layout !== null
            && pvEntityId !== ''
            && !pvScrubFuture
            && pvRate !== null;

        const pvDisplayValue = showPvLabel
            ? this._formatPvValue(pvRate!.value, pvRate!.unit)
            : '';
        //Animation duration of the leader-line dash flow — fast when
        //production is high, slow when production is low. Mapped on
        //the same scale as the sun ray below so the two streams feel
        //like one coherent visual language: 0 → 30 s/cycle (almost
        //still), saturated → 3 s/cycle (visible motion without being
        //annoying). For PV we saturate at ~5 kW which is a typical
        //residential peak.
        //Battery overlay — two independent chips flanking the PV
        //chip in screen-space: SoC % on the LEFT, signed Power on
        //the RIGHT, mirroring each other around the PV chip's
        //vertical axis. Each chip is wired back to the PV chip via
        //a static dotted hairline (no animation, no arrow) — the
        //sign of the power value is the only encoding for charging
        //vs discharging.
        //
        //Scrub semantics mirror PV: live mode reads from
        //hass.states; past-scrub mode reads from the historical
        //series fetched via WS; future-scrub hides both chips
        //because no battery data exists past "now".
        const batterySocEntity   = String(this.config?.['battery-soc-entity']   ?? '').trim();
        const batteryPowerEntity = String(this.config?.['battery-power-entity'] ?? '').trim();
        const batteryColor       = cfgHex(this.config?.['battery-color'], DEFAULT_BATTERY_COLOR_HEX);
        const batteryScrubbing   = !this._isLiveMode && this._selectedTime !== null;
        const batteryScrubFuture = batteryScrubbing
            && this._selectedTime!.getTime() > Date.now() + 60_000;

        //Active SoC / power values for this render — historical
        //samples in scrub mode, live state otherwise.
        const activeBatterySoc: number | null = batteryScrubbing
            ? this._batterySampleAtTime(this._batterySocHistory, this._selectedTime!)
            : this._batterySoc;
        const activeBatteryPower: number | null = batteryScrubbing
            ? this._batterySampleAtTime(this._batteryPowerHistory, this._selectedTime!)
            : this._batteryPower;
        //The power unit doesn't change between live and history
        //samples (same entity, same configuration), so we read it
        //from the live state cache regardless of mode.
        const activeBatteryUnit = this._batteryPowerUnit;

        const showSocChip = (hasApiKey && layout !== null)
            && !batteryScrubFuture
            && batterySocEntity !== ''
            && activeBatterySoc !== null;
        const showPowerChip = (hasApiKey && layout !== null)
            && !batteryScrubFuture
            && batteryPowerEntity !== ''
            && activeBatteryPower !== null;

        const batterySocText = showSocChip
            ? `${Math.round(activeBatterySoc!)} %`
            : '';
        const batteryPowerText = showPowerChip
            ? this._formatBatteryPower(activeBatteryPower!, activeBatteryUnit)
            : '';

        //Charging / discharging direction drives the SVG arrow
        //path direction on the PV↔Power leader. Sign comes straight
        //from the entity (positive = charging by convention).
        //Charging: arrow flows PV → Power (energy moving INTO the
        //battery). Discharging: arrow flows Power → PV (energy
        //moving OUT). The dashes flow at a speed proportional to
        //|P|, saturating at the same ~5 kW threshold as the PV
        //leader so all energy-flow streams read on the same scale.
        const batteryCharging  = showPowerChip && (activeBatteryPower! > 0);
        const batteryWattsForFlow = showPowerChip
            ? Math.abs(this._pvNormalizeToWatts(activeBatteryPower!, activeBatteryUnit))
            : 0;
        //"Idle" — measured power within sensor-noise margin of zero
        //(±5 W). The leader is still drawn so the user keeps the
        //spatial relationship, but the dash flow is frozen and the
        //arrow head is hidden — nothing is moving in either
        //direction, so any motion would be misleading.
        const batteryIdle = showPowerChip && batteryWattsForFlow < 5;
        const batteryFlowDuration = HeliosCard._flowDuration(batteryWattsForFlow, 5000);

        //Battery leader L-shape geometry — computed once and reused
        //for the visible <path> elements (SoC and Power) and for
        //the animated arrow's <animateMotion> path. Only meaningful
        //when a layout is available; gated by the same flag as the
        //chip rendering so we don't dereference a null layout below.
        //
        //  PV_LEG_OFFSET_PX (12) is the horizontal distance from
        //  the PV chip's centre to each L-leg's vertical drop.
        //  The SoC L hangs to the LEFT of centre by this amount,
        //  the Power L to the RIGHT — bringing both legs slightly
        //  inboard of the chip's quarter-width so the bends sit
        //  closer to the chip's middle. Constant rather than
        //  measured because the chips are min-width-clamped to
        //  76 px in the common case — see helios-card-css.ts.
        //  PV_HALF_HEIGHT_PX (11) places the top of the vertical
        //  leg flush against PV's bottom edge so the line emerges
        //  from the chip rather than from inside it.
        //  CHIP_NUDGE_PX (32) is the horizontal distance from each
        //  battery chip's centre to the inside of its left/right
        //  edge, so the chip background covers the very tip of
        //  the leader and the visible dash sequence terminates
        //  cleanly at the chip border.
        //  FILLET_R (6) rounds the corner of the L with a quadratic
        //  Bézier. The visible line and the arrow's <animateMotion>
        //  path share the same fillet, so the arrow's tangent
        //  rotates smoothly through the bend instead of snapping
        //  90° at the corner. SMIL parametrises the path at
        //  constant linear velocity, so the time spent on the
        //  fillet shrinks proportionally with `flowDuration`.
        const PV_LEG_OFFSET_PX     = 7;
        const PV_HALF_HEIGHT_PX    = 11;
        //Half-width of the PV chip — min-width:76 in .pv-pct-label,
        //so 38 px from centre to either side. Used for the solar-ray
        //target snap (left/right side of the chip) when the sun sits
        //roughly horizontal to the chip.
        const PV_HALF_WIDTH_PX     = 38;
        const BAT_CHIP_NUDGE_PX    = 32;
        const FILLET_R             = 6;
        //PV chip sits BELOW the SoC / Power shelf, so each L-leader
        //runs from PV's TOP edge upward to the shelf, then
        //horizontally to the SoC / Power chip.
        const lPvEdgeY      = layout ? layout.pvLabel.y - PV_HALF_HEIGHT_PX           : 0;
        const lShelfY       = layout ? layout.batterySocLabel.y                       : 0;
        const lSocLegX      = layout ? layout.pvLabel.x - PV_LEG_OFFSET_PX            : 0;
        const lPowerLegX    = layout ? layout.pvLabel.x + PV_LEG_OFFSET_PX            : 0;
        const lSocEndX      = layout ? layout.batterySocLabel.x   + BAT_CHIP_NUDGE_PX : 0;
        const lPowerEndX    = layout ? layout.batteryPowerLabel.x - BAT_CHIP_NUDGE_PX : 0;
        //Forward L: PV edge → vertical leg → fillet → horizontal leg
        //→ end. Direction-agnostic — the vertical leg can travel
        //either up (PV below the shelf, current layout) or down
        //(legacy PV-above-shelf layout) because the fillet approach
        //point follows the sign of (shelfY - pvEdgeY).
        const buildLPath = (verticalX: number, pvEdgeY: number, shelfY: number, endX: number): string =>
        {
            const dirH  = endX  > verticalX ? 1 : -1;
            const dirV  = shelfY > pvEdgeY  ? 1 : -1;
            //Clamp the radius so the fillet never overshoots a short
            //leg — the rounded corner has to fit inside both legs.
            const r     = Math.min(FILLET_R, Math.abs(shelfY - pvEdgeY) / 2, Math.abs(endX - verticalX) / 2);
            const preY  = shelfY - dirV * r;
            const postX = verticalX + dirH * r;
            return `M ${verticalX},${pvEdgeY} L ${verticalX},${preY} Q ${verticalX},${shelfY} ${postX},${shelfY} L ${endX},${shelfY}`;
        };
        //Reversed L: end of horizontal leg → fillet → vertical leg →
        //PV edge. Used for the discharging arrow only.
        const buildLPathReverse = (verticalX: number, pvEdgeY: number, shelfY: number, endX: number): string =>
        {
            const dirH  = endX  > verticalX ? 1 : -1;
            const dirV  = shelfY > pvEdgeY  ? 1 : -1;
            const r     = Math.min(FILLET_R, Math.abs(shelfY - pvEdgeY) / 2, Math.abs(endX - verticalX) / 2);
            const preY  = shelfY - dirV * r;
            const postX = verticalX + dirH * r;
            return `M ${endX},${shelfY} L ${postX},${shelfY} Q ${verticalX},${shelfY} ${verticalX},${preY} L ${verticalX},${pvEdgeY}`;
        };
        const socLeaderPath   = buildLPath(lSocLegX,   lPvEdgeY, lShelfY, lSocEndX);
        const powerLeaderPath = buildLPath(lPowerLegX, lPvEdgeY, lShelfY, lPowerEndX);
        const powerArrowPath  = batteryCharging
            ? buildLPath(lPowerLegX, lPvEdgeY, lShelfY, lPowerEndX)
            : buildLPathReverse(lPowerLegX, lPvEdgeY, lShelfY, lPowerEndX);

        //Solar-arc overlay — sun trajectory across the sky, sun's
        //current position, and incidence ray to the home. All
        //pre-projected to screen space by the engine via
        //projectSunScene(). Hidden until the engine is ready.
        const sunScene  = this._sunScene;
        const showSun   = hasApiKey && sunScene !== null && sunScene.arc.length >= 2;

        //Fixed colour design system. The configured sun
        //colour paints the arc, the outer rim of the sun disc,
        //and the inner irradiance fill. The on-ground cloud disc
        //is painted in MapLibre paint properties from the engine
        //(see _updateCloudCoverDisc) so we don't need the cloud
        //hex in this render block.
        const sunColor      = cfgHex(this.config?.['sun-color'],   DEFAULT_SUN_COLOR_HEX);
        const sunRimColor   = this._darkenHex(sunColor, 0.20);
        const arcSegments   = showSun ? this._buildArcSegments(sunScene!.arc, sunColor) : [];

        //The incidence ray only renders when the sun is actually
        //above the horizon — drawing a ray from below the ground
        //towards the home would be visually nonsensical.
        const showRay = showSun && sunScene!.sun.altitude > 0;

        //Live irradiance for the on-map W/m² label that floats
        //above the sun disc. We also derive the inner-disc fill
        //ratio from it: at STC (1000 W/m²) the fill reaches the
        //rim; at zero (night, but masked anyway) the fill vanishes.
        //The square-root mapping linearises the *area* perception
        //(area ∝ r²), so a 50% reading shows a fill that visually
        //covers half the rim's area, not half the rim's radius.
        const sunWm2          = sunScene?.sun.irradiance ?? 0;
        const sunWm2Round     = Math.round(sunWm2);
        const sunFillRatio    = Math.sqrt(Math.max(0, Math.min(1, sunWm2 / 1000)));
        const showSunLabel    = showSun && sunScene!.sun.altitude > 0;
        //Animation duration of the solar-ray dash flow. Same scale as
        //the PV leader (see _flowDuration / _pvNormalizeToWatts) so
        //both streams pulse at coherent rates: the sun ray saturates
        //at 1000 W/m² (clear-sky noon).
        //Sun ray spans the whole card — keep the saturated-end pace
        //a touch slower than the PV leader (0.8 s vs the default
        //0.4 s) so peak-irradiance flow stays readable rather than
        //feeling frantic at the top of the day.
        const sunFlowDuration = HeliosCard._flowDuration(sunWm2, 1000, 0.8);

        //Solar-ray target — snaps to one of the 4 sides of the PV
        //chip based on which side faces the sun. The compass angle
        //is measured from the PV chip's centre to the sun, with 0°
        //pointing up; ±45° windows around each cardinal direction
        //pick the matching chip side:
        //    [-45°,  45°] → TOP
        //    [ 45°, 135°] → RIGHT
        //   |angle|>135°  → BOTTOM
        //    [-135°,-45°] → LEFT
        //Without this snap, a sun sitting below the chip pulled the
        //ray through the chip's top, which looked broken.
        let sunRayTargetX = sunScene?.home.x ?? 0;
        let sunRayTargetY = sunScene?.home.y ?? 0;
        if (layout && sunScene)
        {
            const dx       = sunScene.sun.x - layout.pvLabel.x;
            const dy       = sunScene.sun.y - layout.pvLabel.y;
            const compass  = Math.atan2(dx, -dy);   // 0 = up, +π/2 = right
            const Q        = Math.PI / 4;           // 45°
            const absC     = Math.abs(compass);
            if (absC <= Q)
            {
                //Sun is above → attach to top-centre.
                sunRayTargetX = layout.pvLabel.x;
                sunRayTargetY = layout.pvLabel.y - PV_HALF_HEIGHT_PX;
            }
            else if (absC >= 3 * Q)
            {
                //Sun is below → attach to bottom-centre.
                sunRayTargetX = layout.pvLabel.x;
                sunRayTargetY = layout.pvLabel.y + PV_HALF_HEIGHT_PX;
            }
            else if (compass > 0)
            {
                //Sun is to the right → attach to right-centre.
                sunRayTargetX = layout.pvLabel.x + PV_HALF_WIDTH_PX;
                sunRayTargetY = layout.pvLabel.y;
            }
            else
            {
                //Sun is to the left → attach to left-centre.
                sunRayTargetX = layout.pvLabel.x - PV_HALF_WIDTH_PX;
                sunRayTargetY = layout.pvLabel.y;
            }
        }

        const cardTheme = String(this.config?.['card-theme'] ?? 'light').toLowerCase();
        const cardThemeClass = cardTheme === 'dark' ? 'theme-dark' : 'theme-light';

        //showPlaceholder collapses two cases that share the same
        //render: (a) the user hasn't provided a MapTiler API key
        //yet, (b) the card is rendered inside HA's dashboard editor
        //preview, where we deliberately skip the WebGL engine to
        //avoid context exhaustion. Both fall back to the same
        //illustrated placeholder.
        const showPlaceholder = !hasApiKey || this._isInEditorPreview;

        return html`
            <ha-card class="${cardThemeClass} ${showPlaceholder ? 'placeholder-mode' : ''}">

                ${showPlaceholder ? this._renderPlaceholder() : nothing}

                <div id="map-container" class="${showPlaceholder ? 'hidden' : ''}"></div>

                ${hasApiKey && this._timeRange ? html`
                    <div
                        class="time-bar"
                        @pointerdown="${this._onTimelinePointerDown}"
                    >
                        <!--  Top row: scrub-time cluster (icon-only
                              "back to live" button + scrub-time pill)
                              shown above the chart card with a small
                              breathing gap and a thin tether hair down
                              to the chart's top edge. The cluster
                              anchors at the cursor's X with edge-aware
                              clamping; the tether anchors at the same
                              X without clamping so it always lands
                              directly above the cursor.  -->
                        <div class="tb-top-row">
                            ${(!this._isLiveMode && this._selectedTime) ? (() => {
                                const { start, end } = this._timeRange!;
                                const rangeMs = end.getTime() - start.getTime();
                                const selPct  = Math.max(0, Math.min(100,
                                    (this._selectedTime!.getTime() - start.getTime()) / rangeMs * 100));
                                const xform   = selPct < 8
                                    ? 'translateX(0)'
                                    : (selPct > 92 ? 'translateX(-100%)' : 'translateX(-50%)');
                                return html`
                                    <div
                                        class="tb-sel-label"
                                        style="left:${selPct}%; transform:${xform}"
                                    >${this._formatSelTime(this._selectedTime!)}</div>
                                    <div
                                        class="tb-sel-tether"
                                        style="left:${selPct}%"
                                    ></div>
                                `;
                            })() : nothing}
                        </div>

                        <!--  Optional PV production graph — only
                              rendered when the user has set the
                              pv-power-entity config. Same chip
                              styling as the main chart card; sits
                              just above it with a 4 px gap so the
                              two read as a stacked instrument. The
                              graph's height is the same as one half
                              of the main chart so the irradiance
                              area and the PV area visually balance
                              each other.  -->
                        ${pvEntityId ? html`
                            <div class="tb-chart-card tb-pv-card">
                                ${this._renderPvChart()}
                                ${this._renderTimelineTicks()}
                            </div>
                        ` : nothing}

                        <!--  Chart card: hosts the area chart, the
                              dotted day separators, the day-label
                              chips on the midline, and the live +
                              scrub cursors as HTML overlays.  -->
                        <div class="tb-chart-card">
                            ${this._renderChart()}
                            ${this._renderTimelineDayLabels()}
                            ${this._renderTimelineTicks()}
                        </div>
                    </div>
                ` : nothing}

                ${hasApiKey ? html`
                    <div class="spinner-center ${this._fetching ? 'spinning' : ''}">
                        <div class="spinner"></div>
                    </div>
                ` : nothing}

                ${hasApiKey ? html`
                    <div class="overlay-top-center">
                        <div class="clock ${this._isLiveMode ? '' : 'clock-scrubbed'}">
                            <span class="clock-date">${displayDateLabel}</span>
                            <span class="clock-time">${displayTimeLabel}</span>
                        </div>
                        ${!this._isLiveMode ? html`
                            <button
                                class="clock-tab"
                                @click="${this._resetToLive}"
                            >
                                <ha-icon icon="mdi:restore"></ha-icon>
                            </button>
                        ` : nothing}
                    </div>
                ` : nothing}

${showSun ? html`
                    <svg
                        class="solar-svg"
                        style="opacity:${sunScene!.daylight}"
                    >
                        <!--  Arc — single colour pass, depth conveyed
                              by per-segment stroke-width modulation.
                              First pass paints a faint dark outline
                              for legibility against bright basemap
                              areas; second pass paints the configured
                              sun colour on top.  -->
                        ${arcSegments.map(s => svg`
                            <line
                                class="${s.belowHorizon ? 'solar-arc-outline solar-arc-night' : 'solar-arc-outline'}"
                                x1="${s.x1}" y1="${s.y1}"
                                x2="${s.x2}" y2="${s.y2}"
                                stroke-width="${(HeliosCard.OUTLINE_FAR
                                    + (HeliosCard.OUTLINE_NEAR - HeliosCard.OUTLINE_FAR) * s.nearness)
                                    * (s.belowHorizon ? HeliosCard.NIGHT_STROKE_FACTOR : 1)}"
                            ></line>
                        `)}
                        ${arcSegments.map(s => svg`
                            <line
                                class="${s.belowHorizon ? 'solar-arc-segment solar-arc-night' : 'solar-arc-segment'}"
                                x1="${s.x1}" y1="${s.y1}"
                                x2="${s.x2}" y2="${s.y2}"
                                stroke="${s.color}"
                                stroke-width="${(HeliosCard.SEGMENT_FAR
                                    + (HeliosCard.SEGMENT_NEAR - HeliosCard.SEGMENT_FAR) * s.nearness)
                                    * (s.belowHorizon ? HeliosCard.NIGHT_STROKE_FACTOR : 1)}"
                            ></line>
                        `)}
                        ${showRay ? svg`
                            <line
                                class="solar-ray"
                                style="--sun-flow-duration:${sunFlowDuration}s"
                                x1="${sunScene!.sun.x}"  y1="${sunScene!.sun.y}"
                                x2="${sunRayTargetX}"    y2="${sunRayTargetY}"
                                stroke="${sunColor}"
                            ></line>
                            <polygon
                                class="solar-ray-arrow"
                                points="-6,-4 0,0 -6,4"
                                fill="${sunColor}"
                            >
                                <animateMotion
                                    dur="${sunFlowDuration}s"
                                    repeatCount="indefinite"
                                    rotate="auto"
                                    path="M ${sunScene!.sun.x},${sunScene!.sun.y} L ${sunRayTargetX},${sunRayTargetY}"
                                ></animateMotion>
                            </polygon>
                        ` : nothing}
                        ${(() => {
                            //Sun disc — three concentric layers:
                            //  1. Background fill (configured colour at
                            //     SUN_FILL_OPACITY_BG) so the empty disc
                            //     reads as faintly tinted glass.
                            //  2. Inner fill (configured colour, fully
                            //     opaque) whose radius = sunFillRatio
                            //     × outer radius; conveys irradiance.
                            //     Sub-pixel radii are rounded out by the
                            //     SVG renderer; below ~1 px the inner
                            //     disc is invisible anyway, which is the
                            //     correct visual for "no sun".
                            //  3. Outer rim (slightly darkened sun
                            //     colour) so the disc has a clear edge
                            //     against the basemap regardless of
                            //     contrast.
                            const r = HeliosCard.SUN_R_FAR
                                    + (HeliosCard.SUN_R_NEAR - HeliosCard.SUN_R_FAR) * sunScene!.sun.nearness;
                            const rInner = r * sunFillRatio;
                            return svg`
                                <circle
                                    class="solar-sun-bg"
                                    cx="${sunScene!.sun.x}" cy="${sunScene!.sun.y}"
                                    r="${r}"
                                    fill="${sunColor}"
                                    fill-opacity="${HeliosCard.SUN_FILL_OPACITY_BG}"
                                ></circle>
                                <circle
                                    class="solar-sun-fill"
                                    cx="${sunScene!.sun.x}" cy="${sunScene!.sun.y}"
                                    r="${rInner}"
                                    fill="${sunColor}"
                                    stroke="${sunRimColor}"
                                    stroke-width="0.5"
                                ></circle>
                                <circle
                                    class="solar-sun-rim"
                                    cx="${sunScene!.sun.x}" cy="${sunScene!.sun.y}"
                                    r="${r}"
                                    fill="none"
                                    stroke="${sunColor}"
                                    stroke-width="${HeliosCard.SUN_RIM_WIDTH}"
                                ></circle>
                            `;
                        })()}
                    </svg>
                ` : nothing}

                <!--  Always-visible W/m² label, pinned above the sun
                      disc. Same visual language as the cloud-cover
                      label above the home: black border, white card,
                      tabular numerals — they read as a matched pair
                      of cartographic readouts.  -->
                ${showSunLabel ? html`
                    <div
                        class="solar-pct-label"
                        style="left:${sunScene!.sun.x}px; top:${sunScene!.sun.y - 22}px"
                    >
                        <ha-icon icon="mdi:white-balance-sunny"></ha-icon>
                        <span>${sunWm2Round} W/m²</span>
                    </div>
                ` : nothing}

                ${showLabel ? (() =>
                {
                    //Endpoint = fill-disc edge in the chip-to-home
                    //direction. The fill disc shares the ring's
                    //centre (= home) and scales linearly with cloud
                    //cover %; at 0 % the radius is zero and the line
                    //terminates at home, at 100 % it reaches the
                    //full ring edge. Pinning the endpoint to the
                    //live fill — rather than to a static ring or
                    //the home centre — keeps the leader "hugging"
                    //the disc as it grows and shrinks.
                    const pct  = Math.max(0, Math.min(100, this._cloudCover));
                    const tFill = pct / 100;
                    const endX  = layout!.home.x + (layout!.ringEdge.x - layout!.home.x) * tFill;
                    const endY  = layout!.home.y + (layout!.ringEdge.y - layout!.home.y) * tFill;
                    return html`
                        <svg class="cloud-leader-svg">
                            <line
                                x1="${layout!.cloudLabel.x + 10}"
                                y1="${layout!.cloudLabel.y}"
                                x2="${endX}"
                                y2="${endY}"
                            ></line>
                        </svg>`;
                })() : nothing}
                ${showLabel ? html`
                    <div
                        class="cloud-pct-label"
                        style="left:${layout!.cloudLabel.x}px; top:${layout!.cloudLabel.y}px"
                    >
                        <ha-icon icon="mdi:weather-cloudy"></ha-icon>
                        <span>${cloudPctRound}%</span>
                    </div>
                ` : nothing}

                ${showCloudTooltip ? html`
                    <div
                        class="cloud-tooltip ${this._cloudHoverFlip ? 'cloud-tooltip-flip' : ''}"
                        style="left:${this._cloudHoverX}px; top:${this._cloudHoverY}px"
                    >
                        <div class="cloud-tooltip-head">${cloudHeadLine}</div>
                        <div class="cloud-tooltip-row">${cloudLowLine}</div>
                        <div class="cloud-tooltip-row">${cloudMidLine}</div>
                        <div class="cloud-tooltip-row">${cloudHighLine}</div>
                    </div>
                ` : nothing}

                ${showPvLabel ? html`
                    <div
                        class="pv-pct-label"
                        style="left:${layout!.pvLabel.x}px; top:${layout!.pvLabel.y}px; --pv-leader-color:${pvColor}"
                    >
                        <ha-icon icon="mdi:solar-power-variant"></ha-icon>
                        <span>${pvDisplayValue}</span>
                    </div>
                ` : nothing}

                ${(showSocChip || showPowerChip) ? html`
                    <svg class="battery-leader-svg">
                        <!--
                            SoC ↔ PV — static, dashed, inverted-L
                            path with a rounded corner (matching
                            the PV ↔ Power leader's vocabulary
                            exactly minus the flow animation).
                            Vertical leg drops from PV's bottom
                            edge slightly left of centre, horizontal
                            leg then runs left to the SoC chip. No
                            animation: SoC has no flow direction.
                        -->
                        ${showSocChip ? svg`
                            <path
                                class="battery-leader-line"
                                style="--battery-leader-color:${batteryColor}"
                                d="${socLeaderPath}"
                            ></path>
                        ` : nothing}
                        <!--
                            PV ↔ Power — animated, dashed L with
                            an arrow tracking the sign of the live
                            power. Vertical leg drops from PV's
                            bottom edge slightly right of centre,
                            horizontal leg then runs right to the
                            Power chip.
                            Charging (P > 0) → arrow PV → Power.
                            Discharging (P < 0) → arrow Power → PV
                            (the path class modifier flips the
                            dash flow too).
                        -->
                        ${showPowerChip ? svg`
                            <path
                                class="battery-leader-line ${batteryIdle ? '' : 'battery-leader-line-animated'} ${batteryCharging ? '' : 'battery-leader-discharging'}"
                                style="--battery-leader-color:${batteryColor}; --battery-flow-duration:${batteryFlowDuration}s"
                                d="${powerLeaderPath}"
                            ></path>
                            ${!batteryIdle ? svg`
                                <!--
                                    Polygon is centroid-centred at (0,0):
                                    the centroid of (-2,-4), (4,0), (-2,4)
                                    is (0,0), so animateMotion pivots the
                                    arrow about its visual mass rather
                                    than its tip. Through the L's fillet
                                    the arrow stays balanced on the path
                                    instead of swinging off it.
                                -->
                                <polygon
                                    class="battery-leader-arrow"
                                    points="-2,-4 4,0 -2,4"
                                    fill="${batteryColor}"
                                >
                                    <animateMotion
                                        dur="${batteryFlowDuration}s"
                                        repeatCount="indefinite"
                                        rotate="auto"
                                        path="${powerArrowPath}"
                                    ></animateMotion>
                                </polygon>
                            ` : nothing}
                        ` : nothing}
                    </svg>
                    ${showSocChip ? html`
                        <div
                            class="battery-pct-label"
                            style="left:${layout!.batterySocLabel.x}px; top:${layout!.batterySocLabel.y}px; --battery-leader-color:${batteryColor}"
                        >
                            <ha-icon icon="mdi:battery"></ha-icon>
                            <span>${batterySocText}</span>
                        </div>
                    ` : nothing}
                    ${showPowerChip ? html`
                        <div
                            class="battery-pct-label"
                            style="left:${layout!.batteryPowerLabel.x}px; top:${layout!.batteryPowerLabel.y}px; --battery-leader-color:${batteryColor}"
                        >
                            <ha-icon icon="mdi:lightning-bolt"></ha-icon>
                            <span>${batteryPowerText}</span>
                        </div>
                    ` : nothing}
                ` : nothing}

            </ha-card>
        `;
    }

    //Darken a #rrggbb hex by a factor in [0, 1] (0 = unchanged,
    //1 = pure black). Multiplicative on each channel — keeps the
    //hue intact, just lowers the value. Used to derive the slightly
    //darker rim colour around the sun disc from the configured sun
    //colour, so the rim stays visible against the disc fill without
    //the user having to configure two colours.
    private _darkenHex(hex: string, factor: number): string
    {
        const f = 1 - Math.max(0, Math.min(1, factor));
        const r = Math.round(parseInt(hex.slice(1, 3), 16) * f);
        const g = Math.round(parseInt(hex.slice(3, 5), 16) * f);
        const b = Math.round(parseInt(hex.slice(5, 7), 16) * f);
        const h = (n: number) => n.toString(16).padStart(2, '0');
        return `#${h(r)}${h(g)}${h(b)}`;
    }

    //Placeholder (no API key configured)

    private _renderPlaceholder(): TemplateResult
    {
        //Minimal catalogue thumbnail: only the stylised iso scene
        //(low-poly buildings + ground cloud disc) and the solar arc
        //+ sun overhead — no chips, no leaders, no subtitle. The
        //"HELIOS" wordmark sits centred on top via .ph-content. The
        //sun is positioned at t = 0.75 along the arc Bezier
        //(M 50,230 Q 215,60 360,230 → (286, 166)) so it visually
        //rides ON the curve rather than floating above it. The
        //MapTiler key prompt is documented in the README — it does
        //not belong on the thumbnail.
        return html`
            <div class="placeholder">

                <svg
                    class="ph-scene"
                    viewBox="0 0 400 320"
                    preserveAspectRatio="xMidYMid meet"
                    xmlns="http://www.w3.org/2000/svg"
                >
                    <defs>
                        <radialGradient id="ph-cloud-disc-grad" cx="50%" cy="50%" r="50%">
                            <stop offset="0%"   stop-color="rgba(90,141,196,0.55)" />
                            <stop offset="80%"  stop-color="rgba(90,141,196,0.20)" />
                            <stop offset="100%" stop-color="rgba(90,141,196,0)"    />
                        </radialGradient>
                        <radialGradient id="ph-sun-glow-grad" cx="50%" cy="50%" r="50%">
                            <stop offset="0%"   stop-color="rgba(239,159,39,0.85)" />
                            <stop offset="50%"  stop-color="rgba(239,159,39,0.30)" />
                            <stop offset="100%" stop-color="rgba(239,159,39,0)"    />
                        </radialGradient>
                    </defs>

                    <!-- Cloud disc on the ground; rendered first so
                         buildings emerge through it as islands. -->
                    <ellipse cx="215" cy="215" rx="110" ry="30"
                        fill="url(#ph-cloud-disc-grad)" />
                    <ellipse cx="215" cy="215" rx="110" ry="30"
                        fill="none"
                        stroke="rgba(90,141,196,0.50)"
                        stroke-width="0.6" />

                    <!-- Far-back-left neighbour. -->
                    <g>
                        <polygon points="110,168 132,180 110,192 88,180"  fill="#dadade" />
                        <polygon points="132,180 110,192 110,212 132,200" fill="#cbcbcf" />
                        <polygon points="88,180 110,192 110,212 88,200"   fill="#bcbcc1" />
                    </g>

                    <!-- Far-back-right neighbour, slightly taller. -->
                    <g>
                        <polygon points="300,162 324,176 300,190 276,176" fill="#dadade" />
                        <polygon points="324,176 300,190 300,212 324,198" fill="#cbcbcf" />
                        <polygon points="276,176 300,190 300,212 276,198" fill="#bcbcc1" />
                    </g>

                    <!-- Home: bigger and brighter than its neighbours,
                         centred on the cloud disc. -->
                    <g>
                        <polygon points="215,178 253,198 215,218 177,198" fill="#ebebef" />
                        <polygon points="253,198 215,218 215,260 253,240" fill="#dededf" />
                        <polygon points="177,198 215,218 215,260 177,240" fill="#ccccd0" />
                    </g>

                    <!-- Solar arc — drawn over the buildings so it
                         visually inhabits the sky. -->
                    <path
                        d="M 50 230 Q 215 60 360 230"
                        fill="none"
                        stroke="#EF9F27"
                        stroke-width="2.5"
                        stroke-linecap="round"
                        stroke-opacity="0.85" />

                    <!-- Sun disc + halo, riding on the arc at t=0.75
                         (3/4 of the way from the left) so it sits ON
                         the path. The glow circle pulses; the inner
                         disc stays still so the brand colour reads
                         clearly. -->
                    <g transform="translate(286, 166)">
                        <circle class="ph-sun-glow" r="22" fill="url(#ph-sun-glow-grad)" />
                        <circle r="9" fill="#EF9F27" />
                        <circle r="8.5" fill="none"
                            stroke="#a36617" stroke-width="0.7" stroke-opacity="0.55" />
                    </g>
                </svg>

                <div class="ph-content">
                    <div class="ph-title">HELIOS</div>
                </div>

            </div>
        `;
    }

    static styles = heliosCardStyles;
}
