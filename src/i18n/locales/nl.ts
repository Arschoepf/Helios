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
        mapStyleHint:       'Kies tussen de stratenkaart (sober, stedelijk), de topografische kaart (hoogtelijnen, aardse tinten, beter in heuvelachtig terrein) of de hybride kaart (hoogwaardige satellietbeelden met overlays voor wegen en labels). Labels en 3D-gebouwen werken op alle drie hetzelfde.',
        mapStyleStreet:     'Straten',
        mapStyleTopo:       'Topo',
        mapStyleHybrid:     'Hybride',
        cardTheme:          'Kaartthema *',
        cardThemeHint:      'Schakelt de kaartelementen (chips, grafieken, knoppen, tooltips, scrub-overlay) tussen een licht thema (standaard, op een witte achtergrond) en een donker thema (op een bijna zwarte achtergrond), zodat de kaart netjes past in lichte of donkere Home Assistant-dashboards. De 3D-basemap wordt niet beïnvloed.',
        cardThemeLight:     'Licht',
        cardThemeDark:      'Donker',
        showLabels:         'Labels weergeven *',
        showLabelsHint:     'Toont of verbergt straatnamen, huisnummers, points of interest en buurtnamen op de basiskaart.',
        labelsOn:           'Zichtbaar',
        labelsOff:          'Verborgen',
        autoRotate:         'Automatische camerarotatie *',
        autoRotateHint:     'Na een paar seconden inactiviteit draait de camera langzaam rond het huis (ongeveer 1,5°/s, tegen de schijnbare beweging van de zon in). Een knijp-, sleep- of muiswielgebaar pauzeert de rotatie direct; ze hervat zodra je loslaat.',
        autoRotateOn:       'Aan',
        autoRotateOff:      'Uit',
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
        batteryHint:        'Optioneel. Elke entiteit verschijnt als een eigen chip aan weerszijden van de PV-chip — laadtoestand LINKS, ondertekend vermogen RECHTS — verbonden met PV via een statische stippellijn. Beide entiteiten zijn onafhankelijk optioneel; de bijbehorende chip verschijnt zodra de entiteit is ingesteld.',
        batterySocEntity:   'Laadtoestand-entiteit',
        batterySocEntityHelp: 'Kies een batterijlaadtoestand-sensor (% — meestal met device_class "battery"). Verschijnt als chip links van de PV-chip met het live percentage.',
        batteryPowerEntity: 'Vermogen-entiteit',
        batteryPowerEntityHelp: 'Kies een batterijvermogen-sensor (W of kW). De tekenconventie volgt de entiteit zelf; positief = opladen en wordt letterlijk op de chip weergegeven (bv. „+3.00 kW" bij laden, „−1.20 kW" bij ontladen).',
        batteryColor:       'Batterijkleur *'
    }
};
