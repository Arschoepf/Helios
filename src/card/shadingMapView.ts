//Editor-side debug view for the shading map. Renders a polar
//heatmap of the learned (azimuth x altitude x cloud) residual
//grid plus the export / import / reset buttons. Pure-template
//module: the editor imports `renderShadingMapSection()` and
//drops it into its render output; nothing here mutates the host
//config, so toggles between sections don't dirty the editor's
//config-changed event stream.
//
//The polar layout:
//   - North is at the top of the disc (azimuth 0).
//   - East is on the right (azimuth 90).
//   - Radius encodes altitude, with the horizon at the edge and
//     zenith at the centre. That puts the sun's longest, most
//     informative arcs (mid-altitude, low-altitude) where the
//     human eye looks naturally; the zenith cells are short
//     anyway and crowd less at the centre.
//   - Color encodes the cell's residual ratio: red = under-
//     production vs the model (a tree, soiling, panel shading),
//     green = over-production, white = model matches reality.
//   - Cell opacity encodes the effective sample count so cells
//     with little data fade out instead of pretending to be
//     authoritative.

import { html, svg, nothing, type TemplateResult } from 'lit';
import {
    CLOUD_BIN_LABELS,
    CLOUD_BIN_COUNT_EXPORT,
    decodeCellKey,
    describeMap,
    loadMap,
} from '../engine/shadingMap';
import {
    exportCurrentShadingMap,
    importShadingMapJson,
    resetShadingMap,
} from './shadingTrainer';
import { pickTranslations } from '../i18n';


//Outer disc radius in user units. Picked to match the visual density of the other editor cards: small enough to fit a 4-up grid on a desktop without
//horizontal scroll, large enough that a single 10°-wide azimuth wedge isn't a hairline.
const DISC_R         = 110;
const DISC_CENTRE    = 120;
const DISC_VIEWBOX   = 240;
const AZIMUTH_STEP   = 10;     //must match the engine bin width
const ALTITUDE_STEP  = 5;      //ditto


//Map a ratio in [RATIO_MIN, RATIO_MAX] to a colour. 1.0 = white,
//< 1 = warm red, > 1 = cool green. The clamp matches the engine's
//[0.3, 1.7] cell hard-cap so the colour scale never blows out.
function ratioToFill(ratio: number): string
{
    const r = Math.max(0.3, Math.min(1.7, ratio));
    if (r < 1)
    {
        //Under-prediction: model says more than reality. The further from 1, the deeper red.
        const t = (1 - r) / 0.7;    //[0, 1]
        const red   = 220;
        const green = Math.round(220 * (1 - t));
        const blue  = Math.round(220 * (1 - t));
        return `rgb(${red}, ${green}, ${blue})`;
    }
    const t = (r - 1) / 0.7;
    const red   = Math.round(220 * (1 - t));
    const green = 220;
    const blue  = Math.round(220 * (1 - t));
    return `rgb(${red}, ${green}, ${blue})`;
}


//Single polar disc for one cloud bin. Renders all populated cells
//of that bin as annular sectors centered on (DISC_CENTRE, DISC_CENTRE).
function renderCloudDisc(cloudBin: number, cells: ReturnType<typeof decodeCellKey>[], nowMs: number): TemplateResult
{
    const sectors: TemplateResult[] = [];
    for (const decoded of cells)
    {
        if (!decoded) continue;
        if (decoded.cloudBin !== cloudBin) continue;
        const azCentre   = decoded.azimuthDeg;
        const altCentre  = decoded.altitudeDeg;
        //Annular sector spans [az - 5, az + 5] x [alt - 2.5, alt + 2.5].
        const azStart    = azCentre - AZIMUTH_STEP / 2;
        const azEnd      = azCentre + AZIMUTH_STEP / 2;
        const altLow     = altCentre - ALTITUDE_STEP / 2;
        const altHigh    = altCentre + ALTITUDE_STEP / 2;
        //Radius: horizon at DISC_R, zenith at 0. Inverting altitude so the sun-path's longer low-altitude arcs are at the outside of the disc.
        const rOuter = DISC_R * (1 - altLow  / 90);
        const rInner = DISC_R * (1 - altHigh / 90);
        if (rOuter <= 0 || rInner < 0 || rOuter <= rInner) continue;
        const path = annularSectorPath(azStart, azEnd, rInner, rOuter);
        //Decay-adjusted weight drives opacity so a stale cell
        //fades. Same half-life formula as the engine lookup; we
        //don't import HALFLIFE_DAYS_EXPORT directly here to keep
        //the dependency-graph tight on the view layer.
        const dDays = Math.max(0, (nowMs - decoded.cell.t) / 86_400_000);
        const aged  = decoded.cell.w * Math.pow(0.5, dDays / 60);
        const opacity = Math.max(0.15, Math.min(1, aged / 5));
        const fill = ratioToFill(decoded.cell.ema);
        sectors.push(svg`
            <path d="${path}"
                  fill="${fill}"
                  fill-opacity="${opacity}"
                  stroke="rgba(0,0,0,0.12)"
                  stroke-width="0.4">
                <title>az ${Math.round(azCentre)}° / alt ${Math.round(altCentre)}° / cloud ${CLOUD_BIN_LABELS[cloudBin]}, ratio ${decoded.cell.ema.toFixed(2)}, w ${aged.toFixed(1)}</title>
            </path>
        `);
    }

    return html`
        <div class="shading-disc">
            <div class="shading-disc-title">${CLOUD_BIN_LABELS[cloudBin]}</div>
            <svg viewBox="0 0 ${DISC_VIEWBOX} ${DISC_VIEWBOX}" class="shading-disc-svg">
                <circle cx="${DISC_CENTRE}" cy="${DISC_CENTRE}" r="${DISC_R}" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.15)" stroke-width="0.7" />
                ${[15, 30, 45, 60, 75].map(alt => svg`
                    <circle cx="${DISC_CENTRE}" cy="${DISC_CENTRE}" r="${DISC_R * (1 - alt / 90)}"
                            fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="0.4" />
                `)}
                ${sectors.length ? sectors : svg`
                    <text x="${DISC_CENTRE}" y="${DISC_CENTRE + 4}" text-anchor="middle"
                          fill="rgba(255,255,255,0.4)" font-size="10">no data yet</text>
                `}
                <text x="${DISC_CENTRE}" y="10"  text-anchor="middle" fill="rgba(255,255,255,0.55)" font-size="9">N</text>
                <text x="${DISC_CENTRE}" y="${DISC_VIEWBOX - 2}" text-anchor="middle" fill="rgba(255,255,255,0.55)" font-size="9">S</text>
                <text x="6" y="${DISC_CENTRE + 3}" text-anchor="start" fill="rgba(255,255,255,0.55)" font-size="9">W</text>
                <text x="${DISC_VIEWBOX - 6}" y="${DISC_CENTRE + 3}" text-anchor="end" fill="rgba(255,255,255,0.55)" font-size="9">E</text>
            </svg>
        </div>
    `;
}


//Build the SVG path for one annular sector. (azStart, azEnd) are
//in degrees with 0 = north, clockwise; (rInner, rOuter) are
//pixel radii. The arc flags follow SVG's large-arc / sweep
//convention so a wedge wider than 180° still renders correctly
//(we never exceed 10° per cell, but using the general path keeps
//the function self-contained).
function annularSectorPath(azStart: number, azEnd: number, rInner: number, rOuter: number): string
{
    const sweep = (azEnd - azStart + 360) % 360;
    const largeArc = sweep > 180 ? 1 : 0;
    const p1 = polarToCart(azStart, rOuter);
    const p2 = polarToCart(azEnd,   rOuter);
    const p3 = polarToCart(azEnd,   rInner);
    const p4 = polarToCart(azStart, rInner);
    if (rInner <= 0)
    {
        return [
            `M ${DISC_CENTRE} ${DISC_CENTRE}`,
            `L ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
            `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
            `Z`,
        ].join(' ');
    }
    return [
        `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
        `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
        `L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)}`,
        `A ${rInner} ${rInner} 0 ${largeArc} 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)}`,
        `Z`,
    ].join(' ');
}

function polarToCart(azimuthDeg: number, radius: number): { x: number; y: number }
{
    //Azimuth: 0 = N (up), 90 = E (right), 180 = S (down), 270 = W (left).
    //SVG y grows down so the rotation is angle - 90 from the x-axis.
    const rad = (azimuthDeg - 90) * Math.PI / 180;
    return {
        x: DISC_CENTRE + radius * Math.cos(rad),
        y: DISC_CENTRE + radius * Math.sin(rad),
    };
}


//Public entry: drop this inside the editor's render() to get the
//whole section content. `hass` is passed so the import button
//can trigger a card re-render afterwards (Lit doesn't re-run the
//editor render unless config changes, so we surface a manual
//"refresh" callback to the editor too).
export function renderShadingMapSection(opts: {
    hass:          any;
    onAfterChange: () => void;
}): TemplateResult
{
    const t = pickTranslations(opts.hass?.language);
    const map   = loadMap();
    const nowMs = Date.now();
    const stats = describeMap(map, nowMs);
    //Decode every populated cell once; the four discs filter on
    //cloudBin so the work is shared.
    const decoded = Object.keys(map.cells)
        .map(k => decodeCellKey(k, map.cells[k]))
        .filter((d): d is NonNullable<typeof d> => d !== null);

    const handleExport = () =>
    {
        const json = exportCurrentShadingMap();
        const blob = new Blob([json], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `helios-shading-map-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleImport = () =>
    {
        const input = document.createElement('input');
        input.type   = 'file';
        input.accept = 'application/json,.json';
        input.addEventListener('change', () =>
        {
            const file = input.files && input.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () =>
            {
                const text = String(reader.result || '');
                const ok = importShadingMapJson(text);
                if (!ok)
                {
                    //eslint-disable-next-line no-alert
                    window.alert(t.editor.shadingImportError);
                    return;
                }
                opts.onAfterChange();
            };
            reader.readAsText(file);
        });
        input.click();
    };

    const handleReset = () =>
    {
        //eslint-disable-next-line no-alert
        if (!window.confirm(t.editor.shadingResetConfirm)) return;
        resetShadingMap();
        opts.onAfterChange();
    };

    return html`
        <div class="hint">${t.editor.shadingHint}</div>
        <div class="shading-stats">
            <div><strong>${stats.cells}</strong> ${t.editor.shadingStatsCells}</div>
            <div><strong>${stats.confidentCells}</strong> ${t.editor.shadingStatsConfident}</div>
            ${stats.strongestUnder ? html`
                <div>${t.editor.shadingStatsUnder} <strong>${(stats.strongestUnder.ratio * 100).toFixed(0)}%</strong></div>
            ` : nothing}
            ${stats.strongestOver ? html`
                <div>${t.editor.shadingStatsOver} <strong>${(stats.strongestOver.ratio * 100).toFixed(0)}%</strong></div>
            ` : nothing}
        </div>
        <div class="shading-grid">
            ${Array.from({ length: CLOUD_BIN_COUNT_EXPORT }, (_, b) => renderCloudDisc(b, decoded, nowMs))}
        </div>
        <div class="shading-actions">
            <button type="button" @click="${handleExport}">${t.editor.shadingExport}</button>
            <button type="button" @click="${handleImport}">${t.editor.shadingImport}</button>
            <button type="button" class="shading-reset" @click="${handleReset}">${t.editor.shadingReset}</button>
        </div>
    `;
}
