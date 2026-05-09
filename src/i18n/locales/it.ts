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
        mapStyleHint:       'Scegli tra la mappa stradale (sobria, urbana), la mappa topografica (curve di livello, toni terrosi, ideale in terreno collinare) o la mappa ibrida (immagini satellitari ad alta risoluzione con sovrapposizione di strade ed etichette). Le etichette e gli edifici 3D funzionano allo stesso modo su tutte e tre.',
        mapStyleStreet:     'Strade',
        mapStyleTopo:       'Topo',
        mapStyleHybrid:     'Ibrida',
        cardTheme:          'Tema della scheda *',
        cardThemeHint:      'Cambia gli elementi della scheda (pastiglie, grafici, pulsanti, tooltip, sovrapposizione dello scrub) tra un tema chiaro (predefinito, su sfondo bianco) e un tema scuro (su sfondo quasi nero) in modo che la scheda si integri pulitamente nei dashboard di Home Assistant chiari o scuri. La mappa 3D non è interessata.',
        cardThemeLight:     'Chiaro',
        cardThemeDark:      'Scuro',
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
        batteryHint:        'Opzionale. L\'entità dello stato di carica riempie l\'edificio 3D della casa dal basso verso l\'alto — batteria vuota, la casa appare come una sagoma grigia traslucida; batteria piena, viene dipinta completamente nel colore configurato. Passa il cursore sulla casa per leggere la percentuale esatta. L\'entità di potenza aggiunge una piccola pastiglia in alto a destra della casa con la lettura istantanea con segno; la sua linea punteggiata scorre dalla casa alla pastiglia durante la carica e dalla pastiglia alla casa durante la scarica, a una velocità proporzionale alla potenza.',
        batterySocEntity:   'Entità stato di carica',
        batterySocEntityHelp: 'Scegli un sensore di stato di carica della batteria (% — tipicamente con device_class "battery"). Pilota l\'altezza di riempimento della casa: 0 % = casa invisibile a piena opacità (resta visibile solo la sagoma al 25 %), 100 % = casa completamente riempita nel colore configurato.',
        batteryPowerEntity: 'Entità di potenza',
        batteryPowerEntityHelp: 'Scegli un sensore di potenza della batteria (W o kW). La convenzione del segno segue l\'entità stessa; positivo = in carica e inverte il verso del flusso sulla linea punteggiata.',
        batteryColor:       'Colore batteria *'
    }
};
