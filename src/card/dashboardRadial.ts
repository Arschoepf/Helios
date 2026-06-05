//Helios radial sundial: a single SVG component that lives at the centre of each CoverFlow day card.
//Replaces the cumulative chart + production / forecast mini-tiles introduced in the alpha cycle. The
//design is a 24-hour polar clock around a central sun disc whose radius scales with the day's
//irradiance ratio against the local summer-solstice clear-sky reference:
//
//  - Centre: sun disc + reference circle. Disc radius = irradiance ratio, percentage shown as a
//    numeric label centred on the disc.
//  - Inner ring: radial production curve, hour theta vs power radius. Past hours render as a solid
//    fill below the curve, future hours as a dashed outline only (same vocabulary as the timeline
//    forecast curve so the past / future split reads consistently across the card).
//  - Outer ring: radial consumption curve, same shape semantics as the production curve.
//  - Sundial perimeter: 24 hour ticks, longer ticks at 0 / 6 / 12 / 18, current-hour cursor anchored
//    at the outside of the irradiance reference circle and ending at the outer dial edge.
//
//Angle convention (clockwise, noon at top):
//
//  hour 12 -> top              (0, -r)
//  hour 18 -> right            (+r, 0)
//  hour  0 -> bottom           (0, +r)
//  hour  6 -> left             (-r, 0)
//
//Implemented as alpha = (hour - 12) * pi / 12 then x = r * sin(alpha), y = -r * cos(alpha).

import { html, svg, nothing, type TemplateResult } from 'lit';
import type { DashboardHost } from './dashboard';
import { getSunPosition } from '../engine/sun';
import { pvInverterMaxW, pvNormalizeToWatts, computePvPowerWeighted } from './pv';
import { getHomeCoords } from './init';
import { gridWattsAtTime, isGridCombined } from './grid';
import { formatLocalisedNumber } from './format';
import { pickTranslations } from '../i18n';


//Geometry constants. SVG viewBox is square so the dial reads as a true circle at any aspect ratio
//and CSS preserveAspectRatio="xMidYMid meet" keeps it centred in the parent slot.
const VIEWBOX                  = 400;
const CENTER                   = 200;
const R_IRRAD_REF              = 60;   //irradiance reference circle radius, also max sun disc radius
const R_PROD_INNER             = 70;   //inner edge of the production ring track
const R_PROD_OUTER             = 115;  //outer edge of the production ring track
const R_CONS_INNER             = 125;  //inner edge of the consumption ring track
const R_CONS_OUTER             = 165;  //outer edge of the consumption ring track
const R_DIAL_INNER             = 174;  //inner edge of the sundial perimeter
const R_DIAL_OUTER             = 195;  //outer edge of the sundial perimeter

const HOUR_TICK_INNER          = R_DIAL_INNER;
const HOUR_TICK_OUTER          = R_DIAL_OUTER;
const HOUR_TICK_OUTER_BIG      = R_DIAL_OUTER + 6;  //big ticks at 0 / 6 / 12 / 18 extend slightly outside

const HOUR_MS                  = 3_600_000;
const DAY_MS                   = 24 * HOUR_MS;


//Polar -> Cartesian helper. Angle convention is documented at the top of the file.
function polarPt(hour: number, radius: number, cx: number = CENTER, cy: number = CENTER): [number, number]
{
    const alpha = ((hour - 12) / 12) * Math.PI;
    return [cx + radius * Math.sin(alpha), cy - radius * Math.cos(alpha)];
}


//Build a closed radial polygon path along the supplied per-hour radii. Each hour gets a vertex at
//polarPt(hour, baseRadius + (perHourRadii[h] / scaleMax) * (outerRadius - baseRadius)). Hours with
//a null radius collapse to baseRadius so a missing-data hour reads as "zero". The path closes back
//to its first point so SVG fill applies cleanly.
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
        const v = perHourValues[h];
        const r = v === null
            ? baseRadius
            : baseRadius + Math.max(0, Math.min(1, v / scaleMax)) * (outerRadius - baseRadius);
        //Sample sub-hour to keep the polygon curved between integer hours instead of polygonal. Two
        //extra vertices per hour gap (at h + 1/3 and h + 2/3) read as a smooth ribbon at 24 hours
        //per turn without paying for a true spline.
        const subs = [0, 1/3, 2/3];
        for (const f of subs)
        {
            const hour = h + f;
            //Linearly interpolate radius between consecutive hour values for the sub-hour samples.
            const next  = perHourValues[(h + 1) % 24];
            const rNext = next === null
                ? baseRadius
                : baseRadius + Math.max(0, Math.min(1, next / scaleMax)) * (outerRadius - baseRadius);
            const ri = r + (rNext - r) * f;
            const [x, y] = polarPt(hour, ri);
            d += (d === '' ? 'M ' : ' L ') + x.toFixed(2) + ' ' + y.toFixed(2);
        }
    }
    d += ' Z';
    return d;
}


//Build an OPEN radial polyline path (no Z close), used for the forecast / future portion that
//renders as a dashed outline without fill. Same vertex recipe as buildRadialFillPath but starts and
//ends at the first / last in-range hour rather than wrapping the whole day.
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
    //Slice the supplied range with a step of 1/3 hour so the curve reads as smooth.
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


//Compute the day's hourly PV production in watts. Past hours pull from the LTS / history merge the
//timeline already uses, future hours from the weather-model forecast through computePvPowerWeighted
//(same path the line chart's predicted curve consumes, so the radial reading lines up with the rest
//of the card).
function computeHourlyProduction(host: DashboardHost, dayOffset: number, dayStartMs: number): (number | null)[] {
    const values: (number | null)[] = new Array(24).fill(null);
    const nowMs                     = Date.now();

    const calib = host._pvCalibStats;
    const hist  = host._pvHistory;
    const unit  = (host._pvUnit || '').toLowerCase();
    const isCum = unit === 'wh' || unit === 'kwh' || unit === 'mwh';

    //Past pass: aggregate samples that fall inside each hour bin into a mean watts value. Same
    //differentiation rules as the timeline (cumulative -> neighbour-pair slope, power -> direct).
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
                //kWh / h -> W. Cumulative entities report in Wh / kWh / MWh; multiply by 1000 only
                //when the unit is kWh (the default Helios assumption), other unit paths normalise
                //via pvNormalizeToWatts inside the timeline already.
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
        if (counts[h] > 0)
        {
            values[h] = sums[h] / counts[h];
        }
    }

    //Future pass: walk the weather-model series, model the panel output via the same call the
    //timeline forecast curve uses. Capped by the inverter max so a clear-sky midday for an
    //oversized array reads at the real inverter ceiling, not at the theoretical panel output.
    const series = host._chartSeries;
    const coords = getHomeCoords(host.config, host.hass);
    const cap    = pvInverterMaxW(host.config);
    if (series && coords)
    {
        for (let h = 0; h < 24; h++)
        {
            const hourMs    = dayStartMs + h * HOUR_MS;
            const hourMidMs = hourMs + HOUR_MS / 2;
            //Only fill future / forecast positions, the past pass owns the realised history.
            if (hourMidMs < nowMs && values[h] !== null) { continue; }
            //Find the nearest series sample to this hour.
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
    //Forward-fill production gaps in the past with 0 (no production observed = night), so the curve
    //reads as a continuous ribbon rather than a series of disconnected daytime arcs.
    for (let h = 0; h < 24; h++)
    {
        const hourMs = dayStartMs + h * HOUR_MS;
        if (values[h] === null && hourMs + HOUR_MS / 2 < nowMs)
        {
            values[h] = 0;
        }
    }

    //Touch dayOffset for completeness: the upstream caller resolves dayStartMs from dayOffset, the
    //branch above only needs dayStartMs and the offset is unused inside the body. Kept in the
    //signature so a future refinement (e.g. tomorrow's overnight forecast pulling from a different
    //series) can plug in without re-threading the call site.
    void dayOffset;

    return values;
}


//Hourly grid + battery samples folded into a per-hour home consumption series (W). Computed from
//the same buffers the timeline + dashboard cumulative chart already consume so the radial reading
//lines up with whatever the rest of the card surfaces.
function computeHourlyConsumption(host: DashboardHost, _dayOffset: number, dayStartMs: number): (number | null)[]
{
    const values: (number | null)[] = new Array(24).fill(null);
    const nowMs                     = Date.now();

    //Sum of per-entity grid net = import - export, signed positive when the home pulls from the
    //grid. The combined-meter case (one signed sensor) collapses to the same number via the import
    //buffer alone, which is how readCombined wires it in grid.ts. So we always read import - export,
    //the combined path just happens to push everything into the import buffer with the right sign.
    void isGridCombined;
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
        //Approximate consumption = PV production + grid net (net positive = importing, negative = exporting).
        //Battery is ignored at this pass, a small under-read on battery-charging hours and over-read on
        //discharging hours is acceptable for a visual indicator at 24 hour resolution.
        if (gridNet === null) { continue; }
        //Production already computed externally would be cleaner but the radial passes it through a
        //separate axis here on purpose, the consumption ring is meant to read independently.
        const pvSample = host._pvHistory && host._pvHistory.times.length > 0
            ? interpolatePvAt(host._pvHistory.times, host._pvHistory.values, hourMidMs, host._pvUnit)
            : 0;
        const w = Math.max(0, pvSample + gridNet);
        values[h] = w;
    }

    return values;
}


//Linear interpolation through a (sorted) times[] / values[] pair, returning the watts reading at
//tMs. Used by the consumption deriver above to align PV history sampling with the per-hour grid
//net. Outside the bracketed range returns 0.
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


//Mean shortwave irradiance over the day (W / m2). Past hours pull from the weather model's
//shortwave samples; future hours from the same series since it covers past 30 d + forecast 2 d. The
//mean is divided by the summer-solstice clear-sky reference for the home latitude to land the
//irradiance ratio that drives the central sun disc radius.
function computeDailyIrradianceRatio(host: DashboardHost, dayStartMs: number): { ratioPct: number; meanWm2: number }
{
    const series = host._chartSeries;
    if (!series || series.times.length === 0)
    {
        return { ratioPct: 0, meanWm2: 0 };
    }
    //Collect shortwave samples that fall inside the day window.
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

    //Reference: theoretical clear-sky shortwave at the home's latitude on the summer solstice. We
    //approximate it via the Haurwitz model integrated across the daylight hours of June 21. The
    //expensive parts (sun position lookup, cosine zenith integration) only depend on latitude so we
    //memoise per latitude bucket.
    const coords = getHomeCoords(host.config, host.hass);
    const lat    = coords?.lat ?? 0;
    const refWm2 = summerSolsticeReferenceWm2(lat);
    if (refWm2 <= 0) { return { ratioPct: 0, meanWm2 }; }
    const ratio    = Math.max(0, Math.min(1, meanWm2 / refWm2));
    return { ratioPct: ratio * 100, meanWm2 };
}


//Memoised summer-solstice reference, keyed on rounded latitude. Computes the integrated mean
//shortwave (W / m2) over a clear-sky June 21 at the user's latitude. Northern hemisphere homes get
//the June 21 reference, southern hemisphere homes the December 21 reference so the visualisation
//reads consistently for the user's actual peak-sun day.
const _refMeanWm2Cache = new Map<number, number>();
function summerSolsticeReferenceWm2(lat: number): number
{
    const key = Math.round(lat);
    const cached = _refMeanWm2Cache.get(key);
    if (cached !== undefined) { return cached; }
    //Build a reference date at the solar peak day (June 21 for NH, Dec 21 for SH).
    const year = new Date().getFullYear();
    const refDate = lat >= 0
        ? new Date(year, 5, 21, 0, 0, 0)
        : new Date(year, 11, 21, 0, 0, 0);
    let sum   = 0;
    let count = 0;
    for (let h = 0; h < 24; h += 0.5)
    {
        const t = new Date(refDate.getTime() + h * 3_600_000);
        const sun = getSunPosition(t, lat, 0);
        //getSunPosition returns degrees per the function's contract.
        const altRad = sun.altitude * Math.PI / 180;
        if (altRad <= 0) { continue; }
        //Haurwitz clear-sky shortwave at the surface: 1098 * cos(zenith) * exp(-0.057 / cos(zenith))
        const cosZ = Math.sin(altRad);
        if (cosZ <= 0) { continue; }
        const ghi = 1098 * cosZ * Math.exp(-0.057 / cosZ);
        sum += ghi;
        count++;
    }
    //Average across the whole 24 h window so the ratio compares "mean over the day" to the same
    //"mean over the day" reference, otherwise a winter day would never exceed ~10 % even at clear sky.
    const total = (count > 0 ? sum : 0) / 48;
    _refMeanWm2Cache.set(key, total);
    return total;
}


//Format a watts reading for the corner tooltips. kW with one decimal once the value crosses 1000 W,
//W with no decimal below.
function formatW(hass: { language?: string } | undefined | { language?: string }, w: number | null): string
{
    if (w === null || !Number.isFinite(w)) { return '—'; }
    if (Math.abs(w) >= 1000)
    {
        return `${formatLocalisedNumber(hass as any, w / 1000, 1)} kW`;
    }
    return `${formatLocalisedNumber(hass as any, Math.round(w), 0)} W`;
}


//Day-start ms helper, matches the calendar-day start the rest of the dashboard uses.
function dayStartMsFor(offset: number): number
{
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    return d.getTime();
}


//Current-hour fraction inside the [0, 24) range, used to position the cursor at sub-hour
//resolution so the trail follows the wall clock rather than jumping at every full hour.
function currentHourFraction(): number
{
    const now = new Date();
    return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
}


//Render the radial dial for one CoverFlow card. Called from renderCoverflowCard in dashboard.ts;
//returns a single <div> wrapper containing the SVG dial and the two corner labels.
export function renderRadialDial(host: DashboardHost, cardOffset: number, activeOffset: number): TemplateResult
{
    const isFront    = cardOffset === activeOffset;
    const dayStartMs = dayStartMsFor(cardOffset);
    const dayEndMs   = dayStartMs + DAY_MS;
    const nowMs      = Date.now();
    const t          = pickTranslations(host.hass?.language);

    //Decide where the past / future boundary sits inside this day's 24 h window. Past-only days
    //fill the full ring as a solid area, future-only days as a dashed outline, today straddles the
    //two with the boundary at the current hour fraction.
    let pastEndHour: number;
    if (dayEndMs <= nowMs)        { pastEndHour = 24; }
    else if (dayStartMs >= nowMs) { pastEndHour = 0;  }
    else                          { pastEndHour = (nowMs - dayStartMs) / HOUR_MS; }

    const hourlyProd = computeHourlyProduction(host, cardOffset, dayStartMs);
    const hourlyCons = computeHourlyConsumption(host, cardOffset, dayStartMs);

    //Scale floors. Production uses the configured inverter cap (or 5 kW as a safe default) so the
    //ring reads consistently across days. Consumption uses the max observed in the day plus a 25 %
    //headroom so a quiet day still shows visible variation.
    const prodScaleMax = Math.max(1, pvInverterMaxW(host.config) || 5000);
    let   consMax      = 0;
    for (const v of hourlyCons) { if (v !== null && v > consMax) { consMax = v; } }
    const consScaleMax = Math.max(1, consMax * 1.25, 2000);

    //Past + future paths for each ring.
    const prodPastPath = pastEndHour > 0
        ? buildRadialFillPath(hourlyProd.slice(0, Math.ceil(pastEndHour)).concat(new Array(24 - Math.ceil(pastEndHour)).fill(null)), prodScaleMax, R_PROD_INNER, R_PROD_OUTER)
        : '';
    const prodFuturePath = pastEndHour < 24
        ? buildRadialOutlinePath(hourlyProd, prodScaleMax, R_PROD_INNER, R_PROD_OUTER, Math.floor(pastEndHour), 24)
        : '';
    const consPastPath = pastEndHour > 0
        ? buildRadialFillPath(hourlyCons.slice(0, Math.ceil(pastEndHour)).concat(new Array(24 - Math.ceil(pastEndHour)).fill(null)), consScaleMax, R_CONS_INNER, R_CONS_OUTER)
        : '';

    //Irradiance ratio for the central sun disc.
    const { ratioPct } = computeDailyIrradianceRatio(host, dayStartMs);
    const sunFillR     = R_IRRAD_REF * (ratioPct / 100);
    const haloR        = R_IRRAD_REF * 2.2;
    const haloAlpha    = Math.max(0.05, Math.min(0.55, ratioPct / 100 * 0.55));

    //Cursor: only when this card represents the current calendar day. The cursor sits between the
    //irradiance reference circle and the outer sundial edge, at the current hour fraction.
    const showCursor   = isFront && nowMs >= dayStartMs && nowMs < dayEndMs;
    const cursorHour   = showCursor ? currentHourFraction() : -1;
    let cursorPath = '';
    if (showCursor)
    {
        const [x1, y1] = polarPt(cursorHour, R_IRRAD_REF);
        const [x2, y2] = polarPt(cursorHour, R_DIAL_OUTER);
        cursorPath = `M ${x1.toFixed(2)} ${y1.toFixed(2)} L ${x2.toFixed(2)} ${y2.toFixed(2)}`;
    }

    //Default corner values: at the cursor for today, mean for the day on past / future cards.
    let cornerProdW: number | null = null;
    let cornerConsW: number | null = null;
    if (showCursor)
    {
        const hIdx = Math.min(23, Math.floor(cursorHour));
        cornerProdW = hourlyProd[hIdx];
        cornerConsW = hourlyCons[hIdx];
    }
    else
    {
        //Mean of the non-null bins.
        const mean = (arr: ReadonlyArray<number | null>): number | null =>
        {
            let s = 0, c = 0;
            for (const v of arr) { if (v !== null) { s += v; c++; } }
            return c > 0 ? s / c : null;
        };
        cornerProdW = mean(hourlyProd);
        cornerConsW = mean(hourlyCons);
    }

    //Hour ticks: 24 ticks around the perimeter, longer at 0 / 6 / 12 / 18 (cardinal hours).
    const tickElements: TemplateResult[] = [];
    for (let h = 0; h < 24; h++)
    {
        const isBig    = h === 0 || h === 6 || h === 12 || h === 18;
        const innerR   = HOUR_TICK_INNER;
        const outerR   = isBig ? HOUR_TICK_OUTER_BIG : HOUR_TICK_OUTER;
        const [x1, y1] = polarPt(h, innerR);
        const [x2, y2] = polarPt(h, outerR);
        const cls = isBig ? 'dash-radial-tick dash-radial-tick-big' : 'dash-radial-tick';
        tickElements.push(svg`<line class="${cls}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`);
    }

    //Hour labels at the 4 cardinal positions. Positioned slightly outside the big tick ends so
    //they don't overlap the tick stroke.
    const labels = [
        { hour: 12, text: '12', rOffset: 14 },
        { hour: 18, text: '18', rOffset: 14 },
        { hour: 0,  text: '0',  rOffset: 14 },
        { hour: 6,  text: '6',  rOffset: 14 },
    ];
    const labelElements: TemplateResult[] = labels.map(l =>
    {
        const [x, y] = polarPt(l.hour, R_DIAL_OUTER + l.rOffset);
        return svg`<text class="dash-radial-hour-label" x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="middle" dominant-baseline="central">${l.text}</text>`;
    });

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
            <svg
                class="dash-radial-svg"
                viewBox="0 0 ${VIEWBOX} ${VIEWBOX}"
                preserveAspectRatio="xMidYMid meet"
                aria-hidden="true"
            >
                <defs>
                    <radialGradient id="dash-radial-sun-halo-${cardOffset}">
                        <stop offset="0%"   stop-color="var(--helios-sun-color, #f59e0b)" stop-opacity="${haloAlpha}"/>
                        <stop offset="100%" stop-color="var(--helios-sun-color, #f59e0b)" stop-opacity="0"/>
                    </radialGradient>
                </defs>

                <!-- sundial perimeter, the outermost ring with hour ticks -->
                <circle class="dash-radial-dial-ring" cx="${CENTER}" cy="${CENTER}" r="${(R_DIAL_INNER + R_DIAL_OUTER) / 2}"
                        fill="none" stroke-width="${R_DIAL_OUTER - R_DIAL_INNER}"/>

                <!-- consumption ring track -->
                <circle class="dash-radial-cons-track" cx="${CENTER}" cy="${CENTER}" r="${(R_CONS_INNER + R_CONS_OUTER) / 2}"
                        fill="none" stroke-width="${R_CONS_OUTER - R_CONS_INNER}"/>

                <!-- production ring track -->
                <circle class="dash-radial-prod-track" cx="${CENTER}" cy="${CENTER}" r="${(R_PROD_INNER + R_PROD_OUTER) / 2}"
                        fill="none" stroke-width="${R_PROD_OUTER - R_PROD_INNER}"/>

                <!-- consumption past polygon -->
                ${consPastPath ? svg`<path class="dash-radial-cons-fill" d="${consPastPath}"/>` : nothing}

                <!-- production past polygon -->
                ${prodPastPath ? svg`<path class="dash-radial-prod-fill" d="${prodPastPath}"/>` : nothing}

                <!-- production future outline -->
                ${prodFuturePath ? svg`<path class="dash-radial-prod-future" d="${prodFuturePath}"/>` : nothing}

                <!-- sun halo + background fill + scaled inner disc + reference rim, same recipe as the 3D sun on the map -->
                <circle class="dash-radial-sun-halo" cx="${CENTER}" cy="${CENTER}" r="${haloR}"
                        fill="url(#dash-radial-sun-halo-${cardOffset})"/>
                <circle class="dash-radial-sun-bg" cx="${CENTER}" cy="${CENTER}" r="${R_IRRAD_REF}"/>
                <circle class="dash-radial-sun-fill" cx="${CENTER}" cy="${CENTER}" r="${sunFillR.toFixed(2)}"/>
                <circle class="dash-radial-sun-rim" cx="${CENTER}" cy="${CENTER}" r="${R_IRRAD_REF}"
                        fill="none"/>

                <!-- centre irradiance percentage -->
                <text class="dash-radial-irrad-label" x="${CENTER}" y="${CENTER}" text-anchor="middle" dominant-baseline="central">
                    ${Math.round(ratioPct)}%
                </text>

                <!-- hour ticks and labels -->
                ${tickElements}
                ${labelElements}

                <!-- cursor, only on the current day -->
                ${cursorPath ? svg`<path class="dash-radial-cursor" d="${cursorPath}"/>` : nothing}
            </svg>
        </div>
    `;
}
