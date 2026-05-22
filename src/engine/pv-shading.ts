//LiDAR-aware shading check for the PV prediction.
//
//Helios already knows three things at every time-step:
//
//  * the sun position (altitude + azimuth) from getSunPosition,
//  * each PV array's geographic coordinates (the optional `lon` /
//    `lat` per entry in pv-arrays, or the home fallback otherwise),
//  * the loaded nDSM raster of every cell within building-radius
//    when a LiDAR provider covers the home, the same buffer the
//    LiDAR View overlay paints.
//
//With those three we can ray-march from each panel along the
//panel→sun direction, sample the nDSM along the ray, and decide
//whether the sun line-of-sight is blocked by the local terrain,
//a building, or a tree.
//
//When a panel is shaded the direct beam component of POA goes to
//zero; the isotropic-sky diffuse and ground-reflected components
//are unaffected (a tree to the south still leaves the panel
//facing the whole upper hemisphere of sky). So `isPanelShaded`
//returns a boolean and the caller modulates only the beam term,
//cutting the typical 75-85 % of POA that the direct beam carries
//on a clear day while preserving the floor the diffuse + ground
//terms contribute when an obstacle blocks the sun.
//
//Ray sampling uses bilinear interpolation of the nDSM so the
//shading edge is sub-cell smooth (a panel right behind a building
//corner doesn't flicker between shaded/unshaded as the sun moves
//across the corner pixel boundary).

export interface NdsmRaster
{
    heights:    Float32Array;
    rasterSize: number;       //square: rasterSize × rasterSize cells
    minLat:     number;
    maxLat:     number;
    minLon:     number;
    maxLon:     number;
}

const D = Math.PI / 180;
const M_PER_DEG_LAT = 111_320;     //mean meridional metres per degree

//Bilinear sample of the nDSM at a geographic point. Returns null
//when the point falls outside the raster bbox or the four
//neighbouring cells include any non-finite (no-data) value.
export function sampleNdsmAt(
    raster: NdsmRaster,
    lon:    number,
    lat:    number,
): number | null
{
    if (lon <= raster.minLon || lon >= raster.maxLon) return null;
    if (lat <= raster.minLat || lat >= raster.maxLat) return null;

    const N = raster.rasterSize;
    //Image convention: row 0 is the NORTH edge, so we flip latitude.
    const u = (lon - raster.minLon) / (raster.maxLon - raster.minLon);
    const v = (raster.maxLat - lat) / (raster.maxLat - raster.minLat);
    const x = u * (N - 1);
    const y = v * (N - 1);
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || ix >= N - 1 || iy < 0 || iy >= N - 1) return null;

    const h00 = raster.heights[iy       * N + ix];
    const h10 = raster.heights[iy       * N + ix + 1];
    const h01 = raster.heights[(iy + 1) * N + ix];
    const h11 = raster.heights[(iy + 1) * N + ix + 1];
    if (!isFinite(h00) || !isFinite(h10) || !isFinite(h01) || !isFinite(h11)) return null;

    const dx = x - ix;
    const dy = y - iy;
    const top = h00 * (1 - dx) + h10 * dx;
    const bot = h01 * (1 - dx) + h11 * dx;
    return top * (1 - dy) + bot * dy;
}


//Walk from the panel position toward the sun and return true the
//first time the nDSM cell at the current ground point sits ABOVE
//the sun ray's altitude at that horizontal distance. Returns false
//when the sun is reached without ever hitting a blocker, when the
//raster is missing, or when the sun is below the horizon (sun
//below horizon is already handled by the irradiance fast-path
//upstream, so we don't double-count it here).
//
//Default sampling: 2 m step, 200 m maximum reach. 2 m matches the
//typical nDSM cell pitch for the IGN HD / Defra / AHN providers
//once the engine has down-sampled to its working raster; 200 m
//covers a city block plus a generous tree canopy without paying
//for the long tail of low-altitude grazing rays that contribute
//almost nothing to the direct beam anyway.
export function isPanelShaded(
    raster:         NdsmRaster | null,
    panelLat:       number,
    panelLon:       number,
    panelHeightM:   number,
    sunAltitudeDeg: number,
    sunAzimuthDeg:  number,
    stepM:          number = 2,
    maxDistM:       number = 200,
): boolean
{
    if (!raster) return false;
    if (sunAltitudeDeg <= 0) return false;       //below-horizon: caller's job

    const altR = sunAltitudeDeg * D;
    const azR  = sunAzimuthDeg  * D;
    //Horizontal direction toward the sun. Azimuth is measured
    //clockwise from north, so east = +sin, north = +cos.
    const dxM = Math.sin(azR);
    const dyM = Math.cos(azR);
    const tanAlt = Math.tan(altR);

    //Approximate metres-per-degree conversion at the panel latitude.
    //The ray walks at most maxDistM (200 m by default) so a constant
    //factor is accurate to ~1 m, way under the nDSM resolution.
    const mPerDegLon = M_PER_DEG_LAT * Math.cos(panelLat * D);
    const dLatPerM = dyM / M_PER_DEG_LAT;
    const dLonPerM = dxM / mPerDegLon;

    for (let d = stepM; d <= maxDistM; d += stepM)
    {
        const lat = panelLat + dLatPerM * d;
        const lon = panelLon + dLonPerM * d;
        const groundHeight = sampleNdsmAt(raster, lon, lat);
        if (groundHeight === null) continue;     //outside coverage, skip
        const rayHeight = panelHeightM + d * tanAlt;
        if (groundHeight > rayHeight) return true;
    }
    return false;
}
