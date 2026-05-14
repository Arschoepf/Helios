# HELIOS, v1.4.0

HELIOS is a Home Assistant Lovelace custom card that visualises solar
conditions at a home in real time: sun arc, irradiance, cloud cover,
3D buildings with cast shadows, optional PV production, optional
home-battery state, all stitched onto a 3D MapLibre map centred on
the home and reflected in a scrubbable 5-day timeline.

---

## Changelog

Each entry consolidates everything between two stable releases.

### v1.4.0, LiDAR-driven shadows, SVG cloud overlay, Shading section

Headline iteration on top of v1.3.0. Integrates the French national
LiDAR HD dataset (IGN, metropolitan France + Corsica) as a source
for cast-shadow geometry: where coverage exists, shadows reflect
real buildings AND vegetation captured by aerial LiDAR, instead of
the flat MapTiler footprints (buildings only) used everywhere else.
The cloud-cover disc + 100 % ring move from MapLibre fill layers to
an SVG overlay so they stay a true circle whatever the terrain mesh
does underneath.

**Shadow pipeline.** A single master `shadows-enabled` toggle drives
whether cast shadows are rendered at all. When on, the source is
picked automatically:

- **Home inside a LiDAR provider's coverage.** The card fires one
  WMS round-trip to IGN's `IGNF_LIDAR-HD_MNH_*` service, decodes
  the BIL height raster client-side, classifies every cell against
  the MapTiler footprints (home / building / vegetation), runs an
  8-connected flood fill that keeps cells of the same kind grouped,
  and emits one convex-hull Polygon per region with `render_height`
  set to the region's mean. Those polygons feed
  `projectExtrusionShadows()` exactly like the MapTiler path.
- **Outside coverage.** The card falls back to the MapTiler home +
  surroundings footprints, projected through the same shadow
  emitter (buildings only, no vegetation).

`lidar-precision` (`low / medium / high` mapped to 256² / 512² /
1024² rasters) controls the IGN raster sampling. It has no effect
out of coverage.

**Shadow clipping.** Every cast shadow is clipped to the building
visibility disc via Sutherland-Hodgman against a 64-segment
polygonal approximation. A tall tree right at the edge of the
radius no longer projects a 200 m tail past the visible
surroundings. Consistent with the buildings layer, which is itself
filtered to that disc.

**Cloud disc + ring → SVG.** The translucent on-ground cloud-cover
disc and its fixed 100 % reference ring live as SVG polygons in a
dedicated `.cloud-svg` overlay, projected through
`_projectScenePoint(..., anchorAtHome: true)` (same trick used by
the sun arc) so every vertex shares the home's terrain elevation
reference. The hover breakdown tooltip is wired directly on the
SVG polygon.

**Cast shadow gradient.** `projectExtrusionShadows` emits three
nested polygons per casting region (decreasing length), rendered
by three filtered fill layers at `fill-opacity = total / 3` each.
Alpha compositing gives a linear fade from opaque at the footprint
to one-third opaque at the shadow tip.

**Editor reshuffle.** A new "Shading" section regroups every
shadow-related option: the master toggle, the LiDAR precision
selector (`low / medium / high`), and the opacity slider. The
old "MapTiler shadows" toggle and the irradiance-scanner section
are gone.

**i18n.** New keys: `shadowsSection`, `shadowsEnabled*`,
`lidarPrecision*`, `shadowOpacity*`, `mapStyleMinimal`,
`mapStyleSatellite`, `terrainDetail*`. All 7 locales updated.

### v1.3.0, Auto-calibrating PV, terrain detail, mobile rotation, stability

A feature-rich iteration on top of v1.2.0. Adds auto-calibrating PV
prediction with persistence, terrain-detail control, building
outlines, peak-production highlights, and a mobile-friendly single-
pointer rotation handler. Also consolidates a long string of
stability hotfixes (memory leaks, iOS WebGL recovery, editor-preview
engine skip, engine-count cap). No breaking changes; existing
configs work without modification.

**Auto-calibrating PV prediction.**
The card learns the user's installation by ratio-matching its
Haurwitz/Kasten-Czeplak prediction against the live PV power sensor.
A rolling calibration buffer keeps a recent history of `(predicted,
actual)` samples and produces a smoothed gain so the predicted curve
on the PV chart matches the user's setup over time. The buffer is
persisted server-side via Home Assistant's `frontend/user_data`, so
it survives browser cache wipes, device switches, and dashboard
restarts.

**PV chart improvements.**

- Daily peak-production highlight columns mark each day's maximum
  on the PV chart so the eye lands on the relevant slice without
  reading the axis.
- The leader between the cloud-cover chip and the cloud disc now
  terminates at the edge of the filled disc (sized by the live
  cloud percentage) instead of the fixed reference ring.

**Terrain detail.**
New `terrain-detail` option toggles the DEM `maxzoom` between a
smooth low-detail mesh (default) and a finer terrain pass for users
in dramatic relief.

**Building outlines.**
Both `helios-buildings-home` and `helios-buildings-surroundings`
layers are accompanied by a stroke outline so building footprints
stay legible at low opacity.

**Mobile drag rotation.**

- Custom single-pointer rotation handler replaces MapLibre's
  default right-click `dragRotate` so left-click / single-finger
  touch rotates the map cleanly on mobile.
- `touch-action: none` is forced on the MapLibre canvas so the
  browser doesn't intercept the gesture as a scroll.
- Manual drag direction is inverted so the map follows the gesture
  (drag right → world rotates with the finger).

**Editor and lifecycle stability.**

- Engine initialisation is debounced by 500 ms; cards that live for
  less than that (HA dashboard editor preview, rapid config edits)
  never spawn a MapLibre engine or claim a WebGL context.
- A module-level cap on live `HeliosEngine` instances force-cleans
  the oldest when a new one would push the count over the Safari
  mobile WebGL ceiling.
- A hard skip on cards rendered inside HA's dashboard editor
  preview prevents context exhaustion during config editing.
- `window.__heliosStats` exposes lifecycle counters
  (engine create / cleanup / skipped-as-preview) for in-browser
  forensics.

**Memory hardening.**

- iOS WebGL recovery: the context is force-released via
  `WEBGL_lose_context.loseContext()` after `map.remove()`.
- Pre-cleanup of the map container drains leftover canvas nodes
  before each engine re-init.
- Layer-style warnings are silenced at the source by gating
  `setPaintProperty` on `map.getLayer()` existence.

**i18n.**
French punctuation polish (non-breaking spaces before `:`, `;`, `?`,
`!`). New key: `terrainDetail`.

### v1.2.0, Performance, customization, home cluster

A performance-first iteration on top of v1.1.0, plus several
requested customization knobs and a structural fix to the building
rendering pipeline that resolves the dominant FPS bottleneck
reported on v1.1.0. No breaking changes; existing configs work
without modification.

**Buildings, fully self-sourced.**
The 3D buildings used to come from MapTiler's full vector basemap
with no spatial filter, painting thousands of fill-extrusions per
frame in dense urban areas. The card now fetches the MapTiler v3
vector tiles around the home directly, decodes them with
`@mapbox/vector-tile`, splits the MultiPolygon features that group
unrelated buildings together at the source, filters by haversine
distance, and emits two GeoJSON collections rendered as two
distinct fill-extrusion layers:

- `helios-buildings-home`, the home and any attached outbuildings,
  at full opacity.
- `helios-buildings-surroundings`, neighbours within the configured
  visibility radius, at the configured opacity.

The native MapTiler building layers (`Building`, `Building 3D`,
`Building number`) are removed at style load, the bare `removeLayer`
calls work reliably on the current MapTiler v4 style which doesn't
use MapLibre 5 style imports.

**New configuration options:**

- `building-radius` (m, default 100, range 20–1000), visibility
  radius for neighbour buildings.
- `building-cluster-radius` (m, default 0, range 0–100), distance
  around the home within which every building joins the home group
  at full opacity. Lets verandas, garages and sheds read as one
  with the main house.
- `building-opacity` (0..1, default 0.25), opacity of the
  neighbour buildings.
- `building-color` (hex, default `#d2d2d7`), base colour for every
  rendered building, modulated by sun altitude through the day.
- `performance-mode` (boolean, default `false`), disables the 3D
  terrain mesh and hillshade and forces pixelRatio to 1.0. Pitch and
  3D buildings are preserved, so the card still reads as 3D but
  recovers 3–5× FPS on low-end devices.
- `map-style: 'minimal'`, a third option alongside `'streets'` and
  `'topo'` that loads streets-v4 then prunes every non-essential
  layer (POI symbols, place names, country labels, road shields)
  for a stripped basemap.
- `auto-rotate-enabled` (boolean, default `true`), opt out of the
  slow ambient camera orbit.

**Layout polish.**

- The date/time chip and the timeline now sit at symmetric distances
  from the card edges.
- The "Back to live" tab is larger (40 × 24 px) and easier to tap.
- The PV / SoC / Power chip cluster moved closer to the home; the PV
  chip is mirrored below the SoC / Power shelf, placing it next to
  the home as a focal badge.
- The PV-to-home dashed leader was retired, the chip's position
  already conveys the relationship.
- The solar ray now snaps to the side of the PV chip that faces the
  sun (top / right / bottom / left, ±45° windows from up).
- The cloud-cover leader points to the centre of the cloud disc
  instead of the reference ring's east edge.

**Editor UX.**

- Every numeric option is a slider with the value shown next to the
  track. No more chance to type an out-of-range value.
- Slider input is debounced (250 ms) before the engine sees the
  value, so dragging doesn't cascade per-pixel re-renders.

**Animation perf.**

- An `IntersectionObserver` pauses every CSS animation and every
  SVG SMIL animation when the card scrolls out of the viewport.
- `prefers-reduced-motion` is respected, system-level reduced-
  motion setting disables every Helios animation and transition.

**Memory and stability.**

- The four inactivity-bumper canvas listeners are now detached on
  `cleanup()`; their closure used to keep dead MapLibre maps alive
  across editor re-inits.
- The WebGL context is force-released via
  `WEBGL_lose_context.loseContext()` after `map.remove()`, browsers
  cap active WebGL contexts at 8–16 and weren't always reclaiming
  the slot when MapLibre alone released the resources.
- The map container is drained of leftover canvas nodes before each
  engine re-init.

**Internals.**

- Terrain DEM `maxzoom` lowered from 14 to 12, terrain mesh has
  ~16× fewer vertices to project per rotation frame, invisible at
  pitch 55° / zoom 18 over the home.
- `pixelRatio` cap lowered from `[2, 3]` to `[1.5, 2]` on desktop
  and `[1, 1.5]` to `[1, 1.25]` on mobile.
- Hybrid map style (satellite imagery + raster pipeline) retired.
- Card chrome theme is wired to the map style: `card-theme: 'dark'`
  loads the `-dark` MapTiler variant.

**i18n.**
New keys: `mapStyleMinimal`, `buildingsSection`, `buildingsHint`,
`buildingRadius`, `buildingClusterRadius`, `buildingOpacity`,
`buildingColor`, `performanceMode`, `performanceModeOn`,
`performanceModeOff`, `performanceModeHint`. Removed:
`mapStyleHybrid` (the hybrid style is gone).

### v1.1.0, Home battery, PV production, dark theme

Major feature pass on top of v1.0.0. Three optional overlays became
available, the card got a dark skin, and the basemap / camera
vocabulary tightened.

**PV production overlay** *(optional, `pv-power-entity`)*.
A chip pinned above the home shows instantaneous production (W or
kW). Cumulative-energy sensors (kWh) are differentiated on the fly
over a rolling 60 s window. A dedicated mirror chart appears above
the irradiance / cloud timeline. The leader line between home and
chip animates at a speed proportional to live production.

**Home-battery overlay** *(optional, `battery-soc-entity` and/or
`battery-power-entity`)*.
Two chips flank the PV chip: State-of-Charge on the left, signed
instantaneous power on the right. The Power chip's leader animates
to track the sign of the live power (charging vs discharging).
L-shaped polylines connect each battery chip to the PV chip.

**Cloud-cover breakdown tooltip.**
Hovering the on-ground cloud disc opens a low / mid / high
breakdown. The chip stays simple; the detail is on demand.

**Dark theme** (`card-theme: 'dark'`).
Card chrome (chips, charts, buttons, tooltips, scrub overlay)
switches to a near-black surface so the card sits cleanly in dark
HA dashboards. Surface tone settled on `#191a1b`.

**Topographic basemap** (`map-style: 'topo'`).
A second basemap option alongside the default streets variant ,
softer earth tones and contour lines for hilly / outdoor settings.

**Other polish.**

- The solar-ray dash flow runs at a speed proportional to live
  irradiance.
- The cloud-cover chip moved off the home's vertical axis to a
  fixed geographic anchor east (NH) / west (SH) of the disc, giving
  the home's axis to the PV chip.
- Solid chip surfaces (fully opaque `#ffffff` / `#14161c`), earlier
  translucent versions fought the values' legibility.

**i18n.** 7 locales, `en`, `fr`, `de`, `es`, `it`, `nl`, `pt`.

### v1.0.0, Initial HACS release

First public release. Core feature set:

- Solar arc projection (NOAA-validated; mean altitude error 0.30°,
  mean azimuth error 0.36° across 376 sample points).
- Live sun disc with irradiance-proportional fill.
- Animated incidence ray from sun to home.
- Cloud-cover ground disc scaled by live cloud %.
- 5-day scrubbable timeline (2 past + today + 2 forecast),
  dual-area chart of irradiance and cloud cover.
- MapTiler 3D basemap with configurable hillshade.
- Open-Meteo multi-model weather fetch with regional model
  selection and median fusion.
- 7-locale i18n.

---

## What HELIOS does

HELIOS is a Home Assistant Lovelace card that visualises solar
conditions at the user's home. The full picture sits on a single
3D MapLibre map:

* **Sun arc**, the sun's full 24 h trajectory across the sky,
  projected onto the screen with depth (thicker stroke when in
  front of the camera, thinner behind). Below-horizon segments
  render as discrete dots so "underground" portions of the arc are
  visible without competing with daylight ones.
* **Sun disc**, the live position on the arc. The inner fill
  scales with irradiance (full at 1 000 W/m², empty at night),
  conveying the W/m² reading geometrically.
* **Incidence ray**, dashed line from the sun to the PV chip,
  animated to flow at a speed proportional to live irradiance.
  Snaps to the side of the PV chip facing the sun.
* **Cloud cover disc**, a translucent disc on the ground, centred
  on the home, scaled by the live cloud-cover percentage and
  outlined in the configured cloud colour. A fixed black ring
  marks the 100 % reference.
* **Solar irradiance chip**, pinned above the sun disc, shows the
  live W/m² figure.
* **Cloud cover chip**, pinned just outside the cloud disc, shows
  the live cloud %. Hovering the disc reveals a low/mid/high
  breakdown tooltip.
* **PV production chip** *(optional)*, when a `pv-power-entity`
  is configured, a chip near the home shows the *instantaneous*
  production in W or kW. Cumulative-energy sensors (kWh) are
  differentiated automatically over a rolling 60 s window.
* **Home battery chips** *(optional)*, State-of-Charge and signed
  instantaneous Power flank the PV chip, each connected to PV by
  an L-shaped leader. The Power leader's dashes flow with the
  sign of the live power.
* **Date/time chip**, top-centre of the card, follows the
  timeline cursor (live or scrubbed).
* **Back-to-live tab**, hangs under the date/time chip while
  scrubbing.
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
│   └── workflows/                  HACS validation + release attach
├── dist/                           Generated by `npm run build` (committed for HACS)
│   └── helios.js                   Single bundle
├── src/
│   ├── helios-card.ts              Lit card class, composes everything
│   ├── helios-card-css.ts          Card styles (extracted for readability)
│   ├── helios-config.ts            Visual editor + color picker + config helpers
│   ├── helios-engine.ts            Map orchestration + projection + layers
│   ├── helios-buildings.ts         Self-sourced building tile fetch + radius/cluster filter
│   ├── helios-shadows.ts           Ground-projected shadow polygons (fade-step gradient)
│   ├── helios-lidar.ts             LidarSource interface + provider registry
│   ├── helios-lidar/               Country-specific LiDAR providers
│   │   └── helios-lidar-fr.ts      IGN HD (metropolitan France + Corsica) WMS pipeline
│   ├── helios-sun.ts               Solar position + Haurwitz / Kasten-Czeplak math
│   ├── helios-weather.ts           Open-Meteo fetch + multi-model fusion + cache
│   └── i18n/
│       ├── index.ts                Resolver + Translations interface
│       └── locales/                en, fr, de, es, it, nl, pt
├── hacs.json                       HACS manifest
├── package.json
├── tsconfig.json
├── vite.config.ts
├── README.md                       User-facing docs
├── ARCHITECTURE.md                 This file
└── LICENSE                         MIT
```

Each `src/helios-*.ts` file has a clearly bounded responsibility:

* **helios-card.ts**, top-level Lit element. Owns `render()`,
  the live readings state, the timeline scrub, the PV state and
  the lifecycle hooks. Mostly composition; no heavy logic.
* **helios-card-css.ts**, single `css\`...\`` literal exported
  as `heliosCardStyles`. Imported once from the card.
* **helios-config.ts**, `<helios-card-editor>` (visual editor),
  `<helios-color-picker>` (custom palette + hex picker that
  side-steps the iOS Safari `<input type="color">` crash inside
  HA's nested Shadow DOM), plus `cfgHex` / `formatDate` helpers.
* **helios-engine.ts**, MapLibre setup, hillshade and night-
  shade layers, building extrusions, cloud-cover disc, screen-
  space projections (sun arc, sun disc, incidence ray, label
  positions). Holds the public API consumed by the card
  (`onWeatherUpdate`, `projectSunScene`, `setSelectedTime`,
  `getTimelineSeries`, etc.).
* **helios-buildings.ts**, pure module: fetches MapTiler v3
  vector tiles around the home, decodes them with
  `@mapbox/vector-tile`, splits MultiPolygons, filters features
  by haversine distance, identifies the home cluster. Returns
  two GeoJSON `FeatureCollection`s consumed by the engine.
* **helios-shadows.ts**, `projectExtrusionShadows` takes a building
  / region FeatureCollection plus the current sun position and
  returns a FeatureCollection of fade-step ground shadow polygons.
  Each input region emits N nested polygons (`shadow_step`
  property 0..N-1) the engine paints with stacked filtered layers
  for an alpha-composited gradient. Output polygons are clipped
  Sutherland-Hodgman against the building visibility disc so cast
  shadows never extend past the rendered surroundings.
* **helios-lidar.ts**, `LidarSource` interface + `LIDAR_SOURCES`
  provider registry + `findLidarSource(lat, lon)` resolver. Adding
  a country means dropping a new file under `./helios-lidar/`.
* **helios-lidar/helios-lidar-fr.ts**, IGN LiDAR HD pipeline for
  metropolitan France + Corsica. One WMS round-trip on
  `IGNF_LIDAR-HD_MNH_*` (`image/x-bil;bits=32`), per-cell
  classification against the MapTiler home / surroundings
  footprints, 8-connected flood fill into regions, one convex
  hull Polygon per region with `render_height = mean(cells)`.
  Output feeds `projectExtrusionShadows` exactly like the
  MapTiler footprint path.
* **helios-sun.ts**, `getSunPosition`, `computePvPower`,
  `computeIrradianceWm2`. Pure functions; no DOM, no map.
* **helios-weather.ts**, `fetchHomePointData` and friends:
  multi-model Open-Meteo fetch with median fusion, regional
  model selection, in-browser cache, and the 429 back-off
  schedule. No DOM, no map.

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
5-minute rolling buffer of state samples and differentiates over
a ~60 s window. This produces a real "what's being produced right
now" reading instead of a misleading lifetime total. Power sensors
(`W`/`kW`) are read directly from `hass.states`.

### Building radius + home cluster

At engine init, `helios-buildings.ts` fetches the MapTiler v3
vector tile(s) covering a bbox around the home (1–4 tiles at z=14).
Each tile's `building` source-layer is decoded; MultiPolygon
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
the engine fires `franceLidarHd.fetchShadowRegions()` with the home
position, the building visibility radius, the MapTiler home and
surroundings footprints, and a raster size driven by `lidar-precision`
(256² / 512² / 1024²).

The provider runs one WMS GetMap against
`IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G` with
`FORMAT=image/x-bil;bits=32`, decoding the raw little-endian
float32 height raster client-side. Then:

- **Classify.** Each cell with `5 ≤ h ≤ 100 m` is tagged by which
  inflated MapTiler footprint bbox contains its centre: `home` if
  inside any home polygon's bbox (padded 5 m), `building` if inside
  any surrounding polygon's bbox (padded 5 m), otherwise
  `vegetation`. Cells beyond `radiusMeters` from the home are
  dropped (circular crop).
- **Flood-fill.** 8-connected components, with the constraint that
  neighbours must share the same kind. A tree right next to a
  building stays in its own region so the shadow it casts has the
  tree's geometry, not a blended building+tree blob.
- **Consolidate.** For each region, take the convex hull of the
  cells' four corners (`halfLon`, `halfLat`) and emit one Polygon
  with `render_height = mean(component heights)`. Tens to a few
  hundred features per home, instead of thousands of raw cells.

Those polygons feed `projectExtrusionShadows` exactly like the
MapTiler footprints when no provider covers the home. The result
is then clipped to the building visibility disc (see Shadow
clipping below).

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
maptiler-api-key: YOUR_KEY_HERE     # required
```

See the full option table in [README.md](./README.md). Every field
is editable visually; numeric options are sliders so out-of-range
values can't be entered.

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
   git tag v1.4.0
   git push origin v1.4.0
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
* **MapTiler key required**, the free MapTiler tier (100 k tile
  loads / month) is more than enough for a typical Helios install,
  but every dashboard load and rotation cycle does consume tile
  quota. Open-Meteo doesn't need a key.
* **WebGL contexts on long-lived dashboards**, browsers cap
  concurrent WebGL contexts at 8–16. Helios releases its context
  cleanly on every re-init via `WEBGL_lose_context`, but if you
  stack many MapLibre-backed cards in the same dashboard you may
  hit the limit; the browser will then recycle aggressively and
  performance can degrade. Use `performance-mode: true` or
  `map-style: minimal` on such setups.
