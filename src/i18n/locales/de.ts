import type { Translations } from '../index';

export const de: Translations = {
    cardName:        'HELIOS',
    cardDescription: 'Echtzeit-Visualisierung von Solarenergie und Wolkenbedeckung',

    live: 'Live',

    placeholder:
    {
        subtitle: 'Sonneneinstrahlung & Wolkenbedeckung'
    },

    tooltip:
    {
        cloudCover:  "Bewölkung: {0}%",
        cloudLow:    "Niedrig: {0}%",
        cloudMid:    "Mittel: {0}%",
        cloudHigh:   "Hoch: {0}%",
        resetLive:   'Zurück zur Echtzeit'
    },

    editor:
    {
        required:           'API-Schlüssel',
        apiKey:             'MapTiler-API-Schlüssel',
        apiKeyHelp:         'Erforderlich für 3D-Karte, Hangschattierung und Gebäude. Der kostenlose Tarif reicht völlig aus.',
        getKeyAt:           'Hol dir deinen kostenlosen Schlüssel bei',
        terrainRelief:      'Gelände',
        terrainReliefHint:  'Hangschattierung als Overlay unter der Karte. In hügeligem Gelände hilfreich, um die Hangausrichtung gegenüber der Sonne zu lesen.',
        hillshadeColor:     'Schattierungsfarbe *',
        hillshadeStrength:  'Schattierungsstärke * (0 → 1)',
        mapSection:         'Karte',
        mapStyle:           'Kartenstil *',
        mapStyleHint:       'Wähle zwischen der Straßenkarte (nüchtern, urban) und der topografischen Karte (Höhenlinien, Erdtöne, ideal in hügeligem Gelände). Beschriftungen und 3D-Gebäude funktionieren auf beiden gleich.',
        mapStyleStreet:     'Straßen',
        mapStyleTopo:       'Topo',
        showLabels:         'Beschriftungen anzeigen *',
        showLabelsHint:     'Zeigt oder verbirgt Straßennamen, Hausnummern, POIs und Ortsnamen auf der Grundkarte.',
        labelsOn:           'Sichtbar',
        labelsOff:          'Ausgeblendet',
        timeline:           'Zeitachse',
        timelineHint:       'Format der Datumsanzeige auf der Zeitachse und im Scrub-Chip.',
        dateFormat:         'Datumsformat * (Standard: mm-dd)',
        dateFormatHelp:     'Platzhalter: yyyy, yy, mm, dd. Beispiele:',
        timeFormat:         'Zeitformat *',
        timeFormat12:       '12 h',
        timeFormat24:       '24 h',
        colors:             'Farben',
        colorsHint:         'Eine Farbe pro Messgröße, überall einheitlich verwendet. Die Sonnenfarbe füllt den Bogen, die Sonnenscheibe und den oberen Bereich der Zeitachse. Die Wolkenfarbe füllt die Bodenscheibe und den unteren Bereich der Zeitachse.',
        sunColor:           'Sonnenfarbe *',
        cloudColor:         'Wolkenfarbe *',
        pvSection:          'Solarproduktion',
        pvHint:             'Optional. Wenn gesetzt, erscheint auf dem Haus ein Chip mit der momentanen Produktion (über die letzte Minute berechnet) und über der Zeitachse wird ein dediziertes Diagramm eingeblendet. Die Linie zwischen Haus und Chip animiert mit einer Geschwindigkeit proportional zur Produktion. Akzeptiert sowohl Leistungssensoren (W/kW) als auch kumulative Energiesensoren (Wh/kWh).',
        pvEntity:           'Produktions-Entität',
        pvEntityHelp:       'Wähle einen Leistungs- oder Energiesensor für die Photovoltaik (W, kW, Wh, kWh).',
        pvColor:            'Produktionsfarbe *',
        batterySection:     'Hausbatterie',
        batteryHint:        'Optional. Wenn mindestens eine Entität gesetzt ist, erscheint ein Chip unter dem Haus mit dem aktuellen Ladezustand und der vorzeichenbehafteten momentanen Leistung. Die Leiterlinie animiert beim Laden nach unten und beim Entladen nach oben, mit einer Geschwindigkeit proportional zur aktuellen Leistung. Es wird kein Verlauf abgerufen — der Chip zeigt nur den Live-Wert.',
        batterySocEntity:   'Ladezustand-Entität',
        batterySocEntityHelp: 'Wähle einen Batterie-Ladezustand-Sensor (% — typisch mit device_class "battery").',
        batteryPowerEntity: 'Leistungs-Entität',
        batteryPowerEntityHelp: 'Wähle einen Batterie-Leistungssensor (W oder kW). Vorzeichenkonvention folgt der Entität selbst; positiv = Laden.',
        batteryColor:       'Batteriefarbe *'
    }
};
