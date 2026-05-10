# HELIOS — v1.1.0

Polish release — no breaking changes, no config migration required.

Headline changes since v1.0.0:

* **Catalogue placeholder redesigned.** Stylised iso scene
  (low-poly buildings + ground cloud disc + solar arc with the
  sun rendered ON the curve at 3/4 from the left). HELIOS
  wordmark centred horizontally and anchored at 65 % from the
  bottom of the placeholder.
* **Map style is now configurable** via the new `map-style`
  config (`'streets' | 'topo' | 'hybrid'`, defaults to
  `'streets'`). Hybrid renders MapTiler `hybrid-v4` (high-
  resolution satellite imagery + road / label overlays) with
  the existing sat-hires raster sharpening past zoom 15.
* **Card theme** (`card-theme: 'light' | 'dark'`) flips the
  card chrome (chips, charts, buttons, tooltips, scrub overlay)
  between a light skin (white plates / black ink, default) and
  a dark skin (near-black plates / soft white ink) so the card
  sits cleanly inside light or dark Home Assistant dashboards.
  The 3D basemap and the configured colour palette are
  unaffected.
* **Home-battery overlay.** Three new optional config keys
  (`battery-soc-entity`, `battery-power-entity`,
  `battery-color`) surface a State-of-Charge chip on the
  bottom-LEFT of the PV chip and a signed-Power chip on the
  bottom-RIGHT, connected to PV via L-shaped dotted polylines
  (vertical legs at 1/4 and 3/4 of PV's width respectively).
  The Power leader animates: dashes flow + a small SVG arrow
  travels from PV to Power while charging (positive value) and
  from Power back to PV while discharging (negative). Either
  entity is independently optional.
* **Cloud-cover chip** relocated to a fixed geographic point on
  the disc edge (east of the home in NH, west in SH — both
  project to screen-LEFT at each hemisphere's default bearing).
  Smooth tracking under rotation rather than the discrete
  "leftmost-of-N-samples" jumps of earlier revisions.
* **Camera locked, with ambient drift.** Rotation is the only
  remaining direct user input. When the user has been idle for
  more than 5 s, the camera slowly orbits the home in the
  opposite direction to the sun's apparent motion (1.5 °/s,
  decreasing bearing); any pinch / drag / wheel pauses the
  drift instantly and resumes from the user's bearing once
  they let go.
* **Battery scrub** — the chips follow the timeline: live mode
  reads from `hass.states`, past-scrub mode reads from a single
  `history/history_during_period` WS call covering both battery
  entities over the active range, future-scrub hides the
  battery overlay.
* **Solid chip surfaces** restored across light + dark themes —
  the brief 80 % translucent skin from the early betas was
  reverted to fully opaque chrome for crisper readings against
  the basemap.

i18n: `Translations.editor` gained six new keys
(`mapStyleHybrid`, `cardTheme`, `cardThemeHint`, `cardThemeLight`,
`cardThemeDark`, plus an `mapStyleStreet` / `mapStyleTopo`
already shipped in 1.0.x). Custom locales need to add them or
typecheck will fail.

The detailed beta changelog is preserved below — scroll past the
v1.0.0 section to read it in chronological order.

## v1.1.0-beta.1

* **Catalogue placeholder redesigned** — the previous "sunset sky
  with breathing sun" vignette was replaced by a stylised iso scene
  that mirrors the real card's vocabulary: ground cloud disc, two
  low-poly neighbouring buildings, a brighter central home, the
  orange solar arc with a pulsing sun + halo, and two leader chips
  (W/m² near the sun, kW near the home). Brand chrome (title /
  subtitle / CTA) repainted on a light day-mode sky gradient.

## v1.1.0-beta.2

* **Placeholder framing + text trimmed** — the SVG now uses
  `preserveAspectRatio="xMidYMid meet"` instead of `slice`, so the
  full scene (including the solar arc) stays visible on portrait
  card aspects rather than being cropped at the sides. The
  translucent "Set your MapTiler API key to activate" CTA panel
  was removed — the key requirement is documented in the README
  and shouldn't dominate the catalogue thumbnail. Title and
  subtitle now float on the gradient sky with no background plate;
  sizes and letter-spacing reduced for a lighter footprint.
* **Rotation pinned to the home** — `touchZoomRotate` is now
  enabled with `{ around: 'center' }`, locking the pinch-rotate
  pivot to the canvas centre instead of the centroid of the two
  fingers (which previously made the home orbit around the touch
  point, very visible on small cards). A defensive snap on every
  user-driven `rotate` / `move` event re-anchors the centre on the
  home coordinates if any sub-pixel drift accumulates from the
  bearing handler at zoom 18 / pitch 55°. Programmatic eases
  (gated on `originalEvent`) are not affected.
* **Chips lightened to 80 % opacity** — the chart card backgrounds
  (irradiance/cloud + PV graphs), the date/time chip, the "back to
  live" button (incl. hover/active states) and the three on-map
  readouts (cloud cover, PV production, solar irradiance) now use
  `rgba(255, 255, 255, 0.8)` so the map reads through without
  blurring the legibility of the values. Day-label chips on the
  chart midline stay fully opaque — they sit on the area chart and
  would lose contrast against the irradiance / cloud fills.

i18n: `placeholder.action` was removed from `Translations` and
all locale files. Custom locales pointing at the old shape will
fail typecheck and need that key deleted.

## v1.1.0-beta.3

* **Map style is now configurable** — a new `map-style` config
  key picks the MapTiler basemap. Two values are accepted:
  * `streets` *(default — same as previous releases)* — sober
    vector basemap suited to dense urban areas.
  * `topo` — topographic basemap with contour lines and softer
    earth tones, better in hilly / outdoor settings.

  Label visibility (`show-labels`) and the helios-buildings
  extrusion are independent of this choice — both layers are
  wired to custom sources, so 3D buildings render and labels
  toggle identically on both styles. The hillshade overlay
  (`topography-color` / `topography-alpha`) still renders on
  top of either basemap; on `topo` the basemap already carries
  some baked-in shading, so users may want to lower
  `topography-alpha` (default 0.65) if the cumulative effect
  feels too heavy.

  Switching styles at runtime (via the visual editor or by
  editing the YAML) reloads the basemap in place: terrain,
  hillshade, cloud disc, buildings and label visibility are
  re-applied automatically. The visual editor exposes a
  segmented toggle in the **Map** section.

i18n: `Translations.editor` gained four new keys (`mapStyle`,
`mapStyleHint`, `mapStyleStreet`, `mapStyleTopo`) used by the
new toggle. Custom locales need to provide them or typecheck
will fail.

## v1.1.0-beta.4

* **Home-battery overlay** — three new optional config keys
  expose a live battery chip below the home, mirroring the PV
  chip above. None are required; the chip appears as soon as
  at least one entity is set, and gracefully renders only the
  configured value when one of the two is missing:
  * `battery-soc-entity` — Home Assistant entity id of a
    numeric State-of-Charge sensor (% — typically with
    `device_class: "battery"`). Out-of-range values are
    clamped to `[0, 100]`.
  * `battery-power-entity` — Home Assistant entity id of a
    numeric power sensor (W or kW). Sign convention follows
    the entity itself; positive is interpreted as charging.
    Cumulative-energy sensors (Wh / kWh) are intentionally not
    accepted — the chip needs an instantaneous reading and we
    deliberately do not differentiate on the fly for battery,
    keeping this overlay simple.
  * `battery-color` — single colour reused on the chip border,
    text, icon and animated leader. Defaults to a vivid purple
    (`#9D6BCC`), distinct from sun (orange), cloud (blue) and
    PV (green).

  The chip displays the SoC and the signed instantaneous power
  bullet-separated (e.g. `85 % • +1.2 kW`). The leader line's
  flow direction follows the sign of the power: charging streams
  from the home down to the chip, discharging streams up from
  the chip to the home; zero or unconfigured power leaves the
  line static. Speed is mapped on the same scale as the PV
  leader (saturate at ~5 kW).

  Battery readings are pulled directly from `hass.states` on
  every Lit cycle — no history fetch. This keeps the overlay
  light, but means the chip is hidden while the timeline is
  being scrubbed (showing the live SoC against a past instant
  would be misleading).

i18n: `Translations.editor` gained seven new keys
(`batterySection`, `batteryHint`, `batterySocEntity`,
`batterySocEntityHelp`, `batteryPowerEntity`,
`batteryPowerEntityHelp`, `batteryColor`). Custom locales need
to provide them or typecheck will fail.

## v1.1.0-beta.5

Refinements on the home-battery overlay shipped in beta.4 plus
a small layout tidy-up.

* **Battery chip now follows the timeline scrub** — beta.4
  always showed the live SoC / power, even when the user
  scrubbed into the past, which was misleading (the chip read
  "now" against a past instant). The card now fetches a single
  `history/history_during_period` WS call covering both battery
  entities (when both are configured) over the active timeline
  range, and the chip resolves SoC and signed power at the
  scrubbed instant via a linear lookup (same pattern as the PV
  chip). The chip stays hidden in future scrub mode, where no
  battery data exists. The fetch is gated on a
  `(socEntity, powerEntity, range)` tuple so we don't reissue
  on every Lit cycle.
* **Cloud-cover chip relocated to the left of the disc** — the
  chip used to sit directly above the cloud disc, on the same
  vertical axis as the PV chip (also above the home) and the
  beta.4 battery chip (below the home), making the home column
  visually crowded. The chip now anchors to the screen-left
  edge of the disc, with its leader pointing horizontally to
  the disc edge instead of vertically. The implementation
  samples 12 points around the ground ring and picks the one
  with the smallest screen X, so the chip stays anchored to
  the screen-left even after rotation (a fixed geographic
  anchor would have landed on the wrong screen side under the
  default NH bearing of 180°).
* **Default battery colour changed from purple to red** —
  `DEFAULT_BATTERY_COLOR_HEX` flips from `#9D6BCC` to `#D32F2F`,
  better matching the "energy on draw" semantics of a battery
  reading and clearer next to the green PV chip and the orange
  sun. Users who set `battery-color` explicitly are unaffected.

`projectHomeLabelLayout` returns `ringEdge` instead of `ringTop`
(same shape, new semantics: the screen-leftmost point of the
100 % ring rather than its topmost point in geographic terms).
This is an internal contract between the engine and the card
and shouldn't affect anyone but custom forks.

## v1.1.0-beta.6

* **Battery overlay redesigned: two side-by-side chips, hooked
  off the PV chip** — beta.4 / beta.5 rendered a single
  combined chip (`85 % • +1.2 kW`) below the home with an
  animated leader to the home. The new layout splits the
  battery into one or two independent chips, each with its
  own icon, drawn down-right of the PV chip:
  * **Battery 1** — `mdi:battery` icon + SoC percentage when
    `battery-soc-entity` is configured. If the user only set
    `battery-power-entity`, this slot is repurposed for the
    Power chip (with `mdi:lightning-bolt`).
  * **Battery 2** — only rendered when both entities are
    configured. Shows the signed Power reading with
    `mdi:lightning-bolt`.
  * **L-shaped connector** from PV's bottom edge (≈ ¾ from the
    left) down to the centre-left of Battery 1. Solid hairline
    in the configured battery colour, no animation.
  * **Inter-battery connector** between the centre-right of
    Battery 1 and the centre-left of Battery 2 — dotted
    (`stroke-dasharray: 2 3`), same battery colour, no
    animation. Only rendered when both battery entities are
    configured.
  * **The home's vertical axis is free below the home now** —
    the chip used to live there in beta.4 / 5 but the new
    layout pulls all PV / battery readouts to the upper-right
    quadrant, leaving the home + cloud disc as the visual
    centre.

  The previous flow-direction animation (charging vs
  discharging) was dropped because it was hard to interpret
  visually. The information is still present in the signed
  power value (e.g. `+1.2 kW` vs `−800 W`).

Internal: `projectHomeLabelLayout` now returns `battery1Label`
and `battery2Label` instead of a single `batteryLabel`. The
`.battery-leader-line` / `.battery-leader-arrow` CSS classes
are gone, replaced by `.battery-l-line` (solid polyline) and
`.battery-pair-line` (dotted line). No public config keys
changed; existing dashboards keep working with no edits.

## v1.1.0-beta.7

* **Compact dotted L overlay + stable cloud chip on rotation** —
  small visual polish on the chip overlay introduced in beta.6.
  * The L connector from PV down to the battery row was scaled
    down (vertical and horizontal legs roughly halved) and the
    vertical leg now starts midway between PV's leader-line
    entry point and its right border, so the L reads as anchored
    to the chip rather than orbiting it.
  * The whole L is now dotted (same `stroke-dasharray: 2 3` as
    the inter-battery segment); the inter-battery line was
    flipped from horizontal to vertical so the SoC and Power
    chips stack instead of competing for horizontal real estate.
  * The cloud-cover chip used to follow the screen-leftmost edge
    of the disc using a 12-sample search, which made it teleport
    in 30° increments under camera rotation. It now anchors to a
    fixed geographic point on the disc edge (east in NH / west
    in SH — both project to screen-left at each hemisphere's
    default bearing) and slides smoothly with rotation, with the
    chip pushed radially outward from the home so it stays
    outside the disc at any bearing.

## v1.1.0-beta.8

* **Battery chip recombined into a single readout** — the two
  side-by-side chips from beta.6 / 7 (`mdi:battery 26 %` next to
  `mdi:lightning-bolt +3.00 kW`) are merged into a single combined
  chip showing `mdi:battery 26 % +3.00 kW`. Stacking the two
  values inside one chip removes the visual mismatch caused by
  their different content widths and frees up enough horizontal
  room to lengthen the L's horizontal leg, which now reads as a
  proper "pull" off the PV chip instead of a tight elbow.
* **Hybrid basemap** — `map-style` now accepts a third value,
  `hybrid`, which renders the MapTiler `hybrid-v4` map (high-
  resolution satellite imagery with road and label overlays) and
  enables the existing sat-hires raster layer for sharper imagery
  past zoom 15. Useful when the user wants real-world context
  (vegetation, rooftops, parking lots) under the solar overlay.
  Visual editor exposes a third button in the Map-style toggle.
* **Card theme (light / dark)** — new `card-theme` config
  (`'light' | 'dark'`, default `'light'`) flips the card chrome
  (chips, chart card, day labels, cursors, leader lines, live
  button, tooltips) between a light skin (white plates / black
  ink, unchanged) and a dark skin (near-black plates / soft
  white ink) so the card sits cleanly inside dark Home Assistant
  dashboards. The 3D basemap, the configured colour palette
  (sun, cloud, PV, battery) and the placeholder vignette are all
  unaffected — the theme is purely a CSS overlay applied via a
  `theme-light` / `theme-dark` class on the `<ha-card>` root.

i18n: `Translations.editor` gained five new keys (`mapStyleHybrid`,
`cardTheme`, `cardThemeHint`, `cardThemeLight`, `cardThemeDark`).
Custom locales need to provide them or typecheck will fail.

Internal: `projectHomeLabelLayout` now returns a single
`batteryLabel` instead of `battery1Label` / `battery2Label`. The
`.battery-pair-line` CSS class is removed. No public config keys
were removed; `card-theme` and the `'hybrid'` value of `map-style`
are additive.

## v1.1.0-beta.9

* **The home itself is now the battery gauge** — a substantial
  rework of the home-battery overlay introduced in beta.4.
  * **Neighbour buildings drop to 25 % opacity** (`helios-buildings`
    layer) so the home reads as the unambiguous focal point
    against a soft urban backdrop.
  * **A new `helios-home-fill` extrusion layer** re-paints just
    the home opaque in the configured battery colour, with a
    height scaled by the live SoC: empty battery → invisible
    fill (only the 25 % outline shows), 50 % → lower half of the
    home painted, 100 % → home fully painted. The fill is
    spatially anchored via a `within` filter on a 15 m square
    around the home coordinates — works for individual residential
    homes; very dense neighbourhoods may light up adjacent
    buildings as a known trade-off (see code comment).
  * **Hover the home for the exact percentage.** The fill's height
    encodes a coarse "how full" reading at a glance; mousing over
    the home opens a small SoC tooltip (`mdi:battery 73 %`) for
    the precise number, mirroring the cloud-disc tooltip pattern.
  * **The combined SoC + Power chip from beta.7 / 8 is gone.**
    SoC-only configurations now show no chip at all — the home
    fill carries the value. Power-only configurations show a
    chip at the top-right of the home with the signed
    instantaneous reading.
  * **Animated leader on the Power chip** — the chip is connected
    to the home by a dotted line whose dashes flow from home to
    chip while charging (positive power) and from chip to home
    while discharging (negative). The arrow follows the same
    direction. Speed scales with `|P|` saturating at ~5 kW, the
    same envelope as the PV leader.
* **Editor copy refreshed** for all seven locales to describe the
  new battery semantics (home-fill height ↔ SoC, hover tooltip,
  Power chip + animated leader, charging direction).

Internal: `helios-engine` gained `setBatterySoc(percent)` /
`setBatteryFillColor(hex)` public methods plus the
`onHomeBuildingHover` callback. `projectHomeLabelLayout`'s
`batteryLabel` was repositioned closer to the home and to the
top-right of it. The `.battery-l-line` CSS class was replaced
by `.battery-leader-line` (animated dotted, with a `-discharging`
modifier for the reversed flow direction).

No public config keys changed; existing dashboards keep working
with no edits.

## v1.1.0 (final)

Single visual fix on top of beta.13 before cutting the stable
release.

* **Solid chip surfaces.** Every on-map chip and timeline panel
  (cloud-cover, PV, battery SoC + Power, solar irradiance,
  date/time clock, "back to live" button, day labels, chart
  card) used to render on an 80 % translucent surface (light
  theme) / 82 % near-black (dark theme). The translucency
  helped a little against the basemap but consistently fought
  the values: numbers were softer, the three battery / PV
  chips read as different shades depending on what tile sat
  behind them. All surfaces are now fully opaque
  (`#ffffff` light / `#14161c` dark) with matching opaque
  hover / active states for the live button.

## v1.1.0-beta.13

Three small but visible fixes on top of beta.12.

* **Placeholder title raised.** `.ph-content`'s vertical anchor
  moved from `top: 50 %` to `top: 35 %` (≈ 65 % from the bottom)
  so HELIOS sits cleanly above the iso buildings rather than
  overlapping them in the middle of the placeholder.
* **Battery leaders are now L-shaped.** beta.12's straight
  horizontal lines never lined up visually because the chips
  were on the same horizontal axis as the PV chip. The two
  battery chips now sit BELOW PV (SoC bottom-left, Power
  bottom-right) and the connectors are SVG `<polyline>`s with
  one corner each:
    - SoC ↔ PV: inverted L (vertical leg drops from PV's
      bottom edge at 1/4 of the chip width = the LEFT
      quarter, then horizontal leg runs left to the SoC chip).
    - PV ↔ Power: regular L (vertical leg drops at 3/4 of the
      chip width = the RIGHT quarter, then horizontal leg
      runs right to the Power chip).
  The 1/4 / 3/4 anchor uses the chip's min-width (76 px → 19 px
  from centre) since chips are min-width-clamped in the common
  case. The Power L keeps its animated dashes + arrow whose
  direction tracks the sign of the live power; the SoC L
  stays static.
* **Auto-rotation reverted to simple drift.** beta.12's
  "tween back to the initial bearing after every user gesture"
  felt jerky in practice. The realign-to-initial logic and the
  `_autoRotateInitialBearing` / `_autoRotateUserMoved` fields
  are gone; the loop now does what beta.11 did (steady forward
  drift, paused for 5 s after every user gesture, resumed
  from the user's bearing) at the slightly faster speed
  introduced in beta.12 (1.5 °/s).

Internal: `projectHomeLabelLayout`'s `batterySocLabel` and
`batteryPowerLabel` y values now sit at `pvY + 40` (was `pvY`).
The `.battery-leader-line` CSS rule gained a
`stroke-linejoin: round` so the L corners read as a soft bend
rather than a sharp angle.

## v1.1.0-beta.12

Polish pass on top of beta.11: drops the never-quite-right
`building-color` config, simplifies the catalogue placeholder,
makes the auto-rotation more lively, equalises the visible
length of the battery leaders, and brings back the directional
flow arrow on the PV ↔ Power leader.

* **`building-color` removed.** The exposed config never produced
  a satisfying result (any tinted hue ate visual room from the
  chips and leaders) and the default neutral grey is what every
  use case actually wants. The config key is gone, the
  associated paint-property update path is gone, and the
  visual editor / i18n keys / docs no longer mention it. The
  buildings keep painting at `rgba(210,210,215,1)` with the
  75 % opacity from beta.11.
* **Placeholder stripped down to the wordmark.** beta.11's
  attempt to centre HELIOS while keeping the W/m² chip, the kW
  chip, the leaders, the divider and the subtitle ended up
  cramped. The thumbnail now keeps just the iso scene
  (low-poly buildings + ground cloud disc) and the solar arc
  with the sun on it (re-positioned to t = 0.75 of the Bezier
  → exact 3/4 from the left). Everything else is gone:
  no chips, no leaders, no divider, no subtitle. The HELIOS
  wordmark sits centred horizontally + vertically with a
  slightly larger font (1.85 rem, was 1.5).
* **Auto-rotation reworked.** The ambient drift is a touch
  faster (1 → 1.5 °/s) and now snaps gracefully back to the
  bearing the camera had at card load whenever the user has
  moved it: after 5 s of inactivity the rotation loop tweens
  the camera back to the initial bearing at ~30 °/s before
  resuming forward drift. So no matter how the user spun the
  camera around, it always slides back to the configured
  hemisphere-aware default a few seconds later.
* **Equal-length battery leaders.** The two dotted lines (SoC
  ↔ PV on the left, Power ↔ PV on the right) now read at the
  same visible length in the common case. Both PV and battery
  chips share a `min-width: 76 px` and `justify-content: center`
  so for typical values (small SoC %, small power values) the
  three chips have identical widths, leaving identical gaps
  for the leaders. Very wide power values may still grow their
  chip a few pixels, but the asymmetry is now barely
  perceptible.
* **Animated arrow back on the PV ↔ Power leader.** beta.11
  removed it; beta.12 brings it back with the previous
  charging / discharging direction encoding. Charging
  (positive power) → arrow flows from PV to the Power chip.
  Discharging (negative) → arrow flows back from the Power
  chip to PV. The dashes flow at a speed proportional to
  `|P|`, saturating at the same ~5 kW envelope as the PV
  leader. The SoC ↔ PV leader stays static (no animation)
  since SoC has no flow direction to encode.

i18n: `Translations.editor.buildingColor` removed. Custom
locales must drop that key.

Internal: `HeliosConfig['building-color']`, the
`DEFAULT_BUILDING_COLOR_HEX` export and `setBuildingColor`
method are gone. The buildings layer paints with the hard-
coded `rgba(210,210,215,1)` colour at minzoom 16 / opacity
0.75. The auto-rotation loop gained two private fields
(`_autoRotateInitialBearing`, `_autoRotateUserMoved`) and a
`AUTO_ROTATE_REALIGN_DEG_PER_SEC` constant. The
`.battery-leader-line-animated` and `.battery-leader-arrow`
CSS classes are back; `.battery-leader-discharging` is back as
the `animation-direction: reverse` modifier.

## v1.1.0-beta.11

Reverts the home-as-battery-readout experiment and reshapes the
battery overlay around two chips that flank the PV chip in
screen-space.

* **Home-fill removed.** The 3D home extrusion painted in the
  battery colour (beta.9 / 10) was hard to read in many real-
  world setups (large buildings, dense neighbourhoods, OSM
  footprints that don't match the actual home) and the
  query-and-overpaint plumbing was disproportionate to the
  visual payoff. All home-fill code, state, hover handling and
  the SoC tooltip are gone.
* **Building opacity restored to 75 %** with a new `building-color`
  config (default `#D2D2D7` — same neutral grey as before, just
  exposed). Lets users tint the urban backdrop to match their
  dashboard palette without touching the chip / leader colours.
* **Battery chips mirrored around the PV chip.** State of Charge
  on the LEFT of PV, signed Power on the RIGHT, on the same
  horizontal axis. Each chip is independently optional; the
  corresponding chip only renders when its entity is set. Both
  chips are connected to the PV chip with a short static dotted
  hairline (no animation, no arrow) — the sign of the power
  value is the only encoding for charging vs discharging.
* **Auto-rotation.** A new ambient animation: when the user is
  idle (5 s of no canvas interaction), the camera slowly orbits
  the home in the opposite direction to the sun's apparent
  motion (1 °/s in NH, decreasing bearing). Any pinch / drag /
  wheel pauses it instantly and it resumes after a few seconds
  of stillness. Time-based integration (per-frame `dt` against
  `performance.now`) keeps the speed constant across 60 / 120 Hz
  displays and survives tab-throttling cleanly.
* **Placeholder polish.** "HELIOS" is now centred horizontally
  AND vertically inside the catalogue thumbnail (was anchored
  at `bottom: 6%`). The subtitle font is smaller (0.55 rem,
  was 0.66 rem) with tighter letter-spacing (1.2 px, was
  2.5 px) and a hard 2-line clamp so it never pushes the title
  off-centre. The sun disc was moved from `(305, 110)` to
  `(297, 168)` so it sits on the arc curve rather than floating
  above it; the W/m² leader was nudged to start from the new
  sun position.

i18n: `Translations.editor` gained one new key (`buildingColor`).
Custom locales need to provide it or typecheck will fail. The
`batteryHint`, `batterySocEntityHelp` and `batteryPowerEntityHelp`
copy was rewritten in all seven locales to describe the new
flanking-chip behaviour.

Internal: `projectHomeLabelLayout` returns `batterySocLabel`
and `batteryPowerLabel` instead of a single `batteryLabel`. The
engine gained `setBuildingColor(hex)` (paint-only, no geometry
rebuild). The `setBatterySoc` / `setBatteryFillColor` / `onHome-
BuildingHover` / `helios-home-fill` / `helios-home-src` symbols
were removed. New private state on the engine drives the auto-
rotation loop (`_autoRotateRaf`, `_autoRotateLastFrame`,
`_autoRotateLastUserAction`).

No public config keys were removed; `building-color` is purely
additive. Existing dashboards keep working with no edits.

## v1.1.0-beta.10

Two bug fixes for beta.9.

* **Home-fill now actually paints the home.** beta.9 used a
  `['within', polygon]` filter on the building source-layer to
  isolate the home, but MapLibre 5's `within` expression only
  evaluates Point and LineString features (see `Within.evaluate`
  in `maplibre-gl-dev.js`); building polygons silently never
  match, so the layer existed but always rendered zero features.
  The home-fill is now driven by a custom GeoJSON source seeded
  with a 12 m × 12 m fallback square at the home coordinates,
  upgraded to the actual building footprint via
  `queryRenderedFeatures` on the first `idle` event after the
  tiles have rendered. The fallback guarantees something always
  paints; the upgrade matches the exact building shape when it's
  available in OSM. Closest-centroid disambiguation across the
  query box result picks the right polygon when several buildings
  overlap the search area.
* **Card no longer grows infinitely in panel-mode views.**
  MapLibre's stylesheet (`maplibre-gl/dist/maplibre-gl.css`) was
  never bundled, so the `.maplibregl-canvas { position: absolute }`
  rule never reached the shadow root. The canvas defaulted to
  `position: static` and participated in the layout flow: in HA
  panel views (where the parent container has no fixed height),
  the explicit pixel size MapLibre writes onto the canvas pushed
  the container, our ResizeObserver fired, MapLibre re-read a
  bigger container, and the layout cycle never converged. The
  stylesheet is now imported via Vite's `?inline` query suffix
  and inlined into the lit `css\`...\`` literal (using
  `unsafeCSS`), so the rules land *inside* the shadow root and
  the canvas stays out-of-flow regardless of how the parent
  sizes us.

---

# HELIOS — v1.0.0

This is the **first public release** of HELIOS. The card has been
under private development for several iterations; everything below
documents what ships in v1.0.0 as a single coherent package, the
project layout, and the steps to publish it on HACS.

---

## What HELIOS does

HELIOS is a Home Assistant Lovelace card that visualises solar
conditions at the user's home. The full picture sits on a single
3D MapLibre map:

* **Sun arc** — the sun's full 24 h trajectory across the sky,
  projected onto the screen with depth (thicker stroke when in
  front of the camera, thinner behind). Below-horizon segments
  render as discrete dots so "underground" portions of the arc are
  visible without competing with daylight ones.
* **Sun disc** — the live position on the arc. The inner fill
  scales with irradiance (full at 1 000 W/m², empty at night),
  conveying the W/m² reading geometrically.
* **Incidence ray** — dashed line from the sun to the home,
  animated to flow at a speed proportional to live irradiance.
* **Cloud cover disc** — a translucent disc on the ground, centred
  on the home, scaled by the live cloud-cover percentage and
  outlined in the configured cloud colour. A fixed black ring
  marks the 100 % reference.
* **Solar irradiance chip** — pinned above the sun disc, shows the
  live W/m² figure.
* **Cloud cover chip** — pinned just above the cloud disc, shows
  the live cloud %. Hovering the disc reveals a low/mid/high
  breakdown tooltip.
* **PV production chip** *(optional)* — when a `pv-power-entity`
  is configured, a chip pinned above the home shows the
  *instantaneous* production in W or kW. Cumulative-energy
  sensors (kWh) are differentiated automatically over a rolling
  60 s window. A leader line connects the chip to the home,
  animated to flow at a speed proportional to live production.
* **Date/time chip** — top-right corner, follows the timeline
  cursor (live or scrubbed).
* **Back-to-live button** — top-left corner, only visible while
  scrubbing.
* **Timeline** — bottom of the card, 5 days wide (2 past + today
  + 2 forecast). Dual-area chart with irradiance (top) and cloud
  cover (bottom) sharing a midline that doubles as a date axis
  (white-chip day labels). A second chart for PV production
  appears above when configured. Click or drag to scrub; the
  whole map reflects the selected instant in real time.

The map's hillshade is configurable in colour and strength, and
the sun / cloud / PV palette is fully editable. Nothing else on
the card is configurable — the design is intentionally opinionated
to keep visual coherence.

---

## Project structure

```
Helios/
├── .github/
│   └── workflows/
│       └── validate.yml             HACS validation
├── dist/                            Generated by `npm run build` — committed for HACS
│   └── helios.js                    Single bundle
├── src/
│   ├── helios-card.ts               Lit card class — composes everything
│   ├── helios-card-css.ts           Card styles (extracted for readability)
│   ├── helios-config.ts             Visual editor + color picker + config helpers
│   ├── helios-engine.ts             Map orchestration + projection + layers
│   ├── helios-sun.ts                Solar position + Haurwitz / Kasten-Czeplak math
│   ├── helios-weather.ts            Open-Meteo fetch + multi-model fusion + cache
│   └── i18n/
│       ├── index.ts                 Resolver + Translations interface
│       └── locales/
│           ├── en.ts                English (reference)
│           ├── fr.ts                French
│           ├── de.ts                German
│           ├── es.ts                Spanish
│           ├── it.ts                Italian
│           ├── nl.ts                Dutch
│           └── pt.ts                Portuguese
├── hacs.json                        HACS manifest
├── package.json
├── tsconfig.json
├── vite.config.ts
├── README.md                        User-facing docs
├── LICENSE                          MIT
└── MIGRATION.md                     This file
```

Each `src/helios-*.ts` file has a clearly bounded responsibility:

* **helios-card.ts** — top-level Lit element. Owns render(),
  state for the live readings, the timeline scrub, the PV state
  and the lifecycle hooks. Mostly composition; no heavy logic.
* **helios-card-css.ts** — single `css\`...\`` literal exported
  as `heliosCardStyles`. Imported once from the card.
* **helios-config.ts** — `<helios-card-editor>` (visual editor),
  `<helios-color-picker>` (custom palette+hex picker that side-
  steps the iOS Safari `<input type="color">` crash inside HA's
  nested Shadow DOM), plus `cfgHex` / `formatDate` helpers.
* **helios-engine.ts** — MapLibre setup, hillshade and night-
  shade layers, building extrusions, cloud-cover disc, screen-
  space projections (sun arc, sun disc, incidence ray, label
  positions). Holds the public API consumed by the card
  (`onWeatherUpdate`, `projectSunScene`, `setSelectedTime`,
  `getTimelineSeries`, etc.).
* **helios-sun.ts** — `getSunPosition`, `computePvPower`,
  `computeIrradianceWm2`. Pure functions; no DOM, no map. Used
  by the engine for the arc and the irradiance chip; usable in
  isolation for tests.
* **helios-weather.ts** — `fetchHomePointData` and friends:
  multi-model Open-Meteo fetch with median fusion, regional
  model selection, in-browser cache, and the 429 back-off
  schedule. No DOM, no map.

---

## Algorithms

### Solar position

`getSunPosition(date, lat, lon)` returns altitude / azimuth.
Implementation is the standard simplified declination + equation
of time, with one critical fix: the hour angle is normalised to
`[-180°, 180°]` before the AM/PM disambiguation. Without that
normalisation, longitudes far from Greenwich (NYC, Tokyo, Sydney)
produce `ha` outside the expected range and the AM/PM test yields
azimuths off by up to 180°.

Validated against the NOAA SPA reference across 376 (time, lat)
samples spanning a full year and 8 latitudes — mean altitude
error 0.30°, mean azimuth error 0.36°. The dominant residual
error source is the simplified `decl = 23.45 · sin(...)` formula,
intentionally kept for compactness; max altitude error (~1°) is
well below the visual fidelity required for the hillshade
direction or the W/m² estimate.

### Clear-sky GHI

Haurwitz (1945) — `GHI = 1098 · cos(z) · exp(-0.059 / cos(z))`
W/m². Already includes the diffuse component. Validated against
PVGIS / NREL benchmarks: MAE ~62 W/m² across altitudes from 5° to
90° (compared to ~139 W/m² for the simpler Meinel direct-only
model the project briefly used).

### Cloud attenuation

Kasten-Czeplak (1980) cubic — `k = 1 - 0.75 · (cloud/100)^3.4`.
Algebraically identical to the standard oktas formulation. Thin
clouds barely attenuate; total overcast cuts ~75 % of the GHI.

### Multi-model weather fusion

For each (variable, hour) the engine takes the **median** across
all queried models. Median over mean: individual models
occasionally emit gross outliers (typical case: cloud_cover_low
pegged at 100 % from the Sundqvist parametrisation hitting an
underground pressure level — open-meteo issue #416). The median
is robust to one bad model among N.

The model list is location-aware: ECMWF IFS 0.25° as global
fallback, plus the most accurate national / regional model for
the home coordinate (AROME-France, UKMO UK, DWD ICON-D2,
ItaliaMeteo, MET Nordic, NOAA HRRR, KMA LDPS, JMA MSM, BOM
ACCESS-G, ECMWF + GFS elsewhere).

### Effective cloud cover

The card replaces Open-Meteo's raw `cloud_cover` (satellite-view
total) with a layer-weighted figure that matches both ground
perception and shortwave attenuation:

```
effective = low + 0.6 · mid + 0.2 · high   (capped at 100 %)
```

High cirrus barely dim the sun yet would otherwise bump the raw
total to 80–90 % on otherwise clear days. The weighted form keeps
the cloud field as the single source of truth used everywhere
(timeline, on-ground disc, the PV power computation).

### PV instantaneous rate

For a power sensor (W/kW), the live state IS the instantaneous
rate.

For a cumulative-energy sensor (Wh/kWh), the card maintains a
5-minute rolling buffer of state samples and differentiates over
a ~60 s window:

```
rate = (E_now - E_60s_ago) / Δt   →  in W or kW
```

Resets are detected (Δ < 0) and ignored. When the entity hasn't
moved in 60 s+ — typical at night for an "energy today" sensor —
the rate is reported as 0 instead of falling back to the
cumulative total.

When the user scrubs into the past, the chip switches to a
history-derived rate computed from the two history samples
bracketing the scrubbed instant. The future half of the timeline
hides the chip (no PV data exists there yet).

---

## Configuration

```yaml
type: custom:helios-card
maptiler-api-key: YOUR_KEY_HERE     # required
```

| Key | Type | Default | Description |
|---|---|---|---|
| `maptiler-api-key` | string | — | Required. Free MapTiler key. |
| `topography-color` | hex | `#5064a0` | Hillshade tint. |
| `topography-alpha` | 0–1 | `0.65` | Hillshade strength. |
| `show-labels` | boolean | `true` | Toggle MapTiler street names, building numbers, POIs, place names. |
| `sun-color` | hex | `#EF9F27` | Sun disc + arc + irradiance area. |
| `cloud-color` | hex | `#5A8DC4` | On-ground disc + cloud area. |
| `pv-power-entity` | entity_id | — | Optional. Solar production sensor (W/kW or Wh/kWh). |
| `pv-color` | hex | `#27B36B` | PV chip + leader + dedicated graph. |
| `date-format` | string | `mm-dd` | Tokens: `yyyy`, `yy`, `mm`, `dd`. |
| `time-format` | `'12h' \| '24h'` | `'24h'` | 12-hour (AM/PM) vs 24-hour clock chip. |

Every field is editable visually; `pv-power-entity` uses an
`<ha-entity-picker>` filtered to power/energy sensors.

---

## Build & publish

```bash
npm install
npm run typecheck       # strict TS
npm run build           # produces dist/helios.js
```

To publish on HACS:

1. Make the GitHub repository public.
2. Set the repository description and topics (`home-assistant`,
   `lovelace-card`, `hacs`, `solar`, `weather`).
3. Commit `dist/helios.js` so HACS users without a build step
   get a working bundle.
4. Tag and create a GitHub Release (HACS needs a Release, not
   just a tag):
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
5. Then submit to https://github.com/hacs/default — or, in the
   meantime, add the repository as a Custom Repository inside
   HACS to install it directly.

---

## Known limitations

* **Equatorial azimuth** — peak ~9° error near the equator at
  the solstices because of the simplified declination formula.
  Acceptable for the visual hillshade direction; if higher
  precision is ever needed, swap in a NOAA-SPA implementation.
* **Building opacity is uniform.** Isolating the home building
  and rendering it fully opaque while keeping neighbours
  translucent is doable in concept (vector-tile feature-state)
  but MapLibre 5's `fill-extrusion-opacity` evaluates the data-
  driven branch silently to 0 when mixed with a zoom interpolate.
  All buildings ship at opacity 0.9 — visible enough that the
  home reads as a focal point next to the cloud disc and chips,
  even without isolation.
* **Standard-precision weather mode retired** — the v1.4 design
  always runs in multi-model "high" mode. Single-model output
  was visibly noisier (low-cloud pegs, cumulative-PV jumps) and
  the toggle was a footgun for users who didn't realise multi-
  model was strictly better.
