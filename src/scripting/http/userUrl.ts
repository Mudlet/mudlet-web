/**
 * Read a url the way Mudlet does before it issues any request: through
 * `QUrl::fromUserInput`. Scripts pass bare `example.com/x` or `127.0.0.1:8080/x`
 * and Mudlet means http by them. fetch() would instead resolve such a string
 * *relative to the page* — fetching the web app's own index.html and reporting
 * success — so every url is put through this before it goes anywhere.
 *
 * The rules, as fromUserInput has them:
 *  - an absolute local path (`/x/y`) is a `file:` url;
 *  - an explicit scheme is kept, unless what looks like one is really a host
 *    followed by a port (`localhost:8080/x`), which gets http prepended;
 *  - anything else gets http prepended.
 *
 * The result is the string the request goes to, the string the HTTP functions
 * return, and the string their events report.
 */
export function normalizeUserUrl(raw: string): string {
    const s = raw.trim();
    if (!s) return s;
    if (s.startsWith('/')) return `file://${s}`;
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/s.exec(s);
    if (scheme && !/^\d+(?:[/?#]|$)/.test(scheme[2])) return s;
    return `http://${s}`;
}

/** Why `raw` is not a usable url, or null when it is. */
export function userUrlInvalidReason(raw: string): string | null {
    const s = normalizeUserUrl(raw);
    if (!s) return 'empty url';
    try {
        new URL(s);
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : 'malformed url';
    }
}
