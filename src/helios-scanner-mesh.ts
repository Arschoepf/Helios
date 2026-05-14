//WebGL custom layer that draws a 3D textured mesh of the LiDAR
//surface, one sub-mesh per loaded LiDAR tile.
//
//Each tile that comes back from the provider is turned into:
//  - a vertex grid covering the tile bbox, with Z = MNS height
//    (full LiDAR surface) lifted by SCANNER_LIFT_M so the mesh
//    floats just above the actual terrain mesh and stays visible
//    when the camera looks down on it
//  - a triangle index buffer (two triangles per quad)
//  - a UV stream mapping each vertex to a pixel in the per-tile
//    irradiance texture, which colour-codes the cell by how much
//    sunlight it receives at the selected time
//
//The layer registers as a MapLibre CustomLayerInterface so it sits
//in the same render pipeline as the basemap; it picks up MapLibre's
//projection matrix every frame and projects the vertices itself
//through a tiny WebGL program.
//
//Irradiance compute lives here too: when the scanner is toggled on
//(or the sun moves), we recompute the per-pixel colour buffer for
//every loaded tile and upload it as the tile's texture.

import maplibregl from 'maplibre-gl';
import type { LidarTileData } from './helios-lidar';
import { getSunPosition, computeIrradianceWm2 } from './helios-sun';

const SCANNER_LIFT_M = 0.1;     // metres above each MNS vertex

//----------------------------------------------------------------- shaders

const VERT_SRC = `
attribute vec3 a_pos;
attribute vec2 a_uv;
uniform mat4 u_matrix;
varying vec2 v_uv;
void main()
{
    gl_Position = u_matrix * vec4(a_pos, 1.0);
    v_uv = a_uv;
}
`;

const FRAG_SRC = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_opacity;
void main()
{
    vec4 c = texture2D(u_texture, v_uv);
    gl_FragColor = vec4(c.rgb, c.a * u_opacity);
}
`;

//----------------------------------------------------------------- helpers

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null
{
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
    {
        console.warn('[HELIOS] scanner shader compile failed:', gl.getShaderInfoLog(sh));
        gl.deleteShader(sh);
        return null;
    }
    return sh;
}

function linkProgram(gl: WebGLRenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram | null
{
    const p = gl.createProgram();
    if (!p) return null;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    {
        console.warn('[HELIOS] scanner program link failed:', gl.getProgramInfoLog(p));
        gl.deleteProgram(p);
        return null;
    }
    return p;
}

interface SubMesh
{
    vbo:        WebGLBuffer;
    ibo:        WebGLBuffer;
    indexCount: number;
    indexType:  number;     //gl.UNSIGNED_SHORT or gl.UNSIGNED_INT
    texture:    WebGLTexture;
    width:      number;
    height:     number;
}

//----------------------------------------------------------------- options

export interface ScannerMeshOptions
{
    //Card-side context. Both are read every compute pass.
    homeLat:    number;
    homeLon:    number;
    sunColorLow:  string;
    sunColorHigh: string;
    //Optional clouds % used in the GHI computation.
    cloudCover: number;
    //Initial opacity. Use updateOpacity() to change after add.
    opacity:    number;
    //Time the scanner should colour-code for. Updated by the engine
    //on scrub + sun-tick.
    time:       Date;
}

//----------------------------------------------------------------- layer

export class ScannerMeshLayer implements maplibregl.CustomLayerInterface
{
    public readonly id:             string;
    public readonly type:           'custom' = 'custom';
    public readonly renderingMode:  '3d'     = '3d';

    private _gl?:           WebGLRenderingContext | WebGL2RenderingContext;
    private _map?:          maplibregl.Map;
    private _program:       WebGLProgram | null = null;
    private _aPos          = 0;
    private _aUv           = 0;
    private _uMatrix:       WebGLUniformLocation | null = null;
    private _uTexture:      WebGLUniformLocation | null = null;
    private _uOpacity:      WebGLUniformLocation | null = null;
    private _uint32Indices  = false;

    //Sub-mesh per loaded tile, keyed by the protocol's tile id.
    private _subMeshes = new Map<string, SubMesh>();
    //Cached tile data, kept here so the layer can rebuild textures
    //without going back through the protocol module.
    private _tiles     = new Map<string, LidarTileData>();
    //User-intent visibility flag, drives early-return in render().
    //We never add / remove the layer to flip visibility (that would
    //tear down the GL context on every toggle); the layer stays on
    //the map and just skips the draw call when hidden.
    private _visible             = false;
    //One-shot guard so the "first render" diagnostic only fires
    //once per layer lifetime.
    private _didLogFirstRender   = false;

    private _opts: ScannerMeshOptions;

    constructor(id: string, opts: ScannerMeshOptions)
    {
        this.id    = id;
        this._opts = opts;
    }

    //CustomLayerInterface ---------------------------------------------

    onAdd(map: maplibregl.Map, gl: WebGLRenderingContext | WebGL2RenderingContext): void
    {
        this._map = map;
        this._gl  = gl;

        const isGl2 = typeof (gl as WebGL2RenderingContext).createVertexArray === 'function';
        this._uint32Indices = isGl2 || !!gl.getExtension('OES_element_index_uint');

        const vs = compileShader(gl, gl.VERTEX_SHADER,   VERT_SRC);
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
        if (!vs || !fs)
        {
            console.warn('[HELIOS-SCAN] onAdd: shader compile failed');
            return;
        }
        this._program = linkProgram(gl, vs, fs);
        if (!this._program)
        {
            console.warn('[HELIOS-SCAN] onAdd: program link failed');
            return;
        }

        this._aPos     = gl.getAttribLocation(this._program, 'a_pos');
        this._aUv      = gl.getAttribLocation(this._program, 'a_uv');
        this._uMatrix  = gl.getUniformLocation(this._program, 'u_matrix');
        this._uTexture = gl.getUniformLocation(this._program, 'u_texture');
        this._uOpacity = gl.getUniformLocation(this._program, 'u_opacity');

        console.info(
            `[HELIOS-SCAN] onAdd: ok (gl${isGl2 ? '2' : '1'}, uint32=${this._uint32Indices}, ` +
            `attribs pos=${this._aPos} uv=${this._aUv}, pending tiles=${this._tiles.size})`
        );

        //Rebuild any tiles that landed before the GL context was up.
        const pending = Array.from(this._tiles.entries());
        this._tiles.clear();
        for (const [key, data] of pending) this.addTile(key, data);
    }

    render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: maplibregl.CustomRenderMethodInput): void
    {
        if (!this._visible) return;
        if (!this._program) return;
        if (this._subMeshes.size === 0) return;
        if (!this._didLogFirstRender)
        {
            this._didLogFirstRender = true;
            console.info(`[HELIOS-SCAN] first render: visible, ${this._subMeshes.size} submeshes`);
        }
        const matrix = args.modelViewProjectionMatrix;

        gl.useProgram(this._program);
        gl.enable(gl.BLEND);
        //Pre-multiplied alpha would look slightly cleaner over the
        //terrain, but our textures come in plain RGBA from a canvas
        //so straight-alpha blending matches the source 1:1.
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        //Depth test ON so the mesh respects MapLibre's terrain Z;
        //depth write OFF so subsequent transparent layers (HTML
        //overlays etc.) don't get masked.
        gl.depthMask(false);
        gl.enable(gl.DEPTH_TEST);

        gl.uniformMatrix4fv(this._uMatrix, false, matrix as unknown as Float32List);
        gl.uniform1f(this._uOpacity, this._opts.opacity);
        gl.uniform1i(this._uTexture, 0);

        this._subMeshes.forEach(mesh =>
        {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, mesh.texture);

            gl.bindBuffer(gl.ARRAY_BUFFER,         mesh.vbo);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);

            gl.vertexAttribPointer(this._aPos, 3, gl.FLOAT, false, 20, 0);
            gl.vertexAttribPointer(this._aUv,  2, gl.FLOAT, false, 20, 12);
            gl.enableVertexAttribArray(this._aPos);
            gl.enableVertexAttribArray(this._aUv);

            gl.drawElements(gl.TRIANGLES, mesh.indexCount, mesh.indexType, 0);
        });
    }

    onRemove(_map: maplibregl.Map, gl: WebGLRenderingContext | WebGL2RenderingContext): void
    {
        this._subMeshes.forEach(mesh =>
        {
            gl.deleteBuffer(mesh.vbo);
            gl.deleteBuffer(mesh.ibo);
            gl.deleteTexture(mesh.texture);
        });
        this._subMeshes.clear();
        if (this._program) gl.deleteProgram(this._program);
        this._program = null;
        this._gl  = undefined;
        this._map = undefined;
    }

    //Public API -------------------------------------------------------

    //Push a tile's data in: build the sub-mesh geometry (once) and
    //paint its first irradiance texture.
    addTile(key: string, data: LidarTileData): void
    {
        this._tiles.set(key, data);
        const gl = this._gl;
        if (!gl || !this._program)
        {
            console.info(`[HELIOS-SCAN] addTile(${key}): buffered (gl=${!!gl}, program=${!!this._program})`);
            return;
        }

        //Tear down any previous mesh for the same key (e.g. same
        //tile re-fetched at a higher precision).
        this._destroySubMesh(key);

        const sub = this._buildSubMesh(gl, data);
        if (!sub)
        {
            console.warn(`[HELIOS-SCAN] addTile(${key}): buildSubMesh returned null`);
            return;
        }
        this._subMeshes.set(key, sub);

        //First-paint the texture so the user sees something the
        //frame the tile lands, rather than waiting on a compute pass.
        this._paintTexture(key, data);

        console.info(`[HELIOS-SCAN] addTile(${key}): mesh built (${data.width}x${data.height}, ${sub.indexCount} indices)`);

        this._map?.triggerRepaint();
    }

    //Refresh every loaded tile's texture from the current sun
    //position + the cached colour-ramp config. Cheap enough to run
    //synchronously on a scrub or a tick (~10-50 ms / tile).
    refreshTextures(time: Date, cloudCover: number, lowHex: string, highHex: string): void
    {
        this._opts.time         = time;
        this._opts.cloudCover   = cloudCover;
        this._opts.sunColorLow  = lowHex;
        this._opts.sunColorHigh = highHex;
        this._tiles.forEach((data, key) => this._paintTexture(key, data));
        this._map?.triggerRepaint();
    }

    updateOpacity(opacity: number): void
    {
        this._opts.opacity = Math.max(0, Math.min(1, opacity));
        this._map?.triggerRepaint();
    }

    setVisible(v: boolean): void
    {
        console.info(`[HELIOS-SCAN] setVisible(${v}), submeshes=${this._subMeshes.size}, tiles=${this._tiles.size}`);
        this._visible = v;
        this._map?.triggerRepaint();
    }

    isVisible(): boolean
    {
        return this._visible;
    }

    clear(): void
    {
        const gl = this._gl;
        if (gl)
        {
            this._subMeshes.forEach(mesh =>
            {
                gl.deleteBuffer(mesh.vbo);
                gl.deleteBuffer(mesh.ibo);
                gl.deleteTexture(mesh.texture);
            });
        }
        this._subMeshes.clear();
        this._tiles.clear();
        this._map?.triggerRepaint();
    }

    hasTiles(): boolean
    {
        return this._tiles.size > 0;
    }

    //Internals --------------------------------------------------------

    private _destroySubMesh(key: string): void
    {
        const mesh = this._subMeshes.get(key);
        const gl   = this._gl;
        if (!mesh || !gl) return;
        gl.deleteBuffer(mesh.vbo);
        gl.deleteBuffer(mesh.ibo);
        gl.deleteTexture(mesh.texture);
        this._subMeshes.delete(key);
    }

    //Generate a flat grid of vertices over the tile bbox, with Z =
    //MNS height (full LiDAR surface) + a 10 cm lift. Two triangles
    //per quad. UVs map each vertex to its raster cell.
    private _buildSubMesh(gl: WebGLRenderingContext | WebGL2RenderingContext, data: LidarTileData): SubMesh | null
    {
        const W = data.width;
        const H = data.height;
        const nVerts = W * H;
        const nQuads = (W - 1) * (H - 1);
        const nTris  = nQuads * 2;
        const nIdx   = nTris * 3;

        const buf = new Float32Array(nVerts * 5);
        //Average lat of the tile drives the metres-to-Mercator
        //conversion factor used for the elevation component.
        const midLat   = (data.bounds.minLat + data.bounds.maxLat) * 0.5;
        const mcOrigin = maplibregl.MercatorCoordinate.fromLngLat([data.bounds.minLon, midLat], 0);
        const meterScale = mcOrigin.meterInMercatorCoordinateUnits();

        for (let j = 0; j < H; j++)
        {
            const v = (j + 0.5) / H;
            const lat = data.bounds.maxLat - (j + 0.5) * (data.bounds.maxLat - data.bounds.minLat) / H;
            for (let i = 0; i < W; i++)
            {
                const u = (i + 0.5) / W;
                const lon = data.bounds.minLon + (i + 0.5) * (data.bounds.maxLon - data.bounds.minLon) / W;
                const idx = j * W + i;
                const h   = data.mns[idx];
                const elev = (isFinite(h) ? h : data.mnt[idx]) + SCANNER_LIFT_M;

                const mc = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0);
                const off = idx * 5;
                buf[off    ] = mc.x;
                buf[off + 1] = mc.y;
                buf[off + 2] = elev * meterScale;
                buf[off + 3] = u;
                buf[off + 4] = v;
            }
        }

        const vbo = gl.createBuffer();
        if (!vbo) return null;
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);

        let indexArr: Uint16Array | Uint32Array;
        let indexType: number;
        if (this._uint32Indices && nVerts > 65535)
        {
            indexArr  = new Uint32Array(nIdx);
            indexType = gl.UNSIGNED_INT;
        }
        else
        {
            indexArr  = new Uint16Array(nIdx);
            indexType = gl.UNSIGNED_SHORT;
        }

        let p = 0;
        for (let j = 0; j < H - 1; j++)
        {
            for (let i = 0; i < W - 1; i++)
            {
                const a = j * W + i;
                const b = a + 1;
                const c = a + W;
                const d = c + 1;
                indexArr[p++] = a; indexArr[p++] = b; indexArr[p++] = c;
                indexArr[p++] = b; indexArr[p++] = d; indexArr[p++] = c;
            }
        }

        const ibo = gl.createBuffer();
        if (!ibo) { gl.deleteBuffer(vbo); return null; }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexArr, gl.STATIC_DRAW);

        //Initial empty texture, paintTexture fills it right away.
        const texture = gl.createTexture();
        if (!texture) { gl.deleteBuffer(vbo); gl.deleteBuffer(ibo); return null; }
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
        const empty = new Uint8Array(W * H * 4);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, empty);

        return {
            vbo,
            ibo,
            indexCount: nIdx,
            indexType,
            texture,
            width:      W,
            height:     H
        };
    }

    private _paintTexture(key: string, data: LidarTileData): void
    {
        const gl   = this._gl;
        const mesh = this._subMeshes.get(key);
        if (!gl || !mesh) return;

        const buf = this._computeTextureBytes(data);
        gl.bindTexture(gl.TEXTURE_2D, mesh.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, data.width, data.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    }

    //Per-pixel irradiance compute, identical algorithm to the old
    //raster scanner but scoped to one tile. Cross-tile shadow walks
    //are intentionally skipped here: a tile's shadow ray cast only
    //reads cells in its own raster, which means the very edge of a
    //tile may underestimate shadows for trees that sit in the next
    //tile over. The visual gap is sub-pixel at the camera's typical
    //distance; the simplicity wins.
    private _computeTextureBytes(data: LidarTileData): Uint8Array
    {
        const W      = data.width;
        const H      = data.height;
        const mnt    = data.mnt;
        const mns    = data.mns;
        const pitchM = data.cellPitchM;
        const bounds = data.bounds;

        const out = new Uint8Array(W * H * 4);

        const lowRgb  = parseHex(this._opts.sunColorLow,  [0xdc, 0x26, 0x26]);
        const highRgb = parseHex(this._opts.sunColorHigh, [0x16, 0xa3, 0x4a]);

        const sun = getSunPosition(this._opts.time, this._opts.homeLat, this._opts.homeLon);
        const D       = Math.PI / 180;
        const azR     = sun.azimuth  * D;
        const altR    = Math.max(0, sun.altitude) * D;
        const cosAlt  = Math.cos(altR);
        const sinAlt  = Math.sin(altR);
        const sx      = Math.sin(azR) * cosAlt;
        const sy      = Math.cos(azR) * cosAlt;
        const sz      = sinAlt;

        const ghi     = sun.altitude > 0
            ? computeIrradianceWm2(this._opts.time, this._opts.homeLat, this._opts.homeLon, this._opts.cloudCover)
            : 0;
        const ghiNorm = Math.min(1, ghi / 1000);

        const dCol      = Math.sin(azR);
        const dRow      = -Math.cos(azR);
        const stepRiseM = pitchM * Math.tan(altR);
        const RAY_MAX   = 200;

        const cosLat     = Math.cos(((bounds.minLat + bounds.maxLat) * 0.5) * D);
        const pxLatM     = ((bounds.maxLat - bounds.minLat) / H) * 111_320;
        const pxLonM     = ((bounds.maxLon - bounds.minLon) / W) * (111_320 * cosLat);

        const isInShadow = (col0: number, row0: number, h0: number): boolean =>
        {
            for (let k = 1; k <= RAY_MAX; k++)
            {
                const ci = (col0 + k * dCol) | 0;
                const ri = (row0 + k * dRow) | 0;
                if (ci < 0 || ci >= W || ri < 0 || ri >= H) return false;
                const idx = ri * W + ci;
                const blockerH = mns[idx];
                const sunLineH = h0 + k * stepRiseM;
                if (blockerH > sunLineH + 0.5) return true;
                if (sunLineH > h0 + 100) return false;
            }
            return false;
        };

        for (let j = 0; j < H; j++)
        {
            const rowOff = j * W;
            const jm = j > 0     ? j - 1 : j;
            const jp = j < H - 1 ? j + 1 : j;
            for (let i = 0; i < W; i++)
            {
                const off = (rowOff + i) * 4;
                const im = i > 0     ? i - 1 : i;
                const ip = i < W - 1 ? i + 1 : i;

                //Surface normal from the MNT gradient (the bare-earth
                //orientation; using MNS would give a near-vertical
                //normal at every tree edge and dark out the canopy,
                //which is not what we want, the user sees this as
                //"how does sun hit the ground in this cell").
                const gradX = (mnt[rowOff + ip] - mnt[rowOff + im]) / (2 * pxLonM);
                const gradY = (mnt[jm * W + i]  - mnt[jp * W + i])  / (2 * pxLatM);
                const nl = Math.hypot(gradX, gradY, 1);
                const nx = -gradX / nl;
                const ny = -gradY / nl;
                const nz =      1 / nl;

                const cosI = sun.altitude > 0
                    ? Math.max(0, nx * sx + ny * sy + nz * sz)
                    : 0;

                let ratio = 0;
                if (cosI > 0 && ghi > 0)
                {
                    if (!isInShadow(i + 0.5, j + 0.5, mnt[rowOff + i]))
                    {
                        ratio = cosI * ghiNorm;
                        if (ratio > 1) ratio = 1;
                    }
                }

                out[off    ] = Math.round(lowRgb[0] + (highRgb[0] - lowRgb[0]) * ratio);
                out[off + 1] = Math.round(lowRgb[1] + (highRgb[1] - lowRgb[1]) * ratio);
                out[off + 2] = Math.round(lowRgb[2] + (highRgb[2] - lowRgb[2]) * ratio);
                out[off + 3] = 255;
            }
        }

        return out;
    }
}

//----------------------------------------------------------------- shared

function parseHex(v: string, fallback: [number, number, number]): [number, number, number]
{
    const s = v.trim().replace('#', '');
    if (s.length !== 6) return fallback;
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return fallback;
    return [r, g, b];
}
