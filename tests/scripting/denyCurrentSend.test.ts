// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

/**
 * denyCurrentSend() denies the command a sysDataSendRequest handler is vetting,
 * and only that one (cTelnet::sendData).
 *
 * Outside a handler there is no such command: desktop answers nil and a message
 * and stops nothing, so a deny raised from a key binding, a timer or an alias
 * that sent nothing can no longer lie in wait and swallow whatever command comes
 * next. A send a handler makes is vetted on its own, so its deny stays with it.
 */
describe('denyCurrentSend', () => {
    let t: TestRuntime;
    let sent: string[];

    beforeEach(async () => {
        t = await createTestRuntime();
        sent = [];
        // createTestRuntime builds no ScriptingEngine, so the API sits on the
        // null host, whose dispatchSendRequest never denies anything. Wire the
        // one method under test to the real runtime — the same call the engine
        // forwards — and leave the rest of the null host alone.
        t.api.setHost({ ...t.api.engineHost, dispatchSendRequest: (text: string) => t.rt.dispatchSendRequest(text) });
        // The session has no client, so watch the layer below instead: what
        // reaches session.sendData — the far side of the deny gate, past the
        // echo and the command separator split — is what would have gone on the
        // wire.
        const session = t.session as unknown as { sendData: (text: string) => void };
        const original = session.sendData.bind(t.session);
        session.sendData = (text: string) => { sent.push(text); original(text); };
    });
    afterEach(() => t.dispose());

    it('answers nil and a message outside a handler, and stops nothing', () => {
        expect(t.run('local ok, err = denyCurrentSend(); return ok == nil and err:find("sysDataSendRequest") ~= nil'))
            .toBe(true);
        t.run('send("allowed", false)');
        expect(sent).toEqual(['allowed']);
    });

    it('returns nothing inside a handler', () => {
        t.run(`__n = -1; __h = registerAnonymousEventHandler("sysDataSendRequest", function()
            __n = select('#', denyCurrentSend())
        end)`);
        t.run('send("x", false)');
        t.run('killAnonymousEventHandler(__h)');
        expect(t.run('return __n')).toBe(0);
        expect(sent).toEqual([]);
    });

    it('keeps a deny with the send it was raised for when a handler sends another', () => {
        t.run(`__h = registerAnonymousEventHandler("sysDataSendRequest", function(_, text)
            if text == "outer" then
                denyCurrentSend()
                send("inner", false)
            end
        end)`);
        t.run('send("outer", false)');
        t.run('killAnonymousEventHandler(__h)');
        expect(sent).toEqual(['inner']);
    });

    it('still works from inside a sysDataSendRequest handler', () => {
        t.run(`__h = registerAnonymousEventHandler("sysDataSendRequest", function(_, text)
            if text == "nope" then denyCurrentSend() end
        end)`);
        t.run('send("nope", false)');
        t.run('send("fine", false)');
        t.run('killAnonymousEventHandler(__h)');
        expect(sent).toEqual(['fine']);
    });
});

/**
 * Mudlet warns — once per encoding — when a command cannot be represented in the
 * server encoding, and sends it anyway (cTelnet::sendData). The warning is the
 * only sign a player gets that what they typed will not arrive intact.
 */
describe('unencodable command warning', () => {
    let t: TestRuntime;
    beforeEach(async () => {
        t = await createTestRuntime();
        // Same wiring as above — the last case here turns on a deny actually
        // taking effect.
        t.api.setHost({ ...t.api.engineHost, dispatchSendRequest: (text: string) => t.rt.dispatchSendRequest(text) });
    });
    afterEach(() => t.dispose());

    const warnings = () => t.mainOutput.filter(l => l.includes('unlikely to understand'));

    it('warns once per encoding, naming the command', () => {
        expect(t.run('return setServerEncoding("ISO 8859-1")')).toBe(true);
        t.run('send("wake ląka", false)');
        expect(warnings()).toHaveLength(1);
        expect(warnings()[0]).toContain('wake ląka');

        // Same encoding, still unencodable: no second warning.
        t.run('send("another ą", false)');
        expect(warnings()).toHaveLength(1);

        // A new encoding is a new question, so the notice is armed again.
        expect(t.run('return setServerEncoding("ISO 8859-2")')).toBe(true);
        t.run('send("nadal 一", false)');
        expect(warnings()).toHaveLength(2);
    });

    it('says nothing when the encoding can carry the command', () => {
        t.run('setServerEncoding("ISO 8859-2")');
        t.run('send("ląka", false)');
        expect(warnings()).toHaveLength(0);
    });

    it('says nothing about a command that was denied — it never went anywhere', () => {
        t.run('setServerEncoding("ISO 8859-1")');
        t.run('__h = registerAnonymousEventHandler("sysDataSendRequest", function() denyCurrentSend() end)');
        t.run('send("wake ląka", false)');
        t.run('killAnonymousEventHandler(__h)');
        expect(warnings()).toHaveLength(0);
    });
});
