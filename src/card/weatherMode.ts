//Weather overlay mode. When the user toggles the weather chip in the mode bar, the rest of the HUD
//fades out (same vocabulary as the LiDAR view), the camera tilts to top-down + zooms out so the
//user sees the area around the home from above, and three semi-transparent grayscale layers paint
//the current cloud cover at the SELECTED time (scrub cursor when active, live "now" otherwise).
//
//Each layer represents one of Open-Meteo's altitude bands:
//  - Low clouds (<= 3 km, stratus / cumulus): the darkest band, painted closest to the user's eye
//  - Mid clouds (3-8 km, altocumulus / altostratus): a medium gray middle band
//  - High clouds (>= 8 km, cirrus): the lightest, faintest band on top of the stack
//
//Each band's opacity scales with the matching cloud-cover percentage at the selected time, so the
//user reads the sky state at a glance: an overcast day stacks three dense layers, a clear day
//leaves every band almost transparent. Replaces the previous shading-dome celestial overlay, which
//was visually striking but did not move the forecast accuracy enough to justify the rendering cost.
//
//Pure HTML overlay (no SVG geometry per cell), so the cost is one CSS opacity update per fade tick
//+ the camera easeTo. The shading-map TRAINER (src/card/shadingTrainer.ts) still runs in the
//background and feeds the forecast effective ratio; only the visible dome rendering is gone.

import { html, nothing, type TemplateResult } from 'lit';
import { refreshOverlays, type OverlaysHost } from './overlays';
import type { HeliosEngine } from '../helios-engine';
import type { CardMode } from './card-mode';


//Same time base as the previous shading-dome fade so the chip / leader / arc fade cadence stays
//consistent across modes. Enter ramps the overlay in over 600 ms while the HUD fades out; exit
//ramps back to invisible in 280 ms while the HUD fades back in.
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
    //The instant the cloud-layer overlay reads against. Driven by the host's scrub cursor when
    //active, falls back to the live now when no scrub is parked. The host updates this on every
    //scrub event so the overlay tracks the timeline cursor.
    _selectedTime:              Date | null;
    _isLiveMode:                boolean;
    //LitElement.requestUpdate(), invoked each frame during the fade so the inline opacity steps
    //smoothly. Duck-typed so importing LitElement here doesn't drag Lit into the engine surface.
    requestUpdate(): void;
}


//Tilt the camera to top-down + zoom out, kick the overlay fade-in. The matching exitWeatherMode
//restores the pre-enter pose.
export function enterWeatherMode(host: WeatherModeHost): boolean
{
    if (!host._engine) { return false; }
    host._weatherFadeOutStartMs = null;
    host._weatherFadeInStartMs  = performance.now();
    host._weatherOverlayVisible = true;
    host._engine.enterWeatherCamera();
    refreshOverlays(host);
    startWeatherFadeLoop(host);
    return true;
}


//Start the overlay fade-out, hand the camera back to its pre-mode pose. The HUD chips read through
//the fading overlay during the transition just fine, so the overlay mask drops immediately in the
//card-mode state machine.
export function exitWeatherMode(host: WeatherModeHost): void
{
    host._weatherFadeInStartMs  = null;
    host._weatherFadeOutStartMs = performance.now();
    host._engine?.exitWeatherCamera();
    startWeatherFadeLoop(host);
}


//Drive the enter / exit fade by mutating the host's mode flag at the appropriate moment. The visual
//fade itself is an inline opacity step on the overlay container, this loop only handles the
//discrete state flips + the per-frame requestUpdate.
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


//Resolve the time the cloud-layer overlay reads against. Scrub cursor when the user has parked it,
//live now otherwise. Centralised so the overlay + the optional readout chip below land on the same
//instant.
function selectedTime(host: WeatherModeHost): Date
{
    if (!host._isLiveMode && host._selectedTime) { return host._selectedTime; }
    return new Date();
}


export function renderWeatherOverlay(host: WeatherModeHost): TemplateResult | typeof nothing
{
    if (!host._weatherOverlayVisible && host._weatherFadeOutStartMs === null) { return nothing; }
    if (!host._engine) { return nothing; }
    //v1.8.3-beta.80 ships the lifecycle, the camera transition and the engine helper that exposes
    //the home-point cloud layers at the selected instant. The actual raster overlay (multi-point
    //grid fetch + canvas render with bilinear interp + Perlin noise) follows in a subsequent beta.
    //For this first pass the overlay is an empty fading wrapper so the HUD mask + camera animation
    //can be validated end-to-end before the heavier render path lands.
    const fade = weatherFadeAlpha(host);
    void selectedTime(host);
    return html`
        <div class="weather-mode-overlay" aria-hidden="true" style="opacity:${fade.toFixed(3)}"></div>
    `;
}
