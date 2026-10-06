// @vitest-environment node
//
// Key binding drift measured against the Mudlet PTB (mudlet-web#340). Each
// block is an item of the issue, with desktop's result as the expectation.
//
//  1. permKey keeps the Keypad modifier and maps every Qt key, not only
//     letters, digits and F-keys; getKeyCode reports the Keypad bit.
//  2. On the numpad, NumLock decides the key, as Qt does: numpad 8 is Key_8
//     with it on and Key_Up|Keypad with it off.
//  4. A shifted symbol without Shift never fires on the unshifted key.
//  5. Temporary and permanent keys fire in creation order.
//
// Items 3 and 6 (the command line and the app shortcuts) are pinned in
// tests/ui/keyBindingDrift340.test.ts; tempKey through real Lua in
// tests/scripting/tempKeyDrift340.test.ts.
//
// Node env + a stubbed LuaRuntime (as host-send.test.ts does it): the engine
// boots a runtime in its constructor and none of the Lua side is needed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let ran: string[] = [];

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {},
            run: (code: string) => { ran.push(code); },
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
            dispatchSendRequest: () => false, reapKilledTempItems: () => {},
            setCommand: () => {},
        }),
    },
}));

const { MudSession } = await import('../../src/mud/MudSession');
const { AliasEngine } = await import('../../src/mud/aliases/AliasEngine');
const { TriggerEngine } = await import('../../src/mud/triggers/TriggerEngine');
const { TimerEngine } = await import('../../src/mud/timers/TimerEngine');
const { KeyEngine } = await import('../../src/mud/keybindings/KeyEngine');
const { ScriptingEngine } = await import('../../src/scripting/ScriptingEngine');
const { useAppStore } = await import('../../src/storage/appStore');
const qt = await import('../../src/mud/keybindings/qtKeys');

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'key-drift-340-conn';

// Qt values, as mudlet.key / mudlet.keymodifier publish them.
const SHIFT = 0x02000000, CTRL = 0x04000000, ALT = 0x08000000, KEYPAD = 0x20000000;
const Key = {
    Up: 0x01000013, Down: 0x01000015, Left: 0x01000012, PageUp: 0x01000016,
    Home: 0x01000010, End: 0x01000011, Insert: 0x01000006, Enter: 0x01000005,
    F5: 0x01000034, F6: 0x01000035, Slash: 0x2f, Plus: 0x2b, Exclam: 0x21,
    '1': 0x31, '4': 0x34, '8': 0x38,
};

type Press = Partial<Pick<KeyboardEvent, 'key' | 'location' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>>;
const press = (code: string, extra: Press = {}) => ({
    code, key: '', location: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...extra,
} as KeyboardEvent);
/** A numpad key: `key` is what NumLock makes of it ('8' on, 'ArrowUp' off). */
const numpad = (code: string, key: string, extra: Press = {}) => press(code, { key, location: 3, ...extra });

describe('mudlet-web#340 — permKey, matching and order', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let keyEngine: InstanceType<typeof KeyEngine>;
    let wire: string[];

    const reload = () => keyEngine.loadPerm(useAppStore.getState().connectionKeybindings[CONN] ?? []);
    const permKey = (name: string, modifier: number, key: number, code = '') => {
        const id = engine.createPermKey(name, '', modifier, key, code);
        reload();
        return id;
    };

    beforeEach(() => {
        ran = [];
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Keys', url: 'ws://localhost' }],
            }));
        }
        useAppStore.setState(s => ({ connectionKeybindings: { ...s.connectionKeybindings, [CONN]: [] } }));
        const session = new MudSession();
        keyEngine = new KeyEngine();
        engine = new ScriptingEngine(session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), keyEngine, CONN);
        wire = [];
        vi.spyOn(session, 'echoCommand').mockImplementation(() => {});
        vi.spyOn(session, 'sendData').mockImplementation((text: string) => { wire.push(text); });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    describe('1. permKey on the keypad and on non-alphanumeric keys', () => {
        it('a Keypad+8 binding fires on numpad 8 and leaves the top-row 8 alone', () => {
            permKey('pk_kp8', KEYPAD, Key['8'], 'kp8');
            expect(engine.processKey(press('Digit8', { key: '8' }))).toBe(false);
            expect(ran).toEqual([]);
            expect(engine.processKey(numpad('Numpad8', '8'))).toBe(true);
            expect(ran).toEqual(['kp8']);
        });

        it('getKeyCode reports the Keypad bit', () => {
            permKey('pk_kp8', KEYPAD, Key['8']);
            expect(keyEngine.getKeyCode('pk_kp8')).toEqual({ keyCode: 56, modifiers: 536870912 });
        });

        it('so does a keypad key seeded from the profile', () => {
            useAppStore.setState(s => ({
                connectionKeybindings: {
                    ...s.connectionKeybindings,
                    [CONN]: [{
                        id: 'seed', name: 'seeded', isGroup: false, parentId: null, enabled: true,
                        key: 'Numpad8', modifiers: [], code: '', language: 'lua',
                    }],
                },
            }));
            reload();
            expect(keyEngine.getKeyCode('seeded')).toEqual({ keyCode: 56, modifiers: KEYPAD });
        });

        it.each([
            ['Alt+Up', ALT, Key.Up, press('ArrowUp', { key: 'ArrowUp', altKey: true })],
            ['Home', 0, Key.Home, press('Home', { key: 'Home' })],
            ['Ctrl+/', CTRL, Key.Slash, press('Slash', { key: '/', ctrlKey: true })],
            ['Keypad+Plus', KEYPAD, Key.Plus, numpad('NumpadAdd', '+')],
            ['Insert', 0, Key.Insert, press('Insert', { key: 'Insert' })],
            ['End', 0, Key.End, press('End', { key: 'End' })],
        ])('fires on %s', (name, modifier, key, event) => {
            permKey(`pk_${name}`, modifier, key, name);
            expect(engine.processKey(event)).toBe(true);
            expect(ran).toEqual([name]);
        });

        it('getKeyCode answers for Alt+Up', () => {
            permKey('pk_altup', ALT, Key.Up);
            expect(keyEngine.getKeyCode('pk_altup')).toEqual({ keyCode: 16777235, modifiers: 134217728 });
        });
    });

    describe('2. numpad walking with NumLock off', () => {
        it('Keypad+Up/Down/Left/PageUp fire on NumLock-off numpad 8, 2, 4, 9', () => {
            permKey('n', KEYPAD, Key.Up, 'north');
            permKey('s', KEYPAD, Key.Down, 'south');
            permKey('w', KEYPAD, Key.Left, 'west');
            permKey('ne', KEYPAD, Key.PageUp, 'northeast');
            for (const [code, key] of [['Numpad8', 'ArrowUp'], ['Numpad2', 'ArrowDown'], ['Numpad4', 'ArrowLeft'], ['Numpad9', 'PageUp']]) {
                expect(engine.processKey(numpad(code, key))).toBe(true);
            }
            expect(ran).toEqual(['north', 'south', 'west', 'northeast']);
        });

        it('and not on the arrow keys themselves', () => {
            permKey('n', KEYPAD, Key.Up, 'north');
            expect(engine.processKey(press('ArrowUp', { key: 'ArrowUp' }))).toBe(false);
        });

        it('a NumLock-on Keypad+4 binding does not fire with NumLock off', () => {
            permKey('kp4', KEYPAD, Key['4'], 'kp4');
            expect(engine.processKey(numpad('Numpad4', 'ArrowLeft'))).toBe(false);
            expect(engine.processKey(numpad('Numpad4', '4'))).toBe(true);
            expect(ran).toEqual(['kp4']);
        });

        it('keys imported from desktop XML as Key_Up|Keypad fire the same way', () => {
            // What parseMudletXml makes of <keyCode>Key_Up</keyCode><keyModifier>Keypad</keyModifier>
            // (pinned in tests/ui/keyBindingDrift340.test.ts).
            keyEngine.loadPerm([{
                id: 'imp', name: 'walk n', isGroup: false, parentId: null, enabled: true,
                key: qt.qtKeyToDomCode(Key.Up, KEYPAD), modifiers: qt.qtModifiersToList(KEYPAD),
                qtKey: Key.Up, code: 'imported', language: 'lua',
            }]);
            expect(engine.processKey(press('ArrowUp', { key: 'ArrowUp' }))).toBe(false);
            expect(engine.processKey(numpad('Numpad8', 'ArrowUp'))).toBe(true);
            expect(ran).toEqual(['imported']);
        });
    });

    describe('3. a Keypad-Enter binding', () => {
        it('fires on numpad Enter, and not on Return', () => {
            permKey('kpenter', KEYPAD, Key.Enter, 'kpenter');
            expect(engine.processKey(press('Enter', { key: 'Enter' }))).toBe(false);
            expect(engine.processKey(numpad('NumpadEnter', 'Enter'))).toBe(true);
            expect(ran).toEqual(['kpenter']);
        });
    });

    describe('4. a shifted-symbol binding', () => {
        it('without Shift never fires — not on plain 1, not on Shift+1', () => {
            permKey('excl', 0, Key.Exclam, 'excl');
            expect(engine.processKey(press('Digit1', { key: '1' }))).toBe(false);
            expect(engine.processKey(press('Digit1', { key: '!', shiftKey: true }))).toBe(false);
            expect(ran).toEqual([]);
        });

        it('with Shift fires on Shift+1', () => {
            permKey('excl', SHIFT, Key.Exclam, 'excl');
            expect(engine.processKey(press('Digit1', { key: '!', shiftKey: true }))).toBe(true);
            expect(ran).toEqual(['excl']);
        });

        it('a plain 1 binding is unaffected', () => {
            permKey('one', 0, Key['1'], 'one');
            expect(engine.processKey(press('Digit1', { key: '1' }))).toBe(true);
            expect(keyEngine.getKeyCode('one')).toEqual({ keyCode: 0x31, modifiers: 0 });
        });
    });

    // SlySven on the PR: a French AZERTY user's top row needs Shift for every
    // digit. Qt keys a press by the character it produced, so desktop records
    // that row's unshifted keys as & é " ' ( … and Shift+them as Key_1|Shift …
    describe('non-US layouts: printable keys match by the character typed, as Qt does', () => {
        it('AZERTY: Key_Ampersand fires on the unshifted 1-key, not on the US 7 position', () => {
            permKey('amp', 0, 0x26, 'amp');
            expect(engine.processKey(press('Digit7', { key: '7' }))).toBe(false);
            expect(engine.processKey(press('Digit1', { key: '&' }))).toBe(true);
            expect(ran).toEqual(['amp']);
        });

        it('AZERTY: Key_1|Shift fires on Shift + the 1-key', () => {
            permKey('one', SHIFT, Key['1'], 'one');
            expect(engine.processKey(press('Digit1', { key: '&' }))).toBe(false);
            expect(engine.processKey(press('Digit1', { key: '1', shiftKey: true }))).toBe(true);
            expect(ran).toEqual(['one']);
        });

        it('AZERTY: Key_A fires on the key that types a (the US Q position)', () => {
            permKey('a', 0, 0x41, 'a');
            expect(engine.processKey(press('KeyQ', { key: 'a' }))).toBe(true);
            expect(engine.processKey(press('KeyA', { key: 'q' }))).toBe(false);
            expect(ran).toEqual(['a']);
        });

        it('AZERTY: Key_Eacute, which has no US position, still binds', () => {
            const id = permKey('eacute', 0, 0xc9, 'eacute');
            expect(id).toBeGreaterThan(0);
            expect(engine.processKey(press('Digit2', { key: 'é' }))).toBe(true);
            expect(ran).toEqual(['eacute']);
            expect(keyEngine.getKeyCode('eacute')).toEqual({ keyCode: 0xc9, modifiers: 0 });
        });

        it('a binding stored only as a DOM code keeps matching the physical key', () => {
            keyEngine.loadPerm([{
                id: 'web', name: 'web', isGroup: false, parentId: null, enabled: true,
                key: 'Digit1', modifiers: ['shift'], code: 'web', language: 'lua',
            }]);
            expect(engine.processKey(press('Digit1', { key: '1', shiftKey: true }))).toBe(true);
            expect(ran).toEqual(['web']);
        });

        it('a layout beyond Latin-1 (Cyrillic) falls back to the physical key', () => {
            permKey('ctrl-a', CTRL, 0x41, 'ctrl-a');
            expect(engine.processKey(press('KeyA', { key: 'ф', ctrlKey: true }))).toBe(true);
            expect(ran).toEqual(['ctrl-a']);
        });
    });

    describe('macOS: Qt sets KeypadModifier on the arrows and keys Option presses without Option', () => {
        beforeEach(() => { vi.stubGlobal('navigator', { platform: 'MacIntel' }); });
        afterEach(() => { vi.unstubAllGlobals(); });

        it('a Mac desktop Alt+Up (Key_Up|Alt|Keypad) fires on the arrow', () => {
            permKey('altup', ALT | KEYPAD, Key.Up, 'altup');
            expect(engine.processKey(press('ArrowUp', { key: 'ArrowUp', altKey: true }))).toBe(true);
            expect(ran).toEqual(['altup']);
        });

        it('Option+A (which types å) fires Key_A|Alt', () => {
            permKey('opt-a', ALT, 0x41, 'opt-a');
            expect(engine.processKey(press('KeyA', { key: 'å', altKey: true }))).toBe(true);
            expect(ran).toEqual(['opt-a']);
        });
    });

    describe('5. temporary and permanent keys share one creation order', () => {
        const F5 = press('F5', { key: 'F5' });
        const F6 = press('F6', { key: 'F6' });

        it('a profile key beats a tempKey made after it', () => {
            useAppStore.setState(s => ({
                connectionKeybindings: {
                    ...s.connectionKeybindings,
                    [CONN]: [{
                        id: 'f5', name: 'F5 key', isGroup: false, parentId: null, enabled: true,
                        key: 'F5', modifiers: [], code: 'perm F5 key (profile)', language: 'lua', command: 'north',
                    }],
                },
            }));
            // What the runtime boot does before any script runs.
            keyEngine.reserveOrder(useAppStore.getState().connectionKeybindings[CONN]);
            const temp: string[] = [];
            keyEngine.addTemp('F5', [], () => temp.push('temp F5 key'));
            reload();
            expect(engine.processKey(F5)).toBe(true);
            expect(wire).toEqual(['north']);
            expect(ran).toEqual(['perm F5 key (profile)']);
            expect(temp).toEqual([]);
        });

        it('a permKey made first beats a later tempKey', () => {
            permKey('f6', 0, Key.F6, 'permKey F6 (created first)');
            const temp: string[] = [];
            keyEngine.addTemp('F6', [], () => temp.push('temp F6 key'));
            expect(engine.processKey(F6)).toBe(true);
            expect(ran).toEqual(['permKey F6 (created first)']);
            expect(temp).toEqual([]);
        });

        it('a tempKey made first beats a later permKey', () => {
            const temp: string[] = [];
            keyEngine.addTemp('F6', [], () => temp.push('temp F6 key'));
            permKey('f6', 0, Key.F6, 'perm');
            expect(engine.processKey(F6)).toBe(true);
            expect(temp).toEqual(['temp F6 key']);
            expect(ran).toEqual([]);
        });

        it('with "react to all", every match runs, in creation order', () => {
            useAppStore.getState().patchConnectionProfile(CONN, { reactToAllKeybindings: true });
            try {
                const order: string[] = [];
                keyEngine.addTemp('F6', [], () => order.push('temp1'));
                permKey('f6', 0, Key.F6, 'perm');
                keyEngine.addTemp('F6', [], () => order.push('temp2'));
                ran = order;
                expect(engine.processKey(F6)).toBe(true);
                expect(order).toEqual(['temp1', 'perm', 'temp2']);
            } finally {
                useAppStore.getState().patchConnectionProfile(CONN, { reactToAllKeybindings: false });
            }
        });
    });
});

describe('mudlet-web#340 — the key recorder records Qt keys', () => {
    const rec = (e: Partial<KeyboardEvent>) => qt.bindingFromEvent({
        ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, location: 0, ...e,
    } as KeyboardEvent);

    it('a NumLock-off numpad key as its Keypad key', () => {
        expect(rec({ code: 'Numpad8', key: 'ArrowUp', location: 3 }))
            .toEqual({ key: 'ArrowUp', modifiers: ['keypad'], qtKey: Key.Up });
    });

    it('a NumLock-on numpad digit under its Numpad code', () => {
        expect(rec({ code: 'Numpad8', key: '8', location: 3 }))
            .toEqual({ key: 'Numpad8', modifiers: ['keypad'], qtKey: Key['8'] });
    });

    it('Shift+1 as Key_Exclam with Shift', () => {
        expect(rec({ code: 'Digit1', key: '!', shiftKey: true }))
            .toEqual({ key: 'Digit1', modifiers: ['shift'], qtKey: Key.Exclam });
    });
});
