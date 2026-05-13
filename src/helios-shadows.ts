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

            const cloud: Array<[number, number]> = [];
            for (const p of outer)
            {
                const lon = p[0], lat = p[1];
                cloud.push([lon,           lat]);
                cloud.push([lon + dLonDeg, lat + dLatDeg]);
            }
            const hull = convexHull(cloud);
            if (hull.length < 3) continue;
            hull.push([hull[0][0], hull[0][1]]);

            out.push({
                type:       'Feature',
                geometry:   { type: 'Polygon', coordinates: [hull] },
                properties: {}
            });
        }
    }

    return { type: 'FeatureCollection', features: out };
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
