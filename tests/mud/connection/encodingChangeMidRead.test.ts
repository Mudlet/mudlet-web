import { describe, it, expect } from 'vitest';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import type { MudClientEvents } from '../../../src/mud/events';

// An encoding change inside a read (a CHARSET request, or a script's GMCP
// handler calling setServerEncoding) must not pair a byte sent in the old
// encoding with one read in the new: desktop posts the text ahead of the
// subnegotiation first (cTelnet::postHeldDataBeforeEncodingChange) and
// TBuffer turns a lead byte still held into one replacement mark.

const IAC = '\xFF', SB = '\xFA', SE = '\xF0', GA = '\xF9', DO = '\xFD', WILL = '\xFB';
const charset = (body: string) => IAC + SB + '\x2A' + body + IAC + SE;

function connect(fix = false) {
    const bus = new EventBus<MudClientEvents>();
    const client = new MudClient(
        { url: 'ws://test.invalid', fixUnnecessaryLinebreaks: fix, charsetEnabled: true } as never, bus);
    const out = { text: '' };
    bus.on('flushLines', (groups) => { for (const g of groups) out.text += g.text; });
    client.feedTelnet(IAC + DO + '\x2A');
    return { client, bus, out };
}

describe('an encoding change in the middle of a read', () => {
    it('marks a lead byte the CHARSET request cut off instead of pairing it', () => {
        const { client, out } = connect();
        client.setServerEncoding('GBK');
        client.feedTelnet('inband:\xC4' + charset('\x01;BIG5'));
        expect(client.getServerEncoding()).toBe('big5');
        client.feedTelnet('Z\r\n');
        expect(out.text).toBe('inband:\uFFFDZ\n');
    });

    it('marks a lead byte a GMCP handler\'s setServerEncoding cut off', () => {
        const { client, bus, out } = connect();
        client.setServerEncoding('GBK');
        client.feedTelnet(IAC + WILL + '\xC9');
        bus.on('gmcp', () => { client.setServerEncoding('BIG5'); });
        client.feedTelnet('gmcp:\xC4' + IAC + SB + '\xC9Encoding.Probe {}' + IAC + SE);
        client.feedTelnet('Z\r\n');
        expect(out.text).toBe('gmcp:\uFFFDZ\n');
    });

    it('keeps the line breaks around a prompt the change splits', () => {
        const { client, out } = connect(true);
        client.feedTelnet('gaprompt:0>' + IAC + GA);
        out.text = '';
        client.feedTelnet('gatext' + charset('\x01;BIG5') + '\ngaprompt:1>' + IAC + GA);
        client.feedTelnet('\ngaprompt:HP' + charset('\x01;GBK') + '>' + IAC + GA);
        client.feedTelnet('gaprompt:end\r\n');
        expect(out.text).toBe('gatext\ngaprompt:1>gaprompt:HP>gaprompt:end\n');
    });
});
