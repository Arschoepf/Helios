//NRCan HRDEM Mosaic shadow source for Canada.
//
//Canada's High Resolution Digital Elevation Model (HRDEM) is the
//national LiDAR-derived elevation dataset published by Natural
//Resources Canada through the GeoBase / GeoCanada infrastructure.
//Distributed as a GeoServer WCS 1.1.1 endpoint that exposes both
//a DSM (digital surface model) and a DTM (terrain model) coverage,
//free open data, no API key, no signup.
//
//Same single-coverage shape as France / NRW / Poland: we pull the
//"dsm" coverage which already contains absolute surface heights so
//we skip the DSM-minus-DTM round-trip. The pipeline derives a
//height threshold from the home's local terrain on the fly.
//
//Resolution: 1 m in southern populated areas (LiDAR-sourced), 2 m
//further north, satellite-derived in the very far north. We size
//the request off the native pitch the user's lidar-precision picks,
//the upstream interpolates if the requested grid is denser than the
//source.
//
//Note on WCS version: NRCan's GeoServer only exposes WCS 1.1.1,
//which uses BoundingBox + GridOrigin + GridOffsets rather than
//WCS 2.0.1's SUBSET / SCALESIZE. The math is the same, just a
//different envelope.

import type {
    LidarSource,
    LidarShadowFetchOptions,
    LidarShadowResult
} from '../../lidar';
import { processHeightRaster, homeBbox, emptyResult, RASTER_DEFAULTS } from '../pipeline';
import { fetchFloat32GeoTiff } from '../geotiff';

const WCS_URL    = 'https://datacube.services.geo.ca/ows/elevation';
const COVERAGE   = 'dsm';

//Bbox of Canada padded into Alaska + the Atlantic to catch coastal
//homes on the maritime provinces and the Yukon-Alaska border. The
//WCS silently returns no-data outside actual coverage (and HRDEM
//is patchy in the very far north anyway), so over-fetching at the
//edges is free.
const CA_BBOX = { minLat: 41.5, maxLat: 84.0, minLon: -141.5, maxLon: -52.0 };

export const canadaHrdem: LidarSource =
{
    id:   'ca-nrcan-hrdem',
    name: 'NRCan HRDEM (Canada)',
    //HRDEM is 1 m where LiDAR-derived (most populated south), 2 m in
    //the rest of the country. We declare 1 m as the native pitch so
    //high-precision requests don't downsample on the upstream where
    //the source is finer.
    nativeCellPitchMeters: 1.0,

    covers(lat: number, lon: number): boolean
    {
        return lat >= CA_BBOX.minLat && lat <= CA_BBOX.maxLat
            && lon >= CA_BBOX.minLon && lon <= CA_BBOX.maxLon;
    },

    async fetchShadowRegions(opts: LidarShadowFetchOptions): Promise<LidarShadowResult>
    {
        const rasterSize = Math.min(RASTER_DEFAULTS.maxRasterSize,
            Math.max(RASTER_DEFAULTS.minRasterSize, Math.round(opts.rasterSize)));

        const bbox = homeBbox(opts.homeLat, opts.homeLon, opts.radiusMeters,
            RASTER_DEFAULTS.bboxPadFactor);

        if (bbox.maxLat < CA_BBOX.minLat || bbox.minLat > CA_BBOX.maxLat
         || bbox.maxLon < CA_BBOX.minLon || bbox.minLon > CA_BBOX.maxLon)
        {
            return emptyResult();
        }

        //WCS 1.1.1 GetCoverage. NRCan's GeoServer (geotrellis backend)
        //expects BoundingBox in (lat_min, lon_min, lat_max, lon_max)
        //order for EPSG:4326, not the more common (x_min, y_min,
        //x_max, y_max) lon-first convention; mixing the two yields a
        //500 "ExtentRangeError: xmin must be less than xmax". Format
        //is `image/geotiff` (not `image/tiff`, which the server
        //explicitly rejects). GridOrigin is the top-left corner in
        //the same lat,lon order, GridOffsets is "delta_lat
        //delta_lon" with delta_lat negative because the grid scans
        //top-to-bottom.
        const deltaLat = (bbox.maxLat - bbox.minLat) / rasterSize;
        const deltaLon = (bbox.maxLon - bbox.minLon) / rasterSize;

        const params = new URLSearchParams({
            SERVICE:      'WCS',
            VERSION:      '1.1.1',
            REQUEST:      'GetCoverage',
            IDENTIFIER:   COVERAGE,
            FORMAT:       'image/geotiff',
            BOUNDINGBOX:  `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon},urn:ogc:def:crs:EPSG::4326`,
            GRIDBASECRS:  'urn:ogc:def:crs:EPSG::4326',
            GRIDCS:       'urn:ogc:def:cs:OGC:0.0:Grid2dSquareCS',
            GRIDTYPE:     'urn:ogc:def:method:WCS:1.1:2dSimpleGrid',
            GRIDORIGIN:   `${bbox.maxLat},${bbox.minLon}`,
            GRIDOFFSETS:  `${-deltaLat},${deltaLon}`
        });

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
