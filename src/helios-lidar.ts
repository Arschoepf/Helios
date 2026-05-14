//Common interface and registry for country-specific LiDAR providers.
//
//Adding a country = drop a new file under ./helios-lidar/ that exports
//a LidarSource and register it in LIDAR_SOURCES below. No engine-side
//changes needed.
//
//The pipeline is tile-driven: MapLibre asks the custom DEM protocol
//for terrain tiles, and each tile triggers one `fetchTile` call on
//the matching provider. Providers return MNT (bare-earth) AND MNS
//(full surface) rasters for the requested bbox, both decoded at the
//same resolution; the protocol encodes MNT as terrain-RGB for the
//mesh and the scanner layer reads MNS for its 3D mesh + texture.

export interface LidarSource
{
    //Stable identifier, lowercased and country-prefixed. Goes into
    //logs and the tile-cache key.
    id:    string;
    //Human-readable label, currently logs-only.
    name:  string;

    //Cheap synchronous coverage probe. Implementations should bail
    //fast (a couple of bbox comparisons) so the engine can call this
    //on every home-position change without measurable cost.
    covers(lat: number, lon: number): boolean;

    //Fetch one tile's MNT + MNS rasters in parallel. Returns null on
    //any network / decode failure, or when the requested bbox falls
    //outside the provider's coverage. The protocol caches the result
    //per (z, x, y) so MapLibre's repeated requests don't trigger
    //repeat WMS calls.
    fetchTile(opts: LidarTileFetchOptions): Promise<LidarTileData | null>;
}

export interface LidarTileFetchOptions
{
    minLat:     number;
    minLon:     number;
    maxLat:     number;
    maxLon:     number;
    //Pixel count per side requested from the upstream raster. The
    //protocol picks this based on the user's `lidar-precision`.
    rasterSize: number;
    signal?:    AbortSignal;
}

export interface LidarTileData
{
    //Raster dimensions; same for MNT and MNS, both decode at
    //`rasterSize` (square).
    width:  number;
    height: number;
    //Geographic bounds of the tile (matches the requested bbox).
    //Row 0 is the north edge (`maxLat`).
    bounds: { minLon: number; minLat: number; maxLon: number; maxLat: number };
    //Average ground-cell size in metres (mean of lon / lat pitch).
    //Used by the scanner mesh to set its in-tile sun ray-walk step.
    cellPitchM: number;
    //Bare-earth elevation (MNT). Row-major, top-down.
    mnt: Float32Array;
    //Full surface elevation (MNS): ground + every above-ground feature
    //LiDAR picked up (vegetation, buildings, walls, hedges, ...).
    //Same orientation as `mnt`.
    mns: Float32Array;
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
