import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    canonicalStep, canonicalSequence, keyNameFromCode, stepFromEvent, formatSequence,
} from '../../src/ui/commands/keyMatch';
import {
    APP_SHORTCUTS, boundShortcuts, defaultShortcut, effectiveShortcut, shortcutLookup,
} from '../../src/ui/commands/appShortcuts';
import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';
import { AddonCommandRegistry, normaliseShortcut } from '../../src/ui/commands/addonCommands';

// Mudlet's menu shortcuts, dispatched here for the first time: the registry has
// always *reserved* these keys against packages, but nothing pressed them.

describe('canonical key spelling', () => {
    it('reads a step however its modifiers were written or ordered', () => {
        for (const written of ['Ctrl+Alt+L', 'alt+ctrl+l', 'CTRL+ALT+L', 'Control+Option+L']) {
            expect(canonicalStep(written)).toBe('ctrl+alt+l');
        }
    });

    it('keeps the two characters that are both punctuation and keys', () => {
        expect(canonicalStep('Ctrl++')).toBe('ctrl++');
        expect(canonicalStep('Ctrl+,')).toBe('ctrl+,');
    });

    it('reads a bare key with no modifiers at all', () => {
        expect(canonicalStep('F3')).toBe('f3');
    });

    it('splits a multi-step sequence the way Qt does', () => {
        expect(canonicalSequence('Ctrl+Alt+F1, Ctrl+Alt+F2')).toEqual(['ctrl+alt+f1', 'ctrl+alt+f2']);
    });

    it('refuses a sequence Qt cannot read rather than half-reading it', () => {
        expect(canonicalSequence('Ctrl+NotAKey')).toBeNull();
        expect(canonicalSequence('')).toBeNull();
    });
});

describe('a keypress', () => {
    const press = (over: Partial<KeyboardEvent> & { code: string }) => stepFromEvent({
        ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over,
    } as KeyboardEvent);

    // .key would be "´" here on a Mac and "@" on some European layouts, which is
    // how a menu accelerator ends up on a different key per keyboard.
    it('is read from the physical key, not the character the layout produces', () => {
        expect(press({ code: 'KeyE', altKey: true })).toBe('alt+e');
    });

    it('spells its modifiers in the same order a sequence does', () => {
        expect(press({ code: 'KeyL', ctrlKey: true, altKey: true }))
            .toBe(canonicalStep('Alt+Ctrl+L'));
    });

    it('is nothing at all while only a modifier is down', () => {
        expect(press({ code: 'ControlLeft', ctrlKey: true })).toBeNull();
        expect(press({ code: 'AltLeft', altKey: true })).toBeNull();
    });

    it('names the keys Qt names', () => {
        expect(keyNameFromCode('F3')).toBe('f3');
        expect(keyNameFromCode('Escape')).toBe('esc');
        expect(keyNameFromCode('PageDown')).toBe('pgdown');
        expect(keyNameFromCode('Digit4')).toBe('4');
        expect(keyNameFromCode('Comma')).toBe(',');
    });

    it('writes back out the way a person reads it', () => {
        expect(formatSequence(['ctrl+alt+l'])).toBe('Ctrl+Alt+L');
        expect(formatSequence(['alt+e'])).toBe('Alt+E');
        expect(formatSequence(['f3'])).toBe('F3');
        expect(formatSequence(['ctrl+alt+f1', 'ctrl+alt+f2'])).toBe('Ctrl+Alt+F1, Ctrl+Alt+F2');
    });
});

describe('the client’s own shortcuts', () => {
    it('are Mudlet’s keys, Alt off macOS and Ctrl on it', () => {
        const editor = APP_SHORTCUTS.find(d => d.id === 'scriptEditor')!;
        expect(defaultShortcut(editor, 'windows')).toBe('Alt+E');
        expect(defaultShortcut(editor, 'mac')).toBe('Ctrl+E');
    });

    it('every default is a sequence this client can actually read back', () => {
        for (const def of APP_SHORTCUTS) {
            for (const platform of ['windows', 'mac']) {
                const key = defaultShortcut(def, platform);
                if (!key) continue;
                expect(canonicalSequence(key), `${def.id} on ${platform}`).not.toBeNull();
            }
        }
    });

    it('has no two commands on one key, on either platform', () => {
        for (const platform of ['windows', 'mac']) {
            const seen = new Map<string, string>();
            for (const { id, shortcut } of boundShortcuts(undefined, platform)) {
                const key = canonicalSequence(shortcut)!.join(',');
                expect(seen.has(key), `${id} and ${seen.get(key)} both hold ${shortcut} on ${platform}`).toBe(false);
                seen.set(key, id);
            }
        }
    });

    it('takes an override, and tells a cleared binding from an untouched one', () => {
        const editor = APP_SHORTCUTS.find(d => d.id === 'scriptEditor')!;
        expect(effectiveShortcut(editor, undefined, 'windows')).toBe('Alt+E');
        expect(effectiveShortcut(editor, { scriptEditor: 'Ctrl+Alt+9' }, 'windows')).toBe('Ctrl+Alt+9');
        // Cleared: an empty string is a decision, not an absent key.
        expect(effectiveShortcut(editor, { scriptEditor: '' }, 'windows')).toBe('');
        expect(boundShortcuts({ scriptEditor: '' }, 'windows').map(e => e.id)).not.toContain('scriptEditor');
    });

    it('reads back through the lookup the menus draw from', () => {
        const key = shortcutLookup({ scriptEditor: 'Ctrl+Alt+9' }, 'windows');
        expect(key('scriptEditor')).toBe('Ctrl+Alt+9');
        // Unbound reads as undefined rather than '', so a menu entry draws no
        // accelerator column at all.
        expect(key('files')).toBeUndefined();
    });
});

describe('what a package is told about a key', () => {
    it('names the client command holding it, once the client has been asked', () => {
        const registry = new AddonCommandRegistry();
        registry.setPlatform('windows');
        registry.setClientShortcuts(new Map(
            boundShortcuts({ scriptEditor: 'Ctrl+Alt+9' }, 'windows')
                .map(({ label, shortcut }) => [normaliseShortcut(shortcut), label]),
        ));
        // The key the player moved the editor onto is no longer free.
        expect(registry.holderOf('Ctrl+Alt+9')).toBe('Script editor');
        // And one nobody holds still is.
        expect(registry.holderOf('Ctrl+Alt+8')).toBeNull();
    });
});

describe('dispatching', () => {
    let fired: string[];
    let root: Root;

    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    /** Mount the hook on its own — it renders nothing, it only listens. */
    const renderHook = (bindings: { shortcut: string; run: () => void }[]) => {
        const Probe = () => { useKeyboardShortcuts(bindings); return null; };
        act(() => { root.render(createElement(Probe)); });
    };

    beforeEach(() => {
        fired = [];
        document.body.replaceChildren();
        const host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });
    afterEach(() => {
        act(() => root.unmount());
        vi.useRealTimers();
    });

    const press = (code: string, mods: Partial<KeyboardEvent> = {}, target?: HTMLElement) => {
        const e = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...mods });
        (target ?? document.body).dispatchEvent(e);
        return e;
    };

    it('runs the command whose sequence was pressed', () => {
        renderHook([{ shortcut: 'Alt+E', run: () => fired.push('editor') }]);
        const e = press('KeyE', { altKey: true });
        expect(fired).toEqual(['editor']);
        expect(e.defaultPrevented).toBe(true);
    });

    it('leaves a key nothing is bound to alone', () => {
        renderHook([{ shortcut: 'Alt+E', run: () => fired.push('editor') }]);
        const e = press('KeyQ', { altKey: true });
        expect(fired).toEqual([]);
        expect(e.defaultPrevented).toBe(false);
    });

    // The command line is a textarea and holds the keyboard nearly always, so a
    // handler that bailed out on text-entry targets would never run at all.
    it('still fires while the command line has the keyboard', () => {
        const box = document.createElement('textarea');
        document.body.appendChild(box);
        renderHook([{ shortcut: 'Alt+E', run: () => fired.push('editor') }]);
        press('KeyE', { altKey: true }, box);
        expect(fired).toEqual(['editor']);
    });

    it('but never swallows a plain letter someone is typing', () => {
        const box = document.createElement('textarea');
        document.body.appendChild(box);
        renderHook([{ shortcut: 'E', run: () => fired.push('editor') }]);
        const typed = press('KeyE', {}, box);
        expect(fired).toEqual([]);
        expect(typed.defaultPrevented).toBe(false);
        // The same bare binding does fire outside a text field.
        press('KeyE');
        expect(fired).toEqual(['editor']);
    });

    it('waits for the second half of a two-step sequence', () => {
        renderHook([
            { shortcut: 'Ctrl+Alt+F1, Ctrl+Alt+F2', run: () => fired.push('chord') },
        ]);
        const first = press('F1', { ctrlKey: true, altKey: true });
        expect(fired).toEqual([]);
        // Held, not ignored: the first step must not reach the page either.
        expect(first.defaultPrevented).toBe(true);
        press('F2', { ctrlKey: true, altKey: true });
        expect(fired).toEqual(['chord']);
    });

    it('gives up on a half-typed sequence rather than eating the next keypress', () => {
        vi.useFakeTimers();
        renderHook([
            { shortcut: 'Ctrl+Alt+F1, Ctrl+Alt+F2', run: () => fired.push('chord') },
        ]);
        press('F1', { ctrlKey: true, altKey: true });
        act(() => { vi.advanceTimersByTime(5000); });
        const late = press('F2', { ctrlKey: true, altKey: true });
        expect(fired).toEqual([]);
        expect(late.defaultPrevented).toBe(false);
    });

    it('starts over when an abandoned prefix is pressed again', () => {
        renderHook([
            { shortcut: 'Ctrl+Alt+F1, Ctrl+Alt+F2', run: () => fired.push('chord') },
        ]);
        press('F1', { ctrlKey: true, altKey: true });
        press('KeyZ', { ctrlKey: true });          // nothing; abandons the chord
        press('F1', { ctrlKey: true, altKey: true });
        press('F2', { ctrlKey: true, altKey: true });
        expect(fired).toEqual(['chord']);
    });

    it('ignores a binding whose sequence Qt cannot read', () => {
        renderHook([{ shortcut: 'Ctrl+NotAKey', run: () => fired.push('never') }]);
        press('KeyN', { ctrlKey: true });
        expect(fired).toEqual([]);
    });
});
