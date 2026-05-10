import maplibregl from 'maplibre-gl';
import type { Map } from 'maplibre-gl';
import { getSunPosition, computePvPower, computeIrradianceWm2 } from './helios-sun';
import { fetchHomePointData, RATE_LIMIT_BACKOFF_MS, type SampleHourly } from './helios-weather';

//Public types

export interface HeliosConfig
{
    'maptiler-api-key':       string;
    'topography-color'?:      unknown;
    'topography-alpha'?:      unknown;
    //v1.0 — when false, all of MapTiler Streets' label layers
    //(road names, building numbers, POI labels, place names) are
    //hidden for a cleaner, minimalist basemap. Default: true.
    'show-labels'?:           unknown;
    //v1.2 — fixed-colour design system. Each metric has one
    //configurable colour reused everywhere it appears (timeline mirror
    //chart + on-arc sun disc for sun, on-ground disc + timeline lower
    //half for cloud). The previous start/end ramp keys
    //(ramp-color-start / ramp-color-end) were retired because a hue
    //ramp forces the viewer to invert the mental mapping for cloud
    //cover (high reading = bad, but a high ramp value used to mean
    //good). Intensity is now conveyed by area / position rather than
    //by hue interpolation.
    'sun-color'?:             unknown;
    'cloud-color'?:           unknown;
    //v1.4 — optional photovoltaic production overlay.
    //  pv-power-entity : Home Assistant entity id of a numeric sensor
    //                    representing solar production (instantaneous
    //                    power in W/kW for an impact-readable curve,
    //                    or cumulative daily energy for a saw-tooth
    //                    accumulation curve). When unset, the whole
    //                    PV overlay (chip below the home, dedicated
    //                    timeline graph) is hidden.
    //  pv-color        : single colour used everywhere PV appears
    //                    (chip icon tint, dedicated graph fill /
    //                    stroke). Defaults to a vivid green chosen
    //                    to read cleanly on the white chart card.
    'pv-power-entity'?:       unknown;
    'pv-color'?:              unknown;
    //v1.1 — optional home-battery overlay. A single chip below the
    //home shows the battery State-of-Charge (%) and the live signed
    //power draw (positive while charging, negative while discharging),
    //mirroring the PV chip above the home. Either entity is optional;
    //the chip renders as long as at least one is set, with a leader
    //line whose flow direction follows the sign of the power.
    //  battery-soc-entity   : Home Assistant entity id of a numeric
    //                         sensor in % (typical: device_class
    //                         "battery", or unit "%"). Out-of-range
    //                         values are clamped to [0, 100].
    //  battery-power-entity : Home Assistant entity id of a numeric
    //                         power sensor in W or kW. Sign convention
    //                         follows the entity itself; positive is
    //                         interpreted as charging.
    //  battery-color        : single colour used everywhere battery
    //                         appears (chip text, border, leader,
    //                         flow arrow). Defaults to a vivid purple.
    'battery-soc-entity'?:    unknown;
    'battery-power-entity'?:  unknown;
    'battery-color'?:         unknown;
    'date-format'?:           unknown;
    //v1.0 — '12h' | '24h'. Default: '24h'. Picks between locale-
    //independent 12-hour ("11:23:45 PM") and 24-hour ("23:23:45")
    //rendering of the date/time chip at the top-right of the card.
    'time-format'?:           unknown;
    //v1.1 — picks the MapTiler base style. 'streets' (default) renders
    //a sober vector basemap suited to dense urban areas; 'topo' renders
    //a topographic basemap with contour lines and softer earth tones,
    //better in hilly / outdoor settings; 'hybrid' renders satellite
    //imagery with road and label overlays. The label visibility toggle
    //and the helios-buildings extrusion are independent of this choice
    //(all three are wired to custom sources).
    'map-style'?:             unknown;
    //v1.1.0-beta.8 — picks the card chrome theme. 'light' (default)
    //paints chips, charts, buttons, tooltips and the scrub overlay
    //on a white surface; 'dark' switches to a near-black surface
    //with light-grey text so the card sits cleanly inside dark HA
    //dashboards. The 3D map basemap and the configured colour
    //palette (sun, cloud, PV, battery) are unaffected.
    'card-theme'?:            unknown;
    //v1.1.0-beta.11 — single colour applied to every 3D building
    //in the helios-buildings layer (home + neighbours). Defaults
    //to a neutral cool grey. Exposing it lets users tint the
    //urban backdrop to match their dashboard palette without
    //touching the chip / leader colours that carry the actual
    //data.
    'building-color'?:        unknown;
}

export type CloudIntensity = 'clear' | 'light' | 'moderate' | 'heavy' | 'storm' | 'fog';

//Sources of the irradiance value displayed in the PV legend.
//
//  haurwitz   — local computation using Haurwitz (1945) clear-sky GHI
//               and Kasten-Czeplak (1980) cloud attenuation. Always
//               available since it only needs the solar position and
//               cloud_cover. Used as the fallback past the forecast
//               horizon or when the model omits shortwave_radiation.
//  shortwave  — direct read of `shortwave_radiation_instant` from the
//               weather model (median across the active models in
//               'high' precision mode). Considered more accurate
//               because the model integrates aerosols, humidity
//               profile and multi-layer cloud effects that a purely
//               analytical formula can't reproduce.
export type IrradianceSource = 'haurwitz' | 'shortwave';

export interface WeatherData
{
    cloudCover:     number;
    cloudLow:       number;        //% — low-level clouds (≤ 3 km)
    cloudMid:       number;        //% — mid-level clouds (3–8 km)
    cloudHigh:      number;        //% — high-level clouds (≥ 8 km)
    cloudIntensity: CloudIntensity;
    //v1.2 — gradients retired. The card no longer paints a ramp band
    //under the timeline; the new mirror chart carries both metrics
    //natively. Fields kept on WeatherData for ABI stability and now
    //always emit the empty string.
    cloudGradient:    string;
    irradianceGradient: string;
    timeRange:      { start: Date; end: Date } | null;
    isLiveTime:     boolean;
    pvPower:        number;        //primary value, normalised 0..100 (≈ GHI/10 W/m²)
    pvPowerHaurwitz:  number;      //always populated (analytical fallback)
    pvPowerShortwave: number;      //-1 if shortwave_radiation is unavailable
    irradianceSource: IrradianceSource;
}

type RGB = [number, number, number];

//Mobile detection — used to scale grid density and pixel ratio so older
//phones keep usable framerates. Computed once at module load.
const IS_MOBILE = (() =>
{
    if (typeof navigator === 'undefined')
    {
        return false;
    }
    const ua = navigator.userAgent || '';
    if (/Mobi|Android|iPhone|iPad|iPod|IEMobile|BlackBerry/i.test(ua))
    {
        return true;
    }
    //Treat narrow viewports as mobile too — covers desktop in mobile mode
    if (typeof window !== 'undefined' && window.innerWidth <= 768)
    {
        return true;
    }
    return false;
})();

//Config helpers

function toColor(v: unknown, fallback: string): string
{
    if (v == null)
    {
        return fallback;
    }
    const s = String(v).trim();
    if (!s || s === 'null' || s === 'undefined')
    {
        return fallback;
    }
    if (/^\d+$/.test(s))
    {
        const n = parseInt(s, 10);
        if (n >= 0 && n <= 0xFFFFFF)
        {
            return '#' + n.toString(16).padStart(6, '0');
        }
    }
    return s;
}

function toAlpha(v: unknown, fallback: number): number
{
    if (v == null)
    {
        return fallback;
    }
    const n = parseFloat(String(v));
    return isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function parseHex(v: unknown, fallback: RGB): RGB
{
    if (v == null)
    {
        return fallback;
    }
    const s = String(v).trim().replace('#', '');
    if (s.length !== 6)
    {
        return fallback;
    }
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b))
    {
        return fallback;
    }
    return [r, g, b];
}

//Fixed-colour design system (v1.2).
//
//Each metric has its own colour, fixed and configurable. We don't
//interpolate hues to convey intensity any more — instead we vary the
//area or the position of a single colour so a quick glance at the
//card tells the user "more cloud" or "more sun" without first
//decoding a rainbow ramp. The fixed colour also propagates unchanged
//across all surfaces (timeline mirror chart, on-ground cloud disc,
//on-arc sun disc) so the visual language stays internally consistent.
//
//Defaults were chosen for maximum perceptual contrast against each
//other and against typical satellite imagery:
//  - Sun: a warm amber (#EF9F27) — clearly warm, high luminance,
//    doesn't compete with the green/blue of vegetation or water in
//    the basemap.
//  - Cloud: a cool desaturated blue (#5A8DC4) — clearly cool, mid
//    luminance, doesn't compete with the typical road/river blues
//    rendered by MapTiler streets.
//These two hues sit roughly opposite on the colour wheel so the eye
//can distinguish them even at low alpha.
export const DEFAULT_SUN_COLOR_HEX:   string = '#EF9F27';
export const DEFAULT_CLOUD_COLOR_HEX: string = '#5A8DC4';
//Vivid green that holds its own against the chart's white background
//and reads as "solar production" without competing with the orange sun
//or the blue cloud colours.
export const DEFAULT_PV_COLOR_HEX:    string = '#27B36B';
//Saturated red — distinct from sun (orange), cloud (blue), PV
//(green), and easy to associate visually with battery
//discharge / "energy on draw" semantics. Reads cleanly on the
//80 % white chip background.
export const DEFAULT_BATTERY_COLOR_HEX: string = '#D32F2F';
//Neutral light grey — buildings are urban context, never the
//focal point. Slightly cool (more blue than the chip white) so
//the home reads as "stone / concrete" rather than "snow", and
//sits a touch behind the warmer sun / PV chips visually.
export const DEFAULT_BUILDING_COLOR_HEX: string = '#D2D2D7';

const DEFAULT_CLOUD_RGB: RGB = [0x5A, 0x8D, 0xC4];



//Haversine distance — used to compare two lat/lon pairs in metres.

function geoDistM(lat1: number, lon1: number, lat2: number, lon2: number): number
{
    const R  = 6_371_000;
    const D  = Math.PI / 180;
    const dφ = (lat2 - lat1) * D;
    const dλ = (lon2 - lon1) * D;
    const a  = Math.sin(dφ / 2) ** 2
             + Math.cos(lat1 * D) * Math.cos(lat2 * D) * Math.sin(dλ / 2) ** 2;
    return R * 2 * Math.asin(Math.sqrt(a));
}

//Build a closed-ring polygon approximating a geographic circle.
//
//MapLibre has no native "geographic circle" geometry — its `circle`
//layer type renders pixel-sized markers, not metre-sized discs. So
//for any "x metres around the home" overlay we generate a polygon
//of N segments around the centre. 64 segments are visually
//indistinguishable from a true circle at our zoom range and add
//no measurable cost.
//
//Formulae use the equirectangular metres-per-degree approximation,
//valid within the few-hundred-metres scale we work at:
//  - 1° latitude  ≈ 111 320 m anywhere on Earth
//  - 1° longitude ≈ 111 320 × cos(lat) m
//
//Returns a coordinate ring with the first point repeated at the end
//so the polygon closes — required by GeoJSON's Polygon spec.
function buildCirclePolygon(
    centerLon:     number,
    centerLat:     number,
    radiusMetres:  number,
    segments:      number = 64
): Array<[number, number]>
{
    const cosLat = Math.cos(centerLat * Math.PI / 180);
    const dLat   = radiusMetres / 111_320;
    const dLon   = radiusMetres / (111_320 * cosLat);

    const ring: Array<[number, number]> = [];
    for (let i = 0; i < segments; i++)
    {
        const a = (i / segments) * 2 * Math.PI;
        ring.push([
            centerLon + Math.cos(a) * dLon,
            centerLat + Math.sin(a) * dLat
        ]);
    }
    ring.push(ring[0]);
    return ring;
}


//Cloud-cover disc parameters.
//
//The card now expresses the current cloud coverage as a flat disc on
//the ground centred on the home, surrounded by a black outlined ring
//that materialises the 100 % reference. The disc's radius scales
//linearly with the cloud-cover percentage:
//  cloudPct =   0 %  →  radius = 0     (no disc, pristine sky)
//  cloudPct =  50 %  →  radius = R/2
//  cloudPct = 100 %  →  radius = R     (disc touches the outline)
//
//Radius is in real-world metres. At our locked neighbourhood zoom
//(18) one metre is ~2.5 px on screen, so a 30 m radius reads as
//a ~75 px disc — focal on the home itself, neither dwarfing it nor
//swallowing too much of the surrounding context.
const CLOUD_DISC_RADIUS_M       = 30;
//Disc opacity is intentionally low (0.25): the disc is a quiet
//backdrop, not the focal point. The percentage label and its leader
//line carry the precise reading; the disc only tells the eye, at a
//glance, how much of the ring is filled. The disc is now painted
//in the configured cloud-color (fixed colour design system) — the
//radius alone encodes the percentage.
const CLOUD_DISC_OPACITY        = 0.25;
//100% reference ring — thin and translucent so it never competes
//with the percentage label for attention. Pure black so it reads
//consistently regardless of the chosen cloud-color.
const CLOUD_RING_COLOR          = '#000000';
const CLOUD_RING_WIDTH_PX       = 1;
const CLOUD_RING_OPACITY        = 0.4;
//Number of polygon vertices used to approximate the disc and ring.
//128 is overkill for the visual smoothness alone but the cost is
//still negligible (~128 trig ops per data update) and it future-
//proofs the look against tighter zooms or subtle lighting we may
//add in later phases.
const CLOUD_CIRCLE_SEGMENTS     = 128;

//Vertical screen-space offset of the percentage label above the
//home position, in CSS pixels. The label hovers this many pixels
//above where the home projects on screen, regardless of pitch or
//rotation — it's an HTML overlay, not a ground-anchored object.
//A leader line bridges the gap between the label and the top of
//the cloud-cover ring projected on the ground.
const CLOUD_LABEL_OFFSET_PX     = 100;


//Solar-arc parameters. The arc traces the sun's full 24h
//trajectory across the local sky, projected onto the screen via
//the same camera matrices MapLibre uses for its own 3D content.
//
//Radius is in real-world metres — i.e. the radius of the imaginary
//hemisphere on which we paint the sun's path, centred on the home.
//40 m at zoom 18 keeps the entire arc inside a typical card-sized
//canvas (≈440×500 CSS px) even at low solar altitudes where the
//path stretches far east-west: with the home projected near the
//canvas centre, the noon apex sits comfortably below the top edge
//and the morning/evening extremes stay within the left/right
//margins. Earlier values (100 m) put roughly half the arc above
//the canvas top.
const SUN_ARC_RADIUS_M          = 40;
//Number of samples uniformly spaced over the 24h day (UTC), one per
//15 min. 96 is enough that the polyline reads as smooth even at
//tight zoom while still cheap to recompute on every map transform.
const SUN_ARC_SAMPLES           = 96;
//Opacity multiplier when the sun is below the horizon. The arc
//remains visible (so the user keeps a sense of where the sun will
//rise / has set) but is faded out so it doesn't compete visually
//with the daytime portion that's actually contributing power.
const SUN_ARC_NIGHT_OPACITY     = 0.25;


function weatherCodeToIntensity(code: number, pct: number): CloudIntensity
{
    if (code >= 95)
    {
        return 'storm';
    }
    if (code >= 45 && code <= 48)
    {
        return 'fog';
    }
    if ((code >= 61 && code <= 67) || (code >= 71 && code <= 77) || code >= 80)
    {
        return 'heavy';
    }
    if (code >= 51)
    {
        return 'moderate';
    }
    if (pct < 15)
    {
        return 'clear';
    }
    if (pct < 50)
    {
        return 'light';
    }
    return pct < 80 ? 'moderate' : 'heavy';
}


//Engine

export class HeliosEngine
{
    private map?:     Map;
    private homeLat:  number;
    private homeLon:  number;
    //Home altitude (metres above sea level), forwarded to Open-Meteo
    //via &elevation= for sharper boundary conditions. Undefined falls
    //back to the API's global 90 m DEM.
    private homeElevation?: number;
    private apiKey:   string;
    private cfg:      HeliosConfig;

    private _fetchLat = 0;
    private _fetchLon = 0;

    private _mapReady     = false;
    //Single source of truth for hourly forecast data. Populated by
    //fetchHomePointData(); null until the first successful fetch.
    private _homeHourlyData: SampleHourly | null = null;
    private _selectedTime:  Date | null       = null;

    //Skip atmosphere repaint when the sun moved less than 0.5° since
    //last call (≈ 2 min) — setPaintProperty isn't free on mobile.
    private _lastAtmosphereAlt = -999;

    //Consecutive HTTP 429 count, drives exponential back-off. Resets
    //on any successful fetch.
    private _rateLimitStreak = 0;

    private _fetchAbortController?: AbortController;
    private _resizeDebounceTimer?:  number;
    private _weatherTimer?:         number;
    private _skyTimer?:             number;
    private _resizeObserver?:       ResizeObserver;

    //_weatherTimer holds either a setInterval id (regular refresh) or
    //a setTimeout id (rate-limit back-off). The two ID spaces overlap
    //in practice but not by spec, so we always clear both kinds.
    private _clearWeatherTimer(): void
    {
        if (this._weatherTimer !== undefined)
        {
            window.clearInterval(this._weatherTimer);
            window.clearTimeout(this._weatherTimer);
            this._weatherTimer = undefined;
        }
    }

    public onFetchStart?:    () => void;
    public onFetchEnd?:      () => void;
    public onWeatherUpdate?: (data: WeatherData) => void;
    //Hover events on the cloud-cover disc — drive the floating
    //low/mid/high breakdown tooltip in the card.
    public onCloudHover?:    (e: { x: number; y: number; hover: boolean }) => void;
    //Map transform changed — the card recomputes screen-space
    //projections (sun arc, chip positions, leaders) from this hook.
    public onMapTransform?:  () => void;

    //Auto-rotation state. The map slowly orbits the home in the
    //opposite direction to the sun's apparent motion (decreasing
    //bearing, ~1°/s) when the user has been idle for a few seconds.
    //Any direct interaction resets the inactivity timer, so the
    //rotation pauses immediately on pinch / drag / wheel and
    //resumes once the user lets go.
    private _autoRotateRaf?:           number;
    private _autoRotateLastFrame:      number = 0;
    private _autoRotateLastUserAction: number = 0;

    constructor(
        container:    HTMLElement,
        config:       HeliosConfig,
        haCoords:     [number, number],
        haElevation?: number
    )
    {
        this.homeLat = haCoords[1];
        this.homeLon = haCoords[0];
        this.homeElevation = (typeof haElevation === 'number' && Number.isFinite(haElevation))
            ? haElevation
            : undefined;
        this.cfg     = { ...config };
        this.apiKey  = String(config['maptiler-api-key'] ?? '').trim();

        this._fetchLat = this.homeLat;
        this._fetchLon = this.homeLon;

        //Pixel ratio: clamp [2, 3] on desktop for sharpness, [1, 1.5]
        //on mobile to halve fragment-shader load.
        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
        const pixelRatio = IS_MOBILE
            ? Math.min(Math.max(dpr, 1), 1.5)
            : Math.min(Math.max(dpr, 2), 3);

        const styleInfo = this._resolveMapStyle();

        //Camera is locked on the home for zoom/pan/pitch — the data
        //only makes sense from this exact viewpoint. Rotation is the
        //only direct user input: spinning around the home lets them
        //read the sun trajectory from any compass angle. Bearing
        //auto-flips per hemisphere so noon always sits at the top
        //(NH: south up, SH: north up).
        this.map = new maplibregl.Map(
        {
            container,
            style:           `https://api.maptiler.com/maps/${styleInfo.id}/style.json?key=${this.apiKey}`,
            center:          haCoords,
            zoom:            18,
            pitch:           55,
            bearing:         this.homeLat >= 0 ? 180 : 0,
            minZoom:         18,
            maxZoom:         18,
            dragPan:         false,
            scrollZoom:      false,
            doubleClickZoom: false,
            dragRotate:      true,
            touchZoomRotate: true,
            touchPitch:      false,
            boxZoom:         false,
            keyboard:        false,
            pixelRatio
        });

        //ResizeObserver fires aggressively on iOS during orientation
        //changes. We coalesce bursts into a single resize at the end.
        this._resizeObserver = new ResizeObserver(() =>
        {
            window.clearTimeout(this._resizeDebounceTimer);
            this._resizeDebounceTimer = window.setTimeout(() =>
            {
                if (this.map)
                {
                    requestAnimationFrame(() => this.map?.resize());
                }
            }, 80);
        });

        this._resizeObserver.observe(container);

        //Lock the pinch-rotate pivot to the canvas centre. By default,
        //TwoFingersTouchZoomRotateHandler rotates around the centroid
        //of the two fingers — visually, the home orbits around the
        //pinch point during the gesture, very obvious on small cards.
        //`around: 'center'` forces the pivot to be the screen centre,
        //which is exactly where the home projects, so the home stays
        //pinned no matter where the fingers land.
        this.map.touchZoomRotate.enable({ around: 'center' });

        //Hard pin the map centre on every user-driven transform: the
        //home must never leave the dead-centre of the card during a
        //rotate, and any sub-pixel drift accumulated by the bearing
        //handler at zoom 18 / pitch 55° gets corrected immediately.
        //We gate on `originalEvent` so future programmatic eases
        //(e.g. recenter()) can still animate freely without being
        //fought frame-by-frame by this snap.
        const pinHomeAtCenter = (e: any) =>
        {
            if (!this.map || !e?.originalEvent)
            {
                return;
            }
            const c = this.map.getCenter();
            if (c.lng !== this.homeLon || c.lat !== this.homeLat)
            {
                this.map.setCenter([this.homeLon, this.homeLat]);
            }
        };
        this.map.on('rotate', pinHomeAtCenter);
        this.map.on('move',   pinHomeAtCenter);

        this.map.on('style.load', () => this._onStyleLoad());
        this.map.on('load',       () =>
        {
            this.map?.resize();
            this._startAutoRotateLoop();
        });

        //Map transform broadcaster — relays move events to the card so
        //it can keep HTML overlays (the percentage label and its
        //leader line) aligned with the underlying canvas. We listen
        //on `move` rather than the higher-level `moveend` so the
        //overlays track the camera frame-by-frame during programmatic
        //animations rather than snapping at the end.
        this.map.on('move', () => this.onMapTransform?.());

        //Auto-rotation pause — any DOM-level interaction on the canvas
        //(mouse, touch, wheel) bumps the inactivity timer so the
        //rotation loop yields immediately and only resumes after a
        //few seconds of stillness. We hook DOM events rather than
        //MapLibre 'rotate' / 'pitch' / 'drag' because the loop ITSELF
        //emits those (via setBearing), which would otherwise be
        //indistinguishable from a real user action.
        const canvas = this.map.getCanvas();
        const bumpInactivity = () => { this._autoRotateLastUserAction = Date.now(); };
        canvas.addEventListener('mousedown',  bumpInactivity);
        canvas.addEventListener('wheel',      bumpInactivity, { passive: true });
        canvas.addEventListener('touchstart', bumpInactivity, { passive: true });
        canvas.addEventListener('touchmove',  bumpInactivity, { passive: true });

        //Surface MapLibre internal errors (auth, tile fetch, WebGL) to
        //the browser console rather than letting them silently cascade.
        //Without this hook, an invalid API key just produces silent 403s
        //and the user sees a frozen card with no diagnostic.
        this.map.on('error', (e: any) =>
        {
            const msg = e?.error?.message ?? e?.error ?? 'unknown error';
            console.warn('[HELIOS] MapLibre error:', msg);
        });

        this._refreshWeather();
    }

    //Resolves the active MapTiler style id from `map-style` config.
    //Three values are accepted:
    //  'streets' (default) → 'streets-v4' — sober urban basemap.
    //  'topo'              → 'topo-v4'    — topographic basemap with
    //                                       contour lines and softer
    //                                       earth tones, better in
    //                                       hilly / outdoor settings.
    //  'hybrid'            → 'hybrid-v4'  — satellite imagery with
    //                                       roads + label overlays,
    //                                       useful when the user
    //                                       wants real-world context
    //                                       (vegetation, rooftops,
    //                                       parking lots) under the
    //                                       solar overlay.
    //
    //Anything else falls back to 'streets'. `isHybrid` toggles the
    //sat-hires raster source (added below) so the high-resolution
    //satellite tiles fade in beyond zoom 15 — without it the base
    //hybrid style is too soft at the home's locked zoom 18.
    private _resolveMapStyle(): { id: string; isHybrid: boolean }
    {
        const raw = String(this.cfg['map-style'] ?? 'streets').toLowerCase();
        if (raw === 'topo')
        {
            return { id: 'topo-v4', isHybrid: false };
        }
        if (raw === 'hybrid')
        {
            return { id: 'hybrid-v4', isHybrid: true };
        }
        return { id: 'streets-v4', isHybrid: false };
    }

    private _findHourIndex(t: Date): number
    {
        const home = this._homeHourlyData;
        if (!home || !home.times.length)
        {
            return 0;
        }

        const target = t.getTime();
        const times  = home.times;
        let best     = 0;
        let bestDist = Math.abs(times[0].getTime() - target);

        for (let i = 1; i < times.length; i++)
        {
            const d = Math.abs(times[i].getTime() - target);
            if (d < bestDist)
            {
                bestDist = d;
                best     = i;
            }
            else if (d > bestDist)
            {
                break;
            }
        }

        return best;
    }

    //Resolve the weather variables at a given time as seen from the
    //home location.
    //
    //Single source: _homeHourlyData, populated by fetchHomePointData.
    //If null (initial state, fetch failed, or fetch in flight) we
    //return the "empty" sentinel and let the timeline ramps render
    //as flat / hidden.
    //
    //Returns shortwave = -1 to mean "model didn't provide a value at
    //this hour", which the caller treats as "fall back to Haurwitz".
    private _getWeatherAtTime(t: Date): {
        cloudCover:     number;
        cloudLow:       number;
        cloudMid:       number;
        cloudHigh:      number;
        shortwave:      number;
        cloudIntensity: CloudIntensity;
    }
    {
        const empty = {
            cloudCover:     0,
            cloudLow:       0,
            cloudMid:       0,
            cloudHigh:      0,
            shortwave:      -1,
            cloudIntensity: 'clear' as CloudIntensity
        };

        const home = this._homeHourlyData;
        if (!home || !home.times.length)
        {
            return empty;
        }

        const idx = this._findHourIndex(t);
        if (idx < 0 || idx >= home.times.length)
        {
            return empty;
        }

        const cc   = home.cloudCover[idx]  ?? 0;
        const cLow = home.cloudLow[idx]    ?? 0;
        const cMid = home.cloudMid[idx]    ?? 0;
        const cHi  = home.cloudHigh[idx]   ?? 0;
        const sw   = home.shortwave[idx]   ?? -1;
        const wc   = home.weatherCode[idx] ?? 0;

        return {
            cloudCover:     cc,
            cloudLow:       cLow,
            cloudMid:       cMid,
            cloudHigh:      cHi,
            shortwave:      sw,
            cloudIntensity: weatherCodeToIntensity(wc, cc)
        };
    }

    private _getTimeRange(): { start: Date; end: Date } | null
    {
        const home = this._homeHourlyData;
        if (!home || !home.times.length)
        {
            return null;
        }
        const t = home.times;
        return { start: t[0], end: t[t.length - 1] };
    }

    //Resolve the configured cloud colour, falling back to the design
    //system default. Returned as RGB so callers can build either an
    //opaque rgb() or a translucent rgba() string depending on the
    //surface being painted.
    private _resolvedCloudRgb(): RGB
    {
        return parseHex(this.cfg['cloud-color'], DEFAULT_CLOUD_RGB);
    }

    private _renderForCurrentSelection(): void
    {
        if (!this.map || !this._homeHourlyData)
        {
            return;
        }

        const t = this._selectedTime ?? new Date();
        const w = this._getWeatherAtTime(t);

        //Compute both irradiance candidates so the card can let the
        //user compare them. Haurwitz is always defined (analytical
        //fallback). pvPowerShortwave stays at -1 when the model
        //didn't supply shortwave_radiation_instant for this hour
        //(beyond forecast horizon, missing variable on the chosen
        //model, or auxiliary fetch failed).
        const pvPowerHaurwitz = computePvPower(t, this.homeLat, this.homeLon, w.cloudCover);

        let pvPowerShortwave = -1;
        if (w.shortwave >= 0)
        {
            //shortwave is in W/m². Normalise against STC (1000 W/m²)
            //and clamp to [0, 100] to match the legacy pvPower scale,
            //so downstream ramp/legend code doesn't need to know
            //which source produced the value.
            pvPowerShortwave = Math.max(0, Math.min(100, w.shortwave / 1000 * 100));
        }

        //Pick the primary value to display:
        //  - shortwave when available (model value, more accurate)
        //  - Haurwitz otherwise (fallback)
        const useShortwave    = pvPowerShortwave >= 0;
        const pvPower         = useShortwave ? pvPowerShortwave : pvPowerHaurwitz;
        const irradianceSource: IrradianceSource = useShortwave ? 'shortwave' : 'haurwitz';

        //v1.2 — the cloudGradient and irradianceGradient fields are
        //retained on WeatherData for ABI stability, but the card no
        //longer paints a ramp band underneath the timeline; the new
        //mirror chart carries both metrics natively.
        this.onWeatherUpdate?.(
        {
            cloudCover:       w.cloudCover,
            cloudLow:         w.cloudLow,
            cloudMid:         w.cloudMid,
            cloudHigh:        w.cloudHigh,
            cloudIntensity:   w.cloudIntensity,
            cloudGradient:      '',
            irradianceGradient: '',
            timeRange:        this._getTimeRange(),
            isLiveTime:       this._selectedTime === null,
            pvPower,
            pvPowerHaurwitz,
            pvPowerShortwave,
            irradianceSource
        });

        //Refresh the on-ground cloud-cover gauge: a coloured disc
        //whose radius reflects the current coverage percentage,
        //surrounded by a fixed 100 % reference ring.
        this._updateCloudCoverDisc(w.cloudCover);
    }

    private _onStyleLoad(): void
    {
        if (!this.map)
        {
            return;
        }
        this._mapReady = true;

        if (!this.map.getSource('helios-terrain'))
        {
            this.map.addSource('helios-terrain',
            {
                type:     'raster-dem',
                url:      `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${this.apiKey}`,
                tileSize: 512,
                maxzoom:  14
            });
        }
        this.map.setTerrain({ source: 'helios-terrain', exaggeration: 1.2 });

        const styleInfo = this._resolveMapStyle();

        if (styleInfo.isHybrid && !this.map.getSource('sat-hires'))
        {
            //High-resolution satellite raster overlay, faded in at
            //zoom >= 16 to sharpen the imagery beyond what the vector
            //style provides on its own. Only added in hybrid mode —
            //Streets has no satellite imagery and overlaying one would
            //defeat the choice.
            //
            //URL note: this is the rasterized form of the hybrid-v4
            //*map*, so the path is /maps/hybrid-v4/tiles.json. Using
            ///tiles/hybrid-v4/... returns a 404 (that path is reserved
            //for raw tilesets like satellite-v2 or terrain-rgb-v2).
            this.map.addSource('sat-hires',
            {
                type:     'raster',
                url:      `https://api.maptiler.com/maps/hybrid-v4/tiles.json?key=${this.apiKey}`,
                tileSize: 512
            });

            const firstSym = this.map.getStyle().layers?.find(l => l.type === 'symbol')?.id;

            this.map.addLayer(
                {
                    id:      'sat-hires-layer',
                    type:    'raster',
                    source:  'sat-hires',
                    maxzoom: 22,
                    paint:
                    {
                        'raster-opacity':        ['interpolate', ['linear'], ['zoom'], 15, 0, 16, 1],
                        //Calm initial values matching the daytime runtime
                        //modulation in _refreshShadowsAndAtmosphere. Higher
                        //values (sat 0.35 / contrast 0.40) were producing
                        //a "blown out" feel for the first few frames before
                        //the atmosphere pass overrode them, plus they stack
                        //visually with the base raster styling below.
                        'raster-saturation':     0.15,
                        'raster-contrast':       0.15,
                        'raster-brightness-min': 0.03,
                        'raster-resampling':     'linear'
                    }
                },
                firstSym
            );
        }

        this.map.getStyle().layers?.forEach(l =>
        {
            if (l.type === 'raster' && l.id !== 'sat-hires-layer')
            {
                try
                {
                    //Base raster (below sat-hires, visible at zoom < 16).
                    //Kept very modest because at zooms 15-16 it blends
                    //with sat-hires and the contrasts/saturations would
                    //otherwise add up visually.
                    this.map!.setPaintProperty(l.id, 'raster-saturation', 0.10);
                    this.map!.setPaintProperty(l.id, 'raster-contrast',   0.05);
                }
                catch (_) {}
            }
        });

        //Layer order matters here. We add hillshade and night-shade
        //first (they tint the ground), then the cloud-cover disc
        //(painted on the ground beneath buildings so they emerge
        //through it as islands), then buildings on top. The 3D
        //solar overlays (arc, sun, incidence ray) are NOT MapLibre
        //layers — they live as HTML/SVG above the canvas and use
        //screen-space projection of geographic + altitude points
        //(see projectScenePoint() below). Going through the canvas
        //via a Three.js custom layer was tried and rejected: even
        //when the cube was correctly rendered into the framebuffer,
        //MapLibre's compositing pipeline ended up overpainting it
        //in a way we couldn't reliably override. HTML overlays
        //sidestep the entire GL pipeline and let us style with CSS.
        this._initHillshade();
        this._initNightShade();
        this._initCloudCoverDisc();
        this._addBuildings();
        this._applyLabelVisibility();

        window.clearInterval(this._skyTimer);
        this._lastAtmosphereAlt = -999;
        this._refreshShadowsAndAtmosphere();
        //Sky/atmosphere refresh — every 60s. _refreshShadowsAndAtmosphere
        //internally short-circuits when the sun has not moved enough to
        //cause a visible change, so the cost on mobile is negligible.
        this._skyTimer = window.setInterval(() => this._refreshShadowsAndAtmosphere(), 60_000);

        if (this._homeHourlyData)
        {
            this._renderForCurrentSelection();
        }
    }

    private _initHillshade(): void
    {
        if (!this.map)
        {
            return;
        }
        if (this.map.getLayer('helios-hillshade'))
        {
            this.map.removeLayer('helios-hillshade');
        }

        const t   = this._selectedTime ?? new Date();
        const { azimuth } = getSunPosition(t, this.homeLat, this.homeLon);
        const col = toColor(this.cfg['topography-color'], 'rgba(80,100,160,1)');
        const exg = toAlpha(this.cfg['topography-alpha'], 0.65);

        this.map.addLayer(
        {
            id:     'helios-hillshade',
            type:   'hillshade',
            source: 'helios-terrain',
            paint:
            {
                'hillshade-shadow-color':           col,
                //v1.3 — non-transparent highlights make sun-facing
                //slopes pop, giving the streets style the depth it
                //was missing. Soft warm white at moderate opacity so
                //the hillshade reads as ambient lighting rather than
                //a paint-stroke effect.
                'hillshade-highlight-color':        'rgba(255,250,235,0.55)',
                'hillshade-accent-color':           col,
                'hillshade-illumination-direction': azimuth,
                'hillshade-illumination-anchor':    'map',
                'hillshade-exaggeration':           exg
            }
        });
    }

    //Night-shade overlay
    //
    //A full-world fill layer rendered above the satellite raster (and
    //above hillshade) but below buildings, dots, marker and labels.
    //
    //During daytime its opacity is 0 and it's visually inert. As the sun
    //drops below the horizon the layer fades in: increasing opacity and
    //shifting toward a deep navy / black colour. This gives the user a
    //clear visual cue that it is night, in a way that brightness/contrast
    //adjustments alone (which are clamped by MapLibre's raster paint
    //pipeline) cannot achieve. Sunrise and sunset get a warm tint mixed
    //in with low opacity so the satellite imagery stays readable while
    //subtly conveying the time of day.
    private _initNightShade(): void
    {
        if (!this.map)
        {
            return;
        }
        if (this.map.getLayer('helios-night-shade'))
        {
            this.map.removeLayer('helios-night-shade');
        }
        if (this.map.getSource('helios-night-shade'))
        {
            this.map.removeSource('helios-night-shade');
        }

        //Single polygon covering the whole web-mercator extent
        this.map.addSource('helios-night-shade',
        {
            type: 'geojson',
            data:
            {
                type: 'Feature',
                geometry:
                {
                    type: 'Polygon',
                    coordinates: [[
                        [-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]
                    ]]
                },
                properties: {}
            }
        });

        this.map.addLayer(
        {
            id:     'helios-night-shade',
            type:   'fill',
            source: 'helios-night-shade',
            paint:
            {
                'fill-color':   '#020410',
                'fill-opacity': 0
            }
        });
    }

    //Cloud-cover disc setup.
    //
    //Two layers backed by a single GeoJSON source `helios-cloud-rings`.
    //The source carries two features identified by `properties.kind`:
    //  - 'disc' : a polygon whose radius is proportional to the
    //             current cloud-cover percentage (0..100). Painted
    //             via the `helios-cloud-disc` fill layer in the
    //             configured cloud-color (fixed colour, opacity-
    //             modulated through CLOUD_DISC_OPACITY).
    //  - 'ring' : a fixed-radius polygon at CLOUD_DISC_RADIUS_M, only
    //             ever rendered as an outline by `helios-cloud-ring`.
    //
    //Both features are inserted at startup with placeholder geometry
    //and refreshed by _updateCloudCoverDisc() whenever the cloud-cover
    //value changes (live tick or scrub).
    //
    //Z-order: this layer pair is added before `helios-buildings`, so
    //buildings still emerge through the disc as opaque islands. The
    //home marker (added after buildings) stays on top of everything.
    private _initCloudCoverDisc(): void
    {
        if (!this.map)
        {
            return;
        }

        if (this.map.getLayer('helios-cloud-disc'))
        {
            this.map.removeLayer('helios-cloud-disc');
        }
        if (this.map.getLayer('helios-cloud-disc-ring'))
        {
            this.map.removeLayer('helios-cloud-disc-ring');
        }
        if (this.map.getLayer('helios-cloud-ring'))
        {
            this.map.removeLayer('helios-cloud-ring');
        }
        if (this.map.getSource('helios-cloud-rings'))
        {
            this.map.removeSource('helios-cloud-rings');
        }

        //Initial empty FeatureCollection — _updateCloudCoverDisc will
        //populate it on the next render cycle once we have a cloud
        //cover value.
        this.map.addSource('helios-cloud-rings',
        {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });

        //Disc layer: solid fill, colour driven by data-driven expression
        //reading `properties.color` (set by _updateCloudCoverDisc so the
        //colour resolution lives in TypeScript and the design-system
        //defaults stay in one place).
        this.map.addLayer(
        {
            id:     'helios-cloud-disc',
            type:   'fill',
            source: 'helios-cloud-rings',
            filter: ['==', ['get', 'kind'], 'disc'],
            paint:
            {
                'fill-color':   ['get', 'color'],
                'fill-opacity': CLOUD_DISC_OPACITY
            }
        });

        //Disc-ring layer: full-opacity outline of the dynamic disc in
        //the configured cloud colour. Same line width as the 100 %
        //reference ring, so the disc's edge reads as a crisp boundary
        //against the translucent fill underneath.
        this.map.addLayer(
        {
            id:     'helios-cloud-disc-ring',
            type:   'line',
            source: 'helios-cloud-rings',
            filter: ['==', ['get', 'kind'], 'disc'],
            paint:
            {
                'line-color':   ['get', 'color'],
                'line-width':   CLOUD_RING_WIDTH_PX,
                'line-opacity': 1.0
            }
        });

        //Ring layer: thin black outline of the 100 % reference. Pure
        //line layer with a fixed paint — nothing data-driven here.
        this.map.addLayer(
        {
            id:     'helios-cloud-ring',
            type:   'line',
            source: 'helios-cloud-rings',
            filter: ['==', ['get', 'kind'], 'ring'],
            paint:
            {
                'line-color':   CLOUD_RING_COLOR,
                'line-width':   CLOUD_RING_WIDTH_PX,
                'line-opacity': CLOUD_RING_OPACITY
            }
        });

        //Pointer events on the disc — emitted to the card so it can
        //position a floating breakdown tooltip (low/mid/high bands).
        //We listen on the disc layer only; the ring is too thin to
        //hover reliably and the disc is the meaningful target anyway.
        //Cloud-disc hover cursor: a tiny rendition of the same MDI
        //weather-cloudy glyph used in the on-map cloud-cover label,
        //so the visual language stays consistent end-to-end. We
        //hand the SVG to the browser as a data URL with an explicit
        //hotspot, falling back to the system pointer if the URL is
        //rejected (some older browsers cap the data-URL length or
        //reject SVG cursors entirely; the fallback keeps the disc
        //interactive in those edge cases).
        //
        //Encoded as a 32×32 viewBox with 4 px padding around a 24 px
        //glyph drawn at #1f2933 (dark slate, readable on both the
        //bright basemap and the cloud-color tinted disc). Hotspot is
        //centred at (16, 16) — the visual middle of the cloud — so
        //the click point is exactly under the cursor centre.
        const CLOUD_CURSOR_URL =
            "url(\"data:image/svg+xml;utf8," +
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' width='32' height='32'>" +
            "<g transform='translate(4 4)'>" +
            "<path fill='%231f2933' d='M6 19a5 5 0 0 1-5-5a5 5 0 0 1 5-5c1-2.35 3.3-4 6-4c3.43 0 6.24 2.66 6.5 6.03L19 11a4 4 0 0 1 4 4a4 4 0 0 1-4 4zm13-6h-2v-1a5 5 0 0 0-5-5c-2.5 0-4.55 1.82-4.94 4.19C6.73 11.07 6.37 11 6 11a3 3 0 0 0-3 3a3 3 0 0 0 3 3h13a2 2 0 0 0 2-2a2 2 0 0 0-2-2'/>" +
            "</g></svg>\") 16 16, help";

        //Note: getCanvas() exists on MapLibre's Map at runtime but
        //isn't in the local .d.ts surface we ship; cast to bypass the
        //type narrowing (this matches the existing pattern used
        //around the home marker hover handlers).
        const map = this.map;
        map.on('mousemove', 'helios-cloud-disc', (e) =>
        {
            (map as any).getCanvas().style.cursor = CLOUD_CURSOR_URL;
            this.onCloudHover?.({ x: e.point.x, y: e.point.y, hover: true });
        });
        map.on('mouseleave', 'helios-cloud-disc', () =>
        {
            (map as any).getCanvas().style.cursor = '';
            this.onCloudHover?.({ x: 0, y: 0, hover: false });
        });
    }

    //Update the disc + ring geometry to reflect the given cloud cover
    //percentage. Called from _renderForCurrentSelection so it ticks
    //both with live time progression and with manual scrubbing.
    //
    //  cloudPct ∈ [0, 100]    — coverage at the home location now
    //
    //The ring (100 % reference) has fixed radius CLOUD_DISC_RADIUS_M.
    //The disc scales linearly: radius = CLOUD_DISC_RADIUS_M * pct/100.
    //At 0 % cloud cover the disc has zero radius — effectively
    //invisible — while the ring stays visible to anchor the gauge.
    //
    //v1.2 — fixed cloud colour. The disc's *radius* already encodes
    //the cloud-cover percentage (0% = invisible, 100% = full ring);
    //we keep the colour solid so the user-configured cloud-color
    //reads everywhere identically. CLOUD_DISC_OPACITY (set on the
    //layer's fill-opacity) handles the translucency against the
    //basemap so the disc never fully hides what's underneath.
    private _updateCloudCoverDisc(cloudPct: number): void
    {
        const src = this.map?.getSource('helios-cloud-rings') as
                    maplibregl.GeoJSONSource | undefined;
        if (!src)
        {
            return;
        }

        const pct      = Math.max(0, Math.min(100, cloudPct));
        const discR    = CLOUD_DISC_RADIUS_M * pct / 100;
        const ringR    = CLOUD_DISC_RADIUS_M;

        const discPoly = buildCirclePolygon(this.homeLon, this.homeLat,
                                            discR, CLOUD_CIRCLE_SEGMENTS);
        const ringPoly = buildCirclePolygon(this.homeLon, this.homeLat,
                                            ringR, CLOUD_CIRCLE_SEGMENTS);

        const cloudRgb  = this._resolvedCloudRgb();
        const discColor = `rgb(${cloudRgb[0]},${cloudRgb[1]},${cloudRgb[2]})`;

        src.setData(
        {
            type: 'FeatureCollection',
            features:
            [
                {
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [discPoly] },
                    properties: { kind: 'disc', color: discColor }
                },
                {
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [ringPoly] },
                    properties: { kind: 'ring' }
                }
            ]
        });
    }

    //Renders 3D building extrusions as the visual context for the
    //home location. All buildings are painted in the configured
    //`building-color` (defaults to a neutral light grey) at a
    //single shared opacity — the home is identified by the chips
    //and leader lines on top, not by a special render of the
    //building itself. The earlier home-fill experiment (beta.9 /
    //beta.10) was removed because it was visually noisy and the
    //spatial identification of the home building from vector tiles
    //was unreliable in dense neighbourhoods.
    //Toggle MapTiler Streets' label layers (road names, house numbers,
    //POIs, place names) on or off based on the `show-labels` config.
    //Symbol-type layers are the canonical container for text + icon
    //rendering in MapLibre styles; flipping their `visibility` layout
    //property is enough to hide everything text-based without touching
    //the underlying geometry layers (roads, water, terrain). Our own
    //`helios-*` layers are skipped — they're not labels but we filter
    //defensively in case a future feature adds one.
    private _applyLabelVisibility(): void
    {
        if (!this.map)
        {
            return;
        }
        const showLabels = this.cfg['show-labels'] !== false;
        const visibility = showLabels ? 'visible' : 'none';
        const layers = this.map.getStyle().layers ?? [];
        for (const l of layers)
        {
            if (l.type !== 'symbol' || l.id.startsWith('helios-'))
            {
                continue;
            }
            try
            {
                this.map.setLayoutProperty(l.id, 'visibility', visibility);
            }
            catch (_) {}
        }
    }

    private _addBuildings(): void
    {
        if (!this.map)
        {
            return;
        }
        if (this.map.getLayer('helios-buildings'))
        {
            this.map.removeLayer('helios-buildings');
        }

        //Hide any fill-extrusion layer the active style ships natively.
        //The Streets style includes its own 3D buildings; without this
        //pass our custom helios-buildings layer would Z-fight against
        //them since both extrude the same source-layer at the same
        //heights.
        this.map.getStyle().layers?.forEach(l =>
        {
            if (l.type === 'fill-extrusion' && l.id !== 'helios-buildings')
            {
                try
                {
                    this.map!.setLayoutProperty(l.id, 'visibility', 'none');
                }
                catch (_) {}
            }
        });

        if (!this.map.getSource('helios-planet'))
        {
            this.map.addSource('helios-planet',
            {
                type: 'vector',
                url:  `https://api.maptiler.com/tiles/v3/tiles.json?key=${this.apiKey}`
            });
        }

        const buildingColor = String(this.cfg['building-color']
            ?? DEFAULT_BUILDING_COLOR_HEX);

        this.map.addLayer(
        {
            id:             'helios-buildings',
            source:         'helios-planet',
            'source-layer': 'building',
            type:           'fill-extrusion',
            minzoom:        15,
            paint:
            {
                'fill-extrusion-color':   buildingColor,
                'fill-extrusion-height':  ['get', 'render_height'],
                'fill-extrusion-base':    ['get', 'render_min_height'],
                //Opacity ramps in between zoom 15 and 16; top
                //opacity sits at 0.75 — buildings are present
                //enough to read as solid massing without burying
                //the basemap or competing with the chips and
                //leaders that carry the actual data.
                'fill-extrusion-opacity': [
                    'interpolate', ['linear'], ['zoom'],
                    15, 0,
                    16, 0.75
                ]
            }
        });
    }

    //Public — push a new building colour to the running buildings
    //layer (called by the card when the user edits `building-color`
    //in the visual editor). Skips silently when the layer hasn't
    //been added yet — the next basemap reload will pick the new
    //colour up from `this.cfg`.
    public setBuildingColor(hex: string): void
    {
        if (!this.map || !this.map.getLayer('helios-buildings'))
        {
            return;
        }
        try
        {
            this.map.setPaintProperty('helios-buildings', 'fill-extrusion-color', hex);
        }
        catch (_) {}
    }

    //Linear interpolation between two RGB hex strings.
    private _lerpHex(a: string, b: string, t: number): string
    {
        const pa = parseInt(a.replace('#', ''), 16);
        const pb = parseInt(b.replace('#', ''), 16);
        const ar = (pa >> 16) & 0xff, ag = (pa >> 8) & 0xff, ab = pa & 0xff;
        const br = (pb >> 16) & 0xff, bg = (pb >> 8) & 0xff, bb = pb & 0xff;
        const r = Math.round(ar + (br - ar) * t);
        const g = Math.round(ag + (bg - ag) * t);
        const b2 = Math.round(ab + (bb - ab) * t);
        return '#' + r.toString(16).padStart(2, '0')
                   + g.toString(16).padStart(2, '0')
                   + b2.toString(16).padStart(2, '0');
    }

    //Blend two hex colors by amount t (0..1). t=0 returns `a`, t=1 returns
    //`b`. Same math as _lerpHex but kept under a clearer name when used
    //semantically as a wash/tint rather than a phase transition.
    private _mixHex(a: string, b: string, t: number): string
    {
        return this._lerpHex(a, b, t);
    }

    //Linear interpolation between two scalars
    private _lerp(a: number, b: number, t: number): number
    {
        return a + (b - a) * t;
    }

    //Repaint hillshade direction, satellite raster, night-shade overlay,
    //fog and building tints to match the current sun altitude. Phases
    //blend continuously rather than at hard thresholds so dawn/dusk,
    //golden hour, mid-day and night feel like a smooth progression.
    //
    //Altitude bands (degrees above horizon):
    //  alt < -6   : deep night          (cold blue/black, low contrast)
    //  -6 ..  0   : civil twilight      (indigo → pink tinge)
    //   0 ..  6   : sunrise/sunset      (saturated warm satellite)
    //   6 .. 20   : low sun             (warm shift, long shadows)
    //  20 .. 50   : full daylight       (neutral white balance)
    //  alt >= 50  : near zenith         (bright, slight wash)
    //
    //Short-circuits when the sun has moved less than 0.5° since the
    //last call (≈ 2 min of motion). setPaintProperty isn't free on
    //mobile — repeating the full pass once a minute would burn frames
    //for no perceptible visual change.
    private _refreshShadowsAndAtmosphere(): void
    {
        if (!this.map)
        {
            return;
        }

        const t   = this._selectedTime ?? new Date();
        const sun = getSunPosition(t, this.homeLat, this.homeLon);
        const { altitude, azimuth } = sun;

        if (Math.abs(altitude - this._lastAtmosphereAlt) < 0.5)
        {
            return;
        }
        this._lastAtmosphereAlt = altitude;

        //Sun "warmth" — drives orange tinting that peaks at sunrise/
        //sunset and fades by mid-day. Cosine bell centred on altitude=3°.
        const warmth = altitude < 0
            ? 0
            : Math.max(0, Math.cos((altitude - 3) / 18 * Math.PI / 2));

        //Dynamic shadow colour: black at deep night → indigo at
        //twilight → warm brown at sunrise → cool blue/grey at full day.
        let shadowCol: string;
        if (altitude < -6)
        {
            shadowCol = '#0a0e1a';
        }
        else if (altitude < 0)
        {
            const u = (altitude + 6) / 6;
            shadowCol = this._lerpHex('#0a0e1a', '#2a2540', u);
        }
        else if (altitude < 6)
        {
            const u = altitude / 6;
            shadowCol = this._lerpHex('#2a2540', '#4a2a1f', u);
        }
        else if (altitude < 20)
        {
            const u = (altitude - 6) / 14;
            shadowCol = this._lerpHex('#4a2a1f', '#3a4870', u);
        }
        else
        {
            const u = Math.min(1, (altitude - 20) / 30);
            shadowCol = this._lerpHex('#3a4870', '#5064a0', u);
        }

        //Hillshade — direction from sun azimuth; exaggeration scales with
        //a "drama" factor that peaks at low sun (long shadows at dusk/dawn).
        if (this.map.getLayer('helios-hillshade'))
        {
            try
            {
                this.map.setPaintProperty('helios-hillshade', 'hillshade-illumination-direction', azimuth);
                const userExg = toAlpha(this.cfg['topography-alpha'], 0.65);
                let dramaScale: number;
                if (altitude < 0)
                {
                    dramaScale = 0.35;
                }
                else if (altitude < 12)
                {
                    //Peak shadow drama at altitude ≈ 6° (golden hour)
                    dramaScale = 1.0 + 0.6 * Math.sin((altitude / 12) * Math.PI);
                }
                else
                {
                    dramaScale = this._lerp(1.2, 0.85, Math.min(1, (altitude - 12) / 40));
                }
                //hillshade-exaggeration is clamped to [0, 1] by MapLibre's
                //paint-property validator. With userExg=0.65 the dramaScale
                //peak of ~1.6 (around altitude 6°) lands at 1.04 — over the
                //ceiling. Clamp here so we get the maximum allowed effect
                //rather than a paint-validation warning every frame.
                const finalExg = Math.min(1, userExg * dramaScale);
                this.map.setPaintProperty('helios-hillshade', 'hillshade-exaggeration', finalExg);
                this.map.setPaintProperty('helios-hillshade', 'hillshade-shadow-color', shadowCol);
            }
            catch (_) {}
        }

        //Satellite raster — manipulates brightness/contrast/saturation to
        //communicate the time of day. Night dims and desaturates strongly;
        //sunrise warms; daytime keeps colours neutral and saturated.
        //Note: raster paint properties have a hard floor in MapLibre so
        //they alone cannot make the map look properly "dark" at night;
        //the helios-night-shade overlay below does the heavy lifting for
        //night/dawn/dusk.
        if (this.map.getLayer('sat-hires-layer'))
        {
            try
            {
                let bMin: number, bMax: number, contrast: number, sat: number;

                if (altitude < -6)
                {
                    //Deep night: heavy desaturation, low brightness ceiling
                    bMin = 0;
                    bMax = 0.30;
                    contrast = -0.45;
                    sat = -0.80;
                }
                else if (altitude < 0)
                {
                    const u = (altitude + 6) / 6;
                    bMin = 0;
                    bMax = this._lerp(0.30, 0.75, u);
                    contrast = this._lerp(-0.45, -0.05, u);
                    sat = this._lerp(-0.80, -0.20, u);
                }
                else if (altitude < 6)
                {
                    //Sunrise/sunset window. We deliberately keep both
                    //contrast and saturation modest here — combined with
                    //the warm fog overlay, anything > 0.30 makes the
                    //satellite look posterised / blown out, especially
                    //over white/sandy textures.
                    const u = altitude / 6;
                    bMin = 0;
                    bMax = this._lerp(0.75, 0.95, u);
                    contrast = this._lerp(-0.05, 0.20, u);
                    sat = this._lerp(-0.20, 0.20, u);
                }
                else if (altitude < 20)
                {
                    //Low sun. Peak boost — but capped to keep things
                    //photographic rather than HDR-tone-mapped.
                    const u = (altitude - 6) / 14;
                    bMin = this._lerp(0, 0.04, u);
                    bMax = 0.95;
                    contrast = this._lerp(0.20, 0.18, u);
                    sat = this._lerp(0.20, 0.15, u);
                }
                else
                {
                    //Full daylight. Near-neutral so the imagery reads
                    //naturally without the over-processed look.
                    const u = Math.min(1, (altitude - 20) / 40);
                    bMin = 0.03;
                    bMax = 0.95;
                    contrast = this._lerp(0.18, 0.10, u);
                    sat = this._lerp(0.15, 0.08, u);
                }

                this.map.setPaintProperty('sat-hires-layer', 'raster-brightness-min', bMin);
                this.map.setPaintProperty('sat-hires-layer', 'raster-brightness-max', bMax);
                this.map.setPaintProperty('sat-hires-layer', 'raster-contrast',       contrast);
                this.map.setPaintProperty('sat-hires-layer', 'raster-saturation',     sat);
                this.map.setPaintProperty('sat-hires-layer', 'raster-hue-rotate',     warmth * -8);
            }
            catch (_) {}
        }

        //Night-shade overlay — the primary day/night cue.
        //Opacity ramps from 0 (day) up to ~0.65 at deep night, with a tinted
        //warm pass through the sunrise/sunset window so the satellite stays
        //readable but visibly amber-shifted near the horizon.
        if (this.map.getLayer('helios-night-shade'))
        {
            try
            {
                let nsColor: string;
                let nsOpacity: number;

                if (altitude < -12)
                {
                    //Astronomical night
                    nsColor   = '#02040c';
                    nsOpacity = 0.68;
                }
                else if (altitude < -6)
                {
                    //Nautical twilight → astronomical
                    const u = (-altitude - 6) / 6;
                    nsColor   = '#040824';
                    nsOpacity = this._lerp(0.50, 0.68, u);
                }
                else if (altitude < 0)
                {
                    //Civil twilight — deep blue
                    const u = (altitude + 6) / 6;
                    nsColor   = '#0a1240';
                    nsOpacity = this._lerp(0.50, 0.30, u);
                }
                else if (altitude < 6)
                {
                    //Sunrise/sunset — warm amber wash, light opacity so the
                    //satellite imagery still reads but the time-of-day cue
                    //is unambiguous.
                    const u = altitude / 6;
                    nsColor   = '#3a1408';
                    nsOpacity = this._lerp(0.30, 0.10, u);
                }
                else if (altitude < 20)
                {
                    //Low sun — fading wash
                    const u = (altitude - 6) / 14;
                    nsColor   = '#3a1408';
                    nsOpacity = this._lerp(0.10, 0.0, u);
                }
                else
                {
                    //Full daylight — overlay invisible
                    nsColor   = '#000000';
                    nsOpacity = 0;
                }

                this.map.setPaintProperty('helios-night-shade', 'fill-color',   nsColor);
                this.map.setPaintProperty('helios-night-shade', 'fill-opacity', nsOpacity);
            }
            catch (_) {}
        }

        //Buildings — modulate their colour by sun altitude so they
        //participate in the time-of-day mood. We blend a fixed daylight
        //reference (light grey) towards a cool dark ink at night and
        //towards a warm tint around sunrise/sunset. With the v1.2
        //unified palette there is no longer a user-configurable colour
        //to honour, so the daylight base is hard-coded to the same
        //rgba(210,210,215,1) used by _addBuildings().
        if (this.map.getLayer('helios-buildings'))
        {
            try
            {
                const baseHex = '#d2d2d7';

                let buildingHex: string;
                if (altitude < -6)
                {
                    //Deep night — buildings as dark indigo silhouettes
                    buildingHex = this._mixHex(baseHex, '#0a0e1a', 0.85);
                }
                else if (altitude < 0)
                {
                    //Civil twilight — fade in/out of night
                    const u = (altitude + 6) / 6;
                    const dark = this._mixHex(baseHex, '#0a0e1a', 0.85);
                    const dusk = this._mixHex(baseHex, '#2a2540', 0.55);
                    buildingHex = this._lerpHex(dark, dusk, u);
                }
                else if (altitude < 6)
                {
                    //Sunrise/sunset — warm wash
                    const u = altitude / 6;
                    const dusk = this._mixHex(baseHex, '#2a2540', 0.55);
                    const warm = this._mixHex(baseHex, '#5a3220', 0.35);
                    buildingHex = this._lerpHex(dusk, warm, u);
                }
                else if (altitude < 20)
                {
                    //Low sun — fade warm tint back to base
                    const u = (altitude - 6) / 14;
                    const warm = this._mixHex(baseHex, '#5a3220', 0.35);
                    buildingHex = this._lerpHex(warm, baseHex, u);
                }
                else
                {
                    //Full daylight — exact user-defined colour
                    buildingHex = baseHex;
                }

                this.map.setPaintProperty('helios-buildings', 'fill-extrusion-color', buildingHex);
            }
            catch (_) {}
        }
    }

    //v1.4 — the 'standard' precision tier was retired: a single
    //best-match model produced visibly noisier readings (low-cloud
    //layer stuck at 100 % from altitude bugs, mostly), and the
    //multi-model median fix sat one click away in the editor for
    //users who often missed it. We now always run in the multi-
    //model 'high' mode. The function is kept so the rest of the
    //engine can stay precision-aware in case a future tier is
    //added.
    private _resolvedPrecision(): 'standard' | 'high'
    {
        return 'high';
    }

    private async _refreshWeather(lat?: number, lon?: number): Promise<void>
    {
        const fLat = lat ?? this.homeLat;
        const fLon = lon ?? this.homeLon;

        this._fetchAbortController?.abort();
        this._fetchAbortController = new AbortController();
        const signal = this._fetchAbortController.signal;

        this._clearWeatherTimer();

        this.onFetchStart?.();

        try
        {
            //Single home-point fetch with elevation. The 49-point grid
            //fetch was removed in v1.2 along with the radial cloud
            //nappe — the home point is now the only source of truth.
            const precision = this._resolvedPrecision();
            this._homeHourlyData = await fetchHomePointData(
                fLat, fLon, this.homeElevation, precision, signal
            );
            this._renderForCurrentSelection();

            //Successful fetch: reset the rate-limit back-off so the
            //next 429 (if any) starts again at the shortest delay.
            this._rateLimitStreak = 0;

            if (this._selectedTime === null)
            {
                //v1.4 — refresh every 10 min (was 1 h). Open-Meteo
                //updates its forecast every 15 min on the server,
                //so 10 min on the client gives us near-fresh data
                //without ever lagging more than a model cycle. Well
                //within free-tier quotas.
                this._weatherTimer = window.setInterval(
                    () => this._refreshWeather(this._fetchLat, this._fetchLon),
                    600_000
                );
            }
        }
        catch (e: any)
        {
            if (e.name === 'AbortError')
            {
                return;
            }

            let retryDelay: number;
            if (e.status === 429)
            {
                //Pick the back-off slot for the current streak, capped
                //at the last entry. setTimeout (not setInterval): we
                //only want one retry, then either we succeed and reset
                //the streak, or we fail again and bump the streak.
                const idx = Math.min(this._rateLimitStreak, RATE_LIMIT_BACKOFF_MS.length - 1);
                retryDelay = RATE_LIMIT_BACKOFF_MS[idx];
                this._rateLimitStreak++;

                this._weatherTimer = window.setTimeout(
                    () => this._refreshWeather(this._fetchLat, this._fetchLon),
                    retryDelay
                );
            }
            else
            {
                //Non-rate-limit error (network blip, 500, ...): try
                //again in 1 minute, repeatedly. These usually clear up
                //fast and don't merit the same back-off treatment.
                retryDelay = 60_000;
                this._weatherTimer = window.setInterval(
                    () => this._refreshWeather(this._fetchLat, this._fetchLon),
                    retryDelay
                );
            }
        }
        finally
        {
            this.onFetchEnd?.();
        }
    }

    //"Reset view" — re-anchor the camera on the home and restore the
    //default pitch/bearing. With v1.2's fully locked camera the user
    //can't drift it away through interaction, so this is now an
    //animation-only entry point: it serves as the resting target for
    //future scripted camera motions (intro orbit, narrative tilt,
    //sun-vs-shadow comparison flyovers...) and as a one-tap reset if
    //any of those animations leaves the camera in an unexpected pose.
    public recenter(): void
    {
        if (!this.map)
        {
            return;
        }
        this.map.stop();
        const c    = this.map.getCenter();
        const dist = geoDistM(c.lat, c.lng, this.homeLat, this.homeLon);
        const dur  = Math.min(1200, Math.max(300, dist / 5));

        this.map.easeTo(
        {
            center:   [this.homeLon, this.homeLat],
            zoom:     18,
            pitch:    55,
            //Same hemisphere-aware bearing as the initial setup
            //above — recentering must restore the resting pose,
            //not flip the orientation.
            bearing:  this.homeLat >= 0 ? 180 : 0,
            duration: dur
        });
    }

    //Compute the screen-space layout of the on-map readout chips and
    //the leader lines that tie them to the home / on-ground ring.
    //
    //  cloudLabel — where the cloud-cover chip should be drawn (in
    //               CSS pixels, relative to the map canvas). Sits to
    //               the screen-LEFT of the cloud disc, just outside
    //               the 100 % reference ring. Pinning it on the side
    //               (rather than above) keeps the home's vertical
    //               axis clear for the PV chip (above) and the
    //               battery chip (below).
    //  pvLabel    — where the optional PV production chip should be
    //               drawn. Sits a fixed CLOUD_LABEL_OFFSET_PX above
    //               the home so the production chip is the prominent
    //               readout, with the cloud chip retreating onto its
    //               own feature on the side.
    //  batterySocLabel  — where the optional battery State-of-
    //               Charge chip is drawn (icon + percent). Sits to
    //               the screen-LEFT of the PV chip on the same
    //               horizontal axis, mirroring the Power chip on
    //               the right. Connected to the PV chip with a
    //               static dotted hairline (no animation, no
    //               arrow) — see the card render block.
    //  batteryPowerLabel — where the optional battery Power chip
    //               is drawn (icon + signed instantaneous W/kW).
    //               Sits to the screen-RIGHT of the PV chip,
    //               mirror image of the SoC chip. Same static
    //               dotted leader to PV.
    //  ringEdge   — projection of a fixed geographic point on the
    //               100 % reference ring (the disc's geographic east
    //               edge in the northern hemisphere, west edge in
    //               the south — picked so the chip lands on screen-
    //               LEFT under each hemisphere's default bearing of
    //               180° NH / 0° SH). The cloud leader line ends
    //               here. Pinning to a fixed geographic point — and
    //               not "screen-leftmost-of-N-samples" as a previous
    //               revision did — means the chip tracks the same
    //               world location continuously when the camera
    //               rotates, instead of teleporting in 30° increments
    //               between discrete samples. This matches the
    //               steady, pivot-anchored behaviour of the PV /
    //               battery chips and keeps the overlay legible
    //               throughout rotation animations.
    //  home       — the projected home point, used as the anchor for
    //               the PV and battery chip leader lines.
    //
    //Returns null when the map isn't ready yet — the card treats
    //null as "don't render the overlay this frame".
    public projectHomeLabelLayout(): {
        cloudLabel:        { x: number; y: number };
        pvLabel:           { x: number; y: number };
        batterySocLabel:   { x: number; y: number };
        batteryPowerLabel: { x: number; y: number };
        ringEdge:          { x: number; y: number };
        home:              { x: number; y: number };
    } | null
    {
        if (!this.map)
        {
            return null;
        }

        //project() exists on MapLibre's Map at runtime but is not on
        //the local .d.ts surface we ship; cast to bypass the type
        //narrowing (matches the existing pattern used for getCanvas).
        const m = this.map as any;
        const home = m.project([this.homeLon, this.homeLat]);

        //Hemisphere-aware fixed geographic anchor on the disc edge:
        //  NH (default bearing 180° → south-up) → east of home
        //  SH (default bearing   0° → north-up) → west of home
        //Both pick the side that projects to the LEFT of screen at
        //the hemisphere's default bearing, so the chip starts at the
        //expected spot. Once anchored to a single lon/lat the chip
        //orbits the home smoothly under rotation rather than jumping
        //between sampled "leftmost" estimates.
        const lat0   = this.homeLat;
        const cosLat = Math.cos(lat0 * Math.PI / 180);
        const anchorDE = lat0 >= 0 ? CLOUD_DISC_RADIUS_M : -CLOUD_DISC_RADIUS_M;
        const anchorDLng = anchorDE / (111_320 * cosLat);
        const anchor = m.project([this.homeLon + anchorDLng, this.homeLat]);
        const ringEdgeX = anchor.x;
        const ringEdgeY = anchor.y;

        //Push the chip outwards along the home→anchor direction so
        //it always sits OUTSIDE the projected disc, leaving a short
        //leader-line gap. Using the radial vector (rather than a
        //fixed -X offset) keeps the chip outside even when rotation
        //moves the projected anchor to a non-leftward screen side.
        const CLOUD_CHIP_NUDGE_PX = 30;
        const radDX = ringEdgeX - home.x;
        const radDY = ringEdgeY - home.y;
        const radLen = Math.sqrt(radDX * radDX + radDY * radDY) || 1;
        const cloudLabelX = ringEdgeX + (radDX / radLen) * CLOUD_CHIP_NUDGE_PX;
        const cloudLabelY = ringEdgeY + (radDY / radLen) * CLOUD_CHIP_NUDGE_PX;

        //Battery chips flank the PV chip horizontally — SoC on the
        //LEFT, signed Power on the RIGHT, on the same vertical
        //axis as PV. The horizontal gap is sized to leave room for
        //a short dotted hairline (~50 px) that visually ties each
        //battery chip back to the PV chip without crowding it.
        const BATTERY_CHIP_GAP_PX = 80;
        const pvX = home.x;
        const pvY = home.y - CLOUD_LABEL_OFFSET_PX;

        return {
            cloudLabel:        { x: cloudLabelX,             y: cloudLabelY },
            pvLabel:           { x: pvX,                     y: pvY        },
            batterySocLabel:   { x: pvX - BATTERY_CHIP_GAP_PX, y: pvY      },
            batteryPowerLabel: { x: pvX + BATTERY_CHIP_GAP_PX, y: pvY      },
            ringEdge:          { x: ringEdgeX,               y: ringEdgeY },
            home:              { x: home.x,                  y: home.y    }
        };
    }

    //Project a 3D point (longitude, latitude, altitude_m) into
    //screen-space pixels using MapLibre's current camera matrices.
    //
    //Procedure (per the MapLibre v5 official 3D-model example):
    //  1. modelMatrix = transform.getMatrixForModel(LngLat, alt) —
    //     translates / rotates a model from its local frame into
    //     Mercator world coordinates at the requested location and
    //     altitude.
    //  2. projMatrix = transform.getProjectionDataForCustomLayer()
    //     .mainMatrix — Mercator world to gl clip space.
    //  3. Multiply both matrices to get the full MVP.
    //  4. Apply MVP to (0, 0, 0, 1) — the local-frame origin, which
    //     becomes our 3D point after step 1.
    //  5. Perspective-divide by w to get clip-space coordinates in
    //     [-1, +1].
    //  6. Map to canvas pixels.
    //
    //Returns null when the map isn't ready or when the point is
    //behind the camera (clip-space w <= 0). Callers treat null as
    //"don't render this point this frame".
    //
    //Returns x/y in CSS pixels relative to the map canvas, plus depth
    //(the post-projection w component, which is monotonic in distance
    //from the camera). Callers can use depth to scale visual elements
    //based on how far they are from the viewer — bigger when close,
    //smaller when far — to give the otherwise flat top-down-ish view
    //a sense of perspective beyond what pitch alone provides.
    private _projectScenePoint(
        lon: number, lat: number, altitudeM: number
    ): { x: number; y: number; depth: number } | null
    {
        if (!this.map)
        {
            return null;
        }

        const t: any = (this.map as any).transform;
        if (typeof t?.getMatrixForModel !== 'function' ||
            typeof t?.getProjectionDataForCustomLayer !== 'function')
        {
            return null;
        }

        //getMatrixForModel positions the model in MERCATOR world
        //space, and the model's local origin sits at "altitudeM
        //metres above sea level". With terrain enabled, the camera
        //and the rendered ground both follow the DEM, so an object
        //we want to appear "altitudeM above the local ground"
        //needs the ground elevation added before being passed in.
        //
        //queryTerrainElevation returns metres above sea level,
        //already multiplied by the configured exaggeration; passing
        //the sum through getMatrixForModel keeps the model glued to
        //the visual ground. When terrain isn't ready yet (or isn't
        //enabled), the call returns null and we fall back to 0,
        //which is correct for a flat-mercator pipeline.
        const m: any = this.map as any;
        const terrainM = (typeof m.queryTerrainElevation === 'function')
            ? (m.queryTerrainElevation([lon, lat]) ?? 0)
            : 0;
        const totalAlt = altitudeM + terrainM;

        const modelM: number[] = t.getMatrixForModel([lon, lat], totalAlt);
        const projM:  number[] = t.getProjectionDataForCustomLayer().mainMatrix;

        //Combine the two 4×4 matrices into mvp = projM · modelM.
        //Both are stored column-major in MapLibre, so mvp[col*4+row]
        //is the element at (row, col).
        const mvp = new Array<number>(16);
        for (let col = 0; col < 4; col++)
        {
            for (let row = 0; row < 4; row++)
            {
                let sum = 0;
                for (let k = 0; k < 4; k++)
                {
                    sum += projM[k * 4 + row] * modelM[col * 4 + k];
                }
                mvp[col * 4 + row] = sum;
            }
        }

        //Apply mvp to the origin (0, 0, 0, 1) — i.e. extract the
        //last column, which IS the projection of the origin.
        const cx = mvp[12];
        const cy = mvp[13];
        const cz = mvp[14];
        const cw = mvp[15];

        if (cw <= 0 || !isFinite(cw))
        {
            //Behind the camera or numerically degenerate.
            return null;
        }

        //Perspective divide → clip space in [-1, +1].
        const ndcX = cx / cw;
        const ndcY = cy / cw;
        //ndcZ in [-1, +1] would tell us if the point is in front of
        //(>0) or behind (<0) the near plane; we don't need it for
        //pure screen-space layout but it's available if a caller
        //wants to skip points outside the frustum.
        void cz;

        const canvas: HTMLCanvasElement = (this.map as any).getCanvas();
        //Convert canvas pixel size (which is devicePixelRatio'd) to
        //CSS pixels — the units the card overlay uses to position
        //its DOM elements. canvas.clientWidth is the CSS size.
        const W = canvas.clientWidth  || canvas.width;
        const H = canvas.clientHeight || canvas.height;

        //Map ndc (-1..+1) to (0..W) and (0..H) with Y flipped because
        //ndc Y points up while screen Y points down.
        return {
            x:     (ndcX + 1) * 0.5 * W,
            y:     (1 - ndcY) * 0.5 * H,
            depth: cw
        };
    }

    //Build the screen-space layout of the solar arc, the sun's
    //current position on the arc, and the incidence ray.
    //
    //Returns null until the map is ready. The card uses null as
    //"don't render the overlay this frame".
    //
    //Each arc point also carries the irradiance (W/m²) at that
    //instant, computed with the current cloud cover applied
    //uniformly across the day — that's a simplification (real cloud
    //cover varies hour-to-hour) but keeps the visualisation reactive
    //to the live weather without needing the per-hour forecast for
    //the arc itself. The sun position carries the same.
    //
    //Each arc point and the sun also carry a `nearness` value in
    //[0..1] — 1 means closest to the camera (nearest depth in the
    //batch), 0 means furthest. The card uses this to scale segment
    //thickness and the sun disc radius so the trajectory reads with
    //a real sense of perspective rather than as a flat ribbon.
    public projectSunScene(now: Date): {
        arc:      Array<{
            x: number; y: number;
            irradiance: number; nearness: number; belowHorizon: boolean;
        }>;
        sun:      { x: number; y: number; irradiance: number; altitude: number; nearness: number };
        home:     { x: number; y: number };
        daylight: number;
    } | null
    {
        if (!this.map)
        {
            return null;
        }

        //Ground-level home projection — the SVG anchor for the
        //incidence ray and a reference for any future ground shadow.
        const homeScreen = this._projectScenePoint(this.homeLon, this.homeLat, 0);
        if (!homeScreen)
        {
            return null;
        }

        //Sample the day at evenly-spaced 15-min intervals starting
        //at local midnight. Building the day boundaries in local
        //civil time (rather than UTC) gives a sample at the user's
        //actual midnight, which is when the arc has its visual
        //"start" / "end" point regardless of timezone.
        const dayStart = new Date(now);
        dayStart.setHours(0, 0, 0, 0);
        const dayMs = 24 * 60 * 60 * 1000;
        const stepMs = dayMs / SUN_ARC_SAMPLES;

        //Use the live cloud cover for irradiance colouring along
        //the whole arc. If we have no live reading yet, treat as
        //clear (0%) — the arc still gets coloured at its proper
        //clear-sky intensity so the user sees something meaningful
        //before the first weather fetch lands.
        const liveCloud = this._homeHourlyData
            ? (() => {
                const w = this._getWeatherAtTime(now);
                return w?.cloudCover ?? 0;
            })()
            : 0;

        //First pass: project every arc sample, recording depth.
        //We need the full set of depths before we can normalise
        //them into nearness factors, so we collect everything first
        //and assign nearness in a second pass below.
        type RawArcPoint = {
            x: number; y: number; irradiance: number; depth: number;
            belowHorizon: boolean;
        };
        const raw: RawArcPoint[] = [];
        for (let i = 0; i < SUN_ARC_SAMPLES; i++)
        {
            const t = new Date(dayStart.getTime() + i * stepMs);
            const sun3D = this._sunSpherePoint(t);
            if (!sun3D)
            {
                continue;
            }
            const px = this._projectScenePoint(sun3D.lon, sun3D.lat, sun3D.altitudeM);
            if (!px)
            {
                continue;
            }
            const wm2 = computeIrradianceWm2(t, this.homeLat, this.homeLon, liveCloud);
            //altitudeM in _sunSpherePoint is R·sin(α) — same sign as α,
            //so a negative altitudeM means the sun is below the horizon
            //at this sample. We surface that as a flag rather than the
            //raw value because the card only needs to switch render
            //modes (solid vs dotted), not the exact angle.
            raw.push({
                x: px.x, y: px.y,
                irradiance:    wm2,
                depth:         px.depth,
                belowHorizon:  sun3D.altitudeM < 0
            });
        }

        //Sun at "now" — same spherical projection as the arc points.
        const sunNow3D = this._sunSpherePoint(now);
        const sunNowAlt = getSunPosition(now, this.homeLat, this.homeLon).altitude;
        const sunNowWm2 = computeIrradianceWm2(now, this.homeLat, this.homeLon, liveCloud);

        let sunScreen: { x: number; y: number; depth: number } | null = null;
        if (sunNow3D)
        {
            sunScreen = this._projectScenePoint(sunNow3D.lon, sunNow3D.lat, sunNow3D.altitudeM);
        }
        if (!sunScreen)
        {
            //Even at night we want a defined sun position so the
            //incidence ray has somewhere to anchor (offscreen below
            //the home is fine — the ray just won't be drawn). Fall
            //back to the home location so downstream maths stays
            //finite. Depth is borrowed from home so the sun's
            //nearness factor degrades gracefully (it's not visible
            //in this case anyway).
            sunScreen = { ...homeScreen, depth: homeScreen.depth };
        }

        //Establish the depth range across the full arc + the sun,
        //so every visible element shares one consistent perspective
        //scale. nearness = 1 at the smallest depth (nearest), 0 at
        //the largest (furthest). The arc spans 24 h so the depth
        //range usually covers everything from the sun behind the
        //camera at noon to the sun on the far horizon at dusk.
        let dMin = Infinity;
        let dMax = -Infinity;
        for (const p of raw)
        {
            if (p.depth < dMin) { dMin = p.depth; }
            if (p.depth > dMax) { dMax = p.depth; }
        }
        if (sunScreen.depth < dMin) { dMin = sunScreen.depth; }
        if (sunScreen.depth > dMax) { dMax = sunScreen.depth; }
        const dRange = (dMax - dMin) || 1;
        const nearnessOf = (d: number) => 1 - (d - dMin) / dRange;

        const arc = raw.map(p => ({
            x:            p.x,
            y:            p.y,
            irradiance:   p.irradiance,
            nearness:     nearnessOf(p.depth),
            belowHorizon: p.belowHorizon
        }));

        //daylight factor — a smooth 0..1 ramp keyed on solar
        //altitude. Below -6° (astronomical horizon) it bottoms out
        //at SUN_ARC_NIGHT_OPACITY; above +6° it's full intensity;
        //the band in between blends smoothly so dawn/dusk doesn't
        //pop visually.
        const daylight = (() =>
        {
            if (sunNowAlt >= 6) { return 1; }
            if (sunNowAlt <= -6) { return SUN_ARC_NIGHT_OPACITY; }
            const t01 = (sunNowAlt + 6) / 12;
            return SUN_ARC_NIGHT_OPACITY + (1 - SUN_ARC_NIGHT_OPACITY) * t01;
        })();

        return {
            arc,
            sun:      {
                x: sunScreen.x, y: sunScreen.y,
                irradiance: sunNowWm2,
                altitude:   sunNowAlt,
                nearness:   nearnessOf(sunScreen.depth)
            },
            home:     { x: homeScreen.x, y: homeScreen.y },
            daylight
        };
    }

    //Convert (date) → 3D point on the imaginary celestial hemisphere
    //of radius SUN_ARC_RADIUS_M centred on the home, in (lon, lat,
    //altitude_m) form ready for _projectScenePoint.
    //
    //Convention: azimuth measured clockwise from North, altitude
    //above the horizon. ENU offsets relative to the home are then
    //  east  = R · cos(α) · sin(φ)
    //  north = R · cos(α) · cos(φ)
    //  up    = R · sin(α)
    //and the (east, north) offset is converted into a (lon, lat)
    //offset using local metres-per-degree (good enough for the few-
    //hundred-metre extents we care about).
    private _sunSpherePoint(date: Date): {
        lon: number; lat: number; altitudeM: number
    } | null
    {
        const sun = getSunPosition(date, this.homeLat, this.homeLon);
        const D   = Math.PI / 180;
        const a   = sun.altitude * D;
        const z   = sun.azimuth  * D;

        const east  = SUN_ARC_RADIUS_M * Math.cos(a) * Math.sin(z);
        const north = SUN_ARC_RADIUS_M * Math.cos(a) * Math.cos(z);
        const up    = SUN_ARC_RADIUS_M * Math.sin(a);

        //Local metres-per-degree.
        const mPerDegLat = 111_320;
        const mPerDegLon = 111_320 * Math.cos(this.homeLat * D);

        return {
            lon:        this.homeLon + east  / mPerDegLon,
            lat:        this.homeLat + north / mPerDegLat,
            altitudeM:  up
        };
    }

    public setSelectedTime(time: Date | null): void
    {
        this._selectedTime = time;

        if (time === null)
        {
            this._clearWeatherTimer();
            //Same 10-min cadence as the post-fetch interval above —
            //returning to live mode resumes the standard refresh
            //rhythm rather than re-anchoring on the original
            //hourly pace.
            this._weatherTimer = window.setInterval(
                () => this._refreshWeather(this._fetchLat, this._fetchLon),
                600_000
            );
        }
        else
        {
            this._clearWeatherTimer();
        }

        if (this._mapReady && this._homeHourlyData)
        {
            //Force atmosphere refresh: the user just scrubbed time, so the
            //"have we moved enough" guard would otherwise short-circuit.
            this._lastAtmosphereAlt = -999;
            this._renderForCurrentSelection();
            this._refreshShadowsAndAtmosphere();
        }
    }

    //Expose the hourly series the card needs to draw the chart.
    //
    //Returns one entry per hour over the full forecast window:
    //  - time:       the timestamp
    //  - irradiance: W/m², from the model's shortwave_radiation_instant
    //                when available (>= 0), otherwise the Haurwitz +
    //                Kasten-Czeplak fallback so the curve stays
    //                continuous past the model horizon
    //  - cloud:      effective cloud cover in %, the same layer-
    //                weighted figure used everywhere else
    //
    //Returns null until the first weather fetch completes, mirroring
    //the contract of projectSunScene / projectHomeLabelLayout. The
    //card is expected to call this whenever onWeatherUpdate fires
    //and re-render the chart.
    public getTimelineSeries(): {
        times:      Date[];
        irradiance: number[];
        cloud:      number[];
    } | null
    {
        const home = this._homeHourlyData;
        if (!home || !home.times.length)
        {
            return null;
        }

        const irradiance = home.times.map((_, i) =>
        {
            const sw = home.shortwave[i] ?? -1;
            if (sw >= 0)
            {
                return sw;
            }
            //Haurwitz fallback: returns a normalised PV percentage,
            //we re-scale to W/m² (1000 = STC) so the chart's Y axis
            //is a single unit across both data sources.
            const pct = computePvPower(home.times[i], this.homeLat, this.homeLon, home.cloudCover[i] ?? 0);
            return pct * 10;
        });

        const cloud = home.times.map((_, i) => home.cloudCover[i] ?? 0);

        return {
            times: home.times.slice(),
            irradiance,
            cloud
        };
    }

    public updateConfig(cfg: HeliosConfig): void
    {
        const prevStyleId = this._resolveMapStyle().id;
        this.cfg = { ...cfg };

        if (!this.map)
        {
            return;
        }

        //Map-style change → reload the basemap. setStyle() replaces
        //the entire style.json (sources, layers, sprites, glyphs);
        //our custom sources (helios-terrain, helios-cloud, helios-
        //planet) are wiped along with it and have to be re-added.
        //_onStyleLoad already does that on the resulting `style.load`
        //event — the same path used at initial load — so the only
        //extra work here is dropping `_mapReady` while the new style
        //is in flight, to prevent any code path that checks it from
        //operating on a half-loaded style.
        const nextStyleInfo = this._resolveMapStyle();
        if (nextStyleInfo.id !== prevStyleId)
        {
            this._mapReady = false;
            this.map.setStyle(
                `https://api.maptiler.com/maps/${nextStyleInfo.id}/style.json?key=${this.apiKey}`
            );
            //_onStyleLoad will re-init terrain/hillshade/cloud disc/
            //buildings/labels and re-render the current selection,
            //so we return early — touching paint properties or
            //running _renderForCurrentSelection right now would race
            //against the in-flight style load.
            return;
        }

        //Hillshade is the only style-customisable layer driven by
        //paint properties: the cloud-color is consumed via
        //_updateCloudCoverDisc on the next render cycle, and the
        //sun-color is consumed by the card's SVG overlay (no
        //MapLibre layer involved).
        if (this.map.getLayer('helios-hillshade'))
        {
            const c = toColor(this.cfg['topography-color'], 'rgba(80,100,160,1)');
            const a = toAlpha(this.cfg['topography-alpha'], 0.65);
            this.map.setPaintProperty('helios-hillshade', 'hillshade-shadow-color', c);
            this.map.setPaintProperty('helios-hillshade', 'hillshade-accent-color', c);
            this.map.setPaintProperty('helios-hillshade', 'hillshade-exaggeration', a);
        }

        //Re-apply the label-visibility toggle on every config change —
        //setLayoutProperty is cheap (no geometry rebuild) so we don't
        //bother diffing the old vs new value.
        this._applyLabelVisibility();

        //Building tint is a one-shot paint-property update on the
        //existing helios-buildings layer (no geometry rebuild), so
        //it's cheap to push on every config change without a diff.
        this.setBuildingColor(String(this.cfg['building-color']
            ?? DEFAULT_BUILDING_COLOR_HEX));

        if (this._homeHourlyData && this._mapReady)
        {
            this._renderForCurrentSelection();
        }
    }

    //Smooth, time-based auto-rotation around the home. Runs in the
    //OPPOSITE direction to the sun's apparent motion (decreasing
    //bearing in NH, where the sun goes east → south → west, i.e.
    //clockwise from above) so the camera and the live sun visually
    //counter-orbit each other — a quiet but constant motion that
    //makes the card feel alive even with no user input.
    //
    //Pause logic: any DOM-level interaction on the canvas (mouse
    //down, wheel, touch) bumps `_autoRotateLastUserAction`; the
    //loop checks this on every frame and skips the bearing update
    //while the inactivity window hasn't elapsed (5 s). This gives
    //the user instant, frictionless control during a gesture and
    //a brief grace period after they let go before the camera
    //starts drifting again.
    //
    //We tween in seconds (delta-time integrated against the frame
    //rate) rather than a fixed per-frame increment so the rotation
    //speed is constant across 60 Hz / 120 Hz displays and survives
    //tab-throttling with no visible jumps when the user comes back.
    private static readonly AUTO_ROTATE_DEG_PER_SEC      = 1;
    private static readonly AUTO_ROTATE_INACTIVITY_MS    = 5_000;

    private _startAutoRotateLoop(): void
    {
        if (this._autoRotateRaf !== undefined)
        {
            return;
        }
        this._autoRotateLastFrame      = performance.now();
        this._autoRotateLastUserAction = 0;

        const tick = (t: number) =>
        {
            if (!this.map)
            {
                this._autoRotateRaf = undefined;
                return;
            }

            const dt = Math.max(0, t - this._autoRotateLastFrame) / 1000;
            this._autoRotateLastFrame = t;

            const sinceUser = Date.now() - this._autoRotateLastUserAction;
            if (sinceUser >= HeliosEngine.AUTO_ROTATE_INACTIVITY_MS)
            {
                //Negative delta: bearing decreases, camera rotates
                //counter-clockwise around the up axis as seen from
                //above, map content appears to drift clockwise on
                //screen — opposite of the sun's apparent motion.
                const next = this.map.getBearing()
                    - HeliosEngine.AUTO_ROTATE_DEG_PER_SEC * dt;
                this.map.setBearing(next);
            }

            this._autoRotateRaf = requestAnimationFrame(tick);
        };
        this._autoRotateRaf = requestAnimationFrame(tick);
    }

    public cleanup(): void
    {
        this._clearWeatherTimer();
        window.clearInterval(this._skyTimer);
        window.clearTimeout(this._resizeDebounceTimer);
        this._fetchAbortController?.abort();
        this._resizeObserver?.disconnect();
        if (this._autoRotateRaf !== undefined)
        {
            cancelAnimationFrame(this._autoRotateRaf);
            this._autoRotateRaf = undefined;
        }
        this.map?.remove();
        this.map       = undefined;
        this._mapReady = false;
    }
}