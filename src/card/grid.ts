//Grid import / export readout, the live numeric value read from
//hass.states.
//
//grid-import-entity and grid-export-entity can be wired as a single
//entity (string) OR as an array of entities. The array form is the
//only sane way to model time-of-use installs where the cumulative
//meter is split across two indexes (heures pleines / creuses in
//France, peak / off-peak elsewhere). Crucially, those indexes are
//MUTUALLY EXCLUSIVE: only one is incrementing at any given moment
//(the active tariff), so the chip displays the value of the entity
//that changed MOST RECENTLY. No averaging, no summing: the last-
//updated entity wins.

import type { HeliosConfig } from '../helios-config';
import { pvNormalizeToWatts } from './pv';


type Sample = { t: number; v: number; lastChangeT?: number | null };

//Set of entity IDs that already had their HA recorder history pulled
//once this session. Live state cumulative-kWh meters (especially TIC
//Linky indexes for HP / HC tariffs) sometimes go minutes or hours
//without pushing a fresh state event, but the recorder always has
//older transitions on disk. Seeding the rolling buffer with that
//history means the chip can derive a meaningful slope from the very
//first refresh, instead of waiting for the live state to move (or
//worse, displaying 0 W when the integration is silent).
const _historyFetched   = new Set<string>();
const _historyInflight  = new Set<string>();
//1 hour history backfill, long enough to give the derivation a
//moving signal even on the slowest 30 min Linky polling, short
//enough to keep the WS payload tiny.
const GRID_HISTORY_WINDOW_MS = 60 * 60_000;


function ensureHistoryFetched(host: GridHost, entity: string, bufMap: Map<string, Sample[]>): void
{
    if (!host.hass?.callWS) return;
    if (_historyFetched.has(entity)) return;
    if (_historyInflight.has(entity)) return;
    _historyInflight.add(entity);
    const end   = new Date();
    const start = new Date(end.getTime() - GRID_HISTORY_WINDOW_MS);
    (async (): Promise<void> =>
    {
        try
        {
            const result: any = await host.hass.callWS({
                type:             'history/history_during_period',
                start_time:       start.toISOString(),
                end_time:         end.toISOString(),
                entity_ids:       [entity],
                minimal_response: true,
                no_attributes:    true
            });
            const arr: any[] = (result && result[entity]) ?? [];
            const buf = bufMap.get(entity) ?? [];
            let lastV: number | null = null;
            let lastChangeT: number | null = null;
            for (const item of arr)
            {
                const sRaw = item?.s ?? item?.state;
                if (sRaw === null || sRaw === undefined || sRaw === 'unavailable' || sRaw === 'unknown' || sRaw === '') continue;
                const v = parseFloat(String(sRaw));
                if (!isFinite(v)) continue;
                const tsRaw = item?.lu ?? item?.lc ?? item?.last_updated ?? item?.last_changed ?? null;
                let t: number | null = null;
                if (typeof tsRaw === 'number')      t = tsRaw > 1e12 ? tsRaw : tsRaw * 1000;
                else if (typeof tsRaw === 'string') { const n = Number(tsRaw); t = Number.isFinite(n) && n > 1e9 ? (n > 1e12 ? n : n * 1000) : new Date(tsRaw).getTime(); }
                if (t === null || !isFinite(t)) continue;
                const realTransition = lastV !== null && lastV !== v;
                if (realTransition || lastChangeT === null) lastChangeT = t;
                buf.push({ t, v, lastChangeT });
                lastV = v;
            }
            if (buf.length > 0)
            {
                buf.sort((a, b) => a.t - b.t);
                bufMap.set(entity, buf);
                host.requestUpdate();
            }
            _historyFetched.add(entity);
        }
        catch { /* silent: live derivation still works once HA pushes state */ }
        finally
        {
            _historyInflight.delete(entity);
        }
    })();
}

export interface GridHost
{
    readonly config: HeliosConfig | undefined;
    readonly hass:   any;

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


//Rolling window for the dE/dt derivative when a cumulative energy
//sensor is wired. 10 min stays responsive while covering even slow-
//updating Linky / Shelly integrations.
//60 min rolling window. Long enough to keep the recorder backfill
//meaningful when HA's live state goes silent for several minutes
//between TIC pushes; short enough to keep the slope reactive to
//real consumption changes once HA resumes pushing.
const GRID_SAMPLE_WINDOW_MS = 60 * 60_000;
const GRID_SAMPLE_PERIOD_MS = 5_000;
const GRID_SAMPLE_MAX       = 800;


export function refreshGrid(host: GridHost): void
{
    if (!host.hass)
    {
        if (host._gridImportValue !== null) host._gridImportValue = null;
        if (host._gridImportUnit  !== '')   host._gridImportUnit  = '';
        if (host._gridExportValue !== null) host._gridExportValue = null;
        if (host._gridExportUnit  !== '')   host._gridExportUnit  = '';
        return;
    }

    readSlot(host, 'import');
    readSlot(host, 'export');
}


//Resolve every entity wired for a slot. Accepts both:
//  - "sensor.foo"          (single entity)
//  - ["sensor.foo", "sensor.bar"]  (multi-entity)
//Empty / missing entities are silently dropped.
function resolveEntities(host: GridHost, slot: 'import' | 'export'): string[]
{
    const key = slot === 'import' ? 'grid-import-entity' : 'grid-export-entity';
    const raw = (host.config as Record<string, unknown> | undefined)?.[key];
    if (Array.isArray(raw))
    {
        return (raw as unknown[])
            .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
            .map(s => s.trim());
    }
    if (typeof raw === 'string' && raw.trim() !== '') return [raw.trim()];
    return [];
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
    for (const key of Array.from(bufMap.keys()))     if (!entities.includes(key)) bufMap.delete(key);
    for (const key of Array.from(derivedMap.keys())) if (!entities.includes(key)) derivedMap.delete(key);

    //Per-entity processing. Each entity's reading is sampled into its
    //own rolling buffer; the slope (or the raw value if the sensor
    //reports power natively) is recorded in derivedMap with the
    //timestamp at which the underlying state changed for the last
    //time. Whichever entity has the most recent change wins the
    //chip.
    let unitForOutput = '';
    let sawAny        = false;
    const nowMs       = Date.now();

    const unitsMap = slot === 'import' ? host._gridImportUnits : host._gridExportUnits;

    for (const entity of entities)
    {
        //Pull the last hour of recorder history once per session so
        //the rolling buffer carries a usable slope even when the
        //live state is silent.
        ensureHistoryFetched(host, entity, bufMap);

        const stateObj = host.hass.states?.[entity];
        if (!stateObj) continue;
        const raw  = String(stateObj.state ?? '').trim();
        const unit = String(stateObj.attributes?.unit_of_measurement ?? '').trim();
        if (raw === '' || raw === 'unknown' || raw === 'unavailable') continue;
        const num = parseFloat(raw);
        if (!isFinite(num)) continue;
        unitForOutput = unitForOutput || unit;
        sawAny = true;

        const u = unit.toLowerCase();
        unitsMap.set(entity, u);
        if (u === 'wh' || u === 'kwh' || u === 'mwh')
        {
            const out = deriveWattsFromCumulative(bufMap, entity, num, u, nowMs);
            if (out !== null)
            {
                //out.changedAt is the timestamp of the SAMPLE PUSH that
                //triggered this derivation; it's the right tie-breaker
                //for "which entity moved last". A frozen entity never
                //updates its derivedMap entry, so a tariff that just
                //handed control to the OTHER one stops dragging the
                //chip back to its stale value.
                derivedMap.set(entity, { watts: out.watts, t: out.changedAt });
            }
        }
        else if (u === 'w' || u === 'kw' || u === 'mw')
        {
            //Power sensor: the value IS the watts. Tag with the
            //sensor's last_updated so cross-entity ranking still
            //works against cumulative-kWh siblings.
            const lastUpdated = String(stateObj.last_updated ?? stateObj.last_changed ?? '').trim();
            const changedAt   = lastUpdated ? new Date(lastUpdated).getTime() : nowMs;
            derivedMap.set(entity, {
                watts: pvNormalizeToWatts(num, unit),
                t:     isFinite(changedAt) ? changedAt : nowMs
            });
        }
        else
        {
            //Unknown unit: forward the raw value, tagged with now so
            //it ranks competitively against other entities.
            derivedMap.set(entity, { watts: num, t: nowMs });
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
    //a derivation yet (buffers still warming up), seed at 0.
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
        //No live derivation landed yet. Keep whatever the chip was
        //showing (last derived value from earlier in the session,
        //or from the seeded history below). We never zero the chip
        //out just because the integration went silent.
        return;
    }

    //Output unit: cumulative-kWh sensors derive into W, others keep
    //their native unit. We normalise everything to W on the chip
    //since the multi-entity case can't mix kWh-display with W-display
    //cleanly.
    const outUnit = unitIsEnergy(unitForOutput) ? 'W' : (unitForOutput || 'W');
    applyValue(host, slot, bestWatts, outUnit);
}


function unitIsEnergy(unit: string): boolean
{
    const u = unit.toLowerCase();
    return u === 'wh' || u === 'kwh' || u === 'mwh';
}


//Derive the grid watts AT (or as close as possible to) a target
//timestamp, using the rolling buffer of (t, v) samples. Used by the
//past-scrub render so the chip reflects the consumption / export
//that was happening at the scrub instant rather than the live now.
//
//Strategy: per entity, find the two samples that bracket the target,
//compute the slope across that bracket. Sum (last-changed wins logic
//is dropped for scrub: we want a single snapshot for the time, not
//"whichever entity moved last across now"). The unit map carries
//the energy unit for each entity so the conversion to watts is
//correct regardless of whether the source was Wh / kWh / MWh.
//
//Returns null when no buffer covers the target or when every
//bracket is flat (no transition around the target).
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
        if (buf.length < 2) continue;
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
            //Already in watts equivalent; downstream pvNormalizeToWatts
            //handles kW / MW too.
            const watts = u === 'kw' ? best.v * 1000 : u === 'mw' ? best.v * 1_000_000 : best.v;
            total += watts;
            anyHit = true;
            continue;
        }
        //Cumulative-energy sensor: find the two samples bracketing
        //targetMs (or the closest 2 around it) and compute the slope.
        let beforeIdx = -1;
        let afterIdx  = -1;
        for (let i = 0; i < buf.length; i++)
        {
            if (buf[i].t <= targetMs) beforeIdx = i;
            if (buf[i].t >= targetMs) { afterIdx = i; break; }
        }
        let a = beforeIdx >= 0 ? buf[beforeIdx] : null;
        let b = afterIdx  >= 0 ? buf[afterIdx]  : null;
        if (!a || !b || a === b)
        {
            //Target sits outside the buffer; expand to the closest
            //2 samples on the same side.
            if (buf[0].t > targetMs)             { a = buf[0];                  b = buf[1];                  }
            else if (buf[buf.length - 1].t < targetMs) { a = buf[buf.length - 2]; b = buf[buf.length - 1]; }
            else if (beforeIdx >= 0)             { a = buf[Math.max(0, beforeIdx - 1)]; b = buf[beforeIdx]; }
            else                                 continue;
        }
        if (!a || !b || a === b || a.v === b.v) continue;
        const dt = (b.t - a.t) / 1000;
        if (dt <= 0) continue;
        let dE_wh = b.v - a.v;
        if (u === 'kwh') dE_wh *= 1000;
        else if (u === 'mwh') dE_wh *= 1_000_000;
        total += dE_wh * 3600 / dt;
        anyHit = true;
    }
    return anyHit ? total : null;
}


//Push the latest cumulative reading into the per-entity buffer and
//return:
//   { watts, changedAt }   when the slope can be computed and the
//                          cumulative value moved across the window.
//                          changedAt is the timestamp of the newest
//                          sample (i.e. when the entity last bumped).
//   null                   when the buffer hasn't accumulated enough
//                          samples or the value is flat.
function deriveWattsFromCumulative(
    bufMap: Map<string, Sample[]>,
    entity: string,
    num:    number,
    u:      string,
    nowMs:  number
): { watts: number; changedAt: number } | null
{
    let buf = bufMap.get(entity);
    if (!buf)
    {
        buf = [];
        bufMap.set(entity, buf);
    }
    const last = buf.length > 0 ? buf[buf.length - 1] : null;
    //Track whether THIS push represents a real value transition (the
    //incoming reading differs from the most recent stored one). The
    //changedAt returned below is the timestamp of the LATEST real
    //transition we ever saw in this buffer, used by the multi-entity
    //picker to rank entities by "which one moved most recently".
    //Without this distinction, every entity returned the latest
    //push timestamp (which is just ~nowMs) and the ranking became
    //"whichever entity got processed last in the for loop", not
    //"whichever entity actually moved".
    let isRealTransition = false;
    if (!last || nowMs - last.t >= GRID_SAMPLE_PERIOD_MS)
    {
        isRealTransition = last !== null && last.v !== num;
        buf.push({ t: nowMs, v: num, lastChangeT: isRealTransition ? nowMs : (last?.lastChangeT ?? null) });
    }
    while (buf.length > GRID_SAMPLE_MAX) buf.shift();
    while (buf.length > 1 && nowMs - buf[0].t > GRID_SAMPLE_WINDOW_MS) buf.shift();
    if (buf.length < 2) return null;

    const oldest = buf[0];
    const newest = buf[buf.length - 1];
    if (newest.v === oldest.v) return null;
    const dt = (newest.t - oldest.t) / 1000;
    if (dt <= 0) return null;
    let dE_wh = newest.v - oldest.v;
    if (u === 'kwh') dE_wh *= 1000;
    else if (u === 'mwh') dE_wh *= 1_000_000;
    //Power = energy / time. dE_wh is in Wh (after the unit ladder
    //above), dt is in seconds, so the conversion factor 3600 turns
    //Wh per second into watts. Vetted: 1 kW for 3.6 s = 1 Wh,
    //1 * 3600 / 3.6 = 1000 W. ✓
    const watts = dE_wh * 3600 / dt;
    //changedAt: walk the buffer back to find the most recent sample
    //whose v differs from its predecessor, that is the timestamp of
    //the last real value transition. Fall back to newest.t if the
    //buffer doesn't carry the lastChangeT bookkeeping (legacy samples
    //captured before this commit).
    const changedAt = newest.lastChangeT ?? newest.t;
    return { watts, changedAt };
}


function applyValue(host: GridHost, slot: 'import' | 'export', value: number | null, unit: string): void
{
    if (slot === 'import')
    {
        if (host._gridImportValue !== value) host._gridImportValue = value;
        if (host._gridImportUnit  !== unit)  host._gridImportUnit  = unit;
    }
    else
    {
        if (host._gridExportValue !== value) host._gridExportValue = value;
        if (host._gridExportUnit  !== unit)  host._gridExportUnit  = unit;
    }
}


//Display helper that formats the grid chip value + unit. Watts get
//the same "round to integer when >100, one decimal otherwise"
//treatment as the PV chip; kWh keeps two decimals. Returns the
//empty string when the value is null so callers can collapse the
//chip without an explicit conditional.
export function formatGridValue(value: number | null, unit: string): string
{
    if (value === null) return '';
    const u = unit.toLowerCase();
    if (u === 'w' || u === 'kw' || u === 'mw')
    {
        const w = pvNormalizeToWatts(value, unit);
        if (Math.abs(w) >= 1000) return `${(w / 1000).toFixed(1)} kW`;
        if (Math.abs(w) >= 100)  return `${Math.round(w)} W`;
        return `${w.toFixed(1)} W`;
    }
    if (u === 'wh' || u === 'kwh' || u === 'mwh')
    {
        return `${value.toFixed(2)} ${unit}`;
    }
    //Unknown unit: show the raw value + whatever unit HA reported.
    return unit ? `${value} ${unit}` : String(value);
}
