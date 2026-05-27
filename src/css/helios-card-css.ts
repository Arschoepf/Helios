import { css, unsafeCSS } from 'lit';
//MapLibre's stylesheet ships under dist/maplibre-gl.css. Vite's
//`?inline` query suffix returns the file content as a raw string
//instead of injecting a global <style> tag, we need the rules
//*inside* our shadow root, not in document <head>. Without these
//rules .maplibregl-canvas falls back to the default `position:
//static`, which makes the canvas participate in the layout flow:
//in HA panel-mode (where the parent container has no fixed
//height), the explicit pixel size MapLibre writes onto the canvas
//pushes the container, our ResizeObserver fires, MapLibre re-reads
//a bigger container, and we're in an unbounded growth loop. With
//the rule applied the canvas is taken out of flow and the loop
//breaks.
import maplibreCss from 'maplibre-gl/dist/maplibre-gl.css?inline';

//Visual styles for the main HeliosCard. Kept in a dedicated file so
//the card module reads as logic only; rules are grouped by feature
//(layout, timeline, overlays, solar arc, tooltips).
export const heliosCardStyles = css`
    ${unsafeCSS(maplibreCss)}

    :host
    {
        display: block;
        height:  100%;
    }

    ha-card
    {
        position: relative;
        overflow: hidden;
        background: #000;
        border-radius: var(--ha-card-border-radius, 12px);
        font-family: var(--primary-font-family, 'Roboto', sans-serif);
        height:     100%;
        width:      100%;
        /*  Floor that survives dashboard layouts where the parent
            doesn't apply an explicit height (vertical-stack, panel
            view, some custom dashboards like Mushroom-based grids).
            Without this floor, height:100% resolves to the children's
            intrinsic height, which means only the timeline chart's
            ~150 px contributes and the 3D map area collapses out of
            view. 480 px leaves the chart its natural height and gives
            the map area ~330 px which is enough to read the home and
            its surroundings. Layouts that DO pass an explicit height
            (masonry via getCardSize, sections view via getGridOptions)
            override this freely.                                       */
        min-height: 480px;
        /*  New stacking context so absolute children with z-index
            stay scoped to the card instead of escaping above HA's
            dashboard chrome on scroll. */
        isolation: isolate;
    }

    #map-container
    {
        /*  Absolute + inset:0 so the container fills its ha-card
            parent via the containing-block dimensions (which respect
            min-height) rather than via percentage height resolution.
            Percentage heights only cascade when the parent has a
            concrete pixel height, the Masonry dashboard layout sets
            only a min-height floor on the card, so a height:100% here
            would collapse to 0 and the MapLibre canvas would never
            render. Sections and panel views pass a pixel height down,
            so the old percentage path worked there, the absolute path
            works under both.                                          */
        position: absolute;
        inset: 0;
    }

    /*  Force-hide the MapLibre attribution rail. attributionControl
        compact: true is meant to collapse it to an icon, but MapLibre
        auto-expands the full bar above 640 px viewport width which
        most dashboard cards exceed. We hide it outright via CSS, the
        attribution credit (MapLibre + OpenFreeMap + OpenMapTiles +
        OpenStreetMap data) lives in the README and the HACS info pane
        so the license obligation stays satisfied through documentation
        rather than chrome real estate. */
    .maplibregl-ctrl-attrib,
    .maplibregl-ctrl-bottom-right,
    .maplibregl-ctrl-bottom-left
    {
        display: none !important;
    }


    /*  Home hitbox, invisible circular click target centred on the
        home's projected screen position. Sits above every overlay
        SVG (z 12) but below the detail panel (z 60) so a click
        always reaches it, regardless of which chip / leader happens
        to sit underneath at that moment. */
    .home-hitbox
    {
        position: absolute;
        transform: translate(-50%, -50%);
        width:  72px;
        height: 72px;
        border-radius: 50%;
        background: transparent;
        cursor: pointer;
        pointer-events: auto;
        z-index: 12;
    }

    /*  Home hover glow. Same base + top + side-quad polygons as the
        cloud-disc mask (so it tracks rotation pixel-for-pixel with
        the building extrusion), painted in the configured sun colour
        with a CSS drop-shadow bloom. Opacity is the only thing that
        animates so the fade is GPU-cheap, the geometry comes back
        every frame from the engine without re-rendering this SVG. */
    .home-glow-svg
    {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 11;
        opacity: 0;
        transition: opacity 0.18s ease;
        /* Single soft drop-shadow, the bloom hints "interactive"
           without overpowering the building underneath. */
        filter: drop-shadow(0 0 6px var(--helios-sun-color, #f59e0b));
    }
    .home-glow-svg.is-hovered { opacity: 0.7; }

    /*  Touch devices have no hover state, mouseenter / mouseleave
        never fire, so the .is-hovered class is never applied. Show
        the glow permanently at a softer opacity so the user still
        gets a visual hint that the home is tappable. The detail-
        mode fade rule (specificity 0,2,0) wins over this (0,1,0)
        so the glow still fades out when the dashboard opens. */
    @media (hover: none)
    {
        .home-glow-svg { opacity: 0.45; }
    }
    .home-glow-svg .home-glow-shape
    {
        fill: var(--helios-sun-color, #f59e0b);
        fill-opacity: 0.08;
        stroke: var(--helios-sun-color, #f59e0b);
        stroke-width: 1;
        stroke-linejoin: round;
        pointer-events: none;
    }


    /*  Detail mode, while ha-card carries .detail-active every
        pre-existing overlay fades out and stops intercepting
        pointer events. The transition rides at 0.35 s ease so the
        fade matches the eye-pleasing pacing of the camera ease in
        the engine (0.8 s total, but the fade should land before the
        camera settles so the panel can come in clean on top).

        IMPORTANT: the transition declaration sits on the BASE
        selector, not inside the .detail-active rule. CSS only
        animates between two states when both states share the
        transition property, declaring it inside .detail-active
        only would mean removing the class snaps opacity back to 1
        with no fade-in. */
    .cloud-svg,
    .cloud-leader-svg,
    .cloud-pct-label,
    .solar-svg,
    .solar-pct-label,
    .pv-home-anchor-svg,
    .pv-home-leader-svg,
    .pv-pct-label,
    .battery-leader-svg,
    .battery-pct-label,
    .home-hitbox,
    .home-glow-svg,
    .time-bar,
    .clock,
    .live-return-btn,
    .shadow-busy-chip
    {
        transition: opacity 0.35s ease;
    }
    ha-card.detail-active .cloud-svg,
    ha-card.detail-active .cloud-leader-svg,
    ha-card.detail-active .cloud-pct-label,
    ha-card.detail-active .solar-svg,
    ha-card.detail-active .solar-pct-label,
    ha-card.detail-active .pv-home-anchor-svg,
    ha-card.detail-active .pv-home-leader-svg,
    ha-card.detail-active .pv-pct-label,
    ha-card.detail-active .battery-leader-svg,
    ha-card.detail-active .battery-pct-label,
    ha-card.detail-active .home-hitbox,
    ha-card.detail-active .home-glow-svg,
    ha-card.detail-active .time-bar,
    ha-card.detail-active .clock,
    ha-card.detail-active .live-return-btn,
    ha-card.detail-active .shadow-busy-chip
    {
        opacity: 0;
        pointer-events: none;
    }

    /*  Detail panel, takes over the card while detail mode is on.
        Hosts the three-section dashboard (today / tomorrow /
        battery, the last two sat side by side when both render).
        The backdrop is a soft scrim + blur so the basemap behind
        stays readable (the camera is zoomed and pitched underneath)
        without competing with the panel content. Dismissal goes
        through a dedicated close button in the corner rather than
        a stray click on the panel itself, otherwise scrolling or
        tapping inside a card on a small viewport would close it. */
    .detail-panel
    {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        z-index: 60;
        opacity: 0;
        animation: detail-panel-fade-in 0.25s ease forwards;
        display: flex;
        flex-direction: column;
        font-family: var(--primary-font-family, 'Roboto', sans-serif);
    }
    @keyframes detail-panel-fade-in
    {
        from { opacity: 0; }
        to   { opacity: 1; }
    }

    .detail-close-btn
    {
        position: absolute;
        top: 10px;
        right: 10px;
        width:  28px;
        height: 28px;
        padding: 0;
        background: #ffffff;
        border: 1px solid #000000;
        border-radius: 50%;
        color: #000000;
        cursor: pointer;
        z-index: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        transition: transform 0.12s;
    }
    .detail-close-btn:hover  { transform: scale(1.05); }
    .detail-close-btn:active { transform: scale(0.95); }
    .detail-close-btn ha-icon { --mdc-icon-size: 16px; color: inherit; }
    ha-card.theme-dark .detail-close-btn
    {
        background: #191a1b;
        color:      #e6e6e6;
        border-color: rgba(255, 255, 255, 0.20);
    }

    .detail-panel-inner
    {
        flex: 1;
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow-y: auto;
        overflow-x: hidden;
    }

    /*  Each dashboard section is a chip-style card: same visual
        language as the on-map readouts (white plate, 1 px black
        border, soft shadow). Compact, dense, readable at-a-glance.
        Sections appear sequentially with a short stagger so the eye
        lands on each one in turn without dragging the reveal. */
    .dash-card
    {
        background: #ffffff;
        color:      #000000;
        border:     1px solid #000000;
        border-radius: 4px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        padding: 10px 14px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        opacity: 0;
        transform: translateY(8px);
        animation: dash-card-in 0.35s cubic-bezier(0.22, 1, 0.36, 1) forwards;
        /*  position: relative so the card can take a z-index when
            its tooltip is being hovered (see below). At rest the
            z-index stays auto so no stacking context is created.  */
        position: relative;
    }
    /*  Card lift on tooltip hover. When the user's cursor is on a
        chip with a popover tooltip (.dash-stat-delta or .dash-stat-
        refined), the whole card jumps to z-index 20 so the tooltip,
        which sits at z-index 10 INSIDE the card's stacking context,
        paints above sibling cards in the same row. Without this the
        adjacent battery card naturally paints later in DOM order and
        clips the tooltip. The :has() selector targets the actual
        hover on either tooltip trigger, so the lift only happens
        when the popover is actually visible.                       */
    .dash-card:has(.dash-stat-delta:hover),
    .dash-card:has(.dash-stat-refined:hover)
    {
        z-index: 20;
    }
    /*  Staggered reveal: today first, then the tomorrow + battery
        row appears with a single shared delay. Tomorrow + battery
        sit inside .dash-row (so nth-of-type counts wouldn't line
        up); the explicit class targets keep the cascade readable. */
    .dash-card.dash-today    { animation-delay: 0.00s; }
    .dash-card.dash-tomorrow { animation-delay: 0.18s; }
    .dash-card.dash-battery  { animation-delay: 0.18s; }
    @keyframes dash-card-in
    {
        /*  End on transform:none, not translateY(0). A non-none
            transform value creates a new stacking context, which
            would trap the calibration-hint tooltip on the tomorrow
            card inside its own card and let the battery card next
            to it paint OVER the tooltip. The none value releases
            stacking context once the entry animation finishes so
            the tooltip z-index can paint above sibling cards.     */
        to { opacity: 1; transform: none; }
    }

    ha-card.theme-dark .dash-card
    {
        background: #191a1b;
        color:      #e6e6e6;
        border-color: rgba(255, 255, 255, 0.20);
    }

    .dash-card-header
    {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .dash-card-icon
    {
        --mdc-icon-size: 16px;
        flex-shrink: 0;
    }
    .dash-card-label
    {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 1.5px;
        text-transform: uppercase;
        opacity: 0.65;
    }
    /*  Date chip rendered next to AUJOURD'HUI / DEMAIN labels so the
        user can confirm at a glance that the two sections cover
        distinct days. Smaller and dimmer than the main label so it
        reads as a sidekick, not a title.                            */
    .dash-card-date
    {
        font-size: 10px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        opacity: 0.45;
        letter-spacing: 0.5px;
        margin-left: -2px;
    }
    .dash-card-trailing
    {
        margin-left: auto;
        display: inline-flex;
        align-items: baseline;
        gap: 3px;
    }
    .dash-card-trailing-forecast
    {
        font-style: italic;
        opacity: 0.85;
    }
    .dash-stat-value
    {
        font-size: 28px;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
        line-height: 1;
        letter-spacing: -0.5px;
    }
    .dash-stat-unit
    {
        font-size: 13px;
        font-weight: 500;
        opacity: 0.65;
        margin-left: 3px;
    }
    .dash-stat-value-sm
    {
        font-size: 18px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        line-height: 1;
    }
    .dash-stat-unit-sm
    {
        font-size: 11px;
        font-weight: 500;
        opacity: 0.65;
    }

    /*  Row that holds the two half-width sections (tomorrow +
        battery) side by side. Each child grows to fill its share;
        min-width:0 lets text inside truncate cleanly when the card
        is narrow rather than stretching the row.                    */
    .dash-row
    {
        display: flex;
        gap: 10px;
        align-items: stretch;
        flex-wrap: wrap;
    }
    .dash-row > .dash-section
    {
        /*  Grow to fill the row and shrink below the basis when the
            two siblings can still sit side by side, but never narrower
            than ~190 px or the half-width contents (vessel + flows)
            start truncating; below that, flex-wrap drops to one
            column.                                                  */
        flex: 1 1 190px;
        min-width: 0;
    }

    /*  Section: today                                                  */
    /*                                                                  */
    /*  Vertical body: the two big "produit / prévu" values on top,    */
    /*  the peak line below, then the full-width chart. The chart is   */
    /*  always shown (no container query) since today owns the full    */
    /*  panel width.                                                   */
    .dash-today-body
    {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 2px 0;
    }
    .dash-today-headline
    {
        display: flex;
        /*  Align stats by the bottom of their box rather than by
            baseline, because the italic predicted value renders
            with a slightly higher baseline than the upright
            produced value, which made the two numbers feel
            misaligned at the top edge. Bottom-aligning normalises
            them: the cap heights may differ by a px or two but the
            visual line under the digits matches across stats.    */
        align-items: end;
        /*  Produced sits on the left, forecast on the right, so the
            reader's eye can scan "actual / model" as two columns
            across both the headline and the peak row below.      */
        justify-content: space-between;
        gap: 18px;
        flex-wrap: wrap;
    }
    .dash-today-stat
    {
        display: inline-flex;
        align-items: baseline;
        line-height: 1;
    }
    /*  When forecast calibration kicks in we stack the raw stat
        (value + unit) on top of a small "refined" annotation that
        shows the same forecast adjusted by the past-days actual /
        predicted ratio. Right-aligned because the predicted stat
        sits in the right column of the headline, the refined hint
        should hug the column edge rather than pulling the eye
        back left.                                                */
    .dash-today-stat-with-refined
    {
        flex-direction: column;
        align-items: flex-end;
        gap: 3px;
    }
    .dash-stat-main
    {
        display: inline-flex;
        align-items: baseline;
        line-height: 1;
    }
    .dash-stat-refined
    {
        font-size: 11px;
        font-weight: 600;
        opacity: 0.75;
        white-space: nowrap;
        position: relative;
        cursor: help;
    }
    .dash-stat-refined-pct
    {
        font-variant-numeric: tabular-nums;
        margin-left: 3px;
    }
    .dash-stat-refined-up   { color: #22c55e; }
    .dash-stat-refined-down { color: #ef4444; }
    /*  Custom-styled tooltip explaining where the refined value
        comes from. Same dark-box visual as .dash-stat-delta::after
        below so the two tooltips share a vocabulary.

        Horizontal anchor depends on which dashboard card holds
        the chip. In the AUJOURD'HUI card the headline is a two-
        column flex (produit on the left, prevu + refined on the
        right), so the chip sits in the right column and the
        tooltip extends LEFT into the card via right:0. In the
        DEMAIN card the headline has a single left-aligned column
        (only a prevu reading), so the chip sits on the LEFT and
        the tooltip extends RIGHT into the card via left:0. Using
        the same anchor in both cards bleeds the tooltip past
        whichever edge it shares with the chip and gets clipped by
        ha-card's overflow:hidden.                                 */
    .dash-stat-refined::after
    {
        content: attr(data-tooltip);
        position: absolute;
        bottom: calc(100% + 6px);
        background: rgba(0, 0, 0, 0.85);
        color: #ffffff;
        padding: 6px 10px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 500;
        letter-spacing: 0.1px;
        white-space: normal;
        max-width: 220px;
        width: max-content;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease-out 0.05s;
        z-index: 10;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.30);
    }
    .dash-card.dash-today    .dash-stat-refined::after { right: 0;  left: auto; }
    .dash-card.dash-tomorrow .dash-stat-refined::after { left:  0;  right: auto; }
    .dash-stat-refined:hover::after
    {
        opacity: 1;
    }
    /*  Signed delta % shown after the produced value: "(+15 %)" if
        we're ahead of the forecast at this moment, "(-8 %)" if
        behind. Inherits font sizing from the stat unit it sits
        next to, with a touch more weight so the sign reads cleanly
        but doesn't compete with the headline number.            */
    .dash-stat-delta
    {
        font-size: 13px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        margin-left: 6px;
        opacity: 0.85;
        position: relative;
        cursor: help;
    }
    .dash-stat-delta-up   { color: #22c55e; }
    .dash-stat-delta-down { color: #ef4444; }
    /*  Custom CSS hover hint. Native title= works but only fires
        after a ~1 s hover delay and is gated by browser quirks
        inside HA's nested Shadow DOM; a pure CSS ::after
        appears instantly on hover and looks consistent across
        every host environment. data-tooltip carries the i18n
        string; aria-label keeps screen readers informed.       */
    .dash-stat-delta::after
    {
        content: attr(data-tooltip);
        position: absolute;
        bottom: calc(100% + 6px);
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.85);
        color: #ffffff;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 500;
        letter-spacing: 0.1px;
        white-space: nowrap;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease-out 0.05s;
        z-index: 10;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.30);
    }
    .dash-stat-delta:hover::after
    {
        opacity: 1;
    }
    .dash-today-meta
    {
        display: flex;
        gap: 14px;
        flex-wrap: wrap;
        /*  Same actual-left / forecast-right alignment as the
            headline above so the eye scans the two columns
            uniformly.                                          */
        justify-content: space-between;
    }
    .dash-today-line
    {
        display: inline-flex;
        align-items: center;
        /*  Tightened from 12 px to 11 px font and 6 px to 4 px
            gap so the two peak meta lines (PIC RÉEL + PIC PRÉVU)
            still fit side by side at typical smartphone card
            widths (~330 px inner width). Below that the parent
            flex-wrap kicks in and they stack as before.        */
        gap: 4px;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        /*  Pin every child's line-box to the same vertical extent
            as the icon so iOS Safari doesn't float the smaller
            uppercase label text above the icon's centre. Without
            this, the label / value picked up the parent font's
            ~1.4 line-height and rendered ~2 px higher than the
            13 px icon glyph on small screens.                    */
        line-height: 1;
    }
    .dash-today-line ha-icon
    {
        --mdc-icon-size: 13px;
        width: 13px;
        height: 13px;
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
    }
    /*  Text spans get a 1 px downward nudge so their uppercase
        glyphs visually centre with the icon. align-items: center
        on the parent flex aligns line-boxes, not glyph
        centroids, and an uppercase block (no descenders) sits
        above its line-box centreline, so without the nudge the
        text reads as floating 1-2 px above the icon, both on
        desktop and on smartphone.                                 */
    .dash-today-line .dash-line-value
    {
        font-weight: 700;
        line-height: 1;
        transform: translateY(1px);
    }
    .dash-today-line .dash-line-label
    {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        opacity: 0.55;
        line-height: 1;
        transform: translateY(1px);
    }

    /*  Cumulative production sparkline, full panel width below the
        headline. Two curves share the same Y scale: the actual
        history (dark PV colour) and the full-day model forecast
        (lighter PV colour) so the user can read "predicted vs
        produced" at a glance. Frame style stays consistent with
        the white card surface; no overflow:hidden so the tooltip
        can extend beyond the chart edges.                            */
    .dash-today-chart
    {
        display: block;
        position: relative;
        width: 100%;
        /*  Taller chart so the dual curves + sunrise/sunset markers
            + now cursor + hover overlays all have breathing room.
            The data area sits below the icon zone (PAD_T = 12 in
            viewBox units) so sunrise/sunset icons docked at the
            top never collide with the curves' upper readings.   */
        height: 160px;
        background: rgba(0, 0, 0, 0.05);
        border: 1px solid rgba(0, 0, 0, 0.12);
        border-radius: 4px;
    }
    ha-card.theme-dark .dash-today-chart
    {
        background: rgba(255, 255, 255, 0.06);
        border-color: rgba(255, 255, 255, 0.15);
    }
    .dash-today-chart-svg
    {
        display: block;
        width: 100%;
        height: 100%;
    }
    /*  Subtle hour + kWh gridlines drawn inside the SVG behind
        the curves. Stretch with the viewBox but stroke width
        stays at 1 px via vector-effect.                          */
    .dash-today-chart-grid
    {
        stroke: rgba(0, 0, 0, 0.10);
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
    }
    ha-card.theme-dark .dash-today-chart-grid
    {
        stroke: rgba(255, 255, 255, 0.12);
    }
    /*  Both production curves are wrapped in a <g clip-path>; the
        clip rectangle scales horizontally from 0 to full width
        over 1 s on the first paint, producing a clean left → right
        reveal regardless of the underlying path shape (the prior
        stroke-dashoffset approach mis-rendered curves whose first
        segments were a flat zero plateau, because the dash pattern
        spent the early animation time on the invisible bottom
        flat).                                                     */
    .dash-today-chart-actual,
    .dash-today-chart-predicted
    {
        fill: none;
        stroke-linecap: round;
        stroke-linejoin: round;
        vector-effect: non-scaling-stroke;
    }
    .dash-today-chart-actual
    {
        stroke-width: 1.6;
        opacity: 0.95;
    }
    .dash-today-chart-predicted
    {
        stroke-width: 1.4;
        opacity: 0.95;
    }
    .dash-today-chart-reveal-rect
    {
        transform-box: fill-box;
        transform-origin: 0% 50%;
        animation: dash-chart-reveal 1s cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    @keyframes dash-chart-reveal
    {
        from { transform: scaleX(0); }
        to   { transform: scaleX(1); }
    }

    /*  "Now" cursor: vertical dashed line in the configured sun
        colour marking the current wall-clock instant on the chart.
        Refreshed via the card's 30 s clock tick (the dashboard
        re-renders on every _now change), so the line walks across
        the chart in step with real time. Stroke colour comes from
        an inline style attribute so it tracks the user's chosen
        sun colour.                                                */
    .dash-today-chart-now
    {
        stroke-width: 1;
        stroke-dasharray: 2 2;
        vector-effect: non-scaling-stroke;
        opacity: 0.75;
        pointer-events: none;
    }

    /*  Sunrise / sunset markers: very faint dotted lines in the
        configured sun colour at the morning / evening boundaries
        of daylight, with a small mdi icon docked at the bottom
        of the chart for each. The zero-length dash + round cap
        renders as discrete dots, more discreet than the now
        cursor's continuous dashes.                              */
    /*  Diagonal night-zone hatch lines, painted inside the
        SVG pattern block referenced by the pre-dawn + post-dusk
        rects. Same alpha + light-on-dark recipe the timeline's
        .hc-night-zone uses, just expressed as an SVG stroke
        because the dashboard chart lives inside an SVG. Stroke
        width is tuned for the chart's native size (~240×60 px)
        so the dots read as a soft diagonal grain.                */
    .dash-today-chart-night
    {
        stroke: rgba(0, 0, 0, 0.07);
        pointer-events: none;
    }
    ha-card.theme-dark .dash-today-chart-night
    {
        stroke: rgba(255, 255, 255, 0.10);
    }

    /*  Dotted day/night boundary lines at the sunrise and sunset
        X positions. Same recipe as the timeline's day-separator
        (.hc-day-sep) so the visual language matches: alpha 0.30,
        1.5 / 2.5 dash, non-scaling stroke. The hatch tells the
        user "this slice is night"; the dotted line marks the exact
        moment the sun crossed the horizon.                         */
    .dash-today-chart-twilight
    {
        stroke: rgba(0, 0, 0, 0.30);
        stroke-width: 1;
        stroke-dasharray: 1.5 2.5;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
    }
    ha-card.theme-dark .dash-today-chart-twilight
    {
        stroke: rgba(255, 255, 255, 0.30);
    }
    .dash-today-chart-hover-line
    {
        stroke: rgba(0, 0, 0, 0.45);
        stroke-width: 1;
        stroke-dasharray: 2 2;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
    }
    ha-card.theme-dark .dash-today-chart-hover-line
    {
        stroke: rgba(255, 255, 255, 0.45);
    }
    /*  HTML overlay (not SVG circle) so the dot stays perfectly
        round regardless of the chart's non-uniform aspect ratio.
        SVG circles inside preserveAspectRatio="none" stretch into
        ovals when the container's width:height ratio differs from
        the viewBox's; HTML border-radius is screen-pixel based and
        immune to that distortion.                                */
    .dash-today-chart-hover-dot
    {
        position: absolute;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        border: 1.5px solid #ffffff;
        box-sizing: border-box;
        transform: translate(-50%, -50%);
        pointer-events: none;
        z-index: 1;
    }
    ha-card.theme-dark .dash-today-chart-hover-dot
    {
        border-color: #191a1b;
    }

    /*  Axis label overlays. Positioned so each label hugs its
        respective gridline:
        - X-axis container starts where horizontal gridlines end
          (top: 83.33 %, matching (H - PAD_B) / H), so the hour
          labels sit ~2 px below the gridline-end of the data area.
        - Y-axis container ends where vertical gridlines start
          (width: 9.17 %, matching PAD_L / W), with labels right-
          aligned 3 px inside, so each kWh number reads as a
          caption directly to the left of its gridline.
        Both have pointer-events: none so they don't intercept
        hover on the chart.                                        */
    .dash-today-chart-axis-x
    {
        position: absolute;
        left: 0; right: 0;
        top: 83.33%;
        bottom: 0;
        pointer-events: none;
    }
    .dash-today-chart-axis-x-label
    {
        position: absolute;
        top: 2px;
        transform: translateX(-50%);
        font-size: 9px;
        font-weight: 600;
        opacity: 0.55;
        font-variant-numeric: tabular-nums;
    }
    .dash-today-chart-axis-y
    {
        position: absolute;
        top: 0; bottom: 0; left: 0;
        width: 9.17%;
        pointer-events: none;
    }
    .dash-today-chart-axis-y-label
    {
        position: absolute;
        right: 3px;
        transform: translateY(-50%);
        font-size: 9px;
        font-weight: 600;
        opacity: 0.55;
        font-variant-numeric: tabular-nums;
    }

    /*  Hover tooltip floats next to the data point: above when the
        cursor sits in the lower half of the chart (so it doesn't
        cover the curves above), below when the cursor sits in the
        upper half (so it doesn't cover the curves below). Dark
        background in BOTH themes so the lighter "predicted"
        colour stays readable.
        Positioned via inline left + top (anchored to the actual
        data point's Y); the -above / -below variant transforms
        the tooltip relative to that anchor point.               */
    .dash-today-chart-tooltip
    {
        position: absolute;
        background: rgba(0, 0, 0, 0.85);
        color: #ffffff;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.2px;
        padding: 4px 8px;
        border-radius: 4px;
        white-space: nowrap;
        pointer-events: none;
        font-variant-numeric: tabular-nums;
        display: inline-flex;
        flex-direction: column;
        gap: 2px;
        line-height: 1.2;
        z-index: 2;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.30);
    }
    .dash-today-chart-tooltip-above
    {
        /*  Anchor at data Y, then shift the whole tooltip above
            it by its own height plus a small gap.              */
        transform: translate(-50%, calc(-100% - 8px));
    }
    .dash-today-chart-tooltip-below
    {
        /*  Anchor at data Y, then drop the tooltip below with a
            small gap.                                          */
        transform: translate(-50%, 8px);
    }
    .dash-today-chart-tooltip-time
    {
        font-weight: 700;
        opacity: 0.85;
        font-size: 9px;
        letter-spacing: 0.6px;
        text-transform: uppercase;
    }
    .dash-today-chart-tooltip-row
    {
        display: inline-flex;
        align-items: baseline;
        gap: 4px;
    }
    .dash-today-chart-tooltip-key
    {
        font-weight: 700;
        font-size: 9px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
    }
    .dash-today-chart-tooltip-value
    {
        font-weight: 700;
        color: #ffffff;
    }

    /*  Skeleton placeholder shown in place of the produced value      */
    /*  while the HA history fetch is in flight. Same footprint as     */
    /*  ".dash-stat-value" so layout stays stable when the data        */
    /*  arrives. The shimmer pulse is purely cosmetic.                 */
    .dash-stat-skeleton
    {
        display: inline-block;
        width: 88px;
        height: 28px;
        border-radius: 4px;
        background: linear-gradient(
            90deg,
            rgba(0, 0, 0, 0.08) 0%,
            rgba(0, 0, 0, 0.18) 50%,
            rgba(0, 0, 0, 0.08) 100%
        );
        background-size: 200% 100%;
        animation: dash-skeleton-pulse 1.4s ease-in-out infinite;
        vertical-align: middle;
    }
    ha-card.theme-dark .dash-stat-skeleton
    {
        background: linear-gradient(
            90deg,
            rgba(255, 255, 255, 0.06) 0%,
            rgba(255, 255, 255, 0.18) 50%,
            rgba(255, 255, 255, 0.06) 100%
        );
        background-size: 200% 100%;
    }
    @keyframes dash-skeleton-pulse
    {
        0%   { background-position: 100% 0; }
        100% { background-position: -100% 0; }
    }

    /*  Section: tomorrow                                               */

    .dash-tomorrow-peak
    {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
    }
    .dash-tomorrow-peak ha-icon { --mdc-icon-size: 14px; }
    .dash-tomorrow-peak .dash-line-label
    {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 1px;
        opacity: 0.55;
    }
    .dash-tomorrow-peak .dash-line-value { font-weight: 700; }

    /*  Section: battery                                                */

    .dash-battery-body
    {
        display: flex;
        align-items: center;
        gap: 12px;
    }
    .dash-battery-vessel
    {
        width: 44px;
        height: 72px;
        flex-shrink: 0;
        display: block;
    }
    .dash-battery-vessel .dash-batt-shell,
    .dash-battery-vessel .dash-batt-cap
    {
        fill: rgba(0, 0, 0, 0.04);
        stroke: rgba(0, 0, 0, 0.30);
        stroke-width: 1;
    }
    ha-card.theme-dark .dash-battery-vessel .dash-batt-shell,
    ha-card.theme-dark .dash-battery-vessel .dash-batt-cap
    {
        fill: rgba(255, 255, 255, 0.04);
        stroke: rgba(255, 255, 255, 0.30);
    }
    .dash-battery-flows
    {
        display: flex;
        flex-direction: column;
        gap: 6px;
        flex: 1;
        min-width: 0;
    }
    .dash-battery-flow
    {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
    }
    .dash-battery-flow ha-icon { --mdc-icon-size: 14px; }
    .dash-battery-flow-charge    ha-icon { color: #22c55e; }
    .dash-battery-flow-discharge ha-icon { color: #ef4444; }
    .dash-flow-value { font-weight: 700; }
    .dash-flow-label
    {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 1px;
        opacity: 0.55;
    }


    /*  Timeline, pinned to the bottom of the card with uniform
        breathing space. The whole bar accepts pointer events for
        scrub. */

    .time-bar
    {
        position: absolute;
        /*  Bottom inset matches the time-bar's internal flex gap.
            With the day-label chip row pinned as the last flex
            child, an equal inset above (gap to the chart card) and
            below (gap to the card edge) centres the chip row in
            the band between the chart card's bottom edge and the
            card's bottom edge.                                       */
        bottom: 6px;
        /*  Width is derived from --timeline-width-frac (0.5..1, set
            inline by the renderer). At 1 the bar hugs the card edges
            with the original 8 px breathing on each side. Below 1 it
            shrinks proportionally and stays centred via the
            translateX trick. The inset hooks (left / right: 8 px)
            from the legacy layout are dropped, the new horizontal
            placement uses left: 50 % + translate. */
        left: 50%;
        transform: translateX(-50%);
        width: calc((100% - 16px) * var(--timeline-width-frac, 1));
        z-index: 10;
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
        cursor: grab;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
    }

    .time-bar:active
    {
        cursor: grabbing;
    }

    /*  Chart card, bordered white panel hosting the area chart,
        day-label chips on the midline, dotted day separators and
        the live + scrub HTML cursor overlays. */
    .tb-chart-card
    {
        position: relative;
        background: #ffffff;
        border: 1px solid #000000;
        border-radius: 3px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        height: 48px;
        overflow: hidden;
    }

    .hc-chart-svg
    {
        display: block;
        width: 100%;
        height: 100%;
    }

    /*  Stroke-only outline on top of the filled area so peaks read
        cleanly even where the gradient fades towards the midline.
        Stroke width 0.7 px so the curve reads as a hairline
        trace; a wider stroke (the earlier 1.4 px default) stacked
        over itself on every wobble on high-variation days and
        turned the dense regions into a smudged band. At 0.7 px
        the curve stays a line at any zoom.                       */
    .hc-chart-line
    {
        fill: none;
        stroke-width: 0.7;
        stroke-linejoin: round;
        stroke-linecap: round;
        vector-effect: non-scaling-stroke;
        opacity: 0.95;
        pointer-events: none;
    }

    /*  PV prediction line, overlays the observed PV chart for hours
        past "now" using the user-configured peak power (pv-peak-kwp)
        scaled by the clear-sky model. Dashed + half opacity makes it
        visually distinct from the recorded curve while staying in
        the configured PV colour so it reads as "the same quantity,
        projected". */
    .hc-chart-predicted
    {
        stroke-dasharray: 4 3;
        opacity: 0.55;
    }



    /*  Faint dotted day separators inside the chart card. */
    .hc-day-sep
    {
        stroke: rgba(0, 0, 0, 0.30);
        stroke-width: 1;
        stroke-dasharray: 1.5 2.5;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
    }

    /*  Solid black midline splitting irradiance (top) from cloud
        cover (bottom). Day-label chips overlay it. */
    .hc-chart-mid
    {
        stroke: #000000;
        stroke-width: 1.4;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
    }

    /*  Tiny hour ticks centred on the midline. Discreet enough to
        read as ambient texture rather than a primary feature. */
    .hc-hour-tick
    {
        stroke: rgba(0, 0, 0, 0.35);
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
    }

    /*  Live cursor: thin line spanning the full chart with a small
        triangle handle at the top. Slightly wider + a hair more
        opaque than earlier iterations so it stays readable through
        the future-mask wash that paints on top of half the chart.
        Still kept subtle: it's a passive "where now is" reference,
        not a focus target. */
    .tb-cursor-now
    {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        background: rgba(0, 0, 0, 0.65);
        transform: translateX(-50%);
        pointer-events: none;
        z-index: 4;
    }

    .tb-cursor-now::after
    {
        content: '';
        position: absolute;
        top: -1px;
        left: 50%;
        transform: translateX(-50%);
        width: 0;
        height: 0;
        border-left:   4px solid transparent;
        border-right:  4px solid transparent;
        border-top:    5px solid rgba(0, 0, 0, 0.75);
    }

    /*  Scrub cursor: prominent solid blue line spanning the full
        chart, with a wider triangle handle at the top. Now that the
        scrub-time chip is gone, this cursor IS the primary feedback
        during a drag, so it has to read instantly without scrutiny.
        Same blue as the clock-chip scrub theme so the user spatially
        links the two: drag here, time updates over there. */
    .tb-cursor-sel
    {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        background: rgba(31, 111, 235, 0.95);
        transform: translateX(-50%);
        pointer-events: none;
        z-index: 4;
        box-shadow: 0 0 4px rgba(31, 111, 235, 0.4);
    }

    .tb-cursor-sel::after
    {
        content: '';
        position: absolute;
        top: -3px;
        left: 50%;
        transform: translateX(-50%);
        width: 0;
        height: 0;
        border-left:   6px solid transparent;
        border-right:  6px solid transparent;
        border-top:    8px solid rgba(31, 111, 235, 0.95);
        filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35));
    }

    /*  Hover guide line, drawn vertically across the chart at
        the pointer's X. Same dotted recipe as the day-separator
        lines but a touch more opaque so it reads as "interactive
        focus" rather than ambient structure.                       */
    .hc-hover-guide
    {
        stroke: rgba(0, 0, 0, 0.55);
        stroke-width: 1;
        stroke-dasharray: 2 2;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
    }
    ha-card.theme-dark .hc-hover-guide { stroke: rgba(255, 255, 255, 0.65); }

    /*  Per-curve hover dot, anchored at the interpolated Y of
        each series. Stroked in card colour so the dot stays
        legible whether it lands on a filled area or on the
        background.                                                  */
    .hc-hover-dot
    {
        stroke: #ffffff;
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
    }
    ha-card.theme-dark .hc-hover-dot { stroke: rgba(20, 20, 20, 0.95); }

    /*  Hover tooltip chip, sits above the chart-card stack
        inside the time-bar. White chip with the same border +
        shadow recipe as the .clock and .lidar-view chips so the
        whole timeline reads as one chip family.                    */
    .tb-hover-tooltip
    {
        position: absolute;
        bottom: 100%;
        margin-bottom: 4px;
        transform: translateX(-50%);
        background: #ffffff;
        color: #000000;
        border: 1px solid #000000;
        border-radius: 3px;
        padding: 4px 8px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        font-family: var(--primary-font-family, 'Roboto', sans-serif);
        font-size: 11px;
        line-height: 1.2;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        pointer-events: none;
        z-index: 30;
    }

    .tb-hover-tooltip-time
    {
        font-weight: 600;
        margin-bottom: 3px;
        text-align: center;
    }

    .tb-hover-tooltip-row
    {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .tb-hover-tooltip-icon
    {
        --mdc-icon-size: 13px;
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
        line-height: 1;
    }

    .tb-hover-tooltip-value
    {
        flex: 1;
        text-align: right;
    }

    ha-card.theme-dark .tb-hover-tooltip
    {
        background: rgba(30, 30, 30, 0.95);
        color: #ffffff;
        border-color: rgba(255, 255, 255, 0.85);
    }


    /*  Night-zone overlays. One absolutely-positioned div per
        sunset, next sunrise window, inserted as a sibling of the
        chart SVG inside the chart card. CSS diagonal hatching
        sits on top of the curves but below the live + scrub
        cursors (z-index 4), so dusk and dawn read as "this slice
        is night" without obscuring the curve shape underneath.
        Repeating linear gradients render at the device pixel grid
        regardless of the chart SVG's preserveAspectRatio=none, so
        the stripes stay diagonal across any card width.            */
    /*  Future-mask wash, sits on top of the curves and night zones
        and stretches from "now" to the right edge of the card. The
        wash uses the card background colour at moderate alpha so it
        lightens the curves AND the night-zone hatches in a single
        pass without redoubling on overlapping regions. Cursors sit
        at z-index 4 and stay fully opaque.                          */
    .hc-future-mask
    {
        position: absolute;
        top: 0;
        bottom: 0;
        right: 0;
        pointer-events: none;
        z-index: 3;
        background: rgba(255, 255, 255, 0.55);
    }
    ha-card.theme-dark .hc-future-mask
    {
        background: rgba(20, 20, 22, 0.55);
    }


    .hc-night-zone
    {
        position: absolute;
        top: 0;
        bottom: 0;
        pointer-events: none;
        z-index: 3;
        /*  Hatch + sunset/sunrise edges share the exact same RGBA
            (rgba(0, 0, 0, 0.07) light, rgba(255, 255, 255, 0.10)
            dark) so the boundary line reads as the densest part of
            the same hatch rather than as a separate marker. Alpha
            dropped relative to earlier iterations: too much density
            obscured the curves the user came to read.              */
        background-image: repeating-linear-gradient(
            45deg,
            rgba(0, 0, 0, 0.04) 0,
            rgba(0, 0, 0, 0.04) 1.5px,
            transparent       1.5px,
            transparent       6px
        );
        box-shadow: inset  1px 0 0 0 rgba(0, 0, 0, 0.04),
                    inset -1px 0 0 0 rgba(0, 0, 0, 0.04);
    }
    ha-card.theme-dark .hc-night-zone
    {
        background-image: repeating-linear-gradient(
            45deg,
            rgba(255, 255, 255, 0.06) 0,
            rgba(255, 255, 255, 0.06) 1.5px,
            transparent              1.5px,
            transparent              6px
        );
        box-shadow: inset  1px 0 0 0 rgba(255, 255, 255, 0.06),
                    inset -1px 0 0 0 rgba(255, 255, 255, 0.06);
    }


    /*  Day strip: a single bordered bar spanning the full timeline
        width, with one centred label per visible day and a 1 px
        vertical separator at every midnight boundary between two
        adjacent days. Same border + radius + shadow recipe as the
        chart cards above so the timeline stack reads as one
        composed instrument.                                        */
    .tb-day-strip
    {
        position: relative;
        height: 22px;
        background: #ffffff;
        border: 1px solid #000000;
        border-radius: 3px;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
        overflow: hidden;
        pointer-events: none;
    }

    .tb-day-strip-cell
    {
        position: absolute;
        top: 0;
        bottom: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        padding: 0 4px;
        box-sizing: border-box;
        color: #000000;
        line-height: 1.2;
        letter-spacing: 0.2px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: clip;
        z-index: 2;
        /*  Each cell is its own size container; the date + kWh
            children scale + collapse using cqw / @container queries
            so the text adapts to whatever horizontal real-estate
            the visible time range gives the day (a 4-day window on
            a narrow phone leaves ~25 % of the timeline per cell;
            a 1-day window leaves the whole strip). Falls back to
            the static font-size + display rules below on engines
            without container-query support.                        */
        container-type: inline-size;
        container-name: tb-day-strip-cell;
    }

    /*  Both the date and the kWh scale down with the cell width
        via cqw (1 % of container inline size). The date sits at
        a slightly bigger clamp than the kWh so the primary label
        gets the visual weight; the kWh stays demoted as a
        contextual annotation. Font weight is intentionally NOT
        set here so it inherits from the cell (which gets is-today
        bumped to 800) and from the per-element overrides further
        down (.tb-day-strip-kwh keeps its lighter 500 weight +
        opacity recipe).                                            */
    .tb-day-strip-date
    {
        font-size: clamp(9px, 11cqw, 13px);
    }
    .tb-day-strip-kwh
    {
        font-size: clamp(7px, 9cqw, 11px);
    }

    .tb-day-strip-cell
    {
        font-weight: 600;
    }
    .tb-day-strip-cell.is-today
    {
        font-weight: 800;
    }

    /*  Last-resort fallback: a really cramped cell (4-day window on
        a sub-300 px card) drops the kWh so the date stays the
        single anchor visible. The clamp() above keeps the kWh
        visible on every reasonable layout including a 4-day view
        on a 700 px desktop card.                                   */
    @container tb-day-strip-cell (max-width: 55px)
    {
        .tb-day-strip-kwh { display: none; }
    }

    /*  Vertical separator at each between-day boundary. Dotted
        1 px line matching the chart's own day separators
        (.hc-day-sep: stroke 0.30 alpha, dasharray 1.5 / 2.5), so
        the strip extends the same visual language as the cards
        above it. No separator at the outer edges since the strip
        border already closes the line there.                       */
    .tb-day-strip-sep
    {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 1px;
        z-index: 1;
        background-image: repeating-linear-gradient(
            to bottom,
            rgba(0, 0, 0, 0.30) 0,
            rgba(0, 0, 0, 0.30) 1.5px,
            transparent       1.5px,
            transparent       4px
        );
    }

    /*  Daily kWh total, sits next to the date label in the same
        cell. Same lighter weight + opacity recipe as the previous
        chip layout so the date stays the primary read; forecast
        days italicise to flag "estimate, not observation".         */
    .tb-day-strip-kwh
    {
        font-weight: 500;
        opacity: 0.75;
    }
    .tb-day-strip-kwh::before
    {
        content: "·";
        margin-right: 4px;
        opacity: 0.5;
    }
    .tb-day-strip-kwh.is-forecast
    {
        font-style: italic;
    }

    /*  Optional PV graph card stacked above the main chart. Same
        height as the main chart so the two cards form a balanced
        stack: production sits on top, irradiance + cloud cover
        underneath, neither dominating the other. The combined
        block keeps the same total vertical footprint the previous
        (32 px PV + 64 px main) layout occupied. */
    .tb-pv-card
    {
        height: 48px;
    }


    /*  Spinner, centred on the map while a fetch is in flight. */

    .spinner-center
    {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 50;
        width: 40px;
        height: 40px;
        opacity: 0;
        transition: opacity 0.15s ease;
        pointer-events: none;
    }

    .spinner-center.spinning
    {
        opacity: 1;
    }

    /*  Helios brand spinner: the SVG sun, no border, no background,
        no shadow. Only the ray bundle rotates; the inner disc stays
        still so the brand colour reads as a steady centre while the
        rays sweep around it. */
    .spinner-sun
    {
        width:  100%;
        height: 100%;
        display: block;
    }
    .spinner-sun-rays
    {
        transform-origin: 32px 32px;
        transform-box: view-box;
        animation: helios-spin 1.6s linear infinite;
    }

    @keyframes helios-spin
    {
        to { transform: rotate(360deg); }
    }


    /*  LiDAR View toggle button, lives in the .overlay-top-right
        column. Sized to mirror the .clock chip on the left so the
        two corners read as a symmetric pair. Stays at fixed width
        when toggled on/off so neighbour chips don't jump. */
    /*  Passive "LiDAR" status chip on the top-right rail, mirror of
        the .clock chip on the top-left. Same recipe: 12 px Roboto
        600, line-height 1.2, padding 2 px 8 px, 22 px tall, mixed-
        case label so the baseline metrics are unambiguous across
        Chromium / Firefox / WebKit.

        The chip is purely visual; the click action lives on the
        adjacent .lidar-view-toggle-btn. The .overlay-top-right rail
        uses flex-direction: row-reverse so the DOM order
        (button, then chip) renders visually as (chip, then button):
        chip sits on the LEFT and the button on the RIGHT. The chip
        therefore keeps its LEFT corners rounded and squares its
        RIGHT corners, and lets the button drop its left border so
        the chip's right border becomes the shared seam.            */
    .lidar-view-chip
    {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 22px;
        box-sizing: border-box;
        padding: 2px 8px;
        background: #ffffff;
        color:      #000000;
        border:     1px solid #000000;
        /*  Rounded LEFT corners only: the chip is on the LEFT of
            the cluster, the right edge is the shared seam with the
            toggle button and must stay square. */
        border-radius: 3px 0 0 3px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        font-family: var(--primary-font-family, 'Roboto', sans-serif);
        font-size:   12px;
        font-weight: 600;
        line-height: 1.2;
        white-space: nowrap;
        cursor: pointer;
        pointer-events: auto;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
        position: relative;
        z-index: 50;
    }
    .lidar-view-chip:hover  { background: #f2f2f2; }
    .lidar-view-chip:active { background: #e6e6e6; }
    .lidar-view-chip.is-uncovered
    {
        opacity: 0.35;
        cursor: not-allowed;
    }
    .lidar-view-chip.is-uncovered:hover  { background: #ffffff; }
    .lidar-view-chip.is-uncovered:active { background: #ffffff; }
    .lidar-view-chip.is-on:hover  { background: rgba(24, 92, 199, 0.95); }
    .lidar-view-chip.is-on:active { background: rgba(20, 78, 168, 0.95); }

    /*  LiDAR-view toggle button, sits to the RIGHT of the .lidar-
        view-chip (the .overlay-top-right rail uses row-reverse so
        the DOM-first button ends up on the right). Fuses with the
        chip via a shared seam (no border between them). Mirror of
        the .live-return-btn on the top-left rail; same 22 x 22
        square, same 12 px icon, same scrub-blue theme on activation,
        just flipped to the right side.

        Three coverage states, set inline by the renderer:
          .is-uncovered  no LiDAR provider matches the home, the
                         button is :disabled and inert
          .is-online     a public WCS / WMS provider covers the
                         home, the button toggles LiDAR view
          .is-local      a BYO local-nDSM raster is configured AND
                         covers the home, the button toggles LiDAR
                         view; the harddisk glyph signals the user
                         is on their own data
        On activation (.is-on, set when _lidarViewMode is true) the
        button + chip pair take the same scrub-blue plate the clock
        chip + back-to-live pair uses when scrubbing the timeline.   */
    .lidar-view-toggle-btn
    {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width:  22px;
        height: 22px;
        box-sizing: border-box;
        padding: 0;
        background: #ffffff;
        color:      #000000;
        border:     1px solid #000000;
        /*  Rounded RIGHT corners only + dropped left border: the
            button sits on the RIGHT of the cluster, the left edge
            is the shared seam and the chip's right border is what
            the user sees there. */
        border-radius: 0 3px 3px 0;
        border-left: 0;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        cursor: pointer;
        pointer-events: auto;
        position: relative;
        z-index: 50;
        opacity: 1;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .lidar-view-toggle-btn:hover  { background: #f2f2f2; }
    .lidar-view-toggle-btn:active { background: #e6e6e6; }
    .lidar-view-toggle-btn ha-icon
    {
        --mdc-icon-size: 12px;
        color: inherit;
        display: inline-flex;
        align-items: center;
    }

    /*  Uncovered state: disabled, faded, no hover effect. The chip
        next to it stays at full opacity, the user still reads
        "LiDAR" but the button glyph reads "not available here". */
    .lidar-view-toggle-btn.is-uncovered
    {
        opacity: 0.35;
        cursor: not-allowed;
    }
    .lidar-view-toggle-btn.is-uncovered:hover  { background: #ffffff; }
    .lidar-view-toggle-btn.is-uncovered:active { background: #ffffff; }

    /*  Active state: both halves of the cluster flip to the same
        scrub-blue plate as .clock.is-scrub + .live-return-btn on
        the opposite rail. The pair reads as one continuous blue
        control while LiDAR view is open, which is the visual
        signal that the user is in a non-default mode.              */
    .lidar-view-toggle-btn.is-on,
    .lidar-view-chip.is-on
    {
        background: rgba(31, 111, 235, 0.95);
        color: #ffffff;
        border-color: rgba(20, 78, 168, 0.95);
    }
    .lidar-view-toggle-btn.is-on:hover  { background: rgba(24, 92, 199, 0.95); }
    .lidar-view-toggle-btn.is-on:active { background: rgba(20, 78, 168, 0.95); }


    /*  When LiDAR View is active, fade out every overlay layer so
        the dot cloud reads on its own against a quiet basemap. The
        toggle button itself is opted back in (selector below) so
        the user can always exit. The map container stays visible
        so the dots are projected onto a real basemap.

        Selector list mirrors what .detail-active fades earlier in
        this file, plus the corners (top-left clock + top-right rail
        minus the LiDAR button itself), the home hitbox / glow, and
        the timeline. Easier to audit if any future overlay needs
        to be hidden in LiDAR View by looking at this single block. */
    ha-card.lidar-view-active .overlay-top-left,
    ha-card.lidar-view-active .home-glow-svg,
    ha-card.lidar-view-active .home-hitbox,
    ha-card.lidar-view-active .home-silhouette-svg,
    ha-card.lidar-view-active .time-bar,
    ha-card.lidar-view-active .solar-svg,
    ha-card.lidar-view-active .solar-pct-label,
    ha-card.lidar-view-active .cloud-svg,
    ha-card.lidar-view-active .cloud-leader-svg,
    ha-card.lidar-view-active .cloud-pct-label,
    ha-card.lidar-view-active .pv-home-anchor-svg,
    ha-card.lidar-view-active .pv-home-leader-svg,
    ha-card.lidar-view-active .pv-pct-label,
    ha-card.lidar-view-active .battery-leader-svg,
    ha-card.lidar-view-active .battery-pct-label
    {
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.25s ease;
    }
    ha-card.lidar-view-active .overlay-top-right
    {
        opacity: 1;
        pointer-events: auto;
    }

    /*  Shading-dome view: mirrors the LiDAR fade-out list so the
        rest of the HUD steps aside when the dome takes over the
        canvas, then the dome SVG itself overlays the map without
        intercepting pointer events. Top-right chip cluster stays
        live so the user can toggle the dome back off.            */
    ha-card.shading-dome-active .overlay-top-left,
    ha-card.shading-dome-active .home-glow-svg,
    ha-card.shading-dome-active .home-hitbox,
    ha-card.shading-dome-active .home-silhouette-svg,
    ha-card.shading-dome-active .time-bar,
    ha-card.shading-dome-active .solar-svg,
    ha-card.shading-dome-active .solar-pct-label,
    ha-card.shading-dome-active .cloud-svg,
    ha-card.shading-dome-active .cloud-leader-svg,
    ha-card.shading-dome-active .cloud-pct-label,
    ha-card.shading-dome-active .pv-home-anchor-svg,
    ha-card.shading-dome-active .pv-home-leader-svg,
    ha-card.shading-dome-active .pv-pct-label,
    ha-card.shading-dome-active .battery-leader-svg,
    ha-card.shading-dome-active .battery-pct-label
    {
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.25s ease;
    }
    /*  Top-right cluster (mode bar) stays visible while the
        dome is active so the user can always switch modes via
        the same widget that took them in.                       */
    ha-card.shading-dome-active .overlay-top-right
    {
        opacity: 1;
        pointer-events: auto;
    }
    /*  Three-segment mode bar (Layer UI / LiDAR / Ombres). Sits
        in the top-right rail in place of the old LiDAR chip pair.
        Stacked VERTICALLY with iOS-friendly 40 px touch targets
        so the trio is comfortable on a phone in landscape. Each
        segment is icon-only with a title tooltip; the active
        segment takes the same scrub-blue plate the clock chip
        uses while scrubbing so the user has one consistent
        visual language for "you are in a non-default mode".
        Segments are glued together via shared borders and
        matching corner radii.                                    */
    .mode-bar
    {
        display: inline-flex;
        flex-direction: column;
        align-items: stretch;
        pointer-events: auto;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        border-radius: 6px;
    }
    .mode-bar-seg
    {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width:  40px;
        height: 40px;
        box-sizing: border-box;
        padding: 0;
        background: #ffffff;
        color:      #000000;
        border:     1px solid #000000;
        border-bottom: 0;
        cursor: pointer;
        position: relative;
        z-index: 50;
        opacity: 1;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .mode-bar-seg:first-child { border-radius: 6px 6px 0 0; }
    .mode-bar-seg:last-child  { border-radius: 0 0 6px 6px; border-bottom: 1px solid #000000; }
    .mode-bar-seg:hover       { background: #f2f2f2; }
    .mode-bar-seg:active      { background: #e6e6e6; }
    .mode-bar-seg ha-icon
    {
        --mdc-icon-size: 22px;
        color: inherit;
        display: inline-flex;
        align-items: center;
    }
    /*  Country-flag variant of the LiDAR-View button. The SVG ships
        inline (see card/flags.ts) so it renders identically across
        OSes (Apple flag emoji look great but Windows + a few Linux
        distros mangle several country codes). Square-clamped to the
        same 22 px footprint MDI icons get.                            */
    .mode-bar-seg .mode-bar-flag
    {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width:  22px;
        height: 22px;
        border-radius: 3px;
        overflow: hidden;
    }
    .mode-bar-seg .mode-bar-flag svg
    {
        width:  100%;
        height: 100%;
        display: block;
    }
    .mode-bar-seg.is-disabled
    {
        opacity: 0.35;
        cursor: not-allowed;
    }
    .mode-bar-seg.is-disabled:hover,
    .mode-bar-seg.is-disabled:active { background: #ffffff; }
    .mode-bar-seg.is-on
    {
        background: rgba(31, 111, 235, 0.95);
        color: #ffffff;
        border-color: rgba(20, 78, 168, 0.95);
    }
    .mode-bar-seg.is-on:hover  { background: rgba(24, 92, 199, 0.95); }
    .mode-bar-seg.is-on:active { background: rgba(20, 78, 168, 0.95); }
    /*  Vertical seam between an active segment and the next one
        down: paint a 1 px overlay on the top of the lower
        segment so the seam reads as part of the active plate
        instead of the inactive segment's border below it.       */
    .mode-bar-seg.is-on + .mode-bar-seg::before
    {
        content: '';
        position: absolute;
        left: -1px;
        right: -1px;
        top: -1px;
        height: 1px;
        background: rgba(20, 78, 168, 0.95);
        pointer-events: none;
    }
    /*  Dome SVG: full-card overlay, sits below the click chrome so
        it never blocks pointer events. Fade alpha comes from inline
        style driven by the dome fade RAF.                          */
    .shading-dome-svg
    {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 7;
    }
    /*  Cloud-bin picker: small segmented control hugging the top
        edge under the dome chip cluster. Pills mirror the dome's
        accent so it reads as part of the same widget.             */
    /*  Continuous cloud-cover slider, bottom-left corner of the
        card while the dome is on. Sun glyph on the LEFT, heavy-
        cloud glyph on the RIGHT, the slider in between reads as
        the cloud-cover knob driving the dome's view. The percent
        value chip on the far RIGHT is the immediate readout of
        the slider position; lets the user know they're at 35 %
        rather than guessing from the handle's position.          */
    .shading-dome-cloud-slider
    {
        position: absolute;
        bottom: 14px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 50;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        background: rgba(0, 0, 0, 0.55);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 999px;
        pointer-events: auto;
    }
    /*  Tick wrapper: the slider sits in a relative container so
        the tick spans can be absolutely positioned over the
        track without disturbing the slider's native thumb
        hit-area. --thumb-r feeds the calc() positions on each
        tick so they land on the actual thumb centre at every
        snap point, not on the wrap's geometric percentage. The
        native thumb's centre travels between (thumb-r) and
        (track-width - thumb-r), so we use the same offset for
        the tick positions.                                       */
    .shading-dome-cloud-track-wrap
    {
        --thumb-r: 7px;
        position: relative;
        display: inline-flex;
        align-items: center;
        height: 14px;
    }
    .shading-dome-cloud-tick
    {
        position: absolute;
        top: 50%;
        width: 2px;
        height: 8px;
        background: rgba(255, 255, 255, 0.55);
        border-radius: 1px;
        transform: translate(-50%, -50%);
        pointer-events: none;
    }
    .shading-dome-cloud-icon
    {
        --mdc-icon-size: 18px;
        color: rgba(255, 255, 255, 0.85);
        display: inline-flex;
        align-items: center;
    }
    .shading-dome-cloud-icon--sun   { color: #fde68a; }
    .shading-dome-cloud-icon--cloud { color: #cbd5e1; }
    .shading-dome-cloud-range
    {
        appearance: none;
        -webkit-appearance: none;
        width: 160px;
        height: 4px;
        background: linear-gradient(to right, #fde68a 0%, #cbd5e1 100%);
        border-radius: 999px;
        outline: none;
        cursor: pointer;
        margin: 0;
    }
    .shading-dome-cloud-range::-webkit-slider-thumb
    {
        appearance: none;
        -webkit-appearance: none;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #ffffff;
        border: 1px solid rgba(0, 0, 0, 0.4);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
        cursor: pointer;
    }
    .shading-dome-cloud-range::-moz-range-thumb
    {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #ffffff;
        border: 1px solid rgba(0, 0, 0, 0.4);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
        cursor: pointer;
    }
    .shading-dome-cloud-value
    {
        min-width: 36px;
        text-align: right;
        font-size: 11px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.85);
        font-variant-numeric: tabular-nums;
    }


    /*  Top corner overlays. Date/time + scrub-return cluster on the
        left; LiDAR-view toggle + "LiDAR" status chip on the right.
        Both rails are flex rows sitting 8 px from their card edge,
        each one fusing two elements (chip + adjacent button) into
        a single composite control via shared seams.                */

    /*  Date/time chip, same chip language as the on-map readouts.
        Explicit height (border-box) so the chip and the back-to-
        live button next to it share the exact same vertical
        footprint, no align-items: center shift in the parent flex
        container. */
    .clock
    {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 22px;
        box-sizing: border-box;
        background: #ffffff;
        color:      #000000;
        border:     1px solid #000000;
        border-radius: 3px;
        padding: 2px 6px;
        font-family: var(--primary-font-family, 'Roboto', sans-serif);
        font-size:    12px;
        font-weight:  600;
        line-height:  1.2;
        font-variant-numeric: tabular-nums;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        white-space: nowrap;
        position: relative;
        z-index: 2;
    }

    .clock-date { opacity: 0.75; }
    .clock-time { opacity: 1;    }

    /*  Scrub-mode theme for the clock chip. Same chip flips to a
        white-on-blue look so it doubles as the "you're not in live
        mode" signal. The blue matches the timeline scrub cursor so
        the user spatially links the top-left chip with the timeline
        marker driving it. The chip's right corners are also squared
        in scrub mode so it physically fuses with the back-to-live
        button rendered next to it: same blue plate, shared seam,
        zero visual gap, the pair reads as one composite control.

        Both selectors are listed so the rule beats the dark-theme
        override (ha-card.theme-dark .clock, specificity 0,2,1) in
        both light and dark contexts; without the second selector
        the dark-theme rule keeps the chip grey when scrubbing. */
    .clock.is-scrub,
    ha-card.theme-dark .clock.is-scrub
    {
        background: rgba(31, 111, 235, 0.95);
        color: #ffffff;
        border-color: rgba(20, 78, 168, 0.95);
        border-top-right-radius: 0;
        border-bottom-right-radius: 0;
    }
    .clock.is-scrub .clock-date,
    ha-card.theme-dark .clock.is-scrub .clock-date { opacity: 0.95; color: #ffffff; }
    .clock.is-scrub .clock-time,
    ha-card.theme-dark .clock.is-scrub .clock-time { opacity: 1;    color: #ffffff; }

    /*  "Back to live" button, lives next to the clock chip in the
        top-left cluster while scrubbing. Square 22 x 22 to match
        the clock chip height exactly (so the parent flex container
        doesn't need vertical centering compensation), with the
        same scrub-blue plate as the on-chart scrub cursor and the
        clock chip's scrub theme so the cluster reads as one unit.
        Icon kept small (12 px in a 22 px square = 5 px ring of
        breathing room) so the chip frame dominates over the
        glyph, consistent with the chip-language used everywhere
        else on the card. */
    .live-return-btn
    {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width:  22px;
        height: 22px;
        box-sizing: border-box;
        padding: 0;
        background: rgba(31, 111, 235, 0.95);
        color: white;
        border: 1px solid rgba(20, 78, 168, 0.95);
        /*  Square left corners + drop the left border so the chip's
            right border serves as the shared seam, no double 2 px
            stroke at the join. The pair reads as one continuous
            blue plate. */
        border-radius: 0 3px 3px 0;
        border-left: 0;
        cursor: pointer;
        pointer-events: auto;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        transition: background 0.12s;
    }

    .live-return-btn:hover  { background: rgba(24, 92, 199, 0.95); }
    .live-return-btn:active { background: rgba(20, 78, 168, 0.95); }

    .live-return-btn ha-icon
    {
        --mdc-icon-size: 12px;
        color: white;
        display: inline-flex;
        align-items: center;
    }

    /*  Top-right overlay rail. Hosts the LiDAR-view toggle button
        fused with the passive LiDAR status chip, mirror of the
        top-left clock + scrub-return pair. Mirrors the clock's
        top spacing on the opposite edge so the two overlays sit
        at the same height; flex-direction: row-reverse keeps the
        chip on the right edge of the screen with the toggle
        button to its left, mirroring the clock-on-the-left + back
        -to-live-on-its-right pattern on the opposite rail.

        z-index: 60 puts the rail (and therefore both halves of
        the cluster) above the LiDAR View canvas (z 30) AND above
        the centre spinner (z 50), so the toggle is always
        reachable. Pointer events off on the rail itself so the
        empty rail never steals map interactions; the toggle
        button opts back in via .lidar-view-toggle-btn rules. */
    .overlay-top-right
    {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 60;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        pointer-events: none;
    }

    /*  Top-left rail, mirrors overlay-top-right on the opposite edge
        so the corner overlays sit at matching heights. Hosts the
        date/time clock chip plus, when scrubbing, the back-to-live
        button right next to it (both relate to "where am I in
        time"). Laid out as a flex row with a small gap. Pointer
        events are off on the rail by default, the button re-enables
        them on itself so clicks reach it without the rail stealing
        unrelated map interactions. */
    .overlay-top-left
    {
        position: absolute;
        top: 8px;
        left: 8px;
        z-index: 5;
        display: flex;
        align-items: center;
        /*  No gap, the clock chip and the back-to-live button (when
            scrubbing) physically touch so the pair reads as one
            composite "time + control" widget rather than two
            independent chips. Border radii are squared on the
            facing edges below so the seam is invisible. */
        gap: 0;
        pointer-events: none;
    }


    /*  "LiDAR shadow computing" indicator. Stripped to the spinning
        sun glyph alone, no chip plate, no border, no shadow, matches
        the clean spinner-sun aesthetic at the centre of the map: a
        pure on-brand mark in the foreground that doesn't compete
        with the chips and buttons around it. */
    .shadow-busy-chip
    {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width:  22px;
        height: 22px;
        background: transparent;
        border: 0;
        box-shadow: none;
    }

    /*  Rotating sun glyph used as the busy indicator. Themed through
        the configured sun colour so themed installs stay on-brand,
        with the brand orange as the fallback. */
    .shadow-busy-sun
    {
        --mdc-icon-size: 18px;
        color: var(--helios-sun-color, #EF9F27);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        animation: helios-shadow-spin 1.4s linear infinite;
    }

    @keyframes helios-shadow-spin
    {
        from { transform: rotate(0deg); }
        to   { transform: rotate(360deg); }
    }

    /*  Cloud-cover percentage chip, floating above the cloud disc
        on the ground with a leader line down to its feature. */
    .cloud-pct-label
    {
        position: absolute;
        transform: translate(-50%, -50%);
        pointer-events: none;
        z-index: 6;
        display: inline-flex;
        align-items: center;
        gap: 3px;
        background: #ffffff;
        color:      #000000;
        border:     1px solid #000000;
        border-radius: 3px;
        padding: 2px 6px 2px 4px;
        font-size:    12px;
        font-weight:  600;
        line-height:  1.2;
        font-variant-numeric: tabular-nums;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    }

    .cloud-pct-label ha-icon
    {
        --mdc-icon-size: 12px;
        color: #000000;
        display: inline-flex;
        align-items: center;
    }

    /*  Photovoltaic production chip, same frame as cloud/W/m² but
        tinted in the user-configured production colour (border +
        text + icon) for instant identification.
        --pv-leader-color is set inline by the renderer. The
        min-width / centred text are shared with the SoC and Power
        battery chips so the visible gap on each side of the PV
        chip is identical regardless of how wide each value reads
        ("26 %" vs "+12.34 kW" otherwise produce visibly unequal
        leader gaps). */
    .pv-pct-label
    {
        position: absolute;
        transform: translate(-50%, -50%);
        pointer-events: none;
        z-index: 6;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 3px;
        min-width: 76px;
        box-sizing: border-box;
        background: #ffffff;
        color:      var(--pv-leader-color, #27B36B);
        border:     1px solid var(--pv-leader-color, #27B36B);
        border-radius: 3px;
        padding: 2px 6px 2px 4px;
        font-size:    12px;
        font-weight:  600;
        line-height:  1.2;
        font-variant-numeric: tabular-nums;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        white-space: nowrap;
    }

    .pv-pct-label ha-icon
    {
        --mdc-icon-size: 12px;
        color: inherit;
        display: inline-flex;
        align-items: center;
    }

    /*  Predicted PV chip, shown when scrubbing into the future. The
        value comes from the kWp × clear-sky model, not a measured
        reading, so we semi-transparency the whole chip and rely on
        the leading "≈" character (set by the card's render) to
        signal "estimate" textually. */
    .pv-pct-label.is-predicted
    {
        opacity: 0.55;
        font-style: italic;
    }

    /*  Battery chips (SoC on the left of PV, Power on the right) ,
        same frame as the PV chip, tinted in the user-configured
        battery colour. Shares min-width and centred text with the
        PV chip so the visible dotted-leader gap on each side of PV
        is identical regardless of the value's content width.
        --battery-leader-color is set inline by the renderer. */
    .battery-pct-label
    {
        position: absolute;
        transform: translate(-50%, -50%);
        pointer-events: none;
        z-index: 6;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 3px;
        min-width: 76px;
        box-sizing: border-box;
        background: #ffffff;
        color:      var(--battery-leader-color, #D32F2F);
        border:     1px solid var(--battery-leader-color, #D32F2F);
        border-radius: 3px;
        padding: 2px 6px 2px 4px;
        font-size:    12px;
        font-weight:  600;
        line-height:  1.2;
        font-variant-numeric: tabular-nums;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        white-space: nowrap;
    }

    .battery-pct-label ha-icon
    {
        --mdc-icon-size: 12px;
        color: inherit;
        display: inline-flex;
        align-items: center;
    }

    /*  PV → home leader. Vertical dashed line from the PV chip's
        bottom edge down to the home marker, painted in the configured
        PV colour. Same dash vocabulary as the battery leader so the
        two flows read as one coherent visual language. Animation runs
        only when current production is positive; idle state keeps the
        line static. Sits at z 5, BELOW the chip cluster (z 6) so the
        dashes pass behind the PV / SoC / Power chips. */
    .pv-home-leader-svg
    {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 5;
    }

    .pv-home-leader-line
    {
        stroke: var(--pv-leader-color, #27B36B);
        stroke-width: 1.5;
        stroke-opacity: 0.85;
        stroke-linecap: round;
        fill: none;
    }

    /*  Moving bead, a small filled disc rides the leader at a
        speed proportional to live production. Same vocabulary as
        the Home Assistant energy-distribution card. */
    .pv-home-leader-bead
    {
        opacity: 0.95;
        stroke: #ffffff;
        stroke-width: 1;
        stroke-opacity: 0.85;
        paint-order: stroke fill;
    }
    ha-card.theme-dark .pv-home-leader-bead
    {
        stroke: #191a1b;
        stroke-opacity: 0.95;
    }

    /*  PV home-anchor ring host SVG. Sits below every chip cluster
        + leader line (z-index 1) but above the MapLibre canvas
        (z-index 0), and below the home-glow silhouette (z-index 11)
        so the projected building paints OVER the back half of the
        ring. The eye reads the ring as a ground footprint the
        building stands inside, which is what the perspective
        projection promises geometrically.                           */
    .pv-home-anchor-svg
    {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 1;
    }

    /*  PV home-anchor ring, drawn as a stroked polygon projected
        through the map's perspective so it sits flat on the ground
        around the home (an ellipse aplated by the camera pitch +
        rotated by the camera bearing). Stroked rather than filled
        so the home silhouette stays visible inside the ring. The
        translate-to-home transform lives on the wrapping <g>; the
        polygon points themselves are coordinates relative to
        (0, 0), which lets the pulse animation scale the polygon
        around the home centre by simply scaling the group around
        its local origin.                                            */
    .pv-home-leader-anchor       { transform-origin: 0 0; }
    .pv-home-leader-anchor-disc
    {
        transform-origin: 0 0;
        vector-effect: non-scaling-stroke;
    }
    .pv-home-leader-anchor.is-pulsing .pv-home-leader-anchor-disc
    {
        animation: pv-home-anchor-pulse var(--pv-flow-duration, 2s) ease-in-out infinite;
    }
    @keyframes pv-home-anchor-pulse
    {
        0%, 80% { transform: scale(1); }
        92%     { transform: scale(1.55); }
        100%    { transform: scale(1); }
    }


    /*  Battery leaders.
        Both SoC ↔ PV and PV ↔ Power share the exact same visual
        vocabulary: solid L-shaped path with a rounded fillet at
        the bend, matching the Home Assistant energy-distribution
        card. The PV ↔ Power leader carries a small filled bead
        riding along the path (animateMotion in card.ts) at a
        speed proportional to |P|; the bead's path is flipped
        inline by the renderer when discharging so its travel
        direction matches the energy flow. The SoC leader is
        static, no bead: SoC is a level, not a flow. */
    .battery-leader-svg
    {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 5;
    }

    .battery-leader-line
    {
        stroke: var(--battery-leader-color, #D32F2F);
        stroke-width: 1.5;
        stroke-opacity: 0.85;
        stroke-linecap: round;
        stroke-linejoin: round;
        fill: none;
    }

    .battery-leader-bead
    {
        opacity: 0.95;
        stroke: #ffffff;
        stroke-width: 1;
        stroke-opacity: 0.85;
        paint-order: stroke fill;
    }
    ha-card.theme-dark .battery-leader-bead
    {
        stroke: #191a1b;
        stroke-opacity: 0.95;
    }

    /*  Cloud-cover leader line, black hairline from chip to disc. */
    .cloud-leader-svg
    {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 5;
    }

    .cloud-leader-svg line
    {
        stroke: #000000;
        stroke-width: 1;
        stroke-opacity: 0.55;
    }


    /*  Solar overlay, split into two passes so chips never occlude
        the live sun while the night portion of the loop still reads
        as background:
          - .solar-svg-back paints only the dotted below-horizon
            segments and stacks BELOW the home chip cluster (z 4)
            so the home + readouts sit clearly on top of the night
            half of the orbit.
          - .solar-svg-front paints the above-horizon arc, the
            incidence ray, and the sun disc, and stacks ABOVE the
            chips (z 7) so the live sun always dominates the stack.
            The card is named Helios, the sun must win the stack. */
    .solar-svg
    {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        /* Daylight fade is fed via the --solar-daylight CSS variable
           (set inline per render, ranges 0..1) instead of an inline
           opacity, so the .detail-active fade rule below can win
           cleanly without fighting an inline style. */
        opacity: var(--solar-daylight, 1);
        transition: opacity 600ms ease-out;
    }
    .solar-svg-back  { z-index: 4; }
    .solar-svg-front { z-index: 7; }

    /*  Cloud-cover overlay. Two polygons (the filled disc sized by
        the live cloud %, the fixed 100 % reference ring outline)
        projected from a geographic circle around the home through
        the engine's anchor-at-home pipeline, so they stay a true
        circle whatever the terrain mesh does underneath. Sits below
        the solar overlay in stacking order (z-index 3 vs 4) so the
        sun arc + sun disc draw on top. */
    .cloud-svg
    {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 3;
    }
    /*  Each band is a fully-opaque concentric disc; the outermost
        (high cloud, dark shade) renders first, then mid (normal
        shade), then low (light shade) on top. The visual banding
        comes from each smaller disc covering the centre of the
        larger one — no SVG mask or clip-path needed. */
    .cloud-svg .cloud-disc
    {
        pointer-events: none;
    }
    /*  Thin separator outlines drawn on the inner band boundaries
        (low ↔ mid and mid ↔ high). Stroke-only, no fill so the
        band colours behind stay untouched. The outermost edge
        (high ↔ outside) is already painted by .cloud-ring. */
    .cloud-svg .cloud-band-sep
    {
        fill: none;
        stroke: rgba(0, 0, 0, 0.35);
        stroke-width: 0.75;
        pointer-events: none;
    }
    .cloud-svg .cloud-ring
    {
        fill: none;
        stroke: rgba(0, 0, 0, 0.4);
        stroke-width: 2;
        pointer-events: none;
    }

    /*  Arc, first pass paints a dark outline for legibility on
        light basemaps; second pass paints the configured sun
        colour on top. Stroke widths are set inline per segment. */
    .solar-svg .solar-arc-outline { stroke: rgba(0, 0, 0, 0.35); stroke-linecap: round; }
    .solar-svg .solar-arc-segment { stroke-linecap: round; }

    /*  Sunrise / sunset markers used to live here as ha-icon
        glyphs anchored to the arc's horizon crossings. Removed:
        the arc shape itself reads as "sunrise / sunset".          */


    /*  Below-horizon segments, round dots at fixed spacing so the
        eye reads "this is happening underground" without colour or
        depth scaling having to carry the signal. dasharray "0 N"
        with linecap round renders true circles on every browser.
        Stroke alpha is halved relative to the above-horizon arc
        so the dotted leg recedes visually: the user reads the
        bright arc as "the part of the day where there's sunlight"
        and the dotted leg as ambient context underneath.            */
    .solar-svg .solar-arc-night
    {
        stroke-linecap: round;
        stroke-dasharray: 0 8;
        stroke-opacity: 0.45;
    }
    .solar-svg .solar-arc-night.solar-arc-outline
    {
        stroke-opacity: 0.25;
    }

    /*  Incidence ray, dashes flow from the sun toward the home at
        a speed proportional to live irradiance. */
    .solar-svg .solar-ray
    {
        stroke-width: 1.5;
        stroke-dasharray: 5 5;
        stroke-opacity: 0.55;
        stroke-linecap: round;
        animation: solar-ray-flow var(--sun-flow-duration, 30s) linear infinite;
    }

    @keyframes solar-ray-flow
    {
        from { stroke-dashoffset: 0;  }
        to   { stroke-dashoffset: -10; }
    }

    /*  Solar ray arrow, tiny triangle riding the incidence ray
        toward the home, animated via SVG <animateMotion> at the
        same duration as the dash flow so the arrow advances in
        lockstep with the pointillé. rotate="auto" keeps the tip
        pointing forward along the path (sun → home). */
    .solar-svg .solar-ray-arrow
    {
        opacity: 0.85;
    }


    /*  Solar irradiance label, chip pinned above the live sun
        position, same chip language as the cloud and PV chips.
        Sits in the front layer (z 7) so it stacks on top of every
        home-anchored chip, matching the front-pass solar overlay. */
    .solar-pct-label
    {
        position: absolute;
        transform: translate(-50%, -100%);
        pointer-events: none;
        z-index: 7;
        display: inline-flex;
        align-items: center;
        gap: 3px;
        background: #ffffff;
        color:      #000000;
        border:     1px solid #000000;
        border-radius: 3px;
        padding: 2px 6px 2px 4px;
        font-size:    12px;
        font-weight:  600;
        line-height:  1.2;
        font-variant-numeric: tabular-nums;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        white-space: nowrap;
    }

    .solar-pct-label ha-icon
    {
        --mdc-icon-size: 12px;
        color: #000000;
        display: inline-flex;
        align-items: center;
    }


    /*  ============================================================
        Dark theme, opt-in via the \`card-theme: dark\` config.

        The whole card is already painted on top of a 3D map, so
        "dark mode" here is really about the chrome (chips, charts,
        cursors, day labels, leader lines, tooltips), the basemap
        keeps its own colours. Strategy:

          - chip surfaces flip from a solid white plate to a solid
            near-black plate, so the chip itself reads as a clean
            darkened tile over the map instead of a
            bright sticker.
          - chip text / borders / icons go from black to a soft
            light-grey (#e6e6e6 text, #cccccc borders), pure white
            would clip detail against bright basemap patches.
          - chart hairlines (midline, day separators, hour ticks,
            live cursor) flip from black-on-white to white-on-near-
            black with the same opacity envelopes as the light skin
            so the visual weight stays balanced.
          - chart fills (PV / cloud / irradiance) are user-coloured
            and unchanged, they read fine on both surfaces.
          - the scrub blue (#1f6feb) and the live tooltip dark
            plate already read on dark backgrounds, so they're left
            alone.
        ============================================================ */

    /*  Cards (chart panels) and hairlines on the chart. */
    ha-card.theme-dark .tb-chart-card
    {
        background: #191a1b;
        border-color: #4a4d55;
    }

    ha-card.theme-dark .hc-day-sep
    {
        stroke: rgba(255, 255, 255, 0.30);
    }

    ha-card.theme-dark .hc-chart-mid
    {
        stroke: #cccccc;
    }

    ha-card.theme-dark .hc-hour-tick
    {
        stroke: rgba(255, 255, 255, 0.35);
    }

    ha-card.theme-dark .tb-cursor-now
    {
        background: rgba(255, 255, 255, 0.75);
    }

    ha-card.theme-dark .tb-cursor-now::after
    {
        border-top-color: #ffffff;
    }

    /*  Chips that don't carry a user-configured colour: clock, day
        labels, live button, cloud %, solar W/m². These all share
        the "white plate, black ink" base recipe in light mode, so
        they get the same dark override. */
    ha-card.theme-dark .clock,
    ha-card.theme-dark .tl-live-btn,
    ha-card.theme-dark .tb-day-strip,
    ha-card.theme-dark .cloud-pct-label,
    ha-card.theme-dark .solar-pct-label,
    ha-card.theme-dark .map-btn:not(.map-btn-on),
    ha-card.theme-dark .lidar-view-chip:not(.is-on),
    ha-card.theme-dark .lidar-view-toggle-btn:not(.is-on),
    ha-card.theme-dark .mode-bar-seg:not(.is-on)
    {
        background: #191a1b;
        color:       #e6e6e6;
        /*  Light-mode borders are pure black on a white plate ,
            high contrast but visually contained because the plate
            and the basemap below it are both bright. In dark mode
            the same 1 px ring at #cccccc reads as the brightest
            ink on the card and dominates the chip. Drop the
            opacity so the border behaves as a delimiter rather
            than a focal element. Matches the chart-card and
            segmented-toggle borders elsewhere in dark mode. */
        border-color: rgba(255, 255, 255, 0.20);
    }

    /*  Day-strip dark-mode tweaks: text inside the cells switches
        to the same pale ink the rest of the dark chips use, and
        the vertical separators between days take the same border
        alpha as the chip frame so the strip reads as one cohesive
        component in either theme.                                 */
    ha-card.theme-dark .tb-day-strip
    {
        background: #1f2021;
    }
    ha-card.theme-dark .tb-day-strip-cell { color: #e6e6e6; }
    ha-card.theme-dark .tb-day-strip-sep
    {
        background-image: repeating-linear-gradient(
            to bottom,
            rgba(255, 255, 255, 0.30) 0,
            rgba(255, 255, 255, 0.30) 1.5px,
            transparent              1.5px,
            transparent              4px
        );
    }

    ha-card.theme-dark .tl-live-btn ha-icon,
    ha-card.theme-dark .cloud-pct-label ha-icon,
    ha-card.theme-dark .solar-pct-label ha-icon,
    ha-card.theme-dark .map-btn:not(.map-btn-on) ha-icon,
    ha-card.theme-dark .lidar-view-toggle-btn:not(.is-on) ha-icon,
    ha-card.theme-dark .mode-bar-seg:not(.is-on) ha-icon
    {
        color: #e6e6e6;
    }
    ha-card.theme-dark .mode-bar-seg:not(.is-on):not(.is-disabled):hover
    {
        background: #292a2b;
    }
    ha-card.theme-dark .mode-bar-seg:not(.is-on):not(.is-disabled):active
    {
        background: #353637;
    }
    ha-card.theme-dark .mode-bar-seg
    {
        border-color: rgba(255, 255, 255, 0.20);
    }
    ha-card.theme-dark .mode-bar-seg:last-child
    {
        border-bottom-color: rgba(255, 255, 255, 0.20);
    }

    ha-card.theme-dark .tl-live-btn:hover  { background: #292a2b; }
    ha-card.theme-dark .tl-live-btn:active { background: #353637; }
    ha-card.theme-dark .map-btn:not(.map-btn-on):hover  { background: #292a2b; }
    ha-card.theme-dark .map-btn:not(.map-btn-on):active { background: #353637; }

    /*  PV and battery chips, they keep the user-configured tint
        on the border / text / icon (so a green PV chip reads as
        green on either skin), but the surface flips to the dark
        plate so the tint stays readable. The border drops to 50 %
        opacity of the configured colour: at full saturation the
        ring would dominate the chip against a near-black plate
        and a darkened map, fighting the value just like the
        neutral-chip border above. The text and icon stay at full
        saturation so the colour identity is carried by the
        readable elements, not the frame. */
    ha-card.theme-dark .pv-pct-label
    {
        background: #191a1b;
        border-color: color-mix(in srgb, var(--pv-leader-color, #27B36B) 50%, transparent);
    }
    ha-card.theme-dark .battery-pct-label
    {
        background: #191a1b;
        border-color: color-mix(in srgb, var(--battery-leader-color, #D32F2F) 50%, transparent);
    }

    /*  Cloud-cover leader (chip → disc) flips polarity so it's
        visible against a dark plate and a darkened map. */
    ha-card.theme-dark .cloud-leader-svg line
    {
        stroke: #e6e6e6;
        stroke-opacity: 0.55;
    }

    /*  Solar arc outline, the light skin paints a black halo
        behind the configured sun colour for legibility on bright
        basemaps; in dark mode that halo would disappear into the
        map, so we paint a faint white halo instead. The arc and
        sun disc themselves keep their configured colour. */
    ha-card.theme-dark .solar-svg .solar-arc-outline
    {
        stroke: rgba(255, 255, 255, 0.45);
    }


    /*  ---------------------------------------------------------
        Animation perf hooks
        ---------------------------------------------------------

        1. .helios-paused, set on the host element by the card's
           IntersectionObserver when the card scrolls out of the
           viewport. Pauses every CSS animation (SVG dash-flow,
           offset-path arrow flow) until the card returns. SMIL
           <animateMotion> is paused in parallel via
           svg.pauseAnimations() in the card script.

        2. prefers-reduced-motion, respects the user's system
           setting. When the user has asked for reduced motion at
           the OS level, every helios animation and transition is
           disabled. The card still functions; it just doesn't move.
    */
    :host(.helios-paused) *,
    :host(.helios-paused) *::before,
    :host(.helios-paused) *::after
    {
        animation-play-state: paused !important;
    }

    @media (prefers-reduced-motion: reduce)
    {
        *, *::before, *::after
        {
            animation-duration:         0ms !important;
            animation-iteration-count:  1   !important;
            transition-duration:        0ms !important;
        }
    }
`;
