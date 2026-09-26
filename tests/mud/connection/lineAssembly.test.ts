import { describe, it, expect, vi, afterEach } from 'vitest';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import { TELNET_EOR, TELNET_GA } from '../../../src/mud/protocol/constants';
import type { MudClientEvents } from '../../../src/mud/events';

// Exercise MudClient's partial-line assembly directly via feedTelnet (which
// runs the same processIncomingData path as a real WebSocket frame) and collect
// the rendered lines off the `flushLines` event. No socket is opened.
function makeClient() {
    const bus = new EventBus<MudClientEvents>();
    const client = new MudClient({ url: 'ws://test.invalid' }, bus);
    const lines: string[] = [];
    bus.on('flushLines', (groups) => {
        for (const g of groups) lines.push(g.text);
    });
    // Latch GA-driver mode the way a real Discworld session does: the server
    // ends its first transmission with IAC GA.
    const latchGaDriver = () => client.feedTelnet('\r\n' + TELNET_GA);
    return { client, lines, latchGaDriver };
}

describe('MudClient line assembly', () => {
    it('joins a line split mid-word across two frames in GA-driver mode', () => {
        const { client, lines, latchGaDriver } = makeClient();
        latchGaDriver();
        lines.length = 0; // discard the empty priming flush

        // The frame boundary falls inside the word "Stren" — exactly the
        // Discworld bug report. Neither frame ends in a newline until the second.
        client.feedTelnet('This is the entrance area of the Mended Drum. Str');
        client.feedTelnet('en Withel, Hrun and the splatter are standing here.\r\n');

        expect(lines).toEqual([
            'This is the entrance area of the Mended Drum. Stren Withel, Hrun and the splatter are standing here.\n',
        ]);
    });

    it('joins a split line before GA latches (timeout-fallback path)', () => {
        const { client, lines } = makeClient();

        client.feedTelnet('first half of the ');
        client.feedTelnet('line completed here\r\n');

        expect(lines).toEqual(['first half of the line completed here\n']);
    });

    it('flushes a newline-less prompt as its own line when IAC GA arrives', () => {
        const { client, lines, latchGaDriver } = makeClient();
        latchGaDriver();
        lines.length = 0;

        // A Discworld prompt: text with no trailing newline, terminated by GA.
        client.feedTelnet('HP: 100 > ' + TELNET_GA);

        expect(lines).toEqual(['HP: 100 > ']);
    });

    it('does not split a complete multi-line frame', () => {
        const { client, lines, latchGaDriver } = makeClient();
        latchGaDriver();
        lines.length = 0;

        client.feedTelnet('line one\r\nline two\r\n');

        expect(lines).toEqual(['line one\nline two\n']);
    });
});

// Issue #178 — line and prompt boundaries measured against desktop Mudlet.
// `events` interleaves flushed text with prompt events in the order they fire,
// so a test can tell which flushed line a prompt belongs to: MudClient emits
// `prompt` right before the flushLines batch that carries the prompt line.
function makeRecorder(opts: Record<string, unknown> = {}) {
    const bus = new EventBus<MudClientEvents>();
    const client = new MudClient({ url: 'ws://test.invalid', ...opts }, bus);
    const events: string[] = [];
    bus.on('flushLines', (groups) => {
        for (const g of groups) events.push(g.text);
    });
    bus.on('prompt', (promptLine) => { events.push(promptLine === false ? '<GA:bare>' : '<GA>'); });
    return { client, events };
}

describe('MudClient prompt markers inside a frame', () => {
    it('ends the prompt line at a GA in the middle of a frame', () => {
        const { client, events } = makeRecorder();
        client.feedTelnet('Z0> ' + TELNET_GA);
        events.length = 0;

        client.feedTelnet('A1> ' + TELNET_GA + 'B1 text\r\n');

        expect(events).toEqual(['<GA>', 'A1> ', 'B1 text\n']);
    });

    it('keeps two prompts in one frame apart', () => {
        const { client, events } = makeRecorder();
        client.feedTelnet('MP1> ' + TELNET_GA + 'MP2> ' + TELNET_EOR);

        expect(events).toEqual(['<GA>', 'MP1> ', '<GA>', 'MP2> ']);
    });

    it('does not treat GA bytes inside a subnegotiation as a prompt', () => {
        const { client, events } = makeRecorder();
        // An unknown option's SB payload that happens to carry IAC GA.
        client.feedTelnet('x\xFF\xFA\x7Fp' + TELNET_GA + 'q\xFF\xF0y\r\n');

        expect(events).toEqual(['xy\n']);
    });
});

describe('MudClient telnet sequences split across frames', () => {
    it('joins IAC and GA arriving in separate frames', () => {
        const { client, events } = makeRecorder();
        client.feedTelnet('Z0> ' + TELNET_GA);
        events.length = 0;

        client.feedTelnet('S1> \xFF');
        client.feedTelnet('\xF9');

        expect(events).toEqual(['<GA>', 'S1> ']);
    });

    it('drops a split IAC NOP instead of showing its command byte', () => {
        const { client, events } = makeRecorder();
        client.feedTelnet('N1 a\xFF');
        client.feedTelnet('\xF1b\r\n');

        expect(events).toEqual(['N1 ab\n']);
    });

    it('waits for the option byte of a split IAC WILL', () => {
        const { client, events } = makeRecorder();
        client.feedTelnet('W1 a\xFF\xFB');
        client.feedTelnet('\x7Fb\r\n');

        expect(events).toEqual(['W1 ab\n']);
    });
});

describe('MudClient partial lines in GA-driven mode', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('does not split a line that trickles in slower than the prompt timeout', () => {
        vi.useFakeTimers();
        const { client, events } = makeRecorder();
        client.feedTelnet('Z0> ' + TELNET_GA);
        events.length = 0;

        client.feedTelnet('P1 part ');
        vi.advanceTimersByTime(1200);
        client.feedTelnet('P1 rest\r\n');

        expect(events).toEqual(['P1 part P1 rest\n']);
    });

    it('still flushes a slow partial line before GA has latched', () => {
        vi.useFakeTimers();
        const { client, events } = makeRecorder();

        client.feedTelnet('Name: ');
        vi.advanceTimersByTime(1200);

        expect(events).toEqual(['Name: ']);
    });

    it('reports a bare GA as ending no prompt line', () => {
        const { client, events } = makeRecorder();
        client.feedTelnet('Room line\r\n');
        client.feedTelnet(TELNET_GA);
        client.feedTelnet('Next line\r\n');

        expect(events).toEqual(['Room line\n', '<GA:bare>', 'Next line\n']);
    });
});
