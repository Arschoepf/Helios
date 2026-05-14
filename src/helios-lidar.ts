//Common interface and registry for country-specific LiDAR providers.
//
//Adding a country = drop a new file under ./helios-lidar/ that exports
//a LidarSource and register it in LIDAR_SOURCES below. No engine-side
//changes needed.
//
//Pipeline overview: when the user has shadows enabled AND a provider
//covers the home, the engine calls fetchShadowRegions() with the home
//position and a radius. The provider fetches a height raster around
//the home, runs a size-capped 8-connected flood fill on the cells
//above the height threshold, and emits one convex-hull Polygon per
//capped clump with `render_height` set to the clump's mean cell
//height. Those polygons feed projectExtrusionShadows() exactly like
//the MapTiler footprints do when LiDAR is unavailable. Capping the
//clump area keeps a dense forest from collapsing into one giant
//blanket shadow while preserving the organic, non-grid-aligned
//shape of a convex hull.

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
    //bin polygons with render_height set per bin, together with a
    //small diagnostics bag the engine surfaces through
    //`window.heliosStats()`. Returns an empty collection on network
    //failure, out-of-coverage bbox or empty raster, so the caller
    //can always use the result unconditionally.
    fetchShadowRegions(opts: LidarShadowFetchOptions): Promise<LidarShadowResult>;
}

export interface LidarShadowResult
{
    features:    GeoJSON.FeatureCollection;
    diagnostics:
    {
        //Number of LiDAR cells that passed the height threshold and
        //the circular crop. 0 when the home is outside coverage or
        //the WMS round-trip failed.
        cellsKept:   number;
        //Cells-per-clump cap actually used (derived from the chosen
        //precision). Surfaced so the user can confirm the size cap
        //matches expectations.
        cellsPerClumpCap: number;
        //Min / max kept height in metres. null when no cell passed.
        heightRangeM: [number, number] | null;
    };
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
