//Land Tirol terrain ALS shadow source.
//
//Tirol publishes its airborne-laser-scanning derived elevation
//data through `gis.tirol.gv.at` as a single MapServer with a
//WCSServer extension, free open data, no API key, no signup. The
//service exposes multiple coverages including a DGM and a DOM at
//5 m (statewide) and 50 cm (where available). We pull the 5 m
//pair because it covers the full state, the 50 cm variants are
//project-scoped.
//
//Same DSM-DTM subtraction pattern as Steiermark / UK / NL / NO,
//both layers publish heights above sea level so subtracting
//yields the metres-above-ground raster the pipeline needs.
//Native CRS is EPSG:31254 (MGI Austria Lambert with central meridian
//M28), the service rejects EPSG:4326 axis-label subsetting so we
//project the bbox client-side via proj.ts before sending the request.

import type {
    LidarSource,
    LidarShadowFetchOptions,
    LidarShadowResult
} from '../../lidar';
import { processHeightRaster, homeBbox, emptyResult, RASTER_DEFAULTS } from '../pipeline';
import { fetchFloat32GeoTiff, subtractRasters } from '../geotiff';
import { getEpsg, projectBbox } from '../proj';

const WCS_URL   = 'https://gis.tirol.gv.at/arcgis/services/Service_Public/terrain/MapServer/WCSServer';
const DOM_COV   = 'Oberflaechenmodell_5m_M28';
const DGM_COV   = 'Gelaendemodell_5m_M28';

//Bounding box of Tirol, padded into the Bavarian / Italian /
//Swiss / Salzburg borders so border-area homes still trigger a
//fetch. WCS clips silently outside the state's mosaic.
const TIROL_BBOX = { minLat: 46.65, maxLat: 47.75, minLon: 10.05, maxLon: 12.95 };

export const austriaTirolAls: LidarSource =
{
    id:   'at-tirol-als',
    name: 'Land Tirol ALS (Tyrol, Austria)',
    //Tirol's WCS publishes the state-wide DGM / DOM at a 5 m grid.
    nativeCellPitchMeters: 5.0,

    covers(lat: number, lon: number): boolean
    {
        return lat >= TIROL_BBOX.minLat && lat <= TIROL_BBOX.maxLat
            && lon >= TIROL_BBOX.minLon && lon <= TIROL_BBOX.maxLon;
    },

    async fetchShadowRegions(opts: LidarShadowFetchOptions): Promise<LidarShadowResult>
    {
        const rasterSize = Math.min(RASTER_DEFAULTS.maxRasterSize,
            Math.max(RASTER_DEFAULTS.minRasterSize, Math.round(opts.rasterSize)));

        const bbox = homeBbox(opts.homeLat, opts.homeLon, opts.radiusMeters,
            RASTER_DEFAULTS.bboxPadFactor);

        if (bbox.maxLat < TIROL_BBOX.minLat || bbox.minLat > TIROL_BBOX.maxLat
         || bbox.maxLon < TIROL_BBOX.minLon || bbox.minLon > TIROL_BBOX.maxLon)
        {
            return emptyResult();
        }

        const epsg = getEpsg(31254);
        if (!epsg) return emptyResult();
        const proj = projectBbox(bbox, epsg);

        //ArcGIS WCSServer advertises lowercase axes "x y" for both
        //spatial and grid axes (its RectifiedGrid block uses lowercase
        //regardless of the CRS family). Hardcoded here rather than
        //driven from the EPSG entry since labels are server-specific.
        const buildUrl = (cov: string): string =>
        {
            const params = new URLSearchParams({
                SERVICE:       'WCS',
                VERSION:       '2.0.1',
                REQUEST:       'GetCoverage',
                COVERAGEID:    cov,
                FORMAT:        'image/tiff',
                SUBSETTINGCRS: epsg.urn
            });
            params.append('SUBSET',    `x(${proj.minX.toFixed(2)},${proj.maxX.toFixed(2)})`);
            params.append('SUBSET',    `y(${proj.minY.toFixed(2)},${proj.maxY.toFixed(2)})`);
            params.append('SCALESIZE', `x(${rasterSize}),y(${rasterSize})`);
            return `${WCS_URL}?${params.toString()}`;
        };

        const [dom, dgm] = await Promise.all([
            fetchFloat32GeoTiff(buildUrl(DOM_COV), rasterSize, opts.signal),
            fetchFloat32GeoTiff(buildUrl(DGM_COV), rasterSize, opts.signal)
        ]);
        if (!dom || !dgm) return emptyResult();

        const heights = subtractRasters(dom, dgm);

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
