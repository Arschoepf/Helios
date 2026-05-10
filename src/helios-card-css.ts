import { css, unsafeCSS } from 'lit';
//MapLibre's stylesheet ships under dist/maplibre-gl.css. Vite's
//`?inline` query suffix returns the file content as a raw string
//instead of injecting a global <style> tag — we need the rules
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
        (title + subtitle) sits at the bottom — the MapTiler key
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

    /*  Sun halo pulses gently — same visual language as the live
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
            below the solar arc apex — feels less "crammed in the
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
        /*  Optical centre — letter-spacing piles up on the right of
            the last glyph so the visual centre of the wordmark
            sits a few pixels left of the geometric centre. The
            padding-left compensates so HELIOS reads centred. */
        padding-left: 10px;
    }


    /*  Timeline — pinned to the bottom of the card with uniform
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

    /*  Chart card — bordered white panel hosting the area chart,
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

    /*  Live cursor — solid black vertical line spanning the chart,
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

    /*  Scrub cursor — same anatomy, dashed and tinted blue so live
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

    /*  Scrub-time chip — sits in the top row above the chart card,
        tinted in the scrub-cursor blue so the displayed instant is
        visibly not "now". */
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

    /*  Day labels — small white chips overlaying the chart midline.
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


    /*  Spinner — centred on the map while a fetch is in flight. */

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

    .overlay-top-right,
    .overlay-top-left
    {
        position: absolute;
        top: 14px;
        z-index: 5;
        display: flex;
        align-items: center;
    }

    .overlay-top-right { right: 14px; }
    .overlay-top-left  { left:  14px; }

    /*  Date/time chip — same chip language as the on-map readouts. */
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
    }

    .clock-date { opacity: 0.75; }
    .clock-time { opacity: 1;    }

    /*  "Back to live" button — same chip as the clock, clickable.
        position:relative so the tooltip pseudo-element anchors to
        the button itself. */
    .tl-live-btn
    {
        position: relative;
        pointer-events: auto;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: #ffffff;
        color:      #000000;
        border:     1px solid #000000;
        border-radius: 3px;
        padding: 2px 6px 2px 4px;
        font-family: var(--primary-font-family, 'Roboto', sans-serif);
        font-size:    12px;
        font-weight:  600;
        line-height:  1.2;
        font-variant-numeric: tabular-nums;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        white-space: nowrap;
        cursor: pointer;
        /*  Paint-only transition. Animating transform here would
            keep the button on a GPU compositing layer permanently
            and soften the tooltip text rendered as a child. */
        transition: background 0.15s;
    }

    .tl-live-btn ha-icon
    {
        --mdc-icon-size: 12px;
        color: #000000;
        display: inline-flex;
        align-items: center;
    }

    .tl-live-btn:hover  { background: #f3f3f3; }
    .tl-live-btn:active { background: #e8e8e8; }

    /*  Live-button tooltip — rendered as a real DOM element (not a
        pseudo-element) so its text gets sub-pixel anti-aliasing,
        matching the cloud-disc tooltip rendered the same way. */
    .tl-live-tooltip
    {
        position: absolute;
        left: calc(100% + 6px);
        top: 50%;
        transform: translateY(-50%);
        background: rgba(0, 0, 0, 0.78);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 6px;
        padding: 6px 10px;
        color: white;
        font-family: var(--primary-font-family, 'Roboto', sans-serif);
        font-size: 11px;
        font-weight: 400;
        line-height: 1.4;
        white-space: nowrap;
        text-transform: none;
        letter-spacing: normal;
        font-variant-numeric: tabular-nums;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55);
        pointer-events: none;
        z-index: 100;
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.1s ease, visibility 0.1s ease;
    }

    .tl-live-btn:hover .tl-live-tooltip,
    .tl-live-btn:focus .tl-live-tooltip
    {
        opacity: 1;
        visibility: visible;
    }


    /*  Cloud-cover percentage chip — floating above the cloud disc
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

    /*  Photovoltaic production chip — same frame as cloud/W/m² but
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

    /*  PV leader line — dashes flow from the home up to the chip
        at a speed proportional to live production. */
    .pv-leader-svg
    {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 5;
    }

    .pv-leader-line
    {
        stroke: var(--pv-leader-color, #27B36B);
        stroke-width: 1.5;
        stroke-opacity: 0.85;
        stroke-linecap: round;
        stroke-dasharray: 6 5;
        animation: pv-leader-flow var(--pv-flow-duration, 30s) linear infinite;
    }

    /*  Negative offset shifts dashes from line start (home) toward
        end (chip). Cycle length = sum of dasharray pattern. */
    @keyframes pv-leader-flow
    {
        from { stroke-dashoffset: 0;  }
        to   { stroke-dashoffset: -11; }
    }

    /*  PV leader arrow — small triangle riding the leader line via
        SVG <animateMotion>. Same fill as the line; the rotate="auto"
        on animateMotion keeps the tip pointing in the direction of
        travel (home → chip). */
    .pv-leader-arrow
    {
        opacity: 0.9;
    }

    /*  Battery chips (SoC on the left of PV, Power on the right) —
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
          for SoC ↔ PV — the SoC value has no sign so there's no
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

    /*  Cloud-cover leader line — black hairline from chip to disc. */
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


    /*  Solar overlay — sun arc, current sun disc, incidence ray.
        Single SVG layer spanning the card; opacity fades to 0 at
        night via inline style from the engine. */
    .solar-svg
    {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 4;
        transition: opacity 600ms ease-out;
    }

    /*  Arc — first pass paints a dark outline for legibility on
        light basemaps; second pass paints the configured sun
        colour on top. Stroke widths are set inline per segment. */
    .solar-svg .solar-arc-outline { stroke: rgba(0, 0, 0, 0.35); stroke-linecap: round; }
    .solar-svg .solar-arc-segment { stroke-linecap: round; }

    /*  Below-horizon segments — round dots at fixed spacing so the
        eye reads "this is happening underground" without colour or
        depth scaling having to carry the signal. dasharray "0 N"
        with linecap round renders true circles on every browser. */
    .solar-svg .solar-arc-night
    {
        stroke-linecap: round;
        stroke-dasharray: 0 8;
    }

    /*  Incidence ray — dashes flow from the sun toward the home at
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

    /*  Solar ray arrow — tiny triangle riding the incidence ray
        toward the home, animated via SVG <animateMotion> at the
        same duration as the dash flow so the arrow advances in
        lockstep with the pointillé. rotate="auto" keeps the tip
        pointing forward along the path (sun → home). */
    .solar-svg .solar-ray-arrow
    {
        opacity: 0.85;
    }


    /*  Sky activity — soft cloud-tinted wisps drifting horizontally
        over the on-ground disc. Pure-CSS atmospheric texture; pointer-
        transparent and behind the chips. The whole layer's opacity
        is modulated by --sky-intensity (= live cloud cover / 100), so
        the effect crescendos with the cloudiness without ever
        distracting from the data layers. */
    .sky-activity
    {
        position: absolute;
        width: 220px;
        height: 220px;
        transform: translate(-50%, -50%);
        pointer-events: none;
        z-index: 3;
        opacity: var(--sky-intensity, 0);
        transition: opacity 1.2s ease;
        overflow: hidden;
    }

    .sky-wisp
    {
        position: absolute;
        width: 56px;
        height: 14px;
        border-radius: 50%;
        background: var(--sky-cloud-color, #5A8DC4);
        opacity: 0;
        filter: blur(6px);
        will-change: transform, opacity;
    }

    /*  Five wisps with staggered phases and slightly different
        speeds — even at full opacity the eye reads it as gentle
        weather drift rather than a synchronised animation. The
        negative animation-delay starts each puff mid-cycle so the
        layer is populated immediately on render instead of waiting
        the full duration for the first puff to enter. */
    .sky-wisp-1 { top: 28%; animation: sky-drift 22s linear infinite     0s; }
    .sky-wisp-2 { top: 46%; animation: sky-drift 28s linear infinite   -10s; }
    .sky-wisp-3 { top: 62%; animation: sky-drift 18s linear infinite    -4s; }
    .sky-wisp-4 { top: 38%; animation: sky-drift 32s linear infinite   -18s; }
    .sky-wisp-5 { top: 70%; animation: sky-drift 25s linear infinite   -14s; }

    @keyframes sky-drift
    {
        0%   { transform: translateX(-60px) scaleX(0.9); opacity: 0;    }
        15%  { opacity: 0.45; }
        85%  { opacity: 0.45; }
        100% { transform: translateX(280px) scaleX(1.1); opacity: 0;    }
    }


    /*  Cloud-cover disc tooltip — floats above the on-ground disc
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

    /*  Flipped variant — applied when the cursor is in the right
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


    /*  Solar irradiance label — chip pinned above the live sun
        position, same chip language as the cloud and PV chips. */
    .solar-pct-label
    {
        position: absolute;
        transform: translate(-50%, -100%);
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
        Dark theme — opt-in via the \`card-theme: dark\` config.

        The whole card is already painted on top of a 3D map, so
        "dark mode" here is really about the chrome (chips, charts,
        cursors, day labels, leader lines, tooltips) — the basemap
        keeps its own colours. Strategy:

          - chip surfaces flip from a solid white plate to a solid
            near-black plate, so the chip itself reads as a clean
            darkened tile over the map instead of a
            bright sticker.
          - chip text / borders / icons go from black to a soft
            light-grey (#e6e6e6 text, #cccccc borders) — pure white
            would clip detail against bright basemap patches.
          - chart hairlines (midline, day separators, hour ticks,
            live cursor) flip from black-on-white to white-on-near-
            black with the same opacity envelopes as the light skin
            so the visual weight stays balanced.
          - chart fills (PV / cloud / irradiance) are user-coloured
            and unchanged — they read fine on both surfaces.
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
    ha-card.theme-dark .solar-pct-label
    {
        background: #191a1b;
        color:       #e6e6e6;
        border-color: #cccccc;
    }

    ha-card.theme-dark .tb-day-label
    {
        background: #1f2021;
    }

    ha-card.theme-dark .tl-live-btn ha-icon,
    ha-card.theme-dark .cloud-pct-label ha-icon,
    ha-card.theme-dark .solar-pct-label ha-icon
    {
        color: #e6e6e6;
    }

    ha-card.theme-dark .tl-live-btn:hover  { background: #292a2b; }
    ha-card.theme-dark .tl-live-btn:active { background: #353637; }

    /*  PV and battery chips — they keep the user-configured tint
        on the border / text / icon (so a green PV chip reads as
        green on either skin), but the surface flips to the dark
        plate so the tint stays readable. */
    ha-card.theme-dark .pv-pct-label,
    ha-card.theme-dark .battery-pct-label
    {
        background: #191a1b;
    }

    /*  Cloud-cover leader (chip → disc) flips polarity so it's
        visible against a dark plate and a darkened map. */
    ha-card.theme-dark .cloud-leader-svg line
    {
        stroke: #e6e6e6;
        stroke-opacity: 0.55;
    }

    /*  Solar arc outline — the light skin paints a black halo
        behind the configured sun colour for legibility on bright
        basemaps; in dark mode that halo would disappear into the
        map, so we paint a faint white halo instead. The arc and
        sun disc themselves keep their configured colour. */
    ha-card.theme-dark .solar-svg .solar-arc-outline
    {
        stroke: rgba(255, 255, 255, 0.45);
    }
`;
