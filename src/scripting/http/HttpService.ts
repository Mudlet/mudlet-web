import type { ProfileVFS } from '../vfs/ProfileVFS';
import { githubRawUrl } from '../../utils/githubRawUrl';
import { normalizeUserUrl } from './userUrl';

// Mudlet's HTTP API is fire-and-forget: each function returns immediately,
// the actual request runs in the background, and completion/failure is
// reported via sysXxxHttpDone / sysXxxHttpError events. downloadFile also
// streams sysDownloadFileProgress while the body is being read.
//
// Event signatures (from the Mudlet manual; first arg in the handler is the
// event name itself, prepended by dispatchEventToFunctions in Other.lua —
// we pass only the trailing args here):
//   sysDownloadDone(saveTo, fileSize, response)
//   sysDownloadError(errorMessage, saveTo, url, response)
//   sysDownloadFileProgress(url, bytesDownloaded, totalBytes)
//   sysGetHttpDone(url, body, response)   sysGetHttpError(error, url, response)
//   sysPostHttpDone(url, body, response)  sysPostHttpError(error, url, response)
//   sysPutHttpDone(url, body, response)   sysPutHttpError(error, url, response)
//   sysDeleteHttpDone(url, body, response) sysDeleteHttpError(error, url, response)
//   sysCustomHttpDone(url, body, method, response)
//   sysCustomHttpError(error, url, method, response)
// `response` is the record described at responseRecord(); error events carry
// it too (Mudlet's slot_httpRequestFinished appends it to both), empty when
// no reply ever arrived.

type EmitFn = (event: string, args: unknown[]) => void;
type VFSGetter = () => ProfileVFS | null;
type ProxyUrlGetter = () => string | undefined;
/** Runs `fn` off the current call stack. See {@link HttpService.emitLater}. */
type DeferFn = (fn: () => void) => void;
/** Bytes behind a path in a read-only bundled namespace, or null. */
type LocalReader = (path: string) => Uint8Array | null;

// A 1KB/sec download still emits ~10 progress events per second at 100ms;
// a 10MB/sec stream coalesces into the same cadence rather than firing
// thousands of events into Lua per second.
const PROGRESS_THROTTLE_MS = 100;

// How long an origin stays proxied after a direct fetch to it failed. A failure
// cannot tell CORS from a server that was briefly down, so it is not held
// against the origin for the rest of the session — only long enough that a
// burst of calls does not pay for a doomed direct attempt each time.
const PROXIED_ORIGIN_TTL_MS = 5 * 60_000;

// Set by proxy/server.ts on a reply that is the proxy's own failure to reach
// the target — the text is what Mudlet would have reported ("Connection
// refused"), rather than the 502 it rides on.
const PROXY_ERROR_HEADER = 'X-Mudlet-Proxy-Error';

/** A request that failed before any reply from the target arrived. */
class TransportError extends Error {}

const EMPTY_RECORD = (): Record<string, unknown> => ({ headers: {}, cookies: {} });

export class HttpService {
    // Origins where a direct fetch failed (almost always CORS — there's no way
    // to distinguish CORS from network errors in a browser, both surface as
    // TypeError). Once an origin lands in here we go straight through the
    // proxy without paying for a doomed direct attempt every call.
    // Origin → when it was last sent to the proxy.
    private readonly proxiedOrigins = new Map<string, number>();
    // Origins a direct fetch has already reached and read a reply from, so they
    // answer CORS: a POST to one of these can safely go direct. See
    // fetchWithFallback for why a POST to any other origin cannot.
    private readonly directOrigins = new Set<string>();

    /**
     * The response record Mudlet hands to every HTTP event as its last argument:
     * `{ headers = {...}, cookies = {...} }`. Scripts read it to branch on what
     * came back — a content type, a rate-limit header — and we were passing an
     * empty string, so `response.headers` was an index into nothing.
     *
     * `cookies` is always empty, and has to be: a browser never exposes
     * `Set-Cookie` to script, cross-origin or not. It is still present, because
     * the shape is the contract — a script doing `response.cookies["session"]`
     * should read nil, not fail on indexing a missing table.
     */
    private responseRecord(headers: Headers): Record<string, unknown> {
        return { headers: Object.fromEntries(headers.entries()), cookies: {} };
    }

    constructor(
        private readonly emit: EmitFn,
        private readonly vfsGetter: VFSGetter,
        private readonly proxyUrlGetter: ProxyUrlGetter = () => undefined,
        private readonly defer: DeferFn = fn => queueMicrotask(fn),
        /** Consulted before the profile VFS when serving a `file:` URL, so a
         *  bundled path resolves the same way Lua's io.open resolves it. */
        private readonly localReader: LocalReader = () => null,
    ) {}

    downloadFile(saveTo: string, rawUrl: string): void {
        const url = normalizeUserUrl(rawUrl);
        const scheme = explicitScheme(url);
        // `file:` means the local filesystem, and here that is the VFS. Qt's
        // network manager serves these too, so scripts (and Mudlet's own specs)
        // use them to install a package that is already on disk without going
        // near the network. fetch() cannot: a page served over http may not read
        // file: URLs. Copying through the VFS is what the URL actually asks for.
        if (scheme === 'file') {
            this.copyLocalFile(saveTo, url);
            return;
        }
        // A scheme the browser cannot fetch is refused here rather than left to
        // fetch(): its rejection is indistinguishable from a CORS failure, so
        // the proxy fallback would try the whole thing a second time before
        // reporting an error that never named the real problem.
        if (scheme && scheme !== 'http' && scheme !== 'https') {
            this.emitLater('sysDownloadError',
                [`'${scheme}' urls cannot be downloaded, only http and https`, saveTo, url, EMPTY_RECORD()]);
            return;
        }
        this.runDownload(saveTo, url).catch(err => {
            this.emit('sysDownloadError', [errorMessage(err), saveTo, url, EMPTY_RECORD()]);
        });
    }

    getHTTP(url: string, headers?: Record<string, string>): void {
        void this.runRequest('GET', normalizeUserUrl(url), undefined, headers, 'sysGetHttpDone', 'sysGetHttpError');
    }

    postHTTP(data: string | null, url: string, headers?: Record<string, string>, file?: string): void {
        this.upload('POST', data, normalizeUserUrl(url), headers, file, 'sysPostHttpDone', 'sysPostHttpError');
    }

    putHTTP(data: string | null, url: string, headers?: Record<string, string>, file?: string): void {
        this.upload('PUT', data, normalizeUserUrl(url), headers, file, 'sysPutHttpDone', 'sysPutHttpError');
    }

    deleteHTTP(url: string, headers?: Record<string, string>): void {
        void this.runRequest('DELETE', normalizeUserUrl(url), undefined, headers, 'sysDeleteHttpDone', 'sysDeleteHttpError');
    }

    customHTTP(method: string, data: string | null, url: string, headers?: Record<string, string>, file?: string): void {
        // The verb goes between the body and the response record in both
        // events — handleHttpOK in Mudlet puts it there.
        this.upload(method, data, normalizeUserUrl(url), headers, file,
            'sysCustomHttpDone', 'sysCustomHttpError', [method]);
    }

    private upload(
        method: string,
        data: string | null,
        url: string,
        headers: Record<string, string> | undefined,
        file: string | undefined,
        doneEvent: string,
        errorEvent: string,
        extraArgs: unknown[] = [],
    ): void {
        let body: BodyInit | undefined;
        try {
            body = this.bodyForUpload(data, file);
        } catch (err) {
            this.emitLater(errorEvent, [errorMessage(err), url, ...extraArgs, EMPTY_RECORD()]);
            return;
        }
        const verb = method.toUpperCase();
        // A GET or HEAD cannot carry a body in fetch — the Request constructor
        // throws — and customHTTP("GET", "", url) is how a script spells "no
        // body", since the data argument is mandatory. A non-empty one is still
        // passed through, to fail honestly rather than vanish.
        if ((verb === 'GET' || verb === 'HEAD') && data === '' && !file) body = undefined;
        // fetch labels a string body text/plain;charset=UTF-8 on its own. Mudlet
        // sends no Content-Type for a PUT or a custom verb, and for a POST falls
        // back to application/x-www-form-urlencoded (Qt's own default) — which a
        // form handler (PHP's $_POST, express.urlencoded) needs to see a form at
        // all. Sending the string as bytes stops fetch inventing a type; the
        // form default is CORS-safelisted, so it costs a direct POST nothing.
        if (typeof body === 'string') body = new TextEncoder().encode(body);
        let sendHeaders = headers;
        if (verb === 'POST' && !Object.keys(headers ?? {}).some(k => k.toLowerCase() === 'content-type')) {
            sendHeaders = { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' };
        }
        void this.runRequest(method, url, body, sendHeaders, doneEvent, errorEvent, extraArgs);
    }

    /**
     * Serve a `file:` URL out of the VFS, reporting through the same
     * sysDownloadDone/sysDownloadError a network download would.
     *
     * The path is the URL's own, percent-decoded — `file:///lua/x` reads
     * `/lua/x`, which may be the read-only bundled namespace as readily as the
     * profile, exactly as Lua's io.open sees both.
     */
    private copyLocalFile(saveTo: string, url: string): void {
        this.defer(() => {
            let path: string;
            try { path = decodeURIComponent(url.trim().replace(/^file:\/\//i, '')); }
            catch { path = url.trim().replace(/^file:\/\//i, ''); }

            const vfs = this.vfsGetter();
            if (!vfs) return this.emit('sysDownloadError', ['no profile VFS available', saveTo, url, EMPTY_RECORD()]);

            let data: Uint8Array | null = this.localReader(path);
            if (!data) {
                try { data = vfs.exists(path) ? vfs.readBinaryFile(path) : null; }
                catch { data = null; }
            }
            // Same unterminated quote as the install path had — Mudlet closes it.
            if (!data) return this.emit('sysDownloadError', [`could not open file '${path}'`, saveTo, url, EMPTY_RECORD()]);

            try { vfs.writeBinaryFile(saveTo, data); }
            catch (err) {
                return this.emit('sysDownloadError',
                    [`save to '${saveTo}' failed: ${errorMessage(err)}`, saveTo, url, EMPTY_RECORD()]);
            }
            // Empty headers: a file: copy never spoke HTTP. Still a record, so a
            // handler can index it without knowing which kind of URL it got.
            this.emit('sysDownloadDone', [saveTo, data.byteLength, { headers: {}, cookies: {} }]);
        });
    }

    private async runDownload(saveTo: string, url: string): Promise<void> {
        const res = await this.fetchWithFallback(url, {});
        const record = this.responseRecord(res.headers);
        if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            this.emit('sysDownloadError', [httpErrorMessage(url, res), saveTo, url, record]);
            return;
        }
        const data = await this.readWithProgress(res, url);
        const vfs = this.vfsGetter();
        if (!vfs) {
            this.emit('sysDownloadError', ['no profile VFS available', saveTo, url, record]);
            return;
        }
        try {
            vfs.writeBinaryFile(saveTo, data);
        } catch (err) {
            this.emit('sysDownloadError', [`save to '${saveTo}' failed: ${errorMessage(err)}`, saveTo, url, record]);
            return;
        }
        // The third argument is the response record, not the body: the bytes are
        // already on disk, and handing them back as a Lua string would double the
        // memory cost of every large download for nothing.
        this.emit('sysDownloadDone', [saveTo, data.byteLength, this.responseRecord(res.headers)]);
    }

    private async readWithProgress(res: Response, url: string): Promise<Uint8Array> {
        const total = Number(res.headers.get('Content-Length')) || 0;
        const reader = res.body?.getReader();
        if (!reader) {
            const buf = new Uint8Array(await res.arrayBuffer());
            this.emit('sysDownloadFileProgress', [url, buf.byteLength, total || buf.byteLength]);
            return buf;
        }
        const chunks: Uint8Array[] = [];
        let received = 0;
        let lastEmit = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.byteLength;
            const now = Date.now();
            if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
                this.emit('sysDownloadFileProgress', [url, received, total || -1]);
                lastEmit = now;
            }
        }
        // Final progress event so handlers see the terminal byte count even
        // if the body landed inside the throttle window.
        this.emit('sysDownloadFileProgress', [url, received, total || received]);
        const merged = new Uint8Array(received);
        let off = 0;
        for (const c of chunks) {
            merged.set(c, off);
            off += c.byteLength;
        }
        return merged;
    }

    /**
     * Emit on a later turn of the event loop.
     *
     * Every other emit here fires from an async continuation, so it is already
     * off the call that started the request. The synchronous failures are the
     * exception — building an upload body, or refusing a url scheme outright —
     * because they would otherwise emit, and therefore dispatch Lua event
     * handlers, while still inside the `__postHTTP`/`__downloadFile` binding
     * that Lua itself called. Re-entering the Lua state mid-call crashes
     * wasmoon outright ("memory access out of bounds"), taking the whole
     * runtime with it rather than failing one call.
     *
     * The caller supplies the deferral so it can pick a queue a script can
     * actually observe: microtasks are fine in the app, but a synchronous Lua
     * run (the busted harness) never yields to one, and the runtime hands us
     * its timer queue instead.
     */
    private emitLater(event: string, args: unknown[]): void {
        this.defer(() => this.emit(event, args));
    }

    private bodyForUpload(data: string | null, file: string | undefined): BodyInit | undefined {
        if (file) {
            const vfs = this.vfsGetter();
            if (!vfs) throw new Error('no profile VFS available for file upload');
            // Copy into a fresh Uint8Array — ZenFS may return a Buffer slice
            // whose underlying ArrayBuffer extends past the file body.
            const raw = vfs.readBinaryFile(file);
            const fresh = new Uint8Array(raw.byteLength);
            fresh.set(raw);
            return fresh;
        }
        return data == null ? undefined : data;
    }

    private async runRequest(
        method: string,
        url: string,
        body: BodyInit | undefined,
        headers: Record<string, string> | undefined,
        doneEvent: string,
        errorEvent: string,
        extraArgs: unknown[] = [],
    ): Promise<void> {
        try {
            const res = await this.fetchWithFallback(url, { method, body, headers });
            const text = await res.text();
            const record = this.responseRecord(res.headers);
            if (!res.ok) {
                this.emit(errorEvent, [httpErrorMessage(url, res), url, ...extraArgs, record]);
                return;
            }
            this.emit(doneEvent, [url, text, ...extraArgs, record]);
        } catch (err) {
            this.emit(errorEvent, [errorMessage(err), url, ...extraArgs, EMPTY_RECORD()]);
        }
    }

    // Try the direct fetch first; on failure (almost always CORS), retry
    // through the configured proxy and remember the origin for a while so the
    // calls right after skip the doomed direct attempt. Throws if both
    // attempts fail, or if the direct attempt fails and no proxy is configured.
    //
    // A POST is the exception. It is the one verb a browser sends *without* a
    // CORS preflight, so a server that answers no CORS headers still receives
    // and acts on it — the browser only hides the reply. Retrying it through
    // the proxy then performs the action a second time. So a POST to an origin
    // not yet known to answer CORS goes through the proxy first; the direct
    // attempt is only its fallback when the proxy itself cannot be reached, in
    // which case nothing was delivered. (Every other verb either is safe to
    // repeat or is preflighted, and a failed preflight never reaches the
    // handler.)
    //
    // A github.com `/raw/` url is redirected to raw.githubusercontent.com here
    // rather than by the browser, which cannot follow it — see githubRawUrl.
    // The events still report the url the script asked for: handlers match on
    // it (mpkg checks that a failed download's url ends with its catalog name),
    // and a rewritten one would not be the url they passed in.
    private async fetchWithFallback(requested: string, init: RequestInit): Promise<Response> {
        const target = githubRawUrl(requested);
        const proxyUrl = normalizeProxyBase(this.proxyUrlGetter());
        const origin = parseOrigin(target);

        // A request fetch refuses to build (a GET with a body, a malformed
        // header) is the script's mistake, not the network's: it must not be
        // retried through the proxy, nor mark the origin as needing one.
        new Request(target, init);

        const viaProxy = () => this.fetchViaProxy(proxyUrl!, target, init, origin);

        if (proxyUrl && origin && this.isProxied(origin)) return viaProxy();

        const method = (init.method ?? 'GET').toUpperCase();
        if (proxyUrl && method === 'POST' && origin && !this.answersCors(origin)) {
            let res: Response | undefined;
            try { res = await fetch(buildProxyUrl(proxyUrl, target), init); }
            catch { /* the proxy is down: nothing was sent, so direct is safe */ }
            if (res) return this.checkProxyReply(res);
        }

        let res: Response;
        try {
            res = await fetch(target, init);
        } catch (err) {
            if (!proxyUrl) throw err;
            return viaProxy();
        }
        if (origin) this.directOrigins.add(origin);
        return res;
    }

    // Only a reply the target actually produced proves the proxy was needed and
    // could help; the proxy's own "could not reach it" does neither.
    private async fetchViaProxy(proxyUrl: string, target: string, init: RequestInit, origin: string | null): Promise<Response> {
        const res = await this.checkProxyReply(await fetch(buildProxyUrl(proxyUrl, target), init));
        if (origin) this.proxiedOrigins.set(origin, Date.now());
        return res;
    }

    // The proxy's own failure to reach the target is reported with the reason
    // it carries, as Mudlet would report it, not as the 502 it rides on.
    private async checkProxyReply(res: Response): Promise<Response> {
        const failure = res.headers.get(PROXY_ERROR_HEADER);
        if (failure) {
            await res.body?.cancel().catch(() => {});
            throw new TransportError(failure);
        }
        return res;
    }

    private isProxied(origin: string): boolean {
        const since = this.proxiedOrigins.get(origin);
        if (since === undefined) return false;
        if (Date.now() - since < PROXIED_ORIGIN_TTL_MS) return true;
        this.proxiedOrigins.delete(origin);
        return false;
    }

    // The page's own origin needs no CORS; any other has to have shown it.
    private answersCors(origin: string): boolean {
        return this.directOrigins.has(origin) || origin === globalThis.location?.origin;
    }
}

// The proxy URL setting holds a WebSocket scheme (ws://wss://) since the
// MUD-tunnel use case is what users configure it for. The same Cloudflare
// Worker hostname answers HTTP traffic, so swap the scheme for HTTP forwards.
function normalizeProxyBase(raw: string | undefined): string | undefined {
    const trimmed = raw?.trim().replace(/\/$/, '');
    if (!trimmed) return undefined;
    if (trimmed.startsWith('wss://')) return 'https://' + trimmed.slice(6);
    if (trimmed.startsWith('ws://')) return 'http://' + trimmed.slice(5);
    return trimmed;
}

function buildProxyUrl(base: string, target: string): string {
    return `${base}/?url=${encodeURIComponent(target)}`;
}

// The scheme a url states for itself, lower-cased, or null when it names none.
// A schemeless "example.com/x" is not an error — Mudlet reads it through
// QUrl::fromUserInput, which means http — so only an explicit one is judged.
function explicitScheme(url: string): string | null {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url.trim());
    return m ? m[1].toLowerCase() : null;
}

function parseOrigin(url: string): string | null {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

// Qt's QNetworkReply::errorString() for a reply with an error status, which is
// what Mudlet hands the error event. HTTP/2 replies carry no reason phrase, so
// the bare status code stands in for one.
function httpErrorMessage(url: string, res: Response): string {
    return `Error transferring ${url} - server replied: ${res.statusText || res.status}`;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
