//Solar-radiation override subsystem.
//
//When the user wires `solar-radiation-entity` to a physical W/m²
//sensor (typical Ecowitt / Davis / personal weather station), its
//samples beat Open-Meteo for the live + past portions of the
//irradiance pipeline. This module fetches the entity's history,
//keeps the live sample fresh on every refresh cycle, and pushes
//the merged set into the engine via setSolarRadiationSamples().
//
//Same host-driven pattern as card/pv.ts and card/battery.ts: the card owns the `_solarRadiation*` fields, the functions here read / write them
//through a structural RadiationHost interface.

import type { HeliosConfig } from '../helios-config';
import type { HeliosEngine } from '../helios-engine';


//Fetched historical irradiance series, parallel times[] / values[]
//arrays. Values are W/m² as the sensor reports them, no
//normalisation; the engine consumes that unit directly.
export interface RadiationHistory
{
    times:  Date[];
    values: number[];
}

//Structural surface the host card exposes to this module.
export interface RadiationHost
{
    readonly config:     HeliosConfig | undefined;
    readonly hass:       any;
    readonly _timeRange: { start: Date; end: Date } | null;
    readonly _engine?:   HeliosEngine;

    _solarRadiationHistory:  RadiationHistory | null;
    _solarRadiationFetchKey: string;
    _solarRadiationFetching: boolean;
}


//Live + history refresh, called from the card on every lifecycle
//cycle. Cheap fast paths exit early when no entity is configured;
//in that case the engine is also notified so it drops back to its
//built-in irradiance sources.
export function refreshSolarRadiation(host: RadiationHost): void
{
    const entity = String(host.config?.['solar-radiation-entity'] ?? '').trim();

    if (!entity || !host.hass)
    {
        //Clear everything when the entity is removed so the engine drops back to its built-in irradiance sources.
        if (host._solarRadiationHistory !== null)
        {
            host._solarRadiationHistory = null;
        }
        host._solarRadiationFetchKey = '';
        host._engine?.setSolarRadiationSamples(null);
        return;
    }

    //Push the latest live state alongside whatever history we have.
    //Doing this on every Lit cycle keeps the engine's "now" sample
    //fresh; the engine de-dupes internally on sort, so the cost is
    //tiny even at sub-minute tick rates.
    pushSolarRadiationToEngine(host);

    if (!host._timeRange || host._solarRadiationFetching)
    {
        return;
    }
    const rangeKey = `${host._timeRange.start.getTime()}|${host._timeRange.end.getTime()}`;
    const fetchKey = `${entity}@${rangeKey}`;
    if (fetchKey === host._solarRadiationFetchKey)
    {
        return;
    }
    host._solarRadiationFetchKey = fetchKey;
    fetchSolarRadiationHistory(host, entity, host._timeRange.start, host._timeRange.end);
}


//Merge the cached recorder history with the live state and push the
//result down to the engine. Called both on every refresh cycle (so
//the latest live sample is always in there) and once a history
//fetch lands. Cheap, just an array concat + a setter that runs an
//O(n log n) sort once.
//
//Dirty-flag gate: the inputs are stable between hass pushes and
//history fetches, so we hash the (history identity, state identity,
//entity) tuple and skip the whole rebuild when nothing changed.
//Without this guard the function used to rebuild ~700 sample
//objects per render under rotation (auto-rotate fires move events
//which mutate overlay @state which retriggers updated() which
//calls refreshSolarRadiation), creating a massive GC churn.
const _pushedRadiationKey = new WeakMap<RadiationHost, {
    histRef: unknown;
    stateRef: unknown;
    entity: string;
}>();

export function pushSolarRadiationToEngine(host: RadiationHost): void
{
    if (!host._engine) return;
    const entity = String(host.config?.['solar-radiation-entity'] ?? '').trim();
    if (!entity || !host.hass)
    {
        host._engine.setSolarRadiationSamples(null);
        _pushedRadiationKey.delete(host);
        return;
    }
    const hist     = host._solarRadiationHistory;
    const stateRef = host.hass.states?.[entity];
    const cached = _pushedRadiationKey.get(host);
    if (cached
        && cached.histRef  === hist
        && cached.stateRef === stateRef
        && cached.entity   === entity)
    {
        return;
    }
    const samples: { time: Date; wm2: number }[] = [];
    if (hist)
    {
        for (let i = 0; i < hist.times.length; i++)
        {
            samples.push({ time: hist.times[i], wm2: hist.values[i] });
        }
    }
    if (stateRef)
    {
        const v = parseFloat(stateRef.state);
        if (isFinite(v) && v >= 0)
        {
            const ts = stateRef.last_updated
                ? new Date(stateRef.last_updated)
                : new Date();
            samples.push({ time: ts, wm2: v });
        }
    }
    host._engine.setSolarRadiationSamples(samples.length > 0 ? samples : null);
    _pushedRadiationKey.set(host, { histRef: hist, stateRef, entity });
}


//Mirrors fetchPvHistory: same payload shape, same defensive
//parsing across HA's compaction / minimal_response variants.
//W/m² values are taken as-is; the sensor is expected to expose
//solar irradiance in the same unit the engine consumes, no
//normalisation step.
export async function fetchSolarRadiationHistory(
    host: RadiationHost,
    entityId: string,
    start: Date,
    end: Date
): Promise<void>
{
    if (!host.hass?.callWS)
    {
        return;
    }
    host._solarRadiationFetching = true;
    try
    {
        const now = new Date();
        const fetchEnd = end > now ? now : end;
        if (start >= fetchEnd)
        {
            host._solarRadiationHistory = { times: [], values: [] };
            pushSolarRadiationToEngine(host);
            return;
        }

        const result: any = await host.hass.callWS({
            type:                     'history/history_during_period',
            start_time:               start.toISOString(),
            end_time:                 fetchEnd.toISOString(),
            entity_ids:               [entityId],
            minimal_response:         true,
            no_attributes:            true,
            //Lets HA drop bucket-internal duplicates server-side, lighter recorder load on high-frequency solar-radiation sensors. See #157.
            significant_changes_only: true,
        });

        const arr: any[] = (result && result[entityId]) ?? [];
        const times:  Date[]   = [];
        const values: number[] = [];
        let lastTsMs: number | null = null;

        for (const item of arr)
        {
            const sRaw = item?.s ?? item?.state;
            if (sRaw === null
                || sRaw === undefined
                || sRaw === 'unavailable'
                || sRaw === 'unknown'
                || sRaw === '')
            {
                continue;
            }
            const v = parseFloat(String(sRaw));
            if (!isFinite(v) || v < 0)
            {
                continue;
            }

            let ts: Date | null = null;
            const tsRaw =
                item?.lu             ??
                item?.lc             ??
                item?.last_updated   ??
                item?.last_changed   ??
                null;
            if (typeof tsRaw === 'number')
            {
                ts = new Date(tsRaw > 1e12 ? tsRaw : tsRaw * 1000);
            }
            else if (typeof tsRaw === 'string')
            {
                const asNum = Number(tsRaw);
                if (Number.isFinite(asNum) && asNum > 1e9)
                {
                    ts = new Date(asNum > 1e12 ? asNum : asNum * 1000);
                }
                else
                {
                    ts = new Date(tsRaw);
                }
            }
            if ((!ts || isNaN(ts.getTime())) && lastTsMs !== null)
            {
                ts = new Date(lastTsMs);
            }
            if (!ts || isNaN(ts.getTime()))
            {
                continue;
            }

            lastTsMs = ts.getTime();
            times.push(ts);
            values.push(v);
        }

        host._solarRadiationHistory = { times, values };
        pushSolarRadiationToEngine(host);
    }
    catch (e)
    {
        console.warn('[HELIOS] Solar radiation history fetch failed:', e);
        host._solarRadiationHistory = { times: [], values: [] };
        pushSolarRadiationToEngine(host);
    }
    finally
    {
        host._solarRadiationFetching = false;
    }
}
