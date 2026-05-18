//Detail-mode dashboard panel: the 4-section overlay that fades in
//when the user clicks the home silhouette (today, tomorrow,
//battery), plus the hover handlers that drive the today
//sparkline's tooltip and the home click / exit transitions.
//
//Pure-ish: most exports return TemplateResult or a computed value;
//the handlers mutate dashboard-specific @state on the host. All
//data is pulled through the host structural interface, no direct
//card imports.

import { html, svg, nothing, TemplateResult } from 'lit';
import { pickTranslations } from '../i18n';
import type { HeliosEngine } from '../helios-engine';
import
{
    DEFAULT_SUN_COLOR_HEX,
    DEFAULT_CLOUD_COLOR_HEX,
    DEFAULT_PV_COLOR_HEX,
    DEFAULT_BATTERY_COLOR_HEX
} from '../helios-config';
import { cfgHex, formatLocalisedNumber } from './format';
import
{
    pvCalibK,
    pvNormalizeToWatts,
    computePvPowerWeighted
} from './pv';
import { computeBatteryToday, type BatteryHost } from './battery';
import { computeDailyKwhTotals, type ChartHost } from './charts';
import { getHomeCoords } from './init';


//Structural surface the host card exposes to this module. Includes
//everything ChartHost + BatteryHost require so dashboard renderers
//can also call computeBatteryToday() and computeDailyKwhTotals()
//on the same host, plus the dashboard-specific mutable fields the
//hover / detail handlers update.
export interface DashboardHost extends ChartHost, BatteryHost
{
    readonly _engine?:     HeliosEngine;
    readonly _instanceId:  string;

    _detailMode:           boolean;
    _homeHover:            boolean;
    _dashChartHoverTs:     number | null;
}


//Renders the detail-mode panel: 4 stacked sections (today, week,
//tomorrow, battery) plus a close button. Each section uses one
//big SVG illustration that IS the data; numbers are annotations
//around the illustration, not the centerpiece. Battery section is
//skipped silently when neither battery entity is configured.
//
//The panel uses the configured colour palette (sun / cloud / pv /
//battery) so the dashboard reads as the same product the user
//already knows from the card itself.
export function renderDashboard(host: DashboardHost): TemplateResult
{
    const t            = pickTranslations(host.hass?.language);
    const sunColor     = cfgHex(host.config?.['sun-color'],     DEFAULT_SUN_COLOR_HEX);
    const cloudColor   = cfgHex(host.config?.['cloud-color'],   DEFAULT_CLOUD_COLOR_HEX);
    const pvColor      = cfgHex(host.config?.['pv-color'],      DEFAULT_PV_COLOR_HEX);
    const batteryColor = cfgHex(host.config?.['battery-color'], DEFAULT_BATTERY_COLOR_HEX);

    const hasBattery =
        String(host.config?.['battery-soc-entity']   ?? '').trim() !== ''
     || String(host.config?.['battery-power-entity'] ?? '').trim() !== '';

    return html`
        <div class="detail-panel">
            <button
                class="detail-close-btn"
                @click="${(e: Event) => handleExitDetail(host, e)}"
                aria-label="${t.detail.exitHint}"
            >
                <ha-icon icon="mdi:close"></ha-icon>
            </button>
            <div class="detail-panel-inner">
                ${renderDashTodaySection(host, t, pvColor, sunColor)}
                ${renderDashTomorrowSection(host, t, sunColor, cloudColor)}
                ${hasBattery ? renderDashBatterySection(host, t, batteryColor) : nothing}
            </div>
        </div>
    `;
}


//Computes hourly production for today, splitting observed (past
//+ now) from forecast (now → midnight). Returns one bin per hour
//of the day [0..23], with watts at the hour's midpoint. Bins
//missing observed data fall back to the forecast value where
//available; truly empty bins (no kWp configured + before sensor
//has started) get 0 W.
export function computeTodayHourly(host: DashboardHost): {
    bins:        Array<{ hourTs: number; observedW: number | null; forecastW: number | null }>;
    peakHourTs:  number | null;
    peakW:       number;
    producedKwh: number;
    forecastKwh: number;
}
{
    const HOUR_MS = 3_600_000;
    const today0  = new Date();
    today0.setHours(0, 0, 0, 0);
    const startMs = today0.getTime();
    const endMs   = startMs + 24 * HOUR_MS;
    const nowMs   = Date.now();

    const bins: Array<{
        hourTs: number;
        observedW: number | null;
        forecastW: number | null;
    }> = [];
    for (let h = 0; h < 24; h++)
    {
        bins.push({
            hourTs:    startMs + h * HOUR_MS,
            observedW: null,
            forecastW: null
        });
    }

    //Pass 1: observed. Aggregate _pvHistory into hourly buckets.
    //Same approach the chart uses (cumulative-energy sensors get
    //differentiated, power sensors are averaged).
    const hist = host._pvHistory;
    if (hist && hist.times.length > 0)
    {
        const unit = (host._pvUnit || '').toLowerCase();
        const isCumulativeEnergy = unit === 'wh' || unit === 'kwh' || unit === 'mwh';
        let times:  Date[]   = hist.times;
        let values: number[] = hist.values;
        if (isCumulativeEnergy && times.length >= 2)
        {
            const dT: Date[] = [];
            const dV: number[] = [];
            for (let i = 1; i < times.length; i++)
            {
                const dtH = (times[i].getTime() - times[i - 1].getTime()) / 3_600_000;
                if (dtH <= 0 || dtH > 6) continue;
                const dv  = values[i] - values[i - 1];
                if (dv < 0) continue;
                dT.push(times[i]);
                dV.push(dv / dtH);
            }
            times = dT;
            values = dV;
        }
        const sums   = new Map<number, number>();
        const counts = new Map<number, number>();
        for (let i = 0; i < times.length; i++)
        {
            const tMs = times[i].getTime();
            if (tMs < startMs || tMs >= endMs) continue;
            //After differentiation the values are average power in
            //kW (kWh/hour), so go straight to watts. The original
            //unit ('kWh' / 'MWh' / 'Wh') isn't handled by
            //pvNormalizeToWatts and would silently return 0,
            //which would zero out producedKwh and over-count
            //forecastKwh by skipping the observed contribution.
            const w = isCumulativeEnergy
                ? values[i] * 1000
                : pvNormalizeToWatts(values[i], host._pvUnit);
            if (!isFinite(w)) continue;
            const hourTs = Math.floor(tMs / HOUR_MS) * HOUR_MS;
            sums  .set(hourTs, (sums  .get(hourTs) ?? 0) + w);
            counts.set(hourTs, (counts.get(hourTs) ?? 0) + 1);
        }
        for (let h = 0; h < 24; h++)
        {
            const sum = sums  .get(bins[h].hourTs);
            const cnt = counts.get(bins[h].hourTs);
            if (sum !== undefined && cnt && cnt > 0)
            {
                bins[h].observedW = sum / cnt;
            }
        }
    }

    //Pass 2: forecast. Only when peak power is configured. Fill
    //in every hour bin (so we can show the full curve), but the
    //caller will combine observed + forecast for the area split.
    const k      = pvCalibK(host.config);
    const series = host._chartSeries;
    const coords = getHomeCoords(host.config, host.hass);
    if (k !== null && k > 0 && series && coords)
    {
        for (let i = 0; i < series.times.length; i++)
        {
            const tMs = series.times[i].getTime();
            if (tMs < startMs || tMs >= endMs) continue;
            const cloud = series.cloud[i] ?? 0;
            const pct   = computePvPowerWeighted(host.config, series.times[i], coords.lat, coords.lon, cloud);
            if (pct < 0) continue;
            const watts = pct * k;
            const hourTs = Math.floor(tMs / HOUR_MS) * HOUR_MS;
            const idx = (hourTs - startMs) / HOUR_MS;
            if (idx >= 0 && idx < 24)
            {
                bins[idx].forecastW = watts;
            }
        }
    }

    //Aggregate: peak (across all bins, taking observed > forecast),
    //produced kWh (sum of observed × 1h), forecast end-of-day
    //(observed past + forecast future).
    let peakW = 0;
    let peakHourTs: number | null = null;
    let producedKwh = 0;
    let forecastKwh = 0;
    for (const b of bins)
    {
        const w = b.observedW ?? b.forecastW ?? 0;
        if (w > peakW) { peakW = w; peakHourTs = b.hourTs; }

        if (b.observedW !== null) producedKwh += b.observedW / 1000;

        if (b.hourTs + HOUR_MS <= nowMs)
        {
            //Past hour: count observed if available, else nothing
            //(no forecast for the past).
            if (b.observedW !== null) forecastKwh += b.observedW / 1000;
        }
        else if (b.hourTs > nowMs)
        {
            //Future hour: count forecast if available.
            if (b.forecastW !== null) forecastKwh += b.forecastW / 1000;
        }
        else
        {
            //Hour straddling "now": count observed if available,
            //fall back to forecast (so the running total covers
            //the whole hour).
            forecastKwh += (b.observedW ?? b.forecastW ?? 0) / 1000;
        }
    }

    return { bins, peakHourTs, peakW, producedKwh, forecastKwh };
}


//Time-ordered cumulative production samples for today's chart.
//Past portion comes from the raw PV history (cumulative-energy
//sensors: subtract the day's baseline; power sensors: trapezoidal
//integration), future portion extends with the hourly forecast
//model. Hour marks are interpolated at every full hour so the
//chart can render a dot per hour without snapping the curve.
export function computeTodayCumulative(host: DashboardHost): {
    samples:   Array<{ tMs: number; kwh: number }>;
    hourMarks: Array<{ tMs: number; kwh: number }>;
    pastEndMs: number;
    maxKwh:    number;
}
{
    const HOUR_MS = 3_600_000;
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);
    const startMs = today0.getTime();
    const endMs   = startMs + 24 * HOUR_MS;
    const nowMs   = Date.now();

    const samples: Array<{ tMs: number; kwh: number }> = [];
    samples.push({ tMs: startMs, kwh: 0 });

    let cumKwh    = 0;
    let pastEndMs = startMs;

    //Past: integrate observed history. Cumulative-energy sensors
    //get a baseline-subtracted reading per sample; power sensors
    //get trapezoidal integration over consecutive pairs.
    const hist = host._pvHistory;
    if (hist && hist.times.length > 0)
    {
        const unit = (host._pvUnit || '').toLowerCase();
        const isCumulativeEnergy = unit === 'wh' || unit === 'kwh' || unit === 'mwh';
        const energyFactor = unit === 'wh' ? 1 / 1000
                           : unit === 'mwh' ? 1000
                           : 1;
        let baseline: number | null = null;
        let prevT:    number | null = null;
        let prevW:    number | null = null;

        for (let i = 0; i < hist.times.length; i++)
        {
            const tMs = hist.times[i].getTime();
            if (tMs < startMs || tMs >= endMs) continue;

            if (isCumulativeEnergy)
            {
                const v = hist.values[i] * energyFactor;
                if (baseline === null) baseline = v;
                const kwh = Math.max(0, v - baseline);
                samples.push({ tMs, kwh });
                cumKwh = kwh;
            }
            else
            {
                const w = pvNormalizeToWatts(hist.values[i], host._pvUnit);
                if (!isFinite(w)) continue;
                if (prevT !== null && prevW !== null)
                {
                    const dh = (tMs - prevT) / HOUR_MS;
                    if (dh > 0 && dh <= 6)
                    {
                        cumKwh += ((prevW + w) / 2) / 1000 * dh;
                    }
                }
                samples.push({ tMs, kwh: cumKwh });
                prevT = tMs;
                prevW = w;
            }
            pastEndMs = tMs;
        }
    }

    //Anchor at "now" so the solid past line ends precisely at the
    //present moment, instead of stopping at the last sample which
    //could be a minute or two stale.
    if (pastEndMs < nowMs && nowMs < endMs)
    {
        samples.push({ tMs: nowMs, kwh: cumKwh });
        pastEndMs = nowMs;
    }

    //Future: cumulate hourly forecast. Each hour contributes its
    //full bin amount, except the bin straddling "now" which only
    //contributes its remaining fraction so the boundary stitches
    //cleanly with the past curve.
    const k      = pvCalibK(host.config);
    const series = host._chartSeries;
    const coords = getHomeCoords(host.config, host.hass);
    if (k !== null && k > 0 && series && coords)
    {
        for (let i = 0; i < series.times.length; i++)
        {
            const tMs = series.times[i].getTime();
            if (tMs < startMs || tMs >= endMs) continue;
            const binStart = Math.floor(tMs / HOUR_MS) * HOUR_MS;
            const binEnd   = binStart + HOUR_MS;
            if (binEnd <= nowMs) continue;
            const cloud = series.cloud[i] ?? 0;
            const pct   = computePvPowerWeighted(host.config, series.times[i], coords.lat, coords.lon, cloud);
            if (pct < 0) continue;
            const futureStart = Math.max(binStart, nowMs);
            const fraction    = Math.min(1, (binEnd - futureStart) / HOUR_MS);
            cumKwh += (pct * k) / 1000 * fraction;
            samples.push({ tMs: binEnd, kwh: cumKwh });
        }
    }

    //Linearly interpolate the cumulative kWh at every full hour
    //so each dot lands exactly on the curve. Done in one pass via
    //a binary search since `samples` is time-ordered.
    const lookup = (t: number): number =>
    {
        if (samples.length === 0)                          return 0;
        if (t <= samples[0].tMs)                           return samples[0].kwh;
        if (t >= samples[samples.length - 1].tMs)          return samples[samples.length - 1].kwh;
        let lo = 0, hi = samples.length - 1;
        while (lo < hi - 1)
        {
            const mid = (lo + hi) >> 1;
            if (samples[mid].tMs <= t) lo = mid; else hi = mid;
        }
        const a = samples[lo], b = samples[hi];
        if (b.tMs === a.tMs) return a.kwh;
        return a.kwh + ((t - a.tMs) / (b.tMs - a.tMs)) * (b.kwh - a.kwh);
    };

    const hourMarks: Array<{ tMs: number; kwh: number }> = [];
    for (let h = 0; h <= 24; h++)
    {
        const tMs = startMs + h * HOUR_MS;
        hourMarks.push({ tMs, kwh: lookup(tMs) });
    }

    let maxKwh = 0;
    for (const s of samples) if (s.kwh > maxKwh) maxKwh = s.kwh;

    return { samples, hourMarks, pastEndMs, maxKwh };
}


export function renderDashTodaySection(
    host:     DashboardHost,
    t:        ReturnType<typeof pickTranslations>,
    pvColor:  string,
    sunColor: string
): TemplateResult
{
    const data    = computeTodayHourly(host);
    const HOUR_MS = 3_600_000;

    const peakTimeLabel = data.peakHourTs !== null
        ? new Date(data.peakHourTs + HOUR_MS / 2).toLocaleTimeString([], {
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        })
        : '';
    const peakValueLabel = formatPvWatts(host.hass, data.peakW);

    //Align the forecast number with the one the timeline shows so
    //both views agree. The hourly-bin aggregation used by
    //computeTodayHourly is fine for the peak chart but loses
    //sub-hour granularity; computeDailyKwhTotals integrates raw
    //history + per-hour forecast the same way the timeline does,
    //so reading today's bucket from it guarantees a single number
    //across both surfaces.
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);
    const todayMs   = today0.getTime();
    const dailyKwh  = computeDailyKwhTotals(host);
    const forecastKwh = dailyKwh.get(todayMs) ?? data.forecastKwh;

    const showForecast   = forecastKwh > data.producedKwh + 0.05;
    const showPeak       = data.peakHourTs !== null && data.peakW > 50;

    //Distinguish "no data yet" from "no production yet". When a PV
    //entity is configured and the history hasn't returned yet,
    //show a skeleton in place of the produced value, so users
    //don't read a transient 0,0 kWh as fact. Once the fetch lands
    //(empty or not), we fall back to rendering the number.
    const pvConfigured = String(host.config?.['pv-power-entity'] ?? '').trim() !== '';
    const historyLoading = pvConfigured && host._pvHistory === null;

    //"Not started yet" hint: produced is effectively zero but the
    //forecast knows a peak is still ahead. Avoids the confusing
    //"0,0 kWh / 12,1 kWh PRÉVU" reading by spelling out that the
    //counter is idle, not broken.
    const notStartedYet =
        !historyLoading
     && data.producedKwh < 0.05
     && data.peakHourTs !== null
     && data.peakHourTs > Date.now();

    return html`
        <section class="dash-section dash-card dash-today">
            <header class="dash-card-header">
                <ha-icon class="dash-card-icon" icon="mdi:weather-sunny" style="color:${sunColor}"></ha-icon>
                <span class="dash-card-label">${t.detail.todayLabel}</span>
            </header>
            <div class="dash-today-body">
                <div class="dash-today-produced" style="color:${pvColor}">
                    ${historyLoading ? html`
                        <span class="dash-stat-skeleton" aria-hidden="true"></span>
                    ` : html`
                        <span class="dash-stat-value">${formatLocalisedNumber(host.hass, data.producedKwh, 1)}</span>
                        <span class="dash-stat-unit">kWh</span>
                    `}
                </div>
                <div class="dash-today-side">
                    ${showForecast ? html`
                        <div class="dash-today-line dash-today-forecast">
                            <span class="dash-line-arrow">→</span>
                            <span class="dash-line-value">${formatLocalisedNumber(host.hass, forecastKwh, 1)} kWh</span>
                            <span class="dash-line-label">${t.detail.todayForecast}</span>
                        </div>
                    ` : nothing}
                    ${showPeak ? html`
                        <div class="dash-today-line dash-today-peak">
                            <ha-icon icon="mdi:white-balance-sunny" style="color:${sunColor}"></ha-icon>
                            <span class="dash-line-value">${peakTimeLabel} · ${peakValueLabel}</span>
                            <span class="dash-line-label">${t.detail.todayPeak}</span>
                        </div>
                    ` : nothing}
                </div>
                ${historyLoading ? nothing : renderDashTodayChart(host, pvColor)}
            </div>
            ${notStartedYet ? html`
                <div class="dash-today-status">${t.detail.todayNotStartedYet}</div>
            ` : nothing}
        </section>
    `;
}


//Cumulative production sparkline for the today card. Hidden via
//a container query when the card isn't wide enough to render the
//curve without squashing it (see helios-card-css.ts). When the
//user hovers, a vertical guideline + travelling dot reveal a
//tooltip showing the cumulative kWh at that exact minute.
export function renderDashTodayChart(host: DashboardHost, pvColor: string): TemplateResult | typeof nothing
{
    const cum = computeTodayCumulative(host);
    if (cum.maxKwh < 0.05) return nothing;

    const HOUR_MS  = 3_600_000;
    const today0   = new Date();
    today0.setHours(0, 0, 0, 0);
    const startMs  = today0.getTime();
    const endMs    = startMs + 24 * HOUR_MS;

    const W = 240, H = 60;
    const PAD_X = 4, PAD_T = 4, PAD_B = 6;
    const yMax  = Math.max(cum.maxKwh, 0.1) * 1.05;

    const xFor = (t: number): number =>
        PAD_X + ((t - startMs) / (endMs - startMs)) * (W - 2 * PAD_X);
    const yFor = (kwh: number): number =>
        H - PAD_B - (kwh / yMax) * (H - PAD_T - PAD_B);

    const buildPath = (pts: Array<{ tMs: number; kwh: number }>): string =>
    {
        if (pts.length < 2) return '';
        return 'M ' + pts.map(p =>
            `${xFor(p.tMs).toFixed(2)} ${yFor(p.kwh).toFixed(2)}`
        ).join(' L ');
    };

    const pastSamples   = cum.samples.filter(s => s.tMs <= cum.pastEndMs);
    const futureSamples = cum.samples.filter(s => s.tMs >= cum.pastEndMs);
    const pastPath      = buildPath(pastSamples);
    const futurePath    = buildPath(futureSamples);

    //Hover lookup: interpolate cumulative kWh at the cursor's
    //time. Same binary search as computeTodayCumulative so the
    //tooltip lines up exactly with the curve.
    const hoverTs = host._dashChartHoverTs;
    let hoverKwh:        number | null = null;
    let hoverX:          number        = 0;
    let hoverFracX:      number        = 0;
    let hoverTimeLabel:  string        = '';
    if (hoverTs !== null && hoverTs >= startMs && hoverTs < endMs)
    {
        const samples = cum.samples;
        if (samples.length > 0)
        {
            if (hoverTs <= samples[0].tMs)
            {
                hoverKwh = samples[0].kwh;
            }
            else if (hoverTs >= samples[samples.length - 1].tMs)
            {
                hoverKwh = samples[samples.length - 1].kwh;
            }
            else
            {
                let lo = 0, hi = samples.length - 1;
                while (lo < hi - 1)
                {
                    const mid = (lo + hi) >> 1;
                    if (samples[mid].tMs <= hoverTs) lo = mid; else hi = mid;
                }
                const a = samples[lo], b = samples[hi];
                hoverKwh = a.tMs === b.tMs
                    ? a.kwh
                    : a.kwh + ((hoverTs - a.tMs) / (b.tMs - a.tMs)) * (b.kwh - a.kwh);
            }
            hoverX         = xFor(hoverTs);
            hoverFracX     = (hoverX / W) * 100;
            hoverTimeLabel = new Date(hoverTs).toLocaleTimeString([], {
                hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
            });
        }
    }

    return html`
        <div class="dash-today-chart">
            <svg class="dash-today-chart-svg"
                 viewBox="0 0 ${W} ${H}"
                 preserveAspectRatio="none"
                 @pointermove="${(e: PointerEvent) => handleDashChartPointerMove(host, e)}"
                 @pointerleave="${() => handleDashChartPointerLeave(host)}"
            >
                ${pastPath !== '' ? svg`
                    <path class="dash-today-chart-past"
                          d="${pastPath}"
                          stroke="${pvColor}"/>
                ` : nothing}
                ${futurePath !== '' ? svg`
                    <path class="dash-today-chart-future"
                          d="${futurePath}"
                          stroke="${pvColor}"/>
                ` : nothing}
                ${cum.hourMarks.map(m => svg`
                    <circle class="dash-today-chart-dot"
                            cx="${xFor(m.tMs).toFixed(2)}"
                            cy="${yFor(m.kwh).toFixed(2)}"
                            r="1.4"
                            fill="${pvColor}"/>
                `)}
                ${hoverKwh !== null ? svg`
                    <line class="dash-today-chart-hover-line"
                          x1="${hoverX.toFixed(2)}" x2="${hoverX.toFixed(2)}"
                          y1="${PAD_T}" y2="${H - PAD_B}"/>
                    <circle class="dash-today-chart-hover-dot"
                            cx="${hoverX.toFixed(2)}"
                            cy="${yFor(hoverKwh).toFixed(2)}"
                            r="2.2"
                            fill="${pvColor}"/>
                ` : nothing}
            </svg>
            ${hoverKwh !== null ? html`
                <div class="dash-today-chart-tooltip"
                     style="left: ${hoverFracX.toFixed(2)}%;"
                >
                    ${hoverTimeLabel} · ${formatLocalisedNumber(host.hass, hoverKwh, 1)} kWh
                </div>
            ` : nothing}
        </div>
    `;
}


//Helper: format a wattage value as a short label (W or kW).
export function formatPvWatts(hass: any, w: number): string
{
    if (!isFinite(w) || w < 0) return '0 W';
    if (w >= 1000) return formatLocalisedNumber(hass, w / 1000, 2) + ' kW';
    return Math.round(w) + ' W';
}


//Aggregates tomorrow's forecast: total kWh, peak hour and watts,
//and an irradiance-weighted average cloud cover. All derived from
//the engine's weather series, no observed history is involved
//(tomorrow hasn't happened yet).
export function computeTomorrow(host: DashboardHost): {
    totalKwh:   number;
    peakHourTs: number | null;
    peakW:      number;
    avgCloud:   number;
}
{
    const HOUR_MS = 3_600_000;
    const today0  = new Date();
    today0.setHours(0, 0, 0, 0);
    const tomorrowMs = today0.getTime() + 24 * HOUR_MS;
    const endMs      = tomorrowMs + 24 * HOUR_MS;

    const series = host._chartSeries;
    const coords = getHomeCoords(host.config, host.hass);
    const k      = pvCalibK(host.config);

    let totalKwh = 0;
    let peakHourTs: number | null = null;
    let peakW = 0;
    let cloudSum = 0;
    let cloudWeight = 0;

    if (series && coords)
    {
        for (let i = 0; i < series.times.length; i++)
        {
            const tMs = series.times[i].getTime();
            if (tMs < tomorrowMs || tMs >= endMs) continue;
            const cloud = series.cloud[i] ?? 0;
            const pct   = computePvPowerWeighted(host.config, series.times[i], coords.lat, coords.lon, cloud);
            if (pct > 0 && k !== null)
            {
                const watts = pct * k;
                totalKwh += watts / 1000;
                if (watts > peakW)
                {
                    peakW = watts;
                    peakHourTs = Math.floor(tMs / HOUR_MS) * HOUR_MS;
                }
                cloudSum    += cloud * pct;
                cloudWeight += pct;
            }
        }
    }

    const avgCloud = cloudWeight > 0 ? cloudSum / cloudWeight : 0;

    return { totalKwh, peakHourTs, peakW, avgCloud };
}


export function renderDashTomorrowSection(
    host:      DashboardHost,
    t:         ReturnType<typeof pickTranslations>,
    sunColor:  string,
    _cloudColor: string
): TemplateResult
{
    const data = computeTomorrow(host);
    const HOUR_MS = 3_600_000;

    const peakTimeLabel = data.peakHourTs !== null
        ? new Date(data.peakHourTs + HOUR_MS / 2).toLocaleTimeString([], {
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        })
        : '';

    return html`
        <section class="dash-section dash-card dash-tomorrow">
            <header class="dash-card-header">
                <ha-icon class="dash-card-icon" icon="mdi:weather-partly-cloudy" style="color:${sunColor}"></ha-icon>
                <span class="dash-card-label">${t.detail.tomorrowLabel}</span>
                <span class="dash-card-trailing dash-card-trailing-forecast">
                    <span class="dash-stat-value-sm">≈ ${formatLocalisedNumber(host.hass, data.totalKwh, 1)}</span>
                    <span class="dash-stat-unit-sm">kWh</span>
                </span>
            </header>
            ${data.peakHourTs !== null ? html`
                <div class="dash-tomorrow-peak">
                    <ha-icon icon="mdi:white-balance-sunny" style="color:${sunColor}"></ha-icon>
                    <span class="dash-line-label">${t.detail.tomorrowPeak}</span>
                    <span class="dash-line-value">${peakTimeLabel}</span>
                </div>
            ` : nothing}
        </section>
    `;
}


export function renderDashBatterySection(
    host:         DashboardHost,
    t:            ReturnType<typeof pickTranslations>,
    batteryColor: string
): TemplateResult
{
    const data = computeBatteryToday(host);
    const soc  = data.socNow ?? 0;

    //Vessel canvas: 200 × 240, drawn as a stylised vertical
    //Compact vessel for the chip-card layout. The battery cap +
    //cell are drawn relative to the SVG viewBox and scale with
    //the card width via CSS.
    const W = 60;
    const H = 100;
    const capW = 18, capH = 6;
    const cellX = 8, cellY = 12;
    const cellW = W - 2 * cellX, cellH = H - cellY - 6;
    const liquidH = (Math.max(0, Math.min(100, soc)) / 100) * (cellH - 4);
    const liquidY = cellY + cellH - 2 - liquidH;
    const liquidX = cellX + 2;
    const liquidW = cellW - 4;

    return html`
        <section class="dash-section dash-card dash-battery">
            <header class="dash-card-header">
                <ha-icon class="dash-card-icon" icon="mdi:battery" style="color:${batteryColor}"></ha-icon>
                <span class="dash-card-label">${t.detail.batteryLabel}</span>
                <span class="dash-card-trailing">
                    <span class="dash-stat-value-sm">${Math.round(soc)}</span>
                    <span class="dash-stat-unit-sm">%</span>
                </span>
            </header>
            <div class="dash-battery-body">
                <svg class="dash-battery-vessel" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
                    <defs>
                        <linearGradient id="dash-batt-grad-${host._instanceId}" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%"   stop-color="${batteryColor}" stop-opacity="0.95"/>
                            <stop offset="100%" stop-color="${batteryColor}" stop-opacity="0.6"/>
                        </linearGradient>
                    </defs>
                    ${(() => {
                        //Battery cap drawn as an open path: top + two
                        //sides, no bottom edge. The shell rect just
                        //below provides the shared horizontal line,
                        //so we avoid the two strokes stacking and
                        //showing as a double thickness at the join.
                        const capLx = (W - capW) / 2;
                        const capRx = (W + capW) / 2;
                        const capTy = cellY - capH;
                        const capBy = cellY;
                        const r = 1.5;
                        const capPath = [
                            `M ${capLx} ${capBy}`,
                            `L ${capLx} ${capTy + r}`,
                            `Q ${capLx} ${capTy} ${capLx + r} ${capTy}`,
                            `L ${capRx - r} ${capTy}`,
                            `Q ${capRx} ${capTy} ${capRx} ${capTy + r}`,
                            `L ${capRx} ${capBy}`
                        ].join(' ');
                        return svg`<path class="dash-batt-cap" d="${capPath}"/>`;
                    })()}
                    <rect class="dash-batt-shell"
                          x="${cellX}" y="${cellY}"
                          width="${cellW}" height="${cellH}" rx="3"/>
                    ${liquidH > 0 ? svg`
                        <rect class="dash-batt-liquid"
                              x="${liquidX}" y="${liquidY}"
                              width="${liquidW}" height="${liquidH}"
                              rx="2"
                              fill="url(#dash-batt-grad-${host._instanceId})"/>
                    ` : nothing}
                </svg>
                <div class="dash-battery-flows">
                    <div class="dash-battery-flow dash-battery-flow-charge">
                        <ha-icon icon="mdi:arrow-up-bold"></ha-icon>
                        <span class="dash-flow-value">${formatLocalisedNumber(host.hass, data.chargedKwh, 1)} kWh</span>
                        <span class="dash-flow-label">${t.detail.batteryCharged}</span>
                    </div>
                    <div class="dash-battery-flow dash-battery-flow-discharge">
                        <ha-icon icon="mdi:arrow-down-bold"></ha-icon>
                        <span class="dash-flow-value">${formatLocalisedNumber(host.hass, data.dischargedKwh, 1)} kWh</span>
                        <span class="dash-flow-label">${t.detail.batteryDischarged}</span>
                    </div>
                </div>
            </div>
        </section>
    `;
}


//Detail-mode toggles. Driven by the home click (off → on) and a
//click anywhere on the detail panel (on → off). The engine
//handles the eased camera transition; we just flip the state
//and let the CSS .detail-active class fade out the overlays.
export function handleHomeClick(host: DashboardHost, e: Event): void
{
    //Stop propagation so the underlying map doesn't also process
    //the click as a pan / drag start, and so nested overlay
    //layers don't double-handle it.
    e.stopPropagation();
    if (host._detailMode) { return; }
    //Clear the hover flag immediately, the hitbox un-renders
    //once detail mode opens so mouseleave never fires; without
    //this the glow would flash back on as soon as the user
    //exits detail mode and the hitbox re-appears.
    host._homeHover  = false;
    host._detailMode = true;
    host._engine?.setDetailMode(true);
}


export function handleExitDetail(host: DashboardHost, e: Event): void
{
    e.stopPropagation();
    if (!host._detailMode) { return; }
    host._detailMode = false;
    host._engine?.setDetailMode(false);
}


//Hover handlers on the today chart sparkline. Update the hover
//timestamp on move; clear it on leave so the tooltip + cursor
//disappear cleanly when the pointer exits the SVG.
export function handleDashChartPointerMove(host: DashboardHost, e: PointerEvent): void
{
    const svgEl = e.currentTarget as SVGSVGElement | null;
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    const W = 240, PAD_X = 4;
    const fracPx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const xLogical = fracPx * W;
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);
    const startMs = today0.getTime();
    const endMs   = startMs + 24 * 3_600_000;
    const tFrac = (xLogical - PAD_X) / (W - 2 * PAD_X);
    host._dashChartHoverTs = startMs
        + Math.max(0, Math.min(1, tFrac)) * (endMs - startMs);
}


export function handleDashChartPointerLeave(host: DashboardHost): void
{
    host._dashChartHoverTs = null;
}
