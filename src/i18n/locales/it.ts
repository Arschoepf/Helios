import type { Translations } from '../index';

export const it: Translations = {
    cardName:        'HELIOS',
    cardDescription: 'Visualizzazione in tempo reale dell\'energia solare e della copertura nuvolosa',

    live: 'Live',

    placeholder:
    {
        subtitle: 'Esposizione solare e copertura nuvolosa'
    },

    tooltip:
    {
        cloudCover:  "Copertura nuvolosa: {0}%",
        cloudLow:    "Bassa: {0}%",
        cloudMid:    "Media: {0}%",
        cloudHigh:   "Alta: {0}%",
        resetLive:   'Torna al live'
    },

    editor:
    {
        required:           'Chiave API',
        apiKey:             'Chiave API MapTiler',
        apiKeyHelp:         'Indispensabile per mostrare la mappa 3D, il rilievo e gli edifici. Il piano gratuito è più che sufficiente.',
        getKeyAt:           'Ottieni la tua chiave gratuita su',
        terrainRelief:      'Rilievo',
        terrainReliefHint:  'Ombreggiatura del rilievo sotto la mappa. Utile in aree collinari per leggere l\'orientamento dei pendii rispetto al sole.',
        hillshadeColor:     'Colore dell\'ombreggiatura *',
        hillshadeStrength:  'Intensità dell\'ombreggiatura * (0 → 1)',
        mapSection:         'Mappa',
        mapStyle:           'Stile della mappa *',
        mapStyleHint:       'Scegli tra la mappa stradale (sobria, urbana) e la mappa topografica (curve di livello, toni terrosi, ideale in terreno collinare). Le etichette e gli edifici 3D funzionano allo stesso modo su entrambe.',
        mapStyleStreet:     'Strade',
        mapStyleTopo:       'Topo',
        showLabels:         'Mostra etichette *',
        showLabelsHint:     'Mostra o nasconde i nomi delle vie, i numeri civici, i punti di interesse e i nomi dei quartieri sulla mappa di base.',
        labelsOn:           'Visibili',
        labelsOff:          'Nascoste',
        timeline:           'Cronologia',
        timelineHint:       'Formato delle date mostrate sulla cronologia e nella pastiglia di scrub.',
        dateFormat:         'Formato data * (predefinito: mm-dd)',
        dateFormatHelp:     'Token: yyyy, yy, mm, dd. Esempi:',
        timeFormat:         'Formato ora *',
        timeFormat12:       '12 h',
        timeFormat24:       '24 h',
        colors:             'Colori',
        colorsHint:         'Un colore per grandezza, riutilizzato ovunque appaia. Il colore del sole dipinge l\'arco, il disco solare e l\'area superiore della cronologia. Il colore delle nuvole dipinge il disco al suolo e l\'area inferiore della cronologia.',
        sunColor:           'Colore del sole *',
        cloudColor:         'Colore delle nuvole *',
        pvSection:          'Produzione solare',
        pvHint:             'Opzionale. Se impostato, una pastiglia appare sulla casa (produzione istantanea, calcolata sull\'ultimo minuto) e un grafico dedicato viene aggiunto sopra la cronologia. La linea tra la casa e la pastiglia si anima a una velocità proporzionale alla produzione. Accetta indifferentemente un sensore di potenza (W/kW) o di energia cumulativa (Wh/kWh).',
        pvEntity:           'Entità di produzione',
        pvEntityHelp:       'Scegli un sensore di potenza o energia fotovoltaica (W, kW, Wh, kWh).',
        pvColor:            'Colore di produzione *',
        batterySection:     'Batteria domestica',
        batteryHint:        'Opzionale. Quando è impostata almeno un\'entità, appare una pastiglia sotto la casa con lo stato di carica in tempo reale e la potenza istantanea con segno. La linea si anima verso il basso durante la carica e verso l\'alto durante la scarica, a una velocità proporzionale alla potenza. Nessuno storico viene recuperato — la pastiglia riflette solo la lettura in tempo reale.',
        batterySocEntity:   'Entità stato di carica',
        batterySocEntityHelp: 'Scegli un sensore di stato di carica della batteria (% — tipicamente con device_class "battery").',
        batteryPowerEntity: 'Entità di potenza',
        batteryPowerEntityHelp: 'Scegli un sensore di potenza della batteria (W o kW). La convenzione del segno segue l\'entità stessa; positivo = in carica.',
        batteryColor:       'Colore batteria *'
    }
};
