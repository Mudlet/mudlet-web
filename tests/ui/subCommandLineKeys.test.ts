import { describe, it, expect, beforeEach } from 'vitest';
import { isTextEntryTarget, listenForKeybindings } from '../../src/mud/keybindings/keyEventTarget';

// Issue #284 item 2: every desktop TCommandLine — the main one, a SubCommandLine
// (createCommandLine, Geyser.CommandLine) and a ConsoleCommandLine (a
// miniconsole's or user window's enableCommandLine) — runs the same event(),
// which offers its keys to the KeyUnit. Mudlet Web treated the script-made ones
// as ordinary text entry, so no keybinding fired while focus was in them.

beforeEach(() => { document.body.replaceChildren(); });

function make(className: string): HTMLInputElement {
    const el = document.createElement('input');
    el.className = className;
    document.body.appendChild(el);
    return el;
}

const SCRIPT_MADE = [
    ['a createCommandLine overlay', 'cmdline-overlay-input'],
    ['a miniconsole / user window command line', 'window-cmdline'],
] as const;

describe.each(SCRIPT_MADE)('keybindings in %s', (_label, className) => {
    it('is a command line, not text entry', () => {
        expect(isTextEntryTarget(make(className))).toBe(false);
    });

    it('offers keys to the bindings, and a binding that fires consumes the key', () => {
        const el = make(className);
        const reached: string[] = [];
        el.addEventListener('keydown', e => reached.push((e as KeyboardEvent).key));
        const offered: string[] = [];
        const stop = listenForKeybindings(document, e => { offered.push(e.key); return e.key === 'F5'; });
        const press = (key: string) => {
            const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
            el.dispatchEvent(e);
            return e;
        };
        try {
            expect(press('F2').defaultPrevented).toBe(false);
            expect(press('F5').defaultPrevented).toBe(true);
            expect(offered).toEqual(['F2', 'F5']);
            // The bound F5 never reaches the input's own handler.
            expect(reached).toEqual(['F2']);
            // Enter stays the command line's own, as on the main one.
            press('Enter');
            expect(offered).toEqual(['F2', 'F5']);
            expect(reached).toEqual(['F2', 'Enter']);
        } finally {
            stop();
        }
    });
});
