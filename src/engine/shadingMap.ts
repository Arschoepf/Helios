//Adaptive shading map: a learned-residual layer that sits on top
//of the physics-based PV forecast. The scalar self-calibration
//ratio captures static biases (orientation, soiling, inverter
//loss) as one number per day; this map captures structured
//residuals that depend on where the sun is and how cloudy it is,
//like a tree that shades the panels at sunset on clear days but
//is invisible to the LiDAR scan.
//
//The map is a sparse grid of (azimuth_bin x altitude_bin x
//cloud_bin) cells. Each cell holds a time-decayed weighted mean
//of the observed (actual / predicted) ratios that landed in it.
//Reads use a small gaussian kernel over the neighbouring cells so
//a single new observation doesn't drag a whole cell on its own
//and so sparse-but-adjacent observations cooperate.
//
//Engine module, pure-function: no DOM, no Home Assistant, no
//rendering. Storage adapter is injected so the unit tests can use
//an in-memory backend.

const AZIMUTH_BIN_DEG  = 10;   //36 bins covering [0, 360)
const ALTITUDE_BIN_DEG = 5;    //18 bins covering [0, 90)
const AZIMUTH_BIN_COUNT  = 36;
const ALTITUDE_BIN_COUNT = 18;
//Cloud cover bins: clear / partly / mostly / overcast. We avoid
//finer resolution because the Open-Meteo cloud field is noisy
//enough that 4 bins already track most of the structure.
const CLOUD_BIN_EDGES = [0, 25, 50, 75, 100];   //inclusive low, exclusive high (last is inclusive)
const CLOUD_BIN_COUNT = CLOUD_BIN_EDGES.length - 1;

//Half-life over which an observation loses half its weight. 60 d
//is the right scale for seasonal change (deciduous trees losing
//or growing leaves) without being so short that a normal cloudy
//week erases everything we learned about sunny days.
const HALFLIFE_DAYS = 60;
const DAY_MS = 86_400_000;

//Confidence floor for using the map's value at all. Below this
//effective sample count the lookup returns null and the caller
//falls back to the scalar calibration. 3 is the smallest number
//where the within-cell EMA isn't dominated by the first sample.
const MIN_EFFECTIVE_SAMPLES = 3;

//Per-cell hard cap on the multiplier so a single corrupt
//actual / predicted pair (sensor outage producing zero, e.g.)
//can't push the forecast off by 10x.
const RATIO_MIN = 0.3;
const RATIO_MAX = 1.7;

const STORAGE_KEY = 'helios-shading-map:v1';


export interface ShadingCell
{
    //Time-decayed weighted mean of the observed actual / predicted
    //ratios that landed in this cell.
    ema: number;
    //Sum of decayed weights. Acts as an effective sample count
    //(in [0, +inf)) for confidence weighting.
    w:   number;
    //Last time this cell was updated, used to decay `w` on the
    //next update so seasons can be re-learned.
    t:   number;
}

export interface ShadingMap
{
    //Versioned shape so a future schema change can invalidate the
    //stored payload without crashing the card on first load.
    version: 1;
    //Watermark used by the trainer so it only feeds new
    //observations into the map instead of re-counting the same
    //hour every refresh.
    lastTrainedMs: number;
    //Sparse cell store keyed by `cellKey(az, alt, cloud)`.
    cells: Record<string, ShadingCell>;
}


//Bin coordinates from a (azimuth, altitude, cloud) sample. Clamped
//so the lookup never wanders outside the valid ranges; an azimuth
//of exactly 360 wraps to 0, an altitude > 89 saturates to the top
//bin.
export interface BinCoord { az: number; alt: number; cloud: number; }

export function binFor(azimuthDeg: number, altitudeDeg: number, cloudPct: number): BinCoord | null
{
    if (!isFinite(azimuthDeg) || !isFinite(altitudeDeg) || !isFinite(cloudPct)) return null;
    if (altitudeDeg <= 0) return null;   //Below horizon, no PV, no signal.
    const az  = ((Math.floor(((azimuthDeg % 360) + 360) % 360 / AZIMUTH_BIN_DEG)) | 0);
    const alt = Math.max(0, Math.min(ALTITUDE_BIN_COUNT - 1, Math.floor(altitudeDeg / ALTITUDE_BIN_DEG)));
    let cloud = CLOUD_BIN_COUNT - 1;
    const c = Math.max(0, Math.min(100, cloudPct));
    for (let i = 0; i < CLOUD_BIN_COUNT; i++)
    {
        if (c < CLOUD_BIN_EDGES[i + 1] || i === CLOUD_BIN_COUNT - 1)
        {
            cloud = i;
            break;
        }
    }
    return { az, alt, cloud };
}

export function cellKey(c: BinCoord): string
{
    return `${c.az}|${c.alt}|${c.cloud}`;
}


export function emptyMap(): ShadingMap
{
    return { version: 1, lastTrainedMs: 0, cells: {} };
}


//Apply one observation: (actualWatts, predictedWatts, sunPos,
//cloud, timestamp). No-op if the inputs are degenerate (sun below
//horizon, predicted too small for a stable ratio, NaN anywhere).
//Returns true on success so the caller can count meaningful
//updates for telemetry.
export function applyObservation(
    map:           ShadingMap,
    sunAzimuthDeg: number,
    sunAltitudeDeg: number,
    cloudPct:      number,
    actualW:       number,
    predictedW:    number,
    timestampMs:   number,
): boolean
{
    if (!isFinite(actualW) || !isFinite(predictedW) || !isFinite(timestampMs)) return false;
    //Predicted floor: a 20 W reading driven by a 5 W prediction is
    //a 4x ratio that says nothing about systematic shading. Cut
    //off at 80 W so we only feed cells that the model is
    //confidently predicting non-trivial production for. Same idea
    //as MIN_DAY_PREDICTED_KWH in the scalar calibration.
    if (predictedW < 80 || actualW < 0) return false;
    const ratio = actualW / predictedW;
    if (!isFinite(ratio) || ratio <= 0) return false;
    const clamped = Math.max(RATIO_MIN, Math.min(RATIO_MAX, ratio));

    const bin = binFor(sunAzimuthDeg, sunAltitudeDeg, cloudPct);
    if (!bin) return false;

    const key  = cellKey(bin);
    const cell = map.cells[key];
    if (!cell)
    {
        map.cells[key] = { ema: clamped, w: 1, t: timestampMs };
        return true;
    }

    //Time decay: cells age before they get re-weighted. An
    //observation made 60 d after the cell's last update halves
    //its prior weight so a single fresh observation has the same
    //influence as the entire accumulated history of two months
    //ago. This is what lets seasonal change land cleanly.
    const dDays = Math.max(0, (timestampMs - cell.t) / DAY_MS);
    const retained = cell.w * Math.pow(0.5, dDays / HALFLIFE_DAYS);
    const newW = retained + 1;
    cell.ema = (cell.ema * retained + clamped) / newW;
    cell.w   = newW;
    cell.t   = timestampMs;
    return true;
}


//Look up the effective ratio for a forecast point. Reads the
//target cell plus its 26 neighbours (3 az x 3 alt x 3 cloud
//cube around it), weighted by both a small gaussian kernel and
//each neighbour's effective sample count. Returns null when the
//combined weight is too small to trust, in which case the caller
//should fall back to the scalar calibration or 1.0.
export interface LookupResult
{
    ratio:      number;
    confidence: number;   //in [0, 1]
}

export function lookupRatio(
    map:           ShadingMap,
    sunAzimuthDeg: number,
    sunAltitudeDeg: number,
    cloudPct:      number,
    nowMs:         number,
): LookupResult | null
{
    const target = binFor(sunAzimuthDeg, sunAltitudeDeg, cloudPct);
    if (!target) return null;

    //Kernel sigma = 1 cell in each dimension. Within-cell weight
    //is 1, immediate neighbour 0.61, diagonal 0.37, far corner
    //0.22. Sums to ~5.4 across the cube when fully populated, so
    //the confidence cap below uses 3 effective samples to feel
    //"enough".
    const SIGMA2 = 2;    //2 * sigma^2 with sigma = 1
    let num = 0;
    let den = 0;

    for (let dAz = -1; dAz <= 1; dAz++)
    {
        for (let dAlt = -1; dAlt <= 1; dAlt++)
        {
            for (let dC = -1; dC <= 1; dC++)
            {
                const az    = ((target.az + dAz) % AZIMUTH_BIN_COUNT + AZIMUTH_BIN_COUNT) % AZIMUTH_BIN_COUNT;
                const alt   = target.alt + dAlt;
                if (alt < 0 || alt >= ALTITUDE_BIN_COUNT) continue;
                const cloud = target.cloud + dC;
                if (cloud < 0 || cloud >= CLOUD_BIN_COUNT) continue;
                const cell = map.cells[cellKey({ az, alt, cloud })];
                if (!cell) continue;

                //Age-decay the cell's effective weight on read so a
                //stale six-month-old cell can't pose as fresh data.
                const dDays = Math.max(0, (nowMs - cell.t) / DAY_MS);
                const aged  = cell.w * Math.pow(0.5, dDays / HALFLIFE_DAYS);
                if (aged <= 0) continue;

                const dist2 = dAz * dAz + dAlt * dAlt + dC * dC;
                const kernel = Math.exp(-dist2 / SIGMA2);
                const weight = aged * kernel;
                num += weight * cell.ema;
                den += weight;
            }
        }
    }

    if (den <= 0) return null;
    const ratio = num / den;
    const confidence = Math.min(1, den / MIN_EFFECTIVE_SAMPLES);
    if (confidence < 0.33) return null;   //den < 1 effective sample, not enough yet
    return { ratio, confidence };
}


//Blend the map's per-cell ratio with the scalar fallback so a
//cell that only just started accumulating data still contributes
//something instead of jumping abruptly once it crosses the
//confidence threshold.
export function blendedRatio(lookup: LookupResult | null, fallback: number): number
{
    if (!lookup) return fallback;
    return lookup.ratio * lookup.confidence + fallback * (1 - lookup.confidence);
}


//-----------------------------------------------------------------
//Persistence: localStorage-backed, version-gated. Tests inject an
//in-memory storage so the round-trip can be exercised without a
//browser.

export interface MapStorage
{
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

function safeStorage(): MapStorage | null
{
    try
    {
        if (typeof window === 'undefined') return null;
        const ls = (window as { localStorage?: MapStorage }).localStorage;
        if (!ls) return null;
        return ls;
    }
    catch (_) { return null; }
}

export function loadMap(storage: MapStorage | null = safeStorage()): ShadingMap
{
    if (!storage) return emptyMap();
    try
    {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) return emptyMap();
        const parsed = JSON.parse(raw) as ShadingMap;
        if (!parsed || parsed.version !== 1 || typeof parsed.cells !== 'object') return emptyMap();
        //Trust the cell shape; future schema bumps invalidate via the
        //version field. Empty `cells` is fine, that's a fresh install.
        return {
            version: 1,
            lastTrainedMs: typeof parsed.lastTrainedMs === 'number' ? parsed.lastTrainedMs : 0,
            cells: parsed.cells || {},
        };
    }
    catch (_) { return emptyMap(); }
}

export function saveMap(map: ShadingMap, storage: MapStorage | null = safeStorage()): void
{
    if (!storage) return;
    try { storage.setItem(STORAGE_KEY, JSON.stringify(map)); }
    catch (_) { /* quota or disabled, give up silently */ }
}


//-----------------------------------------------------------------
//Diagnostics: how many cells are populated, how many are
//effectively-confident, the strongest +/- residuals. Useful for
//the debug heatmap view and for telemetry summaries; not used by
//the forecast itself.

export interface MapStats
{
    cells:           number;
    confidentCells:  number;
    strongestUnder:  { key: string; ratio: number; w: number } | null;
    strongestOver:   { key: string; ratio: number; w: number } | null;
}

export function describeMap(map: ShadingMap, nowMs: number): MapStats
{
    let confidentCells = 0;
    let strongestUnder: MapStats['strongestUnder'] = null;
    let strongestOver:  MapStats['strongestOver']  = null;
    const keys = Object.keys(map.cells);
    for (const key of keys)
    {
        const cell = map.cells[key];
        const dDays = Math.max(0, (nowMs - cell.t) / DAY_MS);
        const aged  = cell.w * Math.pow(0.5, dDays / HALFLIFE_DAYS);
        if (aged >= MIN_EFFECTIVE_SAMPLES) confidentCells++;
        if (aged < 1) continue;
        if (cell.ema < 0.9 && (!strongestUnder || cell.ema < strongestUnder.ratio))
        {
            strongestUnder = { key, ratio: cell.ema, w: aged };
        }
        if (cell.ema > 1.1 && (!strongestOver || cell.ema > strongestOver.ratio))
        {
            strongestOver = { key, ratio: cell.ema, w: aged };
        }
    }
    return { cells: keys.length, confidentCells, strongestUnder, strongestOver };
}
