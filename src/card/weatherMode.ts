//Weather overlay mode. When the user toggles the weather chip in the mode bar, the rest of the
//HUD fades out (same vocabulary as the LiDAR view), the camera tilts to top-down + zooms out so
//the user sees the area around the home from above, and a per-altitude cloud-cover SVG overlay
//paints the modelled coverage as three colour-coded translucent layers (high / mid / low) over
//the basemap. The overlay shows the CURRENT instant only, no timeline / scrub: weather mode is
//live-only, the value of the mode is "what is happening right now" rather than a forecast scrub
//the user cannot trust.
//
//Cloud-cover percentages displayed in the per-altitude chips beside the mode bar keep coming
//from the existing Open-Meteo home-point feed (engine.projectCloudScene), exact-at-the-home
//numbers. The SVG grid overlay is the spatial context: each cell of a 10 x 10 grid (~40 km wide
//bbox around the home) paints three stacked polygons whose fill alpha tracks the cell's cloud
//coverage for that altitude band. Polygon corners are projected each render through MapLibre's
//camera transform so the overlay stays glued to the basemap on every frame.

import { html, nothing, svg, type TemplateResult } from 'lit';
import { refreshOverlays, type OverlaysHost } from './overlays';
import type { HeliosEngine } from '../helios-engine';
import type { CardMode } from './card-mode';


//Shared time base with the LiDAR fade so the chip / leader / arc fade cadence reads as one
//consistent vocabulary across modes. Enter ramps the overlay in over 600 ms while the HUD fades
//out; exit ramps back to invisible in 280 ms while the HUD fades back in.
const WEATHER_FADE_IN_MS  = 600;
const WEATHER_FADE_OUT_MS = 280;

//Debug-tier vivid palette for the three altitude bands. Red flags the highest layer (cirrus +
//cumulonimbus tops), green the middle (alto-stratus / cumulus), yellow the lowest (stratus +
//ground-hugging fog). The intent for this first cut is "I want to see which band reads where",
//not "I want a meteorologically faithful gradient"; the palette can collapse to a single
//muted hue later once the rendering pipeline is validated.
const CLOUD_LAYER_COLOR_HIGH = '#e53935';
const CLOUD_LAYER_COLOR_MID  = '#43a047';
const CLOUD_LAYER_COLOR_LOW  = '#fdd835';

//Per-cell threshold below which the band paints nothing. Cells whose mean coverage on a band
//falls under this percentage are dropped from that band's polygon set so the basemap stays
//visible in clear areas. Bands paint at fill-opacity 1.0 above the threshold so each band's
//colour reads vivid + unambiguous; the three altitude bands then read distinctly by stacking
//order rather than by alpha blending. The user toggles individual bands on / off via the
//chip buttons under the mode bar when they want to isolate a single layer.
const CLOUD_LAYER_THRESHOLD_PCT = 15;


export interface WeatherModeHost extends OverlaysHost
{
    readonly _engine?: HeliosEngine;
    _cardMode:                  CardMode;
    _overlayMaskActive:         boolean;
    _weatherOverlayVisible:     boolean;
    _weatherFadeInStartMs:      number | null;
    _weatherFadeOutStartMs:     number | null;
    _weatherFadeRaf?:           number;
    _selectedTime:              Date | null;
    _isLiveMode:                boolean;
    //Per-band visibility flags driven by the three chip buttons under the mode bar. Each flag
    //gates its band's polygon set out of the SVG when false; default all true on mode entry.
    _weatherShowHigh:           boolean;
    _weatherShowMid:            boolean;
    _weatherShowLow:            boolean;
    //LitElement.requestUpdate(), invoked each frame during the fade so the inline opacity steps
    //smoothly. Duck-typed so importing LitElement here doesn't drag Lit into the engine surface.
    requestUpdate(): void;
}


//Tilt the camera to top-down + zoom out, kick the overlay fade-in, fetch the cloud-cover grid
//in the background. The SVG polygons paint as soon as the grid lands; subsequent refreshes
//are driven by the engine's internal 5 min timer.
export function enterWeatherMode(host: WeatherModeHost): boolean
{
    if (!host._engine) { return false; }
    host._weatherFadeOutStartMs = null;
    host._weatherFadeInStartMs  = performance.now();
    host._weatherOverlayVisible = true;
    host._engine.enterWeatherCamera();
    //First fetch is fire-and-forget; the periodic refresh timer takes over after the first
    //payload lands. Errors are logged by the engine; in that case the overlay surface stays
    //blank (no fallback, the user reads it as "no cloud data right now" until the next retry).
    void host._engine.ensureWeatherCloudGrid().then(() =>
    {
        if (host._weatherFadeOutStartMs !== null) { return; }
        if (!host._weatherOverlayVisible)         { return; }
        host._engine?.startWeatherCloudRefresh();
        host.requestUpdate();
    });
    refreshOverlays(host);
    startWeatherFadeLoop(host);
    return true;
}


//Start the overlay fade-out, hand the camera back, stop the cloud refresh timer.
export function exitWeatherMode(host: WeatherModeHost): void
{
    host._weatherFadeInStartMs  = null;
    host._weatherFadeOutStartMs = performance.now();
    host._engine?.exitWeatherCamera();
    host._engine?.stopWeatherCloudRefresh();
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


//Build the SVG polygon-set for one cloud band. Each grid cell projects its 4 lat / lon corners
//to screen pixel coords through MapLibre's camera, paints one polygon per cell as a solid
//fill (no alpha blend) when the cell's mean coverage on that band crosses the threshold. Cells
//below the threshold paint nothing so the basemap stays visible in clear areas. The per-band
//polygon set is wrapped in a single SVG group; the three groups stack by paint order
//(high -> mid -> low) so the lowest band, the most relevant to surface-level conditions,
//sits on top of the higher altitudes when multiple bands cover the same cell.
function renderCloudBand(
    engine: HeliosEngine,
    grid:   NonNullable<ReturnType<HeliosEngine['getWeatherCloudGrid']>>,
    values: Float32Array,
    color:  string,
): TemplateResult[]
{
    const polys: TemplateResult[] = [];
    const nLat = grid.nLat;
    const nLon = grid.nLon;
    for (let iLat = 0; iLat < nLat - 1; iLat++)
    {
        for (let iLon = 0; iLon < nLon - 1; iLon++)
        {
            //Per-cell mean coverage across the 4 corners. Drop sub-threshold cells (they read
            //as gaps in the band so the basemap shows through where the model says it is
            //clear, and the SVG payload stays compact on a partly-cloudy frame).
            const v00 = values[ iLat      * nLon + iLon];
            const v10 = values[ iLat      * nLon + iLon + 1];
            const v01 = values[(iLat + 1) * nLon + iLon];
            const v11 = values[(iLat + 1) * nLon + iLon + 1];
            const mean = (v00 + v10 + v01 + v11) / 4;
            if (mean < CLOUD_LAYER_THRESHOLD_PCT) { continue; }

            const lat0 = grid.lats[iLat];
            const lat1 = grid.lats[iLat + 1];
            const lon0 = grid.lons[iLon];
            const lon1 = grid.lons[iLon + 1];
            //Project each corner. Drop the cell if any projection fails (map not ready) so the
            //SVG never paints a half-cell.
            const p00 = engine.projectLonLat(lon0, lat0);
            const p10 = engine.projectLonLat(lon1, lat0);
            const p11 = engine.projectLonLat(lon1, lat1);
            const p01 = engine.projectLonLat(lon0, lat1);
            if (!p00 || !p10 || !p11 || !p01) { continue; }
            const points = `${p00.x.toFixed(1)},${p00.y.toFixed(1)} `
                         + `${p10.x.toFixed(1)},${p10.y.toFixed(1)} `
                         + `${p11.x.toFixed(1)},${p11.y.toFixed(1)} `
                         + `${p01.x.toFixed(1)},${p01.y.toFixed(1)}`;
            polys.push(svg`<polygon points="${points}" fill="${color}" />`);
        }
    }
    return polys;
}


export function renderWeatherOverlay(host: WeatherModeHost): TemplateResult | typeof nothing
{
    if (!host._weatherOverlayVisible && host._weatherFadeOutStartMs === null) { return nothing; }
    const fade  = weatherFadeAlpha(host);
    const grid  = host._engine?.getWeatherCloudGrid() ?? null;
    const ready = !!grid && !!host._engine;

    //Per-band visibility flags. A band whose chip has been toggled off is skipped from the
    //polygon-build pass entirely so the user reads the remaining bands without overdraw.
    let bandHigh: TemplateResult[] = [];
    let bandMid:  TemplateResult[] = [];
    let bandLow:  TemplateResult[] = [];
    if (ready)
    {
        if (host._weatherShowHigh)
        {
            bandHigh = renderCloudBand(host._engine!, grid!, grid!.cloudHigh, CLOUD_LAYER_COLOR_HIGH);
        }
        if (host._weatherShowMid)
        {
            bandMid  = renderCloudBand(host._engine!, grid!, grid!.cloudMid,  CLOUD_LAYER_COLOR_MID);
        }
        if (host._weatherShowLow)
        {
            bandLow  = renderCloudBand(host._engine!, grid!, grid!.cloudLow,  CLOUD_LAYER_COLOR_LOW);
        }
    }

    return html`
        <div class="weather-mode-overlay" aria-hidden="true" style="opacity:${fade.toFixed(3)}">
            ${ready ? html`
                <svg class="weather-cloud-svg" xmlns="http://www.w3.org/2000/svg">
                    <g class="weather-cloud-band weather-cloud-band--high">${bandHigh}</g>
                    <g class="weather-cloud-band weather-cloud-band--mid">${bandMid}</g>
                    <g class="weather-cloud-band weather-cloud-band--low">${bandLow}</g>
                </svg>
            ` : nothing}
        </div>
    `;
}
