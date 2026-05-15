# ☀️ HELIOS

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)
[![HA-CustomCard](https://img.shields.io/badge/Home%20Assistant-Custom%20Card-blue)](https://github.com/custom-cards/boilerplate-card)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-Donate-orange?style=flat-square&logo=buy-me-a-coffee)](https://www.buymeacoffee.com/reikanysora)

**HELIOS** is a custom [Home Assistant](https://www.home-assistant.io/) Lovelace card that visualises solar conditions at your home in real time.

It pulls weather forecasts from **Open-Meteo** (no key needed), reads the optional production sensor of your photovoltaic install from your HA states, and stitches them together onto an interactive 3D map powered by **MapLibre GL** and **MapTiler**. The whole map, sun arc, sun disc, incidence ray, cloud cover, building extrusions and cast shadows, terrain hillshade, irradiance graph, PV graph, reflects the timeline cursor; scrub it 2 days into the past or 2 days into the future and watch every layer follow.

---

## At a glance

* **Sun arc**, the sun's full daily trajectory, projected with depth onto your home. Below-horizon segments render as discreet dots behind the home so the underground portion of the arc reads as a calm background, while the daylight portion + sun disc + irradiance readout always stack on top of every chip.
* **Live sun disc with irradiance-driven halo**, pinned on the arc; the inner fill scales with live W/m², a soft sun-coloured halo fades cleanly from 100 % at the centre to 0 % at the rim, with peak alpha driven by the same irradiance reading.
* **Incidence ray**, dashed line from sun to PV chip, animated to flow at a speed proportional to live irradiance. The stronger the sun, the faster it pulses.
* **Cloud cover disc**, translucent disc on the ground, scaled by live cloud-cover %, outlined in the configured cloud colour. A fixed black ring marks the 100 % reference. Hover for the low/mid/high breakdown.
* **PV production chip** *(optional)*, pin above the home, shows the **instantaneous** production in W/kW. Cumulative-energy sensors (kWh) are differentiated automatically over a rolling 60 s window.
* **PV → home animated leader**, a vertical dashed line in the configured PV colour from the production chip down to a small anchor bead on the home; dashes flow toward the home at a speed proportional to current production over your theoretical peak (learned from the auto-calibration buffer, or 5 kW fallback while it warms up). Static and arrow-less when production is zero.
* **Auto-calibrating PV prediction** *(optional)*, when a PV entity is configured, the card learns the user's installation by ratio-matching its Haurwitz / Kasten-Czeplak prediction against the live sensor. Daily peak-production columns highlight each day's maximum on the PV chart. The calibration buffer is persisted server-side via Home Assistant's `frontend/user_data` and survives cache wipes, device switches and dashboard restarts.
* **Home battery overlay** *(optional)*, two independent chips flank the PV chip on the same horizontal axis: State of Charge on the left, signed instantaneous power on the right. Each chip is connected to PV by a short static dotted L-leader. Either entity is independently optional; the corresponding chip only renders when its entity is set.
* **Sun-coloured home halo**, a soft glow underneath the home outline so the focal building reads at a glance even on a busy basemap. Halo colour tracks the configured sun colour.
* **Auto-rotation**, when the user is idle, the camera slowly orbits the home in the opposite direction to the sun's apparent motion (~1°/s). Any pinch / drag pauses it instantly and it resumes after a few seconds of stillness.
* **Timeline**, 5 days wide (2 past + today + 2 forecast). Dual-area chart with irradiance on top and cloud cover below. A second graph appears above when a PV entity is configured. Click or drag anywhere on the timeline to scrub; the whole map snaps to the selected instant.
* **Multilingual**, English, French, German, Spanish, Italian, Dutch, Portuguese. Adapts to your Home Assistant language.

---

## Screenshots

![HELIOS PREVIEW 02](https://raw.githubusercontent.com/ReikanYsora/Helios/main/images/preview_02.png)
![HELIOS PREVIEW 02](https://raw.githubusercontent.com/ReikanYsora/Helios/main/images/preview_03.png)

*HELIOS displaying current solar exposure, cloud coverage and live PV production for the user's home.*

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
   maptiler-api-key: YOUR_KEY_HERE
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

A free MapTiler API key is required: <https://www.maptiler.com/cloud/>. The free tier is more than enough for this card, Open-Meteo doesn't need a key at all.

The visual editor exposes every option. Minimal config:

```yaml
type: custom:helios-card
maptiler-api-key: YOUR_KEY_HERE
```

Every option below is editable visually:

| Key | Type | Default | Description |
|---|---|---|---|
| `maptiler-api-key` | string | - | Required. |
| `map-style` | `'streets' \| 'topo' \| 'minimal'` | `'streets'` | Basemap style. `streets` is a sober vector basemap suited to dense urban areas; `topo` is a topographic basemap with contour lines, better in hilly / outdoor settings; `minimal` loads streets and prunes every non-essential layer (POI symbols, place names, country labels, road shields) for a stripped basemap that's cheaper to render. The dark variant of streets / topo is used automatically when `card-theme` is `'dark'`. |
| `card-theme` | `'light' \| 'dark'` | `'light'` | Card chrome skin, chips, charts, buttons, tooltips, the scrub overlay AND the 3D map basemap (via the MapTiler `*-dark` variants) flip between a light surface (white plate) and a dark surface (near-black `#191a1b` plate), so the card sits cleanly inside light or dark Home Assistant dashboards. |
| `performance-mode` | boolean | `false` | Drops the per-frame heavyweights for low-end devices: 3D terrain mesh disabled (flat ground, pitch preserved), hillshade hidden, canvas pixel ratio forced to 1.0. The 3D buildings keep their extrusion, so the card still reads as 3D. Recovers 3–5× FPS on Safari fullscreen / mid-range mobile. |
| `terrain-detail` | `'smooth' \| 'fine'` | `'smooth'` | DEM sampling step. `smooth` keeps the terrain mesh low-poly (cheap to render, invisible at typical zoom); `fine` raises the DEM `maxzoom` for users in dramatic relief who want the mesh to follow detailed topography. |
| `auto-rotate-enabled` | boolean | `true` | When `true`, the camera orbits the home slowly during idle. Any pinch / drag / wheel pauses it for 5 s and it resumes from the user's bearing. Disable on low-power devices or if the constant motion is distracting. |
| `topography-color` | hex | `#5064a0` | Hillshade tint. |
| `topography-alpha` | 0–1 | `0.65` | Hillshade strength. On `topo`, the basemap already carries some baked-in shading, lower this if the cumulative effect feels too heavy. |
| `show-labels` | boolean | `true` | Show MapTiler street names, building numbers, POIs and place names on the basemap. |
| `building-radius` | meters | `100` | Distance around the home within which surrounding buildings are rendered in 3D. Buildings outside the radius are not drawn, the perf win in dense urban areas. Range: 20–1000 m. |
| `building-cluster-radius` | meters | `0` | Distance around the home within which every building joins the home group at full opacity. Use this to attach verandas, garages and sheds to the main house. Range: 0–100 m. |
| `building-opacity` | 0–1 | `0.25` | Opacity of the surrounding buildings. The home (and its cluster) always stays at full opacity so it reads as the focal point. |
| `building-color` | hex | `#d2d2d7` | Base colour for every rendered building, modulated by sun altitude across the day. |
| `shadows-enabled` | boolean | `true` | Master toggle for cast ground shadows. When `false`, no shadows are projected. When `true`, the source is picked automatically: a LiDAR provider when one covers the home (buildings AND vegetation), MapTiler footprints otherwise (buildings only). All shadows are clipped to the building visibility radius for consistency with the rendered surroundings. **LiDAR coverage is currently France-only; see [LiDAR coverage](#lidar-coverage).** |
| `lidar-precision` | `'low' \| 'medium' \| 'high'` | `'medium'` | LiDAR raster size when a provider covers the home. Higher = finer shadow contours but a bigger payload. `low` 256², `medium` 512², `high` 1024² (close to IGN native sampling). No effect out of coverage. |
| `shadow-opacity` | 0–1 | `0.32` | Opacity of the cast ground shadows. |
| `sun-color` | hex | `#EF9F27` | Sun disc + arc + timeline irradiance area. |
| `cloud-color` | hex | `#5A8DC4` | On-ground disc + timeline cloud area. |
| `pv-power-entity` | entity_id | - | Optional. Power (W/kW) or cumulative energy (Wh/kWh) sensor. |
| `pv-color` | hex | `#27B36B` | PV chip border + text + leader + dedicated graph. |
| `battery-soc-entity` | entity_id | - | Optional. Battery State-of-Charge sensor (`%`, usually `device_class: battery`). Renders as a chip on the LEFT of the PV chip showing the live percentage. |
| `battery-power-entity` | entity_id | - | Optional. Battery power sensor (W/kW). Signed: positive is interpreted as charging. Renders as a chip on the RIGHT of the PV chip showing the signed reading verbatim. |
| `battery-color` | hex | `#FF5252` | Battery colour reused on both battery chips' borders + text + the static dotted leaders that connect each to the PV chip. |
| `date-format` | string | `mm-dd` | Tokens: `yyyy`, `yy`, `mm`, `dd`. |
| `time-format` | `'12h' \| '24h'` | `'24h'` | Clock display in the top-right chip. |

The PV entity picker filters to sensors that look like a power or energy reading (`device_class: power|energy` OR a unit in `W/kW/MW/Wh/kWh/MWh`). Both kinds work; the card auto-detects whether to display the entity's state directly (power sensor) or differentiate it on the fly (cumulative energy).

---

## How it works

* **Solar position**, simplified declination + equation of time, with a hour-angle normalisation so longitudes far from Greenwich (NYC, Tokyo, Sydney) stay correct. Validated against the NOAA SPA reference (mean altitude error 0.30°, mean azimuth error 0.36° across 376 sample points).
* **Clear-sky GHI**, Haurwitz (1945), `1098 · cos(z) · exp(-0.059 / cos(z))` W/m². MAE ~62 W/m² versus PVGIS / NREL benchmarks.
* **Cloud attenuation**, Kasten-Czeplak (1980) cubic, `1 - 0.75 · (cloud/100)^3.4`.
* **Multi-model weather**, every fetch queries one global model (ECMWF IFS 0.25°) plus the most accurate national/regional model for your home location (AROME-France, UKMO UK, DWD ICON-D2, ItaliaMeteo, MET Nordic, NOAA HRRR, KMA LDPS, JMA MSM, BOM ACCESS-G, or ECMWF + GFS elsewhere). Per-timestep median fusion absorbs single-model outliers.
* **Effective cloud cover**, the card replaces Open-Meteo's raw `cloud_cover` (satellite-view total) with `low + 0.6·mid + 0.2·high` (capped at 100 %), matching ground perception and shortwave attenuation.
* **PV instantaneous rate**, for cumulative-energy sensors, the card maintains a 5-minute rolling buffer of state samples and differentiates over a ~60 s window, giving a real "what's being produced right now" reading instead of a misleading lifetime total.

Full algorithm + architecture details: see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## LiDAR coverage

When `shadows-enabled` is on, HELIOS picks between two shadow sources automatically:

* **LiDAR**, only when a provider covers your home. With LiDAR, cast shadows reflect real **buildings AND vegetation** (trees, hedges, etc.) captured by aerial scans.
* **MapTiler footprints**, everywhere else. Buildings only, no vegetation.

LiDAR coverage today:

| Country | Provider | Coverage |
| :--- | :--- | :--- |
| France | **IGN LiDAR HD** | Metropolitan France + Corsica |

I'm actively working on adding more providers as national open-data APIs become available. If your country publishes a usable LiDAR HD endpoint and you'd like to see it integrated, open an issue, the provider plug-in shape is documented in [ARCHITECTURE.md](./ARCHITECTURE.md) (`helios-lidar.ts` interface + `./helios-lidar/` registry).

Out of coverage the card still renders shadows from MapTiler footprints, so the visual works worldwide, the LiDAR layer is a precision upgrade where available.

---

## Technical stack

| Component | Technology |
| :--- | :--- |
| **Frontend** | [Lit](https://lit.dev/) 3, TypeScript |
| **Mapping** | [MapLibre GL JS](https://maplibre.org/) 5 + [MapTiler](https://www.maptiler.com/) tiles |
| **Weather data** | [Open-Meteo API](https://open-meteo.com/) (free, no key) |
| **Solar math** | NOAA-validated (mean altitude error 0.30°, mean azimuth error 0.36°) |
| **Build** | Vite 5 |

---

## Development

```bash
npm install
npm run dev        # local dev server
npm run typecheck  # strict TS
npm run build      # produces dist/helios.js
```

Source layout:

| File | Purpose |
| :--- | :--- |
| `src/helios-card.ts`        | Top-level Lit card, render(), state, lifecycle |
| `src/helios-card-css.ts`    | Card styles |
| `src/helios-config.ts`      | Visual editor + color picker + config helpers |
| `src/helios-engine.ts`      | MapLibre orchestration, layers, projections |
| `src/helios-buildings.ts`   | Self-sourced building tile fetch + radius / cluster filter |
| `src/helios-shadows.ts`     | Ground-projected shadow polygons (flat-opacity raster pipeline) |
| `src/helios-lidar.ts`       | `LidarSource` interface + provider registry |
| `src/helios-lidar/`         | Country-specific LiDAR providers (today: `helios-lidar-fr.ts`) |
| `src/helios-sun.ts`         | Solar position + Haurwitz / Kasten-Czeplak math |
| `src/helios-weather.ts`     | Open-Meteo multi-model fetch + cache |
| `src/i18n/`                 | 7-locale strict-typed translations |

---

## About me

I build bridges between data and reality. To me, development is more than a profession; it is the tool I have used since childhood to try and decode the complexity of the world around us. I learn every day, fully aware that total understanding is an infinite horizon I will likely never reach, but the journey is worth it.

---

## Support my work

If you find this project useful and want to support its development, feel free to buy me a coffee (or another battery ;-))!

<a href="https://www.buymeacoffee.com/reikanysora"><img src="https://img.buymeacoffee.com/button-api/?text=Buy me a coffee or a beer ?&emoji=&slug=reikanysora&button_colour=874efe&font_colour=ffffff&font_family=Lato&outline_colour=ffffff&coffee_colour=FFDD00" /></a>

---

## License

This project is licensed under the MIT License, see the [LICENSE](LICENSE) file for details.
