import type { Translations } from '../index';

export const pt: Translations = {
    cardName:        'HELIOS',
    cardDescription: 'Visualização em tempo real da energia solar e da cobertura de nuvens',

    live: 'Direto',

    placeholder:
    {
        subtitle: 'Exposição solar e cobertura de nuvens'
    },

    tooltip:
    {
        cloudCover:  "Cobertura de nuvens: {0}%",
        cloudLow:    "Baixa: {0}%",
        cloudMid:    "Média: {0}%",
        cloudHigh:   "Alta: {0}%",
        resetLive:   'Voltar ao direto'
    },

    editor:
    {
        required:           'Chave API',
        apiKey:             'Chave API MapTiler',
        apiKeyHelp:         'Indispensável para mostrar o mapa 3D, o relevo e os edifícios. O plano gratuito é mais que suficiente.',
        getKeyAt:           'Obtém a tua chave gratuita em',
        terrainRelief:      'Relevo',
        terrainReliefHint:  'Sombreado do relevo mostrado sob o mapa. Útil em áreas montanhosas para ler a orientação das encostas em relação ao sol.',
        hillshadeColor:     'Cor do sombreado *',
        hillshadeStrength:  'Intensidade do sombreado * (0 → 1)',
        mapSection:         'Mapa',
        mapStyle:           'Estilo do mapa *',
        mapStyleHint:       'Escolhe entre o mapa de ruas (sóbrio, urbano) e o mapa topográfico (curvas de nível, tons terrosos, ideal em terreno montanhoso). As etiquetas e os edifícios 3D funcionam de forma idêntica em ambos.',
        mapStyleStreet:     'Ruas',
        mapStyleTopo:       'Topo',
        showLabels:         'Mostrar etiquetas *',
        showLabelsHint:     'Mostra ou oculta os nomes das ruas, números de edifícios, pontos de interesse e nomes de bairros no mapa de fundo.',
        labelsOn:           'Visíveis',
        labelsOff:          'Ocultas',
        timeline:           'Linha temporal',
        timelineHint:       'Formato das datas mostradas na linha temporal e na pastilha do scrub.',
        dateFormat:         'Formato de data * (predefinição: mm-dd)',
        dateFormatHelp:     'Tokens: yyyy, yy, mm, dd. Exemplos:',
        timeFormat:         'Formato da hora *',
        timeFormat12:       '12 h',
        timeFormat24:       '24 h',
        colors:             'Cores',
        colorsHint:         'Uma cor por grandeza, reutilizada onde quer que apareça. A cor do sol pinta o arco, o disco solar e a área superior da linha temporal. A cor das nuvens pinta o disco no solo e a área inferior da linha temporal.',
        sunColor:           'Cor do sol *',
        cloudColor:         'Cor das nuvens *',
        pvSection:          'Produção solar',
        pvHint:             'Opcional. Quando definido, surge uma pastilha sobre a casa (produção instantânea, calculada sobre o último minuto) e um gráfico dedicado é adicionado acima da linha temporal. A linha entre a casa e a pastilha anima a uma velocidade proporcional à produção. Aceita indistintamente um sensor de potência (W/kW) ou de energia cumulativa (Wh/kWh).',
        pvEntity:           'Entidade de produção',
        pvEntityHelp:       'Escolhe um sensor de potência ou energia fotovoltaica (W, kW, Wh, kWh).',
        pvColor:            'Cor de produção *'
    }
};
