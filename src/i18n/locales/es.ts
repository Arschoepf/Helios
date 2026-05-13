import type { Translations } from '../index';

export const es: Translations = {
    cardName:        'HELIOS',
    cardDescription: 'Visualización en tiempo real de la energía solar y la cobertura de nubes',

    placeholder:
    {
        subtitle: 'Exposición solar y cobertura de nubes'
    },

    tooltip:
    {
        cloudCover:  "Cobertura de nubes: {0}%",
        cloudLow:    "Baja: {0}%",
        cloudMid:    "Media: {0}%",
        cloudHigh:   "Alta: {0}%"
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
        mapStyleHint:       'Tres mapas base: Calles (sobrio, urbano), Topo (líneas de nivel y tonos terrosos, ideal en terreno montañoso) o Minimal (carga Calles y elimina todas las etiquetas, iconos POI y escudos viarios superfluos para un renderizado más rápido). Los edificios 3D y las etiquetas se comportan igual en Calles y Topo. La variante oscura del estilo elegido se usa automáticamente cuando el tema de la tarjeta está en oscuro.',
        mapStyleStreet:     'Calles',
        mapStyleTopo:       'Topo',
        cardTheme:          'Tema de la tarjeta *',
        cardThemeHint:      'Cambia los elementos de la tarjeta (chips, gráficos, botones, tooltips, superposición del scrub) y el mapa 3D de fondo entre un tema claro (por defecto, sobre fondo blanco) y un tema oscuro (sobre fondo casi negro) para que la tarjeta encaje limpiamente en paneles de Home Assistant claros u oscuros.',
        cardThemeLight:     'Claro',
        cardThemeDark:      'Oscuro',
        showLabels:         'Mostrar etiquetas *',
        showLabelsHint:     'Muestra u oculta los nombres de calles, números de edificios, puntos de interés y nombres de zonas en el mapa de fondo.',
        labelsOn:           'Visibles',
        labelsOff:          'Ocultas',
        autoRotate:         'Rotación automática de la cámara *',
        autoRotateHint:     'Tras unos segundos de inactividad, la cámara orbita lentamente alrededor de la casa (aprox. 1,5°/s, en sentido opuesto al movimiento aparente del sol). Cualquier pellizco, arrastre o rueda la pausa al instante y se reanuda cuando sueltas.',
        autoRotateOn:       'Activada',
        autoRotateOff:      'Desactivada',
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
        pvHint:             'Opcional. Si se define, aparece una pastilla cerca de la casa con la producción instantánea (calculada sobre el último minuto) y se añade un gráfico dedicado encima de la cronología. Acepta indistintamente un sensor de potencia (W/kW) o de energía acumulada (Wh/kWh).',
        pvEntity:           'Entidad de producción',
        pvEntityHelp:       'Elige un sensor de potencia o energía fotovoltaica (W, kW, Wh, kWh).',
        pvColor:            'Color de producción *',
        batterySection:     'Batería doméstica',
        batteryHint:        'Opcional. Cada entidad aparece como su propio chip a ambos lados del chip PV — estado de carga a la IZQUIERDA, potencia con signo a la DERECHA — conectado al chip PV mediante una línea punteada estática. Ambas entidades son independientemente opcionales; el chip correspondiente aparece en cuanto la entidad está definida.',
        batterySocEntity:   'Entidad de estado de carga',
        batterySocEntityHelp: 'Elige un sensor de estado de carga de la batería (% — típicamente con device_class "battery"). Aparece como chip a la izquierda del chip PV con el porcentaje en vivo.',
        batteryPowerEntity: 'Entidad de potencia',
        batteryPowerEntityHelp: 'Elige un sensor de potencia de la batería (W o kW). La convención de signo sigue la entidad misma; positivo = cargando y se muestra tal cual en el chip (p. ej. «+3.00 kW» en carga, «−1.20 kW» en descarga).',
        batteryColor:       'Color batería *',
        buildingsSection:   'Edificios circundantes',
        buildingsHint:      'Para mantener la tarjeta fluida en zonas urbanas densas, sólo los edificios dentro del radio configurado alrededor del hogar se renderizan en 3D. La propia casa siempre se muestra con opacidad completa; los edificios vecinos se renderizan con la opacidad configurada para aportar contexto urbano sin competir con los datos. El radio del grupo permite incluir las construcciones adosadas (terrazas, garajes, anexos) en el grupo «casa».',
        buildingRadius:        'Radio de visibilidad *',
        buildingClusterRadius: 'Radio del grupo de la casa *',
        buildingOpacity:       'Opacidad de los vecinos *',
        buildingColor:         'Color de los edificios *',
        performanceMode:       'Modo rendimiento *',
        performanceModeOn:     'Activado',
        performanceModeOff:    'Desactivado',
        performanceModeHint:   'Desactiva el terreno 3D, el relieve y limita la densidad de píxeles. Útil en dispositivos modestos o para sesiones largas. La inclinación y los edificios 3D se mantienen.',
        mapStyleMinimal:       'Mínimo',
        terrainDetail:         'Detalle del terreno *',
        terrainDetailSmooth:   'Suave',
        terrainDetailFine:     'Preciso',
        terrainDetailHint:     'Suave (por defecto) muestrea el relieve cada ~20 m y se mantiene fluido en todos los dispositivos. Preciso muestrea cada ~5 m para un relieve más detallado pero ~16× más vértices que proyectar en cada frame de rotación, útil solo en PCs potentes.',
        lidarVegetation:       'Vegetación LiDAR *',
        lidarVegetationOff:    'Off',
        lidarVegetationHint:   'Solo Francia por ahora. Descarga las alturas IGN LiDAR HD alrededor de la casa y dibuja TANTO los edificios COMO los árboles como bloques 3D por celda con sombras proyectadas reales, sustituyendo las extrusiones MapTiler. El valor es el tamaño de celda: menor, detalle más fino, mayor carga de red. 4.5m va bien en cualquier dispositivo, 1m coincide con el muestreo nativo IGN (~300k elementos) y solo para escritorios potentes.'
    }
};
