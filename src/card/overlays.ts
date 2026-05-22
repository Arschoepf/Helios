//Screen-space overlay subsystem: pulls fresh projections from the
//engine (sun arc, cloud disc, home silhouettes, label anchors),
//maps the sun arc samples into stroke-ready segments, controls
//the SMIL animation play-state when the card scrolls in / out of
//view, and exposes the "flow duration" easing used to ramp
//animation speeds with the live production rate.

import type { HeliosEngine } from '../helios-engine';


//Single arc sample as produced by engine.projectSunScene(). The
//card consumes (x, y) for placement and `nearness` / `belowHorizon`
//for visual modulation. `irradiance` is carried alongside for
//consumers that want to colour-modulate per sample.
export interface SunArcSample
{
    x: number;
    y: number;
    irradiance: number;
    nearness:   number;
    belowHorizon: boolean;
}

//Full sun-scene projection: arc samples, sun position, home anchor,
//daylight fraction, plus sunrise / sunset anchors (null when the
//selected day has no sunrise or sunset, polar regions).
export interface SunScene
{
    arc:      SunArcSample[];
    sun:      { x: number; y: number; irradiance: number; altitude: number; nearness: number };
    home:     { x: number; y: number };
    daylight: number;
    sunrise:  { x: number; y: number; angleRad: number; time: Date } | null;
    sunset:   { x: number; y: number; angleRad: number; time: Date } | null;
}

//Screen-space layout of the cloud-cover disc + 100 % reference
//ring, projected through engine.projectCloudScene() on every map
//transform and clock tick.
export interface CloudScene
{
    discLow:    Array<{ x: number; y: number }>;
    discMid:    Array<{ x: number; y: number }>;
    discHigh:   Array<{ x: number; y: number }>;
    ring:       Array<{ x: number; y: number }>;
    cloudHex:   string;
    cloudPct:   number;
    cloudLow:   number;
    cloudMid:   number;
    cloudHigh:  number;
}

//Per-polygon silhouette of one home building in screen space: the
//projected base ring and the projected top ring. Painted into the
//cloud-disc SVG mask so the union covers the exact extruded prism
//even for concave footprints.
export interface HomeSilhouette
{
    base: Array<{ x: number; y: number }>;
    top:  Array<{ x: number; y: number }>;
}

//Screen-space anchor positions for the always-visible chips
//(cloud %, PV W, battery SoC + power) and the ring edge / home
//point used by the leader lines.
export interface LabelLayout
{
    cloudLabel:        { x: number; y: number };
    pvLabel:           { x: number; y: number };
    batterySocLabel:   { x: number; y: number };
    batteryPowerLabel: { x: number; y: number };
    ringEdge:          { x: number; y: number };
    home:              { x: number; y: number };
    //Perspective-projected ground disc around the home. Drawn as
    //a polygon in the PV leader SVG; pulses with the bead arrival
    //by scaling around its centre (which is `home`).
    homeAnchorPoints:  string;
}

//One pair of arc samples mapped to a stroke-ready segment. The
//segment shares one fixed colour (the configured sun colour);
//depth perception comes from `nearness` (modulates stroke width)
//and `belowHorizon` (switches the renderer to night-dot mode).
export interface ArcSegment
{
    x1: number; y1: number;
    x2: number; y2: number;
    color:        string;
    nearness:     number;
    belowHorizon: boolean;
}


//Structural surface the host card exposes. Mixes engine + scene
//state (mutated by refreshOverlays) with the DOM surface
//setAnimationsPaused needs (shadowRoot + classList come from
//LitElement / HTMLElement, the card satisfies them natively).
export interface OverlaysHost
{
    readonly _engine?:      HeliosEngine;
    readonly _selectedTime: Date | null;
    readonly _now:          Date;

    _labelLayout:     LabelLayout | null;
    _sunScene:        SunScene | null;
    _cloudScene:      CloudScene | null;
    _homeSilhouettes: HomeSilhouette[];

    readonly shadowRoot: ShadowRoot | null;
    readonly classList:  DOMTokenList;
}


//Pull the fresh screen-space layouts from the engine and stash
//them on the host. Cheap: each engine projection is a handful of
//matrix multiplies, no allocations of consequence. Called on every
//map transform broadcast by the engine, plus once at first weather
//update (the engine's projection matrix is only ready after the
//style has loaded), plus on every clock tick when in live mode
//(the sun position depends on the time).
export function refreshOverlays(host: OverlaysHost): void
{
    host._labelLayout = host._engine?.projectHomeLabelLayout() ?? null;

    const t = host._selectedTime ?? host._now;
    host._sunScene        = host._engine ? host._engine.projectSunScene(t)   : null;
    host._cloudScene      = host._engine ? host._engine.projectCloudScene()  : null;
    host._homeSilhouettes = host._engine ? host._engine.projectHomeFootprints() : [];

    //LiDAR View overlay lives entirely inside the engine's WebGL
    //custom layer now: no per-transform projection on the JS side,
    //no canvas redraw. The card just drives the fade-in/out alpha
    //via _startLidarFadeLoop; MapLibre re-issues the layer's draw
    //call on every transform automatically.
}


//Pause / resume CSS keyframe animations and SMIL animations when
//the card scrolls in / out of view. Uses the host's class list for
//the CSS side (a single .helios-paused class is keyed off by the
//card stylesheet) and walks the shadow tree to call
//(un)pauseAnimations() on every SVG root for the SMIL side. Both
//SMIL methods are no-ops on browsers that don't support them, so
//no feature-detection is needed.
export function setAnimationsPaused(host: OverlaysHost, paused: boolean): void
{
    host.classList.toggle('helios-paused', paused);
    const root = host.shadowRoot;
    if (!root) return;
    const svgs = root.querySelectorAll('svg');
    for (const svg of Array.from(svgs))
    {
        const s = svg as SVGSVGElement & {
            pauseAnimations?:  () => void;
            unpauseAnimations?: () => void;
        };
        try
        {
            if (paused) s.pauseAnimations?.();
            else        s.unpauseAnimations?.();
        }
        catch (_) {}
    }
}


//Map an arc-sample sequence into stroke-ready segments. The
//caller paints each segment as one <line> with a stroke width
//scaled by `nearness` and a colour pulled from the configured
//sun colour.
export function buildArcSegments(
    arc:      ReadonlyArray<SunArcSample>,
    sunColor: string
): ArcSegment[]
{
    const out: ArcSegment[] = [];
    for (let i = 0; i < arc.length - 1; i++)
    {
        const a = arc[i];
        const b = arc[i + 1];
        out.push({
            x1: a.x, y1: a.y,
            x2: b.x, y2: b.y,
            color:        sunColor,
            nearness:     0.5 * (a.nearness + b.nearness),
            belowHorizon: a.belowHorizon || b.belowHorizon
        });
    }
    return out;
}


//Map a "rate" magnitude to an animation duration in seconds.
//  rate <= 0           → 30 s        (paused, night / no production)
//  rate  = saturation  → minDuration (fastest, full power)
//
//Ease-out cubic ramp: half-saturation already feels meaningfully
//faster than the night baseline, which gives the user the
//feeling of raw power pushing through the line. The minDuration
//is exposed so callers can tune the saturated-end pace per
//channel, the sun ray spans the full map and benefits from a
//slightly slower flow than the PV leader, which is short and
//local.
export function flowDuration(
    rate:        number,
    saturation:  number,
    minDuration: number = 0.4
): number
{
    if (!isFinite(rate) || rate <= 0)
    {
        return 30;
    }
    const f = Math.min(1, rate / saturation);
    const eased = 1 - Math.pow(1 - f, 3);
    return 30 - (30 - minDuration) * eased;
}
