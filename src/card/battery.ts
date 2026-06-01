//Home-battery data subsystem: live SoC + power polling, history fetch, scrub-time sampling, today's energy aggregation, chip formatting, and the user
//invert preference.
//
//Same host-driven pattern as card/pv.ts: the card owns the `@state` battery fields, the functions in this module read / write them through a
//structural BatteryHost interface so Lit's reactivity keeps working transparently.

import type { HeliosConfig } from '../helios-config';
import { formatLocalisedNumber } from './format';
import { pvNormalizeToWatts } from './pv';
import { callWSWithTimeout, WsTimeoutError } from './ws-timeout';


//-----------------------------------------------------------------
//Module-level cache for the battery history fetch. Survives Lit
//element unmount + remount (the user navigating away from the
//Helios card and back) the same way the PV cache does in pv.ts.
//15-minute TTL covers the most common nav-around-the-dashboard
//pattern without serving stale data forever. See #159.

const BATTERY_CACHE_TTL_MS = 15 * 60_000;

interface BatteryHistoryCacheEntry
{
    soc:   BatteryHistory;
    power: BatteryHistory;
    ts:    number;
}

const _batteryHistoryCache: Map<string, BatteryHistoryCacheEntry> = new Map();

function batteryHistoryCacheGet(key: string): BatteryHistoryCacheEntry | null
{
    const e = _batteryHistoryCache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > BATTERY_CACHE_TTL_MS)
    {
        _batteryHistoryCache.delete(key);
        return null;
    }
    return e;
}


//Wipe the module-level battery cache. Called from the card's `resetDataCache()` hook so the editor's "reset" button actually drops
//the cross-mount memo.
export function clearBatteryModuleCaches(): void
{
    _batteryHistoryCache.clear();
}


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


//Resolved battery-bank entry. The chip on the card aggregates N banks into a single capacity-weighted SoC + summed signed power, but the
//trainer needs per-bank SoC history (the cutoff guard skips a bucket only when ALL banks are at or above the threshold, i.e. the min SoC
//across banks is the right signal). parseBatteryBanks turns the user's YAML into this structural list and folds the legacy flat keys
//(battery-soc-entity / battery-power-entity / battery-power-invert) into a single-bank list when `batteries:` is absent.
export interface BatteryBank
{
    //Display name used in editor row headers ("Bank 1" / "House battery" / etc.). Always set after parse: a missing or blank value defaults
    //to "Battery N" so the editor never shows a nameless row.
    name:         string;
    socEntity:    string;
    powerEntity:  string;
    powerInvert:  boolean;
    //Weight applied when capacity-averaging SoC across banks. Default 1 (equal weight) when not specified, so the average becomes a flat
    //unweighted mean when all banks are the same size; set explicitly when bank sizes differ so the displayed SoC reflects the real
    //stored-energy ratio. Always > 0 after parse.
    capacityKwh:  number;
}


//Read the user's battery config into a normalised bank list. The `batteries:` array takes precedence over the legacy flat keys; when
//absent and at least one of the flat keys is set, the flat keys are wrapped in a single-bank list so the rest of the engine speaks one
//shape regardless of how the config is authored. Returns an empty array when no battery is configured (the chip / trainer paths then
//early-out without touching hass.states).
//
//WeakMap cache: the parsed bank list is a pure function of the
//config object identity. It was previously walked on every render
//(chip + chart + dashboard + trainer + multiple call sites in pv.ts
//), each call iterating the batteries array and string-trimming
//every entry.
const _parseBatteryBanksCache = new WeakMap<HeliosConfig, BatteryBank[]>();

export function parseBatteryBanks(config: HeliosConfig | undefined): BatteryBank[]
{
    if (!config) return [];
    const cached = _parseBatteryBanksCache.get(config);
    if (cached !== undefined) return cached;
    const result = _parseBatteryBanksImpl(config);
    _parseBatteryBanksCache.set(config, result);
    return result;
}


//Variant of parseBatteryBanks that falls back to the HA Energy
//dashboard's battery source when the user-configured banks come
//back empty. Lets the card light up the Battery + SoC chips
//automatically as long as the user wired `stat_energy_from` and /
//or `stat_soc` in the dashboard energy preferences.
//
//Returns the explicit user banks untouched when present; otherwise
//synthesises a single-bank list backed by the dashboard defaults.
export function effectiveBatteryBanks(
    config:    HeliosConfig | undefined,
    _defaults: { batteryPowerEntity: string | null; batterySocEntity: string | null },
): BatteryBank[]
{
    //HA Energy auto-detect fallback was retired in 1.8.0 alongside
    //the grid one. The user-configured banks (either via the new
    //`batteries:` array or the legacy flat `battery-soc-entity` /
    //`battery-power-entity` keys) are the only source. Without
    //explicit config, the SoC + power chips collapse cleanly.
    return parseBatteryBanks(config);
}


function _parseBatteryBanksImpl(config: HeliosConfig): BatteryBank[]
{
    const raw = config['batteries'];
    if (Array.isArray(raw) && raw.length > 0)
    {
        const banks: BatteryBank[] = [];
        for (const e of raw)
        {
            if (!e || typeof e !== 'object') continue;
            const obj = e as Record<string, unknown>;
            const soc   = String(obj['soc-entity']   ?? '').trim();
            const power = String(obj['power-entity'] ?? '').trim();
            if (!soc && !power) continue;
            const capRaw = obj['capacity-kwh'];
            const cap = typeof capRaw === 'number' ? capRaw : parseFloat(String(capRaw ?? ''));
            banks.push({
                name:        String(obj['name'] ?? '').trim() || `Battery ${banks.length + 1}`,
                socEntity:   soc,
                powerEntity: power,
                powerInvert: obj['power-invert'] === true,
                capacityKwh: isFinite(cap) && cap > 0 ? cap : 1,
            });
        }
        if (banks.length > 0) return banks;
    }
    const soc   = String(config['battery-soc-entity']   ?? '').trim();
    const power = String(config['battery-power-entity'] ?? '').trim();
    if (!soc && !power) return [];
    return [{
        name:        'Battery 1',
        socEntity:   soc,
        powerEntity: power,
        powerInvert: config['battery-power-invert'] === true,
        capacityKwh: 1,
    }];
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
    readonly _energyDefaults: { batteryPowerEntity: string | null; batterySocEntity: string | null };

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


//Linear interpolation of a sorted (times, values) series at an arbitrary instant. Returns null when the series is empty; clamps to the
//endpoints outside the range so a bank that started reporting mid-day doesn't drag the aggregate to NaN for the earlier samples.
function interpAt(s: BatteryHistory, ms: number): number | null
{
    const t = s.times;
    const v = s.values;
    const n = t.length;
    if (n === 0) return null;
    if (ms <= t[0].getTime()) return v[0];
    if (ms >= t[n - 1].getTime()) return v[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1)
    {
        const mid = (lo + hi) >> 1;
        if (t[mid].getTime() <= ms) lo = mid;
        else                        hi = mid;
    }
    const t0 = t[lo].getTime();
    const t1 = t[hi].getTime();
    if (t1 === t0) return v[lo];
    const f = (ms - t0) / (t1 - t0);
    return v[lo] + (v[hi] - v[lo]) * f;
}


//Fold N per-bank series into one aggregated series. The output time grid is the union of all input timestamps (sorted, deduped); at each
//instant we interpolate every bank's series and combine: capacity-weighted average for SoC, plain sum for power. Banks with empty series
//are skipped at each instant so a partially-reporting bank doesn't poison the aggregate. Returns an empty series when every bank is empty.
function aggregateBankHistory(
    banks:   BatteryBank[],
    series:  BatteryHistory[],
    mode:    'soc' | 'power'
): BatteryHistory
{
    const tset = new Set<number>();
    for (const s of series)
    {
        for (const ts of s.times) tset.add(ts.getTime());
    }
    if (tset.size === 0) return { times: [], values: [] };
    const tsorted = Array.from(tset).sort((a, b) => a - b);
    const times:  Date[]   = new Array(tsorted.length);
    const values: number[] = new Array(tsorted.length);
    let n = 0;
    for (const ms of tsorted)
    {
        if (mode === 'soc')
        {
            let num = 0;
            let den = 0;
            for (let i = 0; i < banks.length; i++)
            {
                const v = interpAt(series[i], ms);
                if (v === null) continue;
                num += v * banks[i].capacityKwh;
                den += banks[i].capacityKwh;
            }
            if (den === 0) continue;
            times[n]  = new Date(ms);
            values[n] = num / den;
            n++;
        }
        else
        {
            let sum:   number = 0;
            let saw:   boolean = false;
            for (let i = 0; i < banks.length; i++)
            {
                const v = interpAt(series[i], ms);
                if (v === null) continue;
                sum += v;
                saw  = true;
            }
            if (!saw) continue;
            times[n]  = new Date(ms);
            values[n] = sum;
            n++;
        }
    }
    times.length  = n;
    values.length = n;
    return { times, values };
}


//Live + history refresh, called from the card on every lifecycle
//cycle. Reads SoC and power from hass.states for every configured
//bank, aggregates into the chip's source-of-truth fields
//(capacity-weighted SoC, summed signed power, first non-empty unit),
//and dispatches a history fetch when the (entities, range) tuple
//changes. The aggregated history fields are populated in
//fetchBatteryHistory after the WS response lands.
export function refreshBattery(host: BatteryHost): void
{
    if (!host.hass) return;

    const banks = effectiveBatteryBanks(host.config, host._energyDefaults);

    //No banks configured at all: clear everything and bail. This
    //keeps a stale graph from lingering when the user wipes the
    //battery section in the editor.
    if (banks.length === 0)
    {
        if (host._batterySoc           !== null) host._batterySoc          = null;
        if (host._batteryPower         !== null) host._batteryPower        = null;
        if (host._batteryPowerUnit     !== '')   host._batteryPowerUnit    = '';
        if (host._batterySocHistory    !== null) host._batterySocHistory   = null;
        if (host._batteryPowerHistory  !== null) host._batteryPowerHistory = null;
        host._batteryFetchKey = '';
        return;
    }

    //Capacity-weighted SoC + summed signed power across all banks. Each bank's invert flag is applied to its own raw reading first so a
    //mixed-vendor install (one BMS reporting charge as positive, another reporting it as negative) still produces a coherent total. SoC
    //per bank is clamped to [0, 100] because some BMS entities briefly report 100.5 % during absorption or dip negative around calibra-
    //tion, neither of which is meaningful to the user.
    let socNum = 0;
    let socDen = 0;
    let powSumW: number | null = null;
    for (const b of banks)
    {
        if (b.socEntity)
        {
            const so = host.hass.states?.[b.socEntity];
            const v  = so ? parseFloat(so.state) : NaN;
            if (isFinite(v))
            {
                const clamped = Math.max(0, Math.min(100, v));
                socNum += clamped * b.capacityKwh;
                socDen += b.capacityKwh;
            }
        }
        if (b.powerEntity)
        {
            const so = host.hass.states?.[b.powerEntity];
            const v  = so ? parseFloat(so.state) : NaN;
            if (isFinite(v))
            {
                //Normalise to watts BEFORE summing so a mixed-vendor setup (one BMS in W, another in kW) produces a coherent aggregate
                //rather than `1500 + 2.5 = 1502.5` of nonsense. The chip formatter auto-promotes back to kW above 1 000 W, so the user
                //sees the right unit suffix regardless of how each bank reported.
                const unit  = String(so.attributes?.unit_of_measurement ?? '');
                const watts = pvNormalizeToWatts(v, unit);
                const signed = b.powerInvert ? -watts : watts;
                powSumW = (powSumW ?? 0) + signed;
            }
        }
    }
    const nextSoc  = socDen > 0 ? socNum / socDen : null;
    //Aggregated unit is always W; banks may have reported in mixed units but pvNormalizeToWatts has folded them to a single scale.
    const nextUnit = powSumW !== null ? 'W' : '';
    if (nextSoc  !== host._batterySoc)       host._batterySoc       = nextSoc;
    if (powSumW  !== host._batteryPower)     host._batteryPower     = powSumW;
    if (nextUnit !== host._batteryPowerUnit) host._batteryPowerUnit = nextUnit;

    //History fetch, only when the (entities, range) tuple changed.
    //Without this guard we'd reissue the WS command on every Lit
    //cycle (e.g. every clock tick).
    if (!host._timeRange || host._batteryFetching) return;
    const rangeKey = `${host._timeRange.start.getTime()}|${host._timeRange.end.getTime()}`;
    //Bank signature: entity ids + invert flags + capacity weights. Capacity weights enter the key so a mid-session edit of a kWh field
    //invalidates the cached history and triggers a refetch that re-applies the new weighting at parse time.
    const sig = banks.map(b =>
        `${b.socEntity}|${b.powerEntity}|inv=${b.powerInvert ? 1 : 0}|cap=${b.capacityKwh}`
    ).join('&');
    const fetchKey = `${sig}@${rangeKey}`;
    if (fetchKey === host._batteryFetchKey) return;
    host._batteryFetchKey = fetchKey;

    //Cache hit short-circuits the WS round-trip: the user navigates away from the Helios card and back, the module-level cache still has
    //the previous aggregation parsed and ready, no recorder hit. Cache invalidates on TTL (15 min) or on any (bank signature / range)
    //change since that flips the fetch key. See #159.
    const cached = batteryHistoryCacheGet(fetchKey);
    if (cached)
    {
        host._batterySocHistory   = cached.soc;
        host._batteryPowerHistory = cached.power;
        return;
    }
    fetchBatteryHistory(host, banks, host._timeRange.start, host._timeRange.end, fetchKey);
}


//Parse a raw-history payload (`history/history_during_period`, minimal response shape) into a `BatteryHistory`. Accepts both `lu` (numeric epoch
//seconds) and `last_updated` / `last_changed` (ISO strings) so the function survives HA payload variations across releases.
function parseRawBatteryHistory(arr: any[]): BatteryHistory
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
        if (!isFinite(v)) continue;
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
        if (!ts || isNaN(ts.getTime())) continue;
        times.push(ts);
        values.push(v);
    }
    return { times, values };
}


//Parse a statistics payload (`recorder/statistics_during_period`) into a `BatteryHistory`. SoC and power sensors most often expose
//`state_class: measurement` (Victron, Solis, Tesla, Pylontech, BYD, SonnenBatterie BMS) and the relevant column is `mean`. Some setups
//wire a cumulative-energy kWh counter as the battery power source instead (`state_class: total_increasing`), in which case `mean` is
//`null` and `state` carries the cumulative reading at the bucket end. We prefer `mean` when present and fall back to `state` so the
//slot lands populated either way. See #161.
function parseBatteryStats(arr: any[]): BatteryHistory
{
    const times:  Date[]   = [];
    const values: number[] = [];
    for (const item of arr ?? [])
    {
        const startMs = parseStatBoundary(item?.start);
        const endMs   = parseStatBoundary(item?.end);
        if (startMs === null) continue;
        let valueRaw: unknown = item?.mean;
        let anchorAtEnd = false;
        if (valueRaw === null || valueRaw === undefined)
        {
            valueRaw = item?.state;
            //Cumulative readings anchor at the bucket end so consecutive deltas attribute correctly to the bucket that produced them.
            anchorAtEnd = true;
        }
        if (valueRaw === null || valueRaw === undefined) continue;
        const v = typeof valueRaw === 'number' ? valueRaw : parseFloat(String(valueRaw));
        if (!isFinite(v)) continue;
        const anchorMs = anchorAtEnd
            ? (endMs ?? startMs)
            : (endMs !== null ? (startMs + endMs) / 2 : startMs);
        times.push(new Date(anchorMs));
        values.push(v);
    }
    return { times, values };
}


//Coerce a `start` / `end` statistics field into a millisecond epoch. Same accept set as the PV stats parser, kept here as a private copy so
//`battery.ts` stays import-light (a single circular guard through `pv.ts` would otherwise be needed).
function parseStatBoundary(raw: unknown): number | null
{
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000;
    if (typeof raw === 'string')
    {
        const asNum = Number(raw);
        if (Number.isFinite(asNum) && asNum > 1e9) return asNum > 1e12 ? asNum : asNum * 1000;
        const d = new Date(raw);
        const t = d.getTime();
        return isFinite(t) ? t : null;
    }
    return null;
}


//Single-call history fetch for the battery overlay. Tries `recorder/statistics_during_period` first because it's the only path that scales
//on a Victron BMS reporting at >1 Hz (5-min buckets, ~576 rows for a 2-day window per entity vs ~150-200k raw). When the entity has no
//long-term-statistics tracking (no `state_class`) the stats array comes back empty and we fall back to a raw `history/history_during_period`
//fetch with `significant_changes_only` so the legacy code path still works for users with custom or non-`measurement` entities.
//
//Both entities (when configured) are bundled into one WS roundtrip so multi-bank installs pay one round-trip per call, not 2N.
export async function fetchBatteryHistory(
    host:     BatteryHost,
    banks:    BatteryBank[],
    start:    Date,
    end:      Date,
    cacheKey: string = '',
): Promise<void>
{
    if (!host.hass?.callWS || banks.length === 0) return;
    host._batteryFetching = true;
    try
    {
        //History only exists up to "now", the future half of the timeline has no battery data. Clamp the fetch end so we don't waste a roundtrip on
        //empty future buckets.
        const now = new Date();
        const fetchEnd = end > now ? now : end;
        if (start >= fetchEnd)
        {
            host._batterySocHistory   = { times: [], values: [] };
            host._batteryPowerHistory = { times: [], values: [] };
            return;
        }

        //Single WS roundtrip carries every bank's SoC + power entity. HA dedupes server-side so duplicate ids in different banks (which
        //would only happen if the user accidentally configured two banks against the same physical entity) don't multiply the cost.
        const idsSet = new Set<string>();
        for (const b of banks)
        {
            if (b.socEntity)   idsSet.add(b.socEntity);
            if (b.powerEntity) idsSet.add(b.powerEntity);
        }
        const ids = Array.from(idsSet);

        //Per-entity parsed series, populated from whichever fetch path returns usable data. Both paths produce the same `BatteryHistory`
        //shape so the per-bank aggregation downstream is source-agnostic.
        const perEntity: Record<string, BatteryHistory> = {};

        const statsResult: any = await callWSWithTimeout<any>(host.hass, {
            type:           'recorder/statistics_during_period',
            start_time:     start.toISOString(),
            end_time:       fetchEnd.toISOString(),
            statistic_ids:  ids,
            period:         '5minute',
            //Both fields, because a setup that wires a cumulative kWh meter as the battery power source has `mean: null` per bucket
            //(measurement assumption breaks). Asking for `state` too lets the parser cover both wirings in one round-trip. See #161.
            types:          ['mean', 'state'],
        });
        const statsUsable = ids.some(id => Array.isArray(statsResult?.[id]) && statsResult[id].length > 0);
        if (statsUsable)
        {
            for (const id of ids)
            {
                perEntity[id] = parseBatteryStats(statsResult?.[id] ?? []);
            }
        }
        else
        {
            //Either no entity is LTS-tracked (no `state_class`) or the recorder hasn't seen the window yet. Fall back to raw history with
            //`significant_changes_only` so high-frequency installs still benefit from server-side dedup.
            const rawResult: any = await callWSWithTimeout<any>(host.hass, {
                type:                     'history/history_during_period',
                start_time:               start.toISOString(),
                end_time:                 fetchEnd.toISOString(),
                entity_ids:               ids,
                minimal_response:         true,
                no_attributes:            true,
                significant_changes_only: true,
            });
            for (const id of ids)
            {
                perEntity[id] = parseRawBatteryHistory(rawResult?.[id] ?? []);
            }
        }

        //Per-bank parsed series, kept around for the aggregation. Bank index parallel to `banks`; either side may be empty when the bank
        //didn't define that entity or HA returned no samples in range.
        const bankSocSeries:   BatteryHistory[] = [];
        const bankPowerSeries: BatteryHistory[] = [];
        for (const b of banks)
        {
            let socS: BatteryHistory = { times: [], values: [] };
            if (b.socEntity)
            {
                socS = perEntity[b.socEntity] ?? { times: [], values: [] };
                //Clamp SoC samples to [0, 100] in the history too, same out-of-range tolerance as the live read.
                socS = { times: socS.times, values: socS.values.map(v => Math.max(0, Math.min(100, v))) };
            }
            let powS: BatteryHistory = { times: [], values: [] };
            if (b.powerEntity)
            {
                powS = perEntity[b.powerEntity] ?? { times: [], values: [] };
                //Apply this bank's own invert preference once at parse time, identical to the live ingest path, so every chart / sum
                //that consumes _batteryPowerHistory sees "positive = charging" regardless of how each bank's entity is wired.
                if (b.powerInvert)
                {
                    powS = { times: powS.times, values: powS.values.map(v => -v) };
                }
            }
            bankSocSeries.push(socS);
            bankPowerSeries.push(powS);
        }

        //Aggregate the per-bank series into the chip's source-of-truth fields. The aggregated time grid is the union of all per-bank
        //timestamps, sorted; per-timestamp we interpolate each bank's series at that instant, then capacity-weight SoC and sum signed
        //power across banks. This produces a continuous aggregated stream even when the BMS entities tick at different cadences (a
        //common case in mixed-vendor setups).
        const socAgg   = aggregateBankHistory(banks, bankSocSeries,   'soc');
        const powerAgg = aggregateBankHistory(banks, bankPowerSeries, 'power');
        host._batterySocHistory   = socAgg;
        host._batteryPowerHistory = powerAgg;

        //Persist the aggregated outcome for the next mount. Cross-mount cache hits short-circuit the WS round-trip entirely on the
        //navigation case that drives the user-visible "lag on each return" symptom from #155.
        if (cacheKey)
        {
            _batteryHistoryCache.set(cacheKey, { soc: socAgg, power: powerAgg, ts: Date.now() });
        }
    }
    catch (e)
    {
        if (e instanceof WsTimeoutError)
        {
            console.warn(`[HELIOS] battery history fetch timed out (${e.timeoutMs} ms), rendering without past-day curve.`);
        }
        else
        {
            console.warn('[HELIOS] battery history fetch failed:', e);
        }
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
