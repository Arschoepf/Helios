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
        pvColor:            'Couleur de production *'
    }
};
