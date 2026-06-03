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
        /*  Container query host so the fullscreen / kiosk breakpoint
            rules at the bottom of this stylesheet can react to the
            card's own width without depending on the viewport size,
            which would mis-fire when the user has several Helios
            cards side by side in a grid view. See issue #33. */
        container-type: inline-size;
        container-name: helios-card;
        /*  Card frame: pull the radius + border + shadow straight off
            the HA card design tokens so Helios matches whatever the
            user's frontend theme has set for every other dashboard
            card. Hard-coded fallbacks mirror the HA default theme:
            12 px radius, 1 px divider hairline, the standard 2-band
            elevation shadow.                                          */
        border-radius: var(--ha-card-border-radius, 12px);
        border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, rgba(0, 0, 0, 0.12)));
        box-shadow: var(--ha-card-box-shadow,
                        0 2px 1px -1px rgba(0, 0, 0, 0.2),
                        0 1px 1px 0 rgba(0, 0, 0, 0.14),
                        0 1px 3px 0 rgba(0, 0, 0, 0.12));
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
    /*  Home click target. Sized to comfortably overlap the 3D
        building silhouette on a typical residential footprint
        (40-50 m at home altitude after the projection), and z-index
        bumped above every chip + leader cluster so the click reliably
        lands on the home regardless of which decoration happens to
        sit under the pointer at that moment.                       */
    .home-hitbox
    {
        position: absolute;
        transform: translate(-50%, -50%);
        width:  120px;
        height: 120px;
        border-radius: 50%;
        background: transparent;
        cursor: pointer;
        pointer-events: auto;
        z-index: 55;
    }

    /*  Home hover glow. Same base + top + side-quad polygons as the
        cloud-dome mask (so it tracks rotation pixel-for-pixel with
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
        /*  The SVG itself stays click-transparent so empty pixels
            don't capture clicks meant for chips behind it; only the
            painted polygons (the home-glow-shape rule below) receive
            pointer events. cursor: pointer makes the silhouette
            read as interactive on hover. */
        pointer-events: none;
        cursor: pointer;
        /*  Sits ABOVE the basemap + buildings but BELOW the home chip
            cluster (z 8) so the hover glow + production pulse never
            cross over the PV / battery / grid / cloud / solar value
            chips. The chips always win on the shared pixels. */
        z-index: 6;
        /*  Resting opacity is a faint 0.25 so the home silhouette is
            always discoverable on the basemap (the user reported the
            home was lost in busy mixed buildings + map detail). Hover
            bumps to 0.85 for an unmistakable interactive cue. The
            drop-shadow stays modest at rest, ramps up on hover via a
            heavier filter rule.                                      */
        opacity: 0.25;
        transition: opacity 0.18s ease, filter 0.18s ease;
        filter: drop-shadow(0 0 4px var(--primary-color, #03a9f4));
    }
    .home-glow-svg.is-hovered
    {
        opacity: 0.85;
        filter: drop-shadow(0 0 8px var(--primary-color, #03a9f4));
    }

    /*  Production pulse: while PV is producing, the home silhouette
        pulses with the configured PV colour at the same cadence as
        the bead sliding down the leader, so the bead's arrival has
        a visible "landing" on the home itself rather than the
        previous floor-disc that expanded under the building. The
        pulse fires once per bead trip via the --pv-flow-duration
        the renderer sets inline. Filter swaps the sun-colour drop-
        shadow for the PV-colour one only during the pulse window
        so the resting glow keeps its hover identity. */
    .home-glow-svg.is-pv-pulsing
    {
        animation: home-glow-pv-pulse var(--pv-flow-duration, 2s) ease-in-out infinite;
    }
    @keyframes home-glow-pv-pulse
    {
        0%, 80% { opacity: 0; }
        92%
        {
            opacity: 0.85;
            filter: drop-shadow(0 0 10px var(--pv-leader-color, var(--energy-solar-color, var(--energy-solar-color, #ff9800))));
        }
        100%    { opacity: 0; }
    }
    .home-glow-svg.is-pv-pulsing .home-glow-shape
    {
        fill:   var(--pv-leader-color, var(--energy-solar-color, var(--energy-solar-color, #ff9800)));
        stroke: var(--pv-leader-color, var(--energy-solar-color, var(--energy-solar-color, #ff9800)));
    }

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
        /*  Translucent HA primary-color halo painted ONLY on hover
            (the parent SVG controls opacity); the home base identity
            colour lives on the 3D fill-extrusion in _addBuildings(). */
        fill: var(--primary-color, #03a9f4);
        fill-opacity: 0.08;
        stroke: var(--primary-color, #03a9f4);
        stroke-width: 1;
        stroke-linejoin: round;
        /*  Painted polygons capture clicks so the silhouette's actual
            shape becomes the hit zone, the 120 px circular hitbox
            below only catches the centre and was missing the corners
            of larger / zoomed-in buildings (the user reported clicks
            on visible parts of the home not registering). */
        pointer-events: visiblePainted;
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
.solar-svg,
    .solar-pct-label,
    .pv-home-anchor-svg,
    .pv-home-leader-svg,
    .pv-pct-label,
    .battery-leader-svg,
    .battery-pct-label,
    .home-hitbox,
    .home-glow-svg,
    .home-drop-leader-svg,
    .time-bar,
    .shadow-busy-chip
    {
        transition: opacity 0.35s ease;
    }
    ha-card.detail-active
ha-card.detail-active .solar-svg,
    ha-card.detail-active .solar-pct-label,
    ha-card.detail-active .pv-home-anchor-svg,
    ha-card.detail-active .pv-home-leader-svg,
    ha-card.detail-active .pv-pct-label,
    ha-card.detail-active .battery-leader-svg,
    ha-card.detail-active .battery-pct-label,
    ha-card.detail-active .home-hitbox,
    ha-card.detail-active .home-glow-svg,
    ha-card.detail-active .home-drop-leader-svg,
    ha-card.detail-active .time-bar,
    ha-card.detail-active .shadow-busy-chip
    {
        opacity: 0;
        pointer-events: none;
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
    /*  Base transition + composite-layer hint kept on the unprefixed
        selectors so the fade runs in BOTH directions across every
        browser. Declaring the transition only inside .lidar-view-
        active made entry smooth but the exit snap-back instantly
        because the selector no longer matched and the transition
        property left scope; declaring it here keeps it in scope at
        all times. The will-change: opacity hint promotes each element
        to its own composite layer so the GPU drives the alpha sweep
        instead of asking the painter to redo layout per frame,
        which used to drop frames on the chips that sit inside
        transform-less wrappers (time-bar, solar-svg).               */
    .overlay-top-left,
    .home-glow-svg,
    .home-hitbox,
    .home-silhouette-svg,
    .home-drop-leader-svg,
    .solar-svg,
    .solar-pct-label,
    .cloud-pct-label,
    .pv-home-anchor-svg,
    .pv-home-leader-svg,
    .pv-pct-label,
    .battery-leader-svg,
    .battery-pct-label,
    .grid-leader-svg,
    .grid-import-label,
    .grid-export-label,
    .home-pill
    {
        transition: opacity 0.35s ease;
    }
    /*  will-change opt-in: scope the composite-layer promotion to the
        transition windows only. At rest, 15+ elements declared
        will-change: opacity unconditionally was pinning that many
        GPU layers in idle VRAM (~15-30 MB on devices with limited
        budgets) and forcing the compositor to re-sync them on every
        Lit re-render. Promote only when a mode actually toggles. */
    ha-card.lidar-view-active     .overlay-top-left, ha-card.lidar-view-active     .home-glow-svg,
    ha-card.lidar-view-active     .home-hitbox,      ha-card.lidar-view-active     .home-silhouette-svg,
    ha-card.lidar-view-active     .home-drop-leader-svg, ha-card.lidar-view-active .solar-svg,
    ha-card.lidar-view-active     .solar-pct-label,  ha-card.lidar-view-active     .cloud-pct-label,
    ha-card.lidar-view-active     .pv-home-anchor-svg, ha-card.lidar-view-active   .pv-home-leader-svg,
    ha-card.lidar-view-active     .pv-pct-label,     ha-card.lidar-view-active     .battery-leader-svg,
    ha-card.lidar-view-active     .battery-pct-label,ha-card.lidar-view-active     .grid-leader-svg,
    ha-card.lidar-view-active     .grid-import-label,ha-card.lidar-view-active     .grid-export-label,
    ha-card.lidar-view-active     .home-pill,
    ha-card.shading-dome-active   .overlay-top-left, ha-card.shading-dome-active   .home-glow-svg,
    ha-card.shading-dome-active   .home-hitbox,      ha-card.shading-dome-active   .home-silhouette-svg,
    ha-card.shading-dome-active   .home-drop-leader-svg, ha-card.shading-dome-active .solar-svg,
    ha-card.shading-dome-active   .solar-pct-label,  ha-card.shading-dome-active   .cloud-pct-label,
    ha-card.shading-dome-active   .pv-home-anchor-svg, ha-card.shading-dome-active .pv-home-leader-svg,
    ha-card.shading-dome-active   .pv-pct-label,     ha-card.shading-dome-active   .battery-leader-svg,
    ha-card.shading-dome-active   .battery-pct-label,ha-card.shading-dome-active   .grid-leader-svg,
    ha-card.shading-dome-active   .grid-import-label,ha-card.shading-dome-active   .grid-export-label,
    ha-card.shading-dome-active   .home-pill,
    ha-card.detail-active         .overlay-top-left, ha-card.detail-active         .home-glow-svg,
    ha-card.detail-active         .home-hitbox,      ha-card.detail-active         .pv-home-anchor-svg,
    ha-card.detail-active         .pv-home-leader-svg, ha-card.detail-active       .pv-pct-label,
    ha-card.detail-active         .battery-leader-svg, ha-card.detail-active       .battery-pct-label,
    ha-card.detail-active         .solar-svg,        ha-card.detail-active         .solar-pct-label,
    ha-card.detail-active         .cloud-pct-label
    {
        will-change: opacity;
    }

    /*  Timeline SLIDES out below the card / slides back in from the
        bottom edge instead of fading. The X centring (translateX
        -50%) is kept inside every keyframe so the bar never drifts
        horizontally during the slide. */
    .time-bar
    {
        transition: transform 0.45s cubic-bezier(0.22, 0.61, 0.36, 1);
        will-change: transform;
    }
    ha-card.lidar-view-active .home-glow-svg,
    ha-card.lidar-view-active .home-hitbox,
    ha-card.lidar-view-active .home-silhouette-svg,
    ha-card.lidar-view-active .home-drop-leader-svg,
    ha-card.lidar-view-active .solar-svg,
    ha-card.lidar-view-active .solar-pct-label,
    ha-card.lidar-view-active .cloud-pct-label,
    ha-card.lidar-view-active .pv-home-anchor-svg,
    ha-card.lidar-view-active .pv-home-leader-svg,
    ha-card.lidar-view-active .pv-pct-label,
    ha-card.lidar-view-active .battery-leader-svg,
    ha-card.lidar-view-active .battery-pct-label,
    ha-card.lidar-view-active .grid-leader-svg,
    ha-card.lidar-view-active .grid-import-label,
    ha-card.lidar-view-active .grid-export-label,
    ha-card.lidar-view-active .home-pill
    {
        opacity: 0;
        pointer-events: none;
    }
    /*  Timeline slides out below the card edge. Pointer-events
        disabled so the drifting element cannot intercept clicks
        while off-screen. translateX kept so the bar stays centred. */
    ha-card.lidar-view-active .time-bar
    {
        transform: translateX(-50%) translateY(140%);
        pointer-events: none;
    }
    ha-card.lidar-view-active .overlay-top-left
    {
        opacity: 0;
        pointer-events: none;
    }
    ha-card.lidar-view-active .overlay-top-right
    {
        opacity: 1;
        pointer-events: auto;
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
        background: var(--card-background-color, #ffffff);
        border: 1px solid var(--divider-color, rgba(0, 0, 0, 0.12));
        border-radius: 50%;
        color: var(--primary-text-color, #212121);
        cursor: pointer;
        z-index: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 1px 3px var(--shadow-color);
        transition: transform 0.12s;
    }
    .detail-close-btn:hover  { transform: scale(1.05); }
    .detail-close-btn:active { transform: scale(0.95); }
    .detail-close-btn ha-icon { --mdc-icon-size: 16px; color: inherit; }
    ha-card.theme-dark .detail-close-btn
    {
        background:   var(--card-background-color, #191a1b);
        color:        var(--primary-text-color, #e6e6e6);
        border-color: var(--divider-color, rgba(255, 255, 255, 0.20));
    }

    .detail-panel-inner
    {
        flex: 1;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        overflow-y: auto;
        overflow-x: hidden;
    }

    /*  Each dashboard section is rendered with the HA card frame:
        same background, border colour, border radius and box-shadow
        tokens that drive the cards on the native HA Energy dashboard.
        Padding mirrors the HA Energy tooltip / card padding so the
        panel reads as a stack of native HA cards. */
    .dash-card
    {
        background: var(--ha-card-background, var(--card-background-color, #ffffff));
        color: var(--primary-text-color, #212121);
        border: 1px solid var(--ha-card-border-color, var(--divider-color, rgba(0, 0, 0, 0.08)));
        border-radius: var(--ha-card-border-radius, 12px);
        box-shadow: var(--ha-card-box-shadow, 0 2px 4px 0 rgba(0, 0, 0, 0.16), 0 1px 4px 0 rgba(0, 0, 0, 0.06));
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 8px;
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
        background:   var(--card-background-color, #191a1b);
        color:        var(--primary-text-color, #e6e6e6);
        border-color: var(--divider-color, rgba(255, 255, 255, 0.20));
    }

    .dash-card-header
    {
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .dash-card-icon
    {
        --mdc-icon-size: 22px;
        flex-shrink: 0;
        width: 32px;
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.08);
    }
    /*  Per-section icon tint, aligned on the HA Energy palette so
        the dashboard reads as the same family as HA's Energy
        distribution card. Today / Tomorrow ride the solar amber,
        the Battery section uses the discharge teal.                 */
    .dash-card.dash-today    .dash-card-icon { color: var(--energy-solar-color, var(--energy-solar-color, #ff9800));        background: rgba(255, 152, 0, 0.12);  }
    .dash-card.dash-tomorrow .dash-card-icon { color: var(--amber-color, var(--warning-color, #ffc107));                background: rgba(255, 193, 7, 0.12);  }
    .dash-card.dash-battery  .dash-card-icon { color: var(--energy-battery-out-color, var(--energy-battery-out-color, #4db6ac)); background: rgba(77, 182, 172, 0.12); }
    .dash-card-label
    {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 1.4px;
        text-transform: uppercase;
        opacity: 0.75;
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
    /*  Forecast headline mirrors the produced figure typographically
        (same font sizes for value + unit) so the reader scans
        "produced / forecast" as twin columns rather than the forecast
        looking like an afterthought. Italic + reduced opacity remain
        as the only typographic differentiators. Inline ha-icon next
        to the value carries the cumulative-bell glyph HA uses for
        the predicted curve. */
    .dash-today-stat--forecast
    {
        gap: 6px;
        opacity: 0.75;
        font-style: italic;
    }
    .dash-today-stat--forecast ha-icon
    {
        --mdc-icon-size: 22px;
        align-self: center;
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
        box-shadow: 0 2px 6px var(--shadow-color);
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
        box-shadow: 0 2px 6px var(--shadow-color);
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
        border-color: var(--card-background-color, #191a1b);
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
        box-shadow: 0 2px 6px var(--shadow-color);
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
        align-items: center;
        gap: 4px;
    }
    .dash-today-chart-tooltip-row--forecast
    {
        opacity: 0.85;
        font-style: italic;
    }
    .dash-today-chart-tooltip-icon
    {
        --mdc-icon-size: 12px;
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
        line-height: 1;
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
        left: 50%;
        transform: translateX(-50%);
        width: calc(100% - 16px);
        /*  Timeline owns its own stacking layer at the very top of
            the card so the sun arc, the home glow and any overlay
            chip never crosses over it during auto-rotate.            */
        z-index: 1000;
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
        background: var(--card-background-color, #ffffff);
        /*  Theme-aware ink border so the chart cards stand out
            against the basemap on both palettes. The 0.55 alpha
            keeps the stroke visible without dominating the chart
            content underneath. */
        border: 2px solid rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.55);
        border-radius: 8px;
        box-shadow: 0 1px 3px var(--shadow-color);
        /*  Height scales with the card's container width (cqw =
            container-query width). 36 px floor on a small grid tile,
            72 px ceiling on a fullscreen kiosk. Both timeline charts
            share the same expression so they always stay siblings of
            the same height. */
        height: clamp(36px, 8cqw, 72px);
        overflow: hidden;
    }
    ha-card.theme-dark .tb-chart-card
    {
        border-color: rgba(255, 255, 255, 0.55);
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
        scaled by the clear-sky model. Dashed pattern, the stroke
        colour itself is computed theme-aware in charts.ts so the
        forecast curve stays readable on both backgrounds.          */
    .hc-chart-predicted
    {
        stroke-dasharray: 4 3;
        stroke-width: 1.8;
    }



    /*  Dotted day separators inside the chart card. Boosted to 0.55
        alpha (was 0.30) and a slightly chunkier dash pattern so the
        midnight boundaries between two days read clearly without the
        eye having to hunt for them. Flips with the theme via
        --rgb-primary-text-color. */
    .hc-day-sep
    {
        stroke: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.55);
        stroke-width: 1.2;
        stroke-dasharray: 2 2.5;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
    }

    /*  Solid midline splitting irradiance (top) from cloud
        cover (bottom). Day-label chips overlay it. Token-driven so
        the line flips with the theme. */
    .hc-chart-mid
    {
        stroke: var(--primary-text-color, #212121);
        stroke-width: 1.4;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
    }

    /*  Tiny hour ticks centred on the midline. Discreet enough to
        read as ambient texture rather than a primary feature. */
    .hc-hour-tick
    {
        stroke: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.35);
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
        background: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.5);
        border-radius: 999px;
        transform: translateX(-50%);
        pointer-events: none;
        z-index: 4;
    }
    /*  No top arrow on the pill, just the stroke. Reads cleaner
        against the chart and matches the rounded chip language of
        the rest of the card. */

    /*  Scrub cursor: a thin solid brand-blue stroke spanning the
        chart. No arrow, no handle dot, no pseudo-element, just a
        single line so the cursor reads as a minimal scrub mark. */
    .tb-cursor-sel
    {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 1.5px;
        background: var(--primary-color, #03a9f4);
        border-radius: 999px;
        transform: translateX(-50%);
        pointer-events: none;
        z-index: 4;
        box-shadow: 0 0 4px rgba(var(--rgb-primary-color), 0.4);
    }

    /*  Hover guide line, drawn vertically across the chart at
        the pointer's X. Same dotted recipe as the day-separator
        lines but a touch more opaque so it reads as "interactive
        focus" rather than ambient structure.                       */
    .hc-hover-guide
    {
        stroke: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.55);
        stroke-width: 1;
        stroke-dasharray: 2 2;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
    }

    /*  Per-curve hover dot, anchored at the interpolated Y of
        each series. Stroked in card colour so the dot stays
        legible whether it lands on a filled area or on the
        background.                                                  */
    .hc-hover-dot
    {
        stroke: var(--card-background-color, #ffffff);
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
    }

    /*  Hover tooltip card, sits above the chart-card stack inside
        the time-bar. Frame + padding match HA Energy dashboard chart
        tooltips so the card reads as native HA chrome (card-background
        surface, HA divider border, HA standard elevation shadow). */
    /*  Wrapper that hosts the magnet tab + tooltip body. Carries the
        horizontal positioning (left + translateX) so both children
        slide together as one block when the scrub moves — the tab
        inherits the wrapper's transform via the DOM tree so there's
        no per-element lag. Bottom + margin lift the whole stack into
        the 10 px gap above the chart card. */
    .tb-hover-tooltip-wrapper
    {
        position: absolute;
        bottom: 100%;
        margin-bottom: 10px;
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        pointer-events: none;
        z-index: 30;
    }
    .tb-hover-tooltip
    {
        background: var(--card-background-color, #ffffff);
        color: var(--primary-text-color, #212121);
        border: 1px solid var(--divider-color, rgba(0, 0, 0, 0.12));
        border-radius: 4px;
        padding: 6px 8px;
        box-shadow: 0 2px 4px 0 rgba(0, 0, 0, 0.16), 0 1px 4px 0 rgba(0, 0, 0, 0.06);
        font-family: var(--primary-font-family, 'Roboto', sans-serif);
        font-size: 12px;
        line-height: 1.25;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        min-width: 120px;
        align-self: stretch;
    }

    /*  Inner layout: time header in bold, a small gap, then one row
        per data series. No banded backgrounds, no row separators —
        the surrounding card frame is the only visible chrome. */
    .tb-hover-tooltip-time
    {
        font-weight: 700;
        text-align: center;
        letter-spacing: 0.3px;
        margin-bottom: 4px;
    }
    .tb-hover-tooltip-row
    {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 1px 0;
    }

    .tb-hover-tooltip-icon
    {
        --mdc-icon-size: 14px;
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
        line-height: 1;
        color: var(--primary-text-color, #212121);
        --mdc-icon-color: var(--primary-text-color, #212121);
    }
    .tb-hover-tooltip-value
    {
        flex: 1;
        text-align: right;
    }

    /*  Magnet-snap tab: real chip tab stacked above the tooltip in
        the wrapper's vertical flex column. Top corners match the
        tooltip's border-radius, bottom corners are flat and the
        bottom border is dropped so the seam between the tab and the
        tooltip reads as one continuous frame. -1 px margin pulls the
        tab down onto the tooltip's top border, sharing the 1 px line. */
    .tb-hover-tooltip-magnet-tab
    {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 18px;
        padding: 0 10px;
        background: var(--primary-color, #03a9f4);
        color: var(--text-on-primary-color, #ffffff);
        border: 1px solid var(--ha-card-border-color, var(--divider-color, rgba(0, 0, 0, 0.12)));
        border-bottom: 0;
        border-radius: 4px 4px 0 0;
        margin-bottom: -1px;
    }
    .tb-hover-tooltip-magnet-tab ha-icon
    {
        --mdc-icon-size: 14px;
        color: inherit;
    }

    /*  Scrub tail: a vertical dotted line drawn at the scrub X,
        sitting in the 10 px gap between the tooltip's bottom edge
        and the chart-card top edge. Positioned independently of the
        tooltip so it stays anchored on the scrub line even when the
        tooltip slides to clear the timeline edges. The dot pattern
        is painted via repeating-linear-gradient so the magnet-snap
        variant can flow the dots upward via a background-position
        animation; a plain dashed border could not be animated. */
    .tb-hover-tooltip-tail
    {
        position: absolute;
        bottom: 100%;
        width: 1.5px;
        height: 10px;
        /*  Default cursor paints in the theme's primary text colour
            (black-ish on light themes, white-ish on dark) and is NOT
            animated, so a regular scrub reads as a quiet vertical
            cue. The brand-blue + flow animation only kicks in inside
            the magnet zone (see the .is-magnet-snap rule below). */
        background-image: repeating-linear-gradient(
            to bottom,
            var(--primary-text-color, #212121) 0,
            var(--primary-text-color, #212121) 2px,
            transparent 2px,
            transparent 4px
        );
        transform: translateX(-50%);
        pointer-events: none;
        /*  Foreground layer above the tooltip (z 30) AND above any
            chart-card decoration so the animated cursor stays visible
            in the magnet zone. */
        z-index: 1001;
    }
    /*  Magnet-snap variant: brand-blue dot column with a continuous
        upward flow animation so the user sees a "rising" pattern
        that signals "release here to return to live". The flow runs
        bottom to top because the live cursor sits ABOVE the chart
        viewport (in time, "now" is the forward edge). */
    .tb-hover-tooltip-tail.is-magnet-snap
    {
        background-image: repeating-linear-gradient(
            to bottom,
            var(--primary-color, #03a9f4) 0,
            var(--primary-color, #03a9f4) 2px,
            transparent 2px,
            transparent 4px
        );
        animation: tb-hover-tooltip-tail-flow 0.5s linear infinite;
    }
    @keyframes tb-hover-tooltip-tail-flow
    {
        from { background-position: 0 0; }
        to   { background-position: 0 -4px; }
    }

    /*  tb-hover-tooltip flips with the theme on its own through
        --card-background-color / --primary-text-color /
        --divider-color, no explicit dark override needed. */


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
        /*  color-mix keeps the wash translucent at every theme: 55 %
            of the active card background mixed with 45 % transparency
            lets the predicted PV curve underneath stay visible while
            still marking the future portion as "not yet real". The
            color-mix on transparent is critical, var(--card-background-
            color) on its own goes fully opaque in dark mode and hides
            the prediction entirely. */
        background: color-mix(in srgb, var(--card-background-color, #ffffff) 55%, transparent);
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
            rgba(0, 0, 0, 0.12) 0,
            rgba(0, 0, 0, 0.12) 1.5px,
            transparent         1.5px,
            transparent         6px
        );
        box-shadow: inset  1px 0 0 0 rgba(0, 0, 0, 0.12),
                    inset -1px 0 0 0 rgba(0, 0, 0, 0.12);
    }
    ha-card.theme-dark .hc-night-zone
    {
        background-image: repeating-linear-gradient(
            45deg,
            rgba(255, 255, 255, 0.18) 0,
            rgba(255, 255, 255, 0.18) 1.5px,
            transparent              1.5px,
            transparent              6px
        );
        box-shadow: inset  1px 0 0 0 rgba(255, 255, 255, 0.18),
                    inset -1px 0 0 0 rgba(255, 255, 255, 0.18);
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
        /*  border-box so the 22 px height includes the 2 px border,
            inner content area is exactly 18 px. The cell's
            line-height matches that 18 px so the text line box fills
            the cell with no leftover space, no ambiguity about
            where the row sits vertically. */
        box-sizing: border-box;
        background: var(--card-background-color, #ffffff);
        /*  Theme-aware ink border matching the chart cards above so
            the timeline + day-strip stack reads as one outlined
            instrument. */
        border: 2px solid rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.55);
        /*  Compact radius (matches the chart cards stacked above) so
            the strip reads as a low-key axis rather than a pill chip. */
        border-radius: 8px;
        box-shadow: 0 1px 2px var(--shadow-color);
        overflow: hidden;
        pointer-events: none;
    }
    ha-card.theme-dark .tb-day-strip
    {
        border-color: rgba(255, 255, 255, 0.55);
    }

    .tb-day-strip-cell
    {
        position: absolute;
        top: 0;
        bottom: 0;
        display: inline-flex;
        flex-direction: row;
        align-items: baseline;
        justify-content: center;
        /*  Tight inline spacing so the date glyph and the kWh
            annotation read as one compact group on a narrow phone
            cell rather than two widely-separated pieces. */
        gap: 1px;
        padding: 0 1px;
        box-sizing: border-box;
        color: var(--primary-text-color, #212121);
        /*  Inherit the HA frontend font stack rather than letting
            the cell fall back to the OS default. Different OS fonts
            ship italic and bold variants with different vertical
            metrics, so on a host that did not propagate the Roboto
            stack down to this depth, the date (bold) and the
            forecast kWh (italic) ended up sitting on different
            baselines and the cell read as misaligned. */
        font-family: var(--mdc-typography-body1-font-family,
                         var(--ha-font-family,
                             var(--paper-font-common-base_-_font-family,
                                 Roboto, "Helvetica Neue", Arial, sans-serif)));
        font-size: clamp(9px, 7cqw, 11px);
        line-height: 18px;
        letter-spacing: 0;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: clip;
        z-index: 2;
        font-weight: 400;
    }

    .tb-day-strip-cell.is-today
    {
        font-weight: 500;
    }
    /*  Active day during scrub / hover gets a faint brand-blue tint
        and bumps the label to a slightly heavier weight so the user
        reads "I am on this day" at a glance. Tint uses --primary-color
        at 16 % alpha for both light and dark themes, sitting just
        above the strip's own --card-background-color. */
    .tb-day-strip-cell.is-active
    {
        background: color-mix(in srgb, var(--primary-color, #03a9f4) 16%, transparent);
        font-weight: 600;
    }

    .tb-day-strip-date
    {
        font-weight: inherit;
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
            rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.30) 0,
            rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.30) 1.5px,
            transparent                                          1.5px,
            transparent                                          4px
        );
    }

    /*  Optional PV graph card stacked above the main chart. Same
        height as the main chart so the two cards form a balanced
        stack: production sits on top, irradiance + cloud cover
        underneath, neither dominating the other. The combined
        block keeps the same total vertical footprint the previous
        (32 px PV + 64 px main) layout occupied. */
    .tb-pv-card
    {
        height: clamp(36px, 8cqw, 72px);
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


    /*  When LiDAR View is active, fade out every overlay layer so
        the dot cloud reads on its own against a quiet basemap. The
        toggle button itself is opted back in (selector below) so
        the user can always exit. The map container stays visible
        so the dots are projected onto a real basemap.

        Selector list mirrors what .detail-active fades earlier in
        this file, plus the corners (top-left clock + top-right rail
        minus the LiDAR button itself), the home hitbox / glow, and
        the timeline. */
    /*  Base transition + composite-layer hint kept on the unprefixed
        selectors so the fade runs in BOTH directions across every
        browser. The will-change: opacity hint promotes each element
        to its own composite layer so the GPU drives the alpha sweep
        instead of asking the painter to redo layout per frame,
        which used to drop frames on the chips that sit inside
        transform-less wrappers (time-bar, solar-svg).               */
    .overlay-top-left,
    .home-glow-svg,
    .home-hitbox,
    .home-silhouette-svg,
    .home-drop-leader-svg,
    .solar-svg,
    .solar-pct-label,
.pv-home-anchor-svg,
    .pv-home-leader-svg,
    .pv-pct-label,
    .battery-leader-svg,
    .battery-pct-label,
    .grid-leader-svg,
    .grid-import-label,
    .grid-export-label,
    .home-pill
    {
        transition: opacity 0.35s ease;
    }
    /*  will-change opt-in: scope the composite-layer promotion to the
        transition windows only. At rest, 15+ elements declared
        will-change: opacity unconditionally was pinning that many
        GPU layers in idle VRAM (~15-30 MB on devices with limited
        budgets) and forcing the compositor to re-sync them on every
        Lit re-render. Promote only when a mode actually toggles. */
    ha-card.detail-active         .overlay-top-left, ha-card.detail-active         .home-glow-svg,
    ha-card.detail-active         .home-hitbox,      ha-card.detail-active         .pv-home-anchor-svg,
    ha-card.detail-active         .pv-home-leader-svg, ha-card.detail-active       .pv-pct-label,
    ha-card.detail-active         .battery-leader-svg, ha-card.detail-active       .battery-pct-label,
    ha-card.detail-active         .solar-svg,        ha-card.detail-active         .solar-pct-label,
    ha-card.detail-active
{
        will-change: opacity;
    }

    /*  Timeline SLIDES out below the card / slides back in from the
        bottom edge instead of fading. The X centring (translateX
        -50%) is kept inside every keyframe so the bar never drifts
        horizontally during the slide. */
    .time-bar
    {
        transition: transform 0.45s cubic-bezier(0.22, 0.61, 0.36, 1);
        will-change: transform;
    }
    {
        opacity: 0;
        pointer-events: none;
    }
    /*  Timeline slides out below the card edge. Pointer-events
        disabled so the drifting element cannot intercept clicks
        while off-screen. translateX kept so the bar stays centred. */
    {
        transform: translateX(-50%) translateY(140%);
        pointer-events: none;
    }
    {
        opacity: 0;
        pointer-events: none;
    }
    {
        opacity: 1;
        pointer-events: auto;
    }

    /*  Shading-dome view: mirrors the LiDAR fade-out list so the
        rest of the HUD steps aside when the dome takes over the
        canvas, then the dome SVG itself overlays the map without
        intercepting pointer events. Top-right chip cluster stays
        live so the user can toggle the dome back off.            */
    {
        opacity: 0;
        pointer-events: none;
    }
    /*  Same slide-out as LiDAR for the timeline. */
    {
        transform: translateX(-50%) translateY(140%);
        pointer-events: none;
    }
    {
        opacity: 1;
        pointer-events: auto;
    }

    /*  Cloud-dome (per-layer reveal) is now a soft mode: the rest of
        the HUD stays alive and the cloud chip itself remains visible
        as the OFF switch. */
    /*  Cloud-cover toggle button. iOS-friendly 40 px touch target,
        icon-only with a title tooltip; the on state takes the brand
        primary plate so the user has one consistent
        visual language for "you are in a non-default mode".
        Segments are glued together via shared borders and
        matching corner radii.                                    */
    /*  HA ha-icon-button-style toggles: each segment is a transparent
        circle that holds the icon, an active or hover state lights
        up the circle in the brand colour. Same visual vocabulary as
        the HA dashboard toolbar buttons so a Helios card dropped
        into a HA Energy dashboard reads as part of the toolbar
        family. */
    .cloud-cover-toggle
    {
        appearance: none;
        -webkit-appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width:  40px;
        height: 40px;
        box-sizing: border-box;
        padding: 0;
        background-color: transparent;
        background-clip: padding-box;
        color: var(--primary-text-color, #212121);
        border: 0;
        outline: 0 !important;
        outline-offset: 0;
        border-radius: 50%;
        overflow: hidden;
        cursor: pointer;
        position: relative;
        z-index: 50;
        opacity: 1;
        -webkit-tap-highlight-color: transparent;
        transition: background-color 0.15s, color 0.15s;
    }
    .cloud-cover-toggle:hover,
    .cloud-cover-toggle:focus,
    .cloud-cover-toggle:focus-visible,
    .cloud-cover-toggle:active
    {
        outline: 0 !important;
        box-shadow: none !important;
    }
    .cloud-cover-toggle:hover  { background-color: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.08); }
    .cloud-cover-toggle:active { background-color: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.16); }
    .cloud-cover-toggle ha-icon
    {
        --mdc-icon-size: 22px;
        color: inherit;
        display: inline-flex;
        align-items: center;
        pointer-events: none;
    }
    /*  Active toggle: brand-blue pastille behind the icon, white
        glyph on top. Same on-primary recipe HA toolbars use. */
    .cloud-cover-toggle.is-on
    {
        background: var(--primary-color, #03a9f4);
        color: var(--text-on-primary-color, #ffffff);
    }
    .cloud-cover-toggle.is-on:hover  { background: var(--dark-primary-color, #0288d1); }
    .cloud-cover-toggle.is-on:active { background: var(--darker-primary-color, #01579b); }

    /*  Mode bar (Layer / LiDAR / Shading). Vertical column of three
        icon-only toggles, anchored top-right, no backplate so the
        column reads as a quiet HA-toolbar trio sitting on the map.
        Each button uses the same transparent-circle recipe as the
        camera-lock and cloud-cover toggles so all three corner
        controls speak the same language. */
    .mode-bar
    {
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        pointer-events: auto;
    }
    .mode-bar-seg
    {
        appearance: none;
        -webkit-appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width:  40px;
        height: 40px;
        box-sizing: border-box;
        padding: 0;
        background-color: transparent;
        background-clip: padding-box;
        color: var(--primary-text-color, #212121);
        border: 0;
        outline: 0 !important;
        outline-offset: 0;
        border-radius: 50%;
        overflow: hidden;
        cursor: pointer;
        position: relative;
        opacity: 1;
        -webkit-tap-highlight-color: transparent;
        transition: background-color 0.15s, color 0.15s, opacity 0.15s;
    }
    .mode-bar-seg:hover,
    .mode-bar-seg:focus,
    .mode-bar-seg:focus-visible,
    .mode-bar-seg:active
    {
        outline: 0 !important;
        box-shadow: none !important;
    }
    .mode-bar-seg:hover  { background-color: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.08); }
    .mode-bar-seg:active { background-color: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.16); }
    .mode-bar-seg ha-icon
    {
        --mdc-icon-size: 22px;
        color: inherit;
        display: inline-flex;
        align-items: center;
        pointer-events: none;
    }
    /*  Active segment: brand-blue pastille behind the icon, white
        glyph on top, same on-primary recipe as cloud-cover-toggle.is-on
        so the two controls read as one family.                       */
    .mode-bar-seg.is-on
    {
        background: var(--primary-color, #03a9f4);
        color: var(--text-on-primary-color, #ffffff);
    }
    .mode-bar-seg.is-on:hover  { background: var(--dark-primary-color, #0288d1); }
    .mode-bar-seg.is-on:active { background: var(--darker-primary-color, #01579b); }
    .mode-bar-seg.is-disabled,
    .mode-bar-seg:disabled
    {
        opacity: 0.4;
        cursor: not-allowed;
        pointer-events: none;
    }
    /*  Spinning LiDAR icon while shadows are being computed. Same
        rotation primitive used by the centre shadow-busy spinner so
        the two surfaces breathe at the same rate. */
    .mode-bar-seg .is-spinning
    {
        animation: helios-mode-spin 1s linear infinite;
    }
    @keyframes helios-mode-spin
    {
        from { transform: rotate(0deg); }
        to   { transform: rotate(360deg); }
    }

    /*  Top corner overlays. Camera-lock + scrub-return on the left,
        cloud-cover toggle on the right. Both rails are flex rows
        sitting 8 px from their card edge.                          */

    /*  Date/time chip, same chip language as the on-map readouts.
        Explicit height (border-box) so the chip and the back-to-
        live button next to it share the exact same vertical
        footprint, no align-items: center shift in the parent flex
        container. */
    /*  Global crisp-text rule for every chip rendered with a
        translate centred on the home anchor. Without this rule
        Safari and Chrome land the chip at a fractional pixel
        (50 % anchor + -50 % translate) which softens the glyph
        edges. text-rendering: geometricPrecision + antialiased
        smoothing keeps the text sharp at any sub-pixel offset. */
    .pv-pct-label,
    .battery-pct-label,
    .solar-pct-label
    {
        text-rendering: geometricPrecision;
        -webkit-font-smoothing: antialiased;
    }

    /*  Top-right overlay rail. Hosts the three view-mode toggles
        (default layer view). z-index: 60 keeps
        the rail above the LiDAR canvas (z 30) and the centre spinner
        (z 50) so a toggle is always reachable. Pointer events off on
        the rail itself so the empty rail never steals map
        interactions; each .cloud-cover-toggle button opts back in. */
    .overlay-top-right
    {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 60;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 8px;
        pointer-events: none;
    }

    /*  Camera-lock toggle. Pinned top-left of the card, opens
        (lock-open) when the camera is free and closes (lock) when
        locked. Same visual size and idle/active recipe as the
        .cloud-cover-toggle so the left lock button and the right
        cloud-cover button read as one family. The brand-blue
        pastille appears when locked, matching cloud-cover-toggle.is-on. */
    .camera-lock-btn
    {
        appearance: none;
        -webkit-appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width:  40px;
        height: 40px;
        box-sizing: border-box;
        padding: 0;
        background-color: transparent;
        background-clip: padding-box;
        color: var(--primary-text-color, #212121);
        border: 0;
        outline: 0 !important;
        outline-offset: 0;
        border-radius: 50%;
        overflow: hidden;
        cursor: pointer;
        pointer-events: auto;
        position: relative;
        z-index: 50;
        opacity: 1;
        -webkit-tap-highlight-color: transparent;
        transition: background-color 0.15s, color 0.15s;
    }
    .camera-lock-btn:hover,
    .camera-lock-btn:focus,
    .camera-lock-btn:focus-visible,
    .camera-lock-btn:active
    {
        outline: 0 !important;
        box-shadow: none !important;
    }
    .camera-lock-btn ha-icon
    {
        --mdc-icon-size: 22px;
        color: inherit;
        display: inline-flex;
        align-items: center;
        pointer-events: none;
    }
    .camera-lock-btn:hover  { background-color: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.08); }
    .camera-lock-btn:active { background-color: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.16); }
    .camera-lock-btn.is-on
    {
        background: var(--primary-color, #03a9f4);
        color: var(--text-on-primary-color, #ffffff);
    }
    .camera-lock-btn.is-on:hover  { background: var(--dark-primary-color, #0288d1); }
    .camera-lock-btn.is-on:active { background: var(--darker-primary-color, #01579b); }

    /*  Top-left rail, mirrors overlay-top-right on the opposite edge
        so the corner overlays sit at matching heights. Hosts the
        camera-lock toggle. Pointer events are off on the rail by
        default; the button opts back in via .camera-lock-btn so
        clicks reach it without the rail stealing unrelated map
        interactions. */
    .overlay-top-left
    {
        position: absolute;
        top: 8px;
        left: 8px;
        z-index: 60;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
        pointer-events: none;
    }
    /*  Cloud rail sits BELOW the camera-lock toggle on the left edge,
        so the two left-side rails do not stack on the same anchor.
        Offset = lock button (40 px) + the 8 px corner inset + an 8 px
        gap. Per-layer chips stack BELOW the toggle when cloud mode is
        on so they read as a column under the toggle. */
    .overlay-top-left.overlay-top-left--cloud
    {
        top: 56px;
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
        color: var(--helios-sun-color, var(--energy-solar-color, var(--energy-solar-color, #ff9800)));
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

    /*  Per-altitude cloud cover discs. Three 40 px round chips drop
        in the overlay-top-right rail below the cloud-cover toggle.
        Always in the DOM whenever the cloud scene is available so
        the chips can fade between the on / off states. The cascade
        runs strict TOP DOWN on enter: high first (delay 0), mid
        after high finishes (~280 ms), low last (~560 ms); on exit
        the same selectors apply BOTTOM UP — low fades first, then
        mid, then high. Visuals mirror the toggle's idle look exactly,
        transparent plate, primary-text-color icon + label. */
    .cloud-layer-chip
    {
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        width:  40px;
        height: 40px;
        margin-top: 4px;
        background: transparent;
        color: var(--primary-text-color, #212121);
        border-radius: 50%;
        font-size: 12px;
        font-weight: 600;
        line-height: 1;
        font-variant-numeric: tabular-nums;
        pointer-events: none;
        opacity: 0;
        transform: translateY(-4px);
        transition: opacity 0.28s ease, transform 0.28s ease;
    }
    /*  Exit cascade (bottom up): low fades out first, then mid, then
        high. These selectors only match when the chip does NOT carry
        the is-on class, i.e. the moment the toggle flips off. */
    .cloud-layer-chip--low  { transition-delay: 0ms;   }
    .cloud-layer-chip--mid  { transition-delay: 280ms; }
    .cloud-layer-chip--high { transition-delay: 560ms; }
    /*  Enter cascade (top down): high first, then mid, then low.
        The is-on selectors override the default delays above so the
        same chip uses different timings on entry vs exit. */
    .cloud-layer-chip--high.is-on
    {
        opacity: 1;
        transform: translateY(0);
        transition-delay: 0ms;
    }
    .cloud-layer-chip--mid.is-on
    {
        opacity: 1;
        transform: translateY(0);
        transition-delay: 280ms;
    }
    .cloud-layer-chip--low.is-on
    {
        opacity: 1;
        transform: translateY(0);
        transition-delay: 560ms;
    }
    .cloud-layer-chip ha-icon
    {
        --mdc-icon-size: 14px;
        color: inherit;
        display: inline-flex;
        align-items: center;
        margin-bottom: 2px;
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
    /*  Wireframe + cell outlines paint via currentColor so the dome
        flips polarity with the theme: black ink on a bright basemap
        in light mode, white ink against a darkened basemap in dark
        mode. Per-cell opacities live inline so the wipe + decay
        envelope stays a pure paint-property and doesn't bleed into
        the theme switch. */
    .shading-dome-cells-wire,
    .shading-dome-cells-color
    {
        color: var(--primary-text-color, #212121);
    }
    ha-card.theme-dark .shading-dome-cells-wire,
    ha-card.theme-dark .shading-dome-cells-color
    {
        color: #ffffff;
    }
    /*  Cloud-bin picker: small segmented control hugging the top
        edge under the dome chip cluster. Pills mirror the dome's
        accent so it reads as part of the same widget.             */
    /*  Continuous cloud-cover slider, bottom-centre of the card
        while the dome is on. Sun glyph on the LEFT, heavy-cloud
        glyph on the RIGHT, the slider in between reads as the
        cloud-cover knob driving the dome's view. Percent value
        chip on the far RIGHT is the immediate readout. Shares the
        same pill, same z, same bottom anchor as the LiDAR opacity
        slider so the two modes feel mounted to the same rail. */
    .shading-dome-cloud-slider
    {
        position: absolute;
        bottom: 14px;
        left: 50%;
        /*  translateY(60px) parks the pill below the card so the
            slide-in animation can lift it back into view when the
            mode becomes active. The .is-active class below resets
            translateY to 0; the transition on transform + opacity
            runs in both directions. */
        transform: translate(-50%, 60px);
        opacity: 0;
        pointer-events: none;
        transition: transform 0.35s ease, opacity 0.35s ease;
        z-index: 50;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        min-height: 28px;
        box-sizing: border-box;
        background: rgba(0, 0, 0, 0.55);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 999px;
    }
    .shading-dome-cloud-slider.is-active
    {
        transform: translate(-50%, 0);
        opacity: 1;
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
        background: rgba(255, 255, 255, 0.35);
        border-radius: 1px;
        transform: translate(-50%, -50%);
        pointer-events: none;
        /*  Stack below the slider thumb so the knob always reads as
            the foreground, the ticks as reference marks behind it. */
        z-index: 0;
    }
    .shading-dome-cloud-icon
    {
        --mdc-icon-size: 16px;
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
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--primary-color, #03a9f4);
        border: 2px solid var(--card-background-color, #ffffff);
        box-shadow: 0 1px 3px var(--shadow-color);
        cursor: pointer;
        position: relative;
        z-index: 2;
    }
    .shading-dome-cloud-range::-moz-range-thumb
    {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--primary-color, #03a9f4);
        border: 2px solid var(--card-background-color, #ffffff);
        box-shadow: 0 1px 3px var(--shadow-color);
        cursor: pointer;
        position: relative;
        z-index: 2;
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

    /*  LiDAR View opacity slider. Painted at the bottom of the card
        while the LiDAR view is active. Same capsule pill as the dome
        cloud picker for visual consistency between the two modes;
        ungated (continuous, no ticks) because opacity is a free
        analog tune, not a binned pick.                              */

    .lidar-view-opacity-slider
    {
        position: absolute;
        bottom: 14px;
        left: 50%;
        /*  Same parked-below-the-card resting state as the dome
            slider so the two modes share one slide-in animation. */
        transform: translate(-50%, 60px);
        opacity: 0;
        pointer-events: none;
        transition: transform 0.35s ease, opacity 0.35s ease;
        z-index: 50;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        min-height: 28px;
        box-sizing: border-box;
        background: rgba(0, 0, 0, 0.55);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 999px;
    }
    .lidar-view-opacity-slider.is-active
    {
        transform: translate(-50%, 0);
        opacity: 1;
        pointer-events: auto;
    }
    .lidar-view-opacity-icon
    {
        --mdc-icon-size: 16px;
        color: rgba(255, 255, 255, 0.85);
        display: inline-flex;
        align-items: center;
    }
    .lidar-view-opacity-icon--low  { opacity: 0.7; }
    .lidar-view-opacity-icon--high { opacity: 1.0; }
    .lidar-view-opacity-range
    {
        appearance: none;
        -webkit-appearance: none;
        width: 160px;
        height: 4px;
        background: linear-gradient(to right, rgba(255, 255, 255, 0.25) 0%, rgba(255, 255, 255, 0.9) 100%);
        border-radius: 999px;
        outline: none;
        cursor: pointer;
        margin: 0;
    }
    .lidar-view-opacity-range::-webkit-slider-thumb
    {
        appearance: none;
        -webkit-appearance: none;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--primary-color, #03a9f4);
        border: 2px solid var(--card-background-color, #ffffff);
        box-shadow: 0 1px 3px var(--shadow-color);
        cursor: pointer;
        position: relative;
        z-index: 2;
    }
    .lidar-view-opacity-range::-moz-range-thumb
    {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--primary-color, #03a9f4);
        border: 2px solid var(--card-background-color, #ffffff);
        box-shadow: 0 1px 3px var(--shadow-color);
        cursor: pointer;
        position: relative;
        z-index: 2;
    }
    .lidar-view-opacity-value
    {
        min-width: 36px;
        text-align: right;
        font-size: 11px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.85);
        font-variant-numeric: tabular-nums;
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
    /*  PV production chip. Compact horizontal pill so it does not
        crowd the map (HA-energy-shaped 76 x 76 nodes read too heavy
        at the card's native zoom). The HA-energy identity stays via
        the coloured ring + icon glyph + ink tokens, the shape stays
        compact. */
    .pv-pct-label
    {
        position: absolute;
        transform: translate(-50%, -50%);
        pointer-events: none;
        z-index: 8;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        min-width: 56px;
        box-sizing: border-box;
        background: var(--card-background-color, #ffffff);
        color:      var(--primary-text-color, #212121);
        border:     2px solid var(--pv-leader-color, var(--energy-solar-color, var(--energy-solar-color, #ff9800)));
        border-radius: 999px;
        padding: 3px 10px;
        font-size:    12px;
        font-weight:  600;
        line-height:  1.2;
        font-variant-numeric: tabular-nums;
        box-shadow: 0 1px 3px var(--shadow-color);
        white-space: nowrap;
    }

    .pv-pct-label ha-icon
    {
        --mdc-icon-size: 16px;
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

    /*  Battery SoC and Power chips, same compact pill recipe as the
        PV chip. HA-energy node identity is carried by the coloured
        ring, the icon and the ink tokens, the shape stays compact so
        it does not crowd the map. */
    .battery-pct-label
    {
        position: absolute;
        transform: translate(-50%, -50%);
        pointer-events: none;
        z-index: 8;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        min-width: 56px;
        box-sizing: border-box;
        background: var(--card-background-color, #ffffff);
        color:      var(--primary-text-color, #212121);
        border:     2px solid var(--battery-leader-color, var(--energy-battery-out-color, var(--energy-battery-out-color, #4db6ac)));
        border-radius: 999px;
        padding: 3px 10px;
        font-size:    12px;
        font-weight:  600;
        line-height:  1.2;
        font-variant-numeric: tabular-nums;
        box-shadow: 0 1px 3px var(--shadow-color);
        white-space: nowrap;
    }

    .battery-pct-label ha-icon
    {
        --mdc-icon-size: 16px;
        color: inherit;
        display: inline-flex;
        align-items: center;
    }

    /*  Grid import / export chips, same compact pill recipe as the
        battery chips but tinted in the HA Energy grid colours:
        consumption blue for import, return purple for export. Both
        chips live in the LEFT column of the home cluster. */
    .grid-import-label,
    .grid-export-label
    {
        position: absolute;
        transform: translate(-50%, -50%);
        pointer-events: none;
        z-index: 8;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        min-width: 56px;
        box-sizing: border-box;
        background: var(--card-background-color, #ffffff);
        color: var(--primary-text-color, #212121);
        border-radius: 999px;
        padding: 3px 10px;
        font-size: 12px;
        font-weight: 600;
        line-height: 1.2;
        font-variant-numeric: tabular-nums;
        box-shadow: 0 1px 3px var(--shadow-color);
        white-space: nowrap;
        text-rendering: geometricPrecision;
        -webkit-font-smoothing: antialiased;
    }
    .grid-import-label
    {
        border: 2px solid var(--energy-grid-consumption-color, var(--energy-grid-consumption-color, #488fc2));
    }
    .grid-export-label
    {
        border: 2px solid var(--energy-grid-return-color, var(--energy-grid-return-color, #8353d1));
    }
    .grid-import-label ha-icon,
    .grid-export-label ha-icon
    {
        --mdc-icon-size: 16px;
        color: inherit;
        display: inline-flex;
        align-items: center;
    }

    .grid-leader-svg
    {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 5;
    }
    .grid-import-leader-line
    {
        stroke: var(--energy-grid-consumption-color, var(--energy-grid-consumption-color, #488fc2));
        stroke-width: 1;
        stroke-linecap: round;
        fill: none;
    }
    .grid-export-leader-line
    {
        stroke: var(--energy-grid-return-color, var(--energy-grid-return-color, #8353d1));
        stroke-width: 1;
        stroke-linecap: round;
        fill: none;
    }
    .grid-import-leader-bead { fill: var(--energy-grid-consumption-color, var(--energy-grid-consumption-color, #488fc2)); }
    .grid-export-leader-bead { fill: var(--energy-grid-return-color, var(--energy-grid-return-color, #8353d1)); }

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
        stroke: var(--pv-leader-color, var(--energy-solar-color, var(--energy-solar-color, #ff9800)));
        stroke-width: 1;
        stroke-opacity: 1;
        stroke-linecap: round;
        fill: none;
    }

    /*  Moving bead, a small filled disc rides the leader at a
        speed proportional to live production. Same vocabulary as
        the Home Assistant energy-distribution card. */
    .pv-home-leader-bead
    {
        opacity: 0.95;
        stroke: var(--card-background-color, #ffffff);
        stroke-width: 1;
        stroke-opacity: 0.85;
        paint-order: stroke fill;
    }
    ha-card.theme-dark .pv-home-leader-bead
    {
        stroke: var(--card-background-color, #191a1b);
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
        /*  Sits ABOVE the cloud-cover dome bands (z 3) so the green
            HA-Energy home ring is always visible at the foot of the
            house even when overcast. Stacks below the home-glow
            silhouette (z 9) and the time bar (z 10) so it still
            yields to the focal home + the timeline. */
        z-index: 4;
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
        stroke: var(--battery-leader-color, var(--energy-battery-out-color, var(--energy-battery-out-color, #4db6ac)));
        stroke-width: 1;
        stroke-opacity: 1;
        stroke-linecap: round;
        stroke-linejoin: round;
        fill: none;
    }

    .battery-leader-bead
    {
        opacity: 0.95;
        stroke: var(--card-background-color, #ffffff);
        stroke-width: 1;
        stroke-opacity: 0.85;
        paint-order: stroke fill;
    }
    ha-card.theme-dark .battery-leader-bead
    {
        stroke: var(--card-background-color, #191a1b);
        stroke-opacity: 0.95;
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
    /*  Central home pill, a circular node painted at the projected
        home centre. Every chip leader (PV, battery, grid) docks
        against its border so the home reads as the single energy
        hub the way HA's Energy distribution card does.            */
    .home-pill
    {
        position: absolute;
        width:  28px;
        height: 28px;
        transform: translate(-50%, -50%);
        background: var(--card-background-color, #ffffff);
        border: 2px solid var(--primary-color, #03a9f4);
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        z-index: 9;
        pointer-events: none;
        box-shadow: 0 1px 3px var(--shadow-color);
        color: var(--primary-color, #03a9f4);
    }
    .home-pill ha-icon
    {
        --mdc-icon-size: 18px;
        color: inherit;
        display: inline-flex;
        align-items: center;
    }

    /*  Solid drop-leader from the home pill down to the projected
        ground at the home position. Length covers the CLUSTER_LIFT_PX
        gap between the cluster Y and the basemap-projected home.x/y.
        Sits in its own SVG layer below the pill (z 5) so the pill
        crowns the leader visually.                                   */
    .home-drop-leader-svg
    {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 5;
        overflow: visible;
    }
    .home-drop-leader-line
    {
        stroke: var(--primary-color, #03a9f4);
        stroke-width: 1;
        stroke-linecap: round;
        fill: none;
        opacity: 0.85;
    }

    .solar-svg-back        { z-index: 4; }
    /*  Above-horizon arc is rendered in TWO passes so the depth of
        each segment drives the local z-order around the home cluster:
          - solar-svg-front-far  (z 5)  : the half of the arc that has
            already arched away from the camera. Sits BEHIND chips
            (z 8), leaders (z 5..), pill (z 9); reads as "the arc
            disappears behind the home".
          - solar-svg-front-near (z 11) : the half closest to the
            camera. Sits IN FRONT of chips + leaders so the arc reads
            as "coming over the top of the home" on its near side.
        Sun disc (z 12) and the W/m^2 chip (z 13) always paint last.  */
    .solar-svg-front-far  { z-index: 5; }
    .solar-svg-front-near { z-index: 11; }
    /*  Sun disc inherits the same depth split as the arc:
        - far half of the loop : disc paints UNDER chips + leaders
          (z 5) so the sun "passes behind the home" as the loop
          arcs away from the camera.
        - near half of the loop : disc paints OVER everything but
          the W/m^2 chip (z 12).                                  */
    .solar-svg-sun-far    { z-index: 5;  }
    .solar-svg-sun-near   { z-index: 12; }
    /*  Sun -> PV ray + bead live on their own SVG below the chip
        family (pv-pct-label sits at z 8) so the chip's background
        always occludes the ray endpoint at the chip border. The
        sun disc itself stays in the depth-split SVGs above so the
        disc still passes in front of / behind the home cluster
        depending on camera bearing. */
    .solar-ray-svg        { z-index: 7;  }

    /*  Cloud-cover dome overlay: a celestial hemisphere centred
        on the home, sliced into three horizontal bands (low / mid
        / high cloud) whose per-band opacity scales with the live
        cover percentage. Same fade-in / fade-out CSS rules as the
        and same currentColor + opacity-driven look so the bands
        feel like "filling water" inside a glass hemisphere. */
    .cloud-dome-svg
    {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 12;
        color: var(--helios-cloud-color, var(--primary-text-color, var(--secondary-text-color, #727272)));
        transition: opacity 240ms ease-out;
    }
    .cloud-dome-disc
    {
        transition: opacity 240ms ease-out;
    }
    .cloud-dome-disc-ring
    {
        stroke-dasharray: 4 4;
    }
    /*  Light theme tweak: the dome discs paint at a darker tint so
        they read against a bright basemap. */
    ha-card.theme-light .cloud-dome-svg
    {
        color: var(--helios-cloud-color, #4d4d4d);
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

    /*  Incidence ray, dashes flow from the sun toward the home at a
        speed proportional to live irradiance. Hairline 1 px to match
        the home cluster's solid leaders so the whole connector family
        reads at one weight. */
    .solar-svg .solar-ray
    {
        stroke-width: 1;
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

    /*  Solar ray bead, small filled disc travelling sun -> PV chip
        along the incidence ray. Same recipe as the PV / battery /
        grid beads (white halo stroke, paint-order stroke-fill, dark
        halo in theme-dark) so the bead family reads consistently
        across all leaders. Speed comes from the inline animateMotion
        dur value driven by the live irradiance.                    */
    .solar-svg .solar-ray-bead
    {
        opacity: 0.95;
        stroke: var(--card-background-color, #ffffff);
        stroke-width: 1;
        stroke-opacity: 0.85;
        paint-order: stroke fill;
    }
    ha-card.theme-dark .solar-svg .solar-ray-bead
    {
        stroke: var(--card-background-color, #191a1b);
        stroke-opacity: 0.95;
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
        /*  Sits ABOVE the arc-front lines (z 11) so the W/m² readout
            never gets crossed over by an arc segment that happens
            to project through its area. The sun disc (z 12) still
            paints on top because it shares the cluster identity. */
        z-index: 13;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: var(--card-background-color, #ffffff);
        color:      var(--primary-text-color, #212121);
        /*  Sun chip uses the HA amber token so the live irradiance
            reads distinct from the PV production identity. PV stays
            on --energy-solar-color (orange); the sun stays on amber
            so the two never blur visually. */
        border:     2px solid var(--helios-sun-color, var(--amber-color, var(--warning-color, #ffc107)));
        border-radius: 999px;
        padding: 3px 10px;
        font-size:    12px;
        font-weight:  600;
        line-height:  1.2;
        font-variant-numeric: tabular-nums;
        box-shadow: 0 1px 3px var(--shadow-color);
        white-space: nowrap;
    }

    .solar-pct-label ha-icon
    {
        --mdc-icon-size: 16px;
        color: inherit;
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

    /*  .tb-chart-card flips via --card-background-color +
        --divider-color, no explicit dark-theme override needed. */

    ha-card.theme-dark .hc-day-sep
    {
        stroke: rgba(255, 255, 255, 0.55);
    }

    ha-card.theme-dark .hc-chart-mid
    {
        stroke: #cccccc;
    }

    ha-card.theme-dark .hc-hour-tick
    {
        stroke: rgba(255, 255, 255, 0.35);
    }

    /*  tb-cursor-now is driven by --rgb-primary-text-color + alpha
        so it flips with the theme on its own, no dark overrides
        needed. */

    /*  Value chips (PV, battery, cloud, solar) sit on a dark plate
        with a thick coloured ring in BOTH themes, matching the visual
        language of Home Assistant's energy dashboard so a Helios card
        sitting alongside HA's own surfaces reads as part of the same
        family. The plate is opaque enough to stay readable over a
        bright basemap in light mode without us forking the recipe
        per theme. */

    /*  Cloud leader keeps its slate-blue colour in dark mode too,
        the chip's frame already carries the same colour on both
        themes so the leader matches by default. */

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


    /*  Fullscreen / kiosk breakpoint, see issue #33. When the card
        is rendered above 900 CSS px of width (a dedicated dashboard
        view, kiosk panel, mobile portrait on tablet, ...), the chip
        text bumps one size step up so the value chips, the day-strip
        and the W/m² readout stay readable from across the room.

        The sun arc radius and the home chip cluster offsets are
        scaled separately by the engine (_heliosScale), so the
        on-map geometry expands in lockstep with this typography pass
        without overlapping the chip text.

        Container queries on ha-card (declared above) so a Helios
        card sitting in a wide section view alongside narrower cards
        flips on its own width, not on the viewport's. */
    @container helios-card (min-width: 900px)
    {
.pv-pct-label,
        .battery-pct-label,
        .grid-import-label,
        .grid-export-label,
        .solar-pct-label
        {
            font-size: 14px;
            padding: 4px 12px;
        }
ha-icon,
        .pv-pct-label ha-icon,
        .battery-pct-label ha-icon,
        .grid-import-label ha-icon,
        .grid-export-label ha-icon,
        .solar-pct-label ha-icon
        {
            --mdc-icon-size: 18px;
        }
        .tb-day-strip-cell
        {
            font-size: clamp(8px, 5.5cqw, 12px);
        }
        .tb-hover-tooltip
        {
            font-size: 13px;
        }
    }


`;
