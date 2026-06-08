//Grid import / export readout, the live numeric value read from
//hass.states and the past-scrub derivation from the rolling buffer
//backed by HA recorder history.
//
//Entity resolution is 100 % HA Energy dashboard (config/energy global
//settings): the card pulls the cumulative kWh meters from
//`stat_energy_from` (import) / `stat_energy_to` (export) and the live
//signed-power sensors from `stat_rate` / `power_config.stat_rate`. A
//multi-source install (split tariffs, separate phase meters, multiple
//grid connections) is summed at consumer side: every meter declared
//on every grid source in HA Energy contributes; the last-updated
//meter wins on the live chip, every meter's bracketed slope sums on
//the scrub path.
//
//Per-source sign inversion is honoured via HA Energy's own
//`power_config.stat_rate_inverted` switch, surfaced through
//`invertedRateEntities[]` on the EnergyDefaults snapshot. The card
//applies the flip at sample time so downstream consumers (chip,
//leader, scrub buffer) see the canonical "positive = import"
//convention regardless of how the user wired the source.
//
//Both live and past-scrub derivations share one bracketed-slope
//helper. The bracket is chosen so that the time span across the two
//samples is at least MIN_SLOPE_SPAN_MS, expanding outward when the
//immediate bracket is too narrow. This keeps a 1 Wh meter quantum
//from projecting into a hundred-watt spike when two consecutive
//samples landed 5 s apart, while still using the natural sample
//cadence on sparse meters (Linky 30 min, Shelly 60 s).

import { pvNormalizeToWatts } from './pv';
import { callWSWithTimeout, WsTimeoutError } from './ws-timeout';
import type { EnergyDefaults } from './energy-prefs';
import { beginLoadingPhase, endLoadingPhase, type LoadingTrackerHost } from './loading-tracker';


type Sample = { t: number; v: number; lastChangeT?: number | null };


//Per-entity wall-clock of the LAST successful backfill. The backfill itself walks the past 72 h, and on a long-uptime session (tablet
//that never sleeps, kiosk display) the oldest in-buffer samples drop out of the 72 h window after about a day. Storing a timestamp
//instead of a plain "done" flag lets us re-issue the backfill on a 24 h cadence so the buffer head keeps tracking with real time and
//scrub never falls off the buffer's back edge.
const _historyFetched   = new Map<string, number>();
//Per-entity "do not retry before this wall-clock" for entities whose last fetch ended in a `WsTimeoutError`. Without the cooldown the
//next `refreshGrid` tick (every clock tick, on every Lit cycle) would re-issue the WS call and pile up timeouts on an already-slow
//recorder. 2 minutes is short enough that a transient recorder stall recovers gracefully and long enough that we do not contribute
//to the load.
const _historyFailedUntil = new Map<string, number>();
const _historyInflight  = new Set<string>();
//Refresh cadence: re-issue the backfill once per hour so the buffer head stays fresh on long-uptime sessions. The old 24 h cadence
//combined with the empty-result fetch-marker bug below would lock a card out of the recorder for a full day after a single empty
//response, which made past-scrub chips read blank until the editor's reset button was pressed.
const GRID_FETCH_REFRESH_MS = 60 * 60_000;
//2 min cooldown after a `WsTimeoutError`, prevents the per-tick retry storm.
const GRID_FETCH_COOLDOWN_MS = 2 * 60_000;


//Wipe the module-level grid history latch. Called from the card's `resetDataCache()` hook so the editor's "reset" button forces a
//fresh 72 h backfill on the next refresh instead of relying on the already-fetched marker.
export function clearGridModuleCaches(): void
{
    _historyFetched.clear();
    _historyFailedUntil.clear();
    _historyInflight.clear();
}
//Two-tier backfill recipe to keep the recorder happy on high-
//frequency grid meters (Victron Cerbo, JK BMS, IoT smart meters at
//1 Hz) without losing past-scrub coverage:
//
//  - RAW the last 6 hours, full resolution + significant_changes_only.
//    This is the heaviest call (~10-20k rows per entity at 1 Hz) but
//    it stays bounded and the recorder handles it in 1 to 2 s.
//  - LTS (5-minute period) the previous 4 days 18 hours, total
//    backfill coverage 5 days. ~1440 rows per entity, near-free on
//    the recorder regardless of source frequency since the rows
//    come from HA's pre-aggregated `statistics_short_term` table.
//
//Scrubbing inside 5 days past returns a real bracketed slope. Past
//5 days pickBracket refuses to extrapolate (returns null) and the
//chip displays nothing rather than a fabricated value. Live
//readings stay accurate at all times.
const GRID_HISTORY_WINDOW_MS = 6 * 60 * 60_000;
const GRID_LTS_WINDOW_MS     = 5 * 24 * 60 * 60_000;
//In-memory retention window aligned with the LTS backfill so live
//accumulation never trims off bracket-relevant history.
const GRID_SAMPLE_WINDOW_MS = 5 * 24 * 60 * 60_000;
const GRID_SAMPLE_MAX       = 16384;
//Minimum time span a slope must cover before it is trusted. Below
//this the 1 Wh meter quantum dominates the numerator and the
//derivation becomes meaningless (1 Wh / 5 s -> 720 W spike with no
//physical meaning). 60 s keeps that error under ~60 W on a 1 Wh
//meter and is short enough that the chip stays responsive.
const MIN_SLOPE_SPAN_MS = 60_000;
//Live derivation horizon. When picking the bracket for the LIVE
//chip we target now() and look for samples within this many ms
//behind now. Older brackets are not interesting for "what is
//flowing right now" and bias the chip toward a stale average. 10
//min covers Linky histo mode (10 min push cadence) without
//showing an outright stale half-hour-old value.
const LIVE_SLOPE_LOOKBACK_MS = 10 * 60_000;
//Edge tolerance for SCRUB targets that sit just outside the
//buffer. When the user drags the scrub past the buffer's first
//sample by less than this, we use the first bracket as a "best
//effort" answer; beyond that we return null so the chip hides
//cleanly instead of showing a misleading constant slope.
const SCRUB_EDGE_TOLERANCE_MS = 10 * 60_000;


export interface GridHost extends LoadingTrackerHost
{
    readonly hass:   any;
    //Optional snapshot of HA Energy dashboard defaults, populated by
    //`card/energy-prefs.ts` via a long-running subscription. When the
    //user has `stat_rate` sensors configured on grid sources, Helios
    //layers a LIVE-only override on top of the directional kWh
    //derivation so the chip matches the value the official Energy
    //dashboard displays to the watt.
    readonly _energyDefaults?: EnergyDefaults;

    requestUpdate(): void;

    _gridImportValue: number | null;
    _gridImportUnit:  string;
    _gridExportValue: number | null;
    _gridExportUnit:  string;
    //Unit per entity (kwh / wh / mwh / w / kw). Needed for the
    //past-scrub derivation so we can convert the raw value delta
    //back to watts independently of which entity sourced the
    //samples in the buffer.
    _gridImportUnits: Map<string, string>;
    _gridExportUnits: Map<string, string>;

    //Per-entity rolling buffers, keyed by entity_id. Multi-entity
    //installs (e.g. EASF01 + EASF02) keep one buffer per source.
    _gridImportSamples: Map<string, Sample[]>;
    _gridExportSamples: Map<string, Sample[]>;
    //Last derived watts per entity, tagged with the wall-clock at
    //which the derivation landed. Used to pick the "most recently
    //updated" entity when the slot has several entities wired.
    _gridImportLastDerived: Map<string, { watts: number; t: number }>;
    _gridExportLastDerived: Map<string, { watts: number; t: number }>;
}


//Per-host counter tracking how many grid-history fetches are currently in flight for this card.
//Aggregates per-entity fetches into a single 'grid-history' phase: the first dispatched fetch begins
//the phase, the last completed fetch ends it. WeakMap so the entry GCs with its card.
const _gridInflightByHost = new WeakMap<object, number>();
function gridPhaseEnter(host: GridHost): void
{
    const count = (_gridInflightByHost.get(host) ?? 0) + 1;
    _gridInflightByHost.set(host, count);
    if (count === 1)
    {
        beginLoadingPhase(host, 'grid-history');
    }
}
function gridPhaseLeave(host: GridHost): void
{
    const count = Math.max(0, (_gridInflightByHost.get(host) ?? 1) - 1);
    _gridInflightByHost.set(host, count);
    if (count === 0)
    {
        endLoadingPhase(host, 'grid-history');
    }
}


function ensureHistoryFetched(host: GridHost, entity: string, bufMap: Map<string, Sample[]>): void
{
    if (!host.hass?.callWS)
    {
        return;
    }
    if (_historyInflight.has(entity))
    {
        return;
    }
    const now = Date.now();
    //Cooldown after a previous timeout: do not retry yet.
    const failedUntil = _historyFailedUntil.get(entity);
    if (failedUntil !== undefined && now < failedUntil)
    {
        return;
    }
    //Fresh enough: a previous backfill already landed within the refresh window.
    const lastFetched = _historyFetched.get(entity);
    if (lastFetched !== undefined && now - lastFetched < GRID_FETCH_REFRESH_MS)
    {
        return;
    }
    _historyInflight.add(entity);
    gridPhaseEnter(host);
    const end      = new Date();
    const rawStart = new Date(end.getTime() - GRID_HISTORY_WINDOW_MS);
    const ltsStart = new Date(end.getTime() - GRID_LTS_WINDOW_MS);
    (async (): Promise<void> =>
    {
        try
        {
            //Fire BOTH backfills in parallel through the module-level
            //semaphore. LTS catches the 5 d..6 h slice with 5-minute
            //buckets, raw catches the 6 h..now slice at full resolution
            //with significant_changes_only. BOTH arms are wrapped in a
            //.catch that returns null and arms the cooldown on a
            //WsTimeoutError; that way a single failing arm degrades
            //the buffer to whatever the other arm returned instead of
            //rejecting the whole Promise.all and leaving the buffer
            //empty. The merge code downstream handles ltsArr / rawArr
            //being empty gracefully.
            const armCooldownIfTimeout = (e: unknown): null =>
            {
                if (e instanceof WsTimeoutError)
                {
                    _historyFailedUntil.set(entity, Date.now() + GRID_FETCH_COOLDOWN_MS);
                }
                return null;
            };
            const [ltsResult, rawResult] = await Promise.all([
                callWSWithTimeout<any>(host.hass, {
                    type:          'recorder/statistics_during_period',
                    start_time:    ltsStart.toISOString(),
                    end_time:      rawStart.toISOString(),
                    statistic_ids: [entity],
                    period:        '5minute',
                    //Both fields: power-native sensors populate `mean`,
                    //cumulative-energy sensors populate `state`. The
                    //parser below prefers `mean` and anchors at the
                    //bucket midpoint; falls back to `state` and anchors
                    //at the bucket end so consecutive deltas attribute
                    //to the bucket that produced them.
                    types:         ['mean', 'state'],
                    //Normalise to kWh / W so installs reporting in Wh, MWh or kW land on the same scale the chip + scrub
                    //buffer assume downstream.
                    units:         { energy: 'kWh', power: 'W' },
                }).catch(armCooldownIfTimeout),
                callWSWithTimeout<any>(host.hass, {
                    type:                     'history/history_during_period',
                    start_time:               rawStart.toISOString(),
                    end_time:                 end.toISOString(),
                    entity_ids:               [entity],
                    minimal_response:         true,
                    no_attributes:            true,
                    //Lets HA drop bucket-internal duplicates server-side, lighter recorder load on high-frequency grid meters.
                    significant_changes_only: true,
                }).catch(armCooldownIfTimeout),
            ]);
            const merged: Sample[] = [];
            let lastV: number | null = null;
            let lastChangeT: number | null = null;
            //LTS samples first (older). One per 5-minute bucket.
            const ltsArr: any[] = (ltsResult && (ltsResult as Record<string, unknown>)[entity] as any[]) ?? [];
            for (const item of ltsArr)
            {
                const startMs = parseStatBoundary(item?.start);
                const endMs   = parseStatBoundary(item?.end);
                if (startMs === null)
                {
                    continue;
                }
                let valueRaw: unknown = item?.mean;
                let anchorAtEnd = false;
                if (valueRaw === null || valueRaw === undefined)
                {
                    valueRaw = item?.state;
                    anchorAtEnd = true;
                }
                if (valueRaw === null || valueRaw === undefined)
                {
                    continue;
                }
                const v = parseNumericState(valueRaw);
                if (v === null)
                {
                    continue;
                }
                const t = anchorAtEnd
                    ? (endMs ?? startMs)
                    : (endMs !== null ? (startMs + endMs) / 2 : startMs);
                const realTransition = lastV !== null && lastV !== v;
                if (realTransition || lastChangeT === null)
                {
                    lastChangeT = t;
                }
                merged.push({ t, v, lastChangeT });
                lastV = v;
            }
            //Raw samples next (newer). High-resolution last 6 h.
            const rawArr: any[] = (rawResult && rawResult[entity]) ?? [];
            for (const item of rawArr)
            {
                const sRaw = item?.s ?? item?.state;
                if (sRaw === null || sRaw === undefined || sRaw === 'unavailable' || sRaw === 'unknown' || sRaw === '')
                {
                    continue;
                }
                const v = parseNumericState(sRaw);
                if (v === null)
                {
                    continue;
                }
                const tsRaw = item?.lu ?? item?.lc ?? item?.last_updated ?? item?.last_changed ?? null;
                const t = parseTimestamp(tsRaw);
                if (t === null)
                {
                    continue;
                }
                const realTransition = lastV !== null && lastV !== v;
                if (realTransition || lastChangeT === null)
                {
                    lastChangeT = t;
                }
                merged.push({ t, v, lastChangeT });
                lastV = v;
            }
            //Merge with any live samples that may have already landed
            //while the WS call was in flight, dedupe by timestamp.
            const live = bufMap.get(entity) ?? [];
            for (const s of live)
            {
                merged.push(s);
            }
            merged.sort((a, b) => a.t - b.t);
            const deduped: Sample[] = [];
            for (const s of merged)
            {
                const last = deduped[deduped.length - 1];
                if (last && last.t === s.t)
                {
                    continue;
                }
                deduped.push(s);
            }
            if (deduped.length > 0)
            {
                bufMap.set(entity, deduped);
                //Invalidate the refresh-gate cache on HeliosCard so the next updated() pass runs the FULL
                //refresh chain again, recomputing the slope (and therefore the live grid chip value) from
                //the newly-populated bufMap. Without this the gate short-circuits the refresh because the
                //hass / config / energyDefaults references have not changed since the WS round-trip
                //started, and the chip stays null until something else triggers a render. Symptom on the
                //user side: 'I have to refresh the page to see import / export chips'.
                const h = host as unknown as {
                    _lastRefreshHassRef?:           unknown;
                    _lastRefreshConfigRef?:         unknown;
                    _lastRefreshTimeRangeRef?:      unknown;
                    _lastRefreshEnergyDefaultsRef?: unknown;
                };
                h._lastRefreshHassRef           = undefined;
                h._lastRefreshConfigRef         = undefined;
                h._lastRefreshTimeRangeRef      = undefined;
                h._lastRefreshEnergyDefaultsRef = undefined;
                host.requestUpdate();
                _historyFetched.set(entity, Date.now());
            }
            //Only mark this entity as fetched when we actually got rows back. The previous version set the
            //flag unconditionally on the success path, so a cold recorder (HA just restarted, entity created
            //less than 5 days ago, transient LTS gap) treated as a "successful" empty fetch locked us out of
            //the next backfill for the full GRID_FETCH_REFRESH_MS window. The user could not scrub more than
            //~10 min into the past because the buffer never got beyond the live samples accumulated since
            //then, and the refresh button did not bust the flag, only the editor reset path did.
            _historyFailedUntil.delete(entity);
        }
        catch (e)
        {
            //Live derivation still works once HA pushes state, so a transient backfill failure stays silent on the UI. On a
            //`WsTimeoutError` we arm a short cooldown so the next `refreshGrid` tick does not re-fire the same heavy fetch into a
            //recorder that is already struggling.
            if (e instanceof WsTimeoutError)
            {
                _historyFailedUntil.set(entity, Date.now() + GRID_FETCH_COOLDOWN_MS);
            }
        }
        finally
        {
            _historyInflight.delete(entity);
            gridPhaseLeave(host);
        }
    })();
}


//Coerce a `start` / `end` statistics field into a millisecond epoch.
//Same accept set as the PV / battery / radiation stats parsers,
//copied here so grid.ts stays import-light.
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


export function refreshGrid(host: GridHost): void
{
    if (!host.hass)
    {
        if (host._gridImportValue !== null)
        {
            host._gridImportValue = null;
        }
        if (host._gridImportUnit  !== '')
        {
            host._gridImportUnit  = '';
        }
        if (host._gridExportValue !== null)
        {
            host._gridExportValue = null;
        }
        if (host._gridExportUnit  !== '')
        {
            host._gridExportUnit  = '';
        }
        return;
    }

    //Directional slots run unconditionally so the scrub + chart
    //past-derivation buffers stay warm. They consume the HA Energy
    //dashboard's `stat_energy_from` / `stat_energy_to` cumulative
    //kWh meters and own the past-derivation path.
    readSlot(host, 'import');
    readSlot(host, 'export');

    //HA Energy dashboard alignment: when the user's Energy
    //dashboard config exposes a `stat_rate` sensor on any grid
    //source, mirror HA's live read on top of the directional
    //slope so the LIVE chip matches the value the official
    //Energy dashboard renders to the watt. The kWh buffers
    //populated above keep driving scrub + chart history; only
    //the LIVE chip values are overridden.
    const statRates = host._energyDefaults?.gridStatRates ?? [];
    if (statRates.length > 0)
    {
        readStatRates(host, statRates);
    }
}


//Mirror of HA `hui-power-sankey-card`'s live grid read. Sums the signed power across every `stat_rate` entity collected
//from the HA Energy dashboard prefs, then routes the net through `applyCombinedSplit`: a non-negative net shows on
//IMPORT only, a negative net on EXPORT only.
//
//No slope, no integration. The chip value reads whatever the signed power sensor reports right now, normalised by SI
//prefix on the unit (k -> *1000, M -> *1e6, etc.) the same way the official Energy dashboard does it.
//
//Bails out silently when no rate sensor produced a usable value, leaving the directional readSlot results from this same
//refresh cycle as the displayed LIVE values. That preserves the cumulative-kWh fallback for users whose HA Energy grid
//sources do not declare a stat_rate.
function readStatRates(host: GridHost, rates: string[]): void
{
    let signedWatts = 0;
    let sawAny      = false;
    for (const entity of rates)
    {
        const stateObj = host.hass.states?.[entity];
        if (!stateObj)
        {
            continue;
        }
        const raw = stateObj.state;
        if (raw === null || raw === undefined || raw === '' || raw === 'unknown' || raw === 'unavailable')
        {
            continue;
        }
        const num = parseNumericState(raw);
        if (num === null)
        {
            continue;
        }
        const unit  = String(stateObj.attributes?.unit_of_measurement ?? '').trim();
        const watts = pvNormalizeToWatts(num, unit);
        //Per-entity inversion: HA Energy `power_config.stat_rate_inverted` flips the sign convention for one source
        //in a multi-source grid wiring. Apply the flag at read time so the directional split below sees the canonical
        //"positive = import" convention.
        const inverted = host._energyDefaults?.invertedRateEntities.includes(entity) ?? false;
        signedWatts += inverted ? -watts : watts;
        sawAny = true;
    }
    if (!sawAny)
    {
        return;
    }
    applyCombinedSplit(host, signedWatts);
}


//Resolve every entity wired for a slot from the HA Energy dashboard snapshot. Grid wiring reads
//exclusively from the HA Energy dashboard global settings (Settings -> Dashboards -> Energy);
//card YAML carrying retired override keys (grid-import-entity / grid-export-entity / grid-power-
//entity / grid-power-invert) gets a one-shot persistent migration notification and the editor
//strips them on the next save, the runtime treats them as absent.
function resolveEntities(host: GridHost, slot: 'import' | 'export'): string[]
{
    const ed = host._energyDefaults;
    if (!ed)
    {
        return [];
    }
    if (slot === 'import')
    {
        return [...ed.gridStatEnergyFroms];
    }
    return [...ed.gridStatEnergyTos];
}


function readSlot(host: GridHost, slot: 'import' | 'export'): void
{
    const entities = resolveEntities(host, slot);
    if (entities.length === 0)
    {
        applyValue(host, slot, null, '');
        return;
    }
    const bufMap     = slot === 'import' ? host._gridImportSamples      : host._gridExportSamples;
    const derivedMap = slot === 'import' ? host._gridImportLastDerived  : host._gridExportLastDerived;

    //Drop buffers + last-derived records for entities that have been
    //removed from the config (user trimmed the array in the editor).
    for (const key of Array.from(bufMap.keys()))     if (!entities.includes(key))
    {
        bufMap.delete(key);
    }
    for (const key of Array.from(derivedMap.keys())) if (!entities.includes(key))
    {
        derivedMap.delete(key);
    }

    let unitForOutput = '';
    let sawAny        = false;
    const nowMs       = Date.now();

    const unitsMap = slot === 'import' ? host._gridImportUnits : host._gridExportUnits;

    for (const entity of entities)
    {
        //Pull the recorder history once per session so the rolling
        //buffer carries a usable slope even when the live state is
        //silent at boot.
        ensureHistoryFetched(host, entity, bufMap);

        const stateObj = host.hass.states?.[entity];
        if (!stateObj)
        {
            continue;
        }
        const raw  = stateObj.state;
        const unit = String(stateObj.attributes?.unit_of_measurement ?? '').trim();
        if (raw === null || raw === undefined || raw === '' || raw === 'unknown' || raw === 'unavailable')
        {
            continue;
        }
        const num = parseNumericState(raw);
        if (num === null)
        {
            continue;
        }
        unitForOutput = unitForOutput || unit;
        sawAny = true;

        const u = unit.toLowerCase();
        unitsMap.set(entity, u);

        //Sample timestamp comes from the entity's last_updated so the
        //slope reflects when HA observed the value, not when we ran
        //refreshGrid. Falling back to nowMs only when last_updated is
        //missing (very old HA, or a state we forged on the fly).
        const stateTs = parseTimestamp(stateObj.last_updated)
                     ?? parseTimestamp(stateObj.last_changed)
                     ?? nowMs;

        //Record the sample BEFORE the per-unit derivation so the
        //scrub buffer is populated regardless of unit. Cumulative
        //meters need it for the bracketed-slope past-derivation;
        //power-native meters need it for the closest-sample-wins
        //past-derivation. The previous gate inside the kWh branch
        //starved the scrub path on power-native configurations
        //(closest-sample search on an empty buffer returned null).
        recordCumulativeSample(bufMap, entity, num, stateTs, nowMs);

        if (u === 'wh' || u === 'kwh' || u === 'mwh')
        {
            const out = bracketedSlopeWatts(bufMap.get(entity), u, nowMs, LIVE_SLOPE_LOOKBACK_MS);
            if (out !== null)
            {
                //out.changedAt is the timestamp of the newest sample
                //in the bracket. A tariff that just stopped moving
                //sees its bracket sample age out; once everything in
                //the buffer pre-dates the lookback window, this entity
                //stops bidding for the chip and the other tariff wins.
                derivedMap.set(entity, { watts: out.watts, t: out.changedAt });
            }
            else
            {
                //Bracket couldn't produce a slope (buffer too short
                //or all samples flat). Forget any stale derivation
                //for this entity so its sibling drives the chip.
                derivedMap.delete(entity);
            }
        }
        else if (u === 'w' || u === 'kw' || u === 'mw')
        {
            //Power sensor: the value IS the watts. Tag with the
            //sensor's last_updated so cross-entity ranking still
            //works against cumulative-kWh siblings.
            derivedMap.set(entity, {
                watts: pvNormalizeToWatts(num, unit),
                t:     stateTs
            });
        }
        else
        {
            //Unknown unit: forward the raw value, tagged with the
            //entity's last_updated so it ranks competitively.
            derivedMap.set(entity, { watts: num, t: stateTs });
        }
    }

    if (!sawAny)
    {
        //No state resolved yet (entities exist but unavailable).
        //Don't seed a fake 0 W; the chip stays hidden (value null)
        //until either a live state lands or the history fetch below
        //seeds the buffer with a recorder slope.
        return;
    }

    //Pick the entity with the most recent change. If no entity has
    //a derivation yet (buffers still warming up), zero the chip out
    //rather than carrying a stale value forward, the previous
    //"keep last value" rule made a frozen sensor look live.
    let bestT     = -1;
    let bestWatts: number | null = null;
    for (const [, entry] of derivedMap)
    {
        if (entry.t > bestT)
        {
            bestT     = entry.t;
            bestWatts = entry.watts;
        }
    }
    if (bestWatts === null)
    {
        //No live derivation landed yet. Show 0 W so the chip stays
        //visible (it has an entity wired) but reads as "nothing
        //currently flowing", instead of carrying whatever stale
        //number the previous tick had.
        applyValue(host, slot, 0, unitIsEnergy(unitForOutput) ? 'W' : (unitForOutput || 'W'));
        return;
    }

    const outUnit = unitIsEnergy(unitForOutput) ? 'W' : (unitForOutput || 'W');
    applyValue(host, slot, bestWatts, outUnit);
}


//Route a signed net-grid wattage to exactly one directional slot:
//import when >= 0 (including the idle 0 W, so one chip stays visible
//to signal the connection is alive), export when < 0. The opposite
//slot is nulled so its chip hides.
function applyCombinedSplit(host: GridHost, signedWatts: number): void
{
    if (signedWatts >= 0)
    {
        applyValue(host, 'import', signedWatts, 'W');
        applyValue(host, 'export', null, '');
    }
    else
    {
        applyValue(host, 'import', null, '');
        applyValue(host, 'export', -signedWatts, 'W');
    }
}


function unitIsEnergy(unit: string): boolean
{
    const u = unit.toLowerCase();
    return u === 'wh' || u === 'kwh' || u === 'mwh';
}


//Parse a state value that came in as either a string or a number.
//Accepts both '.' and ',' decimal separators since some integrations
//(rare, but exist) forward the locale-formatted form. Returns null
//for anything that isn't a finite number.
function parseNumericState(raw: unknown): number | null
{
    if (typeof raw === 'number')
    {
        return Number.isFinite(raw) ? raw : null;
    }
    if (typeof raw !== 'string')
    {
        return null;
    }
    const trimmed = raw.trim();
    if (trimmed === '')
    {
        return null;
    }
    //Locale-tolerant: replace a single comma with a dot when the
    //string has no dot already. Avoids breaking thousand-separated
    //inputs like "12,345.6" which would otherwise parse as 12.
    const normalised = trimmed.includes('.') ? trimmed : trimmed.replace(',', '.');
    const n = parseFloat(normalised);
    return Number.isFinite(n) ? n : null;
}


function parseTimestamp(raw: unknown): number | null
{
    if (raw === null || raw === undefined)
    {
        return null;
    }
    if (typeof raw === 'number')
    {
        if (!Number.isFinite(raw))
        {
            return null;
        }
        return raw > 1e12 ? raw : raw * 1000;
    }
    if (typeof raw !== 'string')
    {
        return null;
    }
    const trimmed = raw.trim();
    if (trimmed === '')
    {
        return null;
    }
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum) && asNum > 1e9)
    {
        return asNum > 1e12 ? asNum : asNum * 1000;
    }
    const parsed = new Date(trimmed).getTime();
    return Number.isFinite(parsed) ? parsed : null;
}


//Push a fresh cumulative-energy reading into the per-entity buffer
//and prune the rolling window. Duplicate timestamps are skipped so
//the buffer doesn't fill with copies of the same observation when
//several refreshGrid ticks land between two HA updates.
function recordCumulativeSample(
    bufMap:  Map<string, Sample[]>,
    entity:  string,
    num:     number,
    stateTs: number,
    nowMs:   number
): void
{
    let buf = bufMap.get(entity);
    if (!buf)
    {
        buf = [];
        bufMap.set(entity, buf);
    }
    const last = buf.length > 0 ? buf[buf.length - 1] : null;
    if (!last || stateTs > last.t)
    {
        const isRealTransition = last !== null && last.v !== num;
        buf.push({
            t: stateTs,
            v: num,
            lastChangeT: isRealTransition ? stateTs : (last?.lastChangeT ?? null)
        });
    }
    //Hard cap on buffer size + drop samples older than the retention
    //window, measured against the current wall clock (so stale buffers
    //prune themselves out of memory even if no new sample lands for
    //a while).
    while (buf.length > GRID_SAMPLE_MAX)
    {
        buf.shift();
    }
    while (buf.length > 1 && nowMs - buf[0].t > GRID_SAMPLE_WINDOW_MS)
    {
        buf.shift();
    }
}


//Find the pair of samples (oldest, newest) that brackets `targetMs`
//in the buffer such that newest.t - oldest.t >= MIN_SLOPE_SPAN_MS.
//When the immediate before/after bracket is too narrow (typical
//5 s push throttle on Wh meters with 1 Wh quantum), we extend the
//bracket outward, preferring the closer side, until either the
//span exceeds MIN_SLOPE_SPAN_MS or the buffer is exhausted.
//
//Returns null when no two distinct samples can be found at all.
//
//`maxLookbackMs` constrains the LIVE path: the bracket's newest
//sample must sit within `maxLookbackMs` of targetMs so a chip that
//was last updated 10 min ago doesn't drag a stale "average" into
//the live display. SCRUB pases null to disable that constraint.
function pickBracket(
    buf:           Sample[],
    targetMs:      number,
    maxLookbackMs: number | null
): { oldest: Sample; newest: Sample } | null
{
    if (buf.length < 2)
    {
        return null;
    }
    //beforeIdx = index of the latest sample with t <= targetMs.
    //afterIdx  = index of the earliest sample with t > targetMs.
    let beforeIdx = -1;
    for (let i = 0; i < buf.length; i++)
    {
        if (buf[i].t <= targetMs)
        {
            beforeIdx = i;
        }
        else
        {
            break;
        }
    }
    let afterIdx = beforeIdx + 1;

    if (beforeIdx < 0)
    {
        //Target predates the buffer.
        if (maxLookbackMs === null)
        {
            //SCRUB path: if the target is meaningfully before the
            //buffer's first sample, refuse to extrapolate. Returning
            //the same first-two-samples bracket for every target in
            //this range would show one constant slope across hours
            //of scrub (the symptom that motivated this audit).
            //Within the edge tolerance the first bracket is still
            //used so a small gap between buffer start and the user's
            //scrub instant doesn't hide the chip needlessly.
            if (buf[0].t - targetMs > SCRUB_EDGE_TOLERANCE_MS)
            {
                return null;
            }
        }
        beforeIdx = 0;
        afterIdx  = 1;
    }
    else if (afterIdx >= buf.length)
    {
        //Target postdates the buffer (live path: target = now,
        //newest buffer sample t < now). Use the last two samples.
        beforeIdx = buf.length - 2;
        afterIdx  = buf.length - 1;
    }

    let oldest = buf[beforeIdx];
    let newest = buf[afterIdx];

    //Extend outward until the bracket spans MIN_SLOPE_SPAN_MS or we
    //can't extend any further on either side.
    while (newest.t - oldest.t < MIN_SLOPE_SPAN_MS)
    {
        const canShrinkOlder  = beforeIdx > 0;
        const canExtendNewer  = afterIdx < buf.length - 1;
        if (!canShrinkOlder && !canExtendNewer)
        {
            break;
        }
        if (!canShrinkOlder)
        {
            afterIdx++;
            newest = buf[afterIdx];
        }
        else if (!canExtendNewer)
        {
            beforeIdx--;
            oldest = buf[beforeIdx];
        }
        else
        {
            //Prefer the side whose neighbour sits closer in time so
            //the bracket grows symmetrically around the target.
            const beforeGap = oldest.t - buf[beforeIdx - 1].t;
            const afterGap  = buf[afterIdx + 1].t - newest.t;
            if (afterGap <= beforeGap)
            {
                afterIdx++;
                newest = buf[afterIdx];
            }
            else
            {
                beforeIdx--;
                oldest = buf[beforeIdx];
            }
        }
    }

    if (maxLookbackMs !== null && targetMs - newest.t > maxLookbackMs)
    {
        return null;
    }
    if (newest.t === oldest.t)
    {
        return null;
    }
    return { oldest, newest };
}


function slopeWatts(oldest: Sample, newest: Sample, u: string): number | null
{
    const dt = (newest.t - oldest.t) / 1000;
    if (dt <= 0)
    {
        return null;
    }
    let dE_wh = newest.v - oldest.v;
    if (u === 'kwh')
    {
        dE_wh *= 1000;
    }
    else if (u === 'mwh')
    {
        dE_wh *= 1_000_000;
    }
    //Power = energy / time. dE_wh is in Wh, dt is in seconds; the
    //3600 factor turns Wh per second into watts.
    return dE_wh * 3600 / dt;
}


//Internal helper used by the LIVE refresh. Returns the slope in
//watts plus the timestamp of the newest sample in the bracket so
//the multi-entity picker can rank by "moved most recently".
function bracketedSlopeWatts(
    buf:           Sample[] | undefined,
    u:             string,
    targetMs:      number,
    maxLookbackMs: number | null
): { watts: number; changedAt: number } | null
{
    if (!buf)
    {
        return null;
    }
    const bracket = pickBracket(buf, targetMs, maxLookbackMs);
    if (!bracket)
    {
        return null;
    }
    const w = slopeWatts(bracket.oldest, bracket.newest, u);
    if (w === null)
    {
        return null;
    }
    //changedAt = the timestamp of the latest REAL value transition
    //seen in this entity's buffer, not the last poll. The multi-
    //tariff picker ranks by "moved most recently", and HA pushes
    //last_updated even when the state value doesn't change, so the
    //poll time would tie HP and HC even when only HP is currently
    //incrementing. Falling back to newest.t when lastChangeT is
    //null preserves the legacy ordering on the very first sample
    //of a buffer.
    const changedAt = bracket.newest.lastChangeT ?? bracket.newest.t;
    return { watts: w, changedAt };
}


//Derive the grid watts AT (or as close as possible to) a target
//timestamp, used by the past-scrub render. Sums the bracketed slope
//of every entity in the slot, so multi-tariff installs (HP + HC)
//combine into the actual power that was flowing at the scrub
//instant, the inactive tariff contributing 0 W because its bracket
//is flat across the target.
//
//Returns null when no buffer can produce a bracket at all.
export function gridWattsAtTime(
    samples:  Map<string, Sample[]>,
    units:    Map<string, string>,
    targetMs: number,
): number | null
{
    let total: number = 0;
    let anyHit: boolean = false;
    for (const [entity, buf] of samples)
    {
        if (buf.length < 2)
        {
            continue;
        }
        const u = (units.get(entity) ?? 'kwh').toLowerCase();
        if (u !== 'wh' && u !== 'kwh' && u !== 'mwh')
        {
            //Power-native sensor: closest sample wins (no
            //integration needed).
            let best = buf[0];
            let bestDt = Math.abs(buf[0].t - targetMs);
            for (let i = 1; i < buf.length; i++)
            {
                const d = Math.abs(buf[i].t - targetMs);
                if (d < bestDt) { best = buf[i]; bestDt = d; }
            }
            //pvNormalizeToWatts is the same conversion used live so
            //kW / MW power-native sensors stay consistent across the
            //two paths.
            const watts = u === 'kw' ? best.v * 1000 : u === 'mw' ? best.v * 1_000_000 : best.v;
            total += watts;
            anyHit = true;
            continue;
        }
        //Cumulative-energy sensor.
        const bracket = pickBracket(buf, targetMs, null);
        if (!bracket)
        {
            continue;
        }
        const w = slopeWatts(bracket.oldest, bracket.newest, u);
        if (w === null)
        {
            continue;
        }
        total += w;
        anyHit = true;
    }
    return anyHit ? total : null;
}


function applyValue(host: GridHost, slot: 'import' | 'export', value: number | null, unit: string): void
{
    //Negative on a directional grid slot has no physical meaning:
    //a negative IMPORT is a moment of EXPORT (already reported by
    //the export slot), and a negative EXPORT is a moment of import.
    //Clamping to 0 keeps the chip readable and prevents the bead
    //animation (driven by the absolute watts) from running on a
    //direction the slot was never wired to represent.
    const clamped = (value === null) ? null : Math.max(0, value);
    if (slot === 'import')
    {
        if (host._gridImportValue !== clamped)
        {
            host._gridImportValue = clamped;
        }
        if (host._gridImportUnit  !== unit)
        {
            host._gridImportUnit  = unit;
        }
    }
    else
    {
        if (host._gridExportValue !== clamped)
        {
            host._gridExportValue = clamped;
        }
        if (host._gridExportUnit  !== unit)
        {
            host._gridExportUnit  = unit;
        }
    }
}


//Display helper that formats the grid chip value + unit. Watts get
//the same "round to integer when >100, one decimal otherwise"
//treatment as the PV chip; kWh keeps two decimals. Returns the
//empty string when the value is null so callers can collapse the
//chip without an explicit conditional.
export function formatGridValue(value: number | null, unit: string): string
{
    if (value === null)
    {
        return '';
    }
    const u = unit.toLowerCase();
    if (u === 'w' || u === 'kw' || u === 'mw')
    {
        const w = pvNormalizeToWatts(value, unit);
        if (Math.abs(w) >= 1000)
        {
            return `${(w / 1000).toFixed(1)} kW`;
        }
        if (Math.abs(w) >= 100)
        {
            return `${Math.round(w)} W`;
        }
        return `${w.toFixed(1)} W`;
    }
    if (u === 'wh' || u === 'kwh' || u === 'mwh')
    {
        return `${value.toFixed(2)} ${unit}`;
    }
    //Unknown unit: show the raw value + whatever unit HA reported.
    return unit ? `${value} ${unit}` : String(value);
}
