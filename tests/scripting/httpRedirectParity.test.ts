// @vitest-environment node
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { configure, InMemory, mkdirSync, existsSync } from '@zenfs/core';
import { HttpService } from '../../src/scripting/http/HttpService';
import { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

/**
 * HTTP drift against desktop Mudlet reported in issue #349: the url and event
 * after a redirect, 300/304 replies, a download of unknown length, an empty
 * upload file, and a download into a directory that does not exist.
 */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const PROXY = 'ws://proxy.invalid';

type Events = Array<[string, unknown[]]>;

function service(events: Events, vfs: unknown = null, proxy?: string) {
    return new HttpService((e, a) => events.push([e, a]), () => vfs as never, () => proxy, fn => fn());
}

/** A Response as fetch hands one back after following a redirect to `url`. */
function redirected(body: string, url: string, init: ResponseInit = { status: 200 }): Response {
    const res = new Response(body, init);
    Object.defineProperty(res, 'redirected', { value: true });
    Object.defineProperty(res, 'url', { value: url });
    return res;
}

function stubFetch(respond: (url: string, init: RequestInit) => Response): Array<{ url: string; init: RequestInit }> {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url: String(url), init });
        return respond(String(url), init);
    }));
    return calls;
}

const names = (events: Events) => events.map(([e]) => e);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a redirected request reports where it ended up', () => {
    it('names the final url in sysGetHttpDone', async () => {
        stubFetch(() => redirected('echo', 'http://h.invalid/echo?from=g302'));
        const events: Events = [];
        service(events).getHTTP('http://h.invalid/r302?t=g302');
        await flush();

        expect(events).toHaveLength(1);
        expect(events[0][0]).toBe('sysGetHttpDone');
        expect(events[0][1].slice(0, 2)).toEqual(['http://h.invalid/echo?from=g302', 'echo']);
    });

    it('names the final url the proxy reports, and keeps its headers out of the record', async () => {
        stubFetch(() => new Response('echo', {
            status: 200,
            headers: { 'X-Mudlet-Final-Url': 'http://h.invalid/echo', 'X-Real': '1' },
        }));
        const events: Events = [];
        service(events, null, PROXY).getHTTP('http://h.invalid/r302');
        await flush();

        const [url, , record] = events[0][1] as [string, string, { headers: Record<string, string> }];
        expect(url).toBe('http://h.invalid/echo');
        expect(record.headers).toEqual({ 'content-type': 'text/plain;charset=UTF-8', 'x-real': '1' });
    });

    it('keeps the requested url when nothing redirected', async () => {
        stubFetch(() => new Response('ok', { status: 200 }));
        const events: Events = [];
        service(events).getHTTP('http://h.invalid/plain');
        await flush();
        expect(events[0][1][0]).toBe('http://h.invalid/plain');
    });
});

describe('a 301/302/303 ends a non-GET request as a GET', () => {
    const cases: Array<[string, (http: HttpService) => void]> = [
        ['putHTTP', http => http.putHTTP('ud', 'http://h.invalid/r302?t=u302')],
        ['postHTTP', http => http.postHTTP('pd', 'http://h.invalid/r302?t=u302')],
        ['deleteHTTP', http => http.deleteHTTP('http://h.invalid/r302?t=u302')],
        ['customHTTP PATCH', http => http.customHTTP('PATCH', 'cd', 'http://h.invalid/r302?t=u302')],
    ];

    for (const [label, call] of cases) {
        it(`${label} finishes as sysGetHttpDone with the final url (direct)`, async () => {
            stubFetch(() => redirected('GET 0 ', 'http://h.invalid/echo?from=u302'));
            const events: Events = [];
            call(service(events));
            await flush();

            expect(names(events)).toEqual(['sysGetHttpDone']);
            // No verb argument: the GET event carries (url, body, response).
            expect(events[0][1]).toHaveLength(3);
            expect(events[0][1].slice(0, 2)).toEqual(['http://h.invalid/echo?from=u302', 'GET 0 ']);
        });
    }

    it('reports an error after the redirect as sysGetHttpError', async () => {
        stubFetch(() => redirected('', 'http://h.invalid/gone', { status: 404, statusText: 'Not Found' }));
        const events: Events = [];
        service(events).putHTTP('ud', 'http://h.invalid/r302');
        await flush();

        expect(names(events)).toEqual(['sysGetHttpError']);
        expect(events[0][1][1]).toBe('http://h.invalid/gone');
    });

    it('takes the GET event after a redirect the proxy reports, with the custom verb argument dropped', async () => {
        stubFetch(() => new Response('GET 0 ', {
            status: 200,
            headers: { 'X-Mudlet-Final-Url': 'http://h.invalid/echo' },
        }));
        const events: Events = [];
        const http = service(events, null, PROXY);
        (http as unknown as { proxiedOrigins: Map<string, number> }).proxiedOrigins.set('http://h.invalid', Date.now());
        http.customHTTP('PATCH', 'cd', 'http://h.invalid/r303');
        await flush();

        expect(names(events)).toEqual(['sysGetHttpDone']);
        expect(events[0][1]).toHaveLength(3);
    });
});

describe('300 and 304 are replies, not errors', () => {
    it('reports a 300 without a Location as sysGetHttpDone with its body', async () => {
        stubFetch(() => new Response('multiple', { status: 300, statusText: 'Multiple Choices' }));
        const events: Events = [];
        service(events).getHTTP('http://h.invalid/s300');
        await flush();

        expect(names(events)).toEqual(['sysGetHttpDone']);
        expect(events[0][1].slice(0, 2)).toEqual(['http://h.invalid/s300', 'multiple']);
    });

    it('reports a 304 as sysGetHttpDone with an empty body', async () => {
        stubFetch(() => new Response(null, { status: 304, statusText: 'Not Modified' }));
        const events: Events = [];
        service(events).getHTTP('http://h.invalid/s304');
        await flush();

        expect(names(events)).toEqual(['sysGetHttpDone']);
        expect(events[0][1].slice(0, 2)).toEqual(['http://h.invalid/s304', '']);
    });

    it('still reports a 400 as an error', async () => {
        stubFetch(() => new Response('bad', { status: 400, statusText: 'Bad Request' }));
        const events: Events = [];
        service(events).getHTTP('http://h.invalid/s400');
        await flush();
        expect(names(events)).toEqual(['sysGetHttpError']);
    });
});

describe('sysDownloadFileProgress with an unknown total', () => {
    it('passes nil, not -1, while the length is unknown', async () => {
        const chunk = new Uint8Array(50_000);
        let sent = 0;
        stubFetch(() => new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent++ < 4) controller.enqueue(chunk);
                else controller.close();
            },
        }), { status: 200 }));
        const events: Events = [];
        service(events, { writeBinaryFile: () => {} }).downloadFile('/profiles/t/x.bin', 'http://h.invalid/chunked');
        await flush();
        await flush();

        const progress = events.filter(([e]) => e === 'sysDownloadFileProgress').map(([, a]) => a);
        expect(progress[0]).toEqual(['http://h.invalid/chunked', 50_000, undefined]);
        expect(progress.at(-1)).toEqual(['http://h.invalid/chunked', 200_000, 200_000]);
    });

    describe('in Lua', () => {
        let t: TestRuntime;
        beforeAll(async () => { t = await createTestRuntime(); });
        afterAll(() => t.dispose());

        it('arrives as a nil third argument', () => {
            t.run(`
                __seen = nil
                registerAnonymousEventHandler("sysDownloadFileProgress", function(_, url, bytes, total, ...)
                    __seen = tostring(bytes) .. ":" .. tostring(total) .. ":" .. type(total)
                end)
            `);
            t.rt.emitEvent('sysDownloadFileProgress', ['http://h.invalid/chunked', 50000, undefined]);
            expect(t.run('return __seen')).toBe('50000:nil:nil');
        });
    });
});

describe('an empty upload file', () => {
    it('uploads the data string instead', async () => {
        const calls = stubFetch(() => new Response('ok', { status: 200 }));
        const vfs = { readBinaryFile: () => new Uint8Array(0) };
        const events: Events = [];
        service(events, vfs).postHTTP('fallbackdata', 'http://h.invalid/post', undefined, '/profiles/t/empty.txt');
        await flush();

        expect(new TextDecoder().decode(calls[0].init.body as Uint8Array)).toBe('fallbackdata');
    });

    it('still uploads a non-empty file over the data string', async () => {
        const calls = stubFetch(() => new Response('ok', { status: 200 }));
        const vfs = { readBinaryFile: () => new TextEncoder().encode('file') };
        const events: Events = [];
        service(events, vfs).putHTTP('fallbackdata', 'http://h.invalid/put', undefined, '/profiles/t/f.txt');
        await flush();

        expect(new TextDecoder().decode(calls[0].init.body as Uint8Array)).toBe('file');
    });
});

describe('downloadFile into a path it cannot open', () => {
    const PROFILE = '/profiles/http-349';
    let vfs: ProfileVFS;

    beforeAll(async () => {
        await configure({ mounts: { '/': InMemory } });
        mkdirSync(PROFILE, { recursive: true });
        mkdirSync(`${PROFILE}/adir`, { recursive: true });
        const Ctor = ProfileVFS as unknown as new (id: string, fs: unknown, source: string) => ProfileVFS;
        vfs = new Ctor('http-349', {}, 'idb');
    });

    const expected = (path: string) => ["Couldn't save to the destination file", path,
        "Couldn't open the destination file for writing (permission errors?)"];

    it('does not create a missing directory, and reports the open failure', async () => {
        stubFetch(() => new Response('hello', { status: 200 }));
        const events: Events = [];
        const saveTo = `${PROFILE}/nodir/x.txt`;
        service(events, vfs).downloadFile(saveTo, 'http://h.invalid/f');
        await flush();
        await flush();

        expect(names(events).filter(e => e !== 'sysDownloadFileProgress')).toEqual(['sysDownloadError']);
        const args = events.find(([e]) => e === 'sysDownloadError')![1];
        expect(args.slice(0, 3)).toEqual(expected(saveTo));
        expect(existsSync(`${PROFILE}/nodir`)).toBe(false);
    });

    it('reports a reason, not the url, when the target is a directory', async () => {
        stubFetch(() => new Response('hello', { status: 200 }));
        const events: Events = [];
        service(events, vfs).downloadFile(`${PROFILE}/adir`, 'http://h.invalid/f');
        await flush();
        await flush();

        const args = events.find(([e]) => e === 'sysDownloadError')![1];
        expect(args.slice(0, 3)).toEqual(expected(`${PROFILE}/adir`));
    });

    it('does the same for a file: url', async () => {
        vfs.writeFile(`${PROFILE}/src.txt`, 'local');
        const events: Events = [];
        const saveTo = `${PROFILE}/nodir2/x.txt`;
        service(events, vfs).downloadFile(saveTo, `file://${PROFILE}/src.txt`);
        await flush();

        expect(events.map(([e, a]) => [e, ...a.slice(0, 3)])).toEqual([['sysDownloadError', ...expected(saveTo)]]);
        expect(existsSync(`${PROFILE}/nodir2`)).toBe(false);
    });

    it('still saves into a directory that exists', async () => {
        stubFetch(() => new Response('hello', { status: 200 }));
        const events: Events = [];
        service(events, vfs).downloadFile(`${PROFILE}/adir/ok.txt`, 'http://h.invalid/f');
        await flush();
        await flush();

        expect(events.find(([e]) => e === 'sysDownloadDone')?.[1].slice(0, 2)).toEqual([`${PROFILE}/adir/ok.txt`, 5]);
        expect(vfs.readFile(`${PROFILE}/adir/ok.txt`)).toBe('hello');
    });
});
