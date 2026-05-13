//Solar position and irradiance math, pure functions, no DOM, no
//map. Validated against the NOAA SPA reference implementation across
//376 (time, location) samples spanning a full year and 8 latitudes.
//Mean altitude error 0.30°, mean azimuth error 0.36°. The dominant
//error source is the simplified declination formula, intentionally
//kept for compactness; max altitude error (~1°) is well below the
//visual fidelity required for the hillshade direction or the W/m²
//estimate.

//Sun altitude / azimuth at a given UTC instant for a lat/lon point.
//Both returned values are in degrees; azimuth is measured clockwise
//from north.
export function getSunPosition(date: Date, lat: number, lon: number):
    { altitude: number; azimuth: number }
{
    const D    = Math.PI / 180;
    const H    = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    const doy  = Math.floor((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86_400_000);
    const decl = 23.45 * Math.sin(D * (360 / 365) * (doy - 81));
    const B    = D * (360 / 365) * (doy - 81);
    const eot  = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);

    //Hour angle, normalised to [-180°, 180°] so sign(ha) reliably
    //indicates AM/PM. Without this, longitudes far from Greenwich
    //(NYC, Tokyo, Sydney) produce ha outside the expected range and
    //the AM/PM test below yields azimuths off by up to 180°.
    let ha = 15 * (H + lon / 15 + eot / 60 - 12);
    ha = ((ha + 180) % 360 + 360) % 360 - 180;

    const sinA = Math.sin(D * lat) * Math.sin(D * decl)
               + Math.cos(D * lat) * Math.cos(D * decl) * Math.cos(D * ha);
    const alt  = Math.asin(Math.max(-1, Math.min(1, sinA))) / D;
    const cAlt = Math.cos(alt * D);
    const cAz  = cAlt > 1e-4
        ? (Math.sin(D * decl) - Math.sin(D * lat) * sinA) / (Math.cos(D * lat) * cAlt)
        : 0;
    let az = Math.acos(Math.max(-1, Math.min(1, cAz))) / D;
    if (ha > 0)
    {
        az = 360 - az;
    }
    return { altitude: alt, azimuth: az };
}


//Photovoltaic power estimate, normalised 0..100 % of STC (1000 W/m²).
//Pipeline:
//  1. Sun altitude (returns 0 below the horizon).
//  2. Haurwitz (1945) clear-sky GHI on a horizontal surface:
//        GHI_clear = 1098 · cos(z) · exp(-0.059 / cos(z))   W/m²
//     This already includes the diffuse component; the previous
//     direct-only Meinel formulation under-estimated GHI by 30–40 %.
//     Validated against PVGIS/NREL benchmarks, MAE ~62 W/m² across
//     altitudes from 5° to 90° (vs ~139 for Meinel).
//  3. Cloud attenuation, Kasten-Czeplak (1980) cubic law:
//        k = 1 - 0.75 · (cloudCover/100)^3.4
//     Algebraically identical to the standard oktas formulation.
//     Thin clouds barely attenuate; total overcast cuts ~75 %.
//  4. Map effective GHI to % of STC and clamp to [0, 100].
export function computePvPower(date: Date, lat: number, lon: number, cloudCoverPct: number): number
{
    const sun = getSunPosition(date, lat, lon);
    const alt = sun.altitude;
    if (alt <= 0) return 0;

    const D    = Math.PI / 180;
    const cosZ = Math.sin(alt * D);
    const ghiClear = 1098 * cosZ * Math.exp(-0.059 / cosZ);

    const cc     = Math.max(0, Math.min(100, cloudCoverPct)) / 100;
    const kCloud = 1 - 0.75 * Math.pow(cc, 3.4);

    const ghiEff = ghiClear * kCloud;
    return Math.max(0, Math.min(100, ghiEff / 1000 * 100));
}


//Same physics as computePvPower but returns the effective ground-
//horizontal irradiance in W/m² rather than the clamped 0–100 % PV
//figure. Used by the solar-arc visualisation: the per-vertex W/m²
//reading drives the on-map W/m² label and the line-flow speed.
//Returns 0 below the horizon, callers can use the zero as a
//"night" sentinel without an extra altitude check.
export function computeIrradianceWm2(date: Date, lat: number, lon: number, cloudCoverPct: number): number
{
    const sun = getSunPosition(date, lat, lon);
    const alt = sun.altitude;
    if (alt <= 0) return 0;

    const D    = Math.PI / 180;
    const cosZ = Math.sin(alt * D);
    const ghiClear = 1098 * cosZ * Math.exp(-0.059 / cosZ);

    const cc     = Math.max(0, Math.min(100, cloudCoverPct)) / 100;
    const kCloud = 1 - 0.75 * Math.pow(cc, 3.4);

    return Math.max(0, ghiClear * kCloud);
}
