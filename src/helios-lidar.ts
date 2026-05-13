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

    //Fetch + consolidate height data around the home. Implementations
    //decode whatever wire format the upstream API exposes, threshold
    //by height, classify cells against the supplied building
    //footprints, and return:
    //
    //  - `regions`: one Polygon per connected region (NOT per cell);
    //    the engine consumes these as shadow-projector input, the
    //    polygons themselves are never rendered. Each emitted feature
    //    must carry numeric `render_height` and `render_min_height`
    //    properties (helios-shadows.ts contract).
    //
    //  - `cells`: one Point per classified cell, used to render the
    //    optional "scanner" point cloud overlay. Each feature carries
    //    `height` (m above ground) and `kind` ('home' | 'building' |
    //    'vegetation') properties.
    //
    //  - `terrain`: optional raw bare-earth (MNT) heights for the
    //    same bbox. When provided, the engine builds a custom DEM
    //    source that replaces the MapTiler terrain in the home area.
    //    Null when the provider has no MNT data or the second fetch
    //    failed; the engine then falls back to MapTiler's global DEM.
    fetch(opts: LidarFetchOptions): Promise<LidarFetchResult>;
}

export interface LidarFetchResult
{
    regions: GeoJSON.FeatureCollection;
    cells:   GeoJSON.FeatureCollection;
    terrain: LidarTerrainData | null;
    //Half-spacing of the terrain-cell grid in metres. The engine uses
    //this to size the ground tiles so they tile cleanly with a small
    //overlap, rather than leaving readable gaps between cells.
    terrainCellHalfM: number;
}

export interface LidarTerrainData
{
    //Bare-earth (MNT) heights in metres above mean sea level. Row-
    //major, top-down (row 0 = NORTH edge of `bounds`). Length must
    //equal width * height.
    heights: Float32Array;
    width:   number;
    height:  number;
    bounds:  { minLon: number; minLat: number; maxLon: number; maxLat: number };
}

export interface LidarFetchOptions
{
    homeLat:      number;
    homeLon:      number;
    radiusMeters: number;
    //Pixel count per side requested from the upstream raster. Higher
    //means finer ground sampling, larger payload and more work in the
    //consolidation pass. The engine derives this from the user-set
    //shadow-precision level (helios-engine.ts:SHADOW_PRECISION_RASTER).
    rasterSize:   number;
    //Hard limit on the haversine distance from the home, in metres.
    //Cells beyond this are dropped so the rendered shadow zones stay
    //inside the visible disc. Providers still fetch a padded bbox so
    //edge features can still cast their shadow inward.
    cropRadiusMeters?: number;
    //MapTiler home polygons. Cells inside (after BUILDING_MASK_PAD_M
    //inflation) are classified as 'home', else cells inside a
    //surroundingFootprints polygon become 'building', else 'vegetation'.
    homeFootprints?:        GeoJSON.FeatureCollection;
    surroundingFootprints?: GeoJSON.FeatureCollection;
    signal?:                AbortSignal;
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
