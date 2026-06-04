//Per-day chart rendered inside each CoverFlow card's bottom slot. Stacked area per HA Energy solar source
//for the actual production over the day, dashed line on top for the model's prediction. Each card renders
//its own chart for its own day window; all five share the same global Y scale so the relative magnitudes
//between days stay comparable (a low-cloud day reads taller than a heavily-overcast one).
//
//Data plumbing:
//- Today (live): each `_pvHistoryPerEntity` source's RAW sample timestamps + values are read directly. No
//  resampling to an arbitrary grid, so every cloud-edge spike the HA Energy entity reports lands on the
//  curve. Cumulative-energy entities are differentiated between consecutive raw samples. Multi-source
//  installs are stacked by union-merging every source's raw timestamps and interpolating each source at
//  that unified timeline (so the stacked top correctly reflects the per-instant sum).
//- Past day: same recipe but pulled from `_pvCalibStats` (hourly LTS). Hourly cadence means ~24 points,
//  the curve is naturally coarser than today's live path.
//- Future day: no actual production area, only the forecast line.
//- Forecast (any day): `_chartSeries` hourly forecast pulled through `computePvPowerWeighted` + the active
//  calibration ratio / shading map, interpolated onto the same unified timeline so it overlays correctly.

import { html, svg, TemplateResult } from 'lit';
import
{
    pvCalibK,
    pvInverterMaxW,
    computePvPowerWeighted
} from './pv';
import { effectiveForecastRatio, pvSourceColor } from './charts';
import { computeForecastCalibration } from './calibration';
import { currentShadingMap } from './shadingTrainer';
import { getHomeCoords } from './init';
import type { DashboardHost } from './dashboard';


//Soft cap on points per chart so a sub-second-cadence sensor does not generate a million-node SVG path.
//Below the cap every raw sample lands on the curve. Above the cap we max-decimate by stride, so the
//highest spike of every stride window survives the decimation (the alternative, plain stride-pick, would
//drop peaks that fall on dropped indices).
const MAX_POINTS_PER_CARD = 1800;


export interface DayChartData
{
    //Common timeline for the day, in absolute ms. May be irregular (raw entity timestamps) for today's
    //live path, regular hourly for past-day LTS, or a hourly fallback when no actual data is available.
    timesMs:   number[];
    //Per-source actual production in W, aligned to `timesMs`. Empty for future days where no actual exists.
    sources:   Array<{ id: string; color: string; valuesW: number[] }>;
    //Forecast power in W, aligned to `timesMs`. Empty when no calibration / coords / chart series is wired.
    forecastW: number[];
    //Day window the chart frame covers, used by the renderer to compute X positions from absolute
    //timestamps (so an irregular timeline still spreads correctly across the chart width).
    dayStartMs: number;
    dayEndMs:   number;
}


//Pre-compute the chart for every CoverFlow day offset and the global Y maximum across all of them. Called
//once per dashboard re-render in `renderDashboard`, results threaded down to each `renderCoverflowCard`
//call so they all share the same Y scale.
export function buildDashCharts(host: DashboardHost, offsets: number[]): {
    byOffset: Map<number, DayChartData>;
    yMaxW:    number;
}
{
    const byOffset = new Map<number, DayChartData>();
    let yMaxW = 0;
    for (const offset of offsets)
    {
        const win = dayWindowFor(offset);
        const data = computeDayChart(host, offset, win.startMs, win.endMs);
        byOffset.set(offset, data);
        const N = data.timesMs.length;
        for (let i = 0; i < N; i++)
        {
            let stacked = 0;
            for (const src of data.sources)
            {
                stacked += src.valuesW[i] ?? 0;
            }
            if (stacked > yMaxW) yMaxW = stacked;
            const fc = data.forecastW[i] ?? 0;
            if (fc > yMaxW) yMaxW = fc;
        }
    }
    if (yMaxW < 1) yMaxW = 1;
    return { byOffset, yMaxW };
}


function dayWindowFor(dayOffset: number): { startMs: number; endMs: number }
{
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + dayOffset);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { startMs: start.getTime(), endMs: end.getTime() };
}


//Convert a raw (times, values) series into an array of in-day {tMs, w} samples. Cumulative-energy
//entities (Wh / kWh / MWh) are differentiated between consecutive raw samples (delta / dt gives W).
//Instantaneous-power entities (W / kW / MW) are taken as-is and rescaled to W.
interface RawSample { tMs: number; w: number; }
function dayRawSamples(
    times:      Date[],
    values:     number[],
    dayStartMs: number,
    dayEndMs:   number,
    isCum:      boolean,
    energyToWhScale: number,
    wScale:     number,
): RawSample[]
{
    const out: RawSample[] = [];
    if (times.length < 2)
    {
        return out;
    }
    if (isCum)
    {
        for (let i = 1; i < times.length; i++)
        {
            const tMs    = times[i].getTime();
            if (tMs < dayStartMs || tMs >= dayEndMs)
            {
                continue;
            }
            const prevMs = times[i - 1].getTime();
            const dh     = (tMs - prevMs) / 3_600_000;
            //Skip silent / stale gaps (no sample for more than an hour) so a stale long-flat segment does
            //not turn into a tall fake spike on the next sample.
            if (dh <= 0 || dh > 1)
            {
                continue;
            }
            const dE = (values[i] - values[i - 1]) * energyToWhScale;
            out.push({ tMs, w: Math.max(0, dE / dh) });
        }
    }
    else
    {
        for (let i = 0; i < times.length; i++)
        {
            const tMs = times[i].getTime();
            if (tMs < dayStartMs || tMs >= dayEndMs)
            {
                continue;
            }
            const v = values[i];
            if (!isFinite(v))
            {
                continue;
            }
            out.push({ tMs, w: Math.max(0, v * wScale) });
        }
    }
    return out;
}


function interpSamplesAtMs(samples: RawSample[], tMs: number): number
{
    if (samples.length === 0) return 0;
    if (tMs <= samples[0].tMs) return samples[0].w;
    const lastIdx = samples.length - 1;
    if (tMs >= samples[lastIdx].tMs) return samples[lastIdx].w;
    let lo = 0;
    let hi = lastIdx;
    while (hi - lo > 1)
    {
        const m = (lo + hi) >> 1;
        if (samples[m].tMs <= tMs) lo = m;
        else hi = m;
    }
    const t0 = samples[lo].tMs;
    const t1 = samples[hi].tMs;
    if (t1 === t0) return samples[lo].w;
    const f = (tMs - t0) / (t1 - t0);
    return samples[lo].w + (samples[hi].w - samples[lo].w) * f;
}


//Max-decimate a sequence of indices: split into `targetCount` evenly-spaced windows, take the index whose
//STACKED value (sum across all sources at that index) is the highest. Preserves peaks across the day so
//the curve does not lose its cloud-edge spikes during decimation.
function maxDecimateIndices(timesMs: number[], sources: Array<{ valuesW: number[] }>, targetCount: number): number[]
{
    const n = timesMs.length;
    if (n <= targetCount) return Array.from({ length: n }, (_, i) => i);
    const out: number[] = [];
    const stride = n / targetCount;
    for (let w = 0; w < targetCount; w++)
    {
        const lo = Math.floor(w * stride);
        const hi = Math.min(n, Math.floor((w + 1) * stride));
        let peakIdx     = lo;
        let peakStacked = -Infinity;
        for (let i = lo; i < hi; i++)
        {
            let s = 0;
            for (const src of sources)
            {
                s += src.valuesW[i] ?? 0;
            }
            if (s > peakStacked)
            {
                peakStacked = s;
                peakIdx     = i;
            }
        }
        out.push(peakIdx);
    }
    return out;
}


function computeDayChart(
    host:       DashboardHost,
    dayOffset:  number,
    dayStartMs: number,
    dayEndMs:   number,
): DayChartData
{
    const unit  = (host._pvUnit || '').toLowerCase();
    const isCum = unit === 'wh' || unit === 'kwh' || unit === 'mwh';
    const energyToWhScale = unit === 'kwh' ? 1000 : unit === 'mwh' ? 1_000_000 : 1;
    const wScale          = unit === 'kw'  ? 1000 : unit === 'mw'  ? 1_000_000 : 1;

    let timesMs:  number[] = [];
    let sources:  DayChartData['sources'] = [];

    if (dayOffset === 0 && host._pvHistoryPerEntity.size > 0)
    {
        const ids   = Array.from(host._pvHistoryPerEntity.keys()).sort();
        const total = ids.length;
        const rawPerSource: Array<{ id: string; color: string; samples: RawSample[] }> = [];
        for (let idx = 0; idx < total; idx++)
        {
            const id = ids[idx];
            const ph = host._pvHistoryPerEntity.get(id);
            if (!ph) continue;
            const samples = dayRawSamples(ph.times, ph.values, dayStartMs, dayEndMs, isCum, energyToWhScale, wScale);
            if (samples.length < 2) continue;
            rawPerSource.push({ id, color: pvSourceColor(idx, total), samples });
        }
        if (rawPerSource.length === 1)
        {
            //Single source = use its raw timestamps directly. Every sample becomes a point on the path.
            const src = rawPerSource[0];
            timesMs   = src.samples.map(s => s.tMs);
            sources.push({ id: src.id, color: src.color, valuesW: src.samples.map(s => s.w) });
        }
        else if (rawPerSource.length > 1)
        {
            //Multi-source = union of every source's raw timestamps so the stacked top reflects per-instant
            //sums. Each source is then linearly interpolated at the union timeline.
            const set = new Set<number>();
            for (const src of rawPerSource)
            {
                for (const s of src.samples) set.add(s.tMs);
            }
            timesMs = Array.from(set).sort((a, b) => a - b);
            for (const src of rawPerSource)
            {
                sources.push({
                    id:      src.id,
                    color:   src.color,
                    valuesW: timesMs.map(t => interpSamplesAtMs(src.samples, t)),
                });
            }
        }
    }
    else if (dayOffset < 0 && host._pvCalibStats && host._pvCalibStats.times.length >= 2)
    {
        const samples = dayRawSamples(host._pvCalibStats.times, host._pvCalibStats.values, dayStartMs, dayEndMs, isCum, energyToWhScale, wScale);
        if (samples.length >= 2)
        {
            timesMs = samples.map(s => s.tMs);
            sources.push({
                id:      'lts',
                color:   pvSourceColor(0, 1),
                valuesW: samples.map(s => s.w),
            });
        }
    }

    //If no actual-production timeline was built, fall back to a 24-hour hourly grid so the forecast line
    //still has something to render against.
    if (timesMs.length === 0)
    {
        for (let h = 0; h <= 24; h++)
        {
            timesMs.push(dayStartMs + h * 3_600_000);
        }
    }

    //Decimate if we exceeded the per-card cap. Skipped for the typical install (most installs land below
    //the cap, so the raw curve is rendered verbatim).
    if (timesMs.length > MAX_POINTS_PER_CARD)
    {
        const keepIdx = maxDecimateIndices(timesMs, sources, MAX_POINTS_PER_CARD);
        timesMs = keepIdx.map(i => timesMs[i]);
        sources = sources.map(s => ({ ...s, valuesW: keepIdx.map(i => s.valuesW[i] ?? 0) }));
    }

    //Forecast interpolated onto the same timeline.
    const forecastW = computeForecastOnTimes(host, timesMs, dayStartMs, dayEndMs);

    return { timesMs, sources, forecastW, dayStartMs, dayEndMs };
}


function computeForecastOnTimes(host: DashboardHost, targetMs: number[], dayStartMs: number, dayEndMs: number): number[]
{
    const out = new Array(targetMs.length).fill(0);
    const series = host._chartSeries;
    const coords = getHomeCoords(host.config, host.hass);
    const k      = pvCalibK(host.config);
    if (!series || !coords || k === null || k <= 0 || series.times.length < 2)
    {
        return out;
    }
    const raster = host._engine?.getLidarRaster() ?? null;
    const capW   = pvInverterMaxW(host.config);
    const shMap  = currentShadingMap();
    const cal    = computeForecastCalibration(host);
    const calR   = cal?.ratio ?? 1;
    const nowMs  = Date.now();

    const fcSamples: RawSample[] = [];
    for (let i = 0; i < series.times.length; i++)
    {
        const tMs = series.times[i].getTime();
        if (tMs < dayStartMs - 3_600_000 || tMs > dayEndMs + 3_600_000)
        {
            continue;
        }
        const cloud = series.cloud[i] ?? 0;
        const pct = computePvPowerWeighted(host.config, series.times[i], coords.lat, coords.lon, cloud, {
            airTempC: series.temperature[i],
            windMs:   series.windSpeed[i],
            raster,
        });
        if (pct < 0) continue;
        const ratio = effectiveForecastRatio(shMap, series.times[i], coords.lat, coords.lon, cloud, calR, nowMs);
        fcSamples.push({ tMs, w: Math.min(capW, Math.max(0, pct * k * ratio)) });
    }
    if (fcSamples.length < 2)
    {
        return out;
    }
    for (let i = 0; i < targetMs.length; i++)
    {
        out[i] = interpSamplesAtMs(fcSamples, targetMs[i]);
    }
    return out;
}


//Find the two timeline indices that bracket the cursor time, plus the interpolation fraction within them.
//Cursor is given as a 0..1 fraction of the chart's day window. The timeline may be irregular so we walk
//to find the bracket rather than computing `frac * N` (which would land on the wrong sample on dense /
//sparse regions of the day).
export function bracketHover(data: DayChartData, frac: number): { i0: number; i1: number; f: number; tMs: number }
{
    const N = data.timesMs.length;
    const tMs = data.dayStartMs + Math.max(0, Math.min(1, frac)) * (data.dayEndMs - data.dayStartMs);
    if (N === 0) return { i0: 0, i1: 0, f: 0, tMs };
    if (N === 1) return { i0: 0, i1: 0, f: 0, tMs };
    if (tMs <= data.timesMs[0])     return { i0: 0,     i1: 0,     f: 0, tMs };
    if (tMs >= data.timesMs[N - 1]) return { i0: N - 1, i1: N - 1, f: 0, tMs };
    let lo = 0;
    let hi = N - 1;
    while (hi - lo > 1)
    {
        const m = (lo + hi) >> 1;
        if (data.timesMs[m] <= tMs) lo = m;
        else hi = m;
    }
    const t0 = data.timesMs[lo];
    const t1 = data.timesMs[hi];
    const f  = t1 === t0 ? 0 : (tMs - t0) / (t1 - t0);
    return { i0: lo, i1: hi, f, tMs };
}


//Total stacked W at the given index, summed across all sources. Used by the hover header readout AND
//by the per-source dot positions on hover so both share the exact same arithmetic.
export function stackedAtIndex(data: DayChartData, i: number): number
{
    let sum = 0;
    for (const src of data.sources)
    {
        sum += src.valuesW[i] ?? 0;
    }
    return sum;
}


//Peak stacked W across the entire day (max of stacked actual OR forecast at any index). Drives the
//default value shown in the chart header when the user is not hovering the curve.
export function peakOfDay(data: DayChartData): number
{
    let peak = 0;
    const N = data.timesMs.length;
    for (let i = 0; i < N; i++)
    {
        const stacked = stackedAtIndex(data, i);
        const fc      = data.forecastW[i] ?? 0;
        if (stacked > peak) peak = stacked;
        if (fc      > peak) peak = fc;
    }
    return peak;
}


//Catmull-Rom to cubic-Bezier smoothing for an SVG path string. Each consecutive (Pi, Pi+1) pair becomes a
//cubic-Bezier with control points derived from the neighbours (Pi-1, Pi+2), so the rendered curve passes
//through every input point but the joins are tangent-continuous instead of polyline kinks.
function smoothPathD(coords: Array<[number, number]>): string
{
    const n = coords.length;
    if (n === 0) return '';
    if (n === 1) return `M ${coords[0][0].toFixed(2)} ${coords[0][1].toFixed(2)}`;
    if (n === 2)
    {
        return `M ${coords[0][0].toFixed(2)} ${coords[0][1].toFixed(2)} L ${coords[1][0].toFixed(2)} ${coords[1][1].toFixed(2)}`;
    }
    let d = `M ${coords[0][0].toFixed(2)} ${coords[0][1].toFixed(2)}`;
    for (let i = 0; i < n - 1; i++)
    {
        const p0 = coords[Math.max(0,     i - 1)];
        const p1 = coords[i];
        const p2 = coords[i + 1];
        const p3 = coords[Math.min(n - 1, i + 2)];
        const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
        const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
        const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
        const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
        d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)} ${cp2x.toFixed(2)} ${cp2y.toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
    }
    return d;
}


const CHART_BOTTOM_PAD = 6;
const CHART_TOP_PAD    = 4;
export function renderDayChartSVG(data: DayChartData, yMaxW: number): TemplateResult
{
    const W = 100;
    const H = 100;
    const N = data.timesMs.length;
    if (N < 2 || yMaxW <= 0)
    {
        return html``;
    }
    const plotH    = H - CHART_BOTTOM_PAD - CHART_TOP_PAD;
    //X position is computed from the ABSOLUTE timestamp of each point, not its index, so an irregular
    //timeline (denser samples around midday than at night) still maps to a chronologically-correct chart.
    const dayMs    = data.dayEndMs - data.dayStartMs;
    const xPctOf   = (tMs: number) => ((tMs - data.dayStartMs) / dayMs) * W;
    const yPctOf   = (w: number)   => H - CHART_BOTTOM_PAD - Math.max(0, Math.min(1, w / yMaxW)) * plotH;

    const areaPaths: TemplateResult[] = [];
    const bottomValues = new Array(N).fill(0);
    for (let srcIdx = 0; srcIdx < data.sources.length; srcIdx++)
    {
        const src     = data.sources[srcIdx];
        const isFirst = srcIdx === 0;
        const topValues = new Array(N);
        for (let i = 0; i < N; i++)
        {
            topValues[i] = bottomValues[i] + (src.valuesW[i] ?? 0);
        }
        const bottomYOf = (i: number) => isFirst ? H : yPctOf(bottomValues[i]);
        const topCoords: Array<[number, number]> = [];
        for (let i = 0; i < N; i++)
        {
            topCoords.push([xPctOf(data.timesMs[i]), yPctOf(topValues[i])]);
        }
        let dFill = smoothPathD(topCoords);
        for (let i = N - 1; i >= 0; i--)
        {
            dFill += ` L ${xPctOf(data.timesMs[i]).toFixed(2)} ${bottomYOf(i).toFixed(2)}`;
        }
        dFill += ' Z';
        const dStroke = smoothPathD(topCoords);
        areaPaths.push(svg`
            <path d="${dFill}" fill="${src.color}" fill-opacity="0.32" stroke="none"></path>
            <path
                d="${dStroke}"
                fill="none"
                stroke="${src.color}"
                stroke-width="1.8"
                stroke-linejoin="round"
                stroke-linecap="round"
                vector-effect="non-scaling-stroke"
            ></path>
        `);
        for (let i = 0; i < N; i++)
        {
            bottomValues[i] = topValues[i];
        }
    }

    let forecastPath: TemplateResult | null = null;
    if (data.forecastW.length >= 2)
    {
        const fcCoords: Array<[number, number]> = [];
        for (let i = 0; i < N; i++)
        {
            fcCoords.push([xPctOf(data.timesMs[i]), yPctOf(data.forecastW[i])]);
        }
        forecastPath = svg`
            <path
                d="${smoothPathD(fcCoords)}"
                class="dash-cf-card-chart-forecast"
                fill="none"
                vector-effect="non-scaling-stroke"
            ></path>
        `;
    }

    return html`
        <svg
            class="dash-cf-card-chart-svg"
            viewBox="0 0 ${W} ${H}"
            preserveAspectRatio="none"
            aria-hidden="true"
        >
            ${areaPaths}
            ${forecastPath}
        </svg>
    `;
}
