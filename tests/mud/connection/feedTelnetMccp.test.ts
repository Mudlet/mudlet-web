// @vitest-environment node
// Telnet_spec "Tests MCCP compressed streams": feedTelnet runs injected bytes
// through MCCP as desktop's loopbackTest() does, a broken stream is warned
// about between the texts around it, and a replay — post-MCCP data played back
// by a parser that knows nothing of compression — is not inflated again.
import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import type { MudClientEvents } from '../../../src/mud/events';

const WILL = '\xFF\xFB\x56';
const START = '\xFF\xFA\x56\xFF\xF0';
const latin1 = (buf: Buffer) => buf.toString('latin1');

function client() {
    const bus = new EventBus<MudClientEvents>();
    const c = new MudClient({ url: 'ws://test.invalid' }, bus);
    const log: string[] = [];
    bus.on('flushLines', (groups) => {
        for (const g of groups) for (const line of g.text.split('\n')) if (line) log.push(`line ${line}`);
    });
    bus.on('client.warning', (message) => log.push(`warn ${message.split('\n')[0]}`));
    return { c, log };
}

describe('feedTelnet and MCCP', () => {
    it('inflates a stream fed after the offer, then shows the plain text after its end', () => {
        const { c, log } = client();
        c.feedTelnet(WILL);
        c.feedTelnet(START + latin1(zlib.deflateSync(Buffer.from('INFLATED\r\n'))) + 'PLAIN\r\n');
        expect(log).toEqual(['line INFLATED', 'line PLAIN']);
    });

    it('warns about a stream that was never compressed and shows its text whole', () => {
        const { c, log } = client();
        c.feedTelnet(WILL);
        c.feedTelnet('BEFORE\r\n' + START + 'NOTCOMPRESSED\r\n');
        expect(log).toEqual([
            'line BEFORE',
            'warn [ WARN  ]  - MCCP decompression error (data error), compression disabled.',
            'line NOTCOMPRESSED',
        ]);
    });

    it('does not inflate a replay chunk', () => {
        const { c, log } = client();
        c.feedReplay(WILL);
        c.feedReplay(START + 'REPLAYED\r\n');
        expect(log).toEqual(['line REPLAYED']);
    });
});
