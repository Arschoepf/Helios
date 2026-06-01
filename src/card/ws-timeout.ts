//Thin wrapper around `hass.callWS` that aborts the in-flight promise after a configurable timeout.
//
//Helios's history and statistics fetches are the slowest WebSocket round-trips the card issues, and on a recorder under heavy load (the Victron
//Cerbo case in #155 saturated the SQLite connection) they would never complete. Without a timeout the card stayed pinned on its loading state
//forever and the user had no signal that anything was wrong. With this wrapper a stuck fetch resolves to a rejection after the budget elapses;
//each caller catches the error and renders a degraded state (live chip values still update from `hass.states`, the chart history line just
//disappears until the next attempt).
//
//No retry, no backoff: the caller's existing fetch-key gate naturally re-issues on the next `refresh*` cycle when the (entity, window) tuple
//changes, which is the right escape valve for a transient recorder stall.

const DEFAULT_TIMEOUT_MS = 30_000;


//Race the underlying `callWS` against a timeout. Resolves with the WS payload, or rejects with a `WsTimeoutError` once the budget elapses. The
//`type` parameter is forwarded into the error message so the warning the caller logs is self-describing without dragging the entire payload along.
export class WsTimeoutError extends Error
{
    constructor(public readonly wsType: string, public readonly timeoutMs: number)
    {
        super(`callWS timeout after ${timeoutMs} ms (${wsType})`);
        this.name = 'WsTimeoutError';
    }
}


export function callWSWithTimeout<T = unknown>(
    hass:    { callWS: (payload: object) => Promise<T> } | null | undefined,
    payload: { type: string; [k: string]: unknown },
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T>
{
    if (!hass || typeof hass.callWS !== 'function')
    {
        return Promise.reject(new Error('hass.callWS unavailable'));
    }
    return new Promise<T>((resolve, reject) =>
    {
        let settled = false;
        const timer = setTimeout(() =>
        {
            if (settled) return;
            settled = true;
            reject(new WsTimeoutError(payload.type, timeoutMs));
        }, timeoutMs);
        hass.callWS(payload).then(
            (result: T) =>
            {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(result);
            },
            (err: unknown) =>
            {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}
