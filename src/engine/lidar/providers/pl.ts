//GUGiK NMPT shadow source for Poland.
//
//Poland's national Digital Surface Model (Numeryczny Model Pokrycia
//Terenu) is published by GUGiK (Główny Urząd Geodezji i Kartografii)
//through a public WCS 2.0.1 endpoint, free open data, no API key.
//
//Same single-coverage shape as France and NRW: the upstream `DSM_PL-EVRF2007-NH` coverage already contains absolute surface heights, so we let the
//shared pipeline run a height threshold off the home's local terrain rather than subtracting a separate DTM.
//
//The service supports EPSG:4326 natively (alongside EPSG:2180 and
//EPSG:3857), so we can keep the lat/lon SUBSET pattern identical to
//NRW's. image/tiff returns a single-band Float32 GeoTIFF that the
//shared GeoTIFF helper decodes without conversion.

import type {
    LidarSource,
    LidarShadowFetchOptions,
    LidarShadowResult
} from '../../lidar';
import { processHeightRaster, homeBbox, emptyResult, RASTER_DEFAULTS } from '../pipeline';
import { fetchFloat32GeoTiff } from '../geotiff';

const WCS_URL    = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/NMPT/GRID1/WCS/DigitalSurfaceModel';
//Two coverages exist in the upstream WCS: PL-EVRF2007-NH (years
//2018-2021, modern Polish height system) and PL-KRON86-NH (legacy
//years 2000-2019). The EVRF2007 coverage is the freshest national
//mosaic so we prefer it; the upstream silently returns an empty
//raster outside its temporal coverage which the pipeline handles
//as out-of-data.
const COVERAGE   = 'DSM_PL-EVRF2007-NH';

//Bounding box of Poland, padded slightly so the eastern Belarusian or southern Slovakian border points still trigger a fetch. The WCS silently clips
//outside national territory, so over-fetching at the border is free.
const PL_BBOX = { minLat: 49.00, maxLat: 54.85, minLon: 14.10, maxLon: 24.20 };

export const polandGugikNmpt: LidarSource =
{
    id:   'pl-gugik-nmpt',
    name: 'GUGiK NMPT (Poland)',
    //GUGiK NMPT is published on a 1 m grid nationwide.
    nativeCellPitchMeters: 1.0,

    covers(lat: number, lon: number): boolean
    {
        return lat >= PL_BBOX.minLat && lat <= PL_BBOX.maxLat
            && lon >= PL_BBOX.minLon && lon <= PL_BBOX.maxLon;
    },

    async fetchShadowRegions(opts: LidarShadowFetchOptions): Promise<LidarShadowResult>
    {
        const rasterSize = Math.min(RASTER_DEFAULTS.maxRasterSize,
            Math.max(RASTER_DEFAULTS.minRasterSize, Math.round(opts.rasterSize)));

        const bbox = homeBbox(opts.homeLat, opts.homeLon, opts.radiusMeters,
            RASTER_DEFAULTS.bboxPadFactor);

        if (bbox.maxLat < PL_BBOX.minLat || bbox.minLat > PL_BBOX.maxLat
         || bbox.maxLon < PL_BBOX.minLon || bbox.minLon > PL_BBOX.maxLon)
        {
            return emptyResult();
        }

        //WCS 2.0.1 with axis labels Long / Lat (the GetCapabilities
        //document declares them in that order for the EVRF2007
        //coverage). SCALESIZE forces the output raster to exactly
        //rasterSize x rasterSize so downstream indexing stays
        //uniform across providers.
        const params = new URLSearchParams({
            SERVICE:       'WCS',
            VERSION:       '2.0.1',
            REQUEST:       'GetCoverage',
            COVERAGEID:    COVERAGE,
            FORMAT:        'image/tiff',
            SUBSETTINGCRS: 'http://www.opengis.net/def/crs/EPSG/0/4326'
        });
        params.append('SUBSET',    `Long(${bbox.minLon},${bbox.maxLon})`);
        params.append('SUBSET',    `Lat(${bbox.minLat},${bbox.maxLat})`);
        params.append('SCALESIZE', `Long(${rasterSize}),Lat(${rasterSize})`);

        const heights = await fetchFloat32GeoTiff(
            `${WCS_URL}?${params.toString()}`,
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
