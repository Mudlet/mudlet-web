import { connect } from 'cloudflare:sockets';

const CORS_HEADERS = {
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
    'keep-alive', 'transfer-encoding', 'upgrade',
]);

// WebSocket close.reason has a 123-byte limit; trimming defensively.
function clipReason(text) {
    const str = String(text ?? '').slice(0, 120);
    return str.length === 0 ? 'unknown error' : str;
}

function describeError(err) {
    if (!err) return 'unknown error';
    if (err.message) return err.message;
    return String(err);
}

function safeClose(server, code, reason) {
    if (server.readyState === WebSocket.OPEN) {
        try { server.close(code, clipReason(reason)); } catch { /* ignore */ }
    }
}

/** Out-of-band control message to the client, as a **text** frame; MUD bytes
 *  always travel as binary. Mirrors the Node proxy's control channel. */
function sendControl(server, payload) {
    if (server.readyState !== WebSocket.OPEN) return;
    try { server.send(JSON.stringify(payload)); } catch { /* ignore */ }
}

function boolParam(params, name) {
    const v = params.get(name);
    return v === '1' || v === 'true' || v === 'yes';
}

function withCors(headers) {
    const h = new Headers(headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) h.set(k, v);
    return h;
}

async function forwardHttp(request, target) {
    let targetUrl;
    try {
        targetUrl = new URL(target);
    } catch {
        return new Response('Invalid target URL', { status: 400, headers: CORS_HEADERS });
    }
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        return new Response('Only http(s) targets are supported', { status: 400, headers: CORS_HEADERS });
    }

    const fwdHeaders = new Headers();
    for (const [k, v] of request.headers.entries()) {
        if (!STRIPPED_REQUEST_HEADERS.has(k.toLowerCase())) fwdHeaders.set(k, v);
    }

    const init = { method: request.method, headers: fwdHeaders, redirect: 'follow' };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = request.body;
    }

    let upstream;
    try {
        upstream = await fetch(targetUrl.toString(), init);
    } catch (err) {
        return new Response(`Proxy fetch failed: ${describeError(err)}`, { status: 502, headers: CORS_HEADERS });
    }

    return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: withCors(upstream.headers),
    });
}

export default {
    async fetch(request) {
        const url = new URL(request.url);

        const upgradeHeader = request.headers.get('Upgrade');
        const isWebSocket = upgradeHeader && upgradeHeader.toLowerCase() === 'websocket';

        if (!isWebSocket) {
            if (request.method === 'OPTIONS') {
                return new Response(null, { status: 204, headers: CORS_HEADERS });
            }
            const target = url.searchParams.get('url');
            if (target) return forwardHttp(request, target);
            return new Response(
                'MUD Telnet-to-WebSocket proxy (Cloudflare Worker)\n'
                + 'TLS: add &tls=1. Certificate details and the tlsIgnore* options are\n'
                + 'unavailable on the Workers runtime; use the Node proxy for those.\n',
                { status: 200, headers: { 'Content-Type': 'text/plain', ...CORS_HEADERS } },
            );
        }

        const host = url.searchParams.get('host');
        const portStr = url.searchParams.get('port') ?? '23';
        const port = parseInt(portStr, 10);

        if (!host) {
            return new Response('Missing required query param: host', { status: 400 });
        }
        if (isNaN(port) || port < 1 || port > 65535) {
            return new Response('Invalid port', { status: 400 });
        }

        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];
        server.accept();

        const useTls = boolParam(url.searchParams, 'tls');
        // The Workers runtime's connect() exposes only `secureTransport` and
        // `allowHalfOpen` — there is no peer-certificate accessor and no way to
        // waive a validation failure. So the ignore-* options the Node proxy
        // honours cannot be implemented here; report them back as unsupported
        // rather than pretending they took effect.
        const unsupported = ['tlsIgnoreExpired', 'tlsIgnoreSelfSigned', 'tlsIgnoreAll']
            .filter((name) => boolParam(url.searchParams, name));

        let tcpClosed = false;
        let tcpSocket;
        try {
            // `connect(address, options)` takes TWO arguments — `secureTransport`
            // belongs in the *options*, not the address. Merging them into one
            // object silently drops it and opens a plaintext socket, which on a
            // TLS port just hangs waiting for a ClientHello that never comes.
            tcpSocket = connect({ hostname: host, port }, { secureTransport: useTls ? 'on' : 'off' });
        } catch (err) {
            // Synchronous failure (e.g. invalid hostname format) — surface and bail.
            safeClose(server, 1011, `Proxy: ${describeError(err)}`);
            return new Response(null, { status: 101, webSocket: client });
        }

        // The TCP `opened` promise rejects on connect failures (DNS, refused,
        // network unreachable) and, with TLS on, on handshake/certificate
        // failures. Without this, those errors used to be swallowed and the
        // client would only see a generic 1006 close.
        // `opened` resolving does NOT mean the TLS handshake succeeded — on this
        // runtime it settles optimistically. So the "established" signal is
        // deferred until the first byte is actually decrypted off the socket
        // (below); announcing it here would claim a channel that may not exist.
        //
        // Measured against workerd: when the peer's certificate is rejected this
        // socket simply goes silent forever — `opened` neither resolves nor
        // rejects, no read error fires, and the connection never closes. The
        // reporting below is therefore best-effort only, and the *client* must
        // time out a TLS connect that produces no `tls.established` rather than
        // rely on ever hearing back from here.
        let tlsConfirmed = false;
        let tlsFailureReported = false;
        const reportTlsFailure = (message) => {
            if (tlsFailureReported) return;
            tlsFailureReported = true;
            sendControl(server, {
                type: 'tls.error',
                code: 'TLS_HANDSHAKE_FAILED',
                message,
                codes: ['TLS_HANDSHAKE_FAILED'],
                cert: null,
                certInspection: false,
                unsupportedOptions: unsupported,
            });
        };

        tcpSocket.opened.then(
            () => {
                // The TCP leg is up. On the TLS path the handshake outcome is
                // still unknown here (see the read loop), but the *socket* to
                // the game exists either way, and that is what the client's
                // "has this session settled?" clock needs: its own WebSocket
                // opened before this dial even started. Issue #130.
                sendControl(server, { type: 'game.connected' });
            },
            (err) => {
                tcpClosed = true;
                if (useTls) {
                    reportTlsFailure(describeError(err));
                }
                safeClose(server, 1011, `Proxy: connect to ${host}:${port} failed: ${describeError(err)}`);
            },
        );

        const writer = tcpSocket.writable.getWriter();

        // TCP → WebSocket
        (async () => {
            const reader = tcpSocket.readable.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (useTls && !tlsConfirmed) {
                        // First decrypted byte — now the handshake is proven good.
                        tlsConfirmed = true;
                        sendControl(server, {
                            type: 'tls.established',
                            // No cert details are obtainable on this runtime; the client
                            // shows "encrypted, details unavailable" rather than a blank box.
                            certInspection: false,
                            cert: null,
                            acceptedDespite: [],
                            unsupportedOptions: unsupported,
                        });
                    }
                    if (server.readyState === WebSocket.OPEN) {
                        // Binary WebSocket frame — `value` is the raw byte view
                        // straight from the TCP socket; no base64 transcoding.
                        server.send(value);
                    }
                }
                // Clean EOF — TCP peer closed the connection normally.
                tcpClosed = true;
                if (useTls && !tlsConfirmed) reportTlsFailure('connection closed before any data was received');
                safeClose(server, 1000, 'TCP connection closed');
            } catch (err) {
                tcpClosed = true;
                // Dying before a single byte was decrypted is the signature of a
                // rejected certificate on this runtime, which cannot report one.
                if (useTls && !tlsConfirmed) reportTlsFailure(describeError(err));
                safeClose(server, 1011, `Proxy: TCP read error: ${describeError(err)}`);
            }
        })();

        // WebSocket → TCP
        server.addEventListener('message', async (event) => {
            if (tcpClosed) return;
            try {
                // Client sends binary frames; event.data is an ArrayBuffer.
                const bytes = new Uint8Array(event.data);
                await writer.write(bytes);
            } catch (err) {
                tcpClosed = true;
                safeClose(server, 1011, `Proxy: TCP write error: ${describeError(err)}`);
            }
        });

        server.addEventListener('close', () => {
            if (!tcpClosed) writer.close().catch(() => {});
        });

        server.addEventListener('error', () => {
            if (!tcpClosed) writer.abort().catch(() => {});
        });

        return new Response(null, { status: 101, webSocket: client });
    },
};
