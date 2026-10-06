// @vitest-environment node
//
// tempKey through the real Lua binding, against the Mudlet PTB
// (mudlet-web#340). The engine-level matching and order are pinned in
// tests/mud/keyBindingDrift340.test.ts; this checks that `tempKey` with
// `mudlet.key` / `mudlet.keymodifier` lands on the same keys.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

type Press = Partial<Pick<KeyboardEvent, 'key' | 'location' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>>;
const press = (code: string, extra: Press = {}) => ({
    code, key: '', location: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...extra,
} as KeyboardEvent);
const numpad = (code: string, key: string) => press(code, { key, location: 3 });

describe('tempKey and the numpad, shifted symbols (mudlet-web#340)', () => {
    let t: TestRuntime;
    beforeEach(async () => {
        t = await createTestRuntime();
        t.run('fired = {}');
    });
    afterEach(() => t.dispose());

    const fired = () => String(t.run('return table.concat(fired, ",")'));
    const key = (e: KeyboardEvent) => t.api.keys.processTemp(e);

    it('NumLock-off numpad walking: 8, 2, 4, 9 fire Keypad+Up/Down/Left/PageUp', () => {
        t.run(`
            tempKey(mudlet.keymodifier.Keypad, mudlet.key.Up,     function() fired[#fired+1] = "north" end)
            tempKey(mudlet.keymodifier.Keypad, mudlet.key.Down,   function() fired[#fired+1] = "south" end)
            tempKey(mudlet.keymodifier.Keypad, mudlet.key.Left,   function() fired[#fired+1] = "west" end)
            tempKey(mudlet.keymodifier.Keypad, mudlet.key.PageUp, function() fired[#fired+1] = "northeast" end)
            tempKey(mudlet.keymodifier.Keypad, mudlet.key["4"],   function() fired[#fired+1] = "kp4" end)
        `);
        for (const [code, k] of [['Numpad8', 'ArrowUp'], ['Numpad2', 'ArrowDown'], ['Numpad4', 'ArrowLeft'], ['Numpad9', 'PageUp']]) {
            expect(key(numpad(code, k))).toBe(true);
        }
        expect(fired()).toBe('north,south,west,northeast');
        // The arrow keys themselves are not the numpad.
        expect(key(press('ArrowUp', { key: 'ArrowUp' }))).toBe(false);
    });

    it('a Keypad+Enter tempKey fires on numpad Enter only', () => {
        t.run('tempKey(mudlet.keymodifier.Keypad, mudlet.key.Enter, function() fired[#fired+1] = "kpenter" end)');
        expect(key(press('Enter', { key: 'Enter' }))).toBe(false);
        expect(key(numpad('NumpadEnter', 'Enter'))).toBe(true);
        expect(fired()).toBe('kpenter');
    });

    it('tempKey(mudlet.key.Exclam) without Shift never fires on plain 1', () => {
        t.run('tempKey(mudlet.key.Exclam, function() fired[#fired+1] = "excl" end)');
        expect(key(press('Digit1', { key: '1' }))).toBe(false);
        expect(key(press('Digit1', { key: '!', shiftKey: true }))).toBe(false);
        expect(fired()).toBe('');
    });

    it('a Keypad tempKey reports the Keypad bit through getKeyCode', () => {
        const id = t.run('return tempKey(mudlet.keymodifier.Keypad, mudlet.key["8"], function() end)');
        expect(t.run(`local k, m = getKeyCode(${id}); return k .. " " .. m`)).toBe('56 536870912');
    });
});
