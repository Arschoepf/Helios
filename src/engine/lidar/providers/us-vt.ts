//Vermont Center for Geographic Information (VCGI) nDSM shadow
//source, the first US-state native provider in Helios.
//
//VCGI publishes a statewide normalized Digital Surface Model
//(nDSM, metres-above-ground) derived from the 2013-2017 QL2 0.7 m
//LiDAR collection, as a public ArcGIS Image Server. Single-fetch,
//no subtraction round-trip, no authentication, no API key. The
//service is hosted on `maps.vcgi.vermont.gov/arcgis/`, returns
//Float32 pixels and natively supports re-projection from any input
//SR (we send bbox in EPSG:4326 and get the response back in 4326
//too).
//
//Coverage: state of Vermont (USA, ~645 K people). Pixel pitch
//0.7 m on the upstream cache.

import type {
    LidarSource,
    LidarShadowFetchOptions,
    LidarShadowResult
} from '../../lidar';
import { processHeightRaster, homeBbox, emptyResult, RASTER_DEFAULTS } from '../pipeline';
import { fetchFloat32GeoTiff } from '../geotiff';

const IMG_URL   = 'https://maps.vcgi.vermont.gov/arcgis/rest/services/EGC_services/IMG_VCGI_LIDARNDSM_WM_CACHE_v1/ImageServer/exportImage';

//Bounding box of Vermont, padded into New Hampshire / Massachusetts / New York / Québec borders. The service returns no-data outside the state mosaic
//so over-fetching is free.
const VT_BBOX = { minLat: 42.65, maxLat: 45.10, minLon: -73.50, maxLon: -71.40 };

export const vermontVcgiNdsm: LidarSource =
{
    id:   'us-vt-vcgi-ndsm',
    name: 'VCGI nDSM (Vermont, USA)',
    //VCGI's statewide nDSM cache is published at 0.7 m pixel pitch.
    nativeCellPitchMeters: 0.7,

    covers(lat: number, lon: number): boolean
    {
        return lat >= VT_BBOX.minLat && lat <= VT_BBOX.maxLat
            && lon >= VT_BBOX.minLon && lon <= VT_BBOX.maxLon;
    },

    async fetchShadowRegions(opts: LidarShadowFetchOptions): Promise<LidarShadowResult>
    {
        const rasterSize = Math.min(RASTER_DEFAULTS.maxRasterSize,
            Math.max(RASTER_DEFAULTS.minRasterSize, Math.round(opts.rasterSize)));

        const bbox = homeBbox(opts.homeLat, opts.homeLon, opts.radiusMeters,
            RASTER_DEFAULTS.bboxPadFactor);

        if (bbox.maxLat < VT_BBOX.minLat || bbox.minLat > VT_BBOX.maxLat
         || bbox.maxLon < VT_BBOX.minLon || bbox.minLon > VT_BBOX.maxLon)
        {
            return emptyResult();
        }

        //ArcGIS exportImage. bbox in lon-lat order (xmin, ymin, xmax,
        //ymax) with bboxSR=4326. The upstream is natively cached in
        //Web Mercator (EPSG:3857) but reprojects transparently when
        //imageSR=4326 is requested. format=tiff with pixelType=F32
        //returns a Float32 GeoTIFF the shared helper decodes
        //natively. The nDSM is already metres-above-ground so the
        //pipeline gets fed the height raster directly, no DSM-DTM
        //subtraction needed.
        const params = new URLSearchParams({
            bbox:          `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`,
            bboxSR:        '4326',
            imageSR:       '4326',
            size:          `${rasterSize},${rasterSize}`,
            format:        'tiff',
            pixelType:     'F32',
            interpolation: 'RSP_BilinearInterpolation',
            f:             'image'
        });

        const heights = await fetchFloat32GeoTiff(
            `${IMG_URL}?${params.toString()}`,
            rasterSize,
            opts.signal
        );
        if (!heights) return emptyResult();

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
