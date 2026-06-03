//Photovoltaic data subsystem: live state polling, history fetch, rolling-buffer sampling, instantaneous-rate derivation, calibration helpers, and the
//chip / chart value formatter.
//
//The functions in here operate against a "host" object (the card)
//that owns the `@state` PV fields. Lit reactivity is preserved by
//writing back to the same setters the card declares, so calling
//refreshPv(this) from a card lifecycle hook still triggers a
//re-render exactly as the inline version did.

import type { HeliosConfig } from '../helios-config';
import type { EnergyDefaults } from './energy-prefs';
import { computePvPower, getSunPosition, type PanelOrientation } from '../engine/sun';
import { isPanelShaded, type NdsmRaster } from '../engine/pv-shading';
import { formatLocalisedNumber } from './format';
import { resolveBatteryEntities } from './battery';
import { callWSWithTimeout, WsTimeoutError, scheduleIdle } from './ws-timeout';


//Resolve the live PV entity from the HA Energy dashboard solar source. Prefers the optional `stat_rate` (signed W or kW)
//over the cumulative `stat_energy_from` (kWh) so the chart and chip plot the live power directly instead of going
//through the trapezoidal differentiation path that reads as flat-topped plateaus on sparse meters. Returns an empty
//string when no solar source is configured, the caller treats that as "chip + chart hidden". Multi-source installs
//collapse to the first entry today; full per-source aggregation across all solar sources lands in a follow-up.
export function resolvePvLiveEntity(defaults: EnergyDefaults): string
{
    if (defaults.solarStatRates.length > 0)
    {
        return defaults.solarStatRates[0];
    }
    if (defaults.solarStatEnergyFroms.length > 0)
    {
        return defaults.solarStatEnergyFroms[0];
    }
    return '';
}

//Default panel height above ground in metres when the user didn't
//set a per-array `height`. 5 m matches the eaves of a single-storey
//French house; close enough for the LiDAR raycast since the
//surrounding obstacles (trees, neighbouring roofs) are usually
//much taller than this fudge factor's residual error.
const DEFAULT_PANEL_HEIGHT_M = 5;


//Time + value pair stored in the rolling live-sample buffer used to derive an instantaneous rate from a cumulative energy entity.
export interface PvSample
{
    t: number;
    v: number;
}

//Fetched historical series, parallel times[] / values[] arrays so a binary or linear search can locate a sample by timestamp without re-allocating
//wrapper objects.
export interface PvHistory
{
    times:  Date[];
    values: number[];
}

//Result of a rate computation. `unit` matches what the user's PV
//chip should print after the value (W / kW / MW / "<unit>/h").
export interface PvRate
{
    value: number;
    unit:  string;
}

//Structural surface the host card exposes to this module. The
//mutable `_pv*` fields are typed non-readonly so the refresh / fetch
//helpers can assign them; Lit's @state reactivity is preserved
//because the assignment hits the same setter the decorator installed.
export interface PvHost
{
    readonly config:     HeliosConfig | undefined;
    readonly hass:       any;
    readonly _timeRange: { start: Date; end: Date } | null;
    readonly _energyDefaults: import('./energy-prefs').EnergyDefaults;

    _pvCurrent:             number | null;
    _pvUnit:                string;
    _pvHistory:             PvHistory | null;
    _pvSampleBuffer:        PvSample[];
    _pvFetchKey:            string;
    _pvFetching:            boolean;
    _pvHistoryDiagnostics:  { rawEntries: number; samples: number; windowH: number } | null;
    //Companion battery SoC history fetched alongside _pvHistory when a battery is wired AND `inverter-cutoff-soc-pct` is set. The
    //shading-map trainer scans it to detect inverter-cutoff buckets (battery full + production blocked) and skip them so the map
    //doesn't accumulate phantom shadow at the matching sun bin. Null when the guard is off or no battery is configured; the
    //trainer then trains every bucket without the guard.
    _batteryHistory:        PvHistory | null;
    //Hourly long-term-statistics series feeding the 5-day forecast calibration. Same parallel times[] / values[] shape as `_pvHistory`,
    //populated via `recorder/statistics_during_period` with `period: 'hour'` over the past 5 days. Power sensors land here as bucket
    //means; cumulative-energy sensors land as the bucket-end `state` field. Carries roughly 120 rows, an order of magnitude lighter
    //recorder load than the raw history path on a high-frequency BMS. Null when statistics are unavailable (entity has no
    //`state_class`, LTS disabled), the calibration then degrades to the narrower `_pvHistory` window.
    _pvCalibStats:          PvHistory | null;
    _pvCalibStatsFetchKey:  string;
    _pvCalibStatsFetching:  boolean;
    //5-minute long-term-statistics series feeding the 30-day shading-map trainer. Same payload contract as `_pvCalibStats` but at a finer
    //period for the trainer's 30-minute buckets. ~8.6k rows for 30 days. Null when statistics are unavailable; trainer then degrades to
    //`_pvHistory`.
    _pvTrainerStats:        PvHistory | null;
    _pvTrainerStatsFetchKey: string;
    _pvTrainerStatsFetching: boolean;
}


//Per-instance flag key used by wipeLegacyPvCalibStorage to mark the one-time cleanup as done. Stored alongside the calibration entries it sweeps so a
//stale read from another browser still triggers a fresh cleanup on first load.
const PV_CALIB_WIPE_FLAG_KEY = 'helios-pv-calib:wiped-v1';


//-----------------------------------------------------------------
//Module-level cache for the three PV-side WS fetches. Survives Lit
//element unmount + remount (the user navigating away from the card
//and back), which is the lifecycle event that the per-instance
//`_pv*FetchKey` gate cannot catch. Without this, every navigation
//restarted the heavy fetch from zero
//
//Each entry carries the parsed series + the fetched-at timestamp.
//TTL keeps stale data from drifting forever, the next refresh
//cycle after expiry falls back to a fresh fetch. Keyed by the same
//fetch key the refresh path computes, so an entity / range / SoC
//bank change naturally invalidates without an explicit clear.

const PV_CACHE_TTL_MS = 15 * 60_000;

interface PvHistoryCacheEntry
{
    history:          PvHistory;
    batteryHistory:   PvHistory | null;
    diagnostics:      { rawEntries: number; samples: number; windowH: number };
    ts:               number;
}

interface PvStatsCacheEntry
{
    stats: PvHistory;
    ts:    number;
}

const _pvHistoryCache:        Map<string, PvHistoryCacheEntry> = new Map();
const _pvCalibStatsCache:     Map<string, PvStatsCacheEntry>   = new Map();
const _pvTrainerStatsCache:   Map<string, PvStatsCacheEntry>   = new Map();


function pvHistoryCacheGet(key: string): PvHistoryCacheEntry | null
{
    const e = _pvHistoryCache.get(key);
    if (!e)
    {
        return null;
    }
    if (Date.now() - e.ts > PV_CACHE_TTL_MS)
    {
        _pvHistoryCache.delete(key);
        return null;
    }
    return e;
}

function pvStatsCacheGet(cache: Map<string, PvStatsCacheEntry>, key: string): PvStatsCacheEntry | null
{
    const e = cache.get(key);
    if (!e)
    {
        return null;
    }
    if (Date.now() - e.ts > PV_CACHE_TTL_MS)
    {
        cache.delete(key);
        return null;
    }
    return e;
}


//Wipe the three module-level PV caches. Called from the card's `resetDataCache()` hook so the editor's "reset" button actually drops the
//cross-mount memo. Without this call the next refresh would short-circuit on a cache hit and re-populate the slot with the exact data
//the user just asked to clear.
export function clearPvModuleCaches(): void
{
    _pvHistoryCache.clear();
    _pvCalibStatsCache.clear();
    _pvTrainerStatsCache.clear();
}


//Live + history refresh, called from the card on every lifecycle
//cycle. Cheap fast paths exit early when no entity is configured or
//when the (entity, range) tuple matches the last successful fetch.
export function refreshPv(host: PvHost): void
{
    const entity = resolvePvLiveEntity(host._energyDefaults);

    if (!entity || !host.hass)
    {
        //Reset everything when the user clears the entity field so the chip and graph immediately disappear instead of sticking around with stale
        //data.
        if (host._pvCurrent !== null || host._pvHistory !== null)
        {
            host._pvCurrent = null;
            host._pvHistory = null;
            host._pvUnit    = '';
        }
        host._pvFetchKey = '';
        return;
    }

    //Live state read, always cheap, runs on every Lit cycle.
    const stateObj = host.hass.states?.[entity];
    if (stateObj)
    {
        const v = parseFloat(stateObj.state);
        const next = isFinite(v) ? v : null;
        if (next !== host._pvCurrent)
        {
            host._pvCurrent = next;
        }
        const unit = stateObj.attributes?.unit_of_measurement ?? '';
        if (unit !== host._pvUnit)
        {
            host._pvUnit = unit;
        }

        //Append the freshly-read state to the rolling buffer if the entity timestamp moved forward since last cycle. We trim entries older than 5 min
        //so the buffer stays tiny even on entities that update many times per second.
        if (next !== null)
        {
            const ts = stateObj.last_updated
                ? new Date(stateObj.last_updated).getTime()
                : Date.now();
            const buf = host._pvSampleBuffer;
            const last = buf.length > 0 ? buf[buf.length - 1] : null;
            if (!last || ts > last.t)
            {
                buf.push({ t: ts, v: next });
                const cutoff = Date.now() - 5 * 60 * 1000;
                while (buf.length > 1 && buf[0].t < cutoff)
                {
                    buf.shift();
                }
            }

            //Extend `_pvHistory`'s tail with the live sample so the chart's right edge tracks the live state between hourly history
            //re-fetches. The history fetch is keyed by (entity, fetch-range) and `range.end` is pinned to the hourly weather grid,
            //so without this the plotted PV curve flatlines at the value captured at the last hour boundary even while the chip
            //keeps ticking. The next full fetch (when the hour rolls over) replaces the array wholesale.
            //
            //In-place push instead of spread: with the live state ticking up to ~50 times per second and the fetch key sitting
            //stable for an hour at a time, the previous spread-then-reassign reallocated `times` and `values` on every tick
            //and the arrays grew unbounded. Push mutates the existing arrays (Lit re-renders are driven by the live state
            //assignment above, not by `_pvHistory` identity), and we trim entries that drift before `_timeRange.start` so the
            //tail does not balloon past the visible window.
            const hist = host._pvHistory;
            if (hist)
            {
                const lastIdx = hist.times.length - 1;
                const lastTs  = lastIdx >= 0 ? hist.times[lastIdx].getTime() : 0;
                if (ts > lastTs)
                {
                    hist.times.push(new Date(ts));
                    hist.values.push(next);
                    //Drop the leading samples that have aged out of the chart's visible window. Guards the array against
                    //unbounded growth on long-uptime sessions where the fetch key stays stable for many hours.
                    if (host._timeRange)
                    {
                        const rangeStartMs = host._timeRange.start.getTime();
                        let drop = 0;
                        while (drop < hist.times.length && hist.times[drop].getTime() < rangeStartMs)
                        {
                            drop++;
                        }
                        if (drop > 0)
                        {
                            hist.times.splice(0, drop);
                            hist.values.splice(0, drop);
                        }
                    }
                }
            }
        }
    }
    else
    {
        if (host._pvCurrent !== null)
        {
            host._pvCurrent = null;
        }
        //Drop the buffer when the entity disappears so we don't serve stale samples after the user clears the config.
        if (host._pvSampleBuffer.length > 0)
        {
            host._pvSampleBuffer = [];
        }
    }

    //Three-fetch staging, gated independently so each piece reissues only when its (entity, window) tuple changes:
    //  1. Raw history bounded to the chart's visible past (~2 days). High-frequency installs (Victron Cerbo at >1 Hz) would return
    //     millions of rows over a wider window, so the narrow cap is the structural ceiling on recorder load.
    //  2. Hourly long-term statistics over 5 days, feeding `calibration.ts`. ~120 rows per fetch, two orders of magnitude lighter
    //     on the recorder than the equivalent raw path.
    //  3. 5-minute long-term statistics over 30 days, feeding `shadingTrainer.ts`. ~8.6k rows per fetch.
    //
    //All three exit cheaply on subsequent Lit cycles (clock ticks, hass updates) because the fetch key cache short-circuits
    //identical-range re-fetches, mirroring the existing behaviour.
    if (!host._timeRange)
    {
        return;
    }
    const fetchEnd = host._timeRange.end;
    const HOUR_MS  = 3_600_000;
    const today0   = new Date();
    today0.setHours(0, 0, 0, 0);

    //Raw history, narrow window. Capped at the last RAW_WINDOW_H
    //hours regardless of how wide the user's visible timeline is.
    //The HA recorder is single-threaded behind SQLite, so a multi-
    //day raw fetch on a 1 Hz inverter (Victron Cerbo and friends)
    //blocks every other card reading the same entity for the
    //duration of the fetch, on every card load. The chart already
    //has access to two LTS slots (`_pvCalibStats` at hour resolution
    //over 5 days, `_pvTrainerStats` at 5-min resolution over 30
    //days), which carry the past portion of the visible timeline
    //orders of magnitude faster. Raw only needs to cover the live
    //tail accurately enough for the tooltip and the head of the
    //chart curve.
    const RAW_WINDOW_H = 6;
    if (!host._pvFetching)
    {
        //Cap anchored on NOW, not on the visible timeline end. The
        //timeline end is the forecast horizon (e.g. tomorrow 23:59),
        //so anchoring the cap there would place fetchStart in the
        //future, fetchPvHistory would see `start >= fetchEnd` after
        //its own "clamp end to now" pass, blank `_pvHistory` and
        //leave the chart's past portion empty until live state
        //pushes start landing. The window we actually want is
        //"the last 6 h of real wall-clock time".
        const visibleStart = host._timeRange.start;
        const cap          = new Date(Date.now() - RAW_WINDOW_H * HOUR_MS);
        const fetchStart   = visibleStart < cap ? cap : visibleStart;
        const rangeKey   = `${fetchStart.getTime()}|${fetchEnd.getTime()}`;
        //Optional battery SoC companion fetch. We only ask HA for the SoC history when the user has explicitly armed the
        //inverter-cutoff guard (cutoff percent configured AND a battery SoC source resolved from the HA Energy defaults); otherwise
        //the trainer doesn't need it and the extra entity in the WS payload would be a waste of HA recorder bandwidth. The fetch
        //key includes the SoC entity id so swapping it forces a re-fetch on the next refresh.
        const battSocId = batterySocEntityForInhibit(host.config, host._energyDefaults);
        const fullFetchKey = `${entity}@${rangeKey}`
            + (battSocId ? '|bsoc:' + battSocId : '');
        if (fullFetchKey !== host._pvFetchKey)
        {
            host._pvFetchKey = fullFetchKey;
            //Cache hit short-circuits the WS round-trip: the user navigates away from the card and back, the module-level cache still
            //has the previous fetch parsed and ready, no recorder hit. Cache invalidates on TTL (15 min) or on any (entity / range /
            //SoC) change since that flips the key.
            const cached = pvHistoryCacheGet(fullFetchKey);
            if (cached)
            {
                host._pvHistory             = cached.history;
                host._batteryHistory        = cached.batteryHistory;
                host._pvHistoryDiagnostics  = cached.diagnostics;
            }
            else
            {
                fetchPvHistory(host, entity, fetchStart, fetchEnd, battSocId, fullFetchKey);
            }
        }
    }

    //Hourly LTS for calibration (5 days).
    if (!host._pvCalibStatsFetching)
    {
        const calibStart = new Date(today0.getTime() - 5 * 24 * HOUR_MS);
        const calibKey   = `${entity}@h|${calibStart.getTime()}|${fetchEnd.getTime()}`;
        if (calibKey !== host._pvCalibStatsFetchKey)
        {
            host._pvCalibStatsFetchKey = calibKey;
            const cachedCalib = pvStatsCacheGet(_pvCalibStatsCache, calibKey);
            if (cachedCalib)
            {
                host._pvCalibStats = cachedCalib.stats;
            }
            else
            {
                fetchPvStatistics(host, entity, calibStart, fetchEnd, 'hour', 'calib', calibKey);
            }
        }
    }

    //5-min LTS for shading-map trainer (30 days).
    if (!host._pvTrainerStatsFetching)
    {
        const trainerStart = new Date(today0.getTime() - 30 * 24 * HOUR_MS);
        const trainerKey   = `${entity}@5m|${trainerStart.getTime()}|${fetchEnd.getTime()}`;
        if (trainerKey !== host._pvTrainerStatsFetchKey)
        {
            host._pvTrainerStatsFetchKey = trainerKey;
            const cachedTrainer = pvStatsCacheGet(_pvTrainerStatsCache, trainerKey);
            if (cachedTrainer)
            {
                host._pvTrainerStats = cachedTrainer.stats;
            }
            else
            {
                //Defer to browser idle time so the user-facing fetches (raw PV history + calib stats) land first and the chart paints
                //quickly. The trainer feeds the shading-map heuristic which the engine can rebuild from any non-empty sample stream, so
                //the trainer is effectively a background optimisation, not a blocker for the chip / chart render.
                scheduleIdle(() =>
                {
                    fetchPvStatistics(host, entity, trainerStart, fetchEnd, '5minute', 'trainer', trainerKey);
                });
            }
        }
    }
}


//Returns the SoC entity id only when the inverter-cutoff guard is armed (cutoff percent set AND a battery SoC source resolved from the HA
//Energy defaults), null otherwise. Centralises the gate so both the trainer and the fetch path agree on when the SoC history is needed.
export function batterySocEntityForInhibit(cfg: HeliosConfig | undefined, defaults: EnergyDefaults): string | null
{
    if (inverterCutoffSocPct(cfg) === null)
    {
        return null;
    }
    return resolveBatteryEntities(defaults).socEntity;
}


//Returns the inverter cutoff threshold (0-100) when the guard is armed, null otherwise. Mirrors batterySocEntityForInhibit so callers can
//read both values without re-validating the config tree twice.
export function inverterCutoffSocPct(cfg: HeliosConfig | undefined): number | null
{
    if (!cfg)
    {
        return null;
    }
    const cutoff = cfg['inverter-cutoff-soc-pct'];
    const cutoffN = typeof cutoff === 'number' ? cutoff : typeof cutoff === 'string' ? parseFloat(cutoff) : NaN;
    if (!isFinite(cutoffN) || cutoffN <= 0 || cutoffN > 100)
    {
        return null;
    }
    return cutoffN;
}


//Coerce HA's heterogeneous history payload into parallel times[] / values[] arrays. Accepts both the minimal-response shape (`s` + `lu`) and the
//full-response shape (`state` + `last_updated`/`last_changed`); rejects 'unavailable' / 'unknown' / '' entries; falls back to the previous
//timestamp for compaction entries where HA omits `lu` on unchanged consecutive samples.
function parseHistoryEntries(arr: any[]): PvHistory
{
    const times:  Date[]   = [];
    const values: number[] = [];
    let lastTsMs: number | null = null;
    for (const item of arr)
    {
        const sRaw = item?.s ?? item?.state;
        if (sRaw === null || sRaw === undefined || sRaw === 'unavailable' || sRaw === 'unknown' || sRaw === '')
        {
            continue;
        }
        const v = parseFloat(String(sRaw));
        if (!isFinite(v))
        {
            continue;
        }

        let ts: Date | null = null;
        const tsRaw = item?.lu ?? item?.lc ?? item?.last_updated ?? item?.last_changed ?? null;
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


//Linearly interpolate a value at `ms` from a (times, values) series. Returns null when the series is empty or `ms` falls strictly outside the
//bracketed range (no extrapolation, the trainer prefers a clean miss over a guessed-out SoC value). Used by the shading trainer to read battery SoC
//at a bucket midpoint, but generic enough for any time-keyed series.
export function valueAtMs(series: PvHistory | null, ms: number): number | null
{
    if (!series || series.times.length === 0)
    {
        return null;
    }
    const t = series.times;
    const v = series.values;
    if (ms < t[0].getTime() || ms > t[t.length - 1].getTime())
    {
        return null;
    }
    //Binary search for the right-hand bracket; samples are inserted in order so the search is sound.
    let lo = 0, hi = t.length - 1;
    while (lo < hi - 1)
    {
        const mid = (lo + hi) >> 1;
        if (t[mid].getTime() <= ms)
        {
            lo = mid;
        }
        else
        {
            hi = mid;
        }
    }
    const t0 = t[lo].getTime();
    const t1 = t[hi].getTime();
    if (t1 === t0)
    {
        return v[lo];
    }
    const f = (ms - t0) / (t1 - t0);
    return v[lo] + (v[hi] - v[lo]) * f;
}


//Pull a historical series from HA's `history/history_during_period` WebSocket command, coerce the heterogeneous payload into parallel times[] /
//values[] arrays, and snapshot the fetch outcome for `window.heliosStats()`. Fires off `host._pvFetching` for the duration; the gate in refreshPv
//prevents overlapping calls. When `batterySocId` is non-null we fold it into the same WS request and store the parsed series on
//`host._batteryHistory`, the shading-map trainer scans it to skip buckets where SoC reached the cutoff.
export async function fetchPvHistory(
    host: PvHost,
    entityId: string,
    start: Date,
    end: Date,
    batterySocId: string | null = null,
    cacheKey: string = '',
): Promise<void>
{
    if (!host.hass?.callWS)
    {
        return;
    }
    host._pvFetching = true;
    try
    {
        //History only exists up to "now", anything past that is the forecast half of the timeline and has no production data. Clamp the fetch end so
        //we don't waste a roundtrip asking HA for empty future buckets.
        const now = new Date();
        const fetchEnd = end > now ? now : end;
        if (start >= fetchEnd)
        {
            host._pvHistory = { times: [], values: [] };
            host._batteryHistory = null;
            return;
        }

        const entityIds = batterySocId
            ? [entityId, batterySocId]
            : [entityId];
        const result: any = await callWSWithTimeout<any>(host.hass, {
            type:                     'history/history_during_period',
            start_time:               start.toISOString(),
            end_time:                 fetchEnd.toISOString(),
            entity_ids:               entityIds,
            minimal_response:         true,
            no_attributes:            true,
            //Lets HA drop bucket-internal duplicates server-side. On a Victron MPPT at >1 Hz that trims roughly 30-70 % of the rows
            //without affecting the calibration / chart since both consumers walk neighbour-pair deltas.
            significant_changes_only: true,
        });

        const arr: any[] = (result && result[entityId]) ?? [];
        const parsed = parseHistoryEntries(arr);
        const times = parsed.times;
        const values = parsed.values;

        const batteryHistory: PvHistory | null = batterySocId
            ? parseHistoryEntries((result && result[batterySocId]) ?? [])
            : null;
        host._batteryHistory = batteryHistory;

        const history: PvHistory = { times, values };
        host._pvHistory = history;
        //Snapshot the fetch outcome so `window.heliosStats()` can
        //surface it without us logging on every fetch.
        const diagnostics =
        {
            rawEntries: arr.length,
            samples:    times.length,
            windowH:    Number(((fetchEnd.getTime() - start.getTime()) / 3_600_000).toFixed(1))
        };
        host._pvHistoryDiagnostics = diagnostics;

        //Persist for the next mount. The TTL covers stale-read protection; the cache lives at module scope so nav-away / nav-back
        //picks it up without a fresh recorder hit.
        if (cacheKey)
        {
            _pvHistoryCache.set(cacheKey, { history, batteryHistory, diagnostics, ts: Date.now() });
        }
    }
    catch (e)
    {
        if (e instanceof WsTimeoutError)
        {
            console.warn(`[HELIOS] PV history fetch timed out (${e.timeoutMs} ms), rendering without past-day series.`);
        }
        else
        {
            console.warn('[HELIOS] PV history fetch failed:', e);
        }
        host._pvHistory = { times: [], values: [] };
    }
    finally
    {
        host._pvFetching = false;
    }
}


//Pull a long-term-statistics series from HA's `recorder/statistics_during_period` WebSocket command. Trades raw resolution for a two-orders-of-
//magnitude reduction in payload size, which keeps the recorder responsive on installs whose PV entity reports several samples per second (Victron
//Cerbo and friends).
//
//`role` selects the target slot: `'calib'` populates `host._pvCalibStats` for the 5-day forecast calibration, `'trainer'` populates
//`host._pvTrainerStats` for the 30-day shading-map trainer. The two paths are independent so a slow trainer fetch does not delay the calibration
//landing.
//
//Field selection depends on the entity unit. Power sensors carry the bucket mean. Cumulative-energy sensors (`Wh` / `kWh` / `MWh`) carry
//their cumulative reading in the bucket `state` field. We ask for BOTH columns in the WS payload and let the parser prefer `mean` when
//it is populated, with `state` as fallback. Asking for both removes a class of silent failures: when the entity unit hasn't yet propagated
//to `host._pvUnit` at the time the fetch fires (cold start before the live hass.states tick lands), the heuristic would have asked for
//`mean` only and a cumulative-energy entity would have returned all-null buckets, leaving the slot empty.
//
//Anchoring: cumulative samples (taken from `state`) anchor at the bucket midpoint to match the power-sensor convention. The slight
//attribution drift across the day boundary is absorbed by `calibration.ts:actualKwhForDay`'s guard widening.
//Power samples (taken from `mean`) anchor at the bucket midpoint so the trapezoidal integration in `calibration.ts` and
//`shadingTrainer.ts` matches the existing semantics. Buckets with both `mean` AND `state` null are dropped silently.
//
//Long-term statistics require the source entity to carry a `state_class` (`measurement`, `total`, or `total_increasing`) so HA tracks it. When the
//entity is not LTS-tracked HA returns an empty array; we surface that as an empty `PvHistory` and let the consumer fall back to `_pvHistory`.
export async function fetchPvStatistics(
    host: PvHost,
    entityId: string,
    start: Date,
    end: Date,
    period: '5minute' | 'hour' | 'day' | 'week' | 'month',
    role: 'calib' | 'trainer',
    cacheKey: string = '',
): Promise<void>
{
    if (!host.hass?.callWS)
    {
        return;
    }

    const fetchingFlag    = role === 'calib' ? '_pvCalibStatsFetching'    : '_pvTrainerStatsFetching';
    const targetSlot      = role === 'calib' ? '_pvCalibStats'            : '_pvTrainerStats';
    const cache           = role === 'calib' ? _pvCalibStatsCache         : _pvTrainerStatsCache;

    host[fetchingFlag] = true;
    try
    {
        //History only exists up to "now". Clamp the fetch end so we don't ask HA for empty future buckets.
        const now = new Date();
        const fetchEnd = end > now ? now : end;
        if (start >= fetchEnd)
        {
            host[targetSlot] = { times: [], values: [] };
            return;
        }

        const result: any = await callWSWithTimeout<any>(host.hass, {
            type:           'recorder/statistics_during_period',
            start_time:     start.toISOString(),
            end_time:       fetchEnd.toISOString(),
            statistic_ids:  [entityId],
            period,
            //Request both `mean` and `state`. Power sensors populate `mean`, cumulative-energy sensors populate `state`. The parser
            //below prefers `mean` and falls back to `state`, so a single round-trip covers both wirings without depending on the
            //user-facing unit having reached `host._pvUnit` yet.
            types:          ['mean', 'state'],
            //Normalise to kWh / W so installs reporting in Wh, MWh or kW land on the same scale the calibration + chart
            //expect. The `pvNormalizeToWatts` helper still handles the live state read where this hint is unavailable.
            units:          { energy: 'kWh', power: 'W' },
        });

        const arr: any[] = (result && result[entityId]) ?? [];
        const times:  Date[]   = [];
        const values: number[] = [];

        for (const item of arr)
        {
            //Bucket boundaries arrive as ISO 8601 strings or millisecond epochs depending on the HA version; coerce both.
            const startRaw = item?.start;
            const endRaw   = item?.end;
            const startMs  = parseStatBoundary(startRaw);
            const endMs    = parseStatBoundary(endRaw);
            if (startMs === null)
            {
                continue;
            }
            //Prefer `mean` (populated for power / measurement entities); fall back to `state` (populated for cumulative-energy
            //entities). Both buckets null is treated as a gap and skipped silently.
            let valueRaw: unknown = item?.mean;
            if (valueRaw === null || valueRaw === undefined)
            {
                valueRaw = item?.state;
            }
            if (valueRaw === null || valueRaw === undefined)
            {
                continue;
            }
            const v = typeof valueRaw === 'number' ? valueRaw : parseFloat(String(valueRaw));
            if (!isFinite(v))
            {
                continue;
            }
            //Bucket midpoint anchor for both flavours. Aligns with the trapezoidal integration in `calibration.ts` and
            //`shadingTrainer.ts`. Mid-bucket attribution averages out across the day boundary for cumulative sensors when the
            //calibration's cross-day guard tolerates the trailing slice.
            const anchorMs = endMs !== null ? (startMs + endMs) / 2 : startMs;
            times.push(new Date(anchorMs));
            values.push(v);
        }

        const stats: PvHistory = { times, values };
        host[targetSlot] = stats;
        if (cacheKey)
        {
            cache.set(cacheKey, { stats, ts: Date.now() });
        }
    }
    catch (e)
    {
        if (e instanceof WsTimeoutError)
        {
            console.warn(`[HELIOS] PV ${role} statistics fetch timed out (${e.timeoutMs} ms), consumer degrades to raw _pvHistory.`);
        }
        else
        {
            //LTS endpoint missing or entity not tracked. Surface an empty series so the consumer can degrade to `_pvHistory`.
            console.warn(`[HELIOS] PV statistics fetch failed (${role}):`, e);
        }
        host[targetSlot] = { times: [], values: [] };
    }
    finally
    {
        host[fetchingFlag] = false;
    }
}


//Coerce a `start` / `end` field from a statistics bucket into a millisecond epoch. Accepts ISO strings, numeric seconds, and numeric milliseconds
//since HA's payload shape has changed between releases. Returns null on anything unparseable.
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


//Locate the slot that brackets a scrub timestamp. Priority order:
//  1. `_pvHistory` raw (~2 days, finest resolution)
//  2. `_pvCalibStats` hourly (5 days), populated right after card mount and not deferred to idle
//  3. `_pvTrainerStats` 5-min (30 days), idle-deferred so it lands a beat later
//
//The calibration slot sits between the raw and trainer ones intentionally: it lands FAST (no idle wait) and its hourly resolution is
//plenty for chip-level accuracy. Without it, a user scrubbing the cursor before the trainer fetch has landed (the first second after
//mount) sees nothing past the 2-day raw edge even though we already have data covering the chart's visible past.
//
//All three slots carry the same `{ times, values }` shape, in the same unit, so the caller treats them identically. Returns null when
//none brackets the instant.
function pickPvHistoryAt(host: PvHost, tMs: number): PvHistory | null
{
    const bracketed = (h: PvHistory | null): PvHistory | null =>
    {
        if (!h || h.times.length === 0)
        {
            return null;
        }
        const firstMs = h.times[0].getTime();
        const lastMs  = h.times[h.times.length - 1].getTime();
        //Allow a 60 s grace at the tail so a "live" scrub to "now" still resolves on a series whose last sample is a few seconds old.
        if (tMs < firstMs || tMs > lastMs + 60_000)
        {
            return null;
        }
        return h;
    };
    return bracketed(host._pvHistory)
        ?? bracketed(host._pvCalibStats)
        ?? bracketed(host._pvTrainerStats);
}


//Compute the production rate at an arbitrary historical time
//(used when the user scrubs the timeline into the past). For
//a cumulative entity we differentiate the two history samples
//bracketing the requested instant; for a power entity we just
//return the value of the closest historical sample. Returns
//null when the requested time falls outside every fetched
//history window, the chip is then hidden by the caller, which
//is the right behaviour for the future half of the timeline
//(no production data exists there yet).
export function pvRateAtTime(host: PvHost, time: Date): PvRate | null
{
    const tMs = time.getTime();

    //Pick the slot that brackets the scrub timestamp. The raw `_pvHistory` window is bounded to the chart's visible past (~2 days), so any
    //scrub older than that would return null without this fallback. `_pvTrainerStats` carries the same data at 5-min resolution over 30
    //days, which is enough for chip-level accuracy when the cursor lands past the raw window.
    const hist = pickPvHistoryAt(host, tMs);
    if (!hist)
    {
        return null;
    }

    //Classification, same logic as currentPvRate. Repeated inline so each helper is self-contained.
    const entity   = resolvePvLiveEntity(host._energyDefaults);
    const stateObj = host.hass?.states?.[entity];
    const sc       = String(stateObj?.attributes?.state_class  ?? '').toLowerCase();
    const dc       = String(stateObj?.attributes?.device_class ?? '').toLowerCase();
    const u        = (host._pvUnit || '').trim();
    const lu       = u.toLowerCase();

    let isCumulative: boolean;
    if (sc === 'total_increasing' || sc === 'total')
    {
        isCumulative = true;
    }
    else if (sc === 'measurement')
    {
        isCumulative = false;
    }
    else if (dc === 'energy')
    {
        isCumulative = true;
    }
    else if (dc === 'power')
    {
        isCumulative = false;
    }
    else isCumulative = lu === 'wh' || lu === 'kwh' || lu === 'mwh';

    let rateUnit: string;
    if (lu === 'wh')
    {
        rateUnit = 'W';
    }
    else if (lu === 'kwh')
    {
        rateUnit = 'kW';
    }
    else if (lu === 'mwh')
    {
        rateUnit = 'MW';
    }
    else
    {
        rateUnit = u ? `${u}/h` : '';
    }

    //Locate the index of the sample at or before `time`, linear scan is fine for the ~96 samples a typical 4-day window carries.
    let idx = hist.times.length - 1;
    for (let i = 0; i < hist.times.length; i++)
    {
        if (hist.times[i].getTime() > tMs)
        {
            idx = i - 1;
            break;
        }
    }
    if (idx < 0)
    {
        idx = 0;
    }

    if (!isCumulative)
    {
        //Power sensor: just return the historical value, floored at zero so a net-meter sensor that briefly dipped negative at dusk doesn't surface
        //as "-2 W of production" on the chip.
        return { value: Math.max(0, hist.values[idx]), unit: u };
    }

    //Cumulative: differentiate around the located index.
    let lo = idx;
    let hi = idx + 1 < hist.times.length ? idx + 1 : idx;
    if (lo === hi)
    {
        //At the boundary, fall back to the previous pair.
        lo = Math.max(0, idx - 1);
        hi = idx;
    }
    if (lo === hi)
    {
        //Single-sample history, no rate possible.
        return { value: 0, unit: rateUnit };
    }
    const dtH = (hist.times[hi].getTime() - hist.times[lo].getTime()) / 3_600_000;
    if (dtH <= 0)
    {
        return { value: 0, unit: rateUnit };
    }
    const dv = hist.values[hi] - hist.values[lo];
    if (dv < 0)
    {
        //Counter reset between the two samples → no production
        //(rate is meaningless across a midnight reset).
        return { value: 0, unit: rateUnit };
    }
    return { value: dv / dtH, unit: rateUnit };
}


//Compute the instantaneous PV production rate for "now".
//
//  - Cumulative entity (state_class total_increasing|total,
//    device_class energy, or unit Wh/kWh/MWh) → differentiate
//    over the rolling sample buffer (which is filled live each
//    Lit cycle), anchored on the sample closest to ~60 s ago
//    so the readout reflects the last minute of production.
//  - Instantaneous entity (anything else) → the entity's own
//    state value already IS the rate.
//
//Returns null when no usable rate can be derived (no entity,
//no buffer yet, counter reset). The caller falls back to the
//raw current state in that case so the chip stays populated.
export function currentPvRate(host: PvHost): PvRate | null
{
    if (host._pvCurrent === null)
    {
        return null;
    }

    const entity   = resolvePvLiveEntity(host._energyDefaults);
    const stateObj = host.hass?.states?.[entity];
    const sc       = String(stateObj?.attributes?.state_class  ?? '').toLowerCase();
    const dc       = String(stateObj?.attributes?.device_class ?? '').toLowerCase();
    const u        = (host._pvUnit || '').trim();
    const lu       = u.toLowerCase();

    //HA's classification taxonomy is authoritative when set;
    //fall back to the unit string for entities (custom
    //template sensors mostly) that omit state_class /
    //device_class.
    let isCumulative: boolean;
    if (sc === 'total_increasing' || sc === 'total')
    {
        isCumulative = true;
    }
    else if (sc === 'measurement')
    {
        isCumulative = false;
    }
    else if (dc === 'energy')
    {
        isCumulative = true;
    }
    else if (dc === 'power')
    {
        isCumulative = false;
    }
    else
    {
        isCumulative = lu === 'wh' || lu === 'kwh' || lu === 'mwh';
    }

    if (!isCumulative)
    {
        //Instantaneous sensor, the live state IS the rate. Net-meter
        //sensors can briefly read slightly negative around dawn / dusk
        //or report a few watts of inverter standby at night; floor at
        //zero so the chip never displays "-2 W of production".
        return { value: Math.max(0, host._pvCurrent), unit: u };
    }

    //Choose the rate unit so the formatted readout reads as
    //power, not as energy-per-something. When the source unit
    //is unknown, append "/h" so the user still sees a sensible
    //label (e.g. "12 units/h") instead of a bare number.
    let rateUnit: string;
    if (lu === 'wh')
    {
        rateUnit = 'W';
    }
    else if (lu === 'kwh')
    {
        rateUnit = 'kW';
    }
    else if (lu === 'mwh')
    {
        rateUnit = 'MW';
    }
    else
    {
        rateUnit = u ? `${u}/h` : '';
    }

    //Cumulative path: from this point on we MUST return a rate
    //object, never null. Showing the raw cumulative state on
    //the chip would be flat-out wrong for an "energy total"
    //sensor (e.g. lifetime kWh). When no rate can be derived
    //(entity static all night, no recent samples, no history),
    //we default to 0, that's the truthful answer for a sensor
    //that hasn't moved.

    //Preferred path: use the rolling buffer of live samples. We
    //walk back from the newest to find the sample closest to
    //~60 s ago, that anchors the rate to a "last minute"
    //window the user explicitly asked for. If the buffer
    //doesn't cover a full minute (entity updates rarely), we
    //fall back to the oldest available sample.
    const buf = host._pvSampleBuffer;
    if (buf.length >= 2)
    {
        const last = buf[buf.length - 1];
        const target = last.t - 60_000;
        let prev = buf[0];
        for (const s of buf)
        {
            if (s.t <= target)
            {
                prev = s;
            }
            else
            {
                break;
            }
        }
        const dtH = (last.t - prev.t) / 3_600_000;
        if (dtH > 0)
        {
            const dv = last.v - prev.v;
            if (dv < 0)
            {
                //Counter reset (e.g. "energy today" flipping to
                //0 at midnight), no meaningful rate. Drop the
                //pre-reset samples so the next call works on a
                //clean window.
                host._pvSampleBuffer = [last];
                return { value: 0, unit: rateUnit };
            }
            return { value: dv / dtH, unit: rateUnit };
        }
    }

    //Static-entity heuristic: if the entity hasn't moved for
    //a minute or more, the live state is the same as it was
    //60 s ago by definition, production rate is zero. This
    //resolves the "lifetime kWh sensor at night" case: the
    //cumulative value sits unchanged for hours, so any rate
    //we'd compute against the buffer's single sample would be
    //meaningless; the truthful answer is 0 W.
    const lastUpdatedMs = stateObj?.last_updated
        ? new Date(stateObj.last_updated).getTime()
        : null;
    if (lastUpdatedMs !== null && Date.now() - lastUpdatedMs >= 60_000)
    {
        return { value: 0, unit: rateUnit };
    }

    //Cold-start: the buffer hasn't accumulated two samples
    //yet (we just opened the dashboard) AND the entity has
    //changed in the last minute (otherwise the static check
    //above would have already returned). Diff the last two
    //historical samples so the chip is populated immediately
    //instead of waiting a full minute for a buffer to form.
    const hist = host._pvHistory;
    if (hist && hist.times.length >= 2)
    {
        const lastIdx = hist.times.length - 1;
        const prevIdx = lastIdx - 1;
        const dtH = (hist.times[lastIdx].getTime()
                   - hist.times[prevIdx].getTime()) / 3_600_000;
        if (dtH > 0)
        {
            const dv = hist.values[lastIdx] - hist.values[prevIdx];
            if (dv < 0)
            {
                return { value: 0, unit: rateUnit };
            }
            return { value: dv / dtH, unit: rateUnit };
        }
    }

    //Default for a cumulative entity with no derivable rate
    //yet, better than misleading the user with the lifetime
    //total. Will quickly transition to a real rate as soon as
    //the buffer accumulates two samples (typically < 1 min on
    //a healthy production sensor).
    return { value: 0, unit: rateUnit };
}


//Convert a POWER RATE into watts. Used to drive animation speeds on a unit-agnostic scale, the leader-line dash flow saturates at a fixed wattage no
//matter what unit the user's sensor is in.
//
//Contract: the `value` argument MUST already be an instantaneous power rate (W / kW / MW). Cumulative-energy sensors (Wh / kWh / MWh)
//are caller-side differentiated into a power rate FIRST via pvRateAtTime / currentPvRate before reaching this helper. Passing a raw
//cumulative-energy reading here returns 0 (which pauses any animation that depends on it, instead of silently mis-scaling a kWh
//figure as if it were already in watts), the explicit no-op is meant as a wiring trap for future callers.
export function pvNormalizeToWatts(value: number, unit: string): number
{
    const lu = (unit || '').toLowerCase();
    if (lu === 'kw')
    {
        return value * 1000;
    }
    if (lu === 'mw')
    {
        return value * 1_000_000;
    }
    if (lu === 'w')
    {
        return value;
    }
    return 0;
}


//Total installed peak power for the forecast scaling, derived from the sum of per-string `pv-arrays[].peak-kwp` values.
//We convert kWp to the calibration scalar k (W per percent of STC) by k = kWp * 1000 / 100 = kWp * 10, then multiply by
//the clear-sky percentage to draw the dotted forecast line on the PV chart. Returns null when no array is configured or
//every row is blank, callers then skip the prediction line and the peak-of-day highlights for future days.
//
//WeakMap cache keyed on the config identity, the resolver runs on every chip / chart / dashboard / calibration render
//cycle and the parsed pv-arrays walk is cheap but not free.
const _pvCalibKCache = new WeakMap<HeliosConfig, number | null>();

export function pvCalibK(config: HeliosConfig | undefined): number | null
{
    if (!config)
    {
        return null;
    }
    if (_pvCalibKCache.has(config))
    {
        return _pvCalibKCache.get(config) ?? null;
    }
    const kwp = pvArrays(config).totalKwp;
    if (kwp <= 0)
    {
        _pvCalibKCache.set(config, null);
        return null;
    }
    const result = kwp * 10;
    _pvCalibKCache.set(config, result);
    return result;
}


//Inverter clipping cap in WATTS, derived from the top-level
//`pv-inverter-max-kw` config key. Returns Infinity when unset or
//invalid so callers can apply a `Math.min(value, cap)` clip
//unconditionally without an extra branch.
//
//Only the forecast curve / chips / day-strip kWh totals consume
//this; live PV observation is unaffected (the inverter has
//already clipped the output in hardware before the entity
//reported its value).
const _pvInverterMaxWCache = new WeakMap<HeliosConfig, number>();

export function pvInverterMaxW(config: HeliosConfig | undefined): number
{
    if (!config)
    {
        return Infinity;
    }
    const cached = _pvInverterMaxWCache.get(config);
    if (cached !== undefined)
    {
        return cached;
    }
    const raw = config['pv-inverter-max-kw'];
    const kw  = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
    const result = (!isFinite(kw) || kw <= 0) ? Infinity : kw * 1000;
    _pvInverterMaxWCache.set(config, result);
    return result;
}


//One-time cleanup of the obsolete auto-calibration buffers (an
//earlier release maintained a rolling 14-day fit in localStorage
//and HA's frontend.user_data). Runs at boot, idempotent thanks
//to the cleanup-flag key. Safe to keep forever, drops a few
//bytes per coords pair we ever wrote samples for.
export function wipeLegacyPvCalibStorage(
    hass: any,
    coords: { lat: number; lon: number } | null
): void
{
    try
    {
        if (window.localStorage?.getItem(PV_CALIB_WIPE_FLAG_KEY) === '1')
        {
            return;
        }
    }
    catch (_) { return; }

    try
    {
        const ls = window.localStorage;
        if (ls)
        {
            const stale: string[] = [];
            for (let i = 0; i < ls.length; i++)
            {
                const k = ls.key(i);
                if (k && k.startsWith('helios-pv-calib:') && k !== PV_CALIB_WIPE_FLAG_KEY)
                {
                    stale.push(k);
                }
            }
            for (const k of stale)
            {
                ls.removeItem(k);
            }
            ls.setItem(PV_CALIB_WIPE_FLAG_KEY, '1');
        }
    }
    catch (_) {}

    if (coords && hass?.callWS)
    {
        const haKey = `helios-pv-calib:${coords.lat.toFixed(3)}_${coords.lon.toFixed(3)}`;
        hass.callWS({ type: 'frontend/set_user_data', key: haKey, value: null })
            .catch(() => {});
    }
}


//Resolves the configured PV layout into a flat list of panel
//orientations + pre-normalised shares (sum to 1.0).
//
//Read order, first match wins:
//  1. `pv-arrays`: non-empty array, each entry parsed as
//     { tilt: 0–90, azimuth: 0–360, share: weight }. Missing
//     tilt defaults to 0 (horizontal fast path inside
//     computePvPower, no transposition applied for that entry).
//     Missing azimuth defaults to 180. Missing share triggers
//     equal-split with siblings. Entries with share ≤ 0 are
//     dropped. Shares are normalised so they sum to 1.0 before
//     the caller weights them, so 50/50, 60/60 and 1/1 all
//     produce the same forecast (forgives user typos).
//  2. Legacy `pv-tilt` + `pv-azimuth`: read as a single entry
//     with share = 1.0, but only when `pv-tilt` > 0 (matches the
//     historical behaviour where tilt = 0 / unset skipped the
//     transposition entirely).
//  3. Otherwise empty result, caller uses the horizontal-panel
//     fast path inside computePvPower.
export function pvArrays(
    config: HeliosConfig | undefined
): {
    orientations: PanelOrientation[];
    shares:       number[];
    //Per-array lat/lon override, null when the user left them blank for this entry. Callers fall back to the home coords when null so existing
    //configs keep working unchanged.
    coords:       ({ lat: number; lon: number } | null)[];
    //Per-array height above ground in metres. Used by the LiDAR raycast shading check: a panel high on a south-facing roof clears a low garden fence
    //that a ground-mounted array of the same orientation would sit in the shadow of.
    heightsM:     number[];
    //Total installed peak power of the configured arrays in kWp. Sum of the per-string `peak-kwp` values; zero when no
    //entry supplied a peak-kwp (no forecast then, the chip + chart still render off the live observation).
    totalKwp:     number;
}
{
    const out: PanelOrientation[] = [];
    const sh:  number[]           = [];
    const co:  ({ lat: number; lon: number } | null)[] = [];
    const he:  number[]           = [];
    const kw:  number[]           = [];

    //Parse a single coord value (lat or lon) from the editor's
    //free-form input. Empty / non-numeric / out-of-range values
    //return null so the caller falls back cleanly. The range
    //gate also protects against the editor leaking a 1.0e3
    //typo into the forecast model.
    const parseCoord = (v: unknown, max: number): number | null =>
    {
        if (v === undefined || v === null || v === '')
        {
            return null;
        }
        const n = typeof v === 'number' ? v : parseFloat(String(v));
        if (!isFinite(n))
        {
            return null;
        }
        if (n < -max || n > max)
        {
            return null;
        }
        return n;
    };

    const rawList = config?.['pv-arrays'];
    if (Array.isArray(rawList) && rawList.length > 0)
    {
        for (const entry of rawList)
        {
            if (!entry || typeof entry !== 'object')
            {
                continue;
            }
            const e = entry as Record<string, unknown>;

            //Missing / blank tilt is the editor's "flat install" state. Default to 0; computePvPower then takes the horizontal
            //fast path for this entry, leaving every other entry's transposition intact.
            const rawTilt = e['tilt'];
            const tiltRaw = typeof rawTilt === 'number' ? rawTilt : parseFloat(String(rawTilt ?? ''));
            const tilt    = isFinite(tiltRaw) ? tiltRaw : 0;

            const rawAz = e['azimuth'];
            const az    = typeof rawAz === 'number' ? rawAz : parseFloat(String(rawAz ?? ''));
            const azDeg = isFinite(az) ? ((az % 360) + 360) % 360 : 180;

            //Per-string peak power in kWp (preferred path).
            //NaN when blank; the caller's pv-peak-kwp covers it.
            const rawPeakKwp = e['peak-kwp'];
            let peakKwp: number = NaN;
            if (rawPeakKwp !== undefined && rawPeakKwp !== null && rawPeakKwp !== '')
            {
                const k = typeof rawPeakKwp === 'number' ? rawPeakKwp : parseFloat(String(rawPeakKwp));
                if (isFinite(k) && k > 0)
                {
                    peakKwp = k;
                }
            }

            const rawShare = e['share'];
            //undefined / null share means "equal split with siblings", flag it with NaN and fill in after we know the count of share-less entries.
            let share: number;
            if (rawShare === undefined || rawShare === null || rawShare === '')
            {
                share = NaN;
            }
            else
            {
                const s = typeof rawShare === 'number' ? rawShare : parseFloat(String(rawShare));
                if (!isFinite(s) || s <= 0)
                {
                    //A zero / negative share kills the entry only when no per-string peak-kwp is provided. Otherwise the peak-kwp carries the weight
                    //and the share is ignored, so we still want to keep the entry.
                    if (!isFinite(peakKwp))
                    {
                        continue;
                    }
                    share = NaN;
                }
                else
                {
                    share = s;
                }
            }

            //Per-array coords. Both lat AND lon must parse to
            //valid numbers for the override to apply, otherwise
            //we treat the array as "use home coords" rather
            //than silently using only one half of a partial
            //input (which would just be the home coord paired
            //with an arbitrary 0 on the other axis).
            const arrayLat = parseCoord(e['latitude'],  90);
            const arrayLon = parseCoord(e['longitude'], 180);
            const coords   = (arrayLat !== null && arrayLon !== null)
                ? { lat: arrayLat, lon: arrayLon }
                : null;

            const rawHeight = e['height'];
            const heightRaw = typeof rawHeight === 'number'
                ? rawHeight
                : parseFloat(String(rawHeight ?? ''));
            const heightM = isFinite(heightRaw) && heightRaw >= 0
                ? Math.min(60, heightRaw)
                : DEFAULT_PANEL_HEIGHT_M;

            out.push({
                tiltDeg:    Math.max(0, Math.min(90, tilt)),
                azimuthDeg: azDeg
            });
            sh.push(share);
            co.push(coords);
            he.push(heightM);
            kw.push(peakKwp);
        }

        //Decide which weighting wins for this config:
        //  - If ANY entry carries an explicit peak-kwp, the per-string
        //    kWp values become the shares directly. Missing entries
        //    pick up the mean of explicit ones so a mixed config
        //    (some entries with peak-kwp, some without) still produces
        //    a usable forecast instead of silently dropping the
        //    incomplete arrays.
        //  - Otherwise we fall back to the legacy share field. Blank
        //    shares fill in with the mean of explicit ones (or 1.0
        //    when every entry omitted a share); same equal-split
        //    semantics existing configs rely on.
        const explicitKw = kw.filter(v => isFinite(v));
        if (explicitKw.length > 0)
        {
            const meanKw = explicitKw.reduce((a, b) => a + b, 0) / explicitKw.length;
            for (let i = 0; i < sh.length; i++)
            {
                const w = isFinite(kw[i]) ? kw[i] : meanKw;
                kw[i] = w;
                sh[i] = w;
            }
        }
        else
        {
            const explicit = sh.filter(s => isFinite(s));
            const fillVal  = explicit.length > 0
                ? explicit.reduce((a, b) => a + b, 0) / explicit.length
                : 1;
            for (let i = 0; i < sh.length; i++)
            {
                if (!isFinite(sh[i]))
                {
                    sh[i] = fillVal;
                }
            }
        }
    }

    if (out.length === 0)
    {
        //Legacy single-orientation fallback.
        const rawTilt = config?.['pv-tilt'];
        const tilt    = typeof rawTilt === 'number' ? rawTilt : parseFloat(String(rawTilt ?? ''));
        if (isFinite(tilt) && tilt > 0)
        {
            const rawAz = config?.['pv-azimuth'];
            const az    = typeof rawAz === 'number' ? rawAz : parseFloat(String(rawAz ?? ''));
            out.push({
                tiltDeg:    Math.max(0, Math.min(90, tilt)),
                azimuthDeg: isFinite(az) ? ((az % 360) + 360) % 360 : 180
            });
            sh.push(1);
            co.push(null);
            he.push(DEFAULT_PANEL_HEIGHT_M);
            kw.push(NaN);
        }
    }

    //Total kWp from the per-string `peak-kwp` field, when set. Zero
    //when no entry supplied a peak-kwp (legacy share-only path);
    //the caller's pvCalibK() then falls back to the top-level
    //`pv-peak-kwp`.
    const totalKwp = kw.reduce((a, b) => isFinite(b) ? a + b : a, 0);

    //Normalise to 1.0 so callers can multiply directly without an extra divide per sample. Empty list stays empty → horizontal fast path in the
    //caller.
    const total = sh.reduce((a, b) => a + b, 0);
    if (total > 0)
    {
        for (let i = 0; i < sh.length; i++)
        {
            sh[i] /= total;
        }
    }

    return { orientations: out, shares: sh, coords: co, heightsM: he, totalKwp };
}


//Live context the caller can hand to computePvPowerWeighted to
//refine the prediction. Every field is optional, omitting them
//returns the legacy Haurwitz + Liu-Jordan output untouched.
//  airTempC + windMs , feed the Sandia-style cell temperature model
//    in pv-thermal.ts, which derates the PV output for warm cells.
//  raster , the loaded LiDAR nDSM; when set, each array is ray-
//    tested against the local terrain and the direct beam is
//    zeroed on shaded arrays.
export interface PvWeightedContext
{
    airTempC?: number;
    windMs?:   number;
    raster?:   NdsmRaster | null;
}


//Forecast PV percentage at a single sample, summed across every configured array weighted by its share of the total kWp. Falls
//through to the horizontal-panel fast path inside computePvPower when no array is configured (returns the GHI-normalised value).
export function computePvPowerWeighted(
    config: HeliosConfig | undefined,
    t: Date,
    lat: number,
    lon: number,
    cloudPct: number,
    ctx?: PvWeightedContext,
): number
{
    const { orientations, shares, coords, heightsM } = pvArrays(config);
    const baseCtx = (ctx && (isFinite(ctx.airTempC ?? NaN) || isFinite(ctx.windMs ?? NaN)))
        ? { airTempC: ctx.airTempC, windMs: ctx.windMs }
        : undefined;

    if (orientations.length === 0)
    {
        //No declared orientation: take the horizontal-panel fast
        //path with optional thermal context. LiDAR shading isn't
        //meaningful at this granularity (we don't know where the
        //panels physically are), so we skip the raycast.
        return computePvPower(t, lat, lon, cloudPct, undefined, baseCtx);
    }

    //One sun-position lookup per pass; reused for every array's
    //shading check. getSunPosition has its own single-entry cache
    //but the entry key is per-coords, so a multi-array install would
    //thrash the cache otherwise.
    const sun = ctx?.raster
        ? getSunPosition(t, lat, lon)
        : null;

    let acc = 0;
    for (let i = 0; i < orientations.length; i++)
    {
        //Per-array coordinates override the home-level fallback
        //when set. Used by installs where panels sit elsewhere
        //than the home (e.g. ground-mounted in a clearing while
        //the home itself is shaded), so each entry's sun
        //position math runs at its true location. The cloud
        //input is still the home-fetched series, since
        //Open-Meteo's grid resolution is coarse enough that
        //300 m of offset lands in the same cell.
        const arrayLat = coords[i]?.lat ?? lat;
        const arrayLon = coords[i]?.lon ?? lon;

        //LiDAR raycast: opaque obstacle between the panel and the
        //sun zeros the direct beam component on this array. Diffuse
        //+ ground still contribute, so a shaded panel doesn't drop
        //to 0, just to ~25-30 % of its unshaded clear-sky output.
        const shaded = (ctx?.raster && sun)
            ? isPanelShaded(
                ctx.raster, arrayLat, arrayLon,
                heightsM[i] ?? DEFAULT_PANEL_HEIGHT_M,
                sun.altitude, sun.azimuth)
            : false;

        const arrayCtx = (baseCtx || shaded)
            ? { airTempC: baseCtx?.airTempC, windMs: baseCtx?.windMs, shading: shaded }
            : undefined;
        acc += computePvPower(t, arrayLat, arrayLon, cloudPct, orientations[i], arrayCtx) * shares[i];
    }
    return acc;
}


//Format a PV reading for the chip below the home. The display
//auto-rescales W → kW when the magnitude crosses a threshold so
//a 4500 W reading prints as "4.5 kW" rather than the noisier
//"4500 W". Energy units (kWh / Wh) keep their native unit and
//get a single decimal, daily totals usually sit in the 0–50 kWh
//band where one decimal is the right amount of precision.
export function formatPvValue(hass: any, value: number, unit: string): string
{
    const u = (unit || '').trim();
    const lu = u.toLowerCase();

    if (lu === 'w' && Math.abs(value) >= 1000)
    {
        return `${formatLocalisedNumber(hass, value / 1000, 2)} kW`;
    }
    if (lu === 'w')
    {
        return `${formatLocalisedNumber(hass, value, 0, true)} W`;
    }
    if (lu === 'kw')
    {
        return `${formatLocalisedNumber(hass, value, 2)} kW`;
    }
    if (lu === 'wh')
    {
        if (Math.abs(value) >= 1000)
        {
            return `${formatLocalisedNumber(hass, value / 1000, 1)} kWh`;
        }
        return `${formatLocalisedNumber(hass, value, 0, true)} Wh`;
    }
    if (lu === 'kwh' || lu === 'mwh')
    {
        return `${formatLocalisedNumber(hass, value, 1)} ${u}`;
    }
    //Fallback for arbitrary units, keep one decimal of precision and let the entity's own unit string carry through.
    const formatted = Math.abs(value) >= 100
        ? formatLocalisedNumber(hass, value, 0, true)
        : formatLocalisedNumber(hass, value, 1);
    return u ? `${formatted} ${u}` : formatted;
}
