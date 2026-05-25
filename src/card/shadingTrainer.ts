//Shading-map trainer: replays the physics model over the user's
//last few days of PV history and accumulates per-cell residuals
//into the persistent shading map. Run from the same refresh path
//that already computes the scalar calibration, so each chart
//cycle moves the map forward without a separate scheduler.
//
//Card-layer module: knows the host shape, the PvHistory parser,
//the weather series. The engine half lives in
//`src/engine/shadingMap.ts` and is pure-function so this trainer
//can be tested against fixtures without touching the engine.

import { getSunPosition } from '../engine/sun';
import {
    applyObservation,
    loadMap,
    saveMap,
    type ShadingMap,
} from '../engine/shadingMap';
import { computePvPowerWeighted, pvCalibK, pvNormalizeToWatts, type PvHistory } from './pv';
import { getHomeCoords } from './init';
import type { ChartHost } from './charts';


//How far back to walk on each refresh. Matches the scalar
//calibration's 5-day window so any sample that contributed to the
//calibration ratio also contributes to the shading map. We add a
//small margin so a freshly-loaded card whose `lastTrainedMs` was
//never set picks up the same horizon as the calibration without
//needing a separate priming pass.
const TRAINING_WINDOW_DAYS = 7;

//One-hour buckets aligned to the hourly weather series. Anything
//finer would chase noise from the sensor; anything coarser would
//lose the "sun at azimuth X for one hour" resolution the map is
//meant to capture.
const HOUR_MS = 3_600_000;


//Run one training pass + persist. Cheap to call repeatedly: only
//touches buckets that ended after `map.lastTrainedMs` and skips
//bucket centres in the future. Returns the number of cells
//updated so the caller can log "n cells trained" if it cares.
export function trainShadingMap(host: ChartHost): number
{
    const k      = pvCalibK(host.config);
    const series = host._chartSeries;
    const hist   = host._pvHistory;
    const coords = getHomeCoords(host.config, host.hass);
    if (k === null || k <= 0 || !series || !hist || !coords) return 0;
    if (hist.times.length < 2 || series.times.length < 2)    return 0;

    const map = loadMap();
    const now = Date.now();
    const windowStart = now - TRAINING_WINDOW_DAYS * 24 * HOUR_MS;
    //Skip buckets we've already processed. Subtract one hour so a
    //bucket that was still partially in the future last time gets
    //a second look once it fully landed in the past.
    const watermark = Math.max(windowStart, (map.lastTrainedMs || 0) - HOUR_MS);

    const raster   = host._engine?.getLidarRaster() ?? null;
    const pvUnit   = host._pvUnit;
    const sensorIsEnergy = isCumulativeEnergyUnit(pvUnit);

    let updated = 0;
    let highestProcessedMs = map.lastTrainedMs || 0;

    //Walk the hourly forecast series; each entry is the
    //model's view of one wall-clock hour. We compare it against
    //the actual production averaged over the same hour. The
    //series is already chronological + hour-aligned by the engine,
    //so a single forward sweep covers everything in O(N).
    for (let i = 0; i < series.times.length; i++)
    {
        const hourStartMs = series.times[i].getTime();
        const hourEndMs   = hourStartMs + HOUR_MS;
        if (hourEndMs <= watermark) continue;          //already trained
        if (hourEndMs > now)        continue;          //future, no actual yet
        if (hourStartMs < windowStart) continue;       //older than the window

        const cloud = series.cloud[i] ?? 0;
        //pct = % of STC; multiplying by k gives the model's
        //expected watts at the hour midpoint. Same call the live
        //tooltip + chart make, so the residual we compute here
        //matches the residual the forecast will show.
        const pct = computePvPowerWeighted(host.config, series.times[i], coords.lat, coords.lon, cloud, {
            airTempC: series.temperature?.[i] ?? NaN,
            windMs:   series.windSpeed?.[i]   ?? NaN,
            raster,
        });
        const predictedW = pct * k;
        if (!isFinite(predictedW) || predictedW <= 0) continue;

        const actualW = actualWattsForHour(hist, pvUnit, sensorIsEnergy, hourStartMs, hourEndMs);
        if (actualW === null) continue;

        const sun = getSunPosition(series.times[i], coords.lat, coords.lon);
        if (!sun || sun.altitude <= 0) continue;

        if (applyObservation(
            map,
            sun.azimuth,
            sun.altitude,
            cloud,
            actualW,
            predictedW,
            hourStartMs + HOUR_MS / 2,   //bucket centre for time-decay anchoring
        ))
        {
            updated++;
        }
        if (hourEndMs > highestProcessedMs) highestProcessedMs = hourEndMs;
    }

    if (updated > 0)
    {
        map.lastTrainedMs = highestProcessedMs;
        saveMap(map);
    }
    return updated;
}


//Surface the current map to callers that want to apply it at
//forecast time (charts.ts). Cached load is fine: the trainer
//saves on every meaningful update and the engine reads happen
//inside the same render tick, so a stale read for one frame is
//never visible.
let _cachedMap: ShadingMap | null = null;
let _cachedLoadedAt = 0;
const CACHE_TTL_MS = 5_000;

export function currentShadingMap(): ShadingMap
{
    const now = Date.now();
    if (_cachedMap && (now - _cachedLoadedAt) < CACHE_TTL_MS) return _cachedMap;
    _cachedMap = loadMap();
    _cachedLoadedAt = now;
    return _cachedMap;
}

export function invalidateShadingMapCache(): void
{
    _cachedMap = null;
    _cachedLoadedAt = 0;
}


//-----------------------------------------------------------------
//Hour-bucket helpers. Power sensors get trapezoidal-mean watts;
//cumulative energy sensors get delta-energy / hour. Returns null
//when the bucket has no usable coverage (gap in the history, no
//pair of samples bracketing the window).

function isCumulativeEnergyUnit(unit: string): boolean
{
    const u = (unit || '').toLowerCase();
    return u === 'wh' || u === 'kwh' || u === 'mwh';
}

function actualWattsForHour(
    hist:     PvHistory,
    pvUnit:   string,
    asEnergy: boolean,
    startMs:  number,
    endMs:    number,
): number | null
{
    if (hist.times.length < 2) return null;
    if (asEnergy) return actualWattsFromEnergyHour(hist, pvUnit, startMs, endMs);
    return actualWattsFromPowerHour(hist, pvUnit, startMs, endMs);
}

function actualWattsFromEnergyHour(
    hist:    PvHistory,
    pvUnit:  string,
    startMs: number,
    endMs:   number,
): number | null
{
    const unit = pvUnit.toLowerCase();
    const energyFactor = unit === 'wh' ? 1 / 1000 : unit === 'mwh' ? 1000 : 1;   //-> kWh
    let kwh = 0;
    let saw = false;
    for (let i = 1; i < hist.times.length; i++)
    {
        const tMs = hist.times[i].getTime();
        if (tMs < startMs || tMs >= endMs) continue;
        const dv = hist.values[i] - hist.values[i - 1];
        if (!isFinite(dv) || dv < 0) continue;
        kwh += dv * energyFactor;
        saw = true;
    }
    if (!saw) return null;
    //kWh per hour bucket = average kW = average W * 1000.
    return kwh * 1000;
}

function actualWattsFromPowerHour(
    hist:    PvHistory,
    pvUnit:  string,
    startMs: number,
    endMs:   number,
): number | null
{
    //Trapezoidal mean: sum(area under consecutive segments that
    //fall inside the bucket) / bucket duration. Skips gaps > 30
    //min so a long sensor outage doesn't poison the bucket with a
    //flat linear interpolation across many hours.
    let area = 0;
    let span = 0;
    let saw = false;
    for (let i = 1; i < hist.times.length; i++)
    {
        const tCurr = hist.times[i].getTime();
        const tPrev = hist.times[i - 1].getTime();
        //Clip segment to [startMs, endMs].
        const segStart = Math.max(tPrev, startMs);
        const segEnd   = Math.min(tCurr, endMs);
        if (segEnd <= segStart) continue;
        const dt = tCurr - tPrev;
        if (dt <= 0 || dt > 30 * 60_000) continue;
        const wPrev = pvNormalizeToWatts(hist.values[i - 1], pvUnit);
        const wCurr = pvNormalizeToWatts(hist.values[i],     pvUnit);
        if (!isFinite(wPrev) || !isFinite(wCurr)) continue;
        //Linearly interpolate the segment endpoints to the bucket
        //clip so partial overlaps are scaled correctly.
        const f0 = (segStart - tPrev) / dt;
        const f1 = (segEnd   - tPrev) / dt;
        const wA = wPrev + (wCurr - wPrev) * f0;
        const wB = wPrev + (wCurr - wPrev) * f1;
        area += ((wA + wB) / 2) * (segEnd - segStart);
        span += (segEnd - segStart);
        saw = true;
    }
    if (!saw || span <= 0) return null;
    return area / span;
}
