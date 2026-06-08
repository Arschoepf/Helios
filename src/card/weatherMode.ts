//Weather overlay mode. When the user toggles the weather chip in the mode bar, the rest of the HUD
//fades out (same vocabulary as the LiDAR view), the camera tilts to top-down + zooms out so the
//user sees the area around the home from above, and a per-altitude cloud raster paints the visible
//map area with a satellite-style cloud mask sampled from a 31 x 31 Open-Meteo grid centred on the
//home at the SELECTED instant (scrub cursor when active, live "now" otherwise).
//
//Each canvas pixel composites three grayscale layers from the corresponding Open-Meteo altitude
//bands (cloud_cover_low / mid / high). Per-pixel cloud values come from a bilinear interpolation
//of the 31 x 31 grid sampled at the pixel's geographic location, modulated by a small value-noise
//field so the raster reads as a textured cloud mass rather than a flat colour swatch.
//
//The raster lives in MapLibre as an `image` source + `raster` layer, so pan / zoom / rotation are
//handled natively by the map (no per-frame re-projection in JS). The canvas is regenerated only
//when the selected time advances or the grid data refreshes (~30 min TTL).

import { html, nothing, type TemplateResult } from 'lit';
import { refreshOverlays, type OverlaysHost } from './overlays';
import type { HeliosEngine } from '../helios-engine';
import type { CardMode } from './card-mode';


//Same time base as the previous shading-dome fade so the chip / leader / arc fade cadence stays
//consistent across modes. Enter ramps the overlay in over 600 ms while the HUD fades out; exit
//ramps back to invisible in 280 ms while the HUD fades back in.
const WEATHER_FADE_IN_MS  = 600;
const WEATHER_FADE_OUT_MS = 280;

//Canvas raster dimensions. 512 x 512 keeps the GPU upload + MapLibre re-projection fast while
//giving the bilinear-interp + noise field enough room to read smoothly under the camera's
//top-down zoom 12 framing. Going to 1024 doubles the per-render cost for marginal visual gain
//under MapLibre's own raster-source mipmap.
const CANVAS_SIDE = 512;


export interface WeatherModeHost extends OverlaysHost
{
    readonly _engine?: HeliosEngine;
    _cardMode:                  CardMode;
    _overlayMaskActive:         boolean;
    _weatherOverlayVisible:     boolean;
    _weatherFadeInStartMs:      number | null;
    _weatherFadeOutStartMs:     number | null;
    _weatherFadeRaf?:           number;
    //The instant the cloud-layer overlay reads against. Driven by the host's scrub cursor when
    //active, falls back to the live now when no scrub is parked.
    _selectedTime:              Date | null;
    _isLiveMode:                boolean;
    //LitElement.requestUpdate(), invoked each frame during the fade so the inline opacity steps
    //smoothly. Duck-typed so importing LitElement here doesn't drag Lit into the engine surface.
    requestUpdate(): void;
}


//Tilt the camera to top-down + zoom out, kick the overlay fade-in, fire the grid fetch if stale.
//The raster paints the moment the grid has landed (the next refresh tick rebuilds the canvas).
export function enterWeatherMode(host: WeatherModeHost): boolean
{
    if (!host._engine) { return false; }
    host._weatherFadeOutStartMs = null;
    host._weatherFadeInStartMs  = performance.now();
    host._weatherOverlayVisible = true;
    host._engine.enterWeatherCamera();
    //Kick the grid fetch in the background; subsequent refreshWeatherRaster() calls pick up the
    //data as soon as it lands. Errors are logged by the engine, the overlay stays blank in that
    //case (no fallback colour map, the user would just see an honest "no data" until the next
    //retry on a TTL miss).
    void host._engine.ensureWeatherGrid().then(() =>
    {
        refreshWeatherRaster(host);
    });
    refreshOverlays(host);
    startWeatherFadeLoop(host);
    return true;
}


//Start the overlay fade-out, hand the camera back, clear the MapLibre raster.
export function exitWeatherMode(host: WeatherModeHost): void
{
    host._weatherFadeInStartMs  = null;
    host._weatherFadeOutStartMs = performance.now();
    host._engine?.exitWeatherCamera();
    host._engine?.clearWeatherCloudOverlay();
    _lastRasterTimeMs = 0;
    startWeatherFadeLoop(host);
}


export function startWeatherFadeLoop(host: WeatherModeHost): void
{
    if (host._weatherFadeRaf !== undefined) { return; }
    const tick = (): void =>
    {
        const now      = performance.now();
        const inStart  = host._weatherFadeInStartMs;
        const outStart = host._weatherFadeOutStartMs;

        if (outStart !== null && now - outStart >= WEATHER_FADE_OUT_MS)
        {
            host._weatherFadeOutStartMs = null;
            host._weatherOverlayVisible = false;
            refreshOverlays(host);
        }
        if (inStart !== null && now - inStart >= WEATHER_FADE_IN_MS)
        {
            host._weatherFadeInStartMs = null;
        }
        host.requestUpdate();
        if (host._weatherFadeInStartMs !== null || host._weatherFadeOutStartMs !== null)
        {
            host._weatherFadeRaf = requestAnimationFrame(tick);
        }
        else
        {
            host._weatherFadeRaf = undefined;
        }
    };
    host._weatherFadeRaf = requestAnimationFrame(tick);
}


export function weatherFadeAlpha(host: WeatherModeHost): number
{
    const now = performance.now();
    if (host._weatherFadeInStartMs !== null)
    {
        return Math.max(0, Math.min(1, (now - host._weatherFadeInStartMs) / WEATHER_FADE_IN_MS));
    }
    if (host._weatherFadeOutStartMs !== null)
    {
        return 1 - Math.max(0, Math.min(1, (now - host._weatherFadeOutStartMs) / WEATHER_FADE_OUT_MS));
    }
    return host._weatherOverlayVisible ? 1 : 0;
}


function selectedTime(host: WeatherModeHost): Date
{
    if (!host._isLiveMode && host._selectedTime) { return host._selectedTime; }
    return new Date();
}


//---------------------------------------------------------------------------------------------------
//Value noise. Simpler than Perlin and visually similar at the densities we use here; the cloud
//mask reads as a textured volume rather than the flat bilinear surface we'd get from the grid
//alone. Single octave of cell-aligned random values smoothstep-blended at sub-cell resolution.
//---------------------------------------------------------------------------------------------------

//Hash function: turns integer cell coords into a deterministic pseudo-random [0, 1) value. Same
//(x, y) always yields the same hash so the texture is stable across re-renders within a session.
function noiseHash(x: number, y: number): number
{
    let h = (x * 374761393) ^ (y * 668265263);
    h = (h ^ (h >>> 13)) * 1274126177;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967295;
}

function smoothStep(t: number): number { return t * t * (3 - 2 * t); }

function valueNoise2D(x: number, y: number): number
{
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smoothStep(x - x0);
    const fy = smoothStep(y - y0);
    const v00 = noiseHash(x0,     y0);
    const v10 = noiseHash(x0 + 1, y0);
    const v01 = noiseHash(x0,     y0 + 1);
    const v11 = noiseHash(x0 + 1, y0 + 1);
    const a = v00 + (v10 - v00) * fx;
    const b = v01 + (v11 - v01) * fx;
    return a + (b - a) * fy;
}

//Fractal noise: stack 3 octaves of value noise at doubling frequencies + halving amplitudes. The
//result reads as a natural cloud texture without the regular grid of single-octave noise. Output
//is normalised to [0, 1] so we can scale it into the modulation envelope below.
function fractalNoise(x: number, y: number): number
{
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < 3; i++)
    {
        sum  += valueNoise2D(x * freq, y * freq) * amp;
        norm += amp;
        amp  *= 0.5;
        freq *= 2;
    }
    return sum / norm;
}


//---------------------------------------------------------------------------------------------------
//Bilinear interpolation on the 31 x 31 grid. Given a (lat, lon), returns the cloud value at that
//position by blending the four nearest grid cells. Clamps to the grid bounds.
//---------------------------------------------------------------------------------------------------

function bilinearGrid(
    arr:     Float32Array,
    nLat:    number,
    nLon:    number,
    nTimes:  number,
    timeIdx: number,
    south:   number,
    north:   number,
    west:    number,
    east:    number,
    lat:     number,
    lon:     number,
): number
{
    //Map lat / lon to fractional grid indices. Clamp at the borders so we never sample out of
    //range; the corner cells just spread their value outward instead.
    const fy = Math.max(0, Math.min(nLat - 1, ((lat - south) / (north - south)) * (nLat - 1)));
    const fx = Math.max(0, Math.min(nLon - 1, ((lon - west)  / (east  - west))  * (nLon - 1)));
    const iy0 = Math.floor(fy);
    const ix0 = Math.floor(fx);
    const iy1 = Math.min(nLat - 1, iy0 + 1);
    const ix1 = Math.min(nLon - 1, ix0 + 1);
    const sy = fy - iy0;
    const sx = fx - ix0;
    const v00 = arr[(iy0 * nLon + ix0) * nTimes + timeIdx];
    const v10 = arr[(iy0 * nLon + ix1) * nTimes + timeIdx];
    const v01 = arr[(iy1 * nLon + ix0) * nTimes + timeIdx];
    const v11 = arr[(iy1 * nLon + ix1) * nTimes + timeIdx];
    const a = v00 + (v10 - v00) * sx;
    const b = v01 + (v11 - v01) * sx;
    return a + (b - a) * sy;
}


//---------------------------------------------------------------------------------------------------
//Time-index resolver. Picks the grid time slice whose midpoint is closest to the selected instant.
//Returns -1 when the grid is empty.
//---------------------------------------------------------------------------------------------------

//Resolve the HA frontend's --primary-color at render time and parse it to RGB triplets the
//canvas pipeline can multiply into per-pixel alphas. Reads from the document root (the CSS var
//cascades down from there). Supports the two formats HA themes emit:
//  - 6-digit hex (#03a9f4)
//  - rgb(r, g, b) function notation
//Falls back to HA's default vivid blue (#03a9f4) when the variable is empty / malformed.
function parsePrimaryColor(): { r: number; g: number; b: number }
{
    const DEFAULT = { r: 0x03, g: 0xa9, b: 0xf4 };
    try
    {
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim();
        if (!raw) { return DEFAULT; }
        if (raw.startsWith('#'))
        {
            const hex = raw.length === 4
                ? raw[1] + raw[1] + raw[2] + raw[2] + raw[3] + raw[3]
                : raw.slice(1, 7);
            const n = parseInt(hex, 16);
            if (Number.isFinite(n))
            {
                return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
            }
        }
        const m = raw.match(/rgb[a]?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (m)
        {
            return { r: +m[1], g: +m[2], b: +m[3] };
        }
    }
    catch (_) { /* ignore, return default */ }
    return DEFAULT;
}


function timeIndexAt(times: Date[], t: Date): number
{
    if (times.length === 0) { return -1; }
    const tMs = t.getTime();
    let best = 0;
    let bestDt = Math.abs(times[0].getTime() - tMs);
    for (let i = 1; i < times.length; i++)
    {
        const dt = Math.abs(times[i].getTime() - tMs);
        if (dt < bestDt) { bestDt = dt; best = i; }
    }
    return best;
}


//---------------------------------------------------------------------------------------------------
//Canvas render: one-shot raster generation. Walks every pixel of an offscreen 512 x 512 canvas,
//bilinear-samples the grid at the pixel's lat / lon, modulates by fractal noise for cloud texture,
//composites the three grayscale layers, and hands a data URL back to the caller for MapLibre.
//---------------------------------------------------------------------------------------------------

//Module-level offscreen canvas reused across renders. Allocating a fresh one per frame would cost
//~1 MB of GC pressure per scrub tick on iOS Safari.
let _canvas: HTMLCanvasElement | null = null;
let _ctx:    CanvasRenderingContext2D | null = null;
//Last render time slice + selected time, used to short-circuit identical rebuilds when the user
//moves the scrub cursor inside the same hour bucket.
let _lastRasterTimeMs = 0;

function getCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null
{
    if (!_canvas)
    {
        _canvas = document.createElement('canvas');
        _canvas.width  = CANVAS_SIDE;
        _canvas.height = CANVAS_SIDE;
        _ctx = _canvas.getContext('2d', { willReadFrequently: false });
    }
    if (!_canvas || !_ctx) { return null; }
    return { canvas: _canvas, ctx: _ctx };
}


//Refresh the raster from the current grid + selected time, push to MapLibre. Cheap to call on
//every host render tick: short-circuits when the time slice hasn't changed since the last paint.
export function refreshWeatherRaster(host: WeatherModeHost): void
{
    if (!host._engine) { return; }
    if (!host._weatherOverlayVisible) { return; }
    //Bail while a fade-out is in flight: the engine's MapLibre raster layer was already removed
    //by exitWeatherMode, and re-adding the canvas here would race the exit and leave the cloud
    //mass painted on the map after the mode chip + overlay have already faded out.
    if (host._weatherFadeOutStartMs !== null) { return; }
    const grid = host._engine.getWeatherGrid();
    if (!grid) { return; }
    const t = selectedTime(host);
    const timeIdx = timeIndexAt(grid.times, t);
    if (timeIdx < 0) { return; }
    //Short-circuit when the time hasn't moved (within the hourly resolution of the grid).
    const targetMs = grid.times[timeIdx].getTime();
    if (targetMs === _lastRasterTimeMs) { return; }
    _lastRasterTimeMs = targetMs;

    const { canvas, ctx } = getCanvas() ?? { canvas: null, ctx: null };
    if (!canvas || !ctx) { return; }
    const W = CANVAS_SIDE;
    const H = CANVAS_SIDE;
    const img = ctx.createImageData(W, H);
    const px  = img.data;

    const { bounds, nLat, nLon, cloudLow, cloudMid, cloudHigh, times } = grid;
    const nTimes = times.length;
    const { south, north, west, east } = bounds;

    //Noise frequency: smaller value = larger features. ~6 cycles across the canvas width gives
    //cloud-blob-sized cells at the weather-mode zoom 9 framing.
    const NOISE_FREQ = 6;

    //Resolve the HA theme's --primary-color at render time so the raster picks up theme swaps
    //without a rebuild. Read from the document root since the variable cascades down from the
    //HA frontend. Falls back to a vivid blue (#03a9f4) when the variable is empty / unset.
    const primary = parsePrimaryColor();

    let p = 0;
    for (let y = 0; y < H; y++)
    {
        const ny = y / (H - 1);
        //Canvas Y axis runs top-to-bottom; latitude runs south-to-north. Flip Y so the canvas
        //top edge maps to the north bound, matching how MapLibre paints the raster onto its
        //coordinate quad (north corner first in setWeatherCloudOverlay).
        const lat = north - ny * (north - south);
        for (let x = 0; x < W; x++)
        {
            const nx = x / (W - 1);
            const lon = west + nx * (east - west);

            const lo = bilinearGrid(cloudLow,  nLat, nLon, nTimes, timeIdx, south, north, west, east, lat, lon);
            const mi = bilinearGrid(cloudMid,  nLat, nLon, nTimes, timeIdx, south, north, west, east, lat, lon);
            const hi = bilinearGrid(cloudHigh, nLat, nLon, nTimes, timeIdx, south, north, west, east, lat, lon);

            //Noise modulation. The fractal noise field returns [0, 1]; we shift / scale it to
            //[0.4, 1.0] so even at "high coverage" the texture stays slightly variable instead of
            //fully solid. Each cloud layer uses a different noise offset so the three masses
            //aren't perfectly correlated.
            const n0 = fractalNoise(nx * NOISE_FREQ,         ny * NOISE_FREQ);
            const n1 = fractalNoise(nx * NOISE_FREQ + 100,   ny * NOISE_FREQ + 100);
            const n2 = fractalNoise(nx * NOISE_FREQ + 200,   ny * NOISE_FREQ + 200);
            const modLo = 0.4 + 0.6 * n0;
            const modMi = 0.4 + 0.6 * n1;
            const modHi = 0.4 + 0.6 * n2;

            //Per-layer alpha = (coverage / 100) × noise modulation. Ceilings tuned so the cloud
            //masses dominate the view (the whole point of the weather mode) while leaving the map
            //legible underneath: at 100 % coverage the stacked layers compose to ~0.92 alpha, the
            //basemap silhouette + landmarks still read through but the user clearly sees an
            //overcast sky. The three layers stack with high (light) on top of mid (medium) on
            //top of low (dense).
            const aLo = Math.max(0, Math.min(1, (lo / 100) * modLo)) * 0.78;
            const aMi = Math.max(0, Math.min(1, (mi / 100) * modMi)) * 0.65;
            const aHi = Math.max(0, Math.min(1, (hi / 100) * modHi)) * 0.50;

            //Composite three primary-tinted layers (high -> mid -> low) onto a transparent
            //background using standard over-compositing. All three bands share the HA theme's
            //--primary-color; the visual depth comes from the alpha stacking + noise modulation,
            //not from per-band hue variation.
            let r = 0, g = 0, b = 0, a = 0;
            //High layer.
            r += primary.r * aHi;
            g += primary.g * aHi;
            b += primary.b * aHi;
            a += aHi;
            //Mid layer.
            const wMi = aMi * (1 - a);
            r += primary.r * wMi;
            g += primary.g * wMi;
            b += primary.b * wMi;
            a += wMi;
            //Low layer.
            const wLo = aLo * (1 - a);
            r += primary.r * wLo;
            g += primary.g * wLo;
            b += primary.b * wLo;
            a += wLo;

            px[p++] = Math.round(r);
            px[p++] = Math.round(g);
            px[p++] = Math.round(b);
            px[p++] = Math.round(a * 255);
        }
    }
    ctx.putImageData(img, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    host._engine.setWeatherCloudOverlay(dataUrl, bounds);
}


export function renderWeatherOverlay(host: WeatherModeHost): TemplateResult | typeof nothing
{
    if (!host._weatherOverlayVisible && host._weatherFadeOutStartMs === null) { return nothing; }
    //Drive a refresh on every render tick. refreshWeatherRaster short-circuits when nothing's
    //changed, so the canvas repaint only happens on the first render after a grid landing or a
    //scrub-time movement past the hourly resolution.
    refreshWeatherRaster(host);
    const fade = weatherFadeAlpha(host);
    //The visible HTML overlay is a transparent wrapper now; the actual cloud raster sits on the
    //MapLibre raster layer. The wrapper stays in the template so the existing fade-in / fade-out
    //transitions continue to drive the lifecycle, and so future surfaces (loading spinner, time
    //chip, etc.) have a stable mount point.
    return html`
        <div class="weather-mode-overlay" aria-hidden="true" style="opacity:${fade.toFixed(3)}"></div>
    `;
}
