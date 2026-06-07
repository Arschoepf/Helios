# Helios, documentation technique

Cette documentation décrit le fonctionnement interne de la card Helios pour Home Assistant. Elle est rédigée pour un développeur débutant qui veut comprendre comment le code est organisé, ce que chaque fichier fait, et comment les pièces s'imbriquent.

Pour un public francophone, j'utilise le français partout. Les termes techniques (LitElement, MapLibre, WebGL, etc.) restent en anglais parce qu'ils correspondent à des noms de bibliothèques ou de concepts standard, et que les chercher en français donnerait des résultats inutiles.

## Table des matières

1. [Vue d'ensemble](#1-vue-densemble)
2. [Stack technique](#2-stack-technique)
3. [Architecture en trois couches](#3-architecture-en-trois-couches)
4. [Point d'entrée, helios-card.ts](#4-point-dentrée-helios-cardts)
5. [Le moteur, helios-engine.ts](#5-le-moteur-helios-enginets)
6. [Schéma de configuration, helios-config.ts](#6-schéma-de-configuration-helios-configts)
7. [La couche card, fichiers src/card/](#7-la-couche-card-fichiers-srccard)
8. [La couche engine, fichiers src/engine/](#8-la-couche-engine-fichiers-srcengine)
9. [Le module LiDAR](#9-le-module-lidar)
10. [Internationalisation, i18n](#10-internationalisation-i18n)
11. [Styles CSS](#11-styles-css)
12. [Flux de données complet](#12-flux-de-données-complet)
13. [Cycle de vie de la card](#13-cycle-de-vie-de-la-card)
14. [Conventions de code](#14-conventions-de-code)


## 1. Vue d'ensemble

### À quoi sert Helios

Helios est une card Lovelace pour Home Assistant. Elle s'affiche dans le dashboard et montre, en 3D temps réel sur une carte du quartier de l'utilisateur :

- la position du soleil et son arc dans le ciel pour le jour courant,
- la couverture nuageuse (donnée météo récupérée depuis Open-Meteo, un service gratuit),
- la production photovoltaïque instantanée et prévue,
- l'état d'une batterie domestique (charge / décharge / SoC),
- les flux d'import et d'export électrique avec le réseau,
- les ombres réelles projetées par les bâtiments et la végétation autour de la maison (quand le LiDAR du pays de l'utilisateur est disponible).

La carte est rendue avec [MapLibre GL JS](https://maplibre.org/), un moteur de cartographie WebGL open source. Le fond de carte vient d'OpenFreeMap (un dérivé gratuit d'OpenStreetMap).

### Ce que voit l'utilisateur

Helios a plusieurs vues, contrôlées par une barre de mode en haut à droite de la card :

- **base** : vue par défaut. La carte 3D avec les chips d'info (production, batterie, météo), les arcs de leader (qui suivent le soleil, les nuages, la maison), et la timeline en bas qu'on peut scruber pour explorer le passé.
- **LiDAR view** : la map 3D s'efface, on voit la nuée de points LiDAR qui décrit la hauteur de chaque cellule autour de la maison. Pratique pour comprendre la précision des ombres.
- **Shading Dome** : un dôme céleste apparaît au-dessus de la maison, coloré par la carte d'ombrage apprise (la "shading map"). Permet de visualiser où le soleil est masqué selon la saison.
- **Dashboard CoverFlow** : quand l'utilisateur clique sur la maison, un panneau plein écran s'ouvre avec 5 cartes "jour" (avant-hier, hier, aujourd'hui, demain, après-demain) navigables en CoverFlow. Chaque card affiche un cadran horloge radial (le "radial sundial") avec les données du jour.

### Ce que ça veut dire pour le code

La card est complexe. ~27 000 lignes de TypeScript et CSS, plus une centaine de fichiers de traduction. Les responsabilités sont éclatées en plusieurs couches pour que chaque fichier reste focalisé et testable.


## 2. Stack technique

### Bibliothèques externes

| Bibliothèque | Rôle |
|--------------|------|
| **Lit** (`lit`) | Framework de composants web. Helios est un seul `HTMLElement` custom (`<helios-card>`) qui utilise Lit pour son rendu réactif. |
| **MapLibre GL** (`maplibre-gl`) | Moteur de carte 3D WebGL. Affiche le fond de carte OpenFreeMap, les extrusions de bâtiments, les ombres rasterisées, la layer LiDAR view personnalisée. |
| **@mapbox/vector-tile** | Décodeur de tuiles vectorielles. Helios télécharge directement les tuiles d'OpenFreeMap pour extraire les bâtiments dans un rayon défini autour de la maison (plutôt que de laisser MapLibre afficher TOUS les bâtiments du viewport, ce qui ramerait en zone urbaine dense). |
| **pbf** | Décodeur Protocol Buffers, utilisé par @mapbox/vector-tile. |
| **geotiff** | Lecteur de fichiers GeoTIFF (format de raster géoréférencé). Sert à lire les fichiers nDSM LiDAR (Digital Surface Model) téléchargés depuis les providers nationaux. |

### Outils de build

- **Vite** pour le bundling. La commande `npm run build` produit un fichier unique `dist/helios.js` qui est chargé par HACS dans Home Assistant.
- **TypeScript** strict, avec `noUnusedLocals` et `noUnusedParameters`. Le typecheck (`npm run typecheck`) est un filet de sécurité avant chaque release.
- **Terser** pour minifier le bundle final.

### Format de distribution

Helios est distribué via [HACS](https://www.hacs.xyz/), le hub de plugins communautaires Home Assistant. Chaque release GitHub attache le bundle `helios.js` final, et HACS le télécharge dans le dossier `config/www/` de l'utilisateur. La card est ensuite déclarée dans le dashboard avec :

```yaml
type: custom:helios-card
home-latitude: 49.0123
home-longitude: 2.3456
# ... autres clés YAML, voir helios-config.ts
```


## 3. Architecture en trois couches

Le code est organisé en trois couches concentriques. Chacune a un rôle clair et ne déborde pas sur celui des autres.

```
┌─────────────────────────────────────────────────────────┐
│  helios-card.ts            (couche Lit, l'élément HTML) │
│   ├─ setConfig, render, lifecycle hooks                 │
│   └─ délègue aux modules card/ et engine                │
│                                                         │
│  ┌────────────────────────────────────────────────────┐ │
│  │ src/card/*.ts          (couche card, "UI logic")   │ │
│  │  pv.ts, battery.ts, grid.ts, charts.ts,            │ │
│  │  dashboard.ts, timeline.ts, overlays.ts, etc.      │ │
│  │  → connaît la forme du host (la card), manipule    │ │
│  │    son @state, retourne des TemplateResult         │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  ┌────────────────────────────────────────────────────┐ │
│  │ src/engine/*.ts        (couche engine, "moteur 3D")│ │
│  │  sun.ts, weather.ts, shadows.ts, lidar/,           │ │
│  │  shadingMap.ts, etc.                               │ │
│  │  → fonctions pures, pas de DOM, pas de Lit         │ │
│  │  → testables sans navigateur                       │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Pourquoi cette séparation

1. **Lisibilité** : chaque fichier a une responsabilité clairement nommée. Quand on cherche "où sont récupérées les valeurs de production PV ?", la réponse est immédiate (`src/card/pv.ts`).
2. **Testabilité** : la couche engine est composée de fonctions pures (entrée, calcul, sortie). On peut les tester sans navigateur, sans DOM, sans Home Assistant. C'est le cas par exemple pour `sun.ts` qui calcule la position du soleil à partir d'une date et de coordonnées : aucun effet de bord.
3. **Réutilisabilité** : la couche engine est indépendante de Lit et de Home Assistant. Si demain on voulait porter Helios vers un autre dashboard (HAOS Premium, Lovelace alternative, etc.), il suffirait de réécrire la couche card.

### Le pattern "host"

Les modules de la couche card ne sont **pas des classes**. Ce sont des fichiers qui exportent des fonctions opérant sur un objet `host` (la card Lit, passée en paramètre). Exemple :

```ts
// dans src/card/pv.ts
export function refreshPv(host: PvHost): void
{
    // ... interroge hass, met à jour host._pvLiveValue, host._pvHistory, etc.
    host.requestUpdate();
}
```

Et l'interface `PvHost` n'est PAS la classe complète `<helios-card>` (sinon les fichiers card s'imbriqueraient circulairement). C'est juste la **forme** des champs que le module en question lit ou écrit :

```ts
interface PvHost
{
    hass: HomeAssistant | undefined;
    _pvLiveValue: number | null;
    _pvHistory: PvHistory | null;
    requestUpdate(): void;
    // ... autres champs nécessaires
}
```

Ce pattern (parfois appelé "structural typing" ou "duck typing typé") permet aux modules card de mettre à jour la card sans dépendre du fichier `helios-card.ts`. La compilation reste rapide et les imports circulaires sont évités.


## 4. Point d'entrée, helios-card.ts

C'est LE fichier qui définit l'élément custom `<helios-card>` que Home Assistant instancie. ~3000 lignes, mais l'essentiel est :

### Déclaration de l'élément

```ts
@customElement('helios-card')
export class HeliosCard extends LitElement
{
    // ...
}
```

Lit enregistre cette classe comme un custom element HTML standard. Quand le dashboard rencontre `<helios-card>` ou `type: custom:helios-card`, le navigateur instancie cette classe.

### Les champs réactifs (@state et @property)

Helios déclare beaucoup d'@state (une centaine). Chaque @state est un champ qui, quand il est réassigné, déclenche un re-render. C'est la mécanique de réactivité de Lit.

Quelques @state importants :

- `_engine` : l'instance du moteur (helios-engine.ts), créée dans `firstUpdated()`.
- `_now` : la date courante. Tick par le timer de timeline.
- `_selectedTime` : si l'utilisateur scrube la timeline, l'instant choisi. `null` en mode live.
- `_isLiveMode` : `true` si on est en live, `false` si on scrube le passé.
- `_pvLiveValue`, `_batteryLiveValue`, `_gridImportLiveValue`, etc. : les valeurs instantanées affichées dans les chips.
- `_pvHistory`, `_batteryPowerHistory`, etc. : les buffers d'historique (24 heures glissantes) pour les chips au scrub.
- `_chartSeries` : la série complète (météo + irradiance) sur 30 jours passés + 2 jours futurs, source des chart et du shading trainer.
- `_loadingPhases`, `_loadingHasCompleted` : drives la barre de progression initiale (voir loading-tracker.ts).
- `_dashDayOffset`, `_dashRadialHoverHour` : état du dashboard CoverFlow et du curseur de scrub sur le sundial.

### Cycle de vie Lit + Helios

Quand Home Assistant instancie la card, voici la séquence (simplifiée) :

```
constructor()
  └─> Lit alloue les @state à leur valeur par défaut.

setConfig(config)         ← appelé par HA avec le YAML
  └─> Helios valide la config (helios-config.ts), normalise les clés,
      stocke dans this.config.

connectedCallback()
  └─> hooks attachés (HA events, mode-bar, scroll observer, etc.)
      Voir src/card/init.ts.

firstUpdated()
  └─> setupEngine() : construit le HeliosEngine, attache la map au DOM.

updated() ou requestUpdate()
  └─> re-render Lit dès qu'un @state change.

disconnectedCallback()
  └─> teardown : engine.destroy(), removeListeners(), etc.
```

### render()

C'est la fonction qui décrit le HTML de la card. Elle est appelée par Lit après chaque changement d'@state. Helios `render()` est long parce que la card a beaucoup d'éléments :

- un `<div>` racine `.helios-card`,
- la zone map (`<div id="map-container">` qui reçoit MapLibre),
- les overlays SVG (sun arc, leaders cloud / PV / battery, sun cosmetic),
- les chips (production, batterie, grid, météo, calibration, sun, cloud),
- la timeline (deux SVG, voir charts.ts),
- la mode bar en haut à droite,
- la LiDAR view overlay (cf. lidar-view.ts),
- le shading dome (cf. shadingDome.ts),
- le dashboard CoverFlow (cf. dashboard.ts),
- la banner de loading (cf. loading-tracker.ts).

Le rendu délègue largement aux modules card/ via des appels du genre `${renderChipStrip(this)}`, `${renderTimeline(this)}`, etc. La card `helios-card.ts` orchestre, les modules card font le travail.

### Le timer global (`_now` tick)

Pour rester "live", Helios tique régulièrement (toutes les ~30 secondes en mode chips, et plus rapidement quand la timeline est active). Le tick fait :

1. avance `_now` à la nouvelle date,
2. relit les `hass.states` pour rafraîchir les chips,
3. demande au moteur de re-projeter le soleil et les nuages,
4. déclenche un re-render Lit.

Cette boucle vit dans `src/card/timeline.ts` (voir `setupTickLoop`).


## 5. Le moteur, helios-engine.ts

C'est le PLUS GROS fichier du projet, ~5500 lignes. C'est la **classe HeliosEngine** qui contrôle la map MapLibre, projette le soleil, les nuages, les ombres, calcule la photovoltaïque, et expose des points d'extension pour la card.

### Pourquoi une classe et pas des fonctions pures comme la couche engine ?

Parce que MapLibre est un gros objet stateful : une fois la map créée, elle a son contexte WebGL, son style chargé, ses layers, sa caméra, ses sources de données. Garder ça dans une classe encapsule la durée de vie : `new HeliosEngine(...)` crée tout, `engine.destroy()` nettoie tout. La card ne touche pas directement à la map MapLibre.

### Responsabilités principales

| Domaine | Méthodes ou propriétés clés |
|---------|------------------------------|
| Cycle de vie | `constructor`, `destroy`, `updateConfig` |
| Caméra | `setCameraBearing`, `setCameraPitch`, `setLockedCamera`, `_initialPose` |
| Soleil et arc | `_recomputeSunArc`, `_refreshSunPose`, expose `getSunArcSamples()` à la card pour dessiner l'arc SVG |
| Météo et nuages | `_refreshWeather`, `_recomputeCloudDome`, expose la géométrie de dôme nuageux à la card |
| Bâtiments | `_ensureBuildingsFetched`, `_pushRenderableSources` (alimente les layers `helios-buildings-home` et `helios-buildings-surroundings`) |
| Ombres | `_refreshShadowsAndAtmosphere`, `_ensureLidarFetched`, alimente le layer `helios-building-shadows` via `paintShadowRaster` |
| LiDAR view | `_lidarViewLayer` (instance de LidarViewLayer), `setLidarViewOpacity` |
| PV prédiction | `getPvPowerAt`, `getDayPvKwh`, `_recomputePvChain` |
| Hooks externes | `onFetchStart / onFetchEnd`, `onShadowComputeStart / onShadowComputeEnd`, etc. La card s'abonne pour piloter la barre de loading. |

### Le pipeline météo (vue d'ensemble)

```
1. La card appelle engine.updateConfig(...) à chaque setConfig.
2. L'engine décide qu'il a besoin d'une nouvelle fetch météo
   (changement de coordonnées home OU dernier cache plus vieux que ~10 min).
3. Il appelle engine/weather.ts:fetchHomePointData(lat, lon).
4. Open-Meteo répond avec ~32 jours d'irradiance + cloud cover par heure.
5. L'engine stocke le résultat dans _homeHourlyData.
6. À chaque tick, getSunPosition(now) calcule l'altitude + azimut du soleil,
   computeIrradianceWm2 fournit la valeur instantanée (interpolée entre les
   bins horaires de la météo).
7. La card lit ces valeurs via les hooks ou appels publics et les passe
   aux chips, aux chart et au dôme nuageux.
```

### Le pipeline ombres (vue d'ensemble)

```
1. Pour chaque batiment dans le rayon de display (200 m par défaut),
   shadows.ts:projectExtrusionShadows projette ses sommets dans la direction
   opposée du soleil, hauteur / tan(altitude) loin.
2. La sortie est une FeatureCollection GeoJSON de polygones d'ombre.
3. Si un provider LiDAR couvre la maison, le LiDAR remplace les bâtiments
   OpenFreeMap pour la projection. Les ombres incluent alors la végétation.
4. shadow-raster.ts:paintShadowRaster rasterise toutes ces polygones sur un
   canvas offscreen (1024 × 1024 par défaut) en noir solide.
5. Un fade radial est appliqué autour du home pour que le bord du rayon
   d'affichage ne se voit pas comme un cercle dur.
6. Le canvas est uploadé comme image dans la source MapLibre
   `helios-building-shadows-src`, et le layer `helios-building-shadows`
   le rend avec une opacité contrôlée par `shadow-opacity`.
```

### Le pipeline PV (vue d'ensemble)

Le forecast PV combine plusieurs entrées :

```
irradiance Open-Meteo × cloud cover
  × shading map auto-apprise (par direction du soleil, voir shadingMap.ts)
  × calibration ratio (par jour, voir card/calibration.ts)
  × kWp de chaque array configuré
  × cos(angle de Liu-Jordan, tilt + azimuth + sun position)
  × correction thermique (engine/pv-thermal.ts)
  × clip inverter max
  ──> watts prédits pour ce moment précis
```

Tout ça est implémenté dans `engine/sun.ts:computePvPower` (la version single array) et `engine/sun.ts:computePvPowerWeighted` (la version multi-arrays).


## 6. Schéma de configuration, helios-config.ts

Ce fichier décrit la SURFACE que l'utilisateur touche via YAML ou l'éditeur visuel. Il n'a aucune logique : juste l'interface `HeliosConfig` et les constantes `DEFAULT_*`.

### L'interface HeliosConfig

C'est un gros TypeScript interface avec ~50 clés optionnelles, toutes typées `unknown`. Chaque clé est typée unknown pour forcer le code consommateur à valider (number(...), string(...), etc.) avant utilisation. C'est défensif : si l'utilisateur met une valeur invalide dans son YAML, le runtime ne plante pas, il fall-back sur le défaut.

Catégories principales :

- **Couleurs** : `sun-color`, `cloud-color`, `pv-color`, `battery-color`.
- **Carte** : `map-style` (streets / minimal), `show-labels`, `card-theme` (auto / light / dark).
- **Localisation** : `home-latitude`, `home-longitude` (override de `hass.config`).
- **Installation PV** : `pv-peak-kwp`, `pv-tilt`, `pv-azimuth`, `pv-arrays` (multi-array), `pv-inverter-max-kw`, `solar-radiation-entity`.
- **Caméra** : `camera-bearing-deg`, `camera-pitch-deg`, `camera-locked`, `auto-rotate-enabled`.
- **Bâtiments** : `building-cluster-radius`, `building-opacity`.
- **Ombres et LiDAR** : `shadows-enabled`, `shadow-opacity`, `lidar-precision`, `lidar-local-ndsm-*` (BYO LiDAR), `lidar-view-opacity`.
- **Timeline** : `timeline-consumption-enabled`.
- **Inverter cutoff** : `inverter-cutoff-soc-pct` (pour le shading trainer).

### Les constantes DEFAULT_*

Exportées à côté de l'interface, utilisées en fallback partout :

```ts
export const DEFAULT_SUN_COLOR_HEX             = '#f59e0b';
export const DEFAULT_BUILDING_OPACITY          = 0.85;
export const DEFAULT_SHADOW_OPACITY            = 0.32;
export const DEFAULT_LIDAR_PRECISION           = 'medium';
export const DEFAULT_DISPLAY_RADIUS_M          = 200;
// ... etc
```

### Migration des clés legacy

L'utilisateur historique (avant la refonte v1.8.3) avait des clés qui sont maintenant gérées par le dashboard HA Energy. Ces clés (`pv-power-entity`, `grid-import-entity`, etc.) sont silencieusement ignorées au runtime, et l'éditeur les supprime à la sauvegarde. La liste vit dans `src/card/editor.ts` sous `_LEGACY_ENTITY_KEYS`, et `helios-card.ts` notifie l'utilisateur via `persistent_notification` une fois si son YAML en contient encore.


## 7. La couche card, fichiers src/card/

Tous les fichiers de cette couche partagent le même pattern : ils exportent des fonctions opérant sur un structural `*Host` (sous-ensemble de la classe HeliosCard), et retournent soit un `TemplateResult` (un fragment de HTML Lit), soit une valeur calculée. Voici un tour rapide.

### src/card/pv.ts

Le plus gros (~1850 lignes). Gère TOUT ce qui touche au photovoltaïque côté card :

- `refreshPv(host)` : récupère la valeur live depuis `hass.states` ET déclenche `fetchPvHistory` quand l'historique est obsolète.
- `fetchPvHistory(host)` : appelle `recorder/statistics_during_period` (LTS) + `history/history_during_period` (raw) en parallèle, fusionne, stocke dans `_pvHistory`.
- `currentPvRate(host)`, `pvRateAtTime(host, ms)` : valeur de production en watts à un instant donné.
- `pvNormalizeToWatts(value, unit)` : convertit n'importe quelle unité PV (W, kW, MW) en watts.
- `pvCalibK(host)`, `pvInverterMaxW(host)` : helpers de calibration et de clip inverter.
- `computePvPowerWeighted(config, time, lat, lon, cloud, opts)` : valeur prédite (modèle physique) à un instant. Utilisée par le forecast.
- `formatPvValue(watts, locale)` : formatage pour les chips ("3.42 kW", "850 W", etc.).
- `resolvePvLiveEntity(host)` : extrait du `EnergyPreferences` la source PV à interroger.

### src/card/battery.ts

Même pattern que pv.ts mais pour la batterie. Lit `stat_soc`, `stat_rate`, `stat_energy_from`, `stat_energy_to` depuis HA Energy. Gère SoC live + power live + history pour le scrub timeline.

### src/card/grid.ts

Idem pour le réseau. Lit `stat_energy_from` (import) et `stat_energy_to` (export), avec un fallback live sur `stat_rate` (signed) quand HA Energy le déclare. Le scrub passé est dérivé de la pente cumulative des compteurs.

### src/card/energy-prefs.ts

Abonnement WebSocket à `energy/get_prefs` + l'event `energy_preferences_updated`. Une seule fois par card. Le résultat est stocké dans `host._energyDefaults` et lu par pv.ts, battery.ts, grid.ts pour résoudre les sources.

### src/card/calibration.ts

Calcule le `pvCalibK` (multiplicateur de calibration) en comparant N derniers jours de prédiction physique vs production réelle. Une seule fonction principale : `computePvCalibrationKey(host)`, retourne un nombre (généralement entre 0.7 et 1.3) ou `null` si insuffisamment de données.

### src/card/radiation.ts

Override irradiance. Si l'utilisateur a un capteur W/m² (Ecowitt, Davis), ses samples remplacent l'irradiance Open-Meteo pour le passé + le live. Le futur reste sur Open-Meteo (un capteur ne connait pas l'avenir). Gère la fetch d'historique + l'injection dans `_chartSeries.irradiance`.

### src/card/charts.ts

Rendu des deux chart SVG sous la map :

- le chart **irradiance + cloud** (toujours visible),
- le chart **PV** (production passée + forecast).

Pure templates : prend un structural ChartHost, retourne du svg`...`. Le scrub timeline (cursor de live + cursor sélectionné) est rendu ici.

### src/card/timeline.ts

Le tick loop (advance `_now`) + les pointer handlers pour scruber la timeline (la barre au-dessus du chart). `setupTickLoop`, `handleTimelinePointerMove`, `resetToLive` sont les exports principaux.

### src/card/dashboard.ts

Le panneau CoverFlow qui s'ouvre quand on clique sur la maison. Rend 5 cards "jour", avec animation 3D au navigation. Le contenu de chaque card est :

- un bandeau (date + icône météo + bouton close),
- une bande de chips (Irradiance, Cloud, Production, Battery),
- un cadran horloge radial (le "radial sundial", voir ci-dessous).

### src/card/dashboardRadial.ts

Le cadran horloge SVG au centre de chaque card. Concentriquement, de l'intérieur vers l'extérieur :

- **Centre** : disque soleil (taille = irradiance instantanée / clear-sky max).
- **Anneau couverture nuageuse** (avec courbe d'irradiance superposée en couleur soleil).
- **Anneau production** (passé en plein, futur en outline pointillé).
- **Anneau batterie** (charge + décharge dans deux couleurs HA Energy).
- **Anneau d'horloge** avec les 24 chiffres d'heure peints dedans + ticks.

Le scrub (hover ou tap mobile) déplace un curseur radial qui met à jour les chips.

### src/card/init.ts

Helpers de bootstrap. Validation des coordonnées home, hash de config (pour décider quand reconstruire l'engine), le setup IntersectionObserver qui suspend les animations quand la card est hors viewport.

### src/card/editor.ts

L'éditeur visuel YAML. Quand l'utilisateur clique "Show Code Editor" → "Show Visual Editor" dans le dashboard HA, c'est ce composant Lit qui s'affiche. Sections collapsibles, validation à la saisie, fallback graceful.

### src/card/overlays.ts

Les overlays HTML / SVG en superposition sur la map (qui sont DEHORS du WebGL parce que MapLibre ne sait pas faire de DOM). Les "leaders" (les segments qui relient les chips aux features de la map : home, soleil, dôme nuageux), les chips de météo (sun, cloud), la silhouette du toit. Ces overlays sont projetés à chaque frame par l'engine et la card les anime via SMIL ou CSS keyframes.

### src/card/lidar-view.ts

Toggle de la vue LiDAR. Anime le crossfade entre la map normale et la nuée de points.

### src/card/shadingDome.ts

Toggle du dôme céleste qui affiche la shading map. Animation entrée / sortie, slider de cloud cover.

### src/card/shadingMapView.ts

Vue éditeur de la shading map (heatmap polaire). Section avancée de l'éditeur. Pas dans l'UI principale de la card.

### src/card/shadingTrainer.ts

Boucle qui rejoue le modèle PV sur les N derniers jours et accumule les résidus par cellule (sun azimuth × altitude × cloud) dans la shading map persistée. Tourne en background, idle-deferred.

### src/card/loading-tracker.ts

Suivi des phases de chargement initial. Chaque fetch (PV history, battery history, grid history, weather, energy prefs, buildings, LiDAR) appelle `beginLoadingPhase(host, id)` et `endLoadingPhase(host, id)`. Quand toutes les phases sont terminées une première fois, la barre de progression se cache pour de bon.

### src/card/card-mode.ts

L'enum `CardMode` ('base' | 'lidar' | 'shadingDome' | 'dashboard'). Une seule source de vérité pour les transitions de mode, remplace l'ancien couple de booleans.

### src/card/ws-timeout.ts

Wrapper autour de `hass.callWS` qui abort le promise après un timeout. Évite que les fetch d'historique restent pendus si le recorder est saturé.

### src/card/format.ts

Helpers de formatage (nombres localisés, hex color manipulations) partagés entre la card et l'éditeur.

### src/card/cloud-icons.ts

Mapping cloud cover (%) -> nom d'icône MDI ('weather-sunny', 'weather-partly-cloudy', etc.).


## 8. La couche engine, fichiers src/engine/

Fonctions pures sauf indication contraire. Aucune ne dépend de Lit, du DOM, ou de Home Assistant.

### src/engine/sun.ts

Math de position du soleil. Validé contre NOAA SPA (Solar Position Algorithm) : erreur moyenne 0.3° en altitude et azimut. Exporte :

- `getSunPosition(date, lat, lon)` : retourne `{ altitudeDeg, azimuthDeg }`.
- `computePvPower(config, sunAlt, sunAz, cloudPct)` : modèle PV single array.
- `computePvPowerWeighted(...)` : version multi-arrays avec pondération par kWp ou share.
- `computeIrradianceWm2(sunAlt, cloudPct)` : irradiance estimée W/m² (modèle clear-sky avec atténuation cloud).
- Diverses constantes de référence (constantes de Liu-Jordan, etc.).

### src/engine/weather.ts

Open-Meteo + cache navigateur. Gère :

- `fetchHomePointData(lat, lon, opts)` : fetch unique pour 30 jours passés + 2 jours futurs.
- Inflight dedup (deux call sites simultanés partagent un seul roundtrip réseau).
- Cache localStorage avec TTL 45 min, key arrondi à 3 décimales de lat / lon (~110 m de granularité).
- Back-off graduel sur erreur 429 (rate limit) ou erreurs réseau.
- `getWeatherFetchStats()` : compteurs (cacheHits / networkFetches / inflightDedups / rateLimit429 / otherErrors) pour debug.

### src/engine/shadows.ts

`projectExtrusionShadows(features, opts)` : pour chaque polygon batiment, projette ses sommets dans la direction opposée du soleil à `hauteur / tan(altitude)` mètres, retourne le convex hull (footprint + projection) comme polygon GeoJSON. C'est l'enveloppe au sol de l'ombre. La 3D extrusion de la map cache la moitié sous le batiment lui-meme, le reste est l'ombre projetée.

### src/engine/shadow-raster.ts

Rasterise les polygons d'ombre sur un canvas offscreen avec fill-rule="evenodd", applique le radial fade-out depuis le home, pousse le PNG résultat dans la source MapLibre `helios-building-shadows-src`. Exporte :

- `paintShadowRaster(map, canvas, features, corners, radius, fadeFullM, fadeOutM)`.
- `shadowRasterSizeFor(level)` : taille canvas en fonction de `lidar-precision`.
- `shadowBoundsCornersLL(homeLat, homeLon, radiusM)` : 4 coins lon/lat de l'image source.

### src/engine/lighting.ts

Phases jour / nuit. Pure fonctions de l'altitude solaire :

- `nightShadeForAltitude(alt)` : opacité de l'overlay nuit (0 le jour, 0.6 la nuit).
- `buildingColorForAltitude(alt, baseColor)` : tint des bâtiments selon l'heure (bleuté la nuit, doré au coucher).
- `sunLightPolarFromAltitude(alt)` : angle polaire MapLibre setLight (clamped à 89° près de l'horizon).

### src/engine/auto-rotate.ts

Boucle d'auto-rotation. La caméra tourne lentement (~1.5°/s) dans le sens opposé du soleil. `startAutoRotateLoop(engine)` retourne un teardown function. Mise en pause automatique sur drag utilisateur et reprise après idle.

### src/engine/detail-mode.ts

Transitions caméra entre vue normale (top-down 55°) et detail mode (zoomé + pitched à ~40°). Easing identique à l'entrée et à la sortie pour que la transition soit symétrique.

### src/engine/camera-bounds.ts

Constants `CAMERA_PITCH_MIN_DEG = 30`, `MAX = 85`, `REST = 55`. Une seule source de vérité, importée partout où la caméra peut bouger (MapLibre constructeur, slider editor, drag handler, detail dive).

### src/engine/buildings.ts

Self-sourced building footprints. Au lieu de laisser MapLibre afficher TOUS les bâtiments visible, Helios télécharge directement les tuiles vectorielles OpenFreeMap pour le rayon défini, décode avec @mapbox/vector-tile, extrait les polygons bâtiment, identifie le ou les polygons "home" (par proximité au home point), et émet 2 FeatureCollection : `home` et `surroundings`. Cache une fois fetched, ne re-fetch que si home ou rayon change.

### src/engine/lidar-view-layer.ts

Layer MapLibre custom (WebGL) pour la nuée de points LiDAR. Implémente l'interface `CustomLayerInterface` :

- `onAdd(map, gl)` : compile les shaders, alloue les buffers GPU.
- `setRaster(raster)` : upload les positions des cellules (lon, lat, hauteur) au GPU une fois.
- `render(gl, options)` : un seul `drawArrays(POINTS)` par frame avec la matrice caméra.

Beaucoup plus performant que l'ancien pipeline canvas 2D qui plafonnait à quelques centaines de milliers de points.

### src/engine/pv-shading.ts

Pour chaque cellule LiDAR autour de la maison, projette un rayon dans la direction du soleil et regarde si une cellule plus haute le bloque. Si oui, la cellule est "shaded" à cet instant. `computeLidarCellExposureRows` : retourne le tableau par cellule pour le forecast PV. Utilisé par le shading trainer pour affiner le modèle.

### src/engine/pv-thermal.ts

Derating thermique. À 60°C de cellule (typique sur toit sud en été), la production tombe de ~15%. `cellTemperatureFromAmbient(ambientC, irradianceWm2, windMs)` calcule la température cellule. `powerFactorFromCellTemp(tempC)` retourne le multiplicateur (0.85 à 60°C).

### src/engine/shadingMap.ts

Le moteur de la shading map (la carte d'ombres apprises). Stockage `localStorage`, accumulation par cellule (sun azimuth × altitude × cloud bin), résidus, half-life decay sur 60 jours.

- `trainShadingMap(map, opts)` : ajoute une observation.
- `currentShadingMap()` : récupère le map persisté.
- `effectiveShadingRatio(map, sunAz, sunAlt, cloudPct)` : retourne le facteur à appliquer (de 0 = totalement masqué à 1.5 = sur-estimé).
- Export / import JSON pour debug.


## 9. Le module LiDAR

C'est le sous-système le plus complexe d'Helios, isolé sous `src/engine/lidar/`. ~3350 lignes.

### Vue d'ensemble

Helios utilise les données LiDAR publiées par les agences nationales pour calculer des ombres précises qui incluent la végétation. Le format reçu varie selon le pays :

- France : IGN HD au format ASC (ascii grid), reproject EPSG:2154 → WGS84.
- Pays-Bas : AHN au format GeoTIFF.
- Belgique (Flandre, Wallonie) : GeoTIFF.
- Allemagne (NRW, BW, BB-BE) : GeoTIFF ou ASC selon Land.
- Suisse : pas natif, l'utilisateur peut fournir son propre nDSM (BYO).
- USA : 3DEP, GeoTIFF.
- ... etc.

Chaque provider est un fichier sous `src/engine/lidar/providers/`. Tous implémentent la même interface `LidarSource`.

### Interface LidarSource

```ts
export interface LidarSource
{
    name: string;
    covers(lat: number, lon: number): boolean;
    fetchRaster(opts: FetchOpts): Promise<RasterResult | null>;
}
```

`covers()` est un check géographique (bbox du pays / région). `fetchRaster()` télécharge et reprojette la zone autour du home en un raster de hauteur en mètres au-dessus du sol (le "nDSM").

### Le pipeline shared

Tous les providers convergent vers `engine/lidar/pipeline.ts` qui :

1. télécharge les tuiles natives du pays,
2. reproject vers WGS84 EPSG:4326 si nécessaire (via `proj.ts`),
3. clip au rayon de display autour du home,
4. retourne un `RasterResult` standard :

```ts
interface RasterResult
{
    cells: Float32Array;       // hauteur en m, longueur = width × height
    width: number;
    height: number;
    minLat, maxLat, minLon, maxLon: number;
    resMeters: number;         // résolution au sol (souvent 1 m)
}
```

### resolveLidarSource

`src/engine/lidar.ts:resolveLidarSource(lat, lon, opts)` itère sur `LIDAR_SOURCES` (un array ordonné de tous les providers + l'éventuel BYO local-nDSM) et retourne le premier qui `covers(lat, lon)` retourne true. L'ordre matter : un BYO local doit passer AVANT les providers publics pour permettre un override utilisateur.

### Le BYO local nDSM

Pour les utilisateurs hors couverture des providers publics, Helios accepte un fichier GeoTIFF local hébergé sur leur Home Assistant (`/local/...`). Configuration via `lidar-local-ndsm-*` keys. La logique vit dans `engine/lidar/local-ndsm.ts`. Un site companion [helios-lidar.org](https://helios-lidar.org) aide les utilisateurs à produire ce fichier depuis leurs LAS / LAZ ou DSM + DTM bruts.

### Le proxy proxy.ts

Certains providers refusent CORS depuis le navigateur. Helios route ces fetches via un proxy gratuit (helios-lidar.org/proxy/) qui ajoute les headers CORS. Fichier `proxy.ts` : 47 lignes, juste l'URL builder et le check de health.


## 10. Internationalisation, i18n

### Architecture

`src/i18n/index.ts` déclare l'interface `Translations` (le contract de keys). 64 fichiers `src/i18n/locales/*.ts` implémentent chacun une locale. Chaque locale est un `Translations` object avec toutes les keys traduites.

### Fallback

`pickTranslations(haLang)` retourne le dictionnaire de la langue HA active, fall-back sur 'en'. Si une key est manquante dans la locale active, le rendu utilise `??` pour fall-back sur l'anglais. C'est utile pour les keys récentes pas encore traduites partout.

### Sections

- `cardName`, `cardDescription` : utilisés par le catalogue de cards HA.
- `detail.*` : labels du dashboard CoverFlow + chips.
- `editor.*` : tous les labels et hints de l'éditeur visuel (le plus gros bloc).


## 11. Styles CSS

### Architecture

Tout le CSS est dans `src/css/helios-card-css.ts` (~3000 lignes) et `src/css/helios-card-editor-css.ts`. Pas de classes / modules CSS séparés : un seul gros `css` tagged template literal exporté pour chaque fichier, importé dans la card / éditeur respective via `static styles = [heliosCardStyles]`.

### Tokens HA frontend

Les couleurs et typographie tirent au maximum sur les CSS custom properties que Home Assistant publie :

- `--primary-text-color`, `--secondary-text-color`,
- `--ha-card-background`, `--ha-card-border-color`, `--ha-card-border-radius`,
- `--ha-font-family-body`, `--ha-font-size-s`, `--ha-font-weight-medium`,
- `--energy-solar-color`, `--energy-battery-in-color`, `--energy-grid-consumption-color`, etc.

Cela permet à Helios de tracker automatiquement le thème actif de l'utilisateur (Mushroom, Material You, etc.) sans qu'on doive coder par thème.

### Theme detection

Pour les overrides spécifiques light vs dark (au-delà de ce que les CSS tokens gèrent), Helios écoute la classe `theme-dark` apposée par HA sur l'outer ha-card. Les overrides utilisent des sélecteurs comme :

```css
ha-card.theme-dark .my-class { ... }
ha-card:not(.theme-dark) .my-class { ... }
```


## 12. Flux de données complet

Schéma simplifié d'une frame typique :

```
┌────────────────────┐
│ Home Assistant     │
│  hass.states       │
│  hass.callWS       │
│  hass.connection   │  ← subscribeMessage('energy_preferences_updated')
└────────────┬───────┘
             │ poll régulier (tick toutes ~30 s)
             ▼
┌─────────────────────────────────────────────────┐
│ helios-card.ts (HeliosCard, Lit element)        │
│  - @state _pvLiveValue, _batteryLive, _grid*    │ ◄── refreshPv / refreshBattery /
│  - @state _now, _selectedTime                   │     refreshGrid (src/card/*.ts)
│  - @state _chartSeries (30 j historique météo)  │ ◄── _engine.weatherSeries
│  - @state _pvHistory, _batteryHistory, _grid*   │ ◄── fetchPvHistory (etc) via ws-timeout
└────────────┬────────────────────────────────────┘
             │ requestUpdate sur change
             ▼
┌─────────────────────────────────────────────────┐
│ render() → assemble HTML / SVG                  │
│  - chips, leaders, arcs, dôme nuageux           │
│  - timeline + charts (src/card/charts.ts)       │
│  - mode-bar, LiDAR view, shading dome           │
│  - dashboard CoverFlow + radial sundial         │
└────────────┬────────────────────────────────────┘
             │ Lit reconcile DOM
             ▼
┌─────────────────────────────────────────────────┐
│ helios-engine.ts (HeliosEngine, classe)         │
│  - map MapLibre, sources, layers                │ ◄── alimentée par
│  - sun arc samples, cloud dome polys            │     - engine/sun.ts (math)
│  - shadow raster                                │     - engine/weather.ts (météo)
│  - LiDAR view layer (WebGL custom)              │     - engine/shadows.ts
│  - hooks vers la card (onFetchStart, etc.)      │     - engine/lidar/* (LiDAR)
└─────────────────────────────────────────────────┘
```

### Cas pratique : le chip "production live"

```
1. HA push un event state_changed sur l'entité PV.
2. Helios écoute via le hooks HA standard (changement détecté via the
   updated() Lit hook qui voit que hass est différent).
3. refreshPv(this) est appelé depuis le tick loop ou le setHass override.
4. Il relit hass.states[pvEntityId], le normalise via pvNormalizeToWatts,
   stocke dans this._pvLiveValue.
5. Lit re-render. Dans render(), le chip "Production live" lit
   this._pvLiveValue, formate avec formatPvValue, l'affiche.
```


## 13. Cycle de vie de la card

Une vue d'ensemble étape par étape, du moment où HA instantie la card jusqu'à l'utilisation interactive :

### Phase 1 : instantiation

```
1. HA voit <helios-card> dans le dashboard YAML.
2. Le navigateur instantie la classe HeliosCard via le custom element registry.
3. Lit alloue tous les @state à leur valeur par défaut (null, [], 0, etc.).
4. constructor() exécute (vide).
```

### Phase 2 : setConfig

```
5. HA appelle helios.setConfig(yamlConfig) avec l'objet parsé du YAML.
6. setConfig valide chaque clé (helios-config.ts), normalise, stocke dans
   this.config.
7. Le hash de config est calculé (init.ts). Si l'engine existait déjà et
   que le hash a changé, l'engine est détruit puis reconstruit.
8. La migration des clés legacy fire un persistent_notification une seule fois.
```

### Phase 3 : connectedCallback (DOM mount)

```
9. La card est attachée au DOM.
10. connectedCallback() s'exécute :
    - attache les listeners (HA events, scroll observer, visibility).
    - subscribe à energy_preferences_updated.
    - démarre le tick loop (timeline.ts).
    - démarre l'IntersectionObserver pour pause/resume animations.
```

### Phase 4 : firstUpdated (rendu initial)

```
11. Lit appelle render() pour la première fois.
12. Le HTML est inséré dans le shadow DOM.
13. firstUpdated() s'exécute :
    - récupère le <div id="map-container"> du shadow DOM,
    - construit new HeliosEngine(mapContainer, config, hooks),
    - attache l'engine à this._engine.
14. L'engine commence sa propre boucle :
    - crée la map MapLibre,
    - charge le style OpenFreeMap,
    - fetch weather (en parallèle),
    - fetch buildings (en parallèle),
    - fetch LiDAR si provider couvre (en parallèle).
15. Chaque fetch appelle un hook onFetchStart / onFetchEnd qui pilote la
    progression de la barre de loading (loading-tracker.ts).
```

### Phase 5 : steady state

```
16. Tick (toutes les ~30 s en mode chips, plus rapide en scrub) :
    - advance _now,
    - relit hass.states pour les chips live,
    - engine.refreshSunPose() projette le soleil,
    - engine.refreshClouds() projette le dôme nuageux,
    - engine.refreshShadows() recalcule les ombres si sun altitude a bougé.
17. Re-render Lit, chips et overlays s'actualisent.
```

### Phase 6 : interactions utilisateur

```
18. Click sur la maison : ouvre le dashboard CoverFlow (dashboard.ts).
19. Click sur la mode bar : change le CardMode, anime le crossfade.
20. Drag sur la timeline : sets _selectedTime, _isLiveMode = false,
    engine.setSelectedTime(date) pour re-projeter les overlays au passé.
21. Drag sur la carte : MapLibre gère, auto-rotate se met en pause.
```

### Phase 7 : disconnectedCallback (teardown)

```
22. La card est détachée du DOM (utilisateur change de dashboard, etc.).
23. disconnectedCallback() s'exécute :
    - clearInterval du tick loop,
    - unsubscribe des HA events,
    - engine.destroy() (libère la map, les buffers WebGL, etc.),
    - removeObserver de l'IntersectionObserver.
```


## 14. Conventions de code

Quelques conventions transverses utiles à connaître.

### Allman braces

Helios écrit les braces sur la ligne suivante :

```ts
function foo()
{
    if (cond)
    {
        bar();
    }
}
```

Y compris pour les bodies single-line et les blocks vides. C'est imposé pour cohérence.

### Pas d'em-dash

Le caractère em-dash `—` n'apparait pas dans les commentaires ou la doc parce qu'il "fait" généré par IA. Toujours remplacé par une virgule ou un colon.

### Pas de version dans les commentaires

Les commentaires décrivent le code COURANT. Pas de "since beta.12", pas de "previous behavior was...". L'historique vit dans les commits.

### Comments expliquent le POURQUOI

Pas le QUOI (les identifiants bien nommés suffisent). On commente quand il y a une contrainte cachée, un invariant subtil, un workaround pour un bug spécifique. Quand on peut retirer un commentaire sans qu'un futur lecteur soit confus, on le retire.

### Pas de magic numbers

Les constantes sont nommées et exportées depuis `helios-config.ts` ou `camera-bounds.ts` ou un module dédié, pour qu'un changement se propage à tous les call sites.

### Pas de console.log

Les diagnostics utilisateurs sont `console.warn` ou `console.info` avec un préfixe `[helios.X]`, gated par un one-shot latch pour ne pas spam la console.

### Tests

Helios n'a presque pas de tests unitaires (le projet est dominé par le rendu visuel, difficile à tester sans navigateur). Le filet de sécurité est :

- `npm run typecheck` (strict TypeScript),
- `npm run build` (Vite + Terser),
- tests visuels manuels sur HACS avant le tag final.

Quelques fixtures et tests existent dans `tests/` pour les modules engine pure-function (notamment sun.ts contre NOAA SPA), mais ce n'est pas systématique.

---

C'est tout. Pour les détails de chaque fonction, ouvre le fichier concerné : les headers des modules contiennent un résumé de leur rôle, et les fonctions principales ont des docstrings de plusieurs lignes qui expliquent le contexte et les contraintes. Bonne exploration.
