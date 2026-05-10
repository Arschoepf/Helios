# ☀️ HELIOS

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)
[![HA-CustomCard](https://img.shields.io/badge/Home%20Assistant-Custom%20Card-blue)](https://github.com/custom-cards/boilerplate-card)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-Donate-orange?style=flat-square&logo=buy-me-a-coffee)](https://www.buymeacoffee.com/reikanysora)

**HELIOS** is a custom [Home Assistant](https://www.home-assistant.io/) Lovelace card that visualises solar conditions at your home in real time.

It pulls weather forecasts from **Open-Meteo** (no key needed), reads the optional production sensor of your photovoltaic install from your HA states, and stitches them together onto an interactive 3D map powered by **MapLibre GL** and **MapTiler**. The whole map — sun arc, sun disc, incidence ray, cloud cover, building extrusions, terrain hillshade, irradiance graph, PV graph — reflects the timeline cursor; scrub it 2 days into the past or 2 days into the future and watch every layer follow.

---

## At a glance

* **Sun arc** — the sun's full daily trajectory, projected with depth onto your home. Below-horizon segments render as discreet dots so the underground portion of the arc is still readable.
* **Live sun disc** — pinned on the arc, fills with the configured sun colour proportional to the live W/m².
* **Incidence ray** — dashed line from sun to home, animated to flow at a speed proportional to live irradiance. The stronger the sun, the faster it pulses.
* **Cloud cover disc** — translucent disc on the ground, scaled by live cloud-cover %, outlined in the configured cloud colour. A fixed black ring marks the 100 % reference. Hover for the low/mid/high breakdown.
* **PV production chip** *(optional)* — pin on the home, shows the **instantaneous** production in W/kW. Cumulative-energy sensors (kWh) are differentiated automatically over a rolling 60 s window. The line between the home and the chip flows at a speed proportional to live production.
* **Home battery overlay** *(optional)* — two independent chips flank the PV chip on the same horizontal axis: State of Charge on the left, signed instantaneous power on the right. Each chip is connected to PV by a short static dotted hairline. Either entity is independently optional; the corresponding chip only renders when its entity is set.
* **Auto-rotation** — when the user is idle, the camera slowly orbits the home in the opposite direction to the sun's apparent motion (~1°/s). Any pinch / drag pauses it instantly and it resumes after a few seconds of stillness.
* **Timeline** — 5 days wide (2 past + today + 2 forecast). Dual-area chart with irradiance on top and cloud cover below. A second graph appears above when a PV entity is configured. Click or drag anywhere on the timeline to scrub; the whole map snaps to the selected instant.
* **Multilingual** — English, French, German, Spanish, Italian, Dutch, Portuguese. Adapts to your Home Assistant language.

---

## Screenshots

![HELIOS PREVIEW 01](https://raw.githubusercontent.com/ReikanYsora/Helios/main/images/preview_01.png)
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

A free MapTiler API key is required: <https://www.maptiler.com/cloud/>. The free tier is more than enough for this card — Open-Meteo doesn't need a key at all.

The visual editor exposes every option. Minimal config:

```yaml
type: custom:helios-card
maptiler-api-key: YOUR_KEY_HERE
```

Every option below is editable visually:

| Key | Type | Default | Description |
|---|---|---|---|
| `maptiler-api-key` | string | — | Required. |
| `map-style` | `'streets' \| 'topo' \| 'hybrid'` | `'streets'` | Basemap style. `streets` is a sober vector basemap suited to dense urban areas; `topo` is a topographic basemap with contour lines, better in hilly / outdoor settings; `hybrid` is high-resolution satellite imagery with road and label overlays for real-world context (vegetation, rooftops, parking lots) under the solar overlay. Labels and 3D buildings work identically on all three. |
| `card-theme` | `'light' \| 'dark'` | `'light'` | Card chrome skin — chips, charts, buttons, tooltips and the scrub overlay flip between a light surface (default, on a white plate) and a dark surface (on a near-black plate), so the card sits cleanly inside light or dark Home Assistant dashboards. The 3D map basemap and the configured colour palette (sun, cloud, PV, battery) are unaffected. |
| `topography-color` | hex | `#5064a0` | Hillshade tint. |
| `topography-alpha` | 0–1 | `0.65` | Hillshade strength. On `topo`, the basemap already carries some baked-in shading — lower this if the cumulative effect feels too heavy. |
| `show-labels` | boolean | `true` | Show MapTiler street names, building numbers, POIs and place names on the basemap. |
| `sun-color` | hex | `#EF9F27` | Sun disc + arc + timeline irradiance area. |
| `cloud-color` | hex | `#5A8DC4` | On-ground disc + timeline cloud area. |
| `pv-power-entity` | entity_id | — | Optional. Power (W/kW) or cumulative energy (Wh/kWh) sensor. |
| `pv-color` | hex | `#27B36B` | PV chip border + text + leader + dedicated graph. |
| `battery-soc-entity` | entity_id | — | Optional. Battery State-of-Charge sensor (`%` — usually `device_class: battery`). Renders as a chip on the LEFT of the PV chip showing the live percentage. |
| `battery-power-entity` | entity_id | — | Optional. Battery power sensor (W/kW). Signed: positive is interpreted as charging. Renders as a chip on the RIGHT of the PV chip showing the signed reading verbatim. |
| `battery-color` | hex | `#D32F2F` | Battery colour reused on both battery chips' borders + text + the static dotted leaders that connect each to the PV chip. |
| `date-format` | string | `mm-dd` | Tokens: `yyyy`, `yy`, `mm`, `dd`. |
| `time-format` | `'12h' \| '24h'` | `'24h'` | Clock display in the top-right chip. |

The PV entity picker filters to sensors that look like a power or energy reading (`device_class: power|energy` OR a unit in `W/kW/MW/Wh/kWh/MWh`). Both kinds work; the card auto-detects whether to display the entity's state directly (power sensor) or differentiate it on the fly (cumulative energy).

---

## How it works

* **Solar position** — simplified declination + equation of time, with a hour-angle normalisation so longitudes far from Greenwich (NYC, Tokyo, Sydney) stay correct. Validated against the NOAA SPA reference (mean altitude error 0.30°, mean azimuth error 0.36° across 376 sample points).
* **Clear-sky GHI** — Haurwitz (1945), `1098 · cos(z) · exp(-0.059 / cos(z))` W/m². MAE ~62 W/m² versus PVGIS / NREL benchmarks.
* **Cloud attenuation** — Kasten-Czeplak (1980) cubic, `1 - 0.75 · (cloud/100)^3.4`.
* **Multi-model weather** — every fetch queries one global model (ECMWF IFS 0.25°) plus the most accurate national/regional model for your home location (AROME-France, UKMO UK, DWD ICON-D2, ItaliaMeteo, MET Nordic, NOAA HRRR, KMA LDPS, JMA MSM, BOM ACCESS-G, or ECMWF + GFS elsewhere). Per-timestep median fusion absorbs single-model outliers.
* **Effective cloud cover** — the card replaces Open-Meteo's raw `cloud_cover` (satellite-view total) with `low + 0.6·mid + 0.2·high` (capped at 100 %), matching ground perception and shortwave attenuation.
* **PV instantaneous rate** — for cumulative-energy sensors, the card maintains a 5-minute rolling buffer of state samples and differentiates over a ~60 s window, giving a real "what's being produced right now" reading instead of a misleading lifetime total.

Full algorithm + architecture details: see [MIGRATION.md](./MIGRATION.md).

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
| `src/helios-card.ts`     | Top-level Lit card, render(), state, lifecycle |
| `src/helios-card-css.ts` | Card styles |
| `src/helios-config.ts`   | Visual editor + color picker + config helpers |
| `src/helios-engine.ts`   | MapLibre orchestration, layers, projections |
| `src/helios-sun.ts`      | Solar position + Haurwitz / Kasten-Czeplak math |
| `src/helios-weather.ts`  | Open-Meteo multi-model fetch + cache |
| `src/i18n/`              | 7-locale strict-typed translations |

---

## About me

I build bridges between data and reality. To me, development is more than a profession; it is the tool I have used since childhood to try and decode the complexity of the world around us. I learn every day, fully aware that total understanding is an infinite horizon I will likely never reach — but the journey is worth it.

---

## Support my work

If you find this project useful and want to support its development, feel free to buy me a coffee (or another battery ;-))!

<a href="https://www.buymeacoffee.com/reikanysora"><img src="https://img.buymeacoffee.com/button-api/?text=Buy me a coffee or a beer ?&emoji=&slug=reikanysora&button_colour=874efe&font_colour=ffffff&font_family=Lato&outline_colour=ffffff&coffee_colour=FFDD00" /></a>

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
