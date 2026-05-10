import type { Translations } from '../index';

export const es: Translations = {
    cardName:        'HELIOS',
    cardDescription: 'Visualización en tiempo real de la energía solar y la cobertura de nubes',

    live: 'En vivo',

    placeholder:
    {
        subtitle: 'Exposición solar y cobertura de nubes'
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
        mapStyle:           'Estilo del mapa *',
        mapStyleHint:       'Elige entre el mapa de calles (sobrio, urbano), el mapa topográfico (líneas de nivel, tonos terrosos, ideal en terreno montañoso) o el mapa híbrido (imágenes de satélite de alta resolución con superposición de calles y etiquetas). Las etiquetas y los edificios 3D funcionan igual en los tres.',
        mapStyleStreet:     'Calles',
        mapStyleTopo:       'Topo',
        mapStyleHybrid:     'Híbrido',
        cardTheme:          'Tema de la tarjeta *',
        cardThemeHint:      'Cambia los elementos de la tarjeta (chips, gráficos, botones, tooltips, superposición del scrub) entre un tema claro (por defecto, sobre fondo blanco) y un tema oscuro (sobre fondo casi negro) para que la tarjeta encaje limpiamente en paneles de Home Assistant claros u oscuros. El mapa 3D no se ve afectado.',
        cardThemeLight:     'Claro',
        cardThemeDark:      'Oscuro',
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
        buildingColor:      'Color de los edificios *',
        pvSection:          'Producción solar',
        pvHint:             'Opcional. Si se define, aparece una pastilla en la casa (producción instantánea, calculada sobre el último minuto) y se añade un gráfico dedicado encima de la cronología. La línea entre la casa y la pastilla se anima a una velocidad proporcional a la producción. Acepta indistintamente un sensor de potencia (W/kW) o de energía acumulada (Wh/kWh).',
        pvEntity:           'Entidad de producción',
        pvEntityHelp:       'Elige un sensor de potencia o energía fotovoltaica (W, kW, Wh, kWh).',
        pvColor:            'Color de producción *',
        batterySection:     'Batería doméstica',
        batteryHint:        'Opcional. Cada entidad aparece como su propio chip a ambos lados del chip PV — estado de carga a la IZQUIERDA, potencia con signo a la DERECHA — conectado al chip PV mediante una línea punteada estática. Ambas entidades son independientemente opcionales; el chip correspondiente aparece en cuanto la entidad está definida.',
        batterySocEntity:   'Entidad de estado de carga',
        batterySocEntityHelp: 'Elige un sensor de estado de carga de la batería (% — típicamente con device_class "battery"). Aparece como chip a la izquierda del chip PV con el porcentaje en vivo.',
        batteryPowerEntity: 'Entidad de potencia',
        batteryPowerEntityHelp: 'Elige un sensor de potencia de la batería (W o kW). La convención de signo sigue la entidad misma; positivo = cargando y se muestra tal cual en el chip (p. ej. «+3.00 kW» en carga, «−1.20 kW» en descarga).',
        batteryColor:       'Color batería *'
    }
};
