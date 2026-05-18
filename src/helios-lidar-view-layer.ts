//WebGL custom MapLibre layer for the LiDAR View dot cloud.
//
//Replaces the previous 2D-canvas pipeline (CPU projection of every
//cell each transform + Path2D bake + drawImage per frame), which hit
//its ceiling around a few hundred thousand points. The custom layer
//uploads the cell positions to the GPU once per raster fetch; each
//frame is then one drawArrays(POINTS) call with the camera matrix
//handled by the shader. Scales to millions of points without breaking
//a sweat, and auto-rotate stops being expensive because no per-frame
//CPU re-projection happens at all.
//
//The buffer holds Mercator x / y / z per cell. Heights stay in metres
//on the source side and are scaled by meterInMercatorCoordinateUnits
//at upload time so the vertex shader can multiply by MapLibre's
//projection matrix directly. Only finite cells are uploaded; NaNs are
//dropped at build-time rather than discarded in the shader.

import maplibregl from 'maplibre-gl';
import type {
    CustomLayerInterface,
    CustomRenderMethodInput,
    Map as MapLibreMap
} from 'maplibre-gl';

//Vertex shader. Takes one Mercator-offset triplet per point (each
//cell's position relative to the home, in Mercator units), filters by
//distance to the home in metres, and sets gl_PointSize so the dot
//occupies the configured pixel area regardless of zoom. Off-radius
//points collapse to PointSize 0 so the rasteriser skips them.
//
//The matrix is *already* shifted to be home-relative: the host JS
//pre-multiplies MapLibre's projection matrix by a translation to the
//home in float64, then sends the combined mat4 as the uniform. That
//shift is what keeps the per-vertex math precise: storing absolute
//Mercator coords (~0.5 + tiny per-cell deltas) puts the deltas at the
//edge of float32's mantissa and the per-frame matrix-times-vec4
//product jitters by a pixel or two each rotation step. With offsets
//(~1e-6 worst case), float32 has plenty of headroom and the cloud
//stays rock-solid as the camera moves.
const VERT_SRC = `
precision highp float;
attribute vec3 a_pos;
uniform mat4  u_matrix;
uniform float u_mercPerMeter;
uniform float u_radiusMeters;
uniform float u_pointSizePx;
varying float v_inside;

void main() {
    float dxM = a_pos.x / u_mercPerMeter;
    float dyM = a_pos.y / u_mercPerMeter;
    float d2  = dxM * dxM + dyM * dyM;
    float r2  = u_radiusMeters * u_radiusMeters;
    v_inside  = step(d2, r2);
    gl_Position  = u_matrix * vec4(a_pos, 1.0);
    gl_PointSize = u_pointSizePx * v_inside;
}
`;

//Fragment shader. discard when outside the radius (the v_inside guard
//is redundant given gl_PointSize=0 already collapses the primitive,
//but keeps the shader robust to driver quirks where a 0-sized point
//may still issue a fragment). Solid colour modulated by the fade
//alpha; blending is set up in the host JS so the colour can stay
//premultiplied here.
const FRAG_SRC = `
precision mediump float;
uniform vec4  u_color;
uniform float u_alphaFade;
varying float v_inside;

void main() {
    if (v_inside < 0.5) discard;
    gl_FragColor = vec4(u_color.rgb, u_color.a * u_alphaFade);
}
`;

export interface LidarViewLayerOpts
{
    homeLat: number;
    homeLon: number;
}

//Raw raster shape forwarded from the LiDAR providers.
export interface LidarRaster
{
    heights:    Float32Array;
    rasterSize: number;
    minLat:     number;
    maxLat:     number;
    minLon:     number;
    maxLon:     number;
}

export class LidarViewLayer implements CustomLayerInterface
{
    public readonly id: string = 'helios-lidar-view';
    public readonly type: 'custom' = 'custom';
    public readonly renderingMode: '2d' = '2d';

    private _map?:    MapLibreMap;
    private _gl?:     WebGLRenderingContext | WebGL2RenderingContext;
    private _program?: WebGLProgram;
    private _buffer?:  WebGLBuffer;
    private _vertexCount: number = 0;

    private _aPos: number = -1;
    private _uMatrix?:       WebGLUniformLocation;
    private _uMercPerMeter?: WebGLUniformLocation;
    private _uRadius?:       WebGLUniformLocation;
    private _uPointSize?:    WebGLUniformLocation;
    private _uColor?:        WebGLUniformLocation;
    private _uAlphaFade?:    WebGLUniformLocation;
    //Reusable scratch for the per-frame matrix shift, allocated once
    //to avoid garbage on every render call.
    private _shiftedMatrix:  Float32Array = new Float32Array(16);

    //Tunables, pushed by the engine on config / fade ticks.
    private _radiusMeters: number = 100;
    private _pointSizePx:  number = 1.5;
    private _color:        [number, number, number, number] = [1, 1, 1, 0.5];
    private _alphaFade:    number = 0;

    //Home position in Mercator. Recomputed when setHome is called so
    //the radius filter stays anchored on the rendered home, and used
    //per-frame as the translation injected into the projection matrix
    //(home-relative buffer trick, see render()).
    private _homeMerc: maplibregl.MercatorCoordinate;
    private _mercPerMeter: number;

    //Vertices cached when the engine sets data BEFORE the layer is
    //added to the map. Uploaded to GL the moment onAdd runs.
    private _pendingVerts?: Float32Array;
    //Raster reference kept around so setHome can rebuild the buffer
    //against the new origin. Without this, switching homes would
    //leave the cloud anchored at the previous mercator centre.
    private _raster: LidarRaster | null = null;

    constructor(opts: LidarViewLayerOpts)
    {
        this._homeMerc     = maplibregl.MercatorCoordinate.fromLngLat([opts.homeLon, opts.homeLat], 0);
        this._mercPerMeter = this._homeMerc.meterInMercatorCoordinateUnits();
    }

    public setHome(lat: number, lon: number): void
    {
        this._homeMerc     = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0);
        this._mercPerMeter = this._homeMerc.meterInMercatorCoordinateUnits();
        //Buffer encodes offsets from the previous home, refit it
        //against the new origin so the cloud stays anchored.
        if (this._raster) this.setData(this._raster);
        this._map?.triggerRepaint();
    }

    public setRadiusMeters(r: number): void
    {
        if (r === this._radiusMeters) return;
        this._radiusMeters = r;
        this._map?.triggerRepaint();
    }

    public setPointSizePx(px: number): void
    {
        if (px === this._pointSizePx) return;
        this._pointSizePx = px;
        this._map?.triggerRepaint();
    }

    public setColor(rgba: [number, number, number, number]): void
    {
        this._color = rgba;
        this._map?.triggerRepaint();
    }

    //Fade multiplier in [0..1]. 0 = invisible (shortcut: no draw call).
    public setAlphaFade(a: number): void
    {
        const clamped = Math.max(0, Math.min(1, a));
        if (clamped === this._alphaFade) return;
        this._alphaFade = clamped;
        this._map?.triggerRepaint();
    }

    //Rebuild the GPU buffer from a fresh height raster. Only finite
    //cells are uploaded; NaN sentinels (no-data) are dropped at build
    //time so the shader never sees them.
    //
    //Each cell is encoded as a Mercator OFFSET from the home origin
    //in float64 first, then truncated to float32. With offsets in the
    //~1e-6 range (a few hundred metres at typical lats), float32 has
    //plenty of mantissa for sub-metre placement; storing absolute
    //Mercator coords (~0.5 + small delta) quantises adjacent cells to
    //the same float32 value and produces the diagonal moiré bands you
    //get on the ground layer at high precision.
    public setData(raster: LidarRaster | null): void
    {
        this._raster = raster;

        if (!raster || raster.rasterSize <= 0)
        {
            this._vertexCount = 0;
            this._pendingVerts = undefined;
            if (this._gl && this._buffer)
            {
                this._gl.bindBuffer(this._gl.ARRAY_BUFFER, this._buffer);
                this._gl.bufferData(this._gl.ARRAY_BUFFER, 0, this._gl.STATIC_DRAW);
            }
            this._map?.triggerRepaint();
            return;
        }

        const { heights, rasterSize, minLat, maxLat, minLon, maxLon } = raster;
        const pxLon = (maxLon - minLon) / rasterSize;
        const pxLat = (maxLat - minLat) / rasterSize;
        //Home Mercator captured here as float64; the subtraction below
        //runs in float64 (JS Number) so each cell's offset reaches the
        //buffer with full double precision before float32 truncation.
        const homeX = this._homeMerc.x;
        const homeY = this._homeMerc.y;
        const homeZ = this._homeMerc.z ?? 0;

        //Worst-case all-cells-finite allocation. We slice the unused
        //tail off before upload so the GPU buffer only carries real
        //points.
        const verts = new Float32Array(rasterSize * rasterSize * 3);
        let n = 0;

        for (let j = 0; j < rasterSize; j++)
        {
            const cLat = maxLat - (j + 0.5) * pxLat;
            for (let i = 0; i < rasterSize; i++)
            {
                const h = heights[j * rasterSize + i];
                if (!isFinite(h)) continue;
                const cLon = minLon + (i + 0.5) * pxLon;
                const mc   = maplibregl.MercatorCoordinate.fromLngLat([cLon, cLat], h);
                verts[n * 3    ] = mc.x       - homeX;
                verts[n * 3 + 1] = mc.y       - homeY;
                verts[n * 3 + 2] = (mc.z ?? 0) - homeZ;
                n++;
            }
        }
        this._vertexCount = n;
        const used = n > 0 ? verts.subarray(0, n * 3) : new Float32Array(0);

        if (this._gl && this._buffer)
        {
            this._gl.bindBuffer(this._gl.ARRAY_BUFFER, this._buffer);
            this._gl.bufferData(this._gl.ARRAY_BUFFER, used, this._gl.STATIC_DRAW);
        }
        else
        {
            //Layer not yet onAdd'd; stash so the upload runs the
            //moment we get a GL context.
            this._pendingVerts = used;
        }
        this._map?.triggerRepaint();
    }

    public onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void
    {
        this._map = map;
        this._gl  = gl;

        //onAdd must leave GL in a clean state on every exit path. A
        //partial shader compile / link that throws while a buffer is
        //bound or an attribute is enabled pollutes the painter's
        //assumptions and the basemap renders to garbage until the
        //page is refreshed. Catch our own errors, free anything we
        //allocated, and re-throw so the surrounding try / catch in
        //_initLidarViewLayer reports it without breaking the rest of
        //the map setup.
        let vs: WebGLShader | null = null;
        let fs: WebGLShader | null = null;
        let program: WebGLProgram | null = null;
        try
        {
            vs = this._compileShader(gl, gl.VERTEX_SHADER,   VERT_SRC);
            fs = this._compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
            program = gl.createProgram();
            if (!program) throw new Error('LidarViewLayer: createProgram failed');
            gl.attachShader(program, vs);
            gl.attachShader(program, fs);
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS))
            {
                const log = gl.getProgramInfoLog(program) ?? '';
                throw new Error(`LidarViewLayer: link failed: ${log}`);
            }
            this._program = program;

            this._aPos          = gl.getAttribLocation(program, 'a_pos');
            this._uMatrix       = gl.getUniformLocation(program, 'u_matrix')       ?? undefined;
            this._uMercPerMeter = gl.getUniformLocation(program, 'u_mercPerMeter') ?? undefined;
            this._uRadius       = gl.getUniformLocation(program, 'u_radiusMeters') ?? undefined;
            this._uPointSize    = gl.getUniformLocation(program, 'u_pointSizePx')  ?? undefined;
            this._uColor        = gl.getUniformLocation(program, 'u_color')        ?? undefined;
            this._uAlphaFade    = gl.getUniformLocation(program, 'u_alphaFade')    ?? undefined;

            this._buffer = gl.createBuffer() ?? undefined;
            if (this._pendingVerts && this._buffer)
            {
                gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
                gl.bufferData(gl.ARRAY_BUFFER, this._pendingVerts, gl.STATIC_DRAW);
                gl.bindBuffer(gl.ARRAY_BUFFER, null);
                this._pendingVerts = undefined;
            }
        }
        catch (err)
        {
            //Tear down whatever managed to allocate before the throw,
            //so MapLibre's next layer sees a clean GL state.
            try { gl.bindBuffer(gl.ARRAY_BUFFER, null); } catch (_) {}
            if (this._buffer)
            {
                try { gl.deleteBuffer(this._buffer); } catch (_) {}
                this._buffer = undefined;
            }
            if (program)
            {
                try { gl.deleteProgram(program); } catch (_) {}
            }
            if (vs) try { gl.deleteShader(vs); } catch (_) {}
            if (fs) try { gl.deleteShader(fs); } catch (_) {}
            this._program = undefined;
            throw err;
        }
    }

    public render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void
    {
        if (!this._program || !this._buffer) return;
        if (this._vertexCount === 0) return;
        //Skip the draw when fully transparent. Saves a pipeline setup
        //per frame while the user has the LiDAR View toggled off.
        if (this._alphaFade <= 0) return;

        //MapLibre passes a projection matrix that maps Mercator [0..1]
        //world coords into clip space. The buffer stores home-relative
        //offsets, so we inject a translation by the home Mercator
        //into the matrix before uploading. The math runs in float64
        //(JS Number) so the combined matrix carries the home shift
        //without losing precision on the way to the float32 uniform.
        const rawMatrix = args.defaultProjectionData?.mainMatrix as ArrayLike<number> | undefined;
        if (!rawMatrix) return;
        this._buildShiftedMatrix(rawMatrix);

        gl.useProgram(this._program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
        gl.enableVertexAttribArray(this._aPos);
        gl.vertexAttribPointer(this._aPos, 3, gl.FLOAT, false, 0, 0);

        if (this._uMatrix)       gl.uniformMatrix4fv(this._uMatrix, false, this._shiftedMatrix);
        if (this._uMercPerMeter) gl.uniform1f(this._uMercPerMeter, this._mercPerMeter);
        if (this._uRadius)       gl.uniform1f(this._uRadius, this._radiusMeters);
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        if (this._uPointSize)    gl.uniform1f(this._uPointSize, this._pointSizePx * dpr);
        if (this._uColor)        gl.uniform4f(this._uColor, this._color[0], this._color[1], this._color[2], this._color[3]);
        if (this._uAlphaFade)    gl.uniform1f(this._uAlphaFade, this._alphaFade);

        //Reset the GL state we depend on. MapLibre's other layers can
        //leave stencil + depth tests enabled and a non-default
        //blendFunc behind; without explicit resets we'd inherit them
        //and see flickering points or a clipped overlay near the
        //screen edges.
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.CULL_FACE);

        gl.drawArrays(gl.POINTS, 0, this._vertexCount);
    }

    //Build `mainMatrix * translation(homeMerc)` directly in the
    //pre-allocated Float32Array uniform target. The product simplifies
    //because translation(t) only touches the last column of the
    //identity, so only mat[12..15] need recomputing; the rotation /
    //scale block (mat[0..11]) carries over unchanged. Done in JS so
    //the home shift is added in float64 before any float32 truncation
    //happens, which is what saves the per-cell precision near the
    //ground (otherwise neighbouring cells quantise to the same float
    //and you get diagonal moiré bands at high precision).
    private _buildShiftedMatrix(src: ArrayLike<number>): void
    {
        const tx = this._homeMerc.x;
        const ty = this._homeMerc.y;
        const tz = this._homeMerc.z ?? 0;
        const out = this._shiftedMatrix;
        out[ 0] = src[ 0]; out[ 1] = src[ 1]; out[ 2] = src[ 2]; out[ 3] = src[ 3];
        out[ 4] = src[ 4]; out[ 5] = src[ 5]; out[ 6] = src[ 6]; out[ 7] = src[ 7];
        out[ 8] = src[ 8]; out[ 9] = src[ 9]; out[10] = src[10]; out[11] = src[11];
        out[12] = src[ 0] * tx + src[ 4] * ty + src[ 8] * tz + src[12];
        out[13] = src[ 1] * tx + src[ 5] * ty + src[ 9] * tz + src[13];
        out[14] = src[ 2] * tx + src[ 6] * ty + src[10] * tz + src[14];
        out[15] = src[ 3] * tx + src[ 7] * ty + src[11] * tz + src[15];
    }

    public onRemove(_map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void
    {
        if (this._buffer)  gl.deleteBuffer(this._buffer);
        if (this._program) gl.deleteProgram(this._program);
        this._buffer  = undefined;
        this._program = undefined;
        this._gl      = undefined;
        this._map     = undefined;
    }

    private _compileShader(gl: WebGLRenderingContext | WebGL2RenderingContext, type: number, src: string): WebGLShader
    {
        const sh = gl.createShader(type);
        if (!sh) throw new Error('LidarViewLayer: createShader failed');
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
        {
            const log = gl.getShaderInfoLog(sh) ?? '';
            gl.deleteShader(sh);
            throw new Error(`LidarViewLayer: compile failed: ${log}`);
        }
        return sh;
    }
}
