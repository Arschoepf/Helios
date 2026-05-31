//ESRI ASCII Grid fetch + decode helper, used by providers whose WCS
//endpoint refuses to serve a Float32 GeoTIFF directly. GUGiK Poland
//advertises `image/tiff` in its capabilities but the bytes come back
//as an 8-bit RGB rendering of the heights, useless to us. Asking
//for `image/x-aaigrid` returns the real surface heights in metres
//as a plain ASCII grid wrapped in a WCS multipart envelope.
//
//AAIGrid format, after stripping the multipart wrapper:
//
//   ncols        100
//   nrows        100
//   xllcorner    16.939737922163
//   yllcorner    51.098530942149
//   dx           0.000032901557
//   dy           0.000020661157
//   NODATA_value -9999
//   v v v v ...     <- ncols x nrows space-separated values, row-major,
//   v v v v ...        top row first (matches our convention for
//   ...                row 0 = north edge)
//
//Reference: GDAL AAIGrid driver
//https://gdal.org/drivers/raster/aaigrid.html

import { lidarFetchUrl } from './proxy';


//Header keywords AAIGrid is allowed to expose. Lowercased here so
//the parser stays case-insensitive without per-token toLowerCase
//calls in the hot loop. `xllcenter` / `yllcenter` are GDAL aliases
//for `xllcorner` / `yllcorner` and appear on some servers.
const HEADER_KEYS = new Set([
    'ncols', 'nrows',
    'xllcorner', 'yllcorner', 'xllcenter', 'yllcenter',
    'cellsize', 'dx', 'dy',
    'nodata_value',
]);


//Pull the ASCII grid body out of a WCS 2.0 multipart envelope. The
//grid sits in the part whose Content-Type is `image/x-aaigrid`; the
//other parts (the PRJ string at the tail, an optional GML metadata
//header) get skipped. When the response is not wrapped (raw grid
//body), we treat the whole text as the grid.
function extractAaiGridBody(text: string): string | null
{
    const marker = text.indexOf('image/x-aaigrid');
    if (marker < 0) return text;   //raw, no envelope
    //Skip past the part headers to the blank line separator.
    const rnrn = text.indexOf('\r\n\r\n', marker);
    const nn   = text.indexOf('\n\n',   marker);
    let bodyStart: number;
    if (rnrn >= 0 && (nn < 0 || rnrn < nn)) bodyStart = rnrn + 4;
    else if (nn >= 0)                       bodyStart = nn + 2;
    else                                    return null;
    //The body ends at the next multipart boundary marker (`--wcs` or
    //similar). Scan forward for a line starting with `--`.
    const endIdx = text.indexOf('\n--', bodyStart);
    return endIdx >= 0 ? text.slice(bodyStart, endIdx) : text.slice(bodyStart);
}


//Parse header + values out of the AAIGrid body. Returns the raw
//heights array sized ncols * nrows on success, null on any malformed
//input. NoData cells are mapped to NaN so the downstream pipeline
//(processHeightRaster) can treat them as "out of coverage" the same
//way it does for every other provider.
function parseAaiGrid(body: string): {
    ncols: number;
    nrows: number;
    heights: Float32Array
} | null
{
    //Tokenise once, the body has at most a few hundred thousand
    //numbers and split() is comfortably faster than per-char scans.
    const tokens = body.split(/\s+/).filter(t => t.length > 0);
    if (tokens.length < 2) return null;

    let ncols = 0;
    let nrows = 0;
    let nodata: number | null = null;
    let i = 0;
    //Walk header pairs until we hit a token that isn't a header keyword.
    while (i + 1 < tokens.length)
    {
        const key = tokens[i].toLowerCase();
        if (!HEADER_KEYS.has(key)) break;
        const valStr = tokens[i + 1];
        if      (key === 'ncols')        ncols  = parseInt(valStr, 10);
        else if (key === 'nrows')        nrows  = parseInt(valStr, 10);
        else if (key === 'nodata_value') nodata = parseFloat(valStr);
        //Other geometry keys are not needed by Helios, the upstream
        //bbox + SCALESIZE already fix the spatial extent.
        i += 2;
    }
    if (ncols <= 0 || nrows <= 0) return null;

    const total = ncols * nrows;
    if (tokens.length - i < total) return null;

    const heights = new Float32Array(total);
    for (let k = 0; k < total; k++)
    {
        const v = parseFloat(tokens[i + k]);
        if (!isFinite(v))                heights[k] = NaN;
        else if (nodata !== null && v === nodata) heights[k] = NaN;
        else                              heights[k] = v;
    }
    return { ncols, nrows, heights };
}


//Resample a (ncols x nrows) grid to rasterSize x rasterSize via
//nearest-neighbour. Same shape as the resample step inside the
//GeoTIFF helper so providers can swap one for the other without
//touching the downstream pipeline.
function resampleNearest(
    src:        Float32Array,
    srcCols:    number,
    srcRows:    number,
    rasterSize: number,
): Float32Array
{
    if (srcCols === rasterSize && srcRows === rasterSize) return src;
    const out = new Float32Array(rasterSize * rasterSize);
    for (let y = 0; y < rasterSize; y++)
    {
        const srcY = Math.min(srcRows - 1, Math.floor((y * srcRows) / rasterSize));
        const rowOff = srcY * srcCols;
        const outOff = y * rasterSize;
        for (let x = 0; x < rasterSize; x++)
        {
            const srcX = Math.min(srcCols - 1, Math.floor((x * srcCols) / rasterSize));
            out[outOff + x] = src[rowOff + srcX];
        }
    }
    return out;
}


//Drop-in counterpart to fetchFloat32GeoTiff for providers that have
//to ask for `image/x-aaigrid` because their `image/tiff` is an RGB
//render. Same signature, same Float32Array output sized
//rasterSize x rasterSize, so the provider only needs to change the
//FORMAT param and the helper name.
export async function fetchAaiGridHeights(
    url:        string,
    rasterSize: number,
    signal?:    AbortSignal,
): Promise<Float32Array | null>
{
    let resp: Response;
    try
    {
        resp = await fetch(lidarFetchUrl(url), { signal });
    }
    catch (_) { return null; }
    if (!resp.ok) return null;

    let text: string;
    try { text = await resp.text(); }
    catch (_) { return null; }

    //A short body is most likely an XML ServiceException, not a grid.
    if (text.length < 200) return null;

    const body = extractAaiGridBody(text);
    if (!body) return null;

    const parsed = parseAaiGrid(body);
    if (!parsed) return null;

    return resampleNearest(parsed.heights, parsed.ncols, parsed.nrows, rasterSize);
}
