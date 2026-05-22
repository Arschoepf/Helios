# Changelog

All notable changes to HELIOS, grouped by theme rather than strict
added / changed / fixed buckets. Entries below the top one are
preserved from the in-tree history that used to live inside
`ARCHITECTURE.md`.

## v1.6.3-beta.13

Three follow-ups on the beta.12 live-card review.

* **Tomorrow card calibration tooltip can now paint above the
  battery card.** The beta.12 fix (transform: none in the entry
  keyframe) released the card's stacking context but the battery
  card next to it still painted on top because of natural DOM
  order. Robust fix : `.dash-card { position: relative }` + a
  `:has(.dash-stat-delta:hover, .dash-stat-refined:hover)`
  selector that lifts the hovered card to `z-index: 20` while
  the popover is visible. The whole card jumps above the sibling
  battery card, the tooltip rides along.
* **Day / night vertical separator lines on the dashboard today
  chart.** Two dotted lines at the sunrise + sunset X positions,
  same dashed recipe as the timeline's `.hc-day-sep`
  (`stroke: rgba(0, 0, 0, 0.30); stroke-dasharray: 1.5 2.5`),
  light + dark themes. The hatch says "this slice is night"; the
  dotted line marks the exact moment the sun crossed the horizon.
* **Shadow recompute coalesced during scrub.** Dragging the
  timeline cursor used to trigger a full LiDAR shadow paint per
  pointer-move event (raster paint + PNG encode + image-source
  update, ~10-40 ms each depending on `lidar-precision`); on a
  fast drag at high precision this stacked up and made the cursor
  visibly chase the pointer. Sweep now coalesces rapid
  setSelectedTime() calls into one shadow refresh per 100 ms.
  Light visuals (sun arc, PV chip, cloud disc) still update on
  every move; only the costly raster paint is deferred.

## v1.6.3-beta.12

Polish round on top of v1.6.3-beta.11. Mostly visual tweaks from
a live-card review + a real correctness fix uncovered by the
calibration-ratio audit.

### Visual

* **Day-strip date label bumped** (`clamp(9px, 11cqw, 13px)`, was
  `clamp(7px, 9cqw, 11px)`). kWh stays demoted at the smaller
  clamp so the date reads as the primary anchor.
* **Pitch range widened** from [25°, 75°] to [15°, 85°]. The user
  can dive nearly top-down (15°) or peek almost flat against the
  ground (85°) without ever passing through it.
* **Sunrise / sunset arc icons removed.** The drop-shadow stack
  from beta.11 turned the sun-coloured glyphs into outlined blobs
  the user found illegible, and the arc shape itself already
  signals "this is sunrise / sunset". One less overlay on the
  horizon line, the LiDAR shadows below it breathe again.
* **Chart curve strokes 1.0 → 0.7 px.** On high-variation days
  the 1.0 px line stacked over itself on every wobble and turned
  dense regions into a smudged band; 0.7 px reads as a hairline
  trace at any zoom.
* **LiDAR chip** label switched from the literal "LiDAR" to the
  i18n `lidarViewChipLabel` ("Vue LiDAR" / "LiDAR view" /
  "LiDAR-Ansicht" / ...). The combined cluster width then roughly
  matches the date / time chip on the opposite corner.
* **Night-hatch overlay on the dashboard today chart.** The
  vertical twilight lines + sunrise/sunset ha-icon glyphs are
  replaced with the same diagonal hatch pattern the timeline's
  `.hc-night-zone` uses. Same visual vocabulary across the card,
  one less competing signal at the horizon line.
* **Dashboard tomorrow-tooltip can now paint above the battery
  card.** The `.dash-card` entry animation ended on
  `transform: translateY(0)`, which left a non-`none` transform
  in place and trapped the tooltip in the tomorrow card's stacking
  context. Ending the animation on `transform: none` releases the
  context and lets the tooltip's z-index do its job.

### Correctness

* **Live PV forecast chip now uses the 5-day calibration ratio.**
  The chip (when scrubbing into the future) was the one consumer
  of `pvCalibK × computePvPowerWeighted` that hadn't been wired to
  `cal.ratio`, so it could read 30 W above or below the dotted
  forecast curve and the hover tooltip at the same scrub instant.
  Same ratio everywhere now, the readouts agree.

### Repo housekeeping

* **GitHub repo description updated.** HACS reads the repo's
  `description` field for its list view; the old "real-time 3D
  solar energy and cloud coverage visualization card" text was
  pre-1.6 and didn't mention LiDAR or PV forecast. Refreshed to
  match what the card actually does.

## v1.6.3-beta.11

Polish round on top of v1.6.3-beta.10, picked up from a real-card
review session. Mostly config + perf knobs plus a couple of small
correctness fixes.

### LiDAR shadow weight tied to `lidar-precision`

The beta.10 sharpness bump (2048×2048 mask + smaller convex hulls)
was effective but the 4× memory + ~40 ms PNG encode wasn't always
worth it on a phone or a multi-card dashboard. The shadow raster
size now depends on the user's existing `lidar-precision` knob:

* `low` and `medium` (default) , 1024×1024, ~10 ms encode. Same
  perf as v1.6.2 for the median user.
* `high` , 2048×2048, ~40 ms encode. Opt-in sharpness for desktops
  showing a single card.

The cluster cap improvement (80 cells max, was 400) stays on
everywhere , it's the cheaper half of the quality win.

### Per-string `peak-kwp` + inverter PMax (config)

Following community feedback that `share` was confusing ("you
already know the kWp per string, why am I converting to a
percentage?"), the PV config now supports a per-array peak-kWp
field. When any `pv-arrays[].peak-kwp` is set, the total install
power is the sum of those values and the legacy top-level
`pv-peak-kwp` is ignored. Existing configs (share + global
peak-kwp) keep working unchanged through the share-based path.

New top-level `pv-inverter-max-kw` clips the forecast at the
inverter's nameplate so an over-sized DC array hooked to a
smaller inverter (typical European 6.4 kWp panels / 5 kW inverter
pairing) doesn't draw a forecast peak above the hardware ceiling.
Applies to the dotted predicted curve, the day-strip kWh totals,
the live forecast chip and the hover tooltip. Live observation is
unaffected , the inverter already clips in hardware before the
entity reports its value. Editor surfaces both fields with full
i18n across the 8 supported locales.

### Camera now pitches as well as rotates

Vertical drag on the canvas tilts the camera; horizontal drag
keeps the existing bearing-rotation behaviour. Pitch is clamped to
[25°, 75°] so the camera can never look past the ground or
collapse into a flat overhead. Mouse left-drag + single-finger
touch both work; two-finger pinch-rotate stays with MapLibre's
built-in handler.

### Smaller polish

* Live PV chip above the home now floors at zero like the tooltip
  did in beta.7. Net-meter sensors that briefly dip negative
  around dawn / dusk no longer surface as "-2 W of production".
* Sunrise / sunset glyphs on the solar arc gained a strong drop-
  shadow stack so they read against the LiDAR shadow blobs at the
  horizon line. Dark theme flips the inner ring to white-on-dark.
* Neighbour-building outlines dropped. The 1 px black line at 0.35
  opacity drawn around every surrounding building piled up
  visually on dense streets and competed with the LiDAR shadows;
  the home outline stays, the rest go quiet.
* Chart curve strokes thinned from 1.4 px to 1.0 px so the line
  reads as a curve rather than a ribbon on the now-balanced
  48 px chart cards.

## v1.6.3-beta.10

Iterative pre-release on top of v1.6.3-beta.9. Three sharpening
tweaks on the rendered scene.

* **Sharper LiDAR cast shadows.** Two changes compound:
  - Shadow raster bumped from 1024 to 2048 pixels per side, so
    each pixel of the cast-shadow mask covers ~ 1 m at the worst-
    case 2 km bbox instead of ~ 2 m. Mask edges no longer get
    bilinearly smeared when MapLibre downscales the source to
    screen size.
  - Flood-fill clump target dropped from 80 m² to 16 m², and the
    upper cap from 400 cells to 80 cells. Each clump is then
    summarised by a smaller convex hull that traces irregular
    shapes (L-roofs, zigzagging tree rows) much closer to their
    real outline, removing the "smudged blob" look on dense
    forest + dense roof scenes. PNG encode goes from ~ 10 ms to
    ~ 40 ms per shadow refresh, still comfortably under the sun
    movement cadence that drives refreshes (5 min in live mode).
* **PV anchor ring sits behind the home silhouette.** Drawn in
  its own SVG layer with an SVG mask built from the same screen-
  space silhouette polygons the home-glow uses. The mask paints
  white everywhere and black over the projected building, so the
  back arc of the ring (the half occluded by the 3D extrusion)
  is hidden. The ring now reads as a ground footprint the
  building stands inside, improving the perspective without
  routing the ring through MapLibre's layer stack.

## v1.6.3-beta.9

Final pre-release on top of v1.6.3-beta.8 before the 1.6.3 GA.
Major correctness fix on the LiDAR shading + a polish pass on the
timeline UI bits introduced earlier in the beta line.

### Terrain-aware LiDAR shading

The ray-march in `pv-shading.ts` was treating every cell of the
nDSM as if the ground at that cell were at the same elevation as
the ground under the panel. On flat installs this is fine; on a
hillside it's systematically wrong, a 5 m building 50 m east of
a home on terrain that rises 8 m read as a 5 m obstacle when its
real projected height in the panel's frame is 13 m, so the model
under-counted shading at low sun angles. Conversely, the same
building on terrain that drops 8 m got over-counted as 5 m of
obstruction when it should have been read as -3 m and ignored.

The helios-lidar.org pipeline (v1.6.3) now ships a 2-band COG
(band 1 = nDSM as before, band 2 = DTM = ground elevation). The
card's local-nDSM loader reads both bands, and the ray-march
lifts its comparison into absolute Z so terrain slope between
the panel and a far obstacle is correctly accounted for. Public
providers (IGN, Defra, PDOK, ...) keep their existing single-band
WCS layers; they fall through to the flat-ground geometry that
was the v1.6.2 default. Legacy single-band local COGs already
deployed at users also keep working unchanged. Re-running the
LAZ on helios-lidar.org produces a new 2-band file users on
sloped terrain can drop in for the corrected math.

### PV tooltip stale-value fix

Hovering a future instant on the timeline used to read out
the last observed PV value clamped forward, so the tooltip
showed "3 W" for noon tomorrow because that was the panel's
reading at 16:00 yesterday. The observed-history path now
explicitly cuts off at the last observed timestamp; instants
beyond fall through to the forecast model, which is what the
tooltip is supposed to show in the future window anyway.

### UI polish from beta.8 review

* **PV home-anchor halved + ringified.** Dropped from a 5 m
  filled disc to a 2.5 m stroked ring around the home. Stays
  perspective-projected (flat on the ground, aplated by pitch),
  the home silhouette is now fully visible inside.
* **Day strip restored kWh visibility.** Container query
  threshold dropped from 90 px to 55 px and the font-size clamp
  lowered to `clamp(7px, 9cqw, 11px)` so kWh shows on every
  reasonable cell width including 4-day mobile views.
* **Day-strip separators match the chart's.** The 1 px vertical
  line between cells now uses the same dotted recipe as the
  chart cards' `.hc-day-sep` (alpha 0.30, dash 1.5 / 2.5),
  light + dark themes.

### Cleanup

`noUnusedLocals` + `noUnusedParameters` were already on in
`tsconfig.json` and the full typecheck passes clean; no stale
imports or references to removed UI elements remain. README +
ARCHITECTURE.md updated for the new terrain-aware shading +
companion COG format.

## v1.6.3-beta.8

Iterative pre-release on top of v1.6.3-beta.7.

* **PV home-anchor is now a perspective-projected ground disc.**
  Was a screen-space `<circle>`; replaced with a polygon sampled
  from 48 points on a 5 m world-coordinate circle around the home,
  projected through the same camera matrices the rest of the map
  uses. The disc lies flat on the ground at the home, aplated by
  pitch and rotated by bearing, so it reads as part of the scene
  rather than a UI sticker. The bead arrival pulse still scales
  the polygon 1 -> 1.55 -> 1 around the home centre.
* **Day-strip respects the dark theme.** Plate background pulls
  the same `#1f2021` as the other dark chips, cell text switches
  to the pale ink and the vertical separators take the chip-frame
  alpha so the strip reads as one cohesive component in either
  mode.
* **Day-strip cells size their text to the available width.** Each
  cell is its own size container; the date + kWh font scales via
  `clamp(8px, 11cqw, 11px)` and the kWh row drops below 90 px of
  cell width so a 4-day mobile view doesn't stack the two strings
  on top of each other.
* **Below-horizon sun arc dimmed.** The dotted underground leg of
  the day-arc kept the same stroke-alpha as the daylight portion;
  dropped to 0.45 on the colour stroke + 0.25 on the outline so
  the dotted leg reads as ambient context, not foreground motion.

## v1.6.3-beta.7

Iterative pre-release on top of v1.6.3-beta.6. Third polish round
+ a behaviour change on the forecast curves.

* **Forecast curves now use the calibration ratio.** The dotted
  forecast line on the PV chart, the per-day chip kWh totals and
  the hover tooltip's PV value all multiply through the 5-day
  rolling forecast calibration ratio, the same value the
  dashboard's "refined" headline shows. The curve, the chips and
  the dashboard number stay in lock-step instead of one of them
  silently using the raw model.
* **Tooltip PV is forced to zero when the sun is below the
  horizon.** Catches stale observed samples that linger into the
  night, inverter standby readings, and forecast bracketing pairs
  that interpolate across sunrise / sunset.
* **Day chips replaced by a single day strip.** One bordered bar
  spanning the timeline width, with each day's date label centred
  on its segment and a 1 px vertical line at every midnight
  boundary. Same border / radius / shadow recipe as the chart
  cards above it.
* **Chart area fills dropped to 0.25 alpha** (was 0.5) on
  irradiance, cloud cover and PV. Curves themselves (the stroked
  lines) stay at full punch; only the wash under them softens.
* **Scrub-cursor white halo removed.** The 1 px white outline
  added in beta.6 turned out to be more distracting than helpful.
  Scrub cursor is back to its plain 2 px blue plate.

## v1.6.3-beta.6

Iterative pre-release on top of v1.6.3-beta.5. Second polish
round on the timeline.

* **Future-portion wash on both chart cards.** A semi-opaque
  overlay anchored to "now" stretches to the right edge of each
  card, fading the irradiance, cloud and PV curves, the night-zone
  hatch and the card background in one pass. Past stays at full
  punch; forecast reads as forecast.
* **Night-zone hatch and edges dropped to 0.04 alpha** (0.06 in
  dark mode). Combined with the future-mask wash above, the night
  windows now ride underneath the curves instead of competing for
  attention.
* **Tooltip now follows touch drags on mobile.** The scrub handler
  writes `_chartHoverPct` in lock-step with `_selectedTime`, so
  the tooltip + per-curve dots track a finger drag exactly the
  way a mouse hover does on desktop. Cleared on pointer release.
* **PV readout clamps negative values to zero.** Net-meter
  entities can briefly dip negative around dawn / dusk; the
  tooltip now shows 0 W instead of "-2 W".
* **Day-label chips a touch bigger.** Font 9 px -> 11 px, padding
  +1 px on each axis, container row 18 px -> 22 px so the chip
  ring still fits comfortably.
* **Live + scrub cursors more readable through the wash.** Live
  cursor is now 2 px (was 1 px) at 0.65 alpha (was 0.45) with a
  slightly larger triangle handle on top. Scrub cursor keeps its
  blue plate but gains a 1 px white halo so it pops out of the
  faded forecast region and the night-zone hatch underneath.

## v1.6.3-beta.5

Iterative pre-release on top of v1.6.3-beta.4. UX polish round
on the timeline + LiDAR cluster.

* **Balanced chart-card stack.** Production chart raised from 32 px
  to 48 px and the irradiance + cloud chart lowered from 64 px to
  48 px. Both cards now share the same height and the combined
  block keeps the same total footprint, so production reads as a
  first-class series rather than a sparkline below the main chart.
* **Tooltip glyphs replace the colour dots.** Each row now leads
  with an MDI icon coloured to its series: `mdi:white-balance-sunny`
  for irradiance, `mdi:cloud-outline` for cloud cover,
  `mdi:flash` for PV. Easier to scan at a glance than the
  generic dots.
* **Map zoom locked again.** Both `minZoom` and `maxZoom` are now
  18, scroll-zoom disabled, and the wheel-zoom-rate tuning block
  removed. The 3D camera + LiDAR overlay are pose-locked to that
  altitude and the optional `[17, 18]` range from beta.1 only
  invited "why does my card look different" screenshots.
* **LiDAR chip is now a button too.** Both the chip and the
  toggle button share the same click handler, so users can press
  either half of the cluster to toggle LiDAR view. Same disabled
  state when no provider covers the home.
* **Night-zone overlay calmed down.** Hatch alpha dropped (0.11 -&gt;
  0.07 light, 0.14 -&gt; 0.10 dark) and the sunset / sunrise edges
  now share the exact same RGBA as the hatch fill, so the
  boundary lines read as the densest part of the hatch rather
  than as separate, eye-catching markers.

## v1.6.3-beta.4

Iterative pre-release on top of v1.6.3-beta.3.

* **Hover tooltip on the timeline charts.** Moving the pointer
  over either chart card now renders a vertical guide line +
  three colour-coded dots (irradiance, cloud cover, PV) at the
  cursor position, with a tooltip chip pinned above the cards
  showing the timestamp + each value in its native unit. The PV
  row is skipped silently when no `pv-power-entity` is wired up,
  so the tooltip stays useful in forecast-only setups.
* **Night-zone edges.** Each diagonal-hatched night window now
  carries a thin vertical edge on its sunset (left) and sunrise
  (right) boundaries, so the dusk and dawn transitions read as
  precise events rather than fuzzy bands.
* **LiDAR cluster seam fix.** The chip + toggle button pair sits
  on a `row-reverse` rail, but the radii were still rounded as if
  the chip were on the right: the seam showed a visible curve on
  both sides. Chip now keeps its rounded LEFT corners only, the
  button keeps its rounded RIGHT corners only, and the button
  drops its left border so the chip's right border is the shared
  seam.

## v1.6.3-beta.3

Hotfix pre-release on top of v1.6.3-beta.2. Two follow-ups from
field testing.

* **Night zones on the timeline.** Each "sunset of day N to
  sunrise of day N+1" window on the visible range now renders as
  a diagonal hatch overlay on top of both the irradiance + cloud
  card and the PV card. The hatching reads as "this slice is
  night" at a glance without obscuring the underlying curves, and
  replaces the beta.2 sun-up / sun-down glyph + dotted vertical
  line treatment (too busy at a glance).
* **LiDAR-view toggle visibility fix.** A stray HTML comment in
  the card template was terminated with `*/` instead of `-->`,
  swallowing the entire top-right LiDAR cluster on render. The
  button is back even when no provider covers the home, in its
  disabled `mdi:cloud-off-outline` state.

## v1.6.3-beta.2

Iterative pre-release on top of v1.6.3-beta.1.

* **Sun-event markers on the timeline.** *(Removed in beta.3 in
  favour of full night-zone hatched overlays.)* Each day inside
  the visible range got two faint vertical dotted lines, one at
  sunrise and one at sunset, capped above the chart card with a
  `mdi:weather-sunset-up` / `mdi:weather-sunset-down` glyph.
* **PV array marker redesign.** A `pv-arrays` entry that carries
  its own coordinates used to render as a single icon at the
  configured lat / lon, which left the user guessing where the
  icon was actually pointing on the ground. The marker is now a
  three-piece "lollipop": a small filled sphere sitting at the
  literal ground coordinate, a thin dotted leader rising above it,
  and the existing solar-panel icon lifted ~2 m above the ground
  on top. All three pieces share the configured PV colour.
* **Map zoom rate.** The MapLibre scroll-wheel zoom rate was
  raised from its world-scale default to one tuned for the card's
  tight `[17, 18]` range, so a single wheel notch traverses the
  visible zoom instead of trickling out over a dozen notches.
* **Timeline anchoring.** The timeline drops 2 px lower against
  the card bottom and the day-chip row's symmetric inset above
  and below leaves it visually centred between the chart's bottom
  edge and the card's bottom edge.
* **Thermal-derating defaults softened.** `γ_pmp` lowered from
  -0.0040 to -0.0035 /°C and NOCT from 45 to 44 °C, both at the
  middle of the modern monocrystalline range instead of the
  legacy textbook values. Trims roughly two percentage points
  off the summer-noon thermal derating; the rolling forecast
  calibration absorbs the residual.

---

## v1.6.3-beta.1

Pre-release on top of v1.6.2 with four UI / UX iterations on the
card chrome and the timeline chart.

### LiDAR-view toggle, redesigned

The top-right `LiDAR` chip used to be a single button that vanished
entirely when no LiDAR provider covered the home. It is now a
two-element cluster mirroring the top-left clock + scrub-return
pair: a passive `LiDAR` status chip on the right with a 22 x 22
toggle button fused to its left edge. The button is **always
rendered** with one of three coverage states, set by the engine
at render time:

* No provider matches the home, `mdi:cloud-off-outline` icon,
  button disabled (faded, no hover effect, click ignored).
* Public online provider matches, `mdi:earth` icon, button active,
  click toggles LiDAR view.
* Local-nDSM provider configured + covering the home,
  `mdi:harddisk` icon, button active, click toggles LiDAR view.
  The harddisk glyph signals at a glance that the user is on
  their own data.

When LiDAR view is active, both halves of the cluster flip to the
same scrub-blue plate the clock chip + back-to-live button take
when scrubbing the timeline, so the pair doubles as the "you're in
LiDAR view" signal the same way the clock signals "you're
scrubbing". Dropped the conditional render gating.

### Timeline cleanup

* **Cloud-cover curve un-mirrored.** The chart now shares a single
  bottom baseline: both irradiance (0..1000 W/m²) and cloud cover
  (0..100 %) grow upward from `y = H` to `y = 0`. The old "sun
  pushes up / cloud presses down" mirror split is gone. Cloud
  paints first as the background fill, irradiance on top, both at
  50 % alpha so the two curves coexist without competing for pixel
  rows. The day-separator dotted lines and the chart card frame
  are unchanged.
* **Day-label chips moved below the chart.** The white `Wed · 8.4
  kWh` chips used to overlay the chart's midline; they now sit as
  a separate row directly below the chart card (4 px breathing
  gap), so they never cover the curves they're labelling. Each
  chip still anchors to its date column via `left: <pct>%`.

### Map zoom

The pinch / scroll zoom is back, gated to a `[17, 18]` range. The
camera resting pose stays at zoom 18 (the same as before); the
user can pinch / scroll out by one MapLibre step (zoom 17) to see
one block of context around the home, but cannot zoom in past the
resting pose, the 3D camera + LiDAR overlay are tuned for that
single altitude. Detail mode separately raises the cap to 19.5
for its dive animation and restores 18 on exit.

---

## v1.6.2

Precision release on top of v1.6.1: two upgrades to the PV
prediction model and one UI cleanup on the LiDAR-View toggle. No
breaking changes, every existing config keeps working unchanged.

### PV thermal derating

The PV forecast now accounts for the cell temperature climb under
sun and the convective cooling under wind, using the classic
Sandia / NOCT pipeline:

* The Open-Meteo fetch now pulls `temperature_2m` + `wind_speed_10m`
  alongside the existing cloud + shortwave variables.
* Cell temperature is estimated with `T_cell = T_air + (NOCT − 20) /
  800 W/m² × GHI − 1.5 × wind`, then the output is derated by
  `1 + γ_pmp × (T_cell − 25)` with γ_pmp = −0.0040 /°C (the typical
  monocrystalline silicon coefficient).
* Plumbed through every PV computation site: live chip, scrub
  preview, dashboard "today" / "tomorrow" graphs, forecast
  calibration. On a hot summer noon at 35 °C ambient and ~900 W/m²
  the derating reduces the predicted peak by ~13 %, which is the
  bulk of the model bias the rolling calibration ratio was
  previously absorbing as a flat multiplier.
* Falls back cleanly when the model didn't return temperature or
  wind: multiplier stays at 1 and the forecast reduces bit-for-bit
  to the previous Haurwitz + Liu-Jordan output.

### LiDAR-aware shading on the PV forecast

When a LiDAR provider covers the home (or a BYO local-nDSM raster
is configured), the PV forecast ray-marches from each PV array
along the sun direction and zeroes the direct-beam component on
arrays whose line-of-sight to the sun is blocked by a building or
tree. The diffuse + ground-reflected components are kept (an
obstacle blocks the sun ray but not the upper hemisphere of sky),
so a shaded panel doesn't drop to zero, just to the ~25-30 % of
clear-sky output the diffuse + reflected terms contribute.

* New `height` field per entry in `pv-arrays` (metres above ground,
  default 5). Used as the ray's starting altitude so a panel on a
  first-floor roof clears a low fence the same-orientation
  ground-mounted array would sit in the shadow of.
* Bilinear sample of the loaded nDSM, 2 m step, 200 m max reach.
  Same buffer the LiDAR View overlay paints, no extra fetch.
* For installs with `pv-arrays` declared at distinct coordinates,
  each entry is shaded independently. So a roof-east array can be
  shaded by a tall neighbour at 8 am while the roof-west array on
  the same property is fully lit.
* Skipped silently when no LiDAR raster is loaded (no providers
  match the home, no BYO nDSM configured), so installs outside
  LiDAR coverage continue to produce the legacy forecast.

### LiDAR-View toggle visual cleanup

The toggle chip on the top-right rail now mirrors the date chip on
the opposite rail exactly: 12 px Roboto 600, line-height 1.2,
padding 2 px 8 px, 22 px tall, mixed-case `LiDAR` label. The 1.6.1
chip used 11 px uppercase Roboto with `line-height: 1`, which left
zero slack for the font's natural cap-height asymmetry; the visible
glyph centre drifted up or down against the icon depending on the
browser (Chromium, Firefox and WebKit each shifted it by a
different fraction of a px). The new recipe centres consistently
across every engine, the same way the date chip has always done.

### Notes for users

The new fields are opt-in but the temperature derating activates
automatically as soon as v1.6.2 is installed, since the weather
fetch starts pulling temperature + wind without any config change.
Expect the forecast to read **a few percent lower** at the midday
peak on hot clear days and a few percent higher on cold clear
winter days; the self-calibration ratio will absorb the residual
within a few sunny days.

For LiDAR-aware shading to kick in, the home needs to be inside a
LiDAR provider's coverage (one of the 10 native providers shipped
with the card, or a BYO local-nDSM via the `lidar-local-ndsm-*`
keys). Outside coverage, the forecast falls back to the existing
geometry-only model.

The companion site [helios-lidar.org](https://helios-lidar.org) is
also bumped to 1.6.2 in lock-step.

---

## v1.6.1

Hotfix on top of v1.6.0 addressing two visible bugs surfaced by
community feedback on the Reddit launch thread. Scope deliberately
kept tight; LiDAR coverage expansion and other feature work moves
to v1.7.

### Fixes

* **Refined-forecast tooltip clipping** ,
  [#16](https://github.com/ReikanYsora/Helios/issues/16). The
  hover explanation behind the "→ X kWh affiné" chip on the
  AUJOURD'HUI and DEMAIN dashboard cards used the same horizontal
  anchor on both layouts, which only fit the AUJOURD'HUI
  two-column headline. The DEMAIN headline is a single
  left-aligned column, so the chip sits on the left and the
  tooltip extended past the card's left edge into ha-card's
  overflow clip. Each card now anchors its tooltip on the side
  opposite the chip so it grows into the card interior:
  `.dash-card.dash-today .dash-stat-refined::after { right: 0 }`
  and `.dash-card.dash-tomorrow .dash-stat-refined::after { left:
  0 }`.
* **Black-map after location change on Firefox**, when the user
  switches `home-latitude` / `home-longitude` in the editor
  preview on Firefox, the previous MapLibre engine's WebGL
  context wasn't fully released by the time the next engine tried
  to bind one, yielding a black canvas. Engine init now waits one
  animation frame between cleanup and new MapLibre allocation
  when there was a previous engine, giving Firefox time to
  release the context. No effect on Chrome (the extra 16 ms sits
  inside the existing 500 ms editor debounce).

## v1.6.0

The biggest iteration since the OpenFreeMap migration. Three
headline tracks: a GPU-resident LiDAR View overlay, a complete
dashboard rework with a learning forecast, and a card-wide
architecture split that broke the two ~5k-line monoliths into
focused subsystem modules. Plus per-array PV configuration (with
optional GPS), a reset cache control, a new German LiDAR provider,
external solar-radiation sensor input, and a long list of editor
polish.

### Highlights

* **Forecast calibration**. The dashboard learns from the last 5
  completed days how the model under- or over-predicts your
  installation and surfaces a refined value beside each PRÉVU
  figure with a hover hint that spells out the calibration window
  ("→ 18.2 kWh refined (-8 %)"). Window clamps the multiplier to
  ±50 %, falls back silently when fewer than 2 past days carry
  enough production to derive a stable ratio, and never publishes
  anything until the historical fetch has landed.
* **Dashboard rework**. The detail-mode panel is rebuilt around
  three responsive sections: Today (produced + refined forecast +
  dual peak readouts + cumulative chart with sunrise / sunset
  markers + live now cursor + smart-positioned hover tooltip),
  Tomorrow (full-day forecast + peak hour, side by side with
  Battery when configured, full width otherwise) and Battery
  (vessel + charge / discharge totals). Date chips next to
  AUJOURD'HUI / DEMAIN confirm the two pure-forecast cards cover
  different days.
* **LiDAR View overlay**. A WebGL custom layer paints every loaded
  LiDAR cell as a small dot in screen space, optionally with a
  wireframe overlay. GPU-resident, re-rasterised by MapLibre on
  every transform with no JS-side redraw, so panning and rotating
  through a dense forest stay smooth. Distance fade, theme-aware
  colours, configurable display radius, soft enter / exit
  transitions with a scanner pulse on activation.
* **Architecture refactor**. `helios-card.ts` (5218 lines) and
  `helios-engine.ts` (4437 lines) were split into focused modules
  under `src/card/` and `src/engine/`, each owning one piece of
  functionality (data fetch, render, input, util, lifecycle on the
  card side; physics, geometry, animation, layer on the engine
  side). The two top-level files now act as orchestrators that
  delegate to their subsystems through small structural host
  interfaces. Lit reactivity stays natural, no service classes, no
  mixin gymnastics, no `requestUpdate()` ceremony.

### PV configuration

* **Per-array GPS coordinates**. Each entry in `pv-arrays` accepts
  optional `latitude` / `longitude` fields. When set and different
  from the home (> 10 m), the forecast model runs at the panel's
  true coordinates and a small solar-panel icon in the configured
  PV colour appears on the map at that position. Useful for ground-
  mounted arrays in a clearing while the home itself sits under
  trees.
* **Multi-orientation PV layout** (`pv-arrays`). One YAML entry per
  group of co-oriented panels (`tilt`, `azimuth`, `share`).
  Forecast model evaluates each entry separately and weights by its
  share, so split-array installs (east + west rows, roof + balcony,
  three-pitch roofs) get a correct prediction instead of the
  single-orientation approximation. Shares auto-normalise so 50/50,
  60/60 and 1/1 all produce the same forecast. Visual editor
  exposes a repeatable section with `+ Add row` / `Remove` and
  renameable rows; legacy `pv-tilt` / `pv-azimuth` keep working
  unchanged. Closes [#8](https://github.com/ReikanYsora/Helios/issues/8),
  contributed by [@i6media](https://github.com/i6media) in
  [PR #10](https://github.com/ReikanYsora/Helios/pull/10).
* **Battery power sign toggle**. New `battery-power-invert` config
  option multiplies live + historical battery power by -1 before
  storage, so installs where the upstream entity reports charging
  as negative (some GivEnergy / GivTCP setups) align with Helios's
  internal "positive = charging" convention without a template
  sensor in front.

### LiDAR

* **Germany (NRW) provider**. Geobasis NRW publishes a pre-computed
  nDOM raster via WCS GeoTIFF, covering Nordrhein-Westfalen
  (~18M people). Single fetch, routes through the same shared
  pipeline as every other provider.
* **Poland (GUGiK NMPT) provider**. National pre-computed DSM via
  WCS 2.0.1, GeoTIFF Float32, EPSG:4326 natively supported (no
  reprojection round-trip). ~38M people. Single fetch.
* **Canada (NRCan HRDEM Mosaic) provider**. National DSM coverage
  via GeoServer WCS 1.1.1. 1-2 m LiDAR-derived in the populated
  south, satellite-derived further north. ~38M people. Single
  fetch.
* **Austria, Styria (Steiermark) provider**. Two-fetch DSM-DTM
  subtraction from the Land Steiermark ALS Höhen-
  / Geländeinformation WCS services. ~1.2M people. First
  Austrian Land integrated, opens the door to the eight others.
* **Austria, Tirol (Tyrol) provider**. Two-fetch DSM-DTM
  subtraction from the Land Tirol terrain WCS (DGM + DOM 5 m).
  ~760K people.
* **Germany, Brandenburg + Berlin provider**. LGB bDOM + DGM
  1 m WCS, two fetches subtracted client-side. Single integration
  covers both Lands (Brandenburg ~2.5M + Berlin ~3.6M = ~6.1M
  people).
* **Germany, Baden-Württemberg provider**. LGL INSPIRE DOM5 +
  DGM1 WCS, two fetches subtracted client-side. ~11.3M people,
  Germany's third most populous Land.
* **United States, Vermont provider**. VCGI statewide
  pre-normalised nDSM via ArcGIS Image Server exportImage,
  single-fetch Float32 GeoTIFF, no DSM-DTM round-trip. ~645K
  people. First US-state native provider in Helios.
* **Worldwide LiDAR provider registry**. New
  [`LIDAR_PROVIDERS.html`](./LIDAR_PROVIDERS.html) lists every
  public elevation / LiDAR source we have inspected (integrated,
  verified compatible but pending, partially compatible,
  incompatible) with status, endpoint, curl-verified example fetch
  URL ready to paste in a browser, and an inline SVG world map
  overlaying the integrated providers' coverage bboxes.
* **BYO local nDSM provider**. New `lidar-local-ndsm-*` config
  family lets users in regions without a built-in provider host
  their own height-above-ground GeoTIFF and have Helios use it as
  the shadow source inside a user-defined bounding box. Takes
  precedence over public providers inside the bbox; outside the
  bbox, the regular fallback chain (public → footprints) applies
  unchanged. Closes [#5](https://github.com/ReikanYsora/Helios/issues/5),
  contributed by [@jourdant](https://github.com/jourdant) in
  [PR #5](https://github.com/ReikanYsora/Helios/pull/5), original
  idea credited to [@stephenwq](https://github.com/stephenwq).
* **LiDAR prep tools**. A `tools/lidar/` Python toolchain walks
  through the last stages of nDSM preparation: inspect a GeoTIFF,
  convert to a Cloud Optimized GeoTIFF for efficient browser
  streaming, generate a synthetic test raster. Detailed guide and
  `uv` setup in [`tools/lidar/README.md`](tools/lidar/README.md).
  Closes [#11](https://github.com/ReikanYsora/Helios/issues/11),
  contributed by [@jourdant](https://github.com/jourdant) in
  [PR #11](https://github.com/ReikanYsora/Helios/pull/11).
* **LiDAR View overlay**. Detailed under Highlights above. Editor
  promotion to its own section, native-pitch raster + per-view
  radius filter, ~30-50× perf win on the hot loop, theme-aware
  colours, distance fade, soft enter / exit transitions, scanner
  pulse on activation, debug overlay for diagnostics.
* **LiDAR View display radius**. Decoupled from `building-radius`
  so the dot cloud can extend past the visible buildings (the
  trees that cast the surrounding shadows often sit beyond the
  building disc).

### Home Assistant integration

* **External solar-radiation sensor input**. New optional
  `solar-radiation-entity` config pulls live + historical W/m²
  from a configured sensor and pushes them to the engine, so the
  irradiance display + chart prefer the physical sensor over the
  Open-Meteo model for live and past timestamps. Future
  timestamps still come from the model. Closes
  [#1](https://github.com/ReikanYsora/Helios/issues/1).
* **`home-latitude` / `home-longitude` override**. Optional
  per-card coordinates that win over `hass.config.latitude` /
  `longitude` when both parse as valid coords. Useful for shared
  HA installs, holiday / parents' homes, mobile setups, multiple
  cards on one dashboard each visualising a different place, or
  privacy-conscious users who leave `hass.config` blank.
  Contributed by [@i6media](https://github.com/i6media) in
  [PR #9](https://github.com/ReikanYsora/Helios/pull/9).
* **Card height floor**. Adds a minimum height so the card still
  reads correctly inside layouts that don't constrain its
  vertical footprint (sections view at small row counts, masonry
  with rigid columns).

### Editor

* **Reset data cache button**. New "Reset" section at the bottom
  of the editor. Wipes the cached Open-Meteo payload and the
  in-memory PV history for every Helios card open on the page,
  forcing a fresh fetch. Useful for a stuck calibration or a
  stale weather payload. HA data is never touched. Destructive
  warning above the button explains exactly what gets cleared
  and what doesn't.
* **Live editor preview**. Editor opens a live preview of the
  card so config edits show their effect before the dashboard
  reload. Engine bootstrap debounced 500 ms so quick editor
  churn doesn't burn WebGL contexts.
* **Renameable PV rows**. Each `pv-arrays` entry takes an
  optional `name`; the editor's repeatable section uses it as
  the card title, falling back to "Row N" otherwise.
* **Accordion editor**. Every section collapsible, the editor
  remembers which one is open, and only one expands at a time so
  the configuration panel stays compact.
* **Editor section reorg**. LiDAR View promoted to its own
  section. Map / UI / Buildings / Shadows / Local LiDAR groups
  rearranged for a natural top-to-bottom flow.
* **Editor vertical rhythm**. Spacing between labels, hints and
  fields tuned across the whole editor so each section reads as
  a calm vertical strip instead of a wall of inputs. Field
  helps share consistent line height and opacity, color groups
  cluster visually.
* **Single-finger auto-rotate**. The idle-camera orbit toggle
  pauses on a single-finger drag instead of requiring two
  fingers, matching the rest of MapLibre's touch input.

### Fixes

* **PV history chart spike**. Cumulative-energy sensors (Wh /
  kWh / MWh) no longer produce phantom spikes from quantization
  noise. The differentiation now holds a 3 min anchor so the
  rate averages over a window where 1 Wh integer noise is
  negligible.
* **Freeze on solar-radiation entity selection**. Selecting a
  solar-radiation entity in the editor used to freeze the card
  while the bridge pulled history. The fetch is now properly
  deferred and the engine continues rendering during the
  in-flight call. Closes
  [#12](https://github.com/ReikanYsora/Helios/issues/12).
* **Sun-ray arrow scrub**. The travelling arrow on the
  irradiance leader no longer detaches from the path when
  scrubbing the timeline back and forth. SMIL `animateMotion`
  no longer restarts on every path update; visibility is now
  gated on `_isLiveMode`.
* **Smartphone vertical alignment on PIC PRÉVU**. Icon and text
  share a single 13 px line-box with a 1 px translateY nudge on
  the uppercase glyphs so they visually centre with the icon
  instead of floating above.
* **LiDAR view button clickability**. `pointer-events` fix so
  the button receives clicks on touch devices. Button hides
  entirely when no provider covers the home, instead of
  rendering disabled.
* **LiDAR View float32 precision** on the GPU buffer (loss-of-
  precision artefacts on long lat / lon values).
* **LiDAR view layer init**. Hardened against a half-ready map
  to stop a race condition where the GL layer attached before
  MapLibre finished bootstrapping its default buffers.

### Internal

* `PAST_DAYS` bumped from 2 to 7. The timeline UI clips to the
  last 2 past days for scrub precision; the extra payload feeds
  the forecast calibration.
* PV history fetch window extended to 7 past days, in one HA
  round-trip instead of two; the chart still filters to its
  visible range.
* New `card/calibration.ts` module exporting
  `computeForecastCalibration(host)`, fed by `_chartSeries` +
  `_pvHistory` + per-day model integration.
* Window-level `helios-data-cache-reset` event bus so multiple
  cards on the same page reset their state in sync.
* `clearWeatherCache()` public helper in `engine/weather.ts`.
* `resetDataCache()` public method on both the card and the
  engine.

### Credits

* **[@jourdant](https://github.com/jourdant)** (Jourdan Templeton)
  — BYO local nDSM LiDAR provider ([PR #5](https://github.com/ReikanYsora/Helios/pull/5))
  and matching Python preparation toolchain
  ([PR #11](https://github.com/ReikanYsora/Helios/pull/11)), idea
  credited to [@stephenwq](https://github.com/stephenwq).
  Unlocks shadows for any region with raw LiDAR data available
  offline, initial use case NSW Australia.
* **[@i6media](https://github.com/i6media)** (Frank Boon) — optional
  `home-latitude` / `home-longitude` overrides
  ([PR #9](https://github.com/ReikanYsora/Helios/pull/9)) and the
  multi-orientation PV layout
  ([PR #10](https://github.com/ReikanYsora/Helios/pull/10)).
  Closes #8.


## v1.5.1, tilted-panel forecast, today cumulative chart, dashboard polish

Hotfix-flavoured iteration on top of v1.5.0. Focused on the issues
1.5.0's new users surfaced in the first 24 hours after release: an
over-optimistic forecast for non-horizontal installs, a dashboard /
timeline mismatch on the projected kWh, and visual polish on the new
detail panel.

**Tilted-panel forecast.** `computePvPower` gains an optional `panel`
argument carrying `tiltDeg` and `azimuthDeg`. When tilt is greater
than zero, the function switches from the horizontal-panel fast path
to a Liu-Jordan isotropic transposition: GHI is split into direct
(cos-of-incidence transposed via `R_b = cos θi / cos z`) and diffuse
(`(1 + cos β) / 2`) components plus a 20 % albedo ground-reflection
term. Two new editor config keys, `pv-tilt` (0..90 degrees) and
`pv-azimuth` (0..360, clockwise from north, 180 = south), feed the
helper `_pvPanelOrientation()` on the card side; defaults keep the
horizontal-panel behaviour bit-for-bit unchanged. Closes #3. A user
with vertical balcony panels was seeing 4.7 kWh predicted against
1.1 kWh measured. With `pv-tilt: 90` + `pv-azimuth: 180`, the
prediction lands in the realistic range and tracks reality through
the day.

**Dashboard / timeline forecast alignment.** The "Aujourd'hui" card
was displaying a forecast figure that drifted from the value shown on
the timeline above. Two root causes: (a) the cumulative-energy unit
(`kWh`) was not handled by `_pvNormalizeToWatts`, which silently
returned 0 after differentiation, zero-ing the observed contribution
in `_computeTodayHourly`; (b) the dashboard's forecast was integrated
via hourly bins while the timeline used the raw `_computeDailyKwhTotals`
path. Both fixed: the cumulative-energy path now goes straight to
watts via `value * 1000` after differentiation, and the dashboard
reads today's forecast directly from `_computeDailyKwhTotals` so the
two surfaces are guaranteed to agree.

**Today cumulative chart.** The right half of the "Aujourd'hui" card,
previously empty, now hosts a sparkline of the day's running kWh.
Past portion is drawn from raw history (cumulative-energy sensors get
a baseline-subtracted reading per sample; power sensors are
integrated by trapezoidal rule); future portion extends with the
hourly forecast bins, the boundary cleanly stitched at "now". A dot
sits on every full hour and a hover line + travelling dot reveal a
tooltip showing the exact cumulative kWh at the cursor's minute.
Gated by a CSS container query on the section (`min-width: 380px`)
so the chart only appears when the card has room to render it
readably; below that, the layout falls back to the previous two-
column shape.

**"Pas encore produit" status + skeleton placeholder.** Two new UI
states for the produced figure in the "Aujourd'hui" card: a
shimmering skeleton replaces the value while the PV history fetch is
in flight (so transient "0,0 kWh" stops reading as fact), and a
small italic line ("production pas encore démarrée" / "production
hasn't started yet" / 8 locales) sits under the value when produced
is effectively zero and the forecast still expects a peak later in
the day.

**Battery cap double-edge fix.** The battery icon in the detail
dashboard had a visible double stroke at the seam between the cap
and the cell shell. Caused by two `<rect>` elements sharing their
edge with `rx`-rounded corners pulling in the cap's bottom slightly,
exposing the shell's top stroke alongside. Replaced by a single open
`<path>` for the cap (top + two sides, no bottom edge) so the shell's
top edge becomes the only stroke at the seam.

**1 px border on travelling beads.** The animated discs that ride
the PV → home and battery ↔ PV leader lines now carry a 1 px stroke
(theme-aware: white on light, near-black on dark) with `paint-order:
stroke fill` so they keep contrast against the map basemap, the
home chip, and any background that happens to share their fill
colour.


## v1.5.0, OpenFreeMap migration, manual PV peak, detail dashboard, multi-country LiDAR

A four-headed iteration on top of v1.4.0. Drops the MapTiler dependency
entirely, replaces auto-calibrating PV with a one-line manual input,
opens a click-through detail dashboard on the home, and rounds out the
LiDAR provider roster started in v1.4.0.

**OpenFreeMap migration.** The map stack moves from MapTiler (paid API
key, opt-in for HACS users) to [OpenFreeMap](https://openfreemap.org/),
which serves OpenMapTiles-schema vector tiles plus three maintained
styles (Liberty, Positron, Fiord) for free with no key, no signup and
no rate limit. The card now ships with zero credentials to configure;
the basemap and the buildings tile fetch (`helios-buildings.ts`) both
resolve their tile URL once at boot from OpenFreeMap's public
TileJSON. Three knock-on cleanups:

- The `maptiler-key` config option is removed (silently ignored if
  present in old YAML; the engine never reads it).
- The `topo` map style is gone (MapTiler-specific). `map-style` now
  accepts `streets` (Liberty) and `minimal` (Positron).
- A `styleimagemissing` handler stubs unknown sprite refs with a 1 px
  transparent image so OFM's smaller sprite sheet can't spam console
  warnings on style switch.

**Manual PV peak power.** The auto-calibration buffer (a 14-day
rolling fit of `predicted vs actual` samples kept in localStorage and
HA's `frontend/user_data`) is gone. Users now enter the installation's
peak power directly via a new `pv-peak-kwp` numeric option in the
editor. `_pvCalibK()` returns `kwp * 10` when set, `null` otherwise.
When `null`, the dotted forecast line and the predicted-value mode of
the PV chip both hide; the live observation, the PV chip and the
peak-of-day highlight still render. A one-shot boot routine
(`_wipeLegacyPvCalibStorage`, gated by a `helios-pv-calib:wiped-v1`
flag) deletes legacy calibration buckets so the migration is silent
for existing users.

**Detail dashboard.** Clicking the home triggers a camera dive (zoom
+ pitch ease) and fades a chip-styled overlay over the HUD with up
to three sections that appear in sequence (~180 ms stagger between
cards):

- **Today**: produced kWh, projected end-of-day total, peak-of-day
  time. No curve, the timeline above already carries that shape.
- **Tomorrow**: a single chip with weather icon + estimated kWh +
  expected peak hour, derived from the multi-model forecast and the
  Haurwitz / Kasten-Czeplak clear-sky model scaled by `pv-peak-kwp`.
- **Battery**: a vessel showing live SoC and the day's charge /
  discharge totals, present only if at least one battery entity is
  configured.

Each card shares the same chip vocabulary as the on-map overlays
(white surface, 1 px black border, soft shadow), with a dark-theme
override for `card-theme: 'dark'`. Click anywhere outside a card to
exit; the camera eases back to its pre-dive bearing and the HUD
fades back in.

**Hover home glow (replaces always-on halo).** The v1.4.0
sun-coloured halo painted under the home's outline as a permanent
MapLibre `line` layer is replaced by an SVG glow toggled on the
`home_hover` state. The home then reads as a calm anchor at rest and
the focal building only "lights up" when the cursor is over it,
signalling the click affordance for the detail dashboard.

**Multi-country LiDAR roster (continuing v1.4.0).** Four providers
land alongside the existing IGN-FR pipeline: Defra (England,
GeoTIFF DSM minus DTM), IGN España PNOA-LiDAR (peninsular Spain +
Balearics, two MDSn coverages merged via element-wise MAX), PDOK
AHN4 (Netherlands, GeoTIFF DSM minus DTM), Kartverket NHM (Norway +
Svalbard, ArcGIS Float32 GeoTIFF DOM minus DTM). All five route
through the shared post-processing in
`./helios-lidar/helios-lidar-pipeline.ts`. The `geotiff` package
(~120 KB gzip, lazy-loaded codecs inlined by Vite
`inlineDynamicImports`) is the only third-party dependency added.

Probed and parked: Wales (NRW, per-tile ZIP only), Switzerland
(swisstopo, WMS only carries pre-rendered hillshade), Slovakia
(ZBGIS, surface only as PNG), Denmark (Datafordeler DHM, requires
per-user OAuth), United States (federal USGS 3DEP exposes a live
ArcGIS Image Server for bare-earth DEM only; no public DSM service,
and state programmes such as MN DNR publish raw LiDAR as per-tile
ZIP downloads only).

**Timeline polish.** Daily kWh totals now appear under each date
label on the timeline. Sunrise / sunset ring markers on the sun arc
were swapped for MDI icons. The bottom scrub chip is gone; the
clock chip in the top-left flips to the blue scrub theme during a
scrub, and the back-to-live button is fused next to it. Auto-rotate
defaults to `false` (was `true`) so a fresh install is calm by
default; users opt in for kiosk dashboards.

**i18n.** New keys: `todayLabel`, `todayProduced`, `todayForecast`,
`todayPeak`, `tomorrowLabel`, `tomorrowPeak`, `batteryLabel`,
`batteryCharged`, `batteryDischarged`, `pvPeakPower`,
`pvPeakPowerHelp`. Norwegian (`no`) added as the 8th locale.


## Earlier versions

The full pre-1.5.0 history (v1.4.0 LiDAR shadows, v1.3.0 PV
auto-calibration, v1.2.0 customisation + home cluster, v1.1.0
battery + PV + dark theme, v1.0.0 initial HACS release) lives in
the project's git log. The notes for those releases used to be
embedded in `ARCHITECTURE.md` and remain available on the
corresponding GitHub Release pages.
