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

import type {
    LidarSource,
    LidarFetchOptions,
    LidarFetchResult,
    LidarTerrainData
} from '../helios-lidar';
import { convexHull } from '../helios-shadows';

const WMS_URL    = 'https://data.geopf.fr/wms-r';
//IGN reprojects the native LAMB-93 product to WGS84G server-side so
//we can stay in lon/lat and avoid a coordinate transform.
//
//  MNH (Modele Numerique de Hauteur), height above local ground;
//       drives the shadow projector and the point-cloud overlay.
//  MNT (Modele Numerique de Terrain), bare-earth ground elevation;
//       drives the custom DEM source that replaces MapTiler terrain
//       in the home area when LiDAR mode is on.
const LAYER_MNH  = 'IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G';
const LAYER_MNT  = 'IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G';

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

    async fetch(opts: LidarFetchOptions): Promise<LidarFetchResult>
    {
        const empty: LidarFetchResult = {
            regions: { type: 'FeatureCollection', features: [] },
            cells:   { type: 'FeatureCollection', features: [] },
            terrain: null,
            terrainCellHalfM: 1.0
        };

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

        //Both layers share the same bbox + raster size; the MNT call
        //runs in parallel so the LiDAR pipeline pays one network RTT
        //rather than two.
        const [heights, mntHeights] = await Promise.all([
            fetchBilLayer(LAYER_MNH, minLat, minLon, maxLat, maxLon, rasterSize, opts.signal),
            fetchBilLayer(LAYER_MNT, minLat, minLon, maxLat, maxLon, rasterSize, opts.signal)
        ]);

        if (!heights) return empty;

        const terrain: LidarTerrainData | null = mntHeights
            ? {
                heights: mntHeights,
                width:   rasterSize,
                height:  rasterSize,
                bounds:  { minLon, minLat, maxLon, maxLat }
              }
            : null;

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
        const regionsOut: GeoJSON.Feature[] = [];
        const keptLabels = new Uint8Array(nextLabel + 1);
        let dropped = 0;
        for (let li = 0; li < components.length; li++)
        {
            const comp = components[li];
            if (comp.cells.length < MIN_REGION_CELLS) { dropped++; continue; }
            keptLabels[li + 1] = 1;

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

            regionsOut.push({
                type:       'Feature',
                geometry:   { type: 'Polygon', coordinates: [hull] },
                properties:
                {
                    render_height:     comp.heightSum / comp.cells.length,
                    render_min_height: 0
                }
            });
        }

        //Pass 4, emit per-cell Points for the optional point-cloud
        //overlay. Three kinds of cells are emitted:
        //
        //  - 'home' / 'building' / 'vegetation': cells that passed
        //    the MNH height threshold AND belong to a kept region
        //    (i.e. cells that are part of an actual building or
        //    vegetation cluster cast as a shadow).
        //
        //  - 'terrain': bare-earth cells (cells whose MNH did NOT
        //    pass the threshold), subsampled so the irradiance
        //    scanner can cover the whole bbox with a reasonable
        //    point count. Density is tuned so the on-card view stays
        //    readable: ~10 k cells regardless of the raster size.
        //
        //Each Point carries (height, kind). The engine reads height
        //as "metres above the local terrain" so the scanner planes
        //all sit on the LiDAR-derived ground surface; for terrain
        //cells height is 0 (a dot on the ground).
        const KIND_NAMES = ['', 'home', 'building', 'vegetation'];
        const cellsOut: GeoJSON.Feature[] = [];
        for (let idx = 0; idx < N; idx++)
        {
            const lab = labels[idx];
            if (!lab || !keptLabels[lab]) continue;
            const k = kindArr[idx];
            if (!k) continue;
            const x = idx % rasterSize;
            const y = (idx / rasterSize) | 0;
            const cLon = minLon + (x + 0.5) * pxLon;
            const cLat = maxLat - (y + 0.5) * pxLat;
            cellsOut.push({
                type:       'Feature',
                geometry:   { type: 'Point', coordinates: [cLon, cLat] },
                properties: { height: hOk[idx], kind: KIND_NAMES[k] }
            });
        }

        //Terrain subsample. We aim for ~96 cells per side regardless
        //of the raster size so the count of emitted terrain points
        //stays around 10 k whatever the precision setting. Cells that
        //already produced a non-terrain point (passed the threshold)
        //are skipped to avoid double-counting.
        const TARGET_PER_SIDE = 96;
        const stride = Math.max(1, Math.floor(rasterSize / TARGET_PER_SIDE));
        let nTerrain = 0;
        for (let j = (stride >> 1); j < rasterSize; j += stride)
        {
            for (let i = (stride >> 1); i < rasterSize; i += stride)
            {
                const idx = j * rasterSize + i;
                if (kindArr[idx]) continue;
                const cLon = minLon + (i + 0.5) * pxLon;
                const cLat = maxLat - (j + 0.5) * pxLat;
                //Inherit the circular crop the per-cell pass enforced,
                //the bbox is square-padded so the corner cells live
                //outside the visible disc and would just smear into
                //the basemap.
                if (cropM !== null
                    && haversineMeters(opts.homeLat, opts.homeLon, cLat, cLon) > cropM)
                {
                    continue;
                }
                cellsOut.push({
                    type:       'Feature',
                    geometry:   { type: 'Point', coordinates: [cLon, cLat] },
                    properties: { height: 0, kind: 'terrain' }
                });
                nTerrain++;
            }
        }

        const totalKept = nHome + nBldg + nVeg;
        if (totalKept > 0)
        {
            console.info(
                `[HELIOS] LiDAR: ${nHome} home + ${nBldg} building + ${nVeg} vegetation cells + ${nTerrain} terrain -> ` +
                `${regionsOut.length} regions (${dropped} dropped < ${MIN_REGION_CELLS} cells), ` +
                `${cellsOut.length} points, ` +
                `height range [${hMin.toFixed(1)}, ${hMax.toFixed(1)}] m` +
                (terrain ? `, MNT raster ${rasterSize}x${rasterSize}` : ', no MNT')
            );
        }
        else
        {
            console.info(`[HELIOS] LiDAR: no MNH cells passed the threshold (${nTerrain} terrain points)`);
        }

        //Half-pitch of the terrain grid, in metres. Spacing in degrees
        //is `pxLon * stride` (for longitude) / `pxLat * stride` (for
        //latitude); we convert via the local metres-per-degree factor
        //so the engine can size flat ground tiles to the LiDAR grid.
        const M_PER_DEG_LON_LOCAL = M_PER_DEG_LAT * Math.cos(opts.homeLat * Math.PI / 180);
        const halfM = 0.5 * Math.min(
            pxLat * stride * M_PER_DEG_LAT,
            pxLon * stride * M_PER_DEG_LON_LOCAL
        );

        return {
            regions: { type: 'FeatureCollection', features: regionsOut },
            cells:   { type: 'FeatureCollection', features: cellsOut },
            terrain,
            terrainCellHalfM: halfM
        };
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

//Single WMS GetMap call for one IGN elevation layer at the given
//bbox + raster size. Returns null on any network / decode failure;
//the caller then either bails (MNH required) or falls back to the
//global terrain (MNT optional). The same response can be a small
//ServiceException XML when the layer name drifts, hence the strict
//byte-length check before reading the buffer as Float32.
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

    const expectedBytes = rasterSize * rasterSize * 4;
    if (buf.byteLength < expectedBytes) return null;

    return new Float32Array(buf, 0, rasterSize * rasterSize);
}
