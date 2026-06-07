//Unified 5-day data source. Single source of truth for every per-time signal the dashboard cards,
//the radial sundial, the graph view and the main UI timeline read from. Replaces the per-card / per-
//consumer bucketization passes that used to walk the raw history arrays + the weather series at every
//render: the source is built ONCE after the underlying fetches land, cached on the host, sliced and
//re-sampled by every downstream consumer at look-up time. Live numeric chips deliberately stay on
//the direct hass.states path (no extra layer between the live entity value and the chip text), every
//other surface that draws or hovers a curve uses the source.
//
//Two cadence knobs, both modifiable at a single place:
//  1. DATA_BUCKETS_PER_HOUR  controls how dense the data source is. Every real sample (LTS hourly,
//     raw push, weather hourly, battery push) lands into a bucket of HOUR_MS / DATA_BUCKETS_PER_HOUR
//     duration. Buckets that didn't receive a real sample are filled with a linear interpolation
//     between the two surrounding real samples (never with a model fallback): the data source is
//     never lying about the actual sensor.
//  2. DISPLAY_BUCKETS_PER_HOUR controls how every graph (radial dial, timeline today, dashboard
//     chart) reads the source. sliceForDay() resamples each per-day slice to that rate. If the two
//     constants are equal the graph reads the source as is (same values as the storage cadence),
//     otherwise a linear resample bridges the two.
//
//Window: J-2 to J+2 = 5 days × (24 × DATA_BUCKETS_PER_HOUR) buckets per series. Origin: storeStartMs
//= midnight (local time) of (today - 2 days), so bucket 0 sits at the J-2 day start.
//
//Series carried (every one is an array of length STORE_BUCKETS, null marks "no real data and no
//surrounding real samples to interpolate between"):
//  - irradiance W/m² (weather model, interpolated between hourly samples)
//  - cloud %        (weather model, interpolated between hourly samples)
//  - production W   (PV LTS + raw history, interpolated between samples, no forecast mixed in)
//  - forecast W     (computePvPowerWeighted × calibration × shading map, every bucket, INDEPENDENT)
//  - battery W      (signed, history-driven, interpolated between samples)
//  - batterySoc %   (live observation only at the current bucket)
//  - gridImport W   (slope of cumulative kWh meter, interpolated between samples)
//  - gridExport W   (slope of cumulative kWh meter, interpolated between samples)
//
//Forecast is a peer of production, not a fallback for it. The radial dial overlays the forecast
//curve as a dashed line on top of the production fill; the two series are never mixed inside a
//single value.

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

//Storage cadence: how many real-sample slots the data source keeps per hour. Every per-time signal
//(production, forecast, weather, battery, grid) is held at this granularity. Change this value and
//every downstream consumer rescales automatically. Default 4 = 15 min slots, dense enough that the
//radial dial and the dashboard chart read as smooth curves without burning CPU on every render.
//PERF TEST: temporarily set to 60 (1 / minute) so the user can observe the rebuild + render cost.
export const DATA_BUCKETS_PER_HOUR    = 60;

//Display cadence: how many slots per hour every graph (radial dial, dashboard chart, timeline today)
//reads back from the data source. If equal to DATA_BUCKETS_PER_HOUR, sliceForDay returns the slice
//unchanged (every graph reads the exact storage values). If different, sliceForDay resamples
//linearly between the bracketing storage buckets so the graph stays a continuous curve. Change this
//value and every graph rescales together; the storage cadence is unaffected.
//PERF TEST: same 60 as the storage cadence so the user can observe the matching-rate path.
export const DISPLAY_BUCKETS_PER_HOUR = 60;

export const STORE_DAYS_PAST  = 2;
export const STORE_DAYS_AHEAD = 2;
export const STORE_DAYS       = STORE_DAYS_PAST + 1 + STORE_DAYS_AHEAD;
export const STORE_BUCKETS_PER_DAY = 24 * DATA_BUCKETS_PER_HOUR;
export const STORE_BUCKETS         = STORE_DAYS * STORE_BUCKETS_PER_DAY;
export const STORE_STEP_MS         = HOUR_MS / DATA_BUCKETS_PER_HOUR;
export const DISPLAY_BUCKETS_PER_DAY = 24 * DISPLAY_BUCKETS_PER_HOUR;


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


//Production = past actual only, no model fallback. Reads the LTS calib stats first (cumulative kWh
//slope OR direct W samples depending on the entity unit), then the per-minute raw history for the
//most recent slice that LTS hasn't caught up to yet. Buckets without a real sample are filled by
//linear interpolation between the bracketing real samples; the data source never blends a forecast
//value into a "real" series. Future buckets stay null (the forecast series owns the future curve).
function buildProduction(host: UnifiedStoreHost, storeStartMs: number, storeEndMs: number, nowMs: number): (number | null)[]
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
    //Restrict interpolation to the PAST half of the store. Past gaps between LTS samples (typically 3
    //buckets out of 4 at 4 / hour with 1 LTS row per hour) get filled with a value that lives strictly
    //between two real readings: the curve stays continuous AND honest. Future buckets stay null so
    //the forecast series stays the only thing the dial draws on the future half.
    const pastEnd = Math.min(STORE_BUCKETS, bucketForMs(storeStartMs, nowMs) + 1);
    if (pastEnd > 0)
    {
        const pastSlice = out.slice(0, pastEnd);
        interpolateNullGaps(pastSlice);
        for (let h = 0; h < pastEnd; h++) { out[h] = pastSlice[h]; }
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
    //Interpolate the past slice only, future stays null (battery has no model forecast).
    const pastEnd = Math.min(STORE_BUCKETS, bucketForMs(storeStartMs, nowMs) + 1);
    if (pastEnd > 0)
    {
        const pastSlice = out.slice(0, pastEnd);
        interpolateNullGaps(pastSlice);
        for (let h = 0; h < pastEnd; h++) { out[h] = pastSlice[h]; }
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
    //Interpolate past gaps between samples. Cumulative kWh meters publish at most every few minutes,
    //the store packs 4 buckets / hour, so gaps are common; linear interp keeps the slope curve smooth.
    const pastEnd = Math.min(STORE_BUCKETS, bucketForMs(storeStartMs, nowMs) + 1);
    if (pastEnd > 0)
    {
        const pastSlice = out.slice(0, pastEnd);
        interpolateNullGaps(pastSlice);
        for (let h = 0; h < pastEnd; h++) { out[h] = pastSlice[h]; }
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
    //Production reads ONLY real sensor samples (LTS + raw history), interpolating linearly between
    //them in the past slice. It never borrows from the forecast: keeping the two series strictly
    //separated is the whole point of the unified source. Forecast is computed in parallel as its own
    //series, the dial / chart layer them as two distinct curves at render time.
    const production   = buildProduction(host, storeStartMs, storeEndMs, nowMs);
    const forecast     = buildForecast(host, storeStartMs, storeEndMs, cloud);
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
    const endBucket   = Math.min(STORE_BUCKETS, startBucket + STORE_BUCKETS_PER_DAY);
    return { start: startBucket, end: endBucket };
}


//Resample a length-srcLen series to a length-dstLen series using linear interpolation between
//bracketing source buckets. Both arrays sit on the same time window (so position i in src and
//position j in dst map to the same time when (i + 0.5) / srcLen == (j + 0.5) / dstLen). Null source
//buckets stay null in the dst when both bracketing values are null; otherwise the non-null side
//carries through. dstLen == srcLen returns a copy.
function resampleLinear(src: ReadonlyArray<number | null>, dstLen: number): (number | null)[]
{
    const srcLen = src.length;
    if (dstLen === srcLen)
    {
        return src.slice() as (number | null)[];
    }
    const out = new Array<number | null>(dstLen).fill(null);
    if (srcLen === 0)
    {
        return out;
    }
    for (let j = 0; j < dstLen; j++)
    {
        //Centre of dst bucket j in normalised [0, srcLen] coordinates.
        const srcF = (j + 0.5) * srcLen / dstLen - 0.5;
        const i0 = Math.max(0, Math.min(srcLen - 1, Math.floor(srcF)));
        const i1 = Math.max(0, Math.min(srcLen - 1, i0 + 1));
        const v0 = src[i0];
        const v1 = src[i1];
        if (v0 === null && v1 === null) { continue; }
        if (v0 === null) { out[j] = v1; continue; }
        if (v1 === null) { out[j] = v0; continue; }
        const f = Math.max(0, Math.min(1, srcF - i0));
        out[j] = v0 + (v1 - v0) * f;
    }
    return out;
}


//Slice the per-day arrays for the card at `dayOffset`. Returns DISPLAY_BUCKETS_PER_DAY-length series
//resampled from the storage cadence so every graph reads at the same DISPLAY rate. If
//DISPLAY_BUCKETS_PER_HOUR == DATA_BUCKETS_PER_HOUR the resample is a straight copy and the graphs
//read the storage values verbatim, otherwise a linear resample bridges the two cadences.
export interface DaySlice
{
    dayStartMs:  number;
    dayEndMs:    number;
    pastEndHour: number;
    //All arrays have length DISPLAY_BUCKETS_PER_DAY.
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
    const N = DISPLAY_BUCKETS_PER_DAY;
    return {
        dayStartMs,
        dayEndMs,
        pastEndHour,
        hourlyIrradiance: resampleLinear(store.irradiance.slice(start, end), N),
        hourlyCloud:      resampleLinear(store.cloud.slice(start, end),      N),
        hourlyProd:       resampleLinear(store.production.slice(start, end), N),
        hourlyForecast:   resampleLinear(store.forecast.slice(start, end),   N),
        hourlyBatt:       resampleLinear(store.battery.slice(start, end),    N),
        hourlyBattSoc:    resampleLinear(store.batterySoc.slice(start, end), N),
        hourlyGridIn:     resampleLinear(store.gridImport.slice(start, end), N),
        hourlyGridOut:    resampleLinear(store.gridExport.slice(start, end), N),
    };
}


//Per-bucket samples covering an arbitrary [startMs, endMs] sub-window of the store. Used by the
//main timeline chart which renders the production + forecast curves across the visible 5-day window.
//Returns one entry per DISPLAY bucket whose centre falls inside the requested window; null entries
//indicate "no data" for that bucket. Out-of-store time stamps are clipped to the store window so
//the caller never gets samples outside the data source.
export interface RangeSlice
{
    times:      Date[];
    production: (number | null)[];
    forecast:   (number | null)[];
    cloud:      (number | null)[];
    irradiance: (number | null)[];
}

export function sliceForRange(store: UnifiedDataStore, startMs: number, endMs: number): RangeSlice
{
    const lo = Math.max(store.storeStartMs, startMs);
    const hi = Math.min(store.storeEndMs,   endMs);
    if (hi <= lo)
    {
        return { times: [], production: [], forecast: [], cloud: [], irradiance: [] };
    }
    const stepMs = HOUR_MS / DISPLAY_BUCKETS_PER_HOUR;
    //Snap lo to the centre of the nearest DISPLAY bucket and walk by stepMs until hi. Each emitted
    //sample carries the time at the bucket centre, matching the convention every consumer uses.
    const firstBucketIdx = Math.floor((lo - store.storeStartMs) / stepMs);
    const firstMid = store.storeStartMs + firstBucketIdx * stepMs + stepMs / 2;
    const times:      Date[]            = [];
    const production: (number | null)[] = [];
    const forecast:   (number | null)[] = [];
    const cloud:      (number | null)[] = [];
    const irradiance: (number | null)[] = [];
    for (let mid = firstMid; mid < hi; mid += stepMs)
    {
        if (mid < lo) { continue; }
        times.push(new Date(mid));
        production.push(valueAt(store.production, store, mid));
        forecast.push(  valueAt(store.forecast,   store, mid));
        cloud.push(     valueAt(store.cloud,      store, mid));
        irradiance.push(valueAt(store.irradiance, store, mid));
    }
    return { times, production, forecast, cloud, irradiance };
}
