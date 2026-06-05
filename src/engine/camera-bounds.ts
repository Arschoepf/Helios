//Camera pitch bounds. Single source of truth used by the MapLibre constructor (minPitch / maxPitch),
//the drag-rotate handler, the editor's live setCameraPitch entry point, the initial-pose clamp on
//_initialPitch (covers stored localStorage pose + camera-pitch-deg YAML override) and the detail-mode
//dive target. Changing the limits here propagates to every code path that can move the camera, so the
//user cannot bypass the floor through any pose source. MIN = mostly top-down, MAX = nearly horizontal
//(grazing ground angle), REST = the hemisphere-aware default when nothing else is configured.
//
//Kept in its own module so both helios-engine.ts and detail-mode.ts can pull from one constant set
//without introducing a circular import (detail-mode lives under src/engine/ and is imported by the
//engine itself).

export const CAMERA_PITCH_MIN_DEG  = 15;
export const CAMERA_PITCH_MAX_DEG  = 55;
export const CAMERA_PITCH_REST_DEG = 15;
