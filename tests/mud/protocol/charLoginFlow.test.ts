import { describe, it, expect } from 'vitest';
import {
    charLoginFailureMessage,
    charLoginTokenRefusedForCleartext,
    decideCharLoginRequest,
    decodeWireBool,
    negotiateCharLoginVersion,
    parseCharLoginDefault,
    parseCharLoginResult,
    parseCharLoginToken,
    parseCharLoginUrl,
    type CharLoginRequestState,
} from '../../../src/mud/protocol/charLoginFlow';

const request = (over: Partial<CharLoginRequestState> = {}): CharLoginRequestState => ({
    methods: ['password-credentials'],
    declined: false,
    attempted: false,
    ...over,
});

describe('decideCharLoginRequest', () => {
    // Mudlet sends the empty reply at once, so the game falls back to its own
    // login prompt; a popup left the server waiting on it (mudlet-web#362).
    it('declines straight away when the server asks and nothing is stored', () => {
        expect(decideCharLoginRequest(request())).toEqual({ kind: 'decline' });
    });

    it('declines when the server sends no method list and nothing is stored', () => {
        expect(decideCharLoginRequest(request({ methods: [] }))).toEqual({ kind: 'decline' });
    });

    it('autofills when the server sends no method list but a login is stored', () => {
        expect(decideCharLoginRequest(request({ methods: [], account: 'rahjiii', password: 'hunter2' })))
            .toEqual({ kind: 'autofill', account: 'rahjiii', password: 'hunter2' });
    });

    it('asks to unlock the vault when the saved login is locked away', () => {
        expect(decideCharLoginRequest(request({ credentialsLocked: true }))).toEqual({ kind: 'unlock' });
    });

    it('declines a method we cannot satisfy', () => {
        expect(decideCharLoginRequest(request({ methods: ['oauth'] }))).toEqual({ kind: 'decline' });
    });

    it('declines once the player has chosen the text login', () => {
        // Must keep answering — the server blocks on the reply — but never
        // reopen the form over the prompts they chose to type into.
        expect(decideCharLoginRequest(request({
            declined: true, account: 'rahjiii', password: 'hunter2',
        }))).toEqual({ kind: 'decline' });
    });

    it('autofills stored credentials on the first ask', () => {
        expect(decideCharLoginRequest(request({ account: 'rahjiii', password: 'hunter2' })))
            .toEqual({ kind: 'autofill', account: 'rahjiii', password: 'hunter2' });
    });

    it('needs both halves to autofill, and declines with half a login', () => {
        expect(decideCharLoginRequest(request({ account: 'rahjiii' }))).toEqual({ kind: 'decline' });
        expect(decideCharLoginRequest(request({ password: 'hunter2' }))).toEqual({ kind: 'decline' });
    });

    // The regression that motivated this file: a server that rejects an attempt
    // re-sends Char.Login.Default. Replaying the credentials it just refused
    // loops silently against every repeat ask instead of letting the player fix
    // them, so the second ask must always reach the popup — whether the first
    // attempt was autofilled or typed by hand (both set `attempted`).
    it('prompts rather than replaying credentials the server already rejected', () => {
        expect(decideCharLoginRequest(request({
            account: 'rahjiii', password: 'wrong', attempted: true,
        }))).toEqual({ kind: 'prompt' });
    });
});

describe('charLoginFailureMessage', () => {
    it("quotes the server's reason", () => {
        expect(charLoginFailureMessage('Invalid credentials'))
            .toBe('Could not log in to the game: Invalid credentials');
    });

    it('falls back to Mudlet\'s generic wording when the server gives none', () => {
        expect(charLoginFailureMessage())
            .toBe('Could not log in to the game, is the login information correct?');
        expect(charLoginFailureMessage('')).toBe(charLoginFailureMessage());
    });
});

describe('decideCharLoginRequest — version 2', () => {
    const v2 = (over: Partial<CharLoginRequestState> = {}): CharLoginRequestState => ({
        version: 2,
        methods: ['password-credentials', 'oauth'],
        declined: false,
        attempted: false,
        secureTransport: true,
        ...over,
    });
    const TOKEN = { account: 'rahj', token: 'tok', provider: 'discord', secureOnly: true };

    it('hands off when nothing is stored, even with a game that takes passwords', () => {
        expect(decideCharLoginRequest(v2())).toEqual({ kind: 'decline' });
    });

    it('never raises the popup, even after a rejected autofill', () => {
        expect(decideCharLoginRequest(v2({ account: 'a', password: 'p', attempted: true })))
            .toEqual({ kind: 'decline' });
    });

    it('lets a saved name and password outrank a saved token', () => {
        expect(decideCharLoginRequest(v2({ account: 'a', password: 'p', signIn: TOKEN })))
            .toEqual({ kind: 'autofill', account: 'a', password: 'p' });
    });

    it('does not autofill a game that does not list password-credentials', () => {
        expect(decideCharLoginRequest(v2({ methods: ['oauth'], account: 'a', password: 'p' })))
            .toEqual({ kind: 'decline' });
    });

    it('replays a saved token — on a password-only game too', () => {
        expect(decideCharLoginRequest(v2({ signIn: TOKEN })))
            .toEqual({ kind: 'reconnect', account: 'rahj', token: 'tok' });
        expect(decideCharLoginRequest(v2({ methods: ['password-credentials'], signIn: TOKEN })))
            .toEqual({ kind: 'reconnect', account: 'rahj', token: 'tok' });
    });

    it('never replays a secure-only token in the clear, and says so', () => {
        const state = v2({ secureTransport: false, signIn: TOKEN });
        expect(decideCharLoginRequest(state)).toEqual({ kind: 'resume', account: 'rahj', provider: 'discord' });
        expect(charLoginTokenRefusedForCleartext(state)).toBe(true);
        // A token with no stated requirement is strict too.
        expect(decideCharLoginRequest(v2({ secureTransport: false, signIn: { account: 'r', token: 't' } })).kind)
            .toBe('decline');
    });

    it('replays a token the server allowed in the clear', () => {
        expect(decideCharLoginRequest(v2({ secureTransport: false, signIn: { ...TOKEN, secureOnly: false } })))
            .toEqual({ kind: 'reconnect', account: 'rahj', token: 'tok' });
    });

    it('resumes the provider after a rejection, and only on a game offering oauth', () => {
        expect(decideCharLoginRequest(v2({ signIn: TOKEN, tokenRejected: true })))
            .toEqual({ kind: 'resume', account: 'rahj', provider: 'discord' });
        expect(decideCharLoginRequest(v2({ methods: ['password-credentials'], signIn: TOKEN, tokenRejected: true })))
            .toEqual({ kind: 'decline' });
        expect(decideCharLoginRequest(v2({ signIn: TOKEN, tokenRejected: true, resumeAttempted: true })))
            .toEqual({ kind: 'decline' });
    });

    it('runs the client-driven flow when available, before handing off', () => {
        expect(decideCharLoginRequest(v2({ clientOAuthAvailable: true }))).toEqual({ kind: 'oauth' });
        expect(decideCharLoginRequest(v2({ methods: ['password-credentials'], clientOAuthAvailable: true })))
            .toEqual({ kind: 'decline' });
    });

    it('opens the vault first when it holds the sign-in', () => {
        expect(decideCharLoginRequest(v2({ credentialsLocked: true }))).toEqual({ kind: 'unlock' });
    });

    it('keeps handing off once the player chose the game\'s own login', () => {
        expect(decideCharLoginRequest(v2({ declined: true, signIn: TOKEN }))).toEqual({ kind: 'decline' });
    });
});

describe('Char.Login wire parsing', () => {
    it('decodes every boolean form the standard permits', () => {
        for (const t of [true, 1, 'true', ' TRUE ', '1']) expect(decodeWireBool(t)).toBe(true);
        for (const f of [false, 0, 'false', '0']) expect(decodeWireBool(f)).toBe(false);
        for (const u of [undefined, null, 2, 'yes', {}, []]) expect(decodeWireBool(u)).toBeUndefined();
    });

    it('negotiates min(client, server), reading strings and rejecting fractions', () => {
        expect(negotiateCharLoginVersion(undefined)).toBe(1);
        expect(negotiateCharLoginVersion(2)).toBe(2);
        expect(negotiateCharLoginVersion('2')).toBe(2);
        expect(negotiateCharLoginVersion(9)).toBe(2);
        expect(negotiateCharLoginVersion(2.5)).toBe(1);
        expect(negotiateCharLoginVersion(0)).toBe(1);
        expect(negotiateCharLoginVersion('two')).toBe(1);
    });

    it('reads nonce_required, falling back to the legacy nonce key', () => {
        const base = { version: 2, type: ['oauth'], location: 'https://id/', client_id: 'c' };
        expect(parseCharLoginDefault({ ...base, nonce_required: 'true' }, true).oauth?.nonceRequired).toBe(true);
        expect(parseCharLoginDefault({ ...base, nonce: true }, true).oauth?.nonceRequired).toBe(true);
        expect(parseCharLoginDefault({ ...base, nonce_required: false, nonce: true }, true).oauth?.nonceRequired).toBe(false);
        expect(parseCharLoginDefault(base, true).oauth?.nonceRequired).toBe(false);
    });

    it('drops malformed method entries', () => {
        expect(parseCharLoginDefault({ type: ['oauth', '', 3, null] }, false).methods).toEqual(['oauth']);
    });

    it('refuses non-http(s) and control-character sign-in links', () => {
        expect(parseCharLoginUrl({ url: 'https://g/x' })).toEqual({ url: 'https://g/x' });
        expect(parseCharLoginUrl({ url: 'data:text/html,hi' })).toBeNull();
        expect(parseCharLoginUrl({ url: 'https://g/\x1b]8;;evil' })).toBeNull();
        expect(parseCharLoginUrl({})).toBeNull();
    });

    it('defaults a token\'s secure_only to the transport it arrived on', () => {
        expect(parseCharLoginToken({ account: 'a', token: 't' }, true)?.secureOnly).toBe(true);
        expect(parseCharLoginToken({ account: 'a', token: 't' }, false)?.secureOnly).toBe(false);
        expect(parseCharLoginToken({ account: 'a', token: 't', secure_only: 0 }, true)?.secureOnly).toBe(false);
        expect(parseCharLoginToken({ account: 'a', token: 't', secure_only: 'maybe' }, true)?.secureOnly).toBe(true);
        expect(parseCharLoginToken({ token: 't' }, true)).toBeNull();
    });

    // Mudlet/Mudlet#10622: an integer 1 read as failure deleted a live token.
    it('reads an integer success as success', () => {
        expect(parseCharLoginResult({ success: 1 })).toEqual({ success: true, message: undefined });
        expect(parseCharLoginResult({ success: 'nope', message: 'm' })).toEqual({ success: false, message: 'm' });
    });
});
