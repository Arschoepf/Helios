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

    placeholder:
    {
        subtitle: 'Exposition solaire & couverture nuageuse'
    },

    tooltip:
    {
        cloudCover:  "Couverture nuageuse : {0}%",
        cloudLow:    "Basse : {0}%",
        cloudMid:    "Moyenne : {0}%",
        cloudHigh:   "Haute : {0}%"
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
        mapStyleHint:       'Trois fonds de carte : Rues (sobre, urbain), Topo (lignes de niveau et tons terreux, idéal en zone vallonnée) ou Minimal (charge le fond Rues puis retire tous les libellés, icônes POI et boucliers routiers superflus pour gagner en performance). Les bâtiments 3D et les libellés se comportent à l\'identique sur Rues et Topo. La variante sombre du style choisi est utilisée automatiquement quand le thème de la carte est en mode sombre.',
        mapStyleStreet:     'Rues',
        mapStyleTopo:       'Topo',
        cardTheme:          'Thème de la carte *',
        cardThemeHint:      'Bascule l\'habillage de la carte (pastilles, graphiques, boutons, infobulles, surlignage du scrub) ainsi que le fond de carte 3D entre un thème clair (par défaut, sur fond blanc) et un thème sombre (sur fond presque noir) pour que la carte s\'intègre proprement dans un tableau de bord Home Assistant clair ou sombre.',
        cardThemeLight:     'Clair',
        cardThemeDark:      'Sombre',
        showLabels:         'Afficher les libellés *',
        showLabelsHint:     'Affiche ou masque les noms de rues, numéros de bâtiments, points d\'intérêt et noms de quartiers du fond de carte.',
        labelsOn:           'Affichés',
        labelsOff:          'Masqués',
        autoRotate:         'Rotation auto de la caméra *',
        autoRotateHint:     'Après quelques secondes d\'inactivité, la caméra tourne lentement autour de la maison (environ 1,5°/s, dans le sens inverse du mouvement apparent du soleil). Tout pincement, glissement ou molette met la rotation en pause immédiatement, elle reprend dès que tu lâches.',
        autoRotateOn:       'Activée',
        autoRotateOff:      'Désactivée',
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
        pvHint:             'Optionnel. Si renseigné, une pastille apparaît près de la maison avec la production instantanée (calculée sur la dernière minute) et un graphique dédié s\'ajoute au-dessus de la chronologie pour suivre la production. Capteur de puissance (W/kW) ou d\'énergie cumulée (Wh/kWh) acceptés indifféremment.',
        pvEntity:           'Entité de production',
        pvEntityHelp:       'Sélectionne un capteur de puissance ou d\'énergie photovoltaïque (W, kW, Wh, kWh).',
        pvColor:            'Couleur de production *',
        batterySection:     'Batterie domestique',
        batteryHint:        'Optionnel. Chaque entité apparaît sous forme de pastille de part et d\'autre de la pastille PV — état de charge à GAUCHE, puissance signée à DROITE — reliée à PV par un trait pointillé statique. Les deux entités sont indépendamment optionnelles ; la pastille correspondante s\'affiche dès que l\'entité est renseignée.',
        batterySocEntity:   'Entité d\'état de charge',
        batterySocEntityHelp: 'Choisis un capteur d\'état de charge de batterie (% — typiquement avec device_class "battery"). Rendue sous forme de pastille à gauche de la pastille PV affichant le pourcentage en direct.',
        batteryPowerEntity: 'Entité de puissance',
        batteryPowerEntityHelp: 'Choisis un capteur de puissance batterie (W ou kW). La convention de signe suit l\'entité elle-même ; positif = en charge et est affiché tel quel sur la pastille (par ex. « +3.00 kW » en charge, « −1.20 kW » en décharge).',
        batteryColor:       'Couleur batterie *',
        buildingsSection:   'Bâtiments alentour',
        buildingsHint:      'Pour ménager les performances en zone urbaine dense, seuls les bâtiments dans le rayon configuré autour de la maison sont rendus en 3D. La maison elle-même reste toujours à pleine opacité, les bâtiments voisins sont rendus en transparence pour donner le contexte sans concurrencer les données. Le rayon de regroupement permet d\'inclure les bâtiments attenants (véranda, dépendance, garage) dans le groupe « maison ».',
        buildingRadius:        'Rayon de visibilité *',
        buildingClusterRadius: 'Rayon de regroupement maison *',
        buildingOpacity:       'Opacité des bâtiments voisins *',
        buildingColor:         'Couleur des bâtiments *',
        performanceMode:       'Mode performance *',
        performanceModeOn:     'Activé',
        performanceModeOff:    'Désactivé',
        performanceModeHint:   'Désactive le relief 3D, l\'ombrage du relief et limite la densité de pixels. Utile sur appareils bas/moyen de gamme ou pour les longues sessions. Conserve l\'inclinaison de caméra et les bâtiments en 3D.',
        mapStyleMinimal:       'Minimal',
        terrainDetail:         'Détail du terrain *',
        terrainDetailSmooth:   'Lissé',
        terrainDetailFine:     'Précis',
        terrainDetailHint:     'Lissé (par défaut) échantillonne le relief tous les ~20 m, fluide partout. Précis échantillonne tous les ~5 m pour un relief plus détaillé mais ~16× plus de sommets à projeter à chaque frame de rotation, réservé aux PC desktops puissants.',
        mapStyleSatellite:     'Satellite',
        shadowPrecision:       'Précision des ombres *',
        shadowPrecisionOff:    'Off',
        shadowPrecisionLow:    'Basse',
        shadowPrecisionMedium: 'Moyenne',
        shadowPrecisionHigh:   'Haute',
        shadowPrecisionUltra:  'Ultra',
        shadowPrecisionHint:   'Uniquement disponible en France pour l\'instant.',
        shadowOpacity:         'Opacité des ombres *',
        shadowOpacityHint:     'Opacité des ombres projetées au sol.',
        buildingShadows:       'Ombres MapTiler *',
        buildingShadowsOn:     'Affichées',
        buildingShadowsOff:    'Masquées',
        buildingShadowsHint:   'Quand le LiDAR n\'est pas disponible (précision off, ou hors France), les ombres sont approximées à partir des empreintes plates MapTiler. À masquer en zone plate ou très urbaine où l\'approximation ressemble plus à du bruit qu\'à de la donnée. Sans effet sur les ombres LiDAR.',
        lidarPointCloud:       'Vue scanner LiDAR'
    }
};
