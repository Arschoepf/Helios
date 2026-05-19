# Helios LiDAR provider registry

This page tracks every public elevation / LiDAR data source we have
inspected for Helios, with status, format, endpoint and an example
fetch URL ready to paste in a browser. Use it to:

- See which countries / regions are integrated today.
- Find what would unlock if a parked provider gets the missing piece
  (an open WCS endpoint, a CORS-friendly raster format, etc.).
- Spot a candidate worth turning into a new provider, the
  integration cost is one focused file under
  `src/engine/lidar/providers/`.

For requirements, see the
[Provider compatibility checklist](#provider-compatibility-checklist)
at the bottom.

---

## Status legend

| Symbol | Meaning |
| :---: | :--- |
| 🟢 | **Integrated**, ships in Helios as a native provider |
| 🟡 | **Compatible**, public raw-float endpoint verified, integration pending |
| 🟠 | **Partial**, data exists but a blocker (auth, format, projection) needs work |
| 🔴 | **Incompatible**, no usable public endpoint today |

---

## 🟢 Integrated providers

| Country | Region | API name | Population | Format | CRS | Endpoint | Example fetch URL |
|:--|:--|:--|--:|:--|:--|:--|:--|
| 🇫🇷 France | Metropolitan + Corsica | IGN LiDAR HD (MNH WMS) | ~68 M | BIL Float32 | EPSG:4326 | `data.geopf.fr/wms-r/wms` | [Paris 1 km²](https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES&CRS=EPSG:4326&BBOX=48.85,2.345,48.86,2.355&WIDTH=256&HEIGHT=256&FORMAT=image/x-bil;bits=32&STYLES=) |
| 🇬🇧 England | All England | Environment Agency LiDAR Composite (DSM + DTM) | ~57 M | GeoTIFF Float32 (two coverages, subtracted client-side) | EPSG:27700 | `environment.data.gov.uk/spatialdata/lidar-composite-first-return-digital-surface-model-fz-dsm-1m/wcs` | [London 1 km²](https://environment.data.gov.uk/spatialdata/lidar-composite-first-return-digital-surface-model-fz-dsm-1m/wcs?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=Lidar_Composite_FZ_DSM_2022_1m__27700&FORMAT=image/tiff&SUBSETTINGCRS=http://www.opengis.net/def/crs/EPSG/0/4326&SUBSET=Long(-0.13,-0.12)&SUBSET=Lat(51.50,51.51)&SCALESIZE=Long(256),Lat(256)) |
| 🇪🇸 Spain | Peninsular + Balearics | IGN España PNOA-LiDAR MDSn (vegetation + buildings merged via MAX) | ~46 M | GeoTIFF Float32 (two coverages) | EPSG:4326 | `wms-mds-2-cobertura.idee.es/mds-2-cobertura` | [Madrid 1 km²](https://wms-mds-2-cobertura.idee.es/mds-2-cobertura?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=MDSn-2-cobertura-1&CRS=EPSG:4326&BBOX=40.41,-3.71,40.42,-3.70&WIDTH=256&HEIGHT=256&FORMAT=image/tiff&STYLES=) |
| 🇳🇱 Netherlands | Mainland | PDOK AHN4 (DSM + DTM) | ~17 M | GeoTIFF Float32 (two coverages, subtracted client-side) | EPSG:28992 | `service.pdok.nl/rws/ahn/wcs/v1_0` | [Amsterdam 1 km²](https://service.pdok.nl/rws/ahn/wcs/v1_0?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=dsm_05m&FORMAT=image/tiff&SUBSETTINGCRS=http://www.opengis.net/def/crs/EPSG/0/4326&SUBSET=Long(4.89,4.90)&SUBSET=Lat(52.37,52.38)&SCALESIZE=Long(256),Lat(256)) |
| 🇳🇴 Norway | Mainland + Svalbard | Kartverket NHM (DOM + DTM) | ~5.5 M | ArcGIS Float32 GeoTIFF | EPSG:25833 | `services.geonorge.no/arcgis/services/hoyde/nhm_dom_25833/MapServer/WCSServer` | [Oslo 1 km²](https://services.geonorge.no/arcgis/services/hoyde/nhm_dom_25833/MapServer/WCSServer?SERVICE=WCS&VERSION=1.1.1&REQUEST=GetCoverage&IDENTIFIER=1&FORMAT=image/tiff&BOUNDINGBOX=10.74,59.91,10.75,59.92,urn:ogc:def:crs:EPSG::4326&GRIDBASECRS=urn:ogc:def:crs:EPSG::4326&GRIDCS=urn:ogc:def:cs:OGC:0.0:Grid2dSquareCS&GRIDTYPE=urn:ogc:def:method:WCS:1.1:2dGridIn2dCrs&GRIDOFFSETS=0.0001,-0.0001) |
| 🇩🇪 Germany (NRW) | Nordrhein-Westfalen | Geobasis NRW nDOM | ~18 M | GeoTIFF Float32 single-band | EPSG:4326 | `www.wcs.nrw.de/geobasis/wcs_nw_ndom` | [Cologne 1 km²](https://www.wcs.nrw.de/geobasis/wcs_nw_ndom?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=nw_ndom&FORMAT=image/tiff&SUBSETTINGCRS=http://www.opengis.net/def/crs/EPSG/0/4326&SUBSET=Long(6.95,6.96)&SUBSET=Lat(50.93,50.94)&SCALESIZE=Long(256),Lat(256)) |
| 🇵🇱 Poland | National | GUGiK NMPT (DSM) | ~38 M | image/tiff via WCS 2.0.1 | EPSG:4326 native | `mapy.geoportal.gov.pl/wss/service/PZGIK/NMPT/GRID1/WCS/DigitalSurfaceModel` | [Warsaw 1 km²](https://mapy.geoportal.gov.pl/wss/service/PZGIK/NMPT/GRID1/WCS/DigitalSurfaceModel?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=DSM_PL-EVRF2007-NH&FORMAT=image/tiff&SUBSETTINGCRS=http://www.opengis.net/def/crs/EPSG/0/4326&SUBSET=Long(21.00,21.01)&SUBSET=Lat(52.23,52.24)&SCALESIZE=Long(256),Lat(256)) |
| 🇨🇦 Canada | National (south 1-2 m, north satellite) | NRCan HRDEM Mosaic (DSM + DTM) | ~38 M | GeoTIFF via WCS 1.1.1 | EPSG:4326 | `datacube.services.geo.ca/ows/elevation` | [Toronto 1 km²](https://datacube.services.geo.ca/ows/elevation?SERVICE=WCS&VERSION=1.1.1&REQUEST=GetCoverage&IDENTIFIER=dsm-mosaic&FORMAT=image/tiff&BOUNDINGBOX=43.65,-79.39,43.66,-79.38,urn:ogc:def:crs:EPSG::4326&GRIDBASECRS=urn:ogc:def:crs:EPSG::4326&GRIDCS=urn:ogc:def:cs:OGC:0.0:Grid2dSquareCS&GRIDTYPE=urn:ogc:def:method:WCS:1.1:2dGridIn2dCrs&GRIDOFFSETS=0.0001,-0.0001) |
| 🇦🇹 Austria | Styria (Steiermark) | Land Steiermark ALS DOM + DGM 1 m | ~1.2 M | GeoTIFF Float32 via WCS 2.0.1 (DSM - DTM subtracted) | EPSG:32633 + 4326 | `gis.stmk.gv.at/arcgis/services/OGD/ALSHoeheninformation_1m_UTM33N/MapServer/WCSServer` and `.../OGD/ALSGelaendeinformation_1m_UTM33N/MapServer/WCSServer` | [Graz 1 km² DSM](https://gis.stmk.gv.at/arcgis/services/OGD/ALSHoeheninformation_1m_UTM33N/MapServer/WCSServer?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=Coverage4&FORMAT=image/tiff&SUBSETTINGCRS=http://www.opengis.net/def/crs/EPSG/0/4326&SUBSET=Lat(47.06,47.07)&SUBSET=Long(15.43,15.44)&SCALESIZE=Lat(256),Long(256)) |

**Bring your own (BYO) provider** (shipping today, drops in as a
zero-code override): the six `lidar-local-ndsm-*` config keys point
Helios at a user-hosted nDSM GeoTIFF inside a user-defined bounding
box. Useful in any region with raw LiDAR data available offline,
initial use case New South Wales Australia. Contributed by
[@jourdant](https://github.com/jourdant) in
[PR #5](https://github.com/ReikanYsora/Helios/pull/5), idea credited
to [@stephenwq](https://github.com/stephenwq).

---

## 🟡 Verified compatible, not yet integrated

| Country | Region | API name | Population | Format | CRS | Endpoint | Example fetch URL | Why parked |
|:--|:--|:--|--:|:--|:--|:--|:--|:--|
| 🇩🇪 Germany (Sachsen-Anhalt) | Sachsen-Anhalt | LVermGeo DOM1 (statewide) | ~2.2 M | GeoTIFF Float32 LZW (NoData -9999) via WCS | EPSG:25832 | `www.geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_DOM1_WCS_OpenData/guest` | n/a, GetCapabilities currently returns HTTP 500 from the lab network | LVermGeo documentation confirms the WCS exists and the file format profile (Float32 LZW, EPSG:25832, NoData -9999) but the endpoint was unreachable at audit time. Ships once the endpoint stabilises or the documented URL is corrected. |
| 🇨🇿 Czech Republic | National (~60% coverage) | ČÚZK DMR 5G via INSPIRE WCS | ~10.5 M | GeoTIFF + GML via WCS 2.0.1 | ETRS89/TM33 (EPSG:3045) | `ags.cuzk.gov.cz/arcgis2/services/INSPIRE_Nadmorska_vyska/ImageServer/WCSServer` | [Prague 1 km²](https://ags.cuzk.gov.cz/arcgis2/services/INSPIRE_Nadmorska_vyska/ImageServer/WCSServer?SERVICE=WCS&VERSION=1.1.1&REQUEST=GetCoverage&IDENTIFIER=1&FORMAT=image/tiff&BOUNDINGBOX=14.42,50.08,14.43,50.09,urn:ogc:def:crs:EPSG::4326&GRIDBASECRS=urn:ogc:def:crs:EPSG::4326&GRIDCS=urn:ogc:def:cs:OGC:0.0:Grid2dSquareCS&GRIDTYPE=urn:ogc:def:method:WCS:1.1:2dGridIn2dCrs&GRIDOFFSETS=0.0001,-0.0001) | INSPIRE service publishes DMR (terrain) only, not DMP (surface). The DMP 1G exists as a separate ZABAGED product but not on this WCS. |
| 🇨🇭 Switzerland | National + Liechtenstein | swisstopo swissSURFACE3D Raster (DSM) | ~9 M | Cloud Optimized GeoTIFF (COG) via STAC API | EPSG:2056 (LV95) | `data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisssurface3d-raster` | [STAC search example](https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisssurface3d-raster/items?bbox=8.54,47.36,8.55,47.37) | STAC pattern, no live WCS. Needs a STAC client (tile picker, sign URLs) on top of the existing GeoTIFF fetcher. |
| 🇪🇪 Estonia | National | Maa-amet DSM 1 m | ~1.3 M | GeoTIFF | EPSG:3301 (Estonian) | `geoportaal.maaamet.ee/url/xgis-ky.php?ky=DOM` (download UI) | n/a, no documented WCS endpoint yet | WMS / WMTS confirmed public, WCS metadata referenced but exact endpoint not yet located; needs a Maa-amet contact. |
| 🇳🇿 New Zealand | National | LINZ National Elevation 1 m (DEM + DSM) | ~5.2 M | Cloud Optimized GeoTIFF (LERC) via LINZ Data Service | EPSG:2193 (NZTM2000) | `data.linz.govt.nz` (Koordinates) | Requires per-user API key under user profile | API key behind a free Koordinates account, same friction profile as Denmark, easy to add but ships behind a `linz-api-key` config field. |
| 🇩🇰 Denmark | National | Dataforsyningen DHM (DTM + DSM) | ~5.9 M | GeoTIFF, 0.4 m | EPSG:25832 | `dataforsyningen.dk` REST API | Requires free account API key | Same shape as LINZ, opt-in API key, would ship behind a `dataforsyningen-api-key` config field. |
| 🇨🇦 Canada (alt) | National | NRCan HRDEM 1 m tiles (direct GeoTIFF download) | ~38 M | GeoTIFF Float32 | UTM NAD83 CSRS | `ftp.maps.canada.ca/pub/elevation/dem_mne/highresolution_hauteresolution/` | n/a, FTP tile index | Alternative path to the HRDEM Mosaic WCS, mentioned for completeness. |

---

## 🟠 Probed, partially compatible

| Country | Region | API name | Population | Format | CRS | Endpoint | Example fetch URL | Blocker |
|:--|:--|:--|--:|:--|:--|:--|:--|:--|
| 🇦🇺 Australia | New South Wales | NSW Spatial Services 5 m Elevation | ~8.2 M (NSW) | ArcGIS exportImage Float32 TIFF | EPSG:3857 + 4326 | `maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_5M_Elevation/ImageServer` | [Sydney 1 km²](https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_5M_Elevation/ImageServer/exportImage?bbox=151.20,-33.87,151.21,-33.86&bboxSR=4326&imageSR=4326&size=256,256&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image) | Bare-earth DEM derived from stereo imagery (photogrammetry, 5 m), not a LiDAR DSM. Helios's pipeline expects height-above-ground; the service exposes height-above-sea-level for terrain only, so the threshold flood-fill would never fire. NSW users get the LiDAR DSM today via the BYO local-nDSM path. |
| 🇦🇺 Australia | Federal | Geoscience Australia ELVIS | ~25 M | LAZ point cloud + GeoTIFF tiles | various | `elevation.fsdf.org.au` | per-tile ZIP download UI | Download portal, no live raster query API at federal level. |
| 🇩🇪 Germany (Bayern) | Bavaria | LDBV DOM20 (20 cm DSM!) | ~13 M | GeoTIFF 1 km² tiles | EPSG:25832 | `geodaten.bayern.de/opengeodata/OpenDataDetail.html?pn=dom20` | Bulk download portal, no documented WCS | Bavaria publishes a stunning 20 cm DSM as Open Data but only as bulk tile downloads at the moment. A user-side community contribution would help nail the exact WCS endpoint, if any. |
| 🇩🇪 Germany (Hamburg) | Hamburg | LGV bDOM 1 m | ~1.9 M | ASCII (older) / PNG (2022) tiles | EPSG:25832 | `metaver.de/trefferanzeige?docuuid=2AB332A1-B1B6-4706-9546-33F0B1EADB6D` | Bulk download (3-3.5 GB per year) | Image-based DSM (photogrammetry), only ZIP'd bulk file packages, no live raster query. |
| 🇩🇪 Germany (Hessen) | Hessen | HVBG DOM1 | ~6.3 M | GeoTIFF (download center) | EPSG:25832 | `hvbg.hessen.de/landesvermessung/geotopographie/3d-daten/digitale-oberflaechenmodelle` | Self-service download | Same shape as Bayern: bulk-only via download center, no WCS surfaced. |
| 🇩🇪 Germany (Sachsen) | Sachsen | Freistaat Sachsen DOM1 + nDOM1 | ~4.0 M | LAZ + GeoTIFF tiles | EPSG:25833 | `www.geodaten.sachsen.de/digitale-hoehenmodelle-3994.html` | 2 km × 2 km tile downloads | Open data published as free 2x2 km tiles; no live WCS for DOM. |
| 🇧🇪 Belgium (Wallonia) | Wallonia | SPW LiDAR HD 2021-22 MNS 1 m | ~3.6 M | GeoTIFF | EPSG:3812 (Lambert 08) | `geoportail.wallonie.be/lidar` | WMS serves pre-rendered RGB only, WCS exists but Lambert 08 only | Reprojection from Lambert 08 to WGS84 would need a proj4js bundle (~50 kB gzip), parked until a second non-WGS84 provider justifies the dep. |
| 🇧🇪 Belgium (Flanders) | Vlaanderen | AIV DHMV II DSM | ~6.6 M | Float32 WCS | EPSG:31370 (Lambert 72) only | `agiv.be` | EPSG:31370 only | Same reprojection blocker as Wallonia; both would ship in the same release once proj4js is bundled. |
| 🇫🇮 Finland | National | Maanmittauslaitos Elevation Model 2 m | ~5.6 M | GeoTIFF via WCS 2.0.1 | EPSG:3067 | `avoin-karttakuva.maanmittauslaitos.fi/ortokuvat-ja-korkeusmallit/wcs/v2` | [Helsinki](https://avoin-karttakuva.maanmittauslaitos.fi/ortokuvat-ja-korkeusmallit/wcs/v2?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=korkeusmalli_2m&FORMAT=image/tiff&SUBSETTINGCRS=http://www.opengis.net/def/crs/EPSG/0/4326&SUBSET=E(60.16,60.17)&SUBSET=N(24.93,24.94)) | DTM only (bare earth), no DSM. Captures terrain-shadow geometry but not vegetation / buildings. |

---

## 🔴 Probed, incompatible

| Country | Region | Provider | Reason |
|:--|:--|:--|:--|
| 🇮🇹 Italy | National | Ministero dell'Ambiente PST LiDAR | Access requires signed information request via email (`datipst@mase.gov.it`). No live raster API. |
| 🇸🇪 Sweden | National | Lantmäteriet Laserdata Nedladdning NH / Forest | Published as raw LAZ point clouds only, no pre-rasterised DSM exposed via WCS. |
| 🇯🇵 Japan | National | GSI Fundamental Geospatial Data | Shapefile-only elevation, account signup required, no raster WCS. |
| 🇬🇷 Greece | National | Hellenic Cadastre | LiDAR datasets withheld under security restrictions. |
| 🇨🇭 Switzerland | National (legacy) | swissALTI3D | DTM only (bare earth) since the 2024 LiDAR refresh. Use swissSURFACE3D Raster (above) for DSM coverage. |
| 🇩🇰 Denmark | National | Dataforsyningen anonymous WMS | The anonymous WMS serves pre-rendered hillshade only; raw float DSM is behind an API-key endpoint (listed under 🟡 instead). |
| 🇧🇪 Belgium (Brussels) | Brussels | UrbIS-3D | DSM exists but only as per-municipality LAZ archives. |
| 🇸🇰 Slovakia | National | ZBGIS DMP | DMR (terrain) is GeoTIFF, DMP (surface) is only published as pre-rendered PNG visualisations. |
| 🇺🇸 United States | Federal | USGS 3DEP | Live ArcGIS Image Server exposes bare-earth DEM only. No federal DSM service. |
| 🇺🇸 United States | State (Minnesota) | MN DNR mntopo | Raw LiDAR is per-tile ZIP download only, no live raster API. |
| 🇱🇻 Latvia | National | LGIA Digitālais virsmas modelis | Published as Shapefile-only downloads, no WCS. |
| 🇱🇹 Lithuania | National | NŽT/ŽGP | LiDAR data available, but no public WCS / WMTS for DSM raster surfaced. |
| 🇼 Wales | National | Natural Resources Wales | Per-tile ZIP downloads only, no live raster query endpoint. |
| 🇮🇸 Iceland | National | Landmælingar Íslands | LiDAR programme in progress, no national DSM service yet. |

---

## Provider compatibility checklist

To turn a new region into a Helios native provider it has to clear
all of:

- [ ] **Raw float values exposed** (not a pre-rendered RGB visualisation).
      A raster of metres-above-ground numbers, or a DSM + DTM pair
      whose difference is metres-above-ground.
- [ ] **Live raster query API** (WCS GetCoverage, ArcGIS Image Server
      exportImage, OGC Coverages, STAC + asset URLs). Per-tile ZIP
      downloads or per-tile FTP aren't usable from a browser card.
- [ ] **`image/tiff` Float32** (the helper in
      `src/engine/lidar/geotiff.ts` handles GeoTIFF Float32; BIL is
      supported too).
- [ ] **EPSG:4326 input/output supported natively**, OR a UTM-zone
      projection (we already do the math), OR a willingness to
      bundle proj4js for arbitrary national projections. The current
      ceiling is two reprojection types; if the candidate adds a
      third, we ship proj4js with the next provider batch.
- [ ] **No per-user authentication**. Free open data, optionally
      with an API key the user adds in the editor.
- [ ] **CORS headers** (`Access-Control-Allow-Origin: *` or a
      browser-friendly equivalent). Without them the browser blocks
      the fetch from any HA dashboard not hosted under the data
      provider's own domain.

A provider that misses one box can still ship behind the BYO local
nDSM path (see `lidar-local-ndsm-*` config keys), or wait for the
upstream gap to close, or contribute the reprojection / STAC client
to Helios.

---

## Adding a country

1. Drop a new file at `src/engine/lidar/providers/<iso>.ts`,
   exporting a `LidarSource` (id, name, native cell pitch, `covers()`
   bbox probe, `fetchShadowRegions()` request builder).
2. Register it in `src/engine/lidar.ts`'s `LIDAR_SOURCES` array.
3. Add the country to `LIDAR_PROVIDERS.md` (this file), to the
   integrated table.
4. Update `README.md`'s LiDAR coverage section so users discover the
   new region.
5. Open a PR. The maintainer ships it in the next minor release
   alongside the others.

See `src/engine/lidar/providers/de-nrw.ts` for the canonical
single-coverage example, `src/engine/lidar/providers/uk.ts` for a
DSM-minus-DTM example, and `src/engine/lidar/providers/es.ts` for a
two-coverage MAX merge.
