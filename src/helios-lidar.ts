//Common interface and registry for country-specific LiDAR providers.
//
//Adding a country = drop a new file under ./helios-lidar/ that exports
//a LidarSource and register it in LIDAR_SOURCES below. No engine-side
//changes needed.
//
//Pipeline overview: when the user has shadows enabled AND a provider
//covers the home, the engine calls fetchShadowRegions() with the home
//position and a radius. The provider fetches a height raster around
//the home and bins above-threshold cells onto a fixed ~10 m grid,
//emitting one Polygon per non-empty bin with `render_height` set to
//the bin's mean cell height. Those bin polygons feed
//projectExtrusionShadows() exactly like the MapTiler footprints do
//when LiDAR is unavailable. Per-bin granularity (rather than one
//convex hull per connected component) keeps a dense forest from
//collapsing into one giant blanket shadow.

export interface LidarSource
{
    //Stable identifier, lowercased and country-prefixed. Goes into
    //logs.
    id:    string;
    //Human-readable label, currently logs-only.
    name:  string;

    //Cheap synchronous coverage probe. Implementations should bail
    //fast (a couple of bbox comparisons) so the engine can call this
    //on every home-position change without measurable cost.
    covers(lat: number, lon: number): boolean;

    //Fetch shadow regions around the home as a FeatureCollection of
    //bin polygons with render_height set per bin. Returns an empty
    //collection on network failure, out-of-coverage bbox or empty
    //raster, so the caller can always use the result unconditionally.
    fetchShadowRegions(opts: LidarShadowFetchOptions): Promise<GeoJSON.FeatureCollection>;
}

export interface LidarShadowFetchOptions
{
    homeLat:                  number;
    homeLon:                  number;
    //Radius in metres around the home from which heights are sampled.
    //The provider over-fetches slightly so trees on the edge still
    //cast their shadow inward.
    radiusMeters:             number;
    //Pixel count per side requested from the upstream raster. The
    //engine picks this based on the user's `lidar-precision`.
    rasterSize:               number;
    //Optional circular crop. Cells beyond this distance from the
    //home are dropped so the shadow zones stay inside the visible
    //disc. When unset, the bbox is the only bound.
    cropRadiusMeters?:        number;
    signal?:                  AbortSignal;
}

import { franceLidarHd } from './helios-lidar/helios-lidar-fr';

//Registered providers, ordered by preference. The first one that
//covers the home wins. Currently France only.
export const LIDAR_SOURCES: LidarSource[] = [
    franceLidarHd
];

export function findLidarSource(lat: number, lon: number): LidarSource | null
{
    for (const src of LIDAR_SOURCES)
    {
        if (src.covers(lat, lon)) return src;
    }
    return null;
}
