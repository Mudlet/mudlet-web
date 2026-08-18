// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createTestRuntime } from '../createTestRuntime';

/**
 * A JS exception thrown from a property getter on an object exposed to Lua does
 * NOT come back as a Lua error string: wasmoon's `__index` trampoline for JS
 * objects has no try/catch, so the value unwinds raw through the wasm boundary
 * into whoever called resume. When that value is not an Error, the old
 * `String(err)` formatting rendered every such failure as the useless line
 * `[event "x"] [object Object]` — with no position, no traceback, and nothing
 * naming the culprit.
 */
class Thrower {
    get boom(): number { throw { code: 'ENOTIME', detail: 'no clock' }; }
}

describe('opaque (non-Error) throws out of Lua', () => {
    it('escapes the wasm boundary as a raw value, not a Lua error string', async () => {
        const t = await createTestRuntime();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (t.rt as any).lua.global.set('probeObj', new Thrower());

        let caught: unknown = null;
        try {
            t.rt.run('return probeObj.boom', 'timer "probe"');
        } catch (e) {
            caught = e;
        }
        expect(caught).not.toBeInstanceOf(Error);
        // The symptom this whole test exists for.
        expect(String(caught)).toBe('[object Object]');

        t.dispose();
    }, 60000);

    it('is reported by what it is, and logged live for devtools', async () => {
        const t = await createTestRuntime();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (t.rt as any).lua.global.set('probeObj', new Thrower());
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const logs: string[] = [];
        t.session.events.on('script.log', (text: string) => { logs.push(text); });

        t.rt.run('function probeEvt() local v = probeObj.boom end', 'setup');
        t.rt.emitEvent('probeEvt', []);

        expect(logs).toEqual([
            '[event "probeEvt"] {"code":"ENOTIME","detail":"no clock"}',
        ]);
        expect(spy).toHaveBeenCalledWith(
            '[mudix] non-Error value thrown out of event "probeEvt":',
            { code: 'ENOTIME', detail: 'no clock' },
        );

        spy.mockRestore();
        t.dispose();
    }, 60000);
});
