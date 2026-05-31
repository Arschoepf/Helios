//CORS relay helper for LiDAR provider endpoints that return correct
//payloads but omit `Access-Control-Allow-Origin`, which makes the
//browser drop the response even though the server delivered it. We
//route those upstreams through helios-lidar.org/api/lidar-proxy,
//which fetches the bytes server-side and relays them with the right
//CORS header.
//
//The list below is intentionally explicit, hardcoded by hostname:
//we only divert providers we know need the relay. Providers that
//serve CORS correctly stay direct (cheaper for our VPS bandwidth,
//cheaper round-trip for the user).
//
//Adding a new provider that needs the relay is two lines: append the
//hostname here, mirror it on the server-side allowlist in
//Helios-Lidar's app/lidar_proxy.py.

const PROXY_BASE_URL = 'https://helios-lidar.org/api/lidar-proxy';

const HOSTS_REQUIRING_RELAY: ReadonlySet<string> = new Set([
    'mapy.geoportal.gov.pl',  //Poland, GUGiK NMPT
]);


//Returns the URL the provider should actually fetch. When the
//upstream hostname needs the CORS relay, wraps it inside our proxy
//endpoint; otherwise returns the original URL untouched so direct
//providers pay zero overhead.
//
//Malformed URLs return as-is rather than throwing: the provider will
//then fail on the fetch itself and trigger the normal backoff path.
export function lidarFetchUrl(upstreamUrl: string): string
{
    let host: string;
    try
    {
        host = new URL(upstreamUrl).hostname.toLowerCase();
    }
    catch (_)
    {
        return upstreamUrl;
    }
    if (!HOSTS_REQUIRING_RELAY.has(host)) return upstreamUrl;
    return `${PROXY_BASE_URL}?upstream=${encodeURIComponent(upstreamUrl)}`;
}
