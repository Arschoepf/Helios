import type { Translations } from '../index';

export const nl: Translations = {
    cardName:        'HELIOS',
    cardDescription: 'Realtime visualisatie van zonne-energie en bewolking',

    live: 'Live',

    placeholder:
    {
        subtitle: 'Zonexpositie & bewolking'
    },

    tooltip:
    {
        cloudCover:  "Bewolking: {0}%",
        cloudLow:    "Laag: {0}%",
        cloudMid:    "Middel: {0}%",
        cloudHigh:   "Hoog: {0}%",
        resetLive:   'Terug naar live'
    },

    editor:
    {
        required:           'API-sleutel',
        apiKey:             'MapTiler API-sleutel',
        apiKeyHelp:         'Vereist voor de 3D-kaart, het reliëf en de gebouwen. Het gratis abonnement is meer dan voldoende.',
        getKeyAt:           'Haal je gratis sleutel op',
        terrainRelief:      'Reliëf',
        terrainReliefHint:  'Reliëfschaduw onder de kaart. Handig in heuvelachtig gebied om de oriëntatie van hellingen ten opzichte van de zon te lezen.',
        hillshadeColor:     'Schaduwkleur *',
        hillshadeStrength:  'Schaduwsterkte * (0 → 1)',
        mapSection:         'Kaart',
        mapStyle:           'Kaartstijl *',
        mapStyleHint:       'Kies tussen de stratenkaart (sober, stedelijk) en de topografische kaart (hoogtelijnen, aardse tinten, beter in heuvelachtig terrein). Labels en 3D-gebouwen werken op beide hetzelfde.',
        mapStyleStreet:     'Straten',
        mapStyleTopo:       'Topo',
        showLabels:         'Labels weergeven *',
        showLabelsHint:     'Toont of verbergt straatnamen, huisnummers, points of interest en buurtnamen op de basiskaart.',
        labelsOn:           'Zichtbaar',
        labelsOff:          'Verborgen',
        timeline:           'Tijdlijn',
        timelineHint:       'Datumformaat dat op de tijdlijn en in de scrub-chip wordt weergegeven.',
        dateFormat:         'Datumformaat * (standaard: mm-dd)',
        dateFormatHelp:     'Tokens: yyyy, yy, mm, dd. Voorbeelden:',
        timeFormat:         'Tijdformaat *',
        timeFormat12:       '12 u',
        timeFormat24:       '24 u',
        colors:             'Kleuren',
        colorsHint:         'Eén kleur per grootheid, overal hergebruikt. De zonkleur kleurt de boog, de zonneschijf en het bovenste deel van de tijdlijn. De wolkenkleur kleurt de schijf op de grond en het onderste deel van de tijdlijn.',
        sunColor:           'Zonkleur *',
        cloudColor:         'Wolkenkleur *',
        pvSection:          'Zonneproductie',
        pvHint:             'Optioneel. Als ingesteld verschijnt op het huis een chip met de momentane productie (berekend over de laatste minuut) en wordt boven de tijdlijn een toegewijde grafiek toegevoegd. De lijn tussen het huis en de chip animeert met een snelheid evenredig aan de productie. Accepteert zowel een vermogenssensor (W/kW) als een cumulatieve energiesensor (Wh/kWh).',
        pvEntity:           'Productie-entiteit',
        pvEntityHelp:       'Kies een sensor voor zonnevermogen of -energie (W, kW, Wh, kWh).',
        pvColor:            'Productiekleur *',
        batterySection:     'Thuisbatterij',
        batteryHint:        'Optioneel. Wanneer ten minste één entiteit is ingesteld, verschijnt er een chip onder het huis met de live laadtoestand en het ondertekende momentane vermogen. De leider-lijn animeert naar beneden tijdens het laden en naar boven tijdens het ontladen, met een snelheid evenredig aan het vermogen. Er wordt geen historie opgehaald — de chip toont alleen de live waarde.',
        batterySocEntity:   'Laadtoestand-entiteit',
        batterySocEntityHelp: 'Kies een batterijlaadtoestand-sensor (% — meestal met device_class "battery").',
        batteryPowerEntity: 'Vermogen-entiteit',
        batteryPowerEntityHelp: 'Kies een batterijvermogen-sensor (W of kW). De tekenconventie volgt de entiteit zelf; positief = opladen.',
        batteryColor:       'Batterijkleur *'
    }
};
