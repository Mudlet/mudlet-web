// @vitest-environment node
//
// #435: a flood arriving as one large read held the page for seconds, every
// line running every trigger before the event loop got a turn. MudClient now
// runs a large socket read through the pipeline in slices, yielding between
// them. These pin what must not change: order (lines, GMCP, prompts, what the
// listeners send), that an ordinary read is still handled before onmessage
// returns, and that close/disconnect/feedTelnet see every queued line first.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import type { MudClientEvents } from '../../../src/mud/events';

class MockWebSocket {
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readyState = MockWebSocket.OPEN;
    binaryType = '';
    bufferedAmount = 0;
    sent: string[] = [];
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;

    constructor(public url: string) { MockWebSocket.instances.push(this); }
    send(bytes: Uint8Array) { this.sent.push(String.fromCharCode(...bytes)); }
    close() { this.readyState = MockWebSocket.CLOSED; }

    deliver(byteString: string) {
        const buf = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) buf[i] = byteString.charCodeAt(i) & 0xff;
        this.onmessage?.({ data: buf.buffer });
    }
}

const IAC = '\xFF', SB = '\xFA', SE = '\xF0', GA = '\xFF\xF9';
const GMCP_WILL = '\xFF\xFB\xC9';
const gmcp = (body: string) => `${IAC}${SB}\xC9${body}${IAC}${SE}`;

/** Spin for `ms`: a listener as slow as a line with a few hundred triggers. */
function busy(ms: number): void {
    const until = performance.now() + ms;
    while (performance.now() < until) { /* spin */ }
}

const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function settle(done: () => boolean): Promise<void> {
    for (let i = 0; i < 10_000 && !done(); i++) await nextTask();
}

describe('a large read is handled in slices', () => {
    let realWebSocket: unknown;
    let hadWindow = false;

    beforeEach(() => {
        realWebSocket = (globalThis as Record<string, unknown>).WebSocket;
        (globalThis as Record<string, unknown>).WebSocket = MockWebSocket as unknown;
        MockWebSocket.instances = [];
        // The line assembler's timers are window.setTimeout.
        hadWindow = 'window' in globalThis;
        if (!hadWindow) (globalThis as Record<string, unknown>).window = globalThis;
    });
    afterEach(() => {
        (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
        if (!hadWindow) delete (globalThis as Record<string, unknown>).window;
    });

    /** A connected client logging each line, GMCP message and prompt in the
     *  order the pipeline hands them on; each batch of lines costs `cost` ms. */
    function connected(cost = 0) {
        const bus = new EventBus<MudClientEvents>();
        const client = new MudClient({ url: 'ws://test.invalid' }, bus);
        client.connect();
        const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1];
        sock.onopen?.({});
        sock.deliver(GMCP_WILL);
        const log: string[] = [];
        bus.on('gmcp', ({ path, value }) => {
            const n = (value as { n?: number } | null)?.n;
            log.push(n === undefined ? `gmcp ${path}` : `gmcp ${path} ${n}`);
        });
        bus.on('prompt', () => log.push('prompt'));
        bus.on('flushLines', groups => {
            for (const g of groups) for (const line of g.text.split('\n')) if (line) log.push(line);
            busy(cost);
        });
        bus.on('client.disconnect', () => log.push('disconnect'));
        return { client, sock, log, bus };
    }

    const lines = (from: number, to: number) =>
        Array.from({ length: to - from }, (_, i) => `line ${from + i}`);

    it('handles an ordinary read before onmessage returns', () => {
        const { sock, log } = connected(20);
        sock.deliver(lines(0, 32).map(l => `${l}\r\n`).join(''));
        expect(log).toEqual(lines(0, 32));
    });

    it('gives the event loop a turn in a flood, and keeps every line in order', async () => {
        const { sock, log } = connected(15);
        let timerRanAfter = -1;
        setTimeout(() => { timerRanAfter = log.length; }, 0);
        const flood = lines(0, 400);
        sock.deliver(flood.map(l => `${l}\r\n`).join(''));
        // The first slice ran at once; the rest waits its turn.
        expect(log.length).toBeGreaterThan(0);
        expect(log.length).toBeLessThan(flood.length);
        await settle(() => log.length === flood.length);
        expect(log).toEqual(flood);
        // A timer due during the flood ran between slices, not after it.
        expect(timerRanAfter).toBeGreaterThan(0);
        expect(timerRanAfter).toBeLessThan(flood.length);
    });

    it('keeps GMCP, prompts and later reads in stream order', async () => {
        const { sock, log } = connected(15);
        const flood = lines(0, 300);
        const messages: number[] = [];
        let data = '';
        for (let i = 0; i < flood.length; i++) {
            data += `${flood[i]}\r\n`;
            if (i % 7 === 3) {
                // Some subnegotiations carry a newline, so a slice can end
                // inside one.
                data += gmcp(`Room.Info {"n":${i},"d":"a\nb"}`);
                messages.push(i);
            }
        }
        data += 'HP 100>' + GA;
        sock.deliver(data);
        // A read arriving while the flood is still queued goes after it.
        sock.deliver('after\r\n' + gmcp('Char.Vitals {}'));
        const total = flood.length + messages.length + 4;
        await settle(() => log.length === total);
        expect(log).toHaveLength(total);
        // Lines and messages each in stream order. As within any one read, a
        // slice's out-of-band data is handled before its lines (#384), so a
        // message can come early, never late: never after the line after it.
        expect(log.filter(l => l.startsWith('line '))).toEqual(flood);
        expect(log.filter(l => l.startsWith('gmcp Room.Info'))).toEqual(messages.map(n => `gmcp Room.Info ${n}`));
        for (const n of messages) {
            expect(log.indexOf(`gmcp Room.Info ${n}`)).toBeLessThan(log.indexOf(`line ${n + 1}`));
        }
        expect(log.filter(l => l === 'prompt')).toHaveLength(1);
        expect(log.filter(l => l !== 'prompt').slice(-3)).toEqual(['HP 100>', 'gmcp Char.Vitals', 'after']);
    });

    it('sends what the listeners send in line order', async () => {
        const { client, sock, log, bus } = connected(15);
        bus.on('flushLines', groups => {
            for (const g of groups) for (const line of g.text.split('\n')) {
                if (line.endsWith('0')) client.send(`cmd ${line}`, false);
            }
        });
        sock.deliver(lines(0, 300).map(l => `${l}\r\n`).join(''));
        await settle(() => log.length === 300);
        const commands = sock.sent.join('').match(/cmd line \d+/g);
        expect(commands).toEqual(lines(0, 300).filter(l => l.endsWith('0')).map(l => `cmd ${l}`));
    });

    it('handles every queued line before the close', async () => {
        const { sock, log } = connected(15);
        sock.deliver(lines(0, 300).map(l => `${l}\r\n`).join('') + 'no newline');
        expect(log.length).toBeLessThan(300);
        sock.readyState = MockWebSocket.CLOSED;
        sock.onclose?.({ code: 1000, wasClean: true, reason: '' });
        // The unterminated last line comes out after the disconnect, as
        // desktop's does.
        expect(log).toEqual([...lines(0, 300), 'disconnect', 'no newline']);
    });

    it('handles every queued line before a disconnect()', () => {
        const { client, sock, log } = connected(15);
        sock.deliver(lines(0, 300).map(l => `${l}\r\n`).join(''));
        expect(log.length).toBeLessThan(300);
        client.disconnect();
        expect(log).toEqual([...lines(0, 300), 'disconnect']);
    });

    it('carries on with the rest of the read after a listener disconnects', async () => {
        const { client, sock, log, bus } = connected(15);
        bus.on('flushLines', groups => {
            if (groups.some(g => g.text.includes('line 40\n'))) client.disconnect();
        });
        sock.deliver(lines(0, 300).map(l => `${l}\r\n`).join(''));
        await settle(() => log.length === 301);
        // the disconnect lands after the slice holding line 40, and the rest
        // of what had already arrived is still handled, as it always was
        const at = log.indexOf('disconnect');
        expect(at).toBeGreaterThan(40);
        expect(log.filter(l => l !== 'disconnect')).toEqual(lines(0, 300));
    });

    it('drops the reads after the one a listener disconnects in', async () => {
        const { client, sock, log, bus } = connected(15);
        bus.on('flushLines', groups => {
            if (groups.some(g => g.text.includes('line 40\n'))) client.disconnect();
        });
        const onmessage = sock.onmessage!;
        sock.deliver(lines(0, 300).map(l => `${l}\r\n`).join(''));
        // A read the socket handed over before the disconnect, still queued.
        const late = 'late line\r\n';
        const buf = new Uint8Array(late.length);
        for (let i = 0; i < late.length; i++) buf[i] = late.charCodeAt(i);
        onmessage({ data: buf.buffer });
        await settle(() => log.length >= 301);
        await nextTask();
        expect(log.filter(l => l !== 'disconnect')).toEqual(lines(0, 300));
    });
});
