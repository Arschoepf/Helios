import maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { getSunPosition, computePvPower, computeIrradianceWm2 } from './engine/sun';
import { fetchHomePointData, clearWeatherCache, RATE_LIMIT_BACKOFF_MS, type SampleHourly } from './engine/weather';
import { fetchBuildingsAroundHome, type BuildingsResult } from './engine/buildings';
import { projectExtrusionShadows } from './engine/shadows';
import { resolveLidarSource } from './engine/lidar';
import { RASTER_DEFAULTS } from './engine/lidar/pipeline';
import { LidarViewLayer } from './engine/lidar-view-layer';
import { startAutoRotateLoop } from './engine/auto-rotate';
import { setDetailMode as _setDetailMode } from './engine/detail-mode';
import
{
    SHADOW_RASTER_SIZE,
    BLANK_SHADOW_DATA_URL,
    shadowBoundsCornersLL,
    paintShadowRaster,
    type ShadowBoundsCorners
} from './engine/shadow-raster';
import
{
    nightShadeForAltitude,
    buildingColorForAltitude,
    sunLightPolarFromAltitude
} from './engine/lighting';
import
{
    type HeliosConfig,
    type LidarPrecisionLevel,
    DEFAULT_BUILDING_RADIUS_M,
    DEFAULT_BUILDING_OPACITY,
    DEFAULT_BUILDING_CLUSTER_RADIUS_M,
    DEFAULT_BUILDING_COLOR_HEX,
    DEFAULT_LIDAR_PRECISION,
    LIDAR_PRECISION_PITCH_MULT,
    DEFAULT_SHADOW_OPACITY,
    DEFAULT_LIDAR_VIEW_POINT_SIZE_PX,
    DEFAULT_LIDAR_VIEW_POINT_OPACITY,
    DEFAULT_LIDAR_VIEW_WIREFRAME,
    DEFAULT_LIDAR_VIEW_WIREFRAME_OPACITY,
    defaultLidarViewPointColor,
    defaultLidarViewWireframeColor,
    LIDAR_VIEW_FULL_OPACITY_RADIUS_M,
    LIDAR_VIEW_DISPLAY_RADIUS_M
} from './helios-config';


//Single ground-shadow layer, rendered as an image source rather
//than a fill layer. The shadow projector produces one polygon per
//casting region; the engine rasterises them onto an offscreen
//canvas at full black, the canvas becomes a MapLibre image source,
//and a raster layer paints it at `raster-opacity = shadow-opacity`.
//Per-pixel rendering avoids the alpha-compositing saturation that
//many overlapping fill polygons would produce in a dense forest
//(every pixel is either covered or not, never stacked twice).
export const SHADOW_LAYER_IDS: readonly string[] = [
    'helios-building-shadows'
];

//Lifecycle instrumentation. Counters live on window.__heliosStats
//so a user can inspect them at any point ("did this engine actually
//get torn down? how many setStyle calls did my last edit trigger?").
//Cheap, no I/O, only mutates a small object. Comparing the diff
//between a fresh page load and an after-edit snapshot is the
//cleanest path to identify which lifecycle path is accumulating
//under heavy editor activity.
interface HeliosStats
{
    enginesCreated:           number;
    enginesCleanedUp:         number;
    updateConfigCalls:        number;
    styleReloads:             number;
    addBuildingsCalls:        number;
    buildingFetchStarts:      number;
    contextLostEvents:        number;
}
function bumpStat(key: keyof HeliosStats): void
{
    if (typeof window === 'undefined') return;
    const w = window as unknown as { __heliosStats?: HeliosStats };
    if (!w.__heliosStats)
    {
        w.__heliosStats = {
            enginesCreated:      0,
            enginesCleanedUp:    0,
            updateConfigCalls:   0,
            styleReloads:        0,
            addBuildingsCalls:   0,
            buildingFetchStarts: 0,
            contextLostEvents:   0
        };
    }
    w.__heliosStats[key] = (w.__heliosStats[key] ?? 0) + 1;
}


//Module-level cap on the number of HeliosEngine instances alive at
//the same time.
//
//Home Assistant's dashboard editor creates a fresh preview card on
//every config edit and does not reliably fire `disconnectedCallback`
//on the previous preview, orphaned engines accumulate, each still
//holding a WebGL context. Safari mobile caps active contexts at ~8
//and starts recycling once the cap is hit, which causes FPS drift
//and the iOS black-screen lockup.
//
//We track every live engine in a module-level Set and force-clean
//the oldest one whenever a new engine is about to push the count
//over the limit. The user's
//currently-visible card is always the most recent engine, so the
//victim of force-cleanup is always an orphan preview the user
//can't see.
const MAX_LIVE_ENGINES = 2;
const _liveEngines = new Set<HeliosEngine>();

export type CloudIntensity = 'clear' | 'light' | 'moderate' | 'heavy' | 'storm' | 'fog';

//Sources of the irradiance value displayed in the PV legend.
//
//  haurwitz  , local computation using Haurwitz (1945) clear-sky GHI
//               and Kasten-Czeplak (1980) cloud attenuation. Always
//               available since it only needs the solar position and
//               cloud_cover. Used as the fallback past the forecast
//               horizon or when the model omits shortwave_radiation.
//  shortwave , direct read of `shortwave_radiation_instant` from the
//               weather model (median across the active models in
//               'high' precision mode). Considered more accurate
//               because the model integrates aerosols, humidity
//               profile and multi-layer cloud effects that a purely
//               analytical formula can't reproduce.
//  sensor    , value pushed in from a Home Assistant entity via
//               setLiveIrradianceOverride. Beats both model paths
//               because it's a measurement at the home itself; only
//               used while the card is in live mode, scrubbing past
//               or forecast still falls back to shortwave/haurwitz.
export type IrradianceSource = 'haurwitz' | 'shortwave' | 'sensor';

export interface WeatherData
{
    cloudCover:     number;
    cloudLow:       number;        //%, low-level clouds (≤ 3 km)
    cloudMid:       number;        //%, mid-level clouds (3–8 km)
    cloudHigh:      number;        //%, high-level clouds (≥ 8 km)
    cloudIntensity: CloudIntensity;
    timeRange:      { start: Date; end: Date } | null;
    isLiveTime:     boolean;
    pvPower:        number;        //primary value, normalised 0..100 (≈ GHI/10 W/m²)
    pvPowerHaurwitz:  number;      //always populated (analytical fallback)
    pvPowerShortwave: number;      //-1 if shortwave_radiation is unavailable
    irradianceSource: IrradianceSource;
}

type RGB = [number, number, number];

//Mobile detection, used to scale grid density and pixel ratio so older
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
    //Treat narrow viewports as mobile too, covers desktop in mobile mode
    if (typeof window !== 'undefined' && window.innerWidth <= 768)
    {
        return true;
    }
    return false;
})();

//Config helpers

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


const DEFAULT_CLOUD_RGB: RGB = [0x5A, 0x8D, 0xC4];



//Haversine distance, used to compare two lat/lon pairs in metres.

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
//MapLibre has no native "geographic circle" geometry, its `circle`
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
//so the polygon closes, required by GeoJSON's Polygon spec.
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
//a ~75 px disc, focal on the home itself, neither dwarfing it nor
//swallowing too much of the surrounding context.
const CLOUD_DISC_RADIUS_M       = 30;
//The disc + ring opacity / stroke styling lives in the .cloud-svg
//selectors over in helios-card-css. The radius constant above is
//still consumed by projectCloudScene to size the geographic circle
//vertices.
//Number of polygon vertices used to approximate the disc and ring.
//128 is overkill for the visual smoothness alone but the cost is
//still negligible (~128 trig ops per data update) and it future-
//proofs the look against tighter zooms or subtle lighting we may
//add in later phases.
const CLOUD_CIRCLE_SEGMENTS     = 128;

//Vertical screen-space offset (CSS px) used to anchor the PV /
//battery chip cluster relative to the projected home. The SoC and
//Power chips sit on a shared shelf this many pixels above the home
//(minus the battery vertical offset); the PV chip is mirrored
//below the shelf. Adjusting this single constant slides the whole
//cluster up or down without disturbing its internal geometry.
const PV_CHIP_OFFSET_PX         = 115;


//Solar-arc parameters. The arc traces the sun's full 24h
//trajectory across the local sky, projected onto the screen via
//the same camera matrices MapLibre uses for its own 3D content.
//
//Radius is in real-world metres, i.e. the radius of the imaginary
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
    map?:     MapLibreMap;
    homeLat:  number;
    homeLon:  number;
    //Home altitude (metres above sea level), forwarded to Open-Meteo
    //via &elevation= for sharper boundary conditions. Undefined falls
    //back to the API's global 90 m DEM.
    private homeElevation?: number;
    cfg:      HeliosConfig;

    private _fetchLat = 0;
    private _fetchLon = 0;

    private _mapReady     = false;
    //Single source of truth for hourly forecast data. Populated by
    //fetchHomePointData(); null until the first successful fetch.
    private _homeHourlyData: SampleHourly | null = null;
    //Markers placed at each pv-array entry whose lat/lon is set and
    //differs from the home position. Tracked per-array index so a
    //config change rebuilds the set without leaking stale markers.
    private _pvArrayMarkers: maplibregl.Marker[] = [];
    private _selectedTime:  Date | null       = null;

    //Skip atmosphere repaint when the sun moved less than 0.5° since
    //last call (≈ 2 min), setPaintProperty isn't free on mobile.
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

    //Irradiance samples pushed in by the card from a HA solar-radiation
    //sensor: the entity's history (recorder snapshots) up to "now",
    //merged with the live state. Stored sorted ascending by time so the
    //lookup at _sensorIrradianceAt can binary-search if the dataset
    //grows past linear-scan territory. Null means "no entity configured
    //or no usable samples yet", the model irradiance is used unchanged.
    //
    //Each sample is in W/m². The engine treats them as ground-truth
    //point readings of global shortwave irradiance at the home, in
    //the same units as Open-Meteo's shortwave_radiation_instant, so
    //they slot into the existing irradiance pipeline without rescaling.
    //
    //Lookup is nearest-neighbour with a strict time window (±30 min by
    //default): outside the window we fall through to the model rather
    //than extrapolate a stale value. Forecast time always falls
    //through since samples never sit in the future.
    private _sensorIrradianceSamples: { tMs: number; wm2: number }[] | null = null;
    private static readonly SENSOR_IRRADIANCE_WINDOW_MS = 30 * 60 * 1000;
    public setSolarRadiationSamples(
        samples: { time: Date; wm2: number }[] | null
    ): void
    {
        if (!samples || samples.length === 0)
        {
            if (this._sensorIrradianceSamples === null) return;
            this._sensorIrradianceSamples = null;
            this._arcInputsCache = undefined;
            this._renderForCurrentSelection();
            return;
        }
        const cleaned: { tMs: number; wm2: number }[] = [];
        for (const s of samples)
        {
            const ms = s.time.getTime();
            if (!isFinite(ms)) continue;
            if (!isFinite(s.wm2) || s.wm2 < 0) continue;
            cleaned.push({ tMs: ms, wm2: s.wm2 });
        }
        cleaned.sort((a, b) => a.tMs - b.tMs);
        const next = cleaned.length > 0 ? cleaned : null;

        //Skip the (re-)render hop when the dataset matches what we
        //already hold. The card pushes samples on every Lit cycle to
        //keep the live state fresh, so without this guard each push
        //fires onWeatherUpdate, which rewrites @state references on
        //the card, which re-runs updated(), which pushes again, an
        //unterminated render loop that freezes the dashboard the
        //moment a solar-radiation entity is selected.
        if (this._sensorSamplesEqual(this._sensorIrradianceSamples, next))
        {
            return;
        }
        this._sensorIrradianceSamples = next;
        //Sun arc cache colours each daily sample from a single live-
        //cloud key; mixing sensor data into the lookup invalidates
        //the existing cache for that day so the next projectSunScene
        //rebuilds with the new ground truth.
        this._arcInputsCache = undefined;
        this._renderForCurrentSelection();
    }

    private _sensorSamplesEqual(
        a: { tMs: number; wm2: number }[] | null,
        b: { tMs: number; wm2: number }[] | null
    ): boolean
    {
        if (a === b) return true;
        if (a === null || b === null) return false;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++)
        {
            if (a[i].tMs !== b[i].tMs) return false;
            if (a[i].wm2 !== b[i].wm2) return false;
        }
        return true;
    }

    //Nearest-neighbour lookup over the pushed sensor history. Returns
    //the W/m² reading whose timestamp is closest to `t` provided the
    //gap is within the strict window; otherwise null so the caller
    //falls back to the model. Linear scan is fine for ~hourly samples
    //across a few-day window (a couple of hundred entries at most).
    private _sensorIrradianceAt(t: Date): number | null
    {
        const samples = this._sensorIrradianceSamples;
        if (!samples || samples.length === 0) return null;
        const tMs = t.getTime();
        let bestIdx = -1;
        let bestDelta = Number.POSITIVE_INFINITY;
        for (let i = 0; i < samples.length; i++)
        {
            const d = Math.abs(samples[i].tMs - tMs);
            if (d < bestDelta)
            {
                bestDelta = d;
                bestIdx   = i;
            }
            //Samples are sorted, once delta starts growing again we
            //can short-circuit, the rest is monotonically worse.
            else if (d > bestDelta)
            {
                break;
            }
        }
        if (bestIdx < 0 || bestDelta > HeliosEngine.SENSOR_IRRADIANCE_WINDOW_MS)
        {
            return null;
        }
        return samples[bestIdx].wm2;
    }
    //Map transform changed, the card recomputes screen-space
    //projections (sun arc, chip positions, leaders) from this hook.
    public onMapTransform?:  () => void;

    //Auto-rotation state. The map slowly orbits the home in the
    //opposite direction to the sun's apparent motion (decreasing
    //bearing, ~1.5°/s) when the user has been idle for a few
    //seconds. Any direct interaction resets the inactivity timer,
    //so the rotation pauses immediately on pinch / drag / wheel
    //and resumes from the user's bearing once they let go.
    _autoRotateRaf?:           number;
    _autoRotateLastFrame:      number = 0;
    _autoRotateLastUserAction: number = 0;
    //MapLibre canvas reference, captured at init so cleanup() can
    //detach our WebGL context listeners against the same node. Held
    //separately because map.getCanvas() returns null once map.remove()
    //has run.
    private _mapCanvas?: HTMLCanvasElement;

    //Single-pointer drag-rotate state. We disable MapLibre's default
    //right-click dragRotate and replace it with a pointer-driven
    //rotation that responds to left-click on desktop and to a single
    //finger drag on touch, what users intuitively expect on a 3D
    //card. The two-finger pinch-rotate path (touchZoomRotate) is
    //preserved so two-finger rotation still works on touch.
    private _dragRotateHandlers?: {
        canvas:  HTMLCanvasElement;
        onDown:  (e: PointerEvent) => void;
        onMove:  (e: PointerEvent) => void;
        onEnd:   (e: PointerEvent) => void;
    };

    //Stored references for every map.on() / canvas.addEventListener
    //we register on the MapLibre map and its canvas. cleanup() uses
    //these to call map.off() / removeEventListener explicitly before
    //map.remove(), so a buggy map.remove() (which we've seen on iOS
    //Safari) can't leave dangling closures that keep the dead engine
    //+ its GeoJSON + its WebGL context alive across re-inits.
    private _mapPinHandler?:       (e: { originalEvent?: unknown }) => void;
    private _mapStyleLoadHandler?: () => void;
    private _mapLoadHandler?:      () => void;
    private _mapMoveHandler?:      () => void;
    private _mapErrorHandler?:     (e: { error?: { message?: string } }) => void;
    private _webglLostHandler?:    (e: Event) => void;
    private _webglRestoredHandler?: () => void;

    //Card-level hook fired when the WebGL context has been lost
    //(iOS Safari aggressively recycles WebGL contexts under memory
    //pressure). The card listens and triggers a clean re-init.
    public onContextLost?: () => void;

    //Cached result of the building fetch around the home. The home
    //doesn't move during a session, so we fetch once and reuse the
    //GeoJSON across style reloads (theme switches, basemap changes)
    //instead of hitting the MapTiler API again. Invalidated when the
    //building-radius config option changes.
    private _buildingsData:     BuildingsResult | null = null;
    private _buildingsFetchKey: string = '';
    private _buildingsAbort?:   AbortController;

    //Last cloud-cover percentage applied to the on-card cloud disc.
    //Cached here so projectCloudScene() can re-project the polygons
    //on every map transform without having to round-trip back
    //through _renderForCurrentSelection.
    private _currentCloudPct: number = 0;
    //Per-layer breakdown captured at the same instant — used by
    //projectCloudScene() to size the three concentric bands
    //(low → mid → high, from centre to edge) proportionally to
    //each layer's contribution to the total.
    private _currentCloudLow:  number = 0;
    private _currentCloudMid:  number = 0;
    private _currentCloudHigh: number = 0;

    //Consolidated LiDAR shadow regions for the current home + radius
    //+ precision combination. Null until the first fetch lands; the
    //shadow projector reads this on every sun-position refresh.
    private _lidarShadowFeatures: GeoJSON.FeatureCollection | null = null;
    //Diagnostics from the most recent LiDAR shadow fetch, surfaced via
    //`window.heliosStats()`. Replaces what we used to print as
    //`[HELIOS] LiDAR shadows: ... cells -> ... clumps` console info.
    private _lidarShadowDiagnostics:
        { cellsKept: number; cellsPerClumpCap: number; heightRangeM: [number, number] | null }
        | null = null;
    //Fetch-key for the cached LiDAR shadow features. Lets us skip a
    //refetch when the user nudges the camera but home/radius/precision
    //haven't changed.
    private _lidarShadowKey: string = '';
    //In-flight LiDAR shadow fetch, aborted when home/radius/precision
    //changes so a slow IGN response can't overwrite a fresher request.
    private _lidarShadowAbort?: AbortController;
    //Raw height raster + geo kept around for the LiDAR View overlay
    //(projects every cell, threshold-bypassed, to screen).
    //Cleared whenever the fetch path resets `_lidarShadowFeatures`
    //so the two stay in lockstep, the View overlay never out-lives
    //the cast-shadow set it was sampled from. Held as a reference
    //to the buffer the provider returned; no copy, no extra mem.
    private _lidarRaster:
        {
            heights:    Float32Array;
            rasterSize: number;
            minLat:     number;
            maxLat:     number;
            minLon:     number;
            maxLon:     number;
        }
        | null = null;

    //Custom MapLibre layer rendering the LiDAR View dot cloud directly
    //on the GPU. Owns one Float32 buffer with the Mercator triplet of
    //each finite cell, rebuilt only when a new raster lands; per frame
    //the shader projects + radius-filters all points in a single
    //drawArrays(POINTS) call. Replaces the old CPU-bake / 2D canvas
    //path, which couldn't keep up past a few hundred thousand cells.
    private _lidarViewLayer?: LidarViewLayer;

    //Offscreen canvas used to rasterise cast shadows before uploading
    //them to the MapLibre image source. Lives for the whole engine
    //lifetime so we don't realloc on every sun tick. Sized at
    //SHADOW_RASTER_SIZE; bounds are recomputed per refresh from the
    //home + building-radius.
    private _shadowCanvas?: HTMLCanvasElement;

    //Cache of the 96 per-day sun arc samples. Sun position + clear-sky
    //irradiance depend only on the calendar day and the cloud cover,
    //not on the live map matrix, so we recompute the heavy trig only
    //when those inputs change. On every transform / rotation tick the
    //cached lon/lat/altitudeM tuples are re-projected through the
    //current map matrix and that's it. Invalidated when day rolls or
    //the live cloud cover shifts by more than a whole percent.
    private _arcInputsCache?: {
        dayStartMs: number;
        cloudPctInt: number;
        samples: Array<{
            lon: number;
            lat: number;
            altitudeM: number;
            wm2: number;
            belowHorizon: boolean;
        } | null>;
    };

    //Last signature of the shadow raster inputs (sun position rounded,
    //home, radius, source-features identity + length). When unchanged
    //we skip the project + paint + PNG-encode round-trip entirely,
    //which is the single most expensive recurring op on a refresh
    //driven by something other than actual sun movement.
    private _lastShadowSig?: string;

    //Card-side hooks for the LiDAR shadow compute pass so the card
    //can surface a busy indicator while the WMS round-trip + raster
    //paint run. Both are optional; the engine still computes
    //silently if the card hasn't set them.
    public onShadowComputeStart?: () => void;
    public onShadowComputeEnd?:   () => void;

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

        bumpStat('enginesCreated');

        //Evict the oldest live engine if we're at the cap. Set
        //iteration follows insertion order so the first value is the
        //longest-lived, typically an orphaned editor-preview engine
        //the user can no longer see.
        while (_liveEngines.size >= MAX_LIVE_ENGINES)
        {
            const oldest = _liveEngines.values().next().value;
            if (!oldest) break;
            console.warn('[HELIOS] WebGL context cap reached, force-cleaning the oldest engine');
            try { oldest.cleanup(); }
            catch (_) {}
            //cleanup() removes it from the set, but be defensive in
            //case it threw before reaching that line.
            _liveEngines.delete(oldest);
        }
        _liveEngines.add(this);

        this._fetchLat = this.homeLat;
        this._fetchLon = this.homeLon;

        //Pixel ratio caps. At pitch 55° + continuous auto-rotation,
        //each rendered pixel is sampled multiple times (extrusion,
        //basemap, shadow raster), so the desktop cap sits at 2 (not
        //the native 2-3 of Retina) and mobile at 1.25, slashing per-
        //frame fragment work without a visible quality regression on
        //the card-sized viewport. The user-exposed `pixel-ratio: 1x`
        //forces 1.0 for the cheapest possible workload.
        const pixelRatio = this._pixelRatio();

        const styleInfo = this._resolveMapStyle();

        //Camera is locked on the home for zoom/pan/pitch, the data
        //only makes sense from this exact viewpoint. Rotation is the
        //only direct user input: spinning around the home lets them
        //read the sun trajectory from any compass angle. Bearing
        //auto-flips per hemisphere so noon always sits at the top
        //(NH: south up, SH: north up).
        this.map = new maplibregl.Map(
        {
            container,
            style:           styleInfo.url,
            center:          haCoords,
            zoom:            18,
            pitch:           55,
            bearing:         this.homeLat >= 0 ? 180 : 0,
            minZoom:         18,
            maxZoom:         18,
            dragPan:         false,
            scrollZoom:      false,
            doubleClickZoom: false,
            //MapLibre's default dragRotate binds to right-click drag,
            //which is not what users expect on a 3D card. We disable
            //it and wire our own pointer handlers below so a left-click
            //drag (mouse) or single-finger drag (touch) rotates.
            dragRotate:      false,
            touchZoomRotate: true,
            touchPitch:      false,
            boxZoom:         false,
            keyboard:        false,
            pixelRatio,
            //Collapse the attribution control to a tiny "i" disc by
            //default. OSM / OpenFreeMap / OpenMapTiles require the
            //attribution to stay accessible (license terms), so we
            //can't hide it outright, but `compact: true` makes it a
            //single icon at the bottom-right of the canvas that
            //expands on click. Far less visual noise than the full
            //"MapLibre | OpenFreeMap © OpenMapTiles..." bar.
            attributionControl: { compact: true }
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

        //Expose the map on the global window for in-browser
        //debugging. `__heliosMap.getStyle().layers` is the single
        //most useful thing when investigating layer / style issues.
        //Cheap to leave on; anyone with dev-tools open already has
        //full access to the page.
        try { (window as unknown as { __heliosMap?: MapLibreMap }).__heliosMap = this.map; }
        catch (_) {}

        //Lock the pinch-rotate pivot to the canvas centre. By default,
        //TwoFingersTouchZoomRotateHandler rotates around the centroid
        //of the two fingers, visually, the home orbits around the
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
        this._mapPinHandler = (e: { originalEvent?: unknown }) =>
        {
            if (!this.map || !e?.originalEvent) return;
            const c = this.map.getCenter();
            if (c.lng !== this.homeLon || c.lat !== this.homeLat)
            {
                this.map.setCenter([this.homeLon, this.homeLat]);
            }
        };
        this.map.on('rotate', this._mapPinHandler);
        this.map.on('move',   this._mapPinHandler);

        this._mapStyleLoadHandler = () => this._onStyleLoad();
        this.map.on('style.load', this._mapStyleLoadHandler);

        this._mapLoadHandler = () =>
        {
            this.map?.resize();
            startAutoRotateLoop(this);
        };
        this.map.on('load', this._mapLoadHandler);

        //OpenFreeMap's Liberty style references a couple of fill-
        //pattern sprites that aren't in the published sprite atlas
        //(`wood-pattern`, `swimming_pool`, ...). MapLibre logs a
        //noisy warning per missing image. Wire a styleimagemissing
        //handler that registers a 1×1 transparent stub for the
        //requested id so the layer falls through to its base color
        //without spamming the console. Cheap, idempotent because
        //hasImage() guards re-registration.
        this.map.on('styleimagemissing', (e: { id?: string }) =>
        {
            if (!this.map || !e?.id || this.map.hasImage(e.id)) return;
            try
            {
                this.map.addImage(e.id, {
                    width:  1,
                    height: 1,
                    data:   new Uint8Array(4)   //RGBA, all zero = transparent
                });
            }
            catch (_) {}
        });

        //Map transform broadcaster, relays move events to the card so
        //it can keep HTML overlays aligned with the underlying canvas.
        //We listen on `move` rather than `moveend` so the overlays
        //track the camera frame-by-frame during programmatic
        //animations rather than snapping at the end.
        this._mapMoveHandler = () => this.onMapTransform?.();
        this.map.on('move', this._mapMoveHandler);

        //Auto-rotation pause is bumped ONLY by the single-pointer
        //drag-rotate handler below (onDown / onMove). Wheel zoom,
        //two-finger pinch-rotate and incidental touches leave the
        //orbit running, only an explicit single-finger drag (or
        //left-mouse drag on desktop) interrupts it.
        const canvas = this.map.getCanvas();
        this._mapCanvas = canvas;

        //Custom drag-rotate. Left-click drag on desktop, single-finger
        //drag on touch. Two-finger pinch-rotate still works via
        //MapLibre's touchZoomRotate handler (left enabled in init).
        //
        //MapLibre's canvas ships with touch-action: pan-x pan-y, which
        //reserves single-finger drags for native browser scrolling ,
        //pointer events for those gestures never reach our handler.
        //Overriding to touch-action: none means every gesture on the
        //canvas surface becomes a card interaction (the user scrolls
        //the dashboard by touching outside the card, the same way
        //Google Maps and other map widgets behave on mobile).
        canvas.style.touchAction = 'none';

        const ROTATE_SENSITIVITY_DEG_PER_PX = 0.35;
        let dragRotating  = false;
        let lastPointerX  = 0;
        let activeId: number | null = null;

        const onDown = (e: PointerEvent) =>
        {
            //Mouse: left button only. Touch / pen: always start.
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            //Single-pointer rotation; ignore additional touches so the
            //two-finger pinch-rotate gesture stays with MapLibre.
            if (activeId !== null) return;
            //Swallow gestures during the post-exit cooldown so the
            //click that dismissed the dashboard panel can't bleed
            //into a fresh drag-rotate on the canvas behind.
            if (this.isUserGestureSuppressed()) return;
            dragRotating = true;
            activeId     = e.pointerId;
            lastPointerX = e.clientX;
            this._autoRotateLastUserAction = Date.now();
            try { canvas.setPointerCapture(e.pointerId); }
            catch (_) {}
        };
        const onMove = (e: PointerEvent) =>
        {
            if (!dragRotating || !this.map || e.pointerId !== activeId) return;
            const dx = e.clientX - lastPointerX;
            lastPointerX = e.clientX;
            this._autoRotateLastUserAction = Date.now();
            //Positive dx (drag right) bumps bearing up so the map
            //content under the finger / cursor follows the gesture
            //direction, what you'd intuitively expect on a touchable
            //3D widget. The negated form (subtract) read inverted on
            //both desktop and mobile.
            this.map.setBearing(this.map.getBearing() + dx * ROTATE_SENSITIVITY_DEG_PER_PX);
        };
        const onEnd = (e: PointerEvent) =>
        {
            if (e.pointerId !== activeId) return;
            dragRotating = false;
            activeId     = null;
            try { canvas.releasePointerCapture(e.pointerId); }
            catch (_) {}
        };
        canvas.addEventListener('pointerdown',   onDown);
        canvas.addEventListener('pointermove',   onMove);
        canvas.addEventListener('pointerup',     onEnd);
        canvas.addEventListener('pointercancel', onEnd);
        this._dragRotateHandlers = { canvas, onDown, onMove, onEnd };

        //WebGL context-loss recovery. iOS Safari recycles WebGL
        //contexts aggressively under memory pressure; without a
        //handler the canvas freezes on a black frame and the user
        //thinks the dashboard is broken. We preventDefault on the
        //lost event (which lets the browser try to restore), flip
        //_mapReady to false so dependent code path bails, and emit
        //onContextLost, the card uses that to fully tear down and
        //re-init the engine on the next animation frame.
        this._webglLostHandler = (e: Event) =>
        {
            e.preventDefault();
            bumpStat('contextLostEvents');
            this._mapReady = false;
            console.warn('[HELIOS] WebGL context lost, requesting card re-init');
            this.onContextLost?.();
        };
        this._webglRestoredHandler = () =>
        {
            console.info('[HELIOS] WebGL context restored');
        };
        canvas.addEventListener('webglcontextlost',     this._webglLostHandler,    false);
        canvas.addEventListener('webglcontextrestored', this._webglRestoredHandler, false);

        //Surface MapLibre internal errors (auth, tile fetch, WebGL) to
        //the browser console rather than letting them silently cascade.
        //Without this hook, an invalid API key just produces silent 403s
        //and the user sees a frozen card with no diagnostic.
        this._mapErrorHandler = (e: { error?: { message?: string } }) =>
        {
            const msg = e?.error?.message ?? 'unknown error';
            //Suppress noisy errors triggered by our own building-layer
            //suppression: we attempt setLayoutProperty / setPaintProperty
            //on layers that may already be removed during the suppression
            //sweep; MapLibre reports each as "Cannot style non-existing
            //layer X" but the outcome is the harmless intended one.
            if (msg.includes('non-existing layer')) return;
            console.warn('[HELIOS] MapLibre error:', msg);
        };
        this.map.on('error', this._mapErrorHandler);

        this._refreshWeather();
    }

    //Resolves the active OpenFreeMap style URL from `map-style` +
    //`card-theme`. OpenFreeMap publishes a fixed set of MapLibre
    //styles at https://tiles.openfreemap.org/styles/<name>:
    //
    //  liberty  , full-colour OpenMapTiles look (default streets)
    //  positron , muted grey, very sober (minimal)
    //  fiord    , muted dark blue / slate-grey, used as the dark
    //             variant for both above. Chosen over OFM's `dark`
    //             style which clamps the background to near-black
    //             (rgb(12,12,12)) and is too oppressive at the small
    //             card viewport, Fiord's #45516E reads as "evening"
    //             without losing the basemap content underneath.
    //
    //We resolve to a single URL because OpenFreeMap has no separate
    //light / dark pair per style, the dark style is its own thing
    //and replaces both Liberty and Positron when the card chrome is
    //dark. The user-side mapping is therefore:
    //
    //  map-style: streets  + card-theme: light → liberty
    //  map-style: streets  + card-theme: dark  → fiord
    //  map-style: minimal  + card-theme: light → positron
    //  map-style: minimal  + card-theme: dark  → fiord
    //
    //All styles use the same vector tile source backing the buildings
    //fetch in engine/buildings.ts, so a style change keeps the home
    //and surroundings GeoJSON cache intact.
    private _resolveMapStyle(): { url: string; styleName: string }
    {
        const raw    = String(this.cfg['map-style'] ?? 'streets').toLowerCase();
        const isDark = String(this.cfg['card-theme'] ?? 'light').toLowerCase() === 'dark';

        let styleName: string;
        if      (isDark)            styleName = 'fiord';
        else if (raw === 'minimal') styleName = 'positron';
        else                        styleName = 'liberty';

        return {
            url:       `https://tiles.openfreemap.org/styles/${styleName}`,
            styleName
        };
    }

    //Resolve the WebGL canvas pixel ratio. '1x' forces 1.0 (cheapest
    //fragment workload), anything else (including unset) falls back
    //to the device-native ratio capped at 2 on desktop / 1.25 on
    //mobile so even retina screens stay within the per-frame budget.
    private _pixelRatio(): number
    {
        if (String(this.cfg['pixel-ratio'] ?? 'auto').toLowerCase() === '1x')
        {
            return 1.0;
        }
        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
        return IS_MOBILE
            ? Math.min(Math.max(dpr, 1), 1.25)
            : Math.min(Math.max(dpr, 1.5), 2);
    }

    //Reads the user-configured shadow precision, normalises any
    //off-spec value to the default and returns one of the canonical
    //LidarPrecisionLevel members.
    private _lidarPrecisionLevel(): LidarPrecisionLevel
    {
        const v = String(this.cfg['lidar-precision'] ?? DEFAULT_LIDAR_PRECISION).toLowerCase();
        if (v === 'low' || v === 'medium' || v === 'high')
        {
            return v as LidarPrecisionLevel;
        }
        return DEFAULT_LIDAR_PRECISION;
    }

    //Master shadow toggle. When false, no cast shadows are rendered
    //(neither LiDAR nor MapTiler). When true, the source is picked
    //based on whether a LiDAR provider covers the home.
    private _shadowsEnabled(): boolean
    {
        return this.cfg['shadows-enabled'] !== false;
    }

    private _shadowOpacity(): number
    {
        const raw = Number(this.cfg['shadow-opacity']);
        if (!Number.isFinite(raw)) return DEFAULT_SHADOW_OPACITY;
        return Math.max(0, Math.min(1, raw));
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

    //Visible timeline window. The Open-Meteo payload now stretches
    //7 past days so the dashboard forecast calibration has enough
    //room to average ratios, but the timeline UI itself clips to
    //the last 2 past days so the slider stays as scrubbable as
    //before. Calibration consumers reach the full payload through
    //`getTimelineSeries()`, which returns every hourly sample.
    private _getTimeRange(): { start: Date; end: Date } | null
    {
        const home = this._homeHourlyData;
        if (!home || !home.times.length)
        {
            return null;
        }
        const t = home.times;
        const last = t[t.length - 1];
        const TIMELINE_PAST_DAYS = 2;
        const today0 = new Date();
        today0.setHours(0, 0, 0, 0);
        const visibleStartMs = today0.getTime() - TIMELINE_PAST_DAYS * 24 * 3_600_000;
        //Snap to the earliest sample at or after the visible start.
        //If the entire fetched window is shorter (cache truncated,
        //first boot), fall back to the very first sample we have.
        let startIdx = 0;
        for (let i = 0; i < t.length; i++)
        {
            if (t[i].getTime() >= visibleStartMs) { startIdx = i; break; }
        }
        return { start: t[startIdx], end: last };
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

        //Compute every irradiance candidate so the card can pick the
        //best available source. Priority order at render time:
        //  1. Sensor reading from the configured solar-radiation entity
        //     (when one was pushed and matches `t` within the window).
        //  2. shortwave_radiation_instant from Open-Meteo, when the
        //     model supplied it for this hour.
        //  3. Haurwitz (analytical clear-sky + Kasten-Czeplak cloud
        //     attenuation), the always-defined fallback used outside
        //     the model horizon.
        //Stays on the horizontal-panel path: these values are GHI
        //(global on horizontal). The tilt/azimuth transposition lives
        //in the card-side PV prediction helpers instead.
        const pvPowerHaurwitz = computePvPower(t, this.homeLat, this.homeLon, w.cloudCover);

        let pvPowerShortwave = -1;
        if (w.shortwave >= 0)
        {
            //shortwave is in W/m². Normalise against STC (1000 W/m²)
            //and clamp to [0, 100] so downstream code doesn't need
            //to know which source produced the value.
            pvPowerShortwave = Math.max(0, Math.min(100, w.shortwave / 1000 * 100));
        }

        const sensorWm2 = this._sensorIrradianceAt(t);
        const pvPowerSensor = sensorWm2 !== null
            ? Math.max(0, Math.min(100, sensorWm2 / 1000 * 100))
            : -1;

        //Pick the primary value to display, sensor beats model when
        //both exist (a thermopile at the home is closer to ground
        //truth than a gridded forecast), model beats analytical when
        //available, Haurwitz is always defined as the last resort.
        let pvPower:          number;
        let irradianceSource: IrradianceSource;
        if (pvPowerSensor >= 0)
        {
            pvPower          = pvPowerSensor;
            irradianceSource = 'sensor';
        }
        else if (pvPowerShortwave >= 0)
        {
            pvPower          = pvPowerShortwave;
            irradianceSource = 'shortwave';
        }
        else
        {
            pvPower          = pvPowerHaurwitz;
            irradianceSource = 'haurwitz';
        }

        this.onWeatherUpdate?.(
        {
            cloudCover:       w.cloudCover,
            cloudLow:         w.cloudLow,
            cloudMid:         w.cloudMid,
            cloudHigh:        w.cloudHigh,
            cloudIntensity:   w.cloudIntensity,
            timeRange:        this._getTimeRange(),
            isLiveTime:       this._selectedTime === null,
            pvPower,
            pvPowerHaurwitz,
            pvPowerShortwave,
            irradianceSource
        });

        //Refresh the on-ground cloud-cover gauge: a coloured disc
        //whose radius reflects the current coverage percentage,
        //surrounded by a fixed 100 % reference ring. The per-layer
        //breakdown (low / mid / high) feeds the three-band split
        //inside the disc in projectCloudScene.
        this._updateCloudCoverDisc(w.cloudCover, w.cloudLow, w.cloudMid, w.cloudHigh);
    }

    private _onStyleLoad(): void
    {
        if (!this.map)
        {
            return;
        }
        this._mapReady = true;

        this.map.getStyle().layers?.forEach(l =>
        {
            if (l.type === 'raster')
            {
                try
                {
                    this.map!.setPaintProperty(l.id, 'raster-saturation', 0.10);
                    this.map!.setPaintProperty(l.id, 'raster-contrast',   0.05);
                }
                catch (_) {}
            }
        });

        //Layer order: night-shade first (it tints the ground), then
        //the cloud-cover disc (under the buildings so they emerge
        //through it as islands), then buildings on top. The 3D solar
        //overlays (arc, sun, incidence ray) live as HTML/SVG above
        //the canvas, a Three.js custom layer was tried and rejected
        //because MapLibre's compositor would overpaint it
        //unpredictably; HTML overlays sidestep the GL pipeline
        //entirely.
        this._initNightShade();
        this._initCloudCoverDisc();
        this._addBuildings();
        this._initLidarViewLayer();
        this._applyLabelVisibility();
        this._refreshPvArrayMarkers();

        window.clearInterval(this._skyTimer);
        this._lastAtmosphereAlt = -999;
        this._refreshShadowsAndAtmosphere();
        //Sky/atmosphere refresh, every 60s. _refreshShadowsAndAtmosphere
        //internally short-circuits when the sun has not moved enough to
        //cause a visible change, so the cost on mobile is negligible.
        this._skyTimer = window.setInterval(() => this._refreshShadowsAndAtmosphere(), 60_000);

        if (this._homeHourlyData)
        {
            this._renderForCurrentSelection();
        }
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
    //Z-order: this layer pair is added before the helios-buildings-*
    //layers, so buildings still emerge through the disc as opaque
    //islands. The home marker (added after buildings) stays on top
    //of everything.
    private _initCloudCoverDisc(): void
    {
        if (!this.map)
        {
            return;
        }

        //The cloud disc + 100 % ring live as a screen-space SVG overlay
        //in the card (see projectCloudScene + helios-card), projected
        //through _projectScenePoint with anchor at home so every vertex
        //shares the same ground-elevation reference and the rendered
        //shape stays a true circle regardless of terrain.
        //
        //Sweep any leftover map sources / layers that might still be
        //in the style after a hot-reload, so the SVG-only pipeline
        //runs clean.
        for (const lid of ['helios-cloud-disc', 'helios-cloud-disc-ring', 'helios-cloud-ring'])
        {
            if (this.map.getLayer(lid)) this.map.removeLayer(lid);
        }
        if (this.map.getSource('helios-cloud-rings'))
        {
            this.map.removeSource('helios-cloud-rings');
        }
    }

    //Update the disc + ring geometry to reflect the given cloud cover
    //percentage. Called from _renderForCurrentSelection so it ticks
    //both with live time progression and with manual scrubbing.
    //
    //  cloudPct ∈ [0, 100]   , coverage at the home location now
    //
    //The ring (100 % reference) has fixed radius CLOUD_DISC_RADIUS_M.
    //The disc scales linearly: radius = CLOUD_DISC_RADIUS_M * pct/100.
    //At 0 % cloud cover the disc has zero radius, effectively
    //invisible, while the ring stays visible to anchor the gauge.
    //
    //Fixed cloud colour. The disc's *radius* already encodes
    //the cloud-cover percentage (0% = invisible, 100% = full ring);
    //we keep the colour solid so the user-configured cloud-color
    //reads everywhere identically. CLOUD_DISC_OPACITY (set on the
    //layer's fill-opacity) handles the translucency against the
    //basemap so the disc never fully hides what's underneath.
    private _updateCloudCoverDisc(
        cloudPct: number,
        cloudLow:  number = 0,
        cloudMid:  number = 0,
        cloudHigh: number = 0
    ): void
    {
        //Stash the values; the SVG overlay in the card pulls them
        //back via projectCloudScene() on every map transform + clock
        //tick. Per-layer values feed the proportional band sizing
        //inside the disc (low → mid → high, centre to edge).
        this._currentCloudPct  = Math.max(0, Math.min(100, cloudPct));
        this._currentCloudLow  = Math.max(0, Math.min(100, cloudLow));
        this._currentCloudMid  = Math.max(0, Math.min(100, cloudMid));
        this._currentCloudHigh = Math.max(0, Math.min(100, cloudHigh));
    }

    //Project the cloud-cover disc + 100 % reference ring into screen
    //space. Returns null when the engine isn't ready yet (the card
    //then skips rendering this frame). Vertices are computed at sea-
    //level offsets around the home and projected with anchor at the
    //home's terrain elevation, so the resulting polygons stay true
    //circles regardless of the terrain mesh underneath.
    //
    //The disc is split into three concentric bands sized by the
    //per-layer cloud percentages: from the centre outward, low →
    //mid → high. Each band's radial width is proportional to its
    //layer's share of the total (low + mid + high), so a sky with
    //mostly high clouds shows a thick outer band and thin inner
    //ones, and vice versa. The TOTAL disc radius is still driven
    //by the effective cloud cover (unchanged), so the whole disc
    //grows / shrinks as the sky thickens.
    //
    //Geometrically we return three concentric polygons (rLow,
    //rMid = rLow + (mid/total) × R, rHigh = R) plus the existing
    //100 % reference ring. The card stacks them outer-first to
    //get the band appearance.
    public projectCloudScene(): {
        discLow:    Array<{ x: number; y: number }>;
        discMid:    Array<{ x: number; y: number }>;
        discHigh:   Array<{ x: number; y: number }>;
        ring:       Array<{ x: number; y: number }>;
        cloudHex:   string;
        cloudPct:   number;
        cloudLow:   number;
        cloudMid:   number;
        cloudHigh:  number;
    } | null
    {
        if (!this.map || !this._mapReady) return null;

        const pct  = this._currentCloudPct;
        const cLow = this._currentCloudLow;
        const cMid = this._currentCloudMid;
        const cHi  = this._currentCloudHigh;
        const R    = CLOUD_DISC_RADIUS_M * pct / 100;

        //Layer breakdown: each band's outer radius is the cumulative
        //share of low + mid (+ high) over the layer total. When all
        //three layers are zero the disc collapses to the home anchor
        //regardless of the effective percentage — that can only
        //happen with a degenerate weather sample, but the guard
        //below keeps the polygons non-degenerate.
        const total = cLow + cMid + cHi;
        const rLow  = total > 0 ? R * (cLow / total)                : 0;
        const rMid  = total > 0 ? R * ((cLow + cMid) / total)       : 0;
        const rHigh = R;
        const ringR = CLOUD_DISC_RADIUS_M;

        //Geographic circle vertices, not closed: the card emits SVG
        //polygons which carry implicit closure.
        const lowGeo  = buildCirclePolygon(this.homeLon, this.homeLat,
                                           rLow,  CLOUD_CIRCLE_SEGMENTS);
        const midGeo  = buildCirclePolygon(this.homeLon, this.homeLat,
                                           rMid,  CLOUD_CIRCLE_SEGMENTS);
        const highGeo = buildCirclePolygon(this.homeLon, this.homeLat,
                                           rHigh, CLOUD_CIRCLE_SEGMENTS);
        const ringGeo = buildCirclePolygon(this.homeLon, this.homeLat,
                                           ringR, CLOUD_CIRCLE_SEGMENTS);

        //anchorAtHome: every vertex uses the home's queryTerrainElevation
        //rather than its own. That keeps the projected polygon a true
        //circle even when the terrain bends between the home and the
        //disc's edge.
        const projectGeo = (geo: Array<[number, number]>): Array<{ x: number; y: number }> =>
        {
            const out: Array<{ x: number; y: number }> = [];
            for (const [lon, lat] of geo)
            {
                const p = this._projectScenePoint(lon, lat, 0);
                if (p) out.push({ x: p.x, y: p.y });
            }
            return out;
        };

        const discLow  = projectGeo(lowGeo);
        const discMid  = projectGeo(midGeo);
        const discHigh = projectGeo(highGeo);
        const ring     = projectGeo(ringGeo);

        if (discHigh.length < 3 && ring.length < 3) return null;

        const rgb      = this._resolvedCloudRgb();
        const cloudHex = '#'
            + rgb[0].toString(16).padStart(2, '0')
            + rgb[1].toString(16).padStart(2, '0')
            + rgb[2].toString(16).padStart(2, '0');

        return {
            discLow, discMid, discHigh, ring,
            cloudHex, cloudPct: pct,
            cloudLow: cLow, cloudMid: cMid, cloudHigh: cHi
        };
    }

    //Project the home building(s) into screen-space silhouettes.
    //Each home polygon contributes one entry containing the base
    //ring (projected at render_min_height) and the top ring
    //(projected at render_height). The card paints both rings plus
    //a quad per outer-ring edge into the cloud-disc SVG mask, the
    //union covers the exact extruded prism in screen space, even
    //for concave footprints (L, U) where a convex hull would cut
    //a too-large hole and expose terrain at the inner corners.
    //
    //Vertex elevation is queried per-vertex against the live
    //terrain mesh, matching what MapLibre's fill-extrusion shader
    //does internally so the silhouette tracks the rendered
    //extrusion exactly.
    //
    //Returns an empty array until the buildings GeoJSON has landed.
    public projectHomeFootprints(): Array<{
        base: Array<{ x: number; y: number }>;
        top:  Array<{ x: number; y: number }>;
    }>
    {
        if (!this.map || !this._mapReady) return [];
        const home = this._buildingsData?.home;
        if (!home || !home.features.length) return [];

        const out: Array<{
            base: Array<{ x: number; y: number }>;
            top:  Array<{ x: number; y: number }>;
        }> = [];
        for (const feat of home.features)
        {
            const geom = feat.geometry;
            if (!geom) continue;
            const props = (feat.properties ?? {}) as Record<string, unknown>;
            const topH  = typeof props['render_height']     === 'number' ? props['render_height']     as number : 0;
            const baseH = typeof props['render_min_height'] === 'number' ? props['render_min_height'] as number : 0;

            let polygons: number[][][][] | null = null;
            if      (geom.type === 'Polygon')      polygons = [geom.coordinates as number[][][]];
            else if (geom.type === 'MultiPolygon') polygons = geom.coordinates as number[][][][];
            if (!polygons) continue;

            for (const poly of polygons)
            {
                if (!poly.length) continue;
                const outer = poly[0] as number[][];
                if (outer.length < 3) continue;

                const baseRing: Array<{ x: number; y: number }> = [];
                const topRing:  Array<{ x: number; y: number }> = [];
                for (const p of outer)
                {
                    const lon = p[0], lat = p[1];
                    const pBase = this._projectScenePoint(lon, lat, baseH);
                    const pTop  = this._projectScenePoint(lon, lat, topH);
                    //Drop the whole vertex pair if either point is
                    //behind the camera, otherwise the side-wall quad
                    //would shear through the screen.
                    if (!pBase || !pTop) continue;
                    baseRing.push({ x: pBase.x, y: pBase.y });
                    topRing .push({ x: pTop.x,  y: pTop.y  });
                }
                if (baseRing.length >= 3 && topRing.length >= 3)
                {
                    out.push({ base: baseRing, top: topRing });
                }
            }
        }
        return out;
    }

    //LiDAR View active flag. Pushed in by the card when the user
    //toggles the View overlay on, so the LiDAR raster fetch path runs
    //even when cast shadows are disabled in the config. Without this,
    //a user with shadows off would click the button and see an empty
    //canvas because the raster never gets fetched.
    private _lidarViewActive: boolean = false;
    public setLidarViewActive(on: boolean): void
    {
        if (on === this._lidarViewActive) return;
        this._lidarViewActive = on;
        //Going from off→on, kick the fetch path so the raster lands.
        //Going from on→off, no-op: the raster stays cached and the
        //next shadow refresh (if shadows come back on) reuses it.
        if (on) this._ensureLidarFetched();
    }

    //Wire (or rewire after a style reload) the WebGL custom layer that
    //paints the LiDAR View dot cloud on the map's own GL context. The
    //layer instance is created once per engine and reused across style
    //reloads; setStyle wipes layers but the JS object survives, so we
    //re-add it and replay the cached buffer + tunables.
    //
    //All steps that touch MapLibre are wrapped in try / catch: a
    //custom layer onAdd that throws can leave the painter with
    //polluted GL state (bound buffers, attrib enables) and silently
    //kill the basemap for the rest of the session. With the wrap, a
    //bad shader compile or a transient painter state just disables
    //our overlay instead of breaking the whole map.
    //
    //The addLayer call itself is deferred to the next animation frame.
    //style.load can fire before MapLibre's painter has finished
    //binding its default buffers; addLayer then synchronously invokes
    //our onAdd against a half-initialised context, which is exactly
    //the "map renders black until page refresh" symptom.
    private _initLidarViewLayer(): void
    {
        if (!this.map) return;
        try
        {
            if (!this._lidarViewLayer)
            {
                this._lidarViewLayer = new LidarViewLayer({
                    homeLat: this.homeLat,
                    homeLon: this.homeLon
                });
            }
            this._lidarViewLayer.setHome(this.homeLat, this.homeLon);
            this._pushLidarViewConfig();

            const layer  = this._lidarViewLayer;
            const raster = this._lidarRaster;
            window.requestAnimationFrame(() =>
            {
                if (!this.map) return;
                try
                {
                    if (!this.map.getLayer(layer.id))
                    {
                        this.map.addLayer(layer);
                    }
                    if (raster) layer.setData(raster);
                }
                catch (err)
                {
                    console.warn('[HELIOS] LiDAR view layer attach failed:', err);
                }
            });
        }
        catch (err)
        {
            console.warn('[HELIOS] LiDAR view layer init failed:', err);
        }
    }

    //Read all LiDAR View visual knobs off the current config and push
    //them to the layer. Called on init and whenever updateConfig sees a
    //relevant key change.
    private _pushLidarViewConfig(): void
    {
        if (!this._lidarViewLayer) return;
        const [fullR, fadeR] = this._lidarViewFadeRange();
        this._lidarViewLayer.setFadeRange(fullR, fadeR);
        this._lidarViewLayer.setPointSizePx(this._lidarViewPointSizePx());
        this._lidarViewLayer.setColor(this._lidarViewColorRgba());
        this._lidarViewLayer.setWireframeEnabled(this._lidarViewWireframeEnabled());
        this._lidarViewLayer.setWireframeColor(this._lidarViewWireframeRgba());
    }

    //Fade alpha multiplier in [0..1]. Driven by the card's enter/exit
    //animation; the engine just forwards. When the View is off the
    //card keeps this at 0, the layer short-circuits its draw call.
    public setLidarViewFadeAlpha(alpha: number): void
    {
        this._lidarViewLayer?.setAlphaFade(alpha);
    }

    //Distance-based opacity fall-off bounds for the View. Both
    //thresholds are fixed: full opacity inside
    //LIDAR_VIEW_FULL_OPACITY_RADIUS_M, smooth fade out at
    //LIDAR_VIEW_DISPLAY_RADIUS_M. Decoupled from building-radius on
    //purpose, so the LiDAR overlay is always painted at a tight,
    //consistent disc no matter how far the underlying raster
    //actually extends.
    private _lidarViewFadeRange(): [fullMeters: number, fadeMeters: number]
    {
        return [LIDAR_VIEW_FULL_OPACITY_RADIUS_M, LIDAR_VIEW_DISPLAY_RADIUS_M];
    }

    private _lidarViewPointSizePx(): number
    {
        const raw = this.cfg['lidar-view-point-size'];
        const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
        if (!isFinite(n) || n <= 0) return DEFAULT_LIDAR_VIEW_POINT_SIZE_PX;
        return Math.min(6, n);
    }

    private _lidarViewColorRgba(): [number, number, number, number]
    {
        const rawColor = this.cfg['lidar-view-point-color'];
        const hex = typeof rawColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(rawColor.trim())
            ? rawColor.trim()
            : defaultLidarViewPointColor(this.cfg['card-theme']);
        const rawOpa = this.cfg['lidar-view-point-opacity'];
        const opa = typeof rawOpa === 'number' ? rawOpa : parseFloat(String(rawOpa ?? ''));
        const alpha = isFinite(opa)
            ? Math.max(0, Math.min(1, opa))
            : DEFAULT_LIDAR_VIEW_POINT_OPACITY;
        const rgb = this._hexToRgb01(hex);
        return [rgb[0], rgb[1], rgb[2], alpha];
    }

    private _lidarViewWireframeEnabled(): boolean
    {
        const raw = this.cfg['lidar-view-wireframe'];
        if (typeof raw === 'boolean') return raw;
        if (typeof raw === 'string')
        {
            const s = raw.trim().toLowerCase();
            if (s === 'true'  || s === '1' || s === 'on'  || s === 'yes') return true;
            if (s === 'false' || s === '0' || s === 'off' || s === 'no')  return false;
        }
        return DEFAULT_LIDAR_VIEW_WIREFRAME;
    }

    private _lidarViewWireframeRgba(): [number, number, number, number]
    {
        const rawColor = this.cfg['lidar-view-wireframe-color'];
        const hex = typeof rawColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(rawColor.trim())
            ? rawColor.trim()
            : defaultLidarViewWireframeColor(this.cfg['card-theme']);
        const rawOpa = this.cfg['lidar-view-wireframe-opacity'];
        const opa = typeof rawOpa === 'number' ? rawOpa : parseFloat(String(rawOpa ?? ''));
        const alpha = isFinite(opa)
            ? Math.max(0, Math.min(1, opa))
            : DEFAULT_LIDAR_VIEW_WIREFRAME_OPACITY;
        const rgb = this._hexToRgb01(hex);
        return [rgb[0], rgb[1], rgb[2], alpha];
    }

    private _hexToRgb01(hex: string): [number, number, number]
    {
        let h = hex.replace('#', '');
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        if (h.length === 8) h = h.slice(0, 6);
        const r = parseInt(h.slice(0, 2), 16) / 255;
        const g = parseInt(h.slice(2, 4), 16) / 255;
        const b = parseInt(h.slice(4, 6), 16) / 255;
        return [
            isFinite(r) ? r : 1,
            isFinite(g) ? g : 1,
            isFinite(b) ? b : 1
        ];
    }

    //LiDAR View support, exposed to the card.
    //
    //getActiveLidarSourceId returns the id of the provider that
    //covers the home (e.g. 'de-nrw-ndom'), or null when no provider
    //covers it. Resolved on-demand against `resolveLidarSource`
    //rather than reading the cached `_lidarSourceId` field, so the
    //answer is correct from the very first render of the card,
    //independent of whether the shadow fetch path has had a chance
    //to run yet (or whether shadows are even enabled in the config).
    //The resolver itself is cheap, ~5 bbox comparisons.
    public getActiveLidarSourceId(): string | null
    {
        const provider = resolveLidarSource(this.homeLat, this.homeLon, this.cfg);
        return provider ? provider.id : null;
    }

    //Toggle MapTiler's symbol layers (road names, house numbers,
    //POIs, place names) on or off based on the `show-labels` config.
    //Symbol-type layers are the canonical container for text + icon
    //rendering in MapLibre styles; flipping their `visibility` layout
    //property is enough to hide everything text-based without
    //touching the underlying geometry (roads, water, terrain). Our
    //own `helios-*` layers are skipped defensively in case a future
    //feature adds a symbol layer of our own.
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

    //Resolves the configured building radius (metres). Falls back to
    //DEFAULT_BUILDING_RADIUS_M and clamps to a sane range so a stray
    //editor value can't accidentally trigger fetching dozens of tiles.
    private _buildingRadiusMeters(): number
    {
        const v = Number(this.cfg['building-radius']);
        if (!Number.isFinite(v) || v <= 0)
        {
            return DEFAULT_BUILDING_RADIUS_M;
        }
        //Hard ceiling at 500 m. Past that the basemap / LiDAR fetch
        //and the per-frame projection start to chug; the slider in
        //the editor also caps at 500 so anything above can only come
        //from a hand-edited YAML config.
        return Math.min(500, Math.max(20, v));
    }

    //Resolves the configured surroundings opacity (0..1). Falls back
    //to DEFAULT_BUILDING_OPACITY for missing or invalid input.
    private _buildingOpacity(): number
    {
        const v = Number(this.cfg['building-opacity']);
        if (!Number.isFinite(v))
        {
            return DEFAULT_BUILDING_OPACITY;
        }
        return Math.min(1, Math.max(0, v));
    }

    //Resolves the cluster radius (metres), every building whose
    //centroid is within this radius (or which contains the home
    //point) becomes part of the home group at full opacity. Allows
    //attached verandas / outbuildings to read as one with the main
    //house. 0 = legacy "single-polygon home" behaviour.
    private _buildingClusterRadiusMeters(): number
    {
        const v = Number(this.cfg['building-cluster-radius']);
        if (!Number.isFinite(v) || v < 0)
        {
            return DEFAULT_BUILDING_CLUSTER_RADIUS_M;
        }
        return Math.min(100, v);
    }

    //Resolves the configured building base colour. Falls back to the
    //neutral grey if missing or malformed.
    private _buildingColor(): string
    {
        const v = String(this.cfg['building-color'] ?? '').trim();
        return /^#[0-9a-fA-F]{6}$/.test(v) ? v : DEFAULT_BUILDING_COLOR_HEX;
    }

    //Adds the two custom building layers around the home:
    //
    //  - helios-buildings-surroundings : every building within the
    //    configured radius of the home, painted at the configured
    //    opacity. Urban context without competing with the data overlays.
    //  - helios-buildings-home : the polygon containing the home
    //    coordinates, painted at full opacity in the same neutral grey.
    //    Reads as the focal point.
    //
    //The building GeoJSON is fetched once per (home, radius) combo
    //in engine/buildings.ts; subsequent calls (e.g. on theme switch,
    //which rebuilds the whole style) reuse the cached data.
    private _addBuildings(): void
    {
        bumpStat('addBuildingsCalls');
        if (!this.map)
        {
            return;
        }

        //Drop any stale helios-buildings* layer so re-runs of
        //_addBuildings (on style reload, theme switch, etc.) are
        //idempotent.
        for (const lid of [
            'helios-buildings',
            'helios-buildings-surroundings',
            'helios-buildings-home',
            'helios-buildings-surroundings-outline',
            'helios-buildings-home-outline',
            'helios-buildings-home-outline-glow'
        ])
        {
            if (this.map.getLayer(lid)) this.map.removeLayer(lid);
        }

        //Suppress every native building layer the active style ships
        //so they don't Z-fight against helios-buildings-* extrusions.
        //
        //MapLibre 5 styles can be assembled from style "imports". For
        //imported layers, `setLayoutProperty('visibility','none')` is
        //a silent no-op against the bare id and `removeLayer(bareId)`
        //may be too. The robust path: per import, set config flags off
        //(`3dBuildings`, `buildings3d`, etc.) AND attempt removal /
        //paint-zeroing under the scoped id `${importId}\\${layerId}`.
        //Paint pipelines and layout pipelines have independent guards
        //inside MapLibre, so opacity:0 may land even when visibility:
        //none didn't, we use both belt and suspenders.
        const styleObj = this.map.getStyle() as {
            layers?:  Array<{ id: string; type: string; 'source-layer'?: string }>;
            imports?: Array<{ id: string }>;
        };
        const allLayers = styleObj.layers ?? [];
        const imports   = styleObj.imports ?? [];
        const importIds = imports.map(i => i.id).filter(Boolean);

        //Identify every native building layer (3D or 2D).
        const buildingLayerIds: string[] = [];
        for (const l of allLayers)
        {
            if (l.id === 'helios-buildings-surroundings'
             || l.id === 'helios-buildings-home') continue;
            const sl = l['source-layer'];
            const isBuildingSrc = sl === 'building' || sl === 'building_3d';
            const isExtrusion   = l.type === 'fill-extrusion';
            const idMentions    = typeof l.id === 'string' && l.id.toLowerCase().includes('building');
            if (isBuildingSrc || isExtrusion || idMentions)
            {
                buildingLayerIds.push(l.id);
            }
        }

        //Strategy A, toggle the MapTiler v4 schema flags off, on
        //every import. Each flag is best-effort: the wrong key just
        //throws and is ignored.
        const buildingConfigKeys = [
            '3dBuildings',    'buildings3d',     'show3dBuildings',
            'show3DBuildings','building3D',      '2dBuildings',
            'buildings',      'showBuildings',   'show2dBuildings'
        ];
        for (const imp of imports)
        {
            for (const key of buildingConfigKeys)
            {
                try { (this.map as unknown as {
                    setConfigProperty: (id: string, k: string, v: unknown) => void
                }).setConfigProperty(imp.id, key, false); }
                catch (_) {}
            }
        }

        //Strategy B, for each building layer, attempt removal AND
        //paint-zeroing, using both the bare id and every scoped
        //variant `${importId}\\${layerId}`.
        const idCandidates = (layerId: string): string[] =>
        {
            const list = [layerId];
            for (const iid of importIds) list.push(`${iid}\\${layerId}`);
            return list;
        };

        for (const layerId of buildingLayerIds)
        {
            for (const cand of idCandidates(layerId))
            {
                //Skip candidates that don't correspond to a real layer
                //in the merged style. Calling set* on a missing layer
                //makes MapLibre fire an "error" event the engine then
                //echoes, gating at the source removes both the noise
                //and the wasted dispatch.
                if (!this.map.getLayer(cand)) continue;

                try { this.map.removeLayer(cand); }
                catch (_) {}

                //If removeLayer worked, the layer is gone, done. The
                //paint / layout fallbacks below are for the rare case
                //of imported layers where removeLayer is a silent no-op.
                if (!this.map.getLayer(cand)) continue;

                try { this.map.setLayoutProperty(cand, 'visibility', 'none'); }
                catch (_) {}
                try { this.map.setPaintProperty(cand, 'fill-extrusion-opacity', 0); }
                catch (_) {}
                try { this.map.setPaintProperty(cand, 'fill-extrusion-height',  0); }
                catch (_) {}
                try { this.map.setPaintProperty(cand, 'fill-opacity', 0); }
                catch (_) {}
            }
        }

        const opacity      = this._buildingOpacity();
        const baseColor    = this._buildingColor();
        const homeData     = this._buildingsData?.home
                          ?? { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;
        const surrData     = this._buildingsData?.surroundings
                          ?? { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;

        if (!this.map.getSource('helios-buildings-surroundings-src'))
        {
            this.map.addSource('helios-buildings-surroundings-src',
            {
                type: 'geojson',
                data: surrData
            });
        }
        else
        {
            (this.map.getSource('helios-buildings-surroundings-src') as maplibregl.GeoJSONSource)
                .setData(surrData);
        }

        if (!this.map.getSource('helios-buildings-home-src'))
        {
            this.map.addSource('helios-buildings-home-src',
            {
                type: 'geojson',
                data: homeData
            });
        }
        else
        {
            (this.map.getSource('helios-buildings-home-src') as maplibregl.GeoJSONSource)
                .setData(homeData);
        }

        //Ground-projected shadows. Rendered as a single image source
        //(black mask painted from shadow polygons on an offscreen
        //canvas) drawn BEFORE the building extrusions so buildings
        //hide the under-building part of their own shadow; the
        //visible shadow is the spillover on the ground.
        //
        //Per-pixel rendering avoids the alpha-compositing saturation
        //we'd get from many overlapping fill polygons in a dense
        //forest. The image source bounds match the building visibility
        //bbox so the raster is exactly the same disc as the rendered
        //surroundings.
        const shadowBounds: ShadowBoundsCorners = shadowBoundsCornersLL(this.homeLat, this.homeLon, this._buildingRadiusMeters());
        if (!this.map.getSource('helios-building-shadows-src'))
        {
            this.map.addSource('helios-building-shadows-src',
            {
                type:        'image',
                url:         BLANK_SHADOW_DATA_URL,
                coordinates: shadowBounds
            });
        }
        const shadowOpa = this._shadowOpacity();
        if (!this.map.getLayer('helios-building-shadows'))
        {
            this.map.addLayer(
            {
                id:     'helios-building-shadows',
                source: 'helios-building-shadows-src',
                type:   'raster',
                paint:
                {
                    'raster-opacity':       shadowOpa,
                    'raster-fade-duration': 0,
                    'raster-resampling':    'linear'
                }
            });
        }

        //Surroundings first, then home, so the home draws on top in
        //the rare case the polygons overlap (the home footprint
        //should also be absent from the surroundings collection, but
        //we don't rely on that for layering correctness).
        this.map.addLayer(
        {
            id:     'helios-buildings-surroundings',
            source: 'helios-buildings-surroundings-src',
            type:   'fill-extrusion',
            paint:
            {
                'fill-extrusion-color':   baseColor,
                'fill-extrusion-height':  ['get', 'render_height'],
                'fill-extrusion-base':    ['get', 'render_min_height'],
                'fill-extrusion-opacity': opacity
            }
        });

        this.map.addLayer(
        {
            id:     'helios-buildings-home',
            source: 'helios-buildings-home-src',
            type:   'fill-extrusion',
            paint:
            {
                'fill-extrusion-color':   baseColor,
                'fill-extrusion-height':  ['get', 'render_height'],
                'fill-extrusion-base':    ['get', 'render_min_height'],
                'fill-extrusion-opacity': 1
            }
        });

        //Cell-shaded outlines: a thin black line on the surroundings'
        //ground footprint, a thicker line on the home so the focal
        //building reads even when its colour matches the surroundings.
        //Drawn ON TOP of the extrusions so the outlines sit over the
        //building edges at ground level.
        this.map.addLayer(
        {
            id:     'helios-buildings-surroundings-outline',
            source: 'helios-buildings-surroundings-src',
            type:   'line',
            paint:
            {
                'line-color':   '#000000',
                'line-width':   1,
                'line-opacity': 0.35
            }
        });
        //Kick off the MapTiler buildings fetch in the background.
        //The shadow source is wired and will populate as soon as the
        //buildings GeoJSON lands.
        this._ensureBuildingsFetched();

        //Wire the LiDAR shadow pipeline. No-op when shadows are off
        //or the home is outside any provider's coverage.
        this._ensureLidarFetched();
    }

    //Idempotent fetch helper. Reuses _buildingsData across style
    //reloads; only re-hits the MapTiler API when the home position
    //or the configured radius actually changed.
    private _ensureBuildingsFetched(): void
    {
        if (!this.map)
        {
            return;
        }
        const radius        = this._buildingRadiusMeters();
        const clusterRadius = this._buildingClusterRadiusMeters();
        const key = `${this.homeLat.toFixed(6)}|${this.homeLon.toFixed(6)}|${radius}|${clusterRadius}`;

        if (this._buildingsData && this._buildingsFetchKey === key)
        {
            return;
        }

        //Abort any in-flight request so a rapid radius change
        //doesn't leave a slow tile from the previous fetch racing
        //the new one to populate the sources.
        this._buildingsAbort?.abort();
        const ac = new AbortController();
        this._buildingsAbort   = ac;
        this._buildingsFetchKey = key;
        bumpStat('buildingFetchStarts');

        fetchBuildingsAroundHome(
        {
            homeLon:             this.homeLon,
            homeLat:             this.homeLat,
            radiusMeters:        radius,
            clusterRadiusMeters: clusterRadius,
            signal:              ac.signal
        })
        .then(result =>
        {
            if (ac.signal.aborted || !this.map) return;
            this._buildingsData = result;
            this._pushRenderableSources();
            //Buildings just arrived, the shadow source is still empty,
            //bypass the "sun hardly moved" guard so the next call paints
            //a full atmosphere pass and populates the shadow polygons.
            this._lastAtmosphereAlt = -999;
            this._refreshShadowsAndAtmosphere();
        })
        .catch(err =>
        {
            if ((err as { name?: string })?.name === 'AbortError') return;
            console.warn('[HELIOS] Buildings fetch failed:', err);
        });
    }

    //Wire up the LiDAR shadow pipeline for the current home + precision
    //setting. Idempotent: safe to call after any config / position
    //change.
    //
    //  - Resolves the country provider that covers the home (France
    //    HD only for now, see engine/lidar.ts).
    //  - When shadows are enabled AND a provider matches, fires one
    //    radius-based fetch against the provider; the result is a
    //    FeatureCollection of consolidated shadow polygons fed to the
    //    shadow projector.
    //  - When shadows are disabled or no provider matches, clears any
    //    cached features so the next shadow refresh falls back to the
    //    MapTiler footprints (or to no shadows if disabled).
    private _ensureLidarFetched(): void
    {
        if (!this.map) return;

        const provider = resolveLidarSource(this.homeLat, this.homeLon, this.cfg);
        //Bail when nothing wants the data: no provider covers the
        //home, OR the user has shadows off AND no LiDAR View open.
        //The View toggle lets the raster fetch happen even when cast
        //shadows are off, so the View overlay can show data without
        //requiring the user to re-enable shadows just to inspect.
        if (!provider || (!this._shadowsEnabled() && !this._lidarViewActive))
        {
            this._lidarShadowFeatures    = null;
            this._lidarShadowDiagnostics = null;
            this._lidarShadowKey         = '';
            this._lidarRaster            = null;
            this._lidarViewLayer?.setData(null);
            this._lidarShadowAbort?.abort();
            this._lidarShadowAbort       = undefined;
            return;
        }

        const level      = this._lidarPrecisionLevel();
        const radius     = this._buildingRadiusMeters();
        //rasterSize derives from the provider's native cell pitch, the
        //precision multiplier and the requested radius, so each fetched
        //cell maps to a real upstream sample rather than a server-side
        //interpolation. Clamped to the pipeline's own [min, max] so a
        //tiny radius can't ask for fewer cells than the flood fill
        //needs and a huge radius can't blow the WMS payload.
        const effectivePitch = provider.nativeCellPitchMeters * LIDAR_PRECISION_PITCH_MULT[level];
        const rawCells       = Math.round((2 * radius) / Math.max(0.01, effectivePitch));
        const rasterSize     = Math.min(
            RASTER_DEFAULTS.maxRasterSize,
            Math.max(RASTER_DEFAULTS.minRasterSize, rawCells)
        );
        const key = `${this.homeLat.toFixed(6)}|${this.homeLon.toFixed(6)}|${radius}|${rasterSize}`;
        if (this._lidarShadowKey === key && this._lidarShadowFeatures) return;

        this._lidarShadowAbort?.abort();
        const ac = new AbortController();
        this._lidarShadowAbort = ac;
        this._lidarShadowKey   = key;

        try { this.onShadowComputeStart?.(); }
        catch (_) {}

        provider.fetchShadowRegions({
            homeLat:          this.homeLat,
            homeLon:          this.homeLon,
            radiusMeters:     radius,
            rasterSize,
            cropRadiusMeters: radius,
            signal:           ac.signal
        })
        .then(res =>
        {
            if (ac.signal.aborted || !this.map) return;
            this._lidarShadowFeatures    = res.features;
            this._lidarShadowDiagnostics = res.diagnostics;
            this._lidarRaster            = res.raster ?? null;
            //Pump the fresh raster to the WebGL LiDAR View layer so
            //the dot cloud refreshes as soon as the fetch lands. No-op
            //when the View has never been opened, the layer just sits
            //with alphaFade=0 and the buffer is ready when the user
            //eventually clicks the toggle.
            this._lidarViewLayer?.setData(this._lidarRaster);
            //New shadow source available, force a full atmosphere /
            //shadow refresh on the next call rather than waiting for
            //the sun to move past the 0.5 deg threshold.
            this._lastAtmosphereAlt = -999;
            this._refreshShadowsAndAtmosphere();
        })
        .catch(err =>
        {
            if ((err as { name?: string })?.name === 'AbortError') return;
            console.warn('[HELIOS] LiDAR shadow fetch failed:', err);
            this._lidarShadowFeatures    = null;
            this._lidarShadowDiagnostics = null;
            this._lidarShadowKey         = '';
        })
        .finally(() =>
        {
            if (ac.signal.aborted) return;
            try { this.onShadowComputeEnd?.(); }
            catch (_) {}
        });
    }

    //Pushes the MapTiler footprints into the building rendering
    //sources. Buildings are always MapTiler-driven; LiDAR data is
    //used exclusively for shadow projection (see _refreshShadowsAndAtmosphere).
    private _pushRenderableSources(): void
    {
        if (!this.map) return;
        const homeSrc = this.map.getSource('helios-buildings-home-src')         as maplibregl.GeoJSONSource | undefined;
        const surrSrc = this.map.getSource('helios-buildings-surroundings-src') as maplibregl.GeoJSONSource | undefined;
        const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
        homeSrc?.setData(this._buildingsData?.home         ?? empty);
        surrSrc?.setData(this._buildingsData?.surroundings ?? empty);
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
    //mobile, repeating the full pass once a minute would burn frames
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

        //Night-shade overlay, the primary day/night cue.
        //Opacity ramps from 0 (day) up to ~0.65 at deep night, with a tinted
        //warm pass through the sunrise/sunset window so the satellite stays
        //readable but visibly amber-shifted near the horizon.
        if (this.map.getLayer('helios-night-shade'))
        {
            try
            {
                const ns = nightShadeForAltitude(altitude);
                this.map.setPaintProperty('helios-night-shade', 'fill-color',   ns.color);
                this.map.setPaintProperty('helios-night-shade', 'fill-opacity', ns.opacity);
            }
            catch (_) {}
        }

        //Buildings, modulate their colour by sun altitude so they
        //participate in the time-of-day mood. We blend the configured
        //daylight reference towards a cool dark ink at night and
        //towards a warm tint around sunrise/sunset.
        try
        {
            const buildingHex = buildingColorForAltitude(this._buildingColor(), altitude);
            for (const lid of ['helios-buildings-surroundings', 'helios-buildings-home'])
            {
                if (this.map.getLayer(lid))
                {
                    this.map.setPaintProperty(lid, 'fill-extrusion-color', buildingHex);
                }
            }
        }
        catch (_) {}

        //Sun-driven face shading on the building extrusions. MapLibre
        //positions the light as [radial, azimuth, polar]: azimuth in
        //degrees clockwise from north (matches getSunPosition's
        //convention exactly), polar from 0 (directly above) to 180
        //(directly below). With anchor='map' the light follows the
        //ground orientation so rotating the camera does not rotate
        //the lighting, which is what we want when scrubbing time.
        //
        //At and below the horizon we clamp the polar angle just shy
        //of 90 deg, the building tints above already convey night, a
        //below-horizon polar would invert the face shading and look
        //wrong on the few buildings that remain visible at twilight.
        try
        {
            this.map.setLight(
            {
                anchor:    'map',
                position:  [1.15, azimuth, sunLightPolarFromAltitude(altitude)],
                color:     '#ffffff',
                intensity: 0.5
            });
        }
        catch (_) {}

        //Map cast-shadow polygons. Source selection:
        //  - shadow toggle off               -> empty
        //  - LiDAR features available        -> LiDAR-consolidated regions
        //                                       (bâtiments + végétation)
        //  - LiDAR unavailable / out of cov. -> MapTiler footprints
        try
        {
            const shadowsOn = this._shadowsEnabled();
            const radius    = this._buildingRadiusMeters();
            //Signature of every input the shadow raster depends on.
            //Same signature = same image; the project + canvas paint +
            //PNG encode round-trip can be skipped entirely. Altitude
            //and azimuth are rounded to 0.01 deg, ~36 seconds of sun
            //motion, well below the visual threshold for a shadow shift.
            const lidarRef = this._lidarShadowFeatures;
            const sig =
                `${shadowsOn ? '1' : '0'}` +
                `|${altitude.toFixed(2)}|${azimuth.toFixed(2)}` +
                `|${this.homeLat.toFixed(6)}|${this.homeLon.toFixed(6)}` +
                `|${radius}` +
                `|L${lidarRef ? lidarRef.features.length : -1}` +
                `|B${this._buildingsData
                    ? (this._buildingsData.home.features.length
                       + this._buildingsData.surroundings.features.length)
                    : -1}`;
            if (sig !== this._lastShadowSig)
            {
                this._lastShadowSig = sig;
                let input: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
                if (shadowsOn)
                {
                    if (lidarRef && lidarRef.features.length > 0)
                    {
                        input = lidarRef;
                    }
                    else if (this._buildingsData)
                    {
                        input = {
                            type:     'FeatureCollection',
                            features: [
                                ...this._buildingsData.home.features,
                                ...this._buildingsData.surroundings.features
                            ]
                        };
                    }
                }
                const projected = projectExtrusionShadows(input,
                {
                    sunAzimuthDeg:    azimuth,
                    sunAltitudeDeg:   altitude,
                    homeLat:          this.homeLat,
                    //Clip shadows to the building visibility disc so
                    //they never extend past the rendered surroundings.
                    clipCenterLat:    this.homeLat,
                    clipCenterLon:    this.homeLon,
                    clipRadiusMeters: radius
                });
                if (this.map)
                {
                    if (!this._shadowCanvas)
                    {
                        this._shadowCanvas = document.createElement('canvas');
                        this._shadowCanvas.width  = SHADOW_RASTER_SIZE;
                        this._shadowCanvas.height = SHADOW_RASTER_SIZE;
                    }
                    paintShadowRaster(
                        this.map,
                        this._shadowCanvas,
                        projected,
                        shadowBoundsCornersLL(this.homeLat, this.homeLon, this._buildingRadiusMeters())
                    );
                }
            }
        }
        catch (_) {}
    }

    //Precision is fixed to 'high' (multi-model median). The function
    //is kept so the rest of the engine stays precision-aware if a
    //tier is added later.
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
            //Single home-point fetch with elevation. The home point is
            //the only weather source, surrounding context is rendered
            //from the same hourly series.
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
                //Refresh every 10 min (was 1 h). Open-Meteo
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

    //"Reset view", re-anchor the camera on the home and restore the
    //default pitch/bearing. The interactive camera is locked, so this
    //is an animation-only entry point: resting target for scripted
    //motions (intro orbit, narrative tilt, sun-vs-shadow flyovers...)
    //and one-tap reset if any of those leaves the camera off-pose.
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
            //above, recentering must restore the resting pose,
            //not flip the orientation.
            bearing:  this.homeLat >= 0 ? 180 : 0,
            duration: dur
        });
    }

    _detailMode          = false;
    //In-flight detail-mode dive tween. Cancelled on every fresh
    //setDetailMode call so a rapid click-exit-click can't stack
    //two animations driving the same camera.
    _detailDiveRaf?: number;
    //Wall-clock timestamp until which fresh user gestures are
    //ignored. Bumped on detail-mode exit; the card reads it via
    //isUserGestureSuppressed() to filter timeline scrubs the same
    //way the canvas drag-rotate handler does.
    _postExitCooldownUntil = 0;

    public setDetailMode(on: boolean): void
    {
        _setDetailMode(this, on);
    }

    //Wipe every cached Open-Meteo payload from localStorage, drop
    //the engine's in-memory weather snapshot, and trigger a fresh
    //fetch. Used by the editor's "reset data cache" button.
    //Returns the count of cached payloads removed (purely
    //informational for the UI to show a quick confirmation).
    public resetDataCache(): number
    {
        const cleared = clearWeatherCache();
        this._homeHourlyData = null;
        this._refreshWeather(this._fetchLat, this._fetchLon);
        return cleared;
    }


    //Diff-and-rebuild of the small green marker spheres placed at
    //each pv-array entry whose lat/lon is set AND meaningfully
    //different from the home position. Cheap to do unconditionally
    //(most installs have zero arrays with coords set, so the loop
    //is empty in the common case). Called from updateConfig and
    //from the engine's init path so a freshly loaded card with
    //pre-set per-array coords already shows the spheres.
    private _refreshPvArrayMarkers(): void
    {
        if (!this.map) return;

        const HOME_PROXIMITY_M = 10;  //treat <10 m diff as "at home"
        const pvHex = (() =>
        {
            const raw = this.cfg['pv-color'];
            if (typeof raw === 'string' && /^#?[0-9a-f]{6}$/i.test(raw.trim()))
            {
                const s = raw.trim();
                return s.startsWith('#') ? s : `#${s}`;
            }
            return '#27B36B';
        })();

        const positions: { lat: number; lon: number }[] = [];
        const raw = this.cfg['pv-arrays'];
        if (Array.isArray(raw))
        {
            for (const entry of raw)
            {
                if (!entry || typeof entry !== 'object') continue;
                const e = entry as Record<string, unknown>;
                const lat = typeof e['latitude']  === 'number' ? e['latitude']  : parseFloat(String(e['latitude']  ?? ''));
                const lon = typeof e['longitude'] === 'number' ? e['longitude'] : parseFloat(String(e['longitude'] ?? ''));
                if (!isFinite(lat) || !isFinite(lon))            continue;
                if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
                if (geoDistM(lat, lon, this.homeLat, this.homeLon) < HOME_PROXIMITY_M) continue;
                positions.push({ lat, lon });
            }
        }

        //Marker glyph: inline SVG of the MDI solar-panel icon, sized
        //and coloured to match the configured PV palette. A
        //surrounding white halo (drop-shadow) keeps the icon
        //legible on dark basemaps without the heavier "pin" chrome
        //that the default MapLibre Marker draws.
        const buildMarkerEl = (color: string): HTMLDivElement =>
        {
            const el = document.createElement('div');
            el.className = 'helios-pv-array-marker';
            el.style.cssText =
                'width:24px;height:24px;display:flex;'
              + 'align-items:center;justify-content:center;'
              + 'pointer-events:none;'
              + 'filter:drop-shadow(0 0 1.5px #ffffff) drop-shadow(0 1px 2px rgba(0,0,0,0.45));';
            el.innerHTML =
                `<svg viewBox="0 0 24 24" width="24" height="24" fill="${color}" aria-hidden="true">`
              + '<path d="M20 4H4C2.9 4 2 4.9 2 6V20H4V18H20V20H22V6C22 4.9 21.1 4 20 4M4 6H20V8H4V6M4 10H20V12H4V10M4 14H20V16H4V14Z"/>'
              + '</svg>';
            return el;
        };

        //Reconcile against existing markers. Simplest approach for
        //a list capped at PV_ARRAYS_MAX (6): tear down and rebuild
        //when the lengths differ; otherwise just update positions
        //in place. Either way, exactly N markers exist after the
        //call, with no leftovers from previous configs.
        if (this._pvArrayMarkers.length !== positions.length)
        {
            for (const m of this._pvArrayMarkers) m.remove();
            this._pvArrayMarkers = [];
            for (const p of positions)
            {
                const marker = new maplibregl.Marker({ element: buildMarkerEl(pvHex) })
                    .setLngLat([p.lon, p.lat])
                    .addTo(this.map);
                this._pvArrayMarkers.push(marker);
            }
        }
        else
        {
            for (let i = 0; i < positions.length; i++)
            {
                this._pvArrayMarkers[i].setLngLat([positions[i].lon, positions[i].lat]);
                //Colour might have changed via the PV colour picker
                //even if the position list didn't. Re-paint the SVG
                //fill rather than rebuilding the element so MapLibre
                //doesn't have to re-anchor the marker.
                const el = this._pvArrayMarkers[i].getElement();
                const svgPath = el?.querySelector('svg path');
                if (svgPath) svgPath.parentElement?.setAttribute('fill', pvHex);
            }
        }
    }

    //True while the post-exit cooldown is active. The card consults
    //this to gate timeline scrubs; the engine consults it internally
    //for the canvas drag-rotate. Both surfaces read the same clock so
    //the suppression window is symmetric across input sources.
    public isUserGestureSuppressed(): boolean
    {
        return Date.now() < this._postExitCooldownUntil;
    }

    public isDetailMode(): boolean
    {
        return this._detailMode;
    }

    //Compute the screen-space layout of the on-map readout chips and
    //the leader lines that tie them to the home / on-ground ring.
    //
    //  cloudLabel, where the cloud-cover chip should be drawn (in
    //               CSS pixels, relative to the map canvas). Sits to
    //               the screen-LEFT of the cloud disc, just outside
    //               the 100 % reference ring.
    //  pvLabel   , where the optional PV production chip should be
    //               drawn. Sits just below the home so the chip is
    //               read as the home's "production" badge. The SoC
    //               and Power chips sit on a shared shelf above it,
    //               so the cluster has the PV chip at the bottom,
    //               the home in the middle of the L-leaders, and
    //               the battery chips at the top.
    //  batterySocLabel  , battery State-of-Charge chip (icon + %).
    //               Sits on the shelf, to the LEFT of the home's
    //               vertical axis, connected to PV by an L polyline
    //               (PV top-left → up → left → SoC right edge).
    //               Static (no flow direction to encode).
    //  batteryPowerLabel, battery Power chip (icon + signed W/kW).
    //               Sits on the shelf, to the RIGHT of the home's
    //               vertical axis, connected to PV by an L polyline
    //               (PV top-right → up → right → Power left edge).
    //               Animated dashes + arrow tracking the sign of
    //               the live power.
    //  ringEdge  , projected position of the cloud disc's 100 %
    //               reference ring edge, in the hemisphere-aware
    //               anchor direction (east of home in NH, west in
    //               SH). The card uses (home, ringEdge) plus the
    //               live cloud-cover percentage to interpolate the
    //               actual fill-disc edge along the same direction.
    //  home      , the projected home point, used as the anchor for
    //               the PV / battery chip leader lines and as the
    //               centre of the cloud fill disc.
    //
    //Returns null when the map isn't ready yet, the card treats
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
        //  NH (default bearing 180° → south-up) → north-east of home
        //  SH (default bearing   0° → north-up) → south-west of home
        //Both pick the side that projects to the LOWER-LEFT of screen
        //at the hemisphere's default bearing, putting the cloud chip
        //away from the irradiance chip's natural top-of-arc position
        //and giving each readout its own quadrant. Once anchored to a
        //single lon/lat the chip orbits the home smoothly under user
        //rotation rather than jumping between sampled estimates.
        const lat0   = this.homeLat;
        const cosLat = Math.cos(lat0 * Math.PI / 180);
        const baseDE = lat0 >= 0 ? CLOUD_DISC_RADIUS_M : -CLOUD_DISC_RADIUS_M;
        //Rotate the base (east in NH, west in SH) by +45° CCW in the
        //(east, north) world frame. Symmetrical signs land NH at NE
        //and SH at SW, both of which project to screen-lower-left at
        //the hemisphere's resting bearing.
        const ROT      = Math.PI / 4;
        const anchorDE = baseDE * Math.cos(ROT);
        const anchorDN = baseDE * Math.sin(ROT);
        const anchorDLng = anchorDE / (111_320 * cosLat);
        const anchorDLat = anchorDN / 111_320;
        const anchor = m.project([this.homeLon + anchorDLng, this.homeLat + anchorDLat]);
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

        //Chip cluster around the home:
        //  - SoC and Power chips sit on a shared horizontal "shelf"
        //    a fixed distance above the home, flanking the home's
        //    vertical axis (SoC on the left, Power on the right).
        //  - The PV chip is mirrored across that shelf and lands
        //    just below the home, leaving the home itself uncluttered
        //    while still placing the PV reading next to its visual
        //    referent. Each pair of L-shaped leaders runs from the
        //    PV chip's TOP edge upward to the shelf, then horizontally
        //    to the SoC / Power chip.
        const BATTERY_CHIP_X_OFFSET_PX = 80;
        const BATTERY_CHIP_Y_OFFSET_PX = 20;
        const shelfY = home.y - PV_CHIP_OFFSET_PX + BATTERY_CHIP_Y_OFFSET_PX;
        const pvX    = home.x;
        const pvY    = shelfY + BATTERY_CHIP_Y_OFFSET_PX;

        return {
            cloudLabel:        { x: cloudLabelX,                    y: cloudLabelY },
            pvLabel:           { x: pvX,                            y: pvY         },
            batterySocLabel:   { x: pvX - BATTERY_CHIP_X_OFFSET_PX, y: shelfY      },
            batteryPowerLabel: { x: pvX + BATTERY_CHIP_X_OFFSET_PX, y: shelfY      },
            ringEdge:          { x: ringEdgeX,                      y: ringEdgeY   },
            home:              { x: home.x,                         y: home.y      }
        };
    }

    //Project a 3D point (longitude, latitude, altitude_m) into
    //screen-space pixels using MapLibre's current camera matrices.
    //
    //Procedure (per the MapLibre v5 official 3D-model example):
    //  1. modelMatrix = transform.getMatrixForModel(LngLat, alt) ,
    //     translates / rotates a model from its local frame into
    //     Mercator world coordinates at the requested location and
    //     altitude.
    //  2. projMatrix = transform.getProjectionDataForCustomLayer()
    //     .mainMatrix, Mercator world to gl clip space.
    //  3. Multiply both matrices to get the full MVP.
    //  4. Apply MVP to (0, 0, 0, 1), the local-frame origin, which
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
    //based on how far they are from the viewer, bigger when close,
    //smaller when far, to give the otherwise flat top-down-ish view
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
        //space at the requested lon/lat and altitude (metres above
        //sea level). With terrain off (no DEM mesh, flat ground at
        //sea level) the altitude maps directly to a screen position,
        //no terrain offset needed.
        const modelM: number[] = t.getMatrixForModel([lon, lat], altitudeM);
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

        //Apply mvp to the origin (0, 0, 0, 1), i.e. extract the
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
        //CSS pixels, the units the card overlay uses to position
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
    //uniformly across the day, that's a simplification (real cloud
    //cover varies hour-to-hour) but keeps the visualisation reactive
    //to the live weather without needing the per-hour forecast for
    //the arc itself. The sun position carries the same.
    //
    //Each arc point and the sun also carry a `nearness` value in
    //[0..1], 1 means closest to the camera (nearest depth in the
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
        //Horizon crossings on the active day's arc, projected to
        //screen space along with the local tangent angle (radians)
        //so the card can render a small ring oriented perpendicular
        //to the arc at each. Either or both may be null at high
        //latitudes during polar summer / winter when the sun never
        //crosses the horizon.
        sunrise:  { x: number; y: number; angleRad: number; time: Date } | null;
        sunset:   { x: number; y: number; angleRad: number; time: Date } | null;
    } | null
    {
        if (!this.map)
        {
            return null;
        }

        //Ground-level home projection, the SVG anchor for the
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
        //clear (0%), the arc still gets coloured at its proper
        //clear-sky intensity so the user sees something meaningful
        //before the first weather fetch lands.
        const liveCloud = this._homeHourlyData
            ? (() => {
                const w = this._getWeatherAtTime(now);
                return w?.cloudCover ?? 0;
            })()
            : 0;

        //Reuse the cached arc inputs when both the calendar day and
        //the (integer-rounded) live cloud cover are unchanged. The
        //heavy trig (96 getSunPosition + 96 computeIrradianceWm2
        //calls per pass) fires only when the cache misses; on every
        //transform / rotation frame we just re-project the cached
        //lon/lat/altitudeM tuples through the current map matrix.
        const dayStartMs  = dayStart.getTime();
        const cloudPctInt = Math.round(liveCloud);
        let cache = this._arcInputsCache;
        if (
            !cache
         || cache.dayStartMs  !== dayStartMs
         || cache.cloudPctInt !== cloudPctInt
        )
        {
            const samples: Array<{
                lon: number;
                lat: number;
                altitudeM: number;
                wm2: number;
                belowHorizon: boolean;
            } | null> = [];
            for (let i = 0; i < SUN_ARC_SAMPLES; i++)
            {
                const t = new Date(dayStartMs + i * stepMs);
                const sun3D = this._sunSpherePoint(t);
                if (!sun3D)
                {
                    samples.push(null);
                    continue;
                }
                //Per-sample priority: sensor reading if one sits
                //within the lookup window, otherwise the analytical
                //clear-sky × cloud-cover model. Mixing the two along
                //the same arc is acceptable since the sensor's
                //samples are sparse (hourly at most) and the gradient
                //transitions smoothly between adjacent points.
                const sensorWm2 = this._sensorIrradianceAt(t);
                const wm2 = sensorWm2 !== null
                    ? sensorWm2
                    : computeIrradianceWm2(t, this.homeLat, this.homeLon, liveCloud);
                samples.push({
                    lon:          sun3D.lon,
                    lat:          sun3D.lat,
                    altitudeM:    sun3D.altitudeM,
                    wm2,
                    //altitudeM in _sunSpherePoint is R·sin(α), same
                    //sign as α, so a negative altitudeM means the sun
                    //is below the horizon at this sample. Surface that
                    //as a flag rather than the raw value because the
                    //card only needs to switch render modes (solid vs
                    //dotted), not the exact angle.
                    belowHorizon: sun3D.altitudeM < 0
                });
            }
            cache = { dayStartMs, cloudPctInt, samples };
            this._arcInputsCache = cache;
        }

        //Per-frame work: re-project the cached samples through the
        //current map matrix, recording depth so we can normalise to
        //a nearness factor below.
        type RawArcPoint = {
            x: number; y: number; irradiance: number; depth: number;
            belowHorizon: boolean;
        };
        const raw: RawArcPoint[] = [];
        for (let i = 0; i < SUN_ARC_SAMPLES; i++)
        {
            const s = cache.samples[i];
            if (!s) continue;
            const px = this._projectScenePoint(s.lon, s.lat, s.altitudeM);
            if (!px) continue;
            raw.push({
                x:            px.x,
                y:            px.y,
                irradiance:   s.wm2,
                depth:        px.depth,
                belowHorizon: s.belowHorizon
            });
        }

        //Sun at "now", same spherical projection as the arc points.
        const sunNow3D = this._sunSpherePoint(now);
        const sunNowAlt = getSunPosition(now, this.homeLat, this.homeLon).altitude;
        const sunNowSensor = this._sensorIrradianceAt(now);
        const sunNowWm2 = sunNowSensor !== null
            ? sunNowSensor
            : computeIrradianceWm2(now, this.homeLat, this.homeLon, liveCloud);

        let sunScreen: { x: number; y: number; depth: number } | null = null;
        if (sunNow3D)
        {
            sunScreen = this._projectScenePoint(sunNow3D.lon, sunNow3D.lat, sunNow3D.altitudeM);
        }
        if (!sunScreen)
        {
            //Even at night we want a defined sun position so the
            //incidence ray has somewhere to anchor (offscreen below
            //the home is fine, the ray just won't be drawn). Fall
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

        //daylight factor, a smooth 0..1 ramp keyed on solar
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

        //Horizon crossings on the active day's arc. We walk the cached
        //arc samples (one every 15 min) and look for the
        //belowHorizon → above transition (sunrise) and the above →
        //below transition (sunset). For visual placement we interpolate
        //linearly between the bracketing samples; 15 min granularity is
        //way over-precise for a screen marker. The screen-space tangent
        //at each crossing comes from the bracketing arc points and is
        //handed to the card so it can rotate the ring perpendicular to
        //the arc at that point. Polar summer / winter and other days
        //with no horizon crossing simply leave both null.
        let sunrise: { x: number; y: number; angleRad: number; time: Date } | null = null;
        let sunset:  { x: number; y: number; angleRad: number; time: Date } | null = null;
        for (let i = 1; i < cache.samples.length; i++)
        {
            const prev = cache.samples[i - 1];
            const curr = cache.samples[i];
            if (!prev || !curr) continue;

            const prevBelow = prev.belowHorizon;
            const currBelow = curr.belowHorizon;
            if (prevBelow === currBelow) continue;

            //Linear interpolation on altitudeM (positive above
            //horizon, negative below). t=0 lands on prev, t=1 on
            //curr. The interpolated altitudeM is exactly 0 at the
            //horizon crossing.
            const aPrev = prev.altitudeM;
            const aCurr = curr.altitudeM;
            const span  = aCurr - aPrev;
            const t     = (Math.abs(span) < 1e-6) ? 0.5 : (-aPrev / span);
            const tClamped = Math.max(0, Math.min(1, t));

            const lerpLon = prev.lon + (curr.lon - prev.lon) * tClamped;
            const lerpLat = prev.lat + (curr.lat - prev.lat) * tClamped;
            const px = this._projectScenePoint(lerpLon, lerpLat, 0);
            if (!px) continue;

            //Tangent: project both bracketing samples to screen and
            //take the angle of (curr - prev). The ring is drawn
            //rotated perpendicular to that tangent (so the arc looks
            //like it threads through the ring).
            const pxPrev = this._projectScenePoint(prev.lon, prev.lat, prev.altitudeM);
            const pxCurr = this._projectScenePoint(curr.lon, curr.lat, curr.altitudeM);
            const angleRad = (pxPrev && pxCurr)
                ? Math.atan2(pxCurr.y - pxPrev.y, pxCurr.x - pxPrev.x)
                : 0;

            const time = new Date(dayStartMs + (i - 1 + tClamped) * stepMs);
            const marker = { x: px.x, y: px.y, angleRad, time };

            if (prevBelow && !currBelow)      sunrise = marker;
            else if (!prevBelow && currBelow) sunset  = marker;
        }

        return {
            arc,
            sun:      {
                x: sunScreen.x, y: sunScreen.y,
                irradiance: sunNowWm2,
                altitude:   sunNowAlt,
                nearness:   nearnessOf(sunScreen.depth)
            },
            home:     { x: homeScreen.x, y: homeScreen.y },
            daylight,
            sunrise,
            sunset
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
            //Same 10-min cadence as the post-fetch interval above ,
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
            //Per-hour priority: sensor → shortwave (model) → Haurwitz
            //(analytical). Forecast hours never carry a sensor sample
            //(it would lie in the future), so the future half of the
            //chart automatically falls through to the model.
            const sensorWm2 = this._sensorIrradianceAt(home.times[i]);
            if (sensorWm2 !== null)
            {
                return sensorWm2;
            }
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

    //Snapshot of the engine's live state. Consumed by the card's own
    //`getStatsSnapshot()` and surfaced through `window.heliosStats()`
    //for in-browser debugging. The shape is intentionally JSON-safe
    //so the user can `JSON.stringify(window.heliosStats())` and paste
    //the result publicly when filing an issue. No PII is returned
    //here: the home lat/lon and elevation are stripped (only the
    //hemisphere is kept, the sun-arc orientation depends on it), and
    //the API key never leaves the card-level snapshot anyway.
    public getStatsSnapshot(): Record<string, unknown>
    {
        const provider = resolveLidarSource(this.homeLat, this.homeLon, this.cfg);
        const shadowsOn = this._shadowsEnabled();
        const lidarFeatures = this._lidarShadowFeatures;
        const buildingsFootprints = this._buildingsData
            ? {
                home:         this._buildingsData.home.features.length,
                surroundings: this._buildingsData.surroundings.features.length
              }
            : null;
        let shadowSource: string;
        if (!shadowsOn)                                  shadowSource = 'disabled';
        else if (lidarFeatures && lidarFeatures.features.length > 0)
                                                          shadowSource = 'lidar';
        else if (this._buildingsData)                    shadowSource = 'maptiler';
        else                                              shadowSource = 'pending';

        return {
            mapReady:             this._mapReady,
            //Home position deliberately omitted. `lidarProvider` and
            //`hemisphere` cover every debug case we care about
            //(coverage check + sun-arc orientation) without leaking
            //the user's address.
            hemisphere:           this.homeLat >= 0 ? 'N' : 'S',
            lidarProvider:        provider ? provider.id : null,
            shadows:
            {
                enabled:          shadowsOn,
                source:           shadowSource,
                opacity:          this._shadowOpacity(),
                lidarClumps:      lidarFeatures?.features.length ?? 0,
                lidarPrecision:   this._lidarPrecisionLevel(),
                clipRadiusM:      this._buildingRadiusMeters(),
                lastSigCached:    this._lastShadowSig !== undefined,
                lidarDiagnostics: this._lidarShadowDiagnostics
            },
            buildings:
            {
                radiusM:          this._buildingRadiusMeters(),
                clusterRadiusM:   this._buildingClusterRadiusMeters(),
                opacity:          this._buildingOpacity(),
                color:            this._buildingColor(),
                footprints:       buildingsFootprints
            },
            weather:
            {
                samples:          this._homeHourlyData?.times.length ?? 0,
                rateLimitStreak:  this._rateLimitStreak
            },
            timeline:
            {
                //Range + selectedTime kept as ISO strings rather than
                //Date instances so the snapshot round-trips through
                //JSON.stringify cleanly.
                rangeStart:       this._getTimeRange()?.start?.toISOString() ?? null,
                rangeEnd:         this._getTimeRange()?.end?.toISOString()   ?? null,
                selectedTime:     this._selectedTime?.toISOString() ?? null
            },
            caches:
            {
                arcCacheDay:      this._arcInputsCache
                    ? new Date(this._arcInputsCache.dayStartMs).toISOString().slice(0, 10)
                    : null,
                arcCacheCloudPct: this._arcInputsCache?.cloudPctInt ?? null
            }
        };
    }

    public updateConfig(cfg: HeliosConfig): void
    {
        bumpStat('updateConfigCalls');
        const prevStyleUrl = this._resolveMapStyle().url;
        const prevPixelR   = this._pixelRatio();
        const prevRadius      = this._buildingRadiusMeters();
        const prevCluster     = this._buildingClusterRadiusMeters();
        const prevOpacity     = this._buildingOpacity();
        const prevColor       = this._buildingColor();
        const prevPrecision   = this._lidarPrecisionLevel();
        const prevShadowOpa   = this._shadowOpacity();
        const prevShadowsOn   = this._shadowsEnabled();
        this.cfg = { ...cfg };

        if (!this.map)
        {
            return;
        }

        //Map-style change → reload the basemap. setStyle() replaces
        //sources, layers, sprites and glyphs; our custom sources get
        //wiped and re-added by the _onStyleLoad handler. Drop
        //_mapReady while the new style is in flight so other code
        //paths don't operate on a half-loaded style.
        const nextStyleInfo = this._resolveMapStyle();
        const styleNeedsReload = nextStyleInfo.url !== prevStyleUrl;
        if (styleNeedsReload)
        {
            bumpStat('styleReloads');
            this._mapReady = false;
            this.map.setStyle(nextStyleInfo.url);
            return;
        }

        //Pixel-ratio toggle: apply in-place, no style reload needed.
        const nextPixelR = this._pixelRatio();
        if (nextPixelR !== prevPixelR)
        {
            try { this.map.setPixelRatio(nextPixelR); } catch (_) {}
        }

        this._applyLabelVisibility();

        //Building updates. Radius or cluster-radius changes invalidate
        //the cached GeoJSON and trigger a refetch via _addBuildings.
        //Opacity / colour changes are cheap paint-property updates.
        const nextRadius  = this._buildingRadiusMeters();
        const nextCluster = this._buildingClusterRadiusMeters();
        const nextOpacity = this._buildingOpacity();
        const nextColor   = this._buildingColor();
        if (nextRadius !== prevRadius || nextCluster !== prevCluster)
        {
            this._buildingsData     = null;
            this._buildingsFetchKey = '';
            this._addBuildings();
        }
        else
        {
            if (nextOpacity !== prevOpacity
             && this.map.getLayer('helios-buildings-surroundings'))
            {
                this.map.setPaintProperty(
                    'helios-buildings-surroundings',
                    'fill-extrusion-opacity',
                    nextOpacity
                );
            }
            if (nextColor !== prevColor)
            {
                for (const lid of ['helios-buildings-surroundings', 'helios-buildings-home'])
                {
                    if (this.map.getLayer(lid))
                    {
                        this.map.setPaintProperty(lid, 'fill-extrusion-color', nextColor);
                    }
                }
            }
        }

        //LiDAR precision change invalidates the cached shadow features
        //(fetch key includes the raster size) and triggers a refetch
        //at the new sampling. _ensureLidarFetched handles the diff.
        const nextPrecision = this._lidarPrecisionLevel();
        if (nextPrecision !== prevPrecision)
        {
            this._lidarShadowKey         = '';
            this._lidarShadowFeatures    = null;
            this._lidarShadowDiagnostics = null;
            this._ensureLidarFetched();
        }

        //Shadow opacity is a paint-level update on the raster layer.
        const nextShadowOpa = this._shadowOpacity();
        if (nextShadowOpa !== prevShadowOpa)
        {
            for (const lid of SHADOW_LAYER_IDS)
            {
                if (this.map.getLayer(lid))
                {
                    try { this.map.setPaintProperty(lid, 'raster-opacity', nextShadowOpa); }
                    catch (_) {}
                }
            }
        }

        //Master shadow toggle: when turning on, fetch LiDAR shadows
        //if a provider covers the home; when turning off, drop the
        //cached LiDAR features and clear the projected polygons.
        const nextShadowsOn = this._shadowsEnabled();
        if (nextShadowsOn !== prevShadowsOn)
        {
            if (nextShadowsOn)
            {
                this._ensureLidarFetched();
            }
            else
            {
                this._lidarShadowFeatures    = null;
                this._lidarShadowDiagnostics = null;
                this._lidarShadowKey         = '';
                this._lidarShadowAbort?.abort();
                this._lidarShadowAbort       = undefined;
            }
            this._lastAtmosphereAlt = -999;
            this._refreshShadowsAndAtmosphere();
        }

        //LiDAR View visual knobs (radius / point size / colour /
        //opacity) are cheap uniform updates on the custom GL layer.
        //Pushed unconditionally; the layer no-ops when nothing actually
        //changed.
        this._pushLidarViewConfig();

        if (this._homeHourlyData && this._mapReady)
        {
            this._renderForCurrentSelection();
        }

        //Per-array PV markers: small spheres at panel positions
        //when the user has set lat/lon different from home.
        this._refreshPvArrayMarkers();
    }


    public cleanup(): void
    {
        bumpStat('enginesCleanedUp');
        _liveEngines.delete(this);
        this._clearWeatherTimer();
        window.clearInterval(this._skyTimer);
        window.clearTimeout(this._resizeDebounceTimer);
        this._fetchAbortController?.abort();
        this._buildingsAbort?.abort();
        this._lidarShadowAbort?.abort();
        this._lidarShadowAbort       = undefined;
        this._lidarShadowFeatures    = null;
        this._lidarShadowDiagnostics = null;
        this._lidarShadowKey         = '';
        this._shadowCanvas           = undefined;
        this._arcInputsCache         = undefined;
        this._lastShadowSig          = undefined;
        this._resizeObserver?.disconnect();
        if (this._autoRotateRaf !== undefined)
        {
            cancelAnimationFrame(this._autoRotateRaf);
            this._autoRotateRaf = undefined;
        }
        if (this._detailDiveRaf !== undefined)
        {
            cancelAnimationFrame(this._detailDiveRaf);
            this._detailDiveRaf = undefined;
        }

        //Tear-down strategy: explicit + defensive + force-lose.
        //
        //We can't trust MapLibre's map.remove() alone to release
        //every listener / source / WebGL resource, on iOS Safari
        //in particular, a dirty remove() leaves closures pinning
        //the dead engine, GeoJSON sources lingering in the GPU,
        //and the WebGL context slot occupied (browsers cap at
        //8-16 active contexts). The drift after several editor
        //re-inits was the symptom; this multi-step cleanup is the
        //fix.
        //
        //Order matters: detach DOM listeners first (so MapLibre's
        //own teardown sees a clean canvas), then unhook every
        //map.on() we registered explicitly, then remove our custom
        //sources/layers (saves the GPU work even if remove() would
        //do it), THEN call map.remove(), THEN force-lose the WebGL
        //context to release the slot.

        const canvas = this._mapCanvas;

        //Step 1, DOM listeners on the canvas (single-pointer drag-
        //rotate, WebGL context lost/restored). The auto-rotate
        //inactivity bump now lives inside the drag-rotate handler
        //itself, no separate listeners to detach.
        if (this._dragRotateHandlers)
        {
            const h = this._dragRotateHandlers;
            h.canvas.removeEventListener('pointerdown',   h.onDown);
            h.canvas.removeEventListener('pointermove',   h.onMove);
            h.canvas.removeEventListener('pointerup',     h.onEnd);
            h.canvas.removeEventListener('pointercancel', h.onEnd);
        }
        if (canvas && this._webglLostHandler)
        {
            canvas.removeEventListener('webglcontextlost', this._webglLostHandler);
        }
        if (canvas && this._webglRestoredHandler)
        {
            canvas.removeEventListener('webglcontextrestored', this._webglRestoredHandler);
        }

        //Grab the WebGL context BEFORE map.remove() destroys it ,
        //we'll force-lose it at the end of cleanup to release the slot.
        let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
        try
        {
            gl = (canvas?.getContext('webgl2') as WebGL2RenderingContext | null)
              ?? (canvas?.getContext('webgl')  as WebGLRenderingContext  | null)
              ?? null;
        }
        catch (_) {}

        //Step 2, every map.on() listener we hold an explicit
        //reference for. map.remove() should clean these up but
        //doing it ourselves means any leftover closure that
        //captures `this` is severed BEFORE the engine is dropped.
        if (this.map)
        {
            try
            {
                if (this._mapPinHandler)
                {
                    this.map.off('rotate', this._mapPinHandler);
                    this.map.off('move',   this._mapPinHandler);
                }
                if (this._mapStyleLoadHandler) this.map.off('style.load', this._mapStyleLoadHandler);
                if (this._mapLoadHandler)      this.map.off('load',       this._mapLoadHandler);
                if (this._mapMoveHandler)      this.map.off('move',       this._mapMoveHandler);
                if (this._mapErrorHandler)     this.map.off('error',      this._mapErrorHandler);
            }
            catch (_) {}
        }

        //Step 3, explicit removal of every helios-* layer and
        //source so MapLibre doesn't have to walk them itself.
        //removeLayer must precede removeSource (MapLibre rejects
        //removing a source still backing live layers).
        if (this.map)
        {
            for (const lid of [
                'helios-hillshade',
                'helios-night-shade',
                'helios-cloud-disc',
                'helios-cloud-disc-ring',
                'helios-cloud-ring',
                'helios-buildings-surroundings',
                'helios-buildings-home',
                'helios-buildings-surroundings-outline',
                'helios-buildings-home-outline',
                'helios-buildings-home-outline-glow',
                'helios-building-shadows'
            ])
            {
                try { if (this.map.getLayer(lid)) this.map.removeLayer(lid); }
                catch (_) {}
            }
            //setTerrain(null) before removing the DEM sources, MapLibre
            //refuses to remove a source still referenced by a live
            //terrain binding.
            try { this.map.setTerrain(null); }
            catch (_) {}
            for (const sid of [
                'helios-terrain',
                'helios-night-shade',
                'helios-cloud-rings',
                'helios-buildings-surroundings-src',
                'helios-buildings-home-src',
                'helios-building-shadows-src'
            ])
            {
                try { if (this.map.getSource(sid)) this.map.removeSource(sid); }
                catch (_) {}
            }
        }

        //Step 4, drop heavy instance state BEFORE map.remove() so
        //the dead engine, once unreachable, holds nothing but
        //handles that have already been released.
        this._buildingsData     = null;
        this._buildingsFetchKey = '';
        this._homeHourlyData    = null;
        for (const m of this._pvArrayMarkers) m.remove();
        this._pvArrayMarkers    = [];
        this._mapCanvas             = undefined;
        this._dragRotateHandlers    = undefined;
        this._mapPinHandler         = undefined;
        this._mapStyleLoadHandler   = undefined;
        this._mapLoadHandler        = undefined;
        this._mapMoveHandler        = undefined;
        this._mapErrorHandler       = undefined;
        this._webglLostHandler      = undefined;
        this._webglRestoredHandler  = undefined;
        this.onContextLost          = undefined;

        //Step 5, MapLibre teardown.
        this.map?.remove();
        this.map       = undefined;
        this._mapReady = false;

        //Step 6, force the WebGL context slot to release. Browsers
        //don't always reclaim it from canvas GC alone, and the cap
        //(8-16 active contexts) is the dominant cause of perf drift
        //+ random page refresh + iOS Safari black screen after
        //several re-inits.
        try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); }
        catch (_) {}

        //Step 7, clear the debug global so it doesn't pin the dead map.
        try
        {
            const w = window as unknown as { __heliosMap?: unknown };
            if (w.__heliosMap !== undefined) delete w.__heliosMap;
        }
        catch (_) {}
    }
}