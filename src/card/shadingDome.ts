//Shading-dome overlay: when the user toggles the dome chip, the
//rest of the HUD fades out (same CSS class trick as the LiDAR
//view) and a celestial hemisphere appears above the home,
//painted with the shading-map residual data:
//  - a faint background of every populated cell projected as an
//    annular sector on the hemisphere, colour-coded by ratio,
//    opacity-coded by effective sample count;
//  - a bold ribbon following today's sun arc, the per-sample
//    colour pulled from the same map so the user can see, at a
//    glance, where the sun walks through "trusted" cells and how
//    the prediction bends along the day's trajectory;
//  - a sun marker pinned at the current instant for context.
//
//Pure-SVG overlay, projected through the same per-frame
//re-projection loop as the sun arc. Cheap enough to follow the
//camera at 60 fps because the heavy lifting (matrix multiplies)
//happens once per cell per frame, not per pixel.

import { svg, html, nothing, type TemplateResult } from 'lit';
import { refreshOverlays, type OverlaysHost } from './overlays';
import { pickTranslations } from '../i18n';
import {
    binFor,
    cellKey,
    decodeCellKey,
    loadMap,
    lookupRatio,
    type ShadingMap,
} from '../engine/shadingMap';
import type { HeliosEngine } from '../helios-engine';


//1 s for both directions: enter wipes the dome into view top-down, exit wipes it out bottom-up. Long enough that the reveal reads as a deliberate
//polish flourish rather than a click latency, short enough that the user isn't left waiting before they can interact with the cloud-cover slider.
//Match the LiDAR exit timings so the animation cadence reads as
//one consistent family across modes. 1000 ms felt sluggish at the
//exit and was making the chip + timeline transitions look like
//they never played at all.
const DOME_FADE_IN_MS  = 600;
const DOME_FADE_OUT_MS = 280;


export interface ShadingDomeHost extends OverlaysHost
{
    readonly _engine?: HeliosEngine;
    _shadingDomeMode:           boolean;
    //Independent CSS-mask flag for the shading-dome-active body class.
    //Decouples the HUD hide rule from the dome's own render gating so
    //a toggle-off can lift the chip + timeline transitions IMMEDIATELY
    //(at click time) while the dome SVG keeps fading out via the rAF
    //loop. Without this decoupling, the chip transitions chased the
    //class flip happening at end-of-fade and Lit's batched paint
    //collapsed the lift to an instant, which read as "no animation".
    _shadingDomeChipMask:       boolean;
    _shadingDomeFadeInStartMs:  number | null;
    _shadingDomeFadeOutStartMs: number | null;
    _shadingDomeFadeRaf?:       number;
    //Cloud cover percentage selected by the continuous slider.
    //0 = clear, 100 = overcast. The lookup bins it down to one
    //of the eight engine bins; the slider reads continuously so
    //the user thinks in real percentages.
    _shadingDomeCloudPct:       number;
    _shadingDomeScene:          ShadingDomeScene | null;
    //LitElement.requestUpdate(), invoked each frame during the
    //fade so the inline SVG opacity transitions smoothly. The
    //surface is duck-typed because importing LitElement here
    //would pin the engine to Lit's runtime.
    requestUpdate(): void;
}


export interface ShadingDomeScene
{
    homeScreen: { x: number; y: number };
    cellPolys:  Array<{ path: string; ratio: number; aged: number; cloudBin: number; altitudeDeg: number }>;
    todayArc:   Array<{ x: number; y: number; ratio: number; confidence: number; altitudeDeg: number; belowHorizon: boolean }>;
    sun:        { x: number; y: number; altitudeDeg: number } | null;
}


//Toggle entry point. Mutually exclusive with the LiDAR view; the
//caller (helios-card click handler) is responsible for closing
//LiDAR-view first if needed.
export function toggleShadingDome(host: ShadingDomeHost): void
{
    if (!host._engine)
    {
        return;
    }
    if (!host._shadingDomeMode)
    {
        //Mark fade-in start so the fade-loop kicks immediately, but DEFER flipping _shadingDomeMode +
        //_shadingDomeChipMask to the next animation frame. The defer ensures Lit renders the cloud picker
        //once with sliderActive=false (resting state, parked below the card) BEFORE the next render flips
        //sliderActive=true and the CSS transition fires. Without the defer, the picker mounted with
        //is-active on the first paint after toggle and the slide-in animation was skipped entirely on
        //default-UI -> ShadingDome (it worked LiDAR -> ShadingDome only because the LiDAR slider's
        //resting state in that path happens to give Lit a paint frame to settle).
        host._shadingDomeFadeOutStartMs = null;
        host._shadingDomeFadeInStartMs  = performance.now();
        refreshOverlays(host);
        requestAnimationFrame(() =>
        {
            host._shadingDomeMode      = true;
            host._shadingDomeChipMask  = true;
            refreshShadingDomeScene(host);
            host.requestUpdate();
        });
        startShadingDomeFadeLoop(host);
    }
    else
    {
        //Toggle off: lift the chip mask IMMEDIATELY so the
        //shading-dome-active class drops off ha-card on the same
        //paint as the click. The chip + timeline transitions fire
        //right away from a clean reflow point, while the dome SVG
        //keeps rendering via _shadingDomeMode = true + the fade-out
        //marker. The rAF tick at end-of-fade flips _shadingDomeMode
        //off to retire the dome render gate.
        host._shadingDomeFadeInStartMs  = null;
        host._shadingDomeFadeOutStartMs = performance.now();
        host._shadingDomeChipMask       = false;
        refreshOverlays(host);
        startShadingDomeFadeLoop(host);
    }
}


//Drive the enter/exit fade by mutating the host's mode flag at the appropriate moment. Visual fade itself is a CSS opacity transition on the dome
//wrapper, this loop only handles the discrete state flip + scheduling the per-frame requestUpdate so Lit re-renders during the transition.
export function startShadingDomeFadeLoop(host: ShadingDomeHost): void
{
    if (host._shadingDomeFadeRaf !== undefined)
    {
        return;
    }
    const tick = (): void =>
    {
        const now = performance.now();
        const inStart  = host._shadingDomeFadeInStartMs;
        const outStart = host._shadingDomeFadeOutStartMs;

        if (outStart !== null && now - outStart >= DOME_FADE_OUT_MS)
        {
            host._shadingDomeFadeOutStartMs = null;
            host._shadingDomeMode           = false;
            host._shadingDomeChipMask       = false;
            host._shadingDomeScene          = null;
            refreshOverlays(host);
        }
        if (inStart !== null && now - inStart >= DOME_FADE_IN_MS)
        {
            host._shadingDomeFadeInStartMs = null;
        }

        //Drive a Lit re-render so the inline opacity on the SVG
        //wrapper steps to its next value. Without this, the fade
        //would only update on whatever else happens to trigger a
        //render (camera moves, sensor updates) and feel choppy.
        host.requestUpdate();

        if (host._shadingDomeFadeInStartMs !== null || host._shadingDomeFadeOutStartMs !== null)
        {
            host._shadingDomeFadeRaf = requestAnimationFrame(tick);
        }
        else
        {
            host._shadingDomeFadeRaf = undefined;
        }
    };
    host._shadingDomeFadeRaf = requestAnimationFrame(tick);
}


//Build the screen-space dome scene from the engine + the
//currently-loaded shading map. Called on every camera move while
//the dome is active, plus once at toggle-on. Idempotent; sets the
//host scene to null when the engine isn't ready.
//Module-level cache for the decoded cells. The shading map only
//changes on a saveMap() call (training pass) , the dome scene
//refresh, by contrast, fires on every map move while the dome is
//active. Walking 5000+ Object.keys + Math.pow per cell on each
//rotation frame was a major freeze trigger; we now keep the
//decoded list cached and key it on the map object identity (the
//loadMap cache layer returns the same reference between writes).
let _cachedDecodedMapRef: unknown = null;
let _cachedDecodedCells: Array<{
    azimuthDeg:  number;
    altitudeDeg: number;
    cloudBin:    number;
    ratio:       number;
    aged:        number;
}> = [];
let _cachedDecodedStampMs = 0;
//Refresh the decay weight every 5 min of wall clock. Inside that
//window the aged values are reused from the cache; outside, the
//entries are re-decoded so the opacity stays in sync with the
//exponential ageing kernel.
const _DECODE_REFRESH_MS = 5 * 60_000;

export function refreshShadingDomeScene(host: ShadingDomeHost): void
{
    if (!host._shadingDomeMode || !host._engine)
    {
        host._shadingDomeScene = null;
        return;
    }
    const map = loadMap();
    const nowMs = Date.now();
    let decodedCells = _cachedDecodedCells;
    if (_cachedDecodedMapRef !== map
        || nowMs - _cachedDecodedStampMs > _DECODE_REFRESH_MS)
    {
        //Decode every populated cell once + age its weight so the view layer paints opacity directly without re-deriving it per-frame.
        decodedCells = [];
        for (const key of Object.keys(map.cells))
        {
            const cell = map.cells[key];
            const d = decodeCellKey(key, cell);
            if (!d)
            {
                continue;
            }
            const dDays = Math.max(0, (nowMs - cell.t) / 86_400_000);
            const aged  = cell.w * Math.pow(0.5, dDays / 60);
            if (aged <= 0.05)
            {
                continue;
            }
            decodedCells.push({
                azimuthDeg:  d.azimuthDeg,
                altitudeDeg: d.altitudeDeg,
                cloudBin:    d.cloudBin,
                ratio:       cell.ema,
                aged,
            });
        }
        _cachedDecodedMapRef = map;
        _cachedDecodedCells  = decodedCells;
        _cachedDecodedStampMs = nowMs;
    }

    const now = new Date();
    //Slider drives a continuous percent; bin it down for the
    //lookup so it maps to one of the eight engine bins.
    const cloudPct = Math.max(0, Math.min(100, host._shadingDomeCloudPct));
    const cloudBin = Math.min(7, Math.floor(cloudPct / 12.5));

    //Per-frame memoisation cache for the sun-arc ribbon lookups.
    //The arc samples the sun every 15 min over a single day; many
    //consecutive samples land in the SAME (az, alt, cloud) bin
    //because the sun walks ~3.75 deg per sample but the azimuth
    //bin is 10 deg wide. Caching by bin-key turns the ribbon's
    //96 lookups into ~30 actual kernel computations, which
    //dominates the dome's CPU cost on every re-projection.
    const lookupCache = new Map<string, { ratio: number; confidence: number } | null>();
    const cellLookup = (az: number, alt: number, cloud: number) =>
    {
        const bin = binFor(az, alt, cloud);
        if (!bin)
        {
            return null;
        }
        const key = cellKey(bin);
        const cached = lookupCache.get(key);
        if (cached !== undefined)
        {
            return cached;
        }
        const result = lookupRatio(map, az, alt, cloud, nowMs);
        lookupCache.set(key, result);
        return result;
    };

    const scene = host._engine.projectShadingDome({
        cellLookup,
        decodedCells,
        cloudBinForArc: cloudBin,
        liveCloudPct:   cloudPct,
        now,
    });
    host._shadingDomeScene = scene;
}


//Compute the current fade alpha [0, 1] applied to the cloud-cover slider that lives below the dome. The dome SVG itself uses the clip-path
//helper just below for a top-to-bottom reveal; the slider keeps a plain opacity fade because animating a clip on a horizontal control would feel
//odd. Both use the same DOME_FADE_*_MS time base so they finish together.
export function shadingDomeFadeAlpha(host: ShadingDomeHost): number
{
    const now = performance.now();
    if (host._shadingDomeFadeInStartMs !== null)
    {
        return Math.max(0, Math.min(1, (now - host._shadingDomeFadeInStartMs) / DOME_FADE_IN_MS));
    }
    if (host._shadingDomeFadeOutStartMs !== null)
    {
        return 1 - Math.max(0, Math.min(1, (now - host._shadingDomeFadeOutStartMs) / DOME_FADE_OUT_MS));
    }
    return host._shadingDomeMode ? 1 : 0;
}


//Quadratic ease-out so the reveal/hide settles smoothly into its end position rather than stopping cold. Without the ease the 1 s linear wipe
//feels mechanical.
function easeOutQuad(t: number): number
{
    return 1 - (1 - t) * (1 - t);
}


//Soft edge of the altitude-driven wipe, in degrees. Cells whose altitude sits inside the (threshold - SOFT) .. threshold window get a fractional
//opacity so the wipe edge feels like a smooth wash rather than a binary cut at the threshold altitude. 8° is roughly one and a half cell rows of
//the 5° altitude grid, enough to read as a deliberate fade without smearing across half the dome.
const DOME_WIPE_SOFT_DEG = 8;
//Highest altitude the wipe needs to reach to fully reveal every cell + the sun marker; the engine clamps cells at altitude 89 and the sun can sit
//up to ~85°, sweeping the threshold to 100 leaves a small margin so the final frame is unmistakably "everything visible".
const DOME_WIPE_MAX_DEG  = 100;


//Returns the wipe threshold altitude in degrees. The reveal is altitude-anchored so the zenith (highest cells) is always the last drawn on enter
//and the first erased on exit, regardless of the user's camera rotation. On enter the threshold rises from 0 toward DOME_WIPE_MAX_DEG over 1 s,
//each cell faded in once the threshold passes its altitude. On exit the threshold falls back toward 0; high-altitude cells lose visibility first,
//the horizon ring is the last to disappear. Steady-state returns DOME_WIPE_MAX_DEG (everything visible) when the mode is on, or 0 when off.
export function shadingDomeWipeThreshold(host: ShadingDomeHost): number
{
    const now = performance.now();
    if (host._shadingDomeFadeInStartMs !== null)
    {
        const t = easeOutQuad(Math.max(0, Math.min(1, (now - host._shadingDomeFadeInStartMs) / DOME_FADE_IN_MS)));
        return t * DOME_WIPE_MAX_DEG;
    }
    if (host._shadingDomeFadeOutStartMs !== null)
    {
        const t = easeOutQuad(Math.max(0, Math.min(1, (now - host._shadingDomeFadeOutStartMs) / DOME_FADE_OUT_MS)));
        return (1 - t) * DOME_WIPE_MAX_DEG;
    }
    return host._shadingDomeMode ? DOME_WIPE_MAX_DEG : 0;
}


//Per-cell opacity multiplier for the wipe. 0 means "below the threshold, hide this cell"; 1 means "well above the threshold, render at full
//opacity"; values in between fall on the soft edge.
function wipeAlphaForAltitude(cellAltitudeDeg: number, threshold: number): number
{
    const delta = threshold - cellAltitudeDeg;
    if (delta <= 0)
    {
        return 0;
    }
    if (delta >= DOME_WIPE_SOFT_DEG)
    {
        return 1;
    }
    return delta / DOME_WIPE_SOFT_DEG;
}


//Should the dome SVG be in the DOM at all? Yes while the mode is on OR while a fade transition is running. Used by the renderer to bail out
//between transitions when the dome is fully hidden, both to save a Lit pass and to make sure pointer-events don't sit on an invisible overlay.
function shouldRenderShadingDome(host: ShadingDomeHost): boolean
{
    return host._shadingDomeMode
        || host._shadingDomeFadeInStartMs !== null
        || host._shadingDomeFadeOutStartMs !== null;
}


//Same colour ramp as the editor heatmap so the dome reads identically across the two surfaces.
function ratioToFill(ratio: number): string
{
    const r = Math.max(0.3, Math.min(1.7, ratio));
    if (r < 1)
    {
        const t = (1 - r) / 0.7;
        const red   = 235;
        const green = Math.round(235 * (1 - t * 0.85));
        const blue  = Math.round(235 * (1 - t * 0.85));
        return `rgb(${red}, ${green}, ${blue})`;
    }
    const t = (r - 1) / 0.7;
    const red   = Math.round(235 * (1 - t * 0.85));
    const green = 235;
    const blue  = Math.round(235 * (1 - t * 0.85));
    return `rgb(${red}, ${green}, ${blue})`;
}


//Render the dome SVG. The wrapper carries the fade-alpha as an
//inline opacity; the SVG fills the host canvas (CSS
//`position: absolute; inset: 0; pointer-events: none`).
//
//Three layered groups:
//  1. faint cell polygons (background structure)
//  2. today's sun-arc ribbon, colour-pulled per sample
//  3. current-sun marker
//
//Returns nothing when the scene isn't ready, so the card template can drop the result directly into its render.
export function renderShadingDomeOverlay(host: ShadingDomeHost): TemplateResult | typeof nothing
{
    if (!shouldRenderShadingDome(host))
    {
        return nothing;
    }
    const scene = host._shadingDomeScene;
    if (!scene)
    {
        return nothing;
    }
    //Altitude-driven wipe threshold: each cell, ribbon segment and the sun marker get multiplied by an alpha derived from the cell's own altitude
    //vs this threshold. While the threshold is high (steady-state mode-on), every alpha resolves to 1 and the render is identical to the pre-wipe
    //version. While the threshold travels through the altitude range, the low-altitude cells light up first and the zenith last.
    const wipe = shadingDomeWipeThreshold(host);

    //Two cell layers, drawn back-to-front:
    //  1. Wireframe of the full grid (every populated + empty
    //     cell as a thin outline) so the lattice structure is
    //     always visible and the dome reads as a hemisphere.
    //  2. Crisp coloured fills for populated cells only. Each
    //     cell carries its decay-weighted opacity directly; no
    //     blur, so the boundaries between cells stay sharp and
    //     the user can tell exactly which (azimuth, altitude)
    //     bin is being shown.
    const wireframeNodes: TemplateResult[] = [];
    const coloredNodes:   TemplateResult[] = [];
    for (const c of scene.cellPolys)
    {
        const wipeAlpha = wipeAlphaForAltitude(c.altitudeDeg, wipe);
        if (wipeAlpha <= 0)
        {
            continue;
        }
        //Wireframe + outlines use currentColor so the theme override
        //below can swap white -> black via .shading-dome-cells-* in
        //light mode without touching the per-cell opacity envelope.
        wireframeNodes.push(svg`
            <path d="${c.path}"
                  fill="none"
                  stroke="currentColor"
                  stroke-opacity="${0.22 * wipeAlpha}"
                  stroke-width="0.6" />
        `);
        if (c.aged > 0)
        {
            const opacity = Math.max(0.18, Math.min(0.55, c.aged / 8)) * wipeAlpha;
            coloredNodes.push(svg`
                <path d="${c.path}"
                      fill="${ratioToFill(c.ratio)}"
                      fill-opacity="${opacity}"
                      stroke="currentColor"
                      stroke-opacity="${0.45 * wipeAlpha}"
                      stroke-width="0.85" />
            `);
        }
    }

    //Ribbon: paint as small connected line segments so the colour can shift per-sample. A single <polyline> would force one stroke colour across the
    //whole arc.
    const ribbonNodes: TemplateResult[] = [];
    const arc = scene.todayArc;
    for (let i = 1; i < arc.length; i++)
    {
        const a = arc[i - 1];
        const b = arc[i];
        if (a.belowHorizon || b.belowHorizon)
        {
            continue;
        }
        //Use the destination sample's lookup as the segment colour;
        //transitions look natural with that convention.
        const colour = b.confidence > 0 ? ratioToFill(b.ratio) : '#f8e89c';
        //Take the higher of the two endpoints' altitudes for the wipe gate so the segment only paints once its upper end has been reached by the
        //threshold. Keeps the ribbon following the same horizon-up reveal as the cells underneath instead of leaking ahead of them at the peak.
        const segAlt    = Math.max(a.altitudeDeg, b.altitudeDeg);
        const wipeAlpha = wipeAlphaForAltitude(segAlt, wipe);
        if (wipeAlpha <= 0)
        {
            continue;
        }
        const opacity = (0.55 + 0.4 * Math.max(0, Math.min(1, b.confidence))) * wipeAlpha;
        ribbonNodes.push(svg`
            <line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}"
                  x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"
                  stroke="${colour}" stroke-opacity="${opacity}"
                  stroke-width="3.5" stroke-linecap="round" />
        `);
    }

    const sunWipeAlpha = scene.sun ? wipeAlphaForAltitude(scene.sun.altitudeDeg, wipe) : 0;
    const sunMarker = (scene.sun && sunWipeAlpha > 0) ? svg`
        <g opacity="${sunWipeAlpha.toFixed(2)}">
            <circle cx="${scene.sun.x.toFixed(1)}" cy="${scene.sun.y.toFixed(1)}"
                    r="7" fill="#fde68a" stroke="rgba(255,255,255,0.9)" stroke-width="1.5" />
            <circle cx="${scene.sun.x.toFixed(1)}" cy="${scene.sun.y.toFixed(1)}"
                    r="12" fill="none" stroke="rgba(253, 230, 138, 0.45)" stroke-width="1.5" />
        </g>
    ` : nothing;

    //Overall SVG opacity = shadingDomeFadeAlpha so the dome ENTRY
    //ramps from invisible to opaque alongside the chip fade-out. The
    //altitude wipe still rolls the cells in horizon-to-zenith inside
    //that ramp; without this opacity multiplier the low-altitude
    //cells appeared opaque immediately and covered the chips before
    //their CSS transition could play, which the user reported as
    //"the entry animation doesn't play". On exit, the same fade-out
    //ramps the dome back to invisible while the chips fade in.
    const fadeAlpha = shadingDomeFadeAlpha(host);
    return html`
        <svg class="shading-dome-svg" style="opacity:${fadeAlpha.toFixed(3)}">
            <g class="shading-dome-cells-wire">${wireframeNodes}</g>
            <g class="shading-dome-cells-color">${coloredNodes}</g>
            <g class="shading-dome-ribbon">${ribbonNodes}</g>
            <g class="shading-dome-sun">${sunMarker}</g>
        </svg>
    `;
}


//Continuous cloud-cover slider with a sun glyph on the LEFT and
//a heavy-cloud glyph on the RIGHT. The slider reads as "the dome
//shows the model's view of THIS amount of cloud cover", which is
//a more direct user mental model than picking from named bins.
//step=12.5 snaps to the eight engine bins so the cursor only
//lands on a real boundary; the percent is binned down at lookup
//time so the underlying data model stays continuous on the wire.
export function renderShadingDomeCloudPicker(
    host: ShadingDomeHost,
    onChange: (pct: number) => void,
): TemplateResult | typeof nothing
{
    const pct = Math.round(Math.max(0, Math.min(100, host._shadingDomeCloudPct)));
    //Always rendered so the slide-out CSS transition can run when the
    //mode is dropped. .is-active lifts the pill into view + enables
    //pointer events; without the class CSS parks it below the card
    //with opacity 0. The exit fade marker drops the class straight
    //away on toggle-off so the pill slides DOWN in parallel with the
    //dome's own fade-out instead of waiting for it to complete.
    const sliderActive = host._shadingDomeMode && host._shadingDomeFadeOutStartMs === null;
    const activeCls    = sliderActive ? ' is-active' : '';
    const tr = pickTranslations((host as unknown as { hass?: { language?: string } }).hass?.language);
    const hint = tr.detail.shadingDomeHint
        ?? 'Auto-learned shading dome. Each cell shows the average PV output at that sun position, for the cloud cover chosen below. Helios applies it to the forecast so real shadows are captured automatically.';
    return html`
        <div class="shading-dome-cloud-hint${activeCls}" aria-hidden="${!sliderActive}">${hint}</div>
        <div class="shading-dome-cloud-slider${activeCls}" aria-label="Cloud cover" ?aria-hidden="${!sliderActive}">
            <ha-icon class="shading-dome-cloud-icon shading-dome-cloud-icon--sun"   icon="mdi:weather-sunny"></ha-icon>
            <div class="shading-dome-cloud-track-wrap">
                <input type="range" min="0" max="100" step="12.5"
                       class="shading-dome-cloud-range"
                       .value="${String(pct)}"
                       aria-label="Cloud cover percentage"
                       @input="${(e: Event) => onChange(Number((e.target as HTMLInputElement).value))}" />
                <!--  Visual ticks for every snap point on the
                      8-bin scale (12.5 % intervals). The slider
                      snaps to these via step=12.5 so each tick
                      tells the user "you can land here".
                      Position uses calc() with the thumb radius
                      (--thumb-r, 7 px) so each tick lands on the
                      actual thumb centre at that value, not on
                      the geometric percentage of the wrap (which
                      would be off by ~half-a-thumb-width).      -->
                <span class="shading-dome-cloud-tick" style="left:calc(var(--thumb-r) + (100% - 2 * var(--thumb-r)) * 0.125)"></span>
                <span class="shading-dome-cloud-tick" style="left:calc(var(--thumb-r) + (100% - 2 * var(--thumb-r)) * 0.250)"></span>
                <span class="shading-dome-cloud-tick" style="left:calc(var(--thumb-r) + (100% - 2 * var(--thumb-r)) * 0.375)"></span>
                <span class="shading-dome-cloud-tick" style="left:calc(var(--thumb-r) + (100% - 2 * var(--thumb-r)) * 0.500)"></span>
                <span class="shading-dome-cloud-tick" style="left:calc(var(--thumb-r) + (100% - 2 * var(--thumb-r)) * 0.625)"></span>
                <span class="shading-dome-cloud-tick" style="left:calc(var(--thumb-r) + (100% - 2 * var(--thumb-r)) * 0.750)"></span>
                <span class="shading-dome-cloud-tick" style="left:calc(var(--thumb-r) + (100% - 2 * var(--thumb-r)) * 0.875)"></span>
            </div>
            <ha-icon class="shading-dome-cloud-icon shading-dome-cloud-icon--cloud" icon="mdi:weather-cloudy"></ha-icon>
            <span class="shading-dome-cloud-value">${pct}%</span>
        </div>
    `;
}


//Re-export so the helios-card import surface stays tight.
export { type ShadingMap };
