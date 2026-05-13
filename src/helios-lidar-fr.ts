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

import type { LidarVegetationSource, LidarFetchOptions } from './helios-lidar';
import { convexHull } from './helios-shadows';

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
//network footprint:
//  RASTER_SIZE     - pixels per side; 128 = 64 KB float32 per request
//  HEIGHT_THRESH_M - keep cells at or above this height (skip grass)
//  HEIGHT_MAX_M    - sanity clamp; anything above (giant sequoias top
//                    out at 95 m) is treated as a garbage value
//  BBOX_PAD_FACTOR - over-fetch slightly so trees on the edge of the
//                    visible radius still cast their shadow inward
const RASTER_SIZE     = 128;
const HEIGHT_THRESH_M = 3;
const HEIGHT_MAX_M    = 100;
const BBOX_PAD_FACTOR = 1.15;

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
            WIDTH:   String(RASTER_SIZE),
            HEIGHT:  String(RASTER_SIZE),
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
        const expectedBytes = RASTER_SIZE * RASTER_SIZE * 4;
        if (buf.byteLength < expectedBytes)
        {
            return empty;
        }

        const heights = new Float32Array(buf, 0, RASTER_SIZE * RASTER_SIZE);

        //Pre-compute building bboxes for the cell-vs-building mask.
        //Naive O(cells x buildings) point-in-polygon would still be
        //fast enough here (16k cells, a few hundred buildings), but
        //the bbox prefilter cuts most of the work to a few comparisons
        //per cell.
        const buildings = opts.buildingFootprints?.features ?? [];
        const bboxes: Array<{ minLon: number; minLat: number; maxLon: number; maxLat: number; geom: GeoJSON.Geometry }> = [];
        for (const b of buildings)
        {
            if (!b.geometry) continue;
            const bb = polygonBBox(b.geometry);
            if (bb) bboxes.push({ ...bb, geom: b.geometry });
        }

        const pxLon = (maxLon - minLon) / RASTER_SIZE;
        const pxLat = (maxLat - minLat) / RASTER_SIZE;
        const halfLon = pxLon / 2;
        const halfLat = pxLat / 2;

        //Pass 1: build a binary vegetation mask. A cell qualifies
        //when its height is in [HEIGHT_THRESH_M, HEIGHT_MAX_M] AND
        //its centre is not inside any known building footprint.
        //Heights are kept in a parallel float array so we can
        //average them per region in pass 3.
        //
        //Row j = 0 is the NORTH edge of the bbox in WMS image
        //convention (top-down). Latitude decreases as j grows.
        const N    = RASTER_SIZE * RASTER_SIZE;
        const mask = new Uint8Array(N);
        const hOk  = new Float32Array(N);
        let hMin = Infinity, hMax = -Infinity, kept = 0;

        for (let j = 0; j < RASTER_SIZE; j++)
        {
            const cLat = maxLat - (j + 0.5) * pxLat;
            for (let i = 0; i < RASTER_SIZE; i++)
            {
                const idx = j * RASTER_SIZE + i;
                const h   = heights[idx];
                if (!isFinite(h) || h < HEIGHT_THRESH_M || h > HEIGHT_MAX_M) continue;

                const cLon = minLon + (i + 0.5) * pxLon;
                if (cellInsideAnyBuilding(cLon, cLat, bboxes)) continue;

                mask[idx] = 1;
                hOk[idx]  = h;
                kept++;
                if (h < hMin) hMin = h;
                if (h > hMax) hMax = h;
            }
        }

        //Pass 2: 8-connected flood fill to identify contiguous
        //vegetation regions. Each region becomes ONE shadow polygon
        //downstream, so what used to be thousands of overlapping
        //per-cell shadows in a forest collapses into a single
        //region polygon, no visual stacking.
        const labels = new Int32Array(N);
        const stack: number[] = [];
        const components: Array<{ cells: number[]; heightSum: number }> = [];
        let nextLabel = 0;

        for (let seed = 0; seed < N; seed++)
        {
            if (!mask[seed] || labels[seed]) continue;

            nextLabel++;
            const cells: number[] = [];
            let heightSum = 0;
            stack.length = 0;
            stack.push(seed);

            while (stack.length)
            {
                const idx = stack.pop()!;
                if (labels[idx] || !mask[idx]) continue;
                labels[idx] = nextLabel;
                cells.push(idx);
                heightSum += hOk[idx];

                const x = idx % RASTER_SIZE;
                const y = (idx / RASTER_SIZE) | 0;
                for (let dy = -1; dy <= 1; dy++)
                {
                    for (let dx = -1; dx <= 1; dx++)
                    {
                        if (dx === 0 && dy === 0) continue;
                        const nx = x + dx, ny = y + dy;
                        if (nx < 0 || nx >= RASTER_SIZE || ny < 0 || ny >= RASTER_SIZE) continue;
                        const nIdx = ny * RASTER_SIZE + nx;
                        if (mask[nIdx] && !labels[nIdx]) stack.push(nIdx);
                    }
                }
            }
            components.push({ cells, heightSum });
        }

        //Pass 3: turn each component into a single Polygon feature.
        //We collect all four corners of every cell in the component
        //and take their convex hull. For non-convex regions (an L or
        //a horseshoe) the hull over-approximates slightly, but the
        //shadow is dark and the over-coverage is hidden by the body
        //of the region itself; the visual gain over per-cell stacking
        //is enormous and the cost is roughly O(M log M) per region.
        //Height fed to the shadow projector is the average of the
        //region's cells: a sensible mid-point between "tallest tree
        //dominates" (max) and "lots of waist-height noise lowers the
        //shadow" (min).
        const out: GeoJSON.Feature[] = [];
        for (const comp of components)
        {
            const corners: Array<[number, number]> = [];
            for (const idx of comp.cells)
            {
                const x = idx % RASTER_SIZE;
                const y = (idx / RASTER_SIZE) | 0;
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

            const avgHeight = comp.heightSum / comp.cells.length;
            out.push({
                type:       'Feature',
                geometry:   { type: 'Polygon', coordinates: [hull] },
                properties:
                {
                    render_height:     avgHeight,
                    render_min_height: 0
                }
            });
        }

        //One-shot diagnostic so we can confirm sane inputs in the
        //browser console without sprinkling logs through the engine.
        //Cheap (one console call per fetch, fetches happen once per
        //home / radius change).
        if (kept > 0)
        {
            console.info(
                `[HELIOS] LiDAR vegetation: ${kept} cells kept, ` +
                `${components.length} regions, ` +
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

//Bbox prefilter then ray-cast. Returns true as soon as one
//building polygon contains the cell centre.
function cellInsideAnyBuilding(
    lon: number, lat: number,
    bboxes: Array<{ minLon: number; minLat: number; maxLon: number; maxLat: number; geom: GeoJSON.Geometry }>
): boolean
{
    for (const b of bboxes)
    {
        if (lon < b.minLon || lon > b.maxLon || lat < b.minLat || lat > b.maxLat) continue;
        if (pointInGeometry(lon, lat, b.geom)) return true;
    }
    return false;
}

function pointInGeometry(lon: number, lat: number, geom: GeoJSON.Geometry): boolean
{
    if (geom.type === 'Polygon')
    {
        const rings = geom.coordinates as number[][][];
        return rings.length > 0 && pointInRing(lon, lat, rings[0]);
    }
    if (geom.type === 'MultiPolygon')
    {
        for (const poly of geom.coordinates as number[][][][])
        {
            if (poly.length > 0 && pointInRing(lon, lat, poly[0])) return true;
        }
    }
    return false;
}

function pointInRing(lon: number, lat: number, ring: number[][]): boolean
{
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const intersect = ((yi > lat) !== (yj > lat))
                       && (lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}
