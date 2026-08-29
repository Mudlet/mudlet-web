import { describe, it, expect } from 'vitest';
import {
    CHAR_LOGIN_CLIENT_VERSION,
    charLoginFailureMessage,
    charLoginProviderName,
    charLoginResumeMessage,
    charLoginSignInLinkMessage,
    charLoginTokenRefusedForCleartext,
    decideCharLoginRequest,
    negotiateCharLoginVersion,
    parseCharLoginDefault,
    parseCharLoginUrl,
    type CharLoginRequestState,
} from '../../../src/mud/protocol/charLoginFlow';

const request = (over: Partial<CharLoginRequestState> = {}): CharLoginRequestState => ({
    methods: ['password-credentials'],
    declined: false,
    attempted: false,
    ...over,
});

/** A version 2 ask. `version` is the only thing separating the two ladders, so
 *  every v2 case states it explicitly. */
const v2 = (over: Partial<CharLoginRequestState> = {}): CharLoginRequestState =>
    request({ version: 2, ...over });

describe('decideCharLoginRequest — version 1', () => {
    it('prompts when the server asks and nothing is stored', () => {
        expect(decideCharLoginRequest(request())).toEqual({ kind: 'prompt' });
    });

    it('prompts when the server sends no method list at all', () => {
        expect(decideCharLoginRequest(request({ methods: [] }))).toEqual({ kind: 'prompt' });
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

    it('needs both halves to autofill', () => {
        expect(decideCharLoginRequest(request({ account: 'rahjiii' }))).toEqual({ kind: 'prompt' });
        expect(decideCharLoginRequest(request({ password: 'hunter2' }))).toEqual({ kind: 'prompt' });
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

    // Pinning the whole v1 surface: every profile in the wild is on a v1 or
    // no-Char.Login server, so the version 2 work must not move any of it. An
    // explicit `version: 1` and an absent one have to agree, since the parser
    // reports 1 for a server that sent no version field.
    it('reads an absent version exactly as version 1', () => {
        const cases: Partial<CharLoginRequestState>[] = [
            {},
            { methods: [] },
            { methods: ['oauth'] },
            { account: 'rahjiii', password: 'hunter2' },
            { account: 'rahjiii', password: 'hunter2', attempted: true },
            { account: 'rahjiii', password: 'hunter2', declined: true },
            { account: 'rahjiii' },
        ];
        for (const over of cases) {
            expect(decideCharLoginRequest(request(over)))
                .toEqual(decideCharLoginRequest(request({ ...over, version: 1 })));
        }
    });
});

describe('decideCharLoginRequest — version 2', () => {
    it('autofills a complete stored pair when the game takes passwords', () => {
        // Typed credentials name the exact character the player wants, so they
        // outrank anything the game would offer on its own screen.
        expect(decideCharLoginRequest(v2({ account: 'rahjiii', password: 'hunter2' })))
            .toEqual({ kind: 'autofill', account: 'rahjiii', password: 'hunter2' });
    });

    it('hands off instead of raising our popup when nothing is stored', () => {
        // The game owns the interactive sign-in screen on version 2. The popup
        // is a version 1 affordance and must never appear here.
        expect(decideCharLoginRequest(v2())).toEqual({ kind: 'decline' });
    });

    it('hands off on an oauth-only game rather than declining for want of a form', () => {
        // Same bytes as version 1's decline, opposite intent: this is what
        // *starts* the browser sign-in, and the Char.Login.URL answers it.
        expect(decideCharLoginRequest(v2({ methods: ['oauth'] }))).toEqual({ kind: 'decline' });
    });

    it('a stored password loses to nothing and still reaches the hand-off', () => {
        // A saved password the game will not take must not block the player
        // from reaching a provider choice.
        expect(decideCharLoginRequest(v2({
            methods: ['oauth'], account: 'rahjiii', password: 'hunter2',
        }))).toEqual({ kind: 'decline' });
    });

    it('treats an empty method list as "no passwords", unlike version 1', () => {
        // Version 2 lists its methods; silence is not consent. Version 1
        // servers really do send Char.Login.Default {} and expect the password
        // exchange, which is why the two differ here.
        expect(decideCharLoginRequest(v2({ methods: [], account: 'a', password: 'b' })))
            .toEqual({ kind: 'decline' });
        expect(decideCharLoginRequest(request({ methods: [], account: 'a', password: 'b' })))
            .toEqual({ kind: 'autofill', account: 'a', password: 'b' });
    });

    it('falls to the hand-off rather than replaying rejected credentials', () => {
        // Where version 1 reaches its popup, version 2 reaches the game's own
        // sign-in screen — which is where the player can fix a wrong password.
        expect(decideCharLoginRequest(v2({
            account: 'rahjiii', password: 'wrong', attempted: true,
        }))).toEqual({ kind: 'decline' });
    });

    it('still honours the player choosing the text login', () => {
        expect(decideCharLoginRequest(v2({
            declined: true, account: 'rahjiii', password: 'hunter2',
        }))).toEqual({ kind: 'decline' });
    });
});

/** A v2 oauth game with a saved sign-in, over an encrypted game-facing link. */
const saved = (over: Partial<CharLoginRequestState> = {}): CharLoginRequestState => v2({
    methods: ['oauth'],
    token: 'tok-abc',
    tokenAccount: 'rahjiii',
    provider: 'discord',
    secureTransport: true,
    ...over,
});

describe('decideCharLoginRequest — reconnect tokens', () => {
    it('replays a saved token', () => {
        expect(decideCharLoginRequest(saved()))
            .toEqual({ kind: 'reconnect', account: 'rahjiii', token: 'tok-abc' });
    });

    it('refuses to replay a token over a cleartext game transport', () => {
        // The gate is connectionSecureTransport's answer, not "is the WebSocket
        // wss:": in proxy mode a wss:// proxy URL only secures the browser↔proxy
        // hop, and the proxy↔game leg is plaintext telnet without `tls`. A token
        // replayed there hands the account to anyone on the path.
        const state = saved({ secureTransport: false });
        expect(decideCharLoginRequest(state))
            .toEqual({ kind: 'resume', account: 'rahjiii', provider: 'discord' });
        expect(charLoginTokenRefusedForCleartext(state)).toBe(true);
        expect(charLoginTokenRefusedForCleartext(saved())).toBe(false);
    });

    it('does not warn about encryption where no token would have been replayed', () => {
        // A stored token on a v1 server, or on a game not offering oauth, was
        // never going to be sent — saying "not using your saved sign-in because
        // this connection is not encrypted" there would be a lie.
        expect(charLoginTokenRefusedForCleartext(saved({
            secureTransport: false, version: 1, methods: ['password-credentials'],
        }))).toBe(false);
        expect(charLoginTokenRefusedForCleartext(saved({
            secureTransport: false, methods: ['password-credentials'],
        }))).toBe(false);
        expect(charLoginTokenRefusedForCleartext(saved({
            secureTransport: false, tokenRejected: true,
        }))).toBe(false);
    });

    it('falls all the way to the hand-off when there is no provider either', () => {
        expect(decideCharLoginRequest(saved({ secureTransport: false, provider: undefined })))
            .toEqual({ kind: 'decline' });
    });

    it('needs both halves of the stored entry to replay', () => {
        expect(decideCharLoginRequest(saved({ token: undefined })))
            .toEqual({ kind: 'resume', account: 'rahjiii', provider: 'discord' });
        expect(decideCharLoginRequest(saved({ tokenAccount: undefined })))
            .toEqual({ kind: 'decline' });
    });

    it('resumes rather than replaying once a token was rejected', () => {
        // The stored entry has just been rewritten into a token-less resume
        // hint; replaying anything here risks looping into another rejection.
        // The player still skips the provider menu.
        expect(decideCharLoginRequest(saved({ tokenRejected: true })))
            .toEqual({ kind: 'resume', account: 'rahjiii', provider: 'discord' });
    });

    it('recovers a rejected token even on a game not offering oauth', () => {
        // Mudlet's rung 1 reads the store before every other test, because the
        // point of that pass is to finish the sign-in the rejection interrupted.
        expect(decideCharLoginRequest(saved({
            tokenRejected: true, methods: ['password-credentials'],
        }))).toEqual({ kind: 'resume', account: 'rahjiii', provider: 'discord' });
    });

    it('replays a token at most once per connection', () => {
        expect(decideCharLoginRequest(saved({ reconnectAttempted: true })))
            .toEqual({ kind: 'resume', account: 'rahjiii', provider: 'discord' });
    });

    it('lets typed credentials outrank a saved token', () => {
        // A token names whatever account last signed in; a typed pair names the
        // exact character the player wants to play.
        expect(decideCharLoginRequest(saved({
            methods: ['password-credentials', 'oauth'],
            account: 'rahjiii:Alaric',
            password: 'hunter2',
        }))).toEqual({ kind: 'autofill', account: 'rahjiii:Alaric', password: 'hunter2' });
    });

    it('stops outranking once those credentials have been rejected', () => {
        // `attempted` means the pair was already tried and refused, so it is no
        // longer the player's live choice and the token gets its turn.
        expect(decideCharLoginRequest(saved({
            methods: ['password-credentials', 'oauth'],
            account: 'rahjiii:Alaric',
            password: 'wrong',
            attempted: true,
        }))).toEqual({ kind: 'reconnect', account: 'rahjiii', token: 'tok-abc' });
    });

    it('never reaches a token on a version 1 server', () => {
        // Every profile in the wild is on one of these; the v1 ladder must not
        // learn a new move.
        expect(decideCharLoginRequest(saved({ version: 1, methods: ['password-credentials'] })))
            .toEqual({ kind: 'prompt' });
    });
});

describe('negotiateCharLoginVersion', () => {
    it('reads an absent or unusable version as 1', () => {
        expect(negotiateCharLoginVersion(undefined)).toBe(1);
        expect(negotiateCharLoginVersion(null)).toBe(1);
        expect(negotiateCharLoginVersion('2')).toBe(1);
        expect(negotiateCharLoginVersion(NaN)).toBe(1);
        expect(negotiateCharLoginVersion(0)).toBe(1);
        expect(negotiateCharLoginVersion(-3)).toBe(1);
    });

    it('takes the version a v2 server reports', () => {
        expect(negotiateCharLoginVersion(2)).toBe(2);
    });

    it('clamps a newer server down rather than reading it as 1', () => {
        // min(client, server): a version 5 server still speaks version 2 to us.
        expect(negotiateCharLoginVersion(5)).toBe(CHAR_LOGIN_CLIENT_VERSION);
    });
});

describe('parseCharLoginDefault', () => {
    it('reads the version and method list', () => {
        expect(parseCharLoginDefault({ version: 2, type: ['password-credentials', 'oauth'] }, false))
            .toEqual({ version: 2, methods: ['password-credentials', 'oauth'] });
    });

    it('drops malformed method entries so they cannot masquerade as methods', () => {
        expect(parseCharLoginDefault({ type: ['oauth', '', 7, null] }, false).methods)
            .toEqual(['oauth']);
    });

    it('survives a payload that is not an object', () => {
        for (const value of [null, undefined, 'nope', 42, ['oauth']]) {
            expect(parseCharLoginDefault(value, false)).toEqual({ version: 1, methods: [] });
        }
    });

    it('reads the client-driven OAuth fields only on an encrypted transport', () => {
        const payload = {
            version: 2,
            type: ['oauth'],
            location: 'https://game.example/.well-known/openid-configuration',
            client_id: 'game-client',
            scopes: ['openid', ''],
            nonce: true,
        };
        // Char.Login.AuthCode carries the authorization code and PKCE verifier
        // together; on cleartext they are dropped and the server-driven flow is
        // used instead.
        expect(parseCharLoginDefault(payload, false).oauth).toBeUndefined();
        expect(parseCharLoginDefault(payload, true).oauth).toEqual({
            location: 'https://game.example/.well-known/openid-configuration',
            clientId: 'game-client',
            scopes: ['openid'],
            nonceRequired: true,
        });
    });

    it('needs both location and client_id to report the capability', () => {
        expect(parseCharLoginDefault({ version: 2, location: 'https://g.example' }, true).oauth)
            .toBeUndefined();
        expect(parseCharLoginDefault({ version: 2, client_id: 'x' }, true).oauth)
            .toBeUndefined();
    });
});

describe('parseCharLoginUrl', () => {
    it('accepts an http(s) sign-in page and lowercases the provider', () => {
        expect(parseCharLoginUrl({ url: 'https://game.example/signin?t=abc', provider: 'Discord' }))
            .toEqual({ url: 'https://game.example/signin?t=abc', provider: 'discord' });
        expect(parseCharLoginUrl({ url: 'http://game.example/signin' }))
            .toEqual({ url: 'http://game.example/signin' });
    });

    it('refuses any scheme but http(s)', () => {
        // The address arrives unauthenticated over the wire.
        for (const url of [
            'javascript:alert(1)',
            'file:///etc/passwd',
            'data:text/html,<script>alert(1)</script>',
            'ftp://game.example/signin',
            'send:look',
            'not a url',
            '',
        ]) {
            expect(parseCharLoginUrl({ url })).toBeNull();
        }
    });

    it('refuses an address carrying control characters', () => {
        // An ESC would close the OSC 8 sequence we render it into early and let
        // the game paint arbitrary ANSI through what should be one link.
        expect(parseCharLoginUrl({ url: 'https://game.example/\u001b[31m' })).toBeNull();
        expect(parseCharLoginUrl({ url: 'https://game.example/\u0007bell' })).toBeNull();
        expect(parseCharLoginUrl({ url: 'https://game.example/\u007f' })).toBeNull();
    });

    it('refuses a payload with no url at all', () => {
        expect(parseCharLoginUrl({})).toBeNull();
        expect(parseCharLoginUrl({ url: 42 })).toBeNull();
        expect(parseCharLoginUrl(null)).toBeNull();
    });
});

describe('charLoginProviderName', () => {
    it("uses the provider's own branding", () => {
        expect(charLoginProviderName('github')).toBe('GitHub');
        expect(charLoginProviderName('discord')).toBe('Discord');
        expect(charLoginProviderName('x')).toBe('X');
    });

    it('capitalises a provider we have never heard of', () => {
        expect(charLoginProviderName('achaea')).toBe('Achaea');
    });

    it('is empty when the game named no provider', () => {
        expect(charLoginProviderName(undefined)).toBe('');
        expect(charLoginProviderName('')).toBe('');
    });
});

describe('charLoginSignInLinkMessage', () => {
    it('names the provider when the game gave one', () => {
        expect(charLoginSignInLinkMessage('https://g.example/in', 'discord'))
            .toBe('To sign in with Discord, open this link in your browser: https://g.example/in');
    });

    it('falls back to Mudlet\'s unbranded wording', () => {
        expect(charLoginSignInLinkMessage('https://g.example/in'))
            .toBe('To sign in, open this link in your browser: https://g.example/in');
    });
});

describe('charLoginResumeMessage', () => {
    it('names the provider being resumed', () => {
        expect(charLoginResumeMessage('github'))
            .toBe('Resuming your GitHub sign-in with the game.');
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
