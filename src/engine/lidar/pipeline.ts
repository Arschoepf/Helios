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

import { convexHull } from '../shadows';
import type { LidarShadowResult } from '../lidar';

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
//                               precisions. ~16 m² is a 4 m × 4 m clump,
//                               the size of a single tree crown or one
//                               wing of a small building; smaller clumps
//                               trace irregular shapes (L-shaped roofs,
//                               tree rows that zigzag) much closer to
//                               their real outline once the per-clump
//                               convex hull is taken in pass 3.
//                               (Tuned down from a wider initial cap
//                               after field reports that the cast
//                               shadow blob looked too "smudged".)
//  MIN_COMPONENT_CELLS        , floor on cells per component before we
//                               bother emitting a polygon. Drops single-
//                               cell noise that would render as speckled
//                               dot shadows.
const DEFAULT_HEIGHT_THRESH_M    = 5;
const DEFAULT_HEIGHT_MAX_M       = 100;
const DEFAULT_TARGET_AREA_M2     = 16;
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
    //Opt-in 3x3 median pre-filter on the raster, BEFORE thresholding.
    //Recommended for providers that publish DSM + DTM separately and
    //let the client subtract per-pixel (AT-Tirol, AT-Steiermark,
    //DE-BW, NL, UK), the per-pixel subtraction amplifies single-cell
    //noise at building edges + vegetation, which would otherwise pass
    //the height threshold and saturate the flood fill with junk
    //components. The median pass keeps building roofs (multi-cell
    //plateaux) while killing isolated spikes. nDSM providers that
    //ship a pre-computed normalised height (FR, PL, CA, VT, NRW)
    //typically don't need this, the source agency has already
    //smoothed the raster server-side.
    medianSmooth?: boolean;
}

//Run the shared consolidation pipeline on a height-above-ground
//Float32Array. The caller is responsible for any DSM-DTM subtraction
//or no-data sentinel scrubbing; pass NaN for cells you want skipped.
//
//Optional `terrain` parallel buffer (same shape, same indexing as
//`heights`) carries the DTM band when the source COG ships one
//(the helios-lidar.org 2-band pipeline). It is forwarded verbatim
//onto the result's `raster.terrain` field so the shading ray-march
//can lift its comparison into absolute Z. Pure pass-through: the
//shadow consolidation logic itself stays nDSM-only.
export function processHeightRaster(
    heights: Float32Array,
    geo:     RasterGeo,
    opts:    PipelineOptions = {},
    terrain?: Float32Array,
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

    if (opts.medianSmooth)
    {
        heights = median3x3(heights, rasterSize);
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
    //Upper bound 80 cells caps the worst-case convex-hull extension
    //to a single building wing or tree group; the shadow polygon
    //then reads as a recognisable shape rather than a smudged blob.
    const maxCellsPerComponent = Math.max(4, Math.min(80,
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
        //above, and the engine treats the buffer as read-only. The
        //terrain band, when provided, is forwarded with the same
        //zero-copy contract.
        raster:
        {
            heights:    heights,
            terrain,
            rasterSize,
            minLat,
            maxLat,
            minLon,
            maxLon
        }
    };
}

//3x3 median filter in-place over a Float32 raster, edges handled by
//reusing the cell's own value when the kernel falls off the grid.
//NaN inputs are preserved (the median of [NaN, ...] is NaN by our
//convention so a no-data cell stays no-data), which keeps the
//upstream "no-data" semantics intact for nDSM cells the upstream
//WCS marked as missing. Returns a fresh Float32Array, the input is
//not mutated.
//
//Use case: DSM-DTM subtraction providers (AT-Tirol, AT-Steiermark,
//DE-BW) where per-pixel subtraction amplifies single-cell noise at
//building edges + vegetation. A median pass kills isolated spikes
//while preserving multi-cell building plateaux.
function median3x3(src: Float32Array, size: number): Float32Array
{
    const out = new Float32Array(src.length);
    const buf = new Array<number>(9);
    for (let j = 0; j < size; j++)
    {
        for (let i = 0; i < size; i++)
        {
            const idx = j * size + i;
            const center = src[idx];
            if (!isFinite(center))
            {
                out[idx] = center;
                continue;
            }
            let n = 0;
            for (let dj = -1; dj <= 1; dj++)
            {
                const jj = j + dj;
                if (jj < 0 || jj >= size) continue;
                for (let di = -1; di <= 1; di++)
                {
                    const ii = i + di;
                    if (ii < 0 || ii >= size) continue;
                    const v = src[jj * size + ii];
                    if (isFinite(v)) buf[n++] = v;
                }
            }
            if (n === 0) { out[idx] = NaN; continue; }
            //In-place insertion sort, faster than Array.sort on a 9-
            //element buffer.
            for (let k = 1; k < n; k++)
            {
                const v = buf[k];
                let m = k - 1;
                while (m >= 0 && buf[m] > v)
                {
                    buf[m + 1] = buf[m];
                    m--;
                }
                buf[m + 1] = v;
            }
            out[idx] = buf[(n - 1) >> 1];
        }
    }
    return out;
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
