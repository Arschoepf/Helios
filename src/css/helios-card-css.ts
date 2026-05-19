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
        width: 100%;
        height: 100%;
        position: relative;
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
    .solar-horizon-icon,
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
    ha-card.detail-active .solar-horizon-icon,
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
        to { opacity: 1; transform: translateY(0); }
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
    /*  Same instant-appearing tooltip pattern as .dash-stat-delta,
        explains where the refined value comes from when the user
        hovers the chip.                                          */
    .dash-stat-refined::after
    {
        content: attr(data-tooltip);
        position: absolute;
        bottom: calc(100% + 6px);
        right: 0;
        background: rgba(0, 0, 0, 0.85);
        color: #ffffff;
        padding: 6px 10px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 500;
        letter-spacing: 0.1px;
        white-space: normal;
        max-width: 240px;
        width: max-content;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease-out 0.05s;
        z-index: 10;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.30);
    }
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
    .dash-today-chart-twilight
    {
        stroke-width: 1;
        stroke-dasharray: 0 3;
        stroke-linecap: round;
        vector-effect: non-scaling-stroke;
        opacity: 0.55;
        pointer-events: none;
    }
    .dash-today-chart-twilight-icon
    {
        position: absolute;
        /*  Anchored to the top of the chart so the icons read as
            flags capping their dotted lines, rather than buried in
            the bottom axis-label gutter. Sits in the top padding
            zone (PAD_T = 12 viewBox units) so it never overlaps
            the curves' data area.                                */
        top: 4px;
        transform: translateX(-50%);
        --mdc-icon-size: 18px;
        opacity: 0.95;
        pointer-events: none;
        z-index: 2;
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
        bottom: 8px;
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
        height: 64px;
        overflow: hidden;
    }

    .hc-chart-svg
    {
        display: block;
        width: 100%;
        height: 100%;
    }

    /*  Stroke-only outline on top of the filled area so peaks read
        cleanly even where the gradient fades towards the midline. */
    .hc-chart-line
    {
        fill: none;
        stroke-width: 1.4;
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

    /*  Live cursor: thin discreet line spanning the full chart with
        a small triangle handle at the top. Stays subtle on purpose,
        the user is in live mode, the cursor is a passive "where now
        is on the timeline" reference, not a focus target. */
    .tb-cursor-now
    {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 1px;
        background: rgba(0, 0, 0, 0.45);
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
        border-left:   3px solid transparent;
        border-right:  3px solid transparent;
        border-top:    4px solid rgba(0, 0, 0, 0.55);
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

    /*  Day labels, small white chips overlaying the chart midline.
        Same chip language as the on-map cloud and W/m² readouts. */
    .tb-day-labels
    {
        position: absolute;
        inset: 0;
        pointer-events: none;
    }

    .tb-day-label
    {
        position: absolute;
        top: 50%;
        transform: translate(-50%, -50%);
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: #ffffff;
        color:      #000000;
        border:     1px solid #000000;
        border-radius: 3px;
        padding: 1px 5px;
        font-size:    9px;
        font-weight:  600;
        line-height:  1.2;
        letter-spacing: 0.2px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
        z-index: 2;
    }

    .tb-day-label-today
    {
        font-weight: 800;
    }

    /*  Daily kWh total appended next to the date. Lighter weight +
        smaller separator dot so the date stays the primary read.
        Forecast variant (today's remainder + future days) is
        italicised so the user can tell observation from estimate
        at a glance, same convention the PV chip uses for predicted
        values. */
    .tb-day-label-kwh
    {
        font-weight: 500;
        opacity: 0.75;
    }
    .tb-day-label-kwh::before
    {
        content: "·";
        margin-right: 4px;
        opacity: 0.5;
    }
    .tb-day-label-kwh.is-forecast
    {
        font-style: italic;
    }

    /*  Optional PV graph card stacked above the main chart. Half
        the main height so the irradiance and PV areas balance. */
    .tb-pv-card
    {
        height: 32px;
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
    .lidar-view-btn
    {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        /*  Sized to mirror the .clock chip on the opposite rail
            (~80 px wide with the default "mm-dd HH:MM" content, at
            12 px / weight 600). justify-content: center balances the
            icon + label inside that fixed width so the toggle reads
            as a symmetric counterweight to the date chip.            */
        min-width: 80px;
        height: 22px;
        box-sizing: border-box;
        padding: 0 8px;
        background: #ffffff;
        color:      #000000;
        border:     1px solid #000000;
        border-radius: 3px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        line-height: 1;
        cursor: pointer;
        /*  Force full opacity at every state except :disabled (which
            sets its own 0.35 for the visual "not available" hint).
            The transition only covers background + color so a state
            change (active / inactive) doesn't briefly pass through a
            translucent state. */
        opacity: 1;
        transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
        /*  The parent .overlay-top-right rail has pointer-events: none
            (so the rail itself never steals map interactions when
            empty). The button has to opt back in explicitly so its
            click reaches the @click handler, mirroring what
            .clock / .live-return-btn do on the opposite (top-left)
            rail. Without this the button visually renders enabled but
            ignores every click.

            z-index: 50 puts the button above the LiDAR View canvas
            overlay (z 30) so the toggle stays clickable while the
            View is open, otherwise the canvas would swallow the
            click that exits the mode. */
        pointer-events: auto;
        position: relative;
        z-index: 50;
    }
    /*  Roboto cap glyphs at small sizes inside line-height: 1 sit
        slightly low in the em-box once the descender slack is gone,
        so flex-centering still leaves the visual centre of "LIDAR"
        a hair below the chip's geometric centre against a 14 px icon
        glyph. translateY(-1px) on the label nudges it back up into
        true centre. The icon itself stays at the geometric centre,
        ha-icon is a square box without ascender/descender asymmetry. */
    .lidar-view-btn-label
    {
        display: inline-block;
        line-height: 1;
        transform: translateY(-1px);
    }
    .lidar-view-btn ha-icon
    {
        --mdc-icon-size: 14px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
    }
    .lidar-view-btn:disabled
    {
        opacity: 0.35;
        cursor: not-allowed;
    }
    .lidar-view-btn.is-on
    {
        background: #1f6feb;
        color: #ffffff;
        border-color: #1f6feb;
    }


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
    ha-card.lidar-view-active .solar-horizon-icon,
    ha-card.lidar-view-active .cloud-svg,
    ha-card.lidar-view-active .cloud-leader-svg,
    ha-card.lidar-view-active .cloud-pct-label,
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


    /*  Top corner overlays. Date/time chip on the left; back-to-live
        + LiDAR busy chip column on the right. Both rails sit 8 px
        from the card edge so they read as a paired pair anchored
        to the frame, mirroring the timeline's edge margin. */

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

    /*  Top-right overlay rail. Hosts the LiDAR View toggle button.
        Mirrors the clock's top spacing on the opposite edge so the
        two overlays sit at the same height.

        z-index: 60 puts the rail (and therefore the button) above
        the LiDAR View canvas (z 30) AND above the centre spinner
        (z 50), so the toggle is always reachable. Pointer events
        off on the rail itself so the empty rail never steals map
        interactions; the button opts back in (.lidar-view-btn has
        its own pointer-events: auto). Stacking contexts: because
        we set z-index on this absolute container, children's own
        z-index values are scoped to this rail; the rail's z-index
        is the one that competes with siblings in ha-card. */
    .overlay-top-right
    {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 60;
        display: flex;
        flex-direction: column;
        gap: 6px;
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

    /*  Sunrise / sunset markers. ha-icon glyphs (mdi:weather-sunset-up
        / -down) centred on the horizon crossings of the day's solar
        arc, coloured in the configured sun colour via inline style.
        The icon shape itself communicates "rising" vs "setting" so
        no label or rotation is needed. */
    .solar-horizon-icon
    {
        position: absolute;
        transform: translate(-50%, -50%);
        --mdc-icon-size: 18px;
        pointer-events: none;
        z-index: 6;
        filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.45));
    }


    /*  Below-horizon segments, round dots at fixed spacing so the
        eye reads "this is happening underground" without colour or
        depth scaling having to carry the signal. dasharray "0 N"
        with linecap round renders true circles on every browser. */
    .solar-svg .solar-arc-night
    {
        stroke-linecap: round;
        stroke-dasharray: 0 8;
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
        background: rgba(255, 255, 255, 0.55);
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
    ha-card.theme-dark .tb-day-label,
    ha-card.theme-dark .cloud-pct-label,
    ha-card.theme-dark .solar-pct-label,
    ha-card.theme-dark .map-btn:not(.map-btn-on),
    ha-card.theme-dark .lidar-view-btn:not(.is-on)
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

    ha-card.theme-dark .tb-day-label
    {
        background: #1f2021;
    }

    ha-card.theme-dark .tl-live-btn ha-icon,
    ha-card.theme-dark .cloud-pct-label ha-icon,
    ha-card.theme-dark .solar-pct-label ha-icon,
    ha-card.theme-dark .map-btn:not(.map-btn-on) ha-icon,
    ha-card.theme-dark .lidar-view-btn:not(.is-on) ha-icon
    {
        color: #e6e6e6;
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
