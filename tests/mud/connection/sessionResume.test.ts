import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MudClient, IDLE_PROBE_MS } from '../../../src/mud/connection/MudClient';
import { MudSession } from '../../../src/mud/MudSession';
import { EventBus } from '../../../src/core/EventBus';
import type { MudClientEvents } from '../../../src/mud/events';
import { ECHO_WILL, ECHO_WONT, SGA_WILL } from '../../../src/mud/protocol/constants';

import {
    BrowserMockWebSocket, OFFER, PROXY, marker, sameSession, visibility, visit,
} from '../../support/resumableSocket';

describe('session resumption (client)', () => {
    let client: MudClient;
    let events: string[];
    let errors: string[];
    let warnings: string[];
    let shown: string;
    let ws: BrowserMockWebSocket;

    beforeEach(() => {
        vi.stubGlobal('WebSocket', BrowserMockWebSocket);
        BrowserMockWebSocket.all = [];
        visibility('hidden');                  // so a loss does not start an automatic attempt by itself
        const bus = new EventBus<MudClientEvents>();
        events = [];
        errors = [];
        warnings = [];
        shown = '';
        for (const name of ['client.connect', 'client.established', 'client.disconnect', 'client.detached', 'client.resumed', 'charmode.detected'] as const) {
            bus.on(name, () => events.push(name));
        }
        bus.on('client.error', m => errors.push(m));
        bus.on('client.warning', m => warnings.push(m));
        bus.on('flushLines', groups => { shown += groups.map(g => g.text).join(''); });
        client = new MudClient({ url: PROXY }, bus);
        client.connect();
        ws = BrowserMockWebSocket.all[0];
        ws.onopen?.({});
        ws.text({ type: 'game.connected' });
        events.length = 0;
    });

    afterEach(() => {
        client.disconnect();
        vi.unstubAllGlobals();
        visibility('visible');
    });

    /** The offer accepted and the marker received: the session is retained. */
    const enable = (input = 0n, output = 0n): void => { ws.text(OFFER); ws.text(marker(input, output)); };

    it('is the plain socket without an offer: raw bytes both ways, and an ordinary close ends it', () => {
        ws.text({ type: 'session.ended' });                 // a direct game's unrelated control is not a session
        client.send('look');
        ws.raw('hello\n');
        expect(ws.sentText()).toEqual(['look\r\n']);
        expect(ws.controls()).toEqual([]);
        expect(shown).toBe('hello\n');
        ws.drop();
        expect(events).toEqual(['client.disconnect']);
    });

    it('does not count the unretained raw prefix toward the input buffer limit', () => {
        const raw = 'x'.repeat(1024 * 1024);
        client.send(raw);
        expect(errors).toEqual([]);
        expect(ws.sentText()).toEqual([raw + '\r\n']);
        ws.sent = [];
        ws.text(OFFER);
        client.send('next');
        ws.text(marker(BigInt(raw.length + 2)));
        expect(errors).toEqual([]);
        expect(ws.envelopes()).toEqual([{ offset: BigInt(raw.length + 2), text: 'next\r\n' }]);
    });

    it('accepts an offer, holds sends until the marker, then numbers them from the marker cursors', () => {
        client.send('pre');
        ws.text(OFFER);
        expect(ws.controls()).toEqual([{ type: 'session.accept', offerId: 'offer-1' }]);
        client.send('held');
        ws.raw('banner');                                  // raw output counts toward the marker
        expect(ws.sentText()).toEqual(['pre\r\n']);
        ws.sent = [];                                     // discard the recorded raw prefix, not the transport's cursor
        ws.text(marker(5n, 6n));
        expect(ws.envelopes()).toEqual([{ offset: 5n, text: 'held\r\n' }]);
        client.send('next');
        expect(ws.envelopes()[1]).toEqual({ offset: 11n, text: 'next\r\n' });
    });

    it('ends the session, saying so, when the marker does not describe this stream', () => {
        ws.text(OFFER);
        ws.raw('banner');
        ws.text(marker(0n, 999n));
        expect(errors).toHaveLength(1);
        expect(ws.controls().at(-1)).toMatchObject({ type: 'session.end', ...sameSession });
        expect(events).toEqual(['client.disconnect']);
    });

    it('hands each sequenced range to the parser once: duplicates dropped, overlap trimmed, a gap fatal', () => {
        enable();
        ws.frame(0n, 'one\n');
        ws.frame(0n, 'one\n');                             // its acknowledgement was lost: resent
        ws.frame(3n, 'Xmore\n');                           // overlaps by one byte
        ws.frame(0n, 'one\n');                             // long stale: must not move the cursor back
        ws.frame(9n, 'next\n');
        expect(shown).toBe('one\nmore\nnext\n');
        expect(ws.controls().filter(c => c.type === 'session.ack').map(c => c.output)).toEqual(['4', '4', '9', '9', '14']);
        ws.frame(100n, 'gap\n');
        expect(errors).toHaveLength(1);
        expect(events).toEqual(['client.disconnect']);
        expect(shown).toBe('one\nmore\nnext\n');
    });

    it('does not accumulate idle probes while detached, and restarts them on resume', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
        try {
            client.disconnect();
            client.connect();
            ws = BrowserMockWebSocket.all[BrowserMockWebSocket.all.length - 1];
            ws.onopen?.({});
            ws.text({ type: 'game.connected' });
            enable();
            ws.frame(0n, '\xff\xf1');                      // telnet enables idle NOPs without requiring a reply
            ws.drop();
            vi.advanceTimersByTime(IDLE_PROBE_MS * 3);
            const dial = resume();
            dial.text({ type: 'session.resumed', input: '0', backendConnected: true });
            expect(dial.envelopes()).toEqual([]);
            vi.advanceTimersByTime(IDLE_PROBE_MS);
            expect(dial.sent.filter(value => value instanceof Uint8Array)).toEqual([
                new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xf1]),
            ]);
        } finally {
            client.disconnect();
            vi.useRealTimers();
        }
    });

    it('disarms character-mode detection while a password echo release waits for resumption', () => {
        vi.useFakeTimers();
        try {
            enable();
            ws.frame(0n, SGA_WILL + ECHO_WILL);
            vi.advanceTimersByTime(600);                   // commit the ECHO debounce
            expect(client.isPasswordMode()).toBe(true);
            client.send('password');
            ws.drop();
            vi.advanceTimersByTime(3_000);
            expect(events).not.toContain('charmode.detected');
            const dial = resume();
            dial.text({ type: 'session.resumed', input: '16', backendConnected: true }); // two 3-byte replies + password\r\n
            dial.frame(6n, ECHO_WONT);                     // the game released echo during the outage
            vi.advanceTimersByTime(3_000);
            expect(client.isPasswordMode()).toBe(false);
            expect(events).not.toContain('charmode.detected');
        } finally {
            client.disconnect();
            vi.useRealTimers();
        }
    });

    it('does not carry a cancelled character-mode window into a new game connection', () => {
        vi.useFakeTimers();
        try {
            enable();
            ws.frame(0n, SGA_WILL + ECHO_WILL);
            vi.advanceTimersByTime(600);
            client.send('password');
            ws.drop();
            client.disconnect();
            client.connect();
            ws = BrowserMockWebSocket.all[BrowserMockWebSocket.all.length - 1];
            ws.onopen?.({});
            ws.text({ type: 'game.connected' });
            enable();
            ws.frame(0n, SGA_WILL + ECHO_WILL);
            vi.advanceTimersByTime(3_000);
            expect(events).not.toContain('charmode.detected');
            client.send('look');
            vi.advanceTimersByTime(3_000);
            expect(events.filter(name => name === 'charmode.detected')).toEqual(['charmode.detected']);
        } finally {
            client.disconnect();
            vi.useRealTimers();
        }
    });

    /** An enabled session with `peek` sent but never acknowledged, 7 output bytes
     *  received, and the transport then lost. */
    const lose = (): void => {
        enable();
        client.send('look');                               // offset 0
        client.send('peek');                               // offset 6
        ws.text({ type: 'session.ack', input: '6' });
        ws.frame(0n, 'banner\n');
        ws.drop();
    };
    const resume = (): BrowserMockWebSocket => {
        client.connect();                                  // the public Connect entrypoint must reuse the held game
        const dial = BrowserMockWebSocket.all[BrowserMockWebSocket.all.length - 1];
        dial.onopen?.({});
        return dial;
    };

    it('resends unacknowledged input before queued sends and continues parsing replayed output in order', () => {
        lose();
        expect(events).toEqual(['client.detached']);
        expect(client.transportDetached()).toBe(true);
        client.send('offline');
        expect(ws.envelopes().map(e => e.text)).toEqual(['look\r\n', 'peek\r\n']);
        const dial = resume();
        expect(dial.url).toBe('wss://relay.test/relay/resume?host=game.test&port=23');
        expect(dial.controls()).toMatchObject([{ type: 'session.resume', ...sameSession, output: '7', inputAcked: '6', inputEnd: '12' }]);
        dial.text({ type: 'session.resumed', input: '6', backendConnected: true });
        expect(dial.envelopes()).toEqual([
            { offset: 6n, text: 'peek\r\n' },
            { offset: 12n, text: 'offline\r\n' },
        ]);
        dial.frame(7n, 'later\n');
        expect(dial.controls().at(-1)).toEqual({ type: 'session.ack', output: '13' });
        expect(events).toEqual(['client.detached', 'client.resumed']);   // and no connect, no established
        expect(shown).toBe('banner\nlater\n');
        expect(client.transportDetached()).toBe(false);
    });

    it('detaches again on a second loss, and the superseded socket can no longer speak for the session', () => {
        lose();
        const dial = resume();
        dial.text({ type: 'session.resumed', input: '12', backendConnected: true });
        expect(dial.envelopes()).toEqual([]);               // the relay accepted even the input whose ack we missed
        expect(events.at(-1)).toBe('client.resumed');
        ws.frame(7n, 'stale\n');                           // the old socket, late
        ws.drop();
        expect(events.at(-1)).toBe('client.resumed');
        expect(shown).toBe('banner\n');
        dial.drop();
        expect(events.at(-1)).toBe('client.detached');
        expect(resume().url).toBe('wss://relay.test/relay/resume?host=game.test&port=23');
    });

    it('lets a socket replaced by a later connect() report nothing about the one that replaced it', () => {
        enable();
        client.connect();
        ws.drop();                                         // the replaced socket's transport dies, late
        expect(events).toEqual([]);
        expect(client.transportDetached()).toBe(false);
        visit();                                           // its own retry finds the session gone, and stops
        const retry = BrowserMockWebSocket.all[2];
        retry.onopen?.({});
        retry.text({ type: 'session.unavailable' });
        expect(events).toEqual([]);
    });

    it('ends the session, saying why, rather than dropping input it cannot hold while away', () => {
        lose();
        client.send('x'.repeat(1024 * 1024));              // past the bound on what may wait for the game
        expect(errors.join()).toMatch(/Too much input/);
        expect(events).toEqual(['client.detached', 'client.disconnect']);
        const end = BrowserMockWebSocket.all[1];                  // and the relay is still asked to end it
        end.onopen?.({});
        expect(end.controls()).toMatchObject([{ type: 'session.end', ...sameSession }]);
        end.text({ type: 'session.ended' });
    });

    it('keeps an end its live socket never answered pending, and retries it as an end — never a resume — on the next visit', () => {
        enable();
        client.send('queued');                             // sent, not yet acknowledged: it must not be sent again
        client.disconnect();                               // the end goes into a socket that may be half-open
        expect(ws.controls().at(-1)).toMatchObject({ type: 'session.end', ...sameSession });
        expect(warnings).toEqual([]);                      // nothing is claimed until it actually fails
        ws.drop();                                         // the browser gives up on it, with no answer
        expect(warnings.join()).toMatch(/to end the game session, so the character may still be logged in/);
        expect(events).toEqual(['client.disconnect']);     // the disconnect's own close, and no second one
        visit();
        expect(BrowserMockWebSocket.all).toHaveLength(2);
        const retry = BrowserMockWebSocket.all[1];
        retry.onopen?.({});
        expect(retry.controls()).toMatchObject([{ type: 'session.end', ...sameSession }]);
        expect(retry.envelopes()).toEqual([]);             // no input flushed
        retry.text({ type: 'session.ended' });
        visit();
        expect(BrowserMockWebSocket.all).toHaveLength(2);         // confirmed: no further attempt
        expect(BrowserMockWebSocket.all.flatMap(s => s.controls()).some(c => c.type === 'session.resume')).toBe(false);
    });

    it('ends through the resume endpoint while away without flushing input, and reports an unanswered end', () => {
        enable();
        ws.drop();
        client.send('queued while away');
        client.disconnect();
        expect(events).toEqual(['client.detached', 'client.disconnect']);
        const end = BrowserMockWebSocket.all[1];
        expect(end.url).toBe('wss://relay.test/relay/resume?host=game.test&port=23');
        end.onopen?.({});
        expect(end.controls()).toMatchObject([{ type: 'session.end', ...sameSession }]);
        expect(end.envelopes()).toEqual([]);
        expect(warnings).toEqual([]);                      // nothing is claimed until the attempt actually fails
        end.drop();
        expect(warnings.join()).toMatch(/to end the game session, so the character may still be logged in/);
        // Retire the fixture's retry listener; confirmed-end semantics are covered above.
        visit();
        const retry = BrowserMockWebSocket.all[2];
        retry.onopen?.({});
        retry.text({ type: 'session.ended' });
    });

    it('makes one automatic attempt per foreground visit, and none in the background', () => {
        enable();
        visibility('visible');
        ws.drop();                                         // visible: one attempt now
        expect(BrowserMockWebSocket.all).toHaveLength(2);
        expect(client.resumeTransport()).toBe(true);       // coalesces with the one in flight
        expect(BrowserMockWebSocket.all).toHaveLength(2);
        BrowserMockWebSocket.all[1].drop();                       // failed without a verdict: no retry loop, but it is said
        expect(BrowserMockWebSocket.all).toHaveLength(2);
        expect(warnings.join()).toMatch(/to resume the game session/);
        visibility('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        expect(BrowserMockWebSocket.all).toHaveLength(2);
        visibility('visible');
        document.dispatchEvent(new Event('visibilitychange'));
        expect(BrowserMockWebSocket.all).toHaveLength(3);         // the next foreground visit gets exactly one more
        BrowserMockWebSocket.all[2].onopen?.({});
        BrowserMockWebSocket.all[2].text({ type: 'session.resumed', input: '0', backendConnected: true });
        expect(events.at(-1)).toBe('client.resumed');
    });

    it('cancels the offer it accepted when the user hangs up while the marker is still pending: no flush, no failure', () => {
        ws.text(OFFER);                                    // the accept is on its way to the relay
        client.send('held');                               // queued while the session is still being named
        client.disconnect();                               // the user hangs up in that window
        expect(ws.controls()).toEqual([
            { type: 'session.accept', offerId: 'offer-1' },
            { type: 'session.cancel', offerId: 'offer-1' },  // an explicit stop, on the socket the offer went to
        ]);
        expect(events).toEqual(['client.disconnect']);     // one logical disconnect, no failure on top of it
        expect(errors).toEqual([]);
        expect(warnings).toEqual([]);                      // nothing is claimed about an end that never needed sending
        expect(client.resumeTransport()).toBe(false);
        client.send('after');                              // nothing further is sent anywhere
        expect(ws.envelopes()).toEqual([]);                // the held command is never flushed
        ws.text(marker(0n, 0n));                           // the relay's marker still lands afterwards…
        expect(ws.controls()).toHaveLength(2);             // …and names nothing this socket will act on
        client.disconnect();                               // a duplicate close is nothing new
        expect(events).toEqual(['client.disconnect']);
    });

    it('takes a transport lost before the marker as an ordinary end, without failure or resumption', () => {
        ws.text(OFFER);                                    // accept out, marker not yet in
        ws.drop();
        expect(events).toEqual(['client.disconnect']);
        expect(errors.join()).toMatch(/Connection lost/);  // the ordinary report a plain socket's loss gets
        expect(warnings).toEqual([]);                      // nothing about resumes or ends that never were
        expect(client.resumeTransport()).toBe(false);
        expect(client.transportDetached()).toBe(false);
    });

});

describe('session resumption (MudSession)', () => {
    let session: MudSession;

    beforeEach(() => {
        vi.stubGlobal('WebSocket', BrowserMockWebSocket);
        BrowserMockWebSocket.all = [];
        visibility('hidden');
        session = new MudSession();
    });
    afterEach(() => {
        session.destroy();
        vi.unstubAllGlobals();
        visibility('visible');
    });

    /** By default the offer arrives before the proxy has reached the game. */
    const connectRetained = (url = PROXY): BrowserMockWebSocket => {
        session.connect(url);
        const ws = BrowserMockWebSocket.all[BrowserMockWebSocket.all.length - 1];
        ws.onopen?.({});
        ws.text(OFFER);
        ws.text(marker());
        return ws;
    };
    const resume = (url = PROXY, backendConnected = true): BrowserMockWebSocket => {
        session.connect(url);                               // the same Connect button, now a resume
        const dial = BrowserMockWebSocket.all[BrowserMockWebSocket.all.length - 1];
        dial.onopen?.({});
        dial.text({ type: 'session.resumed', input: '0', backendConnected });
        return dial;
    };

    it('stays connecting and re-asserts it after a resume until the game itself has connected', () => {
        const ws = connectRetained();
        ws.drop();
        const heard: string[] = [];
        session.events.on('status', (status) => heard.push(status));
        const dial = resume(PROXY, false);
        expect(session.status).toBe('connecting');         // nothing has reached the game
        expect(heard).toEqual(['connecting']);             // the resume said so itself, for every listener
        dial.text({ type: 'game.connected' });
        expect(session.status).toBe('connected');
    });

    it('does not resume the lifecycle after a connection handler explicitly disconnects', () => {
        const ws = connectRetained();
        ws.drop();
        session.events.on('client.connect', () => session.disconnect());
        const resumed: string[] = [];
        session.events.on('client.resumed', () => resumed.push('resumed'));
        const dial = resume();                             // first game.connected arrives with this resume
        expect(session.status).toBe('disconnected');
        expect(resumed).toEqual([]);
        expect(dial.controls().at(-1)).toMatchObject({ type: 'session.end', ...sameSession });
    });

    it('keeps a custom proxy\'s path and query on resume and end, and dials a different target afresh', () => {
        const authed = 'wss://relay.test/auth?token=abc.123&keep=1&keep=2&host=game.test&port=23'
            + '&tls=1&tlsIgnoreExpired=1&tlsIgnoreSelfSigned=1&tlsIgnoreAll=1';
        const endpoint = authed.replace('/auth?', '/auth/resume?');
        const ws = connectRetained(authed);
        ws.drop();
        const dial = resume(authed);
        expect(dial.url).toBe(endpoint);
        dial.drop();
        session.connect('wss://relay.test/auth?token=abc.123&keep=1&keep=2&host=elsewhere.test&port=4000');
        expect(session.dialCount).toBe(2);
        const end = BrowserMockWebSocket.all[2];                  // a different target: the retained session ends, not resumes
        expect(end.url).toBe(endpoint);                    // an end uses the old session's endpoint, not the new game's
        end.onopen?.({});
        expect(end.controls()).toMatchObject([{ type: 'session.end', ...sameSession }]);
    });

    it('learns a TLS handshake it missed while away when it resumes, and says it once however often it resumes', () => {
        const secure = `${PROXY}&tls=1`;
        const established: unknown[] = [];
        session.events.on('tls.established', info => established.push(info));
        const ws = connectRetained(secure);
        ws.drop();                                         // the page loses it before the handshake is done
        expect(session.gameTransportSecure).toBe(false);
        const dial = resume(secure);
        dial.text({ type: 'tls.established', protocol: 'TLSv1.3', acceptedDespite: [] });       // told again, as the relay does on every resume
        expect(session.gameTransportSecure).toBe(true);
        expect(established).toHaveLength(1);
        dial.drop();
        const again = resume(secure);
        again.text({ type: 'tls.established', protocol: 'TLSv1.3', acceptedDespite: [] });
        expect(session.gameTransportSecure).toBe(true);
        expect(established).toHaveLength(1);               // told twice, said once
    });

});
