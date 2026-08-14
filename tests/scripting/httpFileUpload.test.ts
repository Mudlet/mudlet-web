// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';

/**
 * postHTTP/putHTTP/customHTTP take an optional `file` to upload. Both ways that
 * argument used to kill the Lua runtime outright with a wasm "memory access out
 * of bounds" are pinned here, because in the busted corpus a crash costs the
 * whole remaining spec rather than one assertion:
 *
 *  - **file missing.** Building the body is synchronous, so its failure emitted
 *    `sysPostHttpError` — dispatching Lua handlers — while still inside the
 *    `__postHTTP` binding Lua had called. Re-entering the Lua state mid-call
 *    crashes wasmoon. Mudlet checks the file up front instead, so mudix does
 *    too, and the error event is deferred off the call either way.
 *
 *  - **file present.** Nothing to do with the file: reading the headers table
 *    through wasmoon's `$detach` traps on this call shape, and passing a fourth
 *    argument is what made postHTTP reach it. Headers are flattened to a string
 *    on the Lua side now, so no table is detached.
 */
class StubVFS {
    profilePath = '/profiles/test';
    files = new Map<string, Uint8Array>();
    resolvePath(p: string): string { return p.startsWith('/') ? p : `${this.profilePath}/${p}`; }
    exists(p: string): boolean { return this.files.has(this.resolvePath(p)); }
    readBinaryFile(p: string): Uint8Array {
        const bytes = this.files.get(this.resolvePath(p));
        if (!bytes) throw new Error(`ENOENT: ${p}`);
        return bytes;
    }
    writeBinaryFile(p: string, data: Uint8Array): void { this.files.set(this.resolvePath(p), data); }
    readFile(p: string): string { return new TextDecoder().decode(this.readBinaryFile(p)); }
    writeFile(p: string, content: string): void { this.writeBinaryFile(p, new TextEncoder().encode(content)); }
    deleteFile(p: string): void { this.files.delete(this.resolvePath(p)); }
}

describe('HTTP upload with an unreadable file', () => {
    let t: TestRuntime;
    const stub = new StubVFS();

    beforeAll(async () => { t = await createTestRuntime({ vfs: stub as unknown as ProfileVFS }); });
    afterAll(() => t.dispose());

    // Returned as one string: a Lua (nil, msg) tuple can't survive the table
    // marshalling, and `nil` in a table literal collapses the sequence.
    const call = (lua: string) => String(t.run(`
        local ok, err = ${lua}
        return tostring(ok) .. "|" .. tostring(err)
    `));

    for (const fn of ['postHTTP', 'putHTTP']) {
        it(`${fn} returns (nil, "couldn't open ...") for a missing file`, () => {
            const out = call(`${fn}("payload", "http://localhost/", {}, `
                + `getMudletHomeDir() .. "/busted-no-such-upload.txt")`);
            expect(out).toMatch(/^nil\|/);
            expect(out).toContain("couldn't open");
            expect(out).toContain('busted-no-such-upload.txt');
        });
    }

    it('customHTTP reports the same way', () => {
        const out = call('customHTTP("REPORT", "payload", "http://localhost/", {}, "/nope/missing.txt")');
        expect(out).toMatch(/^nil\|/);
        expect(out).toContain("couldn't open");
    });

    it('leaves the runtime usable — the crash this file exists for', () => {
        t.run('postHTTP("p", "http://localhost/", {}, "/nope/missing.txt")');
        expect(t.run('return 1 + 1')).toBe(2);
    });

    // This case used to take the whole Lua state down with "memory access out of
    // bounds". The cause was not the upload at all: reading the headers table
    // through wasmoon's `$detach` traps on this call shape, and the optional
    // file argument is what made postHTTP reach it. Headers cross the boundary
    // as a flat string now (see __mudix_headers_to_string), so nothing detaches.
    it('uploads a file that is actually there, with headers', () => {
        stub.writeBinaryFile('/profiles/test/upload.txt', new TextEncoder().encode('hi'));
        const out = call('postHTTP("payload", "http://localhost/", {["X-Test"] = "1"}, '
            + 'getMudletHomeDir() .. "/upload.txt")');
        // (true, url) — the request is issued and reports back via sysPostHttp*.
        expect(out).toBe('true|http://localhost/');
    });

    it('leaves the runtime usable after an upload', () => {
        expect(t.run("return 1 + 1")).toBe(2);
    });

    // The file's contents ARE the body when one is uploaded, so demanding a data
    // string as well means passing one that is thrown away. Mudlet allows nil
    // there; we refused it with "post data as string expected, got nil".
    it('accepts a nil data argument when a file is supplied', () => {
        stub.writeBinaryFile('/profiles/test/only-file.txt', new TextEncoder().encode('body from the file'));
        for (const fn of ['postHTTP', 'putHTTP']) {
            const out = call(`${fn}(nil, "http://localhost/", {}, getMudletHomeDir() .. "/only-file.txt")`);
            expect(out, fn).toBe('true|http://localhost/');
        }
    });

    // Still refused when there is no file to stand in for it — that call has no
    // body at all, and the type error is the right answer. A raise, not a
    // returned refusal, so this one needs its own pcall rather than `call`.
    it('still refuses a nil data argument with no file', () => {
        const err = String(t.run(`
            local ok, err = pcall(postHTTP, nil, "http://localhost/", {})
            return tostring(ok) .. "|" .. tostring(err)
        `));
        expect(err).toMatch(/^false\|/);
        expect(err).toContain('postHTTP: bad argument #1 type');
    });
});
