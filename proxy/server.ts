import * as http from 'http';
import * as net from 'net';
import * as tls from 'tls';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = parseInt(process.env.PORT ?? '3001', 10);

const CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
};

// Hop-by-hop headers and a few that the browser auto-sets on cross-origin
// requests but the upstream server should not see (Origin/Referer leak the
// app URL; Cookie carries the user's session for *our* origin, never theirs).
const STRIPPED_REQUEST_HEADERS = new Set([
    'host', 'origin', 'referer', 'cookie', 'connection',
    'keep-alive', 'transfer-encoding', 'upgrade', 'content-length',
]);

const server = http.createServer(async (req, res) => {
    const reqUrl = req.url ?? '/';
    const parsed = new URL(reqUrl, 'http://localhost');

    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    const target = parsed.searchParams.get('url');
    if (target) {
        await forwardHttp(req, res, target);
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
    res.end('MUD Telnet-to-WebSocket proxy\n');
});

async function forwardHttp(req: http.IncomingMessage, res: http.ServerResponse, target: string): Promise<void> {
    let targetUrl: URL;
    try {
        targetUrl = new URL(target);
    } catch {
        res.writeHead(400, CORS_HEADERS);
        res.end('Invalid target URL');
        return;
    }
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        res.writeHead(400, CORS_HEADERS);
        res.end('Only http(s) targets are supported');
        return;
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (v == null) continue;
        if (STRIPPED_REQUEST_HEADERS.has(k.toLowerCase())) continue;
        headers[k] = Array.isArray(v) ? v.join(',') : String(v);
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const body = (method === 'GET' || method === 'HEAD') ? undefined : await readRequestBody(req);

    let upstream: Response;
    try {
        upstream = await fetch(targetUrl.toString(), { method, headers, body, redirect: 'follow' });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(502, CORS_HEADERS);
        res.end(`Proxy fetch failed: ${message}`);
        return;
    }

    // Strip CORS headers (we set our own) and any header that describes the
    // *transport* of the upstream body. Node's fetch auto-decodes gzip/br/
    // deflate responses, so forwarding the upstream Content-Encoding makes
    // the browser try to decompress already-decompressed bytes — silently
    // mangling binary downloads. Content-Length / Transfer-Encoding similarly
    // describe the on-wire shape, not the bytes we re-emit chunked below.
    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
        const lk = k.toLowerCase();
        if (lk.startsWith('access-control-')) return;
        if (lk === 'content-encoding' || lk === 'content-length' || lk === 'transfer-encoding') return;
        outHeaders[k] = v;
    });
    Object.assign(outHeaders, CORS_HEADERS);
    res.writeHead(upstream.status, outHeaders);

    if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) res.write(Buffer.from(value));
            }
        } catch (err) {
            console.error('[proxy] response stream error:', err);
        }
    }
    res.end();
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer);
    }
    return Buffer.concat(chunks);
}

const wss = new WebSocketServer({ server });

// WebSocket close.reason is capped at 123 bytes by the spec; trim defensively.
function clipReason(text: string): string {
    return text.length > 120 ? text.slice(0, 120) : text;
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
    if (ws.readyState === WebSocket.OPEN) {
        try { ws.close(code, clipReason(reason)); } catch { /* ignore */ }
    }
}

/** Out-of-band control message to the client. Sent as a **text** frame; MUD
 *  bytes always travel as binary frames, so the client can route the two apart
 *  without an envelope. Proxies predating TLS support simply never send these,
 *  which is what lets the client detect an out-of-date proxy. */
function sendControl(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
}

interface TlsPrefs {
    enabled: boolean;
    ignoreExpired: boolean;
    ignoreSelfSigned: boolean;
    ignoreAll: boolean;
}

function boolParam(params: URLSearchParams, name: string): boolean {
    const v = params.get(name);
    return v === '1' || v === 'true' || v === 'yes';
}

// OpenSSL verify codes, grouped the way Mudlet's ignore-flags are grouped.
// Deliberately *only* CERT_HAS_EXPIRED: Mudlet whitelists QSslError::Certificate-
// Expired alone, so a not-yet-valid cert stays fatal unless "ignore all" is set.
const EXPIRED_CODES = new Set(['CERT_HAS_EXPIRED']);
const SELF_SIGNED_CODES = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN']);

function tolerated(code: string, p: TlsPrefs): boolean {
    if (p.ignoreAll) return true;
    if (p.ignoreExpired && EXPIRED_CODES.has(code)) return true;
    if (p.ignoreSelfSigned && SELF_SIGNED_CODES.has(code)) return true;
    return false;
}

/** The cert fields the client renders. Deliberately a flat, small subset — the
 *  full PeerCertificate carries the raw DER, which we never need to ship. */
function describeCert(cert: tls.PeerCertificate | undefined): Record<string, string> | null {
    if (!cert || Object.keys(cert).length === 0) return null;
    // A DN field may legitimately repeat (multiple CNs); Qt joins them, so do we.
    const flat = (v: string | string[] | undefined): string => Array.isArray(v) ? v.join(', ') : (v ?? '');
    return {
        subject: flat(cert.subject?.CN),
        subjectOrg: flat(cert.subject?.O),
        issuer: flat(cert.issuer?.CN),
        issuerOrg: flat(cert.issuer?.O),
        validFrom: cert.valid_from ?? '',
        validTo: cert.valid_to ?? '',
        // Mudlet's Preferences → Connection → Certificate box shows issuer CN,
        // subject CN, expiry and serial; the rest is ours for diagnostics.
        serial: cert.serialNumber ?? '',
        fingerprint: cert.fingerprint256 ?? cert.fingerprint ?? '',
        altNames: cert.subjectaltname ?? '',
    };
}

/** Verify the peer ourselves instead of letting the handshake abort, so that a
 *  user who opted to tolerate an expired/self-signed cert still connects — and
 *  so we can report what the cert actually was in either outcome.
 *
 *  Returns *every* problem, because OpenSSL surfaces only the first one it hits
 *  via `authorizationError`. A self-signed cert issued for a different host
 *  reports just DEPTH_ZERO_SELF_SIGNED_CERT, so checking the identity only when
 *  `authorizationError` is clear would let "accept self-signed" silently also
 *  accept a hostname mismatch. The identity check therefore always runs. */
function certProblems(socket: tls.TLSSocket, host: string, cert: tls.PeerCertificate): { code: string; message: string }[] {
    const problems: { code: string; message: string }[] = [];
    const add = (code: string, message: string) => {
        if (!problems.some(p => p.code === code)) problems.push({ code, message });
    };

    const authErr = socket.authorizationError as unknown;
    if (authErr) {
        // Node reports this as a bare code string on some paths, an Error on others.
        const code = typeof authErr === 'string' ? authErr : ((authErr as NodeJS.ErrnoException).code ?? String(authErr));
        const message = typeof authErr === 'string' ? authErr : ((authErr as Error).message ?? String(authErr));
        add(code, message);
    }

    if (cert && Object.keys(cert).length > 0) {
        // OpenSSL stops at the first failure, but Qt hands Mudlet the *full*
        // error list and requires a matching checkbox for each. Re-derive the
        // two individually-ignorable conditions so that, e.g., "accept expired"
        // alone can't also wave through an untrusted self-signed issuer.
        const now = Date.now();
        const notAfter = Date.parse(cert.valid_to ?? '');
        const notBefore = Date.parse(cert.valid_from ?? '');
        if (Number.isFinite(notAfter) && now > notAfter) {
            add('CERT_HAS_EXPIRED', `certificate expired on ${cert.valid_to}`);
        }
        if (Number.isFinite(notBefore) && now < notBefore) {
            add('CERT_NOT_YET_VALID', `certificate is not valid until ${cert.valid_from}`);
        }
        // A depth-zero self-signed leaf has an issuer DN identical to its subject.
        // (A self-signed *root* higher in a chain is normal and is reported by
        // OpenSSL as SELF_SIGNED_CERT_IN_CHAIN instead.)
        const dn = (v: unknown) => JSON.stringify(Object.entries((v ?? {}) as Record<string, unknown>).sort());
        if (cert.subject && cert.issuer && dn(cert.subject) === dn(cert.issuer)) {
            add('DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate');
        }
        // `rejectUnauthorized: false` skips the hostname check entirely, so run
        // it explicitly — otherwise a cert for the wrong host passes unnoticed.
        const idErr = tls.checkServerIdentity(host, cert);
        if (idErr) add('ERR_TLS_CERT_ALTNAME_INVALID', idErr.message);
    }
    return problems;
}

wss.on('connection', (ws, req) => {
    const reqUrl = req.url ?? '/';
    const params = new URL(reqUrl, 'http://localhost').searchParams;
    const host = params.get('host');
    const port = parseInt(params.get('port') ?? '23', 10);

    if (!host) {
        ws.close(1008, 'Missing required query param: host');
        return;
    }

    if (isNaN(port) || port < 1 || port > 65535) {
        ws.close(1008, 'Invalid port');
        return;
    }

    const tlsPrefs: TlsPrefs = {
        enabled: boolParam(params, 'tls'),
        ignoreExpired: boolParam(params, 'tlsIgnoreExpired'),
        ignoreSelfSigned: boolParam(params, 'tlsIgnoreSelfSigned'),
        ignoreAll: boolParam(params, 'tlsIgnoreAll'),
    };

    console.log(`[proxy] Connecting to ${host}:${port}${tlsPrefs.enabled ? ' (TLS)' : ''}`);

    let tcp: net.Socket;
    let tcpConnected = false;

    if (tlsPrefs.enabled) {
        const secure = tls.connect({ host, port, servername: host, rejectUnauthorized: false });
        secure.on('secureConnect', () => {
            tcpConnected = true;
            const cert = secure.getPeerCertificate();
            const problems = certProblems(secure, host, cert);
            const blocking = problems.filter(p => !tolerated(p.code, tlsPrefs));
            if (blocking.length > 0) {
                const codes = blocking.map(p => p.code).join(', ');
                console.warn(`[proxy] TLS cert rejected for ${host}:${port}: ${codes}`);
                sendControl(ws, {
                    type: 'tls.error',
                    code: blocking[0].code,
                    message: blocking.map(p => p.message).join('; '),
                    codes: blocking.map(p => p.code),
                    cert: describeCert(cert),
                });
                safeClose(ws, 1011, `Proxy: TLS certificate rejected: ${codes}`);
                secure.destroy();
                return;
            }
            console.log(`[proxy] Connected to ${host}:${port} over ${secure.getProtocol() ?? 'TLS'}`);
            sendControl(ws, { type: 'game.connected' });
            sendControl(ws, {
                type: 'tls.established',
                protocol: secure.getProtocol() ?? '',
                cipher: secure.getCipher()?.name ?? '',
                cert: describeCert(cert),
                // Non-empty when the user's ignore-flags waved real problems through,
                // so the UI can show that the link is encrypted but unverified.
                acceptedDespite: problems.map(p => p.code),
            });
        });
        tcp = secure;
    } else {
        tcp = net.connect(port, host);
        tcp.on('connect', () => {
            tcpConnected = true;
            console.log(`[proxy] Connected to ${host}:${port}`);
            // The client's WebSocket opened when *this* socket was still being
            // dialled, so it cannot tell "connected to the game" from "the proxy
            // accepted me" on its own. Say which one just happened, so
            // auto-reconnect measures the session against the game's socket
            // rather than the proxy's (issue #130).
            sendControl(ws, { type: 'game.connected' });
        });
    }

    tcp.on('data', (chunk: Buffer) => {
        if (ws.readyState === WebSocket.OPEN) {
            // Binary frame — raw bytes, no base64 (matches the client + worker).
            ws.send(chunk, { binary: true });
        }
    });

    tcp.on('error', (err: NodeJS.ErrnoException) => {
        console.error(`[proxy] TCP error for ${host}:${port}: ${err.message}`);
        const phase = tcpConnected ? 'TCP error' : `connect to ${host}:${port} failed`;
        const reason = err.code ? `Proxy: ${phase}: ${err.code}` : `Proxy: ${phase}: ${err.message}`;
        safeClose(ws, 1011, reason);
    });

    tcp.on('close', () => {
        console.log(`[proxy] TCP closed for ${host}:${port}`);
        safeClose(ws, 1000, 'TCP connection closed');
    });

    ws.on('message', (data) => {
        if (!tcp.writable) return;
        try {
            // Client sends binary frames; `data` is a Buffer (or fragments).
            const bytes = Array.isArray(data)
                ? Buffer.concat(data)
                : Buffer.isBuffer(data)
                    ? data
                    : Buffer.from(data as ArrayBuffer);
            tcp.write(bytes);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[proxy] Failed to forward message:', message);
            safeClose(ws, 1011, `Proxy: TCP write error: ${message}`);
            tcp.destroy();
        }
    });

    ws.on('close', () => {
        console.log(`[proxy] WebSocket closed for ${host}:${port}`);
        tcp.destroy();
    });

    ws.on('error', (err) => {
        console.error(`[proxy] WebSocket error: ${err.message}`);
        tcp.destroy();
    });
});

server.listen(PORT, () => {
    console.log(`[proxy] Listening on ws://localhost:${PORT}`);
    console.log(`[proxy] Usage: connect with ws://localhost:${PORT}?host=<mud-host>&port=<mud-port>`);
    console.log(`[proxy] Example: ws://localhost:${PORT}?host=aardmud.org&port=23`);
    console.log(`[proxy] TLS:     add &tls=1 (optionally &tlsIgnoreExpired=1, &tlsIgnoreSelfSigned=1, &tlsIgnoreAll=1)`);
});
