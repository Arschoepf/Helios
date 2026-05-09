# HELIOS — v1.1.0

Polish release — no breaking changes, no config migration required.
Refines the catalogue placeholder, hardens the rotation interaction
so the home stays dead-centre, lightens the on-card chips so the
underlying scene reads through, exposes a `map-style` option to
switch the basemap between streets and topographic, adds an
optional home-battery overlay (SoC + signed power, live and
scrubbable) below the home mirroring the PV chip above, and
relocates the cloud-cover chip to the left of the disc so the
home's vertical axis stays free for the PV / battery pair.

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
