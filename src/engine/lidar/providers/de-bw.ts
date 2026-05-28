//Baden-Württemberg LGL DOM5 + DGM1 shadow source.
//
//LGL Baden-Württemberg (Landesamt für Geoinformation und
//Landentwicklung) opened its full geodata catalogue under
//Datenlizenz Deutschland Namensnennung 2.0 in June 2024, including
//two INSPIRE-themed WCS coverages on `owsproxy.lgl-bw.de`:
//
//  WCS_INSP_BW_Hoehe_Coverage_DOM5 , Digitales Oberflächenmodell,
//                                    5 m grid (5 m for the DSM is
//                                    LGL's published resolution for
//                                    state-wide downloads, finer
//                                    products are bulk-only)
//  WCS_INSP_BW_Hoehe_Coverage_DGM1 , Digitales Geländemodell, 1 m
//
//Both coverages publish through the INSPIRE elevation theme, so the
//coverage identifier is the generic `EL.ElevationGridCoverage` on
//each endpoint (the URL differentiates DOM from DGM, not the
//CoverageId). Both return Float32 GeoTIFF. The service rejects
//EPSG:4326 axis-label subsetting and requires its native UTM 32N
//(EPSG:25832) projection, so we project the bbox client-side via
//proj.ts before sending the request.
//
//Resolution: BW publishes DOM at 5 m and DGM at 1 m. Helios's
//pipeline resamples both onto the same SCALESIZE grid before
//subtracting, so the mismatch is transparent. The actual height
//resolution is bounded by the coarser of the two (5 m for DOM in
//this case).

import type {
    LidarSource,
    LidarShadowFetchOptions,
    LidarShadowResult
} from '../../lidar';
import { processHeightRaster, homeBbox, emptyResult, RASTER_DEFAULTS } from '../pipeline';
import { fetchFloat32GeoTiff, subtractRasters } from '../geotiff';
import { getEpsg, projectBbox } from '../proj';

const DOM_URL   = 'https://owsproxy.lgl-bw.de/owsproxy/wcs/WCS_INSP_BW_Hoehe_Coverage_DOM5';
const DGM_URL   = 'https://owsproxy.lgl-bw.de/owsproxy/wcs/WCS_INSP_BW_Hoehe_Coverage_DGM1';
//Both INSPIRE-themed coverages use the generic theme coverage id.
const COVERAGE  = 'EL.ElevationGridCoverage';

//Bounding box of Baden-Württemberg, padded into Rheinland-Pfalz + Bavaria + Switzerland borders so coastal homes still trigger a fetch. WCS returns
//no-data outside the state mosaic.
const BW_BBOX = { minLat: 47.50, maxLat: 49.85, minLon: 7.45, maxLon: 10.55 };

export const badenWurttembergLgl: LidarSource =
{
    id:   'de-bw-lgl',
    name: 'LGL BW DOM5 + DGM1 (Baden-Württemberg)',
    //LGL BW DOM is published on a 5 m grid. The DGM1 is 1 m but the subtracted output is bounded by the coarser DOM resolution, so we declare 5 m as
    //the effective native pitch.
    nativeCellPitchMeters: 5.0,

    covers(lat: number, lon: number): boolean
    {
        return lat >= BW_BBOX.minLat && lat <= BW_BBOX.maxLat
            && lon >= BW_BBOX.minLon && lon <= BW_BBOX.maxLon;
    },

    async fetchShadowRegions(opts: LidarShadowFetchOptions): Promise<LidarShadowResult>
    {
        const rasterSize = Math.min(RASTER_DEFAULTS.maxRasterSize,
            Math.max(RASTER_DEFAULTS.minRasterSize, Math.round(opts.rasterSize)));

        const bbox = homeBbox(opts.homeLat, opts.homeLon, opts.radiusMeters,
            RASTER_DEFAULTS.bboxPadFactor);

        if (bbox.maxLat < BW_BBOX.minLat || bbox.minLat > BW_BBOX.maxLat
         || bbox.maxLon < BW_BBOX.minLon || bbox.minLon > BW_BBOX.maxLon)
        {
            return emptyResult();
        }

        const epsg = getEpsg(25832);
        if (!epsg) return emptyResult();
        const proj = projectBbox(bbox, epsg);

        //LGL BW's INSPIRE WCS advertises spatial axes "E N" (UTM
        //easting / northing) and grid axes "X Y" (uppercase, the
        //RectifiedGrid block's labels). Hardcoded here, no two
        //national INSPIRE proxies agree on the conventions.
        const buildUrl = (base: string): string =>
        {
            const params = new URLSearchParams({
                SERVICE:       'WCS',
                VERSION:       '2.0.1',
                REQUEST:       'GetCoverage',
                COVERAGEID:    COVERAGE,
                FORMAT:        'image/tiff',
                SUBSETTINGCRS: epsg.urn
            });
            params.append('SUBSET',    `E(${proj.minX.toFixed(2)},${proj.maxX.toFixed(2)})`);
            params.append('SUBSET',    `N(${proj.minY.toFixed(2)},${proj.maxY.toFixed(2)})`);
            params.append('SCALESIZE', `X(${rasterSize}),Y(${rasterSize})`);
            return `${base}?${params.toString()}`;
        };

        const [dom, dgm] = await Promise.all([
            fetchFloat32GeoTiff(buildUrl(DOM_URL), rasterSize, opts.signal),
            fetchFloat32GeoTiff(buildUrl(DGM_URL), rasterSize, opts.signal)
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
        }, {
            //DOM is published at 5 m and DGM at 1 m; the subtraction
            //is dominated by the coarser DOM grid which puts a lot of
            //2-5 m noise on building edges and low vegetation. Median
            //pre-filter kills isolated spikes, threshold raised to 7 m
            //skips tall scrub and 1-story garden sheds whose render
            //would otherwise dominate the shadow output.
            medianSmooth:  true,
            heightThreshM: 7,
        });
    }
};
