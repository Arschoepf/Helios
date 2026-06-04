//Cumulative-production chart for the CoverFlow card, ported in spirit from the v1.8.2 dashboard.
//
//- Solid filled curve = cumulative ACTUAL production (kWh integrated from midnight up to NOW for today,
//  to midnight for past days, zero for future days).
//- Dashed curve = cumulative FORECAST production (the model's prediction integrated hour-by-hour from
//  midnight to midnight, regardless of NOW, so the past portion shows what was forecast at the time).
//- Two opacity overlays mark the night periods (before sunrise, after sunset). The hatched look from
//  1.8.2 is replaced by a softer flat opacity per the new dashboard palette.
//- Two readouts above the chart: total kWh produced (left, solar palette) and total kWh forecast (right,
//  same hue darker / lighter depending on theme). Both swap to the value AT the cursor X when the user
//  hovers the front card.
//- The bottom band (below Y=0) is filled in the actual-curve colour so the baseline reads as the "ground"
//  the curves rise from.

import { html, svg, nothing, TemplateResult } from 'lit';
import { lerpHexToward } from './format';
import { pickTranslations } from '../i18n';
import {
    pvCalibK,
    pvInverterMaxW,
    computePvPowerWeighted,
    pvNormalizeToWatts,
} from './pv';
import { getHomeCoords } from './init';
import { getSunPosition } from '../engine/sun';
import type { DashboardHost } from './dashboard';


function dayWindowFor(dayOffset: number): { startMs: number; endMs: number }
{
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + dayOffset);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { startMs: start.getTime(), endMs: end.getTime() };
}


function liveEndMsFor(dayStartMs: number, dayEndMs: number): number
{
    const now = Date.now();
    if (now < dayStartMs) return dayStartMs;
    if (now >= dayEndMs)  return dayEndMs;
    return now;
}


export interface CumChartData
{
    actualSamples:    Array<{ tMs: number; kwh: number }>;
    predictedSamples: Array<{ tMs: number; kwh: number }>;
    totalActualKwh:    number;
    totalPredictedKwh: number;
    maxKwh:           number;
    sunriseMs:        number | null;
    sunsetMs:         number | null;
    dayStartMs:       number;
    dayEndMs:         number;
    liveEndMs:        number;
}


//5-min cadence (288 + 1 endpoint). The cumulative curve is monotonic non-decreasing so 5-min granularity
//is plenty smooth without bloating the SVG path.
const CUM_STEPS = 288;


export function computeDayCumulative(host: DashboardHost, dayOffset: number): CumChartData
{
    const win        = dayWindowFor(dayOffset);
    const liveEndMs  = liveEndMsFor(win.startMs, win.endMs);
    const stepMs     = (win.endMs - win.startMs) / CUM_STEPS;
    const hourFactor = stepMs / 3_600_000;  //convert W * step to Wh

    const coords = getHomeCoords(host.config, host.hass);
    const k      = pvCalibK(host.config);
    const series = host._chartSeries;
    const capW   = pvInverterMaxW(host.config);
    const raster = host._engine?.getLidarRaster() ?? null;

    //Build a hourly forecast power array first: for each forecast bucket inside the day window, compute
    //the predicted W via computePvPowerWeighted * k. Used both for the predicted cumulative AND for the
    //actual cumulative on FUTURE days (where there's no observed history).
    const fcTimesMs: number[] = [];
    const fcW:       number[] = [];
    if (series && coords && k !== null && k > 0)
    {
        for (let i = 0; i < series.times.length; i++)
        {
            const tMs = series.times[i].getTime();
            if (tMs < win.startMs - 3_600_000 || tMs > win.endMs + 3_600_000) continue;
            const cloud = series.cloud[i] ?? 0;
            const pct = computePvPowerWeighted(host.config, series.times[i], coords.lat, coords.lon, cloud, {
                airTempC: series.temperature[i],
                windMs:   series.windSpeed[i],
                raster,
            });
            if (pct < 0) continue;
            fcTimesMs.push(tMs);
            fcW.push(Math.min(capW, Math.max(0, pct * k)));
        }
    }

    const actualSamples:    Array<{ tMs: number; kwh: number }> = [];
    const predictedSamples: Array<{ tMs: number; kwh: number }> = [];
    let cumActualWh    = 0;
    let cumPredictedWh = 0;
    let prevActualW    = sampleSolarAt(host, win.startMs);
    let prevPredW      = interpLinear(fcTimesMs, fcW, win.startMs);

    actualSamples.push({ tMs: win.startMs, kwh: 0 });
    predictedSamples.push({ tMs: win.startMs, kwh: 0 });

    for (let i = 1; i <= CUM_STEPS; i++)
    {
        const t = win.startMs + i * stepMs;

        //ACTUAL: integrate the solar power up to NOW, freeze beyond NOW (the user knows there's no
        //actual yet, the curve stops growing instead of extrapolating).
        const wActualNow = t <= liveEndMs ? sampleSolarAt(host, t) : 0;
        if (t <= liveEndMs)
        {
            cumActualWh += ((prevActualW + wActualNow) / 2) * hourFactor;
            actualSamples.push({ tMs: t, kwh: cumActualWh / 1000 });
            prevActualW = wActualNow;
        }
        else
        {
            //Freeze the actual line at its NOW value so the cursor + dots can still ride it visually.
            actualSamples.push({ tMs: t, kwh: cumActualWh / 1000 });
        }

        //PREDICTED: integrate the forecast power over the full day, regardless of NOW.
        const wPredNow = interpLinear(fcTimesMs, fcW, t);
        cumPredictedWh += ((prevPredW + wPredNow) / 2) * hourFactor;
        predictedSamples.push({ tMs: t, kwh: cumPredictedWh / 1000 });
        prevPredW = wPredNow;
    }

    const maxKwh = Math.max(
        actualSamples[actualSamples.length - 1].kwh,
        predictedSamples[predictedSamples.length - 1].kwh,
        0.1,
    );

    //Sunrise / sunset: walk the day at 5-min steps and record the first/last time the sun is above the
    //horizon. coords may be null (no home configured), in which case we skip the markers.
    let sunriseMs: number | null = null;
    let sunsetMs:  number | null = null;
    if (coords)
    {
        for (let i = 0; i <= CUM_STEPS; i++)
        {
            const t   = win.startMs + i * stepMs;
            const alt = getSunPosition(new Date(t), coords.lat, coords.lon).altitude;
            if (alt > 0)
            {
                if (sunriseMs === null) sunriseMs = t;
                sunsetMs = t;
            }
        }
    }

    return {
        actualSamples,
        predictedSamples,
        totalActualKwh:    actualSamples[actualSamples.length - 1].kwh,
        totalPredictedKwh: predictedSamples[predictedSamples.length - 1].kwh,
        maxKwh,
        sunriseMs, sunsetMs,
        dayStartMs: win.startMs,
        dayEndMs:   win.endMs,
        liveEndMs,
    };
}


//Sample the solar power at time t. Prefers _pvHistoryPerEntity (today live) for the window it covers, then
//falls back to _pvCalibStats (hourly LTS, multi-day). Returns W. Handles both instantaneous-power and
//cumulative-energy entities via the same diff-or-scale recipe the chart code used.
function sampleSolarAt(host: DashboardHost, tMs: number): number
{
    //Try multi-entity live history first: sum each source's interpolated value.
    if (host._pvHistoryPerEntity.size > 0)
    {
        let total = 0;
        let any   = false;
        const unit = (host._pvUnit || '').toLowerCase();
        const isCum = unit === 'wh' || unit === 'kwh' || unit === 'mwh';
        const scale = unit === 'kwh' ? 1000 : unit === 'mwh' ? 1_000_000 : 1;
        for (const [, ph] of host._pvHistoryPerEntity)
        {
            if (!ph || ph.times.length < 2) continue;
            const t0 = ph.times[0].getTime();
            const tN = ph.times[ph.times.length - 1].getTime();
            if (tMs < t0 || tMs > tN) continue;
            let lo = 0;
            let hi = ph.times.length - 1;
            while (hi - lo > 1)
            {
                const m = (lo + hi) >> 1;
                if (ph.times[m].getTime() <= tMs) lo = m;
                else                              hi = m;
            }
            if (isCum)
            {
                const dh = (ph.times[hi].getTime() - ph.times[lo].getTime()) / 3_600_000;
                if (dh <= 0) continue;
                total += Math.max(0, (ph.values[hi] - ph.values[lo]) * scale / dh);
            }
            else
            {
                const t0i = ph.times[lo].getTime();
                const t1i = ph.times[hi].getTime();
                if (t1i === t0i) continue;
                const f = (tMs - t0i) / (t1i - t0i);
                const v = ph.values[lo] + (ph.values[hi] - ph.values[lo]) * f;
                total += Math.max(0, pvNormalizeToWatts(v, unit));
            }
            any = true;
        }
        if (any) return total;
    }
    //Fall back to the hourly LTS series (covers past days too).
    const calib = host._pvCalibStats;
    if (calib && calib.times.length >= 2)
    {
        const t0 = calib.times[0].getTime();
        const tN = calib.times[calib.times.length - 1].getTime();
        if (tMs >= t0 && tMs <= tN)
        {
            let lo = 0;
            let hi = calib.times.length - 1;
            while (hi - lo > 1)
            {
                const m = (lo + hi) >> 1;
                if (calib.times[m].getTime() <= tMs) lo = m;
                else                                 hi = m;
            }
            const unit = (host._pvUnit || '').toLowerCase();
            const isCum = unit === 'wh' || unit === 'kwh' || unit === 'mwh';
            const scale = unit === 'kwh' ? 1000 : unit === 'mwh' ? 1_000_000 : 1;
            if (isCum)
            {
                const dh = (calib.times[hi].getTime() - calib.times[lo].getTime()) / 3_600_000;
                if (dh > 0)
                {
                    return Math.max(0, (calib.values[hi] - calib.values[lo]) * scale / dh);
                }
            }
            else
            {
                const t0i = calib.times[lo].getTime();
                const t1i = calib.times[hi].getTime();
                if (t1i !== t0i)
                {
                    const f = (tMs - t0i) / (t1i - t0i);
                    const v = calib.values[lo] + (calib.values[hi] - calib.values[lo]) * f;
                    return Math.max(0, pvNormalizeToWatts(v, unit));
                }
            }
        }
    }
    return 0;
}


function interpLinear(timesMs: number[], values: number[], tMs: number): number
{
    if (timesMs.length === 0) return 0;
    if (tMs <= timesMs[0])                       return values[0];
    if (tMs >= timesMs[timesMs.length - 1])      return values[values.length - 1];
    let lo = 0;
    let hi = timesMs.length - 1;
    while (hi - lo > 1)
    {
        const m = (lo + hi) >> 1;
        if (timesMs[m] <= tMs) lo = m;
        else                   hi = m;
    }
    const t0 = timesMs[lo];
    const t1 = timesMs[hi];
    if (t1 === t0) return values[lo];
    const f = (tMs - t0) / (t1 - t0);
    return values[lo] + (values[hi] - values[lo]) * f;
}


function interpolateKwhAt(pts: Array<{ tMs: number; kwh: number }>, t: number): number | null
{
    if (pts.length === 0)                          return null;
    if (t < pts[0].tMs)                            return null;
    if (t > pts[pts.length - 1].tMs)               return null;
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1)
    {
        const m = (lo + hi) >> 1;
        if (pts[m].tMs <= t) lo = m;
        else                 hi = m;
    }
    const t0 = pts[lo].tMs;
    const t1 = pts[hi].tMs;
    if (t1 === t0) return pts[lo].kwh;
    const f = (t - t0) / (t1 - t0);
    return pts[lo].kwh + (pts[hi].kwh - pts[lo].kwh) * f;
}


//Header layout: title above value, left block = production (actual), right block = forecast. Both
//inherit their colour from the curve they describe.
export function renderCumChart(
    host:         DashboardHost,
    cardOffset:   number,
    activeOffset: number,
    data:         CumChartData,
): TemplateResult
{
    const isFront = cardOffset === activeOffset;
    const t       = pickTranslations(host.hass?.language);

    //Theme-aware predicted-curve colour, lighter than the solar base on dark themes, darker on light.
    const baseSolar = 'var(--energy-solar-color, #ff9800)';
    const isDarkTheme = !!(host.hass as { themes?: { darkMode?: boolean } } | undefined)?.themes?.darkMode;
    const predictedSolid = isDarkTheme
        ? lerpHexToward('#ff9800', '#ffffff', 0.55)
        : lerpHexToward('#ff9800', '#000000', 0.35);

    //Hover values: read the cumulative kWh at the cursor X if the user is hovering THIS card (front).
    let actualKwhAtCursor:    number | null = null;
    let predictedKwhAtCursor: number | null = null;
    if (isFront && host._dashChartHoverTs !== null)
    {
        actualKwhAtCursor    = interpolateKwhAt(data.actualSamples,    host._dashChartHoverTs);
        predictedKwhAtCursor = interpolateKwhAt(data.predictedSamples, host._dashChartHoverTs);
    }
    const actualDisplay    = actualKwhAtCursor    ?? data.totalActualKwh;
    const predictedDisplay = predictedKwhAtCursor ?? data.totalPredictedKwh;

    return html`
        <div class="dash-cf-cum-chart">
            <header class="dash-cf-cum-chart-header">
                <div class="dash-cf-cum-chart-meta dash-cf-cum-chart-meta-actual" style="color: ${baseSolar};">
                    <span class="dash-cf-cum-chart-title">${t.detail.todayProduced ?? 'Production'}</span>
                    <span class="dash-cf-cum-chart-value">${actualDisplay.toFixed(1)} <span class="dash-cf-cum-chart-unit">kWh</span></span>
                </div>
                <div class="dash-cf-cum-chart-meta dash-cf-cum-chart-meta-predicted" style="color: ${predictedSolid};">
                    <span class="dash-cf-cum-chart-title">${t.detail.todayForecast ?? 'Forecast'}</span>
                    <span class="dash-cf-cum-chart-value">${predictedDisplay.toFixed(1)} <span class="dash-cf-cum-chart-unit">kWh</span></span>
                </div>
            </header>
            <div
                class="dash-cf-cum-chart-plot"
                @pointermove="${isFront ? (e: PointerEvent) => handleCumChartHover(host, e, data) : null}"
                @pointerleave="${isFront ? () => handleCumChartLeave(host) : null}"
            >
                ${renderCumChartSVG(host, data, isFront, predictedSolid)}
            </div>
        </div>
    `;
}


function renderCumChartSVG(
    host:           DashboardHost,
    data:           CumChartData,
    isFront:        boolean,
    predictedColor: string,
): TemplateResult
{
    const W = 500;
    const H = 200;
    const PAD_T = 4;
    //Bottom padding leaves room for a coloured "ground" band below the Y=0 line, in the production
    //palette, matching the recipe the previous chart used.
    const PAD_B = 12;

    const yMax = data.maxKwh * 1.05;
    const xOf = (tMs: number) => ((tMs - data.dayStartMs) / (data.dayEndMs - data.dayStartMs)) * W;
    const yOf = (kwh: number) => H - PAD_B - (kwh / yMax) * (H - PAD_T - PAD_B);

    const buildPath = (pts: Array<{ tMs: number; kwh: number }>): string =>
    {
        if (pts.length < 2) return '';
        let d = `M ${xOf(pts[0].tMs).toFixed(2)} ${yOf(pts[0].kwh).toFixed(2)}`;
        for (let i = 1; i < pts.length; i++)
        {
            d += ` L ${xOf(pts[i].tMs).toFixed(2)} ${yOf(pts[i].kwh).toFixed(2)}`;
        }
        return d;
    };
    //Closed area under the actual curve: line down to Y=0 baseline on the right, across to Y=0 on the
    //left, close. Used for the soft fill below the actual curve.
    const buildArea = (pts: Array<{ tMs: number; kwh: number }>): string =>
    {
        if (pts.length < 2) return '';
        const baseline = yOf(0);
        let d = `M ${xOf(pts[0].tMs).toFixed(2)} ${baseline.toFixed(2)}`;
        for (const p of pts) d += ` L ${xOf(p.tMs).toFixed(2)} ${yOf(p.kwh).toFixed(2)}`;
        d += ` L ${xOf(pts[pts.length - 1].tMs).toFixed(2)} ${baseline.toFixed(2)} Z`;
        return d;
    };

    const actualPath    = buildPath(data.actualSamples);
    const actualArea    = buildArea(data.actualSamples);
    const predictedPath = buildPath(data.predictedSamples);

    //Night overlay: opacity rectangles before sunrise + after sunset (clamped to the SVG bounds).
    const nightLeftEnd    = data.sunriseMs !== null ? xOf(data.sunriseMs) : null;
    const nightRightStart = data.sunsetMs  !== null ? xOf(data.sunsetMs)  : null;

    //Hover dots + cursor: shown only on the front card when the user is hovering.
    const hoverTs = isFront ? host._dashChartHoverTs : null;
    let cursorX:        number | null = null;
    let actualDotY:     number | null = null;
    let predictedDotY:  number | null = null;
    if (hoverTs !== null && hoverTs >= data.dayStartMs && hoverTs < data.dayEndMs)
    {
        cursorX = xOf(hoverTs);
        const a = interpolateKwhAt(data.actualSamples,    hoverTs);
        const p = interpolateKwhAt(data.predictedSamples, hoverTs);
        if (a !== null) actualDotY    = yOf(a);
        if (p !== null) predictedDotY = yOf(p);
    }

    const baselineY = yOf(0);

    return html`
        <svg
            class="dash-cf-cum-chart-svg"
            viewBox="0 0 ${W} ${H}"
            preserveAspectRatio="none"
            aria-hidden="true"
        >
            ${nightLeftEnd !== null && nightLeftEnd > 0 ? svg`
                <rect class="dash-cf-cum-chart-night" x="0" y="0" width="${nightLeftEnd.toFixed(2)}" height="${H}"></rect>
            ` : nothing}
            ${nightRightStart !== null && nightRightStart < W ? svg`
                <rect class="dash-cf-cum-chart-night" x="${nightRightStart.toFixed(2)}" y="0" width="${(W - nightRightStart).toFixed(2)}" height="${H}"></rect>
            ` : nothing}

            <rect class="dash-cf-cum-chart-baseline-band" x="0" y="${baselineY.toFixed(2)}" width="${W}" height="${(H - baselineY).toFixed(2)}"></rect>

            ${actualArea ? svg`
                <path class="dash-cf-cum-chart-actual-area" d="${actualArea}"></path>
            ` : nothing}
            ${predictedPath ? svg`
                <path class="dash-cf-cum-chart-predicted" d="${predictedPath}" style="stroke: ${predictedColor};"></path>
            ` : nothing}
            ${actualPath ? svg`
                <path class="dash-cf-cum-chart-actual-line" d="${actualPath}"></path>
            ` : nothing}

            ${cursorX !== null ? svg`
                <line class="dash-cf-cum-chart-cursor" x1="${cursorX.toFixed(2)}" y1="0" x2="${cursorX.toFixed(2)}" y2="${H}"></line>
            ` : nothing}
        </svg>
        ${cursorX !== null && actualDotY !== null ? html`
            <span
                class="dash-cf-cum-chart-dot dash-cf-cum-chart-dot-actual"
                style="left: ${((cursorX / W) * 100).toFixed(2)}%; top: ${((actualDotY / H) * 100).toFixed(2)}%;"
            ></span>
        ` : nothing}
        ${cursorX !== null && predictedDotY !== null ? html`
            <span
                class="dash-cf-cum-chart-dot dash-cf-cum-chart-dot-predicted"
                style="left: ${((cursorX / W) * 100).toFixed(2)}%; top: ${((predictedDotY / H) * 100).toFixed(2)}%; border-color: ${predictedColor};"
            ></span>
        ` : nothing}
    `;
}


//Pointer handlers for the cumulative chart. Move records the hover timestamp (mapped from cursor X to a
//ms inside the day window), leave clears it. We re-render via requestUpdate so the Lit diff swaps the
//header values + dot + cursor positions in one frame.
export function handleCumChartHover(host: DashboardHost, e: PointerEvent, data: CumChartData): void
{
    const target = e.currentTarget as HTMLElement | null;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const tMs = data.dayStartMs + frac * (data.dayEndMs - data.dayStartMs);
    if (host._dashChartHoverTs !== tMs)
    {
        host._dashChartHoverTs = tMs;
        (host as unknown as { requestUpdate(): void }).requestUpdate();
    }
}


export function handleCumChartLeave(host: DashboardHost): void
{
    if (host._dashChartHoverTs !== null)
    {
        host._dashChartHoverTs = null;
        (host as unknown as { requestUpdate(): void }).requestUpdate();
    }
}
