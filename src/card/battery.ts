//Home-battery data subsystem: live SoC + power polling, history fetch, scrub-time sampling, today's energy aggregation, chip formatting, and the user
//invert preference.
//
//Same host-driven pattern as card/pv.ts: the card owns the `@state` battery fields, the functions in this module read / write them through a
//structural BatteryHost interface so Lit's reactivity keeps working transparently.

import type { HeliosConfig } from '../helios-config';
import { formatLocalisedNumber } from './format';
import { pvNormalizeToWatts } from './pv';


//Fetched historical series for one battery entity (SoC or power),
//parallel times[] / values[] arrays.
export interface BatteryHistory
{
    times:  Date[];
    values: number[];
}

//Result of computeBatteryToday: live SoC plus the cumulative charged / discharged energy from midnight to "now", in kWh.
export interface BatteryToday
{
    socNow:        number | null;
    chargedKwh:    number;
    dischargedKwh: number;
}

//Structural surface the host card exposes to this module. Mutable
//fields are typed non-readonly so refresh / fetch helpers can
//assign them; Lit's @state reactivity is preserved because each
//assignment hits the same setter the decorator installed.
export interface BatteryHost
{
    readonly config:     HeliosConfig | undefined;
    readonly hass:       any;
    readonly _timeRange: { start: Date; end: Date } | null;

    _batterySoc:          number | null;
    _batteryPower:        number | null;
    _batteryPowerUnit:    string;
    _batterySocHistory:   BatteryHistory | null;
    _batteryPowerHistory: BatteryHistory | null;
    _batteryFetchKey:     string;
    _batteryFetching:     boolean;
}


//True when the user has opted to invert the battery power sign.
//Applied once at ingest (live + history) so every downstream
//consumer (chip readout, flow arrow direction, charged /
//discharged sums) keeps its "positive = charging" assumption
//without an inline ternary at each call site.
export function batteryPowerInvert(config: HeliosConfig | undefined): boolean
{
    return config?.['battery-power-invert'] === true;
}


//Live + history refresh, called from the card on every lifecycle
//cycle. Reads SoC and power from hass.states (one round per
//configured entity), applies the user's invert preference once
//at ingest, and dispatches a history fetch when the (entities,
//range) tuple changes.
export function refreshBattery(host: BatteryHost): void
{
    if (!host.hass)
    {
        return;
    }
    const socEntity   = String(host.config?.['battery-soc-entity']   ?? '').trim();
    const powerEntity = String(host.config?.['battery-power-entity'] ?? '').trim();

    //SoC, clamp to [0, 100] because some BMS entities momentarily report 100.5 % during the absorption phase or briefly drop negative around the
    //calibration cycle, neither of which is meaningful to the user.
    let nextSoc: number | null = null;
    if (socEntity)
    {
        const so = host.hass.states?.[socEntity];
        const v  = so ? parseFloat(so.state) : NaN;
        if (isFinite(v))
        {
            nextSoc = Math.max(0, Math.min(100, v));
        }
    }
    if (nextSoc !== host._batterySoc)
    {
        host._batterySoc = nextSoc;
    }

    //Power, keep the sign (positive = charging, negative =
    //discharging) verbatim from the entity unless the user has
    //opted into `battery-power-invert`, in which case we flip
    //the sign once at ingest so every downstream sign-aware site
    //(chip readout, leader arrow direction, charged /
    //discharged totals) reads the same convention regardless of
    //how the underlying entity is wired. Unit is captured so the
    //chip renderer can format kW vs W; we don't normalise here
    //because the entity's own unit IS the source of truth (some
    //BMS expose W, others kW).
    let nextPower: number | null = null;
    let nextUnit:  string        = '';
    if (powerEntity)
    {
        const so = host.hass.states?.[powerEntity];
        const v  = so ? parseFloat(so.state) : NaN;
        if (isFinite(v))
        {
            nextPower = batteryPowerInvert(host.config) ? -v : v;
            nextUnit  = so.attributes?.unit_of_measurement ?? '';
        }
    }
    if (nextPower !== host._batteryPower)
    {
        host._batteryPower = nextPower;
    }
    if (nextUnit !== host._batteryPowerUnit)
    {
        host._batteryPowerUnit = nextUnit;
    }

    //Drop history series and reset the fetch key when the user clears all battery entity fields, so a stale graph doesn't linger after the config
    //goes blank.
    if (!socEntity && !powerEntity)
    {
        if (host._batterySocHistory !== null)   { host._batterySocHistory   = null; }
        if (host._batteryPowerHistory !== null) { host._batteryPowerHistory = null; }
        host._batteryFetchKey = '';
        return;
    }

    //History fetch, only when the (entities, range) tuple changed.
    //Without this guard we'd reissue the WS command on every Lit
    //cycle (e.g. every clock tick).
    if (!host._timeRange || host._batteryFetching)
    {
        return;
    }
    const rangeKey = `${host._timeRange.start.getTime()}|${host._timeRange.end.getTime()}`;
    //Invert flag is part of the fetch key so a mid-session
    //toggle (user flips the editor switch) invalidates the
    //cached history and triggers a refetch that reapplies the
    //new sign convention at parse time.
    const fetchKey = `${socEntity}+${powerEntity}@${rangeKey}@inv=${batteryPowerInvert(host.config) ? 1 : 0}`;
    if (fetchKey === host._batteryFetchKey)
    {
        return;
    }
    host._batteryFetchKey = fetchKey;
    fetchBatteryHistory(host, socEntity, powerEntity, host._timeRange.start, host._timeRange.end);
}


//Single-call history fetch for the battery overlay. Both entities
//(when configured) are bundled into one `entity_ids` array so we
//pay one WS roundtrip instead of two. Either side of the result
//may end up empty (entity not yet existing, no state changes in
//range, etc.) and that's fine, the chip will show only the side
//that did return data.
export async function fetchBatteryHistory(
    host: BatteryHost,
    socEntity: string,
    powerEntity: string,
    start: Date,
    end: Date
): Promise<void>
{
    if (!host.hass?.callWS)
    {
        return;
    }
    host._batteryFetching = true;
    try
    {
        //History only exists up to "now", the future half of the timeline has no battery data. Clamp the fetch end so we don't waste a roundtrip on
        //empty future buckets.
        const now = new Date();
        const fetchEnd = end > now ? now : end;
        if (start >= fetchEnd)
        {
            if (socEntity)   { host._batterySocHistory   = { times: [], values: [] }; }
            if (powerEntity) { host._batteryPowerHistory = { times: [], values: [] }; }
            return;
        }

        const ids: string[] = [];
        if (socEntity)   { ids.push(socEntity);   }
        if (powerEntity) { ids.push(powerEntity); }

        const result: any = await host.hass.callWS({
            type:             'history/history_during_period',
            start_time:       start.toISOString(),
            end_time:         fetchEnd.toISOString(),
            entity_ids:       ids,
            minimal_response: true,
            no_attributes:    true
        });

        const parseSeries = (arr: any[]): BatteryHistory =>
        {
            const times:  Date[]   = [];
            const values: number[] = [];
            for (const item of arr ?? [])
            {
                const stateStr =
                    typeof item?.s     === 'string' ? item.s :
                    typeof item?.state === 'string' ? item.state :
                    null;
                if (stateStr === null
                    || stateStr === 'unavailable'
                    || stateStr === 'unknown'
                    || stateStr === '')
                {
                    continue;
                }
                const v = parseFloat(stateStr);
                if (!isFinite(v))
                {
                    continue;
                }
                let ts: Date | null = null;
                if (typeof item?.lu === 'number')
                {
                    ts = new Date(item.lu * 1000);
                }
                else if (typeof item?.last_updated === 'string')
                {
                    ts = new Date(item.last_updated);
                }
                else if (typeof item?.last_changed === 'string')
                {
                    ts = new Date(item.last_changed);
                }
                if (!ts || isNaN(ts.getTime()))
                {
                    continue;
                }
                times.push(ts);
                values.push(v);
            }
            return { times, values };
        };

        if (socEntity)
        {
            const series = parseSeries(result?.[socEntity] ?? []);
            //Clamp SoC samples to [0, 100] in the history too, same out-of-range tolerance as the live read.
            series.values = series.values.map(v => Math.max(0, Math.min(100, v)));
            host._batterySocHistory = series;
        }
        else
        {
            host._batterySocHistory = null;
        }
        if (powerEntity)
        {
            const series = parseSeries(result?.[powerEntity] ?? []);
            //Apply the user's invert preference once at parse
            //time, identical to the live ingest path, so every
            //chart / sum that consumes _batteryPowerHistory
            //sees "positive = charging" regardless of the
            //source entity's convention.
            if (batteryPowerInvert(host.config))
            {
                series.values = series.values.map(v => -v);
            }
            host._batteryPowerHistory = series;
        }
        else
        {
            host._batteryPowerHistory = null;
        }
    }
    catch (e)
    {
        console.warn('[HELIOS] battery history fetch failed:', e);
        host._batterySocHistory   = { times: [], values: [] };
        host._batteryPowerHistory = { times: [], values: [] };
    }
    finally
    {
        host._batteryFetching = false;
    }
}


//Locate the history sample at or before `time` and return its
//value, or null if the time falls outside the fetched window. A
//60 s grace at the tail keeps "scrub to live" resolving cleanly
//(same convention as the PV chip).
export function batterySampleAtTime(
    hist: BatteryHistory | null,
    time: Date
): number | null
{
    if (!hist || hist.times.length === 0)
    {
        return null;
    }
    const tMs = time.getTime();
    const firstMs = hist.times[0].getTime();
    const lastMs  = hist.times[hist.times.length - 1].getTime();
    if (tMs < firstMs || tMs > lastMs + 60_000)
    {
        return null;
    }
    let idx = hist.times.length - 1;
    for (let i = 0; i < hist.times.length; i++)
    {
        if (hist.times[i].getTime() > tMs)
        {
            idx = i - 1;
            break;
        }
    }
    if (idx < 0) { idx = 0; }
    return hist.values[idx];
}


//Format a signed battery power value for the chip. Mirrors formatPvValue's W ↔ kW switching but always prefixes a sign so the user can tell charging
//from discharging at a glance.
export function formatBatteryPower(hass: any, value: number, unit: string): string
{
    const lu = (unit || '').trim().toLowerCase();
    const sign = value > 0 ? '+' : (value < 0 ? '−' : '');
    const abs  = Math.abs(value);

    if (lu === 'w' && abs >= 1000)
    {
        return `${sign}${formatLocalisedNumber(hass, abs / 1000, 2)} kW`;
    }
    if (lu === 'w')
    {
        return `${sign}${formatLocalisedNumber(hass, abs, 0, true)} W`;
    }
    if (lu === 'kw')
    {
        return `${sign}${formatLocalisedNumber(hass, abs, 2)} kW`;
    }
    //Unknown unit, format the value with one decimal of precision and keep the configured entity's own unit string. Still locale-aware so the decimal
    //mark matches the rest of the card.
    return `${sign}${formatLocalisedNumber(hass, abs, 1)}${unit ? ' ' + unit : ''}`;
}


//Aggregate today's battery energy from the historical power series.
//Walks the samples from midnight to "now", trapezoid-integrates the
//positive (charging) and negative (discharging) sides separately
//into kWh totals. Returns the live SoC alongside so the dashboard
//card can render the vessel + flow values from a single read.
export function computeBatteryToday(host: BatteryHost): BatteryToday
{
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);
    const startMs = today0.getTime();
    const endMs   = Date.now();

    let chargedKwh    = 0;
    let dischargedKwh = 0;

    const hist = host._batteryPowerHistory;
    if (hist && hist.times.length >= 2)
    {
        for (let i = 1; i < hist.times.length; i++)
        {
            const tMs = hist.times[i].getTime();
            if (tMs < startMs || tMs > endMs) continue;
            const dtH = (tMs - hist.times[i - 1].getTime()) / 3_600_000;
            if (dtH <= 0 || dtH > 6) continue;
            const wAvg = (pvNormalizeToWatts(hist.values[i - 1], host._batteryPowerUnit)
                        + pvNormalizeToWatts(hist.values[i],     host._batteryPowerUnit)) / 2;
            const kwh = (wAvg * dtH) / 1000;
            if (kwh > 0)      chargedKwh    += kwh;
            else              dischargedKwh += -kwh;
        }
    }

    return {
        socNow: host._batterySoc,
        chargedKwh,
        dischargedKwh
    };
}
