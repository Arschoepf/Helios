# Changelog

All notable changes to HELIOS, grouped by theme rather than strict
added / changed / fixed buckets. Entries below the top one are
preserved from the in-tree history that used to live inside
`ARCHITECTURE.md`.

## v1.6.2-beta.2

Iterative pre-release on top of v1.6.2-beta.1. Same feature set
(thermal derating + LiDAR-aware shading on the PV forecast); the
diff is two UI fixes on the LiDAR-View toggle.

* The button is now icon-only. The `LiDAR` text label was visually
  decentring against the icon across browsers because rendering an
  11 px uppercase Roboto run inside an ha-card slot ends up
  font-engine dependent (Chromium / Firefox / WebKit each shift the
  glyph box by a different fraction of a px). Dropping the label
  sidesteps the engine-divergence entirely.
* Icon swapped from `mdi:dots-grid` to `mdi:cube-scan`. Communicates
  the "3D scan / point cloud overlay" intent more directly than the
  flat dot grid did.

---

## v1.6.2-beta.1

Pre-release on top of v1.6.1 that lands two precision upgrades for
the PV prediction model. Both are opt-in: existing configs render
identically until they enable the new fields.

### PV thermal derating

The PV forecast now accounts for the cell temperature climb under
sun and the convective cooling under wind, using the classic
Sandia / NOCT pipeline:

* Pulls `temperature_2m` + `wind_speed_10m` from Open-Meteo alongside
  the existing cloud + shortwave variables.
* Estimates cell temperature with `T_cell = T_air + (NOCT - 20) /
  800 W/m² × GHI − 1.5 × wind`, then derates the output by
  `1 + γ_pmp × (T_cell − 25)` with γ_pmp = −0.0040 /°C (typical
  monocrystalline silicon coefficient).
* Plumbed through every PV computation site: live chip, scrub
  preview, dashboard "today" / "tomorrow" graphs, forecast
  calibration. On a hot summer noon at 35 °C ambient and ~900 W/m²
  the derating reduces the predicted peak by ~13 %, which is the
  bulk of the model bias the calibration ratio was previously
  absorbing as a flat multiplier.
* Falls back cleanly when the model didn't return temperature or
  wind: multiplier stays at 1 and the forecast reduces bit-for-bit
  to the previous Haurwitz + Liu-Jordan output.

### LiDAR-aware shading on the PV forecast

When a LiDAR provider covers the home (or a BYO local-nDSM raster
is configured), the PV forecast now ray-marches from each PV array
along the sun direction and zeroes the direct-beam component on
arrays whose line-of-sight to the sun is blocked by a building or
tree. The diffuse + ground-reflected components are kept (an
obstacle blocks the sun ray but not the upper hemisphere of sky),
so a shaded panel doesn't drop to zero, just to the ~25-30 % of
clear-sky output that the diffuse + reflected terms contribute.

* New `height` field per entry in `pv-arrays` (metres above ground,
  default 5). Used as the ray's starting altitude so a panel on a
  first-floor roof clears a low fence the ground-mounted same-
  orientation array would sit in the shadow of.
* Bilinear sample of the loaded nDSM, 2 m step, 200 m max reach.
  Same buffer the LiDAR View overlay paints, no extra fetch.
* For installs with `pv-arrays` declared at distinct coordinates,
  each entry is shaded independently. So a roof-east array can be
  shaded by a tall neighbour at 8 am while the roof-west array
  on the same property is fully lit.
* Skipped silently when no LiDAR raster is loaded (no providers
  match the home, no BYO nDSM configured), so installs outside
  LiDAR coverage continue to produce the legacy forecast.

### Notes for users

The new fields are opt-in but the temperature derating activates
automatically as soon as v1.6.2 is installed, since the weather
fetch starts pulling temperature + wind without any config change.
Expect the forecast to read **a few percent lower** at the midday
peak on hot clear days and a few percent higher on cold clear
winter days; the self-calibration ratio will absorb the residual
within a few sunny days.

For shading to kick in, the home needs to be inside a LiDAR
provider's coverage (one of the 10 native providers shipped with
the card, or a BYO local-nDSM via the `lidar-local-ndsm-*` keys).
Outside coverage, the forecast falls back to the existing geometry-
only model.

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
