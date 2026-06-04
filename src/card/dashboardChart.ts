//Per-day chart rendered inside each CoverFlow card's bottom slot. Stacked area per HA Energy solar source
//for the actual production over the day, dashed line on top for the model's prediction. Each card renders
//its own chart for its own day window; all five share the same global Y scale so the relative magnitudes
//between days stay comparable (a low-cloud day reads taller than a heavily-overcast one).
//
//Data plumbing:
//- Today + multi-source: per-source values from `_pvHistoryPerEntity`. Each source rendered as its own
//  stacked area in the source-color hue rotation `pvSourceColor` already uses on the timeline chart.
//- Today + single-source: still one area, pulled from `_pvHistoryPerEntity` (the single entry).
//- Past day: one unified area from `_pvCalibStats` (hourly LTS, the 5-day window includes the past 2 days
//  the dashboard shows). No per-source breakdown is available for past days yet, the LTS rows pre-aggregate.
//- Future day: no production area, only the forecast line.
//- Forecast (any day): `_chartSeries` hourly forecast pulled through `computePvPowerWeighted` + the active
//  calibration ratio / shading map, integrated to the chart's 15-min grid via linear interp.

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


//2-min grid over 24 h (720 steps + 1 end-of-day endpoint). Combined with peak-in-window resampling so each
//bucket keeps the sharpest spike of its 2-min window, plus a Catmull-Rom cubic-Bezier smoothing pass on the
//rendered SVG path. The combination gives detail AND a soft curve like the HA frontend's native chart card
//uses (Apex Charts under the hood applies a similar cubic smoothing). 721 x 4 sources x 5 cards = ~14 k
//path nodes worst case.
const CHART_GRID_STEPS = 720;


export interface DayChartData
{
    //Per-source actual production aligned to the common 15-min grid, in W. One entry for the multi-source
    //today path, one entry for the past-day unified path, empty for future days.
    sources:   Array<{ id: string; color: string; valuesW: number[] }>;
    //Forecast power at each grid point, in W. Empty array when no forecast is available (no calibration
    //configured, no coordinates resolved, or `_chartSeries` not yet loaded).
    forecastW: number[];
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
        for (let i = 0; i < CHART_GRID_STEPS + 1; i++)
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
    //Floor to a small positive so an empty-data render still produces a valid coordinate transform (no
    //division by zero when the user opens the panel before any sample lands).
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


function computeDayChart(
    host:       DashboardHost,
    dayOffset:  number,
    dayStartMs: number,
    dayEndMs:   number,
): DayChartData
{
    const timesMs: number[] = [];
    const stepMs = (dayEndMs - dayStartMs) / CHART_GRID_STEPS;
    for (let i = 0; i <= CHART_GRID_STEPS; i++)
    {
        timesMs.push(dayStartMs + i * stepMs);
    }

    const unit  = (host._pvUnit || '').toLowerCase();
    const isCum = unit === 'wh' || unit === 'kwh' || unit === 'mwh';

    const sources: DayChartData['sources'] = [];

    if (dayOffset === 0 && host._pvHistoryPerEntity.size > 0)
    {
        const ids   = Array.from(host._pvHistoryPerEntity.keys()).sort();
        const total = ids.length;
        for (let idx = 0; idx < total; idx++)
        {
            const id = ids[idx];
            const ph = host._pvHistoryPerEntity.get(id);
            if (!ph || ph.times.length < 2)
            {
                continue;
            }
            const valuesW = resampleToWattsGrid(ph.times, ph.values, timesMs, unit, isCum);
            sources.push({
                id,
                color: pvSourceColor(idx, total),
                valuesW,
            });
        }
    }
    else if (dayOffset < 0 && host._pvCalibStats && host._pvCalibStats.times.length >= 2)
    {
        const calib   = host._pvCalibStats;
        const valuesW = resampleToWattsGrid(calib.times, calib.values, timesMs, unit, isCum);
        sources.push({
            id:    'lts',
            color: pvSourceColor(0, 1),
            valuesW,
        });
    }

    const forecastW = computeForecastOnGrid(host, timesMs);

    return { sources, forecastW };
}


//Resample a (times, values) series onto the chart grid as instantaneous Watts. Cumulative energy entities
//(Wh / kWh / MWh) are differentiated between consecutive grid samples (interp the cumulative reading at
//each grid time, take the delta over the 15-min step, divide to get power). Instantaneous power entities
//(W / kW / MW) are interpolated directly and rescaled to W.
function resampleToWattsGrid(
    times:    Date[],
    values:   number[],
    gridMs:   number[],
    unit:     string,
    isCum:    boolean,
): number[]
{
    const out = new Array(gridMs.length).fill(0);
    if (times.length < 2)
    {
        return out;
    }
    if (isCum)
    {
        const energyToWhScale = unit === 'kwh' ? 1000 : unit === 'mwh' ? 1_000_000 : 1;
        let prevCum = NaN;
        for (let i = 0; i < gridMs.length; i++)
        {
            const cum = interpDateMs(times, values, gridMs[i]);
            if (i === 0)
            {
                prevCum = cum;
                out[i]  = 0;
                continue;
            }
            const dh = (gridMs[i] - gridMs[i - 1]) / 3_600_000;
            const dE = (cum - prevCum) * energyToWhScale;
            out[i]   = dh > 0 ? Math.max(0, dE / dh) : 0;
            prevCum  = cum;
        }
    }
    else
    {
        //Instantaneous-power entities: peak-in-window resampling, NOT linear interp. For each grid bucket
        //we take the MAX of every source sample falling inside [gridT-step/2, gridT+step/2]. Linear interp
        //between sparse grid points averages a 30-second cloud-edge spike into nothing; peak-in-window
        //keeps the spike visible as a 1 grid-bucket tall blip. Falls back to interp when a bucket contains
        //no source sample at all (sparse entities, day boundaries).
        const wScale   = unit === 'kw' ? 1000 : unit === 'mw' ? 1_000_000 : 1;
        const stepMs   = gridMs.length > 1 ? (gridMs[1] - gridMs[0]) : 60_000;
        const halfStep = stepMs / 2;
        let srcIdx = 0;
        const srcMs: number[] = times.map(d => d.getTime());
        for (let i = 0; i < gridMs.length; i++)
        {
            const tCenter = gridMs[i];
            const tLo = tCenter - halfStep;
            const tHi = tCenter + halfStep;
            while (srcIdx < srcMs.length && srcMs[srcIdx] < tLo)
            {
                srcIdx++;
            }
            let peak = -Infinity;
            let j = srcIdx;
            while (j < srcMs.length && srcMs[j] <= tHi)
            {
                const v = values[j];
                if (isFinite(v) && v > peak)
                {
                    peak = v;
                }
                j++;
            }
            const value = peak > -Infinity
                ? peak
                : interpDateMs(times, values, tCenter);
            out[i] = Math.max(0, value * wScale);
        }
    }
    return out;
}


function computeForecastOnGrid(host: DashboardHost, gridMs: number[]): number[]
{
    const out = new Array(gridMs.length).fill(0);
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

    const fcTimes: number[] = [];
    const fcW:     number[] = [];
    for (let i = 0; i < series.times.length; i++)
    {
        const tMs = series.times[i].getTime();
        //Keep a 1 h margin either side so the linear interp at the day boundaries finds bracketing samples
        //instead of clamping to a 0 at the edge of the grid.
        if (tMs < gridMs[0] - 3_600_000 || tMs > gridMs[gridMs.length - 1] + 3_600_000)
        {
            continue;
        }
        const cloud = series.cloud[i] ?? 0;
        const pct = computePvPowerWeighted(host.config, series.times[i], coords.lat, coords.lon, cloud, {
            airTempC: series.temperature[i],
            windMs:   series.windSpeed[i],
            raster,
        });
        if (pct < 0)
        {
            continue;
        }
        const ratio = effectiveForecastRatio(shMap, series.times[i], coords.lat, coords.lon, cloud, calR, nowMs);
        const watts = Math.min(capW, Math.max(0, pct * k * ratio));
        fcTimes.push(tMs);
        fcW.push(watts);
    }
    if (fcTimes.length < 2)
    {
        return out;
    }
    for (let i = 0; i < gridMs.length; i++)
    {
        out[i] = interpAtMs(fcTimes, fcW, gridMs[i]);
    }
    return out;
}


function interpDateMs(times: Date[], values: number[], tMs: number): number
{
    if (times.length === 0) return 0;
    if (tMs <= times[0].getTime()) return values[0];
    const lastIdx = times.length - 1;
    if (tMs >= times[lastIdx].getTime()) return values[lastIdx];
    let lo = 0;
    let hi = lastIdx;
    while (hi - lo > 1)
    {
        const m = (lo + hi) >> 1;
        if (times[m].getTime() <= tMs) lo = m;
        else hi = m;
    }
    const t0 = times[lo].getTime();
    const t1 = times[hi].getTime();
    if (t1 === t0) return values[lo];
    const f = (tMs - t0) / (t1 - t0);
    return values[lo] + (values[hi] - values[lo]) * f;
}


function interpAtMs(timesMs: number[], values: number[], tMs: number): number
{
    if (timesMs.length === 0) return 0;
    if (tMs <= timesMs[0]) return values[0];
    const lastIdx = timesMs.length - 1;
    if (tMs >= timesMs[lastIdx]) return values[lastIdx];
    let lo = 0;
    let hi = lastIdx;
    while (hi - lo > 1)
    {
        const m = (lo + hi) >> 1;
        if (timesMs[m] <= tMs) lo = m;
        else hi = m;
    }
    const t0 = timesMs[lo];
    const t1 = timesMs[hi];
    if (t1 === t0) return values[lo];
    const f = (tMs - t0) / (t1 - t0);
    return values[lo] + (values[hi] - values[lo]) * f;
}


//Total stacked W at the given grid index, summed across all sources. Used by the hover header readout AND
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


//Peak stacked W across the entire day (max of stacked actual OR forecast at any grid step). Drives the
//default value shown in the chart header when the user is not hovering the curve.
export function peakOfDay(data: DayChartData): number
{
    let peak = 0;
    const N = data.forecastW.length || (data.sources[0]?.valuesW.length ?? 0);
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
//through every input point but the joins are tangent-continuous instead of polyline kinks. Tension = 1 is
//the canonical uniform Catmull-Rom; lowering it tightens the curve toward straight lines but at 1.0 the
//visual matches the HA frontend chart card the user pointed to as a reference.
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


//Render the SVG for a single CoverFlow card. viewBox is normalised 0 to 100 on both axes so the inner
//area + line paths express points as percentages and the CSS sizes the SVG to fill its parent (the
//.dash-cf-card-chart-plot frame). preserveAspectRatio="none" lets the chart stretch to whatever shape the
//frame ends up at after the container queries swap the card aspect ratio.
//
//A bottom padding of ~6 % keeps the W=0 baseline off the chart frame's lower edge so the orange baseline
//is visibly inset (the HA frontend's native power-curve cards do the same). A top padding of ~4 % stops the
//peak from kissing the upper edge for the same reason.
const CHART_BOTTOM_PAD = 6;
const CHART_TOP_PAD    = 4;
export function renderDayChartSVG(data: DayChartData, yMaxW: number): TemplateResult
{
    const W = 100;
    const H = 100;
    const N = data.forecastW.length || (data.sources[0]?.valuesW.length ?? 0);
    if (N < 2 || yMaxW <= 0)
    {
        return html``;
    }
    const plotH  = H - CHART_BOTTOM_PAD - CHART_TOP_PAD;
    const xPctOf = (i: number) => (i / (N - 1)) * W;
    const yPctOf = (w: number) => H - CHART_BOTTOM_PAD - Math.max(0, Math.min(1, w / yMaxW)) * plotH;

    //Build stacked areas from bottom to top so each layer paints over the previous one with the right
    //vertical offset. The fill is the per-source color at ~38 % opacity (legible without drowning the
    //forecast line) plus a thicker stroke on the area's TOP edge (the production curve drawn over the
    //fill) so the curve has a defined upper border per the HA reference card. The FIRST source's fill
    //also fills the bottom padding band (the strip below the W=0 baseline that the chart frame insets
    //for visual breathing room) with the same colour, so the orange baseline reads as the "ground" the
    //production rises from instead of a hard cut-off edge.
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
            topCoords.push([xPctOf(i), yPctOf(topValues[i])]);
        }
        //Fill path: cubic-Bezier smoothed top edge + straight L closure along the bottom edge of this
        //stacked layer (bottom is by definition flat / monotone, no smoothing buys anything there).
        let dFill = smoothPathD(topCoords);
        for (let i = N - 1; i >= 0; i--)
        {
            dFill += ` L ${xPctOf(i).toFixed(2)} ${bottomYOf(i).toFixed(2)}`;
        }
        dFill += ' Z';
        //Stroke path: only the TOP edge, same smoothing recipe, drawn as a separate open path so the
        //bottom + side edges of the fill polygon stay invisible.
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
            fcCoords.push([xPctOf(i), yPctOf(data.forecastW[i])]);
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
