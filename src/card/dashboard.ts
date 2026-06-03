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
    DEFAULT_PV_COLOR_HEX,
    DEFAULT_BATTERY_COLOR_HEX
} from '../helios-config';
import { formatDate, formatLocalisedNumber, lerpHexToward } from './format';
import
{
    pvCalibK,
    pvNormalizeToWatts,
    pvInverterMaxW,
    computePvPowerWeighted,
    resolvePvLiveEntity
} from './pv';
import { computeBatteryToday, resolveBatteryEntities, type BatteryHost } from './battery';
import { effectiveForecastRatio, type ChartHost } from './charts';
import { computeForecastCalibration } from './calibration';
import { currentShadingMap } from './shadingTrainer';
import type { SunScene } from './overlays';
import { getHomeCoords } from './init';


//Structural surface the host card exposes to this module. Includes
//everything ChartHost + BatteryHost require so dashboard renderers
//can also call computeBatteryToday() on the same host, plus the
//dashboard-specific mutable fields the hover / detail handlers
//update.
export interface DashboardHost extends ChartHost, BatteryHost
{
    readonly _engine?:     HeliosEngine;
    readonly _instanceId:  string;
    readonly _sunScene?:   SunScene | null;
    //_haSolarTodayKwh lives on ChartHost (the scrub tooltip reads it
    //for today's bucket). The same field powers the dashboard "kWh
    //produit aujourd'hui" headline in renderDashTodaySection.

    _detailMode:           boolean;
    _homeHover:            boolean;
    _dashChartHoverTs:     number | null;
    //Timestamp the detail panel opened at. Drives the headline count-up animation on the produced-kWh + forecast-kWh figures so the
    //numbers tick from 0 up to the real value over ~700 ms whenever the user enters detail mode. Reset to null on exit so a subsequent
    //re-open replays the animation. Null while the panel is closed.
    _dashOpenedAtMs:       number | null;
    //Lit-side requestUpdate handle used during the count-up window; the dashboard handlers below set it via the host so a single rAF
    //loop drives re-renders for the 700 ms window then self-clears.
    _dashCountUpRaf?:      number;
}


//Day-integrated kWh forecast with the per-step `effectiveForecastRatio` blended in. The same recipe the timeline day-strip chips use:
//for each forecast sample, compute the raw model output (pct × k), then multiply by the (shading-map per-(sun×cloud) auto-learned
//ratio when confident, scalar 5-day calibration as fallback). Used by the dashboard's "→ X kWh affiné" headline so the dashboard's
//refined figure matches the timeline chips and the in-card refined value at every scrub instant.
export function computeRefinedDailyKwh(host: DashboardHost, dayStartMs: number, dayEndMs: number): number | null
{
    const k      = pvCalibK(host.config);
    const series = host._chartSeries;
    const coords = getHomeCoords(host.config, host.hass);
    if (k === null || k <= 0 || !series || !coords)
    {
        return null;
    }
    const raster = host._engine?.getLidarRaster() ?? null;
    const shMap  = currentShadingMap();
    const cal    = computeForecastCalibration(host);
    const calR   = cal?.ratio ?? 1;
    const nowMs  = Date.now();
    const capW   = pvInverterMaxW(host.config);
    let kwh = 0;
    let any = false;
    for (let i = 0; i < series.times.length; i++)
    {
        const tMs = series.times[i].getTime();
        if (tMs < dayStartMs || tMs >= dayEndMs)
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
        kwh += Math.min(capW, pct * k * ratio) / 1000;
        any = true;
    }
    return any ? kwh : null;
}


//Cubic ease-out shape `1 - (1 - t)³`. Returns a 0..1 phase whose late frames slow down toward the target, which reads as the value
//"settling" on its final figure rather than slamming into it.
const COUNT_UP_MS = 700;
export function dashCountUpPhase(host: DashboardHost): number
{
    const start = host._dashOpenedAtMs;
    if (start === null)
    {
        return 1;
    }
    const t = Math.max(0, Math.min(1, (performance.now() - start) / COUNT_UP_MS));
    const inv = 1 - t;
    return 1 - inv * inv * inv;
}


//Renders the detail-mode panel: a today section stacked above a
//tomorrow + battery row plus a close button. Tomorrow stretches
//full width when the battery section is skipped (neither battery
//entity configured). Each section uses one big SVG illustration
//that IS the data; numbers are annotations around the
//illustration, not the centerpiece.
//
//The panel uses the configured colour palette (sun / cloud / pv /
//battery) so the dashboard reads as the same product the user
//already knows from the card itself.
export function renderDashboard(host: DashboardHost): TemplateResult
{
    const t            = pickTranslations(host.hass?.language);
    //Colour configs are no longer consulted; the dashboard inherits the HA Energy palette via the CSS tokens consumed by
    //every chip / leader / chart style. Locals stay so downstream callers that expect a string colour for inline SVG
    //attributes still build.
    const sunColor     = DEFAULT_SUN_COLOR_HEX;
    const pvColor      = DEFAULT_PV_COLOR_HEX;
    const batteryColor = DEFAULT_BATTERY_COLOR_HEX;

    //Battery card eligibility: the HA Energy defaults expose either a SoC source (`stat_soc`) or a power source (`stat_rate`,
    //`stat_energy_from` or `stat_energy_to`). Either side alone lights the card; the renderer handles the missing-slot case
    //by leaving the corresponding chip empty.
    const batteryEntities = resolveBatteryEntities(host._energyDefaults);
    const hasBattery = batteryEntities.socEntity !== null || batteryEntities.powerEntity !== null;

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
                ${hasBattery ? html`
                    <div class="dash-row">
                        ${renderDashTomorrowSection(host, t, sunColor, pvColor)}
                        ${renderDashBatterySection(host, t, batteryColor)}
                    </div>
                ` : renderDashTomorrowSection(host, t, sunColor, pvColor)}
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
    peakActualHourTs:    number | null;
    peakActualW:         number;
    peakPredictedHourTs: number | null;
    peakPredictedW:      number;
    producedKwh: number;
    forecastKwh: number;
}
{
    const HOUR_MS = 3_600_000;
    const today0  = new Date();
    today0.setHours(0, 0, 0, 0);
    //DST-safe end-of-day: spring-forward (23 h) and fall-back (25 h) days resolve to the correct next local midnight
    //instead of landing at 01:00 or 23:00.
    const tomorrow0 = new Date(today0);
    tomorrow0.setDate(tomorrow0.getDate() + 1);
    const startMs = today0.getTime();
    const endMs   = tomorrow0.getTime();
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
            //Same quantization guard as the chart's differentiation: hold the anchor until 3 min have accumulated so dv / dtH doesn't blow up when
            //the sensor only reports integer Wh.
            const MIN_DTH = 0.05;
            const dT: Date[] = [];
            const dV: number[] = [];
            let prevIdx = 0;
            for (let i = 1; i < times.length; i++)
            {
                const dtH = (times[i].getTime() - times[prevIdx].getTime()) / 3_600_000;
                if (dtH <= 0)
                {
                    continue;
                }
                if (dtH > 6)  { prevIdx = i; continue; }
                const dv = values[i] - values[prevIdx];
                if (dv < 0)   { prevIdx = i; continue; }
                if (dtH < MIN_DTH)
                {
                    continue;
                }
                dT.push(times[i]);
                dV.push(dv / dtH);
                prevIdx = i;
            }
            times = dT;
            values = dV;
        }
        const sums   = new Map<number, number>();
        const counts = new Map<number, number>();
        for (let i = 0; i < times.length; i++)
        {
            const tMs = times[i].getTime();
            if (tMs < startMs || tMs >= endMs)
            {
                continue;
            }
            //After differentiation the values are average power in
            //kW (kWh/hour), so go straight to watts. The original
            //unit ('kWh' / 'MWh' / 'Wh') isn't handled by
            //pvNormalizeToWatts and would silently return 0,
            //which would zero out producedKwh and over-count
            //forecastKwh by skipping the observed contribution.
            const w = isCumulativeEnergy
                ? values[i] * 1000
                : pvNormalizeToWatts(values[i], host._pvUnit);
            if (!isFinite(w))
            {
                continue;
            }
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
    //RAW model output here (no calibration / shading map blend),
    //the refined headline computes its own pass via
    //computeRefinedDailyKwh so the "PRÉVU" figure stays raw and the
    //arrow figure carries the per-(sun×cloud) auto-learning.
    const k      = pvCalibK(host.config);
    const series = host._chartSeries;
    const coords = getHomeCoords(host.config, host.hass);
    if (k !== null && k > 0 && series && coords)
    {
        const raster = host._engine?.getLidarRaster() ?? null;
        const capW   = pvInverterMaxW(host.config);
        for (let i = 0; i < series.times.length; i++)
        {
            const tMs = series.times[i].getTime();
            if (tMs < startMs || tMs >= endMs)
            {
                continue;
            }
            const cloud = series.cloud[i] ?? 0;
            const pct   = computePvPowerWeighted(host.config, series.times[i], coords.lat, coords.lon, cloud, {
                airTempC: series.temperature[i],
                windMs:   series.windSpeed[i],
                raster,
            });
            if (pct < 0)
            {
                continue;
            }
            const watts = Math.min(capW, pct * k);
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
    //
    //We also track the actual and predicted peaks separately so
    //the dashboard can show two distinct readouts (real vs model)
    //side by side. The hybrid `peakW` is kept as a fallback for
    //consumers that just want "the day's peak, whichever source".
    let peakW = 0;
    let peakHourTs: number | null = null;
    let peakActualW = 0;
    let peakActualHourTs: number | null = null;
    let peakPredictedW = 0;
    let peakPredictedHourTs: number | null = null;
    let producedKwh = 0;
    let forecastKwh = 0;
    for (const b of bins)
    {
        const w = b.observedW ?? b.forecastW ?? 0;
        if (w > peakW) { peakW = w; peakHourTs = b.hourTs; }

        if (b.observedW !== null && b.observedW > peakActualW)
        {
            peakActualW = b.observedW;
            peakActualHourTs = b.hourTs;
        }
        if (b.forecastW !== null && b.forecastW > peakPredictedW)
        {
            peakPredictedW = b.forecastW;
            peakPredictedHourTs = b.hourTs;
        }

        if (b.observedW !== null)
        {
            producedKwh += b.observedW / 1000;
        }

        if (b.hourTs + HOUR_MS <= nowMs)
        {
            //Past hour: count observed if available, else nothing
            //(no forecast for the past).
            if (b.observedW !== null)
            {
                forecastKwh += b.observedW / 1000;
            }
        }
        else if (b.hourTs > nowMs)
        {
            //Future hour: count forecast if available.
            if (b.forecastW !== null)
            {
                forecastKwh += b.forecastW / 1000;
            }
        }
        else
        {
            //Hour straddling "now": count observed if available,
            //fall back to forecast (so the running total covers
            //the whole hour).
            forecastKwh += (b.observedW ?? b.forecastW ?? 0) / 1000;
        }
    }

    return {
        bins,
        peakHourTs, peakW,
        peakActualHourTs, peakActualW,
        peakPredictedHourTs, peakPredictedW,
        producedKwh, forecastKwh
    };
}


//Linearly interpolate the cumulative kWh on a sorted samples
//array at a given timestamp. Returns null when the time falls
//outside the defined range (e.g. actual stops at "now"). Shared
//by the chart hover tooltip, the headline delta % readout, and
//any other consumer that needs a point read on the two curves.
function interpolateKwhAt(
    pts: Array<{ tMs: number; kwh: number }>,
    t:   number
): number | null
{
    if (pts.length === 0)
    {
        return null;
    }
    if (t < pts[0].tMs)
    {
        return null;
    }
    if (t > pts[pts.length - 1].tMs)
    {
        return null;
    }
    let lo = 0, hi = pts.length - 1;
    while (lo < hi - 1)
    {
        const mid = (lo + hi) >> 1;
        if (pts[mid].tMs <= t)
        {
            lo = mid;
        }
        else
        {
            hi = mid;
        }
    }
    const a = pts[lo], b = pts[hi];
    if (b.tMs === a.tMs)
    {
        return a.kwh;
    }
    return a.kwh + ((t - a.tMs) / (b.tMs - a.tMs)) * (b.kwh - a.kwh);
}


//Two time-ordered cumulative production curves for today's chart.
//`actualSamples` is the observed history integrated from midnight
//up to the latest sample (or "now" if the entity went quiet for
//a few minutes). `predictedSamples` is the pure forecast model
//(kWp × clear-sky × cloud) integrated hour by hour from midnight
//to midnight, regardless of "now", so the user can compare what
//was predicted at each past hour against what was actually
//produced. Both curves share the same Y scale via `maxKwh`.
export function computeTodayCumulative(host: DashboardHost): {
    actualSamples:    Array<{ tMs: number; kwh: number }>;
    predictedSamples: Array<{ tMs: number; kwh: number }>;
    pastEndMs:        number;
    maxKwh:           number;
}
{
    const HOUR_MS = 3_600_000;
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);
    const tomorrow0 = new Date(today0);
    tomorrow0.setDate(tomorrow0.getDate() + 1);
    const startMs = today0.getTime();
    const endMs   = tomorrow0.getTime();
    const nowMs   = Date.now();

    const actualSamples: Array<{ tMs: number; kwh: number }> = [];
    actualSamples.push({ tMs: startMs, kwh: 0 });

    let actualKwh = 0;
    let pastEndMs = startMs;

    //Actual: integrate observed history. Cumulative-energy sensors
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
            if (tMs < startMs || tMs >= endMs)
            {
                continue;
            }

            if (isCumulativeEnergy)
            {
                const v = hist.values[i] * energyFactor;
                if (baseline === null)
                {
                    baseline = v;
                }
                //Mid-day counter reset (sensor restart, integration nodered restart, daily-reset utility-meter): the
                //raw value drops below the baseline. Snap the baseline so the cumulative day-kwh stays monotonic from
                //the last known total, otherwise every post-reset sample reads as a fresh baseline and the day total
                //jumps backward by the full pre-reset production.
                if (v < baseline)
                {
                    baseline = v - actualKwh;
                }
                const kwh = Math.max(0, v - baseline);
                actualSamples.push({ tMs, kwh });
                actualKwh = kwh;
            }
            else
            {
                const w = pvNormalizeToWatts(hist.values[i], host._pvUnit);
                if (!isFinite(w))
                {
                    continue;
                }
                if (prevT !== null && prevW !== null)
                {
                    const dh = (tMs - prevT) / HOUR_MS;
                    if (dh > 0 && dh <= 6)
                    {
                        actualKwh += ((prevW + w) / 2) / 1000 * dh;
                    }
                }
                actualSamples.push({ tMs, kwh: actualKwh });
                prevT = tMs;
                prevW = w;
            }
            pastEndMs = tMs;
        }
    }

    //Anchor the actual line at "now" so the curve ends precisely at the present moment, instead of stopping at the last sample which could be a
    //minute or two stale.
    if (pastEndMs < nowMs && nowMs < endMs)
    {
        actualSamples.push({ tMs: nowMs, kwh: actualKwh });
        pastEndMs = nowMs;
    }

    //Predicted: integrate the forecast model hour by hour over the
    //whole day (no "now" filter). Each forecast sample contributes
    //the full hour bin (`pct * k / 1000` kWh). Skipped silently
    //when peak power isn't configured.
    const predictedSamples: Array<{ tMs: number; kwh: number }> = [];
    predictedSamples.push({ tMs: startMs, kwh: 0 });
    let predictedKwh = 0;

    const k      = pvCalibK(host.config);
    const series = host._chartSeries;
    const coords = getHomeCoords(host.config, host.hass);
    if (k !== null && k > 0 && series && coords)
    {
        const raster = host._engine?.getLidarRaster() ?? null;
        const capW   = pvInverterMaxW(host.config);
        for (let i = 0; i < series.times.length; i++)
        {
            const tMs = series.times[i].getTime();
            if (tMs < startMs || tMs >= endMs)
            {
                continue;
            }
            const binEnd = Math.floor(tMs / HOUR_MS) * HOUR_MS + HOUR_MS;
            const cloud  = series.cloud[i] ?? 0;
            const pct    = computePvPowerWeighted(host.config, series.times[i], coords.lat, coords.lon, cloud, {
                airTempC: series.temperature[i],
                windMs:   series.windSpeed[i],
                raster,
            });
            if (pct < 0)
            {
                continue;
            }
            predictedKwh += Math.min(capW, pct * k) / 1000;
            predictedSamples.push({ tMs: binEnd, kwh: predictedKwh });
        }
    }

    let maxKwh = 0;
    for (const s of actualSamples)    if (s.kwh > maxKwh)
    {
        maxKwh = s.kwh;
    }
    for (const s of predictedSamples) if (s.kwh > maxKwh)
    {
        maxKwh = s.kwh;
    }

    return { actualSamples, predictedSamples, pastEndMs, maxKwh };
}


export function renderDashTodaySection(
    host:     DashboardHost,
    t:        ReturnType<typeof pickTranslations>,
    pvColor:  string,
    sunColor: string
): TemplateResult
{
    const data    = computeTodayHourly(host);
    const cum     = computeTodayCumulative(host);
    const HOUR_MS = 3_600_000;

    //Format both the actual peak (highest observed bin so far) and
    //the predicted peak (highest forecast bin). In the morning the
    //actual one is null until production crosses ~50 W; in that
    //case the row falls back to showing only "PIC PRÉVU".
    const haLanguage = (host.hass?.language as string | undefined) || undefined;
    const peakTimeFormatter = new Intl.DateTimeFormat(haLanguage, {
        hour: '2-digit', minute: '2-digit',
    });
    const formatPeakTime = (hourTs: number | null): string =>
        hourTs !== null
            ? peakTimeFormatter.format(new Date(hourTs + HOUR_MS / 2))
            : '';
    const peakActualTime    = formatPeakTime(data.peakActualHourTs);
    const peakActualValue   = formatPvWatts(host.hass, data.peakActualW);
    const peakPredictedTime = formatPeakTime(data.peakPredictedHourTs);
    const peakPredictedValue = formatPvWatts(host.hass, data.peakPredictedW);
    const showPeakActual    = data.peakActualHourTs    !== null && data.peakActualW    > 50;
    const showPeakPredicted = data.peakPredictedHourTs !== null && data.peakPredictedW > 50;

    //Use the cumulative method for both the headline produced and
    //forecast values so the numbers match the chart curves exactly.
    //Produced = the latest sample on the actual curve. Forecast =
    //the terminal sample on the pure-model curve (end-of-day).
    //The hourly-bin aggregation in computeTodayHourly is still used
    //for the peak readout and the not-started-yet detection.
    //
    //Math.max guard: a power sensor that reads slightly negative at
    //night (inverter standby noise, net-meter jitter) can produce
    //a small negative integral over the first few minutes of the
    //day; the headline would then read "-0.0 kWh produced" right
    //after midnight, which is a UX regression (the user sees "-0"
    //and assumes a bug). Flooring at zero matches the rest of the
    //PV readouts (live chip, tooltip) that already do this.
    //
    //HA Energy alignment short-circuit : when the user has
    //a solar source on the Energy dashboard, the card refresh tick
    //has populated `_haSolarTodayKwh` from
    //`recorder/statistics_during_period` (types: 'change') over the
    //local day. The recorder's Riemann sum matches the value the
    //HA Energy tile shows to the watt-hour, including on the sparse
    //high-frequency installs where the in-browser trapezoidal
    //integration of `_pvHistory` drifts. The chart curve, the
    //forecast and the calibration loop are NOT touched here, they
    //continue to consume the local integration.
    const haProducedKwh = host._haSolarTodayKwh ?? null;
    const integratedProducedKwh = cum.actualSamples.length > 0
        ? Math.max(0, cum.actualSamples[cum.actualSamples.length - 1].kwh)
        : 0;
    const producedKwh = haProducedKwh !== null ? Math.max(0, haProducedKwh) : integratedProducedKwh;
    const forecastKwh = cum.predictedSamples.length > 0
        ? cum.predictedSamples[cum.predictedSamples.length - 1].kwh
        : 0;

    //Delta between what we've actually produced and what the model
    //predicted up to the same instant. Positive means we're ahead
    //of the forecast (sunnier than expected); negative means
    //behind (cloudier / underperforming). Hidden when the
    //predicted-at-now value is too small to give a stable ratio
    //(early morning, no forecast yet) or when the actual side
    //isn't ready yet.
    const nowMs           = Date.now();
    const predictedAtNow  = interpolateKwhAt(cum.predictedSamples, nowMs);
    const deltaPct        = predictedAtNow !== null && predictedAtNow > 0.2 && producedKwh > 0.05
        ? ((producedKwh - predictedAtNow) / predictedAtNow) * 100
        : null;


    //Distinguish "no data yet" from "no production yet". When a PV
    //entity is configured and the history hasn't returned yet,
    //show a skeleton in place of the produced value, so users
    //don't read a transient 0,0 kWh as fact. Once the fetch lands
    //(empty or not), we fall back to rendering the number.
    const pvConfigured = resolvePvLiveEntity(host._energyDefaults) !== '';
    const historyLoading = pvConfigured && host._pvHistory === null;

    //"Not started yet" hint: produced is effectively zero but the forecast knows a peak is still ahead. Avoids the confusing "0,0 kWh / 12,1 kWh
    //PRÉVU" reading by spelling out that the counter is idle, not broken.
    const notStartedYet =
        !historyLoading
     && producedKwh < 0.05
     && data.peakHourTs !== null
     && data.peakHourTs > Date.now();

    //Theme-aware "predicted" PV shade. Light theme = blend toward
    //BLACK (the otherwise washed-out amber on a white card was the
    //reported "illisible" symptom). Dark theme = blend toward WHITE
    //so the predicted curve and value still read as "lighter than
    //observed" on the dark plate.
    const isDarkTheme    = !!(host.hass as { themes?: { darkMode?: boolean } } | undefined)?.themes?.darkMode;
    const predictedColor = isDarkTheme
        ? lerpHexToward(pvColor, '#ffffff', 0.55)
        : lerpHexToward(pvColor, '#000000', 0.35);

    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    const todayDateLabel = formatDate(todayDate, host.hass);

    //Forecast calibration: surface the refined kWh as a SECOND
    //per-step integration that blends the per-(sun × cloud) shading-
    //map auto-learning with the scalar 5-day actual / predicted
    //ratio. Same recipe as the timeline day-strip chips, so the
    //dashboard headline and the in-card refined values match at
    //every scrub instant. Hidden when fewer than 2 past days
    //carried enough production to compute a stable ratio
    //(computeForecastCalibration returns null in that case).
    const calibration = computeForecastCalibration(host);
    const todayStartMs = (() => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    })();
    const todayEndMs   = todayStartMs + 86_400_000;
    const refinedForecastKwh = calibration !== null
        ? computeRefinedDailyKwh(host, todayStartMs, todayEndMs)
        : null;
    const refinedDeltaPct = calibration !== null && refinedForecastKwh !== null && forecastKwh > 0.05
        ? ((refinedForecastKwh - forecastKwh) / forecastKwh) * 100
        : null;
    const calibrationHint = calibration !== null
        ? t.detail.forecastCalibrationHint.replace('{n}', String(calibration.daysUsed))
        : '';

    //Count-up phase applied only to the headline figures so the rest of the panel (delta %, peak time, etc.) stays anchored on the
    //real values; sweeping the delta from 0 % up would read as confusing rather than animated.
    const phase                  = dashCountUpPhase(host);
    const producedKwhDisplay     = producedKwh * phase;
    const forecastKwhDisplay     = forecastKwh * phase;
    const refinedForecastDisplay = refinedForecastKwh !== null ? refinedForecastKwh * phase : null;

    return html`
        <section class="dash-section dash-card dash-today">
            <header class="dash-card-header">
                <ha-icon class="dash-card-icon" icon="mdi:weather-sunny" style="color:${sunColor}"></ha-icon>
                <span class="dash-card-label">${t.detail.todayLabel}</span>
                <span class="dash-card-date">(${todayDateLabel})</span>
            </header>
            <div class="dash-today-body">
                <div class="dash-today-headline">
                    <div class="dash-today-stat" style="color:${pvColor}">
                        ${historyLoading ? html`
                            <span class="dash-stat-skeleton" aria-hidden="true"></span>
                        ` : html`
                            <span class="dash-stat-value">${formatLocalisedNumber(host.hass, producedKwhDisplay, 1)}</span>
                            <span class="dash-stat-unit">kWh ${t.detail.todayProduced}</span>
                            ${deltaPct !== null ? html`
                                <span class="dash-stat-delta ${deltaPct >= 0 ? 'dash-stat-delta-up' : 'dash-stat-delta-down'}"
                                      data-tooltip="${t.detail.deltaTooltip}"
                                      aria-label="${t.detail.deltaTooltip}"
                                >
                                    (${deltaPct >= 0 ? '+' : ''}${formatLocalisedNumber(host.hass, deltaPct, 0, true)} %)
                                </span>
                            ` : nothing}
                        `}
                    </div>
                    ${forecastKwh > 0.05 ? html`
                        <div class="dash-today-stat dash-today-stat-predicted ${refinedForecastKwh !== null ? 'dash-today-stat-with-refined' : ''}" style="color:${predictedColor}">
                            <span class="dash-stat-main">
                                <span class="dash-stat-value">${formatLocalisedNumber(host.hass, forecastKwhDisplay, 1)}</span>
                                <span class="dash-stat-unit">kWh ${t.detail.todayForecast}</span>
                            </span>
                            ${refinedForecastDisplay !== null && refinedDeltaPct !== null ? html`
                                <span class="dash-stat-refined"
                                      data-tooltip="${calibrationHint}"
                                      aria-label="${calibrationHint}"
                                >
                                    → ${formatLocalisedNumber(host.hass, refinedForecastDisplay, 1)} kWh ${t.detail.forecastRefined}
                                    <span class="dash-stat-refined-pct ${refinedDeltaPct >= 0 ? 'dash-stat-refined-up' : 'dash-stat-refined-down'}">
                                        (${refinedDeltaPct >= 0 ? '+' : ''}${formatLocalisedNumber(host.hass, refinedDeltaPct, 0, true)} %)
                                    </span>
                                </span>
                            ` : nothing}
                        </div>
                    ` : nothing}
                </div>
                ${(showPeakActual || showPeakPredicted || notStartedYet) ? html`
                    <div class="dash-today-meta">
                        ${showPeakActual ? html`
                            <div class="dash-today-line dash-today-peak" style="color:${pvColor}">
                                <ha-icon icon="mdi:white-balance-sunny" style="color:${pvColor}"></ha-icon>
                                <span class="dash-line-label">${t.detail.todayPeak}</span>
                                <span class="dash-line-value">${peakActualTime} · ${peakActualValue}</span>
                            </div>
                        ` : notStartedYet ? html`
                            <div class="dash-today-line dash-today-peak dash-today-paused" style="color:${pvColor}">
                                <ha-icon icon="mdi:weather-night" style="color:${pvColor}"></ha-icon>
                                <span class="dash-line-value">${t.detail.todayNotStartedYet}</span>
                            </div>
                        ` : nothing}
                        ${showPeakPredicted ? html`
                            <div class="dash-today-line dash-today-peak" style="color:${predictedColor}">
                                <ha-icon icon="mdi:white-balance-sunny" style="color:${predictedColor}"></ha-icon>
                                <span class="dash-line-label">${t.detail.todayPeakForecast}</span>
                                <span class="dash-line-value">${peakPredictedTime} · ${peakPredictedValue}</span>
                            </div>
                        ` : nothing}
                    </div>
                ` : nothing}
                ${historyLoading ? nothing : renderDashTodayChart(host, pvColor, sunColor, cum)}
            </div>
        </section>
    `;
}


//Cumulative production sparkline for the today card. Hidden via
//a container query when the card isn't wide enough to render the
//curve without squashing it (see helios-card-css.ts). When the
//user hovers, a vertical guideline + travelling dot reveal a
//tooltip showing the cumulative kWh at that exact minute.
export function renderDashTodayChart(
    host:     DashboardHost,
    pvColor:  string,
    sunColor: string,
    cum:      ReturnType<typeof computeTodayCumulative>
): TemplateResult | typeof nothing
{
    if (cum.maxKwh < 0.05)
    {
        return nothing;
    }

    const t = pickTranslations(host.hass?.language);

    const HOUR_MS  = 3_600_000;
    const today0   = new Date();
    today0.setHours(0, 0, 0, 0);
    const tomorrow0 = new Date(today0);
    tomorrow0.setDate(tomorrow0.getDate() + 1);
    const startMs  = today0.getTime();
    const endMs    = tomorrow0.getTime();
    const nowMs    = Date.now();

    //SVG viewBox with preserveAspectRatio="none". Curves stretch
    //to fill the rendered chart, stroke widths stay constant via
    //vector-effect:non-scaling-stroke. Padding leaves a clear
    //gutter on the left (kWh labels) and below (hour labels) so
    //the HTML axis overlays never overlap the plotted curves.
    const W = 240, H = 60;
    const PAD_L = 22, PAD_R = 4, PAD_T = 12, PAD_B = 10;
    const yMax  = Math.max(cum.maxKwh, 0.1) * 1.05;

    const xFor = (t: number): number =>
        PAD_L + ((t - startMs) / (endMs - startMs)) * (W - PAD_L - PAD_R);
    const yFor = (kwh: number): number =>
        H - PAD_B - (kwh / yMax) * (H - PAD_T - PAD_B);

    const buildPath = (pts: Array<{ tMs: number; kwh: number }>): string =>
    {
        if (pts.length < 2)
        {
            return '';
        }
        return 'M ' + pts.map(p =>
            `${xFor(p.tMs).toFixed(2)} ${yFor(p.kwh).toFixed(2)}`
        ).join(' L ');
    };

    const actualPath    = buildPath(cum.actualSamples);
    const predictedPath = buildPath(cum.predictedSamples);
    //Theme-aware "predicted" PV shade. Light theme = blend toward
    //BLACK (the otherwise washed-out amber on a white card was the
    //reported "illisible" symptom). Dark theme = blend toward WHITE
    //so the predicted curve and value still read as "lighter than
    //observed" on the dark plate.
    const isDarkTheme    = !!(host.hass as { themes?: { darkMode?: boolean } } | undefined)?.themes?.darkMode;
    const predictedColor = isDarkTheme
        ? lerpHexToward(pvColor, '#ffffff', 0.55)
        : lerpHexToward(pvColor, '#000000', 0.35);

    //Hour gridlines + labels at 6 h intervals. 4 ticks (0/6/12/18)
    //read as the natural "morning / noon / afternoon / evening"
    //markers; the right edge (24 h) is implicit, no label needed.
    const hourTicks = [0, 6, 12, 18];

    //Y-axis ticks: round the visible kWh range to a "nice" step so
    //the labels read as round values (e.g. 0 / 5 / 10 / 15) instead
    //of arbitrary fractions of yMax. niceStep picks 1, 2, 5 or 10
    //times the appropriate power of ten so we never exceed ~5
    //ticks on a tall chart.
    const niceStep = (range: number): number =>
    {
        if (range <= 0)
        {
            return 1;
        }
        const target = range / 4;
        const pow    = Math.pow(10, Math.floor(Math.log10(target)));
        const ratio  = target / pow;
        const step   = ratio < 1.5 ? 1 : ratio < 3 ? 2 : ratio < 7 ? 5 : 10;
        return step * pow;
    };
    const yStep   = niceStep(yMax);
    const kwhTicks: number[] = [];
    for (let v = 0; v <= yMax + 1e-9; v += yStep)
    {
        kwhTicks.push(v);
    }

    //Sunrise / sunset markers from the engine's projected sun scene. Only render the ones that fall inside today's window, the projection may carry
    //"yesterday's sunset" or "tomorrow's sunrise" when the scrub time is near a midnight boundary.
    const sunriseMs = host._sunScene?.sunrise?.time?.getTime() ?? null;
    const sunsetMs  = host._sunScene?.sunset?.time?.getTime()  ?? null;
    const showSunrise = sunriseMs !== null && sunriseMs >= startMs && sunriseMs < endMs;
    const showSunset  = sunsetMs  !== null && sunsetMs  >= startMs && sunsetMs  < endMs;

    const hoverTs = host._dashChartHoverTs;
    let hoverActualKwh:    number | null = null;
    let hoverPredictedKwh: number | null = null;
    let hoverX:           number = 0;
    let hoverFracX:       number = 0;
    let hoverTimeLabel:   string = '';
    if (hoverTs !== null && hoverTs >= startMs && hoverTs < endMs)
    {
        hoverActualKwh    = interpolateKwhAt(cum.actualSamples,    hoverTs);
        hoverPredictedKwh = interpolateKwhAt(cum.predictedSamples, hoverTs);
        hoverX            = xFor(hoverTs);
        hoverFracX        = (hoverX / W) * 100;
        hoverTimeLabel    = new Intl.DateTimeFormat((host.hass?.language as string | undefined) || undefined, {
            hour: '2-digit', minute: '2-digit',
        }).format(new Date(hoverTs));
    }
    const showHover = hoverActualKwh !== null || hoverPredictedKwh !== null;

    //Smart tooltip position: anchor on the actual data point when
    //available (it's the primary reading), fall back to predicted
    //otherwise. If the anchor sits in the lower half of the chart
    //(yFor returns large Y values for low kWh, near the bottom)
    //float the tooltip above the cursor so it doesn't cover the
    //curves rising above. If the anchor is in the upper half,
    //drop the tooltip below the cursor so it doesn't cover the
    //curves below.
    const referenceKwh = hoverActualKwh ?? hoverPredictedKwh;
    const referenceY   = referenceKwh !== null ? yFor(referenceKwh) : H / 2;
    const referenceYPct = (referenceY / H) * 100;
    const tooltipBelow = referenceY <= H / 2;

    //Unique clip-path id per instance so two cards on the same
    //dashboard don't share a single rect (and one card's animation
    //don't bleed into the other's).
    const clipId  = `dash-today-chart-reveal-${host._instanceId}`;
    //Unique pattern id for the night-zone hatch overlay. Same per-instance scope as the clip-path so siblings don't collide.
    const hatchId = `dash-today-chart-night-${host._instanceId}`;

    //Night hatch: the regions before sunrise and after sunset get a
    //subtle diagonal hatch instead of the previous vertical twilight
    //lines + sun-up/sun-down glyphs. Same visual vocabulary as the
    //timeline's .hc-night-zone overlay, kept inside the SVG via
    //`<pattern>` because the dashboard chart is rendered at native
    //size (no MapLibre downscale) so a stretched pattern still reads
    //as a clean diagonal. The hatch is bound to the plotted area
    //[PAD_L .. W-PAD_R] × [PAD_T .. H-PAD_B] so it doesn't bleed
    //into the kWh / hour axis labels around the chart frame.
    const nightLeftEnd    = showSunrise ? xFor(sunriseMs!) : null;
    const nightRightStart = showSunset  ? xFor(sunsetMs!)  : null;

    return html`
        <div class="dash-today-chart">
            <svg class="dash-today-chart-svg"
                 viewBox="0 0 ${W} ${H}"
                 preserveAspectRatio="none"
                 @pointermove="${(e: PointerEvent) => handleDashChartPointerMove(host, e)}"
                 @pointerleave="${() => handleDashChartPointerLeave(host)}"
            >
                <defs>
                    <clipPath id="${clipId}">
                        <rect class="dash-today-chart-reveal-rect"
                              x="0" y="0"
                              width="${W}" height="${H}"/>
                    </clipPath>
                    <!--  Diagonal night-zone hatch. Tiled at 6 px in
                          viewBox units, rotated 45°. Pattern stays
                          tile-aligned regardless of the chart's pre-
                          serveAspectRatio because the SVG renders at
                          near-native size in the dashboard. Dark-mode
                          stroke is set via the .dash-today-chart-
                          night CSS class on the line element below.   -->
                    <pattern id="${hatchId}"
                             patternUnits="userSpaceOnUse"
                             width="6" height="6"
                             patternTransform="rotate(45)">
                        <line class="dash-today-chart-night"
                              x1="0" y1="0" x2="0" y2="6"
                              stroke-width="1.5"/>
                    </pattern>
                </defs>
                <!--  Night zones: pre-dawn rect from the plot's left
                      edge to sunrise, and post-dusk rect from sunset
                      to the plot's right edge. Skipped on polar days
                      where the sun never crosses the horizon (showSun
                      flags stay false).                               -->
                ${nightLeftEnd !== null && nightLeftEnd > PAD_L ? svg`
                    <rect
                        x="${PAD_L.toFixed(2)}"
                        y="${PAD_T.toFixed(2)}"
                        width="${(nightLeftEnd - PAD_L).toFixed(2)}"
                        height="${(H - PAD_T - PAD_B).toFixed(2)}"
                        fill="url(#${hatchId})"
                    ></rect>
                ` : nothing}
                ${nightRightStart !== null && nightRightStart < W - PAD_R ? svg`
                    <rect
                        x="${nightRightStart.toFixed(2)}"
                        y="${PAD_T.toFixed(2)}"
                        width="${(W - PAD_R - nightRightStart).toFixed(2)}"
                        height="${(H - PAD_T - PAD_B).toFixed(2)}"
                        fill="url(#${hatchId})"
                    ></rect>
                ` : nothing}
                <!--  Dotted vertical lines at the sunrise / sunset
                      X positions, matching the timeline's day-
                      separator look (.hc-day-sep). Acts as a clear
                      day/night boundary on top of the softer hatch
                      shading. Dark + light themes pick up their
                      stroke colour from .dash-today-chart-twilight
                      below, same alpha as the hc-day-sep on the
                      main chart.                                    -->
                ${nightLeftEnd !== null ? svg`
                    <line
                        class="dash-today-chart-twilight"
                        x1="${nightLeftEnd.toFixed(2)}"
                        y1="${PAD_T.toFixed(2)}"
                        x2="${nightLeftEnd.toFixed(2)}"
                        y2="${(H - PAD_B).toFixed(2)}"
                    ></line>
                ` : nothing}
                ${nightRightStart !== null ? svg`
                    <line
                        class="dash-today-chart-twilight"
                        x1="${nightRightStart.toFixed(2)}"
                        y1="${PAD_T.toFixed(2)}"
                        x2="${nightRightStart.toFixed(2)}"
                        y2="${(H - PAD_B).toFixed(2)}"
                    ></line>
                ` : nothing}
                ${kwhTicks.map(v => svg`
                    <line class="dash-today-chart-grid"
                          x1="${PAD_L}"     y1="${yFor(v).toFixed(2)}"
                          x2="${W - PAD_R}" y2="${yFor(v).toFixed(2)}"/>
                `)}
                ${hourTicks.map(h => {
                    const tMs = startMs + h * HOUR_MS;
                    const x = xFor(tMs);
                    return svg`
                        <line class="dash-today-chart-grid"
                              x1="${x.toFixed(2)}" y1="${PAD_T}"
                              x2="${x.toFixed(2)}" y2="${H - PAD_B}"/>
                    `;
                })}
                <g clip-path="url(#${clipId})">
                    ${predictedPath !== '' ? svg`
                        <path class="dash-today-chart-predicted"
                              d="${predictedPath}"
                              stroke="${predictedColor}"/>
                    ` : nothing}
                    ${actualPath !== '' ? svg`
                        <path class="dash-today-chart-actual"
                              d="${actualPath}"
                              stroke="${pvColor}"/>
                    ` : nothing}
                </g>
                ${nowMs >= startMs && nowMs < endMs ? svg`
                    <line class="dash-today-chart-now"
                          x1="${xFor(nowMs).toFixed(2)}" x2="${xFor(nowMs).toFixed(2)}"
                          y1="${PAD_T}" y2="${H - PAD_B}"
                          stroke="${sunColor}"/>
                ` : nothing}
                ${showHover ? svg`
                    <line class="dash-today-chart-hover-line"
                          x1="${hoverX.toFixed(2)}" x2="${hoverX.toFixed(2)}"
                          y1="${PAD_T}" y2="${H - PAD_B}"/>
                ` : nothing}
            </svg>
            ${hoverPredictedKwh !== null ? html`
                <div class="dash-today-chart-hover-dot"
                     style="left: ${(hoverX / W * 100).toFixed(2)}%; top: ${(yFor(hoverPredictedKwh) / H * 100).toFixed(2)}%; background: ${predictedColor};"
                ></div>
            ` : nothing}
            ${hoverActualKwh !== null ? html`
                <div class="dash-today-chart-hover-dot"
                     style="left: ${(hoverX / W * 100).toFixed(2)}%; top: ${(yFor(hoverActualKwh) / H * 100).toFixed(2)}%; background: ${pvColor};"
                ></div>
            ` : nothing}
            <div class="dash-today-chart-axis-x">
                ${hourTicks.map(h => html`
                    <span class="dash-today-chart-axis-x-label"
                          style="left: ${((PAD_L + (h / 24) * (W - PAD_L - PAD_R)) / W * 100).toFixed(2)}%;"
                    >${String(h).padStart(2, '0')}h</span>
                `)}
            </div>
            <div class="dash-today-chart-axis-y">
                ${kwhTicks.map(v => html`
                    <span class="dash-today-chart-axis-y-label"
                          style="top: ${(yFor(v) / H * 100).toFixed(2)}%;"
                    >${formatLocalisedNumber(host.hass, v, yStep < 1 ? 1 : 0)}</span>
                `)}
            </div>
            <!--  Twilight ha-icon glyphs (sunrise / sunset) used to
                  sit here; they were replaced by the night-zone
                  diagonal hatch rendered inside the SVG above.
                  Same visual vocabulary as the timeline's
                  .hc-night-zone overlay, and the hatch communicates
                  "this slice is night" without competing with the
                  PV curve for the user's attention.                   -->

            ${showHover ? html`
                <div class="dash-today-chart-tooltip dash-today-chart-tooltip-${tooltipBelow ? 'below' : 'above'}"
                     style="left: ${hoverFracX.toFixed(2)}%; top: ${referenceYPct.toFixed(2)}%;"
                >
                    <span class="dash-today-chart-tooltip-time">${hoverTimeLabel}</span>
                    ${hoverActualKwh !== null ? html`
                        <span class="dash-today-chart-tooltip-row">
                            <span class="dash-today-chart-tooltip-key" style="color:${pvColor}">${t.detail.actualShort}:</span>
                            <span class="dash-today-chart-tooltip-value">${formatLocalisedNumber(host.hass, hoverActualKwh, 1)} kWh</span>
                        </span>
                    ` : nothing}
                    ${hoverPredictedKwh !== null ? html`
                        <span class="dash-today-chart-tooltip-row">
                            <span class="dash-today-chart-tooltip-key" style="color:${predictedColor}">${t.detail.forecastShort}:</span>
                            <span class="dash-today-chart-tooltip-value">${formatLocalisedNumber(host.hass, hoverPredictedKwh, 1)} kWh</span>
                        </span>
                    ` : nothing}
                </div>
            ` : nothing}
        </div>
    `;
}


//Helper: format a wattage value as a short label (W or kW).
export function formatPvWatts(hass: any, w: number): string
{
    if (!isFinite(w) || w < 0)
    {
        return formatLocalisedNumber(hass, 0, 0, true) + ' W';
    }
    if (w >= 1000)
    {
        return formatLocalisedNumber(hass, w / 1000, 2) + ' kW';
    }
    return formatLocalisedNumber(hass, Math.round(w), 0, true) + ' W';
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
    const tomorrow0 = new Date(today0);
    tomorrow0.setDate(tomorrow0.getDate() + 1);
    const dayAfter0 = new Date(tomorrow0);
    dayAfter0.setDate(dayAfter0.getDate() + 1);
    const tomorrowMs = tomorrow0.getTime();
    const endMs      = dayAfter0.getTime();

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
        const raster = host._engine?.getLidarRaster() ?? null;
        const capW   = pvInverterMaxW(host.config);
        for (let i = 0; i < series.times.length; i++)
        {
            const tMs = series.times[i].getTime();
            if (tMs < tomorrowMs || tMs >= endMs)
            {
                continue;
            }
            const cloud = series.cloud[i] ?? 0;
            const pct   = computePvPowerWeighted(host.config, series.times[i], coords.lat, coords.lon, cloud, {
                airTempC: series.temperature[i],
                windMs:   series.windSpeed[i],
                raster,
            });
            if (pct > 0 && k !== null)
            {
                const watts = Math.min(capW, pct * k);
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
    pvColor:   string
): TemplateResult
{
    const data = computeTomorrow(host);
    const HOUR_MS = 3_600_000;

    const peakTimeLabel = data.peakHourTs !== null
        ? new Intl.DateTimeFormat((host.hass?.language as string | undefined) || undefined, {
            hour: '2-digit', minute: '2-digit',
        }).format(new Date(data.peakHourTs + HOUR_MS / 2))
        : '';

    //Tomorrow is a pure forecast so its big stat uses the same lighter PV shade as the today section's "prévu" value, so the user reads both at a
    //glance as "predicted production" without having to re-parse the label.
    //Theme-aware "predicted" PV shade. Light theme = blend toward
    //BLACK (the otherwise washed-out amber on a white card was the
    //reported "illisible" symptom). Dark theme = blend toward WHITE
    //so the predicted curve and value still read as "lighter than
    //observed" on the dark plate.
    const isDarkTheme    = !!(host.hass as { themes?: { darkMode?: boolean } } | undefined)?.themes?.darkMode;
    const predictedColor = isDarkTheme
        ? lerpHexToward(pvColor, '#ffffff', 0.55)
        : lerpHexToward(pvColor, '#000000', 0.35);

    const tomorrowDate = new Date();
    tomorrowDate.setHours(0, 0, 0, 0);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowDateLabel = formatDate(tomorrowDate, host.hass);

    //Same per-(sun × cloud) blended ratio we apply on the today
    //card, surfaced under the tomorrow stat too so the user sees a
    //refined estimate in both places. Walks the chart series across
    //tomorrow's 24 h window, multiplies each model output by the
    //shading-map auto-learned ratio (when confident) and falls back
    //to the scalar 5-day calibration otherwise. Hidden when
    //calibration isn't available (no kWp, no history, < 2 valid
    //past days).
    const calibration = computeForecastCalibration(host);
    const tomorrowStartMs = (() => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + 1);
        return d.getTime();
    })();
    const tomorrowEndMs   = tomorrowStartMs + 86_400_000;
    const refinedTotalKwh = calibration !== null
        ? computeRefinedDailyKwh(host, tomorrowStartMs, tomorrowEndMs)
        : null;
    const refinedDeltaPct = calibration !== null && refinedTotalKwh !== null && data.totalKwh > 0.05
        ? ((refinedTotalKwh - data.totalKwh) / data.totalKwh) * 100
        : null;
    const calibrationHint = calibration !== null
        ? t.detail.forecastCalibrationHint.replace('{n}', String(calibration.daysUsed))
        : '';

    return html`
        <section class="dash-section dash-card dash-tomorrow">
            <header class="dash-card-header">
                <ha-icon class="dash-card-icon" icon="mdi:weather-partly-cloudy" style="color:${sunColor}"></ha-icon>
                <span class="dash-card-label">${t.detail.tomorrowLabel}</span>
                <span class="dash-card-date">(${tomorrowDateLabel})</span>
            </header>
            <div class="dash-today-headline">
                <div class="dash-today-stat dash-today-stat-predicted ${refinedTotalKwh !== null ? 'dash-today-stat-with-refined' : ''}" style="color:${predictedColor}">
                    <span class="dash-stat-main">
                        <span class="dash-stat-value">≈ ${formatLocalisedNumber(host.hass, data.totalKwh, 1)}</span>
                        <span class="dash-stat-unit">kWh ${t.detail.todayForecast}</span>
                    </span>
                    ${refinedTotalKwh !== null && refinedDeltaPct !== null ? html`
                        <span class="dash-stat-refined"
                              data-tooltip="${calibrationHint}"
                              aria-label="${calibrationHint}"
                        >
                            → ${formatLocalisedNumber(host.hass, refinedTotalKwh, 1)} kWh ${t.detail.forecastRefined}
                            <span class="dash-stat-refined-pct ${refinedDeltaPct >= 0 ? 'dash-stat-refined-up' : 'dash-stat-refined-down'}">
                                (${refinedDeltaPct >= 0 ? '+' : ''}${formatLocalisedNumber(host.hass, refinedDeltaPct, 0, true)} %)
                            </span>
                        </span>
                    ` : nothing}
                </div>
            </div>
            ${data.peakHourTs !== null ? html`
                <div class="dash-today-meta">
                    <div class="dash-today-line dash-tomorrow-peak">
                        <ha-icon icon="mdi:white-balance-sunny" style="color:${sunColor}"></ha-icon>
                        <span class="dash-line-label">${t.detail.tomorrowPeak}</span>
                        <span class="dash-line-value">${peakTimeLabel}</span>
                    </div>
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

    //Vessel canvas: 200 × 240, drawn as a stylised vertical Compact vessel for the chip-card layout. The battery cap + cell are drawn relative to the
    //SVG viewBox and scale with the card width via CSS.
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
                        //Battery cap drawn as an open path: top + two sides, no bottom edge. The shell rect just below provides the shared horizontal
                        //line, so we avoid the two strokes stacking and showing as a double thickness at the join.
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
    //Stop propagation so the underlying map doesn't also process the click as a pan / drag start, and so nested overlay layers don't double-handle
    //it.
    e.stopPropagation();
    if (host._detailMode) { return; }
    //Clear the hover flag immediately, the hitbox un-renders
    //once detail mode opens so mouseleave never fires; without
    //this the glow would flash back on as soon as the user
    //exits detail mode and the hitbox re-appears.
    host._homeHover  = false;
    host._detailMode = true;
    host._dashOpenedAtMs = performance.now();
    host._engine?.setDetailMode(true);
    startDashCountUpLoop(host);
}


export function handleExitDetail(host: DashboardHost, e: Event): void
{
    e.stopPropagation();
    if (!host._detailMode) { return; }
    host._detailMode = false;
    host._dashOpenedAtMs = null;
    if (host._dashCountUpRaf !== undefined)
    {
        cancelAnimationFrame(host._dashCountUpRaf);
        host._dashCountUpRaf = undefined;
    }
    host._engine?.setDetailMode(false);
}


//rAF loop that re-renders the dashboard for the COUNT_UP_MS window so the headline kWh figures animate from 0 to their final value.
//Self-terminates once the phase saturates at 1 OR the panel closes. Called from handleHomeClick; safe to call again mid-window because
//the rAF token guard short-circuits.
function startDashCountUpLoop(host: DashboardHost): void
{
    if (host._dashCountUpRaf !== undefined)
    {
        return;
    }
    const tick = (): void =>
    {
        if (!host._detailMode || host._dashOpenedAtMs === null)
        {
            host._dashCountUpRaf = undefined;
            return;
        }
        (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
        if (dashCountUpPhase(host) >= 1)
        {
            host._dashCountUpRaf = undefined;
            return;
        }
        host._dashCountUpRaf = requestAnimationFrame(tick);
    };
    host._dashCountUpRaf = requestAnimationFrame(tick);
}


//Hover handlers on the today chart sparkline. Update the hover
//timestamp on move; clear it on leave so the tooltip + cursor
//disappear cleanly when the pointer exits the SVG.
//
//Padding constants must mirror the asymmetric layout used by the
//chart renderer (PAD_L = 22 leaves room for the Y-axis labels,
//PAD_R = 4 is just visual breathing room on the right). Using a
//symmetric PAD_X here would offset the time mapping by ~18 px on
//the left edge, the cursor would land in the middle of the
//morning hours when the mouse is on midnight. Reported as bug
export function handleDashChartPointerMove(host: DashboardHost, e: PointerEvent): void
{
    const svgEl = e.currentTarget as SVGSVGElement | null;
    if (!svgEl)
    {
        return;
    }
    const rect = svgEl.getBoundingClientRect();
    if (rect.width <= 0)
    {
        return;
    }
    const W = 240, PAD_L = 22, PAD_R = 4;
    const fracPx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const xLogical = fracPx * W;
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);
    const startMs = today0.getTime();
    const endMs   = startMs + 24 * 3_600_000;
    const tFrac = (xLogical - PAD_L) / (W - PAD_L - PAD_R);
    host._dashChartHoverTs = startMs
        + Math.max(0, Math.min(1, tFrac)) * (endMs - startMs);
}


export function handleDashChartPointerLeave(host: DashboardHost): void
{
    host._dashChartHoverTs = null;
}
