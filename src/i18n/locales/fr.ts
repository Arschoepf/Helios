import type { Translations } from '../index';

//Notes de traduction (FR) :
//  - "Cloud cover" → "Couverture nuageuse" (terme météo standard FR)
//  - "Global Horizontal Irradiance" → "Irradiance horizontale globale"
//    (terme scientifique standard, repris par Météo-France et l'INES)
//  - "Hillshade" → "Ombrage du relief" (rendu cartographique standard)
//  - On garde le tutoiement informel pour rester cohérent avec le ton
//    de Home Assistant en français.

export const fr: Translations = {
    cardName:        'HELIOS',
    cardDescription: 'Visualisation en temps réel de l\'énergie solaire et de la couverture nuageuse',

    live: 'Direct',

    placeholder:
    {
        subtitle: 'Exposition solaire & couverture nuageuse'
    },

    tooltip:
    {
        cloudCover:  "Couverture nuageuse : {0}%",
        cloudLow:    "Basse : {0}%",
        cloudMid:    "Moyenne : {0}%",
        cloudHigh:   "Haute : {0}%",
        resetLive:   'Revenir à l\'instant présent'
    },

    editor:
    {
        required:           'Clé API',
        apiKey:             'Clé API MapTiler',
        apiKeyHelp:         'Indispensable pour afficher la carte 3D, le relief et les bâtiments. Compte gratuit largement suffisant.',
        getKeyAt:           'Récupère ta clé gratuite sur',
        terrainRelief:      'Relief',
        terrainReliefHint:  'Ombrage du relief affiché sous la carte. Utile en zone vallonnée pour comprendre l\'orientation des pentes par rapport au soleil.',
        hillshadeColor:     'Couleur de l\'ombrage *',
        hillshadeStrength:  'Intensité de l\'ombrage * (0 → 1)',
        mapSection:         'Carte',
        mapStyle:           'Style de la carte *',
        mapStyleHint:       'Choisis entre le fond de carte des rues (sobre, urbain), le fond de carte topographique (lignes de niveau, tons terreux, idéal en zone vallonnée) ou le fond hybride (imagerie satellite haute résolution avec les routes et libellés en surimpression). Les libellés et les bâtiments 3D fonctionnent à l\'identique sur les trois.',
        mapStyleStreet:     'Rues',
        mapStyleTopo:       'Topo',
        mapStyleHybrid:     'Hybride',
        cardTheme:          'Thème de la carte *',
        cardThemeHint:      'Bascule l\'habillage de la carte (pastilles, graphiques, boutons, infobulles, surlignage du scrub) entre un thème clair (par défaut, sur fond blanc) et un thème sombre (sur fond presque noir) pour que la carte s\'intègre proprement dans un tableau de bord Home Assistant clair ou sombre. La carte 3D elle-même n\'est pas affectée.',
        cardThemeLight:     'Clair',
        cardThemeDark:      'Sombre',
        showLabels:         'Afficher les libellés *',
        showLabelsHint:     'Affiche ou masque les noms de rues, numéros de bâtiments, points d\'intérêt et noms de quartiers du fond de carte.',
        labelsOn:           'Affichés',
        labelsOff:          'Masqués',
        timeline:           'Chronologie',
        timelineHint:       'Format des libellés de date affichés sur la chronologie et dans la pastille du scrub.',
        dateFormat:         'Format de date * (par défaut : mm-dd)',
        dateFormatHelp:     'Tokens : yyyy, yy, mm, dd. Exemples :',
        timeFormat:         'Format de l\'heure *',
        timeFormat12:       '12 h',
        timeFormat24:       '24 h',
        colors:             'Couleurs',
        colorsHint:         'Une couleur par grandeur, réutilisée partout où elle apparaît. La couleur du soleil peint l\'arc, le disque solaire et la zone haute de la chronologie. La couleur des nuages peint le disque au sol et la zone basse de la chronologie.',
        sunColor:           'Couleur du soleil *',
        cloudColor:         'Couleur des nuages *',
        pvSection:          'Production photovoltaïque',
        pvHint:             'Optionnel. Si renseigné, une pastille apparaît sur la maison (production instantanée, calculée sur la dernière minute) et un graphique dédié s\'ajoute au-dessus de la chronologie pour suivre la production. La ligne entre la maison et la pastille s\'anime à une vitesse proportionnelle à la production. Capteur de puissance (W/kW) ou d\'énergie cumulée (Wh/kWh) acceptés indifféremment.',
        pvEntity:           'Entité de production',
        pvEntityHelp:       'Sélectionne un capteur de puissance ou d\'énergie photovoltaïque (W, kW, Wh, kWh).',
        pvColor:            'Couleur de production *',
        batterySection:     'Batterie domestique',
        batteryHint:        'Optionnel. L\'entité d\'état de charge remplit le bâtiment 3D de la maison de bas en haut — batterie vide, la maison apparaît comme un volume gris translucide ; batterie pleine, elle est entièrement peinte dans la couleur configurée. Survole la maison pour lire le pourcentage exact. L\'entité de puissance ajoute une petite pastille en haut à droite de la maison avec la valeur instantanée signée ; sa ligne pointillée anime de la maison vers la pastille en charge et de la pastille vers la maison en décharge, à une vitesse proportionnelle à la puissance.',
        batterySocEntity:   'Entité d\'état de charge',
        batterySocEntityHelp: 'Choisis un capteur d\'état de charge de batterie (% — typiquement avec device_class "battery"). Pilote la hauteur de remplissage de la maison : 0 % = maison invisible en pleine opacité (seul le contour à 25 % reste visible), 100 % = maison entièrement remplie dans la couleur configurée.',
        batteryPowerEntity: 'Entité de puissance',
        batteryPowerEntityHelp: 'Choisis un capteur de puissance batterie (W ou kW). La convention de signe suit l\'entité elle-même ; positif = en charge et inverse le sens du flux sur la ligne pointillée.',
        batteryColor:       'Couleur batterie *'
    }
};
