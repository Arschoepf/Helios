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
import { navigateDashDay } from './dashboard';
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
//Concentric ANNULI with breathing gaps between them. The whole layout was rescaled +6 % vs v3 now
//that the CoverFlow cards are wider (5 / 7 aspect ratio instead of 4 / 7). Each data ring has an
//explicit inner edge, outer edge and a 4 unit gap before the next ring. The dial ring is wide enough
//to host its hour labels INSIDE it at the mid-annulus, plus the hour / half / quarter ticks against
//BOTH its outer and inner edges (mirrored).
const R_SUN_REF                = 55;   //reference rim circle, also irradiance max disc radius
const R_CLOUD_INNER            = 63;
const R_CLOUD_OUTER            = 91;
const R_PROD_INNER             = 97;
const R_PROD_OUTER             = 125;
const R_CONS_INNER             = 131;
const R_CONS_OUTER             = 159;
const R_DIAL_INNER             = 165;
const R_DIAL_OUTER             = 197;
const R_HOUR_LABEL             = R_DIAL_INNER + (R_DIAL_OUTER - R_DIAL_INNER) * 0.5;  //labels centred inside the dial annulus
//Tick layout. Each tick has two endpoints inside the dial annulus, one on the OUTER side (close to
//R_DIAL_OUTER) and one on the INNER side (close to R_DIAL_INNER). The hour / half / quarter triplet
//uses different lengths so the eye still snaps to the hour cardinals.
//Outer side endpoints, anchored at the outer edge of the dial:
const R_TICK_OUTER_END         = R_DIAL_OUTER - 1;
const R_TICK_OUTER_HOUR        = R_DIAL_OUTER - 8;
const R_TICK_OUTER_HALF        = R_DIAL_OUTER - 6;
const R_TICK_OUTER_QUARTER     = R_DIAL_OUTER - 3;
//Inner side endpoints, anchored at the inner edge of the dial (mirror of the outer side):
const R_TICK_INNER_END         = R_DIAL_INNER + 1;
const R_TICK_INNER_HOUR        = R_DIAL_INNER + 8;
const R_TICK_INNER_HALF        = R_DIAL_INNER + 6;
const R_TICK_INNER_QUARTER     = R_DIAL_INNER + 3;

const HOUR_MS                  = 3_600_000;
const DAY_MS                   = 24 * HOUR_MS;


//Polar -> Cartesian helper. Angle convention is documented at the top of the file.
function polarPt(hour: number, radius: number, cx: number = CENTER, cy: number = CENTER): [number, number]
{
    const alpha = ((hour - 12) / 12) * Math.PI;
    return [cx + radius * Math.sin(alpha), cy - radius * Math.cos(alpha)];
}


//Annulus fill path bounded between the inner edge (fixed at innerRadius) and a variable outer
//curve that traces the per-hour data values. Emits two subpaths so SVG fill-rule="evenodd" carves
//out the area between them; the inner circle alone would have made the fill spill all the way to
//the centre, the earlier "closed polygon from the centre" recipe likewise. Sub-hour interpolation
//(3 vertices per hour gap) keeps the variable curve visually smooth without paying for a true spline.
function buildRadialAnnulusPath(
    perHourValues: ReadonlyArray<number | null>,
    scaleMax:      number,
    innerRadius:   number,
    outerRadius:   number,
): string
{
    if (perHourValues.length !== 24 || scaleMax <= 0)
    {
        return '';
    }
    let d = '';
    //Outer curve, variable per hour.
    for (let h = 0; h < 24; h++)
    {
        const v     = perHourValues[h];
        const r     = v === null ? innerRadius : innerRadius + Math.max(0, Math.min(1, v / scaleMax)) * (outerRadius - innerRadius);
        const next  = perHourValues[(h + 1) % 24];
        const rNext = next === null ? innerRadius : innerRadius + Math.max(0, Math.min(1, next / scaleMax)) * (outerRadius - innerRadius);
        for (const f of [0, 1/3, 2/3])
        {
            const hour = h + f;
            const ri   = r + (rNext - r) * f;
            const [x, y] = polarPt(hour, ri);
            d += (d === '' ? 'M ' : ' L ') + x.toFixed(2) + ' ' + y.toFixed(2);
        }
    }
    d += ' Z';
    //Inner edge: fixed circle at innerRadius. 48 vertices for a visually smooth fill boundary.
    {
        const [x0, y0] = polarPt(0, innerRadius);
        d += ' M ' + x0.toFixed(2) + ' ' + y0.toFixed(2);
        for (let i = 1; i <= 48; i++)
        {
            const [x, y] = polarPt((i / 48) * 24, innerRadius);
            d += ' L ' + x.toFixed(2) + ' ' + y.toFixed(2);
        }
        d += ' Z';
    }
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
//convention as the rest of the file. The v2 implementation mapped angle 0 to hour 0, which mirrored
//the dial: the pointer sitting at 2 a.m. resolved to 14:00 and vice versa. The dial places 12:00 at
//angle 0 (top), so the inverse must add 12 before wrapping back into [0, 24).
function pointerToHourFraction(svgEl: SVGSVGElement, clientX: number, clientY: number): number
{
    const rect = svgEl.getBoundingClientRect();
    const dx   = clientX - (rect.left + rect.width  / 2);
    const dy   = clientY - (rect.top  + rect.height / 2);
    if (dx === 0 && dy === 0) { return 12; }
    //atan2(dx, -dy) yields 0 at top, +pi/2 at right, +/-pi at bottom, -pi/2 at left. Add 2*pi to
    //wrap the lower half into positive.
    let a = Math.atan2(dx, -dy);
    if (a < 0) { a += 2 * Math.PI; }
    //angle 0 -> hour 12 (top of dial), angle pi -> hour 0 (bottom), wrap into [0, 24).
    let hour = 12 + (a / (2 * Math.PI)) * 24;
    if (hour >= 24) { hour -= 24; }
    return hour;
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

    //Scales are RELATIVE to the day's own max so the visual variation of each ring reads cleanly.
    //Anchoring on the inverter cap (5+ kW) used to make the production ring sit at 30 to 50 % of
    //the available height for the whole sunlight window, so the bell-shape of the day flattened
    //into a thin uniform band. With a day-relative scale plus a 25 % headroom, peak hours fill the
    //ring and dip hours read as a clear narrowing.
    let prodMax = 0;
    for (const v of hourlyProd) { if (v !== null && v > prodMax) { prodMax = v; } }
    const prodScaleMax  = Math.max(1, prodMax * 1.25, 500);
    let   consMax       = 0;
    for (const v of hourlyCons) { if (v !== null && v > consMax) { consMax = v; } }
    const consScaleMax  = Math.max(1, consMax * 1.25, 2000);
    const cloudScaleMax = 100;

    //Slice the arrays by the past / future boundary. Past hours feed the solid fills, future hours
    //feed the dashed outlines. Consumption has no future data so its future portion is always empty.
    const ceilPastH = Math.ceil(pastEndHour);
    const floorPastH = Math.floor(pastEndHour);
    const prodPastPath = pastEndHour > 0
        ? buildRadialAnnulusPath(hourlyProd.slice(0, ceilPastH).concat(new Array(24 - ceilPastH).fill(null)), prodScaleMax, R_PROD_INNER, R_PROD_OUTER)
        : '';
    const prodFuturePath = pastEndHour < 24
        ? buildRadialOutlinePath(hourlyProd, prodScaleMax, R_PROD_INNER, R_PROD_OUTER, floorPastH, 24)
        : '';
    const consPastPath = pastEndHour > 0
        ? buildRadialAnnulusPath(hourlyCons.slice(0, ceilPastH).concat(new Array(24 - ceilPastH).fill(null)), consScaleMax, R_CONS_INNER, R_CONS_OUTER)
        : '';
    const cloudPastPath = pastEndHour > 0
        ? buildRadialAnnulusPath(hourlyCloud.slice(0, ceilPastH).concat(new Array(24 - ceilPastH).fill(null)), cloudScaleMax, R_CLOUD_INNER, R_CLOUD_OUTER)
        : '';
    const cloudFuturePath = pastEndHour < 24
        ? buildRadialOutlinePath(hourlyCloud, cloudScaleMax, R_CLOUD_INNER, R_CLOUD_OUTER, floorPastH, 24)
        : '';

    const { ratioPct } = computeDailyIrradianceRatio(host, dayStartMs);
    const sunFillR     = R_SUN_REF * (ratioPct / 100);

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
    const hoverActive = (hoverHour !== null && hoverHour !== undefined);
    const hoverCursor = hoverActive
        ? `M ${polarPt(hoverHour as number, R_SUN_REF)[0].toFixed(2)} ${polarPt(hoverHour as number, R_SUN_REF)[1].toFixed(2)} L ${polarPt(hoverHour as number, R_DIAL_OUTER)[0].toFixed(2)} ${polarPt(hoverHour as number, R_DIAL_OUTER)[1].toFixed(2)}`
        : '';

    //Hover spheres: one on each curve at the hover-hour radius. The radius interpolates between
    //adjacent hour samples so the sphere slides smoothly along the curve as the cursor moves. Each
    //sphere is a small circle (4 viewBox units) filled with a per-curve radial gradient that
    //simulates a light source at the upper-left, giving the dot a 3D ball look rather than the
    //flat-disc look of a plain <circle> + solid fill.
    const interpRadius = (values: ReadonlyArray<number | null>, scaleMax: number, innerR: number, outerR: number, hour: number): number =>
    {
        const hWhole = Math.floor(hour) % 24;
        const f      = hour - Math.floor(hour);
        const v      = values[hWhole];
        const next   = values[(hWhole + 1) % 24];
        const r      = v === null    ? innerR : innerR + Math.max(0, Math.min(1, v    / scaleMax)) * (outerR - innerR);
        const rNext  = next === null ? innerR : innerR + Math.max(0, Math.min(1, next / scaleMax)) * (outerR - innerR);
        return r + (rNext - r) * f;
    };
    let hoverProdSphere:  { x: number; y: number } | null = null;
    let hoverConsSphere:  { x: number; y: number } | null = null;
    let hoverCloudSphere: { x: number; y: number } | null = null;
    if (hoverActive)
    {
        const hf  = hoverHour as number;
        const idx = Math.max(0, Math.min(23, Math.floor(hf)));
        //Only paint a sphere when the curve actually has a value at that hour, otherwise the
        //sphere would slam into the inner edge and read as a stuck dot.
        const prodVal  = hourlyProd[idx];
        const consVal  = hourlyCons[idx];
        const cloudVal = hourlyCloud[idx];
        if (prodVal  !== null) { const r = interpRadius(hourlyProd,  prodScaleMax,  R_PROD_INNER,  R_PROD_OUTER,  hf); const [x, y] = polarPt(hf, r); hoverProdSphere  = { x, y }; }
        if (consVal  !== null) { const r = interpRadius(hourlyCons,  consScaleMax,  R_CONS_INNER,  R_CONS_OUTER,  hf); const [x, y] = polarPt(hf, r); hoverConsSphere  = { x, y }; }
        if (cloudVal !== null) { const r = interpRadius(hourlyCloud, cloudScaleMax, R_CLOUD_INNER, R_CLOUD_OUTER, hf); const [x, y] = polarPt(hf, r); hoverCloudSphere = { x, y }; }
    }

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

    //Sub-hour + hour ticks. 96 positions around the dial (15 min step). Each tick paints TWO line
    //segments, one on the outer side of the dial annulus and one mirrored on the inner side (close
    //to the centre of the SVG), so the user sees the markers no matter which edge of the dial they
    //look at. The hour, half and quarter triplet uses three different lengths + opacities so the
    //eye still snaps to the hour cardinals first, then the halves, then the quarters.
    const tickLines: TemplateResult[] = [];
    for (let q = 0; q < 96; q++)
    {
        const hour    = q / 4;
        const isHour  = q % 4 === 0;
        const isHalf  = !isHour && q % 2 === 0;
        const innerInnerR = isHour ? R_TICK_INNER_HOUR : isHalf ? R_TICK_INNER_HALF : R_TICK_INNER_QUARTER;
        const outerInnerR = isHour ? R_TICK_OUTER_HOUR : isHalf ? R_TICK_OUTER_HALF : R_TICK_OUTER_QUARTER;
        const cls = isHour ? 'dash-radial-tick-hour'
                  : isHalf ? 'dash-radial-tick-half'
                  :          'dash-radial-tick-quarter';
        //Outer side: anchored at R_TICK_OUTER_END (just inside the dial outer edge), extends inward.
        const [ox1, oy1] = polarPt(hour, R_TICK_OUTER_END);
        const [ox2, oy2] = polarPt(hour, outerInnerR);
        tickLines.push(svg`<line class="${cls}" x1="${ox1.toFixed(2)}" y1="${oy1.toFixed(2)}" x2="${ox2.toFixed(2)}" y2="${oy2.toFixed(2)}"/>`);
        //Inner side: anchored at R_TICK_INNER_END (just outside the dial inner edge), extends outward.
        const [ix1, iy1] = polarPt(hour, R_TICK_INNER_END);
        const [ix2, iy2] = polarPt(hour, innerInnerR);
        tickLines.push(svg`<line class="${cls}" x1="${ix1.toFixed(2)}" y1="${iy1.toFixed(2)}" x2="${ix2.toFixed(2)}" y2="${iy2.toFixed(2)}"/>`);
    }

    //Hour labels: 24 around the perimeter. Format respects HA's 12 / 24 setting. The label is rotated
    //radially so its top points outward from the centre (12 upright at top, 18 rotated 90 deg cw at
    //right, 0 upside-down at bottom, 6 rotated 90 deg ccw at left). The rotation matches the dial's
    //hand-of-a-clock convention so the user reads the numbers naturally walking around the dial.
    const hourLabels: TemplateResult[] = [];
    for (let h = 0; h < 24; h++)
    {
        const [x, y]   = polarPt(h, R_HOUR_LABEL);
        const lbl      = formatDialHourLabel(h, host.hass);
        const rotation = ((h - 12) % 24) * 15;
        hourLabels.push(svg`<text class="dash-radial-hour-label" x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="middle" dominant-baseline="central" transform="rotate(${rotation} ${x.toFixed(2)} ${y.toFixed(2)})">${lbl}</text>`);
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
    //Desktop wheel-scroll over the front card cycles through the day offsets, scroll-down advances
    //one day forward, scroll-up moves back one day. Wheel events are throttled by accumulating the
    //deltaY value, so a continuous trackpad swipe doesn't fire dozens of navigations per second.
    const onWheel = isFront ? (e: WheelEvent) =>
    {
        e.preventDefault();
        const acc = (host._dashRadialWheelAcc ?? 0) + e.deltaY;
        const THRESHOLD = 60;
        if (Math.abs(acc) >= THRESHOLD)
        {
            const dir = acc > 0 ? 1 : -1;
            host._dashRadialWheelAcc = 0;
            navigateDashDay(host, (host._dashDayOffset ?? 0) + dir);
        }
        else
        {
            host._dashRadialWheelAcc = acc;
        }
    } : undefined;

    const t12 = uses12HourFormat(host.hass);
    void t12;

    return html`
        <div class="dash-radial-wrap" @wheel="${onWheel}">
            <div class="dash-radial-corner dash-radial-corner-tl">
                <span class="dash-radial-corner-label">${t.detail.radialProductionLabel ?? t.detail.tileProductionLabel ?? 'Production'}</span>
                <span class="dash-radial-corner-value dash-radial-corner-prod">${formatW(host.hass, cornerProdW)}</span>
            </div>
            <div class="dash-radial-corner dash-radial-corner-tr">
                <span class="dash-radial-corner-label">${t.detail.radialImportLabel ?? t.detail.tileImportLabel ?? 'Import'}</span>
                <span class="dash-radial-corner-value dash-radial-corner-cons">${formatW(host.hass, cornerConsW)}</span>
            </div>
            <div class="dash-radial-corner dash-radial-corner-bl">
                <span class="dash-radial-corner-label">${t.detail.radialCloudLabel ?? 'Cloud'}</span>
                <span class="dash-radial-corner-value dash-radial-corner-cloud">${formatPct(host.hass, cornerCloudPct)}</span>
            </div>
            <div class="dash-radial-corner dash-radial-corner-br">
                <span class="dash-radial-corner-label">${t.detail.radialHourLabel ?? 'Time'}</span>
                <span class="dash-radial-corner-value dash-radial-corner-clock">${cornerClock ?? '—'}</span>
            </div>

            <svg
                class="dash-radial-svg"
                viewBox="0 0 ${VIEWBOX} ${VIEWBOX}"
                preserveAspectRatio="xMidYMid meet"
                @pointermove="${onPointerMove}"
                @pointerleave="${onPointerLeave}"
            >
                <defs>
                    <!-- Sphere gradients for the hover dots: each curve gets its own radial gradient
                         with a light highlight at the top-left of the dot, simulating a 3D ball lit
                         from the upper-left. This replaces the flat-disc look of a plain circle +
                         solid fill. -->
                    <radialGradient id="dash-radial-sphere-prod-${cardOffset}" cx="35%" cy="32%" r="65%">
                        <stop offset="0%"   stop-color="#ffffff" stop-opacity="0.85"/>
                        <stop offset="35%"  stop-color="var(--energy-solar-color, #ff9800)" stop-opacity="1"/>
                        <stop offset="100%" stop-color="#000000" stop-opacity="0.45"/>
                    </radialGradient>
                    <radialGradient id="dash-radial-sphere-cons-${cardOffset}" cx="35%" cy="32%" r="65%">
                        <stop offset="0%"   stop-color="#ffffff" stop-opacity="0.85"/>
                        <stop offset="35%"  stop-color="var(--energy-grid-consumption-color, #488fc2)" stop-opacity="1"/>
                        <stop offset="100%" stop-color="#000000" stop-opacity="0.45"/>
                    </radialGradient>
                    <radialGradient id="dash-radial-sphere-cloud-${cardOffset}" cx="35%" cy="32%" r="65%">
                        <stop offset="0%"   stop-color="#ffffff" stop-opacity="0.85"/>
                        <stop offset="35%"  stop-color="var(--secondary-text-color, rgba(255, 255, 255, 0.7))" stop-opacity="1"/>
                        <stop offset="100%" stop-color="#000000" stop-opacity="0.45"/>
                    </radialGradient>
                </defs>
                <!-- Ring tracks. Each track is a circle with stroke-width = annulus thickness, so
                     the visual is a real ring with breathing room between it and its neighbours.
                     The dial track is drawn here too because the hour labels + sub-hour ticks live
                     INSIDE the dial annulus and need its background to anchor them. -->
                <circle class="dash-radial-cloud-track" cx="${CENTER}" cy="${CENTER}" r="${(R_CLOUD_INNER + R_CLOUD_OUTER) / 2}"
                        fill="none" stroke-width="${R_CLOUD_OUTER - R_CLOUD_INNER}"/>
                <circle class="dash-radial-prod-track"  cx="${CENTER}" cy="${CENTER}" r="${(R_PROD_INNER  + R_PROD_OUTER)  / 2}"
                        fill="none" stroke-width="${R_PROD_OUTER - R_PROD_INNER}"/>
                <circle class="dash-radial-cons-track"  cx="${CENTER}" cy="${CENTER}" r="${(R_CONS_INNER  + R_CONS_OUTER)  / 2}"
                        fill="none" stroke-width="${R_CONS_OUTER - R_CONS_INNER}"/>
                <circle class="dash-radial-dial-track"  cx="${CENTER}" cy="${CENTER}" r="${(R_DIAL_INNER  + R_DIAL_OUTER)  / 2}"
                        fill="none" stroke-width="${R_DIAL_OUTER - R_DIAL_INNER}"/>

                <!-- Past fills (annulus shapes between the ring's inner edge and the per-hour data
                     curve) painted via the evenodd fill rule so the inner subpath carves the centre
                     of the donut shape cleanly. Future outlines are a simple polyline along the data
                     curve at the variable outer radius, no fill needed. Painted inside out so the
                     outer rings stay on top. -->
                ${cloudPastPath   ? svg`<path class="dash-radial-cloud-fill"   fill-rule="evenodd" d="${cloudPastPath}"/>`   : nothing}
                ${cloudFuturePath ? svg`<path class="dash-radial-cloud-future" d="${cloudFuturePath}"/>` : nothing}
                ${prodPastPath    ? svg`<path class="dash-radial-prod-fill"    fill-rule="evenodd" d="${prodPastPath}"/>`    : nothing}
                ${prodFuturePath  ? svg`<path class="dash-radial-prod-future"  d="${prodFuturePath}"/>`  : nothing}
                ${consPastPath    ? svg`<path class="dash-radial-cons-fill"    fill-rule="evenodd" d="${consPastPath}"/>`    : nothing}

                <!-- Sun: just a reference rim + a scaled inner fill. The diagram itself is enough
                     to read the irradiance ratio (the disc fills the rim at 100 %, vanishes at 0 %),
                     no numeric percentage on top. The visual matches the 3D card sun on the map. -->
                <circle class="dash-radial-sun-fill" cx="${CENTER}" cy="${CENTER}" r="${sunFillR.toFixed(2)}"/>
                <circle class="dash-radial-sun-rim"  cx="${CENTER}" cy="${CENTER}" r="${R_SUN_REF}"
                        fill="none"/>

                <!-- Sundial perimeter: quarter-hour ticks then hour labels. The labels themselves
                     anchor the hour positions, no separate full-tick is drawn. -->
                ${tickLines}
                ${hourLabels}

                <!-- Now cursor (today only). -->
                ${nowCursor   ? svg`<path class="dash-radial-cursor-now"   d="${nowCursor}"/>`   : nothing}

                <!-- Hover cursor (any front card with an active hover hour). -->
                ${hoverCursor ? svg`<path class="dash-radial-cursor-hover" d="${hoverCursor}"/>` : nothing}

                <!-- Hover spheres: one per data ring at the hover-hour value. Top layer so they are
                     always visible above the curves. -->
                ${hoverCloudSphere ? svg`<circle class="dash-radial-sphere" cx="${hoverCloudSphere.x.toFixed(2)}" cy="${hoverCloudSphere.y.toFixed(2)}" r="4" fill="url(#dash-radial-sphere-cloud-${cardOffset})"/>` : nothing}
                ${hoverProdSphere  ? svg`<circle class="dash-radial-sphere" cx="${hoverProdSphere.x.toFixed(2)}"  cy="${hoverProdSphere.y.toFixed(2)}"  r="4" fill="url(#dash-radial-sphere-prod-${cardOffset})"/>`  : nothing}
                ${hoverConsSphere  ? svg`<circle class="dash-radial-sphere" cx="${hoverConsSphere.x.toFixed(2)}"  cy="${hoverConsSphere.y.toFixed(2)}"  r="4" fill="url(#dash-radial-sphere-cons-${cardOffset})"/>`  : nothing}
            </svg>
        </div>
    `;
}
