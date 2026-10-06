import { describe, it, expect } from 'vitest';
import {
    charLoginFailureMessage,
    decideCharLoginRequest,
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
