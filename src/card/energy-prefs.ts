//Home Assistant Energy dashboard preferences subscription. Helios reads its data exclusively from the HA Energy dashboard
//global settings (Settings -> Dashboards -> Energy): no more per-card entity slots for PV, grid or battery, the card just
//resolves whatever the dashboard already declares. Subscribed once per card at connectedCallback; HA broadcasts an
//`energy_preferences_updated` event when the user edits the dashboard, the subscription pulls a fresh snapshot and the
//render cascade picks it up.


export interface EnergyDefaults
{
    //Solar live signed power sensors, one per source's `stat_rate` when declared. Preferred over the cumulative
    //`stat_energy_from` for the live chip + chart because the instantaneous read matches the HA Energy tile to the watt
    //and avoids the trapezoidal slope artefacts on sparse high-frequency inverters.
    solarStatRates:         string[];
    //Cumulative kWh meters from every solar source. Drives the buffer backfill for the chart, the adaptive 5-day
    //forecast calibration, and the detail-panel `produced today` total via `recorder/statistics_during_period` change
    //aggregation.
    solarStatEnergyFroms:   string[];
    //Grid live signed power sensors, one per source's `stat_rate`. Positive splits to the IMPORT chip, negative to the
    //EXPORT chip, exactly like the HA Energy dashboard's own live grid tile.
    gridStatRates:          string[];
    //Grid import kWh meters per source (`stat_energy_from`). Backfilled via the 5-day LTS arm + 6-hour raw arm; consumed
    //by the scrub past derivation and the detail-panel `imported today` total.
    gridStatEnergyFroms:    string[];
    //Grid export kWh meters per source (`stat_energy_to`). Same backfill pattern as the import side.
    gridStatEnergyTos:      string[];
    //Battery live signed power sensors per source via `power_config.stat_rate`. Positive convention matches the source
    //(charge positive, discharge negative). Helios applies the same split as the grid LIVE path.
    batteryStatRates:       string[];
    //Battery discharge kWh meters (`stat_energy_from`). Drives the detail-panel `discharged today` headline via the
    //recorder `change` aggregation.
    batteryStatEnergyFroms: string[];
    //Battery charge kWh meters (`stat_energy_to`). Drives the `charged today` headline the same way.
    batteryStatEnergyTos:   string[];
    //Battery state-of-charge sensors via `stat_soc`. Aggregated by uniform average across configured sources for the SoC
    //chip + vessel visualisation. Multi-bank weighting by capacity is no longer supported, HA Energy has no concept of
    //per-source capacity.
    batteryStatSocs:        string[];
}


export const EMPTY_ENERGY_DEFAULTS: EnergyDefaults =
{
    solarStatRates:         [],
    solarStatEnergyFroms:   [],
    gridStatRates:          [],
    gridStatEnergyFroms:    [],
    gridStatEnergyTos:      [],
    batteryStatRates:       [],
    batteryStatEnergyFroms: [],
    batteryStatEnergyTos:   [],
    batteryStatSocs:        [],
};


export interface EnergyPrefsHost
{
    readonly hass: any;
    _energyDefaults: EnergyDefaults;
    _energyPrefsUnsub?: () => void;
    requestUpdate(): void;
}


//Fetch the HA Energy dashboard preferences and update the host's cached snapshot. Safe to call multiple times; bails out
//silently when hass is not yet attached or the call fails (RBAC denied, dashboard not configured, etc.).
export async function fetchEnergyPrefs(host: EnergyPrefsHost): Promise<void>
{
    if (!host.hass?.callWS)
    {
        return;
    }
    try
    {
        const prefs = await host.hass.callWS({ type: 'energy/get_prefs' }) as {
            energy_sources?: Array<Record<string, unknown>>;
        };
        const next = parseEnergyPrefs(prefs);
        host._energyDefaults = next;
        host.requestUpdate();
    }
    catch (_)
    {
        //Subscription stays wired; a transient WS error or a not-yet-configured dashboard collapses the chips silently
        //and the next push from `energy_preferences_updated` will retry.
    }
}


//Open a long-running subscription so the snapshot stays in sync when the user edits the Energy dashboard from another
//tab. Falls back to a single fetch when the subscribe path is missing (older HA cores).
export function subscribeEnergyPrefs(host: EnergyPrefsHost): void
{
    if (!host.hass?.connection || host._energyPrefsUnsub)
    {
        return;
    }
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
        //Event subscription not supported on this HA core; the one-shot fetch above already populated the cache.
    }
}


export function unsubscribeEnergyPrefs(host: EnergyPrefsHost): void
{
    if (host._energyPrefsUnsub)
    {
        try
        {
            host._energyPrefsUnsub();
        }
        catch (_)
        {
        }
        host._energyPrefsUnsub = undefined;
    }
}


//Host shape consumed by `refreshHaDailyTotals`. The card writes the four slots when the recorder query lands; downstream
//render functions prefer these over the local-integration values for the detail-panel headline figures.
export interface HaDailyTotalsHost
{
    readonly hass: any;
    readonly _energyDefaults: EnergyDefaults;
    _haSolarTodayKwh:          number | null;
    _haGridImportTodayKwh:     number | null;
    _haGridExportTodayKwh:     number | null;
    _haBatteryChargedKwh:      number | null;
    _haBatteryDischargedKwh:   number | null;
    requestUpdate(): void;
}


//Recorder query helper. Sums the `change` field of `recorder/statistics_during_period` over today (local midnight to now)
//across every statistic_id in the list. Returns null when the list is empty, when no `hass.callWS` is available, or when
//the call rejects, so callers fall back cleanly.
async function fetchTodayKwhChange(host: HaDailyTotalsHost, statisticIds: string[]): Promise<number | null>
{
    if (statisticIds.length === 0)
    {
        return null;
    }
    if (!host.hass?.callWS)
    {
        return null;
    }
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const now = new Date();
    try
    {
        const result = await host.hass.callWS({
            type:          'recorder/statistics_during_period',
            start_time:    midnight.toISOString(),
            end_time:      now.toISOString(),
            statistic_ids: statisticIds,
            //Day-period query returns at most one bucket per statistic covering today's window. `types: ['change']`
            //returns the net delta the recorder computed across the bucket using the same Riemann sum HA Energy itself
            //consumes, so the result matches the dashboard tile to the watt-hour.
            period:        'day',
            types:         ['change'],
            //Normalise to kWh so installs reporting in Wh / MWh land on the same scale as the HA Energy headline tile;
            //the chip + dashboard formatters assume kWh downstream.
            units:         { energy: 'kWh' },
        }) as Record<string, Array<{ change?: number | null }>>;
        let total  = 0;
        let anyHit = false;
        for (const id of statisticIds)
        {
            const buckets = result?.[id];
            if (!Array.isArray(buckets))
            {
                continue;
            }
            for (const bucket of buckets)
            {
                const v = typeof bucket?.change === 'number' ? bucket.change : null;
                if (v === null)
                {
                    continue;
                }
                total += v;
                anyHit = true;
            }
        }
        return anyHit ? total : null;
    }
    catch (_)
    {
        //Statistic missing, recorder under load or RBAC denied. The caller leaves the previous value untouched, the
        //chip stays readable on the last good snapshot until the next refresh succeeds.
        return null;
    }
}


//Refresh the five HA Energy daily-total slots from the recorder. Fired periodically from the card's tick loop; cheap to
//call (one WS round-trip per non-empty list, fired in parallel).
export async function refreshHaDailyTotals(host: HaDailyTotalsHost): Promise<void>
{
    const defaults = host._energyDefaults;
    const [solar, imp, exp, charged, discharged] = await Promise.all([
        fetchTodayKwhChange(host, defaults.solarStatEnergyFroms),
        fetchTodayKwhChange(host, defaults.gridStatEnergyFroms),
        fetchTodayKwhChange(host, defaults.gridStatEnergyTos),
        fetchTodayKwhChange(host, defaults.batteryStatEnergyTos),
        fetchTodayKwhChange(host, defaults.batteryStatEnergyFroms),
    ]);
    let changed = false;
    if (solar !== null && solar !== host._haSolarTodayKwh)
    {
        host._haSolarTodayKwh = solar;
        changed = true;
    }
    if (imp !== null && imp !== host._haGridImportTodayKwh)
    {
        host._haGridImportTodayKwh = imp;
        changed = true;
    }
    if (exp !== null && exp !== host._haGridExportTodayKwh)
    {
        host._haGridExportTodayKwh = exp;
        changed = true;
    }
    if (charged !== null && charged !== host._haBatteryChargedKwh)
    {
        host._haBatteryChargedKwh = charged;
        changed = true;
    }
    if (discharged !== null && discharged !== host._haBatteryDischargedKwh)
    {
        host._haBatteryDischargedKwh = discharged;
        changed = true;
    }
    if (changed)
    {
        host.requestUpdate();
    }
}


//Parse `energy/get_prefs` payload into the nine arrays above. Each Energy source contributes whichever of its declared
//meters Helios consumes; multi-source installs (split tariffs, separate import / export meters, multi-bank batteries)
//all aggregate by simple sum across the arrays at the consumer.
//
//Real-world shapes (HA core 2024+):
//  - solar:   { type: 'solar', stat_energy_from, stat_rate?, config_entry_solar_forecast? }
//  - grid:    { type: 'grid', stat_energy_from, stat_energy_to?, stat_rate?, power_config? }
//  - battery: { type: 'battery', stat_energy_from, stat_energy_to, stat_soc?, power_config? }
//
//`power_config.stat_rate` is the post-2026 grid + battery live-power slot . The top-level
//`stat_rate` on grid sources is the legacy slot still served by the official sankey card today; we read both so any
//Energy dashboard config Helios encounters maps cleanly into our model.
export function parseEnergyPrefs(prefs: {
    energy_sources?: Array<Record<string, unknown>>;
}): EnergyDefaults
{
    //Fresh literal rather than `{ ...EMPTY_ENERGY_DEFAULTS }` so the array fields are not aliased on the shared empty
    //default, avoiding cross-call contamination when multiple parses run in the same lifecycle (the subscription path
    //can trigger a parse while a previous one is still settling).
    const out: EnergyDefaults =
    {
        solarStatRates:         [],
        solarStatEnergyFroms:   [],
        gridStatRates:          [],
        gridStatEnergyFroms:    [],
        gridStatEnergyTos:      [],
        batteryStatRates:       [],
        batteryStatEnergyFroms: [],
        batteryStatEnergyTos:   [],
        batteryStatSocs:        [],
    };
    const sources = Array.isArray(prefs?.energy_sources) ? prefs!.energy_sources! : [];

    for (const src of sources)
    {
        if (!src || typeof src !== 'object')
        {
            continue;
        }
        const type = String(src['type'] ?? '').toLowerCase();

        if (type === 'solar')
        {
            const meter = pickFirstString(src['stat_energy_from']);
            if (meter)
            {
                out.solarStatEnergyFroms.push(meter);
            }
            const rate = pickFirstString(src['stat_rate']);
            if (rate)
            {
                out.solarStatRates.push(rate);
            }
        }
        else if (type === 'grid')
        {
            const imp = pickFirstString(src['stat_energy_from']);
            if (imp)
            {
                out.gridStatEnergyFroms.push(imp);
            }
            const exp = pickFirstString(src['stat_energy_to']);
            if (exp)
            {
                out.gridStatEnergyTos.push(exp);
            }
            const rate = pickFirstString(src['stat_rate']) ?? pickPowerConfigRate(src['power_config']);
            if (rate)
            {
                out.gridStatRates.push(rate);
            }
        }
        else if (type === 'battery')
        {
            const discharge = pickFirstString(src['stat_energy_from']);
            if (discharge)
            {
                out.batteryStatEnergyFroms.push(discharge);
            }
            const charge = pickFirstString(src['stat_energy_to']);
            if (charge)
            {
                out.batteryStatEnergyTos.push(charge);
            }
            const soc = pickFirstString(src['stat_soc']);
            if (soc)
            {
                out.batteryStatSocs.push(soc);
            }
            const rate = pickPowerConfigRate(src['power_config']);
            if (rate)
            {
                out.batteryStatRates.push(rate);
            }
        }
    }
    return out;
}


//Resolve `power_config.stat_rate` (preferred, signed convention) with a fall-back through the paired form. Returns null
//when the source has no power_config block or none of the slots carry a usable entity id. `stat_rate_to` is the second
//half of a paired sensor wiring (typical Victron / SolarEdge multi-MQTT install where charge and discharge come from
//separate power sensors); we return the `_from` half to stay on the legacy single-entity contract, the trainer + chip
//path remains correct since both members of the pair report the same magnitude.
function pickPowerConfigRate(raw: unknown): string | null
{
    if (!raw || typeof raw !== 'object')
    {
        return null;
    }
    const pc = raw as Record<string, unknown>;
    return pickFirstString(pc['stat_rate'])
        ?? pickFirstString(pc['stat_rate_inverted'])
        ?? pickFirstString(pc['stat_rate_from'])
        ?? pickFirstString(pc['stat_rate_to'])
        ?? null;
}


function pickFirstString(v: unknown): string | null
{
    if (typeof v === 'string' && v.trim() !== '')
    {
        return v.trim();
    }
    if (Array.isArray(v))
    {
        for (const item of v)
        {
            if (typeof item === 'string' && item.trim() !== '')
            {
                return item.trim();
            }
        }
    }
    return null;
}
