import { LitElement, html, svg, PropertyValues, TemplateResult, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { HeliosEngine } from './helios-engine';
import
{
    type HeliosConfig,
    DEFAULT_SUN_COLOR_HEX,
    DEFAULT_PV_COLOR_HEX,
    DEFAULT_BATTERY_COLOR_HEX
} from './helios-config';
import { pickTranslations } from './i18n';
import { heliosCardStyles } from './css/helios-card-css';
import { cfgHex, formatDate, darkenHex, lerpHexToward } from './card/format';
import
{
    refreshPv,
    currentPvRate,
    pvRateAtTime,
    pvNormalizeToWatts,
    pvCalibK,
    pvInverterMaxW,
    computePvPowerWeighted,
    wipeLegacyPvCalibStorage,
    formatPvValue
} from './card/pv';
import
{
    refreshBattery,
    batterySampleAtTime,
    formatBatteryPower
} from './card/battery';
import { refreshSolarRadiation } from './card/radiation';
import { computeForecastCalibration } from './card/calibration';
import
{
    renderChart,
    renderPvChart,
    renderTimelineTicks,
    renderTimelineDayLabels,
    renderTimelineNightZones,
    renderTimelineFutureMask,
    renderTimelineHoverTooltip,
    handleChartHoverMove,
    handleChartHoverLeave
} from './card/charts';
import
{
    renderDashboard,
    handleHomeClick
} from './card/dashboard';
import
{
    buildArcSegments,
    flowDuration,
    type SunScene,
    type CloudScene,
    type LabelLayout,
    type HomeSilhouette
} from './card/overlays';
import
{
    tick,
    onTimelinePointerDown,
    onTimelinePointerMove,
    onTimelinePointerUp,
    resetToLive,
    timelineEnabled,
    timelineWidthPct
} from './card/timeline';
import { toggleLidarView } from './card/lidar-view';
import {
    renderShadingDomeOverlay,
    renderShadingDomeCloudPicker,
    toggleShadingDome,
    refreshShadingDomeScene,
} from './card/shadingDome';
import
{
    computeConfigSig,
    getHomeCoords,
    initEngine,
    initVisibilityObserver
} from './card/init';
//Side-effect import: registers <helios-color-picker> and
//<helios-card-editor> as custom elements.
import './card/editor';


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

//Card name and description in the HA card picker, shown before any
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

//Install banner. Same shape as the styled "X-CARD vY.Z IS INSTALLED"
//lines other HACS frontends print, two adjacent chips with the card
//name on the left and the build version on the right. Guarded so a
//bundle reload (HMR, several Helios cards on the same dashboard, ...)
//does not print it twice. The version is inlined at build time from
//package.json by vite.config.ts.
{
    const flagKey = '__heliosBannerPrinted';
    const w = window as unknown as Record<string, unknown>;
    if (!w[flagKey])
    {
        w[flagKey] = true;
        const labelStyle   = 'background:#f59e0b;color:#1f2937;padding:2px 8px;border-radius:4px 0 0 4px;font-weight:bold;';
        const versionStyle = 'background:#1f2937;color:#f59e0b;padding:2px 8px;border-radius:0 4px 4px 0;font-weight:bold;';
        console.info(
            `%c☀ HELIOS%c v${__HELIOS_VERSION__}`,
            labelStyle,
            versionStyle
        );
        console.info(
            `%c☀ HELIOS%c run window.heliosStats() in the console for a live config + engine dump`,
            labelStyle,
            'color:#6b7280;font-style:italic;'
        );
    }
}


//Module-level registry of every live `<helios-card>` instance. Hooked
//by the card's connectedCallback / disconnectedCallback so that
//`window.heliosStats()` can enumerate every card currently on screen,
//dump its (sanitised) config and ask each engine for its live state.
//Defined here rather than as a static on the class so the global
//`heliosStats()` function below can close over it without forcing the
//class to be fully constructed first.
const _liveCards = new Set<HeliosCard>();

//Window-level reset bus: the editor's "reset data cache" button
//fires this event so every live card on the page (potentially
//several dashboards open in the same tab) drops its cached data
//in one sweep. Wired once at module load so we don't add/remove
//the listener per card.
window.addEventListener('helios-data-cache-reset', () =>
{
    for (const card of _liveCards) card.resetDataCache();
});

//Public diagnostic command, exposed once on first bundle load. Returns
//a JSON-safe snapshot AND prints a grouped, human-readable dump to the
//console. The dump includes the build version, the lifecycle counters
//tracked by the engine, and one section per card (config + engine
//state). All config values are JSON-safe and OK to paste publicly
//when filing an issue (no API keys are stored, the basemap is
//OpenFreeMap which needs none). Re-invoking from
//the console refreshes the snapshot.
{
    interface HeliosWin extends Window
    {
        heliosStats?: () => Record<string, unknown>;
        __heliosStats?: Record<string, unknown>;
    }
    const w = window as HeliosWin;
    if (!w.heliosStats)
    {
        w.heliosStats = () =>
        {
            const cards = Array.from(_liveCards).map((c, i) =>
            ({
                index:  i,
                snapshot: c.getStatsSnapshot()
            }));

            const out: Record<string, unknown> =
            {
                version:   __HELIOS_VERSION__,
                cards:     cards.length,
                lifecycle: w.__heliosStats ?? null,
                details:   cards
            };

            const label    = 'background:#f59e0b;color:#1f2937;padding:2px 8px;border-radius:4px;font-weight:bold;';
            const heading  = 'color:#f59e0b;font-weight:bold;';
            console.groupCollapsed(`%c☀ HELIOS stats%c v${__HELIOS_VERSION__}, ${cards.length} card${cards.length === 1 ? '' : 's'} alive`,
                label, 'color:#6b7280;font-weight:normal;');
            console.log('%cLifecycle counters', heading, w.__heliosStats ?? '(none yet)');
            cards.forEach((c, i) =>
            {
                const snap = c.snapshot;
                console.groupCollapsed(`%cCard #${i + 1}`, heading);
                console.log('config:', snap.config);
                console.log('engine:', snap.engine);
                console.log('pv:',     snap.pv);
                console.groupEnd();
            });
            console.groupEnd();
            return out;
        };
    }
}


//Debug-only home-location override. Set from the browser console via
//`setHeliosLocation(lat, lon)` to render every live card as if HA's
//home coordinates were elsewhere; `clearHeliosLocation()` reverts.
//Stored on `window` only (no localStorage), so a page refresh always
//restores hass.config. Each card reads through _getHomeCoords() which
//prefers the override, and we kick a reinit on every live card so the
//engine, weather fetch and PV calibration cache all swap to the new
//bucket immediately.
{
    interface HeliosWin extends Window
    {
        setHeliosLocation?:        (lat: number, lon: number) => void;
        clearHeliosLocation?:      () => void;
        __heliosLocationOverride?: { lat: number; lon: number };
    }
    const w = window as HeliosWin;

    const label = 'background:#f59e0b;color:#1f2937;padding:2px 8px;border-radius:4px;font-weight:bold;';

    if (!w.setHeliosLocation)
    {
        w.setHeliosLocation = (lat: number, lon: number) =>
        {
            if (typeof lat !== 'number' || typeof lon !== 'number'
                || !isFinite(lat)        || !isFinite(lon)
                || lat < -90  || lat > 90
                || lon < -180 || lon > 180)
            {
                console.warn('☀ HELIOS: setHeliosLocation expected (lat[-90..90], lon[-180..180]), got', lat, lon);
                return;
            }
            w.__heliosLocationOverride = { lat, lon };
            console.info(
                `%c☀ HELIOS%c location override → ${lat.toFixed(5)}, ${lon.toFixed(5)} (refresh page to revert)`,
                label, 'color:#6b7280;');
            for (const card of _liveCards) card.invalidateLocation();
        };
    }

    if (!w.clearHeliosLocation)
    {
        w.clearHeliosLocation = () =>
        {
            if (!w.__heliosLocationOverride)
            {
                console.info('☀ HELIOS: no location override active');
                return;
            }
            w.__heliosLocationOverride = undefined;
            console.info(
                `%c☀ HELIOS%c location override cleared, reverting to hass.config`,
                label, 'color:#6b7280;');
            for (const card of _liveCards) card.invalidateLocation();
        };
    }
}


//Main card


@customElement('helios-card')
export class HeliosCard extends LitElement
{
    //Depth-modulation bounds for the solar overlay. Each pair is the
    //FAR end (back of the day's loop) and the NEAR end (front), with
    //per-element values linearly interpolated using the engine's
    //nearness factor in [0..1].
    private static readonly OUTLINE_FAR  = 1.5;
    private static readonly OUTLINE_NEAR = 5.0;
    private static readonly SEGMENT_FAR  = 1.0;
    private static readonly SEGMENT_NEAR = 4.0;
    //Sun-disc radii in px. The inner irradiance fill needs ~9 px of
    //diameter at apex to read as an annulus rather than a dot.
    private static readonly SUN_R_FAR    = 10.0;
    private static readonly SUN_R_NEAR   = 20.0;
    private static readonly SUN_RIM_WIDTH = 1.5;
    //Faint tint inside the rim so the "empty sun" at sunrise/sunset
    //still reads as a disc, not a coloured spot.
    private static readonly SUN_FILL_OPACITY_BG = 0.20;

    //Below-horizon segments are dots whose diameter IS the stroke
    //width. Scaled down vs daytime so the night portion of the loop
    //reads as a quieter trace, it indicates where the sun goes
    //without competing with the lit half.
    private static readonly NIGHT_STROKE_FACTOR = 0.5;

    @property({ attribute: false }) public hass!: any;
    @property({ attribute: false }) config!: HeliosConfig;

    @state() _engine?:        HeliosEngine;
    @state() _now             = new Date();
    //Cloud-cover values shown in the on-ground disc hover popup.
    @state() _cloudCover      = -1;
    //Screen-space layout of the always-visible labels and leader lines,
    //recomputed via engine.projectHomeLabelLayout() on every map
    //transform. null while the map is still loading.
    @state() _labelLayout: LabelLayout | null = null;
    //Photovoltaic production state, populated when `pv-power-entity`
    //is configured. Live value from hass.states + historical series
    //from HA's history API for the dedicated chart.
    @state() _pvCurrent: number | null = null;
    @state() _pvUnit:    string        = '';
    @state() _pvHistory: {
        times:  Date[];
        values: number[];
    } | null = null;
    _pvFetchKey  = '';
    _pvFetching  = false;
    //Most recent PV history fetch outcome, surfaced via
    //`window.heliosStats()` (raw entries returned, samples kept after
    //unit / unavailable filtering, window covered in hours).
    _pvHistoryDiagnostics: { rawEntries: number; samples: number; windowH: number } | null = null;
    //Idempotency flag for the one-time wipe of legacy PV calibration
    //buffers (see _wipeLegacyPvCalibStorage). Per-instance so we
    //attempt the cleanup at most once per card mount; the persisted
    //flag in localStorage protects across reloads.
    private _pvCalibWiped = false;
    //Rolling buffer of state samples. For cumulative-energy sensors
    //this gives a "last minute" instantaneous rate, fresher than the
    //historical fetch which only refreshes per timeline range.
    _pvSampleBuffer: Array<{ t: number; v: number }> = [];
    //Home-battery state, populated when at least one of
    //`battery-soc-entity` / `battery-power-entity` is configured.
    //Live readings; historical series lives in the *History fields
    //below. Units are kept alongside the values so the chip can
    //format kW vs W without re-reading the state.
    @state() _batterySoc:        number | null = null;
    @state() _batteryPower:      number | null = null;
    @state() _batteryPowerUnit:  string        = '';
    //Historical series for the active timeline range. Both battery
    //entities are fetched in a single `history/history_during_period`
    //WebSocket call when both are set.
    @state() _batterySocHistory: {
        times:  Date[];
        values: number[];
    } | null = null;
    @state() _batteryPowerHistory: {
        times:  Date[];
        values: number[];
    } | null = null;
    _batteryFetchKey  = '';
    _batteryFetching  = false;
    //Solar-radiation entity history, populated when
    //`solar-radiation-entity` is configured. We pull the recorder's
    //samples over the active timeline range and merge them with the
    //live state, then push the merged set down to the engine via
    //setSolarRadiationSamples. Held as a plain field (no @state)
    //because nothing in the card render reads it directly; the
    //engine owns the lookup logic.
    _solarRadiationHistory: { times: Date[]; values: number[] } | null = null;
    _solarRadiationFetchKey = '';
    _solarRadiationFetching = false;
    //Screen-space layout of the solar arc, sun, and incidence ray.
    //Recomputed via engine.projectSunScene() on every map transform
    //and every clock tick (sun position moves with time, refreshed
    //at 1 Hz in live mode).
    @state() _sunScene: SunScene | null = null;
    //Screen-space layout of the cloud-cover disc + 100 % reference
    //ring, projected through engine.projectCloudScene() on every map
    //transform and clock tick. Rendered as a pair of SVG polygons
    //drawn alongside the sun arc, anchored at the home's terrain
    //elevation so the disc stays a true circle whatever the ground
    //does beneath it (a MapLibre fill layer would warp with the
    //terrain mesh under high-precision LiDAR shadows).
    @state() _cloudScene: CloudScene | null = null;
    //Per-polygon silhouettes of the home building(s) in screen
    //space: each entry has the projected base ring and the
    //projected top ring of one home polygon. The card paints
    //both rings plus a quad per outer-ring edge into the cloud-
    //disc SVG mask, the union covers the exact extruded prism
    //even for concave footprints. Re-projected on every map
    //transform so rotation tracks.
    @state() _homeSilhouettes: HomeSilhouette[] = [];
    //Hover state on the home hitbox. Drives a sun-coloured glow halo
    //around the home silhouette so the user reads the focal building
    //as interactive before clicking.
    @state() _homeHover = false;
    //Hover state for the today-cumulative chart in the dashboard. ms
    //epoch of the cursor position on the X axis; null when the pointer
    //is outside the chart or the chart isn't shown.
    @state() _dashChartHoverTs: number | null = null;
    //Hover position on the timeline chart cards, expressed as a
    //percent of the visible time range. Null when the pointer is
    //outside the cards; drives the hover guide line, the per-curve
    //dots and the tooltip chip rendered above the cards.
    @state() _chartHoverPct: number | null = null;
    @state() _chartSeries: {
        times:        Date[];
        irradiance:   number[];
        cloud:        number[];
        //Hourly ambient temperature in °C + wind speed in m/s,
        //NaN-padded where the model didn't return a value. Both
        //arrays mirror the `times` length and feed the PV
        //prediction's thermal-derating term.
        temperature:  number[];
        windSpeed:    number[];
    } | null = null;
    @state() _fetching        = false;
    @state() _timeRange:    { start: Date; end: Date } | null = null;
    @state() _selectedTime: Date | null = null;
    @state() _isLiveMode    = true;
    //True while the engine is fetching the LiDAR shadow payload from
    //the upstream provider and rasterising it for the image source.
    //Drives the spinner chip pinned top-right of the map so the user
    //knows the shadow layer they're about to see is still computing.
    @state() _shadowBusy    = false;
    //True while the home is "focused": the existing overlay HUD is
    //hidden, the camera is eased to a closer / more pitched pose,
    //and a detail dashboard panel takes over. Toggled by clicking
    //the home hitbox (off → on) or clicking anywhere on the panel
    //(on → off). Engine.setDetailMode drives the camera lerp;
    //CSS class .detail-active on ha-card fades out every overlay.
    @state() _detailMode    = false;
    //True while the LiDAR View overlay is showing: the map UI fades
    //out, the engine's WebGL custom layer paints every loaded LiDAR
    //cell as a dot, and the same toggle button (top-right) brings the
    //regular UI back when clicked again. Independent of detail mode;
    //both can't be on at once (the button is hidden in detail).
    @state() _lidarViewMode = false;
    //Fade timestamps. On enter the dot cloud eases in from alpha 0 to
    //1 over LIDAR_FADE_IN_MS; on exit it eases back out before the
    //regular HUD fade-in. Null when no fade is in flight; the layer
    //alpha then stays at its resting value (1 while active, 0 while
    //inactive).
    _lidarFadeInStartMs:  number | null = null;
    _lidarFadeOutStartMs: number | null = null;
    _lidarFadeRaf?:       number;

    //Shading-dome overlay state. Mutually exclusive with the LiDAR
    //view (the click handlers below close one before opening the
    //other). _shadingDomeCloudBin persists the user's bin pick
    //inside the card lifetime so a toggle off/on keeps the slice.
    @state() _shadingDomeMode = false;
    _shadingDomeFadeInStartMs:  number | null = null;
    _shadingDomeFadeOutStartMs: number | null = null;
    _shadingDomeFadeRaf?:       number;
    //Cloud cover percentage selected by the continuous slider in
    //the bottom-left of the dome view. 0 = clear sky, 100 = full
    //overcast. The engine's lookup is bin-based; the bin is
    //derived from this pct so the user reads the slider as a
    //continuous knob even though the underlying data is binned.
    _shadingDomeCloudPct = 0;
    _shadingDomeScene: import('./card/shadingDome').ShadingDomeScene | null = null;

    private _timer?:           number;
    _lastHomeKey       = '';
    _lastConfigSig     = '';
    _initInflight      = false;
    //Deferred engine cleanup. Some HA dashboard layouts (Masonry in
    //particular) detach and re-attach the card element repeatedly
    //during their reflow pass. Tearing down the engine on every
    //disconnect and re-creating it on every reconnect would burn
    //through the browser's WebGL context pool (~16 max) in seconds,
    //which then cascades into context-lost events on the survivors.
    //Instead, we delay the cleanup; if the card re-mounts within the
    //window, we cancel the cleanup and reuse the live engine, the
    //engine's own ResizeObserver picks up any container size delta.
    private _pendingCleanupTimer?: number;
    //Timestamp of the last engine spawn. onContextLost uses this to
    //bail out when context losses arrive faster than ~2 s apart,
    //which only happens when the browser is thrashing the WebGL pool,
    //respawning at that cadence just feeds the fire.
    _lastEngineSpawnAt = 0;


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
        return {};
    }

    //Diagnostic snapshot returned to `window.heliosStats()`. Includes
    //the live config, the engine state snapshot when the engine is
    //up, and a small PV block summarising the most recent history
    //fetch outcome. JSON-safe, no DOM references, no PII: the engine
    //snapshot strips its own hass.config-sourced lat/lon, and the loop
    //below additionally omits the `home-latitude` / `home-longitude`
    //card-config override so user-supplied home coordinates never leak
    //into the diagnostics output either.
    public getStatsSnapshot(): {
        config: Record<string, unknown>;
        engine: Record<string, unknown> | null;
        pv:     Record<string, unknown>;
    }
    {
        const cfg: Record<string, unknown> = {};
        if (this.config)
        {
            for (const [k, v] of Object.entries(this.config))
            {
                //Skip user-supplied home coordinates so the snapshot
                //stays PII-free, matching the engine-side stripping.
                if (k === 'home-latitude' || k === 'home-longitude') continue;
                cfg[k] = v;
            }
        }
        return {
            config: cfg,
            engine: this._engine ? this._engine.getStatsSnapshot() : null,
            pv:
            {
                entityConfigured: typeof this.config?.['pv-power-entity'] === 'string'
                    && (this.config['pv-power-entity'] as string).length > 0,
                unit:             this._pvUnit || null,
                lastHistory:      this._pvHistoryDiagnostics,
                calibrationK:     pvCalibK(this.config)
            }
        };
    }

    //Called by the global `setHeliosLocation` / `clearHeliosLocation`
    //debug helpers. Clears the cached home key so the next `updated()`
    //pass sees `identityChanged` and re-inits the engine against the
    //new coordinates, then schedules a re-render to trigger that pass.
    //
    //The visual editor does NOT route through here when the user edits
    //`home-latitude` / `home-longitude`: it dispatches `config-changed`,
    //HA calls `setConfig()`, Lit re-renders, and `updated()` notices
    //that `_getHomeCoords()` now resolves to a different key. The
    //engine re-init falls out of that natural identity-drift path.
    public invalidateLocation(): void
    {
        this._lastHomeKey = '';
        this.requestUpdate();
    }


    //Wipe all card-side cached production / forecast data and
    //trigger a fresh fetch from HA and Open-Meteo. Used by the
    //editor's "reset data cache" button so users can recover from
    //a stuck calibration or a stale weather payload without
    //touching localStorage manually.
    public resetDataCache(): void
    {
        //Drop in-memory PV state so the next refreshPv() refetches
        //from scratch instead of pulling from the cached fetch key.
        this._pvHistory             = null;
        this._pvSampleBuffer        = [];
        this._pvFetchKey            = '';
        this._pvHistoryDiagnostics  = null;
        //Engine-side: clears localStorage weather cache, drops the
        //in-memory hourly snapshot and triggers a refetch.
        this._engine?.resetDataCache();
        this.requestUpdate();
    }


    //Sizing for masonry view. 1 unit = 50 px so 12 ≈ 600 px.
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
            //Default to the section editor's actual ceiling (12 cols
            //wide, 8 rows tall) so the slot HA carves out matches
            //what its layout UI lets the user resize to. Asking for
            //11 rows by default (the old value) lands a slider handle
            //past the editor's max-row limit, which reads as a buggy
            //"the card wants more space than I can give it" mismatch.
            //Min rows lowered to 4 so the card still fits inside a
            //compact two-row "info strip" layout if a power user
            //really wants that.
            rows:        8,
            columns:     12,
            min_rows:    4,
            max_rows:    24,
            min_columns: 6,
            max_columns: 12
        };
    }

    public connectedCallback(): void
    {
        super.connectedCallback();
        _liveCards.add(this);
        //Cancel any pending cleanup from a recent disconnect, the
        //engine is still alive and we want to keep it that way.
        //Without this, Masonry's mount/unmount churn would still
        //tear down + re-create the engine on every reflow.
        if (this._pendingCleanupTimer !== undefined)
        {
            window.clearTimeout(this._pendingCleanupTimer);
            this._pendingCleanupTimer = undefined;
        }
        tick(this);
        //30 s tick: the clock displays HH:MM only (seconds dropped),
        //the sun moves ~0.13° per refresh (visually smooth at that
        //cadence), and the live cursor on a 5-day timeline advances
        //~6 px per 30 s on a 1000 px wide chart. PV and battery live
        //readings update on hass state changes, not on this tick, so
        //they remain real-time regardless. Cuts the per-second wake-
        //ups by 30× compared to the previous 1 Hz cadence.
        this._timer = window.setInterval(() => tick(this), 30_000);
        initVisibilityObserver(this);
    }

    public disconnectedCallback(): void
    {
        super.disconnectedCallback();
        _liveCards.delete(this);
        window.clearInterval(this._timer);
        this._visibilityObserver?.disconnect();
        this._visibilityObserver = undefined;
        if (this._onVisibilityChange)
        {
            document.removeEventListener('visibilitychange', this._onVisibilityChange);
            this._onVisibilityChange = undefined;
        }
        //If the card dies before the debounce fires, drop the pending
        //init so a short-lived instance never spawns an engine it won't
        //use.
        if (this._initDebounceTimer !== undefined)
        {
            window.clearTimeout(this._initDebounceTimer);
            this._initDebounceTimer = undefined;
            this._initInflight      = false;
        }
        if (this._lidarFadeRaf !== undefined)
        {
            cancelAnimationFrame(this._lidarFadeRaf);
            this._lidarFadeRaf = undefined;
        }
        //Defer the engine teardown; if the card re-mounts within the
        //window (Masonry reflow), connectedCallback cancels the timer
        //and the engine survives untouched. When the card is really
        //gone (view switch, card removed), the cleanup runs after the
        //grace period, the brief extra GPU work is invisible since
        //nothing is on screen anymore.
        if (this._pendingCleanupTimer !== undefined)
        {
            window.clearTimeout(this._pendingCleanupTimer);
        }
        this._pendingCleanupTimer = window.setTimeout(() =>
        {
            this._pendingCleanupTimer = undefined;
            this._engine?.cleanup();
            this._engine = undefined;
        }, 1500);
    }

    //IntersectionObserver, pause every CSS animation and every SVG
    //SMIL animation when the card scrolls out of the viewport. The
    //rotation loop (a requestAnimationFrame in the engine) is left
    //running because (a) the browser auto-throttles rAF on hidden
    //tabs and (b) the card looks alive when the user scrolls back.
    //Only the SVG overlay animations are paused, they're the ones
    //that run continuously regardless of map state.
    _visibilityObserver?: IntersectionObserver;
    //Document-level visibilitychange listener; set up by
    //initVisibilityObserver() and torn down in disconnectedCallback
    //so a card removed from the DOM doesn't leak a global handler
    //(and a re-mounted card doesn't double-subscribe).
    _onVisibilityChange?: () => void;


    //Engine init policy: re-init only when one of the *identity inputs*
    //changes (API key, home coordinates, map style). We resize the
    //existing engine when the container reflows, we never tear down
    //the MapLibre stack just because a sibling fragment re-rendered.
    //Doing so would trash the user's in-progress edits in the
    //dashboard editor.
    protected updated(_changedProperties: PropertyValues): void
    {
        if (!this.hass?.config || !this.config)
        {
            return;
        }

        const coords = getHomeCoords(this.config, this.hass);
        if (!coords) return;

        const { lat, lon } = coords;

        //One-time wipe of the obsolete auto-calibration buffer left
        //by older releases (localStorage + HA frontend.user_data).
        //Idempotent via a flag in localStorage.
        if (!this._pvCalibWiped)
        {
            this._pvCalibWiped = true;
            wipeLegacyPvCalibStorage(this.hass, getHomeCoords(this.config, this.hass));
        }

        const homeKey  = `${lat.toFixed(5)},${lon.toFixed(5)}`;
        const identityChanged = homeKey !== this._lastHomeKey;

        if (!this._engine || identityChanged)
        {
            if (this._initInflight)
            {
                return;
            }
            this._lastHomeKey   = homeKey;
            this._lastConfigSig = computeConfigSig(this.config);
            initEngine(this);
            return;
        }

        //Identity stable, only push config tweaks down if the visual
        //config has actually changed. Without this guard we'd call
        //updateConfig() on every Lit re-render (e.g. every second from
        //the clock tick, or every time a @state changes), which would
        //rebuild the GeoJSON of thousands of points and freeze the page.
        const sig = computeConfigSig(this.config);
        if (sig !== this._lastConfigSig)
        {
            this._lastConfigSig = sig;
            this._engine.updateConfig(this.config);
        }

        refreshPv(this);
        refreshBattery(this);
        refreshSolarRadiation(this);
    }


    //Engine setup

    _initDebounceTimer?: number;


    //Timeline pointer interaction

    _trackElement:   HTMLElement | null = null;
    _trackPointerId: number | null      = null;


    _boundPointerMove = (e: PointerEvent): void => onTimelinePointerMove(this, e);
    _boundPointerUp   = (e: PointerEvent): void => onTimelinePointerUp(this, e);


    //Render

    protected render(): TemplateResult
    {
        //Precondition for rendering the live card chrome: home
        //coordinates resolved (HA config or the lat/lon override).
        //The basemap itself is OpenFreeMap and needs no credentials.
        //Variable name kept as `hasApiKey` because every conditional
        //branch below already keys off it; only the meaning is "we
        //have what we need to project the home onto the map".
        const hasApiKey = getHomeCoords(this.config, this.hass) !== null;


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
            hourCycle: is12h ? 'h12' : 'h23'
        } as Intl.DateTimeFormatOptions);

        //The on-ground disc self-encodes the low/mid/high breakdown
        //via three concentric bands (proportional radial widths,
        //three shades of the cloud colour); no hover tooltip
        //needed.
        const cloudPctRound    = Math.max(0, Math.round(this._cloudCover));

        //Always-visible cloud-cover percentage label, overlaid in HTML
        //above the home marker, with an SVG leader line tying it to
        //the on-ground 100 % ring. Both anchors come pre-projected
        //from the engine, see HeliosEngine.projectHomeLabelLayout().
        //The label is suppressed until both the layout (map ready)
        //and a cloud-cover value (data ready) are available.
        const layout         = this._labelLayout;
        const showLabel      = hasApiKey && layout !== null && this._cloudCover >= 0;

        //Photovoltaic production chip, pinned above the home, tinted
        //in the configured production colour and tied to the home
        //with an animated leader line whose dashes flow from the
        //house up to the chip. Only renders when the user has set
        //the optional `pv-power-entity` config and the live state
        //read produced a finite numeric value.
        const pvEntityId   = String(this.config?.['pv-power-entity'] ?? '').trim();
        const pvColor      = cfgHex(this.config?.['pv-color'], DEFAULT_PV_COLOR_HEX);
        //When the user scrubs the timeline into the past, the chip
        //should reflect what the PV system actually produced at
        //that instant, same behaviour as the cloud / irradiance
        //chips. For future scrubs there's no PV data (production
        //hasn't happened yet); we hide the chip rather than
        //showing a stale or fake number.
        const pvScrubbing  = !this._isLiveMode && this._selectedTime !== null;
        const pvScrubFuture = pvScrubbing
            && this._selectedTime!.getTime() > Date.now() + 60_000;

        //The chip displays the *instantaneous* production at the
        //active timeline instant, live "now" by default, or the
        //scrub target when the user is exploring the past. For a
        //power sensor (W/kW) we plot the entity's own state /
        //historical sample; for a cumulative-energy sensor
        //(Wh/kWh) we differentiate over the rolling buffer (live)
        //or the bracketing pair of history samples (scrub). Either
        //way the chip never shows the lifetime cumulative total ,
        //that figure is meaningless on a "current production"
        //readout.
        const pvRate = (pvEntityId !== '' && layout !== null)
            ? (pvScrubbing
                ? pvRateAtTime(this, this._selectedTime!)
                : (this._pvCurrent !== null ? currentPvRate(this) : null))
            : null;

        //Predicted PV at the scrub instant when scrubbing into the
        //future. Uses the same kWp × computePvPower(t, lat, lon, cloud)
        //path the chart's dotted forecast line uses. Falls back to
        //null when peak power is unset or no weather is available
        //yet, in which case the chip stays hidden as before.
        let pvPredictedRate: { value: number; unit: string } | null = null;
        if (pvScrubFuture && pvEntityId !== '' && layout !== null)
        {
            const k      = pvCalibK(this.config);
            const coords = getHomeCoords(this.config, this.hass);
            const series = this._chartSeries;
            if (k !== null && coords && series && series.times.length > 0)
            {
                //Pick the series sample closest to _selectedTime.
                const targetMs = this._selectedTime!.getTime();
                let best = 0;
                let bestDiff = Math.abs(series.times[0].getTime() - targetMs);
                for (let i = 1; i < series.times.length; i++)
                {
                    const d = Math.abs(series.times[i].getTime() - targetMs);
                    if (d < bestDiff) { bestDiff = d; best = i; }
                }
                const cloud = series.cloud[best] ?? 0;
                const pct   = computePvPowerWeighted(this.config, this._selectedTime!, coords.lat, coords.lon, cloud, {
                    airTempC: series.temperature[best],
                    windMs:   series.windSpeed[best],
                    raster:   this._engine?.getLidarRaster() ?? null,
                });
                if (pct > 0)
                {
                    //k is W per percent of STC, so pct × k is watts.
                    //Apply the 5-day rolling calibration ratio so the
                    //chip agrees with the dotted forecast curve + the
                    //tooltip value at the same scrub instant; clip at
                    //the inverter's PMax so a bright forecast hour
                    //doesn't overshoot the install's hardware ceiling.
                    //Infinity cap = no clipping.
                    const cal  = computeForecastCalibration(this);
                    const calR = cal ? cal.ratio : 1;
                    const w    = Math.min(pvInverterMaxW(this.config), pct * k * calR);
                    pvPredictedRate = { value: w, unit: 'W' };
                }
            }
        }

        const isPvPredicted = pvScrubFuture && pvPredictedRate !== null;
        const pvActiveRate  = isPvPredicted ? pvPredictedRate : pvRate;

        const showPvLabel = hasApiKey
            && layout !== null
            && pvEntityId !== ''
            && pvActiveRate !== null
            && (!pvScrubFuture || isPvPredicted);

        const pvDisplayValue = showPvLabel
            ? (isPvPredicted ? '≈ ' : '') + formatPvValue(this.hass, pvActiveRate!.value, pvActiveRate!.unit)
            : '';

        //PV → home animated leader. Same vocabulary as the existing
        //battery leaders (dashed line + arrow), painted in the
        //configured PV colour. Speed is normalised against the user's
        //configured peak power (kWp -> W), so the flow saturates
        //exactly at the install's nameplate. Without a configured
        //peak we fall back to a 5 kW reference matching the battery
        //leader's saturation so the visual cadence stays consistent.
        //Idle (no flow, no arrow) when current production is zero or
        //negative.
        const pvWattsNow = (pvRate !== null)
            ? pvNormalizeToWatts(pvRate.value, pvRate.unit)
            : 0;
        const pvCalibKVal = pvCalibK(this.config);
        const pvPeakRefW  = (pvCalibKVal !== null && pvCalibKVal > 0)
            ? pvCalibKVal * 100
            : 5000;
        const pvFlowDuration = flowDuration(pvWattsNow, pvPeakRefW, 0.5);
        const pvIdle         = !(pvWattsNow > 0);
        //Animation duration of the leader-line dash flow, fast when
        //production is high, slow when production is low. Mapped on
        //the same scale as the sun ray below so the two streams feel
        //like one coherent visual language: 0 → 30 s/cycle (almost
        //still), saturated → 3 s/cycle (visible motion without being
        //annoying). For PV we saturate at ~5 kW which is a typical
        //residential peak.
        //Battery overlay, two independent chips flanking the PV
        //chip in screen-space: SoC % on the LEFT, signed Power on
        //the RIGHT, mirroring each other around the PV chip's
        //vertical axis. Each chip is wired back to the PV chip via
        //a static dotted hairline (no animation, no arrow), the
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

        //Active SoC / power values for this render, historical
        //samples in scrub mode, live state otherwise.
        const activeBatterySoc: number | null = batteryScrubbing
            ? batterySampleAtTime(this._batterySocHistory, this._selectedTime!)
            : this._batterySoc;
        const activeBatteryPower: number | null = batteryScrubbing
            ? batterySampleAtTime(this._batteryPowerHistory, this._selectedTime!)
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
            ? formatBatteryPower(this.hass, activeBatteryPower!, activeBatteryUnit)
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
            ? Math.abs(pvNormalizeToWatts(activeBatteryPower!, activeBatteryUnit))
            : 0;
        //"Idle", measured power within sensor-noise margin of zero
        //(±5 W). The leader is still drawn so the user keeps the
        //spatial relationship, but the dash flow is frozen and the
        //arrow head is hidden, nothing is moving in either
        //direction, so any motion would be misleading.
        const batteryIdle = showPowerChip && batteryWattsForFlow < 5;
        const batteryFlowDuration = flowDuration(batteryWattsForFlow, 5000);

        //Battery leader L-shape geometry, computed once and reused
        //for the visible <path> elements (SoC and Power) and for
        //the animated arrow's <animateMotion> path. Only meaningful
        //when a layout is available; gated by the same flag as the
        //chip rendering so we don't dereference a null layout below.
        //
        //  PV_LEG_OFFSET_PX (12) is the horizontal distance from
        //  the PV chip's centre to each L-leg's vertical drop.
        //  The SoC L hangs to the LEFT of centre by this amount,
        //  the Power L to the RIGHT, bringing both legs slightly
        //  inboard of the chip's quarter-width so the bends sit
        //  closer to the chip's middle. Constant rather than
        //  measured because the chips are min-width-clamped to
        //  76 px in the common case, see helios-card-css.ts.
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
        //L-leg starting points. The PV chip is 76 px wide (min-width
        //set on .pv-pct-label); pinning the legs at 25 % and 75 % of
        //that width drops each foot 19 px off the chip's centre, well
        //inside the chip body so the L's vertical leg visibly emerges
        //from a clear PV anchor instead of crowding the chip's centre.
        const PV_LEG_OFFSET_PX     = 19;
        const PV_HALF_HEIGHT_PX    = 11;
        //Half-width of the PV chip, min-width:76 in .pv-pct-label,
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
        //→ end. Direction-agnostic, the vertical leg can travel up
        //or down because the fillet approach point follows the sign
        //of (shelfY - pvEdgeY).
        const buildLPath = (verticalX: number, pvEdgeY: number, shelfY: number, endX: number): string =>
        {
            const dirH  = endX  > verticalX ? 1 : -1;
            const dirV  = shelfY > pvEdgeY  ? 1 : -1;
            //Clamp the radius so the fillet never overshoots a short
            //leg, the rounded corner has to fit inside both legs.
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

        //Solar-arc overlay, sun trajectory across the sky, sun's
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
        const sunRimColor   = darkenHex(sunColor, 0.20);
        const arcSegments   = showSun ? buildArcSegments(sunScene!.arc, sunColor) : [];
        //Z-order split: below-horizon (dotted) segments render BEHIND
        //the home chip cluster so the home reads cleanly through the
        //night portion of the loop, while above-horizon segments, the
        //sun ray, the sun disc and the W/m² readout render AFTER all
        //chips so the live sun stays visually dominant, no chip ever
        //occludes the body of the day.
        const arcSegmentsBack  = arcSegments.filter(s =>  s.belowHorizon);
        const arcSegmentsFront = arcSegments.filter(s => !s.belowHorizon);

        //The incidence ray only renders when the sun is actually
        //above the horizon, drawing a ray from below the ground
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
        //Sun ray spans the whole card, keep the saturated-end pace
        //a touch slower than the PV leader (0.8 s vs the default
        //0.4 s) so peak-irradiance flow stays readable rather than
        //feeling frantic at the top of the day.
        const sunFlowDuration = flowDuration(sunWm2, 1000, 0.8);

        //Solar-ray target, snaps to one of the 4 sides of the PV
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
        //Only snap the ray to the PV chip when the chip is actually
        //rendered. Without this check, the ray pointed at a phantom
        //pvLabel position whenever the user had no pv-power-entity
        //configured, drawing toward an invisible anchor instead of
        //landing on the home marker.
        if (layout && sunScene && pvEntityId)
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

        //LiDAR View gating: the button stays visible (so its location
        //is predictable across homes) but goes disabled when no LiDAR
        //provider covers the active home. Read off the engine, falls
        //back to null until the engine has resolved its first home.
        const lidarSourceId    = this._engine?.getActiveLidarSourceId() ?? null;
        const cardClasses = [
            cardThemeClass,
            this._detailMode      ? 'detail-active'        : '',
            this._lidarViewMode   ? 'lidar-view-active'    : '',
            this._shadingDomeMode ? 'shading-dome-active'  : '',
        ].filter(Boolean).join(' ');

        return html`
            <ha-card class="${cardClasses}">

                <div id="map-container"></div>

                ${hasApiKey && this._timeRange && timelineEnabled(this.config) ? html`
                    <div
                        class="time-bar"
                        style="--timeline-width-frac:${timelineWidthPct(this.config) / 100}"
                        @pointerdown="${(e: PointerEvent) => onTimelinePointerDown(this, e)}"
                    >
                        <!--  Optional PV production graph, only
                              rendered when the user has set the
                              pv-power-entity config. Same chip
                              styling as the main chart card; sits
                              just above it with a 4 px gap so the
                              two read as a stacked instrument. The
                              graph's height is the same as one half
                              of the main chart so the irradiance
                              area and the PV area visually balance
                              each other.  -->
                        ${renderTimelineHoverTooltip(this)}
                        ${pvEntityId ? html`
                            <div
                                class="tb-chart-card tb-pv-card"
                                @pointermove="${(e: PointerEvent) => handleChartHoverMove(this, e)}"
                                @pointerleave="${() => handleChartHoverLeave(this)}"
                            >
                                ${renderPvChart(this)}
                                ${renderTimelineNightZones(this)}
                                ${renderTimelineFutureMask(this)}
                                ${renderTimelineTicks(this)}
                            </div>
                        ` : nothing}

                        <!--  Chart card: hosts the area chart, the
                              dotted day separators, the night-zone
                              diagonal hatch overlay (one rect per
                              sunset, next sunrise window) and the
                              live + scrub cursors as HTML overlays.
                              The day-label chip row used to overlay
                              the midline of this card; it's now a
                              sibling block below so the chips never
                              cover the curves they describe.  -->
                        <div
                            class="tb-chart-card"
                            @pointermove="${(e: PointerEvent) => handleChartHoverMove(this, e)}"
                            @pointerleave="${() => handleChartHoverLeave(this)}"
                        >
                            ${renderChart(this)}
                            ${renderTimelineNightZones(this)}
                            ${renderTimelineFutureMask(this)}
                            ${renderTimelineTicks(this)}
                        </div>
                        ${renderTimelineDayLabels(this)}
                    </div>
                ` : nothing}

                ${hasApiKey ? html`
                    <div class="spinner-center ${(this._fetching || this._shadowBusy) ? 'spinning' : ''}">
                        <svg class="spinner-sun" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                            <!--  Rotating ray bundle, 12 spokes around the disc.
                                  Painted in the configured sun colour via the
                                  CSS variable so the spinner stays on-brand
                                  even when the user themes the sun. -->
                            <g class="spinner-sun-rays">
                                ${[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map(deg => svg`
                                    <line
                                        x1="32" y1="6"
                                        x2="32" y2="14"
                                        stroke="var(--helios-sun-color, #f59e0b)"
                                        stroke-width="3"
                                        stroke-linecap="round"
                                        transform="rotate(${deg} 32 32)"
                                    />
                                `)}
                            </g>
                            <!--  Steady inner disc, doesn't spin (otherwise the
                                  rotation reads "the sun is wobbly", not
                                  "we're loading"). -->
                            <circle cx="32" cy="32" r="10" fill="var(--helios-sun-color, #f59e0b)" />
                        </svg>
                    </div>
                ` : nothing}

                <!--  Top-right mode bar: three glued segments picking
                      which canvas state the card is in. The default
                      Layer UI is the regular HUD (sun arc, clouds,
                      leader lines, chips), LiDAR View paints the
                      cell cloud over a quiet basemap, Ombres paints
                      the celestial dome of learned residuals above
                      the home. The three modes are mutually
                      exclusive; the bar shows which one is active
                      and lets the user switch in a single click.
                      Each segment is icon-only with a title
                      tooltip; the active segment takes the same
                      scrub-blue plate the clock chip uses while
                      scrubbing, for visual consistency with the
                      other mode-indicating chips.                   -->
                ${hasApiKey ? (() => {
                    const isLocal     = lidarSourceId === 'local-ndsm';
                    const hasProvider = lidarSourceId !== null;
                    const lidarIcon   = !hasProvider ? 'mdi:cloud-off-outline'
                                       : isLocal     ? 'mdi:harddisk'
                                                     : 'mdi:earth';
                    const lidarTitle  = !hasProvider ? 'No LiDAR coverage at this location'
                                       : isLocal     ? 'LiDAR view, local nDSM'
                                                     : 'LiDAR view, online provider';
                    const isLayer = !this._lidarViewMode && !this._shadingDomeMode;
                    const onLayer = () => {
                        if (this._lidarViewMode)   toggleLidarView(this);
                        if (this._shadingDomeMode) toggleShadingDome(this);
                    };
                    const onLidar = hasProvider ? (() => {
                        if (this._shadingDomeMode) toggleShadingDome(this);
                        if (!this._lidarViewMode)  toggleLidarView(this);
                    }) : undefined;
                    const onDome = () => {
                        if (this._lidarViewMode)   toggleLidarView(this);
                        if (!this._shadingDomeMode) toggleShadingDome(this);
                    };
                    return html`
                        <div class="overlay-top-right">
                            <div class="mode-bar" role="radiogroup" aria-label="View mode">
                                <button
                                    type="button"
                                    class="mode-bar-seg ${isLayer ? 'is-on' : ''}"
                                    role="radio"
                                    aria-checked="${isLayer ? 'true' : 'false'}"
                                    title="Default layer UI"
                                    @click="${onLayer}"
                                >
                                    <ha-icon icon="mdi:solar-power-variant"></ha-icon>
                                </button>
                                <button
                                    type="button"
                                    class="mode-bar-seg ${this._lidarViewMode ? 'is-on' : ''} ${!hasProvider ? 'is-disabled' : ''}"
                                    role="radio"
                                    aria-checked="${this._lidarViewMode ? 'true' : 'false'}"
                                    ?disabled="${!hasProvider}"
                                    title="${lidarTitle}"
                                    @click="${onLidar}"
                                >
                                    <ha-icon icon="${lidarIcon}"></ha-icon>
                                </button>
                                <button
                                    type="button"
                                    class="mode-bar-seg ${this._shadingDomeMode ? 'is-on' : ''}"
                                    role="radio"
                                    aria-checked="${this._shadingDomeMode ? 'true' : 'false'}"
                                    title="Adaptive shading dome"
                                    @click="${onDome}"
                                >
                                    <ha-icon icon="mdi:radar"></ha-icon>
                                </button>
                            </div>
                        </div>
                    `;
                })() : nothing}

                <!--  Top-left cluster: clock chip showing the active
                      timeline instant + (in scrub mode) a back-to-
                      live button right beside it. The clock takes a
                      blue / white "is-scrub" theme when scrubbing
                      so the same chip doubles as the mode signal,
                      no separate scrub-time chip needed lower on
                      the card.  -->
                ${hasApiKey ? html`
                    <div class="overlay-top-left">
                        <div class="clock ${!this._isLiveMode ? 'is-scrub' : ''}">
                            <span class="clock-date">${displayDateLabel}</span>
                            <span class="clock-time">${displayTimeLabel}</span>
                        </div>
                        ${!this._isLiveMode ? html`
                            <button
                                class="live-return-btn"
                                @click="${() => resetToLive(this)}"
                                aria-label="Back to live"
                            >
                                <ha-icon icon="mdi:restore"></ha-icon>
                            </button>
                        ` : nothing}
                    </div>
                ` : nothing}

                ${hasApiKey && this._cloudScene ? (() => {
                    //SVG-projected cloud disc + 100 % ring. The
                    //screen-space points come from the engine via
                    //projectCloudScene() (anchor-at-home), so the
                    //rendered shape stays a true circle whatever the
                    //terrain mesh does underneath.
                    //
                    //The disc is split into three concentric bands
                    //sized by each layer's share of (low+mid+high)
                    //and shaded with three derivatives of the
                    //configured cloud colour: light (low, innermost),
                    //normal (mid), dark (high, outermost). We stack
                    //outer → inner so each smaller polygon visually
                    //"covers" the centre of the larger one to create
                    //the band appearance — no SVG mask / clip needed.
                    const cs        = this._cloudScene!;
                    const lowPts    = cs.discLow.length  >= 3 ? cs.discLow .map(p => `${p.x},${p.y}`).join(' ') : '';
                    const midPts    = cs.discMid.length  >= 3 ? cs.discMid .map(p => `${p.x},${p.y}`).join(' ') : '';
                    const highPts   = cs.discHigh.length >= 3 ? cs.discHigh.map(p => `${p.x},${p.y}`).join(' ') : '';
                    const ringPts   = cs.ring.length     >= 3 ? cs.ring    .map(p => `${p.x},${p.y}`).join(' ') : '';
                    //Light (low) and dark (high) shades: lerp the
                    //cloud hex toward white / black. Mid uses the
                    //configured cloud colour as-is.
                    const cloudLight = lerpHexToward(cs.cloudHex, '#ffffff', 0.55);
                    const cloudDark  = lerpHexToward(cs.cloudHex, '#000000', 0.40);
                    //SVG mask: white background = cloud visible
                    //everywhere, black home silhouettes punch a hole
                    //so the actual MapLibre extrusion (walls, roof,
                    //outline glow) shows through. Re-projected each
                    //transform via projectHomeFootprints so the cut-
                    //out tracks rotation. Empty array until the
                    //buildings GeoJSON has landed; the mask then
                    //degrades to "all visible" and the disc covers
                    //the home as before.
                    const silhouettes = this._homeSilhouettes;
                    const maskId = 'helios-cloud-home-mask';
                    return html`
                        <svg class="cloud-svg">
                            <defs>
                                <mask id="${maskId}" maskUnits="userSpaceOnUse">
                                    <rect x="0" y="0" width="100%" height="100%" fill="white" />
                                    ${silhouettes.map(sil => {
                                        const N = Math.min(sil.base.length, sil.top.length);
                                        if (N < 3) return nothing;
                                        const basePts = sil.base.map(p => `${p.x},${p.y}`).join(' ');
                                        const topPts  = sil.top .map(p => `${p.x},${p.y}`).join(' ');
                                        const walls   = [];
                                        for (let i = 0; i < N; i++)
                                        {
                                            const j = (i + 1) % N;
                                            walls.push(
                                                `${sil.base[i].x},${sil.base[i].y} ` +
                                                `${sil.base[j].x},${sil.base[j].y} ` +
                                                `${sil.top [j].x},${sil.top [j].y} ` +
                                                `${sil.top [i].x},${sil.top [i].y}`
                                            );
                                        }
                                        //Tiny 1 px stroke pads the mask
                                        //outward by half a pixel so SVG
                                        //sub-pixel anti-aliasing on the
                                        //silhouette edge can never leave
                                        //a visible cloud sliver. Just
                                        //breathing room, no visible halo.
                                        return svg`
                                            <polygon points="${basePts}" fill="black" stroke="black" stroke-width="1" stroke-linejoin="round" />
                                            <polygon points="${topPts}"  fill="black" stroke="black" stroke-width="1" stroke-linejoin="round" />
                                            ${walls.map(w => svg`
                                                <polygon points="${w}" fill="black" stroke="black" stroke-width="1" stroke-linejoin="round" />
                                            `)}
                                        `;
                                    })}
                                </mask>
                            </defs>
                            ${ringPts ? svg`
                                <polygon class="cloud-ring" points="${ringPts}" />
                            ` : nothing}
                            <g mask="url(#${maskId})">
                                ${highPts ? svg`
                                    <polygon
                                        class="cloud-disc cloud-disc-high"
                                        points="${highPts}"
                                        fill="${cloudDark}"
                                        fill-opacity="0.5"
                                    />
                                ` : nothing}
                                ${midPts ? svg`
                                    <polygon
                                        class="cloud-disc cloud-disc-mid"
                                        points="${midPts}"
                                        fill="${cs.cloudHex}"
                                        fill-opacity="0.5"
                                    />
                                ` : nothing}
                                ${lowPts ? svg`
                                    <polygon
                                        class="cloud-disc cloud-disc-low"
                                        points="${lowPts}"
                                        fill="${cloudLight}"
                                        fill-opacity="0.5"
                                    />
                                ` : nothing}
                                <!--  Thin separator outlines on the band
                                      boundaries. The reference ring at
                                      100 % already paints the outermost
                                      edge, so we only need the two inner
                                      separators (mid ↔ high and low ↔
                                      mid). Stroke-only, no fill, drawn
                                      on top so the boundary reads
                                      cleanly without flattening the
                                      band colours behind them.  -->
                                ${highPts ? svg`
                                    <polygon
                                        class="cloud-band-sep"
                                        points="${highPts}"
                                    />
                                ` : nothing}
                                ${midPts ? svg`
                                    <polygon
                                        class="cloud-band-sep"
                                        points="${midPts}"
                                    />
                                ` : nothing}
                            </g>
                        </svg>
                    `;
                })() : nothing}

                <!--  Solar arc, BACK pass. Renders only the dotted
                      below-horizon segments (the sun's path through
                      the underside of the celestial sphere), so the
                      home and its chips read in front of the night
                      half of the loop. Above-horizon segments, the
                      ray, the disc and the W/m² readout move to the
                      FRONT pass at the end of the overlay stack.  -->
                ${showSun && arcSegmentsBack.length > 0 ? html`
                    <svg
                        class="solar-svg solar-svg-back"
                        style="--solar-daylight:${sunScene!.daylight}"
                    >
                        ${arcSegmentsBack.map(s => svg`
                            <line
                                class="solar-arc-outline solar-arc-night"
                                x1="${s.x1}" y1="${s.y1}"
                                x2="${s.x2}" y2="${s.y2}"
                                stroke-width="${(HeliosCard.OUTLINE_FAR
                                    + (HeliosCard.OUTLINE_NEAR - HeliosCard.OUTLINE_FAR) * s.nearness)
                                    * HeliosCard.NIGHT_STROKE_FACTOR}"
                            ></line>
                        `)}
                        ${arcSegmentsBack.map(s => svg`
                            <line
                                class="solar-arc-segment solar-arc-night"
                                x1="${s.x1}" y1="${s.y1}"
                                x2="${s.x2}" y2="${s.y2}"
                                stroke="${s.color}"
                                stroke-width="${(HeliosCard.SEGMENT_FAR
                                    + (HeliosCard.SEGMENT_NEAR - HeliosCard.SEGMENT_FAR) * s.nearness)
                                    * HeliosCard.NIGHT_STROKE_FACTOR}"
                            ></line>
                        `)}
                    </svg>
                ` : nothing}

                ${showLabel ? (() =>
                {
                    //Endpoint = fill-disc edge in the chip-to-home
                    //direction. The fill disc shares the ring's
                    //centre (= home) and scales linearly with cloud
                    //cover %; at 0 % the radius is zero and the line
                    //terminates at home, at 100 % it reaches the
                    //full ring edge. Pinning the endpoint to the
                    //live fill, rather than to a static ring or
                    //the home centre, keeps the leader "hugging"
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

                <!--  PV → home animated leader. Vertical dashed line
                      from the PV chip's bottom edge down to the home
                      marker, painted in the configured PV colour and
                      flowing toward the home at a pace proportional
                      to live production over theoretical peak. Same
                      dash vocabulary as the battery leader, no L bend
                      because PV and the home share the same X anchor
                      so a straight segment is the right vocabulary.
                      Hidden when no PV entity is configured.  -->
                <!--  Ground ring around the home. Drawn in its own SVG
                      layer with an SVG mask built from the home's
                      screen-space silhouette polygons (the same ones
                      that drive the home-glow halo). The mask paints
                      WHITE everywhere and BLACK over the extruded
                      building's projected outline, so the ring is
                      hidden wherever the 3D building stands in front
                      of it. The eye reads the ring as a ground
                      footprint the building physically stands inside,
                      improving the perspective without having to
                      route the ring through MapLibre's layer stack.
                      Leader line + bead live in the next sibling SVG
                      so they stay above the home as before.          -->
                ${showPvLabel ? (() => {
                    const maskId = `helios-home-anchor-mask-${this._instanceId}`;
                    return html`
                        <svg class="pv-home-anchor-svg">
                            <defs>
                                <mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="10000" height="10000">
                                    <!--  White background , ring visible. -->
                                    <rect x="0" y="0" width="10000" height="10000" fill="white" />
                                    <!--  Black home silhouette , ring hidden
                                          where the projected building
                                          stands. Same base + top + wall
                                          polygons the .home-glow-svg
                                          renders, no extra projection
                                          pass needed.                       -->
                                    ${this._homeSilhouettes.map(sil => {
                                        const N = Math.min(sil.base.length, sil.top.length);
                                        if (N < 3) return nothing;
                                        const basePts = sil.base.map(p => `${p.x},${p.y}`).join(' ');
                                        const topPts  = sil.top .map(p => `${p.x},${p.y}`).join(' ');
                                        const walls: string[] = [];
                                        for (let i = 0; i < N; i++)
                                        {
                                            const j = (i + 1) % N;
                                            walls.push(
                                                `${sil.base[i].x},${sil.base[i].y} ` +
                                                `${sil.base[j].x},${sil.base[j].y} ` +
                                                `${sil.top [j].x},${sil.top [j].y} ` +
                                                `${sil.top [i].x},${sil.top [i].y}`
                                            );
                                        }
                                        return svg`
                                            <polygon points="${basePts}" fill="black" />
                                            <polygon points="${topPts}"  fill="black" />
                                            ${walls.map(w => svg`
                                                <polygon points="${w}" fill="black" />
                                            `)}
                                        `;
                                    })}
                                </mask>
                            </defs>
                            <g mask="url(#${maskId})">
                                <g
                                    class="pv-home-leader-anchor ${pvIdle ? '' : 'is-pulsing'}"
                                    transform="translate(${layout!.home.x},${layout!.home.y})"
                                    style="--pv-flow-duration:${pvFlowDuration}s"
                                >
                                    <polygon
                                        class="pv-home-leader-anchor-disc"
                                        points="${layout!.homeAnchorPoints}"
                                        fill="none"
                                        stroke="${pvColor}"
                                        stroke-width="1.6"
                                    ></polygon>
                                </g>
                            </g>
                        </svg>
                    `;
                })() : nothing}

                ${showPvLabel ? html`
                    <svg class="pv-home-leader-svg">
                        <line
                            class="pv-home-leader-line"
                            style="--pv-leader-color:${pvColor}"
                            x1="${layout!.pvLabel.x}"
                            y1="${layout!.pvLabel.y + PV_HALF_HEIGHT_PX}"
                            x2="${layout!.home.x}"
                            y2="${layout!.home.y}"
                        ></line>
                        ${!pvIdle ? svg`
                            <!--  Moving bead, a small filled disc rides
                                  the leader from the PV chip to the
                                  home, at a speed proportional to live
                                  production (same vocabulary as the
                                  Home Assistant energy-distribution
                                  card). No rotate="auto" needed since
                                  a disc has no orientation.  -->
                            <circle
                                class="pv-home-leader-bead"
                                r="4"
                                fill="${pvColor}"
                            >
                                <animateMotion
                                    dur="${pvFlowDuration}s"
                                    repeatCount="indefinite"
                                    path="M ${layout!.pvLabel.x},${layout!.pvLabel.y + PV_HALF_HEIGHT_PX} L ${layout!.home.x},${layout!.home.y}"
                                ></animateMotion>
                            </circle>
                        ` : nothing}
                    </svg>
                ` : nothing}

                ${showPvLabel ? html`
                    <div
                        class="pv-pct-label ${isPvPredicted ? 'is-predicted' : ''}"
                        style="left:${layout!.pvLabel.x}px; top:${layout!.pvLabel.y}px; --pv-leader-color:${pvColor}"
                    >
                        <ha-icon icon="mdi:solar-power-variant"></ha-icon>
                        <span>${pvDisplayValue}</span>
                    </div>
                ` : nothing}

                ${(showSocChip || showPowerChip) ? html`
                    <svg class="battery-leader-svg">
                        <!--
                            SoC ↔ PV, solid, inverted-L path with a
                            rounded corner. No animation: SoC is a
                            level, not a flow direction.
                        -->
                        ${showSocChip ? svg`
                            <path
                                class="battery-leader-line"
                                style="--battery-leader-color:${batteryColor}"
                                d="${socLeaderPath}"
                            ></path>
                        ` : nothing}
                        <!--
                            PV ↔ Power, solid L-shaped path with a
                            small filled bead riding along it at a
                            speed proportional to |P|. The bead's
                            animateMotion path is flipped inline by
                            the renderer when discharging so the
                            travel direction matches the energy flow
                            (PV → Power when charging, Power → PV
                            when discharging).
                        -->
                        ${showPowerChip ? svg`
                            <path
                                class="battery-leader-line"
                                style="--battery-leader-color:${batteryColor}"
                                d="${powerLeaderPath}"
                            ></path>
                            ${!batteryIdle ? svg`
                                <circle
                                    class="battery-leader-bead"
                                    r="4"
                                    fill="${batteryColor}"
                                >
                                    <animateMotion
                                        dur="${batteryFlowDuration}s"
                                        repeatCount="indefinite"
                                        path="${powerArrowPath}"
                                    ></animateMotion>
                                </circle>
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

                <!--  Solar arc, FRONT pass. Renders the above-horizon
                      portion of the sun's loop, the incidence ray to
                      the PV chip, and the sun disc itself, placed AFTER
                      every home-anchored chip so the live sun always
                      reads on top. The card is named Helios, the sun
                      must dominate the stack visually.  -->
                ${showSun && arcSegmentsFront.length > 0 ? html`
                    <svg
                        class="solar-svg solar-svg-front"
                        style="--solar-daylight:${sunScene!.daylight}"
                    >
                        ${arcSegmentsFront.map(s => svg`
                            <line
                                class="solar-arc-outline"
                                x1="${s.x1}" y1="${s.y1}"
                                x2="${s.x2}" y2="${s.y2}"
                                stroke-width="${HeliosCard.OUTLINE_FAR
                                    + (HeliosCard.OUTLINE_NEAR - HeliosCard.OUTLINE_FAR) * s.nearness}"
                            ></line>
                        `)}
                        ${arcSegmentsFront.map(s => svg`
                            <line
                                class="solar-arc-segment"
                                x1="${s.x1}" y1="${s.y1}"
                                x2="${s.x2}" y2="${s.y2}"
                                stroke="${s.color}"
                                stroke-width="${HeliosCard.SEGMENT_FAR
                                    + (HeliosCard.SEGMENT_NEAR - HeliosCard.SEGMENT_FAR) * s.nearness}"
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
                            ${this._isLiveMode ? svg`
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
                        ` : nothing}
                        ${(() => {
                            //Sun disc, four concentric layers, painted
                            //in render order (back to front):
                            //  0. Halo, soft glow whose radius (3 ×
                            //     disc) and centre opacity both scale
                            //     with irradiance, so a clear-sky noon
                            //     sun radiates a visible aura while a
                            //     cloudy or low-altitude sun stays
                            //     compact. The fill uses a radial
                            //     gradient that drops cleanly from the
                            //     irradiance-driven opacity at the
                            //     centre to fully transparent at the
                            //     rim, so the glow feathers into the
                            //     basemap without any hard edge.
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
                            //Halo proportional to live irradiance,
                            //saturating at 1000 W/m² (clear-sky noon).
                            //Same square-root mapping as sunFillRatio so
                            //a 50 % reading visually halves the AREA of
                            //the glow rather than its radius.
                            const haloR        = r * 3;
                            const haloAlphaMax = sunFillRatio * 0.55;
                            return svg`
                                <defs>
                                    <radialGradient id="solar-halo-grad">
                                        <stop offset="0%"   stop-color="${sunColor}" stop-opacity="${haloAlphaMax}"></stop>
                                        <stop offset="100%" stop-color="${sunColor}" stop-opacity="0"></stop>
                                    </radialGradient>
                                </defs>
                                <circle
                                    class="solar-sun-halo"
                                    cx="${sunScene!.sun.x}" cy="${sunScene!.sun.y}"
                                    r="${haloR}"
                                    fill="url(#solar-halo-grad)"
                                ></circle>
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

                <!--  W/m² label, pinned above the sun disc. Same
                      visual language as the cloud-cover label, both
                      read as a matched pair of cartographic readouts.
                      Lands after the front-pass arc so the readout
                      sits on top of the sun glyph as well.  -->
                ${showSunLabel ? html`
                    <div
                        class="solar-pct-label"
                        style="left:${sunScene!.sun.x}px; top:${sunScene!.sun.y - 22}px"
                    >
                        <ha-icon icon="mdi:white-balance-sunny"></ha-icon>
                        <span>${sunWm2Round} W/m²</span>
                    </div>
                ` : nothing}

                <!--  Sunrise / sunset markers were drawn here as
                      sun-coloured ha-icon glyphs anchored at the
                      arc's horizon crossings. Removed: the arc
                      shape itself already communicates "the sun
                      rises here, sets there", the icons added
                      visual noise and competed with the LiDAR
                      shadow blobs sitting on the same
                      horizon line.                                  -->


                <!--  Home hover glow, sun-coloured halo around the
                      projected home silhouette. Reuses the same base
                      ring + top ring + side quads as the cloud-disc
                      mask (so it tracks rotation and matches the
                      extrusion exactly), painted as fill + stroke in
                      the configured sun colour with a CSS drop-
                      shadow filter for the bloom. The opacity is
                      flipped via a class so the appearance / fade is
                      a pure CSS transition, no per-frame work.  -->
                ${hasApiKey && this._homeSilhouettes.length > 0 && !this._detailMode ? (() => {
                    const sunColor = cfgHex(this.config?.['sun-color'], DEFAULT_SUN_COLOR_HEX);
                    return html`
                        <svg class="home-glow-svg ${this._homeHover ? 'is-hovered' : ''}"
                             style="--helios-sun-color:${sunColor}">
                            ${this._homeSilhouettes.map(sil => {
                                const N = Math.min(sil.base.length, sil.top.length);
                                if (N < 3) return nothing;
                                const basePts = sil.base.map(p => `${p.x},${p.y}`).join(' ');
                                const topPts  = sil.top .map(p => `${p.x},${p.y}`).join(' ');
                                const walls   = [];
                                for (let i = 0; i < N; i++)
                                {
                                    const j = (i + 1) % N;
                                    walls.push(
                                        `${sil.base[i].x},${sil.base[i].y} ` +
                                        `${sil.base[j].x},${sil.base[j].y} ` +
                                        `${sil.top [j].x},${sil.top [j].y} ` +
                                        `${sil.top [i].x},${sil.top [i].y}`
                                    );
                                }
                                return svg`
                                    <polygon class="home-glow-shape" points="${basePts}" />
                                    <polygon class="home-glow-shape" points="${topPts}"  />
                                    ${walls.map(w => svg`
                                        <polygon class="home-glow-shape" points="${w}" />
                                    `)}
                                `;
                            })}
                        </svg>
                    `;
                })() : nothing}

                <!--  Home hitbox, an invisible circular click target
                      centred on the home's projected screen position.
                      Visible (interactive) only when the map layout is
                      ready AND we're not already in detail mode.
                      Clicking it eases the camera into the detail
                      pose and triggers the dashboard overlay.  -->
                ${hasApiKey && layout !== null && !this._detailMode ? html`
                    <div
                        class="home-hitbox"
                        style="left:${layout!.home.x}px; top:${layout!.home.y}px"
                        @click="${(e: Event) => handleHomeClick(this, e)}"
                        @mouseenter="${this._onHomeEnter}"
                        @mouseleave="${this._onHomeLeave}"
                    ></div>
                ` : nothing}

                <!--  Detail dashboard overlay, takes over the card
                      while _detailMode is on. The CSS class
                      .detail-active on ha-card fades out every
                      pre-existing overlay so the panel reads as
                      the sole content while open. Dismissal goes
                      through a dedicated close button in the corner
                      rather than a content click, otherwise every
                      internal scroll / tap would close the panel.  -->
                ${this._detailMode ? renderDashboard(this) : nothing}

                <!--  Adaptive shading-dome overlay. SVG is full-card,
                      absolutely positioned, pointer-events disabled
                      so it never intercepts clicks meant for the
                      map. Fades in via inline opacity driven by the
                      fade RAF loop. The cloud-bin picker rides
                      flush against the top-right chip cluster so
                      the slice selector is right next to the chip
                      that opened the view.                          -->
                ${renderShadingDomeOverlay(this)}
                ${this._shadingDomeMode ? renderShadingDomeCloudPicker(this, (pct) => {
                    this._shadingDomeCloudPct = pct;
                    refreshShadingDomeScene(this);
                    this.requestUpdate();
                }) : nothing}

            </ha-card>
        `;
    }


    //Per-card unique id used to namespace SVG <defs> ids so multiple
    //Helios cards on the same dashboard don't clash on gradient /
    //filter references.
    _instanceId = `h${Math.floor(Math.random() * 1e9).toString(36)}`;

    //Hover handlers on the home hitbox. Toggle the sun-coloured
    //glow halo around the home silhouette so the focal building
    //reads as interactive before the user clicks. Cleared on exit
    //so the glow doesn't get stuck on if the cursor leaves while
    //the detail overlay is fading in.
    private _onHomeEnter = (): void =>
    {
        this._homeHover = true;
    };
    private _onHomeLeave = (): void =>
    {
        this._homeHover = false;
    };

    static styles = heliosCardStyles;
}
