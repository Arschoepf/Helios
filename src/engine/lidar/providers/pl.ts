//GUGiK NMPT shadow source for Poland.
//
//Poland's national Digital Surface Model (Numeryczny Model Pokrycia
//Terenu) is published by GUGiK (Główny Urząd Geodezji i Kartografii)
//through a public WCS 2.0.1 endpoint, free open data, no API key.
//
//Same single-coverage shape as France and NRW: the upstream `DSM_PL-EVRF2007-NH` coverage already contains absolute surface heights, so we let the
//shared pipeline run a height threshold off the home's local terrain rather than subtracting a separate DTM.
//
//Format gotcha worth knowing: GUGiK advertises image/tiff in its WCS
//capabilities but the bytes come back as an 8-bit RGB rendering of
//the heights, useless as input to the height pipeline. The only
//format on this endpoint that ships the real metres is
//`image/x-aaigrid` (ESRI ASCII Grid). We ask for it explicitly and
//decode through the AAIGrid helper.

import type {
    LidarSource,
    LidarShadowFetchOptions,
    LidarShadowResult
} from '../../lidar';
import { processHeightRaster, homeBbox, emptyResult, RASTER_DEFAULTS } from '../pipeline';
import { fetchAaiGridHeights } from '../aaigrid';

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
            FORMAT:        'image/x-aaigrid',
            SUBSETTINGCRS: 'http://www.opengis.net/def/crs/EPSG/0/4326'
        });
        params.append('SUBSET',    `Long(${bbox.minLon},${bbox.maxLon})`);
        params.append('SUBSET',    `Lat(${bbox.minLat},${bbox.maxLat})`);
        params.append('SCALESIZE', `Long(${rasterSize}),Lat(${rasterSize})`);

        const heights = await fetchAaiGridHeights(
            `${WCS_URL}?${params.toString()}`,
            rasterSize,
            opts.signal
        );
        if (!heights)
        {
            return emptyResult();
        }

        //GUGiK NMPT ships absolute heights above sea level (118-145 m
        //around Wrocław), the shared pipeline thresholds against the
        //DEFAULT_HEIGHT_MAX of 100 m and would reject every cell. We
        //normalise to "metres above local ground" before handing off
        //to the pipeline, picking the local ground as the lowest cell
        //in an 11 x 11 window around the home pixel, that picks the
        //actual ground rather than the roof the home sits on.
        const px = (opts.homeLon - bbox.minLon) / (bbox.maxLon - bbox.minLon);
        const py = 1 - (opts.homeLat - bbox.minLat) / (bbox.maxLat - bbox.minLat);
        const hx = Math.max(0, Math.min(rasterSize - 1, Math.floor(px * rasterSize)));
        const hy = Math.max(0, Math.min(rasterSize - 1, Math.floor(py * rasterSize)));
        const NEIGH = 5;
        let homeGround = Infinity;
        for (let dy = -NEIGH; dy <= NEIGH; dy++)
        {
            const ny = hy + dy;
            if (ny < 0 || ny >= rasterSize)
            {
                continue;
            }
            for (let dx = -NEIGH; dx <= NEIGH; dx++)
            {
                const nx = hx + dx;
                if (nx < 0 || nx >= rasterSize)
                {
                    continue;
                }
                const v = heights[ny * rasterSize + nx];
                if (isFinite(v) && v < homeGround)
                {
                    homeGround = v;
                }
            }
        }
        if (!isFinite(homeGround))
        {
            return emptyResult();
        }

        const normalised = new Float32Array(heights.length);
        for (let i = 0; i < heights.length; i++)
        {
            const v = heights[i];
            normalised[i] = isFinite(v) ? v - homeGround : NaN;
        }

        return processHeightRaster(normalised, {
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
