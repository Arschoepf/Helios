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
        mapStyleHint:       'Escolhe entre o mapa de ruas (sóbrio, urbano), o mapa topográfico (curvas de nível, tons terrosos, ideal em terreno montanhoso) ou o mapa híbrido (imagens de satélite de alta resolução com sobreposição de estradas e etiquetas). As etiquetas e os edifícios 3D funcionam de forma idêntica nos três.',
        mapStyleStreet:     'Ruas',
        mapStyleTopo:       'Topo',
        mapStyleHybrid:     'Híbrido',
        cardTheme:          'Tema do cartão *',
        cardThemeHint:      'Alterna os elementos do cartão (chips, gráficos, botões, tooltips, sobreposição do scrub) entre um tema claro (predefinição, sobre fundo branco) e um tema escuro (sobre fundo quase preto) para que o cartão se integre limpamente em painéis Home Assistant claros ou escuros. O mapa 3D não é afetado.',
        cardThemeLight:     'Claro',
        cardThemeDark:      'Escuro',
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
        pvColor:            'Cor de produção *',
        batterySection:     'Bateria doméstica',
        batteryHint:        'Opcional. A entidade de estado de carga preenche o edifício 3D da casa de baixo para cima — bateria vazia, a casa aparece como uma silhueta cinza translúcida; bateria cheia, fica totalmente pintada na cor configurada. Passa o cursor sobre a casa para ler a percentagem exata. A entidade de potência adiciona um pequeno chip no canto superior direito da casa com a leitura instantânea com sinal; a sua linha pontilhada flui da casa para o chip durante o carregamento e do chip para a casa durante a descarga, a uma velocidade proporcional à potência.',
        batterySocEntity:   'Entidade do estado de carga',
        batterySocEntityHelp: 'Escolhe um sensor de estado de carga da bateria (% — normalmente com device_class "battery"). Comanda a altura de preenchimento da casa: 0 % = casa invisível com opacidade total (só a silhueta a 25 % continua visível), 100 % = casa totalmente preenchida na cor configurada.',
        batteryPowerEntity: 'Entidade de potência',
        batteryPowerEntityHelp: 'Escolhe um sensor de potência da bateria (W ou kW). A convenção de sinal segue a própria entidade; positivo = a carregar e inverte o sentido do fluxo na linha pontilhada.',
        batteryColor:       'Cor da bateria *'
    }
};
