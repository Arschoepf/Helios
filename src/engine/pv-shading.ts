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
//With those three we can ray-march from each panel along the panel→sun direction, sample the nDSM along the ray, and decide whether the sun
//line-of-sight is blocked by the local terrain, a building, or a tree.
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

//LiDAR-derived working raster the engine hands to the shading
//check. `heights` is the nDSM (height above local ground per cell)
//and is always populated. `terrain` is the optional DTM band
//(ground elevation per cell in the source vertical datum). When
//the provider supplies a 2-band COG the engine reads both; when
//the COG is a legacy single-band file the terrain field is left
//undefined and the ray-march falls back to the flat-ground
//behaviour.
export interface NdsmRaster
{
    heights:    Float32Array;
    terrain?:   Float32Array;
    rasterSize: number;       //square: rasterSize × rasterSize cells
    minLat:     number;
    maxLat:     number;
    minLon:     number;
    maxLon:     number;
}

const D = Math.PI / 180;
const M_PER_DEG_LAT = 111_320;     //mean meridional metres per degree

//Bilinear sample of one Float32 band at a geographic point. Returns
//null when the point falls outside the raster bbox or any of the
//four bracketing cells carries a non-finite (no-data) value.
//Shared between the nDSM (heights, always present) and the DTM
//(terrain, optional) so both bands sample with identical interpola-
//tion semantics.
function bilinearSample(
    band: Float32Array,
    raster: NdsmRaster,
    lon:    number,
    lat:    number,
): number | null
{
    if (lon <= raster.minLon || lon >= raster.maxLon)
    {
        return null;
    }
    if (lat <= raster.minLat || lat >= raster.maxLat)
    {
        return null;
    }

    const N = raster.rasterSize;
    //Image convention: row 0 is the NORTH edge, so we flip latitude.
    const u = (lon - raster.minLon) / (raster.maxLon - raster.minLon);
    const v = (raster.maxLat - lat) / (raster.maxLat - raster.minLat);
    const x = u * (N - 1);
    const y = v * (N - 1);
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || ix >= N - 1 || iy < 0 || iy >= N - 1)
    {
        return null;
    }

    const h00 = band[iy       * N + ix];
    const h10 = band[iy       * N + ix + 1];
    const h01 = band[(iy + 1) * N + ix];
    const h11 = band[(iy + 1) * N + ix + 1];
    if (!isFinite(h00) || !isFinite(h10) || !isFinite(h01) || !isFinite(h11))
    {
        return null;
    }

    const dx = x - ix;
    const dy = y - iy;
    const top = h00 * (1 - dx) + h10 * dx;
    const bot = h01 * (1 - dx) + h11 * dx;
    return top * (1 - dy) + bot * dy;
}


//Bilinear sample of the nDSM at a geographic point. Returns null
//when the point falls outside the raster bbox or the four
//neighbouring cells include any non-finite (no-data) value.
export function sampleNdsmAt(
    raster: NdsmRaster,
    lon:    number,
    lat:    number,
): number | null
{
    return bilinearSample(raster.heights, raster, lon, lat);
}


//Bilinear sample of the DTM (ground elevation) at a geographic
//point. Returns null when the raster carries no terrain band (a
//legacy single-band COG) or the point falls outside the raster
//bbox / hits a no-data cell. Callers use this to lift the ray-
//march into absolute Z so terrain slope between the panel and a
//far obstacle is taken into account.
export function sampleDtmAt(
    raster: NdsmRaster,
    lon:    number,
    lat:    number,
): number | null
{
    if (!raster.terrain)
    {
        return null;
    }
    return bilinearSample(raster.terrain, raster, lon, lat);
}


//Walk from the panel position toward the sun and return true the
//first time the local terrain + obstacle (nDSM) at the current
//sample point projects ABOVE the sun ray's altitude at that
//horizontal distance. Returns false when the sun is reached
//without ever hitting a blocker, when the raster is missing, or
//when the sun is below the horizon (sun below horizon is already
//handled by the irradiance fast-path upstream, so we don't double-
//count it here).
//
//Terrain awareness: when the raster carries a DTM band (the
//2-band COGs), the ray-march compares both the ray and the
//obstacle in absolute Z anchored at the panel's local ground
//height. Sloped ground between the panel and a far obstacle is
//then taken into account: a 5 m building 50 m east of the home
//with the terrain rising 8 m on the way reads as a 13 m obstacle;
//the same building with the terrain dropping 8 m reads as -3 m,
//i.e. below the panel and invisible to the sun ray. Legacy
//single-band COGs fall through to the flat-ground assumption
//transparently.
//
//Default sampling: 2 m step, 200 m maximum reach. 2 m matches the
//typical nDSM cell pitch for the IGN HD / Defra / AHN providers
//once the engine has down-sampled to its working raster; 200 m
//covers a city block plus a generous tree canopy without paying
//for the long tail of low-altitude grazing rays that contribute
//almost nothing to the direct beam anyway.
//Per-cell solar exposure across the entire LiDAR raster, chunked across rAF ticks. Output is a Uint8Array indexed by (j * rasterSize + i),
//each byte 0 (in shadow at the current sun position) or 255 (lit). Wired into the LiDAR-View overlay so the wireframe + dot cloud paints
//a live, camera-rotation-independent "who's currently in sunlight" map alongside the height visualisation. NaN cells (no-data) and below-
//horizon sun both produce 0.
//
//Cost: one raymarch per cell against the raster, same recipe as isPanelShaded just lifted out so it runs over the whole grid in a tight
//loop. The engine drives this in 32-row chunks per requestAnimationFrame tick so the cumulative 200-1500 ms wall time at high precision
//never lands on the main thread as a single freeze; the user sees the irradiance map fill in row-by-row instead.
//thread stays responsive while the irradiance map refreshes. The caller owns the output buffer (allocated once when the compute starts)
//and walks j-row ranges through this function on each chunk tick; intermediate chunks see partially-populated frames, the user sees the
//irradiance map filling in row-by-row instead of a 200-1500 ms freeze when a full-raster compute lands on a busy main thread. Rows
//outside [jStart, jEnd) are left untouched so a single allocation survives the full multi-chunk sweep. Below-horizon sun and an empty
//range are both fast no-ops.
export function computeLidarCellExposureRows(
    raster:         NdsmRaster,
    sunAltitudeDeg: number,
    sunAzimuthDeg:  number,
    jStart:         number,
    jEnd:           number,
    out:            Uint8Array,
    stepM:          number = 2,
    maxDistM:       number = 200,
): void
{
    if (sunAltitudeDeg <= 0)
    {
        return;
    }
    if (jStart >= jEnd)
    {
        return;
    }

    const altR  = sunAltitudeDeg * D;
    const azR   = sunAzimuthDeg  * D;
    const dxM   = Math.sin(azR);
    const dyM   = Math.cos(azR);
    const tanAlt = Math.tan(altR);

    const { rasterSize, minLat, maxLat, minLon, maxLon, heights, terrain } = raster;
    const pxLon = (maxLon - minLon) / rasterSize;
    const pxLat = (maxLat - minLat) / rasterSize;
    const hasTerrain = !!terrain;

    const j0 = Math.max(0, jStart);
    const j1 = Math.min(rasterSize, jEnd);

    for (let j = j0; j < j1; j++)
    {
        const cLat = maxLat - (j + 0.5) * pxLat;
        //metres-per-degree-longitude varies with latitude. The ray runs at most maxDistM (200 m by default), so a per-row constant is good
        //to <1 m of error which is well below the raster pitch.
        const mPerDegLon = M_PER_DEG_LAT * Math.cos(cLat * D);
        const dLatPerM   = dyM / M_PER_DEG_LAT;
        const dLonPerM   = dxM / mPerDegLon;

        for (let i = 0; i < rasterSize; i++)
        {
            const idx   = j * rasterSize + i;
            const cellH = heights[idx];
            if (!isFinite(cellH)) { out[idx] = 0; continue; }
            const cLon    = minLon + (i + 0.5) * pxLon;
            const cellDtm = hasTerrain ? terrain![idx] : 0;
            let shadowed  = false;
            for (let d = stepM; d <= maxDistM; d += stepM)
            {
                const lat = cLat + dLatPerM * d;
                const lon = cLon + dLonPerM * d;
                const sampleObstacle = sampleNdsmAt(raster, lon, lat);
                if (sampleObstacle === null)
                {
                    continue;
                }
                let relGround = 0;
                if (hasTerrain)
                {
                    //DTM-gap fallback: when the nDSM reads a valid obstacle but the DTM has a no-data hole at the same step, keep
                    //relGround at 0 (flat-ground assumption) instead of skipping the step. Skipping made the ray see through real
                    //obstacles near LiDAR coverage edges; flat-ground here is a small bias next to the false-negative shading.
                    const sampleDtm = sampleDtmAt(raster, lon, lat);
                    if (sampleDtm !== null)
                    {
                        relGround = sampleDtm - cellDtm;
                    }
                }
                const obstacleZ = relGround + sampleObstacle;
                const rayZ      = cellH + d * tanAlt;
                if (obstacleZ > rayZ) { shadowed = true; break; }
            }
            out[idx] = shadowed ? 0 : 255;
        }
    }
}


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
    if (!raster)
    {
        return false;
    }
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

    //Panel's own DTM reference, looked up once. Null on legacy
    //single-band rasters; the per-step "relGround" then defaults
    //to 0 and the ray-march collapses back to the flat-ground
    //recipe (obstacle_z = nDSM, ray_z = panel_height + d × tan).
    const panelDtm = sampleDtmAt(raster, panelLon, panelLat);

    for (let d = stepM; d <= maxDistM; d += stepM)
    {
        const lat = panelLat + dLatPerM * d;
        const lon = panelLon + dLonPerM * d;
        const obstacleAboveGround = sampleNdsmAt(raster, lon, lat);
        if (obstacleAboveGround === null) continue;     //outside coverage, skip
        let relGround = 0;
        if (panelDtm !== null)
        {
            const sampleDtm = sampleDtmAt(raster, lon, lat);
            //DTM-gap fallback: when the nDSM has a valid obstacle reading at this step but the DTM has a no-data hole (water body,
            //processing artifact, small gap near coverage edges), fall back to flat-ground (relGround = 0) rather than skipping the
            //step entirely. Skipping made the ray "see through" the obstacle, which under-detected shading on panels sitting near
            //LiDAR coverage edges. Flat-ground here at least keeps the nDSM in the line-of-sight comparison; the small terrain bias
            //it introduces is acceptable next to the alternative (false-negative shading).
            if (sampleDtm !== null)
            {
                relGround = sampleDtm - panelDtm;
            }
        }
        const obstacleZ = relGround + obstacleAboveGround;
        const rayZ      = panelHeightM + d * tanAlt;
        if (obstacleZ > rayZ)
        {
            return true;
        }
    }
    return false;
}
