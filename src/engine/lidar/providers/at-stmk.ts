//Land Steiermark ALS shadow source for Styria, Austria.
//
//Styria publishes its airborne-laser-scanning derived elevation data
//through GIS Steiermark as a pair of ArcGIS-backed WCS services,
//free open data, no API key, no signup:
//
//  ALSHoeheninformation_1m_UTM33N  , DSM (Oberflächenmodell, the
//                                     full surface with trees and
//                                     buildings)
//  ALSGelaendeinformation_1m_UTM33N , DTM (Geländemodell, the bare
//                                      ground after filtering)
//
//Both services expose four coverages, the fourth ("Coverage4") is
//the state-wide Gesamtmodell mosaic; the first three are project-
//scoped subsets and hillshade variants. We fetch Coverage4 from each
//service and subtract to derive metres-above-ground, the same
//DSM-DTM pattern used for the UK / NL / NO providers.
//
//Native CRS is EPSG:32633 (WGS84 / UTM Zone 33N) but the service
//also accepts EPSG:4326 subsetting, so we keep the URL builder
//uniform with the OGC providers.

import type {
    LidarSource,
    LidarShadowFetchOptions,
    LidarShadowResult
} from '../../lidar';
import { processHeightRaster, homeBbox, emptyResult, RASTER_DEFAULTS } from '../pipeline';
import { fetchFloat32GeoTiff, subtractRasters } from '../geotiff';

const DOM_URL   = 'https://gis.stmk.gv.at/arcgis/services/OGD/ALSHoeheninformation_1m_UTM33N/MapServer/WCSServer';
const DTM_URL   = 'https://gis.stmk.gv.at/arcgis/services/OGD/ALSGelaendeinformation_1m_UTM33N/MapServer/WCSServer';
const COVERAGE  = 'Coverage4';

//Bounding box of Styria, padded so homes on the Carinthian and
//Burgenland borders still trigger a fetch. WCS returns no-data
//outside the state's mosaic so over-fetching at the edges is free.
const AT_STMK_BBOX = { minLat: 46.55, maxLat: 47.85, minLon: 13.50, maxLon: 16.20 };

export const austriaSteiermarkAls: LidarSource =
{
    id:   'at-stmk-als',
    name: 'Land Steiermark ALS (Styria, Austria)',
    //ALS Höhen-/Geländeinformation are published on a 1 m grid.
    nativeCellPitchMeters: 1.0,

    covers(lat: number, lon: number): boolean
    {
        return lat >= AT_STMK_BBOX.minLat && lat <= AT_STMK_BBOX.maxLat
            && lon >= AT_STMK_BBOX.minLon && lon <= AT_STMK_BBOX.maxLon;
    },

    async fetchShadowRegions(opts: LidarShadowFetchOptions): Promise<LidarShadowResult>
    {
        const rasterSize = Math.min(RASTER_DEFAULTS.maxRasterSize,
            Math.max(RASTER_DEFAULTS.minRasterSize, Math.round(opts.rasterSize)));

        const bbox = homeBbox(opts.homeLat, opts.homeLon, opts.radiusMeters,
            RASTER_DEFAULTS.bboxPadFactor);

        if (bbox.maxLat < AT_STMK_BBOX.minLat || bbox.minLat > AT_STMK_BBOX.maxLat
         || bbox.maxLon < AT_STMK_BBOX.minLon || bbox.minLon > AT_STMK_BBOX.maxLon)
        {
            return emptyResult();
        }

        const buildUrl = (base: string): string =>
        {
            const params = new URLSearchParams({
                SERVICE:       'WCS',
                VERSION:       '2.0.1',
                REQUEST:       'GetCoverage',
                COVERAGEID:    COVERAGE,
                FORMAT:        'image/tiff',
                SUBSETTINGCRS: 'http://www.opengis.net/def/crs/EPSG/0/4326'
            });
            params.append('SUBSET',    `Lat(${bbox.minLat},${bbox.maxLat})`);
            params.append('SUBSET',    `Long(${bbox.minLon},${bbox.maxLon})`);
            params.append('SCALESIZE', `Lat(${rasterSize}),Long(${rasterSize})`);
            return `${base}?${params.toString()}`;
        };

        const [dom, dtm] = await Promise.all([
            fetchFloat32GeoTiff(buildUrl(DOM_URL), rasterSize, opts.signal),
            fetchFloat32GeoTiff(buildUrl(DTM_URL), rasterSize, opts.signal)
        ]);
        if (!dom || !dtm) return emptyResult();

        const heights = subtractRasters(dom, dtm);

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
