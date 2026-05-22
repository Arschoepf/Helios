//Forecast calibration: derive a multiplier that nudges the raw
//Open-Meteo + clear-sky model toward the user's actual production
//history. The model alone can drift systematically: cloud-cover
//over-/under-prediction by Open-Meteo, panel soiling, install
//orientation that the configured azimuth doesn't perfectly capture,
//inverter losses, etc. By comparing the past N days of "what the
//model would have predicted" against "what the user actually
//produced", we get a single ratio that captures all those static
//biases at once.
//
//Pure-function module: takes the host's already-fetched PV history
//and weather series, returns null when there's not enough data
//to compute a meaningful ratio.

import type { HeliosConfig } from '../helios-config';
import { pvCalibK, pvNormalizeToWatts, computePvPowerWeighted, type PvHistory } from './pv';
import { getHomeCoords } from './init';
import type { ChartHost } from './charts';


export interface ForecastCalibration
{
    //Multiplier in [0.5, 1.5]. 1.0 means the model matches reality
    //perfectly; <1 means the model over-predicts (actual <
    //predicted); >1 means the model under-predicts.
    ratio:    number;

    //Number of past days that contributed to the ratio. Below 2 we
    //return null entirely (no calibration shown).
    daysUsed: number;
}


//Rolling window length, kept tight so the ratio reacts within a
//week to real-world changes (seasonal sun height, soiling, a panel
//cleaning event) instead of dragging stale calibration forever.
const WINDOW_DAYS = 5;

//Ratio clamp. A 50 % miss in either direction would mean the
//forecast or the sensor is so broken that "applying calibration"
//is not the right fix; we'd rather show the raw model and let the
//user notice the discrepancy.
const RATIO_MIN = 0.5;
const RATIO_MAX = 1.5;

//Per-day floor: skip days where the predicted total is too low to
//give a stable ratio. A cloudy day predicting 1 kWh produced 0.8
//kWh is a 0.8 ratio; the next day's 25 kWh prediction shouldn't
//be scaled by that. 2 kWh keeps the comparison in the regime
//where the model has signal.
const MIN_DAY_PREDICTED_KWH = 2;


//Returns the calibration ratio plus the count of days that fed
//into it, or null when fewer than 2 past days have enough data
//to be averaged.
export function computeForecastCalibration(host: ChartHost): ForecastCalibration | null
{
    const k      = pvCalibK(host.config);
    const series = host._chartSeries;
    const hist   = host._pvHistory;
    const coords = getHomeCoords(host.config, host.hass);
    if (k === null || k <= 0 || !series || !hist || !coords) return null;

    //Walk back day by day starting at yesterday. For each day,
    //compute the model's "would-have-predicted" kWh from the
    //hourly weather samples and the user's actual produced kWh
    //from the PV history. Keep going up to WINDOW_DAYS or until
    //we run out of weather samples.
    const HOUR_MS = 3_600_000;
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);

    const ratios: number[] = [];
    //Same LiDAR raster + per-array shading used in the live
    //prediction; pulling it once outside the day loop so each
    //past-day integration sees identical shading geometry as
    //the upcoming days. Null on installs without LiDAR coverage,
    //in which case predictedKwhForDay skips the raycast.
    const raster = host._engine?.getLidarRaster() ?? null;

    for (let dayOffset = 1; dayOffset <= WINDOW_DAYS; dayOffset++)
    {
        const dayStartMs = today0.getTime() - dayOffset * 24 * HOUR_MS;
        const dayEndMs   = dayStartMs + 24 * HOUR_MS;

        const predictedKwh = predictedKwhForDay(host.config, series, coords, dayStartMs, dayEndMs, raster);
        if (predictedKwh < MIN_DAY_PREDICTED_KWH) continue;

        const actualKwh = actualKwhForDay(hist, host._pvUnit, dayStartMs, dayEndMs);
        if (actualKwh <= 0) continue;

        const r = actualKwh / predictedKwh;
        if (!isFinite(r) || r <= 0) continue;
        ratios.push(Math.max(RATIO_MIN, Math.min(RATIO_MAX, r)));
    }

    if (ratios.length < 2) return null;

    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    return {
        ratio:    Math.max(RATIO_MIN, Math.min(RATIO_MAX, mean)),
        daysUsed: ratios.length
    };
}


//Integrate the model's predicted production over [startMs, endMs)
//using the hourly weather samples in `series`. Each hourly sample
//contributes one hour's worth at its midpoint power.
function predictedKwhForDay(
    config:   HeliosConfig | undefined,
    series:   NonNullable<ChartHost['_chartSeries']>,
    coords:   { lat: number; lon: number },
    startMs:  number,
    endMs:    number,
    raster:   import('../engine/pv-shading').NdsmRaster | null,
): number
{
    const k = pvCalibK(config);
    if (k === null || k <= 0) return 0;
    let kwh = 0;
    for (let i = 0; i < series.times.length; i++)
    {
        const tMs = series.times[i].getTime();
        if (tMs < startMs || tMs >= endMs) continue;
        const cloud = series.cloud[i] ?? 0;
        const pct = computePvPowerWeighted(config, series.times[i], coords.lat, coords.lon, cloud, {
            airTempC: series.temperature?.[i] ?? NaN,
            windMs:   series.windSpeed?.[i]   ?? NaN,
            raster,
        });
        if (pct <= 0) continue;
        kwh += (pct * k) / 1000;
    }
    return kwh;
}


//Sum observed PV over [startMs, endMs). Handles both power
//sensors (trapezoidal integration) and cumulative-energy sensors
//(diff consecutive samples, clamp gaps).
function actualKwhForDay(
    hist:    PvHistory,
    pvUnit:  string,
    startMs: number,
    endMs:   number
): number
{
    if (hist.times.length < 2) return 0;
    const unit = (pvUnit || '').toLowerCase();
    const isCumulativeEnergy = unit === 'wh' || unit === 'kwh' || unit === 'mwh';
    const energyFactor = unit === 'wh' ? 1 / 1000
                       : unit === 'mwh' ? 1000
                       : 1;
    const HOUR_MS = 3_600_000;

    if (isCumulativeEnergy)
    {
        //Cumulative energy: sum positive deltas where both samples
        //fall inside the day. Counter resets drop the delta.
        let kwh = 0;
        for (let i = 1; i < hist.times.length; i++)
        {
            const tMs = hist.times[i].getTime();
            if (tMs < startMs || tMs >= endMs) continue;
            const dv = hist.values[i] - hist.values[i - 1];
            if (!isFinite(dv) || dv < 0) continue;
            kwh += dv * energyFactor;
        }
        return kwh;
    }

    //Power sensor: trapezoidal integration over consecutive pairs
    //that bracket the day's window.
    let kwh = 0;
    for (let i = 1; i < hist.times.length; i++)
    {
        const tCurrMs = hist.times[i].getTime();
        if (tCurrMs < startMs || tCurrMs >= endMs) continue;
        const tPrevMs = hist.times[i - 1].getTime();
        const dtH = (tCurrMs - tPrevMs) / HOUR_MS;
        if (dtH <= 0 || dtH > 6) continue;
        const wPrev = pvNormalizeToWatts(hist.values[i - 1], pvUnit);
        const wCurr = pvNormalizeToWatts(hist.values[i],     pvUnit);
        if (!isFinite(wPrev) || !isFinite(wCurr)) continue;
        kwh += ((wPrev + wCurr) / 2) * dtH / 1000;
    }
    return kwh;
}
