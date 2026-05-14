//IGN LiDAR HD shadow source for metropolitan France + Corsica.
//
//IGN's Geoplateforme exposes the LiDAR HD survey through a standard
//OGC WMS-Raster endpoint at https://data.geopf.fr/wms-r. We fetch the
//MNH product ("Modele Numerique de Hauteur"): heights of objects
//above the bare terrain. A pixel of 8.5 means "something 8.5 m tall
//sits at this location", which lumps trees, hedges and buildings
//together.
//
//The endpoint accepts FORMAT=image/x-bil;bits=32, which streams the
//raster as raw little-endian float32 height values, no header.
//
//We then BIN the above-threshold cells onto a coarse ~10 m grid
//(target physical size, computed from the actual pixel pitch) and
//emit one rectangular Polygon per non-empty bin with render_height
//set to the bin's mean cell height. Per-bin granularity (rather
//than a single convex hull over each connected component) keeps a
//dense forest from collapsing into one giant blanket shadow: each
//~10 m patch casts its own short shadow trail, the trails alpha-
//composite into a realistic dappled pattern when projected.
//
//Coverage: France metropolitaine + Corse, no DOM-TOM (the LiDAR HD
//programme is still in roll-out for those territories). We stay
//outside the API entirely when home is outside that bbox.
//
//Reference: https://geoservices.ign.fr/lidarhd

import type {
    LidarSource,
    LidarShadowFetchOptions
} from '../helios-lidar';

const WMS_URL    = 'https://data.geopf.fr/wms-r';
const LAYER_MNH  = 'IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G';
//Native LiDAR HD product is in Lambert-93 (EPSG:2154); the WGS84G
//variant is reprojected on the IGN side, which saves us a coordinate
//transform here. Resolution stays the same at our working bbox sizes.

//Bounding box of metropolitan France + Corsica, padded by ~0.3 deg
//so home points right on the coast still trigger a fetch.
const FR_BBOX = { minLat: 41.0, maxLat: 51.5, minLon: -5.5, maxLon: 9.8 };

const M_PER_DEG_LAT = 111_320;

//Tuning constants.
//  HEIGHT_THRESH_M     , keep cells at or above this height (skip grass).
//  HEIGHT_MAX_M        , sanity clamp; anything above (giant sequoias top
//                        out at ~95 m) is treated as a garbage value.
//  BBOX_PAD_FACTOR     , over-fetch slightly so trees on the edge of the
//                        visible radius still cast their shadow inward.
//  BIN_TARGET_M        , physical target size of one shadow bin. ~10 m
//                        keeps the count manageable while preserving
//                        enough granularity that individual tree groups
//                        cast distinguishable shadows.
//  BIN_MIN_FILL_RATIO  , a bin is emitted only when this fraction of
//                        its cells passes the height threshold. Drops
//                        sparse bins (a single tree on grass) so the
//                        shadow output stays clean.
const HEIGHT_THRESH_M     = 5;
const HEIGHT_MAX_M        = 100;
const BBOX_PAD_FACTOR     = 1.15;
const BIN_TARGET_M        = 10;
const BIN_MIN_FILL_RATIO  = 0.15;

export const franceLidarHd: LidarSource =
{
    id:   'fr-ign-lidarhd',
    name: 'IGN LiDAR HD (France)',

    covers(lat: number, lon: number): boolean
    {
        return lat >= FR_BBOX.minLat && lat <= FR_BBOX.maxLat
            && lon >= FR_BBOX.minLon && lon <= FR_BBOX.maxLon;
    },

    async fetchShadowRegions(opts: LidarShadowFetchOptions): Promise<GeoJSON.FeatureCollection>
    {
        const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

        const rasterSize = Math.min(2048, Math.max(64, Math.round(opts.rasterSize)));

        const r    = Math.max(1, opts.radiusMeters);
        const dLat = (r * BBOX_PAD_FACTOR) / M_PER_DEG_LAT;
        const dLon = (r * BBOX_PAD_FACTOR)
                   / (M_PER_DEG_LAT * Math.cos(opts.homeLat * Math.PI / 180));

        const minLat = opts.homeLat - dLat;
        const maxLat = opts.homeLat + dLat;
        const minLon = opts.homeLon - dLon;
        const maxLon = opts.homeLon + dLon;

        //Bail if the fetch bbox sits entirely outside coverage.
        if (maxLat < FR_BBOX.minLat || minLat > FR_BBOX.maxLat
         || maxLon < FR_BBOX.minLon || minLon > FR_BBOX.maxLon)
        {
            return empty;
        }

        //WMS 1.3.0 with EPSG:4326 wants axis order (lat, lon); 1.1.1
        //would want (lon, lat). We pin to 1.3.0 so the axis convention
        //is unambiguous.
        const params = new URLSearchParams({
            SERVICE: 'WMS',
            VERSION: '1.3.0',
            REQUEST: 'GetMap',
            LAYERS:  LAYER_MNH,
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
            resp = await fetch(`${WMS_URL}?${params.toString()}`, { signal: opts.signal });
        }
        catch (_)
        {
            return empty;
        }
        if (!resp.ok) return empty;

        let buf: ArrayBuffer;
        try { buf = await resp.arrayBuffer(); }
        catch (_) { return empty; }

        //A short response means the server returned a ServiceException
        //XML rather than the binary raster (typical when the layer name
        //drifts); bail rather than read garbage as floats.
        const expectedBytes = rasterSize * rasterSize * 4;
        if (buf.byteLength < expectedBytes) return empty;

        const heights = new Float32Array(buf, 0, rasterSize * rasterSize);

        const pxLon = (maxLon - minLon) / rasterSize;
        const pxLat = (maxLat - minLat) / rasterSize;
        const pxLatM = pxLat * M_PER_DEG_LAT;

        //Bin size in cells, picked so each bin is roughly BIN_TARGET_M
        //metres on a side regardless of the user's chosen precision.
        //Clamped to [2, rasterSize/4] so we never produce fewer than
        //16 bins per side (otherwise the shadow output reads as one
        //slab) or more than rasterSize/2 (otherwise the cell-per-bin
        //count drops too low for a meaningful average).
        const binCells  = Math.max(2, Math.min(
            Math.floor(rasterSize / 4),
            Math.round(BIN_TARGET_M / pxLatM)
        ));
        const numBinsX  = Math.ceil(rasterSize / binCells);
        const numBinsY  = Math.ceil(rasterSize / binCells);

        const binHeightSum = new Float64Array(numBinsX * numBinsY);
        const binCount     = new Uint16Array(numBinsX * numBinsY);

        const cropM = opts.cropRadiusMeters && opts.cropRadiusMeters > 0
            ? opts.cropRadiusMeters
            : null;

        //Pass 1: accumulate cells above the height threshold into
        //their respective bins. Row j = 0 is the NORTH edge of the
        //bbox (WMS image convention, top-down); latitude decreases
        //as j grows.
        let keptCells = 0;
        let hMin = Infinity, hMax = -Infinity;

        for (let j = 0; j < rasterSize; j++)
        {
            const cLat = maxLat - (j + 0.5) * pxLat;
            const binJ = (j / binCells) | 0;
            for (let i = 0; i < rasterSize; i++)
            {
                const idx = j * rasterSize + i;
                const h   = heights[idx];
                if (!isFinite(h) || h < HEIGHT_THRESH_M || h > HEIGHT_MAX_M) continue;

                if (cropM !== null)
                {
                    const cLon = minLon + (i + 0.5) * pxLon;
                    if (haversineMeters(opts.homeLat, opts.homeLon, cLat, cLon) > cropM)
                    {
                        continue;
                    }
                }

                const binI    = (i / binCells) | 0;
                const binIdx  = binJ * numBinsX + binI;
                binHeightSum[binIdx] += h;
                binCount[binIdx]     += 1;
                keptCells++;
                if (h < hMin) hMin = h;
                if (h > hMax) hMax = h;
            }
        }

        //Pass 2: emit one rectangular polygon per non-empty bin. A bin
        //needs at least BIN_MIN_FILL_RATIO of its cells above threshold
        //to be emitted, dropping sparse bins (single isolated tree on
        //grass) that would otherwise create speckled stray shadows.
        const minFill = Math.max(1, Math.floor(binCells * binCells * BIN_MIN_FILL_RATIO));
        const out: GeoJSON.Feature[] = [];

        for (let binJ = 0; binJ < numBinsY; binJ++)
        {
            for (let binI = 0; binI < numBinsX; binI++)
            {
                const binIdx = binJ * numBinsX + binI;
                const count  = binCount[binIdx];
                if (count < minFill) continue;

                const avgH = binHeightSum[binIdx] / count;

                const i0   = binI * binCells;
                const i1   = Math.min(rasterSize, i0 + binCells);
                const j0   = binJ * binCells;
                const j1   = Math.min(rasterSize, j0 + binCells);

                const lonW = minLon + i0 * pxLon;
                const lonE = minLon + i1 * pxLon;
                const latN = maxLat - j0 * pxLat;
                const latS = maxLat - j1 * pxLat;

                //Closed CCW ring (GeoJSON outer-ring convention).
                out.push({
                    type:       'Feature',
                    geometry:
                    {
                        type:        'Polygon',
                        coordinates:
                        [[
                            [lonW, latS],
                            [lonE, latS],
                            [lonE, latN],
                            [lonW, latN],
                            [lonW, latS]
                        ]]
                    },
                    properties: { render_height: avgH, render_min_height: 0 }
                });
            }
        }

        if (keptCells > 0)
        {
            console.info(
                `[HELIOS] LiDAR shadows: ${keptCells} cells -> ${out.length} bins ` +
                `(${binCells}x${binCells} cells, ~${(binCells * pxLatM).toFixed(1)} m), ` +
                `height range [${hMin.toFixed(1)}, ${hMax.toFixed(1)}] m`
            );
        }
        else
        {
            console.info('[HELIOS] LiDAR cells: no cells passed the threshold');
        }

        return { type: 'FeatureCollection', features: out };
    }
};

//----------------------------------------------------------------- helpers

const EARTH_RADIUS_M = 6_371_008.8;

//Great-circle distance in metres, used for the circular crop. The
//cells we test are at most a couple of hundred metres from the home
//so a flat-earth approximation would also work, but haversine is
//cheap and unambiguous.
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number
{
    const toRad = Math.PI / 180;
    const dLat  = (lat2 - lat1) * toRad;
    const dLon  = (lon2 - lon1) * toRad;
    const a     = Math.sin(dLat / 2) ** 2
                + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad)
                * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}
