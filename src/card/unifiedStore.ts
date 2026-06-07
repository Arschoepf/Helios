//Unified 5-day data store. Single source of truth for every per-time signal the dashboard cards,
//the radial sundial, the graph view and the main UI timeline read from. Replaces the per-card / per-
//consumer bucketization passes that used to walk the raw history arrays + the weather series at every
//render: the store is built ONCE after the underlying fetches land, cached on the host, sliced /
//interpolated by every downstream consumer at look-up time. Live numeric chips deliberately stay on
//the direct hass.states path (no extra layer between the live entity value and the chip text), every
//other surface that draws or hovers a curve uses the store.
//
//Window: J-2 to J+2 at 15 min granularity = 5 days × 96 buckets / day = 480 buckets per series.
//Step:   STORE_STEP_MS = 15 × 60 × 1000 = 900 000 ms.
//Origin: storeStartMs = midnight (local time) of (today - 2 days), so bucket 0 sits at the J-2 day
//        start and bucket 192 is today's midnight.
//
//Each series in the store is an array of length STORE_BUCKETS. null marks "no data" for that bucket;
//consumers either skip it visually (curve collapses to baseline) or interpolate over it via
//valueAt(). The series carry:
//  - irradiance W/m² (weather model, interpolated between hourly samples)
//  - cloud %        (weather model, interpolated between hourly samples)
//  - production W   (HA Energy stat_energy_from / stat_rate, past actual)
//  - forecast W     (computePvPowerWeighted × calibration × shading map, every bucket)
//  - battery W      (signed, charging positive, history-driven, past only)
//  - batterySoc %   (history-driven, past only)
//  - gridImport W   (slope of cumulative kWh meter, past only)
//  - gridExport W   (slope of cumulative kWh meter, past only)

import type { HeliosConfig } from '../helios-config';
import type { ChartSeries } from './charts';
import type { PvHistory } from './pv';
import { pvNormalizeToWatts, pvCalibK, pvInverterMaxW, computePvPowerWeighted } from './pv';
import { effectiveForecastRatio } from './charts';
import { computeForecastCalibration } from './calibration';
import { trainShadingMap, currentShadingMap } from './shadingTrainer';
import { getHomeCoords } from './init';


const HOUR_MS = 3_600_000;
const DAY_MS  = 24 * HOUR_MS;

export const BUCKETS_PER_HOUR = 4;
export const BUCKETS_PER_DAY  = 24 * BUCKETS_PER_HOUR;     // 96
export const STORE_STEP_MS    = HOUR_MS / BUCKETS_PER_HOUR; // 900 000
export const STORE_DAYS_PAST  = 2;
export const STORE_DAYS_AHEAD = 2;
export const STORE_DAYS       = STORE_DAYS_PAST + 1 + STORE_DAYS_AHEAD; // 5
export const STORE_BUCKETS    = STORE_DAYS * BUCKETS_PER_DAY;            // 480


export interface UnifiedDataStore
{
    //Reference timestamps. storeStartMs is midnight of (today - STORE_DAYS_PAST) days local; storeEndMs
    //is midnight of (today + STORE_DAYS_AHEAD + 1) days local. Bucket i covers [storeStartMs + i ×
    //STORE_STEP_MS, storeStartMs + (i + 1) × STORE_STEP_MS).
    storeStartMs: number;
    storeEndMs:   number;
    //Build-time-stamp + data-version hash so consumers can cheaply detect "this store is the same as
    //the one I rendered against last frame" without comparing every series. Currently used by the
    //live-append path to decide whether to mutate-in-place or trigger a full rebuild upstream.
    builtAtMs:    number;
    dataVersion:  string;

    irradiance:   (number | null)[];
    cloud:        (number | null)[];
    production:   (number | null)[];
    forecast:     (number | null)[];
    battery:      (number | null)[];
    batterySoc:   (number | null)[];
    gridImport:   (number | null)[];
    gridExport:   (number | null)[];
}


//Structural host surface required to build the store. Mirrors the union of what every per-metric
//builder needs to read; the actual card / dashboard host implements a superset of this.
export interface UnifiedStoreHost
{
    readonly config:                  HeliosConfig | undefined;
    readonly hass:                    { language?: string; states?: Record<string, { state: string }>; config?: { latitude?: number; longitude?: number } } | undefined;
    readonly _chartSeries:            ChartSeries | null;
    readonly _pvHistory:              PvHistory | null;
    readonly _pvCalibStats:           PvHistory | null;
    readonly _pvUnit:                 string;
    readonly _batteryPowerHistory:    { times: Date[]; values: number[] } | null;
    readonly _batteryPowerUnit:       string;
    readonly _batterySoc:             number | null;
    readonly _gridImportSamples:      Map<string, Array<{ t: number; v: number }>>;
    readonly _gridExportSamples:      Map<string, Array<{ t: number; v: number }>>;
    readonly _gridImportUnits:        Map<string, string>;
    readonly _gridExportUnits:        Map<string, string>;
    readonly _engine?:                { getLidarRaster(): import('../engine/pv-shading').NdsmRaster | null };
}


//Bucket arithmetic helpers. Bucketing is HALF-OPEN: a sample at time t lands in bucket
//Math.floor((t - storeStartMs) / STORE_STEP_MS). Out-of-window samples return -1.
function bucketForMs(storeStartMs: number, ms: number): number
{
    if (ms < storeStartMs) { return -1; }
    const idx = Math.floor((ms - storeStartMs) / STORE_STEP_MS);
    if (idx >= STORE_BUCKETS) { return -1; }
    return idx;
}

function bucketMidMs(storeStartMs: number, bucket: number): number
{
    return storeStartMs + bucket * STORE_STEP_MS + STORE_STEP_MS / 2;
}


//Fill null gaps in a sparse array with linear interpolation between the bracketing non-null samples.
//Edges (before the first non-null, after the last non-null) carry the nearest non-null forward /
//backward so the consumer always sees a continuous progression where it makes sense to extrapolate.
function interpolateNullGaps(arr: (number | null)[]): void
{
    const N = arr.length;
    let i = 0;
    while (i < N)
    {
        if (arr[i] !== null) { i++; continue; }
        let j = i;
        while (j < N && arr[j] === null) { j++; }
        const prev = i > 0 ? arr[i - 1] : null;
        const next = j < N ? arr[j]     : null;
        if (prev === null && next === null) { return; }
        if (prev === null)
        {
            for (let k = i; k < j; k++) { arr[k] = next; }
        }
        else if (next === null)
        {
            for (let k = i; k < N; k++) { arr[k] = prev; }
            return;
        }
        else
        {
            const span = j - i + 1;
            for (let k = i; k < j; k++)
            {
                const t = (k - i + 1) / span;
                arr[k] = prev + (next - prev) * t;
            }
        }
        i = j;
    }
}


//Midnight (local time) of the J-2 day. Used as the store origin so every per-day slice lines up on
//calendar day boundaries.
function storeOriginMs(): number
{
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime() - STORE_DAYS_PAST * DAY_MS;
}


//---------------------------------------------------------------------------------------------------
//Per-metric builders. Each walks one source array (or a small set of sources), bucketizes the
//in-window samples and returns a length-STORE_BUCKETS array. Builders that depend on already-built
//series take them as a second argument so the build order stays explicit.
//---------------------------------------------------------------------------------------------------


function buildIrradiance(host: UnifiedStoreHost, storeStartMs: number, storeEndMs: number): (number | null)[]
{
    const out = new Array<number | null>(STORE_BUCKETS).fill(null);
    const series = host._chartSeries;
    if (!series || series.times.length === 0) { return out; }
    const sums   = new Array<number>(STORE_BUCKETS).fill(0);
    const counts = new Array<number>(STORE_BUCKETS).fill(0);
    for (let i = 0; i < series.times.length; i++)
    {
        const t = series.times[i].getTime();
        if (t < storeStartMs || t >= storeEndMs) { continue; }
        const v = series.irradiance?.[i];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) { continue; }
        const h = bucketForMs(storeStartMs, t);
        if (h < 0) { continue; }
        sums[h]   += v;
        counts[h] += 1;
    }
    for (let h = 0; h < STORE_BUCKETS; h++)
    {
        if (counts[h] > 0) { out[h] = sums[h] / counts[h]; }
    }
    //Weather model lands at 1 sample / hour, the rest of the buckets stay null until we interpolate.
    interpolateNullGaps(out);
    return out;
}


function buildCloud(host: UnifiedStoreHost, storeStartMs: number, storeEndMs: number): (number | null)[]
{
    const out = new Array<number | null>(STORE_BUCKETS).fill(null);
    const series = host._chartSeries;
    if (!series || series.times.length === 0) { return out; }
    const sums   = new Array<number>(STORE_BUCKETS).fill(0);
    const counts = new Array<number>(STORE_BUCKETS).fill(0);
    for (let i = 0; i < series.times.length; i++)
    {
        const t = series.times[i].getTime();
        if (t < storeStartMs || t >= storeEndMs) { continue; }
        const v = series.cloud[i];
        if (typeof v !== 'number' || !Number.isFinite(v)) { continue; }
        const h = bucketForMs(storeStartMs, t);
        if (h < 0) { continue; }
        sums[h]   += Math.max(0, Math.min(100, v));
        counts[h] += 1;
    }
    for (let h = 0; h < STORE_BUCKETS; h++)
    {
        if (counts[h] > 0) { out[h] = sums[h] / counts[h]; }
    }
    interpolateNullGaps(out);
    return out;
}


//Production = past actual + null for future (the forecast series carries the predicted curve). Past
//actual reads from the LTS calib stats first (cumulative kWh slope OR direct W samples depending on
//the entity unit), falls back to the per-minute raw history for the most recent slice that LTS hasn't
//caught up to yet.
function buildProduction(host: UnifiedStoreHost, storeStartMs: number, storeEndMs: number, nowMs: number, forecast: ReadonlyArray<number | null>): (number | null)[]
{
    const out = new Array<number | null>(STORE_BUCKETS).fill(null);
    const sums   = new Array<number>(STORE_BUCKETS).fill(0);
    const counts = new Array<number>(STORE_BUCKETS).fill(0);
    const unit  = (host._pvUnit || '').toLowerCase();
    const isCum = unit === 'wh' || unit === 'kwh' || unit === 'mwh';

    const ingestPower = (tMs: number, w: number): void =>
    {
        if (!Number.isFinite(w) || w < 0) { return; }
        if (tMs < storeStartMs || tMs >= storeEndMs || tMs > nowMs) { return; }
        const h = bucketForMs(storeStartMs, tMs);
        if (h < 0) { return; }
        sums[h]   += w;
        counts[h] += 1;
    };

    const calib = host._pvCalibStats;
    if (calib && calib.times.length >= 2)
    {
        if (isCum)
        {
            let prevIdx = 0;
            for (let i = 1; i < calib.times.length; i++)
            {
                const t1  = calib.times[i].getTime();
                const t0  = calib.times[prevIdx].getTime();
                const dtH = (t1 - t0) / HOUR_MS;
                if (dtH <= 0 || dtH > 6) { prevIdx = i; continue; }
                const dv = calib.values[i] - calib.values[prevIdx];
                prevIdx = i;
                if (dv < 0) { continue; }
                const factor = unit === 'wh' ? 1 : unit === 'mwh' ? 1_000_000 : 1000;
                ingestPower(t1, (dv / dtH) * factor);
            }
        }
        else
        {
            for (let i = 0; i < calib.times.length; i++)
            {
                ingestPower(calib.times[i].getTime(), pvNormalizeToWatts(calib.values[i], host._pvUnit));
            }
        }
    }
    const hist = host._pvHistory;
    if (hist && hist.times.length > 0 && !isCum)
    {
        for (let i = 0; i < hist.times.length; i++)
        {
            ingestPower(hist.times[i].getTime(), pvNormalizeToWatts(hist.values[i], host._pvUnit));
        }
    }
    for (let h = 0; h < STORE_BUCKETS; h++)
    {
        if (counts[h] > 0) { out[h] = sums[h] / counts[h]; }
    }
    //Past bucket without a real sample: borrow the modelled W from the forecast at the same time, so
    //the production curve reads as a continuous day instead of dropping to zero between LTS samples.
    //If the forecast itself has no value (before sunrise, after sunset, no weather series), fall back
    //to 0 as the meaningful "no production happening here" value. Future buckets stay null, the
    //radial / timeline forecast curve owns the future-half of the screen.
    for (let h = 0; h < STORE_BUCKETS; h++)
    {
        const mid = bucketMidMs(storeStartMs, h);
        if (out[h] === null && mid < nowMs) { out[h] = forecast[h] ?? 0; }
    }
    return out;
}


//Forecast = computePvPowerWeighted × pvCalibK × effectiveForecastRatio at every bucket midpoint.
//Reads the per-bucket cloud from the already-built cloud series so the forecast resolves at the same
//granularity. Trains the shading map once per build before the loop so the map carries every fresh
//observation that landed between the previous build and this one.
function buildForecast(
    host: UnifiedStoreHost,
    storeStartMs: number,
    storeEndMs: number,
    cloud: ReadonlyArray<number | null>
): (number | null)[]
{
    const out = new Array<number | null>(STORE_BUCKETS).fill(null);
    const series = host._chartSeries;
    const coords = getHomeCoords(host.config, host.hass);
    if (!series || !coords) { return out; }
    const k = pvCalibK(host.config);
    if (k === null) { return out; }
    const cap     = pvInverterMaxW(host.config);
    const cal     = computeForecastCalibration(host as any);
    const calR    = cal ? cal.ratio : 1;
    trainShadingMap(host as any);
    const shading = currentShadingMap();
    const raster  = host._engine?.getLidarRaster() ?? null;
    const nowMs   = Date.now();
    for (let h = 0; h < STORE_BUCKETS; h++)
    {
        const mid = bucketMidMs(storeStartMs, h);
        if (mid < storeStartMs || mid >= storeEndMs) { continue; }
        const cc  = cloud[h] ?? 0;
        const t   = new Date(mid);
        const wRaw = computePvPowerWeighted(
            host.config,
            t,
            coords.lat,
            coords.lon,
            cc,
            {
                airTempC: undefined,
                windMs:   undefined,
                raster,
            }
        );
        const eff = effectiveForecastRatio(shading, t, coords.lat, coords.lon, cc, calR, nowMs);
        const w   = wRaw * k * eff;
        if (Number.isFinite(w))
        {
            out[h] = Math.min(cap, Math.max(0, w));
        }
    }
    return out;
}


function buildBattery(host: UnifiedStoreHost, storeStartMs: number, storeEndMs: number, nowMs: number): (number | null)[]
{
    const out = new Array<number | null>(STORE_BUCKETS).fill(null);
    const hist = host._batteryPowerHistory;
    if (!hist || hist.times.length === 0) { return out; }
    const sums   = new Array<number>(STORE_BUCKETS).fill(0);
    const counts = new Array<number>(STORE_BUCKETS).fill(0);
    for (let i = 0; i < hist.times.length; i++)
    {
        const tMs = hist.times[i].getTime();
        if (tMs < storeStartMs || tMs >= storeEndMs || tMs > nowMs) { continue; }
        const w = pvNormalizeToWatts(hist.values[i], host._batteryPowerUnit);
        if (!Number.isFinite(w)) { continue; }
        const h = bucketForMs(storeStartMs, tMs);
        if (h < 0) { continue; }
        sums[h]   += w;
        counts[h] += 1;
    }
    for (let h = 0; h < STORE_BUCKETS; h++)
    {
        if (counts[h] > 0) { out[h] = sums[h] / counts[h]; }
    }
    return out;
}


//Battery SoC: no per-bucket history today, so the only data we have is the live state. Park it on
//the bucket "now" sits in, leave every other bucket null. The store gets a single live observation
//per build, the cursor at the current bucket reads it, every other bucket falls to interpAt's
//forward / backward fill. This stays minimal on purpose: a per-bucket SoC history would need a new
//fetch path which is out of scope for this refactor.
function buildBatterySoc(host: UnifiedStoreHost, storeStartMs: number, nowMs: number): (number | null)[]
{
    const out = new Array<number | null>(STORE_BUCKETS).fill(null);
    const live = host._batterySoc;
    if (live === null || live === undefined || !Number.isFinite(live)) { return out; }
    const h = bucketForMs(storeStartMs, nowMs);
    if (h >= 0) { out[h] = Math.max(0, Math.min(100, live)); }
    return out;
}


//Grid import / export: per-entity sample maps carry cumulative kWh (or signed W in rare configs).
//Convert each entity's samples to per-bucket W via the same slope-derivation the radial dial used to
//do inline, sum across entities (multi-source installs), then bucketize.
function buildGridSlope(
    samplesByEntity: Map<string, Array<{ t: number; v: number }>>,
    unitsByEntity:   Map<string, string>,
    storeStartMs:    number,
    storeEndMs:      number,
    nowMs:           number
): (number | null)[]
{
    const out = new Array<number | null>(STORE_BUCKETS).fill(null);
    const sums   = new Array<number>(STORE_BUCKETS).fill(0);
    const counts = new Array<number>(STORE_BUCKETS).fill(0);
    samplesByEntity.forEach((samples, entityId) =>
    {
        const unit = (unitsByEntity.get(entityId) || '').toLowerCase();
        const isCum = unit === 'wh' || unit === 'kwh' || unit === 'mwh';
        const factor = unit === 'wh' ? 1 : unit === 'mwh' ? 1_000_000 : 1000;
        if (isCum)
        {
            for (let i = 1; i < samples.length; i++)
            {
                const t1  = samples[i].t;
                const t0  = samples[i - 1].t;
                const dtH = (t1 - t0) / HOUR_MS;
                if (dtH <= 0 || dtH > 6) { continue; }
                const dv = samples[i].v - samples[i - 1].v;
                if (!Number.isFinite(dv) || dv < 0) { continue; }
                if (t1 < storeStartMs || t1 >= storeEndMs || t1 > nowMs) { continue; }
                const h = bucketForMs(storeStartMs, t1);
                if (h < 0) { continue; }
                sums[h]   += (dv / dtH) * factor;
                counts[h] += 1;
            }
        }
        else
        {
            for (let i = 0; i < samples.length; i++)
            {
                const t = samples[i].t;
                if (t < storeStartMs || t >= storeEndMs || t > nowMs) { continue; }
                const w = samples[i].v;
                if (!Number.isFinite(w) || w < 0) { continue; }
                const h = bucketForMs(storeStartMs, t);
                if (h < 0) { continue; }
                sums[h]   += w;
                counts[h] += 1;
            }
        }
    });
    for (let h = 0; h < STORE_BUCKETS; h++)
    {
        if (counts[h] > 0) { out[h] = sums[h] / counts[h]; }
    }
    return out;
}


//Cheap data-version hash. Combines the lengths of every underlying source so a fetch that grows any
//of them invalidates the cache key. Not a content hash (would defeat the purpose of caching) but it
//catches every refresh path the card runs today.
function computeDataVersion(host: UnifiedStoreHost): string
{
    const seriesLen   = host._chartSeries?.times.length ?? 0;
    const pvHistLen   = host._pvHistory?.times.length   ?? 0;
    const pvCalibLen  = host._pvCalibStats?.times.length ?? 0;
    const battHistLen = host._batteryPowerHistory?.times.length ?? 0;
    let gridImpLen = 0;
    host._gridImportSamples.forEach(arr => { gridImpLen += arr.length; });
    let gridExpLen = 0;
    host._gridExportSamples.forEach(arr => { gridExpLen += arr.length; });
    const socLive = host._batterySoc ?? '';
    return `${seriesLen}|${pvHistLen}|${pvCalibLen}|${battHistLen}|${gridImpLen}|${gridExpLen}|${socLive}`;
}


//Top-level builder. Runs each per-metric pass in dependency order (cloud before forecast since the
//forecast loop reads cloud at each bucket midpoint). Pure function of the host snapshot: same input
//→ same output, no side effects on the host except shadingTrainer.trainShadingMap which advances the
//shading map state intentionally on every build.
export function buildUnifiedStore(host: UnifiedStoreHost): UnifiedDataStore
{
    const storeStartMs = storeOriginMs();
    const storeEndMs   = storeStartMs + STORE_DAYS * DAY_MS;
    const nowMs        = Date.now();
    const irradiance   = buildIrradiance(host, storeStartMs, storeEndMs);
    const cloud        = buildCloud(host, storeStartMs, storeEndMs);
    //Forecast is computed BEFORE production so the production builder can borrow the modelled W at any
    //past bucket where the recorder didn't land a sample. The LTS calib stats publish 1 sample / hour
    //while the store packs 4 buckets / hour, so without that fallback 3 buckets out of 4 in the past
    //would read as a hard zero and the radial dial production fill would draw as a sawtooth between
    //samples instead of as a continuous day curve.
    const forecast     = buildForecast(host, storeStartMs, storeEndMs, cloud);
    const production   = buildProduction(host, storeStartMs, storeEndMs, nowMs, forecast);
    const battery      = buildBattery(host, storeStartMs, storeEndMs, nowMs);
    const batterySoc   = buildBatterySoc(host, storeStartMs, nowMs);
    const gridImport   = buildGridSlope(host._gridImportSamples, host._gridImportUnits, storeStartMs, storeEndMs, nowMs);
    const gridExport   = buildGridSlope(host._gridExportSamples, host._gridExportUnits, storeStartMs, storeEndMs, nowMs);
    return {
        storeStartMs,
        storeEndMs,
        builtAtMs:   nowMs,
        dataVersion: computeDataVersion(host),
        irradiance,
        cloud,
        production,
        forecast,
        battery,
        batterySoc,
        gridImport,
        gridExport,
    };
}


//Returns true when the store already on the host matches the host's current data version. Lets the
//caller decide whether to skip a rebuild (cache stays warm) or trigger a fresh build.
export function isStoreFresh(host: UnifiedStoreHost, store: UnifiedDataStore | null): boolean
{
    if (!store) { return false; }
    return store.dataVersion === computeDataVersion(host);
}


//---------------------------------------------------------------------------------------------------
//Read-side accessors. Every downstream consumer (radial dial, graph view, timeline) goes through
//these so the bucket arithmetic stays in one place and the interpolation contract is consistent.
//---------------------------------------------------------------------------------------------------


//Linearly interpolate a series value at an exact timestamp. Returns null when the timestamp falls
//outside the store window OR both surrounding buckets are null.
export function valueAt(series: ReadonlyArray<number | null>, store: UnifiedDataStore, ms: number): number | null
{
    if (ms < store.storeStartMs || ms >= store.storeEndMs) { return null; }
    const stepFloat = (ms - store.storeStartMs) / STORE_STEP_MS - 0.5;
    const i0 = Math.max(0, Math.min(STORE_BUCKETS - 1, Math.floor(stepFloat)));
    const i1 = Math.max(0, Math.min(STORE_BUCKETS - 1, i0 + 1));
    const v0 = series[i0];
    const v1 = series[i1];
    if (v0 === null && v1 === null) { return null; }
    if (v0 === null) { return v1; }
    if (v1 === null) { return v0; }
    const f = Math.max(0, Math.min(1, stepFloat - i0));
    return v0 + (v1 - v0) * f;
}


//Bucket range for the day at offset `dayOffset` (-2..+2 typically). Returns the half-open
//[startBucket, endBucket) indices that cover that calendar day. Out-of-range offsets clamp to the
//store bounds.
export function dayBucketRange(store: UnifiedDataStore, dayOffset: number): { start: number; end: number }
{
    const dayStartMs = store.storeStartMs + (STORE_DAYS_PAST + dayOffset) * DAY_MS;
    const startBucket = Math.max(0, bucketForMs(store.storeStartMs, dayStartMs));
    const endBucket   = Math.min(STORE_BUCKETS, startBucket + BUCKETS_PER_DAY);
    return { start: startBucket, end: endBucket };
}


//Slice the per-day arrays for the card at `dayOffset`. Returns BUCKETS_PER_DAY-length series that
//drop straight into the dashboard radial / graph view in place of the legacy prepareRadialDayData
//bucketization.
export interface DaySlice
{
    dayStartMs:  number;
    dayEndMs:    number;
    pastEndHour: number;
    hourlyIrradiance: ReadonlyArray<number | null>;
    hourlyCloud:      ReadonlyArray<number | null>;
    hourlyProd:       ReadonlyArray<number | null>;
    hourlyForecast:   ReadonlyArray<number | null>;
    hourlyBatt:       ReadonlyArray<number | null>;
    hourlyBattSoc:    ReadonlyArray<number | null>;
    hourlyGridIn:     ReadonlyArray<number | null>;
    hourlyGridOut:    ReadonlyArray<number | null>;
}

export function sliceForDay(store: UnifiedDataStore, dayOffset: number): DaySlice
{
    const dayStartMs = store.storeStartMs + (STORE_DAYS_PAST + dayOffset) * DAY_MS;
    const dayEndMs   = dayStartMs + DAY_MS;
    const nowMs      = Date.now();
    const pastEndHour = dayEndMs <= nowMs ? 24
                      : dayStartMs >= nowMs ? 0
                      : (nowMs - dayStartMs) / HOUR_MS;
    const { start, end } = dayBucketRange(store, dayOffset);
    return {
        dayStartMs,
        dayEndMs,
        pastEndHour,
        hourlyIrradiance: store.irradiance.slice(start, end),
        hourlyCloud:      store.cloud.slice(start, end),
        hourlyProd:       store.production.slice(start, end),
        hourlyForecast:   store.forecast.slice(start, end),
        hourlyBatt:       store.battery.slice(start, end),
        hourlyBattSoc:    store.batterySoc.slice(start, end),
        hourlyGridIn:     store.gridImport.slice(start, end),
        hourlyGridOut:    store.gridExport.slice(start, end),
    };
}
