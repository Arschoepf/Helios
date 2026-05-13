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
    //Hard limit on the haversine distance from the home, in metres.
    //Cells beyond this are dropped so the rendered vegetation disc
    //matches the buildings disc. Provider implementations still fetch
    //a padded bbox so shadows of trees on the edge can extend inward.
    cropRadiusMeters?: number;
    //Home polygons from MapTiler. Cells whose centre falls inside any
    //of these (after BUILDING_MASK_PAD_M inflation) are CLASSIFIED as
    //'home' rather than filtered. The engine uses the per-cell LiDAR
    //height for the rendered home extrusion, with the MapTiler
    //footprint kept only for the ground-level outline.
    homeFootprints?:         GeoJSON.FeatureCollection;
    //Surrounding-building polygons from MapTiler. Cells inside any of
    //these are classified as 'building'.
    surroundingFootprints?:  GeoJSON.FeatureCollection;
    signal?:      AbortSignal;
}

//A LiDAR feature is one Polygon cell with a height and a kind that
//tells the renderer how to colour / layer it. Providers must set
//`kind` on every emitted feature.
export type LidarCellKind = 'home' | 'building' | 'vegetation';

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
