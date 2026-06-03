//Timeline chart rendering: the two SVG cards that sit under the map, the timeline cursors that scrub across them, and the per-day kWh aggregation
//used by the day chips.
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
import { cfgHex, formatDate, formatLocalisedNumber, lerpHexToward } from './format';
import
{
    pvCalibK,
    pvInverterMaxW,
    pvNormalizeToWatts,
    computePvPowerWeighted,
    type PvHistory
} from './pv';
import { getHomeCoords } from './init';
import { getSunPosition } from '../engine/sun';
import { computeForecastCalibration } from './calibration';
import { currentShadingMap, trainShadingMap } from './shadingTrainer';
import { lookupRatio, blendedRatio, type ShadingMap } from '../engine/shadingMap';


//Resolve the per-point forecast multiplier: blend the learned
//shading-map ratio (if the corresponding cell is confident
//enough) with the scalar 5-day calibration ratio (always
//available as a fallback). Same shape at every call site so the
//instant tooltip + the hourly chart + the per-day kWh totals all
//apply identical corrections; that's how a tree's late-afternoon
//shadow ends up showing in both the dashboard headline and the
//refined curve simultaneously.
export function effectiveForecastRatio(
    map:    ShadingMap,
    time:   Date,
    lat:    number,
    lon:    number,
    cloud:  number,
    calR:   number,
    nowMs:  number,
): number
{
    const sun = getSunPosition(time, lat, lon);
    if (!sun || sun.altitude <= 0)
    {
        return calR;
    }
    return blendedRatio(lookupRatio(map, sun.azimuth, sun.altitude, cloud, nowMs), calR);
}


//Binary-search the sun's altitude=0 crossing inside [dayStart, dayEnd]
//in the requested direction (rising = first crossing where alt > 0,
//setting = first crossing where alt ≤ 0 after being > 0). Returns
//null at polar latitudes during the day-long polar day / night
//windows where the sun never crosses the horizon, or when the
//bracket is degenerate. Used by the timeline's per-day sunrise /
//sunset markers; coarse 1-hour scan + 12 iterations of bisection
//get the answer to seconds precision in ~22 getSunPosition calls
//per event, well under the per-frame budget.
function findSunCrossing(
    lat: number,
    lon: number,
    dayStartMs: number,
    dayEndMs:   number,
    direction:  'rising' | 'setting'
): Date | null
{
    const STEP_MS = 60 * 60 * 1000;
    let prevAlt = getSunPosition(new Date(dayStartMs), lat, lon).altitude;
    let bracketLo = 0;
    let bracketHi = 0;
    let found = false;
    for (let t = dayStartMs + STEP_MS; t <= dayEndMs; t += STEP_MS)
    {
        const alt = getSunPosition(new Date(t), lat, lon).altitude;
        if (direction === 'rising' && prevAlt <= 0 && alt > 0)
        {
            bracketLo = t - STEP_MS;
            bracketHi = t;
            found = true;
            break;
        }
        if (direction === 'setting' && prevAlt > 0 && alt <= 0)
        {
            bracketLo = t - STEP_MS;
            bracketHi = t;
            found = true;
            break;
        }
        prevAlt = alt;
    }
    if (!found)
    {
        return null;
    }
    for (let i = 0; i < 12; i++)
    {
        const mid = (bracketLo + bracketHi) / 2;
        const alt = getSunPosition(new Date(mid), lat, lon).altitude;
        if ((direction === 'rising') === (alt > 0))
        {
            bracketHi = mid;
        }
        else
        {
            bracketLo = mid;
        }
    }
    return new Date((bracketLo + bracketHi) / 2);
}


//Per-day night intervals clipped to the visible time range.
//Each interval is a (sunset[N] -> sunrise[N+1]) pair returned as
//{ startPct, endPct } fractional positions; consumed by
//`renderTimelineNightZones` to lay diagonal-hatch overlays over
//the chart cards. The walk pads one day on either side of the
//visible window so the leading and trailing night chunks (the
//morning before the first sunrise, the evening after the last
//sunset) still resolve correctly when the window doesn't start
//or end exactly on a solar boundary.
function computeNightIntervals(host: ChartHost): Array<{ startPct: number; endPct: number }>
{
    const range = host._timeRange;
    if (!range)
    {
        return [];
    }
    const coords = getHomeCoords(host.config, host.hass);
    if (!coords)
    {
        return [];
    }
    const startMs = range.start.getTime();
    const endMs   = range.end.getTime();
    const rangeMs = endMs - startMs;
    if (rangeMs <= 0)
    {
        return [];
    }

    type Crossing = { ms: number; kind: 'sunrise' | 'sunset' };
    const crossings: Crossing[] = [];

    const cursor = new Date(range.start);
    cursor.setHours(0, 0, 0, 0);
    cursor.setDate(cursor.getDate() - 1);
    const walkEndMs = endMs + 24 * 60 * 60 * 1000;
    while (cursor.getTime() <= walkEndMs)
    {
        const dayStart = cursor.getTime();
        const dayEnd   = dayStart + 24 * 60 * 60 * 1000;
        const rise = findSunCrossing(coords.lat, coords.lon, dayStart, dayEnd, 'rising');
        const setT = findSunCrossing(coords.lat, coords.lon, dayStart, dayEnd, 'setting');
        if (rise)
        {
            crossings.push({ ms: rise.getTime(), kind: 'sunrise' });
        }
        if (setT)
        {
            crossings.push({ ms: setT.getTime(), kind: 'sunset' });
        }
        cursor.setDate(cursor.getDate() + 1);
    }
    crossings.sort((a, b) => a.ms - b.ms);

    const intervals: Array<{ startMs: number; endMs: number }> = [];
    let pendingSunset: number | null = null;
    let sawAnySunrise = false;
    for (const c of crossings)
    {
        if (c.kind === 'sunset')
        {
            pendingSunset = c.ms;
        }
        else
        {
            if (pendingSunset !== null)
            {
                intervals.push({ startMs: pendingSunset, endMs: c.ms });
                pendingSunset = null;
            }
            else if (!sawAnySunrise)
            {
                //Leading night: the window opens before the first sunset of our walk, so the morning chunk up to the first sunrise is still a night
                //zone.
                intervals.push({ startMs: -Infinity, endMs: c.ms });
            }
            sawAnySunrise = true;
        }
    }
    if (pendingSunset !== null)
    {
        //Trailing night extending past the walk's last sunrise.
        intervals.push({ startMs: pendingSunset, endMs: Infinity });
    }

    const out: Array<{ startPct: number; endPct: number }> = [];
    for (const iv of intervals)
    {
        const s = Math.max(iv.startMs, startMs);
        const e = Math.min(iv.endMs,   endMs);
        if (e > s)
        {
            out.push({
                startPct: (s - startMs) / rangeMs * 100,
                endPct:   (e - startMs) / rangeMs * 100,
            });
        }
    }
    return out;
}


//Night-zone overlays for a chart card. Renders one absolutely-
//positioned div per night interval, filled with a diagonal hatch
//pattern. The divs are inserted inside the chart card so they
//inherit the card's relative positioning + overflow clipping;
//z-index lifts them above the SVG curves (which paint as flow
//content) but stays below the live + scrub cursors (z-index 4).
//The result reads as "this stretch of timeline is night", with
//the underlying curves still legible through the low-alpha
//diagonals.
export function renderTimelineNightZones(host: ChartHost): TemplateResult
{
    const intervals = computeNightIntervals(host);
    if (intervals.length === 0)
    {
        return html``;
    }
    return html`
        ${intervals.map(iv => html`
            <div
                class="hc-night-zone"
                style="left:${iv.startPct.toFixed(2)}%; width:${(iv.endPct - iv.startPct).toFixed(2)}%"
            ></div>
        `)}
    `;
}


//Semi-opaque overlay covering the future portion of a chart card.
//Paints on top of the curves + night-zones at z-index 3, leaving
//the live + scrub cursors (z-index 4) untouched. Anchored to "now"
//inside the active visible range, so the past portion (left of
//the overlay) reads at full punch and the forecast portion (right
//of the overlay) sits behind a wash that fades curves, fills and
//hatch overlays in one go. Returns nothing when "now" sits
//outside the range (a fully-past or fully-future window), so the
//mask never shrinks to a sliver or fills the whole card.
export function renderTimelineFutureMask(host: ChartHost): TemplateResult
{
    const range = host._timeRange;
    if (!range)
    {
        return html``;
    }
    const startMs = range.start.getTime();
    const endMs   = range.end.getTime();
    const rangeMs = endMs - startMs;
    if (rangeMs <= 0)
    {
        return html``;
    }
    const nowMs = Date.now();
    if (nowMs <= startMs || nowMs >= endMs)
    {
        return html``;
    }
    const nowPct = (nowMs - startMs) / rangeMs * 100;
    return html`
        <div
            class="hc-future-mask"
            style="left:${nowPct.toFixed(2)}%"
        ></div>
    `;
}


//PV value at the hover timestamp, expressed in the entity's
//native power unit so the tooltip number matches the Y axis of
//the PV chart and the user's own entity reading. Observed-history
//pair around the cursor wins; falling back to the clear-sky model
//(scaled by pv-peak-kwp + thermal derating + LiDAR shading) for
//hours past "now" keeps the readout meaningful in the forecast
//window. Returns NaN value when neither source can supply a
//number at the cursor instant (no entity configured, sample gap,
//etc).
function pvValueAtTime(host: ChartHost, targetMs: number): { value: number; unit: string; isPredicted: boolean }
{
    const luRaw = (host._pvUnit || '').trim();
    if (!luRaw)
    {
        return { value: NaN, unit: '', isPredicted: false };
    }
    const lu             = luRaw.toLowerCase();
    const isCumulative   = lu === 'wh' || lu === 'kwh' || lu === 'mwh';
    const displayUnit    = isCumulative
        ? (lu === 'kwh' ? 'kW' : lu === 'mwh' ? 'MW' : 'W')
        : luRaw;
    const duLow = displayUnit.toLowerCase();
    const nativeFromW    = duLow === 'kw' ? 1 / 1000
                         : duLow === 'mw' ? 1 / 1_000_000
                         : 1;

    //Hard zero when the sun is below the horizon at the cursor
    //instant. Catches three otherwise-tricky cases at once:
    //  - A stale observed sample (the entity didn't tick after dusk)
    //    that interpAt clamps forward into the night.
    //  - Forecast bracketing pairs straddling sunrise / sunset
    //    where the linear interp between "0" and "small positive"
    //    leaks a few watts into pre-dawn / post-dusk.
    //  - Inverter standby readings that a power-entity reports as
    //    0.5-2 W all night.
    //Panels can't produce without sun, so we don't trust any source
    //that disagrees with that physical floor.
    const coords = getHomeCoords(host.config, host.hass);
    if (coords && getSunPosition(new Date(targetMs), coords.lat, coords.lon).altitude <= 0)
    {
        return { value: 0, unit: displayUnit, isPredicted: false };
    }

    //Observed history. Cumulative entities differentiate between
    //the bracketing pair (the same shape the chart uses); power
    //entities linearly interpolate. Sensor noise (and net-meter
    //entities swinging through zero at dawn / dusk) can hand back
    //a small negative reading; we floor at zero so the tooltip
    //never displays "-2 W" of production.
    //
    //Hover instants BEYOND the last observed sample fall through
    //to the forecast pass below: clamping interpAt to the last
    //observed value would mean the tooltip reads "3 W" for noon
    //tomorrow just because that was the panel's reading at 16:00
    //yesterday (the late-afternoon tail of the last seen day).
    const hist = host._pvHistory;
    const rawFirstMs = (hist && hist.times.length >= 1)
        ? hist.times[0].getTime()
        : Infinity;
    const lastObsMs = (hist && hist.times.length >= 1)
        ? hist.times[hist.times.length - 1].getTime()
        : -Infinity;
    if (hist && hist.times.length >= 2 && targetMs >= rawFirstMs && targetMs <= lastObsMs)
    {
        if (isCumulative)
        {
            for (let i = 1; i < hist.times.length; i++)
            {
                const t1 = hist.times[i].getTime();
                if (targetMs > t1)
                {
                    continue;
                }
                const t0 = hist.times[i - 1].getTime();
                if (targetMs < t0)
                {
                    break;
                }
                const dtH = (t1 - t0) / 3_600_000;
                if (dtH <= 0 || dtH > 6)
                {
                    break;
                }
                const dv = hist.values[i] - hist.values[i - 1];
                if (!isFinite(dv) || dv < 0)
                {
                    break;
                }
                return { value: Math.max(0, dv / dtH), unit: displayUnit, isPredicted: false };
            }
        }
        else
        {
            const v = interpAt(hist.times, hist.values, targetMs);
            if (isFinite(v))
            {
                return { value: Math.max(0, v), unit: displayUnit, isPredicted: false };
            }
        }
    }
    //Older past, before the head of the raw 6-hour window: fall
    //back to the hourly LTS slot the calibration already fetched.
    //The LTS values are already in native power units (mean for
    //power sensors, differentiated state for cumulative-energy
    //sensors) so a linear interpolation at the cursor instant is
    //the right thing to do regardless of the source entity type.
    const calib = host._pvCalibStats;
    if (calib && calib.times.length >= 2 && targetMs <= lastObsMs)
    {
        const v = interpAt(calib.times, calib.values, targetMs);
        if (isFinite(v))
        {
            return { value: Math.max(0, v), unit: displayUnit, isPredicted: false };
        }
    }

    //Forecast for future hours. Reuses the per-array PV power model + thermal / shading hooks the chart already feeds, plus the 5-day rolling
    //calibration ratio so the tooltip's forecast value matches the "refined" headline number on the dashboard, plus the optional inverter PMax clip
    //so the reading never exceeds what the user's hardware can deliver.
    const series = host._chartSeries;
    const k      = pvCalibK(host.config);
    const cal    = computeForecastCalibration(host);
    const calR   = cal ? cal.ratio : 1;
    trainShadingMap(host);
    const shading = currentShadingMap();
    const nowMs   = Date.now();
    const capW    = pvInverterMaxW(host.config);
    if (k !== null && series && coords && series.times.length >= 2)
    {
        const raster = host._engine?.getLidarRaster() ?? null;
        for (let i = 1; i < series.times.length; i++)
        {
            const t1 = series.times[i].getTime();
            if (targetMs > t1)
            {
                continue;
            }
            const t0 = series.times[i - 1].getTime();
            if (targetMs < t0)
            {
                break;
            }
            const cloud0 = series.cloud[i - 1] ?? 0;
            const cloud1 = series.cloud[i] ?? 0;
            const eff0   = effectiveForecastRatio(shading, series.times[i - 1], coords.lat, coords.lon, cloud0, calR, nowMs);
            const eff1   = effectiveForecastRatio(shading, series.times[i],     coords.lat, coords.lon, cloud1, calR, nowMs);
            const w0 = Math.min(capW, computePvPowerWeighted(host.config, series.times[i - 1], coords.lat, coords.lon, cloud0, {
                airTempC: series.temperature[i - 1],
                windMs:   series.windSpeed[i - 1],
                raster,
            }) * k * eff0);
            const w1 = Math.min(capW, computePvPowerWeighted(host.config, series.times[i], coords.lat, coords.lon, cloud1, {
                airTempC: series.temperature[i],
                windMs:   series.windSpeed[i],
                raster,
            }) * k * eff1);
            const dt = t1 - t0;
            if (dt <= 0)
            {
                return { value: Math.max(0, w1) * nativeFromW, unit: displayUnit, isPredicted: true };
            }
            const w  = w0 + (w1 - w0) * (targetMs - t0) / dt;
            return { value: Math.max(0, w) * nativeFromW, unit: displayUnit, isPredicted: true };
        }
    }

    return { value: NaN, unit: displayUnit, isPredicted: false };
}


//Hover tooltip block, sits above the chart-card stack inside the
//time-bar. Shows the hover timestamp + one icon-coded row per
//series, plus the day's kWh production (observed past + today
//so-far) or forecast (future days) on a dedicated row. A small
//magnet-snap tab appears above the tooltip the moment the scrub
//pointer enters the narrow band around the live cursor, signalling
//the imminent auto-snap back to live mode (see applyTimelinePointer
//in timeline.ts for the actual snap logic). The PV row is skipped
//silently when the entity isn't configured or no value is available
//at the cursor instant, so the chip stays useful for forecast-only
//setups.
export function renderTimelineHoverTooltip(host: ChartHost): TemplateResult
{
    const range    = host._timeRange;
    const series   = host._chartSeries;
    if (!range || !series)
    {
        return html``;
    }

    const startMs = range.start.getTime();
    const rangeMs = range.end.getTime() - startMs;
    if (rangeMs <= 0)
    {
        return html``;
    }

    //Tooltip shows ONLY while the pointer is actively over the chart
    //(or actively dragging the scrub, which keeps _chartHoverPct in
    //sync). Once the gesture ends, _chartHoverPct goes null and the
    //tooltip disappears, leaving only the scrub line behind so the
    //user reads the locked instant without a floating callout.
    const hoverPct = host._chartHoverPct;
    if (hoverPct === null || hoverPct < 0 || hoverPct > 100)
    {
        return html``;
    }
    const pct  = hoverPct;
    const atMs = startMs + (pct / 100) * rangeMs;

    const irrV = interpAt(series.times, series.irradiance, atMs);
    const cldV = interpAt(series.times, series.cloud,      atMs);
    const pv   = pvValueAtTime(host, atMs);
    const hasPv = isFinite(pv.value);

    //The scrub tooltip icons now inherit the active HA theme colour
    //(see .tb-hover-tooltip-icon), so the per-series tints from the
    //legacy DEFAULT_*_COLOR_HEX constants are no longer applied here.

    const atDate     = new Date(atMs);
    const haLanguage = (host.hass?.language as string | undefined) || undefined;
    const timeLabel  = new Intl.DateTimeFormat(haLanguage, {
        hour: '2-digit', minute: '2-digit',
    }).format(atDate);

    //Day total split into observed (past + today-so-far) and forecast
    //(future days). Past + today scrub shows the observed production
    //figure only, future scrub shows the forecast figure. No double
    //row even when both inputs are populated for today, the observed
    //total is already authoritative for the day-so-far. Today's bucket
    //prefers the recorder-backed `_haSolarTodayKwh` so the tooltip
    //matches the dashboard "produced today" chip to the watt-hour,
    //falling back to the local trapezoidal integration when the HA
    //Energy preference is not wired.
    const dayKey = new Date(atDate);
    dayKey.setHours(0, 0, 0, 0);
    const todayKey = new Date();
    todayKey.setHours(0, 0, 0, 0);
    const isFutureDay = dayKey.getTime() > todayKey.getTime();
    const isToday     = dayKey.getTime() === todayKey.getTime();
    const dayTotals   = computeDailyKwhTotals(host);
    let dayKwh: number | undefined = dayTotals.get(dayKey.getTime());
    if (isToday && typeof host._haSolarTodayKwh === 'number' && isFinite(host._haSolarTodayKwh))
    {
        dayKwh = host._haSolarTodayKwh;
    }
    const showProduction = !isFutureDay && dayKwh !== undefined && isFinite(dayKwh) && dayKwh >= 0.05;
    const showForecast   =  isFutureDay && dayKwh !== undefined && isFinite(dayKwh) && dayKwh >= 0.05;
    const dayKwhText = (dayKwh !== undefined && isFinite(dayKwh) && dayKwh >= 0.05)
        ? formatLocalisedNumber(host.hass, dayKwh, 1) + ' kWh'
        : '';

    //Magnet-snap detection. When the scrub pointer lands within a
    //narrow band around the live cursor, applyTimelinePointer in
    //timeline.ts auto-releases back to live mode. A small restore
    //tab surfaces above the tooltip the moment the pointer enters
    //that band so the user reads the upcoming snap visually. The
    //px-based scrub check uses 8 px, this pct equivalent is sized to
    //match at typical chart widths (8 px on a 700 px chart ~= 1.2 %).
    const MAGNET_PCT   = 1.2;
    const nowMsRef     = Date.now();
    const inMagnetZone = nowMsRef >= startMs && nowMsRef <= startMs + rangeMs
        && Math.abs(pct - ((nowMsRef - startMs) / rangeMs) * 100) <= MAGNET_PCT;

    //PV decimals: 1 for kW/MW under three digits, 0 otherwise.
    const pvDecimals = !hasPv ? 0
                     : pv.unit === 'W' ? 0
                     : (Math.abs(pv.value) < 100 ? 1 : 0);

    const haLang   = (host.hass?.language as string | undefined) || '';
    const liveText = haLang.toLowerCase().startsWith('fr')
        ? 'Retour au live'
        : 'Back to live';

    //Tooltip horizontal anchor: a continuous left-to-right slide
    //driven by translateX(-${pct}%), so the tooltip's left edge sits
    //at 0 when the scrub is at 0 % and its right edge sits at 100 %
    //when the scrub is at 100 %. Net result: the tooltip never goes
    //off-screen yet there's no jump-to-edge magnet at any threshold,
    //the box just slides smoothly along with the scrub.
    return html`
        <div
            class="tb-hover-tooltip-tail ${inMagnetZone ? 'is-magnet-snap' : ''}"
            style="left:${pct.toFixed(2)}%"
        ></div>
        <div
            class="tb-hover-tooltip-wrapper"
            style="left:${pct.toFixed(2)}%; transform: translateX(-${pct.toFixed(2)}%)"
        >
            ${inMagnetZone ? html`
                <div
                    class="tb-hover-tooltip-magnet-tab"
                    title="${liveText}"
                    aria-label="${liveText}"
                >
                    <ha-icon icon="mdi:restore"></ha-icon>
                </div>
            ` : nothing}
            <div class="tb-hover-tooltip">
                <div class="tb-hover-tooltip-time">${timeLabel}</div>
                ${showProduction && dayKwhText ? html`
                    <div class="tb-hover-tooltip-row">
                        <ha-icon class="tb-hover-tooltip-icon" icon="mdi:solar-power-variant"></ha-icon>
                        <span class="tb-hover-tooltip-value">${dayKwhText}</span>
                    </div>
                ` : nothing}
                ${showForecast && dayKwhText ? html`
                    <div class="tb-hover-tooltip-row">
                        <ha-icon class="tb-hover-tooltip-icon" icon="mdi:crystal-ball"></ha-icon>
                        <span class="tb-hover-tooltip-value">${dayKwhText}</span>
                    </div>
                ` : nothing}
                ${isFinite(irrV) ? html`
                    <div class="tb-hover-tooltip-row">
                        <ha-icon class="tb-hover-tooltip-icon" icon="mdi:white-balance-sunny"></ha-icon>
                        <span class="tb-hover-tooltip-value">${Math.round(Math.max(0, irrV))} W/m²</span>
                    </div>
                ` : nothing}
                ${isFinite(cldV) ? html`
                    <div class="tb-hover-tooltip-row">
                        <ha-icon class="tb-hover-tooltip-icon" icon="mdi:cloud-outline"></ha-icon>
                        <span class="tb-hover-tooltip-value">${Math.round(Math.max(0, Math.min(100, cldV)))} %</span>
                    </div>
                ` : nothing}
                ${hasPv ? html`
                    <div class="tb-hover-tooltip-row">
                        <ha-icon class="tb-hover-tooltip-icon" icon="mdi:solar-power"></ha-icon>
                        <span class="tb-hover-tooltip-value">${formatLocalisedNumber(host.hass, pv.value, pvDecimals)} ${pv.unit}</span>
                    </div>
                ` : nothing}
            </div>
        </div>
    `;
}


//Engine-resampled weather series. Same shape the engine snapshots and pushes to the card on every refresh.
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

//Structural surface the host card exposes to this module. The `_chartHoverPct` field is intentionally writable: hover handlers defined here mutate it
//on pointermove / pointerleave, exactly like the dashboard's `_dashChartHoverTs`. All other fields stay read-only.
export interface ChartHost
{
    readonly config:        HeliosConfig | undefined;
    readonly hass:          any;
    readonly _timeRange:    { start: Date; end: Date } | null;
    readonly _chartSeries:  ChartSeries | null;
    readonly _pvHistory:    PvHistory | null;
    //Hourly long-term-statistics series feeding the 5-day forecast calibration. `calibration.ts` prefers this over `_pvHistory` because it
    //carries the same 5-day window with two orders of magnitude fewer rows on high-frequency installs. Null while the stats fetch is in
    //flight, or empty when the entity is not LTS-tracked, in both cases the consumer degrades to `_pvHistory`.
    readonly _pvCalibStats:   PvHistory | null;
    //5-minute long-term-statistics series feeding the 30-day shading-map trainer. Same fallback contract as `_pvCalibStats`.
    readonly _pvTrainerStats: PvHistory | null;
    //Optional companion battery SoC history, populated by the same fetchPvHistory call when the inverter-cutoff guard is armed.
    //Null when the guard is off or no battery is configured. The shading trainer reads it to skip buckets where SoC reached the cutoff.
    readonly _batteryHistory: PvHistory | null;
    readonly _pvUnit:       string;
    readonly _selectedTime: Date | null;
    readonly _isLiveMode:   boolean;
    //HA Energy daily-total alignment: today's produced kWh as queried
    //from the recorder `change` statistic on every `stat_energy_from`
    //array, so the scrub tooltip lands on the same figure the dashboard
    //chip shows. Null when not configured or before the first recorder
    //call lands, in which case the tooltip falls back to the local
    //trapezoidal integration over `_pvHistory`.
    readonly _haSolarTodayKwh?: number | null;
    //Mutable hover-cursor position as a percent inside the visible
    //time range (0..100), null when no hover is active. Written by
    //the pointer handlers defined below.
    _chartHoverPct:         number | null;
    //Exposed so the PV predictor inside the chart layer can pull
    //the loaded LiDAR raster for the per-array shading raycast.
    //Optional because the chart still renders fine without the
    //engine reference (shading just falls back to "no obstacle").
    readonly _engine?:      { getLidarRaster(): import('../engine/pv-shading').NdsmRaster | null };
}


//Linear-interpolate a series at a target absolute timestamp. The
//series is assumed strictly increasing in time. Targets outside
//the range clamp to the nearest endpoint; NaN slots break the
//interpolation, the caller then sees NaN and skips rendering.
//Used by the hover tooltip + dot positions across the irradiance,
//cloud and PV curves so all three readouts share the same
//interpolation contract.
function interpAt(times: Date[], values: number[], targetMs: number): number
{
    const n = Math.min(times.length, values.length);
    if (n === 0)
    {
        return NaN;
    }
    if (targetMs <= times[0].getTime())
    {
        return isFinite(values[0]) ? values[0] : NaN;
    }
    if (targetMs >= times[n - 1].getTime())
    {
        const v = values[n - 1];
        return isFinite(v) ? v : NaN;
    }
    for (let i = 1; i < n; i++)
    {
        const t1 = times[i].getTime();
        if (targetMs > t1)
        {
            continue;
        }
        const t0 = times[i - 1].getTime();
        const v0 = values[i - 1];
        const v1 = values[i];
        if (!isFinite(v0) || !isFinite(v1))
        {
            return NaN;
        }
        const dt = t1 - t0;
        if (dt <= 0)
        {
            return v1;
        }
        return v0 + (v1 - v0) * (targetMs - t0) / dt;
    }
    return NaN;
}


//Hover-cursor pointer handlers. Attached on each chart card; the
//card's bounding rect drives the fractional X conversion. A press
//(e.buttons !== 0) clears the hover so a scrub drag never leaves
//a stale dot behind: the scrub interaction itself lives on the
//time-bar pointerdown above us, and once it captures the pointer
//our pointermove no longer fires until release.
export function handleChartHoverMove(host: ChartHost, e: PointerEvent): void
{
    if (e.buttons !== 0)
    {
        host._chartHoverPct = null;
        return;
    }
    const card = e.currentTarget as HTMLElement | null;
    if (!card)
    {
        return;
    }
    const rect = card.getBoundingClientRect();
    if (rect.width <= 0)
    {
        return;
    }
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    host._chartHoverPct = frac * 100;
}


export function handleChartHoverLeave(host: ChartHost): void
{
    host._chartHoverPct = null;
}


//Single-baseline "irradiance + cloud" SVG chart sitting above the
//timeline. Both curves share the bottom edge as zero and grow
//upward: 1000 W/m² and 100 % cloud cover both touch the top edge.
//Irradiance is drawn on top with a semi-opaque sun-colour fill;
//cloud fills the area below it in the configured cloud colour with
//lower opacity so the two curves coexist instead of competing for
//pixel rows. This replaces the older "sun pushes up / clouds press
//down" mirror layout, where the cloud area grew downward from the
//midline; the new layout keeps the same vertical real estate but
//is easier to read at a glance because both axes share an origin.
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
    //Shared bottom baseline; both curves grow upward from y = H to
    //y = 0. No midline split anymore.
    const BASE   = H;

    const startMs = range.start.getTime();
    const rangeMs = range.end.getTime() - startMs;
    if (rangeMs <= 0)
    {
        return html`<svg class="hc-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"></svg>`;
    }

    const xOf = (t: Date): number =>
        ((t.getTime() - startMs) / rangeMs) * W;

    //Irradiance Y: 0 W/m² sits on the bottom edge, 1000 W/m² sits at the top edge. Anything above clamps to the top.
    const yIrr = (w: number): number =>
        BASE - Math.max(0, Math.min(1, w / 1000)) * H;

    //Cloud Y: 0 % sits on the bottom edge, 100 % sits at the top edge. Same orientation as irradiance now, so 'thicker cloud' reads as 'taller fill'
    //which matches a user's intuition.
    const yCloud = (pct: number): number =>
        BASE - Math.max(0, Math.min(1, pct / 100)) * H;

    const irrPoints = series.times.map((t, i) =>
        `${xOf(t).toFixed(2)},${yIrr(series.irradiance[i] ?? 0).toFixed(2)}`);
    const cloudPoints = series.times.map((t, i) =>
        `${xOf(t).toFixed(2)},${yCloud(series.cloud[i] ?? 0).toFixed(2)}`);

    //Both areas close back to the shared bottom baseline so the
    //fills always anchor to y = H regardless of the first / last
    //sample value.
    const x0 = xOf(series.times[0]);
    const xN = xOf(series.times[series.times.length - 1]);
    const irrArea = `M ${x0},${BASE} L ${irrPoints.join(' L ')} L ${xN},${BASE} Z`;
    const cloudArea = `M ${x0},${BASE} L ${cloudPoints.join(' L ')} L ${xN},${BASE} Z`;

    //Stroke-only paths layered on top of the filled areas to accentuate the curve outline. Same point sequence as the areas, minus the closing
    //segment back to the midline so we don't draw a horizontal line across the baseline.
    const irrLine   = `M ${irrPoints.join(' L ')}`;
    const cloudLine = `M ${cloudPoints.join(' L ')}`;

    const sunColor   = cfgHex(host.config?.['sun-color'],   DEFAULT_SUN_COLOR_HEX);
    const cloudColor = cfgHex(host.config?.['cloud-color'], DEFAULT_CLOUD_COLOR_HEX);

    //Hover dots + vertical guide. Both curves are interpolated at
    //the hover timestamp so the dots ride the curves exactly,
    //matching what the tooltip above the card reads out. NaN
    //returns (out of range / missing samples) skip the dot quietly.
    const hoverPct = host._chartHoverPct;
    let hoverX:     number = 0;
    let hoverYIrr:  number = NaN;
    let hoverYCld:  number = NaN;
    let showHover  = false;
    if (hoverPct !== null && hoverPct >= 0 && hoverPct <= 100)
    {
        hoverX = (hoverPct / 100) * W;
        const hoverMs = startMs + (hoverPct / 100) * rangeMs;
        const irrV    = interpAt(series.times, series.irradiance, hoverMs);
        const cldV    = interpAt(series.times, series.cloud,      hoverMs);
        if (isFinite(irrV))
        {
            hoverYIrr = yIrr(irrV);
        }
        if (isFinite(cldV))
        {
            hoverYCld = yCloud(cldV);
        }
        showHover = isFinite(hoverYIrr) || isFinite(hoverYCld);
    }

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
            <!-- Cloud first as the background layer. Painted at a
                 higher alpha than the irradiance fill that sits on
                 top so the cloud curve stays readable through the
                 sun overlay; the irradiance fill keeps its lighter
                 0.25 alpha to avoid washing the cloud area out. -->
            <path
                d="${cloudArea}"
                fill="${cloudColor}"
                fill-opacity="0.45"
            ></path>
            <path
                d="${irrArea}"
                fill="${sunColor}"
                fill-opacity="0.25"
            ></path>
            <path
                class="hc-chart-line"
                d="${cloudLine}"
                stroke="${cloudColor}"
            ></path>
            <path
                class="hc-chart-line"
                d="${irrLine}"
                stroke="${sunColor}"
            ></path>
            ${dayXs.map(x => svg`
                <line
                    class="hc-day-sep"
                    x1="${x.toFixed(2)}" y1="0"
                    x2="${x.toFixed(2)}" y2="${H}"
                ></line>
            `)}
            ${hourXs.map(x => svg`
                <line
                    class="hc-hour-tick"
                    x1="${x.toFixed(2)}" y1="${H - HOUR_TICK_HALF * 2}"
                    x2="${x.toFixed(2)}" y2="${H}"
                ></line>
            `)}
            ${showHover ? svg`
                <line
                    class="hc-hover-guide"
                    x1="${hoverX.toFixed(2)}" y1="0"
                    x2="${hoverX.toFixed(2)}" y2="${H}"
                ></line>
                ${isFinite(hoverYCld) ? svg`
                    <circle
                        class="hc-hover-dot"
                        cx="${hoverX.toFixed(2)}"
                        cy="${hoverYCld.toFixed(2)}"
                        r="2.4"
                        fill="${cloudColor}"
                    ></circle>
                ` : ''}
                ${isFinite(hoverYIrr) ? svg`
                    <circle
                        class="hc-hover-dot"
                        cx="${hoverX.toFixed(2)}"
                        cy="${hoverYIrr.toFixed(2)}"
                        r="2.4"
                        fill="${sunColor}"
                    ></circle>
                ` : ''}
            ` : nothing}
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
    //Theme-aware "predicted" PV shade for the dashed forecast curve
    //overlay: light theme blends pvColor toward BLACK so it stays
    //readable on a white card; dark theme blends toward WHITE so it
    //still reads as a softer line on the dark plate. Mirrors the
    //dashboard's predictedColor logic.
    const isDarkTheme       = !!(host.hass as { themes?: { darkMode?: boolean } } | undefined)?.themes?.darkMode;
    const predictedPvColor  = isDarkTheme
        ? lerpHexToward(pvColor, '#ffffff', 0.55)
        : lerpHexToward(pvColor, '#000000', 0.35);

    //Day-boundary X positions, same computation as the main chart so the dotted separators line up across the two.
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
        //Quantization fix: cumulative-energy sensors typically report integer Wh, so two samples a few seconds apart look like "0 then 1 Wh delta
        //over 10 s", which divides to a fake 360 W spike when the true rate is closer to 100 W. Hold the previous anchor until at least MIN_DTH of
        //clock time has accumulated so dv / dtH averages over a window where quantization is negligible. Skip samples before that, don't advance the
        //anchor, so the next iteration compares against the same baseline.
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
                //Sensor outage, abandon this anchor and start a fresh one at the current sample.
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
    //Blend in the hourly LTS slot (`_pvCalibStats`, 5 days) for the
    //past portion of the timeline that the narrow raw window does
    //not cover. The raw fetch is capped at the last 6 hours so the
    //recorder stays responsive on 1 Hz installs (Victron Cerbo and
    //friends); without the LTS fallback the chart would just stop
    //at the head of the raw window and leave the rest of the past
    //blank. The LTS series carries a mean per hour, so we feed it
    //in below the raw samples and let the raw samples paint over
    //them where the two overlap. Already in native power units
    //(the LTS path picks `mean` for power sensors, differentiates
    //`state` for cumulative-energy sensors), so the values feed the
    //chart Y axis on the same scale as the raw samples.
    const rawFirstMs = rawTimes.length > 0 ? rawTimes[0].getTime() : Infinity;
    const calib      = host._pvCalibStats;
    if (calib && calib.times.length > 0)
    {
        for (let i = 0; i < calib.times.length; i++)
        {
            const t  = calib.times[i];
            const tMs = t.getTime();
            if (tMs < startMs)
            {
                continue;
            }
            if (tMs > endMsAbs)
            {
                continue;
            }
            //The raw fetch already carries the live tail at full
            //resolution; the LTS row would just double up the
            //paint underneath. Drop LTS rows once we cross into
            //the raw window.
            if (tMs >= rawFirstMs)
            {
                continue;
            }
            const v = calib.values[i];
            if (!isFinite(v))
            {
                continue;
            }
            samples.push({ t, v });
        }
    }
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
    //Sort by time so the painted line and area trace monotonically
    //left-to-right; the LTS pass and the raw pass append in their
    //natural orders but interleave around the boundary if a stats
    //bucket midpoint sits just inside the raw window.
    samples.sort((a, b) => a.t.getTime() - b.t.getTime());

    //Decimate to at most MAX_POINTS samples before serialising into
    //the SVG `d` attribute. A 1 Hz power sensor over 6 hours alone
    //produces 21 600 samples; the resulting path string overflows
    //Safari / Firefox SVG rasterisers (the path silently renders
    //nothing) and burns layout time on every frame. We bucket by
    //pixel column at the chart's viewBox width and keep the local
    //min + max per bucket so the visible curve still reflects the
    //peaks and troughs even at heavy compression.
    const MAX_POINTS = 1500;
    if (samples.length > MAX_POINTS)
    {
        const buckets = Math.floor(MAX_POINTS / 2);
        const bucketMs = rangeMs / buckets;
        const slim: Array<{ t: Date; v: number }> = [];
        let bIdx = 0;
        let bMinV = Infinity, bMaxV = -Infinity;
        let bMinT: Date | null = null, bMaxT: Date | null = null;
        const flush = (): void =>
        {
            if (bMinT && bMaxT)
            {
                if (bMinT.getTime() <= bMaxT.getTime())
                {
                    slim.push({ t: bMinT, v: bMinV });
                    if (bMinT.getTime() !== bMaxT.getTime())
                    {
                        slim.push({ t: bMaxT, v: bMaxV });
                    }
                }
                else
                {
                    slim.push({ t: bMaxT, v: bMaxV });
                    slim.push({ t: bMinT, v: bMinV });
                }
            }
            bMinV = Infinity; bMaxV = -Infinity; bMinT = null; bMaxT = null;
        };
        for (const s of samples)
        {
            const idx = Math.min(buckets - 1, Math.floor((s.t.getTime() - startMs) / bucketMs));
            if (idx !== bIdx)
            {
                flush();
                bIdx = idx;
            }
            if (s.v < bMinV) { bMinV = s.v; bMinT = s.t; }
            if (s.v > bMaxV) { bMaxV = s.v; bMaxT = s.t; }
        }
        flush();
        samples.length = 0;
        samples.push(...slim);
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
        if (native === 'kw')
        {
            return 1 / 1000;
        }
        if (native === 'mw')
        {
            return 1 / 1_000_000;
        }
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
    //Apply the same 5-day rolling forecast calibration the dashboard
    //already shows in its "refined" headline, so the dotted forecast
    //curve below matches the number the user sees on the dash. Null
    //(less than 2 valid past days) leaves the ratio at 1 and the
    //curve is the raw model output. The optional inverter PMax then
    //clips the resulting watts so the curve doesn't shoot above the
    //user's hardware ceiling.
    const cal     = computeForecastCalibration(host);
    const calR    = cal ? cal.ratio : 1;
    trainShadingMap(host);
    const shading = currentShadingMap();
    const capW    = pvInverterMaxW(host.config);
    const predictedSamples: Array<{ t: Date; v: number }> = [];
    if (k !== null && series && typeof lat === 'number' && typeof lon === 'number')
    {
        const nowMs  = Date.now();
        const raster = host._engine?.getLidarRaster() ?? null;
        for (let i = 0; i < series.times.length; i++)
        {
            const tMs = series.times[i].getTime();
            if (tMs <  nowMs)   continue;             //future only
            if (tMs <  startMs)
            {
                continue;
            }
            if (tMs >  endMsAbs)
            {
                continue;
            }
            const cloud = series.cloud[i] ?? 0;
            const pct = computePvPowerWeighted(host.config, series.times[i], lat, lon, cloud, {
                airTempC: series.temperature[i],
                windMs:   series.windSpeed[i],
                raster,
            });
            if (pct <= 0)
            {
                continue;
            }
            const eff = effectiveForecastRatio(shading, series.times[i], lat, lon, cloud, calR, nowMs);
            const wattsClipped = Math.min(capW, pct * k * eff);
            predictedSamples.push({ t: series.times[i], v: wattsClipped * nativeFromW });
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

    //Hover dot, drawn at the interpolated PV value at hover time.
    //Observed samples win; if there's no observed value at that
    //instant (future, gap, outage), fall back to the predicted
    //series so the dot keeps tracking. Same Y axis as the curve
    //it rides on, so the dot reads as "this is where the curve
    //sits at that moment" rather than free-floating.
    const hoverPct = host._chartHoverPct;
    let hoverX:    number = 0;
    let hoverY:    number = NaN;
    let showHover = false;
    if (hoverPct !== null && hoverPct >= 0 && hoverPct <= 100)
    {
        hoverX = (hoverPct / 100) * W;
        const hoverMs = startMs + (hoverPct / 100) * rangeMs;
        let hoverV: number = NaN;
        //Only sample the observed curve when the hover instant sits inside the observed window. Otherwise interpAt would clamp to the last observed
        //value and the dot would freeze on yesterday's late-afternoon reading when the user hovers at noon tomorrow.
        const lastObsMs = samples.length > 0
            ? samples[samples.length - 1].t.getTime()
            : -Infinity;
        if (samples.length >= 1 && hoverMs <= lastObsMs)
        {
            hoverV = interpAt(
                samples.map(s => s.t),
                samples.map(s => s.v),
                hoverMs,
            );
        }
        if (!isFinite(hoverV) && predictedSamples.length >= 1)
        {
            hoverV = interpAt(
                predictedSamples.map(s => s.t),
                predictedSamples.map(s => s.v),
                hoverMs,
            );
        }
        if (isFinite(hoverV))
        {
            //Floor at zero: a net-meter entity can briefly dip below zero around dawn / dusk and the dot should still ride the visible curve, not
            //dive off the bottom of the card.
            hoverY = yOf(Math.max(0, hoverV));
            showHover = true;
        }
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
                    fill-opacity="0.25"
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
                    stroke="${predictedPvColor}"
                ></path>
            ` : nothing}
            ${showHover ? svg`
                <line
                    class="hc-hover-guide"
                    x1="${hoverX.toFixed(2)}" y1="0"
                    x2="${hoverX.toFixed(2)}" y2="${H}"
                ></line>
                <circle
                    class="hc-hover-dot"
                    cx="${hoverX.toFixed(2)}"
                    cy="${hoverY.toFixed(2)}"
                    r="2.4"
                    fill="${pvColor}"
                ></circle>
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

    //Active day during hover or scrub. The strip cell matching the
    //pointer's day-bucket gets a faint brand-blue tint so the user
    //reads "I am on this day" at a glance. Falls back to null when
    //no hover or scrub is active, leaving every cell at rest.
    const hoverPctRef = host._chartHoverPct;
    let activeDayKey: number | null = null;
    if (hoverPctRef !== null && hoverPctRef >= 0 && hoverPctRef <= 100)
    {
        const hoverMs   = start.getTime() + (hoverPctRef / 100) * rangeMs;
        const hoverDate = new Date(hoverMs);
        hoverDate.setHours(0, 0, 0, 0);
        activeDayKey = hoverDate.getTime();
    }

    //Build the per-day cells + the vertical separators between
    //them. Cells use absolute positioning over the strip so each
    //label sits at the geometric centre of its day's segment, even
    //when the first or last day is only partially visible. The
    //separator list collects the right edge of each day except the
    //last (no separator at the strip's outer right edge).
    type Cell = { isToday: boolean; isActive: boolean; centrePct: number; widthPct: number; label: string };
    const cells: Cell[] = [];
    const sepPcts: number[] = [];
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
            const isActive = activeDayKey !== null && cursor.getTime() === activeDayKey;

            const label    = formatDate(cursor, host.hass);

            cells.push({
                isToday,
                isActive,
                centrePct: pStart + w / 2,
                widthPct:  w,
                label,
            });
            //Right edge of the day; becomes a separator unless
            //this day is the last one visible. We record it
            //unconditionally and trim after the loop.
            sepPcts.push(pEnd);
        }

        cursor.setTime(next.getTime());
    }
    //The final entry is the right edge of the strip (not a
    //between-day boundary), drop it.
    if (sepPcts.length > 0)
    {
        sepPcts.pop();
    }

    return html`
        <div class="tb-day-strip">
            ${cells.map(c => html`
                <div
                    class="tb-day-strip-cell ${c.isToday ? 'is-today' : ''} ${c.isActive ? 'is-active' : ''}"
                    style="left:${(c.centrePct - c.widthPct / 2).toFixed(2)}%; width:${c.widthPct.toFixed(2)}%"
                >
                    <span class="tb-day-strip-date">${c.label}</span>
                </div>
            `)}
            ${sepPcts.map(p => html`
                <div class="tb-day-strip-sep" style="left:${p.toFixed(2)}%"></div>
            `)}
        </div>
    `;
}



//Compute kWh-per-day totals over the active timeline range. The helper integrates two sources:
//
//  - Past + today-so-far: sum of the observed PV history (from
//    `_pvHistory`), respecting the entity's unit (W/kW power
//    sensors are integrated by trapezoidal rule; cumulative
//    energy sensors are differenced and summed).
//  - Today-remainder + future: integration of the kWp × clear-
//    sky × cloud model, hour by hour, using the engine's
//    weather series.
//
//Returns a Map keyed by each day's local-midnight ms, with values in kWh. Days that fall outside the active range or carry no usable data are
//omitted.
export function computeDailyKwhTotals(host: ChartHost): Map<number, number>
{
    const out = new Map<number, number>();
    if (!host._timeRange)
    {
        return out;
    }
    const { start, end } = host._timeRange;
    const startMs  = start.getTime();
    const endMsAbs = end.getTime();

    const dayKey = (ms: number): number =>
    {
        const d = new Date(ms);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    };

    //Pass 1: past + today-so-far from the observed history. Combines two sources so days that fall outside the narrow raw window
    //still get a value:
    //  - `_pvHistory` (~2 days raw, finest resolution) covers today and yesterday.
    //  - `_pvCalibStats` (5 days hourly stats) covers days 2-5 in the past so the per-day chips on the timeline keep showing real
    //    figures instead of falling silently to zero.
    //Days covered by `_pvHistory` are integrated from that slot only; the stats slot fills in days the raw window does not reach.
    const unit = (host._pvUnit || '').toLowerCase();
    const isCumulativeEnergy = unit === 'wh' || unit === 'kwh' || unit === 'mwh';

    const rawHist = host._pvHistory;
    const rawFirstMs = (rawHist && rawHist.times.length > 0) ? rawHist.times[0].getTime() : null;
    const rawLastMs  = (rawHist && rawHist.times.length > 0) ? rawHist.times[rawHist.times.length - 1].getTime() : null;

    const integrate = (
        h:           PvHistory,
        bucketGuard: (tMs: number) => boolean,
    ): void =>
    {
        if (isCumulativeEnergy)
        {
            //Cumulative energy sensor: difference consecutive
            //samples and sum the deltas per day. Counter resets
            //(dv < 0) are dropped, same convention the chart uses.
            for (let i = 1; i < h.times.length; i++)
            {
                const tMs = h.times[i].getTime();
                if (tMs < startMs || tMs > endMsAbs)
                {
                    continue;
                }
                if (!bucketGuard(tMs))
                {
                    continue;
                }
                const dv = h.values[i] - h.values[i - 1];
                if (!isFinite(dv) || dv < 0)
                {
                    continue;
                }
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
            for (let i = 1; i < h.times.length; i++)
            {
                const tCurrMs = h.times[i].getTime();
                if (tCurrMs < startMs || tCurrMs > endMsAbs)
                {
                    continue;
                }
                if (!bucketGuard(tCurrMs))
                {
                    continue;
                }
                const tPrevMs = h.times[i - 1].getTime();
                const dtH = (tCurrMs - tPrevMs) / 3_600_000;
                if (dtH <= 0 || dtH > 6)
                {
                    continue;
                }
                const wPrev = pvNormalizeToWatts(h.values[i - 1], host._pvUnit);
                const wCurr = pvNormalizeToWatts(h.values[i],     host._pvUnit);
                if (!isFinite(wPrev) || !isFinite(wCurr))
                {
                    continue;
                }
                const kwh = ((wPrev + wCurr) / 2) * dtH / 1000;
                const k = dayKey(tCurrMs);
                out.set(k, (out.get(k) ?? 0) + kwh);
            }
        }
    };

    if (rawHist && rawHist.times.length >= 2)
    {
        //Full integration over the raw slot; no gating, raw is authoritative for the days it covers.
        integrate(rawHist, () => true);
    }
    const calib = host._pvCalibStats;
    if (calib && calib.times.length >= 2)
    {
        //Stats slot fills the wider days only. A sample whose timestamp falls within the raw window is already counted; skip it.
        integrate(calib, (tMs) =>
        {
            if (rawFirstMs === null || rawLastMs === null)
            {
                return true;
            }
            return tMs < rawFirstMs || tMs > rawLastMs;
        });
    }

    //Pass 2: future + today-remainder from the forecast model.
    //Skipped silently when peak power is unset (no model, no
    //forecast, only past observation contributes). Forecast kWh
    //is multiplied by the 5-day rolling calibration ratio so the
    //per-day chips match the "refined" dashboard headline + the
    //dotted forecast curve next to them, then clipped at the
    //inverter PMax so a bright midday hour can't push the daily
    //total above what the hardware would actually deliver.
    const k        = pvCalibK(host.config);   //W per percent of STC
    const series   = host._chartSeries;
    const coords   = getHomeCoords(host.config, host.hass);
    const cal      = computeForecastCalibration(host);
    const calR     = cal ? cal.ratio : 1;
    trainShadingMap(host);
    const shading  = currentShadingMap();
    const capW     = pvInverterMaxW(host.config);
    if (k !== null && k > 0 && series && coords)
    {
        //Index hourly forecast samples by hour-floor ms so we can integrate them by 1-hour rectangles per day. The series timestamps are already at
        //hour boundaries from the engine's resampling.
        const nowMs  = Date.now();
        const raster = host._engine?.getLidarRaster() ?? null;
        for (let i = 0; i < series.times.length; i++)
        {
            const tMs   = series.times[i].getTime();
            if (tMs < startMs || tMs > endMsAbs)
            {
                continue;
            }
            if (tMs < nowMs) continue;   //past covered by Pass 1
            const cloud = series.cloud[i] ?? 0;
            const pct   = computePvPowerWeighted(host.config, series.times[i], coords.lat, coords.lon, cloud, {
                airTempC: series.temperature[i],
                windMs:   series.windSpeed[i],
                raster,
            });
            if (pct <= 0)
            {
                continue;
            }
            //pct × k = watts at this hour midpoint × 1h = Wh.
            //Divide by 1000 to land in kWh; clip first so the
            //daily total honours the inverter cap.
            const eff   = effectiveForecastRatio(shading, series.times[i], coords.lat, coords.lon, cloud, calR, nowMs);
            const watts = Math.min(capW, pct * k * eff);
            const kwh   = watts / 1000;
            const dk    = dayKey(tMs);
            out.set(dk, (out.get(dk) ?? 0) + kwh);
        }
    }

    return out;
}
