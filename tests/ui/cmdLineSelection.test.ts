import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCmdLineSelection, type CmdLineSelection } from '../../src/ui/cmdline/useCmdLineSelection';
import { CommandLineOverlay } from '../../src/ui/cmdline/CommandLineOverlay';
import { CommandLineManager } from '../../src/ui/cmdline/CommandLineManager';

// Issue #284 item 5: `printCmdLine("ghi"); selectCmdLineText()` left nothing
// selected, so typing Z made the line "ghiZ" where desktop's is "Z". The
// selection was applied before React had put the new text in the input, and
// writing a controlled input's value puts the caret at its end.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
    document.body.replaceChildren();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
});

/** The main command bar's shape: text in state, an input bound to it, and the
 *  two things a script does — stage text and ask for a caret/selection. */
function mountMain() {
    const api: {
        stage?: (text: string) => void;
        request?: (sel: CmdLineSelection | null, focus?: boolean) => void;
    } = {};
    const Harness = () => {
        const [value, setValue] = useState('');
        const ref = useRef<HTMLTextAreaElement>(null);
        const request = useCmdLineSelection(ref, value);
        api.stage = setValue;
        api.request = request;
        return createElement('textarea', { ref, value, onChange: () => {} });
    };
    act(() => { root.render(createElement(Harness)); });
    const input = () => container.querySelector('textarea') as HTMLTextAreaElement;
    return { api, input };
}

const selection = (el: HTMLInputElement | HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd];

describe('main command line: caret and selection after a script stages text', () => {
    it('selects text a printCmdLine put there just before selectCmdLineText', () => {
        const { api, input } = mountMain();
        act(() => {
            api.stage!('ghi');
            api.request!('end');      // printCmdLine
            api.request!('all');      // selectCmdLineText
        });
        expect(input().value).toBe('ghi');
        expect(selection(input())).toEqual([0, 3]);
    });

    it('leaves the caret at the end for printCmdLine after selectCmdLineText', () => {
        const { api, input } = mountMain();
        act(() => { api.stage!('abc'); });
        act(() => {
            api.request!('all');
            api.stage!('abcdef');
            api.request!('end');
        });
        expect(selection(input())).toEqual([6, 6]);
    });

    it('selects with no text change, and drops a request the line was cleared after', () => {
        const { api, input } = mountMain();
        act(() => { api.stage!('look'); });
        act(() => { api.request!('all'); });
        expect(selection(input())).toEqual([0, 4]);
        act(() => { api.request!('end'); });
        expect(selection(input())).toEqual([4, 4]);
        act(() => {
            api.request!('all');
            api.stage!('');
            api.request!(null);
        });
        expect(input().value).toBe('');
    });
});

describe('createCommandLine overlay: printCmdLine then selectCmdLineText', () => {
    it('selects the text the print just staged', () => {
        const manager = new CommandLineManager();
        manager.create('c1', { x: 0, y: 0, width: 100, height: 20 });
        act(() => { root.render(createElement(CommandLineOverlay, { manager, parent: 'main' })); });
        const input = () => container.querySelector('input[data-mudlet-cmdline-overlay="c1"]') as HTMLInputElement;
        act(() => {
            manager.setValue('c1', 'ghi');
            manager.selectAll('c1');
        });
        expect(input().value).toBe('ghi');
        expect(selection(input())).toEqual([0, 3]);
        // And the other way round the print wins, as on desktop.
        act(() => {
            manager.selectAll('c1');
            manager.setValue('c1', 'ghijk');
        });
        expect(selection(input())).toEqual([5, 5]);
    });
});
