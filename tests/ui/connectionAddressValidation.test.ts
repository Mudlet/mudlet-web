import { describe, it, expect } from 'vitest';
import {
    validateHost, validateWsUrl, validateProxyUrl, withProxyParams, connectionUrl,
    type MudConnection,
} from '../../src/storage/schema';
import { splitHostPort } from '../../src/ui/ConnectionFormModal';
import { formatCloseError } from '../../src/mud/connection/MudClient';

/**
 * The connection form's `canSubmit` used to check non-emptiness and nothing
 * else, so every address field accepted whatever was typed and failed much
 * later — as a generic proxy error, or as a browser-internal string. Issue #56.
 */

describe('validateHost', () => {
    it('accepts an ordinary host name', () => {
        expect(validateHost('achaea.com')).toEqual({ ok: true, host: 'achaea.com' });
        expect(validateHost('  mud.example.org  ')).toEqual({ ok: true, host: 'mud.example.org' });
    });

    it('accepts an IPv4 literal, and an IPv6 one in either form', () => {
        expect(validateHost('127.0.0.1').ok).toBe(true);
        expect(validateHost('2001:db8::1').ok).toBe(true);
        expect(validateHost('[2001:db8::1]').ok).toBe(true);
        expect(validateHost('::1').ok).toBe(true);
    });

    it('accepts an internationalised host, as QUrl does', () => {
        expect(validateHost('bücher.example').ok).toBe(true);
    });

    it('reports an empty field without calling it malformed', () => {
        const r = validateHost('');
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toBe('empty');
    });

    // Each of these was accepted and stored verbatim before.
    it.each([
        ['my host with spaces'],
        ['ws://achaea.com'],
        ['http://achaea.com'],
        ['achaea.com/path'],
        ['achaea.com?x=1'],
        ['user@achaea.com'],
        ['achaea.com:23:23'],
    ])('refuses %j', (value) => {
        const r = validateHost(value);
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toBe('malformed');
    });

    // Engines disagree here and the disagreement hid the bug: Chrome
    // percent-encodes a space into the hostname and deletes a tab outright,
    // while happy-dom throws. `validateHost` decides before parsing, so the
    // answer is the same in both — verified in real Chrome, where this case
    // was still being accepted after the first cut of this function.
    it.each(['my host with spaces', 'achaea .com', 'a\tb.example', 'a\nb.example'])(
        'refuses whitespace in %j whatever the URL parser makes of it',
        (value) => {
            const r = validateHost(value);
            expect(r.ok).toBe(false);
            expect(r.ok === false && r.reason).toBe('malformed');
        },
    );

    it('refuses a host longer than DNS allows', () => {
        const r = validateHost('a'.repeat(1200));
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toBe('tooLong');
    });

    it('refuses a single label longer than 63 characters', () => {
        const r = validateHost(`${'a'.repeat(64)}.example.com`);
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toBe('tooLong');
    });

    // Mudlet refuses this too: a certificate cannot identify a server by IP
    // (dlgConnectionProfiles.cpp).
    it('refuses a raw IP address only when TLS is on', () => {
        expect(validateHost('127.0.0.1', false).ok).toBe(true);
        expect(validateHost('2001:db8::1', false).ok).toBe(true);

        const v4 = validateHost('127.0.0.1', true);
        expect(v4.ok === false && v4.reason).toBe('rawIpWithTls');
        const v6 = validateHost('2001:db8::1', true);
        expect(v6.ok === false && v6.reason).toBe('rawIpWithTls');
        expect(validateHost('achaea.com', true).ok).toBe(true);
    });
});

describe('splitHostPort', () => {
    it('moves a pasted trailing port into the Port field', () => {
        expect(splitHostPort('achaea.com:23')).toEqual({ host: 'achaea.com', port: '23' });
        expect(splitHostPort('achaea.com 4000')).toEqual({ host: 'achaea.com', port: '4000' });
    });

    it('leaves a host with no port alone', () => {
        expect(splitHostPort('achaea.com')).toEqual({ host: 'achaea.com' });
    });

    // The bug: `(.*?)[\s:]+(\d+)$` matched the IPv6 literal's own tail, so
    // `2001:db8::1` was stored as host `2001:db8`, port 1.
    it('does not tear an IPv6 literal into host and port', () => {
        expect(splitHostPort('2001:db8::1')).toEqual({ host: '2001:db8::1' });
        expect(splitHostPort('::1')).toEqual({ host: '::1' });
        expect(splitHostPort('fe80::1ff:fe23:4567:890a')).toEqual({ host: 'fe80::1ff:fe23:4567:890a' });
    });

    it('splits the bracketed IPv6 form, where the port is unambiguous', () => {
        expect(splitHostPort('[2001:db8::1]:4000')).toEqual({ host: '[2001:db8::1]', port: '4000' });
        expect(splitHostPort('[::1]:23')).toEqual({ host: '[::1]', port: '23' });
    });
});

describe('validateWsUrl', () => {
    it('accepts ws:// and wss://', () => {
        expect(validateWsUrl('wss://mud.example.com:4000').ok).toBe(true);
        expect(validateWsUrl('ws://localhost:4000', 'http:').ok).toBe(true);
    });

    it.each([
        ['http://example.com', 'wrongScheme'],
        ['https://example.com', 'wrongScheme'],
        ['javascript:alert(1)', 'wrongScheme'],
        ['not a url', 'malformed'],
        ['example.com:4000', 'wrongScheme'],
    ])('refuses %j', (value, reason) => {
        const r = validateWsUrl(value);
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toBe(reason);
    });

    // The message names the scheme the parser actually read, which for a bare
    // `example.com:4000` is "example.com:" — that being the mistake. It must not
    // invent `//` for a scheme that has none.
    it('names the scheme without inventing slashes for it', () => {
        expect(validateWsUrl('http://example.com')).toMatchObject({
            message: 'A WebSocket URL has to start with wss:// or ws://, not http:',
        });
        expect(validateWsUrl('javascript:alert(1)')).toMatchObject({
            message: 'A WebSocket URL has to start with wss:// or ws://, not javascript:',
        });
        expect(validateWsUrl('example.com:4000')).toMatchObject({
            message: 'A WebSocket URL has to start with wss:// or ws://, not example.com:',
        });
    });

    // Well-formed but unusable from an https page, which the browser only says
    // on Connect and only in its own words.
    it('flags ws:// on an https page as insecure without refusing it', () => {
        const r = validateWsUrl('ws://mud.example.com:4000', 'https:');
        expect(r).toEqual({ ok: true, url: 'ws://mud.example.com:4000', insecure: true });
    });

    it('does not flag ws:// when the page itself is http', () => {
        expect(validateWsUrl('ws://localhost:4000', 'http:')).toMatchObject({ insecure: false });
        expect(validateWsUrl('wss://mud.example.com', 'https:')).toMatchObject({ insecure: false });
    });
});

describe('validateProxyUrl', () => {
    it('treats an empty override as "use the default"', () => {
        expect(validateProxyUrl('')).toEqual({ ok: true, url: '', insecure: false });
    });

    // A bare host used to resolve against the page, so the profile dialed
    // https://mudlet-web.mudlet.org/proxy.example?host=…
    it('refuses a scheme-less address rather than resolving it against the page', () => {
        const r = validateProxyUrl('proxy.example');
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toBe('relative');
    });

    it('refuses a non-WebSocket scheme', () => {
        const r = validateProxyUrl('https://proxy.example');
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toBe('wrongScheme');
    });

    it('flags ws:// on an https page, which can only fail as mixed content', () => {
        expect(validateProxyUrl('ws://proxy.example', 'https:')).toMatchObject({ ok: true, insecure: true });
        expect(validateProxyUrl('wss://proxy.example', 'https:')).toMatchObject({ ok: true, insecure: false });
    });

    it('accepts a proxy carrying its own query string', () => {
        expect(validateProxyUrl('wss://p.example/?token=abc').ok).toBe(true);
    });
});

describe('withProxyParams', () => {
    it('keeps the base exactly as given, rather than canonicalising it', () => {
        expect(withProxyParams('wss://p.example', [['host', 'a.example'], ['port', '23']]))
            .toBe('wss://p.example?host=a.example&port=23');
    });

    // The sharp edge: `${base}?host=…` produced a second `?`, so a self-hosted
    // proxy carrying a token in its query string could never be dialed.
    it('merges into a base that already has a query, with no second ?', () => {
        const url = withProxyParams('wss://p.example/?token=abc', [['host', 'a.example'], ['port', '23']]);
        expect(url.match(/\?/g)).toHaveLength(1);
        const parsed = new URL(url);
        expect(parsed.searchParams.get('token')).toBe('abc');
        expect(parsed.searchParams.get('host')).toBe('a.example');
        expect(parsed.searchParams.get('port')).toBe('23');
    });

    it('lets the dial parameters win over same-named ones in the base', () => {
        const url = withProxyParams('wss://p.example/?host=stale', [['host', 'fresh.example']]);
        expect(new URL(url).searchParams.getAll('host')).toEqual(['fresh.example']);
    });

    it('carries a token through the real connectionUrl path', () => {
        const c: MudConnection = {
            id: '1', name: 'x', mode: 'mud',
            host: 'mud.example.org', port: 4000,
            proxyUrl: 'wss://p.example/?token=abc',
        };
        const parsed = new URL(connectionUrl(c));
        expect(parsed.searchParams.get('token')).toBe('abc');
        expect(parsed.searchParams.get('port')).toBe('4000');
    });
});

describe('formatCloseError', () => {
    const close = (code: number, reason = '') => ({ code, reason }) as CloseEvent;

    // Websocket mode has no proxy in the path at all, so blaming one sent
    // people to check infrastructure that was not involved.
    it('does not blame a proxy for a direct websocket failure', () => {
        const msg = formatCloseError(close(1006), false, false);
        expect(msg).not.toMatch(/proxy/i);
        expect(msg).toMatch(/server was unreachable/);
    });

    it('does blame the proxy in proxy mode, where one is in the path', () => {
        expect(formatCloseError(close(1006), false, true)).toMatch(/proxy was unreachable/);
    });

    // The Worker reports the same string for a name that does not resolve and
    // for a port with nothing listening, so the advice names both rather than
    // implying one.
    it('adds advice to a proxy-supplied reason on a failed connect', () => {
        const msg = formatCloseError(close(1011, 'Proxy: connect to a.example:23 failed: cannot connect'), false, true);
        expect(msg).toContain('Proxy: connect to a.example:23 failed: cannot connect');
        expect(msg).toContain('Check the address and port for the game');
    });

    it('leaves a mid-session close as the server phrased it, with no advice', () => {
        expect(formatCloseError(close(1000, 'Goodbye'), true, true)).toBe('Goodbye');
        expect(formatCloseError(close(1006), true, true)).toBe('Connection lost (no close frame received from server)');
    });
});
