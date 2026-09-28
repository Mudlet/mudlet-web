import { describe, it, expect } from 'vitest';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import { MSP_WILL } from '../../../src/mud/protocol/constants';
import type { MudClientEvents } from '../../../src/mud/events';
import type { MspCommand } from '../../../src/mud/protocol/msp';

// Issues #185 / #239: Mudlet never parses MSP out of game text — it is reached
// only via `IAC SB MSP` and `receiveMSP()`. An in-band `!!SOUND(...)` stays in
// the line, negotiated or not, which is what the usual trigger + receiveMSP +
// deleteLine recipe needs.
function makeClient() {
    const bus = new EventBus<MudClientEvents>();
    const client = new MudClient({ url: 'ws://test.invalid', mspEnabled: true }, bus);
    const lines: string[] = [];
    const commands: MspCommand[] = [];
    bus.on('flushLines', (groups) => {
        for (const g of groups) lines.push(g.text);
    });
    bus.on('msp', (cmd) => commands.push(cmd));
    return { client, lines, commands };
}

describe('in-band MSP tags', () => {
    it('are left in the line while MSP has not been negotiated', () => {
        const { client, lines, commands } = makeClient();
        client.feedTelnet('X1 hello !!SOUND(short.wav) world\r\n');
        expect(lines).toEqual(['X1 hello !!SOUND(short.wav) world\n']);
        expect(commands).toEqual([]);
    });

    it('are still left in the line once the server has agreed to MSP', () => {
        const { client, lines, commands } = makeClient();
        client.feedTelnet(MSP_WILL);
        expect(client.isMspNegotiated()).toBe(true);
        client.feedTelnet('X1 hello !!SOUND(short.wav) world\r\n');
        expect(lines.filter(l => l.trim())).toEqual(['X1 hello !!SOUND(short.wav) world\n']);
        expect(commands).toEqual([]);
    });

    it('are dispatched when they arrive as an MSP subnegotiation', () => {
        const { client, commands } = makeClient();
        client.feedTelnet(MSP_WILL);
        client.feedTelnet('\xFF\xFA\x5A!!SOUND(short.wav)\xFF\xF0');
        expect(commands.map(c => c.file)).toEqual(['short.wav']);
    });
});
