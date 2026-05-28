//Cell-temperature derating helpers for the PV prediction.
//
//A photovoltaic cell's power output drops as the cell warms above
//its STC reference temperature (25 °C). On a south-facing roof in
//summer the cell can easily reach 60-70 °C, which is a 14-18 %
//instantaneous output loss the analytical (irradiance + cloud)
//model ignores. Surfacing that loss closes a chunk of the gap
//between the forecast and the user's actual production around the
//midday peak on hot, sunny days.
//
//Two steps:
//
//  1. Estimate the cell temperature from air temperature, current
//     plane-of-array irradiance and wind speed. We use the classic
//     NOCT-based formulation with a Sandia-style wind cooling term:
//
//         T_cell = T_air + (NOCT - 20) / G_NOCT × GHI - k_wind × wind
//
//     where G_NOCT = 800 W/m² is the irradiance the NOCT spec
//     measures the cell at and k_wind ≈ 1.5 °C per m/s captures the
//     extra convective cooling above the NOCT default 1 m/s wind.
//
//  2. Apply the linear temperature-coefficient of P_mpp to the DC
//     output:
//
//         P_eff = P_dc × (1 + γ_pmp × (T_cell - 25))
//
//     γ_pmp is typically -0.0035 to -0.0050 /°C for monocrystalline
//     silicon. We default to -0.0040 (the value most datasheets
//     quote). The cap at 0.6 prevents a runaway value (a cell at
//     125 °C would otherwise return 60 % of nominal, but the panel
//     would have shut down long before that, the cap is a sanity
//     guard rather than a physical model).
//
//Both functions are pure. Callers pass in the live air temp and wind from the same weather fetch the rest of the engine consumes and reuse the result
//alongside the existing cloud-attenuated irradiance.

//Nominal Operating Cell Temperature, in °C. Modern monocrystalline
//modules typically spec 43-45 °C; we sit at the middle of that
//range so the cell-temp estimate stays unbiased across a typical
//residential fleet. Tied with WIND_COOLING_K below as a paired
//"how hot does the cell run" knob.
export const NOCT_CELL_C        = 44;
export const NOCT_IRRADIANCE    = 800;    //W/m² used to spec NOCT
export const NOCT_AIR_REF_C     = 20;     //°C, reference air at NOCT
export const WIND_COOLING_K     = 1.5;    //°C drop per m/s of wind
//Power temperature coefficient γ_pmp in % per °C, monocrystalline-
//silicon default. Most modern panels spec between -0.0030 and
//-0.0040; -0.0035 is the middle and matches the bulk of recent
//residential installs. The forecast-calibration ratio absorbs any
//residual mismatch within a few sunny days.
export const GAMMA_PMP_PER_C    = -0.0035;
export const STC_REF_C          = 25;     //STC cell reference

//Estimate the cell temperature in °C from the live weather context.
//Returns NaN when air temperature is unknown (the caller should fall
//back to "no derating" in that case rather than guessing).
export function cellTemperatureC(
    airTempC:   number,
    ghiWm2:     number,
    windMs:     number,
): number
{
    if (!isFinite(airTempC)) return NaN;
    const g = Math.max(0, ghiWm2);
    const w = isFinite(windMs) ? Math.max(0, windMs) : 0;
    return airTempC
        + (NOCT_CELL_C - NOCT_AIR_REF_C) / NOCT_IRRADIANCE * g
        - WIND_COOLING_K * w;
}

//Multiplicative derating factor in [0.6, 1.0+]. > 1 is possible
//in cold clear weather (cells run colder than STC and produce a
//little more than rated); the upper end is left uncapped so winter
//gains are surfaced honestly.
export function thermalDerating(cellTempC: number): number
{
    if (!isFinite(cellTempC)) return 1;
    const factor = 1 + GAMMA_PMP_PER_C * (cellTempC - STC_REF_C);
    return Math.max(0.6, factor);
}
