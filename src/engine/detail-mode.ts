//Detail mode camera pose: zoomed in one level and pitched more
//forward (less top-down) so the home reads as a focal model
//rather than a map feature. Entry / exit are both eased with the
//same duration so the transition feels symmetric, and the
//bearing is preserved on entry (the user keeps their current
//orientation) but reset to the hemisphere-aware default on exit,
//mirroring recenter().
//
//Auto-rotate is gated on _detailMode in the tick loop, so the camera doesn't orbit while the dashboard is open. The flag is the source of truth, the
//card just calls setDetailMode in response to the user's home click.
//
//Resting pose (zoom 18, pitch 55) is locked via map.minZoom /
//map.maxZoom so the user can't accidentally pinch-zoom out of
//layout. Detail mode needs to bypass that ceiling, so we widen
//maxZoom on entry, ease the camera to the dive pose, and lock
//it back to 18 once the exit transition lands.

import type { Map as MapLibreMap } from 'maplibre-gl';
import { CAMERA_PITCH_MIN_DEG, CAMERA_PITCH_REST_DEG } from './camera-bounds';


const DETAIL_MODE_ZOOM_TARGET     = 19.5;
//Detail-mode dive ends at the in-card pitch min so the house reads as a mostly top-down 3D model. At
//80 deg (an earlier value) the ground was nearly edge-on and the house read as a flat smudge.
const DETAIL_MODE_PITCH_TARGET    = CAMERA_PITCH_MIN_DEG;
const DETAIL_MODE_TRANSITION_MS   = 800;
//Window during which fresh user gestures are swallowed after a
//detail-mode exit. The exit click that dismisses the dashboard
//panel is followed by an inevitable pointer-down on whatever
//sits behind the panel (timeline, map canvas), which would
//otherwise immediately trigger a scrub or a drag-rotate. The
//cooldown keeps the post-exit moment quiet long enough for the
//user's hand to release.
const POST_EXIT_COOLDOWN_MS       = 600;
//Total bearing sweep applied during the dive. Currently 0, the
//camera dives without rotating; an earlier 270° spin proved too
//busy in practice. Kept as a tunable so a future "cinematic"
//preset can dial it back up without touching the tween code.
const DETAIL_MODE_BEARING_SWEEP   = 0;


//Structural surface the engine exposes to this module. Reads the map / coordinate state, mutates the detail-mode flags + the detail dive rAF handle,
//plus bumps the auto-rotate inactivity timer so the orbit loop stays quiet during the dive transition.
export interface DetailModeHost
{
    readonly map?:     MapLibreMap;
    readonly homeLat:  number;
    readonly homeLon:  number;

    _detailMode:               boolean;
    _detailDiveRaf?:           number;
    //Pre-dive pose snapshot used to restore the user's exact pose on exit. See _detailEntryPitch /
    //_detailEntryBearing on HeliosEngine for the full rationale.
    _detailEntryPitch?:        number;
    _detailEntryBearing?:      number;
    _postExitCooldownUntil:    number;
    _autoRotateLastUserAction: number;
}


//Flip detail-mode on or off and run the eased camera transition. No-op when the requested state matches the current one, so a double-click doesn't
//restart the dive.
export function setDetailMode(host: DetailModeHost, on: boolean): void
{
    if (!host.map || host._detailMode === on)
    {
        return;
    }
    host._detailMode = on;
    //Bump the auto-rotate inactivity timer. The orbit loop is
    //gated on `!_detailMode`, so the moment we flip the flag on
    //exit it would otherwise wake up immediately and call
    //setBearing() on every frame, which cancels the in-flight
    //exit easeTo and snaps the camera straight to the resting
    //pose with no animation. Bumping the timer here keeps the
    //loop quiet for the next AUTO_ROTATE_INACTIVITY_MS, well
    //past the dive transition.
    host._autoRotateLastUserAction = Date.now();
    host.map.stop();

    if (on)
    {
        //Capture the user's pose BEFORE the dive so the symmetric exit transition restores EXACTLY
        //the pose they had on screen, not the hemisphere-aware default. This matters most for users
        //running with the camera-locked chip on, who had previously dialled in a custom pitch /
        //bearing and were quietly forced back to the default every time they closed the dashboard.
        host._detailEntryPitch   = host.map.getPitch();
        host._detailEntryBearing = host.map.getBearing();
        //Widen the zoom ceiling so easeTo can actually reach the
        //dive target (the resting maxZoom is 18, which would
        //otherwise clamp the animation flat).
        try { host.map.setMaxZoom(DETAIL_MODE_ZOOM_TARGET); } catch (_) {}
        diveCamera(
            host,
            DETAIL_MODE_ZOOM_TARGET,
            DETAIL_MODE_PITCH_TARGET,
            +DETAIL_MODE_BEARING_SWEEP,
            true
        );
    }
    else
    {
        //Open the cooldown window: every gesture handler that
        //consults isUserGestureSuppressed() will swallow input
        //until POST_EXIT_COOLDOWN_MS has elapsed.
        host._postExitCooldownUntil = Date.now() + POST_EXIT_COOLDOWN_MS;
        //Restore the captured entry pose. Falls back to the hemisphere-aware default when the entry
        //snapshot is missing (engine respawn while in detail mode is the only path that hits this).
        const exitPitch   = host._detailEntryPitch   ?? CAMERA_PITCH_REST_DEG;
        const exitBearing = host._detailEntryBearing;
        //Bearing is interpolated as startBearing + bearingSweep * e by diveCamera. To LAND at a
        //specific target bearing we compute the sweep on the fly = (target - start). Falls back to
        //the legacy fixed -DETAIL_MODE_BEARING_SWEEP when no entry bearing was captured, preserving
        //the historical behaviour for the engine-respawn edge case above.
        const sweepBack = exitBearing !== undefined
            ? exitBearing - host.map.getBearing()
            : -DETAIL_MODE_BEARING_SWEEP;
        diveCamera(
            host,
            18,
            exitPitch,
            sweepBack,
            false,
            () =>
            {
                if (!host._detailMode)
                {
                    try { host.map?.setMaxZoom(18); } catch (_) {}
                }
                //Clear the snapshot so a fresh entry captures a fresh pose.
                host._detailEntryPitch   = undefined;
                host._detailEntryBearing = undefined;
            }
        );
    }
}


//Custom rAF tween over the WHOLE dive so zoom, pitch and bearing
//share a single smoothstep curve. A previous chained-easeTo
//implementation produced a visible mid-animation hiccup at the
//seam between phase 1's deceleration and phase 2's acceleration,
//plus a one-frame scheduling gap from the moveend → easeTo
//handoff. Driving the camera with jumpTo on every rAF tick
//sidesteps both, and bypasses MapLibre's easeTo bearing
//normalisation (which would collapse a 270° request to its
//shortest -90° equivalent).
export function diveCamera(
    host:         DetailModeHost,
    targetZoom:   number,
    targetPitch:  number,
    bearingSweep: number,
    targetMode:   boolean,
    onComplete?:  () => void
): void
{
    if (!host.map)
    {
        return;
    }
    if (host._detailDiveRaf !== undefined)
    {
        cancelAnimationFrame(host._detailDiveRaf);
        host._detailDiveRaf = undefined;
    }

    const startTime    = performance.now();
    const duration     = DETAIL_MODE_TRANSITION_MS;
    const startZoom    = host.map.getZoom();
    const startPitch   = host.map.getPitch();
    const startBearing = host.map.getBearing();

    //Smoothstep, the same C¹-continuous "ease in / out" curve easeTo uses by default but applied across the entire animation rather than per-phase,
    //so there is no velocity discontinuity halfway through.
    const easeSmoothstep = (t: number): number => t * t * (3 - 2 * t);

    const tick = (now: number): void =>
    {
        //Bail if the engine torn down or the user flipped detail
        //mode mid-transition (a fresh setDetailMode call already
        //started a new tween).
        if (!host.map || host._detailMode !== targetMode)
        {
            host._detailDiveRaf = undefined;
            return;
        }

        const u = Math.min(1, (now - startTime) / duration);
        const e = easeSmoothstep(u);

        //jumpTo bypasses easeTo's animation pipeline entirely so our per-frame interpolation stays the sole source of camera state. Bearing is set to
        //startBearing + sweep×e unwrapped, MapLibre wraps it internally on assignment but the visual rotation between successive frames is the small
        //per-tick delta, so the camera reads as one continuous 270° spin.
        host.map.jumpTo({
            center:  [host.homeLon, host.homeLat],
            zoom:    startZoom    + (targetZoom    - startZoom)    * e,
            pitch:   startPitch   + (targetPitch   - startPitch)   * e,
            bearing: startBearing + bearingSweep                   * e
        });

        if (u < 1)
        {
            host._detailDiveRaf = requestAnimationFrame(tick);
        }
        else
        {
            host._detailDiveRaf = undefined;
            onComplete?.();
        }
    };
    host._detailDiveRaf = requestAnimationFrame(tick);
}
