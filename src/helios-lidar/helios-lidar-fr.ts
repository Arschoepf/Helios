//IGN LiDAR HD shadow source for metropolitan France + Corsica.
//
//Pipeline:
//  1. WMS GetMap on the IGN MNH layer (heights above terrain) in raw
//     little-endian float32 (image/x-bil;bits=32). One request per
//     (home, radius, raster) tuple, the engine caches the result.
//  2. Each pixel is classified against the MapTiler home + surrounding
//     footprints into one of three kinds (home / building / vegetation).
//  3. 8-connected flood fill within each kind groups adjacent cells
//     into regions; each region collapses to one Polygon (convex hull
//     of its cell corners) with average height. The polygon is NEVER
//     rendered; only its projected ground shadow is.
//
//Coverage stops at metropolitan France + Corsica (the LiDAR HD survey
//is still rolling out for DOM-TOM as of 2026); we bail before the API
//call when the home falls outside that bbox.
//
//Reference: https://geoservices.ign.fr/lidarhd

import type { LidarSource, LidarFetchOptions } from '../helios-lidar';
import { convexHull } from '../helios-shadows';

const WMS_URL    = 'https://data.geopf.fr/wms-r';
//IGN reprojects the native LAMB-93 product to WGS84G server-side so
//we can stay in lon/lat and avoid a coordinate transform.
const LAYER_MNH  = 'IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G';

//Bounding box of metropolitan France + Corsica, padded by ~0.3 deg
//so coastal homes still trigger a fetch.
const FR_BBOX = { minLat: 41.0, maxLat: 51.5, minLon: -5.5, maxLon: 9.8 };

const M_PER_DEG_LAT = 111_320;

//Fetch parameters. raster size is caller-driven (LidarFetchOptions);
//the rest stays here.
const HEIGHT_THRESH_M     = 5;     // skip grass / waist-height noise
const HEIGHT_MAX_M        = 100;   // anything taller is treated as garbage
const BBOX_PAD_FACTOR     = 1.15;  // over-fetch so edge cells still cast inward
const BUILDING_MASK_PAD_M = 5;     // outward inflation of MapTiler footprints
//Connected components below this cell count are dropped: a single 5 m
//pixel is more often LiDAR noise (a parked car, a survey artefact)
//than a real shadow caster.
const MIN_REGION_CELLS    = 3;

interface InflatedBBox
{
    minLon: number; minLat: number;
    maxLon: number; maxLat: number;
}

export const franceLidarHd: LidarSource =
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

        //WMS 1.3.0 with EPSG:4326 wants axis order (lat, lon).
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

        //MapTiler footprints inflated by BUILDING_MASK_PAD_M on every
        //side. Bbox-only test downstream (no polygon-interior step):
        //slightly over-classifies in concave corners but yields a
        //cleaner home / building / vegetation boundary in practice.
        const padDegLat = BUILDING_MASK_PAD_M / M_PER_DEG_LAT;
        const padDegLon = BUILDING_MASK_PAD_M
                        / (M_PER_DEG_LAT * Math.cos(opts.homeLat * Math.PI / 180));
        const inflate = (geom: GeoJSON.Geometry): InflatedBBox | null =>
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
        const homeBboxes: InflatedBBox[] = [];
        for (const f of opts.homeFootprints?.features ?? [])
        {
            if (!f.geometry) continue;
            const bb = inflate(f.geometry);
            if (bb) homeBboxes.push(bb);
        }
        const surrBboxes: InflatedBBox[] = [];
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

        //Optional circular crop around the home, in metres.
        const cropM = opts.cropRadiusMeters && opts.cropRadiusMeters > 0
            ? opts.cropRadiusMeters
            : null;

        //Pass 1, classify. Row j = 0 is the NORTH edge of the bbox in
        //WMS image convention (top-down).
        const N       = rasterSize * rasterSize;
        const kindArr = new Uint8Array(N);   // 0 none | 1 home | 2 building | 3 vegetation
        const hOk     = new Float32Array(N);
        let hMin = Infinity, hMax = -Infinity;
        let nHome = 0, nBldg = 0, nVeg = 0;

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

                //Home wins over surrounding when bboxes overlap.
                let k = 3;
                if      (cellInsideAnyBBox(cLon, cLat, homeBboxes)) k = 1;
                else if (cellInsideAnyBBox(cLon, cLat, surrBboxes)) k = 2;

                kindArr[idx] = k;
                hOk[idx]     = h;
                if      (k === 1) nHome++;
                else if (k === 2) nBldg++;
                else              nVeg++;
                if (h < hMin) hMin = h;
                if (h > hMax) hMax = h;
            }
        }

        //Pass 2, 8-connected flood fill within each kind, so a tree
        //next to a building stays a separate region.
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

        //Pass 3, one Polygon per region. Convex hull of cell corners
        //(slight over-approximation for L-shapes is invisible since
        //the polygon itself is never rendered, only its shadow).
        const out: GeoJSON.Feature[] = [];
        let dropped = 0;
        for (const comp of components)
        {
            if (comp.cells.length < MIN_REGION_CELLS) { dropped++; continue; }

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

            out.push({
                type:       'Feature',
                geometry:   { type: 'Polygon', coordinates: [hull] },
                properties:
                {
                    render_height:     comp.heightSum / comp.cells.length,
                    render_min_height: 0
                }
            });
        }

        const totalKept = nHome + nBldg + nVeg;
        if (totalKept > 0)
        {
            console.info(
                `[HELIOS] LiDAR shadows: ${nHome} home + ${nBldg} building + ${nVeg} vegetation cells -> ` +
                `${out.length} regions (${dropped} dropped < ${MIN_REGION_CELLS} cells), ` +
                `height range [${hMin.toFixed(1)}, ${hMax.toFixed(1)}] m`
            );
        }
        else
        {
            console.info('[HELIOS] LiDAR shadows: no cells passed the threshold');
        }

        return { type: 'FeatureCollection', features: out };
    }
};

//----------------------------------------------------------------- helpers

const EARTH_RADIUS_M = 6_371_008.8;

//Great-circle distance in metres. Cells are at most a few hundred
//metres from the home so a flat-earth approximation would also do,
//but the classic haversine is cheap and unambiguous.
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

function polygonBBox(geom: GeoJSON.Geometry): InflatedBBox | null
{
    let rings: number[][][] | null = null;
    if (geom.type === 'Polygon')
    {
        rings = geom.coordinates as number[][][];
    }
    else if (geom.type === 'MultiPolygon')
    {
        //Flatten to outer rings only; multi-polygon parts are adjacent
        //in our pipeline so the union bbox is tight enough.
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

//Bbox-only mask test against a list of pre-inflated rectangles.
function cellInsideAnyBBox(lon: number, lat: number, bboxes: InflatedBBox[]): boolean
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
