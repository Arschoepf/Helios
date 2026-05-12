/*
 * Lightweight i18n for HELIOS — synchronous, zero-dep.
 *
 * Locales are inlined at build time so the user never has to host them
 * separately. The active language is picked from Home Assistant's
 * `hass.language` property, which mirrors the user's HA UI language.
 * If the requested language is missing, we fall back to English.
 */

//Contractual shape every locale must implement.
//
//We declare it explicitly (rather than deriving it via `typeof en`) so
//that the English locale can also import the type without creating a
//circular dependency. Adding a new key requires:
//  1. Adding it here in Translations.
//  2. Adding it in every locale (TS error otherwise).
export interface Translations
{
    cardName:        string;
    cardDescription: string;

    placeholder:
    {
        subtitle: string;
    };

    tooltip:
    {
        cloudCover:  string;     //"Cloud cover: {0}%"
        cloudLow:    string;     //"Low: {0}%"
        cloudMid:    string;     //"Mid: {0}%"
        cloudHigh:   string;     //"High: {0}%"
    };

    editor:
    {
        required:                 string;
        apiKey:                   string;
        apiKeyHelp:               string;
        getKeyAt:                 string;
        terrainRelief:            string;
        terrainReliefHint:        string;
        hillshadeColor:           string;
        hillshadeStrength:        string;
        mapSection:               string;
        mapStyle:                 string;
        mapStyleHint:             string;
        mapStyleStreet:           string;
        mapStyleTopo:             string;
        cardTheme:                string;
        cardThemeHint:            string;
        cardThemeLight:           string;
        cardThemeDark:            string;
        showLabels:               string;
        showLabelsHint:           string;
        labelsOn:                 string;
        labelsOff:                string;
        autoRotate:               string;
        autoRotateHint:           string;
        autoRotateOn:             string;
        autoRotateOff:            string;
        timeline:                 string;
        timelineHint:             string;
        dateFormat:               string;
        dateFormatHelp:           string;
        timeFormat:               string;
        timeFormat12:             string;
        timeFormat24:             string;
        //v1.3 — fixed-colour design system. Each phenomenon (sun, cloud)
        //has one configurable colour reused across the timeline mirror
        //chart, the on-ground cloud disc and the on-arc sun disc. The
        //old start/end ramp keys (rampHigh / rampLow / colorRamp /
        //rampHint) are gone — see MIGRATION.md.
        colors:                   string;
        colorsHint:               string;
        sunColor:                 string;
        cloudColor:               string;
        //v1.4 — optional photovoltaic production overlay.
        pvSection:                string;
        pvHint:                   string;
        pvEntity:                 string;
        pvEntityHelp:             string;
        pvColor:                  string;
        batterySection:           string;
        batteryHint:              string;
        batterySocEntity:         string;
        batterySocEntityHelp:     string;
        batteryPowerEntity:       string;
        batteryPowerEntityHelp:   string;
        batteryColor:             string;
        //v1.2.0-beta.6 — radius (m) around the home within which
        //surrounding buildings are rendered, and the opacity of
        //those surroundings (the home itself stays fully opaque).
        buildingsSection:         string;
        buildingsHint:            string;
        buildingRadius:           string;
        buildingOpacity:          string;
    };
}

import { en } from './locales/en';
import { fr } from './locales/fr';
import { de } from './locales/de';
import { es } from './locales/es';
import { it } from './locales/it';
import { nl } from './locales/nl';
import { pt } from './locales/pt';

const LOCALES: Record<string, Translations> = { en, fr, de, es, it, nl, pt };

const FALLBACK: Translations = en;

//Adding a new locale is a 3-step operation:
//  1. Create ./locales/xx.ts exporting `xx: Translations`
//  2. Import here and add the key to LOCALES
//  3. Done — pickTranslations will resolve `xx-YY` → `xx-yy` → `xx` → `en`
export function pickTranslations(haLanguage: string | undefined): Translations
{
    if (!haLanguage)
    {
        return FALLBACK;
    }

    //Match in order of specificity: full tag → language root → English
    const lower = haLanguage.toLowerCase();
    if (LOCALES[lower])
    {
        return LOCALES[lower];
    }

    const root = lower.split('-')[0];
    if (LOCALES[root])
    {
        return LOCALES[root];
    }

    return FALLBACK;
}