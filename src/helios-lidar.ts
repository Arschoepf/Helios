//Common interface and registry for country-specific LiDAR providers.
//
//Adding a country = drop a new file under ./helios-lidar/ that exports
//a LidarSource and register it in LIDAR_SOURCES below. No engine-side
//changes needed.

export interface LidarSource
{
    //Stable identifier, lowercased and country-prefixed. Goes into
    //logs and the engine's fetch-cache key.
    id:    string;
    //Human-readable label, currently logs-only, may surface in a
    //future config UI.
    name:  string;

    //Cheap synchronous coverage probe. Implementations should bail
    //fast (a couple of bbox comparisons) so the engine can call this
    //on every home-position change without measurable cost.
    covers(lat: number, lon: number): boolean;

    //Fetch the raw LiDAR rasters around the home. Implementations
    //decode whatever wire format the upstream API exposes and return
    //a single LidarRasters bundle holding MNH (height above ground)
    //and MNT (bare-earth elevation) rasters covering the same bbox,
    //plus the metadata the engine needs to project them.
    //
    //Returns `rasters: null` when the fetch failed end-to-end (the
    //LiDAR pipeline silently no-ops in that case). Partial failures
    //surface as a null `rasters` too: we don't ship half a DEM.
    fetch(opts: LidarFetchOptions): Promise<LidarFetchResult>;
}

export interface LidarFetchResult
{
    rasters: LidarRasters | null;
}

export interface LidarRasters
{
    //Raster dimensions; same for MNT and MNS, both decode at the
    //provider's requested resolution.
    width:  number;
    height: number;
    //Geographic bounds, row 0 is the north edge of `maxLat`. The
    //bbox is slightly padded outwards from the requested radius so
    //the engine can shadow-test points up to the visible disc.
    bounds: { minLon: number; minLat: number; maxLon: number; maxLat: number };
    //Average ground-cell size in metres (mean of lon / lat pitch).
    //The engine uses it as the step size for the per-pixel shadow
    //ray cast.
    cellPitchM: number;
    //Bare-earth elevation (MNT, Modele Numerique de Terrain) in
    //metres above mean sea level. Row-major, top-down. Drives the
    //custom DEM source that replaces MapTiler terrain in the LiDAR
    //area; also provides the ground-surface normal for the scanner's
    //per-pixel incidence computation.
    mnt: Float32Array;
    //Full surface elevation (MNS, Modele Numerique de Surface):
    //bare-earth + every above-ground feature (vegetation, buildings,
    //masts, ...). Same orientation as `mnt`. Drives the scanner's
    //shadow ray cast: any cell whose MNS rises above the sun line
    //casts a shadow on neighbouring ground pixels.
    mns: Float32Array;
}

export interface LidarFetchOptions
{
    homeLat:      number;
    homeLon:      number;
    radiusMeters: number;
    //Pixel count per side requested from the upstream raster. Higher
    //means finer ground sampling and a larger payload. The engine
    //derives this from the user-set `lidar-precision` level.
    rasterSize:   number;
    //Hard limit on the haversine distance from the home, in metres.
    //Providers fetch a padded bbox but clamp output cells beyond
    //this so the rendered scanner stays inside the visible disc.
    cropRadiusMeters?: number;
    signal?:           AbortSignal;
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
