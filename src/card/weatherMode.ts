//Weather overlay mode. When the user toggles the weather chip in the mode bar, the rest of the
//HUD fades out (same vocabulary as the LiDAR view), the camera tilts to top-down + zooms out so
//the user sees the area around the home from above, and a per-altitude cloud-cover SVG overlay
//paints the modelled coverage as a dot cloud, one disc per grid point per altitude band. The
//5-day timeline stays visible and scrubbable: each scrub move just picks a different time slice
//out of the same cached grid, no fresh HTTP round-trip.
//
//The dot-cloud encoding deliberately under-fills its cell so the basemap stays visible between
//discs and the overall shape reads as a punctuated cloud cluster rather than a contiguous wash.
//Per-band opacity grows from low (20 %) to high (60 %) so layered points naturally weight the
//higher band heavier when more than one altitude reports cloud cover at the same grid sample.

import { html, nothing, svg, type TemplateResult } from 'lit';
import { refreshOverlays, type OverlaysHost } from './overlays';
import type { HeliosEngine } from '../helios-engine';
import type { CardMode } from './card-mode';


//Shared time base with the LiDAR fade so the chip / leader / arc fade cadence reads as one
//consistent vocabulary across modes. Enter ramps the overlay in over 600 ms while the HUD fades
//out; exit ramps back to invisible in 280 ms while the HUD fades back in.
const WEATHER_FADE_IN_MS  = 600;
const WEATHER_FADE_OUT_MS = 280;

//Per-cell threshold below which the band paints nothing. Cells whose mean coverage on a band
//falls under this percentage are dropped from the blob mask so the basemap stays visible in
//clear areas. The threshold doubles as the bucket boundary for connected-component grouping:
//two adjacent cells both above the threshold end up in the same blob regardless of their exact
//percentages, two adjacent cells one above one below stay in separate blobs.
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
    //Per-band visibility flags driven by the three buttons in the top-left weather rail. Each
    //flag gates its band's polygon set out of the SVG when false; reset to all true on every
    //weather-mode entry.
    _weatherShowHigh:           boolean;
    _weatherShowMid:            boolean;
    _weatherShowLow:            boolean;
    //LitElement.requestUpdate(), invoked each frame during the fade so the inline opacity steps
    //smoothly. Duck-typed so importing LitElement here doesn't drag Lit into the engine surface.
    requestUpdate(): void;
}


//Tilt the camera to top-down + zoom out, kick the overlay fade-in, fetch the cloud-cover grid
//in the background. The SVG polygons paint as soon as the grid lands; subsequent refreshes
//are driven by the engine's internal 5 min timer. Toggle flags reset to all true so the user
//always lands on a complete view of every band the first time they re-enter the mode.
export function enterWeatherMode(host: WeatherModeHost): boolean
{
    if (!host._engine) { return false; }
    host._weatherFadeOutStartMs = null;
    host._weatherFadeInStartMs  = performance.now();
    host._weatherOverlayVisible = true;
    host._weatherShowHigh       = true;
    host._weatherShowMid        = true;
    host._weatherShowLow        = true;
    host._engine.enterWeatherCamera();
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


//Per-point dot renderer. Reads the cloud cover series for one band at one time slice and emits
//one SVG circle per grid point whose value crosses the threshold. The disc is filled in the
//card's primary text colour with the band-specific opacity (low 40 %, mid 60 %, high 80 %) so
//the three altitudes stack with growing visual weight at each step. Discs are sized to a
//fraction of the on-screen cell pitch so neighbours never quite touch, which keeps the cloud
//cluster legible as a punctuated grid rather than a solid wash of colour.
function renderCloudBand(
    projected: ReadonlyArray<{ x: number; y: number } | null>,
    nLat:      number,
    nLon:      number,
    values:    Float32Array,
    nTimes:    number,
    timeIdx:   number,
    radius:    number,
    cssClass:  string,
): TemplateResult[]
{
    const dots: TemplateResult[] = [];
    const r = radius.toFixed(1);
    for (let iLat = 0; iLat < nLat; iLat++)
    {
        for (let iLon = 0; iLon < nLon; iLon++)
        {
            const pointIdx = iLat * nLon + iLon;
            const v = values[pointIdx * nTimes + timeIdx];
            if (v < CLOUD_LAYER_THRESHOLD_PCT) { continue; }
            const p = projected[pointIdx];
            if (!p) { continue; }
            dots.push(svg`<circle class="${cssClass}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" />`);
        }
    }
    return dots;
}


export function renderWeatherOverlay(host: WeatherModeHost): TemplateResult | typeof nothing
{
    if (!host._weatherOverlayVisible && host._weatherFadeOutStartMs === null) { return nothing; }
    const fade   = weatherFadeAlpha(host);
    const engine = host._engine ?? null;
    const grid   = engine?.getWeatherCloudGrid() ?? null;
    const ready  = !!grid && !!engine;

    //Time slice resolved from the timeline scrub state. Live = "now"; scrubbing into the past
    //or the forecast horizon picks the corresponding hour out of the cached 5-day grid without
    //firing another fetch.
    let bandHigh: TemplateResult[] = [];
    let bandMid:  TemplateResult[] = [];
    let bandLow:  TemplateResult[] = [];
    if (ready)
    {
        const activeTime = (host._isLiveMode || !host._selectedTime)
            ? new Date()
            : host._selectedTime;
        const timeIdx = engine!.getWeatherCloudGridTimeIndex(activeTime);
        if (timeIdx >= 0)
        {
            const nTimes = grid!.times.length;
            const nLat   = grid!.nLat;
            const nLon   = grid!.nLon;
            //Project every grid point once + reuse across the three bands. Points that fall
            //outside the camera's clip space come back as null; the per-band loop drops them.
            const projected: Array<{ x: number; y: number } | null> = new Array(nLat * nLon);
            for (let iLat = 0; iLat < nLat; iLat++)
            {
                for (let iLon = 0; iLon < nLon; iLon++)
                {
                    projected[iLat * nLon + iLon] = engine!.projectLonLat(grid!.lons[iLon], grid!.lats[iLat]);
                }
            }
            //Disc radius derived from the on-screen cell pitch: pick two adjacent points near
            //the centre of the grid (camera centre = home, so the centre samples reproject with
            //the least perspective distortion), measure their on-screen distance, and take a
            //fraction of it as the dot radius. The fraction stays under 0.5 so neighbouring
            //dots never overlap, leaving the lit basemap visible between them.
            const midLat = Math.floor(nLat / 2);
            const midLon = Math.floor(nLon / 2);
            const a = projected[midLat * nLon + midLon];
            const b = projected[midLat * nLon + midLon + 1];
            let pitch = 16;
            if (a && b)
            {
                pitch = Math.hypot(b.x - a.x, b.y - a.y) || pitch;
            }
            const radius = Math.max(2, pitch * 0.24);
            if (host._weatherShowHigh)
            {
                bandHigh = renderCloudBand(projected, nLat, nLon, grid!.cloudHigh, nTimes, timeIdx, radius, 'weather-cloud-dot-high');
            }
            if (host._weatherShowMid)
            {
                bandMid  = renderCloudBand(projected, nLat, nLon, grid!.cloudMid,  nTimes, timeIdx, radius, 'weather-cloud-dot-mid');
            }
            if (host._weatherShowLow)
            {
                bandLow  = renderCloudBand(projected, nLat, nLon, grid!.cloudLow,  nTimes, timeIdx, radius, 'weather-cloud-dot-low');
            }
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
