//Open-Meteo weather data layer, multi-model fetch, in-browser
//cache, and pure-function helpers around the weather signal.
//
//No DOM, no map, no engine state. Everything that talks to the
//forecast API lives here so the engine can stay focused on
//rendering.

//Hourly forecast at the home location. Numeric arrays are aligned
//on `times`. `shortwave` uses -1 as a "no data" sentinel, 0 is a
//legitimate night value, so we can't conflate them.
export interface SampleHourly
{
    lat:         number;
    lon:         number;
    times:       Date[];
    cloudCover:  number[];
    cloudLow:    number[];
    cloudMid:    number[];
    cloudHigh:   number[];
    weatherCode: number[];
    shortwave:   number[];
}


//Forecast window: 2 days back + 2 days forward (today included on
//the forecast side) = a 5-day timeline. Wider windows are technic-
//ally possible but kill the UX in practice, forecasts past 48 h
//get noisy, and the timeline becomes too dense to scrub precisely.
const PAST_DAYS     = 2;
//Open-Meteo counts today inside `forecast_days`, so FORECAST_DAYS=3
//yields today + 2 future days. Combined with PAST_DAYS=2, the
//timeline spans 5 days total, 2 past, today, 2 forecast, which is
//the practical window: beyond +2 days the cloud-cover forecast loses
//predictive value.
const FORECAST_DAYS = 3;

//Exponential back-off on consecutive HTTP 429 (rate-limited)
//responses, indexed by streak count. After exhausting the table we
//stay on the last value (60 min) so a single successful fetch
//resets the counter, the user is never permanently locked out.
export const RATE_LIMIT_BACKOFF_MS = [
    5  * 60_000,
    15 * 60_000,
    60 * 60_000
];


//Median of a numeric array, ignoring null/undefined/NaN. Used to
//combine concurrent forecasts from multiple weather models into a
//single robust value per timestep. Median over mean: individual
//models occasionally emit gross outliers (typical: cloud_cover_low
//pegged at 100 % from the Sundqvist parametrisation hitting an
//underground pressure level, open-meteo issue #416).
export function medianOfNumbers(values: ReadonlyArray<number | null | undefined>): number | null
{
    const clean: number[] = [];
    for (const v of values)
    {
        if (v == null || Number.isNaN(v)) continue;
        clean.push(v);
    }
    if (clean.length === 0) return null;
    clean.sort((a, b) => a - b);
    const mid = clean.length >> 1;
    return clean.length % 2 === 0
        ? (clean[mid - 1] + clean[mid]) / 2
        : clean[mid];
}


//Pick the Open-Meteo models to query for the given coordinate. We
//always include one global model (ECMWF IFS 0.25°) plus the most
//accurate national/regional model if the point falls inside its
//coverage area. Coverage boxes are deliberately conservative so
//edge points don't get a model that returns mostly nulls.
//
//Order matters: regions whose box is enclosed by a larger neighbour
//(e.g. Korea inside the Japan box) MUST be tested first.
export function pickModelsForLocation(lat: number, lon: number, precision: 'standard' | 'high'): string[]
{
    if (precision === 'standard')
    {
        return ['best_match'];
    }

    const GLOBAL = 'ecmwf_ifs025';

    //France métropolitaine + Corsica. AROME-France HD at 1.3 km.
    if (lat >= 41.3 && lat <= 51.2 && lon >= -5.5 && lon <= 8.5)
    {
        return ['meteofrance_seamless', GLOBAL];
    }
    //United Kingdom & Ireland. UKMO UK 2 km.
    if (lat >= 49.5 && lat <= 61.0 && lon >= -10.5 && lon <= 2.0)
    {
        return ['ukmo_seamless', GLOBAL];
    }
    //Central Europe, DE/AT/CH/CZ/PL/Benelux. ICON-D2 at 2 km.
    if (lat >= 46.0 && lat <= 56.0 && lon >= 5.0 && lon <= 22.0)
    {
        return ['dwd_icon_seamless', GLOBAL];
    }
    //Italy proper (peninsula + islands).
    if (lat >= 36.5 && lat <= 47.0 && lon >= 10.0 && lon <= 18.5)
    {
        return ['italia_meteo_arpae_icon_2i', GLOBAL];
    }
    //Nordics, Norway/Sweden/Finland/Denmark. MET Nordic at 1 km.
    if (lat >= 54.5 && lat <= 71.5 && lon >= 4.0 && lon <= 32.0)
    {
        return ['metno_seamless', GLOBAL];
    }
    //Continental US (CONUS). NOAA HRRR 3 km via gfs_seamless.
    if (lat >= 24.5 && lat <= 49.5 && lon >= -125.0 && lon <= -66.5)
    {
        return ['gfs_seamless', GLOBAL];
    }
    //Korea, must be tested before Japan (the JMA box encloses Korea).
    if (lat >= 33.0 && lat <= 39.0 && lon >= 124.5 && lon <= 132.0)
    {
        return ['kma_seamless', GLOBAL];
    }
    //Japan. JMA MSM 5 km.
    if (lat >= 24.0 && lat <= 46.0 && lon >= 122.0 && lon <= 146.0)
    {
        return ['jma_seamless', GLOBAL];
    }
    //Australia & NZ. BOM ACCESS-G 15 km.
    if (lat >= -47.5 && lat <= -10.0 && lon >= 112.0 && lon <= 179.0)
    {
        return ['bom_access_global', GLOBAL];
    }
    //Anywhere else: ECMWF + GFS in parallel. Two independent global
    //models give a meaningfully better median than a single one.
    return [GLOBAL, 'gfs_seamless'];
}


//In-browser cache. Precision is currently fixed to 'high'; the tag
//stays in the key so that re-introducing a precision toggle later
//won't collide with existing cached payloads.
const CACHE_KEY_PREFIX = 'helios-weather-cache:';
const CACHE_TTL_MS     = 30 * 60_000;

interface CachedPayload
{
    storedAt: number;
    payload: {
        lat:         number;
        lon:         number;
        times:       string[];
        cloudCover:  number[];
        cloudLow:    number[];
        cloudMid:    number[];
        cloudHigh:   number[];
        weatherCode: number[];
        shortwave:   number[];
    };
}

function cacheKey(lat: number, lon: number, precision: 'standard' | 'high'): string
{
    return `${CACHE_KEY_PREFIX}${precision}:${lat.toFixed(3)},${lon.toFixed(3)}`;
}

function readCache(lat: number, lon: number, precision: 'standard' | 'high'): SampleHourly | null
{
    try
    {
        const raw = window.localStorage?.getItem(cacheKey(lat, lon, precision));
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (Date.now() - obj.storedAt > CACHE_TTL_MS) return null;
        //Even within the TTL, reject the cache if we crossed a local
        //midnight since it was written. Open-Meteo anchors past_days /
        //forecast_days to "today" in the location's timezone, so the
        //forecast window slides at midnight and stale cache from
        //yesterday would otherwise pin the timeline to the old day.
        if (new Date(obj.storedAt).toDateString() !== new Date().toDateString())
        {
            return null;
        }
        const p = obj.payload;
        if (!p || Array.isArray(p) || !Array.isArray(p.times)) return null;
        return {
            lat:         p.lat,
            lon:         p.lon,
            times:       p.times.map((t: string) => new Date(t)),
            cloudCover:  p.cloudCover  ?? [],
            cloudLow:    p.cloudLow    ?? [],
            cloudMid:    p.cloudMid    ?? [],
            cloudHigh:   p.cloudHigh   ?? [],
            weatherCode: p.weatherCode ?? [],
            shortwave:   p.shortwave   ?? []
        };
    }
    catch
    {
        return null;
    }
}

function writeCache(lat: number, lon: number, precision: 'standard' | 'high', data: SampleHourly): void
{
    try
    {
        const obj: CachedPayload =
        {
            storedAt: Date.now(),
            payload:  {
                lat:         data.lat,
                lon:         data.lon,
                times:       data.times.map(t => t.toISOString()),
                cloudCover:  data.cloudCover,
                cloudLow:    data.cloudLow,
                cloudMid:    data.cloudMid,
                cloudHigh:   data.cloudHigh,
                weatherCode: data.weatherCode,
                shortwave:   data.shortwave
            }
        };
        window.localStorage?.setItem(cacheKey(lat, lon, precision), JSON.stringify(obj));
    }
    catch
    {
        //Storage quota / permission errors are silently ignored ,
        //the user just gets a fresh fetch next time.
    }
}


//Variables we ask Open-Meteo for. shortwave_radiation_instant gives
//the GHI W/m² *at* the indicated hour (vs averaged over the
//preceding hour), matching our visual time cursor. The split cloud
//variables let us:
//  - keep the total `cloud_cover` for visual rendering
//  - detect the well-known "fog spike" failure mode of low-layer
//    parametrisations (open-meteo issue #416).
const HOURLY_VARS = [
    'shortwave_radiation_instant',
    'cloud_cover',
    'cloud_cover_low',
    'cloud_cover_mid',
    'cloud_cover_high',
    'weather_code'
];

//Multi-model responses suffix the variable key with the model name
//(e.g. shortwave_radiation_instant_meteofrance_seamless). The
//"best_match" mode is the exception, bare keys. We try the bare
//key first then the suffixed ones, so the same code handles both.
function readSeries(row: any, varName: string, models: string[]): Array<number | null>
{
    const direct = row?.hourly?.[varName];
    if (Array.isArray(direct))
    {
        return direct.map((v: any) => (v == null || Number.isNaN(v)) ? null : Number(v));
    }
    const series: Array<Array<number | null>> = [];
    for (const m of models)
    {
        const arr = row?.hourly?.[`${varName}_${m}`];
        if (!Array.isArray(arr)) continue;
        series.push(arr.map((v: any) => (v == null || Number.isNaN(v)) ? null : Number(v)));
    }
    if (series.length === 0) return [];
    const len = Math.max(...series.map(s => s.length));
    const out: Array<number | null> = new Array(len);
    for (let i = 0; i < len; i++)
    {
        out[i] = medianOfNumbers(series.map(s => s[i]));
    }
    return out;
}

//weather_code is categorical (WMO 0..99), averaging is meaningless.
//Pick the value from the first model that has it, which is by
//construction the most appropriate for the user's location.
function readWeatherCode(row: any, models: string[]): number[]
{
    const direct = row?.hourly?.weather_code;
    if (Array.isArray(direct))
    {
        return direct.map((v: any) => Number(v) || 0);
    }
    for (const m of models)
    {
        const arr = row?.hourly?.[`weather_code_${m}`];
        if (Array.isArray(arr))
        {
            return arr.map((v: any) => Number(v) || 0);
        }
    }
    return [];
}

//Cloud-cover gaps clamp to 0 (treat missing as clear). Shortwave
//uses -1 because 0 is a valid night value.
const fillCloud     = (arr: Array<number | null>): number[] => arr.map(v => v == null ? 0  : v);
const fillShortwave = (arr: Array<number | null>): number[] => arr.map(v => v == null ? -1 : v);


//Single-point hourly forecast at the home location. Reads from the
//browser cache when fresh; otherwise fetches Open-Meteo with
//multi-model fusion (median per timestep), the user's elevation
//passed via &elevation= for sharper boundary conditions, and a
//"layer-weighted" effective cloud cover that matches both ground
//perception and shortwave attenuation:
//
//  effective = low + 0.6·mid + 0.2·high  (capped at 100 %)
//
//This replaces the API's raw `cloud_cover` (satellite-view total)
//which over-counts high cirrus on otherwise clear days.
//
//Returns null on any failure so the caller can degrade gracefully.
export async function fetchHomePointData(
    lat:       number,
    lon:       number,
    elevation: number | undefined,
    precision: 'standard' | 'high',
    signal:    AbortSignal
): Promise<SampleHourly | null>
{
    const cached = readCache(lat, lon, precision);
    if (cached) return cached;

    const models = pickModelsForLocation(lat, lon, precision);

    let url =
        `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${lat.toFixed(5)}` +
        `&longitude=${lon.toFixed(5)}` +
        `&hourly=${HOURLY_VARS.join(',')}` +
        `&models=${models.join(',')}` +
        `&past_days=${PAST_DAYS}&forecast_days=${FORECAST_DAYS}` +
        `&timezone=auto`;

    if (elevation !== undefined)
    {
        url += `&elevation=${elevation.toFixed(0)}`;
    }

    try
    {
        const res = await fetch(url, { signal });
        if (!res.ok) return null;
        const json = await res.json();
        const row = Array.isArray(json) ? json[0] : json;

        const tArr  = row?.hourly?.time ?? [];
        const times: Date[] = tArr.map((t: string) => new Date(t));

        const lowSeries  = fillCloud(readSeries(row, 'cloud_cover_low',  models));
        const midSeries  = fillCloud(readSeries(row, 'cloud_cover_mid',  models));
        const highSeries = fillCloud(readSeries(row, 'cloud_cover_high', models));

        const cloudEffective = lowSeries.map((lo, i) =>
        {
            const mi = midSeries[i]  ?? 0;
            const hi = highSeries[i] ?? 0;
            return Math.min(100, (lo ?? 0) + 0.6 * mi + 0.2 * hi);
        });

        const data: SampleHourly = {
            lat,
            lon,
            times,
            cloudCover:  cloudEffective,
            cloudLow:    lowSeries,
            cloudMid:    midSeries,
            cloudHigh:   highSeries,
            weatherCode: readWeatherCode(row, models),
            shortwave:   fillShortwave(readSeries(row, 'shortwave_radiation_instant', models))
        };

        writeCache(lat, lon, precision, data);
        return data;
    }
    catch
    {
        //AbortError on cancellation, network errors, JSON parse errors ,
        //all swallowed silently. The caller treats null as "no data
        //available" and renders the timeline ramps as empty.
        return null;
    }
}
