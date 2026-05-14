import type { Translations } from '../index';

/*
 * English, reference locale.
 *
 * The Translations type (defined in ../index.ts) is derived from this
 * object's runtime shape. Because we annotate `en` with that very
 * type, it must contain all keys but is NOT typed as a literal, so
 * other locales can supply any string for each key. Adding a new key
 * here automatically widens Translations and triggers a TypeScript
 * error in every locale that hasn't been updated.
 */
export const en: Translations = {
    cardName:        'HELIOS',
    cardDescription: 'Real-time solar energy and cloud coverage visualization',

    placeholder:
    {
        subtitle: 'Solar exposure & cloud coverage'
    },

    tooltip:
    {
        cloudCover:  "Cloud cover: {0}%",
        cloudLow:    "Low: {0}%",
        cloudMid:    "Mid: {0}%",
        cloudHigh:   "High: {0}%"
    },

    editor:
    {
        required:           'API key',
        apiKey:             'MapTiler API key',
        apiKeyHelp:         'Required to render the 3D map, hillshade and buildings. The free tier is more than enough.',
        getKeyAt:           'Get your free key at',
        terrainRelief:      'Terrain',
        terrainReliefHint:  'Hillshade overlay rendered under the map. Useful in hilly terrain to read slope orientation against the sun.',
        hillshadeColor:     'Hillshade color *',
        hillshadeStrength:  'Hillshade strength * (0 → 1)',
        mapSection:         'Map',
        mapStyle:           'Map style *',
        mapStyleHint:       'Three basemaps: Streets (sober, urban), Topo (contour lines and earth tones, better in hilly terrain), or Minimal (loads Streets then strips every non-essential label, POI icon and road shield for a faster render). 3D buildings and labels behave identically on Streets and Topo. The dark variant of the chosen style is used automatically when the card theme is set to dark.',
        mapStyleStreet:     'Streets',
        mapStyleTopo:       'Topo',
        cardTheme:          'Card theme *',
        cardThemeHint:      'Switches the card chrome (chips, charts, buttons, tooltips, scrub overlay) and the 3D map basemap between a light skin (default, on a white surface) and a dark skin (on a near-black surface) so the card sits cleanly inside light or dark Home Assistant dashboards.',
        cardThemeLight:     'Light',
        cardThemeDark:      'Dark',
        showLabels:         'Show labels *',
        showLabelsHint:     'Toggles street names, building numbers, points of interest and place names on the basemap.',
        labelsOn:           'Shown',
        labelsOff:          'Hidden',
        autoRotate:         'Camera auto-rotation *',
        autoRotateHint:     'When idle for a few seconds, the camera slowly orbits the home (about 1.5°/s, opposite to the sun\'s apparent motion). Any pinch, drag or wheel pauses it instantly and it resumes once you let go.',
        autoRotateOn:       'On',
        autoRotateOff:      'Off',
        timeline:           'Timeline',
        timelineHint:       'Format of the date labels shown on the timeline and inside the scrub chip.',
        dateFormat:         'Date format * (default: mm-dd)',
        dateFormatHelp:     'Tokens: yyyy, yy, mm, dd. Examples:',
        timeFormat:         'Time format *',
        timeFormat12:       '12 h',
        timeFormat24:       '24 h',
        colors:             'Colors',
        colorsHint:         'One colour per metric, reused everywhere it appears. The sun colour paints the arc, the sun disc and the upper area of the timeline. The cloud colour paints the on-ground disc and the lower area of the timeline.',
        sunColor:           'Sun color *',
        cloudColor:         'Cloud color *',
        pvSection:          'Solar production',
        pvHint:             'Optional. When set, a chip appears near the home with the instant production (computed over the last minute) and a dedicated graph is added above the timeline. Accepts either a power sensor (W/kW) or a cumulative energy sensor (Wh/kWh).',
        pvEntity:           'Production entity',
        pvEntityHelp:       'Pick a solar power or energy sensor (W, kW, Wh, kWh).',
        pvColor:            'Production color *',
        batterySection:     'Home battery',
        batteryHint:        'Optional. Each entity surfaces as its own chip flanking the PV chip — State of Charge on the LEFT, signed Power on the RIGHT — connected to PV with a static dotted hairline. Either entity is independently optional; the chip on its side appears as soon as the entity is set.',
        batterySocEntity:   'State of charge entity',
        batterySocEntityHelp: 'Pick a battery State of Charge sensor (% — usually with device_class "battery"). Renders as a chip on the left of the PV chip showing the live percentage.',
        batteryPowerEntity: 'Power entity',
        batteryPowerEntityHelp: 'Pick a battery power sensor (W or kW). Sign convention follows the entity itself; positive is interpreted as charging and is shown verbatim on the chip (e.g. "+3.00 kW" charging, "-1.20 kW" discharging).',
        batteryColor:       'Battery color *',
        buildingsSection:   'Surrounding buildings',
        buildingsHint:      'To keep the card smooth in dense urban areas, only buildings within the configured radius around the home are rendered in 3D. The home itself stays at full opacity; nearby buildings are rendered with the configured opacity so they provide urban context without competing with the data overlays. The cluster radius groups attached outbuildings (verandas, garages, sheds) into the "home" set.',
        buildingRadius:        'Visibility radius *',
        buildingClusterRadius: 'Home cluster radius *',
        buildingOpacity:       'Surrounding opacity *',
        buildingColor:         'Building color *',
        performanceMode:       'Performance mode *',
        performanceModeOn:     'On',
        performanceModeOff:    'Off',
        performanceModeHint:   'Disables 3D terrain, hillshade and caps pixel density. Useful on low-end devices or for long sessions. Camera pitch and 3D buildings are preserved.',
        mapStyleMinimal:       'Minimal',
        terrainDetail:         'Terrain detail *',
        terrainDetailSmooth:   'Smooth',
        terrainDetailFine:     'Fine',
        terrainDetailHint:     'Smooth (default) samples the DEM every ~20 m and stays fluid on every device. Fine samples every ~5 m for richer relief but ~16× more mesh vertices to project per rotation frame, only worth it on capable desktops.',
        mapStyleSatellite:     'Satellite',
        lidarPrecision:       'LiDAR precision *',
        lidarPrecisionOff:    'Off',
        lidarPrecisionLow:    'Low',
        lidarPrecisionMedium: 'Medium',
        lidarPrecisionHigh:   'High',
        lidarPrecisionUltra:  'Ultra',
        lidarPrecisionHint:   'Drives the LiDAR-based topography, the cast-shadow geometry AND the irradiance scanner density. Only available in France for now.',
        shadowOpacity:         'Shadow opacity *',
        shadowOpacityHint:     'Opacity of the cast ground shadows.',
        buildingShadows:       'MapTiler building shadows *',
        buildingShadowsOn:     'Shown',
        buildingShadowsOff:    'Hidden',
        buildingShadowsHint:   'When LiDAR is unavailable (precision off, or home outside France), shadows are approximated from the flat MapTiler footprints. Hide them in flat or dense urban areas where the approximation reads as noise. LiDAR-driven shadows are unaffected.',
        lidarPointCloud:       'LiDAR scanner view',
        scannerSection:        'Irradiance scanner',
        scannerSectionHint:    'On-card toggle that paints every LiDAR cell with a two-stop colour ramp based on the irradiance it receives at the selected time. Low for night / shadow, high for full sun at STC (1 kW/m²). The default thermal red → green ramp reads cleanly on both light and dark basemaps.',
        scannerLowColor:       'Low (zero irradiance) *',
        scannerHighColor:      'High (full irradiance) *',
        scannerOpacity:        'Scanner opacity *'
    }
};
