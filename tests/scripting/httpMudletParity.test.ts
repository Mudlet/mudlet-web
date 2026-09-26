// @vitest-environment node
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { HttpService } from '../../src/scripting/http/HttpService';
import { normalizeUserUrl, userUrlInvalidReason } from '../../src/scripting/http/userUrl';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

/**
 * Where Mudlet Web's HTTP API drifted from desktop Mudlet (issue #193), each
 * pinned against the real request path with fetch stubbed.
 */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const PROXY = 'ws://proxy.invalid';

type Call = { url: string; init: RequestInit };
type Events = Array<[string, unknown[]]>;

function service(events: Events, proxy?: string) {
    return new HttpService((e, a) => events.push([e, a]), () => null, () => proxy, fn => fn());
}

/** fetch stub: `respond` decides per call; every call is recorded. */
function stubFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url: String(url), init });
        return respond(String(url), init);
    }));
    return calls;
}

const isProxied = (url: string) => url.startsWith('http://proxy.invalid/');
const find = (events: Events, name: string) => events.find(([e]) => e === name)?.[1];

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a POST is never replayed through the proxy', () => {
    // The browser delivers a simple POST to a server with no CORS headers and
    // only hides the reply; retrying it through the proxy made the server act on
    // it twice.
    it('goes through the proxy first when the origin is not known to answer CORS', async () => {
        const calls = stubFetch(url => {
            if (!isProxied(url)) throw new TypeError('Failed to fetch');
            return new Response('ok', { status: 200 });
        });
        const events: Events = [];
        service(events, PROXY).postHTTP('buy=sword', 'http://game.invalid/buy');
        await flush();

        expect(calls.map(c => c.url)).toEqual([
            `http://proxy.invalid/?url=${encodeURIComponent('http://game.invalid/buy')}`,
        ]);
        expect(find(events, 'sysPostHttpDone')?.[1]).toBe('ok');
    });

    it('goes direct once a direct request to the origin has read a reply', async () => {
        const calls = stubFetch(() => new Response('ok', { status: 200 }));
        const events: Events = [];
        const http = service(events, PROXY);
        http.getHTTP('http://api.invalid/status');
        await flush();
        http.postHTTP('x=1', 'http://api.invalid/post');
        await flush();

        expect(calls.map(c => c.url)).toEqual(['http://api.invalid/status', 'http://api.invalid/post']);
    });

    it('falls back to direct only when the proxy itself cannot be reached', async () => {
        const calls = stubFetch(url => {
            if (isProxied(url)) throw new TypeError('Failed to fetch');
            return new Response('ok', { status: 200 });
        });
        const events: Events = [];
        service(events, PROXY).postHTTP('x=1', 'http://game.invalid/buy');
        await flush();

        expect(calls).toHaveLength(2);
        expect(calls[1].url).toBe('http://game.invalid/buy');
        expect(find(events, 'sysPostHttpDone')).toBeDefined();
    });

    it('is sent direct, once, with no proxy configured', async () => {
        const calls = stubFetch(() => { throw new TypeError('Failed to fetch'); });
        const events: Events = [];
        service(events).postHTTP('x=1', 'http://game.invalid/buy');
        await flush();

        expect(calls).toHaveLength(1);
        expect(find(events, 'sysPostHttpError')).toBeDefined();
    });
});

describe('error events', () => {
    it('carry the response record and Qt\'s wording', async () => {
        stubFetch(() => new Response('boom', {
            status: 500, statusText: 'Internal Server Error', headers: { 'X-Test': '1' },
        }));
        const events: Events = [];
        service(events).getHTTP('http://example.invalid/500');
        await flush();

        const args = find(events, 'sysGetHttpError')!;
        expect(args[0]).toBe('Error transferring http://example.invalid/500 - server replied: Internal Server Error');
        expect(args[1]).toBe('http://example.invalid/500');
        expect((args[2] as { headers: Record<string, string> }).headers['x-test']).toBe('1');
    });

    it('carry the record on a download error too, after the url', async () => {
        stubFetch(() => new Response('', { status: 404, statusText: 'Not Found' }));
        const events: Events = [];
        service(events).downloadFile('/profiles/t/x', 'http://example.invalid/x');
        await flush();

        const args = find(events, 'sysDownloadError')!;
        expect(args.slice(0, 3)).toEqual([
            'Error transferring http://example.invalid/x - server replied: Not Found',
            '/profiles/t/x', 'http://example.invalid/x',
        ]);
        expect(args[3]).toHaveProperty('headers');
    });

    it('carry an empty record when no reply arrived', async () => {
        stubFetch(() => { throw new TypeError('Failed to fetch'); });
        const events: Events = [];
        service(events).deleteHTTP('http://example.invalid/x');
        await flush();

        expect(find(events, 'sysDeleteHttpError')).toEqual(
            ['Failed to fetch', 'http://example.invalid/x', { headers: {}, cookies: {} }]);
    });

    // The proxy answers 502 when it cannot reach the target; the reason it
    // names is what Mudlet would have reported.
    it('report the proxy\'s reason rather than its 502', async () => {
        stubFetch(url => {
            if (!isProxied(url)) throw new TypeError('Failed to fetch');
            return new Response('Proxy fetch failed', {
                status: 502, statusText: 'Bad Gateway', headers: { 'X-Mudlet-Proxy-Error': 'Connection refused' },
            });
        });
        const events: Events = [];
        service(events, PROXY).getHTTP('http://down.invalid/x');
        await flush();

        expect(find(events, 'sysGetHttpError')?.[0]).toBe('Connection refused');
    });
});

describe('customHTTP', () => {
    it('puts the verb before the response record in sysCustomHttpDone', async () => {
        stubFetch(() => new Response('body', { status: 200 }));
        const events: Events = [];
        service(events).customHTTP('PATCH', 'd', 'http://example.invalid/x');
        await flush();

        const args = find(events, 'sysCustomHttpDone')!;
        expect(args.slice(0, 3)).toEqual(['http://example.invalid/x', 'body', 'PATCH']);
        expect(args[3]).toHaveProperty('headers');
    });

    it('puts the verb before the response record in sysCustomHttpError', async () => {
        stubFetch(() => new Response('', { status: 405, statusText: 'Method Not Allowed' }));
        const events: Events = [];
        service(events).customHTTP('REPORT', 'd', 'http://example.invalid/x');
        await flush();

        const args = find(events, 'sysCustomHttpError')!;
        expect(args.slice(1, 3)).toEqual(['http://example.invalid/x', 'REPORT']);
        expect(args[3]).toHaveProperty('headers');
    });

    it('makes a GET with the empty body a script has to pass', async () => {
        const calls = stubFetch(() => new Response('hello', { status: 200 }));
        const events: Events = [];
        service(events, PROXY).customHTTP('GET', '', 'http://example.invalid/ok');
        await flush();

        expect(calls).toHaveLength(1);
        expect(calls[0].init.body).toBeUndefined();
        expect(find(events, 'sysCustomHttpDone')?.[1]).toBe('hello');
    });

    it('does not send a request fetch refuses to the proxy', async () => {
        const calls = stubFetch(() => new Response('hello', { status: 200 }));
        const events: Events = [];
        service(events, PROXY).customHTTP('GET', 'not empty', 'http://example.invalid/ok');
        await flush();

        expect(calls).toHaveLength(0);
        expect(find(events, 'sysCustomHttpError')).toBeDefined();
    });
});

describe('Content-Type', () => {
    const contentType = (init: RequestInit) =>
        Object.entries((init.headers ?? {}) as Record<string, string>)
            .find(([k]) => k.toLowerCase() === 'content-type')?.[1];

    it('defaults a POST to a form, as Qt does', async () => {
        const calls = stubFetch(() => new Response('', { status: 200 }));
        service([]).postHTTP('name=bob', 'http://example.invalid/form');
        await flush();

        expect(contentType(calls[0].init)).toBe('application/x-www-form-urlencoded');
        // Bytes, not a string: fetch labels a string text/plain on its own.
        expect(new Request('http://x.invalid', { ...calls[0].init }).headers.get('content-type'))
            .toBe('application/x-www-form-urlencoded');
    });

    it('keeps a Content-Type the script chose', async () => {
        const calls = stubFetch(() => new Response('', { status: 200 }));
        service([]).postHTTP('{}', 'http://example.invalid/json', { 'content-type': 'application/json' });
        await flush();

        expect(contentType(calls[0].init)).toBe('application/json');
    });

    it('sends none on a PUT', async () => {
        const calls = stubFetch(() => new Response('', { status: 200 }));
        service([]).putHTTP('data', 'http://example.invalid/put');
        await flush();

        expect(new Request('http://x.invalid', calls[0].init).headers.get('content-type')).toBeNull();
    });
});

describe('proxied origins', () => {
    it('are tried direct again once the proxy window lapses', async () => {
        let now = 1_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        let directFails = true;
        const calls = stubFetch(url => {
            if (!isProxied(url) && directFails) throw new TypeError('Failed to fetch');
            return new Response('ok', { status: 200 });
        });
        const http = service([], PROXY);
        http.getHTTP('http://cors.invalid/a');
        await flush();
        expect(calls.map(c => isProxied(c.url))).toEqual([false, true]);

        directFails = false;
        http.getHTTP('http://cors.invalid/b');
        await flush();
        expect(isProxied(calls[2].url)).toBe(true);

        now += 10 * 60_000;
        http.getHTTP('http://cors.invalid/c');
        await flush();
        expect(calls[3].url).toBe('http://cors.invalid/c');
    });

    it('are not marked by a proxy that could not reach the target', async () => {
        const calls = stubFetch(url => {
            if (!isProxied(url)) throw new TypeError('Failed to fetch');
            return new Response('', { status: 502, headers: { 'X-Mudlet-Proxy-Error': 'Connection refused' } });
        });
        const http = service([], PROXY);
        http.getHTTP('http://down.invalid/a');
        await flush();
        http.getHTTP('http://down.invalid/b');
        await flush();

        expect(calls.map(c => isProxied(c.url))).toEqual([false, true, false, true]);
    });
});

describe('urls without a scheme', () => {
    it('are read as QUrl::fromUserInput reads them', () => {
        expect(normalizeUserUrl('127.0.0.1:8080/ok')).toBe('http://127.0.0.1:8080/ok');
        expect(normalizeUserUrl('localhost:8080/ok')).toBe('http://localhost:8080/ok');
        expect(normalizeUserUrl('localhost:8080')).toBe('http://localhost:8080');
        expect(normalizeUserUrl('example.com/x')).toBe('http://example.com/x');
        expect(normalizeUserUrl('  https://example.com/x ')).toBe('https://example.com/x');
        expect(normalizeUserUrl('ftp://example.com/x')).toBe('ftp://example.com/x');
        expect(normalizeUserUrl('/abs/path')).toBe('file:///abs/path');
        expect(userUrlInvalidReason('')).toBe('empty url');
        expect(userUrlInvalidReason('127.0.0.1:8080/ok')).toBeNull();
    });

    it('are fetched over http rather than relative to the page', async () => {
        const calls = stubFetch(() => new Response('hello', { status: 200 }));
        const events: Events = [];
        service(events).getHTTP('127.0.0.1:8080/ok');
        await flush();

        expect(calls[0].url).toBe('http://127.0.0.1:8080/ok');
        expect(find(events, 'sysGetHttpDone')?.[0]).toBe('http://127.0.0.1:8080/ok');
    });

    describe('from Lua', () => {
        let t: TestRuntime;
        beforeAll(async () => { t = await createTestRuntime(); });
        afterAll(() => t.dispose());

        it('come back normalised as the second return value', () => {
            vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
            expect(t.run('local ok, url = getHTTP("127.0.0.1:8080/ok"); return url'))
                .toBe('http://127.0.0.1:8080/ok');
            expect(t.run('local ok, url = downloadFile(getMudletHomeDir() .. "/x", "example.invalid/x"); return url'))
                .toBe('http://example.invalid/x');
        });
    });
});
