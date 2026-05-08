import { LitElement, html, svg, PropertyValues, TemplateResult, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import
{
    HeliosEngine,
    type HeliosConfig,
    DEFAULT_SUN_COLOR_HEX,
    DEFAULT_CLOUD_COLOR_HEX,
    DEFAULT_PV_COLOR_HEX
} from './helios-engine';
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
    //v1.3 — sun disc enlarged so the irradiance fill is readable
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
    //in v1.2.1 after the v1.2 cleanup removed them — now they feed the
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
        cloudLabel: { x: number; y: number };
        pvLabel:    { x: number; y: number };
        ringTop:    { x: number; y: number };
        home:       { x: number; y: number };
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
    //Significantly trimmed in v1.2: most visual styling is now hard-
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
        'pv-power-entity'
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
    }

    public disconnectedCallback(): void
    {
        super.disconnectedCallback();
        window.clearInterval(this._timer);
        this._engine?.cleanup();
        this._engine = undefined;
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

    private _initEngine(): void
    {
        this._initInflight = true;

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

    //v1.3 — segments now share one fixed colour (the configured sun
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
    //v1.3 — mirror chart.
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

        //Auto-scale: the Y axis maps 0 to the bottom edge and the
        //series' running max to the top edge. With a min of 1 we
        //avoid division-by-zero when the series is all-zero (early
        //morning, prolonged outage) and keep the curve visibly
        //pinned to the baseline rather than silently disappearing.
        let yMax = 1;
        for (const s of samples)
        {
            if (s.v > yMax)
            {
                yMax = s.v;
            }
        }
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
            </svg>
        `;
    }

    //v1.3 — the thin track now carries only the cursors. Day
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

        const resetTooltip    = t.tooltip.resetLive;


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
        const pvWattsForFlow = pvRate !== null
            ? this._pvNormalizeToWatts(pvRate.value, pvRate.unit)
            : 0;
        const pvFlowDuration = HeliosCard._flowDuration(pvWattsForFlow, 5000);

        //Solar-arc overlay — sun trajectory across the sky, sun's
        //current position, and incidence ray to the home. All
        //pre-projected to screen space by the engine via
        //projectSunScene(). Hidden until the engine is ready.
        const sunScene  = this._sunScene;
        const showSun   = hasApiKey && sunScene !== null && sunScene.arc.length >= 2;

        //v1.3 — fixed colour design system. The configured sun
        //colour paints the arc, the outer rim of the sun disc,
        //and the inner irradiance fill. The configured cloud
        //colour paints the on-ground disc and the lower mirror
        //of the timeline chart.
        const sunColor      = cfgHex(this.config?.['sun-color'],   DEFAULT_SUN_COLOR_HEX);
        const cloudColor    = cfgHex(this.config?.['cloud-color'], DEFAULT_CLOUD_COLOR_HEX);
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

        return html`
            <ha-card class="${!hasApiKey ? 'placeholder-mode' : ''}">

                ${!hasApiKey ? this._renderPlaceholder() : nothing}

                <div id="map-container" class="${!hasApiKey ? 'hidden' : ''}"></div>

                ${hasApiKey && this._timeRange ? html`
                    <div
                        class="time-bar"
                        @pointerdown="${this._onTimelinePointerDown}"
                    >
                        <!--  Top row: scrub time chip, shown above the
                              chart card with a small breathing gap so
                              it reads cleanly without competing with
                              the chart's data ink.  -->
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
                    <div class="overlay-top-right">
                        <div class="clock ${this._isLiveMode ? '' : 'clock-scrubbed'}">
                            <span class="clock-date">${displayDateLabel}</span>
                            <span class="clock-time">${displayTimeLabel}</span>
                        </div>
                    </div>
                ` : nothing}

                ${hasApiKey && !this._isLiveMode ? html`
                    <div class="overlay-top-left">
                        <button
                            class="tl-live-btn"
                            @click="${this._resetToLive}"
                        >
                            <ha-icon class="tl-live-icon" icon="mdi:restore"></ha-icon>
                            <span>${t.live}</span>
                            <span class="tl-live-tooltip">${resetTooltip}</span>
                        </button>
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
                                x2="${sunScene!.home.x}" y2="${sunScene!.home.y}"
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
                                    path="M ${sunScene!.sun.x},${sunScene!.sun.y} L ${sunScene!.home.x},${sunScene!.home.y}"
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

                ${showLabel ? html`
                    <!--  Sky activity — soft cloud-tinted wisps drifting
                          horizontally over the on-ground disc, modulated
                          by the live cloud-cover percentage. Pure CSS,
                          pointer-transparent, behind the chips so it
                          never competes for attention. -->
                    <div
                        class="sky-activity"
                        style="
                            left:${layout!.home.x}px;
                            top:${layout!.home.y}px;
                            --sky-cloud-color:${cloudColor};
                            --sky-intensity:${Math.min(1, cloudPctRound / 100)};
                        "
                    >
                        <span class="sky-wisp sky-wisp-1"></span>
                        <span class="sky-wisp sky-wisp-2"></span>
                        <span class="sky-wisp sky-wisp-3"></span>
                        <span class="sky-wisp sky-wisp-4"></span>
                        <span class="sky-wisp sky-wisp-5"></span>
                    </div>

                    <svg class="cloud-leader-svg">
                        <line
                            x1="${layout!.cloudLabel.x}"
                            y1="${layout!.cloudLabel.y + 10}"
                            x2="${layout!.ringTop.x}"
                            y2="${layout!.ringTop.y}"
                        ></line>
                    </svg>
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
                    <svg class="pv-leader-svg">
                        <line
                            class="pv-leader-line"
                            style="--pv-leader-color:${pvColor}; --pv-flow-duration:${pvFlowDuration}s"
                            x1="${layout!.home.x}"
                            y1="${layout!.home.y}"
                            x2="${layout!.pvLabel.x}"
                            y2="${layout!.pvLabel.y + 10}"
                        ></line>
                        ${svg`
                            <polygon
                                class="pv-leader-arrow"
                                points="-6,-4 0,0 -6,4"
                                fill="${pvColor}"
                            >
                                <animateMotion
                                    dur="${pvFlowDuration}s"
                                    repeatCount="indefinite"
                                    rotate="auto"
                                    path="M ${layout!.home.x},${layout!.home.y} L ${layout!.pvLabel.x},${layout!.pvLabel.y + 10}"
                                ></animateMotion>
                            </polygon>
                        `}
                    </svg>
                    <div
                        class="pv-pct-label"
                        style="left:${layout!.pvLabel.x}px; top:${layout!.pvLabel.y}px; --pv-leader-color:${pvColor}"
                    >
                        <ha-icon icon="mdi:solar-power-variant"></ha-icon>
                        <span>${pvDisplayValue}</span>
                    </div>
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
        const t = pickTranslations(this.hass?.language);

        return html`
            <div class="placeholder">

                <div class="ph-sky"></div>
                <div class="ph-haze ph-haze-1"></div>
                <div class="ph-haze ph-haze-2"></div>

                <svg
                    class="ph-clouds"
                    viewBox="0 0 800 500"
                    preserveAspectRatio="xMidYMid slice"
                    xmlns="http://www.w3.org/2000/svg"
                >
                    <defs>
                        <filter id="ph-noise" x="-20%" y="-20%" width="140%" height="140%">
                            <feTurbulence
                                type="fractalNoise"
                                baseFrequency="0.012 0.025"
                                numOctaves="3"
                                seed="7"
                                result="noise"
                            />
                            <feDisplacementMap
                                in="SourceGraphic"
                                in2="noise"
                                scale="55"
                                xChannelSelector="R"
                                yChannelSelector="G"
                            />
                            <feGaussianBlur stdDeviation="3" />
                        </filter>
                        <linearGradient id="ph-cloud-grad" x1="0" x2="0" y1="0" y2="1">
                            <stop offset="0%"   stop-color="rgba(255,255,255,0.0)" />
                            <stop offset="40%"  stop-color="rgba(255,255,255,0.55)" />
                            <stop offset="100%" stop-color="rgba(180,200,225,0.65)" />
                        </linearGradient>
                    </defs>
                    <g filter="url(#ph-noise)" fill="url(#ph-cloud-grad)">
                        <ellipse class="ph-band ph-band-1" cx="200" cy="160" rx="220" ry="20" />
                        <ellipse class="ph-band ph-band-2" cx="500" cy="320" rx="280" ry="26" />
                        <ellipse class="ph-band ph-band-3" cx="650" cy="220" rx="180" ry="16" />
                    </g>
                </svg>

                <!-- Half-sun rising at the top of the card. The wrapper is centred
                     horizontally and translated upward so only the bottom half
                     of the disc + halo are visible above the title. -->
                <div class="ph-sun-rise">
                    <div class="ph-sun-bloom"></div>
                    <div class="ph-sun-corona"></div>
                    <div class="ph-sun-body"></div>
                </div>

                <div class="ph-vignette"></div>

                <div class="ph-content">
                    <div class="ph-title">HELIOS</div>
                    <div class="ph-divider"></div>
                    <div class="ph-sub">${t.placeholder.subtitle}</div>
                    <div class="ph-action">${t.placeholder.action}</div>
                </div>

            </div>
        `;
    }

    static styles = heliosCardStyles;
}
