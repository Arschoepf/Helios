//Shading-map trainer: replays the physics model over the user's last few days of PV history and accumulates per-cell residuals into the persistent
//shading map. Run from the same refresh path that already computes the scalar calibration, so each chart cycle moves the map forward without a
//separate scheduler.
//
//Card-layer module: knows the host shape, the PvHistory parser, the weather series. The engine half lives in `src/engine/shadingMap.ts` and is
//pure-function so this trainer can be tested against fixtures without touching the engine.

import { getSunPosition } from '../engine/sun';
import {
    applyObservation,
    exportMapJson,
    importMapJson,
    loadMap,
    mergeMaps,
    resetMap,
    saveMap,
    type ShadingMap,
} from '../engine/shadingMap';
import { computePvPowerWeighted, inverterCutoffSocPct, pvCalibK, pvNormalizeToWatts, valueAtMs, type PvHistory } from './pv';
import { getHomeCoords } from './init';
import type { ChartHost } from './charts';


//Home Assistant user_data key. Mirrors the local localStorage entry but lives under the per-user namespace HA exposes via the frontend WebSocket
//commands, so opening the card on a different device pulls the same map the original device has been training.
const HA_USER_DATA_KEY = 'helios-shading-map';

//Debounce window for the cross-device push: a chart redraw on hover can trigger trainShadingMap several times per second, but we don't want to spam
//frontend.set_user_data with the same payload over and over. One push every 30 s is plenty.
const PUSH_DEBOUNCE_MS = 30_000;


//How far back to walk on each refresh. 30 days lines up with the
//PV history fetch + the Open-Meteo past_days payload, so a fresh
//install with no shading map ends up training on every observed
//bucket from the last month rather than only the last week. The
//watermark makes this cheap on subsequent passes (we only touch
//the buckets that landed since the previous run).
const TRAINING_WINDOW_DAYS = 30;

//30-minute buckets. Halves the slot length so each cell gets
//twice the data, captures shading events that come and go
//within an hour (a parked car, a passing isolated cloud, a tree
//branch swinging in wind), and stays well above the per-sample
//noise floor of any reasonable PV sensor. Open-Meteo cloud
//cover is hourly so we linearly interpolate between consecutive
//hourly samples to get the bucket's representative cloud value.
const HOUR_MS     = 3_600_000;
const BUCKET_MS   = 30 * 60_000;
const BUCKETS_PER_HOUR = 2;


//Run one training pass + persist. Cheap to call repeatedly: only touches buckets that ended after `map.lastTrainedMs` and skips bucket centres in the
//future. Returns the number of cells updated so the caller can log "n cells trained" if it cares.
export function trainShadingMap(host: ChartHost): number
{
    const k      = pvCalibK(host.config);
    const series = host._chartSeries;
    const hist   = host._pvHistory;
    const coords = getHomeCoords(host.config, host.hass);
    if (k === null || k <= 0 || !series || !hist || !coords) return 0;
    if (hist.times.length < 2 || series.times.length < 2)    return 0;
    //Fire-and-forget pull from HA on the first call; the latch in
    //syncShadingMapFromHomeAssistant() guarantees one pull per
    //page load, and a merge always lands cleanly because we only
    //ever pull before pushing.
    void syncShadingMapFromHomeAssistant(host.hass);

    const map = loadMap();
    const now = Date.now();
    const windowStart = now - TRAINING_WINDOW_DAYS * 24 * HOUR_MS;
    //Skip buckets we've already processed. Subtract one bucket so a bucket that was partially in the future last time gets a second look once it
    //fully landed in the past.
    const watermark = Math.max(windowStart, (map.lastTrainedMs || 0) - BUCKET_MS);

    const raster   = host._engine?.getLidarRaster() ?? null;
    const pvUnit   = host._pvUnit;
    const sensorIsEnergy = isCumulativeEnergyUnit(pvUnit);

    //Inverter-cutoff guard: when the user has configured both `battery-soc-entity` and `inverter-cutoff-soc-pct`, skip every bucket whose battery
    //SoC at the midpoint reached or exceeded the cutoff. Those buckets see the inverter clamp PV output even when the sun is up, training them as
    //"shadow" would otherwise carve a permanent phantom shadow at the matching sun azimuth/altitude/cloud bin. Threshold varies per inverter model
    //(95 / 98 / 100), the user knows their own; we just consult the config and the freshly-fetched SoC history.
    const cutoffPct = inverterCutoffSocPct(host.config);
    const socSeries = (cutoffPct !== null) ? host._batteryHistory : null;

    let updated = 0;
    let skippedInhibit = 0;
    let highestProcessedMs = map.lastTrainedMs || 0;

    //Walk every 30-min bucket between the hourly samples we already have. For each bucket we interpolate the cloud cover from the surrounding hourly
    //Open-Meteo samples, replay the model at the bucket midpoint, and compare against the actual production averaged over the bucket. This gives us
    //2x the observations per cell vs the legacy hourly-only loop without changing the per-cell data model.
    for (let i = 0; i < series.times.length - 1; i++)
    {
        const t0Ms = series.times[i].getTime();
        const t1Ms = series.times[i + 1].getTime();
        if (t1Ms - t0Ms !== HOUR_MS) continue;   //skip non-hourly gaps
        const cloud0 = series.cloud[i]     ?? 0;
        const cloud1 = series.cloud[i + 1] ?? 0;
        const temp0  = series.temperature?.[i]     ?? NaN;
        const temp1  = series.temperature?.[i + 1] ?? NaN;
        const wind0  = series.windSpeed?.[i]     ?? NaN;
        const wind1  = series.windSpeed?.[i + 1] ?? NaN;

        for (let b = 0; b < BUCKETS_PER_HOUR; b++)
        {
            const bucketStartMs = t0Ms + b * BUCKET_MS;
            const bucketEndMs   = bucketStartMs + BUCKET_MS;
            if (bucketEndMs <= watermark) continue;
            if (bucketEndMs > now)        continue;
            if (bucketStartMs < windowStart) continue;

            //Linear interpolation across the parent hour. b=0
            //samples a quarter into the hour (centre of bucket 0),
            //b=1 three-quarters in (centre of bucket 1).
            const frac    = (b + 0.5) / BUCKETS_PER_HOUR;
            const cloud   = cloud0 + (cloud1 - cloud0) * frac;
            const airT    = lerpFinite(temp0, temp1, frac);
            const windMs  = lerpFinite(wind0, wind1, frac);
            const tMid    = new Date(bucketStartMs + BUCKET_MS / 2);

            const pct = computePvPowerWeighted(host.config, tMid, coords.lat, coords.lon, cloud, {
                airTempC: airT,
                windMs,
                raster,
            });
            const predictedW = pct * k;
            if (!isFinite(predictedW) || predictedW <= 0) continue;

            const actualW = actualWattsForBucket(hist, pvUnit, sensorIsEnergy, bucketStartMs, bucketEndMs);
            if (actualW === null) continue;

            const sun = getSunPosition(tMid, coords.lat, coords.lon);
            if (!sun || sun.altitude <= 0) continue;

            //Inverter-cutoff inhibit. If the user's hybrid setup is configured to clamp PV when the battery hits a certain SoC, the bucket is
            //tainted: actual production is artificially low even though the sun is shining, and feeding that to the shading model would teach it
            //"strong shadow at this azimuth/altitude" forever. We drop the bucket entirely; the cell falls back to either the scalar calibration
            //or its existing prior. The watermark still advances so we don't re-evaluate the same bucket on the next refresh.
            if (cutoffPct !== null && socSeries !== null)
            {
                const soc = valueAtMs(socSeries, tMid.getTime());
                if (soc !== null && soc >= cutoffPct)
                {
                    skippedInhibit++;
                    if (bucketEndMs > highestProcessedMs) highestProcessedMs = bucketEndMs;
                    continue;
                }
            }

            if (applyObservation(map, sun.azimuth, sun.altitude, cloud, actualW, predictedW, tMid.getTime()))
            {
                updated++;
            }
            if (bucketEndMs > highestProcessedMs) highestProcessedMs = bucketEndMs;
        }
    }

    if (updated > 0)
    {
        map.lastTrainedMs = highestProcessedMs;
        saveMap(map);
        invalidateShadingMapCache();
        schedulePushToHomeAssistant(host.hass, map);
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

//Linear interpolation that gracefully falls back when one of the
//endpoints is NaN (typical when the weather series has a single
//missing field at one of the hour boundaries).
function lerpFinite(a: number, b: number, frac: number): number
{
    if (!isFinite(a) && !isFinite(b)) return NaN;
    if (!isFinite(a)) return b;
    if (!isFinite(b)) return a;
    return a + (b - a) * frac;
}

function actualWattsForBucket(
    hist:     PvHistory,
    pvUnit:   string,
    asEnergy: boolean,
    startMs:  number,
    endMs:    number,
): number | null
{
    if (hist.times.length < 2) return null;
    if (asEnergy) return actualWattsFromEnergyBucket(hist, pvUnit, startMs, endMs);
    return actualWattsFromPowerBucket(hist, pvUnit, startMs, endMs);
}

function actualWattsFromEnergyBucket(
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
    //Bucket-average watts = (kWh in window) / (window hours) * 1000.
    const windowHours = (endMs - startMs) / 3_600_000;
    if (windowHours <= 0) return null;
    return (kwh / windowHours) * 1000;
}

function actualWattsFromPowerBucket(
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
        //Linearly interpolate the segment endpoints to the bucket clip so partial overlaps are scaled correctly.
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


//-----------------------------------------------------------------
//Home Assistant sync: pull the cloud map at card init and merge
//it with the local one so a fresh device picks up everything the
//user's other devices have already trained. Push happens
//debounced after each trainShadingMap pass so the cloud copy
//stays current without us spamming the WebSocket.

//Per-page-load latch to avoid pulling on every render tick; the
//first chart render pulls, subsequent ones reuse whatever is on
//disk + in cache.
let _pulledFromHomeAssistant = false;

//Last-saved payload string + timer handle for the push debounce. We snapshot the stringified map at the time the timer fires so two pushes within the
//debounce window collapse to one network call carrying the latest state.
let _pushTimer: ReturnType<typeof setTimeout> | null = null;

export async function syncShadingMapFromHomeAssistant(hass: any): Promise<boolean>
{
    if (_pulledFromHomeAssistant) return false;
    _pulledFromHomeAssistant = true;
    if (!hass || typeof hass.callWS !== 'function') return false;
    let remoteRaw: string | null = null;
    try
    {
        const reply = await hass.callWS({
            type:  'frontend/get_user_data',
            key:   HA_USER_DATA_KEY,
        });
        const value = reply && typeof reply === 'object' ? (reply as { value?: unknown }).value : null;
        if (typeof value === 'string') remoteRaw = value;
        else if (value && typeof value === 'object') remoteRaw = JSON.stringify(value);
    }
    catch (_) { return false; }
    if (!remoteRaw) return false;
    const remote = importMapJson(remoteRaw);
    if (!remote) return false;
    const local  = loadMap();
    const merged = mergeMaps(local, remote);
    saveMap(merged);
    invalidateShadingMapCache();
    return true;
}

function schedulePushToHomeAssistant(hass: any, _map: ShadingMap): void
{
    if (!hass || typeof hass.callWS !== 'function') return;
    if (_pushTimer !== null) clearTimeout(_pushTimer);
    _pushTimer = setTimeout(() =>
    {
        _pushTimer = null;
        //Re-read so we push whatever is on disk at the moment the
        //debounced timer fires, not the snapshot we had when the
        //first call landed; subsequent trains in the window are
        //already saved.
        const latest = loadMap();
        const payload = exportMapJson(latest);
        try
        {
            hass.callWS({
                type:  'frontend/set_user_data',
                key:   HA_USER_DATA_KEY,
                value: payload,
            });
        }
        catch (_) { /* user_data WS unavailable, sync gracefully degrades to local-only */ }
    }, PUSH_DEBOUNCE_MS);
}


//-----------------------------------------------------------------
//Editor-facing helpers: export / import / reset wired to the
//buttons in the shading-map section.

export function exportCurrentShadingMap(): string
{
    return exportMapJson(loadMap());
}

export function importShadingMapJson(raw: string): boolean
{
    const parsed = importMapJson(raw);
    if (!parsed) return false;
    saveMap(parsed);
    invalidateShadingMapCache();
    return true;
}

export function resetShadingMap(): void
{
    resetMap();
    invalidateShadingMapCache();
}
