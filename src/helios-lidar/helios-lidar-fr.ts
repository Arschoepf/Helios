//IGN LiDAR HD raster source for metropolitan France + Corsica.
//
//Pipeline:
//  1. Two WMS GetMap calls in parallel (MNH height-above-ground +
//     MNT bare-earth elevation), both as little-endian float32
//     rasters (image/x-bil;bits=32).
//  2. MNH cells outside [HEIGHT_THRESH_M, HEIGHT_MAX_M] are reset to
//     0 so the consumer never has to repeat the noise filter.
//  3. The two rasters share the same bbox + dimensions, so the
//     engine can sample them in lockstep when computing the
//     irradiance scanner.
//
//Coverage stops at metropolitan France + Corsica (the LiDAR HD survey
//is still rolling out for DOM-TOM); we bail before the API call when
//the home falls outside that bbox.
//
//Reference: https://geoservices.ign.fr/lidarhd

import type {
    LidarSource,
    LidarFetchOptions,
    LidarFetchResult,
    LidarRasters
} from '../helios-lidar';

const WMS_URL    = 'https://data.geopf.fr/wms-r';
//IGN reprojects the native LAMB-93 product to WGS84G server-side so
//we can stay in lon/lat and avoid a coordinate transform.
//
//  MNH (Modele Numerique de Hauteur), height above local ground;
//       drives the irradiance scanner shadow ray cast.
//  MNT (Modele Numerique de Terrain), bare-earth ground elevation;
//       drives the custom DEM source that replaces MapTiler terrain
//       in the LiDAR area.
const LAYER_MNH  = 'IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G';
const LAYER_MNT  = 'IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G';

//Bounding box of metropolitan France + Corsica, padded by ~0.3 deg
//so coastal homes still trigger a fetch.
const FR_BBOX = { minLat: 41.0, maxLat: 51.5, minLon: -5.5, maxLon: 9.8 };

const M_PER_DEG_LAT = 111_320;

//MNH noise floor + ceiling. Below the floor we're picking up grass
//and survey noise; above the ceiling we're picking up known garbage
//(tall masts, errors).
const HEIGHT_THRESH_M = 5;
const HEIGHT_MAX_M    = 100;
//Over-fetch so edge cells still get a chance to cast their shadow
//inward into the visible disc.
const BBOX_PAD_FACTOR = 1.15;

export const franceLidarHd: LidarSource =
{
    id:   'fr-ign-lidarhd',
    name: 'IGN LiDAR HD (France)',

    covers(lat: number, lon: number): boolean
    {
        return lat >= FR_BBOX.minLat && lat <= FR_BBOX.maxLat
            && lon >= FR_BBOX.minLon && lon <= FR_BBOX.maxLon;
    },

    async fetch(opts: LidarFetchOptions): Promise<LidarFetchResult>
    {
        const empty: LidarFetchResult = { rasters: null };

        //Defensive clamp on the caller-supplied raster size.
        const rasterSize = Math.min(2048, Math.max(64, Math.round(opts.rasterSize)));

        const r    = Math.max(1, opts.radiusMeters);
        const dLat = (r * BBOX_PAD_FACTOR) / M_PER_DEG_LAT;
        const dLon = (r * BBOX_PAD_FACTOR)
                   / (M_PER_DEG_LAT * Math.cos(opts.homeLat * Math.PI / 180));

        const minLat = opts.homeLat - dLat;
        const maxLat = opts.homeLat + dLat;
        const minLon = opts.homeLon - dLon;
        const maxLon = opts.homeLon + dLon;

        const [mnhRaw, mntRaw] = await Promise.all([
            fetchBilLayer(LAYER_MNH, minLat, minLon, maxLat, maxLon, rasterSize, opts.signal),
            fetchBilLayer(LAYER_MNT, minLat, minLon, maxLat, maxLon, rasterSize, opts.signal)
        ]);

        if (!mnhRaw || !mntRaw) return empty;

        //Threshold MNH in place: anything outside the meaningful
        //range collapses to 0 so downstream code can take "h > 0"
        //as the canonical "this is an above-ground feature" test.
        const N = rasterSize * rasterSize;
        let nKept = 0;
        let hMin  = Infinity, hMax = -Infinity;
        for (let i = 0; i < N; i++)
        {
            const h = mnhRaw[i];
            if (!isFinite(h) || h < HEIGHT_THRESH_M || h > HEIGHT_MAX_M)
            {
                mnhRaw[i] = 0;
                continue;
            }
            nKept++;
            if (h < hMin) hMin = h;
            if (h > hMax) hMax = h;
        }

        const cosLat       = Math.cos(opts.homeLat * Math.PI / 180);
        const pxLatM       = ((maxLat - minLat) / rasterSize) * M_PER_DEG_LAT;
        const pxLonM       = ((maxLon - minLon) / rasterSize) * (M_PER_DEG_LAT * cosLat);
        const cellPitchM   = 0.5 * (pxLatM + pxLonM);

        const rasters: LidarRasters = {
            width:      rasterSize,
            height:     rasterSize,
            bounds:     { minLon, minLat, maxLon, maxLat },
            cellPitchM,
            mnh:        mnhRaw,
            mnt:        mntRaw
        };

        if (nKept > 0)
        {
            console.info(
                `[HELIOS] LiDAR: ${rasterSize}x${rasterSize} rasters, ` +
                `${nKept} MNH cells above threshold, ` +
                `height range [${hMin.toFixed(1)}, ${hMax.toFixed(1)}] m, ` +
                `cell pitch ${cellPitchM.toFixed(2)} m`
            );
        }
        else
        {
            console.info(
                `[HELIOS] LiDAR: ${rasterSize}x${rasterSize} rasters, ` +
                `no MNH cells above ${HEIGHT_THRESH_M} m`
            );
        }

        return { rasters };
    }
};

//----------------------------------------------------------------- helpers

//Single WMS GetMap call for one IGN elevation layer at the given
//bbox + raster size. Returns null on any network / decode failure;
//the caller bails when MNH or MNT is missing.
async function fetchBilLayer(
    layer:      string,
    minLat:     number,
    minLon:     number,
    maxLat:     number,
    maxLon:     number,
    rasterSize: number,
    signal?:    AbortSignal
): Promise<Float32Array | null>
{
    const params = new URLSearchParams({
        SERVICE: 'WMS',
        VERSION: '1.3.0',
        REQUEST: 'GetMap',
        LAYERS:  layer,
        STYLES:  '',
        CRS:     'EPSG:4326',
        BBOX:    `${minLat},${minLon},${maxLat},${maxLon}`,
        WIDTH:   String(rasterSize),
        HEIGHT:  String(rasterSize),
        FORMAT:  'image/x-bil;bits=32'
    });

    let resp: Response;
    try
    {
        resp = await fetch(`${WMS_URL}?${params.toString()}`, { signal });
    }
    catch (_)
    {
        return null;
    }
    if (!resp.ok) return null;

    let buf: ArrayBuffer;
    try { buf = await resp.arrayBuffer(); }
    catch (_) { return null; }

    //A short response means the server returned a ServiceException
    //XML rather than the binary raster (typical when the layer name
    //drifts); bail rather than read garbage as floats.
    const expectedBytes = rasterSize * rasterSize * 4;
    if (buf.byteLength < expectedBytes) return null;

    return new Float32Array(buf, 0, rasterSize * rasterSize);
}
