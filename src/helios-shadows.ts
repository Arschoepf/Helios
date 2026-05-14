//Ground-projected shadow polygons. MapLibre 5 has no native cast-shadow
//for fill-extrusion layers, so we compute them in JS each timeline tick:
//for every input footprint we offset its vertices by (h / tan(alt)) in
//the opposite-of-sun direction and emit the convex hull of (original ,
//projected) as a flat Polygon. The 3D extrusion of the original feature
//hides the under-feature part of that polygon at render time, leaving
//only the actual ground shadow visible.

const M_PER_DEG_LAT = 111_320;

export interface ProjectShadowsOptions
{
    //Compass azimuth, degrees clockwise from north (matches getSunPosition).
    sunAzimuthDeg:    number;
    //Altitude above horizon in degrees. Below minAltitudeDeg the
    //projector returns an empty FeatureCollection.
    sunAltitudeDeg:   number;
    //Reference latitude for the metres-to-degrees-of-longitude
    //conversion. cos(lat) is constant over a Helios card's bbox.
    homeLat:          number;
    //Drop features whose effective height is below this. Default 2 m.
    minHeightM?:      number;
    //Sun-altitude cut-off below which we emit nothing. Default 1.5 deg
    //(below that, shadows become hundreds of metres long and the
    //night-shade overlay already conveys "it's dark").
    minAltitudeDeg?:  number;
    //Optional clip-to-disc. When all three are set, every emitted
    //polygon is clipped against a circular region of `clipRadiusMeters`
    //around (clipCenterLat, clipCenterLon). Used to keep cast shadows
    //within the building visibility radius, consistent with the
    //surroundings extrusion clip.
    clipCenterLat?:   number;
    clipCenterLon?:   number;
    clipRadiusMeters?: number;
}

export function projectExtrusionShadows(
    extrusions: GeoJSON.FeatureCollection,
    opts:       ProjectShadowsOptions
): GeoJSON.FeatureCollection
{
    const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

    const minAlt = opts.minAltitudeDeg ?? 1.5;
    if (opts.sunAltitudeDeg <= minAlt) return empty;

    const D    = Math.PI / 180;
    const azR  = opts.sunAzimuthDeg  * D;
    const altR = opts.sunAltitudeDeg * D;

    //Shadow direction = opposite of the sun on the ground plane
    //(compass: x = east, y = north).
    const shadowDx = -Math.sin(azR);
    const shadowDy = -Math.cos(azR);

    const tanAlt     = Math.tan(altR);
    const mPerDegLon = M_PER_DEG_LAT * Math.cos(opts.homeLat * D);
    const minH       = opts.minHeightM ?? 2;

    //Build the clip polygon once per call. We approximate the disc
    //with 64 vertices (smooth at typical card zoom, negligible cost).
    //Generated in CCW order so the Sutherland-Hodgman half-plane test
    //treats "inside the disc" as "left of every edge".
    let clipRing: Array<[number, number]> | null = null;
    if (
        typeof opts.clipCenterLat   === 'number'
     && typeof opts.clipCenterLon   === 'number'
     && typeof opts.clipRadiusMeters === 'number'
     && opts.clipRadiusMeters > 0
    )
    {
        const segs = 64;
        const dLatDisc = opts.clipRadiusMeters / M_PER_DEG_LAT;
        const dLonDisc = opts.clipRadiusMeters
                       / (M_PER_DEG_LAT * Math.cos(opts.clipCenterLat * D));
        const ring: Array<[number, number]> = [];
        for (let i = 0; i < segs; i++)
        {
            const a = (i / segs) * 2 * Math.PI;
            ring.push([
                opts.clipCenterLon + Math.cos(a) * dLonDisc,
                opts.clipCenterLat + Math.sin(a) * dLatDisc
            ]);
        }
        clipRing = ring;
    }

    const out: GeoJSON.Feature[] = [];

    for (const feat of extrusions.features)
    {
        const geom = feat.geometry;
        if (!geom) continue;

        const props = (feat.properties ?? {}) as Record<string, unknown>;
        const top   = typeof props['render_height']     === 'number' ? props['render_height']     as number : 0;
        const base  = typeof props['render_min_height'] === 'number' ? props['render_min_height'] as number : 0;
        const h     = Math.max(0, top - base);
        if (h < minH) continue;

        const lenM    = h / tanAlt;
        const dLatDeg = shadowDy * lenM / M_PER_DEG_LAT;
        const dLonDeg = shadowDx * lenM / mPerDegLon;

        //Defend against MultiPolygon for portability even though our
        //pipelines only emit single-polygon Features.
        let polygons: number[][][][] | null = null;
        if      (geom.type === 'Polygon')      polygons = [geom.coordinates as number[][][]];
        else if (geom.type === 'MultiPolygon') polygons = geom.coordinates as number[][][][];
        if (!polygons) continue;

        for (const poly of polygons)
        {
            if (!poly.length) continue;
            const outer = poly[0] as number[][];
            if (outer.length < 3) continue;

            //One flat-opacity shadow polygon per casting region: the
            //convex hull of (original vertices + opposite-of-sun
            //projections). The 3D extrusion of the original feature
            //covers the under-feature part at render time, leaving
            //only the ground spillover visible.
            const cloud: Array<[number, number]> = [];
            for (const p of outer)
            {
                const lon = p[0], lat = p[1];
                cloud.push([lon,            lat]);
                cloud.push([lon + dLonDeg,  lat + dLatDeg]);
            }
            const hull = convexHull(cloud);
            if (hull.length < 3) continue;

            //Optional clip-to-disc. The shadow trail can extend well
            //past the building visibility radius for a tall region
            //near the edge; clipping here keeps the visible shadows
            //confined to the same disc as the rendered buildings.
            let ring: Array<[number, number]> = hull;
            if (clipRing)
            {
                const clipped = clipConvexPolygon(hull, clipRing);
                if (clipped.length < 3) continue;
                ring = clipped;
            }
            ring = ring.slice();
            ring.push([ring[0][0], ring[0][1]]);

            out.push({
                type:       'Feature',
                geometry:   { type: 'Polygon', coordinates: [ring] },
                properties: { render_height: h }
            });
        }
    }

    return { type: 'FeatureCollection', features: out };
}

//Sutherland-Hodgman polygon clip. Both `subject` and `clip` are
//non-closed rings in CCW order. Returns the intersection ring (also
//non-closed, possibly empty). Robust for any convex `clip`; the
//subject does not need to be convex but is in our pipeline (each
//shadow polygon is a convex hull). The "inside" test is the standard
//left-of-edge sign of the 2D cross product.
function clipConvexPolygon(
    subject: Array<[number, number]>,
    clip:    Array<[number, number]>
): Array<[number, number]>
{
    if (subject.length < 3 || clip.length < 3) return [];
    let output: Array<[number, number]> = subject.slice();

    for (let e = 0; e < clip.length; e++)
    {
        if (output.length === 0) return [];
        const e1 = clip[e];
        const e2 = clip[(e + 1) % clip.length];

        const input = output;
        output = [];

        const inside = (p: [number, number]): number =>
            (e2[0] - e1[0]) * (p[1] - e1[1]) - (e2[1] - e1[1]) * (p[0] - e1[0]);

        const intersect = (
            a: [number, number], b: [number, number]
        ): [number, number] =>
        {
            const x1 = e1[0], y1 = e1[1], x2 = e2[0], y2 = e2[1];
            const x3 = a[0],  y3 = a[1],  x4 = b[0],  y4 = b[1];
            const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
            if (den === 0) return [b[0], b[1]];
            const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
            return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
        };

        for (let i = 0; i < input.length; i++)
        {
            const curr = input[i];
            const next = input[(i + 1) % input.length];
            const cIn  = inside(curr) >= 0;
            const nIn  = inside(next) >= 0;
            if (cIn)
            {
                if (nIn) output.push(next);
                else     output.push(intersect(curr, next));
            }
            else
            {
                if (nIn)
                {
                    output.push(intersect(curr, next));
                    output.push(next);
                }
            }
        }
    }

    return output;
}

//Andrew's monotone chain. Returns vertices CCW, NOT closed. Exported
//for the LiDAR pipeline which uses it to wrap each consolidated region.
export function convexHull(pts: Array<[number, number]>): Array<[number, number]>
{
    if (pts.length < 3) return pts.slice();

    const arr   = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
        (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

    const lower: Array<[number, number]> = [];
    for (const p of arr)
    {
        while (lower.length >= 2
            && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
        {
            lower.pop();
        }
        lower.push(p);
    }

    const upper: Array<[number, number]> = [];
    for (let i = arr.length - 1; i >= 0; i--)
    {
        const p = arr[i];
        while (upper.length >= 2
            && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
        {
            upper.pop();
        }
        upper.push(p);
    }

    lower.pop();
    upper.pop();
    return lower.concat(upper);
}
