//Environment Agency LiDAR Composite shadow source for England.
//
//Defra exposes the national LiDAR Composite as two separate WMS
//services: a Digital Surface Model (DSM, includes vegetation +
//buildings) and a Digital Terrain Model (DTM, bare ground only). We
//fetch both and subtract per pixel to produce a height-above-ground
//raster, which the shared pipeline then consolidates into shadow
//polygons.
//
//Both endpoints serve image/tiff (Float32 GeoTIFF). CRS:84 (=
//EPSG:4326 with lon-lat axis order) is supported by the elevation
//layers, so we pin to that and avoid any reprojection bookkeeping.
//
//Coverage: ~99 % of England. The DSM service does NOT cover Wales,
//Scotland or Northern Ireland; we bbox-clip on the English-mainland
//rectangle, with a few-degree pad for the eastern English coast and
//Lundy.

import type {
    LidarSource,
    LidarShadowFetchOptions,
    LidarShadowResult
} from '../../lidar';
import { processHeightRaster, homeBbox, emptyResult, RASTER_DEFAULTS } from '../pipeline';
import { fetchFloat32GeoTiff, subtractRasters } from '../geotiff';

const DSM_URL = 'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-surface-model-last-return-dsm-1m-2022/wms';
const DTM_URL = 'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wms';
const DSM_LAYER = 'Lidar_Composite_Elevation_LZ_DSM_1m';
const DTM_LAYER = 'Lidar_Composite_Elevation_DTM_1m';

//Coverage of the English LiDAR Composite. Wider than England's
//geopolitical extent on purpose (Cornwall west tip, Northumberland
//east coast, Channel Islands) so home points right on the edge still
//probe.
const UK_BBOX = { minLat: 49.7, maxLat: 56.0, minLon: -7.2, maxLon: 2.1 };

export const englandLidarComposite: LidarSource =
{
    id:   'uk-defra-lidar-composite',
    name: 'Environment Agency LiDAR Composite (England)',
    //Defra LiDAR Composite DSM / DTM are published on a 1 m grid.
    nativeCellPitchMeters: 1.0,

    covers(lat: number, lon: number): boolean
    {
        return lat >= UK_BBOX.minLat && lat <= UK_BBOX.maxLat
            && lon >= UK_BBOX.minLon && lon <= UK_BBOX.maxLon;
    },

    async fetchShadowRegions(opts: LidarShadowFetchOptions): Promise<LidarShadowResult>
    {
        const rasterSize = Math.min(RASTER_DEFAULTS.maxRasterSize,
            Math.max(RASTER_DEFAULTS.minRasterSize, Math.round(opts.rasterSize)));

        const bbox = homeBbox(opts.homeLat, opts.homeLon, opts.radiusMeters,
            RASTER_DEFAULTS.bboxPadFactor);

        if (bbox.maxLat < UK_BBOX.minLat || bbox.minLat > UK_BBOX.maxLat
         || bbox.maxLon < UK_BBOX.minLon || bbox.minLon > UK_BBOX.maxLon)
        {
            return emptyResult();
        }

        //CRS:84 is EPSG:4326 with lon,lat axis order, no axis flip
        //needed in the BBOX string. Defra advertises both EPSG:27700
        //(British National Grid) and CRS:84 on the elevation layers.
        const buildUrl = (base: string, layer: string): string =>
        {
            const params = new URLSearchParams({
                SERVICE: 'WMS',
                VERSION: '1.3.0',
                REQUEST: 'GetMap',
                LAYERS:  layer,
                STYLES:  '',
                CRS:     'CRS:84',
                BBOX:    `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`,
                WIDTH:   String(rasterSize),
                HEIGHT:  String(rasterSize),
                FORMAT:  'image/tiff'
            });
            return `${base}?${params.toString()}`;
        };

        //Fire DSM and DTM requests in parallel; both must succeed for
        //the subtraction to mean anything.
        const [dsm, dtm] = await Promise.all([
            fetchFloat32GeoTiff(buildUrl(DSM_URL, DSM_LAYER), rasterSize, opts.signal),
            fetchFloat32GeoTiff(buildUrl(DTM_URL, DTM_LAYER), rasterSize, opts.signal)
        ]);
        if (!dsm || !dtm)
        {
            return emptyResult();
        }

        const heights = subtractRasters(dsm, dtm);

        return processHeightRaster(heights, {
            rasterSize,
            minLat:           bbox.minLat,
            maxLat:           bbox.maxLat,
            minLon:           bbox.minLon,
            maxLon:           bbox.maxLon,
            homeLat:          opts.homeLat,
            homeLon:          opts.homeLon,
            cropRadiusMeters: opts.cropRadiusMeters
        });
    }
};
