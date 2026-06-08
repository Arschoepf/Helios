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
import { callWSWithTimeout, WsTimeoutError } from './ws-timeout';
import { beginLoadingPhase, endLoadingPhase, type LoadingTrackerHost } from './loading-tracker';


//-----------------------------------------------------------------
//Module-level cache for the solar-radiation history fetch.
//Mirrors the PV and battery patterns so a navigation away and back
//does not re-trigger the WS round-trip.

const RADIATION_CACHE_TTL_MS = 15 * 60_000;

interface RadiationHistoryCacheEntry
{
    history: RadiationHistory;
    ts:      number;
}

const _radiationHistoryCache: Map<string, RadiationHistoryCacheEntry> = new Map();

function radiationHistoryCacheGet(key: string): RadiationHistoryCacheEntry | null
{
    const e = _radiationHistoryCache.get(key);
    if (!e)
    {
        return null;
    }
    if (Date.now() - e.ts > RADIATION_CACHE_TTL_MS)
    {
        _radiationHistoryCache.delete(key);
        return null;
    }
    return e;
}


//Wipe the module-level radiation cache. Called from the card's `resetDataCache()` hook.
export function clearRadiationModuleCaches(): void
{
    _radiationHistoryCache.clear();
}


//Coerce a `start` / `end` statistics field into a millisecond epoch. Same accept set as the PV / battery parsers, duplicated here so the
//module stays self-contained.
function parseStatBoundary(raw: unknown): number | null
{
    if (raw === null || raw === undefined)
    {
        return null;
    }
    if (typeof raw === 'number')
    {
        return raw > 1e12 ? raw : raw * 1000;
    }
    if (typeof raw === 'string')
    {
        const asNum = Number(raw);
        if (Number.isFinite(asNum) && asNum > 1e9)
        {
            return asNum > 1e12 ? asNum : asNum * 1000;
        }
        const d = new Date(raw);
        const t = d.getTime();
        return isFinite(t) ? t : null;
    }
    return null;
}


//Parse a statistics payload into a RadiationHistory. Irradiance sensors are `state_class: measurement` (Ecowitt, Davis, PWS, the
//common HA integrations) and report instantaneous W/m². The `mean` column carries the bucket-averaged value, anchored at the bucket
//midpoint to match the engine's W/m² assumption.
//
//We deliberately do NOT fall back to the `state` field here. A small subset of installs surface their radiation source as a
//cumulative MJ/m² counter (`state_class: total_increasing`) and `state` then carries monotonically increasing values. Pushing those
//straight to `setSolarRadiationSamples` would feed the engine values that look like 10000+ W/m² and distort every downstream
//derivation (5-day calibration ratio, "affiné" forecast, irradiance chip). Buckets with null `mean` are skipped and, if the slot
//ends up empty, the consumer degrades to the raw-history fallback which has its own unit semantics handled.
function parseRadiationStats(arr: any[]): RadiationHistory
{
    const times:  Date[]   = [];
    const values: number[] = [];
    for (const item of arr ?? [])
    {
        const startMs = parseStatBoundary(item?.start);
        const endMs   = parseStatBoundary(item?.end);
        if (startMs === null)
        {
            continue;
        }
        const valueRaw = item?.mean;
        if (valueRaw === null || valueRaw === undefined)
        {
            continue;
        }
        const v = typeof valueRaw === 'number' ? valueRaw : parseFloat(String(valueRaw));
        if (!isFinite(v) || v < 0)
        {
            continue;
        }
        const anchorMs = endMs !== null ? (startMs + endMs) / 2 : startMs;
        times.push(new Date(anchorMs));
        values.push(v);
    }
    return { times, values };
}


//Fetched historical irradiance series, parallel times[] / values[]
//arrays. Values are W/m² as the sensor reports them, no
//normalisation; the engine consumes that unit directly.
export interface RadiationHistory
{
    times:  Date[];
    values: number[];
}

//Structural surface the host card exposes to this module.
export interface RadiationHost extends LoadingTrackerHost
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
    //Narrow raw window cap, mirrors the PV side (see fetchPvHistory):
    //a Davis / Ecowitt W/m² sensor reporting every second over a
    //multi-day visible timeline used to drag the HA recorder for the
    //whole duration of the fetch, blocking every other card reading
    //the same entity. The chart only needs accurate live data for
    //the head of the curve; older past values are interpolated from
    //the engine's resampled series. 6 h gives the W/m² tooltip
    //enough resolution while keeping the recorder responsive.
    //Cap anchored on NOW so fetchStart stays in the past even when
    //the visible timeline end sits in the forecast horizon (next
    //day). Anchoring on timeline end would place fetchStart in the
    //future and the inner clamp at fetchSolarRadiationHistory
    //would leave the slot empty.
    const RAW_WINDOW_H = 6;
    const visibleStart = host._timeRange.start;
    const cap          = new Date(Date.now() - RAW_WINDOW_H * 3_600_000);
    const fetchStart   = visibleStart < cap ? cap : visibleStart;
    const rangeKey = `${fetchStart.getTime()}|${host._timeRange.end.getTime()}`;
    const fetchKey = `${entity}@${rangeKey}`;
    if (fetchKey === host._solarRadiationFetchKey)
    {
        return;
    }
    host._solarRadiationFetchKey = fetchKey;

    //Cache hit short-circuits the WS round-trip on the navigation case. Cache invalidates on TTL (15 min) or on any (entity / range)
    //change since that flips the fetch key.
    const cached = radiationHistoryCacheGet(fetchKey);
    if (cached)
    {
        host._solarRadiationHistory = cached.history;
        pushSolarRadiationToEngine(host);
        return;
    }
    fetchSolarRadiationHistory(host, entity, fetchStart, host._timeRange.end, fetchKey);
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
    if (!host._engine)
    {
        return;
    }
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
    host:     RadiationHost,
    entityId: string,
    start:    Date,
    end:      Date,
    cacheKey: string = '',
): Promise<void>
{
    if (!host.hass?.callWS)
    {
        return;
    }
    host._solarRadiationFetching = true;
    beginLoadingPhase(host, 'solar-radiation');
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

        //Try statistics first. Personal weather station and IoT irradiance sensors that follow HA conventions expose
        //`state_class: measurement` and land in LTS automatically, so the stats path scales to high-frequency feeds at near-zero cost.
        //Falls back to raw history when the entity is not tracked, which preserves coverage on non-LTS custom sensors at the cost
        //of recorder bandwidth on the slim 2-day window.
        let history: RadiationHistory = { times: [], values: [] };
        const statsResult: any = await callWSWithTimeout<any>(host.hass, {
            type:           'recorder/statistics_during_period',
            start_time:     start.toISOString(),
            end_time:       fetchEnd.toISOString(),
            statistic_ids:  [entityId],
            period:         '5minute',
            //Mean only. The radiation parser refuses the cumulative `state` field to avoid feeding the engine monotonically
            //increasing values that look like 10000+ W/m² (see parseRadiationStats). When the entity is wired as a cumulative
            //counter the stats array lands empty and the raw-history fallback below takes over.
            types:          ['mean'],
        });
        const statsArr: any[] = (statsResult && statsResult[entityId]) ?? [];
        if (statsArr.length > 0)
        {
            history = parseRadiationStats(statsArr);
        }
        else
        {
            const rawResult: any = await callWSWithTimeout<any>(host.hass, {
                type:                     'history/history_during_period',
                start_time:               start.toISOString(),
                end_time:                 fetchEnd.toISOString(),
                entity_ids:               [entityId],
                minimal_response:         true,
                no_attributes:            true,
                significant_changes_only: true,
            });
            history = parseRawRadiationHistory((rawResult && rawResult[entityId]) ?? []);
        }

        host._solarRadiationHistory = history;
        pushSolarRadiationToEngine(host);
        if (cacheKey)
        {
            _radiationHistoryCache.set(cacheKey, { history, ts: Date.now() });
        }
    }
    catch (e)
    {
        if (e instanceof WsTimeoutError)
        {
            console.warn(`[HELIOS] solar radiation fetch timed out (${e.timeoutMs} ms), engine falls back to Open-Meteo for the past window.`);
        }
        else
        {
            console.warn('[HELIOS] Solar radiation history fetch failed:', e);
        }
        host._solarRadiationHistory = { times: [], values: [] };
        pushSolarRadiationToEngine(host);
    }
    finally
    {
        host._solarRadiationFetching = false;
        endLoadingPhase(host, 'solar-radiation');
    }
}


//Raw-history parser, kept around for the statistics fallback path. Same defensive parsing as the legacy implementation: tolerates the
//compact `s`/`lu` shape and the verbose `state`/`last_updated` shape, drops `unavailable` / `unknown` / empty samples, falls back to the
//previous timestamp on a missing `lu` (HA's compaction can omit it on consecutive identical samples).
function parseRawRadiationHistory(arr: any[]): RadiationHistory
{
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

    return { times, values };
}
