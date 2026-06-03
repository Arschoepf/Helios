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
//Engine module, pure-function: no DOM, no Home Assistant, no rendering. Storage adapter is injected so the unit tests can use an in-memory backend.

const AZIMUTH_BIN_DEG  = 10;   //36 bins covering [0, 360)
const ALTITUDE_BIN_DEG = 5;    //18 bins covering [0, 90)
const AZIMUTH_BIN_COUNT  = 36;
const ALTITUDE_BIN_COUNT = 18;
//Cloud cover bins: 8 bins at 12.5 % each. The light-to-overcast
//transmittance curve is highly non-linear (a 70-90 % sky lets
//roughly twice as much through as a 90-100 % sky), so finer
//resolution near the upper end matters more than the user might
//assume; we keep uniform width across the range for symmetry
//and let the EMA / kernel smoothing absorb the noise.
const CLOUD_BIN_EDGES = [0, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];   //inclusive low, exclusive high (last is inclusive)
const CLOUD_BIN_COUNT = CLOUD_BIN_EDGES.length - 1;

//Half-life over which an observation loses half its weight. 60 d
//is the right scale for seasonal change (deciduous trees losing
//or growing leaves) without being so short that a normal cloudy
//week erases everything we learned about sunny days.
const HALFLIFE_DAYS = 60;
const DAY_MS = 86_400_000;

//Confidence floor for using the map's value at all. Below this
//effective sample count the lookup returns null and the caller
//falls back to the scalar calibration. 2 keeps the lookups
//tolerant enough that a fresh 30-day install reaches a useful
//count of trusted cells within days; the kernel-smoothed
//averaging across the 27-cell neighbourhood absorbs the extra
//noise from cells that have only 2 raw observations.
const MIN_EFFECTIVE_SAMPLES = 2;

//Per-cell hard cap on the multiplier so a single corrupt
//actual / predicted pair (sensor outage producing zero, e.g.)
//can't push the forecast off by 10x.
const RATIO_MIN = 0.3;
const RATIO_MAX = 1.7;

//Storage key carries a schema version so a future cloud-cover
//bin change can land without silently corrupting cells already on
//disk; older keys are ignored and the model relearns from scratch.
const STORAGE_KEY = 'helios-shading-map:v2';


export interface ShadingCell
{
    //Time-decayed weighted mean of the observed actual / predicted ratios that landed in this cell.
    ema: number;
    //Sum of decayed weights. Acts as an effective sample count
    //(in [0, +inf)) for confidence weighting.
    w:   number;
    //Last time this cell was updated, used to decay `w` on the next update so seasons can be re-learned.
    t:   number;
}

export interface ShadingMap
{
    //Versioned shape so a future schema change can invalidate the stored payload without crashing the card on first load.
    version: 2;
    //Watermark used by the trainer so it only feeds new observations into the map instead of re-counting the same hour every refresh.
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
    if (!isFinite(azimuthDeg) || !isFinite(altitudeDeg) || !isFinite(cloudPct))
    {
        return null;
    }
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
    return { version: 2, lastTrainedMs: 0, cells: {} };
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
    if (!isFinite(actualW) || !isFinite(predictedW) || !isFinite(timestampMs))
    {
        return false;
    }
    //Predicted floor: a 20 W reading driven by a 5 W prediction is a 4x ratio that says nothing about systematic shading. Cut off at 80 W so we only
    //feed cells that the model is confidently predicting non-trivial production for. Same idea as MIN_DAY_PREDICTED_KWH in the scalar calibration.
    if (predictedW < 80 || actualW < 0)
    {
        return false;
    }
    const ratio = actualW / predictedW;
    if (!isFinite(ratio) || ratio <= 0)
    {
        return false;
    }
    const clamped = Math.max(RATIO_MIN, Math.min(RATIO_MAX, ratio));

    const bin = binFor(sunAzimuthDeg, sunAltitudeDeg, cloudPct);
    if (!bin)
    {
        return false;
    }

    const key  = cellKey(bin);
    const cell = map.cells[key];
    if (!cell)
    {
        map.cells[key] = { ema: clamped, w: 1, t: timestampMs };
        return true;
    }

    //Time decay: cells age before they get re-weighted. An observation made 60 d after the cell's last update halves its prior weight so a single
    //fresh observation has the same influence as the entire accumulated history of two months ago. This is what lets seasonal change land cleanly.
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
    if (!target)
    {
        return null;
    }

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
                if (alt < 0 || alt >= ALTITUDE_BIN_COUNT)
                {
                    continue;
                }
                const cloud = target.cloud + dC;
                if (cloud < 0 || cloud >= CLOUD_BIN_COUNT)
                {
                    continue;
                }
                const cell = map.cells[cellKey({ az, alt, cloud })];
                if (!cell)
                {
                    continue;
                }

                //Age-decay the cell's effective weight on read so a stale six-month-old cell can't pose as fresh data.
                const dDays = Math.max(0, (nowMs - cell.t) / DAY_MS);
                const aged  = cell.w * Math.pow(0.5, dDays / HALFLIFE_DAYS);
                if (aged <= 0)
                {
                    continue;
                }

                const dist2 = dAz * dAz + dAlt * dAlt + dC * dC;
                const kernel = Math.exp(-dist2 / SIGMA2);
                const weight = aged * kernel;
                num += weight * cell.ema;
                den += weight;
            }
        }
    }

    if (den <= 0)
    {
        return null;
    }
    const ratio = num / den;
    const confidence = Math.min(1, den / MIN_EFFECTIVE_SAMPLES);
    if (confidence < 0.33) return null;   //den below a third of MIN_EFFECTIVE_SAMPLES, not enough kernel weight yet
    return { ratio, confidence };
}


//Blend the map's per-cell ratio with the scalar fallback so a cell that only just started accumulating data still contributes something instead of
//jumping abruptly once it crosses the confidence threshold.
export function blendedRatio(lookup: LookupResult | null, fallback: number): number
{
    if (!lookup)
    {
        return fallback;
    }
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
        if (typeof window === 'undefined')
        {
            return null;
        }
        const ls = (window as { localStorage?: MapStorage }).localStorage;
        if (!ls)
        {
            return null;
        }
        return ls;
    }
    catch (_) { return null; }
}

//In-memory cache of the parsed map. The dome refresh path calls
//loadMap() on every map move while the shading dome is active,
//and the underlying payload can grow past 50 KB after weeks of
//training. Each call is `localStorage.getItem` + `JSON.parse`
//running synchronously on the main thread, blocking 10-50 ms per
//hit on Safari and Firefox: the classic source of mini-freezes
//under manual rotation. We cache the parsed object and invalidate
//it whenever the caller writes back via saveMap / resetMap.
let _cachedMap: ShadingMap | null = null;

function _invalidateLoadMapCache(): void
{
    _cachedMap = null;
}


export function loadMap(storage: MapStorage | null = safeStorage()): ShadingMap
{
    if (_cachedMap)
    {
        return _cachedMap;
    }
    if (!storage)
    {
        _cachedMap = emptyMap();
        return _cachedMap;
    }
    try
    {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw)
        {
            _cachedMap = emptyMap();
            return _cachedMap;
        }
        const parsed = JSON.parse(raw) as ShadingMap;
        if (!parsed || parsed.version !== 2 || typeof parsed.cells !== 'object')
        {
            _cachedMap = emptyMap();
            return _cachedMap;
        }
        //Trust the cell shape; future schema bumps invalidate via the
        //version field. Empty `cells` is fine, that's a fresh install.
        _cachedMap = {
            version: 2,
            lastTrainedMs: typeof parsed.lastTrainedMs === 'number' ? parsed.lastTrainedMs : 0,
            cells: parsed.cells || {},
        };
        return _cachedMap;
    }
    catch (_)
    {
        _cachedMap = emptyMap();
        return _cachedMap;
    }
}

export function saveMap(map: ShadingMap, storage: MapStorage | null = safeStorage()): void
{
    //Keep the in-memory cache aligned with what just got persisted
    //so the next loadMap() call hits the cache instead of round-
    //tripping through JSON.parse.
    _cachedMap = map;
    if (!storage)
    {
        return;
    }
    try { storage.setItem(STORAGE_KEY, JSON.stringify(map)); }
    catch (_) { /* quota or disabled, give up silently */ }
}

export function resetMap(storage: MapStorage | null = safeStorage()): ShadingMap
{
    const fresh = emptyMap();
    _invalidateLoadMapCache();
    if (storage)
    {
        try { storage.setItem(STORAGE_KEY, JSON.stringify(fresh)); }
        catch (_) { /* fine, in-memory caller still gets the reset */ }
    }
    return fresh;
}


//Merge two maps cell-by-cell into a new map. Used for the Home Assistant cross-device sync: a device pulls the cloud copy on init and merges it with
//whatever local-only training has happened since the last push. Per-cell rule: combine the two EMAs as a weight-weighted average of the time-decayed
//remote and time-decayed local cells. lastTrainedMs takes the max so neither side reprocesses observations the other already saw.
export function mergeMaps(a: ShadingMap, b: ShadingMap, nowMs: number = Date.now()): ShadingMap
{
    const out: ShadingMap = {
        version: 2,
        lastTrainedMs: Math.max(a.lastTrainedMs || 0, b.lastTrainedMs || 0),
        cells: {},
    };
    const keys = new Set<string>();
    for (const k of Object.keys(a.cells))
    {
        keys.add(k);
    }
    for (const k of Object.keys(b.cells))
    {
        keys.add(k);
    }
    for (const k of keys)
    {
        const ca = a.cells[k];
        const cb = b.cells[k];
        if (ca && !cb) { out.cells[k] = { ...ca }; continue; }
        if (cb && !ca) { out.cells[k] = { ...cb }; continue; }
        //Both sides have this cell: weighted mean of the time-decayed weights so a stale-but-heavy cell can't drown out a fresh high-confidence cell.
        //Anchor the merged cell at the later of the two timestamps so future observations decay from the correct reference point.
        const dDaysA = Math.max(0, (nowMs - ca.t) / DAY_MS);
        const dDaysB = Math.max(0, (nowMs - cb.t) / DAY_MS);
        const wA = ca.w * Math.pow(0.5, dDaysA / HALFLIFE_DAYS);
        const wB = cb.w * Math.pow(0.5, dDaysB / HALFLIFE_DAYS);
        const wSum = wA + wB;
        if (wSum <= 0) { out.cells[k] = ca.t >= cb.t ? { ...ca } : { ...cb }; continue; }
        out.cells[k] = {
            ema: (ca.ema * wA + cb.ema * wB) / wSum,
            w:   wSum,
            t:   Math.max(ca.t, cb.t),
        };
    }
    return out;
}


//Plain-text export: pretty-printed JSON so a human can eyeball the cells from a downloaded file. Round-trippable through importMapJson.
export function exportMapJson(map: ShadingMap): string
{
    return JSON.stringify(map, null, 2);
}

//Validate-and-load a JSON string into a ShadingMap. Returns null
//when the payload is malformed (wrong version, missing fields,
//bad cell shape). The caller is expected to fall back to its
//current map rather than overwrite it with garbage.
export function importMapJson(raw: string): ShadingMap | null
{
    try
    {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object')
        {
            return null;
        }
        if (parsed.version !== 2)
        {
            return null;
        }
        if (!parsed.cells || typeof parsed.cells !== 'object')
        {
            return null;
        }
        const cells: Record<string, ShadingCell> = {};
        for (const key of Object.keys(parsed.cells))
        {
            const c = parsed.cells[key];
            if (!c || typeof c.ema !== 'number' || typeof c.w !== 'number' || typeof c.t !== 'number')
            {
                continue;
            }
            if (!isFinite(c.ema) || !isFinite(c.w) || !isFinite(c.t))
            {
                continue;
            }
            cells[key] = { ema: c.ema, w: c.w, t: c.t };
        }
        return {
            version: 2,
            lastTrainedMs: typeof parsed.lastTrainedMs === 'number' ? parsed.lastTrainedMs : 0,
            cells,
        };
    }
    catch (_) { return null; }
}


//Decoded back-conversion of a cellKey() string. Used by the
//debug heatmap to project each populated cell back to its
//(azimuth midpoint, altitude midpoint, cloud bin). Returns null
//for invalid keys so a corrupt entry can't crash the render.
export interface DecodedCell
{
    azimuthDeg:  number;
    altitudeDeg: number;
    cloudBin:    number;
    cell:        ShadingCell;
}

export function decodeCellKey(key: string, cell: ShadingCell): DecodedCell | null
{
    const parts = key.split('|');
    if (parts.length !== 3)
    {
        return null;
    }
    const az    = parseInt(parts[0], 10);
    const alt   = parseInt(parts[1], 10);
    const cloud = parseInt(parts[2], 10);
    if (!isFinite(az) || !isFinite(alt) || !isFinite(cloud))
    {
        return null;
    }
    return {
        azimuthDeg:  az * AZIMUTH_BIN_DEG  + AZIMUTH_BIN_DEG  / 2,
        altitudeDeg: alt * ALTITUDE_BIN_DEG + ALTITUDE_BIN_DEG / 2,
        cloudBin:    cloud,
        cell,
    };
}

//Convenience for callers that want the labels for the cloud bins in a UI selector. Mirrors CLOUD_BIN_EDGES.
export const CLOUD_BIN_LABELS = [
    '0-12.5%', '12.5-25%', '25-37.5%', '37.5-50%',
    '50-62.5%', '62.5-75%', '75-87.5%', '87.5-100%',
];
export const CLOUD_BIN_COUNT_EXPORT = CLOUD_BIN_COUNT;
export const HALFLIFE_DAYS_EXPORT = HALFLIFE_DAYS;


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
        if (aged >= MIN_EFFECTIVE_SAMPLES)
        {
            confidentCells++;
        }
        if (aged < 1)
        {
            continue;
        }
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
