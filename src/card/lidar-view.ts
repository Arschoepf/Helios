//LiDAR View overlay: when the user clicks the View button, the regular map UI fades out and every loaded LiDAR cell is projected to screen as a small
//dot. This module handles the toggle gesture and drives the alpha-fade rAF loop that smooths both the enter and the exit transitions.
//
//Same host-driven pattern as the timeline / overlays modules: the card owns the `@state` flag and the fade timestamps, the helpers here mutate them
//through a structural LidarViewHost.

import { refreshOverlays, type OverlaysHost } from './overlays';
import type { HeliosEngine } from '../helios-engine';


//Fade durations. Enter is slightly longer than exit so the dot
//cloud reads as a deliberate "settle in"; exit hurries back so the
//HUD comes back fast when the user dismisses the view.
const LIDAR_FADE_IN_MS  = 380;
const LIDAR_FADE_OUT_MS = 280;


//Structural surface the host card exposes. Extends OverlaysHost so
//toggleLidarView can fire refreshOverlays(host) immediately on
//enter without juggling two host arguments.
export interface LidarViewHost extends OverlaysHost
{
    readonly _engine?:           HeliosEngine;

    _lidarViewMode:              boolean;
    _lidarFadeInStartMs:         number | null;
    _lidarFadeOutStartMs:        number | null;
    _lidarFadeRaf?:              number;
}


//Toggle the LiDAR View overlay. Disabled (silently no-op) when
//the engine reports no provider covers the home, so the user
//never gets stuck in an empty-canvas view.
//
//Enter: dots fade in over ~380 ms via a uniform alpha ramp on the
//canvas; the .lidar-view-active class lands at the same instant
//so the regular HUD fades out via its own CSS transition under
//the appearing cloud.
//
//Exit: two-phase. First the dot cloud fades back out in ~280 ms, THEN .lidar-view-active drops so the regular HUD fades back in via the existing CSS
//transition. We delay the class flip so the HUD doesn't pop back through the still-visible cloud.
//
//We deliberately do NOT clip-mask the dots to a perspective
//polygon during the fade: that was the single most expensive
//thing in the draw path (per-frame 64-vertex clip stomped the
//GPU rasteriser), and at the current frame budget it wasn't
//worth the visual flourish.
export function toggleLidarView(host: LidarViewHost): void
{
    if (!host._engine) return;
    if (!host._lidarViewMode && host._engine.getActiveLidarSourceId() === null) return;

    if (!host._lidarViewMode)
    {
        //Off → on. Engaging immediately.
        host._lidarFadeOutStartMs = null;
        host._lidarFadeInStartMs  = performance.now();
        host._lidarViewMode = true;
        host._engine.setLidarViewActive(true);
        refreshOverlays(host);
        startLidarFadeLoop(host);
    }
    else
    {
        //On → off. Start the exit fade; the class flip + engine
        //setLidarViewActive(false) happen at the end of the fade
        //so the dot cloud doesn't blink off before the HUD eases
        //back in.
        host._lidarFadeInStartMs  = null;
        host._lidarFadeOutStartMs = performance.now();
        startLidarFadeLoop(host);
    }
}


//Drives the fade alpha while a fade is in flight. Each tick
//computes the current alpha multiplier and pushes it to the
//engine; the WebGL layer composites the dot cloud with that alpha
//next time MapLibre repaints. Self-terminates when both fades are
//null (idle stable state) so the rAF cost stays at zero during
//regular viewing.
export function startLidarFadeLoop(host: LidarViewHost): void
{
    if (host._lidarFadeRaf !== undefined) return;
    const tick = (): void =>
    {
        const now = performance.now();
        const inStart  = host._lidarFadeInStartMs;
        const outStart = host._lidarFadeOutStartMs;

        //Exit fade complete, finalise the mode flip and clamp the layer alpha to 0 in one go.
        if (outStart !== null && now - outStart >= LIDAR_FADE_OUT_MS)
        {
            host._lidarFadeOutStartMs = null;
            host._lidarViewMode = false;
            host._engine?.setLidarViewFadeAlpha(0);
            host._engine?.setLidarViewActive(false);
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
        //Enter ramps 0→1, exit brings it back to 0. They're never
        //both in flight (toggle clears one before starting the
        //other) so the multiplication is a guard.
        const alpha = (host._lidarFadeInStartMs  !== null ? inT : (host._lidarViewMode ? 1 : 0))
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
