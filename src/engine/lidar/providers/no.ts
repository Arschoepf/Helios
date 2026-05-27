//Kartverket NHM (Nasjonal Høydemodell) shadow source for Norway.
//
//Norway's national elevation model is published by Kartverket through
//ArcGIS ImageServer endpoints (not OGC WCS, which simplifies the
//URL builder but means we go through the ESRI exportImage REST call
//instead of GetCoverage). Two services are available nationwide:
//
// /arcgis/rest/services/DTM/ImageServer , Float32 terrain heights /arcgis/rest/services/DOM/ImageServer , Float32 surface heights
//
//"DOM" is the Norwegian abbreviation for Digital Overflate Modell, i.e. the same as DSM. We fetch both, subtract, and feed the height-above-ground
//raster to the shared pipeline.
//
//Spatial reference: the ImageServers are natively in EPSG:25833
//(ETRS89 / UTM Zone 33N), but exportImage transparently reprojects
//if we send `bboxSR=4326` and `imageSR=4326`, which lets us keep the
//provider URL builder uniform with the OGC ones. exportImage's
//`format=tiff` returns a Float32 GeoTIFF when the source is Float32.
//
//Coverage: mainland Norway + Svalbard. We bbox-clip on a generous rectangle that covers both.

import type {
    LidarSource,
    LidarShadowFetchOptions,
    LidarShadowResult
} from '../../lidar';
import { processHeightRaster, homeBbox, emptyResult, RASTER_DEFAULTS } from '../pipeline';
import { fetchFloat32GeoTiff, subtractRasters } from '../geotiff';

const DTM_URL = 'https://hoydedata.no/arcgis/rest/services/DTM/ImageServer/exportImage';
const DOM_URL = 'https://hoydedata.no/arcgis/rest/services/DOM/ImageServer/exportImage';

//Mainland Norway + Jan Mayen + Svalbard. Wide on purpose, the exportImage call returns no-data outside actual coverage so the pipeline drops anything
//that comes back empty.
const NO_BBOX = { minLat: 57.5, maxLat: 81.0, minLon: 4.0, maxLon: 33.0 };

export const norwayKartverketNhm: LidarSource =
{
    id:   'no-kartverket-nhm',
    name: 'Kartverket NHM (Norway)',
    //Kartverket DTM / DOM ImageServers expose 1 m sampling nationwide.
    nativeCellPitchMeters: 1.0,

    covers(lat: number, lon: number): boolean
    {
        return lat >= NO_BBOX.minLat && lat <= NO_BBOX.maxLat
            && lon >= NO_BBOX.minLon && lon <= NO_BBOX.maxLon;
    },

    async fetchShadowRegions(opts: LidarShadowFetchOptions): Promise<LidarShadowResult>
    {
        const rasterSize = Math.min(RASTER_DEFAULTS.maxRasterSize,
            Math.max(RASTER_DEFAULTS.minRasterSize, Math.round(opts.rasterSize)));

        const bbox = homeBbox(opts.homeLat, opts.homeLon, opts.radiusMeters,
            RASTER_DEFAULTS.bboxPadFactor);

        if (bbox.maxLat < NO_BBOX.minLat || bbox.minLat > NO_BBOX.maxLat
         || bbox.maxLon < NO_BBOX.minLon || bbox.minLon > NO_BBOX.maxLon)
        {
            return emptyResult();
        }

        //ArcGIS exportImage. bbox in lon-lat order (xmin, ymin, xmax,
        //ymax) when bboxSR=4326. format=tiff with no compression
        //returns a Float32 GeoTIFF for Float32 source data, which the
        //GeoTIFF helper decodes natively.
        const buildUrl = (base: string): string =>
        {
            const params = new URLSearchParams({
                bbox:        `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`,
                bboxSR:      '4326',
                imageSR:     '4326',
                size:        `${rasterSize},${rasterSize}`,
                format:      'tiff',
                pixelType:   'F32',
                noData:      '-9999',
                f:           'image'
            });
            return `${base}?${params.toString()}`;
        };

        const [dom, dtm] = await Promise.all([
            fetchFloat32GeoTiff(buildUrl(DOM_URL), rasterSize, opts.signal),
            fetchFloat32GeoTiff(buildUrl(DTM_URL), rasterSize, opts.signal)
        ]);
        if (!dom || !dtm) return emptyResult();

        //Replace the noData sentinel with NaN before subtracting so a missing ground sample doesn't pollute the surface delta.
        const cleanseNoData = (a: Float32Array): Float32Array =>
        {
            for (let i = 0; i < a.length; i++)
            {
                if (a[i] <= -9000) a[i] = NaN;
            }
            return a;
        };
        const heights = subtractRasters(cleanseNoData(dom), cleanseNoData(dtm));

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
