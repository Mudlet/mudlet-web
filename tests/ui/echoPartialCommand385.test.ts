// mudlet-web#385 item 2: a command typed after an `echo()` with no trailing
// newline is drawn on that echo's row, as desktop's printCommand writes it into
// the line echo() is building — `P1cmdA`, not `P1` and `cmdA` on two rows.
import { describe, it, expect, beforeEach } from 'vitest';
import { MudSession } from '../../src/mud/MudSession';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';
import { Console } from '../../src/mud/text/Console';
import { setupOutputRenderer } from '../../src/ui/output/OutputRenderer';

beforeEach(() => {
    document.body.replaceChildren();
});

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function mount(session: MudSession) {
    const main = new Console();
    session.consoles.set('main', main);
    const wrapper = document.createElement('div');
    const sentinel = document.createElement('div');
    sentinel.className = 'output-sentinel';
    wrapper.appendChild(sentinel);
    const stickyArea = document.createElement('div');
    document.body.append(wrapper, stickyArea);
    setupOutputRenderer(session.events as never, {
        outputWrapper: wrapper, sentinel, stickyArea, isSplitView: () => false, stickyLines: 5,
    });
    const rows = () => Array.from(wrapper.querySelectorAll<HTMLElement>('.output-msg'))
        .map(r => r.querySelector('.output-msg-content')?.textContent ?? '');
    /** What ScriptingAPI.echo + flushOutput do with an unterminated echo. */
    const echoPartial = (text: string) => {
        main.currentPartial.appendBuffer(new AnsiAwareBuffer(text));
        session.events.emit('message', main.currentPartial, 'script-partial');
    };
    const bufferLines = () => main.getLines(0, main.getLineCount() + 1).map(plain).filter(l => l !== '');
    return { rows, echoPartial, bufferLines };
}

describe('command echo after an unterminated echo', () => {
    it('is drawn on the echo\'s row and stored there once', () => {
        const session = new MudSession();
        const { rows, echoPartial, bufferLines } = mount(session);

        echoPartial('P1');
        session.echoCommand('cmdA');

        expect(rows()).toEqual(['P1cmdA']);
        expect(bufferLines()).toEqual(['P1cmdA']);
    });

    it('lets the next echo start a row of its own', () => {
        const session = new MudSession();
        const { rows, echoPartial, bufferLines } = mount(session);

        echoPartial('P1');
        session.echoCommand('cmdA');
        echoPartial('P2');
        session.echoCommand('cmdB');
        session.echoCommand('cmdC');

        expect(rows()).toEqual(['P1cmdA', 'P2cmdB', 'cmdC']);
        expect(bufferLines()).toEqual(['P1cmdA', 'P2cmdB', 'cmdC']);
    });
});
