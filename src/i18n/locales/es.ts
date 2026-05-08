import type { Translations } from '../index';

export const es: Translations = {
    cardName:        'HELIOS',
    cardDescription: 'Visualización en tiempo real de la energía solar y la cobertura de nubes',

    live: 'En vivo',

    placeholder:
    {
        subtitle: 'Exposición solar y cobertura de nubes',
        action:   'Configura tu clave API de MapTiler para activar'
    },

    tooltip:
    {
        cloudCover:  "Cobertura de nubes: {0}%",
        cloudLow:    "Baja: {0}%",
        cloudMid:    "Media: {0}%",
        cloudHigh:   "Alta: {0}%",
        resetLive:   'Volver al directo'
    },

    editor:
    {
        required:           'Clave API',
        apiKey:             'Clave API de MapTiler',
        apiKeyHelp:         'Imprescindible para mostrar el mapa 3D, el relieve y los edificios. El plan gratuito es más que suficiente.',
        getKeyAt:           'Consigue tu clave gratuita en',
        terrainRelief:      'Relieve',
        terrainReliefHint:  'Sombreado del relieve mostrado bajo el mapa. Útil en zonas montañosas para leer la orientación de las pendientes respecto al sol.',
        hillshadeColor:     'Color del sombreado *',
        hillshadeStrength:  'Intensidad del sombreado * (0 → 1)',
        mapSection:         'Mapa',
        showLabels:         'Mostrar etiquetas *',
        showLabelsHint:     'Muestra u oculta los nombres de calles, números de edificios, puntos de interés y nombres de zonas en el mapa de fondo.',
        labelsOn:           'Visibles',
        labelsOff:          'Ocultas',
        timeline:           'Cronología',
        timelineHint:       'Formato de las fechas mostradas en la cronología y en la pastilla del scrub.',
        dateFormat:         'Formato de fecha * (por defecto: mm-dd)',
        dateFormatHelp:     'Tokens: yyyy, yy, mm, dd. Ejemplos:',
        timeFormat:         'Formato de hora *',
        timeFormat12:       '12 h',
        timeFormat24:       '24 h',
        colors:             'Colores',
        colorsHint:         'Un color por magnitud, reutilizado en todos los lugares donde aparece. El color del sol pinta el arco, el disco solar y la zona alta de la cronología. El color de las nubes pinta el disco del suelo y la zona baja de la cronología.',
        sunColor:           'Color del sol *',
        cloudColor:         'Color de las nubes *',
        pvSection:          'Producción solar',
        pvHint:             'Opcional. Si se define, aparece una pastilla en la casa (producción instantánea, calculada sobre el último minuto) y se añade un gráfico dedicado encima de la cronología. La línea entre la casa y la pastilla se anima a una velocidad proporcional a la producción. Acepta indistintamente un sensor de potencia (W/kW) o de energía acumulada (Wh/kWh).',
        pvEntity:           'Entidad de producción',
        pvEntityHelp:       'Elige un sensor de potencia o energía fotovoltaica (W, kW, Wh, kWh).',
        pvColor:            'Color de producción *'
    }
};
