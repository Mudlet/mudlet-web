// mudlet-web#272, items 1 and 4 — measured against the Mudlet PTB:
//  - A NUL byte never reaches the buffer (cTelnet::processSocketData drops it
//    outside a subnegotiation), so `line` is not cut short at it.
//  - A partial line holding nothing but escapes, flushed by the prompt timeout,
//    is not a line: Mudlet drops the "empty timer posting" and its colours
//    carry on into the text that follows.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import { stripTelnetSequences } from '../../../src/mud/protocol/gmcp';
import { AnsiAwareBuffer } from '../../../src/mud/text/FormatState';
import type { MudClientEvents } from '../../../src/mud/events';

const E = '\x1b';

function makeClient() {
    const bus = new EventBus<MudClientEvents>();
    const client = new MudClient({ url: 'ws://test.invalid' }, bus);
    const lines: string[] = [];
    bus.on('flushLines', (groups) => {
        for (const g of groups) lines.push(...g.text.split('\n').filter((l, i, a) => i < a.length - 1 || l !== ''));
    });
    return { client, lines };
}

describe('mudlet-web#272 — NUL bytes', () => {
    it.each([
        ['N1 a\0XXb\r\n', 'N1 aXXb'],
        ['N2 \0\0abcXX\r\n', 'N2 abcXX'],
        ['Z1 hp\0: 100 ready\r\n', 'Z1 hp: 100 ready'],
    ])('%j reaches the line without its NULs', (wire, want) => {
        const { client, lines } = makeClient();
        client.feedTelnet(wire);
        expect(lines).toEqual([want]);
    });

    it('leaves a NUL inside a subnegotiation payload alone', () => {
        const payloads: string[] = [];
        const out = stripTelnetSequences('a\0b\xff\xfa\xc9x\0y\xff\xf0c', (seq) => {
            payloads.push(seq.substring(2, seq.length - 2));
            return '';
        });
        expect(out).toBe('abc');
        expect(payloads).toEqual(['\xc9x\0y']);
    });
});

describe('mudlet-web#272 — colour-only fragment flushed by the prompt timeout', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('adds no empty line, and the colour carries on into the next text', () => {
        vi.useFakeTimers();
        const { client, lines } = makeClient();
        client.feedTelnet('P0 before\r\n');
        client.feedTelnet(`${E}[31m`);
        vi.advanceTimersByTime(1200);
        client.feedTelnet('P1 after colour-only fragment\r\n');

        expect(lines.map(l => new AnsiAwareBuffer(l).text)).toEqual(['P0 before', 'P1 after colour-only fragment']);
        const p1 = new AnsiAwareBuffer(lines[1]);
        expect(p1.getStateAt(0)?.foreground).toEqual({ space: 'hex', color: '#800000' });
    });

    it('two such fragments in a row add nothing either', () => {
        vi.useFakeTimers();
        const { client, lines } = makeClient();
        client.feedTelnet(`${E}[0m${E}[1m`);
        vi.advanceTimersByTime(1200);
        client.feedTelnet(`${E}[0m`);
        vi.advanceTimersByTime(1200);
        client.feedTelnet('P2 after two fragments\r\n');

        expect(lines.map(l => new AnsiAwareBuffer(l).text)).toEqual(['P2 after two fragments']);
        expect(new AnsiAwareBuffer(lines[0]).getStateAt(0)?.bold).toBeUndefined();
    });

    it('still flushes a fragment of spaces or text', () => {
        vi.useFakeTimers();
        const { client, lines } = makeClient();
        client.feedTelnet('   ');
        vi.advanceTimersByTime(1200);
        client.feedTelnet(`${E}[32mName: `);
        vi.advanceTimersByTime(1200);
        client.feedTelnet(`${E}[5C`);
        vi.advanceTimersByTime(1200);

        expect(lines.map(l => new AnsiAwareBuffer(l).text)).toEqual(['   ', 'Name: ', '     ']);
    });
});
