//Cloud-cover dome overlay: when the user toggles the cloud dome
//chip, the rest of the HUD fades out and a celestial hemisphere
//appears above the home, "filled" with three stacked horizontal
//bands (low / mid / high cloud cover). Each band's opacity scales
//with the matching cover percentage so a 100% low-cover sky reads
//as a dense fog hugging the horizon while a 0% layer disappears
//completely.
//
//Mirrors the shadingDome.ts module: same toggle / fade / scene /
//render plumbing, same per-frame re-projection on map transforms.

import { svg, html, nothing, type TemplateResult } from 'lit';
import { refreshOverlays, type OverlaysHost } from './overlays';
import type { HeliosEngine } from '../helios-engine';


//Match the shading dome's fade timing so toggling between the two
//modes feels uniform.
//Fade-in budget must cover the longest per-layer reveal: the
//`high` disc starts at LAYER_DELAY_MS[2] = 700 ms and takes
//LAYER_FADE_DUR_MS = 600 ms to fill, finishing at 1300 ms. The
//1500 ms ceiling below leaves a small safety margin so the fade
//loop's tick is guaranteed to drive the last few frames of the
//`high` disc reveal.
const CLOUD_DOME_FADE_IN_MS  = 1500;
const CLOUD_DOME_FADE_OUT_MS = 700;


export interface CloudDomeScene
{
    homeScreen: { x: number; y: number };
    //One flat disc per atmospheric layer. ringPath is the 100 %
    //reference polygon (always full size); fillPath is the same
    //circle scaled by cover/100 to show the live percentage.
    layers: Array<{
        kind:     'low' | 'mid' | 'high';
        cover:    number;
        ringPath: string;
        fillPath: string;
    }>;
}


export interface CloudDomeHost extends OverlaysHost
{
    readonly _engine?: HeliosEngine;

    _cloudDomeMode:           boolean;
    _cloudDomeFadeInStartMs:  number | null;
    _cloudDomeFadeOutStartMs: number | null;
    _cloudDomeFadeRaf?:       number;
    _cloudDomeScene:          CloudDomeScene | null;

    //Live cloud cover percentage at the home, used to drive both
    //the chip icon and the mode-bar button icon (so the user knows
    //the current sky state without opening the dome).
    readonly _cloudCover: number;

    requestUpdate(): void;
}


//Toggle entry point. Mutually exclusive with the shading dome and
//the LiDAR view, the caller closes any active mode first.
export function toggleCloudDome(host: CloudDomeHost): void
{
    if (!host._engine) return;
    if (!host._cloudDomeMode)
    {
        host._cloudDomeFadeOutStartMs = null;
        host._cloudDomeFadeInStartMs  = performance.now();
        host._cloudDomeMode = true;
        refreshCloudDomeScene(host);
        refreshOverlays(host);
        startCloudDomeFadeLoop(host);
    }
    else
    {
        host._cloudDomeFadeInStartMs  = null;
        host._cloudDomeFadeOutStartMs = performance.now();
        startCloudDomeFadeLoop(host);
    }
}


export function startCloudDomeFadeLoop(host: CloudDomeHost): void
{
    if (host._cloudDomeFadeRaf !== undefined) return;
    const tick = (): void =>
    {
        const now = performance.now();
        const inStart  = host._cloudDomeFadeInStartMs;
        const outStart = host._cloudDomeFadeOutStartMs;

        if (outStart !== null && now - outStart >= CLOUD_DOME_FADE_OUT_MS)
        {
            host._cloudDomeFadeOutStartMs = null;
            host._cloudDomeMode = false;
            host._cloudDomeScene = null;
            refreshOverlays(host);
        }
        if (inStart !== null && now - inStart >= CLOUD_DOME_FADE_IN_MS)
        {
            host._cloudDomeFadeInStartMs = null;
        }

        host.requestUpdate();

        if (host._cloudDomeFadeInStartMs !== null || host._cloudDomeFadeOutStartMs !== null)
        {
            host._cloudDomeFadeRaf = requestAnimationFrame(tick);
        }
        else
        {
            host._cloudDomeFadeRaf = undefined;
        }
    };
    host._cloudDomeFadeRaf = requestAnimationFrame(tick);
}


//Recompute the dome scene from the engine. Idempotent; called on
//camera moves while the dome is active plus once at toggle-on.
export function refreshCloudDomeScene(host: CloudDomeHost): void
{
    if (!host._cloudDomeMode || !host._engine)
    {
        host._cloudDomeScene = null;
        return;
    }
    //Pull the live per-band cover from the cloud scene (which the
    //engine refreshes whenever weather lands). Default to zero when
    //the data hasn't arrived yet so the dome still renders as a
    //wireframe-style empty hemisphere.
    const cloudScene = host._engine.projectCloudScene();
    const low  = cloudScene?.cloudLow  ?? 0;
    const mid  = cloudScene?.cloudMid  ?? 0;
    const high = cloudScene?.cloudHigh ?? 0;

    host._cloudDomeScene = host._engine.projectCloudDome({
        cloudLow:  low,
        cloudMid:  mid,
        cloudHigh: high,
    });
}


function shouldRenderCloudDome(host: CloudDomeHost): boolean
{
    return host._cloudDomeMode
        || host._cloudDomeFadeInStartMs !== null
        || host._cloudDomeFadeOutStartMs !== null;
}


export function cloudDomeFadeAlpha(host: CloudDomeHost): number
{
    const now = performance.now();
    if (host._cloudDomeFadeInStartMs !== null)
    {
        const t = Math.max(0, Math.min(1, (now - host._cloudDomeFadeInStartMs) / CLOUD_DOME_FADE_IN_MS));
        return easeOutQuad(t);
    }
    if (host._cloudDomeFadeOutStartMs !== null)
    {
        const t = Math.max(0, Math.min(1, (now - host._cloudDomeFadeOutStartMs) / CLOUD_DOME_FADE_OUT_MS));
        return 1 - easeOutQuad(t);
    }
    return host._cloudDomeMode ? 1 : 0;
}


function easeOutQuad(t: number): number
{
    return 1 - (1 - t) * (1 - t);
}


//Map a cloud-cover percentage to the SVG fill opacity for that
//layer. Sub-linear so even a 30% layer reads as a faint mist; a
//100% layer caps at 0.55 so the layers underneath stay visible
//when they too carry their own opacity.
function coverToOpacity(coverPct: number): number
{
    const t = Math.max(0, Math.min(100, coverPct)) / 100;
    return 0.10 + Math.sqrt(t) * 0.45;
}


//Map a 0..100 cloud cover to a Material Design Icons weather glyph.
//Reused by the chip and by the mode-bar button so the live cover
//is readable from either surface without opening the dome.
export function cloudCoverIcon(coverPct: number): string
{
    if (coverPct < 0)   return 'mdi:weather-cloudy';
    if (coverPct < 15)  return 'mdi:weather-sunny';
    if (coverPct < 40)  return 'mdi:weather-partly-cloudy';
    if (coverPct < 75)  return 'mdi:weather-cloudy';
    return 'mdi:weather-pouring';
}


//Per-altitude cloud layer icon. Picking weather glyphs proved to be
//too subtle to read, so we use vertical-align glyphs which literally
//show "thing at the bottom / centre / top of a frame": instantly
//maps to "low cloud at the bottom of the atmosphere", etc.
//  - low  : format-vertical-align-bottom (arrow pointing to bottom)
//  - mid  : format-vertical-align-center (bar centred mid-frame)
//  - high : format-vertical-align-top    (arrow pointing to top)
export function cloudLayerIcon(layer: 'low' | 'mid' | 'high'): string
{
    if (layer === 'low')  return 'mdi:format-vertical-align-bottom';
    if (layer === 'mid')  return 'mdi:format-vertical-align-center';
    return 'mdi:format-vertical-align-top';
}


//Sequential layer animation timings (in ms, measured from the
//fade-in start). low appears first, mid 350 ms later, high 350 ms
//after mid. Each layer takes 600 ms to fade itself in. So the
//full reveal completes at low_in_start + 700 + 600 = 1300 ms,
//comfortably inside the global CLOUD_DOME_FADE_IN_MS budget.
const LAYER_DELAY_MS    = [   0, 350, 700];
const LAYER_FADE_DUR_MS =     600;


export function renderCloudDomeOverlay(host: CloudDomeHost): TemplateResult | typeof nothing
{
    if (!shouldRenderCloudDome(host)) return nothing;
    const scene = host._cloudDomeScene;
    if (!scene) return nothing;
    const globalAlpha = cloudDomeFadeAlpha(host);
    if (globalAlpha <= 0) return nothing;

    const now = performance.now();
    //Per-layer opacity: on fade-IN, each layer comes up at its own
    //LAYER_DELAY_MS after the global start, ramping to 1 over
    //LAYER_FADE_DUR_MS. On fade-OUT, every layer drops together with
    //the global alpha (no staggered exit, the user just sees a
    //collective fade-out).
    const inStart  = host._cloudDomeFadeInStartMs;
    const outStart = host._cloudDomeFadeOutStartMs;
    const perLayerAlpha = (index: number): number =>
    {
        if (outStart !== null) return globalAlpha;
        if (inStart === null) return host._cloudDomeMode ? 1 : 0;
        const elapsed = now - inStart - LAYER_DELAY_MS[index];
        if (elapsed <= 0) return 0;
        const t = Math.min(1, elapsed / LAYER_FADE_DUR_MS);
        return t;
    };

    const layerNodes: TemplateResult[] = [];
    scene.layers.forEach((layer, i) =>
    {
        const layerAlpha = perLayerAlpha(i);
        if (layerAlpha <= 0) return;
        const fillOp   = coverToOpacity(layer.cover);
        const strokeOp = 0.6;
        layerNodes.push(svg`
            <g class="cloud-dome-disc cloud-dome-disc--${layer.kind}"
               style="opacity:${layerAlpha.toFixed(3)}">
                ${layer.ringPath ? svg`
                    <path d="${layer.ringPath}"
                          class="cloud-dome-disc-ring"
                          fill="none"
                          stroke="currentColor"
                          stroke-opacity="${strokeOp.toFixed(3)}"
                          stroke-width="1.2" />
                ` : nothing}
                ${layer.fillPath ? svg`
                    <path d="${layer.fillPath}"
                          class="cloud-dome-disc-fill"
                          fill="currentColor"
                          fill-opacity="${fillOp.toFixed(3)}"
                          stroke="none" />
                ` : nothing}
            </g>
        `);
    });

    return html`
        <svg class="cloud-dome-svg" style="opacity:${globalAlpha.toFixed(3)}">
            ${layerNodes}
        </svg>
    `;
}
