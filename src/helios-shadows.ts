//Ground-projected shadow polygons for any layer of extruded
//footprints (buildings, vegetation cells from a LiDAR raster, ...).
//
//MapLibre 5 has no built-in cast-shadow pipeline for fill-extrusion
//layers (that feature lives only in Mapbox GL JS v3+, which we don't
//ship). To still get ShadowMap-style ombres portees on the ground we
//compute them ourselves in JS once per timeline tick:
//
//  1. For each footprint, take its top extrusion height
//     (render_height minus render_min_height).
//  2. Compute the shadow length on the ground from the sun altitude:
//     L = h / tan(alt). The shadow direction is the unit vector
//     pointing away from the sun (compass azimuth + 180 deg).
//  3. Offset every footprint vertex by (dLon, dLat) corresponding to
//     L metres in that direction.
//  4. Take the convex hull of (original_vertices , projected_vertices)
//     and emit it as a Polygon feature.
//
//The convex hull is geometrically exact for convex footprints and
//slightly over-approximates for non-convex (L-shaped, courtyards)
//ones, but the original polygon usually sits on top of the shadow at
//render time so the visible over-coverage is masked. The cost is
//O(n log n) per feature for the sort + hull, negligible compared to
//a single MapLibre frame at the feature counts we deal with (a few
//hundred buildings or a few thousand vegetation cells).
//
//We skip the whole pass when the sun is below the horizon or very
//low: at altitude under ~1.5 deg shadows become hundreds of metres
//long, dominate the viewport, and the night-shade overlay already
//conveys "it's dark" at that point.

//Metres per degree of latitude (WGS84 mean). Constant within the
//bounds of a single Helios card (a few hundred metres around home).
const M_PER_DEG_LAT = 111_320;

export interface ProjectShadowsOptions
{
    //Compass azimuth of the sun, degrees clockwise from north,
    //matching the convention of getSunPosition() in helios-sun.ts.
    sunAzimuthDeg:    number;
    //Altitude of the sun above the horizon, in degrees. Values <=
    //minAltitudeDeg short-circuit the whole pass and return an empty
    //FeatureCollection.
    sunAltitudeDeg:   number;
    //Reference latitude for the metres-to-degrees-of-longitude
    //conversion. Use the home latitude, the radius around it is
    //small enough that cos(lat) is effectively constant.
    homeLat:          number;
    //Features whose effective height (top minus base) is below this
    //do not contribute a shadow. Avoids hairline polygons for tile
    //features that come back with render_height = 0 or near zero.
    minHeightM?:      number;
    //Cut-off below which we emit no shadows at all (sun too low).
    minAltitudeDeg?:  number;
}

export function projectExtrusionShadows(
    extrusions: GeoJSON.FeatureCollection,
    opts:       ProjectShadowsOptions
): GeoJSON.FeatureCollection
{
    const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

    const minAlt = opts.minAltitudeDeg ?? 1.5;
    if (opts.sunAltitudeDeg <= minAlt)
    {
        return empty;
    }

    const D    = Math.PI / 180;
    const azR  = opts.sunAzimuthDeg  * D;
    const altR = opts.sunAltitudeDeg * D;

    //Unit vector pointing TOWARD the sun on the ground plane (compass
    //convention: x = east, y = north). The shadow lies in the
    //opposite direction.
    const sunDx = Math.sin(azR);
    const sunDy = Math.cos(azR);
    const shadowDx = -sunDx;
    const shadowDy = -sunDy;

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

        //Helios-buildings emits only Polygon features (MultiPolygons
        //are split upstream); LiDAR vegetation cells are also single
        //Polygon features. We still defend against MultiPolygon so
        //the helper stays usable for any caller.
        let polygons: number[][][][] | null = null;
        if (geom.type === 'Polygon')
        {
            polygons = [geom.coordinates as number[][][]];
        }
        else if (geom.type === 'MultiPolygon')
        {
            polygons = geom.coordinates as number[][][][];
        }
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
                cloud.push([lon,            lat]);
                cloud.push([lon + dLonDeg,  lat + dLatDeg]);
            }
            const hull = convexHull(cloud);
            if (hull.length < 3) continue;
            //Close the ring for GeoJSON validity.
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

//Andrew's monotone chain. Returns vertices in CCW order, NOT closed.
//The shadow projection adds a fixed offset to every vertex of a
//footprint, so the resulting cloud sits in a half-plane relative to
//the original polygon. Convex hull of (original , projected) is the
//tightest enclosing polygon that includes both the footprint and its
//translated copy, exactly the shadow silhouette for a convex base.
//Vegetation cells from a LiDAR raster are 4-vertex squares, so the
//hull degenerates to a 6-vertex hexagon, ideal cheap shadow shape.
function convexHull(pts: Array<[number, number]>): Array<[number, number]>
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
