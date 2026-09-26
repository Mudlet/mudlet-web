// @vitest-environment node
//
// cTelnet::sendData removes every line feed from a command before appending
// the line terminator (mudlet-web#180), so `send("one\ntwo")` reaches the game
// as the one command `onetwo`. Mudlet Web put the LF on the wire, and the game
// read it as two commands.
import { describe, it, expect, vi } from 'vitest';
import { MudSession } from '../../src/mud/MudSession';

describe('MudSession.sendData', () => {
    it('strips line feeds rather than splitting the command', () => {
        const session = new MudSession();
        const sent: string[] = [];
        const client = { send: vi.fn((text: string) => { sent.push(text); }) };
        (session as unknown as { client: unknown }).client = client;
        session.sendData('one\ntwo');
        session.sendData('a\n\nb\n');
        expect(sent).toEqual(['onetwo', 'ab']);
    });
});
