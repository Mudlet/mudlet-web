// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    CharLoginController,
    RECONNECT_RESULT_TIMEOUT_MS,
    SIGN_IN_ATTEMPT_INTERVAL_MS,
    type CharLoginSession,
    type SignInOffer,
} from '../../src/mud/CharLoginController';
import type { OAuthClientFlowOptions } from '../../src/mud/protocol/oauthClientFlow';
import type { VaultSignIn } from '../../src/vault/vaultRecord';
import {
    CHAR_LOGIN_INSECURE_RECONNECT_MESSAGE,
    CHAR_LOGIN_SILENT_DROP_MESSAGE,
    CHAR_LOGIN_TOKEN_EXPIRED_MESSAGE,
    CHAR_LOGIN_TOKEN_SAVED_MESSAGE,
    type CharLoginCapabilities,
} from '../../src/mud/protocol/charLoginFlow';

/** Records every frame the controller would send. */
function fakeSession(secure = true) {
    const sent: unknown[][] = [];
    const session: CharLoginSession & { sent: unknown[][]; reconnects: number } = {
        sent,
        reconnects: 0,
        gameTransportSecure: secure,
        dontReconnect: false,
        sendCharLoginCredentials: (...a) => { sent.push(['credentials', ...a]); },
        sendCharLoginReconnect: (account, token, secureOnly, ts) => {
            if (secureOnly && !session.gameTransportSecure) return false;
            sent.push(['reconnect', account, token, ts]);
            return true;
        },
        sendCharLoginResume: (...a) => { sent.push(['resume', ...a]); },
        sendCharLoginAuthCode: (auth, ts) => {
            if (!session.gameTransportSecure) return false;
            sent.push(['authcode', auth, ts]);
            return true;
        },
        reconnect: () => { session.reconnects++; return true; },
    };
    return session;
}

interface Harness {
    controller: CharLoginController;
    session: ReturnType<typeof fakeSession>;
    vault: { entry?: VaultSignIn; open: boolean; locked: boolean; saves: (VaultSignIn | null)[] };
    stored: { account: string; password: string };
    posts: [string, string][];
    offers: (SignInOffer | null)[];
    ui: Record<string, ReturnType<typeof vi.fn>>;
    timers: { fn: () => void; at: number }[];
    clock: { now: number };
    flows: { opts: OAuthClientFlowOptions; aborted: boolean; done: boolean }[];
    tick(ms: number): void;
}

function harness(opts: { secure?: boolean; vaultOpen?: boolean; redirect?: string | null } = {}): Harness {
    const session = fakeSession(opts.secure ?? true);
    const vault = { entry: undefined as VaultSignIn | undefined, open: opts.vaultOpen ?? true, locked: false, saves: [] as (VaultSignIn | null)[] };
    const stored = { account: '', password: '' };
    const posts: [string, string][] = [];
    const offers: (SignInOffer | null)[] = [];
    const timers: { fn: () => void; at: number }[] = [];
    const clock = { now: 10_000 };
    const flows: Harness['flows'] = [];
    const ui = {
        cancelTextAutoLogin: vi.fn(),
        showPrompt: vi.fn(),
        showPromptError: vi.fn(),
        closePrompt: vi.fn(),
        requestUnlock: vi.fn(),
        suggestVaultSetup: vi.fn(),
        offerSignIn: vi.fn((o: SignInOffer | null) => { offers.push(o); }),
        post: vi.fn((level: string, text: string) => { posts.push([level, text]); }),
    };
    const controller = new CharLoginController({
        session,
        ui,
        readStoredLogin: () => ({ ...stored }),
        oauthRedirectUri: () => (opts.redirect === undefined ? 'https://web.mudlet.org/oauth-callback.html' : opts.redirect),
        vault: {
            needsUnlock: () => vault.locked && !!vault.entry?.token,
            locked: () => vault.locked,
            missing: () => !vault.open,
            signIn: () => (vault.open && !vault.locked ? vault.entry && { ...vault.entry } : undefined),
            hasSignIn: () => !!vault.entry?.token,
            canStore: () => vault.open && !vault.locked,
            save: async (e) => { vault.saves.push(e); vault.entry = e ?? undefined; return vault.open && !vault.locked; },
        },
        createOAuthFlow: (o) => {
            const f = { opts: o, aborted: false, done: false, start: () => {}, abort: () => { f.aborted = true; f.done = true; } };
            flows.push(f);
            return f;
        },
        now: () => clock.now,
        setTimer: (fn, ms) => { const t = { fn, at: clock.now + ms }; timers.push(t); return t; },
        clearTimer: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
    });
    const tick = (ms: number) => {
        clock.now += ms;
        for (const t of [...timers].sort((a, b) => a.at - b.at)) {
            if (t.at <= clock.now && timers.includes(t)) {
                timers.splice(timers.indexOf(t), 1);
                t.fn();
            }
        }
    };
    controller.connected();
    return { controller, session, vault, stored, posts, offers, ui, timers, clock, flows, tick };
}

const v2 = (methods: string[], extra: Partial<CharLoginCapabilities> = {}): CharLoginCapabilities =>
    ({ version: 2, methods, ...extra });
const OAUTH = { location: 'https://id.example/.well-known/openid-configuration', clientId: 'mudlet', scopes: [], nonceRequired: false };
const flush = () => new Promise(r => setTimeout(r, 0));

describe('CharLoginController — version 1 (unchanged behaviour)', () => {
    let h: Harness;
    beforeEach(() => { h = harness({ secure: false }); });

    it('autofills once, then raises the popup on the re-ask', () => {
        h.stored.account = 'rahj';
        h.stored.password = 'pw';
        h.controller.request({ version: 1, methods: ['password-credentials'] });
        expect(h.session.sent).toEqual([['credentials', 'rahj', 'pw', true]]);
        h.controller.result({ success: false, message: 'Bad password' });
        expect(h.ui.showPromptError).toHaveBeenCalledWith('Bad password');
        expect(h.session.dontReconnect).toBe(true);
        h.tick(SIGN_IN_ATTEMPT_INTERVAL_MS);
        h.controller.request({ version: 1, methods: ['password-credentials'] });
        expect(h.ui.showPrompt).toHaveBeenCalled();
        expect(h.session.sent).toHaveLength(1);
    });

    it('reports a silent hang-up on unanswered credentials', () => {
        h.stored.account = 'rahj';
        h.stored.password = 'pw';
        h.controller.request({ version: 1, methods: [] });
        h.controller.disconnected();
        expect(h.posts).toContainEqual(['WARN', CHAR_LOGIN_SILENT_DROP_MESSAGE]);
    });

    it('asks for the vault, then answers once it is open', () => {
        h.vault.locked = true;
        h.vault.entry = { account: 'x', token: 't' };
        h.controller.request({ version: 1, methods: ['password-credentials'] });
        expect(h.ui.requestUnlock).toHaveBeenCalled();
        expect(h.session.sent).toEqual([]);
        h.vault.locked = false;
        h.stored.account = 'rahj';
        h.stored.password = 'pw';
        h.controller.vaultUnlockDone('unlocked');
        expect(h.session.sent).toEqual([['credentials', 'rahj', 'pw', true]]);
    });
});

describe('CharLoginController — version 2', () => {
    it('hands off with token_storage reflecting the vault', () => {
        const open = harness();
        open.controller.request(v2(['password-credentials', 'oauth']));
        expect(open.session.sent).toEqual([['credentials', undefined, undefined, true]]);
        const none = harness({ vaultOpen: false });
        none.controller.request(v2(['oauth']));
        expect(none.session.sent).toEqual([['credentials', undefined, undefined, false]]);
    });

    it('leaves a frame naming no method to the text auto-login', () => {
        const h = harness();
        h.controller.request(v2([]));
        expect(h.session.sent).toEqual([]);
        expect(h.ui.cancelTextAutoLogin).not.toHaveBeenCalled();
    });

    it('folds a burst of asks into one attempt a second', () => {
        const h = harness();
        h.controller.request(v2(['oauth']));
        h.controller.request(v2(['oauth']));
        h.controller.request(v2(['oauth']));
        expect(h.session.sent).toHaveLength(1);
        h.tick(SIGN_IN_ATTEMPT_INTERVAL_MS);
        expect(h.session.sent).toHaveLength(2);
    });

    it('offers a Char.Login.URL as a link, remembering its provider', async () => {
        const h = harness();
        h.controller.request(v2(['oauth']));
        h.controller.url({ url: 'https://game.example/login', provider: 'discord' });
        expect(h.offers.at(-1)).toEqual({ url: 'https://game.example/login', provider: 'discord', flow: 'server' });
        // Mudlet's hand-off wording, without the link (the dialog carries it).
        expect(h.posts.at(-1)).toEqual(['INFO',
            'Opening your browser to sign in with Discord. Complete the login there, then return here.']);
        // The token that follows is saved with that provider and announced once.
        h.controller.token({ account: 'rahj', token: 'tok', secureOnly: true });
        h.controller.token({ account: 'rahj', token: 'tok2', secureOnly: true });
        await flush();
        expect(h.vault.entry).toEqual({ account: 'rahj', token: 'tok2', secureOnly: true, provider: 'discord' });
        expect(h.posts.filter(([, t]) => t === CHAR_LOGIN_TOKEN_SAVED_MESSAGE)).toHaveLength(1);
        h.controller.result({ success: true });
        expect(h.offers.at(-1)).toBeNull();
    });

    describe('closes a Char.Login.URL offer once the game moves past it', () => {
        const offered = () => {
            const h = harness();
            h.controller.request(v2(['oauth']));
            h.controller.url({ url: 'https://game.example/login', provider: 'discord' });
            expect(h.offers.at(-1)).not.toBeNull();
            return h;
        };
        it('on a token', () => {
            const h = offered();
            h.controller.token({ account: 'rahj', token: 'tok', secureOnly: true });
            expect(h.offers.at(-1)).toBeNull();
        });
        it('on a failed result', () => {
            const h = offered();
            h.controller.result({ success: false, message: 'no' });
            expect(h.offers.at(-1)).toBeNull();
        });
        it('on the next Char.Login.Default (StickMUD: sign-in not linked to a character)', () => {
            const h = offered();
            h.tick(SIGN_IN_ATTEMPT_INTERVAL_MS);
            h.controller.request(v2(['oauth']));
            expect(h.offers.at(-1)).toBeNull();
        });
        it('on player input', () => {
            const h = offered();
            h.controller.playerInput();
            expect(h.offers.at(-1)).toBeNull();
        });
        it('but not our own OAuth offer on player input or a re-sent Default', () => {
            const h = harness();
            h.controller.request(v2(['oauth'], { oauth: OAUTH }));
            h.flows[0].opts.onAuthorizationUrl('https://id.example/auth');
            expect(h.offers.at(-1)).toMatchObject({ flow: 'client' });
            h.controller.playerInput();
            h.controller.request(v2(['oauth'], { oauth: OAUTH }));
            expect(h.offers.at(-1)).toMatchObject({ flow: 'client' });
        });
    });

    it('reports an invalid sign-in link without rendering it', () => {
        const h = harness();
        h.controller.url(null);
        expect(h.posts).toEqual([['WARN', 'The game sent an invalid sign-in link; cannot continue.']]);
        expect(h.offers).toEqual([]);
    });

    it('discards a token when there is no open vault, and one from a game that never offered sign-in', async () => {
        const closed = harness({ vaultOpen: false });
        closed.controller.request(v2(['oauth']));
        closed.controller.token({ account: 'a', token: 't', secureOnly: true });
        const unoffered = harness();
        unoffered.controller.token({ account: 'a', token: 't', secureOnly: true });
        await flush();
        expect(closed.vault.saves).toEqual([]);
        expect(unoffered.vault.saves).toEqual([]);
    });

    it('replays a saved token and stays quiet about its rotation', async () => {
        const h = harness();
        h.vault.entry = { account: 'rahj', token: 'old', provider: 'discord', secureOnly: true };
        h.controller.request(v2(['oauth']));
        expect(h.session.sent).toEqual([['reconnect', 'rahj', 'old', true]]);
        h.controller.token({ account: 'rahj', token: 'new', secureOnly: true });
        h.controller.result({ success: true });
        await flush();
        expect(h.vault.entry?.token).toBe('new');
        expect(h.vault.entry?.provider).toBe('discord');
        expect(h.posts.map(([, t]) => t)).not.toContain(CHAR_LOGIN_TOKEN_SAVED_MESSAGE);
    });

    it('turns a rejected token into a resume hint and reconnects to resume', () => {
        const h = harness();
        h.vault.entry = { account: 'rahj', token: 'dead', provider: 'discord', secureOnly: true };
        h.controller.request(v2(['oauth']));
        h.controller.result({ success: false, message: 'expired' });
        expect(h.vault.saves.at(-1)).toEqual({ account: 'rahj', provider: 'discord' });
        expect(h.posts).toContainEqual(['INFO', CHAR_LOGIN_TOKEN_EXPIRED_MESSAGE]);
        h.tick(0);
        expect(h.session.reconnects).toBe(1);
        // The next connection resumes the provider instead of replaying.
        h.controller.disconnected();
        h.controller.connected();
        h.session.sent.length = 0;
        h.controller.request(v2(['oauth']));
        expect(h.session.sent).toEqual([['resume', 'rahj', 'discord', true]]);
    });

    it('falls through to the hand-off when a replayed token goes unanswered', () => {
        const h = harness();
        h.vault.entry = { account: 'rahj', token: 'tok', secureOnly: true };
        h.controller.request(v2(['oauth']));
        h.tick(RECONNECT_RESULT_TIMEOUT_MS);
        expect(h.session.sent).toEqual([['reconnect', 'rahj', 'tok', true], ['credentials', undefined, undefined, true]]);
    });

    it('will not replay a secure-only token in the clear, and says why', () => {
        const h = harness({ secure: false });
        h.vault.entry = { account: 'rahj', token: 'tok', secureOnly: true };
        h.controller.request(v2(['oauth']));
        expect(h.posts).toContainEqual(['WARN', CHAR_LOGIN_INSECURE_RECONNECT_MESSAGE]);
        expect(h.session.sent).toEqual([['credentials', undefined, undefined, true]]);
    });

    it('keeps a sign-in the player forgot mid-session forgotten', async () => {
        const h = harness();
        h.vault.entry = { account: 'rahj', token: 'tok', provider: 'discord', secureOnly: true };
        h.controller.request(v2(['oauth']));
        h.vault.entry = undefined; // "Forget saved sign-in"
        h.controller.token({ account: 'rahj', token: 'rotated', secureOnly: true });
        await flush();
        expect(h.vault.saves).toEqual([]);
    });

    it('does not open a popup when a version 2 login fails', () => {
        const h = harness();
        h.stored.account = 'a';
        h.stored.password = 'p';
        h.controller.request(v2(['password-credentials']));
        h.controller.result({ success: false });
        expect(h.ui.showPromptError).not.toHaveBeenCalled();
        expect(h.posts.at(-1)?.[0]).toBe('WARN');
    });
});

describe('CharLoginController — client-driven OAuth', () => {
    it('runs the flow and sends the captured code', () => {
        const h = harness();
        h.controller.request(v2(['oauth'], { oauth: OAUTH }));
        expect(h.flows).toHaveLength(1);
        expect(h.flows[0].opts.redirectUri).toBe('https://web.mudlet.org/oauth-callback.html');
        expect(h.session.sent).toEqual([]);
        h.flows[0].opts.onAuthorizationUrl('https://id.example/authorize?x');
        expect(h.offers.at(-1)).toEqual({ url: 'https://id.example/authorize?x', flow: 'client' });
        // A re-ask while the player is signing in does not restart the flow.
        h.tick(SIGN_IN_ATTEMPT_INTERVAL_MS);
        h.controller.request(v2(['oauth'], { oauth: OAUTH }));
        expect(h.flows).toHaveLength(1);
        const auth = { code: 'c', codeVerifier: 'v', redirectUri: 'https://web.mudlet.org/oauth-callback.html' };
        h.flows[0].opts.onCaptured(auth);
        expect(h.session.sent).toEqual([['authcode', auth, true]]);
        expect(h.offers.at(-1)).toBeNull();
    });

    it('falls back to the game\'s sign-in when discovery fails', () => {
        const h = harness();
        h.controller.request(v2(['oauth'], { oauth: OAUTH }));
        h.flows[0].opts.onFailed('could not fetch', 'setup');
        expect(h.session.sent).toEqual([['credentials', undefined, undefined, true]]);
        expect(h.session.dontReconnect).toBe(false);
    });

    it('reports a failed sign-in and stops auto-reconnect', () => {
        const h = harness();
        h.controller.request(v2(['oauth'], { oauth: OAUTH }));
        h.flows[0].opts.onFailed('access_denied', 'signin');
        expect(h.session.sent).toEqual([]);
        expect(h.session.dontReconnect).toBe(true);
        expect(h.posts.at(-1)?.[0]).toBe('WARN');
    });

    it('lets the player choose the game\'s own sign-in instead', () => {
        const h = harness();
        h.controller.request(v2(['oauth'], { oauth: OAUTH }));
        h.controller.useGameSignIn();
        expect(h.flows[0].aborted).toBe(true);
        expect(h.session.sent).toEqual([['credentials', undefined, undefined, true]]);
        // A late capture from the aborted flow sends nothing.
        h.flows[0].opts.onCaptured({ code: 'c', codeVerifier: 'v', redirectUri: 'r' });
        expect(h.session.sent).toHaveLength(1);
    });

    it('skips the flow when this page cannot run it', () => {
        const h = harness({ redirect: null });
        h.controller.request(v2(['oauth'], { oauth: OAUTH }));
        expect(h.flows).toEqual([]);
        expect(h.session.sent).toEqual([['credentials', undefined, undefined, true]]);
    });

    it('aborts the flow on disconnect', () => {
        const h = harness();
        h.controller.request(v2(['oauth'], { oauth: OAUTH }));
        h.controller.disconnected();
        expect(h.flows[0].aborted).toBe(true);
    });
});

describe('CharLoginController — a locked vault with nothing saved for this profile', () => {
    it('asks to open it before answering, then tells the game it can keep a token', () => {
        const h = harness();
        h.vault.locked = true;
        h.controller.request(v2(['oauth']));
        expect(h.ui.requestUnlock).toHaveBeenCalledWith('store');
        expect(h.session.sent).toEqual([]);
        h.vault.locked = false;
        h.controller.vaultUnlockDone('unlocked');
        expect(h.session.sent).toEqual([['credentials', undefined, undefined, true]]);
    });

    it('signs in without saving on "Not now", and does not ask again this visit', () => {
        const h = harness();
        h.vault.locked = true;
        h.controller.request(v2(['oauth']));
        h.controller.vaultUnlockDone('closed');
        expect(h.session.sent).toEqual([['credentials', undefined, undefined, false]]);
        h.controller.disconnected();
        h.controller.connected();
        h.tick(SIGN_IN_ATTEMPT_INTERVAL_MS);
        h.controller.request(v2(['oauth']));
        expect(h.ui.requestUnlock).toHaveBeenCalledTimes(1);
        expect(h.session.sent).toHaveLength(2);
    });

    it('does not ask when there is no vault at all', () => {
        const h = harness({ vaultOpen: false });
        h.controller.request(v2(['oauth']));
        expect(h.ui.requestUnlock).not.toHaveBeenCalled();
        expect(h.session.sent).toEqual([['credentials', undefined, undefined, false]]);
    });
});

describe('CharLoginController — no vault set up', () => {
    it('says once a visit where to set one up', () => {
        const h = harness({ vaultOpen: false });
        h.controller.request(v2(['oauth']));
        expect(h.ui.suggestVaultSetup).toHaveBeenCalledTimes(1);
        h.controller.disconnected();
        h.controller.connected();
        h.tick(SIGN_IN_ATTEMPT_INTERVAL_MS);
        h.controller.request(v2(['oauth']));
        expect(h.ui.suggestVaultSetup).toHaveBeenCalledTimes(1);
    });

    it('stays quiet on a version 1 game, a game naming no method, or with a vault', () => {
        const v1 = harness({ vaultOpen: false });
        v1.controller.request({ version: 1, methods: ['password-credentials'] });
        const none = harness({ vaultOpen: false });
        none.controller.request(v2([]));
        const open = harness();
        open.controller.request(v2(['oauth']));
        for (const h of [v1, none, open]) {
            expect(h.ui.suggestVaultSetup).not.toHaveBeenCalled();
        }
    });
});
