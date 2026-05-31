//Home Assistant Energy dashboard preferences subscription. The
//Energy dashboard stores its source configuration (which entity is
//"solar production", "grid import", "grid export", "battery charge"
//and "battery discharge") in a single object reachable through the
//`energy/get_prefs` WebSocket call. Helios uses that object as a
//fallback for the chip entities: when the user deletes a value in
//the card editor, the chip automatically falls back to the matching
//Energy dashboard entity instead of going blank.
//
//Subscribed once per card at connectedCallback. The result is
//cached on the host so every refresh path reads from the same
//snapshot; a subsequent push via the long-running subscription
//(HA broadcasts `config_entry_updated` when the user edits the
//Energy dashboard) replaces the snapshot and triggers a re-render.

import type { HeliosConfig } from '../helios-config';


export interface EnergyDefaults
{
    //First entity of type 'solar' under energy_sources[].
    pvPowerEntity:     string | null;
    //First grid source's stat_energy_from (consumption / import).
    gridImportEntity:  string | null;
    //First grid source's stat_energy_to (return / export). Often
    //declared on a separate grid entry from the import meter on
    //installs with split tariffs / split meters.
    gridExportEntity:  string | null;
    //First battery source's stat_energy_from (discharge / out).
    batteryPowerEntity: string | null;
    //Battery state of charge sensor (stat_soc). Exposed by HA
    //core 2024+ on the battery source so the dashboard can show a
    //live percentage gauge.
    batterySocEntity:  string | null;
}


export const EMPTY_ENERGY_DEFAULTS: EnergyDefaults =
{
    pvPowerEntity:      null,
    gridImportEntity:   null,
    gridExportEntity:   null,
    batteryPowerEntity: null,
    batterySocEntity:   null,
};


export interface EnergyPrefsHost
{
    readonly hass: any;
    _energyDefaults: EnergyDefaults;
    _energyPrefsUnsub?: () => void;
    requestUpdate(): void;
}


//Fetch the Energy dashboard preferences and update the host's
//cached defaults snapshot. Safe to call multiple times; bails out
//silently when hass is not yet attached or the call fails.
//
//Logs the resolved defaults to the console under a `[HELIOS energy
//prefs]` tag so users can confirm the dashboard auto-detect is
//working without diving into the source. Errors are surfaced too
//(the previous silent catch hid common setups where the WS call
//is denied by RBAC or the Energy dashboard is not yet configured).
export async function fetchEnergyPrefs(host: EnergyPrefsHost): Promise<void>
{
    if (!host.hass?.callWS) return;
    try
    {
        const prefs = await host.hass.callWS({ type: 'energy/get_prefs' }) as {
            energy_sources?: Array<Record<string, unknown>>;
        };
        const next = parseEnergyPrefs(prefs);
        host._energyDefaults = next;
        host.requestUpdate();
    }
    catch
    {
        //Silent: the HA Energy auto-detect is no longer used by the
        //chips (1.8.0 stripped the fallback). The subscription stays
        //wired so any future opt-in surface (editor entity-picker
        //"Use HA Energy default" toggle, etc.) has the snapshot
        //ready, but failures should not flood the console.
    }
}


//Open a long-running subscription so the snapshot stays in sync
//when the user edits the Energy dashboard from another tab. Falls
//back to a single fetch when the subscribe path is missing (older
//HA cores).
export function subscribeEnergyPrefs(host: EnergyPrefsHost): void
{
    if (!host.hass?.connection || host._energyPrefsUnsub) return;
    fetchEnergyPrefs(host);
    try
    {
        host._energyPrefsUnsub = host.hass.connection.subscribeEvents(
            () => fetchEnergyPrefs(host),
            'energy_preferences_updated',
        );
    }
    catch (_)
    {
        //Event subscription not supported, the one-shot fetch above already populated the cache.
    }
}


export function unsubscribeEnergyPrefs(host: EnergyPrefsHost): void
{
    if (host._energyPrefsUnsub)
    {
        try { host._energyPrefsUnsub(); }
        catch (_) {}
        host._energyPrefsUnsub = undefined;
    }
}


//Parse `energy/get_prefs` payload into the five entity slots Helios
//cares about.
//
//Real-world format (matches HA core 2024+):
//  - solar source: { type: 'solar', stat_energy_from: 'sensor...' }
//  - grid source : { type: 'grid', stat_energy_from: 'sensor...',
//                    stat_energy_to: 'sensor...' or null }
//  - battery     : { type: 'battery', stat_energy_from: '...',
//                    stat_energy_to: '...', stat_soc: 'sensor...' }
//
//Note that a single dashboard can list MULTIPLE 'grid' sources
//(one per tariff: Linky EASF01 hours pleines, EASF02 heures
//creuses, an export-only meter, etc.). We walk every one and keep
//the FIRST non-null entity for import (stat_energy_from) and
//for export (stat_energy_to). Same fan-out for solar in case a
//user has both an inverter sensor and a meter-side sensor.
export function parseEnergyPrefs(prefs: {
    energy_sources?: Array<Record<string, unknown>>;
}): EnergyDefaults
{
    const out: EnergyDefaults = { ...EMPTY_ENERGY_DEFAULTS };
    const sources = Array.isArray(prefs?.energy_sources) ? prefs!.energy_sources! : [];

    for (const src of sources)
    {
        if (!src || typeof src !== 'object') continue;
        const type = String(src['type'] ?? '').toLowerCase();

        if (type === 'solar' && !out.pvPowerEntity)
        {
            const e = pickFirstString(src['stat_energy_from']);
            if (e) out.pvPowerEntity = e;
        }
        else if (type === 'grid')
        {
            //Import side: stat_energy_from directly on the grid source.
            if (!out.gridImportEntity)
            {
                const e = pickFirstString(src['stat_energy_from']);
                if (e) out.gridImportEntity = e;
            }
            //Export side: stat_energy_to directly on the grid source.
            if (!out.gridExportEntity)
            {
                const e = pickFirstString(src['stat_energy_to']);
                if (e) out.gridExportEntity = e;
            }
        }
        else if (type === 'battery')
        {
            //Live power side: discharge (stat_energy_from) is the
            //"battery is producing" semantic, same as the live-power
            //chip displays for a positive value.
            if (!out.batteryPowerEntity)
            {
                const e = pickFirstString(src['stat_energy_from'])
                       ?? pickFirstString(src['stat_energy_to']);
                if (e) out.batteryPowerEntity = e;
            }
            //State of charge: HA core 2024+ exposes this as
            //`stat_soc` on the battery source. Read it when present
            //so Helios can drive the SoC chip from the dashboard
            //default without a per-card configuration.
            if (!out.batterySocEntity)
            {
                const e = pickFirstString(src['stat_soc']);
                if (e) out.batterySocEntity = e;
            }
        }
    }
    return out;
}


function pickFirstString(v: unknown): string | null
{
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (Array.isArray(v))
    {
        for (const item of v)
        {
            if (typeof item === 'string' && item.trim() !== '') return item.trim();
        }
    }
    return null;
}


//Resolve the effective entity id for one of the five Helios slots:
//returns the user-configured entity when present, otherwise the
//cached Energy dashboard default. Empty string when neither is
//set (the corresponding chip stays hidden).
export function resolveEffectiveEntity(
    config: HeliosConfig | undefined,
    _defaults: EnergyDefaults,
    key: 'pv-power-entity' | 'battery-soc-entity' | 'battery-power-entity'
       | 'grid-import-entity' | 'grid-export-entity',
): string
{
    //User-config entity ONLY. The HA Energy dashboard auto-detect
    //fallback was removed in 1.8.0: it was a steady source of bug
    //reports ("the chip reads from sensor X but my dashboard uses
    //sensor Y") and the resolution logic for daily-total vs
    //cumulative-since-install sensors was always wrong half the
    //time anyway. The user-configured entity is now the only
    //input; an empty string here collapses the corresponding chip.
    const raw = String(config?.[key] ?? '').trim();
    //grid-import-entity can be an array (heures pleines / creuses
    //in France, time-of-use bands elsewhere). For the single-entity
    //resolver we only return the FIRST one; multi-entity handling
    //happens inside refreshGrid() where each entity gets its own
    //rolling buffer and the slopes are summed.
    if (Array.isArray((config as Record<string, unknown>)?.[key]))
    {
        const arr = (config as unknown as Record<string, string[]>)[key];
        const first = arr.find(s => typeof s === 'string' && s.trim() !== '');
        return first ? first.trim() : '';
    }
    return raw;
}
