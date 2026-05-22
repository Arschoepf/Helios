//Anonymous install heartbeat.
//
//Once per browser per 24 h, the card fires a single POST to
//helios-lidar.org carrying just a randomly-generated UUID v4
//("install_id"). The VPS counts distinct IDs seen in the last
//30 days and exposes the running total via GET /api/install-count
//so the landing page can show "Join the N users running Helios".
//
//What we send : `{ install_id: <uuid> }`. That is the whole body.
//What we DO NOT send : no IP (the server doesn't log it for this
//endpoint), no user-agent, no Home Assistant version, no entity
//ids, no lat / lon, no country. The UUID is a pseudonym generated
//in localStorage and never tied back to a real person.
//
//Opt-out paths, any of which silences the heartbeat completely :
//  - `helios-anon-stats: false` in the card config
//  - `navigator.doNotTrack === '1'` set in the browser
//  - localStorage is unavailable (private mode, restricted host)
//  - the user clears localStorage (a fresh UUID is then generated
//    the next time the heartbeat fires; this gives a small over-
//    count but no tracking continuity)
//
//Pure-side-effect module : nothing else in the codebase depends
//on the return value. A network failure (CORS, DNS, server down)
//is swallowed silently so the card render never blocks on it.

const STATS_ENDPOINT_URL  = 'https://helios-lidar.org/api/heartbeat';
const INSTALL_ID_KEY      = 'helios-install-id';
const LAST_PING_KEY       = 'helios-install-last-ping';
const PING_INTERVAL_MS    = 24 * 60 * 60 * 1000;    //24 h
const UUID_V4_RE          = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;


//Generate a fresh UUID v4 using the platform crypto. Prefers the
//native randomUUID() (Node 14.17+ / browsers 2022+) and falls back
//to a manual assembly via getRandomValues() for older WebViews. We
//can rely on crypto.getRandomValues() being present everywhere the
//card runs since HA's frontend already requires a modern browser.
function generateUuidV4(): string
{
    const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
    if (cryptoObj && typeof cryptoObj.randomUUID === 'function')
    {
        return cryptoObj.randomUUID();
    }
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function')
    {
        const b = new Uint8Array(16);
        cryptoObj.getRandomValues(b);
        b[6] = (b[6] & 0x0f) | 0x40;   //version 4
        b[8] = (b[8] & 0x3f) | 0x80;   //variant 10
        const hex: string[] = [];
        for (let i = 0; i < 16; i++) hex.push(b[i].toString(16).padStart(2, '0'));
        return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
    }
    //No crypto at all : return a sentinel that the server-side
    //regex will reject. The heartbeat then no-ops, which is the
    //right outcome on a hostile / sandboxed runtime.
    return '00000000-0000-0000-0000-000000000000';
}


//Safe localStorage accessor : the storage object can be present
//but throw on read in private / restricted contexts, so every
//touch goes through a try / catch.
function readStorage(key: string): string | null
{
    try
    {
        return window.localStorage?.getItem(key) ?? null;
    }
    catch (_)
    {
        return null;
    }
}

function writeStorage(key: string, value: string): boolean
{
    try
    {
        window.localStorage?.setItem(key, value);
        return true;
    }
    catch (_)
    {
        return false;
    }
}


//Returns the persisted install id, generating + storing one on
//first call. Returns null when localStorage isn't writable (the
//caller then skips the heartbeat entirely; private-mode browsers
//don't count).
export function getInstallId(): string | null
{
    const existing = readStorage(INSTALL_ID_KEY);
    if (existing && UUID_V4_RE.test(existing)) return existing;

    const fresh = generateUuidV4();
    if (!UUID_V4_RE.test(fresh)) return null;
    if (!writeStorage(INSTALL_ID_KEY, fresh)) return null;
    return fresh;
}


//True when the heartbeat must stay silent: explicit card config
//opt-out, browser-level DNT, or one of the storage / crypto
//fallbacks bailing out.
function isOptedOut(config: { 'helios-anon-stats'?: unknown } | undefined): boolean
{
    if (config && config['helios-anon-stats'] === false) return true;
    try
    {
        const dnt = (navigator as Navigator & { doNotTrack?: string | null }).doNotTrack;
        if (dnt === '1') return true;
    }
    catch (_) { /* ignore, assume not opted out */ }
    return false;
}


//Fire the heartbeat at most once per PING_INTERVAL_MS per browser.
//No-ops silently when:
//  - the user / browser opted out (see isOptedOut)
//  - localStorage is unavailable
//  - a previous ping within the throttle window already happened
//  - the network call fails (offline, CORS, server down)
//Safe to call from the engine init: never throws, never blocks
//the call stack waiting on the fetch.
export function maybePingHeartbeat(
    config: { 'helios-anon-stats'?: unknown } | undefined,
): void
{
    if (isOptedOut(config)) return;

    const installId = getInstallId();
    if (installId === null) return;

    //Throttle. A bad / corrupt timestamp (not a number) is treated
    //as "no recent ping" so we fire and overwrite with a valid one.
    const rawLast = readStorage(LAST_PING_KEY);
    if (rawLast !== null)
    {
        const lastMs = parseInt(rawLast, 10);
        if (Number.isFinite(lastMs) && Date.now() - lastMs < PING_INTERVAL_MS)
        {
            return;
        }
    }

    //Best-effort fetch. Failures are swallowed; the next page
    //load (or refresh-after-24h, whichever comes first) tries
    //again. We update the throttle marker BEFORE awaiting the
    //response so a brief network blip doesn't spawn 10 retries
    //in the same minute.
    writeStorage(LAST_PING_KEY, String(Date.now()));

    try
    {
        fetch(STATS_ENDPOINT_URL, {
            method:      'POST',
            mode:        'cors',
            credentials: 'omit',
            headers:     { 'content-type': 'application/json' },
            body:        JSON.stringify({ install_id: installId }),
            keepalive:   true,
        }).catch(() => { /* swallow network errors silently */ });
    }
    catch (_) { /* swallow ; can't even start the fetch */ }
}
