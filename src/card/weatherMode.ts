//Weather overlay mode. When the user toggles the weather chip in the mode bar, the rest of the
//HUD fades out (same vocabulary as the LiDAR view), the camera tilts to top-down + zooms out so
//the user sees the area around the home from above, and a per-altitude cloud-cover SVG overlay
//paints the modelled coverage as one polygon per connected blob, one band per altitude. The
//5-day timeline stays visible and scrubbable: each scrub move just picks a different time slice
//out of the same cached grid, no fresh HTTP round-trip.
//
//Cloud-cover percentages displayed in the per-altitude buttons (top-left rail in weather mode)
//keep coming from the existing Open-Meteo home-point feed (engine.projectCloudScene), exact-at-
//the-home numbers. The SVG overlay is the spatial context around the home; the buttons double
//as toggles that hide individual bands so the user can isolate a single layer.

import { html, nothing, svg, type TemplateResult } from 'lit';
import { refreshOverlays, type OverlaysHost } from './overlays';
import type { HeliosEngine } from '../helios-engine';
import type { CardMode } from './card-mode';


//Shared time base with the LiDAR fade so the chip / leader / arc fade cadence reads as one
//consistent vocabulary across modes. Enter ramps the overlay in over 600 ms while the HUD fades
//out; exit ramps back to invisible in 280 ms while the HUD fades back in.
const WEATHER_FADE_IN_MS  = 600;
const WEATHER_FADE_OUT_MS = 280;

//Per-cell threshold below which the band paints nothing. Cells whose mean coverage on a band
//falls under this percentage are dropped from the blob mask so the basemap stays visible in
//clear areas. The threshold doubles as the bucket boundary for connected-component grouping:
//two adjacent cells both above the threshold end up in the same blob regardless of their exact
//percentages, two adjacent cells one above one below stay in separate blobs.
const CLOUD_LAYER_THRESHOLD_PCT = 15;


export interface WeatherModeHost extends OverlaysHost
{
    readonly _engine?: HeliosEngine;
    _cardMode:                  CardMode;
    _overlayMaskActive:         boolean;
    _weatherOverlayVisible:     boolean;
    _weatherFadeInStartMs:      number | null;
    _weatherFadeOutStartMs:     number | null;
    _weatherFadeRaf?:           number;
    _selectedTime:              Date | null;
    _isLiveMode:                boolean;
    //Per-band visibility flags driven by the three buttons in the top-left weather rail. Each
    //flag gates its band's polygon set out of the SVG when false; reset to all true on every
    //weather-mode entry.
    _weatherShowHigh:           boolean;
    _weatherShowMid:            boolean;
    _weatherShowLow:            boolean;
    //LitElement.requestUpdate(), invoked each frame during the fade so the inline opacity steps
    //smoothly. Duck-typed so importing LitElement here doesn't drag Lit into the engine surface.
    requestUpdate(): void;
}


//Tilt the camera to top-down + zoom out, kick the overlay fade-in, fetch the cloud-cover grid
//in the background. The SVG polygons paint as soon as the grid lands; subsequent refreshes
//are driven by the engine's internal 5 min timer. Toggle flags reset to all true so the user
//always lands on a complete view of every band the first time they re-enter the mode.
export function enterWeatherMode(host: WeatherModeHost): boolean
{
    if (!host._engine) { return false; }
    host._weatherFadeOutStartMs = null;
    host._weatherFadeInStartMs  = performance.now();
    host._weatherOverlayVisible = true;
    host._weatherShowHigh       = true;
    host._weatherShowMid        = true;
    host._weatherShowLow        = true;
    host._engine.enterWeatherCamera();
    void host._engine.ensureWeatherCloudGrid().then(() =>
    {
        if (host._weatherFadeOutStartMs !== null) { return; }
        if (!host._weatherOverlayVisible)         { return; }
        host._engine?.startWeatherCloudRefresh();
        host.requestUpdate();
    });
    refreshOverlays(host);
    startWeatherFadeLoop(host);
    return true;
}


//Start the overlay fade-out, hand the camera back, stop the cloud refresh timer.
export function exitWeatherMode(host: WeatherModeHost): void
{
    host._weatherFadeInStartMs  = null;
    host._weatherFadeOutStartMs = performance.now();
    host._engine?.exitWeatherCamera();
    host._engine?.stopWeatherCloudRefresh();
    startWeatherFadeLoop(host);
}


export function startWeatherFadeLoop(host: WeatherModeHost): void
{
    if (host._weatherFadeRaf !== undefined) { return; }
    const tick = (): void =>
    {
        const now      = performance.now();
        const inStart  = host._weatherFadeInStartMs;
        const outStart = host._weatherFadeOutStartMs;

        if (outStart !== null && now - outStart >= WEATHER_FADE_OUT_MS)
        {
            host._weatherFadeOutStartMs = null;
            host._weatherOverlayVisible = false;
            refreshOverlays(host);
        }
        if (inStart !== null && now - inStart >= WEATHER_FADE_IN_MS)
        {
            host._weatherFadeInStartMs = null;
        }
        host.requestUpdate();
        if (host._weatherFadeInStartMs !== null || host._weatherFadeOutStartMs !== null)
        {
            host._weatherFadeRaf = requestAnimationFrame(tick);
        }
        else
        {
            host._weatherFadeRaf = undefined;
        }
    };
    host._weatherFadeRaf = requestAnimationFrame(tick);
}


export function weatherFadeAlpha(host: WeatherModeHost): number
{
    const now = performance.now();
    if (host._weatherFadeInStartMs !== null)
    {
        return Math.max(0, Math.min(1, (now - host._weatherFadeInStartMs) / WEATHER_FADE_IN_MS));
    }
    if (host._weatherFadeOutStartMs !== null)
    {
        return 1 - Math.max(0, Math.min(1, (now - host._weatherFadeOutStartMs) / WEATHER_FADE_OUT_MS));
    }
    return host._weatherOverlayVisible ? 1 : 0;
}


//Connected-component finder + boundary walker. Reads the cloud cover series for one band at
//one time slice, builds a binary "covered" mask of cells whose mean exceeds the threshold,
//flood-fills connected components, then walks each component's outline by collecting the cell-
//side line segments that face an out-of-component neighbour. The output is one SVG polygon per
//component, projected to screen space. Two cells in the same component merge into one shape;
//touching cells across band boundaries stay in separate components.
function renderCloudBand(
    engine:    HeliosEngine,
    grid:      NonNullable<ReturnType<HeliosEngine['getWeatherCloudGrid']>>,
    values:    Float32Array,
    nTimes:    number,
    timeIdx:   number,
    cssClass:  string,
): TemplateResult[]
{
    const nLat       = grid.nLat;
    const nLon       = grid.nLon;
    const nCellsLat  = nLat - 1;
    const nCellsLon  = nLon - 1;
    const totalCells = nCellsLat * nCellsLon;
    if (totalCells === 0) { return []; }

    //Build the binary "covered" mask. Mean of the four corner samples per cell, gated on the
    //threshold so a cell whose corners are all sub-threshold drops out of the polygon set.
    const covered = new Uint8Array(totalCells);
    for (let iLat = 0; iLat < nCellsLat; iLat++)
    {
        for (let iLon = 0; iLon < nCellsLon; iLon++)
        {
            const i00 = ( iLat      * nLon + iLon)      * nTimes + timeIdx;
            const i10 = ( iLat      * nLon + iLon + 1)  * nTimes + timeIdx;
            const i01 = ((iLat + 1) * nLon + iLon)      * nTimes + timeIdx;
            const i11 = ((iLat + 1) * nLon + iLon + 1)  * nTimes + timeIdx;
            const mean = (values[i00] + values[i10] + values[i01] + values[i11]) / 4;
            covered[iLat * nCellsLon + iLon] = mean >= CLOUD_LAYER_THRESHOLD_PCT ? 1 : 0;
        }
    }

    //Flood-fill connected components. Components are 4-connected (up/down/left/right neighbours
    //only); diagonal-only contact is read as separate components, which keeps the visual closer
    //to the underlying model's coverage map at no extra rendering cost.
    const compId   = new Int32Array(totalCells).fill(-1);
    const queue    = new Int32Array(totalCells);
    let   nextId   = 0;
    for (let startCell = 0; startCell < totalCells; startCell++)
    {
        if (!covered[startCell] || compId[startCell] !== -1) { continue; }
        compId[startCell] = nextId;
        queue[0] = startCell;
        let qHead = 0;
        let qTail = 1;
        while (qHead < qTail)
        {
            const cell = queue[qHead++];
            const cI = (cell / nCellsLon) | 0;
            const cJ = cell - cI * nCellsLon;
            //Four orthogonal neighbours. Each guard pair prevents reading a cell outside the
            //mask without an explicit branch for every direction.
            if (cI > 0)
            {
                const n = cell - nCellsLon;
                if (covered[n] && compId[n] === -1) { compId[n] = nextId; queue[qTail++] = n; }
            }
            if (cI < nCellsLat - 1)
            {
                const n = cell + nCellsLon;
                if (covered[n] && compId[n] === -1) { compId[n] = nextId; queue[qTail++] = n; }
            }
            if (cJ > 0)
            {
                const n = cell - 1;
                if (covered[n] && compId[n] === -1) { compId[n] = nextId; queue[qTail++] = n; }
            }
            if (cJ < nCellsLon - 1)
            {
                const n = cell + 1;
                if (covered[n] && compId[n] === -1) { compId[n] = nextId; queue[qTail++] = n; }
            }
        }
        nextId++;
    }
    if (nextId === 0) { return []; }

    //Per component: collect boundary edges, chain into a closed loop, project + emit as one
    //SVG polygon. Edges are addressed by their (a, b) grid-point endpoints; each interior cell
    //side gets a single edge, each cell-face touching a non-component cell becomes a boundary
    //edge. Chaining walks the edge graph starting at any vertex and following the outgoing
    //edge at each step (the boundary is one closed loop per simply-connected component, no
    //holes expected from cloud-cover data so the chain closes back on itself).
    const polys: TemplateResult[] = [];
    //Per-component edge accumulator: from vertex (gI * nLon + gJ) -> destination vertex. One
    //outgoing edge per source vertex on a simple polygonal boundary, which is the topology a
    //grid-cell union produces. CCW outgoing direction so the chain wraps the outside of the
    //component.
    const adj = new Map<number, number>();

    const vIdx = (gI: number, gJ: number): number => gI * nLon + gJ;

    for (let target = 0; target < nextId; target++)
    {
        adj.clear();

        const matches = (i: number, j: number): boolean =>
        {
            if (i < 0 || j < 0 || i >= nCellsLat || j >= nCellsLon) { return false; }
            return compId[i * nCellsLon + j] === target;
        };

        for (let iLat = 0; iLat < nCellsLat; iLat++)
        {
            for (let iLon = 0; iLon < nCellsLon; iLon++)
            {
                if (compId[iLat * nCellsLon + iLon] !== target) { continue; }
                //Cell corners in (gI, gJ) grid-point indices, ordered so the boundary walk
                //runs counter-clockwise around the cell when viewed from above. North side
                //is paint-order top of screen, so the cell corners go:
                //  sw (iLat,     iLon)    -> se (iLat,     iLon + 1)
                //  se                     -> ne (iLat + 1, iLon + 1)
                //  ne                     -> nw (iLat + 1, iLon)
                //  nw                     -> sw (close the cell)
                //The boundary edge is added when the neighbour on that side is NOT in the
                //component. Direction is preserved so adjacent boundary edges chain head-to-tail
                //around the outline.
                if (!matches(iLat - 1, iLon))     { adj.set(vIdx(iLat,     iLon),     vIdx(iLat,     iLon + 1)); }
                if (!matches(iLat,     iLon + 1)) { adj.set(vIdx(iLat,     iLon + 1), vIdx(iLat + 1, iLon + 1)); }
                if (!matches(iLat + 1, iLon))     { adj.set(vIdx(iLat + 1, iLon + 1), vIdx(iLat + 1, iLon)); }
                if (!matches(iLat,     iLon - 1)) { adj.set(vIdx(iLat + 1, iLon),     vIdx(iLat,     iLon)); }
            }
        }
        if (adj.size === 0) { continue; }

        //Walk the chain. Start at any vertex with an outgoing edge, follow `adj` until we land
        //back at the start vertex. The chain has the boundary as one closed loop for a simply
        //connected blob; concave blobs still produce a single chain because every grid corner
        //has at most one boundary outgoing edge in CCW order.
        const firstVertex = adj.keys().next().value as number;
        const points: string[] = [];
        let v = firstVertex;
        let safety = adj.size + 4; //defensive cap, the loop terminates on its own
        while (safety-- > 0)
        {
            const gI = (v / nLon) | 0;
            const gJ = v - gI * nLon;
            const screen = engine.projectLonLat(grid.lons[gJ], grid.lats[gI]);
            if (!screen) { break; }
            points.push(`${screen.x.toFixed(1)},${screen.y.toFixed(1)}`);
            const next = adj.get(v);
            if (next === undefined || next === firstVertex) { break; }
            v = next;
        }
        if (points.length >= 3)
        {
            polys.push(svg`<polygon class="${cssClass}" points="${points.join(' ')}" />`);
        }
    }

    return polys;
}


export function renderWeatherOverlay(host: WeatherModeHost): TemplateResult | typeof nothing
{
    if (!host._weatherOverlayVisible && host._weatherFadeOutStartMs === null) { return nothing; }
    const fade   = weatherFadeAlpha(host);
    const engine = host._engine ?? null;
    const grid   = engine?.getWeatherCloudGrid() ?? null;
    const ready  = !!grid && !!engine;

    //Time slice resolved from the timeline scrub state. Live = "now"; scrubbing into the past
    //or the forecast horizon picks the corresponding hour out of the cached 5-day grid without
    //firing another fetch.
    let bandHigh: TemplateResult[] = [];
    let bandMid:  TemplateResult[] = [];
    let bandLow:  TemplateResult[] = [];
    if (ready)
    {
        const activeTime = (host._isLiveMode || !host._selectedTime)
            ? new Date()
            : host._selectedTime;
        const timeIdx = engine!.getWeatherCloudGridTimeIndex(activeTime);
        if (timeIdx >= 0)
        {
            const nTimes = grid!.times.length;
            if (host._weatherShowHigh)
            {
                bandHigh = renderCloudBand(engine!, grid!, grid!.cloudHigh, nTimes, timeIdx, 'weather-cloud-poly-high');
            }
            if (host._weatherShowMid)
            {
                bandMid  = renderCloudBand(engine!, grid!, grid!.cloudMid,  nTimes, timeIdx, 'weather-cloud-poly-mid');
            }
            if (host._weatherShowLow)
            {
                bandLow  = renderCloudBand(engine!, grid!, grid!.cloudLow,  nTimes, timeIdx, 'weather-cloud-poly-low');
            }
        }
    }

    return html`
        <div class="weather-mode-overlay" aria-hidden="true" style="opacity:${fade.toFixed(3)}">
            ${ready ? html`
                <svg class="weather-cloud-svg" xmlns="http://www.w3.org/2000/svg">
                    <g class="weather-cloud-band weather-cloud-band--high">${bandHigh}</g>
                    <g class="weather-cloud-band weather-cloud-band--mid">${bandMid}</g>
                    <g class="weather-cloud-band weather-cloud-band--low">${bandLow}</g>
                </svg>
            ` : nothing}
        </div>
    `;
}
