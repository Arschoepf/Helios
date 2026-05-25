//Float32 GeoTIFF fetch + decode helper, used by every provider that
//exposes its LiDAR raster as image/tiff (UK, NL, NO, ES). The IGN
//French provider stays on the BIL float32 fast path because its WMS
//advertises that format directly.
//
//We resample the decoded raster to exactly `rasterSize × rasterSize`
//via nearest-neighbour because the upstream WCS / WMS may return a
//slightly off-by-one grid (some servers round bbox to native pixel
//edges instead of honouring the requested width/height precisely).
//Nearest-neighbour is correct for height samples (averaging would
//bleed building edges over open ground).

import { fromArrayBuffer } from 'geotiff';

export async function fetchFloat32GeoTiff(
    url:        string,
    rasterSize: number,
    signal?:    AbortSignal
): Promise<Float32Array | null>
{
    let resp: Response;
    try
    {
        resp = await fetch(url, { signal });
    }
    catch (_)
    {
        return null;
    }
    if (!resp.ok) return null;

    let buf: ArrayBuffer;
    try { buf = await resp.arrayBuffer(); }
    catch (_) { return null; }

    //A short response is likely an XML error page (ServiceException),
    //not a binary GeoTIFF. Bail rather than feed garbage to the parser.
    if (buf.byteLength < 200) return null;

    let tiff;
    try
    {
        tiff = await fromArrayBuffer(buf);
    }
    catch (_)
    {
        return null;
    }

    let image;
    try
    {
        image = await tiff.getImage();
    }
    catch (_)
    {
        return null;
    }

    let rasters;
    try
    {
        //width/height force-resample to the requested grid so the
        //caller can index by (j × rasterSize + i) without having to
        //track the upstream's actual returned size.
        rasters = await image.readRasters({
            width:  rasterSize,
            height: rasterSize,
            interleave: false,
            samples: [0]
        });
    }
    catch (_)
    {
        return null;
    }

    //readRasters returns either a typed array (single sample) or an
    //array of typed arrays. Normalise to a single Float32Array.
    let band: ArrayLike<number>;
    if (Array.isArray(rasters))
    {
        if (rasters.length === 0) return null;
        band = rasters[0] as ArrayLike<number>;
    }
    else
    {
        band = rasters as unknown as ArrayLike<number>;
    }

    if (band instanceof Float32Array)
    {
        return band;
    }

    //Convert any other numeric typed array (Float64, Int16, UInt16)
    //into a Float32Array so downstream math is uniform.
    const out = new Float32Array(band.length);
    for (let i = 0; i < band.length; i++)
    {
        out[i] = band[i];
    }
    return out;
}

//Substract two equally-sized rasters element-wise (DSM minus DTM →
//height-above-ground). NaN propagates through, so a no-data cell on
//either input drops the corresponding output, which the pipeline then
//skips.
export function subtractRasters(
    dsm: Float32Array,
    dtm: Float32Array
): Float32Array
{
    const N = Math.min(dsm.length, dtm.length);
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++)
    {
        const d  = dsm[i];
        const g  = dtm[i];
        const dh = d - g;
        out[i] = (isFinite(dh) && dh >= 0) ? dh : NaN;
    }
    return out;
}

//Same byte path as fetchFloat32GeoTiff() but also returns the
//GDAL_NODATA sentinel parsed from the GeoTIFF metadata (or null when
//the tag is absent), the band 1 data, AND the band 2 data when the
//source COG ships one (the helios-lidar.org pipeline outputs a
//2-band COG with band 1 = nDSM, band 2 = DTM). Used by the local-
//nDSM provider so it can map nodata cells to NaN before the shared
//pipeline runs; the public providers stay on the simpler helper
//above and keep their existing byte-for-byte behaviour.
export async function fetchFloat32GeoTiffWithNoData(
    url:        string,
    rasterSize: number,
    signal?:    AbortSignal
): Promise<{ data: Float32Array; terrain: Float32Array | null; noData: number | null } | null>
{
    let resp: Response;
    try
    {
        resp = await fetch(url, { signal });
    }
    catch (_)
    {
        return null;
    }
    if (!resp.ok) return null;

    let buf: ArrayBuffer;
    try { buf = await resp.arrayBuffer(); }
    catch (_) { return null; }

    if (buf.byteLength < 200) return null;

    let tiff;
    try { tiff = await fromArrayBuffer(buf); }
    catch (_) { return null; }

    let image;
    try { image = await tiff.getImage(); }
    catch (_) { return null; }

    //getGDALNoData() returns the parsed GDAL_NODATA tag as a number,
    //or null when the tag is absent. Some older geotiff.js versions
    //expose it as a synchronous accessor; guard the call so a missing
    //method does not break the fetch.
    let noData: number | null = null;
    try
    {
        const anyImg = image as unknown as { getGDALNoData?: () => number | null };
        if (typeof anyImg.getGDALNoData === 'function')
        {
            const raw = anyImg.getGDALNoData();
            noData = (typeof raw === 'number' && Number.isFinite(raw)) ? raw : null;
        }
    }
    catch (_) { noData = null; }

    //Probe the source band count so we can read band 2 (DTM) only
    //when it actually exists. Current helios-lidar.org COGs ship
    //2 bands; legacy single-band COGs uploaded earlier or built
    //from a single-band source expose only band 1, and
    //getSamplesPerPixel returns 1.
    let sampleCount = 1;
    try
    {
        const anyImg = image as unknown as { getSamplesPerPixel?: () => number };
        if (typeof anyImg.getSamplesPerPixel === 'function')
        {
            const n = anyImg.getSamplesPerPixel();
            if (typeof n === 'number' && n >= 1) sampleCount = n;
        }
    }
    catch (_) { sampleCount = 1; }
    const wantBands = sampleCount >= 2 ? [0, 1] : [0];

    let rasters;
    try
    {
        rasters = await image.readRasters({
            width:  rasterSize,
            height: rasterSize,
            interleave: false,
            samples: wantBands
        });
    }
    catch (_) { return null; }

    //Always-an-array path (`interleave: false` returns one typed
    //array per requested sample). Normalise each band to Float32.
    if (!Array.isArray(rasters) || rasters.length === 0) return null;

    const toF32 = (b: ArrayLike<number>): Float32Array =>
    {
        if (b instanceof Float32Array) return b;
        const out = new Float32Array(b.length);
        for (let i = 0; i < b.length; i++) out[i] = b[i];
        return out;
    };

    const data    = toF32(rasters[0] as ArrayLike<number>);
    const terrain = rasters.length >= 2
        ? toF32(rasters[1] as ArrayLike<number>)
        : null;

    return { data, terrain, noData };
}

//Element-wise MAX of two equally-sized rasters. Used by the Spanish
//provider to merge the vegetation and building MDSn coverages into a
//single height-above-ground raster (each cell is either vegetation OR
//building OR ground, the higher of the two pre-normalised heights is
//the right value).
export function maxRasters(
    a: Float32Array,
    b: Float32Array
): Float32Array
{
    const N = Math.min(a.length, b.length);
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++)
    {
        const av = a[i];
        const bv = b[i];
        const aOk = isFinite(av);
        const bOk = isFinite(bv);
        if      (aOk && bOk) out[i] = Math.max(av, bv);
        else if (aOk)        out[i] = av;
        else if (bOk)        out[i] = bv;
        else                 out[i] = NaN;
    }
    return out;
}
