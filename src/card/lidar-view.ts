//LiDAR View overlay: when the user clicks the View button, the regular map UI fades out and every loaded LiDAR cell is projected to screen as a small
//dot. This module handles the toggle gesture and drives the alpha-fade rAF loop that smooths both the enter and the exit transitions.
//
//Same host-driven pattern as the timeline / overlays modules: the card owns the `@state` flag and the fade timestamps, the helpers here mutate them
//through a structural LidarViewHost.

import { html, nothing, type TemplateResult } from 'lit';
import { refreshOverlays, type OverlaysHost } from './overlays';
import type { HeliosEngine } from '../helios-engine';
import type { CardMode } from './card-mode';


//Fade durations. Enter is slightly longer than exit so the dot
//cloud reads as a deliberate "settle in"; exit hurries back so the
//HUD comes back fast when the user dismisses the view.
const LIDAR_FADE_IN_MS  = 380;
const LIDAR_FADE_OUT_MS = 280;


//Structural surface the host card exposes. The mode-transition state machine on the card side reads
//_cardMode + _overlayMaskActive to drive what the user sees; this module mutates the fade-loop fields
//(_lidarFadeIn/OutStartMs, _lidarLayerActive) and signals the engine. The picker reads _cardMode
//directly to compute its .is-active class so the slide-in / slide-out animation fires reliably on the
//same render as the mode flip.
export interface LidarViewHost extends OverlaysHost
{
    readonly _engine?:           HeliosEngine;

    _cardMode:                   CardMode;
    _overlayMaskActive:          boolean;
    _lidarLayerActive:           boolean;
    _lidarFadeInStartMs:         number | null;
    _lidarFadeOutStartMs:        number | null;
    _lidarFadeRaf?:              number;
    _lidarViewOpacity:           number;
}


//Start the LiDAR enter animation. Returns true if the engine has a provider and the fade actually
//kicked, false otherwise (no-op when the engine reports no LiDAR source covers the active home).
//Called from the card's _handleCardModeChange when _cardMode transitions INTO 'lidar'.
//
//Dot cloud fades in over LIDAR_FADE_IN_MS via a uniform alpha ramp on the WebGL custom layer. The
//chip / leader / arc / timeline CSS transitions run independently, driven by _overlayMaskActive
//flipping ON the moment _cardMode left base.
export function enterLidarView(host: LidarViewHost): boolean
{
    if (!host._engine)
    {
        return false;
    }
    if (host._engine.getActiveLidarSourceId() === null)
    {
        return false;
    }
    host._lidarFadeOutStartMs = null;
    host._lidarFadeInStartMs  = performance.now();
    host._lidarLayerActive    = true;
    host._engine.setLidarViewActive(true);
    refreshOverlays(host);
    startLidarFadeLoop(host);
    return true;
}


//Start the LiDAR exit animation. The dot cloud fades back out over LIDAR_FADE_OUT_MS, then the fade
//loop tears the engine layer down (setLidarViewActive(false)) and, if _cardMode landed on base, lifts
//the overlay mask so the HUD chips fade back in. Holding the mask until WebGL fade-out completes is
//deliberate, otherwise the HUD would pop back through the still-visible dot cloud.
export function exitLidarView(host: LidarViewHost): void
{
    host._lidarFadeInStartMs  = null;
    host._lidarFadeOutStartMs = performance.now();
    startLidarFadeLoop(host);
}


//Drives the fade alpha while a fade is in flight. Each tick
//computes the current alpha multiplier and pushes it to the
//engine; the WebGL layer composites the dot cloud with that alpha
//next time MapLibre repaints. Self-terminates when both fades are
//null (idle stable state) so the rAF cost stays at zero during
//regular viewing.
export function startLidarFadeLoop(host: LidarViewHost): void
{
    if (host._lidarFadeRaf !== undefined)
    {
        return;
    }
    const tick = (): void =>
    {
        const now = performance.now();
        const inStart  = host._lidarFadeInStartMs;
        const outStart = host._lidarFadeOutStartMs;

        //Exit fade complete, tear down the WebGL layer and lift the overlay mask if the user landed on
        //base (mask stays on if they navigated to shading-dome instead, so the chips don't flash in
        //between modes).
        if (outStart !== null && now - outStart >= LIDAR_FADE_OUT_MS)
        {
            host._lidarFadeOutStartMs = null;
            host._lidarLayerActive    = false;
            host._engine?.setLidarViewFadeAlpha(0);
            host._engine?.setLidarViewActive(false);
            if (host._cardMode === 'base')
            {
                host._overlayMaskActive = false;
            }
            //onMapTransform gated refreshOverlays() out while LiDAR was active, so any camera rotation
            //the user performed inside LiDAR mode left the home silhouette + chip positions frozen at
            //the bearing they had at toggle-on. Push a fresh projection pass now so the glow + leaders
            //land at the right screen coords when the HUD comes back.
            refreshOverlays(host);
        }
        //Enter fade complete, drop the marker so subsequent ticks stop ramping. The layer alpha sits at 1 until the user toggles back off.
        if (inStart !== null && now - inStart >= LIDAR_FADE_IN_MS)
        {
            host._lidarFadeInStartMs = null;
        }

        //Recompute the fade progress on the still-active marker(s)
        //and push to the engine. The push triggers a MapLibre
        //repaint via the layer's setter, so the user sees the
        //updated alpha on the next frame.
        const inT  = host._lidarFadeInStartMs  !== null
            ? Math.max(0, Math.min(1, (now - host._lidarFadeInStartMs)  / LIDAR_FADE_IN_MS))
            : 1;
        const outT = host._lidarFadeOutStartMs !== null
            ? Math.max(0, Math.min(1, (now - host._lidarFadeOutStartMs) / LIDAR_FADE_OUT_MS))
            : 0;
        //Enter ramps 0→1, exit brings it back to 0. They're never both in flight (the enter / exit
        //helpers clear one before setting the other) so the multiplication is a guard.
        const alpha = (host._lidarFadeInStartMs  !== null ? inT : (host._lidarLayerActive ? 1 : 0))
                    * (host._lidarFadeOutStartMs !== null ? (1 - outT) : 1);
        host._engine?.setLidarViewFadeAlpha(alpha);

        if (host._lidarFadeInStartMs !== null || host._lidarFadeOutStartMs !== null)
        {
            host._lidarFadeRaf = requestAnimationFrame(tick);
        }
        else
        {
            host._lidarFadeRaf = undefined;
        }
    };
    host._lidarFadeRaf = requestAnimationFrame(tick);
}


//Bottom-of-card opacity slider, painted only while the LiDAR-View
//mode is active. Mirrors the shading-dome cloud picker (same
//capsule pill, same z-index, same vertical offset) so the two
//modes use a consistent control well. Slider value is a percent
//surface (0..100) for readability; the host bridges it back to
//the [0..1] engine API.
export function renderLidarViewOpacityPicker(
    host:     LidarViewHost,
    onChange: (opacity: number) => void,
): TemplateResult | typeof nothing
{
    const pct        = Math.round(Math.max(0, Math.min(1, host._lidarViewOpacity)) * 100);
    //.is-active is a direct projection of _cardMode (single @state), so the slider's CSS transition
    //fires reliably on the same render as the mode flip. No coupling to the WebGL fade-out timestamp,
    //the pill slides down the moment the user clicks away from lidar mode while the dot cloud takes
    //another LIDAR_FADE_OUT_MS to vanish on its own track.
    const sliderActive = host._cardMode === 'lidar';
    const activeCls    = sliderActive ? ' is-active' : '';
    return html`
        <div class="lidar-view-opacity-slider${activeCls}" aria-label="LiDAR view opacity" ?aria-hidden="${!sliderActive}">
            <ha-icon class="lidar-view-opacity-icon lidar-view-opacity-icon--low"  icon="mdi:circle-outline"></ha-icon>
            <input type="range" min="0" max="100" step="1"
                   class="lidar-view-opacity-range"
                   .value="${String(pct)}"
                   aria-label="LiDAR view opacity percentage"
                   tabindex="${sliderActive ? 0 : -1}"
                   @input="${(e: Event) => {
                       const input = e.target as HTMLInputElement;
                       const v = Number(input.value);
                       onChange(v / 100);
                       //Imperative DOM write for the % readout, the host's `_lidarViewOpacity` is intentionally NOT a `@state`
                       //(the slider fires ~50 input events / s and a state coupling would re-render the entire card on every
                       //tick, see the field comment in helios-card.ts), so a Lit pass would never re-paint the value span on
                       //its own. Mirror what the input.value already reflects natively.
                       const span = input.parentElement?.querySelector('.lidar-view-opacity-value') as HTMLElement | null;
                       if (span)
                       {
                           span.textContent = `${Math.round(v)}%`;
                       }
                   }}" />
            <ha-icon class="lidar-view-opacity-icon lidar-view-opacity-icon--high" icon="mdi:circle"></ha-icon>
            <span class="lidar-view-opacity-value">${pct}%</span>
        </div>
    `;
}
