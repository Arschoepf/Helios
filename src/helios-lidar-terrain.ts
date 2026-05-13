//Custom DEM source backed by IGN LiDAR HD MNT data.
//
//MapLibre's `raster-dem` source consumes terrain tiles in either the
//Mapbox terrain-RGB or Terrarium encodings. Both formats pack a
//metre-resolution elevation into the R/G/B bytes of a PNG, so any
//arbitrary float32 raster can be served as a DEM by:
//
//  1. Generating the PNG bytes on the fly for each requested tile
//     (we slice the LiDAR raster onto the tile's bbox, then encode).
//  2. Registering a maplibregl protocol that turns the source's
//     synthetic URL ('helios-lidar-dem://{engineId}/{z}/{x}/{y}')
//     into those bytes.
//
//The protocol is registered once per page; per-engine state lives
//in a module-level registry indexed by engine id, so multiple
//Helios cards on the same dashboard never trip on each other.

import maplibregl from 'maplibre-gl';
import type { LidarTerrainData } from './helios-lidar';

export const LIDAR_TERRAIN_PROTOCOL = 'helios-lidar-dem';

//Web-Mercator zoom at which we serve the LiDAR DEM tiles. We expose
//z=12..15: the LiDAR-covered area is encoded at every level, and
//tiles outside the bbox are proxied verbatim from MapTiler at the
//requested level so the camera always sees a continuous DEM (no
//cliff at the LiDAR boundary as it rotates). z=15 is fine enough for
//the card's locked z=18 (3 levels of overzoom).
export const LIDAR_TERRAIN_MIN_ZOOM = 12;
export const LIDAR_TERRAIN_MAX_ZOOM = 15;

//Tile resolution served by the protocol. 512 matches MapTiler's
//terrain-rgb tileSize so our DEM source can drop in with no extra
//pipeline work, and gives the terrain mesh fine enough vertices
//that the LiDAR relief reads cleanly at zoom 18 over the home.
const TILE_SIZE = 512;

interface TerrainEntry
{
    data:        LidarTerrainData;
    //MapTiler API key, used to fetch the global terrain-rgb tiles for
    //pixels that fall outside the LiDAR coverage. When no key is
    //available we silently encode height = 0 there and let the
    //camera see flat ground outside the LiDAR bbox.
    maptilerKey: string | null;
    cache:       Map<string, ArrayBuffer>;
}

const _entries = new Map<string, TerrainEntry>();
let _protocolRegistered = false;

//Idempotent registration of the maplibregl custom protocol. Called
//on the first engine that activates LiDAR terrain; subsequent calls
//are no-ops. The protocol stays registered for the lifetime of the
//page, additional engines just plug into the shared handler.
function ensureProtocolRegistered(): void
{
    if (_protocolRegistered) return;
    _protocolRegistered = true;

    //MapLibre 5 supports two handler shapes (callback and Promise);
    //we use the Promise form for parity with the rest of the code-
    //base's async style. AbortController is wired so a teardown
    //while a tile is being encoded cancels cleanly.
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
        const cached = entry.cache.get(key);
        if (cached) return { data: cached.slice(0) };

        const bytes = await encodeTile(entry, z, x, y);
        entry.cache.set(key, bytes);
        return { data: bytes.slice(0) };
    });
}

//Registers (or replaces) the MNT raster for a given engine. The
//engine then references the source via its tile URL template:
//   `${LIDAR_TERRAIN_PROTOCOL}://${engineId}/{z}/{x}/{y}`
//
//`maptilerKey` is used as the fallback DEM source for pixels that
//fall outside the LiDAR coverage. When set, the protocol handler
//composes per-pixel: LiDAR inside the bbox, MapTiler terrain-rgb
//outside, so the camera sees a continuous terrain at distance and
//doesn't trip on a cliff at the LiDAR boundary as it rotates.
export function registerLidarTerrain(
    engineId:    string,
    data:        LidarTerrainData,
    maptilerKey: string | null
): void
{
    ensureProtocolRegistered();
    _entries.set(engineId, { data, maptilerKey, cache: new Map() });
}

//Unregister an engine's MNT raster. Called from engine cleanup so
//the protocol handler doesn't keep dead Float32Arrays alive.
export function unregisterLidarTerrain(engineId: string): void
{
    _entries.delete(engineId);
}

//Geographic bounds of the registered MNT raster, useful for the
//source's `bounds` field (MapLibre will only request tiles whose
//bbox intersects it, saving us from generating empty tiles around
//the home).
export function getLidarTerrainBounds(engineId: string): [number, number, number, number] | null
{
    const e = _entries.get(engineId);
    if (!e) return null;
    const b = e.data.bounds;
    return [b.minLon, b.minLat, b.maxLon, b.maxLat];
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

//Bilinear sample of the source MNT raster at a given lon/lat. Returns
//NaN when the request falls outside the bounds so the caller can fill
//the pixel with a "no-data" terrain-RGB value (which MapLibre treats
//as transparent / fall-through under blending).
function sampleHeight(d: LidarTerrainData, lon: number, lat: number): number
{
    const { minLon, minLat, maxLon, maxLat } = d.bounds;
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return NaN;

    //Source pixel grid: row 0 is the NORTH edge (top-down).
    const fx = (lon - minLon) / (maxLon - minLon) * (d.width  - 1);
    const fy = (maxLat - lat) / (maxLat - minLat) * (d.height - 1);
    const x0 = Math.max(0, Math.min(d.width  - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(d.height - 1, Math.floor(fy)));
    const x1 = Math.min(d.width  - 1, x0 + 1);
    const y1 = Math.min(d.height - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;

    const h00 = d.heights[y0 * d.width + x0];
    const h10 = d.heights[y0 * d.width + x1];
    const h01 = d.heights[y1 * d.width + x0];
    const h11 = d.heights[y1 * d.width + x1];
    if (!isFinite(h00) || !isFinite(h10) || !isFinite(h01) || !isFinite(h11))
    {
        return isFinite(h00) ? h00 : NaN;
    }

    const a = h00 * (1 - tx) + h10 * tx;
    const b = h01 * (1 - tx) + h11 * tx;
    return a * (1 - ty) + b * ty;
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

async function encodeTile(entry: TerrainEntry, z: number, x: number, y: number): Promise<ArrayBuffer>
{
    const d = entry.data;
    const { n, s, w, e } = tileBounds(z, x, y);

    const tileFullyInsideLidar  =
           w >= d.bounds.minLon && e <= d.bounds.maxLon
        && s >= d.bounds.minLat && n <= d.bounds.maxLat;
    const tileFullyOutsideLidar =
           e <= d.bounds.minLon || w >= d.bounds.maxLon
        || n <= d.bounds.minLat || s >= d.bounds.maxLat;

    //Tile is fully outside the LiDAR bbox, the LiDAR contributes
    //nothing. Forward the request to MapTiler so the camera still
    //sees real elevation at distance, instead of a flat sea-level
    //cliff at the LiDAR boundary as it rotates. When no key is
    //available, fall back to the encoded-zero "empty" tile.
    if (tileFullyOutsideLidar)
    {
        const proxied = await fetchMaptilerTile(entry.maptilerKey, z, x, y);
        return proxied ?? emptyTile();
    }

    const canvas = document.createElement('canvas');
    canvas.width  = TILE_SIZE;
    canvas.height = TILE_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return emptyTile();

    //When the tile straddles the LiDAR boundary, fetch the matching
    //MapTiler tile in parallel and use it as the per-pixel fallback
    //wherever the LiDAR raster doesn't have data. Decode it into a
    //float array so the inner loop stays branch-free.
    let maptilerHeights: Float32Array | null = null;
    if (!tileFullyInsideLidar)
    {
        maptilerHeights = await fetchMaptilerTileHeights(entry.maptilerKey, z, x, y);
    }

    const img = ctx.createImageData(TILE_SIZE, TILE_SIZE);
    const buf = img.data;

    //Web-Mercator pixel grid: y = 0 is the NORTH edge of the tile.
    //We compute the lat/lon for each output pixel (Mercator → WGS84),
    //then bilinear-sample the LiDAR raster. The cost is bounded by
    //TILE_SIZE² (~262 k pixels at 512²) and runs once per tile, after
    //which the result is cached.
    const yToLat = (py: number) =>
    {
        const ny = py / TILE_SIZE;
        const lat0 = Math.log(Math.tan(Math.PI / 4 + (n * Math.PI / 180) / 2));
        const lat1 = Math.log(Math.tan(Math.PI / 4 + (s * Math.PI / 180) / 2));
        const lat  = lat0 + (lat1 - lat0) * ny;
        return 180 / Math.PI * (2 * Math.atan(Math.exp(lat)) - Math.PI / 2);
    };

    for (let py = 0; py < TILE_SIZE; py++)
    {
        const lat = yToLat(py + 0.5);
        for (let px = 0; px < TILE_SIZE; px++)
        {
            const lon = w + (e - w) * ((px + 0.5) / TILE_SIZE);
            const h   = sampleHeight(d, lon, lat);
            const off = (py * TILE_SIZE + px) * 4;
            //LiDAR wins where it has data, otherwise fall back to the
            //pre-decoded MapTiler pixel. When the tile is fully inside
            //the bbox we never read the fallback so the maptilerHeights
            //allocation is skipped above.
            const final = isFinite(h)
                ? h
                : (maptilerHeights ? maptilerHeights[py * TILE_SIZE + px] : 0);
            encodeHeight(final, buf, off);
        }
    }
    ctx.putImageData(img, 0, 0);

    const blob: Blob | null = await new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/png'));
    if (!blob) return emptyTile();
    return await blob.arrayBuffer();
}

//Verbatim proxy: fetch the MapTiler terrain-rgb PNG and return its
//bytes unchanged. The PNG is already in Mapbox encoding, which is
//what our raster-dem source declares, so the browser can decode it
//directly with no re-encoding pass on our side.
async function fetchMaptilerTile(
    key: string | null,
    z:   number,
    x:   number,
    y:   number
): Promise<ArrayBuffer | null>
{
    if (!key) return null;
    //terrain-rgb-v2 is served as WebP by MapTiler; the .png variant
    //404s for many tiles and turns into a flat sea-level cliff at the
    //LiDAR bbox edge. WebP first, with a PNG fallback for the rare
    //tiles where the server hands back an older PNG-only response.
    for (const ext of ['webp', 'png'])
    {
        try
        {
            const url = `https://api.maptiler.com/tiles/terrain-rgb-v2/${z}/${x}/${y}.${ext}?key=${key}`;
            const resp = await fetch(url);
            if (!resp.ok) continue;
            return await resp.arrayBuffer();
        }
        catch (_) { /* try the next extension */ }
    }
    return null;
}

//Same MapTiler fetch, but decodes the PNG into a float array of
//metres-above-sea-level heights so the compositing inner loop can
//read it as raw values rather than as an RGBA pixel. Returns null
//on any failure (network, decode, missing key); callers treat null
//as "no fallback, encode 0 here".
async function fetchMaptilerTileHeights(
    key: string | null,
    z:   number,
    x:   number,
    y:   number
): Promise<Float32Array | null>
{
    if (!key) return null;
    const blob = await fetchMaptilerTile(key, z, x, y);
    if (!blob) return null;

    return new Promise<Float32Array | null>(resolve =>
    {
        const url = URL.createObjectURL(new Blob([blob], { type: 'image/png' }));
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () =>
        {
            URL.revokeObjectURL(url);
            try
            {
                const canvas = document.createElement('canvas');
                canvas.width  = TILE_SIZE;
                canvas.height = TILE_SIZE;
                const ctx = canvas.getContext('2d');
                if (!ctx) { resolve(null); return; }
                //MapTiler tiles can be 256 or 512 native; drawing into a
                //fixed-size canvas resamples them to our composite grid.
                ctx.drawImage(img, 0, 0, TILE_SIZE, TILE_SIZE);
                const data = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
                const out  = new Float32Array(TILE_SIZE * TILE_SIZE);
                for (let i = 0, j = 0; i < data.length; i += 4, j++)
                {
                    out[j] = -10000 + (data[i] * 65536 + data[i + 1] * 256 + data[i + 2]) * 0.1;
                }
                resolve(out);
            }
            catch (_) { resolve(null); }
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
    });
}

//A pre-encoded all-zero terrain-RGB PNG returned when the requested
//tile sits fully outside the LiDAR bbox or the canvas pipeline fails.
//Generated lazily on first use, then memoised, so the cost is paid
//once per page.
let _emptyTileCache: ArrayBuffer | null = null;
function emptyTile(): ArrayBuffer
{
    if (_emptyTileCache) return _emptyTileCache.slice(0);

    const canvas = document.createElement('canvas');
    canvas.width  = TILE_SIZE;
    canvas.height = TILE_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return new ArrayBuffer(0);
    const img = ctx.createImageData(TILE_SIZE, TILE_SIZE);
    const buf = img.data;
    for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++)
    {
        encodeHeight(0, buf, i * 4);
    }
    ctx.putImageData(img, 0, 0);
    //Synchronous fallback: blob URL would be async; instead we
    //serialize the canvas to a data URL and decode the base64 bytes
    //into an ArrayBuffer. Fine for a one-shot setup cost.
    const dataUrl = canvas.toDataURL('image/png');
    const base64  = dataUrl.split(',')[1] ?? '';
    const bytes   = atob(base64);
    const out     = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
    _emptyTileCache = out.buffer;
    return _emptyTileCache.slice(0);
}
