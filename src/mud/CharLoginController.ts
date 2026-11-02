/**
 * GMCP `Char.Login` sign-in, versions 1 and 2, for one profile's session.
 *
 * Port of Mudlet's `GMCPAuthenticator` (development branch): it reads the
 * game's `Char.Login.Default`, decides how to answer (see `charLoginFlow`),
 * replays and stores password-less reconnect tokens, offers `Char.Login.URL`
 * sign-in pages, and runs the client-driven OAuth flow (`oauthClientFlow`).
 * React stays out of it — `ProfileSession` supplies the UI through
 * {@link CharLoginUi} and forwards the session's events.
 *
 * Where it differs from desktop, and why:
 *
 * - **No browser launch.** Mudlet opens the system browser itself when it has
 *   evidence the player wants to sign in. A browser blocks a tab opened outside
 *   a user gesture, so every sign-in page becomes a button (and a console link)
 *   the player clicks.
 * - **Storage is the credential vault.** Mudlet writes tokens to the OS
 *   keychain. Ours go into the vault, encrypted, and nowhere else: with no
 *   vault, or a locked one, `token_storage` says false and an arriving token
 *   is dropped, as the standard requires of a client that said so.
 * - **One session per profile.** Mudlet's rotated-token retry and rejected-token
 *   fingerprint exist because two desktop instances can share one keychain
 *   entry. A profile here is held by one tab at a time (per-profile Web Locks),
 *   so a rejected token is simply dead.
 * - **A version 1 popup.** Mudlet Web raises `CharLoginModal` when a version 1
 *   game rejects a saved password; Mudlet does not. Version 2 never opens it.
 */

import type { VaultSignIn } from '../vault/vaultRecord';
import {
    CHAR_LOGIN_AUTHCODE_INSECURE_MESSAGE,
    CHAR_LOGIN_INSECURE_RECONNECT_MESSAGE,
    CHAR_LOGIN_INVALID_URL_MESSAGE,
    CHAR_LOGIN_OAUTH_FAILED_MESSAGE,
    CHAR_LOGIN_SILENT_DROP_MESSAGE,
    CHAR_LOGIN_TOKEN_EXPIRED_MESSAGE,
    CHAR_LOGIN_TOKEN_SAVED_MESSAGE,
    CHAR_LOGIN_TOKEN_SAVE_FAILED_MESSAGE,
    charLoginFailureMessage,
    charLoginResumeMessage,
    charLoginSignInLinkMessage,
    charLoginTokenRefusedForCleartext,
    decideCharLoginRequest,
    type CharLoginAction,
    type CharLoginCapabilities,
    type CharLoginRequestState,
    type CharLoginResult,
    type CharLoginToken,
    type CharLoginUrl,
} from './protocol/charLoginFlow';
import {
    OAuthClientFlow,
    type OAuthAuthorization,
    type OAuthClientFlowOptions,
    type OAuthFailureStage,
} from './protocol/oauthClientFlow';

/** A sign-in page waiting for the player to open it. */
export interface SignInOffer {
    url: string;
    provider?: string;
    /** `server`: a `Char.Login.URL` — the game finishes the sign-in itself.
     *  `client`: our own OAuth flow, which is waiting for the redirect. */
    flow: 'server' | 'client';
}

/** The session operations the controller drives (a `MudSession` satisfies it). */
export interface CharLoginSession {
    sendCharLoginCredentials(account?: string, password?: string, tokenStorage?: boolean): void;
    sendCharLoginReconnect(account: string, token: string, secureOnly: boolean, tokenStorage?: boolean): boolean;
    sendCharLoginResume(account: string, provider: string, tokenStorage?: boolean): void;
    sendCharLoginAuthCode(auth: OAuthAuthorization, tokenStorage?: boolean): boolean;
    readonly gameTransportSecure: boolean;
    dontReconnect: boolean;
    reconnect(): boolean;
}

/** Where saved sign-ins live — the credential vault, via `vaultAccess`. */
export interface CharLoginVault {
    /** A saved password or token for this profile sits in a locked vault. */
    needsUnlock(): boolean;
    /** The saved sign-in, when there is one and the vault is open. */
    signIn(): VaultSignIn | undefined;
    /** Whether the vault holds a token for this profile — answerable locked. */
    hasSignIn(): boolean;
    /** Whether a token handed to us now would be kept (`token_storage`). */
    canStore(): boolean;
    save(entry: VaultSignIn | null): Promise<boolean>;
}

/** What the controller needs from the UI. */
export interface CharLoginUi {
    /** Text auto-login (Mudlet's login timers) — GMCP takes the login over. */
    cancelTextAutoLogin(): void;
    /** Raise the version 1 credentials popup, keeping one already up. */
    showPrompt(): void;
    /** Show a rejected attempt's reason in the popup (raising it if needed). */
    showPromptError(message: string): void;
    closePrompt(): void;
    /** Ask to unlock the vault; answer with {@link CharLoginController.vaultUnlockDone}. */
    requestUnlock(): void;
    /** Show (or with null, withdraw) a sign-in page for the player to open. */
    offerSignIn(offer: SignInOffer | null): void;
    /** A console notice in Mudlet's house style. */
    post(level: 'INFO' | 'WARN', text: string): void;
}

export interface CharLoginControllerOptions {
    session: CharLoginSession;
    vault: CharLoginVault;
    ui: CharLoginUi;
    /** The player's saved account + password (`utils/storedCredentials`). */
    readStoredLogin(): { account: string; password: string };
    /** The client-driven OAuth redirect URI, or null when this page cannot run
     *  the flow at all (no WebCrypto, no BroadcastChannel). */
    oauthRedirectUri(): string | null;
    /** Seams for tests. */
    createOAuthFlow?: (opts: OAuthClientFlowOptions) => Pick<OAuthClientFlow, 'start' | 'abort' | 'done'>;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

/** A server can pack many `Char.Login.Default` frames into one burst, and each
 *  attempt reads the vault and may send a frame. One attempt a second, the
 *  burst folded into one — Mudlet's `scmSignInAttemptInterval`. */
export const SIGN_IN_ATTEMPT_INTERVAL_MS = 1000;
/** How long a replayed token waits for the `Char.Login.Result` that answers it
 *  before the game is treated as one that ignores `Char.Login.Reconnect` —
 *  Mudlet's `scmReconnectResultTimeout`. */
export const RECONNECT_RESULT_TIMEOUT_MS = 15_000;

export class CharLoginController {
    // ── per socket (reset on connect) ────────────────────────────────────
    /** Credentials have been sent once this connection. */
    private attempted = false;
    /** The player chose "Use text login". */
    private declined = false;
    /** The player dismissed the vault unlock prompt this connection. */
    private vaultDeclined = false;
    /** A Char.Login request is parked behind the vault unlock prompt. */
    private vaultPending = false;
    /** Credentials went out and the game has said nothing since. */
    private unanswered = false;
    /** Any `Char.Login.Default` this connection named a way to sign in. A token
     *  arriving without one is ignored: nothing would replay it. */
    private signInOffered = false;
    private reconnectAttempted = false;
    private resumeAttempted = false;
    private oauthAttempted = false;
    /** The last capabilities the game advertised, for re-deciding after an
     *  unlock or a deadline. */
    private caps: CharLoginCapabilities | null = null;
    /** The account the player last handed over, for the retry popup. */
    lastLoginAttempt: { account: string; save: boolean } | null = null;

    // ── per sign-in attempt (Mudlet's PerConnectionState) ─────────────────
    private awaitingReconnectResult = false;
    /** This connection is running on a token it replayed, so a token arriving
     *  now is a silent rotation rather than a first save worth announcing. */
    private reconnectingWithToken = false;
    /** The provider this account signs in with — from the stored entry or this
     *  connection's `Char.Login.URL`. Saved with the token. */
    private accountProvider = '';
    private reconnectAccount = '';

    // ── across connections ───────────────────────────────────────────────
    /** A token was rejected: the next attempt reads the store but does not
     *  replay. Consumed by that attempt. Mudlet's `mReconnectRejected`. */
    private tokenRejected = false;
    /** Bumped on every connect, disconnect and sign-in attempt, so async work
     *  that started under an older one stops. */
    private generation = 0;
    private announcedSaveFor = -1;

    private lastAttemptAt: number | null = null;
    private pendingAttempt: unknown = null;
    private reconnectDeadline: unknown = null;
    private oauthFlow: Pick<OAuthClientFlow, 'start' | 'abort' | 'done'> | null = null;
    private offerShown = false;
    private offerFlow: SignInOffer['flow'] | null = null;

    private readonly now: () => number;
    private readonly setTimer: (fn: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;

    constructor(private readonly opts: CharLoginControllerOptions) {
        this.now = opts.now ?? (() => Date.now());
        this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    }

    // ── session lifecycle ────────────────────────────────────────────────

    /** The game link came up: a fresh connection signs in from scratch. */
    connected(): void {
        this.resetSocket();
    }

    /** The connection went. If credentials are still unanswered, this drop *is*
     *  the game's answer — say so before the popup goes (measured on Achaea). */
    disconnected(): void {
        if (this.unanswered) {
            this.unanswered = false;
            this.opts.ui.post('WARN', CHAR_LOGIN_SILENT_DROP_MESSAGE);
        }
        this.opts.ui.closePrompt();
        this.resetSocket();
    }

    /** The player pressed Disconnect: hanging up on ourselves is not the game
     *  refusing the login. */
    userDisconnecting(): void {
        this.unanswered = false;
    }

    /** Any server output: the game is still talking, so whatever happens later
     *  is not a silent hang-up on the login. */
    serverOutput(): void {
        this.unanswered = false;
    }

    dispose(): void {
        this.resetSocket();
    }

    private resetSocket(): void {
        this.generation++;
        this.cancelOAuthFlow();
        this.withdrawOffer();
        this.clearPendingAttempt();
        this.clearReconnectDeadline();
        this.attempted = false;
        this.declined = false;
        this.vaultDeclined = false;
        this.vaultPending = false;
        this.unanswered = false;
        this.signInOffered = false;
        this.reconnectAttempted = false;
        this.resumeAttempted = false;
        this.oauthAttempted = false;
        this.caps = null;
        this.lastLoginAttempt = null;
        this.lastAttemptAt = null;
        this.resetAttempt();
    }

    private resetAttempt(): void {
        this.awaitingReconnectResult = false;
        this.reconnectingWithToken = false;
        this.accountProvider = '';
        this.reconnectAccount = '';
    }

    // ── Char.Login.Default ───────────────────────────────────────────────

    request(caps: CharLoginCapabilities): void {
        // A version 2 frame naming no way to sign in can only be answered with
        // the hand-off, which would cancel the text auto-login — the only way
        // such a game signs in. Leave it alone, and drop an attempt a burst
        // already armed with the previous frame's capabilities. Version 1 keeps
        // answering `{}` frames: servers in the wild send exactly that and
        // expect the password exchange.
        if (caps.version >= 2 && caps.methods.length === 0) {
            this.clearPendingAttempt();
            return;
        }
        this.caps = caps;
        this.signInOffered = true;
        // The game moved to its next step, so a page it linked earlier is
        // finished with (StickMUD asks for a character name next).
        this.withdrawServerOffer();
        // A browser sign-in the player may be halfway through answers this ask
        // already; restarting it would invalidate the page they have open.
        // (StickMUD re-sends Default once per menu step.)
        if (this.oauthFlow && !this.oauthFlow.done) return;
        this.scheduleAttempt();
    }

    private scheduleAttempt(): void {
        if (this.pendingAttempt !== null) return;
        const now = this.now();
        const since = this.lastAttemptAt === null ? Infinity : now - this.lastAttemptAt;
        if (since >= SIGN_IN_ATTEMPT_INTERVAL_MS) {
            this.lastAttemptAt = now;
            this.attempt();
            return;
        }
        const generation = this.generation;
        this.pendingAttempt = this.setTimer(() => {
            this.pendingAttempt = null;
            if (generation !== this.generation) return;
            this.lastAttemptAt = this.now();
            this.attempt();
        }, SIGN_IN_ATTEMPT_INTERVAL_MS - since);
    }

    private clearPendingAttempt(): void {
        if (this.pendingAttempt !== null) {
            this.clearTimer(this.pendingAttempt);
            this.pendingAttempt = null;
        }
    }

    private requestState(): CharLoginRequestState {
        const caps = this.caps ?? { version: 1, methods: [] };
        const stored = this.opts.readStoredLogin();
        const redirectUri = caps.oauth ? this.opts.oauthRedirectUri() : null;
        return {
            version: caps.version,
            methods: caps.methods,
            declined: this.declined,
            attempted: this.attempted,
            account: stored.account,
            password: stored.password,
            credentialsLocked: !this.vaultDeclined && this.opts.vault.needsUnlock(),
            signIn: caps.version >= 2 ? this.opts.vault.signIn() : undefined,
            secureTransport: this.opts.session.gameTransportSecure,
            tokenRejected: this.tokenRejected,
            reconnectAttempted: this.reconnectAttempted,
            resumeAttempted: this.resumeAttempted,
            clientOAuthAvailable: !!caps.oauth && !this.oauthAttempted && redirectUri !== null,
        };
    }

    /** Mudlet's `attemptReconnect` → `readStoredSignIn` → `selectAuthMethod`. */
    private attempt(): void {
        this.generation++;
        this.resetAttempt();
        this.opts.ui.cancelTextAutoLogin();
        const state = this.requestState();
        // The rejection latch lasts exactly one attempt.
        this.tokenRejected = false;
        if (charLoginTokenRefusedForCleartext(state)) {
            this.opts.ui.post('WARN', CHAR_LOGIN_INSECURE_RECONNECT_MESSAGE);
        }
        this.execute(decideCharLoginRequest(state), state);
    }

    private get tokenStorage(): boolean {
        return this.opts.vault.canStore();
    }

    private execute(action: CharLoginAction, state: CharLoginRequestState): void {
        const { session, ui } = this.opts;
        switch (action.kind) {
            case 'decline':
                session.sendCharLoginCredentials(undefined, undefined, this.tokenStorage);
                return;
            case 'autofill':
                this.attempted = true;
                // Saved credentials just went out, so a retry form opens with
                // the save box still ticked.
                this.lastLoginAttempt = { account: action.account, save: true };
                this.unanswered = true;
                session.sendCharLoginCredentials(action.account, action.password, this.tokenStorage);
                return;
            case 'reconnect': {
                this.reconnectAttempted = true;
                const signIn = state.signIn!;
                if (!session.sendCharLoginReconnect(action.account, action.token, signIn.secureOnly ?? true, this.tokenStorage)) {
                    // Refused at send time — the transport changed underneath.
                    // Fall through to whatever comes after the token.
                    this.execute(decideCharLoginRequest({ ...state, reconnectAttempted: true }), state);
                    return;
                }
                this.reconnectingWithToken = true;
                this.accountProvider = signIn.provider ?? '';
                this.reconnectAccount = action.account;
                this.awaitingReconnectResult = true;
                this.armReconnectDeadline();
                return;
            }
            case 'resume':
                this.resumeAttempted = true;
                this.accountProvider = action.provider;
                session.sendCharLoginResume(action.account, action.provider, this.tokenStorage);
                ui.post('INFO', charLoginResumeMessage(action.provider));
                return;
            case 'oauth':
                this.oauthAttempted = true;
                this.startOAuthFlow();
                return;
            case 'prompt':
                ui.showPrompt();
                return;
            case 'unlock':
                // Safe to ask now rather than at connect: the server blocks
                // until we answer, so there is no race to lose.
                this.vaultPending = true;
                ui.requestUnlock();
                return;
        }
    }

    /** The vault unlock prompt closed. When a request was parked behind it,
     *  answer it now — the game withholds its own prompt until we reply. */
    vaultUnlockDone(result: 'created' | 'unlocked' | 'closed'): void {
        if (result === 'closed') this.vaultDeclined = true;
        if (!this.vaultPending) return;
        this.vaultPending = false;
        this.attempt();
    }

    // ── version 1 popup ──────────────────────────────────────────────────

    /** The player submitted the credentials popup. */
    promptSubmitted(account: string, password: string, save: boolean): void {
        // This connection's one automatic attempt is spent: a re-ask after
        // this must raise the form again rather than replay what just failed.
        this.attempted = true;
        this.lastLoginAttempt = { account, save };
        this.unanswered = true;
        this.opts.session.sendCharLoginCredentials(account, password, this.tokenStorage);
    }

    /** The player chose "Use text login". */
    promptDeclined(): void {
        this.declined = true;
        this.opts.session.sendCharLoginCredentials(undefined, undefined, this.tokenStorage);
    }

    // ── Char.Login.Result ────────────────────────────────────────────────

    result(result: CharLoginResult): void {
        this.unanswered = false;
        // Any answer ends a sign-in page the game linked: it has decided.
        this.withdrawServerOffer();
        if (this.awaitingReconnectResult) {
            this.awaitingReconnectResult = false;
            this.clearReconnectDeadline();
            if (result.success) return;
            this.tokenRejected_();
            return;
        }
        if (result.success) {
            this.opts.ui.closePrompt();
            this.withdrawOffer();
            return;
        }
        // Report it in the output too: a server that rejects a login commonly
        // drops the connection straight after, which tears any popup down, and
        // a game doing GMCP login withholds its own text — so this is often the
        // only trace of the failure.
        this.opts.ui.post('WARN', charLoginFailureMessage(result.message));
        // Mudlet raises mDontReconnect on a failed login: auto-reconnect would
        // otherwise redial and re-offer the same refused credentials.
        this.opts.session.dontReconnect = true;
        if (this.declined || (this.caps?.version ?? 1) >= 2) return;
        this.opts.ui.showPromptError(result.message || 'Login failed.');
    }

    /** A replayed token was refused. Drop it — keeping the account and
     *  provider as a resume hint so the next sign-in needs no provider menu —
     *  and reconnect so the player signs in on a fresh, stable connection:
     *  servers commonly hang up right after rejecting one. */
    private tokenRejected_(): void {
        this.tokenRejected = true;
        const account = this.reconnectAccount;
        const provider = this.accountProvider;
        // A sign-in the player forgot while this one was in flight stays
        // forgotten: rewriting it as a hint would put back what they removed.
        if (this.opts.vault.hasSignIn()) {
            const hint: VaultSignIn | null = account && provider ? { account, provider } : null;
            void this.opts.vault.save(hint);
        }
        this.opts.ui.post('INFO', CHAR_LOGIN_TOKEN_EXPIRED_MESSAGE);
        const generation = this.generation;
        this.setTimer(() => {
            if (generation === this.generation) this.opts.session.reconnect();
        }, 0);
    }

    private armReconnectDeadline(): void {
        this.clearReconnectDeadline();
        const generation = this.generation;
        this.reconnectDeadline = this.setTimer(() => {
            this.reconnectDeadline = null;
            if (generation !== this.generation || !this.awaitingReconnectResult) return;
            this.awaitingReconnectResult = false;
            console.warn(`GMCP Char.Login: the game did not answer the replayed sign-in token within ${RECONNECT_RESULT_TIMEOUT_MS}ms, `
                + 'so it is being treated as a game that does not support Char.Login.Reconnect; falling through to the sign-in hand-off.');
            const state = { ...this.requestState(), reconnectAttempted: true };
            this.execute(decideCharLoginRequest(state), state);
        }, RECONNECT_RESULT_TIMEOUT_MS);
    }

    private clearReconnectDeadline(): void {
        if (this.reconnectDeadline !== null) {
            this.clearTimer(this.reconnectDeadline);
            this.reconnectDeadline = null;
        }
    }

    // ── Char.Login.URL ───────────────────────────────────────────────────

    url(link: CharLoginUrl | null): void {
        if (!link) {
            this.opts.ui.post('WARN', CHAR_LOGIN_INVALID_URL_MESSAGE);
            return;
        }
        if (link.provider) this.accountProvider = link.provider;
        // Every browser sign-in is where a connection stops running on the
        // token it replayed: a token from this sign-in is a first save.
        this.reconnectingWithToken = false;
        this.offer({ url: link.url, provider: link.provider, flow: 'server' });
    }

    private offer(offer: SignInOffer): void {
        this.offerShown = true;
        this.offerFlow = offer.flow;
        this.opts.ui.post('INFO', charLoginSignInLinkMessage(offer.provider));
        this.opts.ui.offerSignIn(offer);
    }

    private withdrawOffer(): void {
        if (!this.offerShown) return;
        this.offerShown = false;
        this.opts.ui.offerSignIn(null);
    }

    /** Close a `Char.Login.URL` offer once the game has moved past it. The
     *  game only says the page is done by what it does next — a token, a
     *  result, its next `Default` — and some (StickMUD, for a sign-in not yet
     *  linked to a character) send nothing but text. Our own OAuth offer has
     *  its own ending (captured / failed) and is left alone. */
    private withdrawServerOffer(): void {
        if (this.offerFlow === 'server') this.withdrawOffer();
    }

    /** The player sent a command. A game waiting on a browser sign-in takes
     *  input as "cancel" or as the next answer, so its page is done with. */
    playerInput(): void {
        this.withdrawServerOffer();
    }

    // ── Char.Login.Token ─────────────────────────────────────────────────

    token(t: CharLoginToken): void {
        if (!this.signInOffered) {
            console.warn('GMCP Char.Login.Token ignored: this connection\'s Char.Login.Default named no way to sign in, so no saved token could be replayed.');
            return;
        }
        // A token means the browser sign-in finished.
        this.withdrawServerOffer();
        const { vault, session, ui } = this.opts;
        // A rotation of a token this connection replayed, after the player
        // forgot that sign-in, belongs to the sign-in they discarded.
        if (this.reconnectingWithToken && !vault.hasSignIn()) return;
        if (!vault.canStore()) {
            // We told the game token_storage false (or the vault has locked
            // since), and a client that did must discard what arrives.
            console.info('GMCP Char.Login.Token discarded: there is no open credential vault to keep it in.');
            return;
        }
        const stored = this.opts.readStoredLogin();
        const savedCredentialsOutrank = !!stored.account && !!stored.password
            && !!this.caps?.methods.includes('password-credentials');
        // A rotation is not a new opt-in; a token this connection could not
        // replay would make the promise false as it is made; and while a saved
        // password signs in ahead of it, the promise would repeat every time.
        const worthAnnouncing = !this.reconnectingWithToken
            && !(t.secureOnly && !session.gameTransportSecure)
            && !savedCredentialsOutrank;
        const attempt = this.generation;
        const entry: VaultSignIn = {
            account: t.account,
            token: t.token,
            secureOnly: t.secureOnly,
            ...(this.accountProvider ? { provider: this.accountProvider } : {}),
        };
        void vault.save(entry).then((ok) => {
            if (!ok) {
                ui.post('WARN', CHAR_LOGIN_TOKEN_SAVE_FAILED_MESSAGE);
                return;
            }
            if (!worthAnnouncing || this.announcedSaveFor === attempt) return;
            this.announcedSaveFor = attempt;
            ui.post('INFO', CHAR_LOGIN_TOKEN_SAVED_MESSAGE);
        });
    }

    // ── client-driven OAuth ──────────────────────────────────────────────

    private startOAuthFlow(): void {
        this.cancelOAuthFlow();
        const oauth = this.caps?.oauth;
        const redirectUri = this.opts.oauthRedirectUri();
        if (!oauth || !redirectUri) {
            this.handOff();
            return;
        }
        const create = this.opts.createOAuthFlow ?? ((o: OAuthClientFlowOptions) => new OAuthClientFlow(o));
        // Every callback checks it still belongs to the live flow: an aborted
        // one (a reconnect, the player's "use the game's sign-in") says nothing.
        const flow = create({
            discoveryUrl: oauth.location,
            clientId: oauth.clientId,
            scopes: oauth.scopes,
            nonceRequired: oauth.nonceRequired,
            redirectUri,
            onAuthorizationUrl: (url) => {
                if (this.oauthFlow !== flow) return;
                this.offer({ url, flow: 'client' });
            },
            onCaptured: (auth) => {
                if (this.oauthFlow !== flow) return;
                this.oauthFlow = null;
                this.withdrawOffer();
                this.sendAuthCode(auth);
            },
            onFailed: (detail, stage) => {
                if (this.oauthFlow !== flow) return;
                this.oauthFlow = null;
                this.oauthFailed(detail, stage);
            },
        });
        this.oauthFlow = flow;
        flow.start();
    }

    private sendAuthCode(auth: OAuthAuthorization): void {
        const { session, ui } = this.opts;
        this.reconnectingWithToken = false;
        if (!session.sendCharLoginAuthCode(auth, this.tokenStorage)) {
            session.dontReconnect = true;
            ui.post('WARN', CHAR_LOGIN_AUTHCODE_INSECURE_MESSAGE);
        }
    }

    private oauthFailed(detail: string, stage: OAuthFailureStage): void {
        console.warn('GMCP Char.Login client-driven OAuth failed:', detail);
        this.withdrawOffer();
        if (stage === 'setup') {
            // Nothing reached the player yet — typically a provider whose
            // discovery document a browser may not read (no CORS). The game is
            // still waiting, and its own sign-in works without us: hand off.
            this.handOff();
            return;
        }
        this.opts.session.dontReconnect = true;
        this.opts.ui.post('WARN', CHAR_LOGIN_OAUTH_FAILED_MESSAGE);
    }

    /** The player chose the game's own sign-in over our browser flow. */
    useGameSignIn(): void {
        if (!this.oauthFlow) return;
        this.cancelOAuthFlow();
        this.withdrawOffer();
        this.handOff();
    }

    /** The player dismissed a server-driven sign-in offer. The console link
     *  stays; nothing is sent. */
    dismissOffer(): void {
        this.offerShown = false;
    }

    private handOff(): void {
        this.opts.session.sendCharLoginCredentials(undefined, undefined, this.tokenStorage);
    }

    private cancelOAuthFlow(): void {
        if (this.oauthFlow) {
            const flow = this.oauthFlow;
            this.oauthFlow = null;
            flow.abort();
        }
    }
}
