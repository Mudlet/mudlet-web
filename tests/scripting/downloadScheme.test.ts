// @vitest-environment node

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

/**
 * A url whose scheme the browser cannot fetch is refused before any request is
 * made. Left to fetch(), it rejects with the same opaque TypeError a CORS block
 * gives, so the proxy fallback retried the doomed url a second time and the
 * eventual sysDownloadError never named the real problem.
 *
 * The refusal is reported off the call stack — emitting into Lua from inside the
 * `__downloadFile` binding Lua is still executing crashes wasmoon — but on the
 * *timer* queue, not a microtask: a script that blocks on waitForEvent pumps
 * timers and never yields to a microtask, so the event has to arrive by a route
 * such a script can still see. That is exactly the media specs' shape, and it is
 * why the ordering is pinned here rather than left implicit.
 */
describe('downloadFile url scheme', () => {
    let t: TestRuntime;
    beforeAll(async () => { t = await createTestRuntime(); });
    afterAll(() => t.dispose());

    const errorsFor = (url: string, saveTo: string) => {
        t.run(`
            __seen = {}
            __h = registerAnonymousEventHandler("sysDownloadError", function(_, message, path)
                __seen[#__seen + 1] = tostring(message) .. "|" .. tostring(path)
            end)
            downloadFile(${JSON.stringify(saveTo)}, ${JSON.stringify(url)})
        `);
        // Stands in for the pump a blocked script would be running: the refusal
        // is queued as a due-now timer, so draining the queue delivers it.
        t.api.timers.pumpDue();
        const out = String(t.run('return table.concat(__seen, "\\n")'));
        t.run('killAnonymousEventHandler(__h)');
        return out;
    };

    it('refuses a scheme the browser cannot fetch, naming the file', () => {
        const out = errorsFor('ftp://example.invalid/sounds/x.wav', '/profiles/test/media/x.wav');
        expect(out).toContain('http');
        expect(out).toContain('ftp');
        expect(out).toContain('/profiles/test/media/x.wav');
    });

    it('leaves the runtime usable', () => {
        expect(t.run('return 1 + 1')).toBe(2);
    });

    // Schemeless urls are not an error: Mudlet reads them through
    // QUrl::fromUserInput, where "example.com/x" means http://example.com/x. A
    // scheme check that refused those would break every relative download.
    it('does not refuse a schemeless url', () => {
        expect(errorsFor('example.invalid/x.wav', '/profiles/test/media/y.wav')).toBe('');
    });
});
