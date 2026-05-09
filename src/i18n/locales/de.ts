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
        mapStyleHint:       'Wähle zwischen der Straßenkarte (nüchtern, urban), der topografischen Karte (Höhenlinien, Erdtöne, ideal in hügeligem Gelände) oder der Hybrid-Karte (hochauflösende Satellitenbilder mit Straßen- und Beschriftungs-Overlay). Beschriftungen und 3D-Gebäude funktionieren auf allen drei gleich.',
        mapStyleStreet:     'Straßen',
        mapStyleTopo:       'Topo',
        mapStyleHybrid:     'Hybrid',
        cardTheme:          'Karten-Thema *',
        cardThemeHint:      'Wechselt das Karten-Chrome (Chips, Diagramme, Schaltflächen, Tooltips, Scrub-Overlay) zwischen einem hellen Skin (Standard, auf weißer Fläche) und einem dunklen Skin (auf nahezu schwarzer Fläche), damit sich die Karte sauber in helle oder dunkle Home-Assistant-Dashboards einfügt. Die 3D-Grundkarte selbst bleibt unverändert.',
        cardThemeLight:     'Hell',
        cardThemeDark:      'Dunkel',
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
        batteryHint:        'Optional. Die Ladezustand-Entität füllt das 3D-Hausgebäude von unten nach oben — leere Batterie zeigt das Haus als durchscheinende graue Silhouette, volle Batterie färbt es vollständig in der konfigurierten Farbe. Mit der Maus über das Haus fahren zeigt den genauen Prozentsatz. Die Leistungs-Entität fügt oben rechts vom Haus einen kleinen Chip mit dem vorzeichenbehafteten Live-Wert hinzu; die punktierte Leiterlinie fließt beim Laden vom Haus zum Chip und beim Entladen vom Chip zum Haus, mit einer Geschwindigkeit proportional zur Leistung.',
        batterySocEntity:   'Ladezustand-Entität',
        batterySocEntityHelp: 'Wähle einen Batterie-Ladezustand-Sensor (% — typisch mit device_class "battery"). Steuert die Füllhöhe des Hauses: 0 % = Haus bei voller Deckkraft unsichtbar (nur die 25 %-Silhouette bleibt sichtbar), 100 % = Haus vollständig in der konfigurierten Farbe gefüllt.',
        batteryPowerEntity: 'Leistungs-Entität',
        batteryPowerEntityHelp: 'Wähle einen Batterie-Leistungssensor (W oder kW). Vorzeichenkonvention folgt der Entität selbst; positiv = Laden und kehrt die Flussrichtung der Leiterlinie um.',
        batteryColor:       'Batteriefarbe *'
    }
};
