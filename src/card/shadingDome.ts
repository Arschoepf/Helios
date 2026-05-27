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
const DOME_FADE_IN_MS  = 1000;
const DOME_FADE_OUT_MS = 1000;


export interface ShadingDomeHost extends OverlaysHost
{
    readonly _engine?: HeliosEngine;
    _shadingDomeMode:           boolean;
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
    cellPolys:  Array<{ path: string; ratio: number; aged: number; cloudBin: number }>;
    todayArc:   Array<{ x: number; y: number; ratio: number; confidence: number; altitudeDeg: number; belowHorizon: boolean }>;
    sun:        { x: number; y: number; altitudeDeg: number } | null;
}


//Toggle entry point. Mutually exclusive with the LiDAR view; the
//caller (helios-card click handler) is responsible for closing
//LiDAR-view first if needed.
export function toggleShadingDome(host: ShadingDomeHost): void
{
    if (!host._engine) return;
    if (!host._shadingDomeMode)
    {
        host._shadingDomeFadeOutStartMs = null;
        host._shadingDomeFadeInStartMs  = performance.now();
        host._shadingDomeMode = true;
        refreshShadingDomeScene(host);
        refreshOverlays(host);
        startShadingDomeFadeLoop(host);
    }
    else
    {
        host._shadingDomeFadeInStartMs  = null;
        host._shadingDomeFadeOutStartMs = performance.now();
        startShadingDomeFadeLoop(host);
    }
}


//Drive the enter/exit fade by mutating the host's mode flag at the appropriate moment. Visual fade itself is a CSS opacity transition on the dome
//wrapper, this loop only handles the discrete state flip + scheduling the per-frame requestUpdate so Lit re-renders during the transition.
export function startShadingDomeFadeLoop(host: ShadingDomeHost): void
{
    if (host._shadingDomeFadeRaf !== undefined) return;
    const tick = (): void =>
    {
        const now = performance.now();
        const inStart  = host._shadingDomeFadeInStartMs;
        const outStart = host._shadingDomeFadeOutStartMs;

        if (outStart !== null && now - outStart >= DOME_FADE_OUT_MS)
        {
            host._shadingDomeFadeOutStartMs = null;
            host._shadingDomeMode = false;
            host._shadingDomeScene = null;
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
export function refreshShadingDomeScene(host: ShadingDomeHost): void
{
    if (!host._shadingDomeMode || !host._engine)
    {
        host._shadingDomeScene = null;
        return;
    }
    const map = loadMap();
    const nowMs = Date.now();
    //Decode every populated cell once + age its weight so the view layer paints opacity directly without re-deriving it per-frame.
    const decodedCells: Array<{ azimuthDeg: number; altitudeDeg: number; cloudBin: number; ratio: number; aged: number }> = [];
    for (const key of Object.keys(map.cells))
    {
        const cell = map.cells[key];
        const d = decodeCellKey(key, cell);
        if (!d) continue;
        const dDays = Math.max(0, (nowMs - cell.t) / 86_400_000);
        const aged  = cell.w * Math.pow(0.5, dDays / 60);
        if (aged <= 0.05) continue;
        decodedCells.push({
            azimuthDeg:  d.azimuthDeg,
            altitudeDeg: d.altitudeDeg,
            cloudBin:    d.cloudBin,
            ratio:       cell.ema,
            aged,
        });
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
        if (!bin) return null;
        const key = cellKey(bin);
        const cached = lookupCache.get(key);
        if (cached !== undefined) return cached;
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


//Dome visibility gating used to gate the chip on confident cell
//count; the new mode-bar always exposes the segment so this is
//unused. Kept exported (returns true) in case a future surface
//wants to opt in to the same gating again.
export function shouldShowDomeChip(): boolean
{
    return true;
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


//Returns the inline `clip-path` value applied to the dome SVG. The visible portion of the SVG is always anchored to the top edge; the
//bottom-inset percentage is what we animate. On enter, the inset shrinks from 100 % to 0 % so the dome is drawn top-down. On exit, the inset
//grows from 0 % to 100 % so the bottom disappears first and the wipe travels upward, the "other direction" the user asked for. Steady-state
//returns either "no clip" (mode on) or "fully clipped" (mode off); the latter never actually renders because shouldRenderShadingDome() short-
//circuits in renderShadingDomeOverlay before we get here.
export function shadingDomeClipPath(host: ShadingDomeHost): string
{
    const now = performance.now();
    if (host._shadingDomeFadeInStartMs !== null)
    {
        const t = easeOutQuad(Math.max(0, Math.min(1, (now - host._shadingDomeFadeInStartMs) / DOME_FADE_IN_MS)));
        const insetBottom = (1 - t) * 100;
        return `inset(0% 0% ${insetBottom.toFixed(2)}% 0%)`;
    }
    if (host._shadingDomeFadeOutStartMs !== null)
    {
        const t = easeOutQuad(Math.max(0, Math.min(1, (now - host._shadingDomeFadeOutStartMs) / DOME_FADE_OUT_MS)));
        const insetBottom = t * 100;
        return `inset(0% 0% ${insetBottom.toFixed(2)}% 0%)`;
    }
    return host._shadingDomeMode ? 'inset(0% 0% 0% 0%)' : 'inset(0% 0% 100% 0%)';
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
    if (!shouldRenderShadingDome(host)) return nothing;
    const scene = host._shadingDomeScene;
    if (!scene) return nothing;
    const clip = shadingDomeClipPath(host);

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
        wireframeNodes.push(svg`
            <path d="${c.path}"
                  fill="none"
                  stroke="rgba(255,255,255,0.09)"
                  stroke-width="0.35" />
        `);
        if (c.aged > 0)
        {
            const opacity = Math.max(0.18, Math.min(0.55, c.aged / 8));
            coloredNodes.push(svg`
                <path d="${c.path}"
                      fill="${ratioToFill(c.ratio)}"
                      fill-opacity="${opacity}"
                      stroke="rgba(255,255,255,0.22)"
                      stroke-width="0.45" />
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
        if (a.belowHorizon || b.belowHorizon) continue;
        //Use the destination sample's lookup as the segment colour;
        //transitions look natural with that convention.
        const colour = b.confidence > 0 ? ratioToFill(b.ratio) : '#f8e89c';
        const opacity = 0.55 + 0.4 * Math.max(0, Math.min(1, b.confidence));
        ribbonNodes.push(svg`
            <line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}"
                  x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"
                  stroke="${colour}" stroke-opacity="${opacity}"
                  stroke-width="3.5" stroke-linecap="round" />
        `);
    }

    const sunMarker = scene.sun ? svg`
        <circle cx="${scene.sun.x.toFixed(1)}" cy="${scene.sun.y.toFixed(1)}"
                r="7" fill="#fde68a" stroke="rgba(255,255,255,0.9)" stroke-width="1.5" />
        <circle cx="${scene.sun.x.toFixed(1)}" cy="${scene.sun.y.toFixed(1)}"
                r="12" fill="none" stroke="rgba(253, 230, 138, 0.45)" stroke-width="1.5" />
    ` : nothing;

    return html`
        <svg class="shading-dome-svg" style="clip-path:${clip}; -webkit-clip-path:${clip};">
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
    if (shadingDomeFadeAlpha(host) <= 0) return nothing;
    const pct = Math.round(Math.max(0, Math.min(100, host._shadingDomeCloudPct)));
    return html`
        <div class="shading-dome-cloud-slider" aria-label="Cloud cover">
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
