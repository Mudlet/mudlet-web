// @vitest-environment node
//
// Mudlet/mudlet-web#351 item 1. A Lua string that is not valid UTF-8 — a script
// saved in Latin-1, text built with string.char(>127) — reached send/echo/cecho
// through emscripten's UTF8ToString, which on a short string trusted every lead
// byte: "x\128yzw" went out as one four-byte character with yzw gone. Desktop
// reads it with QString::fromUtf8: each bad byte or sequence becomes U+FFFD and
// the text after it is kept. The expected bytes are desktop's.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { SessionCodec } from '../../src/mud/protocol/charset';

const hex = (s: string) => [...s].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');

describe('#351 item 1: invalid UTF-8 in a Lua string', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => env.dispose());

    const CASES: Array<[string, string]> = [
        ['x\\128yzw', '78efbfbd797a77'],
        ['x\\255yzw', '78efbfbd797a77'],
        ['x\\192\\175yzw', '78efbfbdefbfbd797a77'],
        ['\\233t\\233', 'efbfbd74efbfbd'],
    ];

    it.each(CASES)('send("%s") puts desktop\'s bytes on the wire', (lua, wire) => {
        const sent = vi.spyOn(env.session, 'sendData').mockImplementation(() => {});
        env.run(`send("${lua}", false)`);
        expect(sent).toHaveBeenCalledTimes(1);
        const text = sent.mock.calls[0][0];
        expect(hex(new SessionCodec().encodeOutgoing(text))).toBe(wire);
    });

    it.each(CASES)('echo and cecho of "%s" keep the text after the bad bytes', (lua, wire) => {
        const expected = new TextDecoder().decode(Uint8Array.from(wire.match(/../g)!.map(b => parseInt(b, 16))));
        env.run(`echo("${lua}\\n")`);
        env.run(`cecho("<red>${lua}\\n")`);
        expect(env.mainOutput.slice(-2)).toEqual([expected, expected]);
    });

    it('reads a long string the same way as a short one', () => {
        const sent = vi.spyOn(env.session, 'sendData').mockImplementation(() => {});
        env.run(`send(string.rep("a", 40) .. "\\128yzw", false)`);
        expect(sent.mock.calls[0][0]).toBe('a'.repeat(40) + '�yzw');
    });

    it('leaves valid text alone', () => {
        const sent = vi.spyOn(env.session, 'sendData').mockImplementation(() => {});
        env.run('send("zażółć 中文 😀", false)');
        expect(sent.mock.calls[0][0]).toBe('zażółć 中文 😀');
    });
});
