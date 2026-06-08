//Weather overlay mode. When the user toggles the weather chip in the mode bar, the rest of the
//HUD fades out (same vocabulary as the LiDAR view), the camera tilts to top-down + zooms out so
//the user sees the area around the home from above, and a live RainViewer precipitation radar
//overlay paints rain / storm cells onto the basemap. The overlay shows the CURRENT instant only,
//no timeline / scrub, the value of weather mode is "what is happening right now" rather than a
//forecast scrub the user cannot trust.
//
//Cloud-cover percentages displayed in the low / mid / high chips keep coming from the existing
//Open-Meteo home-point feed (engine.projectCloudScene). The RainViewer raster is the visual
//context layer; the chips are the precise numbers at the home.

import { html, nothing, type TemplateResult } from 'lit';
import { refreshOverlays, type OverlaysHost } from './overlays';
import type { HeliosEngine } from '../helios-engine';
import type { CardMode } from './card-mode';


//Shared time base with the LiDAR fade so the chip / leader / arc fade cadence reads as one
//consistent vocabulary across modes. Enter ramps the overlay in over 600 ms while the HUD fades
//out; exit ramps back to invisible in 280 ms while the HUD fades back in.
const WEATHER_FADE_IN_MS  = 600;
const WEATHER_FADE_OUT_MS = 280;


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
    //LitElement.requestUpdate(), invoked each frame during the fade so the inline opacity steps
    //smoothly. Duck-typed so importing LitElement here doesn't drag Lit into the engine surface.
    requestUpdate(): void;
}


//Tilt the camera to top-down + zoom out, kick the overlay fade-in, fetch the RainViewer index
//and attach the radar overlay. The overlay paints as soon as the index lands; subsequent
//refreshes are driven by the engine's internal 5 min timer.
export function enterWeatherMode(host: WeatherModeHost): boolean
{
    if (!host._engine) { return false; }
    host._weatherFadeOutStartMs = null;
    host._weatherFadeInStartMs  = performance.now();
    host._weatherOverlayVisible = true;
    host._engine.enterWeatherCamera();
    //Fetch the RainViewer index in the background; the attach call paints the radar as soon as
    //the frame has been resolved. The fade-out guard catches a rapid Weather -> UI -> Weather
    //sequence so we never attach an overlay onto a map that's already easing back out.
    void host._engine.ensureRainViewerFrame().then(() =>
    {
        if (host._weatherFadeOutStartMs !== null) { return; }
        if (!host._weatherOverlayVisible)         { return; }
        host._engine?.attachRainViewerOverlay();
    });
    refreshOverlays(host);
    startWeatherFadeLoop(host);
    return true;
}


//Start the overlay fade-out, hand the camera back, detach the RainViewer raster.
export function exitWeatherMode(host: WeatherModeHost): void
{
    host._weatherFadeInStartMs  = null;
    host._weatherFadeOutStartMs = performance.now();
    host._engine?.exitWeatherCamera();
    host._engine?.detachRainViewerOverlay();
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


export function renderWeatherOverlay(host: WeatherModeHost): TemplateResult | typeof nothing
{
    if (!host._weatherOverlayVisible && host._weatherFadeOutStartMs === null) { return nothing; }
    const fade = weatherFadeAlpha(host);
    //The visible HTML overlay is a transparent wrapper now; the actual rain radar sits on the
    //MapLibre raster layer owned by the engine. The wrapper stays in the template so the
    //existing fade-in / fade-out transitions continue to drive the lifecycle, and so future
    //surfaces (loading spinner, region warning, etc.) have a stable mount point.
    return html`
        <div class="weather-mode-overlay" aria-hidden="true" style="opacity:${fade.toFixed(3)}"></div>
    `;
}
