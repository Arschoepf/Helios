# ☀️ HELIOS

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)
[![HA-CustomCard](https://img.shields.io/badge/Home%20Assistant-Custom%20Card-blue)](https://github.com/custom-cards/boilerplate-card)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-Donate-orange?style=flat-square&logo=buy-me-a-coffee)](https://www.buymeacoffee.com/reikanysora)

**HELIOS** is a custom [Home Assistant](https://www.home-assistant.io/) Lovelace card that visualises solar conditions at your home in real time.

It pulls weather forecasts from **Open-Meteo** (no key needed), reads the optional production sensor of your photovoltaic install from your HA states, and stitches them together onto an interactive 3D map powered by **MapLibre GL** with vector tiles served by **[OpenFreeMap](https://openfreemap.org/)** (free, no key, no signup). The whole map, sun arc, sun disc, incidence ray, cloud cover, building extrusions and cast shadows, irradiance graph, PV graph, reflects the timeline cursor; scrub it 2 days into the past or 2 days into the future and watch every layer follow.

> **Companion site:** [**helios-lidar.org**](https://helios-lidar.org) is a free web tool that turns raw open LiDAR data from any country (LAZ / LAS point clouds OR DSM + DTM raster pairs) into the nDSM GeoTIFF Helios needs, plus the YAML snippet to paste into the card. Use it when your region is not covered by the built-in LiDAR providers below. No QGIS, no GDAL, no install. Free, no account, no ads, hosted on my own VPS.

---

## At a glance

* **Sun arc**, the sun's full daily trajectory, projected with depth onto your home. Below-horizon segments render as discreet dots behind the home so the underground portion of the arc reads as a calm background, while the daylight portion + sun disc + irradiance readout always stack on top of every chip.
* **Live sun disc with irradiance-driven halo**, pinned on the arc; the inner fill scales with live W/m², a soft sun-coloured halo fades cleanly from 100 % at the centre to 0 % at the rim, with peak alpha driven by the same irradiance reading.
* **Incidence ray**, dashed line from sun to PV chip, animated to flow at a speed proportional to live irradiance. The stronger the sun, the faster it pulses.
* **Cloud cover disc**, translucent disc on the ground, scaled by live cloud-cover %, outlined in the configured cloud colour. A fixed black ring marks the 100 % reference. Hover for the low/mid/high breakdown.
* **PV production chip** *(optional)*, pin above the home, shows the **instantaneous** production in W/kW. Cumulative-energy sensors (kWh) are differentiated automatically over a rolling 60 s window.
* **PV → home animated leader**, a vertical dashed line in the configured PV colour from the production chip down to a small anchor bead on the home; when you set the installation's peak power (kWp) in the editor, dashes flow toward the home at a speed proportional to current production over that peak. Static and arrow-less when production is zero.
* **PV production overlay + forecast** *(optional)*, when a PV entity is configured, the card surfaces the current production as a chip below the home and a dedicated graph above the timeline. If you also enter your installation's peak power (kWp) in the editor, a dotted forecast line based on the Haurwitz / Kasten-Czeplak clear-sky model + live cloud cover, with a Sandia NOCT cell-temperature derating fed from Open-Meteo's air temperature + wind speed, overlays the past observation, and the chip switches to a predicted value (prefixed `≈`) when scrubbing into the future. When a LiDAR provider covers the home (or a BYO local-nDSM is configured), the forecast additionally ray-marches from each array toward the sun against the loaded nDSM and zeroes the direct beam on shaded arrays, keeping diffuse + ground-reflected components so a shaded panel drops to ~25-30 % of clear-sky output rather than zero.
* **PV array map markers**, when entries in `pv-arrays` carry their own GPS coordinates (> 10 m from the home), a small solar-panel icon in the configured PV colour appears on the map at each panel location. Useful for ground-mounted arrays sitting elsewhere than the home, e.g. in a clearing while the house itself is under trees.
* **Home battery overlay** *(optional)*, two independent chips flank the PV chip on the same horizontal axis: State of Charge on the left, signed instantaneous power on the right. Each chip is connected to PV by a short static dotted L-leader. Either entity is independently optional; the corresponding chip only renders when its entity is set.
* **Detail dashboard**, click the home to dive into a chip-styled overlay with three sections: Today (produced kWh + a refined forecast learned from your past production + dual peak readouts + a cumulative chart with sunrise / sunset markers, a live now cursor and a smart hover tooltip), Tomorrow (full-day forecast + peak hour) and Battery when configured (vessel + charge / discharge totals). Tomorrow stretches full width when no battery entity is set. Click anywhere outside to exit.
* **Forecast calibration**, the dashboard learns from the last 5 completed days how the Open-Meteo model under- or over-predicts your installation and surfaces a refined value next to each PRÉVU figure with a hover hint explaining the calibration window. Captures static biases (cloud forecast skew, soiling, orientation, inverter losses) without needing any extra configuration; hidden silently when fewer than 2 past days carry enough production to derive a stable ratio.
* **LiDAR View overlay**, optional GPU-resident dot cloud of every loaded LiDAR cell, toggled from the top-right rail. Re-rasterised by MapLibre on every transform with no JS-side redraw, so panning and rotating through a dense forest stay smooth. Hidden entirely when no LiDAR provider covers the home.
* **Hover home glow**, hovering the home triggers a soft sun-coloured halo underneath the silhouette so the focal building reads as interactive before you click. Halo colour tracks the configured sun colour.
* **Auto-rotation** *(opt-in)*, when enabled, the camera slowly orbits the home in the opposite direction to the sun's apparent motion (~1°/s) after a few seconds of inactivity. Any pinch / drag pauses it instantly and it resumes after a fresh idle window.
* **Timeline**, 5 days wide (2 past + today + 2 forecast). Dual-area chart with irradiance on top and cloud cover below. A second graph appears above when a PV entity is configured. Click or drag anywhere on the timeline to scrub; the whole map snaps to the selected instant.
* **Multilingual**, English, French, German, Spanish, Italian, Dutch, Portuguese, Norwegian. Adapts to your Home Assistant language.

---

## Screenshots

![HELIOS PREVIEW 01](https://raw.githubusercontent.com/ReikanYsora/Helios/main/images/preview_01.png)
![HELIOS PREVIEW 02](https://raw.githubusercontent.com/ReikanYsora/Helios/main/images/preview_02.png)
![HELIOS PREVIEW 03](https://raw.githubusercontent.com/ReikanYsora/Helios/main/images/preview_03.png)

*HELIOS displaying current solar exposure, cloud coverage and live PV production for the user's home. The full card is also available as an interactive live demo at [helios-lidar.org](https://helios-lidar.org).*

---

## Support my work

If you find this project useful, don't hesitate to give it a ⭐ on GitHub, and consider supporting me with a donation if you can.

<a href="https://www.buymeacoffee.com/reikanysora"><img src="https://img.buymeacoffee.com/button-api/?text=+1 W/m² of motivation&emoji=☀️&slug=reikanysora&button_colour=5F7FFF&font_colour=ffffff&font_family=Inter&outline_colour=000000&coffee_colour=FFDD00" /></a>

---

## Installation via HACS

### Custom repository (recommended for now)

1. Open HACS → click the three-dot menu → **Custom repositories**.
2. Add this repository: `https://github.com/ReikanYsora/Helios`
3. Set category to **Dashboard**.
4. Install **HELIOS** from the dashboard list.
5. Reload your browser.
6. Add the card to your dashboard:
   ```yaml
   type: custom:helios-card
   ```

### Manual installation

1. Download `helios.js` from the latest [release](https://github.com/ReikanYsora/Helios/releases).
2. Copy it to `<config>/www/community/helios/`.
3. Add the resource to your dashboard:
   ```yaml
   url: /local/community/helios/helios.js
   type: module
   ```

---

## Configuration

No API key required. The basemap is served by [OpenFreeMap](https://openfreemap.org/) (free, no signup, no rate limits) and weather comes from Open-Meteo (also free, no key).

The visual editor exposes every option. Minimal config:

```yaml
type: custom:helios-card
```

Every option below is editable visually:

| Key | Type | Default | Description |
|---|---|---|---|
| `map-style` | `'streets' \| 'minimal'` | `'streets'` | Basemap style. `streets` resolves to OpenFreeMap's [Liberty](https://tiles.openfreemap.org/styles/liberty) (full-colour OpenMapTiles look); `minimal` resolves to [Positron](https://tiles.openfreemap.org/styles/positron) (muted grey, very sober). Both flip to OpenFreeMap's [Dark](https://tiles.openfreemap.org/styles/dark) when `card-theme` is `'dark'`. |
| `card-theme` | `'light' \| 'dark'` | `'light'` | Card chrome skin (chips, charts, buttons, tooltips, scrub overlay) AND the 3D map basemap flip between a light surface (white plate) and a dark surface (near-black `#191a1b` plate), so the card sits cleanly inside light or dark Home Assistant dashboards. |
| `pixel-ratio` | `'auto' \| '1x'` | `'auto'` | WebGL canvas pixel density. `auto` uses the device's native devicePixelRatio (capped at 2 on desktop, 1.25 on mobile). `1x` forces 1.0, the cheapest per-frame fragment workload, useful on low-end devices or for long sessions where battery / heat matters more than crispness. |
| `auto-rotate-enabled` | boolean | `false` | When `true`, the camera orbits the home slowly during idle. Any pinch / drag / wheel pauses it for 5 s and it resumes from the user's bearing. Off by default; enable for kiosk / always-on dashboards. |
| `show-labels` | boolean | `true` | Show street names, building numbers, POIs and place names on the basemap. |
| `building-radius` | meters | `100` | Distance around the home within which surrounding buildings are rendered in 3D. Buildings outside the radius are not drawn, the perf win in dense urban areas. Range: 20–1000 m. |
| `building-cluster-radius` | meters | `0` | Distance around the home within which every building joins the home group at full opacity. Use this to attach verandas, garages and sheds to the main house. Range: 0–100 m. |
| `building-opacity` | 0–1 | `0.25` | Opacity of the surrounding buildings. The home (and its cluster) always stays at full opacity so it reads as the focal point. |
| `building-color` | hex | `#d2d2d7` | Base colour for every rendered building, modulated by sun altitude across the day. |
| `shadows-enabled` | boolean | `true` | Master toggle for cast ground shadows. When `false`, no shadows are projected. When `true`, the source is picked automatically: a LiDAR provider when one covers the home (buildings AND vegetation), OpenFreeMap building footprints otherwise (buildings only). All shadows are clipped to the building visibility radius for consistency with the rendered surroundings. See [LiDAR coverage](#lidar-coverage). |
| `lidar-precision` | `'low' \| 'medium' \| 'high'` | `'medium'` | LiDAR raster size when a provider covers the home. Higher = finer shadow contours but a bigger payload. `low` 256², `medium` 512², `high` 1024² (close to IGN native sampling). No effect out of coverage. |
| `shadow-opacity` | 0–1 | `0.32` | Opacity of the cast ground shadows. |
| `lidar-local-ndsm-enabled` | boolean | `false` | Optional. Master opt-in for the BYO local nDSM provider. When `true` AND every key below validates, Helios uses your own GeoTIFF as the shadow source inside the configured bbox, taking precedence over any national provider that would otherwise match. See [LiDAR coverage](#lidar-coverage). |
| `lidar-local-ndsm-url` | string | - | Browser-reachable URL of your nDSM GeoTIFF / COG. Same-origin `/local/community/Helios/lidar/…tif` is the recommended host path. The raster must be an nDSM (height-above-ground, in metres) prepared offline, not a raw DSM/DTM. |
| `lidar-local-ndsm-min-lat` | number | - | Southern edge of the raster's geographic extent, EPSG:4326 degrees. Required when the provider is enabled. |
| `lidar-local-ndsm-max-lat` | number | - | Northern edge, EPSG:4326 degrees. Required when the provider is enabled. |
| `lidar-local-ndsm-min-lon` | number | - | Western edge, EPSG:4326 degrees. Required when the provider is enabled. |
| `lidar-local-ndsm-max-lon` | number | - | Eastern edge, EPSG:4326 degrees. Required when the provider is enabled. |
| `sun-color` | hex | `#EF9F27` | Sun disc + arc + timeline irradiance area. |
| `cloud-color` | hex | `#5A8DC4` | On-ground disc + timeline cloud area. |
| `pv-power-entity` | entity_id | - | Optional. Power (W/kW) or cumulative energy (Wh/kWh) sensor. |
| `pv-peak-kwp` | number | - | Optional. Installed peak power in kilowatts-peak. When set, drives the dotted clear-sky forecast line on the PV chart and paces the PV → home animated leader against your installation. Leave empty to hide the forecast (live observation + today's peak still display). |
| `pv-arrays` | list | - | Optional. One entry per group of co-oriented panels. Each entry takes `tilt` (0–90°, 0 = horizontal, 90 = vertical), `azimuth` (0–360° clockwise from north: 0 = N, 90 = E, 180 = S, 270 = W), `share` (this group's % of the total kWp), and the two optional GPS fields below. The forecast model evaluates each entry separately and weights the result by its share, so split-array installs - one row east + one row west, roof + balcony, three-pitch roofs, etc. - get a correct production curve instead of the single-orientation approximation. Shares are auto-normalised to sum to 100 % at compute time. See the example below the table. |
| `pv-arrays[].latitude` | number | home lat | Optional. Decimal-degree latitude of this row of panels, used when they sit a meaningful distance away from the home (ground-mounted in a clearing, detached garage, etc.). The forecast model runs at the panel's true location instead of the home coords and a small solar-panel marker in the PV colour appears on the map. Both `latitude` and `longitude` must be set for the override to apply, otherwise the row falls back to the home coords. |
| `pv-arrays[].longitude` | number | home lon | Optional. Decimal-degree longitude, see `latitude` above. |
| `pv-arrays[].height` | metres | `5` | Optional. Height above ground in metres for this row of panels. Used as the starting altitude when the forecast ray-marches against the LiDAR nDSM to decide whether the array is in shadow at a given sun position. The default 5 m matches the eaves of a single-storey French house; raise it for a roof on top of an upper floor (8-10 m) and lower it for a ground-mounted array (0-1 m) so the shading check respects the local geometry. Has no effect when no LiDAR provider is active. |
| `pv-tilt` | degrees | `0` | *Legacy.* Tilt angle of your panels from horizontal: 0 for a flat install, 90 for fully vertical (e.g. balcony). When greater than 0, the forecast model switches from a horizontal-panel assumption to a Liu-Jordan transposition so steep-roof and balcony installs stop seeing a flat-roof prediction (typically a 3–4× overshoot). Superseded by `pv-arrays`; ignored when `pv-arrays` is set. |
| `pv-azimuth` | degrees | `180` | *Legacy.* Compass bearing your panels face, clockwise from north. Only used when `pv-tilt > 0` and `pv-arrays` is unset. |
| `pv-color` | hex | `#27B36B` | PV chip border + text + leader + dedicated graph. |
| `battery-soc-entity` | entity_id | - | Optional. Battery State-of-Charge sensor (`%`, usually `device_class: battery`). Renders as a chip on the LEFT of the PV chip showing the live percentage. |
| `battery-power-entity` | entity_id | - | Optional. Battery power sensor (W/kW). Signed: positive is interpreted as charging. Renders as a chip on the RIGHT of the PV chip showing the signed reading verbatim. |
| `battery-color` | hex | `#FF5252` | Battery colour reused on both battery chips' borders + text + the static dotted leaders that connect each to the PV chip. |
| `date-format` | string | `mm-dd` | Tokens: `yyyy`, `yy`, `mm`, `dd`. |
| `time-format` | `'12h' \| '24h'` | `'24h'` | Clock display in the top-right chip. |
| `home-latitude` | number | Home Assistant's home latitude | Optional override for the home latitude in decimal degrees. When BOTH `home-latitude` and `home-longitude` are set to valid coordinates, they take precedence over `hass.config.latitude` / `longitude` and the map recentres on the override. Useful when Home Assistant's configured home address isn't where you want the card centered (shared HA install, holiday home, mobile setup, privacy-conscious users who leave `hass.config` blank, or multiple cards on one dashboard each visualising a different place). Leave empty (default) to use HA's configured home. |
| `home-longitude` | number | Home Assistant's home longitude | Optional override for the home longitude in decimal degrees. Only applied together with `home-latitude`; partial or out-of-range values are silently rejected and the card falls back to HA's configured home. |

The PV entity picker filters to sensors that look like a power or energy reading (`device_class: power|energy` OR a unit in `W/kW/MW/Wh/kWh/MWh`). Both kinds work; the card auto-detects whether to display the entity's state directly (power sensor) or differentiate it on the fly (cumulative energy).

### Multi-array PV layouts

Use `pv-arrays` when your panels aren't all facing the same way. One YAML entry per orientation group:

```yaml
type: custom:helios-card
pv-peak-kwp: 6.5
pv-arrays:
  - { tilt: 10, azimuth: 90,  share: 50 }   # one row tilted 10°, facing east
  - { tilt: 10, azimuth: 270, share: 50 }   # one row tilted 10°, facing west
```

Other shapes work the same way: a roof + balcony combo, a three-pitch roof, or any asymmetric retrofit:

```yaml
pv-arrays:
  - { tilt: 35, azimuth: 180, share: 70 }   # main south-facing roof
  - { tilt: 90, azimuth: 90,  share: 30 }   # vertical balcony panels facing east
```

The visual editor exposes a repeatable "Array" section with `+ Add array` / `Remove`, so you can configure this without dropping to YAML. Shares are auto-normalised, so typing 50/50, 60/60 or 1/1 all produce the same forecast. Existing configs using only `pv-tilt` / `pv-azimuth` keep working unchanged.

---

## How it works

* **Solar position**, simplified declination + equation of time, with a hour-angle normalisation so longitudes far from Greenwich (NYC, Tokyo, Sydney) stay correct. Validated against the NOAA SPA reference (mean altitude error 0.30°, mean azimuth error 0.36° across 376 sample points).
* **Clear-sky GHI**, Haurwitz (1945), `1098 · cos(z) · exp(-0.059 / cos(z))` W/m². MAE ~62 W/m² versus PVGIS / NREL benchmarks.
* **Cloud attenuation**, Kasten-Czeplak (1980) cubic, `1 - 0.75 · (cloud/100)^3.4`.
* **Multi-model weather**, every fetch queries one global model (ECMWF IFS 0.25°) plus the most accurate national/regional model for your home location (AROME-France, UKMO UK, DWD ICON-D2, ItaliaMeteo, MET Nordic, NOAA HRRR, KMA LDPS, JMA MSM, BOM ACCESS-G, or ECMWF + GFS elsewhere). Per-timestep median fusion absorbs single-model outliers.
* **Effective cloud cover**, the card replaces Open-Meteo's raw `cloud_cover` (satellite-view total) with `low + 0.6·mid + 0.2·high` (capped at 100 %), matching ground perception and shortwave attenuation.
* **PV instantaneous rate**, for cumulative-energy sensors, the card maintains a 5-minute rolling buffer of state samples and differentiates over a ~60 s window, giving a real "what's being produced right now" reading instead of a misleading lifetime total.
* **PV forecast (optional)**, when `pv-peak-kwp` is set, the card multiplies the live `effective_cover` by Haurwitz / Kasten-Czeplak per timestamp and scales by the installed peak power, painting a dotted prediction curve on the PV chart that the live observation tracks against. Scrubbing into the future flips the PV chip to the predicted figure (italicised, prefixed `≈`).
* **PV thermal derating**, the same forecast pulls `temperature_2m` + `wind_speed_10m` from Open-Meteo and runs a Sandia NOCT cell-temperature model (`T_cell = T_air + (NOCT - 20) / 800 · GHI - 1.5 · wind`), then derates the predicted output with a `γ_pmp = -0.0040 /°C` temperature coefficient. On a hot summer noon at 35 °C / ~900 W/m² the predicted peak drops by ~13 %, which was previously being absorbed by the rolling calibration ratio as a flat multiplier. Falls back to a multiplier of 1 when the model didn't return temperature or wind at that hour.
* **LiDAR-aware shading on the PV forecast**, when a LiDAR provider covers the home (or a BYO local nDSM is configured), the forecast additionally ray-marches from each `pv-arrays` entry along the sun direction against the loaded nDSM (2 m step, 200 m reach, bilinear sample) and zeroes the direct-beam component on arrays whose line-of-sight to the sun is blocked. Diffuse + ground-reflected components are kept, so a shaded panel doesn't drop to zero but to ~25-30 % of clear-sky output. For installs with `pv-arrays` declared at distinct coordinates, each entry is shaded independently, so a roof-east array shaded by a tall neighbour at 8 am doesn't affect the roof-west array on the same property. From v1.6.3 onwards, when the loaded raster ships a DTM band (every COG produced by [helios-lidar.org](https://helios-lidar.org)) the ray-march also accounts for terrain slope between the panel and the obstacle: a building 50 m east on terrain that rises 8 m reads as a 13 m obstacle, the same building on terrain that drops 8 m reads as -3 m and is correctly ignored. Single-band rasters (legacy locals, every public provider) keep the previous flat-ground behaviour.

* **Forecast calibration (optional)**, the dashboard refines its predicted kWh by learning from the last 5 completed days' (actual / predicted) ratio. The ratio captures the residual biases the analytical model can't see (cloud-forecast skew, soiling, panel ageing) on top of the thermal + shading corrections already applied upstream, and is clamped to [0.5, 1.5] so a one-off sensor outage can't poison the average. Hidden silently when fewer than 2 past days carry enough production to derive a stable ratio.

Full algorithm + architecture details: see [ARCHITECTURE.md](./ARCHITECTURE.md). Per-release notes: see [CHANGELOG.md](./CHANGELOG.md).

---

## LiDAR coverage

When `shadows-enabled` is on, HELIOS picks between two shadow sources automatically:

* **LiDAR**, only when a provider covers your home. With LiDAR, cast shadows reflect real **buildings AND vegetation** (trees, hedges, etc.) captured by aerial scans.
* **OpenFreeMap building footprints**, everywhere else. Buildings only, no vegetation.

LiDAR coverage today:

| Country | Provider | Coverage | Format | Note |
| :--- | :--- | :--- | :--- | :--- |
| France | **IGN LiDAR HD** | Metropolitan France + Corsica | BIL float32 | Pre-computed nDSM, single fetch |
| England | **Environment Agency LiDAR Composite** | ~99% of England | GeoTIFF float32 | Two fetches (DSM + DTM), subtracted client-side |
| Spain | **IGN España PNOA-LiDAR (MDSn)** | Peninsular Spain + Balearics | GeoTIFF float32 | Two coverages (vegetation + buildings), merged via MAX. Canarias not covered |
| Netherlands | **PDOK AHN4** | Mainland NL | GeoTIFF float32 | Two coverages (DSM + DTM), subtracted client-side. Caribbean Netherlands not covered |
| Norway | **Kartverket NHM** | Mainland Norway + Svalbard | GeoTIFF float32 (ArcGIS) | Two services (DOM + DTM), subtracted client-side |
| Germany (NRW) | **Geobasis NRW nDOM** | Nordrhein-Westfalen (~18M people) | GeoTIFF float32 (WCS) | Pre-computed nDOM, single fetch |
| Poland | **GUGiK NMPT** | All of Poland (~38M people) | GeoTIFF float32 (WCS 2.0.1) | Pre-computed national DSM, single fetch, EPSG:4326 natively supported |
| Canada | **NRCan HRDEM Mosaic** | National (1-2 m LiDAR in the south, satellite-derived in the far north) | GeoTIFF float32 (WCS 1.1.1) | Pre-computed DSM coverage, single fetch |
| Austria (Styria) | **Land Steiermark ALS** | Styria (Steiermark, ~1.2M people) | GeoTIFF float32 (WCS 2.0.1) | Two fetches (DOM + DGM), subtracted client-side |
| Austria (Tirol) | **Land Tirol ALS** | Tirol (~760K people) | GeoTIFF float32 (WCS 2.0.1) | Two fetches (DOM + DGM) at 5 m, subtracted client-side |
| Germany (Baden-Württemberg) | **LGL INSPIRE DOM5 + DGM1** | Baden-Württemberg (~11.3M people) | GeoTIFF float32 (WCS 2.0.1) | Two INSPIRE coverages (DOM 5 m + DGM 1 m), subtracted client-side |
| Germany (Brandenburg + Berlin) | **LGB bDOM + DGM** | Brandenburg + Berlin (~6.1M people) | GeoTIFF float32 (WCS 2.0.1) | Two fetches (image-based DOM + DGM), subtracted client-side |
| United States (Vermont) | **VCGI nDSM** | Vermont (~645K people) | Float32 GeoTIFF (ArcGIS exportImage) | Pre-normalised nDSM, single fetch, no DSM-DTM round-trip |

An interactive world map of every region the card covers natively
lives at [helios-lidar.org/coverage](https://helios-lidar.org/coverage),
click any point to drop a demo Helios card on it and see the result
instantly. Rectangles are colour-coded by the release that introduced
each provider.

Other national LiDAR programmes were probed and not yet integrated:

* **Wales (Natural Resources Wales)** , per-tile ZIP downloads only, no live raster query endpoint.
* **Switzerland (swisstopo)** , published WMS only carries pre-rendered PNG hillshade, not raw heights. Raw `swissALTI3D` rasters are downloadable as files only.
* **Slovakia (ZBGIS)** , DMR (terrain) is available as GeoTIFF, but DMP (surface) is only published as cached PNG visualisations.
* **Denmark (Datafordeler DHM)** , WCS GeoTIFF exists but requires a per-user API key / OAuth signup, integration parked until that friction is reduced.
* **Belgium (Wallonia + Flanders)** , both regions publish 1m DSM/DTM rasters under permissive licences (CC-BY 4.0 for Wallonia's MNS/MNT 2021-2022, Flemish DHMV II for Flanders + Brussels). Wallonia's WMS however serves pre-rendered RGB tiles for `image/tiff`, not the raw float values we need. Flanders has a clean Float32 WCS but the only exposed CRS is EPSG:31370 (Belgian Lambert 72) which would require bundling a reprojection library (proj4js) to convert our WGS84 bbox math. Parked until both can be unblocked together.
* **Other German Länder** , Bayern, Berlin, Hamburg, Sachsen and a handful of others publish nDOM rasters with similar quality to NRW, integration tracked per-Land as time allows.
* **United States** , federal USGS 3DEP exposes a live ArcGIS Image Server (`elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer`) for the *bare-earth* DEM only (DTM). No public DSM service at federal level, so the height-above-ground data needed for shadows isn't reachable. State-level programmes such as Minnesota DNR (`mntopo`) publish raw LiDAR as per-tile ZIP downloads only, no live raster query API. BYO local nDSM is the practical path for US users until a public DSM service materialises.

If your country publishes a usable LiDAR HD endpoint (raw float heights via WMS or WCS, CORS-friendly, no per-user authentication) and you'd like to see it integrated, open an issue. The provider plug-in shape is documented in [ARCHITECTURE.md](./ARCHITECTURE.md) (`helios-lidar.ts` interface + `./helios-lidar/providers/` registry).

Out of coverage the card still renders shadows from OpenFreeMap building footprints, so the visual works worldwide, the LiDAR layer is a precision upgrade where available.

### Bring your own LiDAR

If your region isn't covered by any of the public providers above but you have access to raw LiDAR data (e.g. via a national open-data portal), Helios can use a small nDSM GeoTIFF you prepared yourself as its shadow source within a bounding box you define. There are two ways to prepare that file.

#### Recommended path: helios-lidar.org

The companion web tool at **[helios-lidar.org](https://helios-lidar.org)** does the GIS conversion server-side. You upload either a raw LAZ / LAS point cloud or a DSM + DTM raster pair from your country's open-data portal; the site spits back, after a couple of minutes:

* a 2-band Cloud-Optimized GeoTIFF (band 1 = nDSM = obstacle height above local ground, band 2 = DTM = ground elevation), used by the card's terrain-aware shading,
* the exact YAML snippet to paste into your card config,
* a 3D preview matching the card's own LiDAR View, so you can sanity-check the result before downloading.

> **Already running Helios with a local nDSM from before v1.6.3?** Your existing file keeps working , the card detects the missing DTM band and falls back to flat-ground geometry as it did before. If your home is on a slope (hill, valley, mountain residential), re-running your original LAZ on helios-lidar.org produces a 2-band file the card uses to ray-march obstacles through the real terrain. Users on flat terrain see no difference either way.

No QGIS, no GDAL, no PDAL, no Python install on your side. Free, no account, no ads, no tracking. The site is hosted on a small VPS I pay for myself and is the intended path for LAZ-only or DSM/DTM-only regions where the on-the-fly providers above don't yet reach. Country-specific tile-picker links (France IGN, Switzerland swissSURFACE3D, Netherlands AHN, Spain PNOA-LiDAR, UK Environment Agency, USA 3DEP + global OpenTopography aggregator) are listed directly on the upload page, with a short glossary explaining DSM / DTM / nDSM / LAS / LAZ / COG for first-time users.

#### Manual offline prep (advanced)

If you'd rather run the conversion locally, a set of Python helpers under [`tools/lidar/`](tools/lidar/README.md) walks you through the same stages (inspect a GeoTIFF, convert it to a Cloud Optimized GeoTIFF, generate a synthetic test raster). Use them if you want a guided local path; bypass them entirely if you already have a COG-formatted nDSM ready to host. The detailed guide, including the GDAL system-library install per OS, the `uv` setup, and the YAML config snippet to paste back into Helios, lives in [`tools/lidar/README.md`](tools/lidar/README.md).

#### How it plugs into the card

The card config exposes a `lidar-local-ndsm-*` family (visible in the editor's collapsed "Advanced , Local LiDAR (BYO)" section, hidden by default). When the toggle is on AND the URL + the 4 bounding-box keys all validate, this source takes precedence over any public provider that would otherwise match inside the bbox. Outside the bbox, the regular fallback chain (public providers → OpenFreeMap footprints) applies unchanged.

What "nDSM" means: a normalised Digital Surface Model = DSM (top of canopy / rooftops) − DTM (bare earth), so each pixel holds height-above-ground in metres. A bare-earth DTM or a raw DSM is *not* a valid input, the subtraction has to happen first. Host the resulting GeoTIFF anywhere your browser can fetch it: `/config/www/community/Helios/lidar/foo.tif` exposed as `/local/community/Helios/lidar/foo.tif` is the historical path; the YAML snippet that helios-lidar.org generates uses `/config/www/helios/foo.tif` exposed as `/local/helios/foo.tif` instead, both work.

The BYO local nDSM provider was contributed by [@jourdant](https://github.com/jourdant) in [PR #5](https://github.com/ReikanYsora/Helios/pull/5), the preparation tooling in [PR #11](https://github.com/ReikanYsora/Helios/pull/11), with the original idea credited to [@stephenwq](https://github.com/stephenwq). Initial use case: NSW Australia (raster prepared from the [NSW elevation portal](https://elevation.fsdf.org.au/)), where no native provider exists in Helios yet. Big thanks to all three for closing the LiDAR-coverage gap for the rest of the world.

---

## Technical stack

| Component | Technology |
| :--- | :--- |
| **Frontend** | [Lit](https://lit.dev/) 3, TypeScript |
| **Mapping** | [MapLibre GL JS](https://maplibre.org/) 5 + [OpenFreeMap](https://openfreemap.org/) vector tiles (free, no key, OpenMapTiles schema) |
| **GeoTIFF** | [geotiff.js](https://github.com/geotiffjs/geotiff.js) for parsing the Float32 LiDAR rasters from UK / ES / NL / NO providers |
| **Weather data** | [Open-Meteo API](https://open-meteo.com/) (free, no key) |
| **Solar math** | NOAA-validated (mean altitude error 0.30°, mean azimuth error 0.36°) |
| **Offline prep tooling** | Python 3.12 + `uv` for LiDAR and future dataset-prep helpers |
| **Build** | Vite 5 |

---

## Development

```bash
npm install
npm run dev        # local dev server
npm run typecheck  # strict TS
npm run build      # produces dist/helios.js
```

The card itself stays TypeScript-first. A separate Python toolchain
under [`tools/`](tools/lidar/README.md) hosts offline data-prep helpers
(currently the LiDAR nDSM workflow); it's optional and self-contained.
You only need it if you want to prepare a BYO LiDAR raster for a region
Helios doesn't ship a built-in provider for. Setup, prerequisites and
usage are documented in [`tools/lidar/README.md`](tools/lidar/README.md).
The Python side is opt-in: contributors working only on the card never
need to touch it.

Source layout:

| Path | Purpose |
| :--- | :--- |
| `src/helios-card.ts`              | Top-level Lit element: render orchestrator + HA + Lit lifecycle |
| `src/helios-engine.ts`            | Top-level engine class: MapLibre orchestration + projections |
| `src/helios-config.ts`            | `HeliosConfig` schema + `DEFAULT_*` constants (shared) |
| `src/card/pv.ts`                  | PV live state + history fetch + rate derivation + chip formatter |
| `src/card/battery.ts`             | Battery SoC + power live + history + today aggregation |
| `src/card/radiation.ts`           | Optional `solar-radiation-entity` bridge → engine override |
| `src/card/charts.ts`              | Timeline SVG charts + cursors + day labels |
| `src/card/dashboard.ts`           | Detail-mode panel (today, tomorrow, battery) |
| `src/card/calibration.ts`         | Forecast calibration: actual / predicted ratio learned from past days |
| `src/card/overlays.ts`            | Sun arc + cloud disc + home silhouette projections |
| `src/card/timeline.ts`            | 30 s clock tick + scrub pointer handlers + config readers |
| `src/card/lidar-view.ts`          | LiDAR View toggle + fade rAF loop |
| `src/card/init.ts`                | Engine bootstrap + visibility observer + home-coords resolver |
| `src/card/format.ts`              | cfgHex, formatDate, locale-aware number, hex colour helpers |
| `src/card/editor.ts`              | `<helios-card-editor>` + `<helios-color-picker>` |
| `src/engine/sun.ts`               | Solar position + Haurwitz / Kasten-Czeplak / Liu-Jordan math |
| `src/engine/weather.ts`           | Open-Meteo multi-model fetch + cache + 429 back-off |
| `src/engine/buildings.ts`         | OpenFreeMap planet tile fetch + radius / cluster filter |
| `src/engine/shadows.ts`           | Ground-projected shadow polygons + Sutherland-Hodgman clip |
| `src/engine/shadow-raster.ts`     | Offscreen canvas rasteriser feeding MapLibre's image source |
| `src/engine/lighting.ts`          | Day-night colour math (night shade, building tint, light angle) |
| `src/engine/auto-rotate.ts`       | Idle camera orbit rAF loop |
| `src/engine/detail-mode.ts`       | Detail-mode camera dive (smoothstep zoom + pitch + bearing) |
| `src/engine/lidar-view-layer.ts`  | MapLibre custom layer painting the LiDAR dot cloud |
| `src/engine/lidar.ts`             | `LidarSource` interface + provider registry + BYO validator |
| `src/engine/lidar/pipeline.ts`    | Shared flood-fill + convex-hull pipeline |
| `src/engine/lidar/geotiff.ts`     | Float32 GeoTIFF fetch + DSM-DTM math helpers |
| `src/engine/lidar/local-ndsm.ts`  | Generic BYO nDSM provider built from card config |
| `src/engine/lidar/providers/`     | One file per country / region: `fr.ts`, `uk.ts`, `es.ts`, `nl.ts`, `no.ts`, `de-nrw.ts`, `pl.ts`, `ca.ts`, `at-stmk.ts`, `de-bb-be.ts`, `de-bw.ts`, `at-tirol.ts`, `us-vt.ts` |
| `src/css/`                        | Card + editor style literals |
| `src/i18n/`                       | 8-locale strict-typed translations (en/fr/de/es/it/nl/pt/no) |
| `tools/`                          | Python helper scripts for local data preparation workflows |
| `data/`                           | Local working datasets and derived outputs used by helper tooling |

Each `card/*` and `engine/*` module exports plain functions; subsystems
talk to the card / engine through a small structural host interface
declared in the module itself. See [ARCHITECTURE.md](./ARCHITECTURE.md#code-organisation)
for the full pattern.

---

## Credits & data sources

HELIOS depends on several open data services. None require an account or API key.

* **[OpenFreeMap](https://openfreemap.org/)** — free vector basemap tiles + styles (Liberty, Positron, Dark) built from OpenStreetMap data via the OpenMapTiles schema. The buildings, labels and the basemap itself all come from here. Big thank you to the OpenFreeMap project for hosting a public, no-key, no-rate-limit instance — without it, HELIOS would still be hostage to a paid map provider.
* **[OpenStreetMap](https://www.openstreetmap.org/copyright)** — the underlying map data behind every OpenFreeMap tile. © OpenStreetMap contributors.
* **[Open-Meteo](https://open-meteo.com/)** — weather forecasts (cloud cover, irradiance, etc.). Free, no key, multi-model fusion under the hood.
* **National LiDAR providers** — IGN (France), Environment Agency (England), IGN España (Spain), PDOK (Netherlands), Kartverket (Norway). See [LiDAR coverage](#lidar-coverage) for the per-country credits.
* **[MapLibre GL JS](https://maplibre.org/)** — the WebGL map engine that draws every frame.
* **[geotiff.js](https://github.com/geotiffjs/geotiff.js)** — GeoTIFF Float32 decoder used by the UK / ES / NL / NO LiDAR providers.

---

## Contributors

External contributors who have shaped the card beyond the core author:

* **[@jourdant](https://github.com/jourdant)** (Jourdan Templeton) — generic BYO local nDSM LiDAR provider ([PR #5](https://github.com/ReikanYsora/Helios/pull/5), unlocks shadows in any region with raw LiDAR data available offline, initial use case NSW Australia), and the Python preparation toolchain under `tools/lidar/` ([PR #11](https://github.com/ReikanYsora/Helios/pull/11), inspect a GeoTIFF, convert to Cloud Optimized GeoTIFF, generate a synthetic test raster). Original idea credit: [@stephenwq](https://github.com/stephenwq).
* **[@i6media](https://github.com/i6media)** (Frank Boon) — optional `home-latitude` / `home-longitude` overrides ([PR #9](https://github.com/ReikanYsora/Helios/pull/9), useful for shared HA installs, holiday / parents' homes, mobile setups, or multiple cards on one dashboard each visualising a different place), and the multi-orientation PV layout (`pv-arrays`) ([PR #10](https://github.com/ReikanYsora/Helios/pull/10), one entry per group of co-oriented panels, each with its own tilt, azimuth, share and optional GPS).

---

## About me

I build bridges between data and reality. To me, development is more than a profession; it is the tool I have used since childhood to try and decode the complexity of the world around us. I learn every day, fully aware that total understanding is an infinite horizon I will likely never reach, but the journey is worth it.

---

## License

This project is licensed under the MIT License, see the [LICENSE](LICENSE) file for details.
