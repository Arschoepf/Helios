//Timeline chart rendering: the two SVG cards that sit under the
//map, the timeline cursors that scrub across them, and the per-day
//kWh aggregation used by the day chips.
//
//Pure templates: each function takes a structural `ChartHost`
//(the card) and returns a Lit `TemplateResult` or a derived
//value. State mutations live elsewhere; charts only read.

import { html, svg, nothing, TemplateResult } from 'lit';
import
{
    type HeliosConfig,
    DEFAULT_SUN_COLOR_HEX,
    DEFAULT_CLOUD_COLOR_HEX,
    DEFAULT_PV_COLOR_HEX
} from '../helios-config';
import { cfgHex, formatDate, formatLocalisedNumber } from './format';
import
{
    pvCalibK,
    pvNormalizeToWatts,
    computePvPowerWeighted,
    type PvHistory
} from './pv';
import { timelineConsumptionEnabled } from './timeline';
import { getHomeCoords } from './init';


//Engine-resampled weather series. Same shape the engine snapshots
//and pushes to the card on every refresh.
export interface ChartSeries
{
    times:        Date[];
    irradiance:   number[];
    cloud:        number[];
    //Hourly ambient temperature (°C) and 10-metre wind speed (m/s).
    //NaN where the model didn't supply a value. Consumers that
    //don't care about thermal derating ignore these fields.
    temperature:  number[];
    windSpeed:    number[];
}

//Structural surface the host card exposes to this module. All
//fields read-only: the chart layer never mutates card state.
export interface ChartHost
{
    readonly config:        HeliosConfig | undefined;
    readonly hass:          any;
    readonly _timeRange:    { start: Date; end: Date } | null;
    readonly _chartSeries:  ChartSeries | null;
    readonly _pvHistory:    PvHistory | null;
    readonly _pvUnit:       string;
    readonly _selectedTime: Date | null;
    readonly _isLiveMode:   boolean;
    //Exposed so the PV predictor inside the chart layer can pull
    //the loaded LiDAR raster for the per-array shading raycast.
    //Optional because the chart still renders fine without the
    //engine reference (shading just falls back to "no obstacle").
    readonly _engine?:      { getLidarRaster(): import('../engine/pv-shading').NdsmRaster | null };
}


//Two-half "sun vs cloud" SVG chart that sits above the timeline:
//  - top half: irradiance W/m² (0..1000 W/m²), filled with the
//    configured sun colour.
//  - bottom half: cloud cover %, "the clouds press down". Filled
//    with the configured cloud colour, mirrored gradient.
//
//The metaphor maps the user's mental model: when the sun pushes
//past what the clouds press in, production is high; when the
//clouds reach further than the sun's push, production is low.
//The two areas inhabit non-overlapping pixel rows, so we never
//have to worry about z-order or transparency stacking.
export function renderChart(host: ChartHost): TemplateResult
{
    const series = host._chartSeries;
    const range  = host._timeRange;
    if (!series || !range || series.times.length < 2)
    {
        return html`<svg class="hc-chart-svg" viewBox="0 0 1000 100" preserveAspectRatio="none"></svg>`;
    }

    const W      = 1000;
    const H      = 100;
    //Midline sits exactly halfway. The two halves get H/2 = 50
    //pixels of vertical resolution each, enough to read the
    //shape of a typical day at a glance.
    const MID    = H / 2;
    const HALF   = H / 2;

    const startMs = range.start.getTime();
    const rangeMs = range.end.getTime() - startMs;
    if (rangeMs <= 0)
    {
        return html`<svg class="hc-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"></svg>`;
    }

    const xOf = (t: Date): number =>
        ((t.getTime() - startMs) / rangeMs) * W;

    //Top area Y: 0 W/m² sits on the midline, 1000 W/m² sits at
    //the top edge of the SVG. Anything above clamps to the top.
    const yIrr = (w: number): number =>
        MID - Math.max(0, Math.min(1, w / 1000)) * HALF;

    //Bottom area Y: 0 % sits on the midline, 100 % sits at the
    //bottom edge. Pure linear (cloud cover is already 0..100).
    const yCloud = (pct: number): number =>
        MID + Math.max(0, Math.min(1, pct / 100)) * HALF;

    const irrPoints = series.times.map((t, i) =>
        `${xOf(t).toFixed(2)},${yIrr(series.irradiance[i] ?? 0).toFixed(2)}`);
    const cloudPoints = series.times.map((t, i) =>
        `${xOf(t).toFixed(2)},${yCloud(series.cloud[i] ?? 0).toFixed(2)}`);

    //Both areas close back to the midline (not the SVG edge),
    //so each half stays anchored to its own baseline.
    const x0 = xOf(series.times[0]);
    const xN = xOf(series.times[series.times.length - 1]);
    const irrArea = `M ${x0},${MID} L ${irrPoints.join(' L ')} L ${xN},${MID} Z`;
    const cloudArea = `M ${x0},${MID} L ${cloudPoints.join(' L ')} L ${xN},${MID} Z`;

    //Stroke-only paths layered on top of the filled areas to
    //accentuate the curve outline. Same point sequence as the
    //areas, minus the closing segment back to the midline so
    //we don't draw a horizontal line across the baseline.
    const irrLine   = `M ${irrPoints.join(' L ')}`;
    const cloudLine = `M ${cloudPoints.join(' L ')}`;

    const sunColor   = cfgHex(host.config?.['sun-color'],   DEFAULT_SUN_COLOR_HEX);
    const cloudColor = cfgHex(host.config?.['cloud-color'], DEFAULT_CLOUD_COLOR_HEX);

    //Day-boundary X positions in viewBox units (midnight of each
    //local day inside the time range). Drawn as faint dotted
    //vertical lines spanning the full chart height, same role
    //as the day chips on the midline, just visual separators.
    const startMsAbs = range.start.getTime();
    const endMsAbs   = range.end.getTime();
    const dayXs: number[] = [];
    const dCursor = new Date(range.start);
    dCursor.setHours(0, 0, 0, 0);
    while (dCursor.getTime() <= endMsAbs)
    {
        const next = new Date(dCursor);
        next.setDate(next.getDate() + 1);
        if (dCursor.getTime() > startMsAbs && dCursor.getTime() < endMsAbs)
        {
            dayXs.push(xOf(dCursor));
        }
        dCursor.setTime(next.getTime());
    }

    //Hour-boundary X positions, used to draw small vertical
    //ticks centred on the midline (one per hour). Midnights are
    //skipped, those already get a full-height day separator.
    const hourXs: number[] = [];
    const hCursor = new Date(range.start);
    hCursor.setMinutes(0, 0, 0);
    hCursor.setHours(hCursor.getHours() + 1);
    while (hCursor.getTime() <= endMsAbs)
    {
        if (hCursor.getTime() > startMsAbs && hCursor.getHours() !== 0)
        {
            hourXs.push(xOf(hCursor));
        }
        hCursor.setHours(hCursor.getHours() + 1);
    }
    const HOUR_TICK_HALF = 3;

    return html`
        <svg
            class="hc-chart-svg"
            viewBox="0 0 ${W} ${H}"
            preserveAspectRatio="none"
        >
            <path
                d="${irrArea}"
                fill="${sunColor}"
                fill-opacity="0.5"
            ></path>
            <path
                d="${cloudArea}"
                fill="${cloudColor}"
                fill-opacity="0.5"
            ></path>
            <path
                class="hc-chart-line"
                d="${irrLine}"
                stroke="${sunColor}"
            ></path>
            <path
                class="hc-chart-line"
                d="${cloudLine}"
                stroke="${cloudColor}"
            ></path>
            ${dayXs.map(x => svg`
                <line
                    class="hc-day-sep"
                    x1="${x.toFixed(2)}" y1="0"
                    x2="${x.toFixed(2)}" y2="${H}"
                ></line>
            `)}
            <line
                class="hc-chart-mid"
                x1="0" y1="${MID}"
                x2="${W}" y2="${MID}"
            ></line>
            ${hourXs.map(x => svg`
                <line
                    class="hc-hour-tick"
                    x1="${x.toFixed(2)}" y1="${MID - HOUR_TICK_HALF}"
                    x2="${x.toFixed(2)}" y2="${MID + HOUR_TICK_HALF}"
                ></line>
            `)}
        </svg>
    `;
}


//Render the optional photovoltaic production graph that sits
//above the main timeline chart. Same X axis as the main chart
//(time range pulled from host._timeRange) so day boundaries and
//the scrub cursor line up vertically across both blocks. The
//curve is plotted from host._pvHistory (fetched via the HA
//history WebSocket command); future data is intentionally left
//blank, the curve naturally stops at the last recorded sample
//since there's no production data after "now".
export function renderPvChart(host: ChartHost): TemplateResult
{
    const range = host._timeRange;
    const hist  = host._pvHistory;
    const W     = 1000;
    const H     = 100;

    if (!range)
    {
        return html`<svg class="hc-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"></svg>`;
    }

    const startMs = range.start.getTime();
    const rangeMs = range.end.getTime() - startMs;
    if (rangeMs <= 0)
    {
        return html`<svg class="hc-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"></svg>`;
    }

    const pvColor = cfgHex(host.config?.['pv-color'], DEFAULT_PV_COLOR_HEX);

    //Day-boundary X positions, same computation as the main
    //chart so the dotted separators line up across the two.
    const endMsAbs = range.end.getTime();
    const dayXs: number[] = [];
    const dCursor = new Date(range.start);
    dCursor.setHours(0, 0, 0, 0);
    while (dCursor.getTime() <= endMsAbs)
    {
        const next = new Date(dCursor);
        next.setDate(next.getDate() + 1);
        if (dCursor.getTime() > startMs && dCursor.getTime() < endMsAbs)
        {
            dayXs.push(((dCursor.getTime() - startMs) / rangeMs) * W);
        }
        dCursor.setTime(next.getTime());
    }

    //If we have no history yet, render the empty frame (axis
    //grid + day separators) so the graph card never looks
    //"broken" while data is being fetched.
    //
    //If the entity reports a cumulative energy (Wh / kWh / MWh)
    //we differentiate it into a power-rate series so the curve
    //reflects production at each instant rather than the
    //ever-climbing daily total. The user said it best: "produc-
    //tion par minute, pas totale". Negative deltas (a daily
    //"energy today" sensor flipping back to 0 at midnight) are
    //treated as resets and dropped, and abnormally large gaps
    //are skipped to avoid smearing one big jump across an hour
    //of empty time.
    const lu = (host._pvUnit || '').toLowerCase();
    const isCumulativeEnergy = lu === 'wh' || lu === 'kwh' || lu === 'mwh';

    let rawTimes:  Date[]   = hist?.times  ?? [];
    let rawValues: number[] = hist?.values ?? [];

    if (isCumulativeEnergy && rawTimes.length >= 2)
    {
        //Quantization fix: cumulative-energy sensors typically
        //report integer Wh, so two samples a few seconds apart
        //look like "0 then 1 Wh delta over 10 s", which divides
        //to a fake 360 W spike when the true rate is closer to
        //100 W. Hold the previous anchor until at least MIN_DTH
        //of clock time has accumulated so dv / dtH averages over
        //a window where quantization is negligible. Skip samples
        //before that, don't advance the anchor, so the next
        //iteration compares against the same baseline.
        const MIN_DTH = 0.05;   //3 minutes
        const dTimes:  Date[]   = [];
        const dValues: number[] = [];
        let prevIdx = 0;
        for (let i = 1; i < rawTimes.length; i++)
        {
            const dtH = (rawTimes[i].getTime() - rawTimes[prevIdx].getTime()) / 3_600_000;
            if (dtH <= 0)
            {
                continue;
            }
            if (dtH > 6)
            {
                //Sensor outage, abandon this anchor and start a
                //fresh one at the current sample.
                prevIdx = i;
                continue;
            }
            const dv = rawValues[i] - rawValues[prevIdx];
            if (dv < 0)
            {
                //Counter reset (typical for "energy today"
                //sensors that zero out at midnight). Reset the
                //anchor to the new low value.
                prevIdx = i;
                continue;
            }
            if (dtH < MIN_DTH)
            {
                continue;
            }
            dTimes.push(rawTimes[i]);
            dValues.push(dv / dtH);
            prevIdx = i;
        }
        rawTimes  = dTimes;
        rawValues = dValues;
    }

    const samples: Array<{ t: Date; v: number }> = [];
    for (let i = 0; i < rawTimes.length; i++)
    {
        const t = rawTimes[i];
        const v = rawValues[i];
        if (t.getTime() < startMs || t.getTime() > endMsAbs)
        {
            continue;
        }
        if (!isFinite(v))
        {
            continue;
        }
        samples.push({ t, v });
    }

    const xOf = (t: Date): number =>
        ((t.getTime() - startMs) / rangeMs) * W;

    //Observed samples are in the entity's native power unit
    //(kW / W / MW for a power entity, or differentiated to that
    //unit / hour for a cumulative-energy entity). Calibration k
    //is "W per percent of STC", so a raw `pct * k` predicted
    //value is in WATTS. Mixing units on the same Y axis would
    //flatten the observed curve into invisibility when the
    //entity is in kW and the predicted is in W (yMax pegged to
    //thousands while observed sits at single digits). Compute
    //the W → native scale once and apply it to the predicted
    //series so both feed yMax on the same axis.
    const nativeFromW = (() => {
        const native = isCumulativeEnergy
            ? (lu === 'kwh' ? 'kw' : lu === 'mwh' ? 'mw' : lu === 'wh' ? 'w' : '')
            : lu;
        if (native === 'kw') return 1 / 1000;
        if (native === 'mw') return 1 / 1_000_000;
        return 1;
    })();

    //Predicted PV for hours from "now" forward, scales the
    //clear-sky percentage by the user-configured peak power
    //(kWp -> W per percent of STC). Skipped silently when the
    //peak power isn't set in the editor.
    const k = pvCalibK(host.config);
    const coords = getHomeCoords(host.config, host.hass);
    const lat = coords?.lat;
    const lon = coords?.lon;
    const series = host._chartSeries;
    const predictedSamples: Array<{ t: Date; v: number }> = [];
    if (k !== null && series && typeof lat === 'number' && typeof lon === 'number')
    {
        const nowMs  = Date.now();
        const raster = host._engine?.getLidarRaster() ?? null;
        for (let i = 0; i < series.times.length; i++)
        {
            const tMs = series.times[i].getTime();
            if (tMs <  nowMs)   continue;             //future only
            if (tMs <  startMs) continue;
            if (tMs >  endMsAbs) continue;
            const pct = computePvPowerWeighted(host.config, series.times[i], lat, lon, series.cloud[i] ?? 0, {
                airTempC: series.temperature[i],
                windMs:   series.windSpeed[i],
                raster,
            });
            if (pct <= 0) continue;
            predictedSamples.push({ t: series.times[i], v: pct * k * nativeFromW });
        }
    }

    //Auto-scale: the Y axis maps 0 to the bottom edge and the
    //series' running max to the top edge. With a min of 1 we
    //avoid division-by-zero when the series is all-zero (early
    //morning, prolonged outage) and keep the curve visibly
    //pinned to the baseline rather than silently disappearing.
    //Predicted samples also feed into yMax so the forecast line
    //doesn't clip when expected production exceeds anything
    //the user has produced lately.
    let yMax = 1;
    for (const s of samples)          { if (s.v > yMax) yMax = s.v; }
    for (const s of predictedSamples) { if (s.v > yMax) yMax = s.v; }
    const yOf = (v: number): number =>
        H - Math.max(0, Math.min(1, v / yMax)) * H;

    const points = samples.map(s =>
        `${xOf(s.t).toFixed(2)},${yOf(s.v).toFixed(2)}`);

    let area  = '';
    let line  = '';
    if (points.length >= 2)
    {
        const x0 = xOf(samples[0].t);
        const xN = xOf(samples[samples.length - 1].t);
        area = `M ${x0},${H} L ${points.join(' L ')} L ${xN},${H} Z`;
        line = `M ${points.join(' L ')}`;
    }

    let predictedLine = '';
    if (predictedSamples.length >= 2)
    {
        const pPoints = predictedSamples.map(s =>
            `${xOf(s.t).toFixed(2)},${yOf(s.v).toFixed(2)}`);
        predictedLine = `M ${pPoints.join(' L ')}`;
    }

    return html`
        <svg
            class="hc-chart-svg"
            viewBox="0 0 ${W} ${H}"
            preserveAspectRatio="none"
        >
            ${dayXs.map(x => svg`
                <line
                    class="hc-day-sep"
                    x1="${x.toFixed(2)}" y1="0"
                    x2="${x.toFixed(2)}" y2="${H}"
                ></line>
            `)}
            ${area ? svg`
                <path
                    d="${area}"
                    fill="${pvColor}"
                    fill-opacity="0.5"
                ></path>
                <path
                    class="hc-chart-line"
                    d="${line}"
                    stroke="${pvColor}"
                ></path>
            ` : nothing}
            ${predictedLine ? svg`
                <path
                    class="hc-chart-line hc-chart-predicted"
                    d="${predictedLine}"
                    stroke="${pvColor}"
                ></path>
            ` : nothing}
        </svg>
    `;
}


//The thin track now carries only the cursors. Day
//separators live inside the chart card SVG (dotted vertical
//lines) and the scrub time label has been promoted to a chip
//above the chart card.
export function renderTimelineTicks(host: ChartHost): TemplateResult
{
    if (!host._timeRange)
    {
        return html``;
    }

    const { start, end } = host._timeRange;
    const rangeMs = end.getTime() - start.getTime();
    const now     = new Date();
    const toPct   = (d: Date): number =>
        Math.max(0, Math.min(100, (d.getTime() - start.getTime()) / rangeMs * 100));

    const nowPct        = toPct(now);
    const showSelected  = !host._isLiveMode && host._selectedTime !== null;
    const selPct        = showSelected ? toPct(host._selectedTime!) : 0;

    return html`
        <div class="tb-cursor-now" style="left:${nowPct}%"></div>
        ${showSelected ? html`
            <div class="tb-cursor-sel" style="left:${selPct}%"></div>
        ` : nothing}
    `;
}


//Day labels rendered as small white chips overlaying the chart
//card on its midline (between the irradiance and cloud halves).
//Same chip styling as the on-map cloud and W/m² readouts, so all
//three feel like the same family. Each chip is centred on the
//middle of its day's segment in the time range.
export function renderTimelineDayLabels(host: ChartHost): TemplateResult
{
    if (!host._timeRange)
    {
        return html``;
    }

    const { start, end } = host._timeRange;
    const rangeMs = end.getTime() - start.getTime();
    const now     = new Date();
    const toPct   = (d: Date): number =>
        Math.max(0, Math.min(100, (d.getTime() - start.getTime()) / rangeMs * 100));

    const today0 = new Date(now);
    today0.setHours(0, 0, 0, 0);

    //Pre-compute the daily kWh totals once per render (cheap; the
    //helper itself caches the observed bucketing). Past + today-
    //so-far is integrated from the actual PV history; today-
    //remainder + future days come from the kWp × clear-sky
    //model. The map is keyed by the day's local-midnight ms.
    //Skip the integration entirely when the user has the per-day
    //consumption chip turned off: the chip is the only consumer
    //here, no reason to spend cycles on the integration.
    const showConsumption = timelineConsumptionEnabled(host.config);
    const dailyKwh = showConsumption
        ? computeDailyKwhTotals(host)
        : new Map<number, number>();

    const labels: TemplateResult[] = [];
    const cursor = new Date(start);
    cursor.setHours(0, 0, 0, 0);

    while (cursor.getTime() <= end.getTime())
    {
        const next = new Date(cursor);
        next.setDate(next.getDate() + 1);

        const segStart = Math.max(start.getTime(), cursor.getTime());
        const segEnd   = Math.min(end.getTime(),   next.getTime());

        if (segEnd > segStart)
        {
            const pStart   = toPct(new Date(segStart));
            const pEnd     = toPct(new Date(segEnd));
            const w        = pEnd - pStart;
            const dayDelta = Math.round((cursor.getTime() - today0.getTime()) / 86_400_000);
            const isToday  = dayDelta === 0;

            const label    = formatDate(cursor, host.config?.['date-format']);
            const centre   = pStart + w / 2;
            const labelPct = Math.min(Math.max(centre, 6), 94);

            const kwh   = dailyKwh.get(cursor.getTime());
            //Forecast days (future + today's not-yet-produced
            //share) are flagged so the chip styling can hint
            //"this is an estimate" with a touch of italic. Past
            //days are always concrete.
            const isForecast = kwh !== undefined && cursor.getTime() > today0.getTime();
            const kwhText = (kwh !== undefined && isFinite(kwh) && kwh >= 0.05)
                ? formatLocalisedNumber(host.hass, kwh, 1) + ' kWh'
                : '';

            labels.push(html`
                <div
                    class="tb-day-label ${isToday ? 'tb-day-label-today' : ''}"
                    style="left:${labelPct}%"
                >
                    <span class="tb-day-label-date">${label}</span>
                    ${kwhText ? html`
                        <span class="tb-day-label-kwh ${isForecast ? 'is-forecast' : ''}">${kwhText}</span>
                    ` : nothing}
                </div>
            `);
        }

        cursor.setTime(next.getTime());
    }

    return html`<div class="tb-day-labels">${labels}</div>`;
}


//Compute kWh-per-day totals over the active timeline range. The
//helper integrates two sources:
//
//  - Past + today-so-far: sum of the observed PV history (from
//    `_pvHistory`), respecting the entity's unit (W/kW power
//    sensors are integrated by trapezoidal rule; cumulative
//    energy sensors are differenced and summed).
//  - Today-remainder + future: integration of the kWp × clear-
//    sky × cloud model, hour by hour, using the engine's
//    weather series.
//
//Returns a Map keyed by each day's local-midnight ms, with
//values in kWh. Days that fall outside the active range or
//carry no usable data are omitted.
export function computeDailyKwhTotals(host: ChartHost): Map<number, number>
{
    const out = new Map<number, number>();
    if (!host._timeRange) return out;
    const { start, end } = host._timeRange;
    const startMs  = start.getTime();
    const endMsAbs = end.getTime();

    const dayKey = (ms: number): number =>
    {
        const d = new Date(ms);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    };

    //Pass 1: past + today-so-far from the observed history.
    const hist = host._pvHistory;
    if (hist && hist.times.length >= 2)
    {
        const unit = (host._pvUnit || '').toLowerCase();
        const isCumulativeEnergy = unit === 'wh' || unit === 'kwh' || unit === 'mwh';

        if (isCumulativeEnergy)
        {
            //Cumulative energy sensor: difference consecutive
            //samples and sum the deltas per day. Counter resets
            //(dv < 0) are dropped, same convention the chart uses.
            for (let i = 1; i < hist.times.length; i++)
            {
                const tMs = hist.times[i].getTime();
                if (tMs < startMs || tMs > endMsAbs) continue;
                const dv = hist.values[i] - hist.values[i - 1];
                if (!isFinite(dv) || dv < 0) continue;
                const kwh = unit === 'mwh' ? dv * 1000
                          : unit === 'wh'  ? dv / 1000
                          : dv;
                const k = dayKey(tMs);
                out.set(k, (out.get(k) ?? 0) + kwh);
            }
        }
        else
        {
            //Power sensor: trapezoidal integration of the
            //instantaneous reading over each consecutive pair.
            //Skip gaps > 6 h (likely sensor outage, integrating
            //across them would invent energy).
            for (let i = 1; i < hist.times.length; i++)
            {
                const tCurrMs = hist.times[i].getTime();
                if (tCurrMs < startMs || tCurrMs > endMsAbs) continue;
                const tPrevMs = hist.times[i - 1].getTime();
                const dtH = (tCurrMs - tPrevMs) / 3_600_000;
                if (dtH <= 0 || dtH > 6) continue;
                const wPrev = pvNormalizeToWatts(hist.values[i - 1], host._pvUnit);
                const wCurr = pvNormalizeToWatts(hist.values[i],     host._pvUnit);
                if (!isFinite(wPrev) || !isFinite(wCurr)) continue;
                const kwh = ((wPrev + wCurr) / 2) * dtH / 1000;
                const k = dayKey(tCurrMs);
                out.set(k, (out.get(k) ?? 0) + kwh);
            }
        }
    }

    //Pass 2: future + today-remainder from the forecast model.
    //Skipped silently when peak power is unset (no model, no
    //forecast, only past observation contributes).
    const k        = pvCalibK(host.config);   //W per percent of STC
    const series   = host._chartSeries;
    const coords   = getHomeCoords(host.config, host.hass);
    if (k !== null && k > 0 && series && coords)
    {
        //Index hourly forecast samples by hour-floor ms so we
        //can integrate them by 1-hour rectangles per day. The
        //series timestamps are already at hour boundaries from
        //the engine's resampling.
        const nowMs  = Date.now();
        const raster = host._engine?.getLidarRaster() ?? null;
        for (let i = 0; i < series.times.length; i++)
        {
            const tMs   = series.times[i].getTime();
            if (tMs < startMs || tMs > endMsAbs) continue;
            if (tMs < nowMs) continue;   //past covered by Pass 1
            const cloud = series.cloud[i] ?? 0;
            const pct   = computePvPowerWeighted(host.config, series.times[i], coords.lat, coords.lon, cloud, {
                airTempC: series.temperature[i],
                windMs:   series.windSpeed[i],
                raster,
            });
            if (pct <= 0) continue;
            //pct × k = watts at this hour midpoint × 1h = Wh.
            //Divide by 1000 to land in kWh.
            const kwh = (pct * k) / 1000;
            const dk = dayKey(tMs);
            out.set(dk, (out.get(dk) ?? 0) + kwh);
        }
    }

    return out;
}
