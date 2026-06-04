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
    //Boundary between actuals and the not-yet-happened part of the day. For today this is NOW (the user
    //sees actuals up to this point + a dashed 0 line beyond), for past days it equals dayEndMs (the whole
    //day is actuals), for future days it equals dayStartMs (the whole day is future).
    liveEndMs:  number;
}


function dayMaxStacked(data: DayChartData): number
{
    let yMax = 0;
    const N = data.timesMs.length;
    for (let i = 0; i < N; i++)
    {
        let stacked = 0;
        for (const src of data.sources)
        {
            stacked += src.valuesW[i] ?? 0;
        }
        if (stacked > yMax) yMax = stacked;
        const fc = data.forecastW[i] ?? 0;
        if (fc > yMax) yMax = fc;
    }
    return yMax;
}


//Pre-compute the production chart for every CoverFlow day offset and the GLOBAL Y maximum across all
//five days. Battery + grid charts were dropped (they were redundant with the HA Energy dashboard); the
//dashboard now keeps only the production chart, with the Production + Prévision mini-tiles above it.
export function buildDashCharts(host: DashboardHost, offsets: number[]): {
    productionByOffset: Map<number, DayChartData>;
    productionYMaxW:    number;
}
{
    const productionByOffset = new Map<number, DayChartData>();
    let productionYMaxW = 0;
    for (const offset of offsets)
    {
        const win  = dayWindowFor(offset);
        const prod = computeDayChart(host, offset, win.startMs, win.endMs);
        productionByOffset.set(offset, prod);
        productionYMaxW = Math.max(productionYMaxW, dayMaxStacked(prod));
    }
    if (productionYMaxW < 1) productionYMaxW = 1;
    return { productionByOffset, productionYMaxW };
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

    //Pad LEFT so the curve always starts at the dayStart edge of the chart frame (so the area does not
    //leave a gap between sunrise and the chart's left edge). Pad RIGHT only up to liveEndMs (= NOW for
    //today), leaving the post-NOW window for the dashed future-baseline line; this stops the area from
    //extending flat at "last known value" to the right edge on a live install.
    const liveEnd = liveEndMsFor(dayStartMs, dayEndMs);
    if (timesMs.length === 0 || timesMs[0] > dayStartMs)
    {
        timesMs.unshift(dayStartMs);
        sources = sources.map(s => ({ ...s, valuesW: [s.valuesW[0] ?? 0, ...s.valuesW] }));
    }
    const padEnd = liveEnd - 1;
    if (timesMs.length > 0 && timesMs[timesMs.length - 1] < padEnd)
    {
        timesMs.push(padEnd);
        sources = sources.map(s => ({ ...s, valuesW: [...s.valuesW, s.valuesW[s.valuesW.length - 1] ?? 0] }));
    }

    //Forecast interpolated onto the same timeline.
    const forecastW = computeForecastOnTimes(host, timesMs, dayStartMs, dayEndMs);

    return { timesMs, sources, forecastW, dayStartMs, dayEndMs, liveEndMs: liveEndMsFor(dayStartMs, dayEndMs) };
}


function liveEndMsFor(dayStartMs: number, dayEndMs: number): number
{
    const now = Date.now();
    if (now < dayStartMs) return dayStartMs;
    if (now >= dayEndMs)  return dayEndMs;
    return now;
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

    //Baseline band: full-width colored rect from the W=0 baseline down to the chart's bottom edge, in the
    //FIRST source's color at low opacity. Lets the colored band span the entire day window, including
    //the future part where no actual sample exists yet. Without this the bottom padding band only got
    //filled where the first source had samples, leaving the future part visually empty.
    let baselineBand: TemplateResult | null = null;
    if (data.sources.length > 0)
    {
        const yBase = yPctOf(0);
        baselineBand = svg`
            <rect
                x="0" y="${yBase.toFixed(2)}"
                width="${W}" height="${(H - yBase).toFixed(2)}"
                fill="${data.sources[0].color}"
                fill-opacity="0.32"
            ></rect>
        `;
    }

    const areaPaths: TemplateResult[] = [];
    const bottomValues = new Array(N).fill(0);
    for (let srcIdx = 0; srcIdx < data.sources.length; srcIdx++)
    {
        const src = data.sources[srcIdx];
        const topValues = new Array(N);
        for (let i = 0; i < N; i++)
        {
            topValues[i] = bottomValues[i] + (src.valuesW[i] ?? 0);
        }
        //Every source's fill closes back along its natural bottom (W=0 for the first stacked source, the
        //previous source's top for everything above). The colored band below the W=0 baseline is now drawn
        //separately as a baseline rect that spans the full day width so the future part of the day also
        //gets the colored band.
        const bottomYOf = (i: number) => yPctOf(bottomValues[i]);
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

    //Dashed horizontal line at W=0 over the part of the day that has not happened yet (NOW to dayEnd for
    //today, the entire day window for future days, nothing for past days). Only drawn on charts that
    //carry a FORECAST curve (= production), since on battery / grid charts the dashed baseline reads as
    //a phantom 'forecast' which is misleading (those charts only show actuals).
    let futurePath: TemplateResult | null = null;
    const hasForecast = data.forecastW.some(v => v > 0);
    if (hasForecast && data.liveEndMs < data.dayEndMs)
    {
        const x1 = xPctOf(data.liveEndMs);
        const x2 = xPctOf(data.dayEndMs - 1);
        const yB = yPctOf(0);
        futurePath = svg`
            <line
                x1="${x1.toFixed(2)}" y1="${yB.toFixed(2)}"
                x2="${x2.toFixed(2)}" y2="${yB.toFixed(2)}"
                stroke="color-mix(in srgb, var(--primary-text-color, #ffffff) 38%, transparent)"
                stroke-width="1.2"
                stroke-dasharray="2 2"
                vector-effect="non-scaling-stroke"
            ></line>
        `;
    }

    return html`
        <svg
            class="dash-cf-card-chart-svg"
            viewBox="0 0 ${W} ${H}"
            preserveAspectRatio="none"
            aria-hidden="true"
        >
            ${baselineBand}
            ${areaPaths}
            ${futurePath}
            ${forecastPath}
        </svg>
    `;
}


//Hover dots rendered as ABSOLUTE-POSITIONED HTML elements outside the SVG so they stay perfectly circular
//regardless of the SVG's non-uniform stretch. Returns the position in plot-frame percentages, one entry
//per stacked source top + one entry for the forecast curve (when present + non-zero day).
export interface HoverDot { leftPct: number; topPct: number; color: string; isForecast: boolean; }
export function computeHoverDots(data: DayChartData, yMaxW: number, hoverFrac: number, hasForecast: boolean): HoverDot[]
{
    const N = data.timesMs.length;
    if (N < 2 || yMaxW <= 0) return [];
    const plotH = 100 - CHART_BOTTOM_PAD - CHART_TOP_PAD;
    const yPctOf = (w: number) => 100 - CHART_BOTTOM_PAD - Math.max(0, Math.min(1, w / yMaxW)) * plotH;
    const dayMs  = data.dayEndMs - data.dayStartMs;
    const bracket = bracketHover(data, hoverFrac);
    const cxPct = ((bracket.tMs - data.dayStartMs) / dayMs) * 100;
    const dots: HoverDot[] = [];
    let stacked = 0;
    for (const src of data.sources)
    {
        const v = (src.valuesW[bracket.i0] ?? 0) * (1 - bracket.f) + (src.valuesW[bracket.i1] ?? 0) * bracket.f;
        stacked += v;
        dots.push({ leftPct: cxPct, topPct: yPctOf(stacked), color: src.color, isForecast: false });
    }
    if (hasForecast && data.forecastW.length >= 2)
    {
        const fcV = (data.forecastW[bracket.i0] ?? 0) * (1 - bracket.f) + (data.forecastW[bracket.i1] ?? 0) * bracket.f;
        dots.push({
            leftPct:    cxPct,
            topPct:     yPctOf(fcV),
            color:      'color-mix(in srgb, var(--energy-solar-color, #ff9800) 75%, var(--primary-text-color, #000) 25%)',
            isForecast: true,
        });
    }
    return dots;
}
