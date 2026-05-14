//IGN LiDAR HD raster source for metropolitan France + Corsica.
//
//Two parallel WMS GetMap calls per fetch:
//  - MNT (Modele Numerique de Terrain): bare-earth elevation, the
//    smooth ground the custom DEM source feeds to MapLibre's
//    setTerrain.
//  - MNS (Modele Numerique de Surface): full surface model
//    (ground + vegetation + buildings + everything LiDAR picked up),
//    drives the irradiance scanner's shadow ray cast so every
//    above-ground feature contributes.
//
//Both rasters share the same bbox + dimensions, so consumers can
//sample them in lockstep when computing the scanner colour.
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
const LAYER_MNT  = 'IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G';
const LAYER_MNS  = 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G';

//Bounding box of metropolitan France + Corsica, padded by ~0.3 deg
//so coastal homes still trigger a fetch.
const FR_BBOX = { minLat: 41.0, maxLat: 51.5, minLon: -5.5, maxLon: 9.8 };

const M_PER_DEG_LAT = 111_320;

//Over-fetch so edge cells still get a chance to contribute their
//shadow inward into the visible disc.
const BBOX_PAD_FACTOR = 1.10;

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

        const [mntRaw, mnsRaw] = await Promise.all([
            fetchBilLayer(LAYER_MNT, minLat, minLon, maxLat, maxLon, rasterSize, opts.signal),
            fetchBilLayer(LAYER_MNS, minLat, minLon, maxLat, maxLon, rasterSize, opts.signal)
        ]);

        if (!mntRaw || !mnsRaw) return empty;

        const cosLat     = Math.cos(opts.homeLat * Math.PI / 180);
        const pxLatM     = ((maxLat - minLat) / rasterSize) * M_PER_DEG_LAT;
        const pxLonM     = ((maxLon - minLon) / rasterSize) * (M_PER_DEG_LAT * cosLat);
        const cellPitchM = 0.5 * (pxLatM + pxLonM);

        //Sanity log on the surface delta so out-of-spec MNS values
        //(typically NaNs or sea-level fall-backs) show up in the
        //console without crashing the pipeline. We don't gate on it,
        //the scanner compute clamps per pixel anyway.
        const N = rasterSize * rasterSize;
        let nLifted = 0;
        let maxLift = 0;
        for (let i = 0; i < N; i++)
        {
            const lift = mnsRaw[i] - mntRaw[i];
            if (isFinite(lift) && lift > 0.5)
            {
                nLifted++;
                if (lift > maxLift) maxLift = lift;
            }
        }
        console.info(
            `[HELIOS] LiDAR: ${rasterSize}x${rasterSize} MNT + MNS rasters, ` +
            `${nLifted} above-ground cells, max lift ${maxLift.toFixed(1)} m, ` +
            `cell pitch ${cellPitchM.toFixed(2)} m`
        );

        const rasters: LidarRasters = {
            width:      rasterSize,
            height:     rasterSize,
            bounds:     { minLon, minLat, maxLon, maxLat },
            cellPitchM,
            mnt:        mntRaw,
            mns:        mnsRaw
        };

        return { rasters };
    }
};

//----------------------------------------------------------------- helpers

//Single WMS GetMap call for one IGN elevation layer at the given
//bbox + raster size. Returns null on any network / decode failure;
//the caller bails when either layer is missing.
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
