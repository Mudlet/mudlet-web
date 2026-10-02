// A command echoed at a GA prompt is shown inline on the prompt row and stored
// there exactly once (mudlet-web#288). The console model joins it
// (Console.appendToPromptLine, from MudSession.echoCommand) and the renderer
// only redraws the row. The renderer used to do the joining itself, into the
// very buffer the console stores — so the command landed on the prompt line in
// getLines() as well as on the separate line echoCommand had already added.
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
    session.consoles.set('main', new Console());
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
    return { rows };
}

/** What processFlushBatch does with a GA-terminated line: store it flagged as
 *  a prompt, then render it. */
function serverPrompt(session: MudSession, text: string): void {
    const buf = new AnsiAwareBuffer(text);
    buf.isPrompt = true;
    session.consoles.get('main')!.appendLine(buf);
    session.events.emit('message', buf, 'mud', Date.now(), true);
}

function bufferLines(session: MudSession): string[] {
    const con = session.consoles.get('main')!;
    return con.getLines(0, con.getLineCount() + 1).map(plain).filter(l => l !== '');
}

describe('command echo at a GA prompt', () => {
    it('is drawn on the prompt row and stored there once', () => {
        const session = new MudSession();
        const { rows } = mount(session);

        serverPrompt(session, 'B2 hp> ');
        session.echoCommand('cmdX');

        expect(rows()).toEqual(['B2 hp> cmdX']);
        expect(bufferLines(session)).toEqual(['B2 hp> cmdX']);
    });

    it('draws a second command on a row of its own, as it is stored', () => {
        const session = new MudSession();
        const { rows } = mount(session);

        serverPrompt(session, 'G1 hp> ');
        session.echoCommand('glance');
        session.echoCommand('look');

        expect(rows()).toEqual(['G1 hp> glance', 'look']);
        expect(bufferLines(session)).toEqual(['G1 hp> glance', 'look']);
    });

    it('draws a command sent from inside the trigger engine below the prompt', () => {
        const session = new MudSession();
        const { rows } = mount(session);

        serverPrompt(session, 'T1 hp> ');
        session.scriptEchoDeferred = true;
        session.echoCommand('fromTrigger');
        session.scriptEchoDeferred = false;

        expect(rows()).toEqual(['T1 hp> ', 'fromTrigger']);
        expect(bufferLines(session)).toEqual(['T1 hp> ', 'fromTrigger']);
    });
});
