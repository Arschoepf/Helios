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
//cell's position relative to the home, in Mercator units) and emits
//a continuous fall-off factor v_alpha based on the cell's metric
//distance to the home: 1 within u_fadeFullMeters, fading down to 0
//at u_fadeOutMeters via a smoothstep. The fragment shader uses
//v_alpha as a multiplier on the layer colour so points near the
//home read at full opacity while the outer disc dissolves into the
//basemap. Lines whose endpoints span the fade band inherit a
//gradient automatically through varying interpolation.
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
attribute vec3  a_pos;
attribute float a_exposure;
uniform mat4  u_matrix;
uniform float u_mercPerMeter;
uniform float u_fadeFullMeters;
uniform float u_fadeOutMeters;
uniform float u_pointSizePx;
varying float v_alpha;
varying float v_exposure;

void main() {
    float dxM = a_pos.x / u_mercPerMeter;
    float dyM = a_pos.y / u_mercPerMeter;
    float d2  = dxM * dxM + dyM * dyM;
    float fullR2 = u_fadeFullMeters * u_fadeFullMeters;
    float fadeR2 = u_fadeOutMeters * u_fadeOutMeters;
    v_alpha    = 1.0 - smoothstep(fullR2, fadeR2, d2);
    v_exposure = a_exposure;
    gl_Position  = u_matrix * vec4(a_pos, 1.0);
    //Collapse the primitive once the alpha is essentially zero so
    //fully-faded points don't waste rasteriser time. The 0.001
    //threshold is below the perceptual floor (1/255 = 0.0039) so
    //nothing visible is dropped.
    gl_PointSize = u_pointSizePx * step(0.001, v_alpha);
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
//Solar-exposure modulation. The vertex shader normalises a per-cell exposure byte to [0, 1]; this controls a brightness multiplier + a warm
//tint applied to the base colour. 1 = sun-lit (full brightness, slight warm shift), 0 = in shadow (dimmed). The defaults are tuned so a
//missing exposure buffer (attribute disabled, vertexAttrib1f(1.0)) produces visuals identical to the pre-exposure render: full lit, neutral
//tint. When the engine starts feeding real exposure data the dimmed cells immediately read as shadow without changing the lit baseline.
uniform float u_exposureLitBoost;
uniform float u_exposureShadowFloor;
uniform vec3  u_exposureWarmTint;
varying float v_alpha;
varying float v_exposure;

void main() {
    //v_alpha is the home-distance fall-off, 1 inside the full radius
    //and dropping to 0 at the fade-out radius. Cells fully past the
    //fade are still discarded so we don't waste blend bandwidth on
    //invisible fragments (and for lines this clips the segment past
    //the boundary cleanly).
    if (v_alpha <= 0.0) discard;
    float lit  = mix(u_exposureShadowFloor, u_exposureLitBoost, v_exposure);
    vec3  warm = mix(vec3(1.0), u_exposureWarmTint, v_exposure);
    vec3  col  = u_color.rgb * lit * warm;
    gl_FragColor = vec4(col, u_color.a * u_alphaFade * v_alpha);
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
    //Vertex buffer (Mercator offsets from home, one triplet per
    //finite cell) and its companion line-topology index buffer
    //(pairs of vertex indices, one per grid edge whose endpoints
    //both have data). Both are uploaded once per setData and reused
    //for every frame: drawArrays(POINTS) for the dot cloud,
    //drawElements(LINES) for the wireframe mesh.
    private _buffer?:      WebGLBuffer;
    private _indexBuffer?: WebGLBuffer;
    //Parallel per-vertex byte buffer carrying the live solar exposure (0 = in shadow, 255 = lit). Sourced from computeLidarCellExposure() in
    //the engine, refreshed via setExposure() whenever the sun moves enough to recompute. When the attribute is disabled (no compute has run
    //yet, sun below horizon, etc.) the vertex shader reads a constant 1.0 via vertexAttrib1f, the fragment shader then renders at the
    //pre-exposure baseline (full lit, neutral tint).
    private _exposureBuffer?: WebGLBuffer;
    private _hasExposure: boolean = false;
    private _vertexCount: number = 0;
    private _lineIdxCount: number = 0;
    //WebGL2 supports UNSIGNED_INT indices natively; on a WebGL1
    //context we probe for OES_element_index_uint at onAdd time. We
    //need 32-bit indices because high-precision rasters reach a few
    //million finite cells and 65536 is too small.
    private _indexType: number = 0;

    private _aPos:      number = -1;
    private _aExposure: number = -1;
    private _uMatrix?:           WebGLUniformLocation;
    private _uMercPerMeter?:     WebGLUniformLocation;
    private _uFadeFull?:         WebGLUniformLocation;
    private _uFadeOut?:          WebGLUniformLocation;
    private _uPointSize?:        WebGLUniformLocation;
    private _uColor?:            WebGLUniformLocation;
    private _uAlphaFade?:        WebGLUniformLocation;
    private _uExposureLit?:      WebGLUniformLocation;
    private _uExposureShadow?:   WebGLUniformLocation;
    private _uExposureWarmTint?: WebGLUniformLocation;
    //Reusable scratch for the per-frame matrix shift, allocated once to avoid garbage on every render call.
    private _shiftedMatrix:  Float32Array = new Float32Array(16);

    //Tunables, pushed by the engine on config / fade ticks. The fade
    //range (full inside .._fadeFullMeters, smoothstep down to 0 at
    //.._fadeOutMeters) lets the cloud sit at full opacity around the
    //home and dissolve into the basemap further out.
    private _fadeFullMeters: number = 100;
    private _fadeOutMeters:  number = 100;
    private _pointSizePx:  number = 1.5;
    private _color:        [number, number, number, number] = [1, 1, 1, 0.5];
    private _alphaFade:    number = 0;
    //Wireframe overlay: same vertices, line topology, independent
    //colour + alpha. Off by default; when on, drawElements(LINES)
    //runs alongside the points draw (the user can dial the point
    //size to 0 to see lines only).
    private _wireframeEnabled: boolean = false;
    private _wireframeColor:   [number, number, number, number] = [1, 1, 1, 0.5];

    //Home position in Mercator. Recomputed when setHome is called so
    //the radius filter stays anchored on the rendered home, and used
    //per-frame as the translation injected into the projection matrix
    //(home-relative buffer trick, see render()).
    private _homeMerc: maplibregl.MercatorCoordinate;
    private _mercPerMeter: number;

    //Vertices + line indices cached when the engine sets data BEFORE the layer is added to the map. Uploaded to GL the moment onAdd runs.
    private _pendingVerts?:    Float32Array;
    private _pendingLineIdx?:  Uint32Array;
    private _pendingExposure?: Uint8Array;
    //Maps a raster-cell index (j * rasterSize + i) to its vertex index in the GPU buffer, or -1 when the cell was NaN at setData time. Cached so
    //setExposure() can translate a per-raster-cell exposure array (engine concern) to the per-vertex order the GPU buffer expects, without
    //asking the engine to know our internal packing.
    private _cellToVert: Int32Array | null = null;
    //Raster reference kept around so setHome can rebuild the buffer against the new origin. Without this, switching homes would leave the cloud
    //anchored at the previous mercator centre.
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
        //Buffer encodes offsets from the previous home, refit it against the new origin so the cloud stays anchored.
        if (this._raster) this.setData(this._raster);
        this._map?.triggerRepaint();
    }

    public setFadeRange(fullMeters: number, fadeOutMeters: number): void
    {
        if (fullMeters === this._fadeFullMeters
         && fadeOutMeters === this._fadeOutMeters) return;
        this._fadeFullMeters = fullMeters;
        this._fadeOutMeters  = fadeOutMeters;
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

    public setWireframeEnabled(on: boolean): void
    {
        if (on === this._wireframeEnabled) return;
        this._wireframeEnabled = on;
        this._map?.triggerRepaint();
    }

    public setWireframeColor(rgba: [number, number, number, number]): void
    {
        this._wireframeColor = rgba;
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

        //Worst-case all-cells-finite allocations. We slice the unused tail off before upload so the GPU buffers only carry real points + real edges.
        const verts = new Float32Array(rasterSize * rasterSize * 3);
        //cellToVert maps a (j*R + i) cell index to its index in the
        //vertex stream, or -1 when the cell was NaN. Needed so the
        //line-topology pass can connect adjacent finite cells.
        const cellToVert = new Int32Array(rasterSize * rasterSize);
        let n = 0;

        for (let j = 0; j < rasterSize; j++)
        {
            const cLat = maxLat - (j + 0.5) * pxLat;
            for (let i = 0; i < rasterSize; i++)
            {
                const idx = j * rasterSize + i;
                const h = heights[idx];
                if (!isFinite(h))
                {
                    cellToVert[idx] = -1;
                    continue;
                }
                const cLon = minLon + (i + 0.5) * pxLon;
                const mc   = maplibregl.MercatorCoordinate.fromLngLat([cLon, cLat], h);
                verts[n * 3    ] = mc.x       - homeX;
                verts[n * 3 + 1] = mc.y       - homeY;
                verts[n * 3 + 2] = (mc.z ?? 0) - homeZ;
                cellToVert[idx]  = n;
                n++;
            }
        }
        this._vertexCount = n;
        const used = n > 0 ? verts.subarray(0, n * 3) : new Float32Array(0);

        //Wireframe topology: for every finite cell, emit an edge to
        //the cell on its right (i+1, j) and below (i, j+1) when those
        //neighbours are also finite. Each grid edge appears once, so
        //the dataset stays at most ~2*N entries.
        const maxEdges = Math.max(0, n * 2);
        const lineIdx  = new Uint32Array(maxEdges * 2);
        let li = 0;
        for (let j = 0; j < rasterSize; j++)
        {
            for (let i = 0; i < rasterSize; i++)
            {
                const v = cellToVert[j * rasterSize + i];
                if (v < 0) continue;
                if (i + 1 < rasterSize)
                {
                    const vR = cellToVert[j * rasterSize + (i + 1)];
                    if (vR >= 0)
                    {
                        lineIdx[li++] = v;
                        lineIdx[li++] = vR;
                    }
                }
                if (j + 1 < rasterSize)
                {
                    const vD = cellToVert[(j + 1) * rasterSize + i];
                    if (vD >= 0)
                    {
                        lineIdx[li++] = v;
                        lineIdx[li++] = vD;
                    }
                }
            }
        }
        this._lineIdxCount = li;
        const lineUsed = li > 0 ? lineIdx.subarray(0, li) : new Uint32Array(0);
        //Cache the cellToVert mapping for the next setExposure() call. Reset _hasExposure since the previous exposure (sized to the old
        //vertex count) is stale, the next compute pass will refit and re-upload.
        this._cellToVert  = cellToVert;
        this._hasExposure = false;

        if (this._gl && this._buffer)
        {
            const gl = this._gl;
            gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
            gl.bufferData(gl.ARRAY_BUFFER, used, gl.STATIC_DRAW);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            if (this._indexBuffer)
            {
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer);
                gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lineUsed, gl.STATIC_DRAW);
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
            }
            //Shrink the exposure buffer to the new vertex count so a render that lands before the next compute doesn't read stale bytes from
            //a longer buffer (the attribute is fall-back-constant via vertexAttrib1f when _hasExposure is false anyway, but keeping the buffer
            //sized to vertexCount means we can flip _hasExposure on without a re-allocation roundtrip).
            if (this._exposureBuffer)
            {
                gl.bindBuffer(gl.ARRAY_BUFFER, this._exposureBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, n, gl.STATIC_DRAW);
                gl.bindBuffer(gl.ARRAY_BUFFER, null);
            }
        }
        else
        {
            //Layer not yet onAdd'd; stash so the upload runs the
            //moment we get a GL context.
            this._pendingVerts   = used;
            this._pendingLineIdx = lineUsed;
        }
        this._map?.triggerRepaint();
    }


    //Accept a per-raster-cell exposure byte array (length = rasterSize²) coming from computeLidarCellExposure(). Maps it through the cached
    //cellToVert into a per-vertex byte array, uploads to the GPU and flips _hasExposure so the next render reads from a_exposure instead of
    //the constant fallback. Passing null clears the override.
    public setExposure(perCellExposure: Uint8Array | null): void
    {
        if (!perCellExposure || !this._cellToVert || this._vertexCount === 0)
        {
            this._hasExposure  = false;
            this._pendingExposure = undefined;
            this._map?.triggerRepaint();
            return;
        }
        const vertExposure = new Uint8Array(this._vertexCount);
        const c2v = this._cellToVert;
        const N   = c2v.length;
        for (let i = 0; i < N; i++)
        {
            const v = c2v[i];
            if (v >= 0) vertExposure[v] = perCellExposure[i] ?? 255;
        }
        if (this._gl && this._exposureBuffer)
        {
            this._gl.bindBuffer(this._gl.ARRAY_BUFFER, this._exposureBuffer);
            this._gl.bufferData(this._gl.ARRAY_BUFFER, vertExposure, this._gl.STATIC_DRAW);
            this._gl.bindBuffer(this._gl.ARRAY_BUFFER, null);
            this._hasExposure = true;
        }
        else
        {
            this._pendingExposure = vertExposure;
        }
        this._map?.triggerRepaint();
    }

    public onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void
    {
        this._map = map;
        this._gl  = gl;

        //onAdd must leave GL in a clean state on every exit path. A partial shader compile / link that throws while a buffer is bound or an attribute
        //is enabled pollutes the painter's assumptions and the basemap renders to garbage until the page is refreshed. Catch our own errors, free
        //anything we allocated, and re-throw so the surrounding try / catch in _initLidarViewLayer reports it without breaking the rest of the map
        //setup.
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

            this._aPos              = gl.getAttribLocation(program, 'a_pos');
            this._aExposure         = gl.getAttribLocation(program, 'a_exposure');
            this._uMatrix           = gl.getUniformLocation(program, 'u_matrix')           ?? undefined;
            this._uMercPerMeter     = gl.getUniformLocation(program, 'u_mercPerMeter')     ?? undefined;
            this._uFadeFull         = gl.getUniformLocation(program, 'u_fadeFullMeters')   ?? undefined;
            this._uFadeOut          = gl.getUniformLocation(program, 'u_fadeOutMeters')    ?? undefined;
            this._uPointSize        = gl.getUniformLocation(program, 'u_pointSizePx')      ?? undefined;
            this._uColor            = gl.getUniformLocation(program, 'u_color')            ?? undefined;
            this._uAlphaFade        = gl.getUniformLocation(program, 'u_alphaFade')        ?? undefined;
            this._uExposureLit      = gl.getUniformLocation(program, 'u_exposureLitBoost') ?? undefined;
            this._uExposureShadow   = gl.getUniformLocation(program, 'u_exposureShadowFloor') ?? undefined;
            this._uExposureWarmTint = gl.getUniformLocation(program, 'u_exposureWarmTint') ?? undefined;

            this._buffer = gl.createBuffer() ?? undefined;
            if (this._pendingVerts && this._buffer)
            {
                gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
                gl.bufferData(gl.ARRAY_BUFFER, this._pendingVerts, gl.STATIC_DRAW);
                gl.bindBuffer(gl.ARRAY_BUFFER, null);
                this._pendingVerts = undefined;
            }

            this._exposureBuffer = gl.createBuffer() ?? undefined;
            if (this._pendingExposure && this._exposureBuffer)
            {
                gl.bindBuffer(gl.ARRAY_BUFFER, this._exposureBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, this._pendingExposure, gl.STATIC_DRAW);
                gl.bindBuffer(gl.ARRAY_BUFFER, null);
                this._hasExposure  = this._pendingExposure.length === this._vertexCount;
                this._pendingExposure = undefined;
            }

            //Index buffer for the wireframe overlay. WebGL2 has
            //native 32-bit index support; WebGL1 needs the
            //OES_element_index_uint extension. We always need 32-bit
            //because high-precision rasters reach a few million
            //finite cells, well past the 16-bit cap. When the
            //extension is unavailable (very rare today), the
            //wireframe stays disabled; points keep working as the
            //setLines path short-circuits on _indexType === 0.
            const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined'
                          && gl instanceof WebGL2RenderingContext;
            const has32Idx = isWebGL2
                          || !!gl.getExtension('OES_element_index_uint');
            this._indexType = has32Idx ? gl.UNSIGNED_INT : 0;
            if (has32Idx)
            {
                this._indexBuffer = gl.createBuffer() ?? undefined;
                if (this._pendingLineIdx && this._indexBuffer)
                {
                    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer);
                    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this._pendingLineIdx, gl.STATIC_DRAW);
                    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
                    this._pendingLineIdx = undefined;
                }
            }
        }
        catch (err)
        {
            //Tear down whatever managed to allocate before the throw, so MapLibre's next layer sees a clean GL state.
            try { gl.bindBuffer(gl.ARRAY_BUFFER, null); } catch (_) {}
            try { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null); } catch (_) {}
            if (this._buffer)
            {
                try { gl.deleteBuffer(this._buffer); } catch (_) {}
                this._buffer = undefined;
            }
            if (this._indexBuffer)
            {
                try { gl.deleteBuffer(this._indexBuffer); } catch (_) {}
                this._indexBuffer = undefined;
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
        //Skip the draw when fully transparent. Saves a pipeline setup per frame while the user has the LiDAR View toggled off.
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

        //a_exposure: byte attribute normalised to [0, 1], or a constant 1.0 fallback when no compute has run yet. Wrap the constant set in a
        //disableVertexAttribArray so subsequent layers can't inherit our enabled state and read garbage out of an unrelated buffer.
        if (this._aExposure >= 0)
        {
            if (this._hasExposure && this._exposureBuffer)
            {
                gl.bindBuffer(gl.ARRAY_BUFFER, this._exposureBuffer);
                gl.enableVertexAttribArray(this._aExposure);
                gl.vertexAttribPointer(this._aExposure, 1, gl.UNSIGNED_BYTE, true, 0, 0);
                gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
            }
            else
            {
                gl.disableVertexAttribArray(this._aExposure);
                gl.vertexAttrib1f(this._aExposure, 1.0);
            }
        }

        if (this._uMatrix)       gl.uniformMatrix4fv(this._uMatrix, false, this._shiftedMatrix);
        if (this._uMercPerMeter) gl.uniform1f(this._uMercPerMeter, this._mercPerMeter);
        if (this._uFadeFull)     gl.uniform1f(this._uFadeFull, this._fadeFullMeters);
        if (this._uFadeOut)      gl.uniform1f(this._uFadeOut,  this._fadeOutMeters);
        //Exposure tone controls. Lit cells get a 1.0 multiplier (no change to the base colour) shaded toward a warm 1.0/0.85/0.6 tint; shadowed
        //cells get dimmed to 35 % brightness with a neutral tint. Values picked so the "lit vs in shadow" contrast reads at a glance without the
        //shadow cells fading below visibility under the home-distance fall-off.
        if (this._uExposureLit)      gl.uniform1f(this._uExposureLit, 1.0);
        if (this._uExposureShadow)   gl.uniform1f(this._uExposureShadow, 0.35);
        if (this._uExposureWarmTint) gl.uniform3f(this._uExposureWarmTint, 1.0, 0.85, 0.6);
        //gl_PointSize is measured in framebuffer pixels. MapLibre
        //sizes its framebuffer at map.getPixelRatio() x CSS, which the
        //user can clamp via the `pixel-ratio` config (1x on mobile to
        //save GPU). window.devicePixelRatio diverges from that on any
        //device where the clamp kicks in (iOS DPR 3 with framebuffer
        //at 1.25x), so dots come out 2-3x too big. Asking MapLibre
        //directly keeps the dots at the same CSS size across devices.
        const pixelRatio = this._map?.getPixelRatio?.()
                        ?? ((typeof window !== 'undefined' && window.devicePixelRatio) || 1);
        if (this._uPointSize)    gl.uniform1f(this._uPointSize, this._pointSizePx * pixelRatio);
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

        //Points pass. Skipped when the user dialed point size to 0
        //(typical wireframe-only setup): gl_PointSize at 0 already
        //collapses each primitive, but bypassing the call also saves
        //the vertex shader work.
        if (this._uColor && this._pointSizePx > 0)
        {
            gl.uniform4f(this._uColor, this._color[0], this._color[1], this._color[2], this._color[3]);
            gl.drawArrays(gl.POINTS, 0, this._vertexCount);
        }

        //Wireframe pass. Same vertex buffer, line topology from the index buffer. The radius filter still applies via v_inside in the fragment
        //shader: lines whose endpoints are both outside the radius go away, lines crossing the boundary fade to clipped at the edge.
        if (this._wireframeEnabled
         && this._indexBuffer
         && this._indexType !== 0
         && this._lineIdxCount > 0
         && this._uColor)
        {
            gl.uniform4f(this._uColor,
                this._wireframeColor[0],
                this._wireframeColor[1],
                this._wireframeColor[2],
                this._wireframeColor[3]
            );
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer);
            gl.drawElements(gl.LINES, this._lineIdxCount, this._indexType, 0);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        }
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
        if (this._buffer)      gl.deleteBuffer(this._buffer);
        if (this._indexBuffer) gl.deleteBuffer(this._indexBuffer);
        if (this._program)     gl.deleteProgram(this._program);
        this._buffer      = undefined;
        this._indexBuffer = undefined;
        this._program     = undefined;
        this._indexType   = 0;
        this._gl          = undefined;
        this._map         = undefined;
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
