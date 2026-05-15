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
//(layout → placeholder → timeline → overlays → solar arc → tooltips).
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
        min-height: 200px;
        /*  New stacking context so absolute children with z-index
            stay scoped to the card instead of escaping above HA's
            dashboard chrome on scroll. */
        isolation: isolate;
    }

    ha-card.placeholder-mode
    {
        height:     100%;
        min-height: 200px;
    }

    #map-container
    {
        width: 100%;
        height: 100%;
        position: relative;
    }

    #map-container.hidden
    {
        display: none;
    }


    /*  Placeholder shown until the user enters a MapTiler key.
        Mini-Helios vignette: a stylised iso scene matching the real
        card's vocabulary (sun arc, sun + halo, low-poly buildings
        with a brighter central home, ground cloud disc, leader
        chips) over a light day-mode sky gradient. The brand chrome
        (title + subtitle) sits at the bottom, the MapTiler key
        prompt lives in the README, not on the catalogue thumbnail. */

    .placeholder
    {
        position: absolute;
        inset: 0;
        overflow: hidden;
        z-index: 20;
        isolation: isolate;
        background:
            radial-gradient(1000px 600px at 65% 28%,
                rgba(255,210,150,0.30) 0%,
                rgba(255,210,150,0)    55%),
            linear-gradient(180deg,
                #dbe3ec 0%,
                #e6e0d4 55%,
                #d3ccbf 100%);
    }

    .ph-scene
    {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 1;
    }

    /*  Sun halo pulses gently, same visual language as the live
        card's breathing sun. Only the glow circle scales; the
        inner orange disc stays fixed so the brand colour reads
        cleanly at the centre. */
    .ph-sun-glow
    {
        transform-origin: center;
        transform-box: fill-box;
        animation: ph-sun-pulse 4s ease-in-out infinite;
    }

    @keyframes ph-sun-pulse
    {
        0%, 100% { transform: scale(1);    opacity: 1;   }
        50%      { transform: scale(1.15); opacity: 0.9; }
    }

    .ph-content
    {
        position: absolute;
        /*  Title centred horizontally, vertically anchored at 65 %
            from the BOTTOM of the placeholder (so 35 % from the
            top). Sits just above the iso buildings and visually
            below the solar arc apex, feels less "crammed in the
            middle" than a strict 50 % vertical centre. */
        top: 35%;
        left: 50%;
        transform: translate(-50%, -50%);
        text-align: center;
        z-index: 10;
        padding: 6px 18px;
        box-sizing: border-box;
    }

    .ph-title
    {
        font-size: 1.85rem;
        font-weight: 200;
        letter-spacing: 10px;
        text-transform: uppercase;
        color: #2a2e34;
        text-shadow: 0 1px 1px rgba(255,255,255,0.6);
        line-height: 1;
        white-space: nowrap;
        /*  Optical centre, letter-spacing piles up on the right of
            the last glyph so the visual centre of the wordmark
            sits a few pixels left of the geometric centre. The
            padding-left compensates so HELIOS reads centred. */
        padding-left: 10px;
    }


    /*  Timeline, pinned to the bottom of the card with uniform
        breathing space. The whole bar accepts pointer events for
        scrub. */

    .time-bar
    {
        position: absolute;
        bottom: 8px;
        left:   8px;
        right:  8px;
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

    /*  Reserves vertical space for the scrub-time chip so the chart
        card doesn't jump up/down when scrubbing toggles. */
    .tb-top-row
    {
        position: relative;
        height: 18px;
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
        past "now" using the auto-calibrated scalar fit from history.
        Dashed + half opacity makes it visually distinct from the
        recorded curve while staying in the configured PV colour so
        it reads as "the same quantity, projected". */
    .hc-chart-predicted
    {
        stroke-dasharray: 4 3;
        opacity: 0.55;
    }

    /*  Daily peak-production highlight, for each natural day in the
        timeline, a 1-hour-wide vertical band painted in the configured
        PV colour at low opacity marks the hour where production is
        (or is predicted to be) highest. Drawn behind the chart area
        so the curves remain legible on top. */
    .hc-pv-peak
    {
        opacity: 0.18;
        pointer-events: none;
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

    /*  Live cursor, solid black vertical line spanning the chart,
        with a triangle marker pointing down from the top edge. */
    .tb-cursor-now
    {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 1px;
        background: rgba(0, 0, 0, 0.55);
        transform: translateX(-50%);
        pointer-events: none;
        z-index: 4;
    }

    .tb-cursor-now::after
    {
        content: '';
        position: absolute;
        top: 0;
        left: 50%;
        transform: translateX(-50%);
        width: 0;
        height: 0;
        border-left:   4px solid transparent;
        border-right:  4px solid transparent;
        border-top:    5px solid #000000;
    }

    /*  Scrub cursor, same anatomy, dashed and tinted blue so live
        and scrubbed positions are unmistakable side by side. */
    .tb-cursor-sel
    {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 1px;
        background:
            repeating-linear-gradient(
                to bottom,
                rgba(31, 111, 235, 0.75) 0,
                rgba(31, 111, 235, 0.75) 3px,
                transparent              3px,
                transparent              6px
            );
        transform: translateX(-50%);
        pointer-events: none;
        z-index: 4;
    }

    .tb-cursor-sel::after
    {
        content: '';
        position: absolute;
        top: 0;
        left: 50%;
        transform: translateX(-50%);
        width: 0;
        height: 0;
        border-left:   4px solid transparent;
        border-right:  4px solid transparent;
        border-top:    5px solid #1f6feb;
    }

    /*  Scrub-time pill, sits in the top row above the chart card
        when the user has scrubbed away from "now". Tinted in the
        scrub-cursor blue so the displayed instant is visibly not
        "now". Anchored at the cursor's X via an inline left
        percentage, with edge-clamping handled by the inline
        transform so the pill never bleeds past the card edges.
        Pointer-transparent so dragging the timeline through it
        still scrubs, the "back to live" affordance lives in the
        clock tab above the card, not next to the pill, to keep the
        timeline's hit area uncontested on mobile. */
    .tb-sel-label
    {
        position: absolute;
        bottom: 0;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.3px;
        color: white;
        background: rgba(31, 111, 235, 0.95);
        padding: 3px 8px;
        border-radius: 3px;
        white-space: nowrap;
        pointer-events: none;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
        font-variant-numeric: tabular-nums;
        z-index: 3;
    }

    /*  Scrub tether, a 6 px vertical hair that drops from the
        bottom edge of the scrub cluster to the top edge of the
        chart card, anchored at the cursor's X. Carries the
        scrub-cursor blue so it reads as continuous with the cursor's
        downward triangle inside the chart. The tether is rendered
        as a sibling of the cluster (not a child) and uses the same
        left-percentage anchor without the cluster's edge-clamping
        transform, so it always lands directly above the cursor even
        when the cluster shifts to avoid clipping. */
    .tb-sel-tether
    {
        position: absolute;
        bottom: -6px;
        height: 6px;
        width: 1px;
        background: rgba(31, 111, 235, 0.95);
        transform: translateX(-50%);
        pointer-events: none;
        z-index: 3;
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
        width: 44px;
        height: 44px;
        opacity: 0;
        transition: opacity 0.15s ease;
        pointer-events: none;
    }

    .spinner-center.spinning
    {
        opacity: 1;
    }

    .spinner
    {
        width: 100%;
        height: 100%;
        border: 3px solid rgba(255,255,255,0.20);
        border-top-color: #ffffff;
        border-radius: 50%;
        animation: helios-spin 0.75s linear infinite;
        box-shadow: 0 0 20px rgba(0,0,0,0.5);
    }

    @keyframes helios-spin
    {
        to { transform: rotate(360deg); }
    }


    /*  Top corner overlays. Date/time chip on the right; "back to
        live" chip on the left when scrubbed. */

    /*  Top-row overlay, the clock centres horizontally above the
        card, with an optional "back to live" tab hanging from its
        bottom-centre when the user has scrubbed away from now. The
        wrapper is a vertical flex column so the tab stacks under
        the clock automatically; both elements share the same X
        anchor (the column's centre = the card's centre). */
    .overlay-top-center
    {
        position: absolute;
        /*  Matches the timeline's bottom: 8px so the clock and the
            timeline sit at symmetric distance from the card edges. */
        top: 8px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 5;
        display: flex;
        flex-direction: column;
        align-items: center;
    }

    /*  Date/time chip, same chip language as the on-map readouts. */
    .clock
    {
        display: inline-flex;
        align-items: center;
        gap: 6px;
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

    /*  "Back to live" button, top-right rail. Same blue plate as the
        on-chart scrub cursor and the scrub-time pill, white restore
        icon centred. 28 × 28 px square chip matching the LiDAR busy
        chip's footprint so the two stack into a clean vertical column
        when both are visible. Mobile-friendly tap target, pointer
        events on so the button stays clickable even though its parent
        rail has events off. */
    .live-return-btn
    {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width:  28px;
        height: 28px;
        padding: 0;
        background: rgba(31, 111, 235, 0.95);
        color: white;
        border: 1px solid rgba(20, 78, 168, 0.95);
        border-radius: 3px;
        cursor: pointer;
        pointer-events: auto;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        transition: background 0.12s;
    }

    .live-return-btn:hover  { background: rgba(24, 92, 199, 0.95); }
    .live-return-btn:active { background: rgba(20, 78, 168, 0.95); }

    .live-return-btn ha-icon
    {
        --mdc-icon-size: 18px;
        color: white;
        display: inline-flex;
        align-items: center;
    }

    /*  Top-right overlay rail. Hosts the LiDAR shadow busy chip so the
        user knows the shadows currently on screen are still computing.
        Mirrors the clock's top spacing on the opposite edge so the two
        overlays sit at the same height. Pointer events off so the chip
        never gets in the way of map interaction. */
    .overlay-top-right
    {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 5;
        display: flex;
        flex-direction: column;
        gap: 6px;
        pointer-events: none;
    }

    /*  Compass anchor, mirrors overlay-top-right on the opposite edge
        so the corner overlays sit at matching heights. */
    .overlay-top-left
    {
        position: absolute;
        top: 8px;
        left: 8px;
        z-index: 5;
        pointer-events: none;
    }

    /*  Compass needle, no bezel. The outer container sets up the 3D
        perspective + the same 55° pitch the MapLibre camera uses, so
        the needle reads as if it's resting on the tilted ground plane.
        The pitch value is hardcoded to match HeliosEngine's fixed
        pitch: if that ever becomes user-configurable, expose it via
        projectHomeLabelLayout and drive this transform from the layout. */
    .compass-needle
    {
        width:  44px;
        height: 44px;
        perspective: 200px;
        pointer-events: none;
    }

    /*  Spin layer, counter-rotates around the ground-plane normal by
        the negated map bearing so the red N half always points at
        true north. preserve-3d propagates the parent's perspective to
        the children, otherwise the rotateX would collapse back to 2D
        and the foreshortening cue would vanish. */
    .compass-needle-spin
    {
        width:  100%;
        height: 100%;
        position: relative;
        transform-style: preserve-3d;
        transition: transform 120ms linear;
    }

    /*  Tilt wrapper baked into both halves, applied via the shared
        transform on each triangle. We tilt INSIDE the spinning frame
        so the needle stays laid on the ground plane regardless of
        bearing, instead of being a static plane the needle paints on
        top of (which would look like a 2D arrow that yaws but never
        lays down). */
    .compass-needle-n,
    .compass-needle-s
    {
        position: absolute;
        left: 50%;
        width: 14px;
        margin-left: -7px;
        height: 22px;
        backface-visibility: hidden;
    }

    /*  Red half, points UP toward N. clip-path carves the triangle so
        we can paint a top-to-bottom gradient (a CSS border triangle
        would be a single colour). Two gradients stacked: a lateral
        light-to-dark sweep mimics a faceted needle catching light from
        the upper-left, the linear vertical gradient brightens the tip
        to suggest a sharp metal edge. The element is then laid back
        with rotateX(55deg) so it appears to rest on the basemap. */
    .compass-needle-n
    {
        top: 0;
        background:
            linear-gradient(95deg, rgba(255, 255, 255, 0.18) 0%, transparent 35%, rgba(0, 0, 0, 0.35) 100%),
            linear-gradient(to bottom, #ff5e5e 0%, #c91313 70%, #7a0a0a 100%);
        clip-path: polygon(50% 0%, 100% 100%, 0% 100%);
        transform: translateZ(0.5px) rotateX(55deg);
        transform-origin: 50% 100%;
        filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.55));
    }

    /*  Grey half, points DOWN toward S. Symmetric to the N half but
        flipped, with a muted gunmetal palette so the eye locks on the
        red side as the canonical direction marker. */
    .compass-needle-s
    {
        top: 22px;
        background:
            linear-gradient(95deg, rgba(255, 255, 255, 0.15) 0%, transparent 40%, rgba(0, 0, 0, 0.40) 100%),
            linear-gradient(to top, #4a4f57 0%, #2a2e34 70%, #18191c 100%);
        clip-path: polygon(50% 100%, 100% 0%, 0% 0%);
        transform: translateZ(0.5px) rotateX(55deg);
        transform-origin: 50% 0%;
        filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.55));
    }

    /*  Passive 28 px square chip used as a "LiDAR shadow computing"
        indicator. Same visual language as the date/time clock (white
        surface, 1 px black border) so it doesn't introduce a new style
        vocabulary; the only content is a small spinning ring. */
    .shadow-busy-chip
    {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width:  28px;
        height: 28px;
        background: #ffffff;
        border: 1px solid #000000;
        border-radius: 3px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    }

    /*  Rotating sun glyph used as the busy indicator. Matches the
        default Helios sun tone so the spinner reads as a Helios sun
        rather than a generic system loader. */
    .shadow-busy-sun
    {
        --mdc-icon-size: 18px;
        color: #EF9F27;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        animation: helios-shadow-spin 1.4s linear infinite;
    }

    ha-card.theme-dark .shadow-busy-chip
    {
        background: #14161c;
        border-color: rgba(255, 255, 255, 0.6);
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

    /*  Battery leaders.
        Both SoC ↔ PV and PV ↔ Power share the exact same visual
        vocabulary: dashed L-shaped path with a rounded fillet at
        the bend (so an arrow riding the path rotates smoothly
        through the corner instead of snapping).
        - .battery-leader-line carries the static styling (stroke
          colour, width, opacity, dash pattern). Used on its own
          for SoC ↔ PV, the SoC value has no sign so there's no
          flow direction to animate.
        - .battery-leader-line-animated layers the flow animation
          on top: the dashes drift at a speed proportional to |P|
          (via --battery-flow-duration), exactly like the PV
          leader's visual language. A small arrow polygon rides
          the path via SVG <animateMotion>; the
          .battery-leader-discharging class flips the dash flow
          direction (CSS animation-direction: reverse) so the
          dashes move from chip → PV when discharging, and the
          arrow path is flipped inline by the renderer so the
          two cues stay in sync. */
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
        stroke-dasharray: 6 5;
        fill: none;
    }

    .battery-leader-line-animated
    {
        animation: battery-leader-flow var(--battery-flow-duration, 30s) linear infinite;
    }

    .battery-leader-discharging
    {
        animation-direction: reverse;
    }

    @keyframes battery-leader-flow
    {
        from { stroke-dashoffset: 0;   }
        to   { stroke-dashoffset: -11; }
    }

    .battery-leader-arrow
    {
        opacity: 0.9;
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
    .cloud-svg .cloud-disc
    {
        pointer-events: auto;
        cursor: help;
    }
    .cloud-svg .cloud-disc-ring
    {
        fill: none;
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


    /*  Cloud-cover disc tooltip, floats above the on-ground disc
        on hover. Position set inline from the engine's onCloudHover
        event in canvas pixel coordinates. */
    .cloud-tooltip
    {
        position: absolute;
        transform: translate(12px, -50%);
        pointer-events: none;
        z-index: 50;
        background: rgba(0, 0, 0, 0.78);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 6px;
        padding: 6px 10px;
        color: white;
        font-size: 11px;
        line-height: 1.4;
        font-variant-numeric: tabular-nums;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55);
        white-space: nowrap;
    }

    /*  Flipped variant, applied when the cursor is in the right
        half of the card so the tooltip stays inside the bounds. */
    .cloud-tooltip-flip
    {
        transform: translate(calc(-100% - 12px), -50%);
    }

    .cloud-tooltip-head
    {
        font-weight: 700;
        margin-bottom: 4px;
    }

    .cloud-tooltip-row
    {
        opacity: 0.85;
        line-height: 1.45;
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
          - the placeholder vignette is left in light mode regardless
            of theme: it's a marketing thumbnail rendered when no
            API key is set, with a sunset gradient that doesn't have
            a meaningful dark equivalent.
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
    ha-card.theme-dark .map-btn:not(.map-btn-on)
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
    ha-card.theme-dark .map-btn:not(.map-btn-on) ha-icon
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
           offset-path arrow flow, placeholder spin / pulse) until
           the card returns. SMIL <animateMotion> is paused in
           parallel via svg.pauseAnimations() in the card script.

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
