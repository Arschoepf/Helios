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
        pvColor:            'Colore di produzione *'
    }
};
