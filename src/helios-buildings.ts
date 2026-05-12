//Self-sourced building footprints around the home.
//
//Why this module exists: rendering buildings through MapTiler's
//"helios-planet" vector source as a single fill-extrusion layer
//forces MapLibre to draw every building in the viewport at every
//frame. In dense urban areas that's several thousand extrusions per
//frame — visible jank on mobile, heavy battery drain, and beta
//testers (rightly) complained.
//
//Filtering after-the-fact via MapLibre paint expressions (distance,
//feature-state) was attempted and abandoned: per-feature distance
//evaluation on tiled vector sources produced flicker and inconsistent
//opacities at tile boundaries (geometry is clipped per tile, so a
//building that spans two tiles renders as two features with
//independently-evaluated paint properties).
//
//The fix is architectural: we fetch the MapTiler v3 vector tiles
//ourselves once at startup (and only the 1–4 tiles that cover the
//radius around the home), decode them with @mapbox/vector-tile,
//filter features by distance, identify the polygon that contains the
//home point, and emit TWO GeoJSON FeatureCollections that the engine
//feeds into two distinct fill-extrusion layers:
//
//  - helios-buildings-home          : 1 feature, opacity 1.0
//  - helios-buildings-surroundings  : N features, opacity from config
//
//Tiles are fetched once: the home doesn't move during a session, so
//there is no listener on pan/zoom. Only style reloads (which wipe
//sources/layers) trigger a re-emit — but the cached GeoJSON is
//reused; the network fetch is not repeated.

import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

export interface BuildingsResult
{
    home:         GeoJSON.FeatureCollection;
    surroundings: GeoJSON.FeatureCollection;
}

export interface FetchBuildingsOptions
{
    homeLon:       number;
    homeLat:       number;
    radiusMeters:  number;
    apiKey:        string;
    //Tile zoom level to fetch. MapTiler v3 carries the `building`
    //layer with `render_height` from z=14 onwards. z=14 keeps the
    //tile count to 1 (rarely 2) for radii under ~500 m, which is
    //the smallest network footprint while still giving us proper
    //extrusion heights.
    zoom?:         number;
    signal?:       AbortSignal;
}

const EARTH_RADIUS_M    = 6_371_008.8;
const HOME_FALLBACK_M   = 30;   //If no polygon contains the home point, pick
                                //the nearest one within this radius. Covers the
                                //common case where HA's home latitude lands in
                                //a garden a few metres off the actual building.

//----------------------------------------------------------------- coords

function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number }
{
    const n      = Math.pow(2, z);
    const latRad = lat * Math.PI / 180;
    const x      = Math.floor((lon + 180) / 360 * n);
    const y      = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    return { x, y };
}

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

//Convert a degree delta in latitude / longitude to metres at a given
//latitude. Used to expand the home point into a bbox before mapping
//it to tile indices.
function metersToDegLat(m: number): number
{
    return m / 111_320;
}

function metersToDegLon(m: number, atLat: number): number
{
    return m / (111_320 * Math.cos(atLat * Math.PI / 180));
}

//----------------------------------------------------------------- geometry

//Ray-casting point-in-polygon for a single ring (lon,lat pairs).
//Returns true if (lon, lat) is strictly inside or on the boundary.
function pointInRing(lon: number, lat: number, ring: number[][]): boolean
{
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const intersect = ((yi > lat) !== (yj > lat))
                       && (lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi);
        if (intersect)
        {
            inside = !inside;
        }
    }
    return inside;
}

//A GeoJSON Polygon is [outer, hole1, hole2, ...]; a MultiPolygon is
//an array of those. We treat the home check as "point is in the
//outer ring of any polygon". Holes are ignored — a building polygon
//with a courtyard still counts as containing the home point if the
//home sits anywhere within the outer footprint.
function polygonContains(geom: GeoJSON.Geometry, lon: number, lat: number): boolean
{
    if (geom.type === 'Polygon')
    {
        return geom.coordinates.length > 0 && pointInRing(lon, lat, geom.coordinates[0] as number[][]);
    }
    if (geom.type === 'MultiPolygon')
    {
        return geom.coordinates.some(poly => poly.length > 0 && pointInRing(lon, lat, poly[0] as number[][]));
    }
    return false;
}

//Centroid approximation: average of outer-ring vertices. Used only
//for the radius filter — exact centroids aren't necessary, we just
//need a "representative" point per building. For MultiPolygon we
//take the centroid of the first polygon's outer ring; close enough
//for filter purposes (a building rendered as a MultiPolygon is rare
//and the parts are always adjacent).
function representativePoint(geom: GeoJSON.Geometry): [number, number] | null
{
    let ring: number[][] | null = null;
    if (geom.type === 'Polygon' && geom.coordinates.length > 0)
    {
        ring = geom.coordinates[0] as number[][];
    }
    else if (geom.type === 'MultiPolygon' && geom.coordinates.length > 0 && geom.coordinates[0].length > 0)
    {
        ring = geom.coordinates[0][0] as number[][];
    }
    if (!ring || ring.length === 0)
    {
        return null;
    }
    let sx = 0, sy = 0;
    for (const p of ring) { sx += p[0]; sy += p[1]; }
    return [sx / ring.length, sy / ring.length];
}

//----------------------------------------------------------------- main

export async function fetchBuildingsAroundHome(opts: FetchBuildingsOptions): Promise<BuildingsResult>
{
    const z          = Math.max(0, Math.floor(opts.zoom ?? 14));
    const r          = Math.max(1, opts.radiusMeters);

    //Bounding box around the home in degrees, derived from the
    //radius. We over-estimate by a few percent so a building whose
    //centroid is *just* outside the bbox but whose actual nearest
    //corner is inside the radius still gets fetched. The wasted
    //features are filtered out at the haversine step below.
    const padFactor  = 1.15;
    const dLat       = metersToDegLat(r * padFactor);
    const dLon       = metersToDegLon(r * padFactor, opts.homeLat);
    const minLat     = opts.homeLat - dLat;
    const maxLat     = opts.homeLat + dLat;
    const minLon     = opts.homeLon - dLon;
    const maxLon     = opts.homeLon + dLon;

    //Tile range covering the bbox. Note Y is inverted (north-up).
    const tlTile = lonLatToTile(minLon, maxLat, z);
    const brTile = lonLatToTile(maxLon, minLat, z);
    const xMin   = Math.min(tlTile.x, brTile.x);
    const xMax   = Math.max(tlTile.x, brTile.x);
    const yMin   = Math.min(tlTile.y, brTile.y);
    const yMax   = Math.max(tlTile.y, brTile.y);

    const tilesToFetch: Array<{ x: number; y: number }> = [];
    for (let x = xMin; x <= xMax; x++)
    {
        for (let y = yMin; y <= yMax; y++)
        {
            tilesToFetch.push({ x, y });
        }
    }

    //Defensive: at very small radii on a tile corner we expect 1–4
    //tiles. Anything larger means radius or zoom is misconfigured;
    //bail rather than hammer the API.
    if (tilesToFetch.length > 16)
    {
        throw new Error(`[HELIOS] fetchBuildingsAroundHome: ${tilesToFetch.length} tiles requested — radius/zoom misconfigured`);
    }

    const features: GeoJSON.Feature[] = [];
    await Promise.all(tilesToFetch.map(async ({ x, y }) =>
    {
        const url = `https://api.maptiler.com/tiles/v3/${z}/${x}/${y}.pbf?key=${opts.apiKey}`;
        let resp: Response;
        try
        {
            resp = await fetch(url, { signal: opts.signal });
        }
        catch (e)
        {
            //Network error → silently skip this tile. Surroundings
            //will be sparser but the card stays usable. Errors are
            //already logged by the browser network panel; flooding
            //the HA console would be noise.
            return;
        }
        if (!resp.ok)
        {
            return;
        }
        let buf: ArrayBuffer;
        try
        {
            buf = await resp.arrayBuffer();
        }
        catch (_)
        {
            return;
        }
        if (buf.byteLength === 0)
        {
            return;
        }

        let tile: VectorTile;
        try
        {
            tile = new VectorTile(new Pbf(new Uint8Array(buf)));
        }
        catch (_)
        {
            return;
        }
        const layer = tile.layers['building'];
        if (!layer)
        {
            return;
        }

        for (let i = 0; i < layer.length; i++)
        {
            let geojson: GeoJSON.Feature;
            try
            {
                geojson = layer.feature(i).toGeoJSON(x, y, z) as GeoJSON.Feature;
            }
            catch (_)
            {
                continue;
            }
            if (!geojson.geometry) continue;

            //v1.2.0-beta.10 — split MultiPolygons into individual
            //Polygon features.
            //
            //MapTiler's v3 vector-tile encoder groups multiple
            //unrelated buildings into a single MultiPolygon feature
            //(observed: a single feature carrying 24 sub-polygons
            //in a rural French hamlet). Beta.9 captured one such
            //MultiPolygon as the "home" because the home point sat
            //inside one of its sub-polygons — and rendered ALL 24
            //buildings at full opacity, which read as "buildings
            //visible at kilometres". Splitting at decode time means
            //downstream filtering (home detection, radius cutoff)
            //operates at the granularity of one building per feature.
            //L-shaped or multi-wing buildings split into parts that
            //will still render identically when extruded at the same
            //height, so the visual outcome is unchanged for genuine
            //multi-part buildings.
            if (geojson.geometry.type === 'Polygon')
            {
                features.push(geojson);
            }
            else if (geojson.geometry.type === 'MultiPolygon')
            {
                for (const polyCoords of geojson.geometry.coordinates)
                {
                    features.push({
                        type:       'Feature',
                        geometry:   { type: 'Polygon', coordinates: polyCoords as number[][][] },
                        properties: { ...(geojson.properties ?? {}) }
                    });
                }
            }
            //Lines / points are skipped silently — not buildings.
        }
    }));

    //Filter by radius and identify the home polygon.
    let homeFeature: GeoJSON.Feature | null = null;
    let homeFallback: { feature: GeoJSON.Feature; distance: number } | null = null;
    const surroundings: GeoJSON.Feature[] = [];

    for (const f of features)
    {
        const contains = polygonContains(f.geometry, opts.homeLon, opts.homeLat);
        if (contains && !homeFeature)
        {
            homeFeature = f;
            continue;
        }

        const rep = representativePoint(f.geometry);
        if (!rep)
        {
            continue;
        }
        const d = haversineMeters(opts.homeLat, opts.homeLon, rep[1], rep[0]);

        //Fallback candidate for the home: closest building within
        //HOME_FALLBACK_M of the configured home point. Only used if
        //no polygon actually contains the point (HA latitude on a
        //garden, parking spot, etc.).
        if (!homeFeature && d <= HOME_FALLBACK_M)
        {
            if (!homeFallback || d < homeFallback.distance)
            {
                homeFallback = { feature: f, distance: d };
            }
        }

        if (d <= r)
        {
            surroundings.push(f);
        }
    }

    if (!homeFeature && homeFallback)
    {
        homeFeature = homeFallback.feature;
        //Remove the fallback from surroundings (it was added there
        //on its first pass since we hadn't promoted it to home yet).
        const idx = surroundings.indexOf(homeFallback.feature);
        if (idx >= 0) surroundings.splice(idx, 1);
    }

    return {
        home:         { type: 'FeatureCollection', features: homeFeature ? [homeFeature] : [] },
        surroundings: { type: 'FeatureCollection', features: surroundings }
    };
}
