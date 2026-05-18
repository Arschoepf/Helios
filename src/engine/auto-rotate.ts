//Smooth, time-based auto-rotation around the home. Runs in the
//OPPOSITE direction to the sun's apparent motion (decreasing
//bearing in NH, where the sun goes east → south → west, i.e.
//clockwise from above) so the camera and the live sun visually
//counter-orbit each other, a quiet but constant motion that
//makes the card feel alive even with no user input. The rotation
//pauses for AUTO_ROTATE_INACTIVITY_MS after every user gesture
//(mouse down / wheel / touch) so the user has full control during
//a manipulation, then resumes from wherever the user left the
//camera, no recalibration to a fixed bearing.
//
//We tween in seconds (delta-time integrated against the frame
//rate) rather than a fixed per-frame increment so the rotation
//speed is constant across 60 Hz / 120 Hz displays and survives
//tab-throttling with no visible jumps when the user comes back.

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { HeliosConfig } from '../helios-config';


const AUTO_ROTATE_DEG_PER_SEC   = 1.5;
const AUTO_ROTATE_INACTIVITY_MS = 5_000;


//Structural surface the engine exposes to this loop. Only the
//fields the loop actually reads / writes; gesture handlers in the
//engine bump `_autoRotateLastUserAction` directly, no helper here
//(a 1-line assignment doesn't benefit from a wrapper).
export interface AutoRotateHost
{
    readonly map?:         MapLibreMap;
    readonly cfg:          HeliosConfig;
    readonly _detailMode:  boolean;

    _autoRotateRaf?:           number;
    _autoRotateLastFrame:      number;
    _autoRotateLastUserAction: number;
}


//Kick off the rotation rAF loop. Idempotent: a second call while
//the loop is already running is a no-op. The loop self-terminates
//when the map goes away (engine cleanup); the cleanup path also
//cancels the rAF directly to drop it on the same frame.
export function startAutoRotateLoop(host: AutoRotateHost): void
{
    if (host._autoRotateRaf !== undefined || !host.map)
    {
        return;
    }
    host._autoRotateLastFrame      = performance.now();
    host._autoRotateLastUserAction = 0;

    const tick = (t: number) =>
    {
        if (!host.map)
        {
            host._autoRotateRaf = undefined;
            return;
        }

        const dt = Math.max(0, t - host._autoRotateLastFrame) / 1000;
        host._autoRotateLastFrame = t;

        const sinceUser = Date.now() - host._autoRotateLastUserAction;
        //Strict equality check: an undefined config (the common
        //case for fresh installs) defaults to OFF. Auto-rotation
        //is a stylistic touch some users find distracting, and
        //in scrub mode it can confuse "did the camera move or
        //did time pass?". The user has to explicitly opt in via
        //the editor toggle. Detail mode also suppresses it.
        const autoRotateEnabled = host.cfg['auto-rotate-enabled'] === true;
        if (autoRotateEnabled
            && !host._detailMode
            && sinceUser >= AUTO_ROTATE_INACTIVITY_MS)
        {
            //Negative delta: bearing decreases, camera rotates
            //counter-clockwise around the up axis as seen
            //from above, map content drifts clockwise on
            //screen, opposite of the sun's apparent motion.
            const next = host.map.getBearing()
                - AUTO_ROTATE_DEG_PER_SEC * dt;
            host.map.setBearing(next);
        }

        host._autoRotateRaf = requestAnimationFrame(tick);
    };
    host._autoRotateRaf = requestAnimationFrame(tick);
}
