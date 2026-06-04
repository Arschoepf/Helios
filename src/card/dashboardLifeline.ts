//Energy Lifeline visualisation rendered inside each CoverFlow card.
//
//Concept: one horizontal axis (00 h -> 24 h), ONE central signed line carrying the net balance
//(production - consumption), ONE soft background fill carrying the battery state-of-charge from 0 % at the
//bottom to 100 % at the top. Above the axis the line is yellow (solar surplus), below the axis it flips to
//blue (deficit / grid pull / battery drain). Past portion is solid, future portion is dashed. A thin white
//cursor sits at "now" when the card is today.
//
//Net = production - consumption. By the energy-balance identity:
//    production - consumption = (grid_export - grid_import) + (battery_charge - battery_discharge)
//we derive `net` from the grid + battery flows the host already buffers, no extra consumption sensor needed.
//Positive net = surplus, the home is producing more than it consumes.

import { html, svg, nothing, TemplateResult } from 'lit';
import { pvNormalizeToWatts } from './pv';
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


export interface LifelineData
{
    times:      number[];   //absolute ms, evenly spaced across the day
    netW:       number[];   //signed W per sample, surplus positive
    socPct:     number[];   //0..100 battery SoC per sample (0 when no battery wired)
    dayStartMs: number;
    dayEndMs:   number;
    liveEndMs:  number;     //boundary between actuals and forecast
    hasNet:     boolean;    //true when at least one of grid / battery has data in this day window
    hasSoc:     boolean;    //true when battery SoC has data in this day window
}


//5-min cadence (288 + 1 endpoint). Smooth without bloating the SVG path on a chart that lives inside a
//CoverFlow card.
const LIFELINE_STEPS = 288;


export function buildLifeline(host: DashboardHost, dayOffset: number): LifelineData
{
    const win       = dayWindowFor(dayOffset);
    const liveEndMs = liveEndMsFor(win.startMs, win.endMs);

    const times:  number[] = [];
    const netW:   number[] = [];
    const socPct: number[] = [];
    let hasNet = false;
    let hasSoc = false;

    for (let i = 0; i <= LIFELINE_STEPS; i++)
    {
        const t = win.startMs + (i / LIFELINE_STEPS) * (win.endMs - win.startMs);
        times.push(t);

        const gridIn  = sampleGridAt(host._gridImportSamples, host._gridImportUnits, t);
        const gridOut = sampleGridAt(host._gridExportSamples, host._gridExportUnits, t);
        const battW   = sampleBatterySignedAt(host, t);

        //net = (export - import) + (charge - discharge). batteryPower convention: positive = charging.
        const net = (gridOut.value - gridIn.value) + battW.value;
        netW.push(net);
        if (gridIn.has || gridOut.has || battW.has) hasNet = true;

        const soc = sampleSoCAt(host, t);
        socPct.push(soc.value);
        if (soc.has) hasSoc = true;
    }

    return {
        times, netW, socPct,
        dayStartMs: win.startMs,
        dayEndMs:   win.endMs,
        liveEndMs,
        hasNet, hasSoc,
    };
}


interface Sampled { value: number; has: boolean; }


//Sample the multi-entity grid power at time t, returning the aggregate W (positive). Handles both
//instantaneous-power entities (W / kW / MW) and cumulative-energy entities (Wh / kWh / MWh) by
//differentiating consecutive samples for the latter.
function sampleGridAt(
    samplesMap: Map<string, Array<{ t: number; v: number }>>,
    unitsMap:   Map<string, string>,
    tMs:        number,
): Sampled
{
    if (!samplesMap || samplesMap.size === 0)
    {
        return { value: 0, has: false };
    }
    let total = 0;
    let any   = false;
    for (const [entity, samples] of samplesMap)
    {
        if (samples.length < 2) continue;
        const t0First = samples[0].t;
        const tLast   = samples[samples.length - 1].t;
        if (tMs < t0First || tMs > tLast) continue;
        const unit = (unitsMap?.get(entity) ?? '').toLowerCase();

        let lo = 0;
        let hi = samples.length - 1;
        while (hi - lo > 1)
        {
            const m = (lo + hi) >> 1;
            if (samples[m].t <= tMs) lo = m;
            else                     hi = m;
        }

        const isCum = unit === 'wh' || unit === 'kwh' || unit === 'mwh';
        if (isCum)
        {
            const dh = (samples[hi].t - samples[lo].t) / 3_600_000;
            if (dh <= 0) continue;
            const scale = unit === 'kwh' ? 1000 : unit === 'mwh' ? 1_000_000 : 1;
            const w = Math.max(0, (samples[hi].v - samples[lo].v) * scale / dh);
            total += w;
            any = true;
        }
        else
        {
            const t0 = samples[lo].t;
            const t1 = samples[hi].t;
            if (t1 === t0) continue;
            const f = (tMs - t0) / (t1 - t0);
            const v = samples[lo].v + (samples[hi].v - samples[lo].v) * f;
            const w = Math.max(0, pvNormalizeToWatts(v, unit));
            total += w;
            any = true;
        }
    }
    return { value: total, has: any };
}


//Signed battery power in W (positive = charging, negative = discharging). Handles both the signed-power
//wiring (the value IS signed W) and the cumulative-counter wiring (monotonic non-decreasing kWh) via the
//same heuristic the chart code uses. For cumulative wiring there is no direction information so the
//derived power is always reported positive (treated as charging).
function sampleBatterySignedAt(host: DashboardHost, tMs: number): Sampled
{
    const ph = host._batteryPowerHistory;
    if (!ph || ph.times.length < 2) return { value: 0, has: false };
    const t0First = ph.times[0].getTime();
    const tLast   = ph.times[ph.times.length - 1].getTime();
    if (tMs < t0First || tMs > tLast) return { value: 0, has: false };

    //Cumulative-wiring heuristic: every consecutive delta non-negative + no negative values + last > first.
    let cumulative = true;
    for (let i = 1; i < ph.values.length && cumulative; i++)
    {
        if (ph.values[i] < 0)                      { cumulative = false; break; }
        if (ph.values[i] < ph.values[i - 1] - 0.5) { cumulative = false; break; }
    }
    cumulative = cumulative && ph.values[ph.values.length - 1] > ph.values[0];

    let lo = 0;
    let hi = ph.times.length - 1;
    while (hi - lo > 1)
    {
        const m = (lo + hi) >> 1;
        if (ph.times[m].getTime() <= tMs) lo = m;
        else                              hi = m;
    }

    if (cumulative)
    {
        const dh = (ph.times[hi].getTime() - ph.times[lo].getTime()) / 3_600_000;
        if (dh <= 0) return { value: 0, has: false };
        const dE = (ph.values[hi] - ph.values[lo]) * 1000;
        return { value: Math.max(0, dE / dh), has: true };
    }
    else
    {
        const t0 = ph.times[lo].getTime();
        const t1 = ph.times[hi].getTime();
        if (t1 === t0) return { value: ph.values[lo], has: true };
        const f = (tMs - t0) / (t1 - t0);
        return { value: ph.values[lo] + (ph.values[hi] - ph.values[lo]) * f, has: true };
    }
}


function sampleSoCAt(host: DashboardHost, tMs: number): Sampled
{
    const ph = host._batterySocHistory;
    if (!ph || ph.times.length < 2) return { value: 0, has: false };
    const t0First = ph.times[0].getTime();
    const tLast   = ph.times[ph.times.length - 1].getTime();
    if (tMs < t0First || tMs > tLast) return { value: 0, has: false };

    let lo = 0;
    let hi = ph.times.length - 1;
    while (hi - lo > 1)
    {
        const m = (lo + hi) >> 1;
        if (ph.times[m].getTime() <= tMs) lo = m;
        else                              hi = m;
    }
    const t0 = ph.times[lo].getTime();
    const t1 = ph.times[hi].getTime();
    if (t1 === t0) return { value: ph.values[lo], has: true };
    const f = (tMs - t0) / (t1 - t0);
    return { value: ph.values[lo] + (ph.values[hi] - ph.values[lo]) * f, has: true };
}


//Render the lifeline SVG. viewBox 0 0 500 120 with preserveAspectRatio="none" so the SVG stretches to its
//container shape. instanceKey differentiates per-card clipPath ids so the same SVG can be rendered
//multiple times (one per CoverFlow day) without id collisions.
export function renderLifelineSVG(data: LifelineData, instanceKey: string): TemplateResult
{
    const W = 500;
    const H = 120;
    const AXIS_Y = H / 2;
    const TOP_PAD = 4;
    const BOT_PAD = 4;
    const HALF_H  = AXIS_Y - TOP_PAD;

    const N = data.times.length;
    if (N < 2)
    {
        return html``;
    }

    //Y scale: dynamic max-abs of net W with a 200 W floor so a flat near-zero day does not amplify noise.
    let yMaxAbs = 200;
    for (const v of data.netW)
    {
        const a = Math.abs(v);
        if (a > yMaxAbs) yMaxAbs = a;
    }

    const xOf    = (tMs: number) => ((tMs - data.dayStartMs) / (data.dayEndMs - data.dayStartMs)) * W;
    const yOfNet = (v: number)   =>
    {
        const yOffset = Math.max(-HALF_H, Math.min(HALF_H, (v / yMaxAbs) * HALF_H));
        return AXIS_Y - yOffset;
    };
    const yOfSoc = (pct: number) =>
    {
        const clamped = Math.max(0, Math.min(100, pct));
        return H - BOT_PAD - (clamped / 100) * (H - TOP_PAD - BOT_PAD);
    };

    //Battery SoC closed-area path: bottom-left -> walk along the SoC curve -> bottom-right -> close.
    let socPath: string | null = null;
    if (data.hasSoc)
    {
        let d = `M 0 ${H}`;
        for (let i = 0; i < N; i++)
        {
            d += ` L ${xOf(data.times[i]).toFixed(2)} ${yOfSoc(data.socPct[i]).toFixed(2)}`;
        }
        d += ` L ${W} ${H} Z`;
        socPath = d;
    }

    //Net line: split into solid (<= liveEndMs) and dashed (> liveEndMs) sub-paths so the same coordinate
    //walk renders with the right style on each segment. Each sub-path is cloned into a "surplus" copy
    //(clipped to y < axis) and a "deficit" copy (clipped to y > axis) so the line colour switches at the
    //axis without needing per-point gradients.
    let solidD  = '';
    let dashedD = '';
    let lastSolidPoint: { x: number; y: number } | null = null;
    for (let i = 0; i < N; i++)
    {
        const t = data.times[i];
        const x = xOf(t);
        const y = yOfNet(data.netW[i]);
        if (t <= data.liveEndMs)
        {
            solidD += `${solidD === '' ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)} `;
            lastSolidPoint = { x, y };
        }
        else
        {
            if (dashedD === '' && lastSolidPoint)
            {
                //Continuity: the dashed path starts at the last solid point so there is no visible gap at
                //the live/forecast boundary.
                dashedD += `M ${lastSolidPoint.x.toFixed(2)} ${lastSolidPoint.y.toFixed(2)} L ${x.toFixed(2)} ${y.toFixed(2)} `;
            }
            else
            {
                dashedD += `${dashedD === '' ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)} `;
            }
        }
    }

    const aboveId = `lifeline-above-${instanceKey}`;
    const belowId = `lifeline-below-${instanceKey}`;
    const gradId  = `lifeline-batt-${instanceKey}`;

    const nowMs      = Date.now();
    const showCursor = nowMs >= data.dayStartMs && nowMs < data.dayEndMs;
    const cursorX    = showCursor ? xOf(nowMs) : 0;

    return html`
        <svg
            class="dash-cf-lifeline-svg"
            viewBox="0 0 ${W} ${H}"
            preserveAspectRatio="none"
            aria-hidden="true"
        >
            <defs>
                <clipPath id="${aboveId}">
                    <rect x="0" y="0" width="${W}" height="${AXIS_Y}"></rect>
                </clipPath>
                <clipPath id="${belowId}">
                    <rect x="0" y="${AXIS_Y}" width="${W}" height="${H - AXIS_Y}"></rect>
                </clipPath>
                <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stop-color="var(--energy-battery-in-color, #4caf50)" stop-opacity="0.30"></stop>
                    <stop offset="100%" stop-color="var(--energy-battery-in-color, #4caf50)" stop-opacity="0.06"></stop>
                </linearGradient>
            </defs>

            ${socPath !== null ? svg`
                <path d="${socPath}" fill="url(#${gradId})" stroke="none"></path>
            ` : nothing}

            <line x1="0" y1="${AXIS_Y}" x2="${W}" y2="${AXIS_Y}" class="dash-cf-lifeline-axis"></line>

            ${solidD ? svg`
                <path d="${solidD.trim()}" class="dash-cf-lifeline-net dash-cf-lifeline-net-surplus" clip-path="url(#${aboveId})"></path>
                <path d="${solidD.trim()}" class="dash-cf-lifeline-net dash-cf-lifeline-net-deficit" clip-path="url(#${belowId})"></path>
            ` : nothing}
            ${dashedD ? svg`
                <path d="${dashedD.trim()}" class="dash-cf-lifeline-net dash-cf-lifeline-net-surplus is-dashed" clip-path="url(#${aboveId})"></path>
                <path d="${dashedD.trim()}" class="dash-cf-lifeline-net dash-cf-lifeline-net-deficit is-dashed" clip-path="url(#${belowId})"></path>
            ` : nothing}

            ${showCursor ? svg`
                <line x1="${cursorX.toFixed(2)}" y1="0" x2="${cursorX.toFixed(2)}" y2="${H}" class="dash-cf-lifeline-cursor"></line>
            ` : nothing}
        </svg>
    `;
}
