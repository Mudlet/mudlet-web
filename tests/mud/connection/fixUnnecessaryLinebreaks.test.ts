import { describe, it, expect } from 'vitest';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import { TELNET_GA } from '../../../src/mud/protocol/constants';
import type { MudClientEvents } from '../../../src/mud/events';

// Exercises the "Fix unnecessary linebreaks on GA servers" port
// (MudClient.fixUnnecessaryLinebreaks → cTelnet::gotPrompt / mUSE_IRE_DRIVER_BUGFIX).
// Drives processIncomingData via feedTelnet and accumulates all rendered text off
// flushLines. We assert on the full concatenated output (the passthrough processor
// tags every chunk 'mud', so chunks within a frame merge into one group) — what
// matters here is whether the spurious leading newline survives. No socket opened.
// A block ending `\r\n` + GA ends with an extra '\n': the empty prompt line the
// bare GA ends, as in Mudlet (mudlet-web#288).
function makeClient(fix: boolean) {
    const bus = new EventBus<MudClientEvents>();
    const client = new MudClient(
        { url: 'ws://test.invalid', fixUnnecessaryLinebreaks: fix },
        bus,
    );
    const out = { text: '' };
    bus.on('flushLines', (groups) => {
        for (const g of groups) out.text += g.text;
    });
    // Latch GA-driver mode: the server ends its first transmission with IAC GA.
    const latchGaDriver = () => client.feedTelnet('\r\n' + TELNET_GA);
    return { client, out, latchGaDriver };
}

describe('MudClient fixUnnecessaryLinebreaks', () => {
    it('strips the spurious leading newline of a GA-driven block when enabled', () => {
        const { client, out, latchGaDriver } = makeClient(true);
        latchGaDriver();
        out.text = '';

        // IRE bug: the transmission begins with a stray <LF> before real content.
        client.feedTelnet('\r\nYou see a cat.\r\nHp: 100 > ' + TELNET_GA);

        expect(out.text).toBe('You see a cat.\nHp: 100 > ');
    });

    it('keeps the leading newline when disabled (default)', () => {
        const { client, out, latchGaDriver } = makeClient(false);
        latchGaDriver();
        out.text = '';

        client.feedTelnet('\r\nYou see a cat.\r\nHp: 100 > ' + TELNET_GA);

        expect(out.text).toBe('\nYou see a cat.\nHp: 100 > ');
    });

    it('strips only one newline, and only the leading one', () => {
        const { client, out, latchGaDriver } = makeClient(true);
        latchGaDriver();
        out.text = '';

        // Two leading newlines: only the first is dropped; the blank line the
        // second produces survives.
        client.feedTelnet('\r\n\r\nYou see a cat.\r\n' + TELNET_GA);

        expect(out.text).toBe('\nYou see a cat.\n\n');
    });

    it('skips a leading ANSI SGR sequence before stripping the newline', () => {
        const { client, out, latchGaDriver } = makeClient(true);
        latchGaDriver();
        out.text = '';

        // The block opens with a color escape, then the spurious newline.
        client.feedTelnet('\x1b[32m\r\nGreen text\r\n' + TELNET_GA);

        expect(out.text).toBe('\x1b[32mGreen text\n\n');
    });

    it('does not strip when the block starts with real content', () => {
        const { client, out, latchGaDriver } = makeClient(true);
        latchGaDriver();
        out.text = '';

        client.feedTelnet('Hp: 100 > ' + TELNET_GA);

        expect(out.text).toBe('Hp: 100 > ');
    });

    it('leaves a newline alone when its read has no GA after it', () => {
        const { client, out, latchGaDriver } = makeClient(true);
        latchGaDriver();
        out.text = '';

        // Desktop only strips from a block that ENDS in GA (cTelnet::gotPrompt);
        // a read with no marker goes through gotRest untouched, so the newline
        // arriving on its own survives, and the GA block after it starts with
        // real content.
        client.feedTelnet('\r\n');
        client.feedTelnet('You see a cat.\r\n' + TELNET_GA);

        expect(out.text).toBe('\nYou see a cat.\n\n');
    });

    it('leaves the reply that follows a prompt in its own packet alone (#290)', () => {
        // The issue's capture: a prompt, then 400 ms later the reply as a
        // separate packet that opens with a newline, then the next prompt.
        // Desktop shows [p1> ][][after1][p2> ][][after2][p3> ] with the option
        // on, exactly as with it off.
        const { client, out } = makeClient(true);

        client.feedTelnet('p1> ' + TELNET_GA);
        client.feedTelnet('\nafter1\r\n');
        client.feedTelnet('p2> ' + TELNET_GA);
        client.feedTelnet('\nafter2\r\n');
        client.feedTelnet('p3> ' + TELNET_GA);

        expect(out.text).toBe('p1> \nafter1\np2> \nafter2\np3> ');
    });

    it('strips the first transmission too, at the GA that latches GA mode', () => {
        // cTelnet sets mGA_Driver before it calls gotPrompt, so the block ending
        // in the very first GA is already fixed.
        const { client, out } = makeClient(true);

        client.feedTelnet('\r\nwelcome\r\n' + TELNET_GA);

        expect(out.text).toBe('welcome\n\n');
    });

    it('does not strip a first GA block that continues a partial line', () => {
        // Before GA mode, desktop's mMudData still holds the partial line the
        // earlier read left for the posting timer, so the GA block's newline is
        // not at the front of what it strips from.
        const { client, out } = makeClient(true);

        client.feedTelnet('abc');
        client.feedTelnet('\r\nwelcome\r\n' + TELNET_GA);

        expect(out.text).toBe('abc\nwelcome\n\n');
    });

    it('applies to every GA block, not just the first', () => {
        const { client, out, latchGaDriver } = makeClient(true);
        latchGaDriver();
        out.text = '';

        client.feedTelnet('\r\nfirst block\r\n' + TELNET_GA);
        client.feedTelnet('\r\nsecond block\r\n' + TELNET_GA);

        expect(out.text).toBe('first block\n\nsecond block\n\n');
    });
});
