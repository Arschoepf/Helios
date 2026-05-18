//Cast-shadow raster painting. The shadow projector produces one
//polygon per casting region; this module rasterises them onto an
//offscreen canvas at full black and pushes the result to the
//MapLibre ImageSource backing the shadow layer. Per-pixel
//rendering avoids the alpha-compositing saturation that many
//overlapping fill polygons would produce in a dense forest
//(every pixel is either covered or not, never stacked twice).

import type maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap } from 'maplibre-gl';


//Offscreen raster resolution for the shadow mask. 1024x1024 over a
//building-radius bbox (up to ~2 km wide at max radius) gives ~2 m
//per pixel at the worst case, finer than the LiDAR cell pitch we
//feed in, so the polygon edges read as smooth anti-aliased curves
//rather than visible stair-stepping.
export const SHADOW_RASTER_SIZE = 1024;


//Fully-transparent 1x1 PNG used as the initial image of the shadow
//source so MapLibre has something valid to bind before the first
//paint pass runs.
export const BLANK_SHADOW_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';


//Four lat/lon corners of the shadow image source, in [NW, NE, SE, SW]
//order (the convention MapLibre image sources expect). Sides are the
//`radiusMeters` value converted to degrees with the standard cos(lat)
//longitude correction.
export type ShadowBoundsCorners =
    [[number, number], [number, number], [number, number], [number, number]];

export function shadowBoundsCornersLL(
    homeLat:      number,
    homeLon:      number,
    radiusMeters: number
): ShadowBoundsCorners
{
    const cosLat  = Math.cos(homeLat * Math.PI / 180);
    const dLat    = radiusMeters / 111_320;
    const dLon    = radiusMeters / (111_320 * cosLat);
    const minLon  = homeLon - dLon;
    const maxLon  = homeLon + dLon;
    const minLat  = homeLat - dLat;
    const maxLat  = homeLat + dLat;
    return [
        [minLon, maxLat],  // NW
        [maxLon, maxLat],  // NE
        [maxLon, minLat],  // SE
        [minLon, minLat]   // SW
    ];
}


//Rasterise the cast-shadow polygons onto the offscreen canvas and
//push the resulting PNG to the image source. Painting every polygon
//at solid black means overlapping regions stay black (no alpha
//stacking); the layer's `raster-opacity` then applies a single
//per-pixel opacity that matches the user setting exactly, no
//matter how many shadow polygons overlapped.
export function paintShadowRaster(
    map:      MapLibreMap,
    canvas:   HTMLCanvasElement,
    features: GeoJSON.FeatureCollection,
    corners:  ShadowBoundsCorners
): void
{
    const src = map.getSource('helios-building-shadows-src') as
                maplibregl.ImageSource | undefined;
    if (!src) return;

    const minLon = corners[0][0], maxLat = corners[0][1];
    const maxLon = corners[1][0], minLat = corners[2][1];

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const size = canvas.width;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#000000';

    const lonSpan = maxLon - minLon;
    const latSpan = maxLat - minLat;
    const lonToPx = (lon: number): number =>
        (lon - minLon) / lonSpan * size;
    //Canvas Y is top-down (0 at top), lat is bottom-up, so the
    //north edge maps to pixel 0 and the south edge to the last pixel.
    const latToPx = (lat: number): number =>
        (maxLat - lat) / latSpan * size;

    for (const feat of features.features)
    {
        const geom = feat.geometry;
        if (!geom) continue;
        let polygons: number[][][][] | null = null;
        if      (geom.type === 'Polygon')      polygons = [geom.coordinates as number[][][]];
        else if (geom.type === 'MultiPolygon') polygons = geom.coordinates as number[][][][];
        if (!polygons) continue;

        for (const poly of polygons)
        {
            if (!poly.length) continue;
            const outer = poly[0] as number[][];
            if (outer.length < 3) continue;

            ctx.beginPath();
            ctx.moveTo(lonToPx(outer[0][0]), latToPx(outer[0][1]));
            for (let i = 1; i < outer.length; i++)
            {
                ctx.lineTo(lonToPx(outer[i][0]), latToPx(outer[i][1]));
            }
            ctx.closePath();
            ctx.fill();
        }
    }

    //Keep the bounds in sync in case the home position or the
    //building radius changed since the source was created. Cheap
    //and idempotent.
    try { src.setCoordinates(corners); }
    catch (_) {}
    //MapLibre 5's ImageSource.updateImage only takes a URL, so we
    //serialise the canvas as a PNG data URL on each paint. PNG
    //encode of a mostly-transparent 1024 raster lands in the
    //~10-20 ms range on commodity hardware, well under the sun
    //movement cadence that triggers shadow refreshes.
    try
    {
        const dataUrl = canvas.toDataURL('image/png');
        src.updateImage({ url: dataUrl });
    }
    catch (_) {}
}
