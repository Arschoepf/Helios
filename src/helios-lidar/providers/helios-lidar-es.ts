//IGN España PNOA-LiDAR shadow source for Spain.
//
//Spain's national IGN exposes the PNOA-LiDAR derivatives through a
//WCS 2.0.1 endpoint at https://wcs-mds.idee.es/mds. Unlike the UK or
//Dutch services, IGN España already publishes pre-computed normalised
//surface models ("MDSn"), the difference between MDS (surface) and
//MDT (terrain), per LiDAR class:
//
//  mdsn_v025 , vegetation height above ground (2.5 m grid)
//  mdsn_e025 , building height above ground (2.5 m grid)
//
//Both rasters cover the entire mainland + Balearics. We fetch both
//and merge them with element-wise MAX, every cell is at most one of
//{vegetation, building, ground}, so the higher of the two pre-
//normalised heights is the right value.
//
//Coverage excludes Canarias (separate WCS at ign.es-canarias). We
//bbox-clip on peninsular Spain + Balearics; Canarias users fall back
//to MapTiler footprint shadows.

import type {
    LidarSource,
    LidarShadowFetchOptions,
    LidarShadowResult
} from '../../helios-lidar';
import { processHeightRaster, homeBbox, emptyResult, RASTER_DEFAULTS } from '../helios-lidar-pipeline';
import { fetchFloat32GeoTiff, maxRasters } from '../helios-lidar-geotiff';

const WCS_URL = 'https://wcs-mds.idee.es/mds';
const COVERAGE_VEG  = 'mdsn_v025';
const COVERAGE_BLD  = 'mdsn_e025';

//Peninsular Spain + Balearics bbox, padded slightly. Canarias
//(13°-19° W, 27°-29° N) is intentionally excluded, the data is on a
//separate IGN service we don't currently consume.
const ES_BBOX = { minLat: 35.8, maxLat: 44.0, minLon: -9.6, maxLon: 4.4 };

export const spainPnoaLidar: LidarSource =
{
    id:   'es-ign-pnoa-mdsn',
    name: 'IGN España PNOA-LiDAR MDSn (Spain)',

    covers(lat: number, lon: number): boolean
    {
        return lat >= ES_BBOX.minLat && lat <= ES_BBOX.maxLat
            && lon >= ES_BBOX.minLon && lon <= ES_BBOX.maxLon;
    },

    async fetchShadowRegions(opts: LidarShadowFetchOptions): Promise<LidarShadowResult>
    {
        const rasterSize = Math.min(RASTER_DEFAULTS.maxRasterSize,
            Math.max(RASTER_DEFAULTS.minRasterSize, Math.round(opts.rasterSize)));

        const bbox = homeBbox(opts.homeLat, opts.homeLon, opts.radiusMeters,
            RASTER_DEFAULTS.bboxPadFactor);

        if (bbox.maxLat < ES_BBOX.minLat || bbox.minLat > ES_BBOX.maxLat
         || bbox.maxLon < ES_BBOX.minLon || bbox.minLon > ES_BBOX.maxLon)
        {
            return emptyResult();
        }

        //WCS 2.0.1 GetCoverage. EPSG:4326 is supported as a CRS but
        //the canonical native CRS is EPSG:25830 (ETRS89 UTM 30N); we
        //pin to 4326 so we stay in degrees. Subset axes are Lat / Long.
        const buildUrl = (coverage: string): string =>
        {
            const params = new URLSearchParams({
                SERVICE: 'WCS',
                VERSION: '2.0.1',
                REQUEST: 'GetCoverage',
                COVERAGEID: coverage,
                FORMAT:  'image/tiff',
                SUBSETTINGCRS: 'http://www.opengis.net/def/crs/EPSG/0/4326',
                OUTPUTCRS:    'http://www.opengis.net/def/crs/EPSG/0/4326'
            });
            //SUBSET axes are not URLSearchParams-friendly (need to
            //repeat the same key), so we append manually.
            return `${WCS_URL}?${params.toString()}`
                + `&SUBSET=Lat(${bbox.minLat},${bbox.maxLat})`
                + `&SUBSET=Long(${bbox.minLon},${bbox.maxLon})`
                + `&SCALESIZE=Lat(${rasterSize}),Long(${rasterSize})`;
        };

        const [veg, bld] = await Promise.all([
            fetchFloat32GeoTiff(buildUrl(COVERAGE_VEG), rasterSize, opts.signal),
            fetchFloat32GeoTiff(buildUrl(COVERAGE_BLD), rasterSize, opts.signal)
        ]);
        if (!veg && !bld) return emptyResult();

        //Defensive: if one coverage is missing (transient WCS hiccup)
        //we still consume the other rather than dropping the whole
        //fetch. The merge function handles a missing operand.
        const heights = (veg && bld)
            ? maxRasters(veg, bld)
            : (veg ?? bld!);

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
