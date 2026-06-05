//Helios radial sundial: the single SVG component at the centre of each CoverFlow day card.
//
//Concentric layout, inside -> outside:
//  - Centre: sun disc (irradiance % of summer-solstice clear-sky) + reference rim.
//  - Cloud ring: hourly cloud cover (% from the weather model series), past solid / future dashed.
//  - Production ring: hourly PV power, past solid / future dashed.
//  - Consumption ring: hourly home consumption from the grid net + PV reconstruction, past only.
//  - Sundial: 24 hour labels + 96 sub-hour ticks (4 per hour).
//
//Two cursors:
//  - Permanent "now" cursor on today's card, anchored at the outer edge of the irradiance reference
//    rim and ending at the outer dial edge.
//  - On-hover cursor, mirror of the now cursor in secondary text colour. Drives the corner labels
//    (top-left production, top-right consumption, bottom-left cloud, bottom-right hour).
//
//Angle convention (clockwise, noon at top):
//  hour 12 -> top              (0, -r)
//  hour 18 -> right            (+r, 0)
//  hour  0 -> bottom           (0, +r)
//  hour  6 -> left             (-r, 0)
//Implemented as alpha = (hour - 12) * pi / 12, then x = r * sin(alpha), y = -r * cos(alpha).

import { html, svg, nothing, type TemplateResult } from 'lit';
import type { DashboardHost } from './dashboard';
import { getSunPosition } from '../engine/sun';
import { pvInverterMaxW, pvNormalizeToWatts, computePvPowerWeighted } from './pv';
import { getHomeCoords } from './init';
import { gridWattsAtTime } from './grid';
import { formatLocalisedNumber } from './format';
import { pickTranslations } from '../i18n';


//Tighter geometry than the V1 prototype: outer dial shrunk from 195 to 165 viewBox units (15 %
//narrower visually), reference disc shrunk from 60 to 48 so the four rings have meaningful breathing
//room. ViewBox stays at 400 so external aspect ratios + max-width caps still apply consistently.
const VIEWBOX                  = 400;
const CENTER                   = 200;
const R_SUN_REF                = 48;   //reference rim circle (no background fill), also max disc radius
const R_CLOUD_INNER            = 56;
const R_CLOUD_OUTER            = 80;
const R_PROD_INNER             = 82;
const R_PROD_OUTER             = 110;
const R_CONS_INNER             = 112;
const R_CONS_OUTER             = 140;
const R_DIAL_INNER             = 145;
const R_DIAL_OUTER             = 162;
const R_HOUR_LABEL             = R_DIAL_OUTER + 11;  //label baseline radius

const HOUR_MS                  = 3_600_000;
const DAY_MS                   = 24 * HOUR_MS;


//Polar -> Cartesian helper. Angle convention is documented at the top of the file.
function polarPt(hour: number, radius: number, cx: number = CENTER, cy: number = CENTER): [number, number]
{
    const alpha = ((hour - 12) / 12) * Math.PI;
    return [cx + radius * Math.sin(alpha), cy - radius * Math.cos(alpha)];
}


//Closed radial fill path along the supplied per-hour radii. Sub-hour interpolation (3 vertices per
//hour gap) keeps the polygon visually smooth without paying for a true spline.
function buildRadialFillPath(
    perHourValues: ReadonlyArray<number | null>,
    scaleMax:      number,
    baseRadius:    number,
    outerRadius:   number,
): string
{
    if (perHourValues.length !== 24 || scaleMax <= 0)
    {
        return '';
    }
    let d = '';
    for (let h = 0; h < 24; h++)
    {
        const v     = perHourValues[h];
        const r     = v === null ? baseRadius : baseRadius + Math.max(0, Math.min(1, v / scaleMax)) * (outerRadius - baseRadius);
        const next  = perHourValues[(h + 1) % 24];
        const rNext = next === null ? baseRadius : baseRadius + Math.max(0, Math.min(1, next / scaleMax)) * (outerRadius - baseRadius);
        for (const f of [0, 1/3, 2/3])
        {
            const hour = h + f;
            const ri   = r + (rNext - r) * f;
            const [x, y] = polarPt(hour, ri);
            d += (d === '' ? 'M ' : ' L ') + x.toFixed(2) + ' ' + y.toFixed(2);
        }
    }
    d += ' Z';
    return d;
}


//Open radial outline path (no Z close). Used for the past portion when slicing by current hour.
function buildRadialOutlinePath(
    perHourValues: ReadonlyArray<number | null>,
    scaleMax:      number,
    baseRadius:    number,
    outerRadius:   number,
    fromHour:      number,
    toHour:        number,
): string
{
    if (scaleMax <= 0 || toHour <= fromHour)
    {
        return '';
    }
    let d = '';
    const stepHours = 1 / 3;
    for (let hour = fromHour; hour <= toHour + 1e-6; hour += stepHours)
    {
        const hWhole = Math.floor(hour) % 24;
        const f      = hour - Math.floor(hour);
        const v      = perHourValues[hWhole];
        const next   = perHourValues[(hWhole + 1) % 24];
        const r      = v === null ? baseRadius : baseRadius + Math.max(0, Math.min(1, v / scaleMax)) * (outerRadius - baseRadius);
        const rNext  = next === null ? baseRadius : baseRadius + Math.max(0, Math.min(1, next / scaleMax)) * (outerRadius - baseRadius);
        const ri     = r + (rNext - r) * f;
        const [x, y] = polarPt(hour, ri);
        d += (d === '' ? 'M ' : ' L ') + x.toFixed(2) + ' ' + y.toFixed(2);
    }
    return d;
}


//Hourly PV production (W). Past hours from the LTS / history merge, future hours from the
//weather-model forecast through computePvPowerWeighted (same path the timeline forecast curve uses).
function computeHourlyProduction(host: DashboardHost, dayStartMs: number): (number | null)[]
{
    const values: (number | null)[] = new Array(24).fill(null);
    const nowMs                     = Date.now();

    const calib = host._pvCalibStats;
    const hist  = host._pvHistory;
    const unit  = (host._pvUnit || '').toLowerCase();
    const isCum = unit === 'wh' || unit === 'kwh' || unit === 'mwh';

    const sums   = new Array(24).fill(0) as number[];
    const counts = new Array(24).fill(0) as number[];
    const ingestPower = (tMs: number, w: number): void =>
    {
        if (!Number.isFinite(w) || w < 0) { return; }
        if (tMs < dayStartMs || tMs >= dayStartMs + DAY_MS) { return; }
        const h = Math.floor((tMs - dayStartMs) / HOUR_MS);
        sums[h]   += w;
        counts[h] += 1;
    };

    if (calib && calib.times.length >= 2)
    {
        if (isCum)
        {
            let prevIdx = 0;
            for (let i = 1; i < calib.times.length; i++)
            {
                const t1  = calib.times[i].getTime();
                const t0  = calib.times[prevIdx].getTime();
                const dtH = (t1 - t0) / 3_600_000;
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
    if (hist && hist.times.length > 0 && !isCum)
    {
        for (let i = 0; i < hist.times.length; i++)
        {
            ingestPower(hist.times[i].getTime(), pvNormalizeToWatts(hist.values[i], host._pvUnit));
        }
    }
    for (let h = 0; h < 24; h++)
    {
        if (counts[h] > 0) { values[h] = sums[h] / counts[h]; }
    }

    //Forecast pass: walk the weather-model series, model panel output via the same call the timeline
    //forecast curve uses. Inverter cap clips the radius so an oversized array reads at the real
    //inverter ceiling, not at the theoretical panel output.
    const series = host._chartSeries;
    const coords = getHomeCoords(host.config, host.hass);
    const cap    = pvInverterMaxW(host.config);
    if (series && coords)
    {
        for (let h = 0; h < 24; h++)
        {
            const hourMs    = dayStartMs + h * HOUR_MS;
            const hourMidMs = hourMs + HOUR_MS / 2;
            if (hourMidMs < nowMs && values[h] !== null) { continue; }
            let bestIdx = -1;
            let bestDt  = Infinity;
            for (let i = 0; i < series.times.length; i++)
            {
                const dt = Math.abs(series.times[i].getTime() - hourMidMs);
                if (dt < bestDt) { bestDt = dt; bestIdx = i; }
            }
            if (bestIdx < 0 || bestDt > HOUR_MS) { continue; }
            const cloud = series.cloud[bestIdx] ?? 0;
            const w = computePvPowerWeighted(
                host.config,
                series.times[bestIdx],
                coords.lat,
                coords.lon,
                cloud,
                {
                    airTempC: series.temperature?.[bestIdx],
                    windMs:   series.windSpeed?.[bestIdx],
                    raster:   host._engine?.getLidarRaster() ?? null,
                }
            );
            if (Number.isFinite(w))
            {
                values[h] = Math.min(cap, Math.max(0, w));
            }
        }
    }
    for (let h = 0; h < 24; h++)
    {
        const hourMs = dayStartMs + h * HOUR_MS;
        if (values[h] === null && hourMs + HOUR_MS / 2 < nowMs)
        {
            values[h] = 0;
        }
    }
    return values;
}


//Hourly home consumption (W) reconstructed from grid net + PV history. Past only, future hours stay
//null (we have no consumption forecast). Cleanly nulls the hours past "now" so the ring fills only
//the realised portion of the day.
function computeHourlyConsumption(host: DashboardHost, dayStartMs: number): (number | null)[]
{
    const values: (number | null)[] = new Array(24).fill(null);
    const nowMs                     = Date.now();
    const sumGridAt = (tMs: number): number | null =>
    {
        const imp = gridWattsAtTime(host._gridImportSamples, host._gridImportUnits, tMs);
        const exp = gridWattsAtTime(host._gridExportSamples, host._gridExportUnits, tMs);
        if (imp === null && exp === null) { return null; }
        return (imp ?? 0) - (exp ?? 0);
    };
    for (let h = 0; h < 24; h++)
    {
        const hourMidMs = dayStartMs + h * HOUR_MS + HOUR_MS / 2;
        if (hourMidMs > nowMs) { break; }
        const gridNet = sumGridAt(hourMidMs);
        if (gridNet === null) { continue; }
        const pvSample = host._pvHistory && host._pvHistory.times.length > 0
            ? interpolatePvAt(host._pvHistory.times, host._pvHistory.values, hourMidMs, host._pvUnit)
            : 0;
        const w = Math.max(0, pvSample + gridNet);
        values[h] = w;
    }
    return values;
}


//Hourly cloud cover (%) over the day window. Pulled from the weather-model series which covers
//past 30 d + forecast 2 d, so cloud is uniformly available for past + future. Returns 0..100.
function computeHourlyCloud(host: DashboardHost, dayStartMs: number): (number | null)[]
{
    const values: (number | null)[] = new Array(24).fill(null);
    const series = host._chartSeries;
    if (!series || series.times.length === 0) { return values; }
    const sums   = new Array(24).fill(0) as number[];
    const counts = new Array(24).fill(0) as number[];
    for (let i = 0; i < series.times.length; i++)
    {
        const t = series.times[i].getTime();
        if (t < dayStartMs || t >= dayStartMs + DAY_MS) { continue; }
        const v = series.cloud[i];
        if (typeof v !== 'number' || !Number.isFinite(v)) { continue; }
        const h = Math.floor((t - dayStartMs) / HOUR_MS);
        sums[h]   += Math.max(0, Math.min(100, v));
        counts[h] += 1;
    }
    for (let h = 0; h < 24; h++)
    {
        if (counts[h] > 0) { values[h] = sums[h] / counts[h]; }
    }
    return values;
}


function interpolatePvAt(times: ReadonlyArray<Date>, values: ReadonlyArray<number>, tMs: number, unit: string): number
{
    if (times.length === 0) { return 0; }
    if (tMs <= times[0].getTime())                  { return pvNormalizeToWatts(values[0], unit); }
    if (tMs >= times[times.length - 1].getTime())   { return pvNormalizeToWatts(values[values.length - 1], unit); }
    for (let i = 1; i < times.length; i++)
    {
        const t1 = times[i].getTime();
        if (t1 < tMs) { continue; }
        const t0 = times[i - 1].getTime();
        if (t1 === t0) { return pvNormalizeToWatts(values[i], unit); }
        const f  = (tMs - t0) / (t1 - t0);
        const v  = values[i - 1] + (values[i] - values[i - 1]) * f;
        return pvNormalizeToWatts(v, unit);
    }
    return 0;
}


function computeDailyIrradianceRatio(host: DashboardHost, dayStartMs: number): { ratioPct: number; meanWm2: number }
{
    const series = host._chartSeries;
    if (!series || series.times.length === 0) { return { ratioPct: 0, meanWm2: 0 }; }
    const dayEndMs = dayStartMs + DAY_MS;
    let sum   = 0;
    let count = 0;
    for (let i = 0; i < series.times.length; i++)
    {
        const t = series.times[i].getTime();
        if (t < dayStartMs || t >= dayEndMs) { continue; }
        const sw = series.irradiance?.[i];
        if (typeof sw !== 'number' || !Number.isFinite(sw) || sw < 0) { continue; }
        sum += sw;
        count++;
    }
    if (count === 0) { return { ratioPct: 0, meanWm2: 0 }; }
    const meanWm2 = sum / count;
    const coords = getHomeCoords(host.config, host.hass);
    const lat    = coords?.lat ?? 0;
    const refWm2 = summerSolsticeReferenceWm2(lat);
    if (refWm2 <= 0) { return { ratioPct: 0, meanWm2 }; }
    const ratio  = Math.max(0, Math.min(1, meanWm2 / refWm2));
    return { ratioPct: ratio * 100, meanWm2 };
}


const _refMeanWm2Cache = new Map<number, number>();
function summerSolsticeReferenceWm2(lat: number): number
{
    const key = Math.round(lat);
    const cached = _refMeanWm2Cache.get(key);
    if (cached !== undefined) { return cached; }
    const year = new Date().getFullYear();
    const refDate = lat >= 0
        ? new Date(year, 5, 21, 0, 0, 0)
        : new Date(year, 11, 21, 0, 0, 0);
    let sum   = 0;
    for (let h = 0; h < 24; h += 0.5)
    {
        const t = new Date(refDate.getTime() + h * 3_600_000);
        const sun = getSunPosition(t, lat, 0);
        const altRad = sun.altitude * Math.PI / 180;
        if (altRad <= 0) { continue; }
        const cosZ = Math.sin(altRad);
        if (cosZ <= 0) { continue; }
        const ghi = 1098 * cosZ * Math.exp(-0.057 / cosZ);
        sum += ghi;
    }
    const total = sum / 48;
    _refMeanWm2Cache.set(key, total);
    return total;
}


//Resolve the HA-configured time format (12h vs 24h). 'language' / 'system' / unset all fall back to
//the language's Intl default so a fr-FR user lands on 24h, an en-US user on 12h, without us having
//to maintain a per-locale table.
function uses12HourFormat(hass: { locale?: { time_format?: string; language?: string }; language?: string } | undefined): boolean
{
    const tf = hass?.locale?.time_format;
    if (tf === '12') { return true; }
    if (tf === '24') { return false; }
    const lang = hass?.locale?.language || hass?.language || (typeof navigator !== 'undefined' ? navigator.language : 'en');
    try
    {
        const cycle = new Intl.DateTimeFormat(lang, { hour: 'numeric' }).resolvedOptions().hourCycle;
        return cycle === 'h11' || cycle === 'h12';
    }
    catch (_)
    {
        return false;
    }
}


//Convert a 0..23 integer hour into the label string for the dial face, respecting HA's 12 / 24
//format. The 12-hour layout maps 0 + 12 to "12", everything else to its 1..11 modulo so the dial
//reads like a classic analog clock face with AM hours on the morning quadrant and PM hours on the
//afternoon quadrant.
function formatDialHourLabel(hour: number, hass: { locale?: { time_format?: string; language?: string }; language?: string } | undefined): string
{
    if (uses12HourFormat(hass))
    {
        const h12 = hour % 12;
        return h12 === 0 ? '12' : String(h12);
    }
    return String(hour);
}


//Format a clock time for the corner pill, full locale + time format. "14:30" on fr-FR / 24 h,
//"2:30 PM" on en-US / 12 h.
function formatHoverClock(hourFraction: number, hass: { locale?: { time_format?: string; language?: string }; language?: string } | undefined): string
{
    const h = Math.floor(hourFraction);
    const m = Math.floor((hourFraction - h) * 60);
    const d = new Date(2000, 0, 1, h, m);
    const lang = hass?.locale?.language || hass?.language || 'en';
    try
    {
        return new Intl.DateTimeFormat(lang, {
            hour:     'numeric',
            minute:   '2-digit',
            hourCycle: uses12HourFormat(hass) ? 'h12' : 'h23',
        }).format(d);
    }
    catch (_)
    {
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    }
}


function formatW(hass: { language?: string } | undefined, w: number | null): string
{
    if (w === null || !Number.isFinite(w)) { return '—'; }
    if (Math.abs(w) >= 1000)
    {
        return `${formatLocalisedNumber(hass as any, w / 1000, 1)} kW`;
    }
    return `${formatLocalisedNumber(hass as any, Math.round(w), 0)} W`;
}


function formatPct(hass: { language?: string } | undefined, pct: number | null): string
{
    if (pct === null || !Number.isFinite(pct)) { return '—'; }
    return `${formatLocalisedNumber(hass as any, Math.round(pct), 0)} %`;
}


function dayStartMsFor(offset: number): number
{
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    return d.getTime();
}


function currentHourFraction(): number
{
    const now = new Date();
    return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
}


//Pointer -> hour conversion. Reads the SVG's bounding box, computes the angle of (clientX, clientY)
//relative to the centre and maps it into the [0, 24) hour range using the same noon-on-top clockwise
//convention as the rest of the file.
function pointerToHourFraction(svgEl: SVGSVGElement, clientX: number, clientY: number): number
{
    const rect = svgEl.getBoundingClientRect();
    const dx   = clientX - (rect.left + rect.width  / 2);
    const dy   = clientY - (rect.top  + rect.height / 2);
    if (dx === 0 && dy === 0) { return 0; }
    //atan2(dx, -dy) yields 0 at top, +pi/2 at right, +/-pi at bottom, -pi/2 at left. Add 2*pi to
    //wrap the lower half into positive, then scale.
    let a = Math.atan2(dx, -dy);
    if (a < 0) { a += 2 * Math.PI; }
    return (a / (2 * Math.PI)) * 24;
}


//Render the radial dial for one CoverFlow card. Front card is the only one that wires hover
//handlers, so a quiet rear card never costs a pointermove dispatch.
export function renderRadialDial(host: DashboardHost, cardOffset: number, activeOffset: number): TemplateResult
{
    const isFront    = cardOffset === activeOffset;
    const dayStartMs = dayStartMsFor(cardOffset);
    const dayEndMs   = dayStartMs + DAY_MS;
    const nowMs      = Date.now();
    const t          = pickTranslations(host.hass?.language);

    let pastEndHour: number;
    if (dayEndMs <= nowMs)        { pastEndHour = 24; }
    else if (dayStartMs >= nowMs) { pastEndHour = 0;  }
    else                          { pastEndHour = (nowMs - dayStartMs) / HOUR_MS; }

    const hourlyProd  = computeHourlyProduction(host, dayStartMs);
    const hourlyCons  = computeHourlyConsumption(host, dayStartMs);
    const hourlyCloud = computeHourlyCloud(host, dayStartMs);

    const prodScaleMax  = Math.max(1, pvInverterMaxW(host.config) || 5000);
    let   consMax       = 0;
    for (const v of hourlyCons) { if (v !== null && v > consMax) { consMax = v; } }
    const consScaleMax  = Math.max(1, consMax * 1.25, 2000);
    const cloudScaleMax = 100;

    //Slice the arrays by the past / future boundary. Past hours feed the solid fills, future hours
    //feed the dashed outlines. Consumption has no future data so its future portion is always empty.
    const ceilPastH = Math.ceil(pastEndHour);
    const floorPastH = Math.floor(pastEndHour);
    const prodPastPath = pastEndHour > 0
        ? buildRadialFillPath(hourlyProd.slice(0, ceilPastH).concat(new Array(24 - ceilPastH).fill(null)), prodScaleMax, R_PROD_INNER, R_PROD_OUTER)
        : '';
    const prodFuturePath = pastEndHour < 24
        ? buildRadialOutlinePath(hourlyProd, prodScaleMax, R_PROD_INNER, R_PROD_OUTER, floorPastH, 24)
        : '';
    const consPastPath = pastEndHour > 0
        ? buildRadialFillPath(hourlyCons.slice(0, ceilPastH).concat(new Array(24 - ceilPastH).fill(null)), consScaleMax, R_CONS_INNER, R_CONS_OUTER)
        : '';
    const cloudPastPath = pastEndHour > 0
        ? buildRadialFillPath(hourlyCloud.slice(0, ceilPastH).concat(new Array(24 - ceilPastH).fill(null)), cloudScaleMax, R_CLOUD_INNER, R_CLOUD_OUTER)
        : '';
    const cloudFuturePath = pastEndHour < 24
        ? buildRadialOutlinePath(hourlyCloud, cloudScaleMax, R_CLOUD_INNER, R_CLOUD_OUTER, floorPastH, 24)
        : '';

    const { ratioPct } = computeDailyIrradianceRatio(host, dayStartMs);
    const sunFillR     = R_SUN_REF * (ratioPct / 100);
    const haloR        = R_SUN_REF * 2.2;
    const haloAlpha    = Math.max(0.05, Math.min(0.55, ratioPct / 100 * 0.55));

    //Now cursor: only on the current day.
    const showNowCursor = isFront && nowMs >= dayStartMs && nowMs < dayEndMs;
    const nowHour       = showNowCursor ? currentHourFraction() : -1;
    const nowCursor = showNowCursor
        ? `M ${polarPt(nowHour, R_SUN_REF)[0].toFixed(2)} ${polarPt(nowHour, R_SUN_REF)[1].toFixed(2)} L ${polarPt(nowHour, R_DIAL_OUTER)[0].toFixed(2)} ${polarPt(nowHour, R_DIAL_OUTER)[1].toFixed(2)}`
        : '';

    //Hover cursor: only on the front card AND only when the host carries a hover hour set by the
    //pointermove handler below. Same shape as the now cursor but in secondary text colour so the
    //two read as a layered pair when the user hovers over the live day.
    const hoverHour = isFront ? host._dashRadialHoverHour : null;
    const hoverCursor = (hoverHour !== null && hoverHour !== undefined)
        ? `M ${polarPt(hoverHour, R_SUN_REF)[0].toFixed(2)} ${polarPt(hoverHour, R_SUN_REF)[1].toFixed(2)} L ${polarPt(hoverHour, R_DIAL_OUTER)[0].toFixed(2)} ${polarPt(hoverHour, R_DIAL_OUTER)[1].toFixed(2)}`
        : '';

    //Corner read-outs. When hovering, every corner snaps to the hover hour. Otherwise the production
    //and consumption corners show the "now" reading (today) or the daily mean (past / forecast), the
    //cloud corner shows the day's mean cloud cover, and the clock corner shows "now" or the day's
    //friendly label.
    const meanOf = (arr: ReadonlyArray<number | null>): number | null =>
    {
        let s = 0, c = 0;
        for (const v of arr) { if (v !== null) { s += v; c++; } }
        return c > 0 ? s / c : null;
    };
    const hourIdxFor = (hf: number): number => Math.max(0, Math.min(23, Math.floor(hf)));

    let cornerProdW:    number | null = null;
    let cornerConsW:    number | null = null;
    let cornerCloudPct: number | null = null;
    let cornerClock:    string | null = null;

    if (hoverHour !== null && hoverHour !== undefined)
    {
        const idx        = hourIdxFor(hoverHour);
        cornerProdW      = hourlyProd[idx];
        cornerConsW      = hourlyCons[idx];
        cornerCloudPct   = hourlyCloud[idx];
        cornerClock      = formatHoverClock(hoverHour, host.hass);
    }
    else if (showNowCursor)
    {
        const idx        = hourIdxFor(nowHour);
        cornerProdW      = hourlyProd[idx];
        cornerConsW      = hourlyCons[idx];
        cornerCloudPct   = hourlyCloud[idx];
        cornerClock      = formatHoverClock(nowHour, host.hass);
    }
    else
    {
        cornerProdW      = meanOf(hourlyProd);
        cornerConsW      = meanOf(hourlyCons);
        cornerCloudPct   = meanOf(hourlyCloud);
        cornerClock      = null;
    }

    //Quarter-hour ticks: 24 hours * 4 = 96 ticks. The hour ticks (every 4 ticks) are NOT painted
    //here because the hour labels themselves anchor the eye on the cardinals; the user only asked
    //for the smaller quarter-hour marks.
    const quarterTicks: TemplateResult[] = [];
    for (let q = 0; q < 96; q++)
    {
        if (q % 4 === 0) { continue; }  //hour positions: the label takes its place
        const hour     = q / 4;
        const isHalf   = q % 2 === 0;
        const innerR   = R_DIAL_INNER;
        const outerR   = R_DIAL_INNER + (isHalf ? 5 : 3);
        const [x1, y1] = polarPt(hour, innerR);
        const [x2, y2] = polarPt(hour, outerR);
        const cls      = isHalf ? 'dash-radial-tick-half' : 'dash-radial-tick-quarter';
        quarterTicks.push(svg`<line class="${cls}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`);
    }

    //Hour labels: 24 around the perimeter. Format respects HA's 12 / 24 setting. Skip 13..23 when
    //the dial is in 12-hour mode AND the layout already shows their 1..11 counterparts on the
    //afternoon quadrant. We DO render the duplicate label so the clock reads like a real analog face
    //(both 1 AM and 1 PM share the same digit, the position carries the meaning).
    const hourLabels: TemplateResult[] = [];
    for (let h = 0; h < 24; h++)
    {
        const [x, y] = polarPt(h, R_HOUR_LABEL);
        const lbl    = formatDialHourLabel(h, host.hass);
        hourLabels.push(svg`<text class="dash-radial-hour-label" x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="middle" dominant-baseline="central">${lbl}</text>`);
    }

    //Pointer handlers (front card only). Imperative because every pointermove on a multi-second
    //hover would otherwise rebuild the whole template; here we set the host's hover hour and call
    //requestUpdate so Lit batches the render at the next microtask, which is fast enough at the
    //single-svg granularity to feel live.
    const onPointerMove = isFront ? (e: PointerEvent) =>
    {
        const svgEl = (e.currentTarget as SVGSVGElement | null);
        if (!svgEl) { return; }
        const hf = pointerToHourFraction(svgEl, e.clientX, e.clientY);
        host._dashRadialHoverHour = hf;
        host.requestUpdate();
    } : undefined;
    const onPointerLeave = isFront ? () =>
    {
        host._dashRadialHoverHour = null;
        host.requestUpdate();
    } : undefined;

    const t12 = uses12HourFormat(host.hass);
    void t12;

    return html`
        <div class="dash-radial-wrap">
            <div class="dash-radial-corner dash-radial-corner-tl">
                <span class="dash-radial-corner-label">${t.detail.tileProductionLabel ?? 'Production'}</span>
                <span class="dash-radial-corner-value dash-radial-corner-prod">${formatW(host.hass, cornerProdW)}</span>
            </div>
            <div class="dash-radial-corner dash-radial-corner-tr">
                <span class="dash-radial-corner-label">${t.detail.tileImportLabel ?? 'Consumption'}</span>
                <span class="dash-radial-corner-value dash-radial-corner-cons">${formatW(host.hass, cornerConsW)}</span>
            </div>
            <div class="dash-radial-corner dash-radial-corner-bl">
                <span class="dash-radial-corner-label">${t.detail.todayPeak ? 'Cloud' : 'Cloud'}</span>
                <span class="dash-radial-corner-value dash-radial-corner-cloud">${formatPct(host.hass, cornerCloudPct)}</span>
            </div>
            ${cornerClock !== null ? html`
                <div class="dash-radial-corner dash-radial-corner-br">
                    <span class="dash-radial-corner-label">${t.detail.todayLabel ?? 'Time'}</span>
                    <span class="dash-radial-corner-value dash-radial-corner-clock">${cornerClock}</span>
                </div>
            ` : nothing}

            <svg
                class="dash-radial-svg"
                viewBox="0 0 ${VIEWBOX} ${VIEWBOX}"
                preserveAspectRatio="xMidYMid meet"
                @pointermove="${onPointerMove}"
                @pointerleave="${onPointerLeave}"
            >
                <defs>
                    <radialGradient id="dash-radial-sun-halo-${cardOffset}">
                        <stop offset="0%"   stop-color="var(--helios-sun-color, #f59e0b)" stop-opacity="${haloAlpha}"/>
                        <stop offset="100%" stop-color="var(--helios-sun-color, #f59e0b)" stop-opacity="0"/>
                    </radialGradient>
                </defs>

                <!-- Ring tracks, lowest layer of the rings so the data curves paint cleanly on top. -->
                <circle class="dash-radial-cloud-track" cx="${CENTER}" cy="${CENTER}" r="${(R_CLOUD_INNER + R_CLOUD_OUTER) / 2}"
                        fill="none" stroke-width="${R_CLOUD_OUTER - R_CLOUD_INNER}"/>
                <circle class="dash-radial-prod-track"  cx="${CENTER}" cy="${CENTER}" r="${(R_PROD_INNER  + R_PROD_OUTER)  / 2}"
                        fill="none" stroke-width="${R_PROD_OUTER - R_PROD_INNER}"/>
                <circle class="dash-radial-cons-track"  cx="${CENTER}" cy="${CENTER}" r="${(R_CONS_INNER  + R_CONS_OUTER)  / 2}"
                        fill="none" stroke-width="${R_CONS_OUTER - R_CONS_INNER}"/>

                <!-- Past + future curves, painted inside out so the outer rings stay on top. -->
                ${cloudPastPath   ? svg`<path class="dash-radial-cloud-fill"   d="${cloudPastPath}"/>`   : nothing}
                ${cloudFuturePath ? svg`<path class="dash-radial-cloud-future" d="${cloudFuturePath}"/>` : nothing}
                ${prodPastPath    ? svg`<path class="dash-radial-prod-fill"    d="${prodPastPath}"/>`    : nothing}
                ${prodFuturePath  ? svg`<path class="dash-radial-prod-future"  d="${prodFuturePath}"/>`  : nothing}
                ${consPastPath    ? svg`<path class="dash-radial-cons-fill"    d="${consPastPath}"/>`    : nothing}

                <!-- Sun: halo (radial gradient), scaled inner fill, reference rim. No tinted bg disc:
                     the user asked for a single rim + a single inner fill matching the 3D card sun. -->
                <circle class="dash-radial-sun-halo" cx="${CENTER}" cy="${CENTER}" r="${haloR}"
                        fill="url(#dash-radial-sun-halo-${cardOffset})"/>
                <circle class="dash-radial-sun-fill" cx="${CENTER}" cy="${CENTER}" r="${sunFillR.toFixed(2)}"/>
                <circle class="dash-radial-sun-rim"  cx="${CENTER}" cy="${CENTER}" r="${R_SUN_REF}"
                        fill="none"/>

                <!-- Irradiance percentage centred on the disc, permanent. -->
                <text class="dash-radial-irrad-label" x="${CENTER}" y="${CENTER}" text-anchor="middle" dominant-baseline="central">
                    ${Math.round(ratioPct)}%
                </text>

                <!-- Sundial perimeter: quarter-hour ticks then hour labels. The labels themselves
                     anchor the hour positions, no separate full-tick is drawn. -->
                ${quarterTicks}
                ${hourLabels}

                <!-- Now cursor (today only). -->
                ${nowCursor   ? svg`<path class="dash-radial-cursor-now"   d="${nowCursor}"/>`   : nothing}

                <!-- Hover cursor (any front card with an active hover hour). -->
                ${hoverCursor ? svg`<path class="dash-radial-cursor-hover" d="${hoverCursor}"/>` : nothing}
            </svg>
        </div>
    `;
}
