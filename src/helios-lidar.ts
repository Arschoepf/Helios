//Common interface and registry for country-specific LiDAR vegetation
//sources. Each source can answer two questions:
//
//  - covers(lat, lon): does this provider have data for the home
//    location? Cheap bbox check, no network call.
//  - fetch(opts):      one-shot pull of a vegetation height field
//    over a square area around the home. Returned as a GeoJSON
//    FeatureCollection of small Polygon "cells" with `render_height`
//    and `render_min_height` properties so the same shadow projection
//    code path used for buildings (helios-shadows.ts) handles them
//    transparently.
//
//Adding a new country = adding a new file (helios-lidar-us.ts,
//helios-lidar-de.ts, ...) that exports a LidarVegetationSource and
//registering it in LIDAR_SOURCES below. No engine-side changes
//needed past that.

export interface LidarVegetationSource
{
    //Stable identifier, used in logs and as a cache key prefix. Keep
    //it lowercase, country-prefixed, hyphen-separated.
    id:    string;
    //Human-readable label, currently used only in console logging
    //but may surface in future config UI.
    name:  string;

    //Cheap synchronous coverage probe. Implementations should bail
    //fast (a couple of bbox comparisons) so the engine can call this
    //on every home-position change without measurable cost.
    covers(lat: number, lon: number): boolean;

    //Fetch vegetation cells around the home. Implementations are
    //responsible for:
    //  - choosing an appropriate raster resolution / bbox padding,
    //  - decoding whatever wire format the upstream API exposes
    //    (BIL float32 for IGN, GeoTIFF for some US sources, ...),
    //  - thresholding by height (typically >= 3 m to skip grass /
    //    bushes),
    //  - removing cells overlapping the supplied building footprints
    //    (those already cast their own shadow via helios-buildings).
    //
    //Returned features must be Polygons with `render_height` and
    //`render_min_height` numeric properties; helios-shadows.ts
    //consumes them identically to MapTiler building features.
    fetch(opts: LidarFetchOptions): Promise<GeoJSON.FeatureCollection>;
}

export interface LidarFetchOptions
{
    homeLat:      number;
    homeLon:      number;
    radiusMeters: number;
    //Pixel count per side requested from the upstream raster. Higher
    //means finer ground sampling, larger payload, more features
    //downstream. The engine derives this from the user-configured
    //vegetation level (helios-engine.ts:LIDAR_VEGETATION_RASTER).
    rasterSize:   number;
    //Footprints already known from MapTiler (home + surroundings).
    //Cells whose centre falls inside any of these are dropped to
    //avoid double-counting buildings as vegetation pillars.
    buildingFootprints?: GeoJSON.FeatureCollection;
    signal?:      AbortSignal;
}

//Registered providers, ordered by preference. The first one that
//covers the home wins. Currently France (IGN LiDAR HD) only; future
//providers (US 3DEP, German DGM, ...) live alongside in the
//./helios-lidar/ subfolder and are registered the same way.
import { franceLidarHd } from './helios-lidar/helios-lidar-fr';

export const LIDAR_SOURCES: LidarVegetationSource[] = [
    franceLidarHd
];

export function findLidarSource(lat: number, lon: number): LidarVegetationSource | null
{
    for (const src of LIDAR_SOURCES)
    {
        if (src.covers(lat, lon)) return src;
    }
    return null;
}
