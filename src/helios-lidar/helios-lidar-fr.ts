//IGN LiDAR HD shadow source for metropolitan France + Corsica.
//
//IGN's Geoplateforme exposes the LiDAR HD survey through a standard
//OGC WMS-Raster endpoint at https://data.geopf.fr/wms-r. We fetch the
//MNH product ("Modele Numerique de Hauteur"): heights of objects
//above the bare terrain. A pixel of 8.5 means "something 8.5 m tall
//sits at this location", which lumps trees, hedges and buildings
//together. We then classify each cell against MapTiler footprints
//and consolidate connected cells of the same kind into one Polygon,
//ready to feed projectExtrusionShadows.
//
//The endpoint accepts FORMAT=image/x-bil;bits=32, which streams the
//raster as raw little-endian float32 height values, no header. With
//WIDTH=HEIGHT=512 a typical 200 m bbox costs ~1 MB on the wire and
//gives a sub-metre ground sample, more than enough for shadow shape.
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
import { convexHull } from '../helios-shadows';

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
//  HEIGHT_THRESH_M  , keep cells at or above this height (skip grass).
//  HEIGHT_MAX_M     , sanity clamp; anything above (giant sequoias
//                     top out at ~95 m) is treated as a garbage value.
//  BBOX_PAD_FACTOR  , over-fetch slightly so trees on the edge of the
//                     visible radius still cast their shadow inward.
//  BUILDING_MASK_PAD_M , outward inflation of each MapTiler building
//                     footprint when masking cells. MapTiler vector
//                     geometry is often a few metres smaller than the
//                     actual structure, the padding catches wall-cells
//                     and attached sheds that would otherwise leak
//                     through as "vegetation".
const HEIGHT_THRESH_M     = 5;
const HEIGHT_MAX_M        = 100;
const BBOX_PAD_FACTOR     = 1.15;
const BUILDING_MASK_PAD_M = 5;

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

        //Pre-compute inflated bboxes for the home AND surrounding
        //footprints separately so each LiDAR cell can be classified:
        //inside a home polygon -> kind='home', inside a surrounding
        //polygon -> kind='building', outside both -> kind='vegetation'.
        //Each footprint is inflated by BUILDING_MASK_PAD_M on every
        //side. Bbox-only test, no polygon-interior step: in L-shaped
        //corners this slightly over-classifies a few cells as
        //building, the right trade-off for a clean home / vegetation
        //boundary.
        const padDegLat = BUILDING_MASK_PAD_M / M_PER_DEG_LAT;
        const padDegLon = BUILDING_MASK_PAD_M
                        / (M_PER_DEG_LAT * Math.cos(opts.homeLat * Math.PI / 180));
        const inflate = (geom: GeoJSON.Geometry) =>
        {
            const bb = polygonBBox(geom);
            if (!bb) return null;
            return {
                minLon: bb.minLon - padDegLon,
                minLat: bb.minLat - padDegLat,
                maxLon: bb.maxLon + padDegLon,
                maxLat: bb.maxLat + padDegLat
            };
        };
        const homeBboxes: Array<{ minLon: number; minLat: number; maxLon: number; maxLat: number }> = [];
        for (const f of opts.homeFootprints?.features ?? [])
        {
            if (!f.geometry) continue;
            const bb = inflate(f.geometry);
            if (bb) homeBboxes.push(bb);
        }
        const surrBboxes: Array<{ minLon: number; minLat: number; maxLon: number; maxLat: number }> = [];
        for (const f of opts.surroundingFootprints?.features ?? [])
        {
            if (!f.geometry) continue;
            const bb = inflate(f.geometry);
            if (bb) surrBboxes.push(bb);
        }

        const pxLon   = (maxLon - minLon) / rasterSize;
        const pxLat   = (maxLat - minLat) / rasterSize;
        const halfLon = pxLon / 2;
        const halfLat = pxLat / 2;

        const cropM = opts.cropRadiusMeters && opts.cropRadiusMeters > 0
            ? opts.cropRadiusMeters
            : null;

        //Pass 1: classify every passing cell into one of three kinds
        //(home / building / vegetation) and stash its height. Two
        //parallel grids (kindArr + hOk) so the flood fill in pass 2
        //reads kind for connectivity and height for averaging.
        //
        //Row j = 0 is the NORTH edge of the bbox (WMS image convention,
        //top-down). Latitude decreases as j grows.
        const N        = rasterSize * rasterSize;
        const kindArr  = new Uint8Array(N);     // 0 = none, 1 = home, 2 = building, 3 = vegetation
        const hOk      = new Float32Array(N);
        let hMin = Infinity, hMax = -Infinity;
        let keptHome = 0, keptBldg = 0, keptVeg = 0;

        for (let j = 0; j < rasterSize; j++)
        {
            const cLat = maxLat - (j + 0.5) * pxLat;
            for (let i = 0; i < rasterSize; i++)
            {
                const idx = j * rasterSize + i;
                const h   = heights[idx];
                if (!isFinite(h) || h < HEIGHT_THRESH_M || h > HEIGHT_MAX_M) continue;

                const cLon = minLon + (i + 0.5) * pxLon;
                if (cropM !== null
                    && haversineMeters(opts.homeLat, opts.homeLon, cLat, cLon) > cropM)
                {
                    continue;
                }

                //Home wins over surrounding when the inflated bboxes
                //happen to overlap (rare but defensive).
                let k = 3;                                            // vegetation
                if (cellInsideAnyBBox(cLon, cLat, homeBboxes))      k = 1;
                else if (cellInsideAnyBBox(cLon, cLat, surrBboxes)) k = 2;

                kindArr[idx] = k;
                hOk[idx]     = h;
                if (k === 1)      keptHome++;
                else if (k === 2) keptBldg++;
                else              keptVeg++;
                if (h < hMin) hMin = h;
                if (h > hMax) hMax = h;
            }
        }

        //Pass 2: 8-connected flood fill, components stay within their
        //kind. A tree right next to a building stays in its own region
        //so the shadow it casts has the tree's geometry, not a blended
        //building+tree blob.
        const labels = new Int32Array(N);
        const stack: number[] = [];
        const components: Array<{ cells: number[]; heightSum: number }> = [];
        let nextLabel = 0;

        for (let seed = 0; seed < N; seed++)
        {
            const ks = kindArr[seed];
            if (ks === 0 || labels[seed]) continue;

            nextLabel++;
            const cells: number[] = [];
            let heightSum = 0;
            stack.length = 0;
            stack.push(seed);

            while (stack.length)
            {
                const idx = stack.pop()!;
                if (labels[idx] || kindArr[idx] !== ks) continue;
                labels[idx] = nextLabel;
                cells.push(idx);
                heightSum += hOk[idx];

                const x = idx % rasterSize;
                const y = (idx / rasterSize) | 0;
                for (let dy = -1; dy <= 1; dy++)
                {
                    for (let dx = -1; dx <= 1; dx++)
                    {
                        if (dx === 0 && dy === 0) continue;
                        const nx = x + dx, ny = y + dy;
                        if (nx < 0 || nx >= rasterSize || ny < 0 || ny >= rasterSize) continue;
                        const nIdx = ny * rasterSize + nx;
                        if (!labels[nIdx] && kindArr[nIdx] === ks) stack.push(nIdx);
                    }
                }
            }
            components.push({ cells, heightSum });
        }

        //Pass 3: one Polygon per region. We collect the 4 corners of
        //every cell in the region and take the convex hull; that
        //slightly over-approximates non-convex shapes (an L or a
        //horseshoe gets convexified) but the polygon is never
        //rendered visibly, only its projected shadow shows up, and a
        //small extra coverage at the shadow edge is invisible under
        //the home or behind the tree line. Height fed to the shadow
        //projector is the region average.
        const out: GeoJSON.Feature[] = [];
        for (const comp of components)
        {
            const corners: Array<[number, number]> = [];
            for (const idx of comp.cells)
            {
                const x = idx % rasterSize;
                const y = (idx / rasterSize) | 0;
                const cLon = minLon + (x + 0.5) * pxLon;
                const cLat = maxLat - (y + 0.5) * pxLat;
                corners.push([cLon - halfLon, cLat - halfLat]);
                corners.push([cLon + halfLon, cLat - halfLat]);
                corners.push([cLon + halfLon, cLat + halfLat]);
                corners.push([cLon - halfLon, cLat + halfLat]);
            }
            const hull = convexHull(corners);
            if (hull.length < 3) continue;
            hull.push([hull[0][0], hull[0][1]]);

            const avg = comp.heightSum / comp.cells.length;
            out.push({
                type:       'Feature',
                geometry:   { type: 'Polygon', coordinates: [hull] },
                properties:
                {
                    render_height:     avg,
                    render_min_height: 0
                }
            });
        }

        const totalKept = keptHome + keptBldg + keptVeg;
        if (totalKept > 0)
        {
            console.info(
                `[HELIOS] LiDAR shadows: ${keptHome} home + ${keptBldg} building + ${keptVeg} vegetation cells -> ` +
                `${components.length} regions, height range [${hMin.toFixed(1)}, ${hMax.toFixed(1)}] m`
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

//Great-circle distance in metres, used for the circular vegetation
//crop. The cells we test are at most a couple of hundred metres from
//the home so a flat-earth approximation would also work, but haversine
//is cheap and unambiguous.
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

//Bbox-only mask test. Each bbox passed in is already inflated, so any
//cell whose centre lands inside is treated as belonging to that kind.
//Slightly over-filters in concave corners of L-shaped footprints,
//which is the right trade-off here: we'd rather miss a few real
//vegetation cells than render a phantom green block next to the home
//because MapTiler's footprint stopped a metre before the wall.
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
