// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logOutboundBytes } from '../../../src/mud/connection/telnetDebug';
import { GMCP_COMMAND_CODE, GMCP_IAC, GMCP_SB, GMCP_SE } from '../../../src/mud/protocol/constants';

/**
 * A debug log gets pasted into bug reports, so the `Char.Login` messages that
 * carry a secret must never print their bodies — the password, the bearer token
 * that signs in without one, and the authorization code + PKCE verifier that
 * would let anyone redeem the code.
 */
describe('logOutboundBytes redaction', () => {
    let logged: string[];
    let store: Record<string, string>;

    beforeEach(() => {
        logged = [];
        store = { 'mudix.debugTelnet': '1' };
        (globalThis as Record<string, unknown>).localStorage = {
            getItem: (k: string) => store[k] ?? null,
        };
        vi.spyOn(console, 'debug').mockImplementation((...args: unknown[]) => {
            logged.push(args.map(String).join(' '));
        });
    });
    afterEach(() => {
        vi.restoreAllMocks();
        delete (globalThis as Record<string, unknown>).localStorage;
    });

    const gmcp = (body: string) =>
        GMCP_IAC + GMCP_SB + String.fromCharCode(GMCP_COMMAND_CODE) + body + GMCP_IAC + GMCP_SE;

    it.each([
        ['Char.Login.Credentials {"account":"rahjiii","password":"hunter2"}', 'hunter2'],
        ['Char.Login.Reconnect {"account":"rahjiii","token":"tok-abc","version":2}', 'tok-abc'],
        ['Char.Login.AuthCode {"code":"c0de","code_verifier":"v3rif1er"}', 'v3rif1er'],
    ])('redacts %s', (body, secret) => {
        logOutboundBytes(gmcp(body));
        const out = logged.join('\n');
        expect(out).toContain('<redacted>');
        expect(out).not.toContain(secret);
    });

    it('still logs the bodies of ordinary GMCP messages', () => {
        logOutboundBytes(gmcp('Core.Supports.Set [ "Char.Login 2" ]'));
        expect(logged.join('\n')).toContain('Char.Login 2');
    });

    it('matches the module name case-insensitively', () => {
        // GMCP module casing varies between servers, and nothing stops a script
        // from framing the message itself.
        logOutboundBytes(gmcp('CHAR.LOGIN.RECONNECT {"token":"tok-abc"}'));
        expect(logged.join('\n')).not.toContain('tok-abc');
    });
});
