//IGN LiDAR HD vegetation source for metropolitan France + Corsica.
//
//IGN's Geoplateforme exposes the LiDAR HD survey through a standard
//OGC WMS-Raster endpoint at https://data.geopf.fr/wms-r. Three
//height products are available; we want MNH ("Modele Numerique de
//Hauteur"): heights of objects ABOVE the bare terrain. A pixel of
//8.5 means "something 8.5 m tall sits at this location", which
//lumps trees, hedges and buildings together. We then subtract the
//building footprints we already have (helios-buildings.ts) to keep
//only the vegetation.
//
//The endpoint accepts FORMAT=image/x-bil;bits=32, which streams the
//raster as raw little-endian float32 height values, no header. With
//WIDTH=HEIGHT=128 a typical 600 m bbox costs 64 KB on the wire and
//gives a 4-5 m ground sample, comfortably tree-scale.
//
//Coverage: France metropolitaine + Corse, no DOM-TOM (the LiDAR HD
//programme is still in roll-out for those territories as of 2026).
//We stay outside the API entirely when home is outside that bbox,
//rather than waiting for a 404.
//
//Reference: https://geoservices.ign.fr/lidarhd

import type { LidarVegetationSource, LidarFetchOptions } from '../helios-lidar';

const WMS_URL    = 'https://data.geopf.fr/wms-r';
const LAYER_MNH  = 'IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G';
//Native LiDAR HD product is in Lambert-93 (EPSG:2154) but the WGS84G
//variant of the layer is reprojected on the IGN side, which saves us
//a coordinate transform here. Resolution stays the same at our
//working bbox sizes.

//Bounding box of metropolitan France + Corsica, padded by ~0.3 deg
//so home points right on the coast still trigger a fetch.
const FR_BBOX = { minLat: 41.0, maxLat: 51.5, minLon: -5.5, maxLon: 9.8 };

const M_PER_DEG_LAT = 111_320;

//Fetch parameters. Tune here if we want sharper trees vs lighter
//network footprint. The raster size is now caller-driven (passed via
//LidarFetchOptions.rasterSize) so the editor can expose it; the
//remaining constants stay here.
//  HEIGHT_THRESH_M - keep cells at or above this height (skip grass)
//  HEIGHT_MAX_M    - sanity clamp; anything above (giant sequoias top
//                    out at 95 m) is treated as a garbage value
//  BBOX_PAD_FACTOR - over-fetch slightly so trees on the edge of the
//                    visible radius still cast their shadow inward
const HEIGHT_THRESH_M     = 5;
const HEIGHT_MAX_M        = 100;
const BBOX_PAD_FACTOR     = 1.15;
//Outward inflation of each MapTiler building footprint when masking
//cells. MapTiler's vector geometry is often a few metres smaller than
//the actual structure; the padding catches the wall-cells and
//attached sheds that would otherwise leak through as "vegetation".
const BUILDING_MASK_PAD_M = 5;

export const franceLidarHd: LidarVegetationSource =
{
    id:   'fr-ign-lidarhd',
    name: 'IGN LiDAR HD (France)',

    covers(lat: number, lon: number): boolean
    {
        return lat >= FR_BBOX.minLat && lat <= FR_BBOX.maxLat
            && lon >= FR_BBOX.minLon && lon <= FR_BBOX.maxLon;
    },

    async fetch(opts: LidarFetchOptions): Promise<GeoJSON.FeatureCollection>
    {
        const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

        //Pixel count per side, caller-driven (the engine maps the
        //user-configured vegetation level to a specific value). We
        //clamp defensively so a bad config value cannot send a 50000-
        //pixel request to IGN.
        const rasterSize = Math.min(2048, Math.max(64, Math.round(opts.rasterSize)));

        const r = Math.max(1, opts.radiusMeters);
        const dLat = (r * BBOX_PAD_FACTOR) / M_PER_DEG_LAT;
        const dLon = (r * BBOX_PAD_FACTOR)
                   / (M_PER_DEG_LAT * Math.cos(opts.homeLat * Math.PI / 180));

        const minLat = opts.homeLat - dLat;
        const maxLat = opts.homeLat + dLat;
        const minLon = opts.homeLon - dLon;
        const maxLon = opts.homeLon + dLon;

        //WMS 1.3.0 with EPSG:4326 wants axis order (lat, lon) for the
        //bbox; 1.1.1 would want (lon, lat). We pin to 1.3.0 so the
        //axis convention is unambiguous.
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
        catch (e)
        {
            //Network error or aborted, surface as empty result. The
            //caller already logs at the engine level if it cares.
            return empty;
        }
        if (!resp.ok)
        {
            return empty;
        }

        let buf: ArrayBuffer;
        try
        {
            buf = await resp.arrayBuffer();
        }
        catch (_) { return empty; }

        //Sanity check: 4 bytes per pixel, no header. A short response
        //means the server returned an exception XML instead of binary
        //(common when the layer name drifts), bail rather than read
        //garbage as floats.
        const expectedBytes = rasterSize * rasterSize * 4;
        if (buf.byteLength < expectedBytes)
        {
            return empty;
        }

        const heights = new Float32Array(buf, 0, rasterSize * rasterSize);

        //Pre-compute EXPANDED building bboxes for the cell mask.
        //Each MapTiler footprint is inflated by BUILDING_MASK_PAD_M on
        //all four sides. The vector-tile geometry is often a few metres
        //smaller than the actual building (walls, eaves, attached
        //sheds), and a LiDAR cell sitting right on a wall or just past
        //a missing detail comes back as a 5-20 m "vegetation" cell.
        //The padding catches those cells. We drop the polygon-interior
        //test on purpose: a bbox-only check filters slightly too much
        //in concave corners, but the trade-off favours fewer phantom
        //buildings appearing as a green block next to the home.
        const buildings = opts.buildingFootprints?.features ?? [];
        const padDegLat = BUILDING_MASK_PAD_M / M_PER_DEG_LAT;
        const padDegLon = BUILDING_MASK_PAD_M
                        / (M_PER_DEG_LAT * Math.cos(opts.homeLat * Math.PI / 180));
        const bboxes: Array<{ minLon: number; minLat: number; maxLon: number; maxLat: number }> = [];
        for (const b of buildings)
        {
            if (!b.geometry) continue;
            const bb = polygonBBox(b.geometry);
            if (bb)
            {
                bboxes.push({
                    minLon: bb.minLon - padDegLon,
                    minLat: bb.minLat - padDegLat,
                    maxLon: bb.maxLon + padDegLon,
                    maxLat: bb.maxLat + padDegLat
                });
            }
        }

        const pxLon = (maxLon - minLon) / rasterSize;
        const pxLat = (maxLat - minLat) / rasterSize;
        //Hexagonal cells instead of square ones. Each pixel becomes a
        //6-vertex regular hexagon scaled to ~85 % of the pixel size,
        //which leaves a small gap between neighbours and breaks the
        //"flat slab" impression of adjacent equal-height cells. The
        //radius is computed independently in lon and lat degrees so
        //the hex is regular in metres, not in degree space.
        const hexFactor = 0.85;
        const rLon = (pxLon / 2) * hexFactor;
        const rLat = (pxLat / 2) * hexFactor;
        //Precompute the 6 unit-vector offsets for the hexagon vertices.
        //Pointy-top orientation: starts at the top, rotates CCW.
        const HEX_OFFSETS: Array<[number, number]> = [
            [ 0.0,   1.0  ],
            [-0.866, 0.5  ],
            [-0.866, -0.5 ],
            [ 0.0,   -1.0 ],
            [ 0.866, -0.5 ],
            [ 0.866, 0.5  ]
        ];

        //Optional circular crop. When set, cells whose centre is more
        //than `cropRadiusMeters` from the home are dropped, so the
        //rendered vegetation disc matches the buildings disc.
        const cropM = opts.cropRadiusMeters && opts.cropRadiusMeters > 0
            ? opts.cropRadiusMeters
            : null;

        //One Polygon Feature per LiDAR cell at the cell's actual
        //height, with a deterministic per-cell jitter in the height
        //(85-115 %) so adjacent trees in a forest break their plateau
        //and look more like individual crowns than a single block.
        //Hash is i * 73856093 XOR j * 19349663, classic spatial-hash
        //primes, fold to [0, 1).
        //
        //Row j = 0 is the NORTH edge of the bbox in WMS image
        //convention (top-down). Latitude decreases as j grows.
        const out: GeoJSON.Feature[] = [];
        let hMin = Infinity, hMax = -Infinity, kept = 0;

        for (let j = 0; j < rasterSize; j++)
        {
            const cLat = maxLat - (j + 0.5) * pxLat;
            for (let i = 0; i < rasterSize; i++)
            {
                const h = heights[j * rasterSize + i];
                if (!isFinite(h) || h < HEIGHT_THRESH_M || h > HEIGHT_MAX_M) continue;

                const cLon = minLon + (i + 0.5) * pxLon;
                if (cellInsideAnyBBox(cLon, cLat, bboxes)) continue;

                if (cropM !== null
                    && haversineMeters(opts.homeLat, opts.homeLon, cLat, cLon) > cropM)
                {
                    continue;
                }

                //Per-cell height jitter, deterministic from (i, j).
                let hash = ((i * 73856093) ^ (j * 19349663)) >>> 0;
                hash = (hash * 668265263) >>> 0;
                const jitter = 0.85 + (hash / 4294967296) * 0.30;
                const adjHeight = h * jitter;

                //Build the hex ring around (cLon, cLat).
                const ring: number[][] = new Array(7);
                for (let k = 0; k < 6; k++)
                {
                    const o = HEX_OFFSETS[k];
                    ring[k] = [cLon + o[0] * rLon, cLat + o[1] * rLat];
                }
                ring[6] = ring[0];

                out.push({
                    type:     'Feature',
                    geometry: { type: 'Polygon', coordinates: [ring] },
                    properties:
                    {
                        render_height:     adjHeight,
                        render_min_height: 0
                    }
                });

                kept++;
                if (h < hMin) hMin = h;
                if (h > hMax) hMax = h;
            }
        }

        //One-shot diagnostic, cheap, runs once per fetch.
        if (kept > 0)
        {
            console.info(
                `[HELIOS] LiDAR vegetation: ${kept} cells emitted, ` +
                `height range [${hMin.toFixed(1)}, ${hMax.toFixed(1)}] m`
            );
        }
        else
        {
            console.info('[HELIOS] LiDAR vegetation: no cells passed the threshold');
        }

        return { type: 'FeatureCollection', features: out };
    }
};

//----------------------------------------------------------------- helpers

const EARTH_RADIUS_M = 6_371_008.8;

//Great-circle distance in metres, used for the circular vegetation
//crop. The cells we test are at most a couple of hundred metres from
//the home so a flat-earth approximation would also work, but the
//classic haversine is cheap and unambiguous.
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

function polygonBBox(geom: GeoJSON.Geometry): { minLon: number; minLat: number; maxLon: number; maxLat: number } | null
{
    let rings: number[][][] | null = null;
    if (geom.type === 'Polygon')
    {
        rings = geom.coordinates as number[][][];
    }
    else if (geom.type === 'MultiPolygon')
    {
        //Flatten to the outer rings only; multi-polygon parts are
        //adjacent in our pipeline so the union bbox is tight enough.
        const all: number[][][] = [];
        for (const poly of geom.coordinates as number[][][][])
        {
            if (poly.length) all.push(poly[0] as number[][]);
        }
        rings = all;
    }
    if (!rings || rings.length === 0) return null;

    let minLon =  Infinity, minLat =  Infinity;
    let maxLon = -Infinity, maxLat = -Infinity;
    for (const ring of rings)
    {
        for (const [lon, lat] of ring)
        {
            if (lon < minLon) minLon = lon;
            if (lat < minLat) minLat = lat;
            if (lon > maxLon) maxLon = lon;
            if (lat > maxLat) maxLat = lat;
        }
    }
    return { minLon, minLat, maxLon, maxLat };
}

//Bbox-only mask test. The bboxes passed in are already inflated by
//BUILDING_MASK_PAD_M on every side, so any cell whose centre lands
//inside an inflated bbox is treated as a building cell and dropped.
//Slightly over-filters in concave corners of L-shaped footprints,
//which is the right trade-off here: we'd rather miss a few real
//vegetation cells than render a phantom green block next to the
//home because MapTiler's footprint stopped a metre before the wall.
function cellInsideAnyBBox(
    lon: number, lat: number,
    bboxes: Array<{ minLon: number; minLat: number; maxLon: number; maxLat: number }>
): boolean
{
    for (const b of bboxes)
    {
        if (lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat)
        {
            return true;
        }
    }
    return false;
}
