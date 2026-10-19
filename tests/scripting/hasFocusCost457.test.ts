// #457: hasFocus() ran `document.querySelector('.command-input')`, which walks
// every scrollback row ahead of the command line — several ms a call in a
// long session, and EMCO calls it once per chat line.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ScriptingAPI } from '../../src/scripting/ScriptingAPI';

const api = { session: { windows: { getElement: () => null } } } as unknown as ScriptingAPI;
const hasFocus = (name?: string) => ScriptingAPI.prototype.hasFocus.call(api, name);

describe('hasFocus() (#457)', () => {
    afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

    it('answers from the focused element, without searching the document', () => {
        const output = document.createElement('div');
        for (let i = 0; i < 500; i++) output.appendChild(document.createElement('div'));
        const input = document.createElement('textarea');
        input.className = 'command-input';
        const other = document.createElement('input');
        document.body.append(output, input, other);

        const query = vi.spyOn(document, 'querySelector');
        const queryAll = vi.spyOn(document, 'querySelectorAll');
        input.focus();
        expect(hasFocus()).toBe(true);
        expect(hasFocus('main')).toBe(true);
        other.focus();
        expect(hasFocus()).toBe(false);
        expect(query).not.toHaveBeenCalled();
        expect(queryAll).not.toHaveBeenCalled();
    });
});
