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
//Consolidation pipeline:
//
//  1. Classify cells. Cells above the height threshold pass; the
//     rest (grass, bare ground, noise) are dropped. Optional circular
//     crop keeps the output inside the visible disc.
//  2. Flood-fill with a size cap. 8-connected BFS, but a component
//     stops growing once it reaches TARGET_COMPONENT_AREA_M2 / cell
//     area cells. The remaining seeds are picked up by the outer scan
//     loop and start fresh components. A dense forest therefore
//     breaks into many small clumps instead of one giant blob.
//  3. Convex hull per clump. Organic, non-axis-aligned polygons that
//     alpha-composite into a dappled shadow pattern when projected,
//     instead of looking like a grid-aligned tile texture.

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
//  HEIGHT_THRESH_M            , keep cells at or above this height
//                               (skip grass and bare ground noise).
//  HEIGHT_MAX_M               , sanity clamp; anything above (giant
//                               sequoias top out at ~95 m) is treated
//                               as a garbage value.
//  BBOX_PAD_FACTOR            , over-fetch slightly so trees on the
//                               edge of the visible radius still cast
//                               their shadow inward.
//  TARGET_COMPONENT_AREA_M2   , physical target area of one flood-fill
//                               component. The cell cap is derived
//                               from this and the actual pixel pitch
//                               so component size is consistent across
//                               precisions. ~80 m² maps to a roughly
//                               9 m × 9 m clump, the size of a small
//                               tree group or a single building, which
//                               keeps each cast shadow distinguishable
//                               and avoids the giant-blanket effect.
//  MIN_COMPONENT_CELLS        , floor on cells per component before
//                               we bother emitting a polygon. Drops
//                               single-cell noise that would render
//                               as speckled dot shadows.
const HEIGHT_THRESH_M          = 5;
const HEIGHT_MAX_M             = 100;
const BBOX_PAD_FACTOR          = 1.15;
const TARGET_COMPONENT_AREA_M2 = 80;
const MIN_COMPONENT_CELLS      = 3;

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

        const pxLon   = (maxLon - minLon) / rasterSize;
        const pxLat   = (maxLat - minLat) / rasterSize;
        const halfLon = pxLon / 2;
        const halfLat = pxLat / 2;
        const pxLatM  = pxLat * M_PER_DEG_LAT;
        const cellAreaM2 = pxLatM * pxLatM;

        //Component cell cap. Derived from TARGET_COMPONENT_AREA_M2 so
        //components stay at roughly the same physical size whatever
        //the chosen precision. Clamped to a sane range so a very low
        //precision still produces multi-cell components and a very
        //high precision doesn't cap so loosely that one component can
        //swallow a whole forest again.
        const maxCellsPerComponent = Math.max(4, Math.min(400,
            Math.round(TARGET_COMPONENT_AREA_M2 / cellAreaM2)));

        const cropM = opts.cropRadiusMeters && opts.cropRadiusMeters > 0
            ? opts.cropRadiusMeters
            : null;

        //Pass 1: identify valid cells (above threshold + inside crop).
        //Row j = 0 is the NORTH edge of the bbox (WMS image convention,
        //top-down); latitude decreases as j grows.
        const N        = rasterSize * rasterSize;
        const validArr = new Uint8Array(N);
        const hOk      = new Float32Array(N);
        let keptCells  = 0;
        let hMin = Infinity, hMax = -Infinity;

        for (let j = 0; j < rasterSize; j++)
        {
            const cLat = maxLat - (j + 0.5) * pxLat;
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

                validArr[idx] = 1;
                hOk[idx]      = h;
                keptCells++;
                if (h < hMin) hMin = h;
                if (h > hMax) hMax = h;
            }
        }

        //Pass 2: size-capped 8-connected flood fill. Once a component
        //reaches maxCellsPerComponent cells, the BFS stops and the
        //next unvisited valid cell becomes the seed of a fresh
        //component. A dense forest therefore decomposes into many
        //small organic clumps rather than one giant convex hull.
        const labels = new Int32Array(N);
        const stack: number[] = [];
        const components: Array<{ cells: number[]; heightSum: number }> = [];
        let nextLabel = 0;

        for (let seed = 0; seed < N; seed++)
        {
            if (!validArr[seed] || labels[seed]) continue;

            nextLabel++;
            const cells: number[] = [];
            let heightSum = 0;
            stack.length = 0;
            stack.push(seed);

            while (stack.length && cells.length < maxCellsPerComponent)
            {
                const idx = stack.pop()!;
                if (labels[idx] || !validArr[idx]) continue;
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
                        if (!labels[nIdx] && validArr[nIdx]) stack.push(nIdx);
                    }
                }
            }

            if (cells.length >= MIN_COMPONENT_CELLS)
            {
                components.push({ cells, heightSum });
            }
        }

        //Pass 3: one convex-hull Polygon per component. We collect the
        //4 corners of every cell and take the hull, an irregular
        //(non-axis-aligned) polygon that breaks the grid alignment of
        //the underlying raster. Multiple capped hulls overlap inside a
        //dense forest, their projected shadows alpha-composite into a
        //continuous-but-dappled pattern.
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

        if (keptCells > 0)
        {
            console.info(
                `[HELIOS] LiDAR shadows: ${keptCells} cells -> ${out.length} clumps ` +
                `(cap ${maxCellsPerComponent} cells, ~${Math.sqrt(TARGET_COMPONENT_AREA_M2).toFixed(0)} m), ` +
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
