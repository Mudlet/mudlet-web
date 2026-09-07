import { describe, it, expect } from 'vitest';
import {
    connectionUrl, effectiveProxyUrl, proxyCanInspectCertificates, DEFAULT_PROXY_URL,
    type MudConnection,
} from '../../src/storage/schema';

const conn = (c: Partial<MudConnection>): MudConnection => ({
    id: 'x', name: 'x', mode: 'mud', host: 'mud.example.org', port: 23,
    proxyUrl: 'wss://proxy.example.com', ...c,
});

/** The proxy contract: `tls=1` turns on the upstream handshake, and the three
 *  tolerance flags are only meaningful alongside it. */
describe('connectionUrl TLS parameters', () => {
    it('omits every TLS parameter when TLS is off', () => {
        expect(connectionUrl(conn({}))).toBe('wss://proxy.example.com?host=mud.example.org&port=23');
    });

    it('adds tls=1 when TLS is on', () => {
        expect(connectionUrl(conn({ tls: true, port: 4443 })))
            .toBe('wss://proxy.example.com?host=mud.example.org&port=4443&tls=1');
    });

    it('adds each certificate-tolerance flag that is set', () => {
        const url = connectionUrl(conn({
            tls: true, port: 4443,
            sslIgnoreExpired: true, sslIgnoreSelfSigned: true, sslIgnoreAll: true,
        }));
        expect(url).toContain('&tls=1');
        expect(url).toContain('&tlsIgnoreExpired=1');
        expect(url).toContain('&tlsIgnoreSelfSigned=1');
        expect(url).toContain('&tlsIgnoreAll=1');
    });

    it('sends only the flags actually enabled', () => {
        const url = connectionUrl(conn({ tls: true, sslIgnoreSelfSigned: true }));
        expect(url).toContain('&tlsIgnoreSelfSigned=1');
        expect(url).not.toContain('tlsIgnoreExpired');
        expect(url).not.toContain('tlsIgnoreAll');
    });

    it('does not leak tolerance flags when TLS itself is off', () => {
        // Otherwise a profile that once used TLS would keep sending cert options
        // to a proxy that is now being asked for a plaintext connection.
        const url = connectionUrl(conn({ tls: false, sslIgnoreAll: true }));
        expect(url).not.toContain('tls');
    });

    it('leaves websocket-mode URLs untouched', () => {
        const url = connectionUrl(conn({ mode: 'websocket', url: 'wss://mud.example.org/ws', tls: true }));
        expect(url).toBe('wss://mud.example.org/ws');
    });
});

describe('effectiveProxyUrl', () => {
    it('prefers the connection proxy, then the user proxy, then the default', () => {
        expect(effectiveProxyUrl(conn({ proxyUrl: 'wss://mine.example.com' }), 'wss://user.example.com'))
            .toBe('wss://mine.example.com');
        expect(effectiveProxyUrl(conn({ proxyUrl: undefined }), 'wss://user.example.com'))
            .toBe('wss://user.example.com');
        expect(effectiveProxyUrl(conn({ proxyUrl: undefined }))).toBe(DEFAULT_PROXY_URL);
    });

    it('strips a trailing slash so the URL matches what connectionUrl builds', () => {
        expect(effectiveProxyUrl(conn({ proxyUrl: 'wss://mine.example.com/' }))).toBe('wss://mine.example.com');
    });
});

/** Certificate tolerance is only meaningful on a proxy that can read the peer
 *  certificate — the Node proxy. Workers cannot, so the UI hides the options. */
describe('proxyCanInspectCertificates', () => {
    it('says no for a Cloudflare Worker, including the built-in default', () => {
        expect(proxyCanInspectCertificates('wss://mudix.delwing.workers.dev')).toBe(false);
        expect(proxyCanInspectCertificates('wss://anything.someone.workers.dev')).toBe(false);
        // The built-in default is a Worker on a custom domain, so its name is
        // no help — it is recognised as itself.
        expect(proxyCanInspectCertificates(DEFAULT_PROXY_URL)).toBe(false);
        expect(proxyCanInspectCertificates('wss://web-proxy.mudlet.org')).toBe(false);
    });

    it('is case-insensitive about the hostname', () => {
        expect(proxyCanInspectCertificates('wss://mudix.delwing.Workers.Dev')).toBe(false);
    });

    it('says yes for a self-hosted proxy', () => {
        expect(proxyCanInspectCertificates('ws://localhost:3001')).toBe(true);
        expect(proxyCanInspectCertificates('wss://proxy.example.com')).toBe(true);
    });

    it('is not fooled by workers.dev appearing elsewhere in the URL', () => {
        expect(proxyCanInspectCertificates('wss://proxy.example.com/workers.dev')).toBe(true);
        expect(proxyCanInspectCertificates('wss://notworkers.dev.example.com')).toBe(true);
    });

    it('assumes support when the URL cannot be parsed, rather than hiding controls', () => {
        expect(proxyCanInspectCertificates('')).toBe(true);
        expect(proxyCanInspectCertificates('not a url')).toBe(true);
    });
});
