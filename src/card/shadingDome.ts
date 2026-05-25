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
    decodeCellKey,
    describeMap,
    loadMap,
    lookupRatio,
    type ShadingMap,
} from '../engine/shadingMap';
import type { HeliosEngine } from '../helios-engine';


const DOME_FADE_IN_MS  = 380;
const DOME_FADE_OUT_MS = 280;

//Threshold below which the dome chip is hidden entirely (no
//cluttering the HUD with a button that opens an empty canvas).
//Three cells with a kernel-smoothed lookup typically take a
//handful of sunny hours to accumulate; below that we're not
//confidently showing anything.
const MIN_CONFIDENT_CELLS_FOR_CHIP = 3;


export interface ShadingDomeHost extends OverlaysHost
{
    readonly _engine?: HeliosEngine;
    _shadingDomeMode:           boolean;
    _shadingDomeFadeInStartMs:  number | null;
    _shadingDomeFadeOutStartMs: number | null;
    _shadingDomeFadeRaf?:       number;
    //Cloud cover percentage selected by the continuous slider.
    //0 = clear, 100 = overcast. The lookup bins it down to one
    //of the four engine bins; the slider reads continuously so
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


//Drive the enter/exit fade by mutating the host's mode flag at
//the appropriate moment. Visual fade itself is a CSS opacity
//transition on the dome wrapper, this loop only handles the
//discrete state flip + scheduling the per-frame requestUpdate so
//Lit re-renders during the transition.
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
    //Decode every populated cell once + age its weight so the
    //view layer paints opacity directly without re-deriving it
    //per-frame.
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
    //lookup so it maps to one of the four engine bins.
    const cloudPct = Math.max(0, Math.min(100, host._shadingDomeCloudPct));
    const cloudBin = Math.min(3, Math.floor(cloudPct / 25));
    const scene = host._engine.projectShadingDome({
        cellLookup:     (az, alt, cloud) => lookupRatio(map, az, alt, cloud, nowMs),
        decodedCells,
        cloudBinForArc: cloudBin,
        liveCloudPct:   cloudPct,
        now,
    });
    host._shadingDomeScene = scene;
}


//Should the dome chip surface at all? Hidden until the user's
//map has accumulated enough confident cells to actually show
//something interesting. Cheap: O(cells), called from the card
//render path which already loads the map on first chart pass.
//
//ALPHA-ONLY OVERRIDE: returns true unconditionally so the user
//can demo the dome rendering without waiting 1-3 sunny days for
//the map to populate. Restore the gated logic below before any
//1.7.0 beta / stable release.
export function shouldShowDomeChip(): boolean
{
    return true;
    // eslint-disable-next-line no-unreachable
    const map = loadMap();
    if (!map || !map.cells) return false;
    const stats = describeMap(map, Date.now());
    return stats.confidentCells >= MIN_CONFIDENT_CELLS_FOR_CHIP;
}


//Compute the current fade alpha [0, 1] applied to the dome
//wrapper. Used by the card template to drive a CSS opacity so
//the fade is GPU-cheap (composite-only, no layout) regardless of
//how many cells are painted.
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


//Same colour ramp as the editor heatmap so the dome reads
//identically across the two surfaces.
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
//Returns nothing when the scene isn't ready, so the card
//template can drop the result directly into its render.
export function renderShadingDomeOverlay(host: ShadingDomeHost): TemplateResult | typeof nothing
{
    const alpha = shadingDomeFadeAlpha(host);
    if (alpha <= 0) return nothing;
    const scene = host._shadingDomeScene;
    if (!scene) return nothing;

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
                  stroke="rgba(255,255,255,0.16)"
                  stroke-width="0.4" />
        `);
        if (c.aged > 0)
        {
            const opacity = Math.max(0.18, Math.min(0.55, c.aged / 8));
            coloredNodes.push(svg`
                <path d="${c.path}"
                      fill="${ratioToFill(c.ratio)}"
                      fill-opacity="${opacity}"
                      stroke="rgba(255,255,255,0.35)"
                      stroke-width="0.5" />
            `);
        }
    }

    //Ribbon: paint as small connected line segments so the colour
    //can shift per-sample. A single <polyline> would force one
    //stroke colour across the whole arc.
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
        <svg class="shading-dome-svg" style="opacity:${alpha.toFixed(2)}">
            <g class="shading-dome-cells-wire">${wireframeNodes}</g>
            <g class="shading-dome-cells-color">${coloredNodes}</g>
            <g class="shading-dome-ribbon">${ribbonNodes}</g>
            <g class="shading-dome-sun">${sunMarker}</g>
        </svg>
    `;
}


//Continuous cloud-cover slider with a sun glyph on the LEFT and
//a heavy-cloud glyph on the RIGHT. Replaces the 4-pill segmented
//control: the slider reads as "the dome shows the model's view
//of THIS amount of cloud cover", which is a more direct user
//mental model than picking from named bins. The percent is binned
//down to one of the four engine bins at lookup time so the
//underlying data model is unchanged.
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
                      tells the user "you can land here".         -->
                <span class="shading-dome-cloud-tick" style="left:12.5%"></span>
                <span class="shading-dome-cloud-tick" style="left:25%"></span>
                <span class="shading-dome-cloud-tick" style="left:37.5%"></span>
                <span class="shading-dome-cloud-tick" style="left:50%"></span>
                <span class="shading-dome-cloud-tick" style="left:62.5%"></span>
                <span class="shading-dome-cloud-tick" style="left:75%"></span>
                <span class="shading-dome-cloud-tick" style="left:87.5%"></span>
            </div>
            <ha-icon class="shading-dome-cloud-icon shading-dome-cloud-icon--cloud" icon="mdi:weather-cloudy"></ha-icon>
            <span class="shading-dome-cloud-value">${pct}%</span>
        </div>
    `;
}


//Re-export so the helios-card import surface stays tight.
export { type ShadingMap };
