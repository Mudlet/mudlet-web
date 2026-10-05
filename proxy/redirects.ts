// Qt's default QNetworkRequest::maxRedirectsAllowed.
const MAX_REDIRECTS = 50;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch `url`, following redirects as Qt's network manager does for Mudlet
 * rather than as fetch does: a 301, 302 or 303 turns every verb except HEAD
 * into a GET without a body (fetch keeps PUT/DELETE/custom verbs, and their
 * body, on a 301/302), and a 307/308 repeats the request as it was.
 */
export async function fetchFollowingLikeQt(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: RequestInit['body'],
): Promise<{ upstream: Response; finalUrl: string; finalMethod: string; redirected: boolean }> {
    let current = url;
    let currentMethod = method;
    let currentHeaders = headers;
    let currentBody = body;
    for (let hops = 0; ; hops++) {
        const upstream = await fetch(current, {
            method: currentMethod, headers: currentHeaders, body: currentBody, redirect: 'manual',
        });
        const location = upstream.headers.get('location');
        if (!REDIRECT_STATUSES.has(upstream.status) || !location) {
            return { upstream, finalUrl: current, finalMethod: currentMethod, redirected: hops > 0 };
        }
        await upstream.body?.cancel().catch(() => {});
        if (hops >= MAX_REDIRECTS) throw new Error('Too many redirects');
        current = new URL(location, current).toString();
        if (upstream.status !== 307 && upstream.status !== 308 && currentMethod !== 'HEAD') {
            currentMethod = 'GET';
            currentBody = undefined;
            currentHeaders = Object.fromEntries(Object.entries(currentHeaders)
                .filter(([k]) => k.toLowerCase() !== 'content-type'));
        }
    }
}
