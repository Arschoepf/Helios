//Shared post-processing pipeline for every LiDAR provider.
//
//Inputs: a Float32Array of "height above ground in metres" per cell,
//laid out row-major, north edge first (image-y convention), plus the
//geographic bbox of the raster and the home anchor.
//
//Outputs: a FeatureCollection of Polygon features, each carrying a
//render_height property (mean cell height of the clump). The features
//feed projectExtrusionShadows() exactly like the MapTiler footprints
//do when LiDAR is unavailable.
//
//Providers differ only in HOW they get the height-above-ground values
//(IGN serves it as a single nDSM raster; UK/NL/NO have to fetch DSM
//and DTM separately and subtract; ES merges two normalised layers).
//Once the heights are ready, the consolidation logic is identical, so
//keeping it in one place avoids drift between providers.

import { convexHull } from '../helios-shadows';
import type { LidarShadowResult } from '../helios-lidar';

//Tuning constants. Same defaults as the legacy FR-only implementation:
//
//  HEIGHT_THRESH_M            , keep cells at or above this height
//                               (skip grass and bare-ground noise).
//  HEIGHT_MAX_M               , sanity clamp; above this is treated as
//                               garbage (giant sequoias top out ~95 m).
//  TARGET_COMPONENT_AREA_M2   , physical target area of one flood-fill
//                               component, the cell cap is derived from
//                               this and the actual pixel pitch so
//                               component size stays consistent across
//                               precisions. ~80 m² is a 9 m × 9 m clump,
//                               the size of a small tree group or a
//                               single building, dense enough to cast a
//                               readable shadow without flattening a
//                               whole forest into one blob.
//  MIN_COMPONENT_CELLS        , floor on cells per component before we
//                               bother emitting a polygon. Drops single-
//                               cell noise that would render as speckled
//                               dot shadows.
const DEFAULT_HEIGHT_THRESH_M    = 5;
const DEFAULT_HEIGHT_MAX_M       = 100;
const DEFAULT_TARGET_AREA_M2     = 80;
const DEFAULT_MIN_COMPONENT_CELLS = 3;

const M_PER_DEG_LAT = 111_320;
const EARTH_RADIUS_M = 6_371_008.8;

export interface RasterGeo
{
    rasterSize: number;
    minLat:     number;
    maxLat:     number;
    minLon:     number;
    maxLon:     number;
    //Optional circular crop in metres around (homeLat, homeLon). When
    //set, cells beyond the radius are dropped so the shadow zones stay
    //inside the visible disc.
    homeLat:    number;
    homeLon:    number;
    cropRadiusMeters?: number;
}

export interface PipelineOptions
{
    heightThreshM?: number;
    heightMaxM?:    number;
    //Override the per-component physical target area (m²) when a
    //provider's data has a meaningfully different cell pitch from the
    //IGN baseline (1 m). Most callers can leave this default.
    targetAreaM2?:  number;
    minComponentCells?: number;
}

//Run the shared consolidation pipeline on a height-above-ground
//Float32Array. The caller is responsible for any DSM-DTM subtraction
//or no-data sentinel scrubbing; pass NaN for cells you want skipped.
export function processHeightRaster(
    heights: Float32Array,
    geo:     RasterGeo,
    opts:    PipelineOptions = {}
): LidarShadowResult
{
    const heightThresh = opts.heightThreshM    ?? DEFAULT_HEIGHT_THRESH_M;
    const heightMax    = opts.heightMaxM       ?? DEFAULT_HEIGHT_MAX_M;
    const targetArea   = opts.targetAreaM2     ?? DEFAULT_TARGET_AREA_M2;
    const minCells     = opts.minComponentCells ?? DEFAULT_MIN_COMPONENT_CELLS;

    const { rasterSize, minLat, maxLat, minLon, maxLon } = geo;
    const N = rasterSize * rasterSize;

    if (heights.length < N)
    {
        return emptyResult();
    }

    const pxLon  = (maxLon - minLon) / rasterSize;
    const pxLat  = (maxLat - minLat) / rasterSize;
    const halfLon = pxLon / 2;
    const halfLat = pxLat / 2;
    const pxLatM  = pxLat * M_PER_DEG_LAT;
    const cellAreaM2 = pxLatM * pxLatM;

    //Cell cap derived from physical target area so component size is
    //consistent across providers regardless of their native pixel
    //pitch. Clamped so very low precision still produces multi-cell
    //components and very high precision doesn't blow the cap loose.
    const maxCellsPerComponent = Math.max(4, Math.min(400,
        Math.round(targetArea / Math.max(0.01, cellAreaM2))));

    const cropM = geo.cropRadiusMeters && geo.cropRadiusMeters > 0
        ? geo.cropRadiusMeters
        : null;

    //Pass 1: identify valid cells (above threshold + inside crop).
    //Row j = 0 is the NORTH edge of the bbox (raster image convention,
    //top-down); latitude decreases as j grows.
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
            if (!isFinite(h) || h < heightThresh || h > heightMax) continue;

            if (cropM !== null)
            {
                const cLon = minLon + (i + 0.5) * pxLon;
                if (haversineMeters(geo.homeLat, geo.homeLon, cLat, cLon) > cropM)
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

    //Pass 2: size-capped 8-connected flood fill. Same logic as the
    //legacy FR implementation, lifted here so every provider gets the
    //same dappled-shadow look.
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

        if (cells.length >= minCells)
        {
            components.push({ cells, heightSum });
        }
    }

    //Pass 3: one convex-hull Polygon per component. Vertices are the
    //4 corners of every cell in the component; the hull breaks the
    //grid alignment of the underlying raster so cast shadows alpha-
    //composite into a continuous-but-dappled pattern instead of a
    //tile-aligned grid texture.
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

    return {
        features:
        {
            type:     'FeatureCollection',
            features: out
        },
        diagnostics:
        {
            cellsKept:        keptCells,
            cellsPerClumpCap: maxCellsPerComponent,
            heightRangeM:     keptCells > 0
                ? [Number(hMin.toFixed(1)), Number(hMax.toFixed(1))]
                : null
        },
        //Forward the raw raster + geo so the engine can keep it for
        //the LiDAR View overlay. Same buffer reference, no copy: the
        //pipeline never mutates `heights` after the validity pass
        //above, and the engine treats the buffer as read-only.
        raster:
        {
            heights:    heights,
            rasterSize,
            minLat,
            maxLat,
            minLon,
            maxLon
        }
    };
}

export function emptyResult(): LidarShadowResult
{
    return {
        features:
        {
            type:     'FeatureCollection',
            features: []
        },
        diagnostics:
        {
            cellsKept:        0,
            cellsPerClumpCap: 0,
            heightRangeM:     null
        }
    };
}

//Compute the lat/lon bbox around a home point, padded by
//`padFactor` so trees on the edge of the radius still cast their
//shadow inward.
export function homeBbox(
    homeLat: number, homeLon: number, radiusMeters: number, padFactor: number
): { minLat: number; maxLat: number; minLon: number; maxLon: number }
{
    const r    = Math.max(1, radiusMeters);
    const dLat = (r * padFactor) / M_PER_DEG_LAT;
    const dLon = (r * padFactor)
               / (M_PER_DEG_LAT * Math.cos(homeLat * Math.PI / 180));
    return {
        minLat: homeLat - dLat,
        maxLat: homeLat + dLat,
        minLon: homeLon - dLon,
        maxLon: homeLon + dLon
    };
}

//Great-circle distance in metres for the circular crop. Cheap enough
//to call per-cell at our raster sizes.
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number
{
    const toRad = Math.PI / 180;
    const dLat  = (lat2 - lat1) * toRad;
    const dLon  = (lon2 - lon1) * toRad;
    const a     = Math.sin(dLat / 2) ** 2
                + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad)
                * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

export const RASTER_DEFAULTS =
{
    bboxPadFactor:           1.15,
    minRasterSize:           64,
    maxRasterSize:           2048
} as const;
