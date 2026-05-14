import maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { getSunPosition, computePvPower, computeIrradianceWm2 } from './helios-sun';
import { fetchHomePointData, RATE_LIMIT_BACKOFF_MS, type SampleHourly } from './helios-weather';
import { fetchBuildingsAroundHome, type BuildingsResult } from './helios-buildings';
import { projectExtrusionShadows } from './helios-shadows';
import { findLidarSource } from './helios-lidar';

//Public types

export interface HeliosConfig
{
    'maptiler-api-key':       string;
    'topography-color'?:      unknown;
    'topography-alpha'?:      unknown;
    //When false, all of MapTiler Streets' label layers
    //(road names, building numbers, POI labels, place names) are
    //hidden for a cleaner, minimalist basemap. Default: true.
    'show-labels'?:           unknown;
    //Fixed-colour design system. Each metric has one configurable
    //colour reused everywhere it appears (timeline mirror chart +
    //on-arc sun disc for sun, on-ground disc + timeline lower half
    //for cloud). Intensity is conveyed by area / position rather than
    //by hue interpolation, so a high cloud reading reads consistently
    //as "more" regardless of the chosen colour.
    'sun-color'?:             unknown;
    'cloud-color'?:           unknown;
    //Optional photovoltaic production overlay.
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
    //Optional home-battery overlay. A single chip below the
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
    //'12h' | '24h'. Default: '24h'. Picks between locale-
    //independent 12-hour ("11:23:45 PM") and 24-hour ("23:23:45")
    //rendering of the date/time chip at the top-right of the card.
    'time-format'?:           unknown;
    //Picks the MapTiler base style. 'streets' (default) renders
    //a sober vector basemap suited to dense urban areas; 'topo' renders
    //a topographic basemap with contour lines and softer earth tones,
    //better in hilly / outdoor settings. The label visibility toggle
    //and the helios-buildings extrusion are independent of this choice
    //(both are wired to custom sources). When `card-theme: dark` is
    //set, the dark variants of these styles (streets-v4-dark /
    //topo-v4-dark) are used so the basemap matches the chrome.
    'map-style'?:             unknown;
    //Picks the card chrome theme. 'light' (default) paints chips,
    //charts, buttons, tooltips and the scrub overlay on a white
    //surface; 'dark' switches to a near-black surface with light-
    //grey text so the card sits cleanly inside dark HA dashboards.
    //The 3D map basemap and the configured colour palette (sun,
    //cloud, PV, battery) are unaffected.
    'card-theme'?:            unknown;
    //Opts the idle-camera orbit in or out. Default: true (orbit
    //enabled). When false, the camera stays at the user's bearing
    //forever; pinch-rotate still works normally. Useful on low-power
    //devices or for users who find the constant motion distracting.
    'auto-rotate-enabled'?:    unknown;
    //Radius (m) around the home within which surrounding buildings are
    //rendered. Buildings outside are not drawn at all. Default 100 m.
    'building-radius'?:        unknown;
    //Opacity 0..1 of the surrounding buildings; home stays at 1.0.
    //Default 0.25, a "ghost" surround that conveys urban context
    //without competing with the data overlays.
    'building-opacity'?:       unknown;
    //Cluster radius (m) around the home: every building whose centroid
    //sits within this radius (or which contains the home point) is
    //treated as part of the home and painted at full opacity. Used
    //to keep verandas, garages and outbuildings physically attached
    //to the main house from rendering as semi-transparent "neighbours".
    //Default 0 (legacy single-polygon home detection).
    'building-cluster-radius'?: unknown;
    //Hex colour of every rendered building (home and surroundings
    //share the same base tone, modulated by sun altitude). The
    //surrounding extrusions remain visually distinct via opacity,
    //not hue. Default neutral cool grey #d2d2d7.
    'building-color'?:         unknown;
    //Drops the most expensive per-frame work for low-end devices /
    //long sessions: terrain mesh disabled (flat ground, pitch is
    //preserved so the 3D buildings still read as 3D), hillshade
    //hidden, canvas pixel ratio forced to 1.0. Default false.
    'performance-mode'?:       unknown;
    //Terrain mesh density. 'smooth' (default) samples the DEM at
    //z=12, ~20 m per vertex, fluid on every device. 'fine' bumps
    //the source maxzoom to 14, ~5 m per vertex, more detail in
    //the relief but ~16× more mesh vertices to project per frame.
    'terrain-detail'?:         unknown;
    //Cast-shadow master toggle. Default true. When false, no shadows
    //are projected at all (neither LiDAR nor MapTiler).
    'shadows-enabled'?:        unknown;
    //LiDAR raster precision for shadow geometry. Only meaningful when
    //the home is inside a provider's coverage. One of:
    //  'low'    256x256 raster on the home-radius bbox
    //  'medium' 512x512
    //  'high'   1024x1024 (close to IGN native sampling)
    'lidar-precision'?:       unknown;
    //Opacity of the cast ground shadow layer, 0..1. Default 0.32.
    'shadow-opacity'?:         unknown;
}

//Default values for the building config, exposed so the visual
//editor can render the matching placeholder / slider defaults.
export const DEFAULT_BUILDING_RADIUS_M         = 100;
export const DEFAULT_BUILDING_OPACITY          = 0.25;
export const DEFAULT_BUILDING_CLUSTER_RADIUS_M = 0;
export const DEFAULT_BUILDING_COLOR_HEX        = '#d2d2d7';
//Shadow precision levels. Each level maps to a WMS raster size which
//drives how finely the IGN LiDAR HD heightmap is sampled around the
//home. Higher precision means finer shadow contours but a larger
//payload and more work for the consolidation step. Only meaningful
//when the home is inside a provider's coverage; outside, shadows
//fall back to MapTiler footprints regardless of this setting.
//
//  'low'    256 x 256 raster
//  'medium' 512 x 512
//  'high'   1024 x 1024 (close to IGN native ~50 cm sampling)
export type LidarPrecisionLevel = 'low' | 'medium' | 'high';
export const DEFAULT_LIDAR_PRECISION: LidarPrecisionLevel = 'medium';
export const LIDAR_PRECISION_RASTER: Record<LidarPrecisionLevel, number> = {
    low:    256,
    medium: 512,
    high:   1024
};
//Default opacity of the ground shadow layer when the user has not set
//the `shadow-opacity` config option.
export const DEFAULT_SHADOW_OPACITY = 0.32;


//Single ground-shadow layer. We used to emit three nested fade-step
//polygons per casting region for a gradient falloff, but the 3x
//polygon count tanked perf on dense LiDAR scenes and the alpha
//compositing over multiple overlapping clumps saturated the shadow
//to almost black. One flat-opacity layer is cheaper and reads more
//naturally.
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
    enginesSkippedAsPreview?: number;
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
export type IrradianceSource = 'haurwitz' | 'shortwave';

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

//Fixed-colour design system.
//
//Each metric has its own colour, fixed and configurable. We don't
//interpolate hues to convey intensity any more, instead we vary the
//area or the position of a single colour so a quick glance at the
//card tells the user "more cloud" or "more sun" without first
//decoding a rainbow ramp. The fixed colour also propagates unchanged
//across all surfaces (timeline mirror chart, on-ground cloud disc,
//on-arc sun disc) so the visual language stays internally consistent.
//
//Defaults were chosen for maximum perceptual contrast against each
//other and against typical satellite imagery:
//  - Sun: a warm amber (#EF9F27), clearly warm, high luminance,
//    doesn't compete with the green/blue of vegetation or water in
//    the basemap.
//  - Cloud: a cool desaturated blue (#5A8DC4), clearly cool, mid
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
//Saturated red, distinct from sun (orange), cloud (blue), PV
//(green), and easy to associate visually with battery
//discharge / "energy on draw" semantics. Reads cleanly on the
//80 % white chip background.
export const DEFAULT_BATTERY_COLOR_HEX: string = '#D32F2F';

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
const PV_CHIP_OFFSET_PX         = 105;


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
    private map?:     MapLibreMap;
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
    //Map transform changed, the card recomputes screen-space
    //projections (sun arc, chip positions, leaders) from this hook.
    public onMapTransform?:  () => void;

    //Auto-rotation state. The map slowly orbits the home in the
    //opposite direction to the sun's apparent motion (decreasing
    //bearing, ~1.5°/s) when the user has been idle for a few
    //seconds. Any direct interaction resets the inactivity timer,
    //so the rotation pauses immediately on pinch / drag / wheel
    //and resumes from the user's bearing once they let go.
    private _autoRotateRaf?:           number;
    private _autoRotateLastFrame:      number = 0;
    private _autoRotateLastUserAction: number = 0;
    //Inactivity-bumper bookkeeping, we hold both the canvas and the
    //listener reference so cleanup() can fully detach them. Without
    //this, every engine re-init (API key change, home-coords change,
    //map-style change) accumulates the four listeners + their closure
    //(which captures `this`, hence the entire dead engine + its old
    //MapLibre context) until the browser starts recycling WebGL
    //contexts under pressure, visible as random dashboard reloads
    //during editing and creeping FPS degradation after several
    //re-inits within the same session.
    private _bumpInactivityCanvas?: HTMLCanvasElement;
    private _bumpInactivityHandler?: () => void;

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

    //Consolidated LiDAR shadow regions for the current home + radius
    //+ precision combination. Null until the first fetch lands; the
    //shadow projector reads this on every sun-position refresh.
    private _lidarShadowFeatures: GeoJSON.FeatureCollection | null = null;
    //Fetch-key for the cached LiDAR shadow features. Lets us skip a
    //refetch when the user nudges the camera but home/radius/precision
    //haven't changed.
    private _lidarShadowKey: string = '';
    //In-flight LiDAR shadow fetch, aborted when home/radius/precision
    //changes so a slow IGN response can't overwrite a fresher request.
    private _lidarShadowAbort?: AbortController;

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

        bumpStat('enginesCreated');

        //Evict the oldest live engine if we're at the cap. Set
        //iteration follows insertion order so the first value is the
        //longest-lived, typically an orphaned editor-preview engine
        //the user can no longer see.
        while (_liveEngines.size >= MAX_LIVE_ENGINES)
        {
            const oldest = _liveEngines.values().next().value;
            if (!oldest) break;
            console.warn('[HELIOS] WebGL context cap reached — force-cleaning the oldest engine');
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
        //each rendered pixel is sampled multiple times (terrain mesh,
        //hillshade, extrusion, basemap) so the desktop cap sits at 2
        //(not the native 2-3 of Retina) and mobile at 1.25, slashing
        //per-frame fragment work without a visible quality regression
        //on the card-sized viewport. Performance-mode forces 1.0.
        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
        const pixelRatio = (this.cfg['performance-mode'] === true)
            ? 1.0
            : (IS_MOBILE
                ? Math.min(Math.max(dpr, 1), 1.25)
                : Math.min(Math.max(dpr, 1.5), 2));

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
            //MapLibre's default dragRotate binds to right-click drag,
            //which is not what users expect on a 3D card. We disable
            //it and wire our own pointer handlers below so a left-click
            //drag (mouse) or single-finger drag (touch) rotates.
            dragRotate:      false,
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
            this._startAutoRotateLoop();
        };
        this.map.on('load', this._mapLoadHandler);

        //Map transform broadcaster, relays move events to the card so
        //it can keep HTML overlays aligned with the underlying canvas.
        //We listen on `move` rather than `moveend` so the overlays
        //track the camera frame-by-frame during programmatic
        //animations rather than snapping at the end.
        this._mapMoveHandler = () => this.onMapTransform?.();
        this.map.on('move', this._mapMoveHandler);

        //Auto-rotation pause, any DOM-level interaction on the canvas
        //(mouse, touch, wheel) bumps the inactivity timer so the
        //rotation loop yields immediately and only resumes after a
        //few seconds of stillness. We hook DOM events rather than
        //MapLibre 'rotate' / 'pitch' / 'drag' because the loop ITSELF
        //emits those (via setBearing), which would otherwise be
        //indistinguishable from a real user action.
        const canvas = this.map.getCanvas();
        const bumpInactivity = () =>
        {
            this._autoRotateLastUserAction = Date.now();
        };
        this._bumpInactivityCanvas  = canvas;
        this._bumpInactivityHandler = bumpInactivity;
        canvas.addEventListener('mousedown',  bumpInactivity);
        canvas.addEventListener('wheel',      bumpInactivity, { passive: true });
        canvas.addEventListener('touchstart', bumpInactivity, { passive: true });
        canvas.addEventListener('touchmove',  bumpInactivity, { passive: true });

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
            dragRotating = true;
            activeId     = e.pointerId;
            lastPointerX = e.clientX;
            try { canvas.setPointerCapture(e.pointerId); }
            catch (_) {}
        };
        const onMove = (e: PointerEvent) =>
        {
            if (!dragRotating || !this.map || e.pointerId !== activeId) return;
            const dx = e.clientX - lastPointerX;
            lastPointerX = e.clientX;
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
            console.warn('[HELIOS] WebGL context lost — requesting card re-init');
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

    //Resolves the active MapTiler style id from `map-style` config.
    //Three values are accepted:
    //  'streets' (default) → 'streets-v4', sober urban basemap.
    //  'topo'              → 'topo-v4'   , topographic basemap with
    //                                       contour lines and softer
    //                                       earth tones, better in
    //                                       hilly / outdoor settings.
    //  'minimal'           → 'streets-v4' loaded then pruned in
    //                                       _onStyleLoad to a curated
    //                                       whitelist of layers, fewer
    //                                       per-frame draw calls, best
    //                                       for low-end devices.
    //
    //Anything else falls back to 'streets'. When `card-theme: dark`
    //is set, the `-dark` variant of the chosen base style is used so
    //the basemap matches the dark chrome.
    private _resolveMapStyle(): { id: string }
    {
        const raw = String(this.cfg['map-style'] ?? 'streets').toLowerCase();
        //Satellite is a one-off: real imagery, no light/dark variants
        //(it always reads as itself), useful for visually checking
        //that the LiDAR shadows line up with reality.
        if (raw === 'satellite') return { id: 'hybrid' };

        const base   = raw === 'topo' ? 'topo-v4' : 'streets-v4';
        const isDark = String(this.cfg['card-theme'] ?? 'light').toLowerCase() === 'dark';
        return { id: isDark ? `${base}-dark` : base };
    }

    //True when the user picked the curated minimal basemap. The map
    //still loads streets-v4 (we don't ship a hand-built style); the
    //pruning happens in _pruneMinimalStyle at style.load time.
    private _isMinimalStyle(): boolean
    {
        return String(this.cfg['map-style'] ?? 'streets').toLowerCase() === 'minimal';
    }

    //Layers we keep when `map-style: minimal` is active. Everything
    //else is removed outright in _pruneMinimalStyle, removeLayer is
    //immune to MapLibre 5 style-import scoping (the bare removeLayer
    //call was confirmed effective on the streets-v4 layer set).
    private static readonly MINIMAL_KEEP_LAYER_IDS: ReadonlySet<string> = new Set([
        'Background',
        //Land use / cover that give the ground its colour palette
        //without adding any extra draw call beyond what's already
        //present.
        'Farmland', 'Vegetation', 'Wood', 'Forest', 'Grass',
        'Residential', 'Sand', 'Ice',
        //Water everywhere it appears (lakes, rivers, swimming pools)
        //plus the visible river/stream lines.
        'Water', 'River', 'Stream',
        //Roads: keep the meaningful classes for orientation; drop
        //tunnels, bridges, hatching, ramps, oneways, shields, etc.
        'Major road', 'Highway', 'Minor road z10', 'Minor road z12',
        'Service road', 'Pathway', 'Track'
    ]);

    private _pruneMinimalStyle(): void
    {
        if (!this.map || !this._isMinimalStyle())
        {
            return;
        }
        const keep   = HeliosEngine.MINIMAL_KEEP_LAYER_IDS;
        const layers = this.map.getStyle().layers ?? [];
        for (const l of layers)
        {
            if (l.id.startsWith('helios-')) continue;
            if (keep.has(l.id))             continue;
            try { this.map.removeLayer(l.id); }
            catch (_) {}
        }
    }

    //Performance mode, disables the per-frame heavyweights (terrain
    //mesh + hillshade) and caps pixelRatio at 1.0. The 3D pitch and
    //extruded buildings are preserved, so the card still reads as 3D.
    private _performanceMode(): boolean
    {
        return this.cfg['performance-mode'] === true;
    }

    //Terrain DEM maxzoom, 'smooth' (default) at z=12, 'fine' at z=14.
    //z=14 ~16× more mesh vertices than z=12 per frame, which moves
    //rotation cost considerably; only useful when the user values
    //the finer relief over fluidity.
    private _terrainMaxzoom(): number
    {
        return String(this.cfg['terrain-detail'] ?? 'smooth').toLowerCase() === 'fine'
            ? 14
            : 12;
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
            //and clamp to [0, 100] so downstream code doesn't need
            //to know which source produced the value.
            pvPowerShortwave = Math.max(0, Math.min(100, w.shortwave / 1000 * 100));
        }

        //Pick the primary value to display:
        //  - shortwave when available (model value, more accurate)
        //  - Haurwitz otherwise (fallback)
        const useShortwave    = pvPowerShortwave >= 0;
        const pvPower         = useShortwave ? pvPowerShortwave : pvPowerHaurwitz;
        const irradianceSource: IrradianceSource = useShortwave ? 'shortwave' : 'haurwitz';

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

        //Minimal basemap: prune all native layers outside the
        //curated whitelist before any helios-* layer is added,
        //so we don't waste setup work on layers that won't render.
        this._pruneMinimalStyle();

        const perfMode = this._performanceMode();

        if (!this.map.getSource('helios-terrain'))
        {
            //DEM sampling step depends on the `terrain-detail` config:
            //z=12 (~20 m / vertex) for the smooth default, z=14
            //(~5 m / vertex) when the user opts into fine detail.
            //z=14 has ~16× more mesh vertices to project per rotation
            //frame than z=12, the difference is mostly visible at
            //pitch 55° on hilly home locations.
            this.map.addSource('helios-terrain',
            {
                type:     'raster-dem',
                url:      `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${this.apiKey}`,
                tileSize: 512,
                maxzoom:  this._terrainMaxzoom()
            });
        }
        //Performance mode drops the terrain mesh entirely (flat
        //ground). Pitch is preserved, so the 3D buildings still
        //read as 3D, but the per-frame mesh projection cost is gone.
        if (perfMode)
        {
            this.map.setTerrain(null);
            try { this.map.setPixelRatio(1.0); } catch (_) {}
        }
        else
        {
            this.map.setTerrain({ source: 'helios-terrain', exaggeration: 1.2 });
        }

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

        //Layer order: hillshade and night-shade first (they tint the
        //ground), then the cloud-cover disc (under the buildings so
        //they emerge through it as islands), then buildings on top.
        //The 3D solar overlays (arc, sun, incidence ray) live as
        //HTML/SVG above the canvas, a Three.js custom layer was
        //tried and rejected because MapLibre's compositor would
        //overpaint it unpredictably; HTML overlays sidestep the GL
        //pipeline entirely.
        this._initHillshade();
        this._initNightShade();
        this._initCloudCoverDisc();
        this._addBuildings();
        this._applyLabelVisibility();

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
        //Performance mode: skip hillshade entirely. The fragment
        //shader pass is one of the dominant per-frame costs on
        //Safari fullscreen.
        if (this._performanceMode())
        {
            return;
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
                //Non-transparent highlights make sun-facing slopes
                //pop. Soft warm white at moderate opacity so the
                //hillshade reads as ambient lighting rather than a
                //paint-stroke effect.
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
    private _updateCloudCoverDisc(cloudPct: number): void
    {
        //Stash the value; the SVG overlay in the card pulls it back
        //via projectCloudScene() on every map transform + clock tick.
        this._currentCloudPct = Math.max(0, Math.min(100, cloudPct));
    }

    //Project the cloud-cover disc + 100 % reference ring into screen
    //space. Returns null when the engine isn't ready yet (the card
    //then skips rendering this frame). Vertices are computed at sea-
    //level offsets around the home and projected with anchor at the
    //home's terrain elevation, so the resulting polygons stay true
    //circles regardless of the terrain mesh underneath.
    public projectCloudScene(): {
        disc:     Array<{ x: number; y: number }>;
        ring:     Array<{ x: number; y: number }>;
        cloudHex: string;
        cloudPct: number;
    } | null
    {
        if (!this.map || !this._mapReady) return null;

        const pct   = this._currentCloudPct;
        const discR = CLOUD_DISC_RADIUS_M * pct / 100;
        const ringR = CLOUD_DISC_RADIUS_M;

        //Geographic circle vertices, not closed: the card emits the
        //SVG polygon, which has implicit closure.
        const discGeo = buildCirclePolygon(this.homeLon, this.homeLat,
                                           discR, CLOUD_CIRCLE_SEGMENTS);
        const ringGeo = buildCirclePolygon(this.homeLon, this.homeLat,
                                           ringR, CLOUD_CIRCLE_SEGMENTS);

        const disc: Array<{ x: number; y: number }> = [];
        const ring: Array<{ x: number; y: number }> = [];
        //anchorAtHome: every vertex uses the home's queryTerrainElevation
        //rather than its own. That keeps the projected polygon a true
        //circle even when the terrain bends between the home and the
        //disc's edge.
        for (const [lon, lat] of discGeo)
        {
            const p = this._projectScenePoint(lon, lat, 0, { anchorAtHome: true });
            if (p) disc.push({ x: p.x, y: p.y });
        }
        for (const [lon, lat] of ringGeo)
        {
            const p = this._projectScenePoint(lon, lat, 0, { anchorAtHome: true });
            if (p) ring.push({ x: p.x, y: p.y });
        }
        if (disc.length < 3 && ring.length < 3) return null;

        const rgb      = this._resolvedCloudRgb();
        const cloudHex = '#'
            + rgb[0].toString(16).padStart(2, '0')
            + rgb[1].toString(16).padStart(2, '0')
            + rgb[2].toString(16).padStart(2, '0');

        return { disc, ring, cloudHex, cloudPct: pct };
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
        return Math.min(1000, Math.max(20, v));
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
    //in helios-buildings.ts; subsequent calls (e.g. on theme switch,
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
            'helios-buildings-home-outline'
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

        //Ground-projected shadows. Single source feeding a single
        //flat-opacity fill layer drawn BEFORE the building extrusions
        //so buildings hide the under-building part of their own
        //shadow; the visible shadow is the spillover on the ground.
        if (!this.map.getSource('helios-building-shadows-src'))
        {
            this.map.addSource('helios-building-shadows-src',
            {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection
            });
        }
        const shadowOpa = this._shadowOpacity();
        if (!this.map.getLayer('helios-building-shadows'))
        {
            this.map.addLayer(
            {
                id:     'helios-building-shadows',
                source: 'helios-building-shadows-src',
                type:   'fill',
                paint:
                {
                    'fill-color':     '#000000',
                    'fill-opacity':   shadowOpa,
                    'fill-antialias': true
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
        //ground footprint, a thicker / darker line on the home so the
        //focal building reads even when its colour matches the
        //surroundings. Drawn ON TOP of the extrusions so the outlines
        //sit over the building edges at ground level.
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
        this.map.addLayer(
        {
            id:     'helios-buildings-home-outline',
            source: 'helios-buildings-home-src',
            type:   'line',
            paint:
            {
                'line-color':   '#000000',
                'line-width':   2,
                'line-opacity': 0.85
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
        const apiKey = this.apiKey;
        if (!apiKey)
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
            apiKey,
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
    //    HD only for now, see helios-lidar.ts).
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

        const provider = findLidarSource(this.homeLat, this.homeLon);
        if (!provider || !this._shadowsEnabled())
        {
            this._lidarShadowFeatures  = null;
            this._lidarShadowKey       = '';
            this._lidarShadowAbort?.abort();
            this._lidarShadowAbort     = undefined;
            return;
        }

        const level      = this._lidarPrecisionLevel();
        const rasterSize = LIDAR_PRECISION_RASTER[level];
        const radius     = this._buildingRadiusMeters();
        const key = `${this.homeLat.toFixed(6)}|${this.homeLon.toFixed(6)}|${radius}|${rasterSize}`;
        if (this._lidarShadowKey === key && this._lidarShadowFeatures) return;

        this._lidarShadowAbort?.abort();
        const ac = new AbortController();
        this._lidarShadowAbort = ac;
        this._lidarShadowKey   = key;

        console.info(`[HELIOS-ENGINE] LiDAR shadow fetch: provider=${provider.id}, level=${level}, raster=${rasterSize}, radius=${radius}m`);

        provider.fetchShadowRegions({
            homeLat:          this.homeLat,
            homeLon:          this.homeLon,
            radiusMeters:     radius,
            rasterSize,
            cropRadiusMeters: radius,
            signal:           ac.signal
        })
        .then(fc =>
        {
            if (ac.signal.aborted || !this.map) return;
            this._lidarShadowFeatures = fc;
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
            this._lidarShadowFeatures = null;
            this._lidarShadowKey      = '';
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

        //Hillshade, direction from sun azimuth; exaggeration scales with
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
                //peak of ~1.6 (around altitude 6°) lands at 1.04, over the
                //ceiling. Clamp here so we get the maximum allowed effect
                //rather than a paint-validation warning every frame.
                const finalExg = Math.min(1, userExg * dramaScale);
                this.map.setPaintProperty('helios-hillshade', 'hillshade-exaggeration', finalExg);
                this.map.setPaintProperty('helios-hillshade', 'hillshade-shadow-color', shadowCol);
            }
            catch (_) {}
        }

        //Night-shade overlay, the primary day/night cue.
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
                    //Civil twilight, deep blue
                    const u = (altitude + 6) / 6;
                    nsColor   = '#0a1240';
                    nsOpacity = this._lerp(0.50, 0.30, u);
                }
                else if (altitude < 6)
                {
                    //Sunrise/sunset, warm amber wash, light opacity so the
                    //satellite imagery still reads but the time-of-day cue
                    //is unambiguous.
                    const u = altitude / 6;
                    nsColor   = '#3a1408';
                    nsOpacity = this._lerp(0.30, 0.10, u);
                }
                else if (altitude < 20)
                {
                    //Low sun, fading wash
                    const u = (altitude - 6) / 14;
                    nsColor   = '#3a1408';
                    nsOpacity = this._lerp(0.10, 0.0, u);
                }
                else
                {
                    //Full daylight, overlay invisible
                    nsColor   = '#000000';
                    nsOpacity = 0;
                }

                this.map.setPaintProperty('helios-night-shade', 'fill-color',   nsColor);
                this.map.setPaintProperty('helios-night-shade', 'fill-opacity', nsOpacity);
            }
            catch (_) {}
        }

        //Buildings, modulate their colour by sun altitude so they
        //participate in the time-of-day mood. We blend the configured
        //daylight reference towards a cool dark ink at night and
        //towards a warm tint around sunrise/sunset.
        try
        {
            const baseHex = this._buildingColor();

            let buildingHex: string;
            if (altitude < -6)
            {
                //Deep night, buildings as dark indigo silhouettes
                buildingHex = this._mixHex(baseHex, '#0a0e1a', 0.85);
            }
            else if (altitude < 0)
            {
                //Civil twilight, fade in/out of night
                const u = (altitude + 6) / 6;
                const dark = this._mixHex(baseHex, '#0a0e1a', 0.85);
                const dusk = this._mixHex(baseHex, '#2a2540', 0.55);
                buildingHex = this._lerpHex(dark, dusk, u);
            }
            else if (altitude < 6)
            {
                //Sunrise/sunset, warm wash
                const u = altitude / 6;
                const dusk = this._mixHex(baseHex, '#2a2540', 0.55);
                const warm = this._mixHex(baseHex, '#5a3220', 0.35);
                buildingHex = this._lerpHex(dusk, warm, u);
            }
            else if (altitude < 20)
            {
                //Low sun, fade warm tint back to base
                const u = (altitude - 6) / 14;
                const warm = this._mixHex(baseHex, '#5a3220', 0.35);
                buildingHex = this._lerpHex(warm, baseHex, u);
            }
            else
            {
                //Full daylight, exact user-defined colour
                buildingHex = baseHex;
            }

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
            const polar = altitude > 0
                ? Math.max(0, Math.min(89, 90 - altitude))
                : 89;
            this.map.setLight(
            {
                anchor:    'map',
                position:  [1.15, azimuth, polar],
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
            const shadowsSrc = this.map.getSource('helios-building-shadows-src') as
                               maplibregl.GeoJSONSource | undefined;
            if (shadowsSrc)
            {
                let input: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
                if (this._shadowsEnabled())
                {
                    if (this._lidarShadowFeatures && this._lidarShadowFeatures.features.length > 0)
                    {
                        input = this._lidarShadowFeatures;
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
                shadowsSrc.setData(projectExtrusionShadows(input,
                {
                    sunAzimuthDeg:    azimuth,
                    sunAltitudeDeg:   altitude,
                    homeLat:          this.homeLat,
                    //Clip shadows to the building visibility disc so
                    //they never extend past the rendered surroundings.
                    clipCenterLat:    this.homeLat,
                    clipCenterLon:    this.homeLon,
                    clipRadiusMeters: this._buildingRadiusMeters()
                }));
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
        const BATTERY_CHIP_Y_OFFSET_PX = 40;
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
        lon: number, lat: number, altitudeM: number,
        opts?: { anchorAtHome?: boolean }
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
        //
        //`anchorAtHome` queries the elevation at the HOME position
        //rather than at the projected point. The sun arc + sun disc
        //live on a celestial sphere centred on the home; using the
        //terrain elevation under the projected (often km-distant)
        //lon/lat would offset each arc vertex by a different ground
        //height, jaggering the arc when the terrain bends sharply
        //near the home. Anchoring at the home keeps every arc vertex
        //referenced to the same ground plane.
        const m: any = this.map as any;
        const queryLon = opts?.anchorAtHome ? this.homeLon : lon;
        const queryLat = opts?.anchorAtHome ? this.homeLat : lat;
        const terrainM = (typeof m.queryTerrainElevation === 'function')
            ? (m.queryTerrainElevation([queryLon, queryLat]) ?? 0)
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
            const px = this._projectScenePoint(sun3D.lon, sun3D.lat, sun3D.altitudeM,
                { anchorAtHome: true });
            if (!px)
            {
                continue;
            }
            const wm2 = computeIrradianceWm2(t, this.homeLat, this.homeLon, liveCloud);
            //altitudeM in _sunSpherePoint is R·sin(α), same sign as α,
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

        //Sun at "now", same spherical projection as the arc points.
        const sunNow3D = this._sunSpherePoint(now);
        const sunNowAlt = getSunPosition(now, this.homeLat, this.homeLon).altitude;
        const sunNowWm2 = computeIrradianceWm2(now, this.homeLat, this.homeLon, liveCloud);

        let sunScreen: { x: number; y: number; depth: number } | null = null;
        if (sunNow3D)
        {
            sunScreen = this._projectScenePoint(sunNow3D.lon, sunNow3D.lat, sunNow3D.altitudeM,
                { anchorAtHome: true });
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
        bumpStat('updateConfigCalls');
        const prevStyleId  = this._resolveMapStyle().id;
        const prevMinimal  = this._isMinimalStyle();
        const prevPerfMode    = this._performanceMode();
        const prevTerrainMax  = this._terrainMaxzoom();
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

        //Map-style, minimal-pruning toggle or terrain-detail change
        //→ reload the basemap. setStyle() replaces sources, layers,
        //sprites and glyphs; our custom sources (terrain included)
        //get wiped and re-added by the _onStyleLoad handler with
        //the current config values. Drop _mapReady while the new
        //style is in flight so other code paths don't operate on
        //a half-loaded style.
        const nextStyleInfo = this._resolveMapStyle();
        const nextTerrainMax = this._terrainMaxzoom();
        const styleNeedsReload =
               nextStyleInfo.id   !== prevStyleId
            || this._isMinimalStyle() !== prevMinimal
            || nextTerrainMax     !== prevTerrainMax;
        if (styleNeedsReload)
        {
            bumpStat('styleReloads');
            this._mapReady = false;
            this.map.setStyle(
                `https://api.maptiler.com/maps/${nextStyleInfo.id}/style.json?key=${this.apiKey}`
            );
            return;
        }

        //Performance-mode toggle: apply terrain / hillshade / pixel-
        //ratio changes in-place. Avoids the full style reload.
        const nextPerfMode = this._performanceMode();
        if (nextPerfMode !== prevPerfMode)
        {
            if (nextPerfMode)
            {
                this.map.setTerrain(null);
                if (this.map.getLayer('helios-hillshade'))
                {
                    this.map.removeLayer('helios-hillshade');
                }
                try { this.map.setPixelRatio(1.0); } catch (_) {}
            }
            else
            {
                this.map.setTerrain({ source: 'helios-terrain', exaggeration: 1.2 });
                this._initHillshade();
                const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
                const px  = IS_MOBILE
                    ? Math.min(Math.max(dpr, 1), 1.25)
                    : Math.min(Math.max(dpr, 1.5), 2);
                try { this.map.setPixelRatio(px); } catch (_) {}
            }
        }

        //Hillshade paint update, only when the layer still exists
        //(performance-mode removes it).
        if (this.map.getLayer('helios-hillshade'))
        {
            const c = toColor(this.cfg['topography-color'], 'rgba(80,100,160,1)');
            const a = toAlpha(this.cfg['topography-alpha'], 0.65);
            this.map.setPaintProperty('helios-hillshade', 'hillshade-shadow-color', c);
            this.map.setPaintProperty('helios-hillshade', 'hillshade-accent-color', c);
            this.map.setPaintProperty('helios-hillshade', 'hillshade-exaggeration', a);
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
            this._lidarShadowKey      = '';
            this._lidarShadowFeatures = null;
            this._ensureLidarFetched();
        }

        //Shadow opacity is a paint-level update on the single ground
        //shadow layer.
        const nextShadowOpa = this._shadowOpacity();
        if (nextShadowOpa !== prevShadowOpa)
        {
            for (const lid of SHADOW_LAYER_IDS)
            {
                if (this.map.getLayer(lid))
                {
                    try { this.map.setPaintProperty(lid, 'fill-opacity', nextShadowOpa); }
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
                this._lidarShadowFeatures = null;
                this._lidarShadowKey      = '';
                this._lidarShadowAbort?.abort();
                this._lidarShadowAbort    = undefined;
            }
            this._lastAtmosphereAlt = -999;
            this._refreshShadowsAndAtmosphere();
        }

        if (this._homeHourlyData && this._mapReady)
        {
            this._renderForCurrentSelection();
        }
    }

    //Smooth, time-based auto-rotation around the home. Runs in the
    //OPPOSITE direction to the sun's apparent motion (decreasing
    //bearing in NH, where the sun goes east → south → west, i.e.
    //clockwise from above) so the camera and the live sun visually
    //counter-orbit each other, a quiet but constant motion that
    //makes the card feel alive even with no user input. The
    //rotation pauses for `AUTO_ROTATE_INACTIVITY_MS` after every
    //user gesture (mouse down / wheel / touch) so the user has
    //full control during a manipulation, then resumes from
    //wherever the user left the camera, no recalibration to a
    //fixed bearing.
    //
    //We tween in seconds (delta-time integrated against the frame
    //rate) rather than a fixed per-frame increment so the rotation
    //speed is constant across 60 Hz / 120 Hz displays and survives
    //tab-throttling with no visible jumps when the user comes back.
    private static readonly AUTO_ROTATE_DEG_PER_SEC   = 1.5;
    private static readonly AUTO_ROTATE_INACTIVITY_MS = 5_000;

    private _startAutoRotateLoop(): void
    {
        if (this._autoRotateRaf !== undefined || !this.map)
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
            //`!== false` means an undefined config (the common case)
            //is treated as opted-in. The user has to explicitly set
            //`auto-rotate-enabled: false` to disable the orbit.
            const autoRotateEnabled = this.cfg['auto-rotate-enabled'] !== false;
            if (autoRotateEnabled && sinceUser >= HeliosEngine.AUTO_ROTATE_INACTIVITY_MS)
            {
                //Negative delta: bearing decreases, camera rotates
                //counter-clockwise around the up axis as seen
                //from above, map content drifts clockwise on
                //screen, opposite of the sun's apparent motion.
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
        bumpStat('enginesCleanedUp');
        _liveEngines.delete(this);
        this._clearWeatherTimer();
        window.clearInterval(this._skyTimer);
        window.clearTimeout(this._resizeDebounceTimer);
        this._fetchAbortController?.abort();
        this._buildingsAbort?.abort();
        this._lidarShadowAbort?.abort();
        this._lidarShadowAbort    = undefined;
        this._lidarShadowFeatures = null;
        this._lidarShadowKey      = '';
        this._resizeObserver?.disconnect();
        if (this._autoRotateRaf !== undefined)
        {
            cancelAnimationFrame(this._autoRotateRaf);
            this._autoRotateRaf = undefined;
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

        const canvas = this._bumpInactivityCanvas;

        //Step 1, DOM listeners on the canvas (inactivity bumper,
        //single-pointer drag-rotate, WebGL context lost/restored).
        if (canvas && this._bumpInactivityHandler)
        {
            canvas.removeEventListener('mousedown',  this._bumpInactivityHandler);
            canvas.removeEventListener('wheel',      this._bumpInactivityHandler);
            canvas.removeEventListener('touchstart', this._bumpInactivityHandler);
            canvas.removeEventListener('touchmove',  this._bumpInactivityHandler);
        }
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
        this._bumpInactivityCanvas  = undefined;
        this._bumpInactivityHandler = undefined;
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