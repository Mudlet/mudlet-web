// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpService } from '../../src/scripting/http/HttpService';

/**
 * Mudlet hands every HTTP event a response record as its last argument —
 * `{ headers = {...}, cookies = {...} }` — and scripts read it to branch on what
 * came back. mudix passed an empty string, so `response.headers` was an index
 * into nothing.
 *
 * Exercised against the real fetch path with fetch itself stubbed, which is the
 * only honest way to cover it here: Mudlet's own networking specs cannot run in
 * this client (a synchronous busted run blocks the event loop the response would
 * arrive on — see e2e/knownDivergences.ts), and writing a second, synchronous
 * transport just so they could would mean testing a code path nothing else ever
 * takes.
 */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function service(emit: (event: string, args: unknown[]) => void, vfs: unknown = null) {
    return new HttpService(emit, () => vfs as never, () => undefined, fn => fn());
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('HTTP response record', () => {
    it('carries the response headers on a completed request', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('hello', {
            status: 200,
            headers: { 'X-Mudlet-Fixture': '1', 'Content-Type': 'text/plain' },
        })));
        const events: Array<[string, unknown[]]> = [];
        service((e, a) => events.push([e, a])).getHTTP('http://example.invalid/x');
        await flush();

        const [name, args] = events.find(([e]) => e === 'sysGetHttpDone')!;
        expect(name).toBe('sysGetHttpDone');
        expect(args[0]).toBe('http://example.invalid/x');
        expect(args[1]).toBe('hello');
        const response = args[2] as { headers: Record<string, string>; cookies: Record<string, string> };
        // Header names come back lower-cased, as the Fetch API reports them.
        expect(response.headers['x-mudlet-fixture']).toBe('1');
        expect(response.cookies).toEqual({});
    });

    // The shape is the contract: a script indexing response.cookies for a
    // session id must read nil, not fail on a missing table. Browsers never
    // expose Set-Cookie to script, so the table is always empty — but it is
    // always there.
    it('always has both tables, even with no headers at all', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
        const events: Array<[string, unknown[]]> = [];
        service((e, a) => events.push([e, a])).getHTTP('http://example.invalid/y');
        await flush();

        const response = events.find(([e]) => e === 'sysGetHttpDone')![1][2] as Record<string, unknown>;
        expect(response).toHaveProperty('headers');
        expect(response).toHaveProperty('cookies');
    });

    it('reports a download with its headers rather than an empty body string', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('file body', {
            status: 200,
            headers: { 'X-Mudlet-Fixture': '1' },
        })));
        const written: Array<[string, Uint8Array]> = [];
        const vfs = { writeBinaryFile: (p: string, b: Uint8Array) => { written.push([p, b]); } };
        const events: Array<[string, unknown[]]> = [];
        service((e, a) => events.push([e, a]), vfs).downloadFile('/profiles/t/f.txt', 'http://example.invalid/f');
        await flush();

        const args = events.find(([e]) => e === 'sysDownloadDone')![1];
        expect(args[0]).toBe('/profiles/t/f.txt');
        expect(args[1]).toBe('file body'.length);
        expect((args[2] as { headers: Record<string, string> }).headers['x-mudlet-fixture']).toBe('1');
        expect(written).toHaveLength(1);
    });

    // A file: URL never spoke HTTP, but a handler should not have to know which
    // kind of URL it was given before indexing the record.
    it('gives a file: copy the same record shape', async () => {
        const vfs = {
            exists: () => true,
            readBinaryFile: () => new TextEncoder().encode('local bytes'),
            writeBinaryFile: () => {},
        };
        const events: Array<[string, unknown[]]> = [];
        service((e, a) => events.push([e, a]), vfs).downloadFile('/profiles/t/f.txt', 'file:///lua/f.txt');
        await flush();

        const args = events.find(([e]) => e === 'sysDownloadDone')![1];
        expect(args[2]).toEqual({ headers: {}, cookies: {} });
    });
});
