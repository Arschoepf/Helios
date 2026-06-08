# Changelog

All notable changes to HELIOS, grouped by theme rather than strict
added / changed / fixed buckets. Entries below the top one are
preserved from the in-tree history that used to live inside
`ARCHITECTURE.md`.

## v1.8.3

> Bigger cycle than v1.8.3 originally scoped for. After triaging the long tail of bug reports on v1.8.2 (always-0 grid
> chips on slow-cadence meters, two cards on the same dashboard disagreeing on grid power, PV daily total drifting from
> PowerCalc by 38 % on a 1 Hz Victron install, multi-tariff Linky setups quietly mis-aggregating) I decided to walk away
> from per-card entity configuration for everything the official HA Energy dashboard already declares globally. The card
> now reads PV, grid and battery entities directly from `Settings → Dashboards → Energy`, eliminating the entire class of
> "the Helios chip points at sensor X but my dashboard uses sensor Y" bugs and reducing the configuration surface to the
> install-specific bits HA does not know about (PV peak kWp + per-string tilt and azimuth via `pv-arrays`, optional
> inverter cap, LiDAR providers, visual options). One source of truth, less ambiguity, fewer ways to land in a half-broken
> state. The transition is staged across several commits inside this cycle; the breaking change lands as a one-shot HA
> persistent notification telling the user which retired keys in their card YAML are silently ignored, and pointing them
> at the Energy dashboard for the entity configuration.
>
> The cycle also delivers three regression fixes for the grid history backfill that
> shipped in v1.8.2 (a raw arm that could fail silently leaving
> the buffer empty, a scrub buffer that never populated for
> power-native grid sensors, and a 24 h LTS window that capped
> scrub coverage shorter than users expected), a deeper alignment
> pass that mirrors the HA Energy dashboard live grid read so the
> LIVE chip matches the official Energy dashboard to the watt
> when a `stat_rate` sensor is configured on the grid source, and
> four UI polish items for fullscreen / kiosk canvases.
>
> Upcoming work is tracked live on the public roadmap at
> [helios-lidar.org/roadmap](https://helios-lidar.org/roadmap),
> refreshed every five minutes.

### Weather mode polish round 2 (#210)

beta.90 was a MET Norway switch experiment, reverted; beta.91 ships the next batch of weather
mode polish on top of the original Open-Meteo source:

- **Zoom out an extra notch**: target moves from zoom 10 to **zoom 9**; the `[minZoom, maxZoom]`
  envelope widens to `[8, 18]` accordingly. Grid half-extent grows from 1.3 deg to **1.6 deg**
  latitude so the raster covers ~356 km x ~356 km and the wider zoom 9 viewport (~320 km) keeps
  painting past the visible edges.
- **Cloud overlay actually clears on exit**: `refreshWeatherRaster` now bails when a fade-out is
  in flight. Previously the canvas was re-attached to the MapLibre raster source mid-fade, so
  the cloud mass stayed painted on the map after the rest of the overlay had faded out.
- **Color back to primary**: the debug red palette swaps for the HA theme's `--primary-color`,
  read live from the document root so theme swaps propagate without a rebuild. Per-layer alpha
  ceilings drop from 0.85 / 0.70 / 0.55 to 0.50 / 0.40 / 0.30 so the cloud masses read as a
  soft veil and the map stays legible underneath.
- **Cloud icon merged into the weather button**: the top-left cloud anchor + per-layer chips
  are gone. The weather mode button in the right rail now carries the live cloud-cover icon
  (sun / partly-cloudy / cloudy / pouring) so a user reads the current sky state at a glance
  without entering the mode. The 3 per-altitude chips (high / mid / low) stack BELOW the mode
  bar when weather mode is active; they pop in / out with the mode flip.
- **Default camera pitch raised from 30 deg to 50 deg**: the default boot pose was too close to
  top-down, opening with the home barely tilted. 50 deg gives a fuller 3D view of the building
  extrusions out of the box.

### About layout polish + shading / 30-day audit (#210)

**About panel:**

- Developer name fixed to "Jérôme Crémoux" (accent on the second e).
- Every identity row aligned right with a consistent label-left / link-right layout: Version,
  Developer (name), X profile, LinkedIn, GitHub Helios, GitHub Helios-Lidar.
- X logo: inline SVG of the post-rebrand X glyph (mdi:twitter was retired, the MDI set didn't
  ship a proper "X" replacement).
- Row padding tightened so the six identity rows stack densely instead of with the previous
  block spacing.

**Storage audit + legacy sweep:**

- One-time purge of legacy localStorage keys on engine spawn: `helios-shading-map:v2` (retired
  in beta.80, can sit at 100-500 kB on long-running installs) and `helios:cloud-mode` (retired
  in beta.81). Idempotent + cheap, only runs once per page load.
- Active keys confirmed in audit: `helios-camera-pose:<lat,lon>` (camera pin), `helios-weather
  -cache:<lat,lon,prec>` (Open-Meteo payload), `helios-pv-calib-wipe-flag-v1` (calibration
  wipe flag). PV history / calib / trainer caches are in-memory only.

**Shading + 30-day reference sweep:**

- `engine.projectShadingDome` + the supporting `_projectSpherePoint` helper removed entirely
  (dead code since beta.80).
- Trainer 5-min stats window narrowed from 30 days to 5 days: the only consumer of the wider
  window was the retired shading map, the unified data source only needs the J-2 .. J+2 slice.
- Inline comments referencing ShadingDome / shading map / 30-day glissement updated across
  helios-card, init, overlays, loading-tracker, radiation, calibration, helios-config, pv,
  weatherMode, ws-timeout.

### Seven user-facing fixes (#210)

- **Zoom out finally works.** `_applyMapBounds` installs a tight bbox (~2 × building-radius)
  around the home so the user can't pan past the rendered surroundings; MapLibre enforces an
  effective minimum zoom from that bbox, which clamps any easeTo target to ~16 regardless of
  `setMinZoom`. `enterWeatherCamera` now drops `maxBounds` entirely before the easeTo so the
  camera can dezoom freely to zoom 10. `exitWeatherCamera` restores the original bbox.
- **Midnight refresh.** The store's data-version hash now includes the local day-key
  (`Date#toDateString()`), so the store auto-rebuilds at midnight rollover even when no new
  source rows have landed yet. Without this, every per-day slice stayed shifted by one day
  until the first fresh fetch tripped a length change.
- **Chart hover tooltip raised.** Position moves from `top: 14%` to `top: 4%` so the icon +
  value pair sits at the very top of the chart card, leaving the cursor line visible above as
  before.
- **Loading banner no animation, positioned for real.** The slide-in transition used to be
  half-played on short fetch waves: the banner appeared mid-slide, disappeared the moment the
  data landed, and the user only saw a blink. The animation is gone; the banner pins at the
  top edge of the card (top 8 px), horizontally centred between the lock button on the left
  and the mode bar on the right, fades in / out via opacity only.
- **Editor About: version font + link.** The version chip now uses the HA frontend body font
  (`var(--ha-font-family-body)`), bold, primary text colour. The chip is clickable and jumps
  to the matching GitHub release page (`/releases/tag/v<version>`).
- **Editor About: Developer block.** New row right under the version with the developer name,
  X profile link and LinkedIn link.
- **Site description and coffee-message paragraphs rewritten** to better reflect the
  positioning the project deserves.

i18n: EN + FR strings updated; the new keys (`aboutDeveloperLabel`,
`aboutDeveloperLinkedIn`) are filled in EN + FR and shipped as EN placeholders in the 62
other locales, to be retranslated in the final beta phase.

### Weather mode zoom 10 + grid extended to 290 km (#210)

Zoom 12 from beta.81 wasn't pulled back enough to give the user a satellite-style overview.
Bumping the weather-mode camera target to zoom 10 (~160 km viewport at temperate latitudes)
opens a regional view; the `[minZoom, maxZoom]` envelope widens to `[9, 18]` so the easeTo
target isn't edge-clamped.

The grid half-extent grows from 0.7 to 1.3 degrees latitude (78 km -> 145 km per side), so the
raster covers ~290 km x ~290 km and keeps painting past the visible edges at zoom 10. At
31 x 31 cells the per-cell pitch goes from ~5 km to ~9 km, still inside the underlying weather
model native resolution range (3 km AROME-France, 13 km ICON-EU).

### Weather raster: red debug palette + zoom race fix (#210)

Two fixes for the user-visible weather mode pass:

- **Red debug palette.** Temporarily swap the grayscale composite (200 / 180 / 140 RGB) for a
  red palette (high = light red 255/120/120, mid = medium red 220/60/60, low = deep red 180/0/0)
  so the raster is impossible to miss visually. Restore the grayscale once the visibility is
  validated.
- **Zoom race condition fix.** A rapid UI -> Weather -> UI -> Weather sequence could let the
  previous exit's `setTimeout(tighten, 1250)` fire mid-ease of the next entry, re-clamping
  `[minZoom, maxZoom]` to `[18, 18]` and freezing the camera at 18 before the entry's easeTo to
  12 could land. The pending tighten handle is now kept on the engine and `enterWeatherCamera`
  cancels any stale one before scheduling its own.

### Weather grid POST body uses form encoding, not JSON (#210)

Beta.84 packed the lat / lon arrays as JSON in the POST body. Open-Meteo's API rejected this with
HTTP 400; the documented multi-location POST format expects the same `latitude=A,B&longitude=X,Y`
comma-separated string format as the GET query string, just placed in the body with
`application/x-www-form-urlencoded`. The fetch now sends that exact shape.

### Weather grid fetch: switch GET to POST (#210)

beta.83 fired the multi-location forecast call as a GET with 961 (lat, lon) pairs in the query
string, which serialises to ~22 kB. The user's browser surfaced HTTP 414 (URI Too Long) on the
first weather-mode entry: Open-Meteo's Cloudflare edge enforces the usual 8-16 kB URL ceiling.
The fetch now uses POST with the same fields packed into a JSON body. Same endpoint, same
response shape, no URL ceiling.

### Weather mode raster overlay shipped (#210)

The weather mode now paints a satellite-style cloud raster on the map when active. Each
canvas pixel composites three altitude bands (low / mid / high) sampled from a 31 x 31
Open-Meteo grid centred on the home, bilinear-interpolated to the pixel's lat / lon, then
modulated by a 3-octave value-noise field so the raster reads as a textured cloud volume
rather than a flat colour swatch.

**Engine surface:**

- `_weatherGrid` storage: ~7 MB in-memory hourly cloud values (cloud_low / cloud_mid /
  cloud_high) at 31 x 31 grid points spanning ~156 km x ~156 km around the home.
- `ensureWeatherGrid()`: idempotent fetch with a 30 min TTL. A single Open-Meteo
  multi-location GET (961 lat / lon pairs in one call, under the 1000-coordinate API
  limit) brings down 48 h of forecast.
- `getWeatherGrid()` / `isWeatherGridFresh()`: read-side accessors the renderer polls.
- `setWeatherCloudOverlay(dataUrl, bounds)`: attaches the canvas image as a MapLibre
  `image` source + `raster` layer. Subsequent calls swap the image via `updateImage` so
  the layer never blinks during scrub.
- `clearWeatherCloudOverlay()`: removes the source + layer on mode exit.

**Card / `weatherMode.ts`:**

- Inline value-noise (`fractalNoise`, 3 octaves of `valueNoise2D`) for cloud texture.
  Deterministic per (x, y) so the texture stays stable across re-renders within a
  session.
- 512 x 512 offscreen canvas reused across renders (allocate once, paint many).
- Bilinear interpolation on the grid at every canvas pixel + per-layer alpha derived
  from the matching coverage percent, modulated by independent noise offsets for each
  band so the three masses aren't perfectly correlated.
- Composite order: high (light gray, top of stack) → mid → low (dark gray, bottom).
  Dense low band wins where coverages overlap, matching real-sky visual weighting.
- `refreshWeatherRaster(host)` short-circuits when the selected time hasn't crossed
  into a new hourly bucket since the last paint, so the scrub cursor sweeping through
  the same hour costs zero canvas work.

The MapLibre raster layer handles pan / zoom / rotation natively, so the cloud mass moves
correctly with the camera without per-frame JS reprojection. Initial fetch takes 200-500 ms
on a residential connection; the raster paints on the next render tick after the data
lands.

### Lock button disabled in weather mode (#210)

Last polish on the weather mode entry / exit: the camera-lock button stays visible in the top-
left corner so the user reads the current lock state at a glance, but goes disabled while the
weather mode is active. The engine force-locks the camera on enter to keep the satellite-style
top-down view framed; letting the user toggle the lock would either fight the engine state or
strand the view with a half-applied unlock. The pre-enter state is still restored on exit.

### Weather mode UI polish (#210)

Five follow-ups on beta.80 from the user-facing pass:

- **Zoom out actually fires now.** The base map locks zoom to 18 (minZoom = maxZoom = 18) so the
  user can't wander off the designed altitude. The weather-mode easeTo target was getting clamped
  back to 18 silently. `enterWeatherCamera` now widens the envelope to [10, 18] before the easeTo
  and `exitWeatherCamera` restores the original clamps after the return animation lands. The
  target zoom drops from 18 to 12 for the satellite-style overview.
- **Rotation lock during weather mode.** The camera locks the moment we enter the mode regardless
  of the user's current preference so a stray drag doesn't pan the overhead view out of frame.
  The pre-enter lock state is captured + restored on exit, so a user who had rotation free stays
  free on the way back, and a locked user stays locked.
- **Timeline stays visible in weather mode.** Chips / leaders / arcs still hide behind the
  overlay mask, but the bottom timeline tracks the cursor so the user can scrub through the day
  and the cloud overlay will follow once the raster lands. CSS adds a `:not(.mode-weather)`
  qualifier on the timeline slide-out rule.
- **Cloud-cover toggle button retired.** The previous chip-toggle was a discoverability dead-end:
  most users never realised the cloud icon was clickable. The button is gone. The three per-
  altitude chips (high / mid / low) now auto-reveal whenever the weather mode is active, and
  collapse back to the aggregate icon otherwise. The `helios:cloud-mode` localStorage key + the
  related per-card state are dropped.
- **Loading banner CSS restored.** The block was accidentally swept with the shading-dome CSS
  purge in beta.80, so the loading text rendered as unstyled raw text in the top-left corner.

### Big shift: shading map retired, weather mode foundation (#210)

**The card is no longer a niche PV-enthusiast tool.** Helios now positions itself as a universal
home weather / energy card; the shading-dome view (a celestial hemisphere overlay learning per-cell
shading residuals from 30 days of PV history) and its associated training infrastructure are gone.
The shading map was visually striking but contributed marginally to forecast accuracy on most
installs while consuming 100-500 KB of localStorage and ~1500 lines of code.

**What ships in this beta:**

- `effectiveForecastRatio` reduces to identity on `calR` (the scalar 5-day calibration ratio).
  Forecast accuracy remains driven by `computePvPowerWeighted` (physical PV model from `pv-arrays`)
  × `pvCalibK` × `calR`, which is the bulk of the gain anyway.
- Four files retired entirely: `engine/shadingMap.ts`, `card/shadingMapView.ts`,
  `card/shadingTrainer.ts`, `card/shadingDome.ts`. Code paths in `unifiedStore.ts`, `charts.ts`,
  `dashboard.ts`, `pv.ts` and `helios-card.ts` simplify accordingly.
- 11 shading-related i18n keys dropped from the type + all 64 locales.
- Editor "Shading map" debug section removed; the radial-icon button in the mode bar is
  reassigned to a new "Weather" mode.
- `helios-shading-map:v2` is no longer written. Existing entries from earlier versions stay until
  the user / browser collects them (we don't actively clear other apps' storage, but the key never
  gets touched again so it'll fall out of the LRU).

**What lands in this beta as a foundation:**

- New `weather` card mode replacing the shading-dome slot. Clicking the icon (`mdi:weather-partly
  -cloudy`) tilts the camera to top-down (pitch 0) and zooms out by ~5 levels with an 1200 ms
  ease, animates the HUD chip mask the same way the shading-dome did, and exits restoring the
  exact pre-enter pose.
- `engine.enterWeatherCamera()` / `engine.exitWeatherCamera()` + `engine.getCloudLayersAt(t)`
  helpers shipped on the public engine surface.
- `weatherMode.ts` ships the full fade-loop + lifecycle. The visible overlay is intentionally a
  bare fading wrapper in this beta; the raster cloud overlay (multi-point Open-Meteo grid +
  canvas with bilinear interp + Perlin noise) lands in the next beta where the heavier render
  path can be validated against the perf budget.

**Bundle: -115 KB** uncompressed (-32 KB gzipped) on net, on top of every previous v1.8.3
optimisation.

### Chart hover tooltip + adaptive radial layout (#210)

**Dashboard chart hover tooltip.** A small icon + value chip appears at the hover cursor, showing
the production and forecast values at the cursor instant when each is available. Anchored near the
top of the chart so the cursor line stays visible above the tooltip and reads as "cutting through"
it. HA card tokens for the background / border / shadow so the tooltip follows light + dark
themes automatically. Icon only, no text labels.

**Adaptive radial dial layout.** The radial dial now adjusts which rings it draws based on the
user's actual equipment:

- No HA Energy battery source: the battery ring + one inter-ring gap collapse and the freed span
  (34 viewBox units) is redistributed onto the cloud and production rings. Each grows from 28 to
  45 units wide.
- No HA Energy solar source + no `pv-arrays` config: the production ring collapses and its span +
  one inter-ring gap redistribute onto the cloud and battery rings the same way.
- Neither PV nor battery: the cloud + irradiance ring fills the entire span between the inner sun
  disc and the clock annulus (108 units wide).

The clock annulus and the inner irradiance disc keep their original radii in every case so the
visual anchor points stay consistent. Hover dots, ring track arcs, chip strip badges and the
graph-mode toggle button all gate themselves on the equipment flags the same way:

- No PV: the chart-mode toggle button hides itself (the graph view would draw an empty production
  curve) and the view is locked to radial regardless of the persisted mode.
- No battery: the battery chip + dot don't render.

`hasPvConfigured()` and `hasBatteryConfigured()` ship in a new `src/card/equipment.ts` module that
reads off the HA Energy defaults + the per-card `pv-arrays` config.

### Update frequency knob, hatch fix, faster grow animation (#210)

**New editor section "Data display" (above PV install)**, containing a single slider:

- "Update frequency" (1-60 per hour), default 4 = a value every 15 minutes. Drives both the data
  source storage cadence and the rendering cadence of every graph that reads from it. Higher
  values give more precise curves at the cost of CPU per rebuild + memory per series.

The previous twin constants (`DATA_BUCKETS_PER_HOUR` + `DISPLAY_BUCKETS_PER_HOUR`) collapse into
this single user-facing setting. `displayUpdateFrequencyPerHour(config)` reads + clamps the value
from the user config; the unified store carries `bucketsPerHour / bucketsPerDay / bucketsTotal /
stepMs` fields the read-side accessors consume, so the cadence flows from a single source through
every consumer (radial dial, dashboard chart, timeline production curve).

**Forecast cadence stays locked at the weather model's hourly rate.** No point computing the
predicted W per minute when the cloud-cover input only refreshes once an hour, and the forecast
loop is the heaviest pass in the build. `buildForecast` now runs internally at 1 bucket / hour
(120 buckets across the 5-day window) and linearly resamples the result into the storage cadence,
keeping the rebuild cost constant regardless of the user-chosen frequency.

**Dashboard chart visual fixes:**

- Night-zone hatch now leans at a true 45 deg regardless of the chart's runtime aspect ratio.
  The previous SVG `<pattern>` lived in the SVG's user-coordinate space, which the chart stretches
  via `preserveAspectRatio="none"`; the hatch is now an HTML overlay div with a CSS
  `repeating-linear-gradient` (same recipe as the timeline night zone) sitting in CSS pixel space.
- Grow animation drops from 700 ms to 400 ms, snappier and aligned with the HA Energy forecast
  chart timing.

i18n: EN + FR strings shipped for the new section. 61 other locales received the EN placeholder
strings to keep the type-check happy, to be translated in the final beta phase.

### Past production now reads 5-min LTS, not hourly (#210)

End-to-end audit revealed the data source's production builder was missing its densest input:

- `_pvHistory` (raw HA history): the 6-h fetch was removed weeks ago, so this slot starts empty and
  is only extended with live state pushes since session start, never carrying the full past day.
- `_pvCalibStats` (hourly LTS): 1 sample per hour over 5 days, ~120 rows. This is what the store
  was reading from. At any storage cadence (4 b/h, 60 b/h, anything) the past curve was 1 real
  sample per hour with linear interpolation between hours, producing a smooth hourly shape that did
  not change with the bucket count.
- `_pvTrainerStats` (5-min LTS): 12 samples per hour over 30 days, ~8.6k rows. Already fetched on
  idle for the shading-map trainer. Carries the sub-hourly variability the HA Energy dashboard
  shows on the same entity. Was NOT plugged into the data source.

This release wires `_pvTrainerStats` as the primary past-production source. `_pvCalibStats` stays
as a fallback for the few installs where the trainer hasn't landed yet. The bucket cadence now
actually matters: at 60 buckets / h the curve carries the 5-minute peaks the sensor recorded; at
4 buckets / h the curve averages over 15 min but still reflects the trainer-resolution shape.

### Production curve precision: differentiate raw cumulative history (#210)

The data source's production builder ingested the raw `_pvHistory` only for power entities (W).
For cumulative-energy entities (kWh, the typical HA Energy `stat_energy_from` shape), the raw
push stream was silently dropped and the past production curve relied on the hourly LTS alone,
producing a smooth shape regardless of how many buckets per hour the storage cadence kept. The
sensor's actual variability stayed invisible.

This release ports the differentiation pass the legacy `renderPvChart` used to do into the data
source. Adjacent cumulative readings differentiate into a per-window watts-per-hour rate, with the
same 3-minute anchor window (MIN_DTH = 0.05) to avoid integer-Wh quantization noise. Counter
resets and outages reset the anchor. The resulting per-bucket production now mirrors the
sub-hourly peaks + dips the HA Energy dashboard already shows on the same data.

### Hatch inclination fix + 60-bucket perf-test build (#210)

- Dashboard graph night-zone hatch now leans the same way as the timeline (`/`, 45 deg upward-right
  instead of `\`); the SVG `patternTransform` switched from `rotate(45)` to `rotate(-45)`.
- PERF TEST: `DATA_BUCKETS_PER_HOUR` and `DISPLAY_BUCKETS_PER_HOUR` both bumped from 4 to 60 (= 1
  bucket per minute) for performance observation on the user's instance. Series length goes from
  480 to 7200 buckets per signal; per-render display slice from 96 to 1440. Forecast builder loop
  scales linearly with the storage cadence (×15 cost on each rebuild). Revert to 4 after the test.

### Dashboard graph styling aligned on the timeline chart (#210)

The mini graph at the bottom of the radial dashboard card now shares the timeline PV chart's
visual recipe so the two surfaces read as one composed instrument:
- Curve and fill colour come from the user-configurable `pv-color` card option (instead of the
  `--energy-solar-color` theme token), so every chart in the card honours the same setting.
- Production area drops from 35 % to 25 % alpha to match the timeline area.
- Forecast curve uses the same theme-aware lerp (pvColor blended toward black on light themes,
  toward white on dark) as the timeline.
- Night-zone hatch shrinks from 8 px / 1.5 px stroke to 6 px / 1.5 px stroke at 45 deg with the
  same rgba(0,0,0,0.12) light / rgba(255,255,255,0.18) dark alphas the timeline uses.

### Dashboard chips at scrub: HA-direct readout, never store-derived (#210)

When the user parks the cursor on the radial dial, the four chips above it (Irradiance, Cloud,
Production, Battery) now read from Home Assistant directly at the cursor instant, never from the
unified data source. The store still drives the curve geometry on the dial, but a chip is an
entity readout and the user expects it to track the sensor: at instant `t` the chip shows what HA
recorded at `t`, with no interpolation layer in between.

Reader paths:
- Production: same path the timeline tooltip already used (`pvValueAtTime` on `_pvHistory` raw +
  `_pvCalibStats` LTS), forecast fallback rejected so the chip never blends a modelled W.
- Battery: linear interp on `_batteryPowerHistory` raw.
- Cloud / Irradiance: linear interp on the Open-Meteo `_chartSeries`.

Future instants and gaps outside the raw sources resolve to `—` (no synthetic value). The bottom
mini-card pair (`renderCardChartBlock`) follows the same rule for its Production chip; the
Forecast chip in that pair has no HA source so it keeps reading the modelled series.

### Data source rework, two cadence knobs, every graph plugs into it (#210)

The previous beta filled past production gaps with the forecast model so the radial dial curve
read as continuous between LTS samples. The user reported (rightly) that the curve was lying about
the sensor: 3 buckets out of 4 in the past were showing modelled watts dressed up as real
production. This release reworks the data source to be strictly honest about what is measured vs.
what is modelled.

**Two cadence constants, single place each:**

- `DATA_BUCKETS_PER_HOUR` controls how dense the data source itself is. Every real sample (LTS
  hourly, PV raw push, weather hourly, battery, grid) lands into a bucket of `HOUR_MS /
  DATA_BUCKETS_PER_HOUR`. Past buckets that didn't receive a sample are filled by linear
  interpolation between the two surrounding REAL samples, never by a model fallback. The data
  source is never lying about the sensor.
- `DISPLAY_BUCKETS_PER_HOUR` controls how every graph (radial dial, timeline production curve)
  reads the source. When equal to the data cadence, graphs read the stored values verbatim;
  otherwise `sliceForDay` / `sliceForRange` resample linearly between bracketing storage buckets.

**Production and forecast are peers, never mixed:**

- Production carries the LTS calib stats + raw PV history, bucketed and linearly interpolated in
  the past slice. Future buckets stay null.
- Forecast is its own series: `computePvPowerWeighted × calibration × shading map × cap clip` at
  every DISPLAY bucket across the full 5-day window.
- The radial dial overlays them as two distinct curves (production fill + dashed forecast outline).
  The dashboard timeline now also reads both from the same source via `sliceForRange`.

**What changes in renderPvChart (timeline production curve):**

- The local samples-merge pass (cumulative-energy differentiation + raw + LTS interleave + sort +
  1500-point decimation) is gone, the chart reads the production array directly from the data
  source at DISPLAY rate.
- The local forecast loop (`computePvPowerWeighted` per `_chartSeries` sample) is gone, the chart
  reads `store.forecast` instead. The watts-to-native unit conversion stays as the single bridge
  between the source (always watts) and the chart Y axis (entity-native unit).
- The cloud + irradiance chart `renderChart` is unchanged: it draws point-to-point on the raw
  Open-Meteo samples, which already meets the "real data only, no forecast mix" contract.

The radial dial migration that landed in beta.70/71 stays in place but the upstream production
series no longer borrows the forecast at past-null buckets; gaps are linearly interpolated between
real LTS rows, so the visible curve reflects the sensor and only the sensor.

### Unified 5-day data store, radial dial migrated (#210)

The dashboard had been growing every per-time signal (irradiance, cloud cover, production, forecast,
battery, grid import / export) as its own per-render bucketization pass; the radial dial, the timeline
and the graph view each walked the same raw sources and produced subtly different bucket alignments,
so hover spheres on the radial did not land exactly on the same hour as the timeline. This release
introduces a single source of truth for everything from J-2 to J+2: 480 buckets of 15 min granularity
held on the card instance, rebuilt only when the source array hashes change so idle frames cost nothing.

The radial dial migration ships in this beta. `prepareRadialDayData` is now a thin wrapper around
`sliceForDay(store, cardOffset)` that carves the 96 buckets for the requested calendar day out of the
5-day store, instead of running five independent compute loops per render. Five per-day compute helpers
(production, forecast, battery, cloud, irradiance) and the linear gap-fill helper are deleted (-310
lines). Timeline + graph view migration land in the next beta, the first card to consume the unified
store sets the contract for the rest.

Live chips intentionally stay off the store and keep reading `hass.states[entity]` directly; bucketing
live values would either bloat the store with one bucket per WS push or lose the per-second precision
the chips need.

### Drop raw history fetch + boot loading overlay

Two complementary cleanups now that the card is wired to the HA Energy dashboard end-to-end:

- `refreshPv` no longer fires the `history/history_during_period` raw 6 h fetch. That call was the single
  heaviest WS round-trip the card made (4-source 1 Hz Victron install = ~5-10 MB payload, single-threaded
  SQLite recorder scan blocking every other read for the duration). With HA Energy as the source of truth the
  raw window is no longer load-bearing for any single feature, the chart already blends `_pvCalibStats` /
  `_pvTrainerStats` for the past portion and the right-edge live tail keeps extending via the
  `hass.states[entity]` pushes appended directly to `_pvHistory`. Same approach the HA Energy panel itself uses.
- Boot loading overlay (spinner + warning panel) removed. The overlay was waiting on the slow raw fetch; with
  that gone the user-perceived first paint is sub-second and the overlay was flashing for nothing.
- The `_energyDefaultsLoaded` flag + `refreshHaDailyTotals` early kickoff stay around as an internal perf win
  (the recorder daily-totals query now lands the moment the HA Energy prefs snapshot parses, instead of
  waiting up to 30 s for the next periodic tick).

### Boot spinner = the 3D card sun, fills with progress + Helios casing in HA catalog

- The boot loading spinner is now the exact same 4-layer sun disc the engine paints over the home on the 3D
  card: halo radial gradient + low-opacity background disc + inner fill + outer rim. The inner-fill radius and
  halo radius / alpha are driven by the boot progress ratio (resolved required slots over total required slots),
  so the disc literally fills as each WS round-trip lands and the irradiation reads as growing alongside.
  Subtle rim breathing pulse so the spinner never sits perfectly still even at 0 %.
- The card name in the HA card catalog is now `Helios` instead of `HELIOS` (all 63 locales updated). The
  console banners + diagnostic messages keep their stylised `☀ HELIOS` because they are developer-facing.

### Dashboard chart morning gap , LTS calib blended into the cumulative + hourly aggregators

The dashboard's today-card cumulative kWh chart and the hourly-bin aggregator that feeds the headline "X kWh
produit" + "PIC RÉEL HH:MM" only walked `_pvHistory`, which is capped at the last 6 h of wall-clock time (HA
recorder is single-threaded behind SQLite, multi-day raw scans on a 1 Hz Victron block every other card reading
the same entity). Opening the card at, say, 22 h made the chart paint as "0 kWh until 16 h" because the morning
production from 6 h to 16 h was not in the raw window, even though the timeline chart had no issue (the timeline
already blended `_pvCalibStats` for its own past-portion painting).

`computeTodayCumulative` and `computeTodayHourly` now blend `_pvCalibStats` (5-day hourly LTS already fetched
for the calibration loop) into the integration alongside the raw samples. The raw window still owns the present
tail at full resolution; LTS rows that cross into the raw window are dropped so the two sources never paint over
the same hour. Cumulative entities get neighbour-pair differentiation on the LTS state, power entities get the
hourly mean directly, same shapes used elsewhere in the codebase.

Result: the dashboard chart covers the full local day from 00 h to "now" regardless of when the user opens the
card, and the PIC RÉEL reading lands on the real peak even if the live raw window has slid past it.

### Boot loading hot-fix , daily-totals kickoff + 30 s timeout

Reported by ReikanYsora: alpha.35 was reaching the 15 s timeout and surfacing the warning panel with
`pv_today`, `grid_import_today`, `grid_export_today` missing every time. Two compounding causes:

- `refreshHaDailyTotals` was called at `connectedCallback` time but the HA Energy defaults snapshot had not
  landed yet (the parse is async), so the call was a no-op. The next actual run waited for the 30 s tick, which
  was past the boot timeout.
- 15 s was simply too tight for first-mount scenarios where the recorder query takes 5-10 s on installs with
  many entities.

Fix:

- `updated()` now fires `refreshHaDailyTotals` exactly once the moment `_energyDefaultsLoaded` first reads true,
  so the three `*_today` recorder queries land within the boot window.
- Boot timeout extended from 15 s to 30 s.

### Boot loading state , map-only + home-build spinner + warning panel on timeout

The card now boots in a dedicated loading state instead of paining its UI piece by piece as the various WS
round-trips resolve. Only the map basemap renders during the loading phase; every other DOM element (chips,
leaders, timeline, dashboard, mode bar, sun, cloud, irradiance overlays) is hidden behind opacity 0 +
pointer-events none, and a centred home-outline build animation draws and re-draws under a backdrop-blurred
overlay to signal "chargement en cours". The gate watches every configured data source independently: engine
+ MapLibre style ready, HA Energy prefs parsed, PV history + LTS calib + LTS trainer + today-kWh recorder
totals if PV is wired, battery SoC + power histories if battery is wired, grid import + export daily totals
if grid is wired. Sources the install does not configure are skipped, so a PV-only setup never blocks on a
never-arriving battery payload.

When every required source has landed the gate flips to `ready` and the full UI fades in over 500 ms. If the
15 s timeout watchdog fires first the gate flips to `failed` and a warning panel takes over the same overlay
with the per-source missing list so the user can see which piece of the dashboard the WS round-trip never
returned (HA Energy not configured, recorder timeout, MapLibre style fetch blocked by a corporate proxy, etc.).

### Critical fixes , "data outdated on first open" + "production curve shifted in time"

Two regressions converged into one root-cause investigation kicked off by LBDG_'s reports.

**1. Fetch key was changing every millisecond.** `refreshPv` was anchoring its raw-history fetch window on
`new Date(Date.now() - 6 h)`, which differs by milliseconds on every Lit cycle. The `fullFetchKey` flipped on every
hass push (one per state change of any HA entity on busy buses), the gate at `fullFetchKey !== _pvFetchKey` fired a
new WS round-trip every time, and the async resolutions raced each other on the `_pvHistory` write. The visible
symptom was the "data outdated on first card open" report: a stale in-flight fetch from a brief boot-window resolved
on top of a fresh one, the user saw the older snapshot until navigating away long enough for the stale promises to
settle. Fix: round the cap to a 1-minute boundary so the key flips at most once per minute, the live chip + tooltip
keep updating on every push from the unrelated live-state read.

**2. Multi-source cumulative aggregation injected phantom kWh jumps.** When one of several solar sources came online
mid-window (e.g., a Victron MPPT booting up at 13:00 with a lifetime cumulative of 1000 kWh), `aggregatePvHistoriesLkcf`
was summing the raw cumulatives and the 1000 kWh "appeared" at 13:00 as if produced in that instant. The dashboard's
today-kWh integration then attributed the whole jump to "today's production starting at 13:00", which is exactly the
shape LBDG_ reported, "Je n'ai pas commencé à produire après midi mais bien avant". Fix: per-entity baselining inside
`aggregatePvHistoriesLkcf` when the `cumulative` flag is on: each entity is captured at its first observed value
within the window and only its delta-since-arrival contributes to the sum from there. Power sensors pass `cumulative:
false` and keep the raw-sum path because baselining a W reading is meaningless.

`fetchPvHistory` and `fetchPvStatistics` (calibration LTS + trainer LTS) accept and forward the flag; `refreshPv`
detects cumulative from `_pvUnit` and passes it through.

### Dashboard cumulative chart , per-source breakdown on hover

The today-card cumulative kWh chart now lists every HA Energy solar source under the aggregate "actual" value in
its hover tooltip on multi-source installs. Each per-source row carries the entity `friendly_name` from
`hass.states`, the per-source cumulative kWh integrated up to the hover instant using the same baseline /
counter-reset rules as the aggregate, and a colour pastille matching the per-source curve on the timeline above.
Single-source installs see no change.

### Per-source PV curves + tooltip breakdown

Multi-source HA Energy installs now render one PV curve per source on the timeline chart, drawn under the
aggregate line with reduced opacity so the headline total still reads as the dominant trace. Colours follow a
hue rotation around the theme PV color token, so a 2-source split E / W lands on opposite hues, a 3-source
install on 120 ° spacing, etc. The same per-source colour shows up as a pastille on the scrub tooltip breakdown
rows that list every source by its HA `friendly_name` next to its value at the cursor instant, so the user can
read row to curve at a glance.

Single-source installs skip both the per-source curve loop and the breakdown rows (the per-entity map carries
one entry equal to the aggregate, drawing it would just paint a duplicate trace at lower opacity).

### Multi-bank battery history aggregation

Mirrors the alpha.30 PV history shape on the battery side. `fetchBatteryHistory` now accepts an array of SoC
entities and an array of power entities, fires a single recorder / history WS round-trip with every wired bank,
and aggregates per-entity histories via a generic last-known-carry-forward walker. SoC uses arithmetic mean (HA
frontend convention), power uses a signed sum with per-entity inversion applied via `invertedRateEntities`
before reduction so a mixed wiring (standard sign on bank A, inverted on bank B) still aggregates correctly.
Single-bank installs collapse to the per-entity series unchanged. The fetch cache key embeds every entity sorted
so adding / removing a bank invalidates the previous snapshot.

### Multi-source PV history + LTS aggregation + multi-bank battery live (Phase 2 / 2)

Completes the multi-source story started in alpha.29:

- `fetchPvHistory` now accepts the full array of wired solar entities, fires a single WS round-trip with every
  entity id, parses each per-entity history, and aggregates via last-known-carry-forward at the union of
  timestamps. The cache key embeds every entity (sorted) so adding / removing a source invalidates the previous
  snapshot. The chart curve + scrub-past now reflect the SUM, matching the live chip + tooltip + dashboard
  headline that alpha.29 fixed.
- `fetchPvStatistics` follows the same shape for both the 5-day hourly calibration LTS and the 30-day 5-min
  trainer LTS. The calibration ratio is learned against the summed predicted-vs-actual instead of the
  first-entity share, and the shading trainer trains on total production.
- `_pvHistory` tail-extension is restored in multi-source mode (it was gated off in alpha.29 to keep the
  single-entity historical tail visually consistent), since `_pvHistory` now carries the summed series.
- Battery multi-bank live SoC averages across every `stat_soc` entity, mirroring the HA frontend logic in
  `hui-energy-distribution-card.ts:213-225`. Battery multi-bank live power sums across every wired source with
  per-entity sign-flips applied via `invertedRateEntities` before the sum, so a mixed wiring (standard sign on
  bank A, inverted on bank B) still aggregates correctly.

Outstanding for a follow-up: battery multi-bank HISTORY aggregation (scrub-past on multi-bank installs still
walks the first bank's series until the recorder + interpolation refactor lands for `fetchBatteryHistory`).

### Multi-source PV live aggregation (Phase 1 / 2)

Installs with several solar sources declared in HA Energy (typically split E / W arrays each declared as its own
solar source) were only ever showing the FIRST entity in the chip, the tooltip and the dashboard headline, because
`resolvePvLiveEntity` collapsed the multi-source array down to `[0]`. `refreshPv` now sums the live state across
every wired source: each entity is normalised to W via `pvNormalizeToWatts` and the total is stored as the
canonical W value, so the chip + tooltip + dashboard reflect the real combined production. The rolling sample
buffer + the live tail tracking follow the same path.

History fetch + scrub-past + the chart curve itself stay single-entity for now (a follow-up reshapes
`fetchPvHistory` + `_pvHistory` into an entity-summed series), so the chart's right edge does NOT extend past
the last full history fetch in multi-source mode, keeping the historical tail (single entity) visually
consistent with itself until Phase 2 lands.

### Grid import / export past-scrub chip values restored

The entity refonte in #184 retired the card-level `grid-import-entity` / `grid-export-entity` YAML slots, but
`resolveEntities` inside `grid.ts` still only checked those keys. For v1.8.3 installs wired exclusively through the HA
Energy dashboard, `readSlot` saw an empty entity list, never populated `_gridImportSamples` or `_gridExportSamples`,
and the import / export chips read blank during past-scrub. The LIVE chip kept working because `readStatRates`
mirrored the HA Energy `stat_rate` power sensor on top, but the sample buffers stayed empty so any scrub off the
"now" cursor showed nothing. `resolveEntities` now falls back to `_energyDefaults.gridStatEnergyFroms` /
`gridStatEnergyTos` when the YAML slot is empty, so the directional kWh sensors from HA Energy drive both the live
slope derivation and the past-scrub sample buffer. The combined slot stays YAML-only, so the display logic in
helios-card.ts keeps the same decision tree.

### Past scrub grid values restored after the hass setter throttle was rolled back

The custom `hass` setter shipped in alpha.26 carried a stale-states corner case on installs where HA mutates
`hass.states` in place instead of replacing the reference. The setter's `prevStates !== nextStates` short-circuit
suppressed every render in that mode and `refreshGrid` stopped appending live samples to `_gridCombinedSamples`, so
the import / export chips read blank during past-scrub once the existing buffer drifted past the cursor. The setter
is rolled back; the four other PART 5 wins (auto-rotate suspend, binary search, daily totals singleton, sky timer
clear on pause) stay in. A safer setter shape lands in a follow-up.

### Forecast accuracy + main-thread performance pass

Forecast (PART 4 audit follow-ups):

- Hemisphere-aware default azimuth, southern-hemisphere installs that leave the field blank now default to north
  (`0`) instead of south (`180`), eliminating a systematic 10-30 % under-prediction for AUS / NZ / South-American
  users.
- DST-safe day iteration in the 5-day calibration loop and in the today / tomorrow dashboard windows. Spring-forward
  (23 h) and fall-back (25 h) days now land on the correct local midnight instead of 01:00 / 23:00.
- Calibration ratio is no longer clamped per-day before averaging, the single clamp on the final mean preserves the
  full signal from outlier days (a real 2.0 day no longer gets dragged toward 1.0).
- Cloud cover layers are clamped to [0, 100] individually before the weighted sum, so an upstream Open-Meteo quirk
  on one layer cannot bleed an off-balance contribution into the final value.
- Mid-day cumulative counter reset (sensor restart, integration nodered restart, daily reset on a utility-meter)
  re-baselines so the today-kwh stays monotonic from the last known total, instead of jumping backward.
- `computePvPowerWeighted` gains a defensive bounds check on the `pvArrays` output to keep a future drift in array
  lengths from silently propagating NaN through the forecast.

Performance (PART 5 audit follow-ups):

- Auto-rotate rAF loop suspends itself when the editor toggle is OFF or the camera-locked switch is ON instead of
  self-resubmitting at 60 Hz for the full life of the engine. The loop re-arms from `updateConfig` whenever the
  user flips either flag back to the rotation-permitting state. The default install ships with auto-rotate OFF, so
  this drops a continuous CPU sink that was burning ~4-6 % of one core for nothing.
- Custom `hass` setter that diffs only the entity ids the card reads (PV / grid / battery slots resolved from the HA
  Energy defaults) and skips `requestUpdate()` when none of the watched states moved. A 1 Hz Victron / Shelly install
  with a busy state bus (a smart thermostat, a phone battery, MQTT lights) used to push a full Lit render on every
  unrelated state change, now those pushes land silently and only the relevant watts ticks redraw.
- Binary search over `_pvHistory.times` inside `pvRateAtTime` and `interpAt`. The scrub tooltip used to linear-scan
  from index 0 on every Lit render; on 1 Hz sensors the history reaches ~21,600 entries over a 6 h window, so the
  tooltip path is now O(log n) per call instead of O(n).
- HA daily totals fetch is shared across cards on the same dashboard. A new module-level cache keyed by
  `(local_date, sorted_statistic_ids)` with a 25 s TTL + in-flight Promise dedupe means an N-card dashboard hits the
  recorder once per 30 s window instead of 5N times.
- The 60 s sky / atmosphere refresh interval is cleared on `setPaused(true)` so a scrolled-away card no longer wakes
  the page every minute just to early-return.

### Scrub tooltip Live chip aligned with the time row

The Live chip now lives as the last flex child of the time heading row, pushed to the right edge via
`margin-left: auto`. Flexbox alignment vertically centres the chip on the clock glyph + the time label automatically,
no more absolute positioning against the tooltip padding.

### Scrub tooltip time heading + Live chip blur + vertical centering

The scrub-timeline tooltip now opens with a time heading (`clock` glyph + bold hour, left-aligned) sitting above a
hairline separator that matches the data-row alignment underneath. The Live chip got a proper pixel-snap layer
(`translateZ(0)` + opaque card-background fill) so the 1 px primary-coloured border and the LIVE label render crisply
on high-DPI displays, and its content sits on a fixed 18 px line-height with `line-height: 1` so the pulsing dot and
the label are vertically centred inside the chip frame.

### Battery sign convention follows the HA Energy `stat_rate_inverted` slot (#185)

Battery and grid live reads now respect the inverted slot that some installs use when the meter reports the opposite of
the HA convention (typically positive on discharge / export instead of positive on charge / import). The energy-prefs
parser tracks which entities were declared in `stat_rate_inverted` and the per-sample readers flip the sign at read
time, so the +/- battery icon, the live chip, the chart and the daily totals stay consistent with what the HA Energy
dashboard itself shows.

### Entity configuration refonte: HA Energy dashboard is the single source of truth (#184)

The card retires the per-card entity slots for everything the HA Energy dashboard already declares: `pv-power-entity`,
`grid-import-entity`, `grid-export-entity`, `grid-power-entity`, `grid-power-invert`, `battery-soc-entity`,
`battery-power-entity`, `battery-power-invert`, `batteries`. The runtime resolver now walks `EnergyPreferences` from the
`energy/get_prefs` WebSocket call and feeds every consumer (live chips, scrub past, chart, daily totals, calibration)
from there. When the user opens their card YAML and one of the retired keys is set, the card fires a one-shot HA
persistent notification listing the ignored keys and pointing them at `Settings → Dashboards → Energy → your sources`.
The chip stays hidden when no matching Energy dashboard source is configured, no in-between guessing layer.

Kept on the card YAML, because the Energy dashboard does not surface them: `pv-peak-kwp`, `pv-arrays` (per-string tilt,
azimuth, share, optional GPS position), `pv-inverter-max-kw`, `solar-radiation-entity`, `inverter-cutoff-soc-pct` (now
reading the resolved `stat_soc`), `home-latitude` / `home-longitude` (override for the `hass.config.latitude` staleness
bug), every LiDAR provider and rendering option, every visual / camera / timeline option.

`EnergyDefaults` is restructured around per-source arrays: `solarStatRates`, `solarStatEnergyFroms`, `gridStatRates`,
`gridStatEnergyFroms`, `gridStatEnergyTos`, `batteryStatRates`, `batteryStatEnergyFroms`, `batteryStatEnergyTos`,
`batteryStatSocs`. Multi-source installs (multi-tariff grid, multi-bank battery) aggregate by simple sum across the
arrays at the consumer; the multi-bank weighted-SoC model from earlier cycles is dropped because HA Energy has no
concept of per-source capacity. The deep multi-source fan-out inside `pv.ts`, `grid.ts` and `battery.ts` lands across
follow-up commits in this same cycle; the foundation commit ships the new shape, the runtime + the migration warning.

### Live grid chip matches HA Energy dashboard (#172)

When the HA Energy dashboard config exposes a `stat_rate` signed
power sensor on any grid source, Helios now reads it directly
from `hass.states` (no slope, no aggregation) and routes the sign
across the IMPORT / EXPORT chips the same way HA does in its
own `hui-power-sankey-card.ts`. The directional `grid-import-entity`
/ `grid-export-entity` cumulative kWh buffers populated by
`readSlot` keep driving scrub and chart history, only the LIVE
chip value is overridden.

Priority order in `refreshGrid` (highest to lowest):

1. `grid-power-entity` (user-explicit combined signed sensor) routes
   through `readCombined` and wins outright.
2. `readSlot('import')` + `readSlot('export')` run unconditionally
   so the scrub / chart-history buffers stay warm regardless of
   which path drives LIVE.
3. When `_energyDefaults.gridStatRates` is non-empty, `readStatRates`
   overrides the LIVE chip values with HA-aligned instantaneous reads.

`EnergyDefaults` gains a `gridStatRates: string[]` field collected
from every grid source's `stat_rate`, populated through the existing
long-running `energy/get_prefs` subscription in `card/energy-prefs.ts`.
When no `stat_rate` is configured on any Energy dashboard source,
the v1.8.2 legacy kWh-slope behaviour is preserved exactly.

### Grid backfill resilience (#173, #174, #175)

The raw arm of `ensureHistoryFetched` is now wrapped in
`.catch(() => null)` symmetrically with the LTS arm. A single
transient failure (recorder timeout, network glitch, custom
sensor without `state_class`) no longer wipes both arms via
`Promise.all` rejection; whichever arm returned data populates
the buffer. A `WsTimeoutError` on either arm arms the cooldown
gate the same way as before.

Effect on the two-windows-disagree symptom users reported on
v1.8.2: when one card's raw fetch timed out and the other's
succeeded, only one buffer got populated and the chip values
diverged. The symmetric catch closes that gap.

`readSlot` records the sample BEFORE the per-unit derivation so
the scrub buffer is populated for power-native sensors too. The
previous gate inside the kWh branch left the scrub buffer empty
when the user wired a `W` / `kW` / `MW` sensor on `grid-import-entity`
or `grid-export-entity`, the closest-sample-wins lookup in
`gridWattsAtTime` returned null and the chip during scrub mode
showed nothing.

`GRID_LTS_WINDOW_MS` extended from 24 hours to 5 days, matching
`GRID_SAMPLE_WINDOW_MS` retention. Scrub coverage on grid chips
returns to a 5-day past window. LTS bucket queries hit HA's
pre-aggregated `statistics_short_term` table so the recorder
stays unaffected (1440 buckets per entity served from a single
SQLite read, sub-second on a healthy install).

### Fullscreen polish (#176, #177, #178, #179)

Chip cluster gains a dedicated `_clusterLiftScale()` (max 2.4x
vs the horizontal `_heliosScale()` 1.6x). On fullscreen / kiosk
canvases the chip-to-home leader length grows faster than the
horizontal chip spread; the home stays visually anchored in the
lower half of the scene instead of pinching up next to the chip
cluster. The horizontal chip-spread ramp stays at 1.6x max so
the cluster does not run off-centre.

Sun arc max ramp drops from 3.0x to 2.2x. The arc no longer
overshoots the chip cluster on a 1500 px-wide canvas. Both call
sites (`_sunSpherePoint` for the arc itself, `_projectSpherePoint`
for the shading-dome cells) consume the same updated constant.

Sun disc + halo consume the sun-arc scale via a new
`getSunArcScale()` public engine method, so the disc keeps the
same fraction of the arc length regardless of canvas size. No
more tiny dot on a gigantic curve.

Mode-bar handlers (Layer / LiDAR / Dome) call a new
`_exitScrubMode()` helper before swapping mode, the scrub
tooltip no longer floats orphaned at the bottom of the card
after the timeline geometry shifts.

At standard Lovelace grid sizes (<= 600 px wide), all the scale
ramps stay at 1.0 and the geometry is identical to v1.8.2, no
regression on regular dashboards.

## v1.8.2

> Hardening release on top of v1.8.1. The cycle focuses on three
> things: recorder relief for installs with high-frequency
> sensors (1 Hz Victron Cerbo, JK BMS, Ecowitt feeds and
> similar) so loading Helios no longer blocks every other card
> on the dashboard for 30 to 100 seconds on each mount, camera
> pose + lock persistence to localStorage so the framing
> survives page reloads, and a chip family harmonisation pass
> (cloud chip joins the canonical recipe, leader-bead radii
> unified, sun arc gets its own fullscreen ramp). The dashboard
> panel's today's battery totals are back to a full-day window
> after beta.4 over-trimmed them, and the back-to-live
> affordance is now a real tab anchored to the chart card.
>
> The full beta-by-beta narrative is preserved below. Upcoming
> work is tracked live on the public roadmap at
> [helios-lidar.org/roadmap](https://helios-lidar.org/roadmap),
> pulled directly from the GitHub Project and refreshed every
> five minutes.
>
> Special thanks to **LBDG_** and **JJAsond** for the relentless
> field testing on 1 Hz installs throughout the entire beta
> cycle. They turned the recorder pressure investigation from
> "intermittent, slow, weird" into a precise diagnosis (the
> grid module's 72 h raw window being the last hot path, the
> raw-window cap anchor mis-sourced from the forecast horizon,
> the LTS arm being over-capped in beta.4) and validated each
> beta in production before it shipped. v1.8.2 would not be
> where it is without their patience.

### beta.8

### Cloud chip joins the canonical chip family

The cloud-cover chip and its three layer sub-chips (low / mid /
high) read with a different visual recipe than the rest of the
chip family: 1 px divider-grey border vs the canonical 2 px
coloured ring used by PV, SoC, Grid In and Grid Out. The cloud
chip also lifted by 1 px on hover (translateY) which left the
top-anchored pill bouncing visually each time the cursor entered
or left it.

The cloud chip now uses the same compact pill recipe as PV / SoC
/ Grid: 2 px ring in the configured cloud colour
(`--helios-cloud-color`, falling back to the HA secondary text
token then `#727272`), `gap: 4px`, `min-width: 56px`, `padding:
3px 10px`, `ha-icon` sized at 16 px to match. The 22 px fixed
height is gone, the padding now drives the chip dimensions
exactly like the other chips.

The hover transform is gone. On hover the chip stays anchored at
its X-centred top spot and the box-shadow softens from
`0 1px 3px` to `0 2px 8px`; on active the shadow drops back
flat. The user explicitly asked for shadow-only feedback so the
chip does not move around.

The three layer sub-chips get the same 2 px coloured ring so the
detail view reads as a coherent group with the parent chip.

### beta.7

### Sun arc gets its own fullscreen ramp

beta.5 scaled both the sun arc radius and the home chip cluster
offsets through a single helper `_heliosScale()` that ramped
from 1.0 at min(width, height) <= 600 px to 1.6 at >= 1200 px.
The chip cluster looked right at that ramp, but the arc still
read as small on a fullscreen / kiosk canvas.

The arc is computed in world metres, projected by MapLibre at a
fixed zoom: at the standard 440 px-wide card 40 m maps to ~140
CSS px and fills the lower half of the canvas. On a 1500 px-wide
kiosk canvas the same 40 m still maps to ~140 px and gets lost
in the empty space. The chip cluster, which is computed directly
in pixel offsets, did NOT need the same multiplier.

A dedicated helper `_sunArcScale()` ramps the arc on its own from
1.0 at <= 600 px to 3.0 at >= 1200 px, applied at the two call
sites (`_sunSpherePoint` for the arc itself,
`_projectSpherePoint` for the shading-dome cells that share the
same celestial hemisphere).

The chip cluster ramp (`_heliosScale()`) stays at 1.6 max so the
home chips do not over-spread on a wide canvas.

### beta.6

### Battery dashboard panel today's totals, restore full-day integration

The dashboard panel (the dive-in view opened by clicking the
home) shows today's charged / discharged kWh totals for the
battery, computed by `computeBatteryToday` integrating the
signed power curve from `_batteryPowerHistory` between local
midnight and now.

beta.4 capped every history fetch at the last 6 hours to keep
the recorder responsive on 1 Hz installs. That cap applied to
BOTH arms of `fetchBatteryHistory`: the LTS arm
(`recorder/statistics_during_period`, 5-minute period) and the
raw fallback. The LTS arm is near-free on the recorder
regardless of source frequency, so capping it served no perf
purpose; what it cost was the morning portion of today's
battery curve, and the panel reported a fraction of the day's
true charged / discharged energy as a result.

`fetchBatteryHistory` now takes two start anchors:

- `ltsStart`: the full visible timeline range (typically midnight
  or earlier). The LTS arm queries the recorder over this
  broader window so today's totals integrate across the full
  current day.
- `rawStart`: the last 6 hours. The raw fallback (used only
  when the entity is not LTS-tracked) keeps its cap so a 1 Hz
  BMS without `state_class` does not drag the recorder.

PV, grid and W/m² were not affected: PV's chart blend already
falls through to the 5-day hourly LTS slot for past beyond 6 h,
grid's two-tier backfill (24 h LTS + 6 h raw) landed in beta.3,
W/m² is not surfaced on the dashboard panel.

### beta.5

### Uniform beads, fullscreen polish (#33)

**Leader-bead radii unified.** The animated discs that ride the
solid leaders between the home and its chips were sized
inconsistently across the family: `r=4` on PV and battery,
`r=3.5` on grid import / export, `r=5` on the solar ray. All five
classes now use `r=3` (6 px diameter), matching the visual weight
HA Energy gives to its own flow circles when rendered at the
typical card size.

**Fullscreen / kiosk layout polish (#33).** When the card is
rendered above 900 CSS px wide (a dedicated solar dashboard view,
a kiosk panel, mobile portrait on a tablet), the layout used to
keep the chip cluster clumped in the central 25 % of the canvas
and the sun arc pinned to its grid-tuned 40 m radius.

A new engine helper `_heliosScale()` ramps a multiplier from 1.0
at min(width, height) <= 600 px to 1.6 at >= 1200 px, fed by the
existing ResizeObserver-backed canvas dimension cache. The
multiplier scales:

- `SUN_ARC_RADIUS_M`: the celestial hemisphere the sun arc and
  the shading-dome paint on stretches with the card, so the arc
  reads from across the room.
- `PV_CHIP_OFFSET_PX`, `CHIP_SIDE_X_OFFSET_PX`, `CHIP_STACK_GAP_PX`,
  `CLUSTER_LIFT_PX`: the chip cluster around the home spreads
  proportionally, so the PV / battery / grid pills no longer
  collide in the centre.

At standard Lovelace grid sizes scale = 1.0 and the geometry
stays exactly as before.

CSS-side, a new `@container helios-card (min-width: 900px)` rule
bumps the typography on the value chips (PV / battery / grid /
cloud / solar), the day-strip, the hover tooltip and the cloud
layer chips so they stay readable at the same distance. The
container query targets the card's own width via
`container-type: inline-size` on `ha-card`, so a Helios card
sitting in a wide section view alongside narrower cards flips
on its own size, not the viewport's.

### beta.4

### Fix the beta.1 raw-window cap anchor, restores past chart history

beta.1 capped the PV, W/m² and battery raw fetches at the last
6 hours and computed the cap as `fetchEnd - 6 h`, where
`fetchEnd` was sourced from `host._timeRange.end` (the forecast
horizon, typically next day 23:59) rather than wall-clock time.
On any timeline where `end > now`, the resulting `fetchStart`
fell in the FUTURE.

Each `fetch*History` helper then ran its own "clamp end to now"
pass, and the resulting `start >= fetchEnd` condition tripped
the early-return that blanks the slot to `{times: [], values:
[]}`. The chart's past portion stayed empty and the curve only
started painting from the moment live state pushes began
landing (i.e. from the refresh instant forward).

The three sites (`refreshPv`, `refreshBattery`,
`refreshSolarRadiation`) now anchor the cap on `Date.now()`
directly, so `fetchStart` always sits 6 hours back from real
wall-clock time and the inner clamp leaves the slot populated.

### beta.3

### Grid LTS backfill, restores past-scrub coverage to 24 h

beta.2 capped the grid raw backfill at 6 h to unblock the
recorder on 1 Hz installs. The trade-off was that scrubbing the
home card timeline past 6 h returned no value on the grid
import / export chips (pickBracket refused to extrapolate
beyond the buffer edge). This release adds the missing piece
without re-introducing the recorder stall.

The grid backfill is now two-tiered, mirroring the recipe the PV
chart already uses:

- LTS at 5-minute period covers the 24 h..6 h slice
  (~216 buckets per entity). Pulled from HA's pre-aggregated
  `statistics_short_term` table, near-free on the recorder
  regardless of source frequency.
- Raw, full resolution + `significant_changes_only`, covers the
  6 h..now slice. Bounded at ~10 to 20 k rows per entity on a
  1 Hz meter, completes in 1 to 2 s.

Both arms fire in parallel through the existing module-level
WS semaphore (cap 2 in-flight). The LTS arm is wrapped in a
silent `.catch` so a custom sensor without `state_class` (no
LTS available) degrades to raw-only and the user-facing
behaviour stays as-is.

LTS samples land in the same `Sample[]` buffer as the raw
samples, so `pickBracket` works as-is. Cumulative-energy meters
anchor LTS samples at the bucket end (consecutive `state`
deltas attribute to the correct bucket); power-native meters
anchor at the bucket midpoint and use `mean` directly.

The buffer retention window also bumps from 6 h to 24 h so the
live accumulation does not trim off bracket-relevant history
mid-session.

### beta.2

### Grid history window 72 h -> 6 h, the last recorder hot path

beta.1 capped the PV, W/m² and battery raw fetches at 6 hours and
the user-visible 100-second IO stall shrank but did not go away.
A re-audit of every WebSocket recorder call on the card surfaced
the remaining offender: the grid module
(`src/card/grid.ts`) was still fetching a 72-hour raw window
per grid entity on every card load. On a Victron Cerbo or
similar setup at 1 Hz that's ~250 000 rows scanned per import
+ export + optional combined entity, dwarfing every other fetch
the card issues.

`GRID_HISTORY_WINDOW_MS` (and the matching in-memory
`GRID_SAMPLE_WINDOW_MS`) drop from 72 h to 6 h. The trade-off
accepted is that scrubbing the timeline beyond 6 hours past now
returns a flat extrapolated watt value (the bracket-pick hits
the buffer edge), instead of a true historical bracket. Live
chips, recent past chart and short-scrub tooltips stay
accurate.

Combined with beta.1's caps, every recorder-bound call the card
issues on load is now at most 6 hours of raw data per entity,
and the LTS slots (calibration, trainer) keep the
multi-day past covered for the chart and the tooltip. A reload
mid-fetch no longer piles a fresh 100-second query onto the
queue; each query completes in 1 to 2 seconds even on 1 Hz
installs, so 5 rapid reloads cost ~10 seconds of recorder time
instead of ~500.

### beta.1

### Recorder relief on 1 Hz installs, camera persistence, back-to-live tab, polish

Direct follow-up to the beta.0 regressions and the high-frequency
sensor story. The card now leans on the LTS slots it already
fetched for everything older than the last 6 hours, so a Victron
Cerbo, JK BMS or Ecowitt setup at 1 Hz no longer drags the HA
recorder for tens of seconds every time the card loads. Camera
pose actually persists this time, the back-to-live control is a
real tab, and a handful of polish items land alongside.

**Recorder relief on 1 Hz installs.** The raw `history_during_period`
fetch behind the PV chart, the W/m² entity and the battery banks
used to ask HA for the full visible timeline (multiple days). On
a sensor pushing one value per second that scan dragged the
single-threaded recorder for 30 to 100 seconds on every card
load, blocking every other card reading the same entities for
the duration. The user reported disk IO jumping from 20 % to
67 % on InfluxDB-backed setups.

Three pieces:

- The raw window is capped at the last 6 hours per fetch site
  (PV, radiation, battery). The recent past keeps full
  resolution for tooltip and chart-head accuracy.
- The PV chart blends in the hourly LTS slot
  (`_pvCalibStats`, 5 days) for the past that the 6-hour raw
  window does not cover. The LTS slot was already fetched for
  the calibration ratio, so this is a free reuse, no extra
  recorder hit.
- The hover tooltip's `pvValueAtTime` falls through the same
  way: raw within the 6-hour window, LTS outside, forecast
  beyond "now".

Net IO drops by orders of magnitude on 1 Hz installs without any
visible quality loss on the chart or the tooltip.

**Past PV chart visible again.** A 1 Hz sensor over 6 hours
produces ~21 600 raw samples. The resulting SVG `d` path string
overflows Safari and Firefox's path rasterisers (the path
silently renders nothing), so the past portion of the chart was
showing up empty even though the tooltip read the correct
values. `renderPvChart` now decimates to at most 1 500 points
via per-pixel min/max bucketing so the visible curve still
reflects peaks and troughs at heavy compression. Same fix
incidentally speeds up every layout pass on the timeline by
~10×.

**Camera pose actually persists (#166 follow-up).** The
beta.0 fix wrote the pose under the engine's expected keys but
HA's lovelace does NOT persist `config-changed` events emitted
from a live card, only from the editor preview. The lock chip
now writes directly to `localStorage` under the key
`helios:camera-pose:<lat>:<lon>`. The engine reads the same
key on init, falls back to the legacy YAML keys for older
installs, and finally to the hemisphere-aware default. Locking
the camera, dragging it, reloading: the same pose comes back.

**Back-to-live is a real tab now.** The previous round
shipped a rounded capsule that read as a deformed button. The
new control is a proper tab: rounded TOP corners only, flat
bottom that overlaps the chart card's top border by 1 px so
the tab looks physically attached. Side still flips based on
the scrub position (scrub on the right -> tab on the left, and
vice versa). The tab's pointerdown and click both
`stopPropagation()` so a tap on the tab no longer bubbles up
to the time-bar's scrub handler (which used to re-scrub to
the tab's X coordinate and silently swallow the click).

**Lock button stripped of tooltip + i18n.** The `title=`
attribute and the two i18n keys (`cameraLockEnable`,
`cameraLockDisable`) are gone. A tooltip on a touch device
never shows, and the padlock glyph already carries the
meaning. `aria-label` for accessibility is implicit via the
icon's HA semantics, no localised string is generated on the
critical render path.

**Home glow z-index lowered.** The hover glow + production
pulse used to paint over the home cluster chips (PV, battery,
grid import/export). z-index drops from 9 to 6 so the glow sits
above the basemap and the solar ray but below all chips at z 8.

**Solar incidence ray thinner.** The dashed sun -> PV connector
was at `stroke-width: 1.5`, thicker than the other solid
leaders (which dropped to 1 in #164). Now also at 1 so the
connector family reads at one weight.

### beta.0

### Chrome simplification, camera pose persistence, CSS audit pass

First beta of the v1.8.2 line. Closes the alpha cycle by tightening
the on-card chrome in preparation for the upcoming HA Energy
integration: fewer chips on screen, the camera pose actually
sticks across reloads, the editor surface area shrinks, and a CSS
audit pass aligns the styling on HA's design tokens so the card
flips polarity cleanly with the host theme.

**Camera pose + lock state are now persistent (#166).** The lock
chip introduced in alpha.13 wrote the bearing and pitch under
`camera-bearing` and `camera-pitch`. The engine, on init, reads
`camera-bearing-deg` and `camera-pitch-deg` (the legacy editor
keys). The mismatch silently dropped the saved pose on every page
reload. The lock click handler now writes the `-deg` keys, so
locking + reloading restores the exact bearing, pitch and lock
state.

**Top-left chrome simplified (#167).** The date / time chip and
its scrub-mode "back to live" button are gone. The date is
promoted to the scrub tooltip (which now shows date + time +
readings) and the tooltip pins itself at the scrub cursor when
the user is not actively hovering, so the moment selected on the
timeline stays labeled. The back-to-live button moves to a small
scrub-blue tab on the time-bar that swaps side based on the
scrub position: cursor in the right half, tab on the left;
cursor in the left half, tab on the right, the two never
collide.

**Overlay layout restored (#168).** The camera lock chip moves
to the top-left rail (replacing the deleted clock chip) and the
three view-mode toggles (default layer, LiDAR view, shading
dome) move back to the top-right rail. The middle-right rail
introduced in alpha.13 is gone.

**Timeline day-strip tightened for phone widths (#169).** The
day-strip cells at the bottom of the timeline still overflowed on
narrow phones. The font-size clamp drops from `clamp(6px, 6.5cqw,
9px)` to `clamp(6px, 5.5cqw, 8px)`, the inline gap between the
date and the kWh value drops to 1 px, the cell padding to 1 px,
the `·` separator margin to 2 px, and the letter-spacing to 0.
The hierarchy (bold date, lighter italic forecast kWh) is
unchanged.

**Display radius locked at 300 m (#170).** Past 300 m the
basemap + LiDAR fetch and the per-frame projection start to
chug on mid-range phones, and the home cluster stops reading as
"near home" anyway. The editor slider is removed, the engine
returns the constant directly, and the two i18n keys
(`displayRadius` + `displayRadiusHint`) are dropped from every
locale.

**CSS audit pass.** A pass on the stylesheet against HA's design
tokens:

- Dead CSS removed: the `.lidar-view-toggle-btn` / `.lidar-view-chip`
  family is gone (the LiDAR toggle has been part of the
  `.mode-bar` radio group for several releases). Its dark-theme
  override is gone too.
- Token rename: `--text-primary-color` was a typo for
  `--text-on-primary-color`. Every consumer (`.mode-bar-seg.is-on`,
  `.camera-lock-btn.is-on`, `.tb-back-to-live`) now uses the
  correct token. The `#ffffff` fallback masked the typo so the
  visual output is unchanged.
- Hard-coded dark plate (`#191a1b` / `#e6e6e6`) on
  `.detail-close-btn`, `.dash-card` and the four bead strokes
  (`.pv-home-leader-bead`, `.battery-leader-bead`,
  `.solar-svg .solar-ray-bead`, `.dash-today-chart-hover-dot`)
  routed through `var(--card-background-color)` /
  `var(--primary-text-color)` / `var(--divider-color)` with the
  original hex as fallback.
- Missing fallbacks added on every `var(--primary-color)`,
  `var(--dark-primary-color)`, `var(--darker-primary-color)`
  occurrence so a theme that does not define the token (some
  community themes ship only the light grays) still gets the
  HA brand-blue palette.

### alpha.13

### Camera lock on the live card, hairline leaders, instant cloud-toggle

Three UI changes shipped together, each tracked in a dedicated
issue.

**Camera lock button on the permanent card UI (#163).** The
camera rotation X / Y sliders + lock switch are removed from the
editor "Camera" section (and the i18n keys that drove them are
gone with them). The same intent now lives directly on the live
card as a single lock chip pinned top-right: open padlock when
the camera is free, closed padlock when the pose is held.
Clicking the chip captures the bearing and pitch that the user
just dragged to, flips the lock state, persists the three values
to YAML through a normal `config-changed` event, and applies the
new lock to the live MapLibre instance in the same frame so the
button feel matches the visible map. Reload re-applies the saved
pose, since the values landed in YAML. The three view-mode
toggles (default layer, LiDAR view, shading dome) keep the same
X coordinate but move from the top-right rail to a new
middle-right rail, leaving the corner free for the lock chip.

**Hairline leader strokes (#164).** All six solid leader lines
on the home cluster move from `stroke-width: 2` down to
`stroke-width: 1` to match the connector lines on the Home
Assistant Energy dashboard. The card now reads as part of the
same Energy visual family when dropped on the same dashboard
view. The chart curves are untouched, their widths are tuned for
chart legibility rather than leader weight.

- `.pv-home-leader-line`
- `.battery-leader-line`
- `.grid-import-leader-line`
- `.grid-export-leader-line`
- `.home-drop-leader-line`
- `.cloud-layer-leader`

**Instant cloud-cover toggle (#165).** Tapping the central cloud
percentage chip used to expand the three layer chips (low / mid
/ high) and their L-shape leaders through a ~0.6 s cascade. The
cascade is removed entirely: the three chips and their leaders
appear and disappear in the same frame as the click. The
`transition` + every `transition-delay` rule on
`.cloud-layer-chips` and `.cloud-layer-leaders` are dropped, the
elements simply flip between `opacity: 0` and `opacity: 1`.

### alpha.12

### Pool reverted, shared fetch caches added

A deeper investigation into the Home Assistant frontend source
(see issue #162) confirmed that `hui-card.ts:195` hard-codes the
helios-card rebuild on every editor preview commit, with no
opt-out hook available. Cross-shadow-root DOM transplant of the
MapLibre container reliably broke rendering (basemap turned
black, timeline / solar arc overlays vanished), because the
moved node loses its old shadow root's CSS scoping AND lands in
a freshly-mounted parent whose layout has not yet resolved a
non-zero height, hitting the standard "container at 0 px causes
black canvas" failure mode.

Alphas 8 through 11 attempted to keep the engine alive across
the rebuild cycle and all introduced visible side effects.
Reverting to the simple lifecycle: every helios-card instance
owns its engine, creates it on mount, destroys it on disconnect.
The editor preview pane re-allocates a WebGL context per
config-changed commit, which is exactly what apexcharts-card,
mini-graph-card and Mushroom accept too. The live dashboard
tile is untouched, `hui-card` takes the `_updateElement` branch
when `preview === false` and the engine survives every
config-changed commit.

To make the per-commit recreation cheap, the parsed fetch
payloads are now cached at module scope:

- **Buildings**: the OpenMapTiles GeoJSON for the home is
  cached for 30 minutes per (homeLat, homeLon, radius,
  clusterRadius). A fresh engine after a slider commit picks up
  the cached payload synchronously and skips the network +
  parse round-trip.
- **LiDAR raster and shadow features**: same 30-min cache per
  (homeLat, homeLon, radius, rasterSize, providerId). The
  multi-megabyte typed array decode that the IGN COG provider
  performs is now paid once per session, not once per commit.

OpenFreeMap basemap tiles are already cached by the browser's
HTTP cache. The MapLibre `setStyle` re-fetch on a fresh engine
resolves from disk, not from network.

Removed: the engine pool, the DOM reparent helpers
(`HeliosEngine.reparentInto`, `HeliosEngine.getMapContainer`),
the engine pool API on `init.ts`
(`registerEngineInPool` / `claimEngineFromPool` /
`releaseEngineFromPool`). The `preview` field on `InitHost`.

### alpha.11

### Engine pool with eager registration and ownership handshake, fixes the per-commit WebGL respawn for real

The previous attempts failed because they registered the engine
into the pool from `disconnectedCallback`. The Home Assistant
frontend source (`hui-card.ts:121-166`, dev branch) confirms HA
constructs the new helios-card element, calls `setConfig` on it,
and only THEN removes the old element. By the time the OLD card's
`disconnectedCallback` fires, the NEW card has already been
constructed and is about to run its own `updated()`. The pool
push was always too late.

Alpha.11 inverts the timing.

- Eager registration: every engine pushes itself into the pool the
  moment it is created in `initEngineNow`, not at disconnect.
  When the slider commit destroys the preview pane, the NEW
  helios-card construction finds the OLD preview's engine already
  waiting in the pool.

- Pool key: (homeKey, mode) where mode is `preview` when HA
  sets `element.preview = true` (which the editor preview pane
  does, line `hui-card.ts:136-138`) and `live` for the dashboard
  tile. The preview pane never claims the live dashboard's
  engine, and vice versa.

- Owner handshake: each pool entry tracks `lastOwner`. Claim
  reassigns the owner and cancels any pending dispose. Release
  is a no-op when the releaser is not the registered owner (the
  old card releasing after a new card has already claimed). When
  the releaser IS the owner (real navigation away), release
  schedules dispose after the grace window.

The previous `pushEngineToPool` / `tryClaimPooledEngine` helpers
are replaced by `registerEngineInPool` /
`claimEngineFromPool` / `releaseEngineFromPool` /
`isCurrentPoolOwner`. The 1.5 second grace window is widened to
2.5 seconds to absorb the 1 second mount-debounce a fresh card
incurs before its first engine pass.

### alpha.10

### Pool transplant moves the container, not its children, basemap stops going black

Diagnostic on alpha.9 confirmed the pool itself works (the slider
drag stopped incrementing `enginesCreated`). The visible artefact
that remained was the basemap turning black when entering edit
mode, the engine pool was successfully grafting the previous
MapLibre stack into the editor preview pane but the transplant
broke MapLibre's rendering.

The alpha.9 transplant moved every CHILD of the old container into
a freshly-rendered new container, then poked MapLibre's private
`_container` field so future `appendChild` calls would land on the
new node. The trouble is that the new container started life at
0x0 dimensions in the new shadow root, `map.resize()` baked that
into the canvas, the basemap requested its tiles at the wrong
viewport, and the result was a black square (see also the project
memory rule "Black-map = check container height FIRST").

Alpha.10 instead moves the WHOLE old container DOM node into the
new shadow root, replacing the freshly-rendered empty
`<div id="map-container">` wholesale. MapLibre's `_container`
reference stays valid because we never reach into the private
field. The moved container keeps its existing children, its CSS
class names and its ResizeObserver wiring. A `requestAnimationFrame`
follow-up resize handles the typically-identical new dimensions
once the new shadow root completes its first layout pass.

### alpha.9

### Engine pool with MapLibre transplant, real fix for the per-commit WebGL respawn

Alpha.8 deferred the engine cleanup on `disconnectedCallback` and
cancelled it on the subsequent `connectedCallback`. The diagnostic
in #162 confirmed Home Assistant actually destroys the helios-card
element on every editor `config-changed` event and constructs a
fresh one. A new element instance never sees the old timer, so the
fix from alpha.8 covered only the same-instance reattach case
(rare in practice).

Replaces alpha.8's same-instance soft cleanup with a module-level
engine pool keyed by home coordinates. On disconnect the engine is
pushed to the pool, the next mount tries to claim it. When the
claim succeeds, `HeliosEngine.transplantToContainer(newContainer)`
moves the MapLibre stack (canvas, overlay divs, marker root) from
the orphaned container into the new shadow root's
`<div id="map-container">`, updates the MapLibre map's internal
container reference, and calls `map.resize()` so dimensions
follow. The new helios-card instance walks `wireEngineCallbacks`
to re-bind the engine to itself. No `new HeliosEngine(...)`, no
fresh WebGL context, no buildings refetch, no basemap reload.

The pool entry's cleanup timer destroys the engine after a 1.5 s
grace if no remount claims it (real navigation away). FIFO array
per home key supports multiple cards at the same coordinates.

### alpha.8

### Soft cleanup on disconnect, stops the per-commit WebGL respawn

Diagnosed via the in-card `window.heliosStats()` counters
(#162). Home Assistant detaches and re-attaches the same
helios-card custom-element instance on every `config-changed`
event emitted by the editor, slider commits and toggle flips
included, not only on the documented edit-mode entry. Each
detach was tearing the engine down and the immediate re-attach
was creating a fresh one, burning one full WebGL context
allocation per user input. With two cards on the dashboard the
counter incremented by 2 on every slider release.

`disconnectedCallback` now defers the engine cleanup by a
1 second grace instead of firing it immediately.
`connectedCallback` cancels the deferred cleanup if the same
element re-attaches within the grace, the engine, its MapLibre
stack and its WebGL context remain alive, and `updated()`
short-circuits the respawn branch because `_engine` is still
defined and `_lastHomeKey` still matches. If the grace expires
without a re-attach (real navigation away) the cleanup fires
exactly as before. Net result: zero WebGL context recreation on
slider drags, picker writes, toggle flips and the other editor
events that previously triggered a respawn cycle.

### alpha.7

### Resilience pass + hygiene cleanup

Block B (preventive resilience fixes) and block C (hygiene) batched
in one alpha.

Resilience:

- Open-Meteo rate-limit (HTTP 429) is no longer swallowed silently
  inside the weather fetch. The error now propagates with its
  status code so the engine catch arms the exponential back-off
  table instead of letting the card keep hammering Open-Meteo at
  the normal cadence under a rate-limit.
- `VISUAL_CONFIG_KEYS` extended to every key the engine actually
  consumes (PV layout, grid wiring, battery banks, inverter cutoff,
  timeline preferences, shadows, LiDAR precision). Live edits in
  the visual editor now reach the engine immediately instead of
  waiting for the next natural respawn (page reload, theme flip).
- Grid history backfill latch tracks a per-entity wall-clock and
  re-issues the 72 h fetch on a 24 h cadence so the buffer head
  stays fresh on long-uptime sessions. A `WsTimeoutError` arms a
  2 min cooldown so the next `refreshGrid` tick does not hammer
  the recorder with retries.
- Radiation statistics parser is strict on the `mean` column and
  no longer falls back to `state`. Pushing a cumulative MJ/m²
  counter through the engine would feed monotonically increasing
  values that look like 10000+ W/m² and distort every downstream
  derivation. Out-of-shape entities now degrade cleanly to the
  raw-history fallback.

Hygiene cleanups (no user-facing behaviour change):

- Removed the user-facing `v1.6.2` legacy-path reference from the
  `pvArrayPeakKwpHelp` editor hint in all 11 locales.
- Removed inline `1.8.0` / `alpha.18` version references from
  source comments. Comments now describe current state only.
- Corrected the `auto-rotate-enabled` schema default from `true`
  to `false` in both the schema doc comment and the README.
- Deleted the `HeliosColorPicker` custom element and its style
  block. The pre-1.8.0 editor color pickers are gone; the class
  was dead code in the bundle (~3-4 KB minified) and registered a
  globally-scoped custom element with no consumers. Bundle drops
  by 12 KB raw / 3 KB gzipped.
- Deleted 9 dead i18n keys from `i18n/index.ts` and all 11
  locales: `pvArrayShare`, `pvArrayShareHelp`, `gridSourceTitle`,
  `uiColorsHint`, `sunColor`, `cloudColor`, `pvColor`,
  `batteryColor`, `buildingColor`. Each was declared in the
  `Translations` interface and provided in every locale but never
  read anywhere in the source.
- Updated the README colour defaults (`sun-color`, `cloud-color`,
  `pv-color`, `battery-color`) to match the runtime constants.
  The previous palette values (`#EF9F27`, `#5A8DC4`, `#27B36B`,
  `#FF5252`) had been retired but the doc was not updated.
- Removed em-dashes from `.github/workflows/test.yml` (`—` would
  surface in CI failure logs).
- Dropped the hardcoded `open` attribute on the Timeline
  sub-section inside the editor UI accordion so it follows the
  same collapse contract as every other section.
- Added a NaN guard in `formatLocalisedNumber` so cold-cache or
  upstream parse failures render a neutral zero placeholder
  instead of surfacing the literal "NaN" string in chips.

### alpha.6

### Multi-fix on top of the recorder unblock series

A comprehensive audit on top of the alpha.2 to alpha.5 perf
migration surfaced seven issues that this release fixes in one
batch.

- The editor "Reset data cache" button now actually resets. The
  per-instance state was already cleared, but the cross-mount
  module caches added since alpha.3 kept the previous data alive,
  so the button looked broken. The reset now wipes PV, battery,
  radiation, and grid module caches in addition to the
  per-instance state.

- Chip values at scrub time stay populated across a wider range.
  The PV chip cursor reader used to fall back to the trainer
  stats slot only (30 days, but idle-deferred so it lands a beat
  after mount). It now consults the calibration stats slot first
  (5 days, fetched immediately), so a user who scrubs right
  after the page loads sees historical chip values without
  waiting on the idle queue.

- PV statistics fetch asks for both `mean` and `state` columns
  instead of an exclusive heuristic driven by the entity unit.
  Power sensors land via `mean`, cumulative-energy sensors land
  via `state`, the parser prefers whichever is populated.
  Removes a class of silent failures where the entity unit had
  not yet propagated to the card state at the time of the first
  fetch and a cumulative entity returned all-null `mean` buckets,
  leaving the slot empty and the calibration affiné value
  disappearing for the user.

- Calibration cross-day cumulative bucket no longer dropped.
  On hourly stats with bucket-midpoint anchor, the slice
  straddling midnight (23:30 of day D to 00:30 of day D+1) used
  to fail both day D's bucket guard and day D+1's previous-sample
  guard, losing one hour of cumulative energy per calibration
  day. The guard now tolerates the cross-day slice.

- Per-day kWh chips on the timeline no longer read 0 kWh for
  days beyond the narrow raw window. `computeDailyKwhTotals`
  now integrates `_pvCalibStats` (5 days hourly) for days the
  raw slot does not reach, while staying on the raw slot for
  the days it covers. The "3 days ago" chips now reflect what
  was actually produced instead of silently rounding to zero.

- Shading-map trainer no longer trains buckets that fall
  outside the battery SoC coverage when the inverter-cutoff
  guard is armed. The SoC histories piggyback on the raw PV
  fetch and only cover ~2 days; the trainer walks back 30
  days. For the 28-day gap, the cutoff guard used to fall
  through silently, accumulating phantom shadows at sun bins
  where the inverter was actually clamping batteries-full
  output. When the guard is configured and any SoC entity is
  wired, an out-of-coverage bucket now skips (advances the
  watermark) instead of training blind.

- Live tail of `_pvHistory` no longer reallocates on every
  tick. Pushing the live sample used to spread the entire
  arrays into fresh ones at up to 50 Hz, growing unbounded over
  long-uptime sessions. Push is now in-place and the tail
  trims entries that age out of `_timeRange.start` so the
  array stays bounded to the visible window.

### alpha.5

### Chip scrub coverage on cumulative-energy entities and outside-raw scrubs

Field follow-up on alpha.3 / alpha.4. The recorder freeze fix from
alpha.2 (#155) carried two latent regressions for users scrubbing
the timeline cursor:

- The PV chip resolver (`pvRateAtTime`) read `_pvHistory` only.
  Since the raw history slot is bounded to the chart's visible
  past (~2 days) the chip turned blank as soon as the cursor
  landed outside that window. The 5-min trainer-grade statistics
  slot covering the past 30 days is now consulted as a fallback,
  so scrub-time chip values resolve anywhere within the
  recorder's long-term-statistics retention (#161).
- The battery and radiation statistics fetches requested only
  the `mean` column. For entities with `state_class:
  total_increasing` (a cumulative kWh counter wired as battery
  power, an irradiance source surfaced as a Wh meter, etc.)
  `mean` is null per bucket and the parser dropped every row,
  even though HA returned non-empty arrays. Both fetches now
  request `['mean', 'state']` and the parser prefers the
  populated one. Slots land populated regardless of the source
  entity's class.

### alpha.4

### LiDAR polish + grid chip icons

- LiDAR mode-bar (#152): when the shadow fetch finishes loading,
  the satellite (or harddisk) glyph that replaces the spinner no
  longer inherits a frame of rotation animation. The
  `is-spinning` class now lives on the `ha-icon` itself so the
  animation drops in the exact frame the icon attribute swaps.
- LiDAR opacity slider (#153): the percent readout next to the
  slider thumb now tracks the drag. `_lidarViewOpacity` is
  intentionally not a Lit `@state` (the slider fires up to
  50 input events / s and a state coupling would re-render the
  entire card on every tick), so the readout span gets an
  imperative DOM write inside the input handler.
- Grid import / export chip icons (#154): from a home-centric
  reading, the previous icons pointed in the wrong direction.
  Swapped so the chip glyph matches its label.

### alpha.3

### Battery, radiation, semaphore: extending the alpha.2 recorder fix

Follow-up to alpha.2 after field validation against a Victron
Cerbo GX setup. The PV-path fix from alpha.2 worked (adaptive
calibration applied, recorder no longer globally frozen), but
two symptoms remained: battery data took several minutes to
populate, and each card mount caused a brief lag. A related
report described every apex-charts card on the same dashboard
flatlining while Helios was loading, the signature of Helios
still monopolising the recorder on cards that share the
connection.

- Battery and radiation fetches now follow the same statistics-
  first pattern as PV (#159). 5-minute buckets, ~576 rows per
  entity for a 2-day window vs ~150-200k raw on a 1 Hz BMS.
  Raw history fallback for entities without long-term statistics
  tracking. Module-level cache mirroring the PV pattern, no
  more refetch on every card mount.
- Global concurrency semaphore on the WebSocket fetch path
  (#160). Caps Helios's in-flight history / statistics fetches
  at 2, so the recorder retains headroom for other history-bound
  cards on the same dashboard.
- The 30-day shading-map trainer fetch defers behind the
  user-facing PV history and calibration fetches via
  `requestIdleCallback` (1 s timeout fallback). The chip and
  chart paint first, the trainer catches up in the background.

### alpha.2

### Recorder unblock on high-frequency PV sensors

- Tracked as #155. On installs whose PV entity reports more than
  one sample per second (e.g. a Victron Cerbo GX MPPT), the
  Helios card never finished loading and the HA recorder went
  unresponsive for unrelated entities while the card was open.
  Root cause was a single 30-day raw history fetch that ballooned
  to millions of state rows on high-frequency installs.
- The PV calibration and the 30-day shading-map trainer now
  consume `recorder/statistics_during_period` instead of raw
  history. ~120 hourly rows for the 5-day calibration, ~8.6k
  5-min rows for the 30-day trainer, vs potentially millions on
  the legacy path. Both consumers fall back to the raw window
  when the source entity is not long-term-statistics tracked
  (no `state_class`).
- Raw history fetches on the PV / grid / battery / radiation
  paths are now bound to the chart's visible window (~2 days)
  and pass `significant_changes_only: true` so HA drops
  bucket-internal duplicates server-side. Roughly 30 to 70 %
  fewer rows on noisy sensors.
- Module-level cache for the three PV slots survives the user
  navigating away from the Helios card and back (the previous
  per-LitElement cache reset on every mount). 15-minute TTL.
- WebSocket calls now have a 30-second timeout. On a stalled
  recorder the card degrades to live chip values rather than
  hanging on a loading state forever.

### alpha.1

- Editor polish: 16 px bottom margin on the Camera block so it
  no longer kisses the pixel-ratio segmented toggle below, and a
  12 px bottom margin on every `grid-source-row` so the combined
  entity picker (and the import / export pickers next to it) get
  air before the invert toggle / "add source" row underneath.
- Combined grid entity hint: dropped the inline brand list
  (Fronius P_Grid, Shelly EM, P1 net power, ...) from all 11
  locales; the YAML config doc carries the example list, the
  in-editor hint stays focused on what the field expects.

### alpha.0

### Camera pose control

New UI section in the editor for pinning the resting camera pose
and / or locking it. Three new config keys:

- `camera-pitch-deg` (15..85), vertical tilt baked into every
  engine init. The slider in the editor previews live as you drag.
- `camera-bearing-deg` (0..359), horizontal rotation, same live
  preview. Wraps to `[0, 360)` so a stale 720 deg in the YAML
  reads as 0 instead of putting the map in an unreachable pose.
- `camera-locked` (boolean), when on, manual drag-rotate +
  drag-pitch are inert on the canvas, pinch-rotate is disabled
  too, and the idle auto-orbit is suspended so the configured pose
  is the only pose the user ever sees. Lock + auto-rotate are
  mutually exclusive at runtime, the auto-orbit code reads the
  lock flag every tick.

Editor: "Camera" block inside the UI section with a pitch slider,
a bearing slider, a lock toggle, and a "Reset" button anchored
bottom-right that clears all three keys, releases the lock and
drives the engine back to the hemisphere-aware default pose
(north up in SH, south up in NH, pitch 55).

Live preview rides the engine directly via setCameraBearing /
setCameraPitch / setCameraLocked instead of going through a
config commit, so a slider drag never respawns the WebGL context.
The values are written to YAML in parallel (debounced) so the
next natural respawn boots from the chosen pose.

### Combined signed grid entity

- New `grid-power-entity` accepts a single signed sensor whose value
  carries the flow direction (Fronius `P_Grid`, Shelly EM, P1 net
  power, …) instead of two separate import / export meters. When it
  is set it owns both chips and supersedes `grid-import-entity` /
  `grid-export-entity`: a non-negative reading lights the IMPORT chip
  (the EXPORT chip hides), a negative reading lights the EXPORT chip,
  so only the active direction shows.
- Works with a power sensor (W / kW / MW, the value IS the signed
  watts) or a signed net-energy sensor (Wh / kWh / MWh whose total
  falls while exporting, the bracketed slope IS the signed watts). A
  list is summed, e.g. three signed per-phase sensors into one net.
  The whole live + scrub derivation rides the existing per-entity
  buffer / recorder-backfill machinery, so multi-tariff and combined
  installs share the same slope path.
- `grid-power-invert` flips the sign convention for meters that
  report grid feed-in as positive (default: positive = import).
- Editor grid section gains a combined-entity picker plus a sign
  toggle; the directional import / export pickers collapse while a
  combined entity is wired.

## v1.8.1

> Point-fix release on top of v1.8.0. v1.8.0 is withdrawn from the
> release timeline, its grid IN / OUT chips were unusable past the
> first six hours of scrub, the day-strip labels were misaligned,
> the sun bead flickered through camera rotations, and the cloud
> dome retirement was not reflected in the docs. v1.8.1 is the
> first build of the cycle that reads as the intended product.

### Grid IN / OUT, full audit + rewrite

- Sample timestamps now come from the entity's `last_updated`
  instead of the wall clock at refresh time, so the slope reflects
  when HA actually observed the value.
- Slope is taken across a bracketed pair of samples whose time
  span is at least 60 s. When the immediate before/after bracket
  sits too close together (5 s pushes on a 1 Wh meter), the
  bracket extends outward until the span clears the noise floor.
  Kills the 1 Wh-quantum-into-720 W-spike pattern.
- Multi-tariff installs (HP / HC) rank by the LAST REAL VALUE
  TRANSITION, not the latest poll, so the entity that actually
  incremented most recently always wins the chip. Live lookback
  10 min covers Linky histo mode (10 min push cadence).
- Recorder backfill window 72 h to match the timeline's visible
  past range. `pickBracket()` returns null when a scrub target
  sits more than 10 min before the buffer's first sample, the
  chip hides cleanly instead of showing a stale constant slope.
- Negative readings clamp to 0 in both live and scrub: a negative
  IMPORT is an EXPORT moment the export chip already reports.
- Bead cadence is now LINEAR in frequency (`dur = MIN * CAP /
  watts`, clamped to `[MIN, MAX]`), so twice the power gives
  twice the speed. Caps tuned to round residential thresholds:
  5 kW import, 1 kW export.

### Day-strip vertical centring + smartphone fit

The date / kWh pair on the bottom strip now shares one baseline
geometry across all four label states (bold today, regular past,
italic forecast, regular non-today). Both spans land on the same
font-size + 18 px line-height, on the HA frontend font stack
(`--mdc-typography-body1-font-family`, `--ha-font-family`,
`--paper-font-common-base_-_font-family`, Roboto fallback). The
strip itself is `box-sizing: border-box` so the inner content
area is exactly 18 px and the line box fills it without leftover
space. Font clamped to 6-9 px so the pair fits the narrower
per-day cells a portrait smartphone produces. Cramped-cell
kWh-hide threshold dropped to 48 px so the last day's forecast
stays visible when the timeline ends mid-day.

### Sun -> PV ray, no more flicker or chip overrun

- The bead was riding on a circle whose `cx` / `cy` plus a
  relative path mutated two attributes per rotation frame; the
  SMIL interpolation jittered between the old and new base.
  Switched to an absolute-path bead with `cx` / `cy` at the
  origin, single-attribute updates keep the animation continuous
  through camera drags.
- The ray + bead lived in the same SVG as the sun disc, whose
  depth split brought the SVG above the PV chip on the sun's
  near half of the sky. Moved the ray + bead to a dedicated SVG
  fixed at z 7, the chip background now always occludes the ray
  endpoint at the chip border. The sun disc keeps its depth
  split so it still passes in front of / behind the home cluster
  depending on bearing.

### Home click zone follows the building shape

The silhouette polygons now receive pointer events themselves,
so a click on any visible part of the focal building opens the
dashboard, regardless of how the 120 px circular hitbox lines
up against the projected centroid. The circular hitbox stays as
a fallback for tiny / distant buildings.

### Dome + LiDAR sliders harmonised

Both pills now share the same min-height, 16 px icons and anchor
rail, and both slide UP from below the card on mode entry and
slide DOWN out of view on mode exit (mirroring the timeline's
own enter / exit). Slider retreat fires immediately on
toggle-off, in parallel with the mode's own fade-out instead of
after it.

### Editor + docs freshness

- Grid section in the visual editor moved between PV and
  Shading, so the energy-producing sources stay grouped.
- README + ARCHITECTURE: the on-ground cloud-cover disc bullet
  is gone (the chip + dome toggle at the top of the card
  replaced it). The Depth-of-field veil bullet is gone (the
  effect is no longer in the rendering pipeline). Grid IN / OUT
  chips added to the "at a glance" feature list, with
  `grid-import-entity` / `grid-export-entity` rows in the config
  table. `cloud-color` description updated to reflect the dome
  bands.
- Project-wide audit pass: em-dashes replaced with commas in
  every source comment, every i18n locale label and the README
  + CHANGELOG. Decorative section dividers removed from
  `engine/buildings.ts`. Dead `shouldShowDomeChip()` helper
  removed from `card/shadingDome.ts`. Unused `PV_LEG_OFFSET_PX`
  constant + its `void` silencer removed from `helios-card.ts`,
  along with a sibling `void batteryCharging;` that was
  silencing a variable the very next line consumes.

### Other

- Cloud-cover curve in the timeline chart bumped from
  `fill-opacity: 0.25` to `0.45` so it stays readable through
  the irradiance fill painted on top.

## v1.8.0

> Accelerated release to address performance regressions reported after
> v1.7.0. Some roadmap items (notably the new LiDAR providers) are
> deferred. Apologies for the delay on those, they remain priority for
> the next cycle. Stabilising the rendering took precedence over
> extending coverage for this one.

### Home Assistant harmonisation

The card now reads the active HA theme directly via
`hass.themes.darkMode` instead of exposing its own toggle. Every chip,
leader, chart and editor control consumes HA design tokens
(`--primary-color`, `--card-background-color`, `--divider-color`,
`--ha-card-border-*`, `--energy-solar-color`,
`--energy-grid-consumption-color`, `--energy-battery-in-color`, etc.).
The card also picks up the HA frontend default border / radius / box-
shadow, so Helios sits visually alongside the other Energy dashboard
cards. Users familiar with the HA Energy dashboard recognise the same
colour vocabulary and chip language, and an HA theme switch now flips
the card automatically.

The legacy `card-theme: light | dark` YAML option is gone. When the
editor opens, retired keys are silently scrubbed from the config.

### Performance and stability

- WebGL "too many active contexts" fix in dashboard edit mode. The
  mount / unmount loop HA triggers during the edit-mode UI animation
  is neutralised (`preview: false`, 1 s first-spawn debounce,
  `isConnected` gates on every deferred spawn path). Engines no
  longer pile up and the browser's WebGL pool stays healthy.
- `LidarViewLayer.setData()` memoised on the raster signature.
  Re-toggling LiDAR view without moving the map short-circuits the
  Mercator double loop and the GPU buffer uploads. ~100-300 ms gain.
- Shading dome animations revised: entry and exit play symmetrically
  with the chip + timeline transitions.
- Home glow refreshed after exiting LiDAR (the projections were
  frozen at the bearing of toggle-on).
- Proportional grid IN / OUT bead animation, tied to the live power
  (cap 10 kW import, 1 kW export, idle below 5 W).
- Dependencies bumped to their latest stable versions (Vite 8,
  TypeScript 6, pbf 5, @mapbox/vector-tile 3, terser 5.48). Bundle
  drops from ~2986 KB to ~2208 KB (-26 %, gzipped -13 %).

### Grid Import / Export

- Multi-tariff support. `grid-import-entity` and `grid-export-entity`
  accept either a string or an array of entities. Typical case: French
  Linky EASF01 (peak hours) + EASF02 (off-peak hours). The visual
  editor exposes an editable list with up to 8 sources per side.
- "Last-changed wins" logic. When several entities are wired, the
  chip displays the watts of whichever entity moved most recently
  (the active tariff).
- Recorder backfill at boot. A 1 h history pull from the HA recorder
  seeds the rolling buffer for each grid entity on first refresh, so
  the slope is meaningful right away even when the live integration
  is silent for minutes (slow-polling Linky TIC, etc.).
- Rolling window 60 min, up to 800 samples per entity.
- No more 0 W seeding. If no derivation has landed yet, the chip
  stays on the last computed value instead of falling back to 0.
- Import / export leaders + beads driven by the live power.

### Home hub and leaders

- Solid drop-leader between the home pill and the projected ground
  at the 3D building, painted in HA primary colour. The home cluster
  is lifted a notch to leave the leader visible.
- Permanent home glow (opacity 0.25 at rest) bumping to 0.85 with a
  thicker drop-shadow on hover.
- Larger home hitbox (120 px, z-index 55) so click / hover lands on
  the home even when chips or leaders sit under the pointer.
- Sun ray bead. The sun → PV chip ray now carries a circular bead
  instead of an arrow, speed tied to the live irradiance.
- Battery + grid leaders use a quadratic fillet on the L-shape to
  match the cloud-layer leaders.

### Cloud cover

- The fourth mode-bar button is gone. The central cloud chip itself
  toggles 3 per-layer sub-chips (low / mid / high) with a cascade
  fade-in animation.
- Three L-leaders connect the toggle to the sub-chips, converging on
  a central junction with a vertical trunk.
- Auto-OFF when switching to LiDAR or Shading mode so the sub-chips
  don't leak into the active layer.

### Timeline and clock chip

- Top-left date / time chip pulled up to z-index 1000, no longer
  crossed by the solar arc nor by the dome overlays.
- Mobile day-strip: tighter gap / padding / font clamps. The kWh
  annotation hides below 90 px cell width.
- Night hatches and day separators alpha bumped to stay legible in
  dark mode.
- Hover tooltip uses a 12 px border-radius matching the chip language.
- Theme-aware prediction colour: darker on light theme, lighter on
  dark theme.
- Timeline slides in / out from below (translateY 140 %) when
  returning to the default view.

### LiDAR mesh

- Loading feedback. Until the exposure compute lands, only the points
  and the wireframe paint in pure white. Colour-filled triangles
  appear once the exposure is ready.
- Spinner on the LiDAR mode-bar button during compute, with the other
  two mode buttons disabled to prevent state races.
- Shader shadow floor bumped (0.25 → 0.55) so the mesh stays legible
  at night when every cell is in shadow.

### Solar arc and irradiance chip

- Depth-split rendering. The half of the arc closer to the camera
  paints over the chips (z 11), the half further out paints behind
  (z 5). The sun disc follows the same rule.
- The W/m² label sits at z 13 above the front arc so it never gets
  crossed.

### PV string markers removed

The icon + leader + sphere that marked each PV string position is
removed. Backing code, CSS and engine projections are gone too
(~5 KB bundle savings).

### HA Energy auto-detect removed

The fallback that pulled entities from the HA Energy dashboard is
removed for PV, battery and grid. Resolution is now entirely driven
by the explicit YAML keys. Diagnosing a chip at 0 W is much simpler:
if the chip is silent, the configured entity is the one responsible,
no opaque fallback shadowing the source.

### Diagnostics and hygiene

- Every runtime `console.info` / `console.log` debug call is gone.
  The console stays silent in steady state, only genuine warnings
  (context lost, fetch failed) remain.
- Engine cleanup drops `_lidarViewLayer` + `_lidarRaster` explicitly
  after `map.remove()` so dead GL handles don't get pinned across
  editor respawns.

### i18n

- 9 new grid keys translated across every supported locale (EN, FR,
  DE, ES, IT, NL, PT, NO, PL, CS, SV).

## v1.7.0

Headline release on top of v1.6.4. Thirty-five alpha iterations + three
betas, condensed below. The deliberate scope choice for this cycle was
"refine the prediction rather than add more providers", so the LiDAR
provider count is unchanged (10) and the energy went into the live
irradiance overlay, the adaptive shading map, multi-battery support and
the polish pass on the dashboard + layer transitions. Users in
uncovered regions can prepare their own raster via
[helios-lidar.org](https://helios-lidar.org).

### Live LiDAR irradiance overlay

The LiDAR-View overlay now paints every loaded raster cell as a
wireframe + filled triangles, shaded in real time by a per-cell
raymarch from each cell toward the sun against the loaded nDSM.
Lit cells glow warm (warm-tinted at the irradiance peak), shadowed
cells dim out. The compute runs in 32-row chunks per
requestAnimationFrame tick so the main thread stays responsive while
the irradiance map fills in row-by-row, no freeze even on
high-precision rasters. Toggled from the three-segment top-right
mode bar (Layer / LiDAR / Dome); a bottom-of-card slider tunes the
overlay opacity live. The five previous per-element visual config
keys (`lidar-view-point-color` / `-point-opacity` /
`-wireframe` / `-wireframe-color` / `-wireframe-opacity`) collapsed
into that single slider; the legacy keys are silently stripped on
first edit. Only `lidar-view-point-size` remains tunable from the
editor.

### Adaptive shading map

A second learning layer sits on top of the 5-day calibration: each
cell of a polar grid (sun azimuth × sun altitude × cloud-cover bin)
holds the average actual / predicted ratio observed at that
combination. The forecast then bends at the right time of day for
tree shadows, neighbouring roofs and other obstacles the LiDAR
didn't capture. Visualisable from the editor as a hemispheric "dome"
overlay (Shadows segment of the mode bar), with stats and per-bin
import / export / reset. Builds up from the user's own data over a
few weeks; until then the scalar calibration carries the load.

### Multi-battery banks

New `batteries:` config array declares any number of physical
battery banks side-by-side (house + garage + standalone hybrid,
mixed-vendor BMS, etc.). The chip on the card stays single,
aggregating the banks as a capacity-weighted SoC + summed signed
power. Each bank carries its own `power-invert` flag (per-vendor
sign convention) and an optional `capacity-kwh` weight. Editor UI
mirrors the multi-array PV pattern (add / remove rows, individual
collapsible cards). Legacy flat `battery-soc-entity` /
`battery-power-entity` / `battery-power-invert` keys keep working:
they are wrapped as a single-bank list under the hood and stripped
on the first edit via the new editor UI. Mixed-vendor power
readings (one bank in W, another in kW) are normalised to watts
before being summed so the aggregate is coherent.

### Inverter cutoff guard

New `inverter-cutoff-soc-pct` config gates the shading-map trainer:
when the user's hybrid inverter clamps PV output once the battery
reaches its set ceiling, every observation bucket where every bank
reached the cutoff is skipped, so the inverter-blocked production
doesn't train as phantom shadow at the matching sun position.
Per-bucket min-SoC across banks is the gate signal, so a half-full
sibling bank correctly trains the bucket while one full bank does
not block it. Logs a console warning when the cutoff is armed but
no bank exposes a SoC entity (silent-guard misconfig).

### Dashboard counter-up

Headline kWh figures on the dashboard (produced, forecast, refined)
now tick up from 0 to their real value with a 700 ms cubic ease-out
the moment the user opens detail mode. Delta % and peak time stay
anchored on the real values so they don't sweep through nonsense
intermediate numbers.

### Depth-of-field veil

Permanent across modes, ultra-subtle (0.6 px backdrop blur) shaped
by a radial mask centred on the home's current screen position.
Fully transparent inside the inner disc (no blur at the focal
point), full blur at the edges. Sits between the basemap and the
chips so the UI stays crisp regardless. Subliminal on its own,
gives the card a gentle peripheral out-of-focus feel that mimics
DoF at distance.

### About section in the editor

New collapsible section pinned at the very bottom of the visual
editor, carries: the running version (inlined at build time from
package.json), a pointer at the companion site
[helios-lidar.org](https://helios-lidar.org), the two source-code
repos (Helios + Helios-Lidar) with GitHub icons, and a short
appreciation paragraph + Buy Me A Coffee link styled in the BMC
yellow. Translated into all 11 locales.

### Memory hygiene + correctness pass

A round of audits before the final tag closed:

* Four memory leaks identified across the engine lifecycle, the
  chunked exposure loop pinning the dead engine after rapid config
  edits, the LiDAR-View custom layer leaking its 4 GPU buffers +
  shader program on iOS Safari, the editor's reset-feedback timer
  firing on dead elements, and the styleimagemissing handler
  surviving past cleanup as an anonymous lambda. All four closed,
  so the "must refresh after several edits" symptom is gone.
* DTM no-data gap in `pv-shading.ts` now falls back to flat-ground
  at the offending step instead of skipping the obstacle entirely,
  fixed in both `isPanelShaded` and `computeLidarCellExposureRows`,
  was under-detecting shading on panels near LiDAR coverage edges.
* LiDAR exposure raster-swap race fixed (size guard in setExposure
  + raster-identity check in the chunked tick + stale-sun
  re-check), no more one-frame ghosting on precision change or
  view locked 30 s behind the cursor during a rapid timeline scrub.
* Calibration day-boundary no longer over-counts ~1 h of the
  previous evening into the new day on sparse cumulative-energy
  sensors (both samples of a delta pair must fall inside the day).
* Multi-bank power aggregation normalises to watts before summing
  (mixed-vendor W + kW installs were producing nonsense before).

### Editor polish

* Battery banks AND PV arrays are now fully wipeable from the
  visual editor: removing the last row drops the `batteries:` or
  `pv-arrays:` key entirely, so the chip / forecast cleanly falls
  back to "not configured". Empty arrays are honoured on re-read so
  the section shows just an "+ Add" button.
* Chip fade-in / fade-out across mode toggles got a
  `will-change: opacity` hint, the CSS rules were already correct
  in both directions but the browser dropped frames on chips
  inside transform-less wrappers (time-bar, solar-svg) under load,
  producing intermittent "sometimes works, sometimes doesn't"
  behaviour. Now bulletproof, GPU-composited.

### Locales

Three new locales added: Czech, Polish, Swedish. Total: 11
(cs, de, en, es, fr, it, nl, no, pl, pt, sv). Every new key
introduced this cycle (multi-battery editor + About section +
LiDAR-View hint rewrite) was translated natively into all 11.

### Repo split

The Python preparation toolchain (raw LAZ / LAS → 2-band COG that
the companion site uses server-side) moved out of this repo into
its own [Helios-Lidar](https://github.com/ReikanYsora/Helios-Lidar)
repository. Card-side and pipeline-side concerns are now in two
separate repos kept loosely coupled by the documented COG output
format. The local `tools/` and `data/` directories have been
removed from this tree accordingly.

### License

Switched from MIT to GPL-3.0-or-later. LICENSE file ships the
canonical GPL-3.0 text prepended with the project's copyright
notice; README badge + footer + package.json `license` field
all updated.

## v1.6.4

Point release on top of v1.6.3 with one behavioural change.

### Heartbeat ping removed

The anonymous install heartbeat introduced in v1.6.3 (a once-per-
day POST of a random UUIDv4 to helios-lidar.org) is gone. The
card no longer emits any beacon, and the `helios-anon-stats`
config key is no longer read. Anyone setting it explicitly to
`false` can leave the line in their YAML (it's now a no-op) or
remove it.

Install analytics are now derived from public GitHub Releases
download counts on the helios-lidar.org landing page, which keeps
the same informational value without a client-side ping.

## v1.6.3

Headline release on top of v1.6.2. Sixteen beta iterations
condensed below. The big themes :

### Terrain-aware LiDAR shading

The pre-1.6.3 ray-march in `pv-shading.ts` assumed flat ground at
every cell of the nDSM, which under- or over-counted shading by
the slope between the panel and a far obstacle on any non-flat
install. The companion pipeline at [helios-lidar.org](https://helios-lidar.org)
now ships a 2-band COG (band 1 = nDSM, band 2 = DTM) and the
card lifts both into absolute Z anchored at the panel's local
ground, so a 5 m building 50 m east on terrain that rises 8 m
correctly reads as a 13 m obstacle (and a 5 m building on
terrain that drops 8 m correctly reads as -3 m, i.e. below the
panel and invisible to the sun). Legacy single-band rasters
(public providers + pre-v1.6.3 local COGs) fall back to the
flat-ground geometry transparently, no breakage.

US-foot LAZ files (a common hurdle for North American users)
also got fixed in the pipeline: the source CRS gets reprojected
to the nearest UTM zone in metres before rasterisation, so
6 ftUS-pitch panels no longer end up encoded as 6 m and skew
the shading.

### PV configuration : per-string kWp + inverter PMax

`pv-arrays[].peak-kwp` replaces the abstract `share` field for
multi-string installs. Each row carries its real nameplate;
total install power is the sum, no more "60/40 with 5 kWp total"
shorthand. New top-level `pv-inverter-max-kw` clips the forecast
at the inverter's nameplate so an oversized DC array (typical
European 6.4 kWp behind a 5 kW inverter) doesn't show a peak
above what the hardware delivers. Editor + 8 locales updated.
Legacy share-based configs keep working unchanged.

### 5-day rolling forecast calibration, now everywhere

The dashboard already nudged its "refined" headline by the
5-day actual / model ratio; v1.6.3 propagates the same `cal.ratio`
to the dotted forecast curve, the per-day kWh chips on the
timeline strip, the hover tooltip's PV value, AND the live PV
chip when scrubbing into the future. All four readouts now
agree at any scrub instant.

### Timeline overhaul

* **Hover tooltip** on both chart cards (irradiance / cloud + PV).
  Pointer-move draws a vertical guide line + colour-coded dots
  (mdi:white-balance-sunny, mdi:cloud-outline, mdi:flash) at the
  cursor position. PV row skipped silently when no entity is
  configured. Works on mobile too: a touch drag updates the
  tooltip the same way as desktop hover.
* **Night zones** as diagonal-hatch overlays from sunset[N] to
  sunrise[N+1] on both chart cards, with dotted vertical day /
  night boundary lines. Same hatch + boundary on the dashboard's
  today chart for one unified visual vocabulary.
* **Future-mask wash** anchored at "now" so the forecast portion
  of every curve + the night-zone hatch fades together. Past
  reads punchy; forecast reads as forecast.
* **Day-strip** below the cards: one bordered bar with dotted
  midnight separators and per-day kWh totals; the cells size their
  text via container queries so a 4-day mobile view doesn't
  smash the date + kWh together.
* **Balanced chart heights** (48 px each) so PV no longer looks
  like a sparkline below the irradiance / cloud card.
* **Cursor weights bumped** to read through the future wash.
  Negative PV readings (net-meter dawn / dusk noise) clamp at 0
  in the tooltip + the live chip + the dashboard headline.

### Camera : pitch on vertical drag

Vertical drag on the canvas tilts the camera; horizontal drag
keeps the existing bearing rotation. Pitch clamped to
[15°, 85°], so the user can dive almost top-down or peek almost
flat against the ground without ever passing through it.
Two-finger pinch-rotate stays with MapLibre's built-in handler.

### PV home-anchor as a perspective ground ring

The single screen-space disc at the home gets replaced by a
2.5 m stroked ring projected through the map's camera matrices.
Lies flat on the ground around the home, aplated by pitch and
rotated by bearing. The back arc of the ring is masked by the
home silhouette (same polygons the home-glow uses), so the
building visually sits inside the ring. Pulse animation rides
through the bead arrival cycle.

### LiDAR cast-shadow quality

The cluster cap dropped from 400 cells to 80 (~16 m² target
area) so convex hulls trace L-roofs and zigzagging tree rows
much closer to their real outline; the shadow raster size is
tied to the existing `lidar-precision` knob (low / medium =
1024 px, high = 2048 px) so the median user pays no extra
mobile cost and power-users opt in to the sharper edges. Shadow
recompute is also coalesced into a 100 ms debounce during
timeline scrub, so dragging the cursor at high precision no
longer feels glued.

### Smaller polish that ships in 1.6.3 too

* **LiDAR chip cluster** redesigned as a row-reverse pair (chip
  on the left, mode toggle on the right), both clickable, with
  three coverage states (no provider / online / local) and the
  active-on theme matching the scrub clock on the opposite
  corner. Chip text comes from the `lidarViewChipLabel` i18n
  key ("Vue LiDAR" / "LiDAR view" / ...).
* **Forecast curves at 0.7 px stroke** (was 1.4 px) so dense
  variation reads as a hairline trace instead of a smudged band.
* **PV predicted icon in the timeline tooltip** uses the lighter
  `lerpHexToward(pvColor, '#ffffff', 0.55)` tint, matching the
  dashboard's dotted forecast convention.
* **Dashboard tomorrow card calibration tooltip** can finally
  paint above the battery card (`:has()` selector lifts the
  hovered card to a higher z-index).
* **Editor BYO LiDAR hint** rewritten to lead with
  helios-lidar.org (the easy path) and mention the local
  `tools/lidar/` helpers as the fallback. Now renders the
  inline `[text](url)` syntax as real `<a>` anchors via a
  scheme-restricted markdown-link helper.
* **Sunrise / sunset arc icons removed** ; the arc shape on the
  3D map already signals them and the icons piled up visually
  against the LiDAR shadow blobs on the horizon. Replaced by
  diagonal night-zone hatching on the dashboard chart for the
  same indication on the 2D charts.
* **Neighbour-building outlines** dropped (visual noise on dense
  streets); the home outline stays.
* **Day-strip date font** bumped (`clamp(9px, 11cqw, 13px)`) and
  the cells use container queries so the layout adapts to any
  card width.
* **Detail-panel `.dash-card` entry animation** ends on
  `transform: none` so the stacking context releases after the
  fade-in and tooltips can paint above sibling cards.
* **HACS repo description** refreshed to match what the card
  actually does in 1.6.x.

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
  public elevation / LiDAR source inspected (integrated,
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
 , BYO local nDSM LiDAR provider ([PR #5](https://github.com/ReikanYsora/Helios/pull/5))
  and matching Python preparation toolchain
  ([PR #11](https://github.com/ReikanYsora/Helios/pull/11)), idea
  credited to [@stephenwq](https://github.com/stephenwq).
  Unlocks shadows for any region with raw LiDAR data available
  offline, initial use case NSW Australia.
* **[@i6media](https://github.com/i6media)** (Frank Boon), optional
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
