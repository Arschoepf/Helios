//IGN LiDAR HD tile-based source for metropolitan France + Corsica.
//
//Implements LidarSource.fetchTile: each call fires two parallel WMS
//GetMap requests against `data.geopf.fr`, one for MNT (bare-earth)
//and one for MNS (full surface model), both as little-endian float32
//rasters at the caller-requested size. The pair feeds the per-tile
//cache the custom DEM protocol holds; MapLibre's tile lifecycle is
//what actually drives when this gets called.
//
//Coverage stops at metropolitan France + Corsica (the LiDAR HD survey
//is still rolling out for DOM-TOM); we bail before the API call when
//the home falls outside that bbox.
//
//Reference: https://geoservices.ign.fr/lidarhd

import type {
    LidarSource,
    LidarTileFetchOptions,
    LidarTileData
} from '../helios-lidar';

const WMS_URL    = 'https://data.geopf.fr/wms-r';
const LAYER_MNT  = 'IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G';
const LAYER_MNS  = 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G';

//Bounding box of metropolitan France + Corsica, padded by ~0.3 deg
//so coastal homes still trigger a fetch. Used by `covers()` (cheap
//gate) and as a soft guard inside `fetchTile` (the WMS would 404 a
//tile that falls fully outside coverage anyway, but bailing early
//saves a round-trip).
const FR_BBOX = { minLat: 41.0, maxLat: 51.5, minLon: -5.5, maxLon: 9.8 };

const M_PER_DEG_LAT = 111_320;

export const franceLidarHd: LidarSource =
{
    id:   'fr-ign-lidarhd',
    name: 'IGN LiDAR HD (France)',

    covers(lat: number, lon: number): boolean
    {
        return lat >= FR_BBOX.minLat && lat <= FR_BBOX.maxLat
            && lon >= FR_BBOX.minLon && lon <= FR_BBOX.maxLon;
    },

    async fetchTile(opts: LidarTileFetchOptions): Promise<LidarTileData | null>
    {
        //Defensive clamp on the caller-supplied raster size.
        const rasterSize = Math.min(2048, Math.max(64, Math.round(opts.rasterSize)));

        //Skip the WMS round-trip when the tile sits fully outside the
        //LiDAR HD coverage bbox.
        if (opts.maxLat < FR_BBOX.minLat || opts.minLat > FR_BBOX.maxLat
         || opts.maxLon < FR_BBOX.minLon || opts.minLon > FR_BBOX.maxLon)
        {
            return null;
        }

        const [mnt, mns] = await Promise.all([
            fetchBilLayer(LAYER_MNT, opts.minLat, opts.minLon, opts.maxLat, opts.maxLon, rasterSize, opts.signal),
            fetchBilLayer(LAYER_MNS, opts.minLat, opts.minLon, opts.maxLat, opts.maxLon, rasterSize, opts.signal)
        ]);

        if (!mnt || !mns) return null;

        const cosLat     = Math.cos(((opts.minLat + opts.maxLat) * 0.5) * Math.PI / 180);
        const pxLatM     = ((opts.maxLat - opts.minLat) / rasterSize) * M_PER_DEG_LAT;
        const pxLonM     = ((opts.maxLon - opts.minLon) / rasterSize) * (M_PER_DEG_LAT * cosLat);
        const cellPitchM = 0.5 * (pxLatM + pxLonM);

        return {
            width:  rasterSize,
            height: rasterSize,
            bounds: {
                minLon: opts.minLon, minLat: opts.minLat,
                maxLon: opts.maxLon, maxLat: opts.maxLat
            },
            cellPitchM,
            mnt,
            mns
        };
    }
};

//----------------------------------------------------------------- helpers

//Single WMS GetMap call for one IGN elevation layer at the given
//bbox + raster size. Returns null on any network / decode failure.
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
