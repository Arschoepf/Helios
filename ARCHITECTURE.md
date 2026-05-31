# HELIOS, architecture

HELIOS is a Home Assistant Lovelace custom card that visualises solar
conditions at a home in real time: sun arc, irradiance, cloud cover,
3D buildings with cast shadows, optional PV production with a
learning forecast, optional home-battery state, all stitched onto a
3D MapLibre map centred on the home and reflected in a scrubbable
5-day timeline. A click on the home drops into a detail dashboard
with today, tomorrow and battery cards plus a cumulative production
chart.

The 3D basemap and the building footprints come from
**[OpenFreeMap](https://openfreemap.org/)** (free vector tiles built
from OpenStreetMap data via the OpenMapTiles schema, no API key, no
signup, no rate limit). Weather forecasts come from
**[Open-Meteo](https://open-meteo.com/)** (also free, no key). LiDAR
shadow data comes from national open-data programmes credited
per-country in the LiDAR section below. None of these services
require an account, so HELIOS ships and runs without any user
configuration of credentials.

For a chronological account of what changed across releases see
[CHANGELOG.md](./CHANGELOG.md). For end-user documentation see
[README.md](./README.md).

External contributors who have shaped surfaces of the card beyond the
core author:

* **[@jourdant](https://github.com/jourdant)** , generic BYO local
  nDSM LiDAR provider ([PR #5](https://github.com/ReikanYsora/Helios/pull/5))
  and matching Python preparation toolchain
  ([PR #11](https://github.com/ReikanYsora/Helios/pull/11)), idea
  credited to [@stephenwq](https://github.com/stephenwq).
* **[@i6media](https://github.com/i6media)** (Frank Boon) , optional
  `home-latitude` / `home-longitude` overrides
  ([PR #9](https://github.com/ReikanYsora/Helios/pull/9)) and the
  multi-orientation PV layout (`pv-arrays`)
  ([PR #10](https://github.com/ReikanYsora/Helios/pull/10)) for
  installs with panels split across several roofs / orientations.

---

## What HELIOS does

HELIOS is a Home Assistant Lovelace card that visualises solar
conditions at the user's home. The full picture sits on a single
3D MapLibre map:

* **Sun arc**, the sun's full 24 h trajectory across the sky,
  projected onto the screen with depth (thicker stroke when in
  front of the camera, thinner behind). Split into two passes:
  below-horizon dots render behind the home chip cluster so the
  home stays readable through the night half of the loop;
  above-horizon segments + sun disc + W/m² chip render in front
  of every chip so the live sun always dominates the stack.
* **Sun disc with halo**, the live position on the arc. Four
  concentric layers, painted back-to-front: an irradiance-driven
  halo (SVG `radialGradient`, 100 % alpha at the centre, 0 % at
  the rim, peak alpha = `sqrt(irradiance/1000) × 0.55`); a
  background tint; an inner fill whose radius scales with
  irradiance; an outer rim.
* **Incidence ray**, dashed line from the sun to the PV chip,
  animated to flow at a speed proportional to live irradiance.
  Snaps to the side of the PV chip facing the sun.
* **Solar irradiance chip**, pinned above the sun disc, shows the
  live W/m² figure. Reads from the configured
  `solar-radiation-entity` for live + past timestamps when one is
  set; falls back to the model otherwise. Future timestamps
  always come from the model.
* **Cloud cover chip + dome**, a top-of-card chip shows the live
  cloud-cover percentage. Tapping the chip toggles a hemispheric
  cloud-dome overlay anchored at the home and fans three sub-
  chips below the toggle for the low / mid / high layer
  breakdown. The dome is sliced into three horizontal bands whose
  opacity tracks each layer's share of the sky, so the user reads
  the modelled coverage spatially rather than as a flat number.
* **Home halo**, a soft sun-coloured glow under the focal home
  outline so the building reads at a glance even on a busy basemap.
* **PV production chip** *(optional)*, when a `pv-power-entity`
  is configured, a chip above the home shows the *instantaneous*
  production in W or kW. Cumulative-energy sensors (kWh) are
  differentiated automatically over a rolling 60 s window.
* **PV → home animated leader**, a vertical dashed line in the
  configured PV colour from the PV chip's bottom edge down to a
  small anchor bead on the home. Dashes flow toward the home at a
  speed proportional to current production over the user's
  theoretical peak (100 × `pvCalibK` when calibrated, 5 kW
  fallback). Static and arrow-less when production is 0.
* **PV array markers**, when `pv-arrays` entries carry their own
  GPS coordinates (more than 10 m away from the home), a small
  solar-panel icon in the configured PV colour marks each panel
  location on the map. Useful when panels sit elsewhere than the
  home, ground-mounted in a clearing while the house is under
  trees.
* **Home battery chips** *(optional)*, State-of-Charge and signed
  instantaneous Power flank the PV chip, each connected to PV by
  an L-shaped leader whose foot lands at 25 % / 75 % of the PV
  chip's width. The Power leader's dashes flow with the sign of
  the live power.
* **Detail dashboard**, click the home to dive into a chip-styled
  overlay with three sections: Today (produced kWh + refined
  forecast with calibration hint + dual peak readouts + cumulative
  sparkline with sunrise / sunset markers + live now cursor +
  hover tooltip), Tomorrow (full-day forecast + peak hour) and
  Battery (vessel + charge / discharge totals). Tomorrow stretches
  full width when no battery is configured. Click anywhere outside
  to exit.
* **LiDAR View overlay**, a GPU-resident dot cloud of every loaded
  LiDAR cell, painted in screen space by a MapLibre custom layer.
  Toggle from the top-right rail (hidden when no provider covers
  the home). Optional wireframe overlay. Re-rasterised by MapLibre
  on every transform with no JS-side redraw, so panning and
  rotating through a dense forest stay smooth.
* **Date/time chip**, top-LEFT of the card, follows the timeline
  cursor (live or scrubbed).
* **Back-to-live button**, top-RIGHT rail, mirrors the date/time
  chip on the opposite edge. Shows only while scrubbing. Shares
  its column with the LiDAR View toggle when both are active.
* **Timeline**, bottom of the card, 5 days wide. Dual-area chart
  with irradiance (top) and cloud cover (bottom) sharing a
  midline that doubles as a date axis. A second chart for PV
  production appears above when configured. Click or drag to
  scrub; the whole map reflects the selected instant in real time.

---

## Project structure

```
Helios/
├── .github/
│   └── workflows/                       HACS validation + release attach + helios-lidar deploy
├── dist/                                Generated by `npm run build` (committed for HACS)
│   └── helios.js                        Single bundle
├── src/
│   ├── helios-card.ts                   Lit element, render orchestrator, HA + Lit lifecycle
│   ├── helios-engine.ts                 MapLibre engine orchestrator
│   ├── helios-config.ts                 HeliosConfig schema + DEFAULT_* constants
│   ├── vite-env.d.ts                    __HELIOS_VERSION__ global typed
│   ├── card/
│   │   ├── pv.ts                        PV live state, history fetch, rate derivation, multi-array parser
│   │   ├── battery.ts                   Multi-bank parser + SoC + power live + history aggregation
│   │   ├── radiation.ts                 Solar-radiation sensor override + engine push
│   │   ├── calibration.ts               Forecast calibration, actual / predicted ratio over 5 days
│   │   ├── shadingMapView.ts            Polar shading-map editor panel (stats + 4-up grids + actions)
│   │   ├── shadingTrainer.ts            Per-(sun × cloud) cell trainer + inverter-cutoff guard
│   │   ├── shadingDome.ts               Hemispheric dome overlay rendering of the shading map
│   │   ├── charts.ts                    Timeline charts (irradiance, PV) + day labels
│   │   ├── dashboard.ts                 Detail-mode panel + counter-up animation
│   │   ├── overlays.ts                  Screen-space projections (sun arc, home silhouettes)
│   │   ├── timeline.ts                  Clock tick + scrub pointer handlers
│   │   ├── lidar-view.ts                LiDAR-View toggle + fade rAF loop + opacity picker
│   │   ├── init.ts                      Engine bootstrap + visibility observer + home coords
│   │   ├── format.ts                    cfgHex, formatDate, locale-aware number, hex math
│   │   └── editor.ts                    <helios-card-editor> + <helios-color-picker> + About section
│   ├── engine/
│   │   ├── sun.ts                       Solar position + Haurwitz / Kasten-Czeplak / Liu-Jordan math
│   │   ├── pv-thermal.ts                Sandia NOCT cell-temp + temp-coefficient derating
│   │   ├── pv-shading.ts                nDSM raycast (per-array shading + per-cell chunked exposure)
│   │   ├── shadingMap.ts                Polar grid layout + per-cell ratio store + lookup
│   │   ├── weather.ts                   Open-Meteo multi-model fetch + cache + back-off
│   │   ├── buildings.ts                 OpenFreeMap planet tile fetch + radius / cluster filter
│   │   ├── shadows.ts                   Ground-projected shadow polygons (flat-opacity)
│   │   ├── shadow-raster.ts             Offscreen canvas rasteriser for the shadow image source
│   │   ├── lighting.ts                  Day/night colour modulation (night-shade, building, light)
│   │   ├── auto-rotate.ts               Idle camera orbit rAF loop
│   │   ├── detail-mode.ts               Detail-mode camera dive (zoom + pitch + bearing)
│   │   ├── lidar-view-layer.ts          MapLibre WebGL custom layer (dots + wireframe + irradiance fill)
│   │   ├── lidar.ts                     LidarSource interface + REGISTERED provider registry
│   │   └── lidar/
│   │       ├── pipeline.ts              Flood-fill + convex-hull pipeline (shared by every provider)
│   │       ├── geotiff.ts               Float32 GeoTIFF fetch + DSM-DTM helpers
│   │       ├── local-ndsm.ts            Generic BYO nDSM provider built from card config
│   │       └── providers/               One file per country / region; 10 registered + 4 dormant
│   │           ├── fr.ts                IGN HD (metropolitan France + Corsica), BIL float32  [registered]
│   │           ├── uk.ts                Defra LiDAR Composite (England), GeoTIFF DSM + DTM   [registered]
│   │           ├── es.ts                IGN España PNOA-LiDAR MDSn (peninsular Spain)        [registered]
│   │           ├── nl.ts                PDOK AHN4 (Netherlands), GeoTIFF DSM + DTM           [registered]
│   │           ├── no.ts                Kartverket NHM (Norway + Svalbard), ArcGIS GeoTIFF   [registered]
│   │           ├── de-nrw.ts            Geobasis NRW nDOM (Nordrhein-Westfalen), WCS         [registered]
│   │           ├── de-bb-be.ts          LGB bDOM + DGM (Brandenburg + Berlin), WCS 2.0.1     [registered]
│   │           ├── pl.ts                GUGiK NMPT (Poland), WCS 2.0.1, EPSG:4326 native     [registered]
│   │           ├── ca.ts                NRCan HRDEM Mosaic (Canada), WCS 1.1.1               [registered]
│   │           ├── us-vt.ts             VCGI nDSM (Vermont, USA), ArcGIS exportImage         [registered]
│   │           ├── at-stmk.ts           Land Steiermark ALS                                  [DORMANT, see lidar.ts]
│   │           ├── at-tirol.ts          Land Tirol ALS                                       [DORMANT, see lidar.ts]
│   │           ├── de-bw.ts             LGL INSPIRE DOM5 + DGM1 (Baden-Württemberg)          [DORMANT, see lidar.ts]
│   │           └── be-fl.ts             AGIV DHMV II (Flanders)                              [DORMANT, see lidar.ts]
│   ├── css/
│   │   ├── helios-card-css.ts           Runtime card styles (map, chips, charts, DoF veil, sliders)
│   │   └── helios-card-editor-css.ts    Editor + color-picker + About section styles
│   └── i18n/
│       ├── index.ts                     Resolver + Translations interface (typed)
│       └── locales/                     11 files: cs, de, en, es, fr, it, nl, no, pl, pt, sv
├── hacs.json                            HACS manifest
├── package.json
├── tsconfig.json
├── vite.config.ts
├── README.md                            User-facing docs
├── CHANGELOG.md                         Per-release notes
├── ARCHITECTURE.md                      This file
└── LICENSE                              GPL-3.0-or-later
```

The Python preparation toolchain (raw LAZ / LAS → 2-band COG, what the helios-lidar.org companion site uses server-side) lives in the standalone [Helios-Lidar](https://github.com/ReikanYsora/Helios-Lidar) repository and is no longer part of this tree. Contributors working on the card never need to touch the Python side; contributors working on the LiDAR preparation pipeline never need to touch this card-side tree either. Two repos, two concerns, kept loosely coupled by the documented 2-band COG output format the card consumes.


## Code organisation

Three files sit at the root of `src/`: the two entry points HACS and
HA need to find (`helios-card.ts`, `helios-engine.ts`) and the
configuration schema shared between them (`helios-config.ts`).
Everything else is grouped under `card/` or `engine/` by ownership.

### card/* and engine/* subsystems

Each subsystem under `card/` and `engine/` is a focused module that
owns one piece of functionality: data fetch, render, input, util,
lifecycle on the card side; physics, geometry, animation, layer on
the engine side. Modules export plain functions; they do not
extend the card class or the engine class.

Subsystem modules talk to their parent (the card or the engine)
through a small **host interface** declared in the module itself.
The interface lists exactly the fields and methods the module
touches on `this`, no more. The card and the engine satisfy these
interfaces structurally, so a call site looks like:

```ts
// In helios-card.ts
import { refreshPv } from './card/pv';

protected updated(): void {
    refreshPv(this);   // `this` satisfies card/pv.ts's PvHost
}
```

The pattern keeps three things in balance:

* **Lit reactivity stays natural.** The card still owns its
  `@state` fields; assignments from inside a subsystem module hit
  the same Lit setter and trigger a re-render exactly as an inline
  assignment would.
* **No indirection at runtime.** Calling `refreshPv(this)` is a
  direct function call. No service classes, no mixin gymnastics,
  no `requestUpdate()` ceremony.
* **Each module's surface is explicit.** Reading the `PvHost`
  interface tells you everything the PV subsystem can touch on the
  card.

A handful of state fields therefore had to lose the `private`
modifier so a host interface could declare them. The underscore
prefix (`_pvCurrent`, `_lastHomeKey`, `_detailDiveRaf`, ...) stays
as the convention marking them as internal-to-the-card; they are
not part of the user-facing API.

### Render functions vs handlers vs data services

Three call shapes recur across the card subsystems:

* **Pure render**: `renderChart(host): TemplateResult`. Reads host
  state, returns a Lit template. No mutation. Card render() calls
  it inline (`${renderChart(this)}`).
* **Event handler**: `onTimelinePointerDown(host, e)`. Reads the
  event, mutates host state, optionally sets up an
  `addEventListener` chain. Card render() wires it as an arrow
  (`@pointerdown="${(e) => onTimelinePointerDown(this, e)}"`).
* **Data service**: `refreshPv(host)`, `fetchPvHistory(host, ...)`.
  Called from lifecycle hooks (`updated()`, intervals). Reads
  hass / config / time range, mutates the corresponding `@state`
  buckets, kicks the engine when needed.

The dashboard module composes all three: its `renderDashboard`
returns a template, its `handleHomeClick` / `handleExitDetail` are
event handlers, and its `computeTodayHourly` / `computeBatteryToday`
are pure data services consumed by both the templates and the
diagnostic snapshot.


## Module responsibilities

### Entry points + shared config

* **`helios-card.ts`**, top-level Lit element. Owns the `render()`
  orchestrator, the `@state` fields, the HA card API
  (`setConfig`, `getCardSize`, `getGridOptions`), the Lit
  lifecycle hooks (`connectedCallback`, `disconnectedCallback`,
  `updated`), and the public `resetDataCache()` method that the
  editor's reset button drives through a window-level event bus.
  Delegates the substantive work to `card/*` modules.
* **`helios-engine.ts`**, top-level engine class. Owns the
  MapLibre instance, the GeoJSON sources / layers, the weather
  pipeline orchestration, the screen-space projections, the
  per-array PV markers, and the public API consumed by the card
  (`onWeatherUpdate`, `projectSunScene`, `setSelectedTime`,
  `getTimelineSeries`, `getLidarRaster`, `getAmbientSeries`,
  `setLidarViewActive`, `resetDataCache`, etc.). Delegates focused
  subsystems to `engine/*` modules.
* **`helios-config.ts`**, `HeliosConfig` interface (every editor
  / YAML option) + `DEFAULT_*` constants. Imported by both the
  card and the engine so neither owns the schema.

### card/* subsystems

* **`card/pv.ts`**, PV live state polling, history fetch, rolling
  sample buffer, instantaneous-rate derivation (handles cumulative
  energy via differentiation with a 3 min quantization-noise
  anchor), kWp calibration, per-array orientation + optional
  coordinate parsing, weighted clear-sky forecast, chip formatter,
  one-time wipe of the legacy auto-calibration buffer.
* **`card/battery.ts`**, mirror of `card/pv.ts` for the home
  battery: SoC + signed power live polling, single-call history
  fetch (both entities bundled into one WS round-trip), invert
  preference, scrub-time sampling, chip formatter, today's
  charge / discharge aggregation.
* **`card/radiation.ts`**, optional `solar-radiation-entity`
  bridge: pulls live + history, pushes the merged sample set to
  the engine so its irradiance model prefers the physical sensor
  over Open-Meteo for the live + past portions of the chart.
* **`card/charts.ts`**, the two SVG cards under the map: the
  irradiance + cloud mirror chart, the optional PV production
  chart, the timeline cursors (live + scrub), the day-label
  chips with per-day kWh totals, and the aggregation helper that
  produces those totals from the observed history + forecast model.
* **`card/dashboard.ts`**, the detail-mode panel: the today card
  (produced kWh + refined forecast + dual peak readouts + cumulative
  sparkline with sunrise / sunset markers + now cursor + hover
  tooltip), the tomorrow card (forecast kWh + peak hour), and the
  battery card (vessel-style SoC + charge / discharge totals).
  Tomorrow stretches full width when no battery is configured. Plus
  the home click / exit handlers that toggle detail mode.
* **`card/calibration.ts`**, the forecast learning loop. Iterates
  over the last 5 completed days, computes `actual / predicted`
  per day, filters out days with too little predicted production
  to give a stable ratio, averages the surviving ratios, clamps to
  [0.5, 1.5] and returns a `{ ratio, daysUsed }` pair. Pure
  function consumed by `dashboard.ts` to render the "refined"
  annotation; null when fewer than 2 past days carry enough data.
* **`card/overlays.ts`**, screen-space projections refreshed on
  every map transform and clock tick: sun arc samples, sun
  position, home silhouettes, label anchors.
  Plus `setAnimationsPaused` (IntersectionObserver hook),
  `buildArcSegments` (pairs arc samples into stroke-ready
  segments), and `flowDuration` (rate-to-duration easing used by
  the leader and sun-ray animations).
* **`card/timeline.ts`**, the 30-second clock tick, the timeline
  scrub pointer handlers (down / move / up + apply), the
  back-to-live action, plus the three small config readers for
  timeline enabled / width / consumption-chip toggles.
* **`card/lidar-view.ts`**, the LiDAR View overlay toggle and the
  rAF loop that smooths the enter / exit alpha fades. State is
  owned by the card (`_lidarViewMode`, fade timestamps); the
  module only orchestrates the transitions and pushes the
  composited alpha to the engine's WebGL layer.
* **`card/init.ts`**, the lifecycle helpers the card's
  `connectedCallback` / `updated` delegate to:
  `getHomeCoords(config, hass)` (3-tier override resolver),
  `computeConfigSig(config)` (cheap visual-config hash that gates
  `engine.updateConfig`), `initVisibilityObserver(host)`,
  `initEngine(host)` (debounced wrapper that defers MapLibre
  construction 500 ms so editor-preview churn doesn't burn WebGL
  contexts), and `initEngineNow(host)` (the actual construction +
  callback wiring).
* **`card/format.ts`**, dependency-free formatting and validation
  helpers: `cfgHex` (hex validator), `formatDate` (locale-
  independent token formatter), `formatLocalisedNumber`
  (Intl.NumberFormat with fallback), `darkenHex`, `lerpHexToward`.
  Imported by every render module + the editor.
* **`card/editor.ts`**, `<helios-card-editor>` (visual editor
  rendered inside HA's dashboard editor, every section
  collapsible, only one open at a time) + `<helios-color-picker>`
  (custom palette + hex picker that side-steps the iOS Safari
  `<input type="color">` crash inside HA's nested Shadow DOM).
  Hosts the per-array PV layout repeatable section, the reset
  data cache control, and a `window.dispatchEvent` bridge so the
  editor doesn't need a direct handle on the card.

### engine/* subsystems

* **`engine/sun.ts`**, `getSunPosition`, `computePvPower`,
  `computeIrradianceWm2` and the supporting Haurwitz / Kasten-
  Czeplak / Liu-Jordan math. `computePvPower` also accepts a
  `PvComputeContext` carrying optional `airTempC` + `windMs` +
  `shading`, which it forwards to `pv-thermal.ts` for cell-temp
  derating and to the caller for direct-beam zeroing on shaded
  arrays. Pure functions; no DOM, no map. Shared between the
  engine (live + forecast) and the card's PV forecast renderer.
* **`engine/pv-thermal.ts`**, Sandia NOCT cell-temperature model
  + linear temperature-coefficient derating. `cellTemperatureC()`
  estimates the cell temp from air temperature, plane-of-array
  irradiance and wind speed; `thermalDerating()` returns the
  multiplicative output factor at the resulting cell temp
  (γ_pmp = −0.0040 /°C by default). Both pure functions.
* **`engine/pv-shading.ts`**, per-array LiDAR-aware shading check.
  `sampleNdsmAt()` bilinear-samples the loaded nDSM raster at
  arbitrary lon/lat; `sampleDtmAt()` does the same for the optional
  DTM band shipped by 2-band COGs from helios-lidar.org v1.6.3+.
  `isPanelShaded()` ray-marches from a panel position along the sun
  direction (2 m step, 200 m reach) and returns true the first time
  the local terrain + obstacle stack exceeds the sun ray's altitude.
  When the raster carries a DTM band, the ray-march compares both
  the ray and the obstacle in absolute Z anchored at the panel's
  local ground; without one, it falls back to the flat-ground
  geometry used in v1.6.2 and earlier (covers every public provider
  + legacy single-band local COGs). Pure functions.
* **`engine/weather.ts`**, `fetchHomePointData` and friends:
  multi-model Open-Meteo fetch with median fusion, regional
  model selection, in-browser cache, 429 back-off schedule, plus
  `clearWeatherCache()` used by the editor's reset button. The
  fetch covers 7 past days + today + 2 forecast days; the
  timeline UI itself clips to the last 2 past days for scrub
  precision, the extra payload feeds the forecast calibration.
  Hourly variables include `shortwave_radiation_instant`, the
  three split cloud layers, `weather_code`, and the
  `temperature_2m` + `wind_speed_10m` pair that feeds the PV
  thermal-derating model. No DOM, no map.
* **`engine/buildings.ts`**, OpenFreeMap planet vector-tile fetch
  around the home (snapshot URL resolved once via the `/planet`
  TileJSON, cached for the page lifetime). Decodes tiles with
  `@mapbox/vector-tile`, splits MultiPolygons, filters features
  by haversine distance, identifies the home cluster, returns
  two GeoJSON `FeatureCollection`s.
* **`engine/shadows.ts`**, `projectExtrusionShadows`: takes a
  building / region FeatureCollection plus the sun position and
  returns flat-opacity ground shadow polygons (one convex hull
  per input region). Output is Sutherland-Hodgman clipped against
  the building visibility disc so cast shadows never extend past
  the rendered surroundings.
* **`engine/shadow-raster.ts`**, the offscreen canvas pipeline
  that turns the projected shadow polygons into a PNG fed to
  MapLibre's ImageSource. Painting every polygon solid black
  means overlapping regions stay black (no alpha stacking); the
  layer's `raster-opacity` then applies a single per-pixel
  opacity matching the user setting exactly. Also exports
  `shadowBoundsCornersLL` (lat/lon corners for the image source)
  and `BLANK_SHADOW_DATA_URL` (transparent 1x1 PNG used as the
  initial bind).
* **`engine/lighting.ts`**, day-night colour math driven by sun
  altitude: `nightShadeForAltitude` (overlay colour + opacity
  ramped across astronomical / nautical / civil twilight and
  sunrise / sunset wash), `buildingColorForAltitude` (extrusion
  colour blended from the configured base towards a cool dark
  ink at night and a warm tint at golden hour),
  `sunLightPolarFromAltitude` (MapLibre directional-light polar
  angle clamp). Pure formulas; the engine applies the values to
  paint properties and `setLight`.
* **`engine/auto-rotate.ts`**, the idle-camera orbit rAF loop.
  Rotation runs in the opposite direction to the sun's apparent
  motion, paused for 5 s after every user gesture and gated on
  the `auto-rotate-enabled` config toggle + `!_detailMode`. Time-
  based delta integration so the rotation speed stays constant
  across 60 Hz / 120 Hz displays and across tab-throttling.
* **`engine/detail-mode.ts`**, the home-click camera dive: a
  single smoothstep tween over zoom + pitch + bearing driven by
  jumpTo on every rAF tick (sidesteps MapLibre's bearing
  normalisation which would collapse a wide spin to its shortest
  equivalent). Plus the 600 ms post-exit cooldown that gates
  fresh gestures so the dismiss click can't bleed into an
  immediate scrub on the timeline behind the panel.
* **`engine/lidar-view-layer.ts`**, the MapLibre custom layer
  that draws every loaded LiDAR cell as a small dot in screen
  space, with optional wireframe overlay. WebGL-resident,
  re-rasterised by MapLibre on every transform with no JS-side
  redraw. Driven by `engine.setLidarViewActive(boolean)` and
  `engine.setLidarViewFadeAlpha(0..1)`. Theme-aware colours,
  distance fade, configurable display radius decoupled from the
  building visibility disc so the dot cloud can extend past the
  rendered buildings (the trees that cast the surrounding shadows
  often sit beyond the building disc).
* **`engine/lidar.ts`**, `LidarSource` interface + `LIDAR_SOURCES`
  provider registry + `findLidarSource(lat, lon)` + `resolveLidarSource(lat, lon, cfg)`
  helpers. Also hosts the validator for the six `lidar-local-ndsm-*`
  BYO keys. Adding a country means dropping a new file under
  `./engine/lidar/providers/` and importing it into the registry.
* **`engine/lidar/pipeline.ts`**, the shared post-processing
  every provider routes through: classify cells above a height
  threshold (with optional circular crop), size-capped 8-connected
  flood fill so dense forests decompose into many small clumps,
  one convex hull per clump emitted as a `Polygon` feature with
  `render_height = mean(clump cells)`. Identical output shape to
  OpenFreeMap building footprints, so the rest of the engine
  doesn't care which side fed the polygons.
* **`engine/lidar/geotiff.ts`**, `fetchFloat32GeoTiff` for the
  WMS / WCS / ArcGIS endpoints that serve `image/tiff` (everyone
  except IGN's BIL fast path) plus `subtractRasters` (DSM minus
  DTM → height-above-ground) and `maxRasters` (used by Spain to
  merge vegetation and building MDSn coverages). The `geotiff`
  package is the only third-party dependency added for LiDAR
  support; its lazy-loaded codecs (pako, zstd, lerc, jpeg, lzw)
  are inlined into the single-file bundle by Vite
  `inlineDynamicImports`.
* **`engine/lidar/local-ndsm.ts`**, generic BYO nDSM provider
  built on demand from card config (not registered in
  `LIDAR_SOURCES`). Geotiff decoding uses
  `fetchFloat32GeoTiffWithNoData()` (a sibling of
  `fetchFloat32GeoTiff()` that also returns the GDAL_NODATA
  sentinel so nodata cells can be mapped to NaN before the
  shared pipeline runs). Contributed by
  [@jourdant](https://github.com/jourdant) in
  [PR #5](https://github.com/ReikanYsora/Helios/pull/5),
  original idea credited to
  [@stephenwq](https://github.com/stephenwq). Unlocks coverage
  in any region with raw LiDAR data available offline (initial
  use case: NSW Australia).
* **`engine/lidar/providers/*.ts`**, one file per country / region.
  Single-fetch normalised-raster providers (height-above-ground
  natively): France (BIL float32), Germany-NRW (Geobasis nDOM),
  Poland (GUGiK NMPT, EPSG:4326 native), Canada (NRCan HRDEM DSM
  via WCS 1.1.1). Two-fetch DSM-minus-DTM providers: England /
  Netherlands / Norway / Austria-Styria. MAX-merge provider:
  Spain (PNOA MDSn vegetation + buildings). Each provider ends
  by handing a single height raster to `pipeline.ts` for
  post-processing. See [LIDAR_PROVIDERS.html](./LIDAR_PROVIDERS.html)
  for the full worldwide registry, including verified-compatible
  candidates pending integration and explicitly-incompatible
  sources.

---

## Algorithms

### Solar position

`getSunPosition(date, lat, lon)` returns altitude / azimuth. The
implementation uses a simplified declination + equation of time,
with hour-angle normalisation so longitudes far from Greenwich
(NYC, Tokyo, Sydney) stay correct. Validated against the NOAA SPA
reference: mean altitude error 0.30°, mean azimuth error 0.36°
across 376 sample points.

### Clear-sky irradiance

Haurwitz (1945): `GHI_clear = 1098 · cos(z) · exp(-0.059 / cos(z))`
W/m², where `z` is the solar zenith angle. MAE ~62 W/m² versus
PVGIS / NREL benchmarks across full-day curves at varied latitudes.

### Cloud attenuation

Kasten-Czeplak (1980) cubic: `GHI_actual / GHI_clear = 1 - 0.75 ·
(cloud/100)^3.4`. The cloud cover used here is the *effective*
ground-perception value (see below), not the satellite-view total
from Open-Meteo.

### Effective cloud cover

The raw `cloud_cover` field from Open-Meteo measures the satellite-
view total. For ground-level shortwave attenuation, low cloud
weighs much more than high cloud. HELIOS computes:

```
effective_cover = clamp(low + 0.6·mid + 0.2·high, 0, 100)
```

### Multi-model weather fusion

Every Open-Meteo fetch queries one global model (ECMWF IFS 0.25°)
plus the most accurate regional model for the home's location
(AROME-France, UKMO UK, DWD ICON-D2, ItaliaMeteo, MET Nordic,
NOAA HRRR, KMA LDPS, JMA MSM, BOM ACCESS-G, or ECMWF + GFS
elsewhere). Per-timestep median fusion absorbs single-model
outliers (low-cloud pegs, irradiance spikes).

### PV instantaneous rate

For cumulative-energy sensors (`Wh`/`kWh`), the card maintains a
5-minute rolling buffer of state samples and differentiates over a
~60 s window. The differentiation also holds a 3 min anchor when
samples arrive faster than that, so the integer-Wh quantization
noise of typical HA recorders doesn't translate into phantom
power spikes (a 1 Wh delta over 10 s would otherwise read as
360 W; with the anchor it averages cleanly across enough samples
to converge on the true rate). Power sensors (`W`/`kW`) are read
directly from `hass.states`.

### Forecast calibration

The dashboard's "refined" annotation under each PRÉVU figure comes
from a small daily ratio averaged over the last 5 completed days.
For each day in [J-1, J-5]:

* `predicted_kwh` = integrate `pct × kWp` over the day's hourly
  weather samples (re-run of the model the dashboard uses for
  the future, applied to the stored past).
* `actual_kwh` = sum the observed PV history over the same day
  (deltas for cumulative-energy sensors, trapezoidal integration
  for power sensors).
* Skip days where `predicted_kwh < 2 kWh` (cloudy days don't
  carry enough signal to give a stable ratio).
* `ratio = actual / predicted`, clamped to [0.5, 1.5] so a
  one-off sensor outage can't poison the average.

If 2 or more valid daily ratios survive, the average is returned;
otherwise `null` (the refined annotation is hidden). The
calibration captures static biases that the pure model can't see:
Open-Meteo cloud over- / under-prediction in your area, panel
soiling, install orientation that the configured azimuth doesn't
perfectly capture, inverter losses, etc.

`PAST_DAYS` in `engine/weather.ts` was bumped from 2 to 7 to give
the calibration enough history to average over; the timeline UI
itself clips back to 2 past days via `_getTimeRange()` so the
slider stays scrubbable.

### Building radius + home cluster

At engine init, `helios-buildings.ts` fetches OpenFreeMap planet
vector tile(s) covering a bbox around the home (1–4 tiles at z=14).
The tile URL template is resolved once at startup from the public
TileJSON at `https://tiles.openfreemap.org/planet`; OpenFreeMap
rotates the underlying snapshot path every few weeks, so caching
the template per page lifetime keeps the engine pointed at
whatever snapshot is current. Each tile's `building` source-layer is
decoded (OpenMapTiles schema, so `render_height` and
`render_min_height` are present); MultiPolygon
features are split into independent Polygon features. Then each
feature is classified:

- If the polygon contains the home point OR its centroid is within
  `building-cluster-radius` of the home → home cluster.
- Else if its centroid is within `building-radius` → surroundings.
- Else discarded.

The home cluster is emitted as one `FeatureCollection`, painted at
full opacity. Surroundings are another `FeatureCollection`, painted
at the configured opacity. Both share the same `fill-extrusion-color`
modulated by sun altitude.

### LiDAR shadow consolidation

When `shadows-enabled` is true AND a LiDAR provider covers the home,
the engine resolves the matching `LidarSource` via
`findLidarSource(lat, lon)` and calls its `fetchShadowRegions()` with
the home position, the building visibility radius and a raster size
driven by `lidar-precision` (256² / 512² / 1024²).

Each provider does one (France: BIL float32 from IGN's
`IGNF_LIDAR-HD_MNH_*` WMS; Germany-NRW: pre-computed nDOM from the
Geobasis WCS) or two (UK / NL / NO: GeoTIFF DSM minus DTM; Spain:
vegetation MDSn merged with buildings MDSn via MAX) upstream
fetches, decodes them client-side and hands a single height raster
to the shared post-processing pipeline. Then:

- **Filter.** Cells with `5 ≤ h ≤ 100 m` pass the height threshold.
  Cells beyond `radiusMeters` haversine from the home are dropped
  (circular crop).
- **Flood-fill with size cap.** 8-connected BFS, but each component
  stops growing once it reaches `TARGET_COMPONENT_AREA_M2 / cellArea`
  cells (~80 m² physical). When the cap hits, leftover neighbours
  are picked up by the outer scan loop as fresh seeds, so a dense
  forest decomposes into many small clumps instead of one giant
  region. The cell cap is recomputed per precision from the actual
  pixel pitch so the physical clump size stays consistent.
- **Convex hull per clump.** For each clump, take the convex hull of
  the cells' four corners and emit one Polygon with `render_height
  = mean(clump cells)`. The hull is an irregular, non-axis-aligned
  polygon, so cast shadows from many overlapping clumps alpha-
  composite into a continuous dappled pattern instead of looking
  like a grid-aligned tile mosaic. Single-cell or near-single-cell
  components (< `MIN_COMPONENT_CELLS`) are dropped so noise from
  the height threshold doesn't render as speckled dots.

Polygon count: typically a few hundred to a few thousand clumps per
fetch, scaling with the wooded area covered rather than the raster
resolution.

Those polygons feed `projectExtrusionShadows` exactly like the
OpenFreeMap building footprints do when no provider covers the
home. The result is then clipped to the building visibility disc
(see Shadow clipping below).

### Shadow clipping

`projectExtrusionShadows` accepts optional `clipCenterLat`,
`clipCenterLon`, `clipRadiusMeters`. When provided, it builds a
64-vertex CCW polygon approximating the disc and runs
Sutherland-Hodgman against each emitted shadow polygon. The shadow
trail of a tall region near the edge of the visibility radius
(which would extend hundreds of metres past the buildings) gets
clipped to the same circle as the rendered surroundings.

---

## Configuration

```yaml
type: custom:helios-card
```

No keys, no signup. The basemap comes from OpenFreeMap (free vector
tiles) and weather from Open-Meteo (free, no key). See the full
option table in [README.md](./README.md). Every field is editable
visually; numeric options are sliders so out-of-range values can't
be entered.

---

## Diagnostics

The bundle exposes a single global command for in-browser debugging:

```js
window.heliosStats()
```

Runs against every `<helios-card>` currently mounted on the page and
returns a JSON-safe snapshot AND prints a grouped console dump. Each
card section contains:

- **config**, the live `setConfig` payload (JSON-safe and OK to
  paste publicly, no API keys are ever stored).
- **engine**, the engine's own snapshot: home lat/lon, resolved
  LiDAR provider (or `null` when out of coverage), shadow source
  (`disabled` / `lidar` / `openfreemap` / `pending`), shadow
  opacity and LiDAR clump count, building footprints count,
  weather samples, active timeline range, cache state for the
  per-day sun arc and the last shadow signature.

A `lifecycle` block aggregates module-level counters maintained by
the engine (`window.__heliosStats`): engines created vs cleaned up,
WebGL context-lost events, building fetches fired, etc. Useful for
diagnosing leaks across config edits and reloads.

`heliosStats()` does not mutate any state; it can be invoked from
the user's console at any time.

Two companion helpers let developers reproduce visual issues on a
different home location without touching HA's config:

```js
setHeliosLocation(lat, lon)   // override home for every live card
clearHeliosLocation()         // revert to hass.config
```

The override lives on `window.__heliosLocationOverride` only; a page
refresh always restores HA's home.

A reset-from-the-card path is also exposed: the editor's "Reset
data cache" button fires a `helios-data-cache-reset` window event;
every live card listens for it and calls its public
`resetDataCache()` method, which wipes the cached Open-Meteo
payload, drops the in-memory PV history and triggers a fresh fetch.
Home Assistant data is never touched.

---

## Build & publish

```bash
npm install
npm run typecheck       # strict TS
npm run build           # produces dist/helios.js
```

To publish a release:

1. Make sure `dist/helios.js` is committed (HACS needs the prebuilt
   bundle).
2. Tag the commit and push:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
3. Create a GitHub Release (HACS needs a Release, not just a tag).
   The `release.yml` workflow rebuilds `dist/helios.js` from the
   tagged commit and attaches it to the release.

---

## Known limitations

* **Equatorial azimuth**, peak ~9° error near the equator at the
  solstices because of the simplified declination formula.
  Acceptable for the visual hillshade direction; if higher precision
  is ever needed, swap in a NOAA-SPA implementation.
* **OpenFreeMap availability**, the basemap, glyphs, sprites and
  building tiles all come from OpenFreeMap's public CDN. There's no
  per-user rate limit, but the project is run by a single
  organisation; if their CDN goes down, the basemap stops loading
  for everyone. No commercial SLA is offered.
* **LiDAR coverage**, ten providers registered today (France IGN
  HD, England Defra, Spain IGN, Netherlands PDOK, Norway Kartverket,
  Germany NRW, Germany Brandenburg + Berlin LGB, Poland GUGiK,
  Canada NRCan HRDEM, USA Vermont VCGI). Four additional providers
  (Austria Steiermark, Austria Tirol, Germany Baden-Württemberg,
  Belgium Flanders) live in `engine/lidar/providers/` but are NOT
  in the registry, the DSM-DTM subtraction quality on those feeds
  was below the bar set by the existing nDSM providers (per-pixel
  subtraction amplifies noise on building edges and over vegetation).
  They can be re-enabled by adding them back to LIDAR_SOURCES once a
  cleaner data path is identified. Out-of-coverage homes fall back
  to OpenFreeMap building footprints (buildings only, no vegetation),
  so the visual works worldwide but trees / hedges only cast shadows
  in covered countries. Users in uncovered regions with access to
  raw LiDAR data can host their own nDSM GeoTIFF and have Helios use
  it as the shadow source via the BYO `lidar-local-ndsm-*` config
  (prepared most easily via the companion site at
  [helios-lidar.org](https://helios-lidar.org)).
* **WebGL contexts on long-lived dashboards**, browsers cap
  concurrent WebGL contexts at 8–16. Helios releases its context
  cleanly on every re-init via `WEBGL_lose_context`, but if you
  stack many MapLibre-backed cards in the same dashboard you may
  hit the limit; the browser will then recycle aggressively and
  performance can degrade. Use `pixel-ratio: 1x` and
  `map-style: minimal` on such setups.
* **Forecast calibration scope**, the refined value in the
  dashboard captures static biases between the model and observed
  production (cloud forecast skew, soiling, orientation, inverter
  losses) but doesn't model time-of-day shading (terrain shadows,
  tall trees east / west of the panels). For installs with strong
  morning or evening shading, the refined number can still over-
  estimate during the shaded hours.
* **PV array map markers vs. forecast cloud cover**, when
  `pv-arrays` entries carry their own GPS, the forecast uses those
  per-array coordinates for the sun position math but the cloud
  cover is still fetched at the home location. For panels within
  the same Open-Meteo grid cell (typically 1–10 km) this is
  exact; for panels several kilometres away, the cloud values
  may differ slightly from the panel's true micro-weather.
