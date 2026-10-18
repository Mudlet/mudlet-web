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

/**
 * A `file:` url's host and fully decoded path, read the way QUrl reads them,
 * or null when `url` is not a file url. Not the WHATWG parser: that one drops a
 * `localhost` host and folds a path that starts `//` into the host, both of
 * which the checks below need to see.
 */
export function fileUrlParts(url: string): { host: string; path: string } | null {
    const m = /^file:(.*)$/is.exec(url.trim());
    if (!m) return null;
    let rest = m[1], host = '';
    if (rest.startsWith('//')) {
        const slash = rest.indexOf('/', 2);
        host = slash === -1 ? rest.slice(2) : rest.slice(2, slash);
        rest = slash === -1 ? '' : rest.slice(slash);
    }
    let path = rest;
    try { path = decodeURIComponent(rest); } catch { /* keep it as written */ }
    return { host, path };
}

/**
 * Why Mudlet refuses `raw` before issuing a request, as the whole reason that
 * follows "url is invalid, reason: " (TLuaInterpreter::getHTTP and friends), or
 * null when it may be used.
 *
 * Only http and https may be fetched: file:, qrc:, data: and the like would hand
 * local or bundled content back as though it had been downloaded. downloadFile()
 * alone also takes a local file — it copies to a path the script chose rather
 * than handing the content back — but only one on this machine: a file url
 * naming another host, or a path naming a share, is a network path on Windows.
 */
export function userUrlRefusal(raw: string, allowLocalFile: boolean): string | null {
    const invalid = userUrlInvalidReason(raw);
    if (invalid) return invalid;
    const url = normalizeUserUrl(raw);
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)?.[1] ?? '';
    if (/^https?$/i.test(scheme)) return null;
    const file = fileUrlParts(url);
    if (!allowLocalFile || !file) {
        return `unsupported scheme '${scheme}', only ${allowLocalFile ? 'http, https and file' : 'http and https'} are allowed`;
    }
    if (file.host && file.host.toLowerCase() !== 'localhost') {
        return `file url names host '${file.host}', only local files are allowed`;
    }
    if (file.path.replace(/\\/g, '/').startsWith('//')) {
        return `file url names a network path '${file.path}', only local files are allowed`;
    }
    return null;
}
