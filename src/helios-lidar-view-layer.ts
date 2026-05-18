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

//Vertex shader. Takes one Mercator triplet per point, filters by
//distance to the home in metres (kept in metres so the user-facing
//`lidar-view-radius` config maps 1:1 to the shader uniform), and sets
//gl_PointSize so the dot occupies the configured pixel area
//regardless of zoom. Off-radius points collapse to PointSize 0 so the
//rasteriser skips them entirely.
const VERT_SRC = `
attribute vec3 a_pos;
uniform mat4  u_matrix;
uniform vec2  u_homeMerc;
uniform float u_mercPerMeter;
uniform float u_radiusMeters;
uniform float u_pointSizePx;
varying float v_inside;

void main() {
    float dxMerc = a_pos.x - u_homeMerc.x;
    float dyMerc = a_pos.y - u_homeMerc.y;
    float dxM = dxMerc / u_mercPerMeter;
    float dyM = dyMerc / u_mercPerMeter;
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
    private _uHomeMerc?:     WebGLUniformLocation;
    private _uMercPerMeter?: WebGLUniformLocation;
    private _uRadius?:       WebGLUniformLocation;
    private _uPointSize?:    WebGLUniformLocation;
    private _uColor?:        WebGLUniformLocation;
    private _uAlphaFade?:    WebGLUniformLocation;

    //Tunables, pushed by the engine on config / fade ticks.
    private _radiusMeters: number = 100;
    private _pointSizePx:  number = 1.5;
    private _color:        [number, number, number, number] = [1, 1, 1, 0.5];
    private _alphaFade:    number = 0;

    //Home position in Mercator. Recomputed when setHome is called so
    //the radius filter stays anchored on the rendered home.
    private _homeMerc: maplibregl.MercatorCoordinate;
    private _mercPerMeter: number;

    //Vertices cached when the engine sets data BEFORE the layer is
    //added to the map. Uploaded to GL the moment onAdd runs.
    private _pendingVerts?: Float32Array;

    constructor(opts: LidarViewLayerOpts)
    {
        this._homeMerc     = maplibregl.MercatorCoordinate.fromLngLat([opts.homeLon, opts.homeLat], 0);
        this._mercPerMeter = this._homeMerc.meterInMercatorCoordinateUnits();
    }

    public setHome(lat: number, lon: number): void
    {
        this._homeMerc     = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0);
        this._mercPerMeter = this._homeMerc.meterInMercatorCoordinateUnits();
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
    public setData(raster: LidarRaster | null): void
    {
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
                verts[n * 3    ] = mc.x;
                verts[n * 3 + 1] = mc.y;
                verts[n * 3 + 2] = mc.z ?? 0;
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

        const vs = this._compileShader(gl, gl.VERTEX_SHADER,   VERT_SRC);
        const fs = this._compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
        const program = gl.createProgram();
        if (!program) throw new Error('LidarViewLayer: createProgram failed');
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        {
            const log = gl.getProgramInfoLog(program) ?? '';
            gl.deleteProgram(program);
            throw new Error(`LidarViewLayer: link failed: ${log}`);
        }
        this._program = program;

        this._aPos          = gl.getAttribLocation(program, 'a_pos');
        this._uMatrix       = gl.getUniformLocation(program, 'u_matrix')       ?? undefined;
        this._uHomeMerc     = gl.getUniformLocation(program, 'u_homeMerc')     ?? undefined;
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
            this._pendingVerts = undefined;
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
        //world coords into clip space.
        const rawMatrix = args.defaultProjectionData?.mainMatrix as ArrayLike<number> | undefined;
        if (!rawMatrix) return;
        const matrix = rawMatrix instanceof Float32Array
            ? rawMatrix
            : Float32Array.from(rawMatrix as ArrayLike<number>);

        gl.useProgram(this._program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
        gl.enableVertexAttribArray(this._aPos);
        gl.vertexAttribPointer(this._aPos, 3, gl.FLOAT, false, 0, 0);

        if (this._uMatrix)       gl.uniformMatrix4fv(this._uMatrix, false, matrix);
        if (this._uHomeMerc)     gl.uniform2f(this._uHomeMerc, this._homeMerc.x, this._homeMerc.y);
        if (this._uMercPerMeter) gl.uniform1f(this._uMercPerMeter, this._mercPerMeter);
        if (this._uRadius)       gl.uniform1f(this._uRadius, this._radiusMeters);
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        if (this._uPointSize)    gl.uniform1f(this._uPointSize, this._pointSizePx * dpr);
        if (this._uColor)        gl.uniform4f(this._uColor, this._color[0], this._color[1], this._color[2], this._color[3]);
        if (this._uAlphaFade)    gl.uniform1f(this._uAlphaFade, this._alphaFade);

        //Standard premultiplied-style alpha blending so the dot cloud
        //composites correctly over the basemap + building extrusions.
        //MapLibre may leave blending state from a previous layer; we
        //force what we need and don't bother restoring (every visible
        //layer sets its own anyway).
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);

        gl.drawArrays(gl.POINTS, 0, this._vertexCount);
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
