import type { Translations } from '../index';

/*
 * English — reference locale.
 *
 * The Translations type (defined in ../index.ts) is derived from this
 * object's runtime shape. Because we annotate `en` with that very
 * type, it must contain all keys but is NOT typed as a literal — so
 * other locales can supply any string for each key. Adding a new key
 * here automatically widens Translations and triggers a TypeScript
 * error in every locale that hasn't been updated.
 */
export const en: Translations = {
    cardName:        'HELIOS',
    cardDescription: 'Real-time solar energy and cloud coverage visualization',

    live: 'Live',

    placeholder:
    {
        subtitle: 'Solar exposure & cloud coverage',
        action:   'Set your MapTiler API key to activate'
    },

    tooltip:
    {
        cloudCover:  "Cloud cover: {0}%",
        cloudLow:    "Low: {0}%",
        cloudMid:    "Mid: {0}%",
        cloudHigh:   "High: {0}%",
        resetLive:   'Back to live'
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
        showLabels:         'Show labels *',
        showLabelsHint:     'Toggles street names, building numbers, points of interest and place names on the basemap.',
        labelsOn:           'Shown',
        labelsOff:          'Hidden',
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
        pvHint:             'Optional. When set, a chip appears on the home (instant production, computed over the last minute) and a dedicated graph is added above the timeline. The line between the home and the chip animates at a speed proportional to the live production. Accepts either a power sensor (W/kW) or a cumulative energy sensor (Wh/kWh).',
        pvEntity:           'Production entity',
        pvEntityHelp:       'Pick a solar power or energy sensor (W, kW, Wh, kWh).',
        pvColor:            'Production color *'
    }
};
