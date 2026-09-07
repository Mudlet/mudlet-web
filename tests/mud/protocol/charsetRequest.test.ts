// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import type { MudClientEvents } from '../../../src/mud/events';

// A server's RFC 2066 CHARSET REQUEST, arriving as injected bytes the way
// feedTelnet delivers them: IAC SB CHARSET REQUEST <sep><name>[<sep><name>…]
// IAC SE. What comes back is the name this client then reports for the
// session, which is its own canonical spelling and not the wire's.
const request = (...names: string[]) =>
    '\xFF\xFA\x2A\x01;' + names.join(';') + '\xFF\xF0';

describe('CHARSET REQUEST picks the encoding to run the session in', () => {
    let client: MudClient;
    let negotiated: string[];

    beforeEach(() => {
        const bus = new EventBus<MudClientEvents>();
        negotiated = [];
        bus.on('charset.negotiated', name => negotiated.push(name));
        client = new MudClient({ url: 'ws://test.invalid' }, bus);
        // A REQUEST is read only while the option is live, so the server
        // offers CHARSET first — as one does before sending one.
        client.feedTelnet('\xFF\xFB\x2A');
    });
    afterEach(() => { negotiated = []; });

    const encoding = () => negotiated[negotiated.length - 1];

    it('switches to a code page the browser has no decoder for', () => {
        client.feedTelnet(request('CP437'));
        expect(encoding()).toBe('CP437');
    });

    it('keeps the encoding already in use when it is on offer too', () => {
        // Taking the first name would let a game listing ASCII ahead of UTF-8
        // quietly downgrade the session.
        client.feedTelnet(request('ASCII', 'UTF-8'));
        expect(encoding()).toBe('UTF-8');
    });

    it('reads the spelling a server writes as the name this client uses', () => {
        client.feedTelnet(request('ISO-8859-2'));
        expect(encoding()).toBe('ISO 8859-2');
        client.feedTelnet(request('US-ASCII'));
        expect(encoding()).toBe('ASCII');
    });

    it('skips the names it cannot decode and takes the first it can', () => {
        client.feedTelnet(request('NOSUCHCHARSET', 'CP437'));
        expect(encoding()).toBe('CP437');
    });

    it('changes nothing when nothing on offer is one it knows', () => {
        client.feedTelnet(request('NOSUCHCHARSET', 'ALSOUNKNOWN'));
        expect(negotiated).toEqual([]);
    });

    it('changes nothing for a request with nothing after the separator', () => {
        client.feedTelnet('\xFF\xFA\x2A\x01;\xFF\xF0');
        client.feedTelnet('\xFF\xFA\x2A\x01\xFF\xF0');
        expect(negotiated).toEqual([]);
        // …and neither may leave the parser unable to act on the next request
        client.feedTelnet(request('CP437'));
        expect(encoding()).toBe('CP437');
    });
});
