//Custom DEM source backed by IGN LiDAR HD MNT data, served per tile
//to mirror MapTiler's terrain-rgb tile pattern: MapLibre asks for
//(z, x, y), we compute the tile's WGS84 bbox, fire ONE provider call
//for both MNT (terrain-RGB encoding target) and MNS (scanner mesh
//source), encode MNT into the Mapbox terrain-RGB scheme, and hand
//the bytes back. MNS stays cached for the scanner mesh layer.
//
//There is NO MapTiler fallback. In LiDAR mode the terrain is pure
//LiDAR. Tiles outside the provider's coverage return a transparent
//empty tile, the camera then sees flat ground (sea level) there.
//
//The protocol is registered once per page; per-engine state lives
//in a module-level registry indexed by engine id, so multiple
//Helios cards on the same dashboard never trip on each other.

import maplibregl from 'maplibre-gl';
import type { LidarSource, LidarTileData } from './helios-lidar';

export const LIDAR_TERRAIN_PROTOCOL = 'helios-lidar-dem';

//Web-Mercator zoom range the source advertises. minzoom = 12 so the
//camera at far distance still gets LiDAR data; maxzoom = 14 keeps
//each tile bbox bounded (a z=14 tile is ~480 m wide at the equator),
//then MapLibre auto-overzooms for the card's locked z=18 viewing.
export const LIDAR_TERRAIN_MIN_ZOOM = 12;
export const LIDAR_TERRAIN_MAX_ZOOM = 14;

//Per-tile raster size by `lidar-precision`. Lower = cheaper IGN
//round-trip, higher = finer terrain mesh + scanner texture. The
//engine pulls this through registerLidarTerrain.
export const PRECISION_TILE_RASTER: Record<string, number> = {
    low:    256,
    medium: 384,
    high:   512,
    ultra:  768
};

interface TerrainEntry
{
    source:     LidarSource;
    rasterSize: number;
    //Loaded tiles, keyed by `${z}/${x}/${y}`. Holds the LiDAR raster
    //data the scanner mesh reads + the encoded terrain-RGB bytes
    //(cached so subsequent identical requests return synchronously).
    tiles:      Map<string, TileEntry>;
    onTileLoaded?: (key: string, data: LidarTileData) => void;
}

interface TileEntry
{
    data:       LidarTileData;
    terrainPng: ArrayBuffer;
}

const _entries = new Map<string, TerrainEntry>();
let _protocolRegistered = false;

//Idempotent registration of the maplibregl custom protocol.
function ensureProtocolRegistered(): void
{
    if (_protocolRegistered) return;
    _protocolRegistered = true;

    maplibregl.addProtocol(LIDAR_TERRAIN_PROTOCOL, async (req: { url: string }) =>
    {
        //URL shape: helios-lidar-dem://{engineId}/{z}/{x}/{y}
        const rest = req.url.replace(`${LIDAR_TERRAIN_PROTOCOL}://`, '');
        const parts = rest.split('/');
        if (parts.length < 4)
        {
            return { data: new ArrayBuffer(0) };
        }
        const engineId = parts[0];
        const z = parseInt(parts[1], 10);
        const x = parseInt(parts[2], 10);
        const y = parseInt(parts[3], 10);

        const entry = _entries.get(engineId);
        if (!entry || !Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y))
        {
            return { data: emptyTile() };
        }

        const key = `${z}/${x}/${y}`;
        const cached = entry.tiles.get(key);
        if (cached) return { data: cached.terrainPng.slice(0) };

        //Compute the tile's WGS84 bbox, fire one provider fetch.
        const { n, s, w, e } = tileBounds(z, x, y);
        const tile = await entry.source.fetchTile({
            minLat:     s,
            minLon:     w,
            maxLat:     n,
            maxLon:     e,
            rasterSize: entry.rasterSize
        });
        if (!tile) return { data: emptyTile() };

        const terrainPng = await encodeTerrainRgb(tile);
        const stored: TileEntry = { data: tile, terrainPng };
        entry.tiles.set(key, stored);

        //Notify the engine so the scanner mesh layer can build (or
        //rebuild) the sub-mesh for this tile right away.
        try { entry.onTileLoaded?.(key, tile); }
        catch (_) {}

        return { data: terrainPng.slice(0) };
    });
}

//Register / replace a provider for a given engine. The engine then
//references the source via its tile URL template:
//   `${LIDAR_TERRAIN_PROTOCOL}://${engineId}/{z}/{x}/{y}`
//`onTileLoaded` fires once per fresh fetch (cache hits don't re-fire),
//giving the engine a hook to wake up the scanner mesh layer for the
//newly available tile.
export function registerLidarTerrain(
    engineId:     string,
    source:       LidarSource,
    rasterSize:   number,
    onTileLoaded: (key: string, data: LidarTileData) => void
): void
{
    ensureProtocolRegistered();
    _entries.set(engineId, {
        source,
        rasterSize: Math.max(64, Math.round(rasterSize)),
        tiles:      new Map(),
        onTileLoaded
    });
}

//Unregister an engine's entry. Called from engine cleanup so the
//protocol handler doesn't keep dead arrays alive.
export function unregisterLidarTerrain(engineId: string): void
{
    _entries.delete(engineId);
}

//Iterate the loaded tiles for an engine. The scanner mesh layer
//reads this snapshot when it builds / refreshes its geometry.
export function getLoadedLidarTiles(engineId: string): Array<{ key: string; data: LidarTileData }>
{
    const out: Array<{ key: string; data: LidarTileData }> = [];
    const entry = _entries.get(engineId);
    if (!entry) return out;
    entry.tiles.forEach((te, key) => out.push({ key, data: te.data }));
    return out;
}

//Look up one specific tile by key.
export function getLidarTile(engineId: string, key: string): LidarTileData | null
{
    return _entries.get(engineId)?.tiles.get(key)?.data ?? null;
}

//----------------------------------------------------------------- helpers

//Mapbox terrain-RGB: height_m = -10000 + (R*65536 + G*256 + B) * 0.1
function encodeHeight(h: number, out: Uint8ClampedArray, off: number): void
{
    const v = Math.max(0, Math.round((h + 10000) * 10));
    out[off    ] = (v >> 16) & 0xff;
    out[off + 1] = (v >>  8) & 0xff;
    out[off + 2] =  v        & 0xff;
    out[off + 3] = 255;
}

//Web Mercator tile bbox in degrees (n + s + w + e). Standard XYZ
//convention: tile (0, 0) at the chosen zoom sits at the NW corner.
function tileBounds(z: number, x: number, y: number): {
    n: number; s: number; w: number; e: number
}
{
    const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
    const s = Math.PI - 2 * Math.PI * (y + 1) / Math.pow(2, z);
    const w = x       / Math.pow(2, z) * 360 - 180;
    const e = (x + 1) / Math.pow(2, z) * 360 - 180;
    const toLat = (rad: number) => 180 / Math.PI * Math.atan(0.5 * (Math.exp(rad) - Math.exp(-rad)));
    return { n: toLat(n), s: toLat(s), w, e };
}

//Encode the tile's MNT into a Mapbox terrain-RGB PNG. The output
//size matches the LiDAR raster (no Web-Mercator reprojection: at
//z >= 12 the raster's WGS84 sampling is close enough to Mercator
//that the residual ~1 m offset doesn't visibly bend the terrain).
async function encodeTerrainRgb(tile: LidarTileData): Promise<ArrayBuffer>
{
    const W = tile.width;
    const H = tile.height;
    const canvas = document.createElement('canvas');
    canvas.width  = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return emptyTile();

    const img = ctx.createImageData(W, H);
    const buf = img.data;
    const mnt = tile.mnt;
    for (let i = 0; i < W * H; i++)
    {
        const h = mnt[i];
        encodeHeight(isFinite(h) ? h : 0, buf, i * 4);
    }
    ctx.putImageData(img, 0, 0);

    const blob: Blob | null = await new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/png'));
    if (!blob) return emptyTile();
    return await blob.arrayBuffer();
}

//Pre-encoded all-zero terrain-RGB PNG returned when a tile request
//can't be satisfied. Memoised after the first use.
let _emptyTileCache: ArrayBuffer | null = null;
function emptyTile(): ArrayBuffer
{
    if (_emptyTileCache) return _emptyTileCache.slice(0);
    const SIZE = 256;
    const canvas = document.createElement('canvas');
    canvas.width  = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return new ArrayBuffer(0);
    const img = ctx.createImageData(SIZE, SIZE);
    const buf = img.data;
    for (let i = 0; i < SIZE * SIZE; i++) encodeHeight(0, buf, i * 4);
    ctx.putImageData(img, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    const base64  = dataUrl.split(',')[1] ?? '';
    const bytes   = atob(base64);
    const out     = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
    _emptyTileCache = out.buffer;
    return _emptyTileCache.slice(0);
}
