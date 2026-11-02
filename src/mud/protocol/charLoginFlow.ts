/**
 * GMCP `Char.Login` flow decisions.
 *
 * The server sends `Char.Login.Default` to ask for credentials and then waits,
 * withholding its text login prompt until the client answers. Answering is
 * therefore mandatory — every path here ends in a reply (the hand-off when
 * there is nothing to send), or a popup, vault unlock or browser sign-in that
 * will produce one. `Char.Login.Result` reports the outcome, and a server that
 * rejects an attempt commonly re-sends `Char.Login.Default` to ask again, so
 * these rules run repeatedly within one connection.
 *
 * Two protocol versions are in play, and they want different things from us:
 *
 * - **Version 1** is a password exchange. We autofill a saved login once, and
 *   raise `CharLoginModal` when the game rejects it, so the player can correct
 *   it. That is what every version 1 profile in the wild is talking to.
 * - **Version 2** adds browser sign-in (Google, Discord, or the game's own
 *   account system) and password-less reconnect tokens. There the game owns the
 *   interactive sign-in screen and we automate *around* it — Mudlet's design is
 *   explicit that the client does not render a pop-up of its own — so on
 *   version 2 the modal never opens: we replay a token, resume a provider,
 *   autofill a stored pair, run the client-driven OAuth flow, or hand off.
 *
 * Mirrors Mudlet's `GMCPAuthenticator` (development branch,
 * GMCPAuthenticator.{h,cpp}). Kept free of React and session plumbing so the
 * rules can be tested directly; `CharLoginController` supplies the state.
 */

/** The highest `Char.Login` version this client implements — what
 *  `Core.Supports.Set` advertises and the ceiling every negotiation is clamped
 *  to. */
export const CHAR_LOGIN_CLIENT_VERSION = 2;

// ── Wire decoding ─────────────────────────────────────────────────────────

/**
 * Decode a field the standard declares boolean, in every form it permits: a
 * JSON boolean, the strings `"true"`/`"false"`/`"1"`/`"0"` (case-insensitive,
 * whitespace ignored), or the numbers 1/0. Several MUD drivers have no JSON
 * boolean at all — LDMud's `json_serialize()` among them, and StickMUD sends
 * `"true"` — which is why the string and number forms exist.
 *
 * Anything else is `undefined`, *not* false, so the caller applies that field's
 * own default: the defaults here are true or "the transport the token arrived
 * on", never a flat false, so collapsing the two would answer a
 * security-bearing question wrong. Mudlet's `decodeWireBool`.
 */
export function decodeWireBool(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (value === 1) return true;
        if (value === 0) return false;
        return undefined;
    }
    if (typeof value === 'string') {
        const text = value.trim().toLowerCase();
        if (text === 'true' || text === '1') return true;
        if (text === 'false' || text === '0') return false;
    }
    return undefined;
}

/**
 * Clamp the version a server reported in `Char.Login.Default` to what we
 * implement: the negotiated version is `min(client, server)`.
 *
 * Absent, unreadable, fractional or non-positive all mean 1 — a version 1
 * server sends no field at all. The string form is read too: a driver with no
 * JSON number sends `"2"`, and read as a number that answered a version 2
 * server as version 1 for the whole session. A value *above* what we implement
 * is clamped down, not read as 1. Mirrors `saveSupportsSet`.
 */
export function negotiateCharLoginVersion(reported: unknown): number {
    let v: number;
    if (typeof reported === 'number') v = reported;
    else if (typeof reported === 'string' && /^\s*-?\d+\s*$/.test(reported)) v = Number(reported.trim());
    else return 1;
    if (!Number.isInteger(v) || v < 1) return 1;
    return Math.min(v, CHAR_LOGIN_CLIENT_VERSION);
}

/** The client-driven OAuth capability a version 2 server advertises when it is
 *  itself an OpenID Provider. */
export interface CharLoginOAuthCapability {
    /** The OpenID Connect discovery document's URL (the `location` field). */
    location: string;
    clientId: string;
    /** Requested scopes; the flow defaults an empty list to `["openid"]`. */
    scopes: string[];
    /** The authorization request must carry a `nonce` the server can check the
     *  ID token against. */
    nonceRequired: boolean;
}

/** Everything `Char.Login.Default` told us, normalised. */
export interface CharLoginCapabilities {
    /** Negotiated version — see {@link negotiateCharLoginVersion}. */
    version: number;
    /** The `type` list, malformed entries dropped. Empty when the server sent none. */
    methods: string[];
    /** Present only on an encrypted game-facing transport, and only when the
     *  server sent both `location` and `client_id`. */
    oauth?: CharLoginOAuthCapability;
}

function asObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function stringList(value: unknown): string[] {
    // A non-string or empty entry would otherwise masquerade as a real method
    // and slip past the `includes` guards.
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string' && t !== '') : [];
}

/**
 * Read a `Char.Login.Default` payload into capabilities.
 *
 * `secureTransport` is whether the link to the *game* is encrypted, not "is the
 * WebSocket wss:" — in proxy mode a `wss://` proxy URL only secures the
 * browser↔proxy hop. The client-driven OAuth fields are read only when it is:
 * the `Char.Login.AuthCode` that completes that flow carries the authorization
 * code and the PKCE verifier together and must never travel in the clear, so on
 * cleartext they are dropped and the sign-in silently uses the server-driven
 * flow instead — Mudlet's `saveSupportsSet`.
 *
 * The standard's field is `nonce_required`. Mudlet read a plain `nonce` until
 * Mudlet/Mudlet#10623; the old key is still honoured when the standard's is
 * absent, so a server written against that keeps working.
 */
export function parseCharLoginDefault(value: unknown, secureTransport: boolean): CharLoginCapabilities {
    const obj = asObject(value);
    const caps: CharLoginCapabilities = {
        version: negotiateCharLoginVersion(obj.version),
        methods: stringList(obj.type),
    };
    if (secureTransport) {
        const location = typeof obj.location === 'string' ? obj.location.trim() : '';
        const clientId = typeof obj.client_id === 'string' ? obj.client_id : '';
        if (location && clientId) {
            const declared = decodeWireBool(obj.nonce_required);
            const nonceRequired = declared ?? decodeWireBool(obj.nonce) ?? false;
            if (declared === undefined && obj.nonce_required !== undefined) {
                console.warn('GMCP Char.Login.Default: a \'nonce_required\' value that is not a boolean in any form '
                    + 'the standard permits is being ignored. The sign-in request will carry no nonce.');
            }
            caps.oauth = { location, clientId, scopes: stringList(obj.scopes), nonceRequired };
        }
    }
    return caps;
}

/** A validated `Char.Login.URL`. */
export interface CharLoginUrl {
    url: string;
    /** Lowercase provider id (`discord`, `google`, …) when the server named one. */
    provider?: string;
}

/**
 * Validate a `Char.Login.URL` payload.
 *
 * The address arrives unauthenticated over the wire, so only `http`/`https`
 * survive — never `javascript:`, `file:`, `data:` or any other scheme handler,
 * whether we would open it or merely render it as a link. Control characters
 * are refused outright: the address is rendered into the console inside an
 * OSC 8 sequence, where an ESC would close it early and let the game paint
 * arbitrary ANSI through what is supposed to be one link. Returns null for
 * anything unusable, including a missing or unparseable `url`.
 */
export function parseCharLoginUrl(value: unknown): CharLoginUrl | null {
    const obj = asObject(value);
    const raw = typeof obj.url === 'string' ? obj.url.trim() : '';
    if (!raw) return null;
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1F\x7F]/.test(raw)) return null;
    let scheme: string;
    try {
        scheme = new URL(raw).protocol.toLowerCase();
    } catch {
        return null;
    }
    if (scheme !== 'http:' && scheme !== 'https:') return null;
    const provider = typeof obj.provider === 'string' && obj.provider.trim()
        ? obj.provider.trim().toLowerCase()
        : undefined;
    return provider ? { url: raw, provider } : { url: raw };
}

/** A parsed `Char.Login.Token`. */
export interface CharLoginToken {
    account: string;
    token: string;
    /** Whether the token may only ever be replayed over an encrypted transport. */
    secureOnly: boolean;
}

/**
 * Read a `Char.Login.Token` payload. Null when the account or token is missing.
 *
 * `secure_only` absent — or in a form that is not a boolean at all — means the
 * token inherits the transport it arrived on: one minted over TLS is
 * encrypted-only, one minted in the clear may be replayed either way. A server
 * that mints over TLS but accepts replays in the clear has to say so with an
 * explicit false, so where a token has protection to lose, silence keeps it.
 * Mudlet's `handleAuthToken`.
 *
 * Never logs the payload: it is a bearer secret.
 */
export function parseCharLoginToken(value: unknown, secureTransport: boolean): CharLoginToken | null {
    const obj = asObject(value);
    const account = typeof obj.account === 'string' ? obj.account : '';
    const token = typeof obj.token === 'string' ? obj.token : '';
    if (!account || !token) return null;
    const declared = decodeWireBool(obj.secure_only);
    if (declared === undefined && obj.secure_only !== undefined) {
        console.warn('GMCP Char.Login.Token: a \'secure_only\' value that is not a boolean in any form the '
            + 'standard permits is being ignored; the token is stored as replayable only '
            + (secureTransport ? 'over an encrypted connection' : 'as this unencrypted connection allows')
            + ', inherited from the transport it arrived on.');
    }
    return { account, token, secureOnly: declared ?? secureTransport };
}

/** A parsed `Char.Login.Result`. */
export interface CharLoginResult {
    success: boolean;
    message?: string;
}

/**
 * Read a `Char.Login.Result`. `success` decodes like every other declared
 * boolean — reading only `true`/`"true"` made an integer 1 a failure, and a
 * failed reconnect deletes a token the server had just accepted
 * (Mudlet/Mudlet#10622). Absent or undecodable reads as failure.
 */
export function parseCharLoginResult(value: unknown): CharLoginResult {
    const obj = asObject(value);
    const success = decodeWireBool(obj.success);
    if (success === undefined && obj.success !== undefined) {
        console.warn('GMCP Char.Login.Result: a \'success\' value that is not a boolean in any form the '
            + 'standard permits; treating the attempt as failed.');
    }
    return {
        success: success ?? false,
        message: typeof obj.message === 'string' ? obj.message : undefined,
    };
}

// ── Deciding how to answer Char.Login.Default ─────────────────────────────

/** What to do about a `Char.Login.Default` request. */
export type CharLoginAction =
    /**
     * Hand the sign-in to the game: version 1's empty `{}` ("no credentials,
     * use your next method" — the player's *Use text login*), or version 2's
     * deliberate "run your own sign-in screen", which carries the common fields
     * but no account. Mudlet sends it even when the profile has a stored
     * password the game will not take, so a saved password never blocks the
     * player from reaching a provider choice.
     */
    | { kind: 'decline' }
    /** Send stored credentials without troubling the player. */
    | { kind: 'autofill'; account: string; password: string }
    /** Replay the saved password-less token — `Char.Login.Reconnect`. */
    | { kind: 'reconnect'; account: string; token: string }
    /**
     * Ask the game to restart this provider's browser sign-in — the *resume*
     * form of `Char.Login.Credentials`, `{account, provider}`. The absence of a
     * password, not the presence of `provider`, makes it a resume.
     */
    | { kind: 'resume'; account: string; provider: string }
    /** Run the client-driven OAuth flow (discovery, PKCE, redirect capture). */
    | { kind: 'oauth' }
    /** Raise the credentials popup. Version 1 only. */
    | { kind: 'prompt' }
    /**
     * Ask to unlock the vault. `read`: it holds this profile's saved login or
     * sign-in. `store`: it holds nothing for this profile yet, but only an open
     * vault lets the game hand over a token to keep (`token_storage`).
     */
    | { kind: 'unlock'; reason: 'read' | 'store' };

/** A saved sign-in as the decision sees it — the vault's `VaultSignIn`. */
export interface StoredSignInView {
    account: string;
    provider?: string;
    token?: string;
    secureOnly?: boolean;
}

export interface CharLoginRequestState {
    /** Negotiated `Char.Login` version. Absent reads as 1. */
    version?: number;
    /** The `type` list from `Char.Login.Default`; empty when the server sent none. */
    methods: string[];
    /** The player chose "Use text login" earlier this connection. */
    declined: boolean;
    /** Credentials have already been sent once this connection (stored or typed). */
    attempted: boolean;
    /** Stored/in-memory credentials, if any. */
    account?: string;
    password?: string;
    /** A saved password or sign-in exists but sits in a locked vault, so it
     *  can't be read yet. Mudlet Web only — desktop has no vault to unlock. */
    credentialsLocked?: boolean;
    /** A vault exists but is locked, and holds nothing for this profile — so
     *  the game would be told `token_storage: false`. False once the player
     *  said "Not now". Mudlet Web only. */
    storageLocked?: boolean;
    /** The saved version 2 sign-in, if the vault holds one and is open. */
    signIn?: StoredSignInView;
    /** Whether the link to the *game* is encrypted. */
    secureTransport?: boolean;
    /** A token was rejected earlier: read the store, but do not replay a token
     *  this once. Mudlet's `mReconnectRejected` latch. */
    tokenRejected?: boolean;
    /** A token has already been replayed this connection. */
    reconnectAttempted?: boolean;
    /** A provider resume has already been sent this connection. */
    resumeAttempted?: boolean;
    /** The client-driven OAuth flow can run: the server advertised it over an
     *  encrypted link, and it has not already been tried this connection. */
    clientOAuthAvailable?: boolean;
}

/** Whether the game will accept `Char.Login.Credentials {account, password}`.
 *  Version 1 servers in the wild send `Char.Login.Default {}` and expect the
 *  password exchange, so silence means yes there. Version 2 lists its methods —
 *  that is what the list is for — so silence means no. */
function acceptsPasswordCredentials(state: CharLoginRequestState): boolean {
    if ((state.version ?? 1) >= 2) return state.methods.includes('password-credentials');
    return state.methods.length === 0 || state.methods.includes('password-credentials');
}

/**
 * Decide how to answer a `Char.Login.Default`.
 *
 * Version 1's one automatic attempt per connection is the load-bearing rule: it
 * makes a saved login silent when it works, and guarantees that a *wrong* saved
 * login turns into a visible popup instead of a silent send-reject-send loop
 * against the server's repeated asks.
 */
export function decideCharLoginRequest(state: CharLoginRequestState): CharLoginAction {
    // The player already opted into logging in by hand: keep answering (the
    // server blocks until we do) without reopening anything over the very
    // prompts they chose to type into. Ahead of the version split because it is
    // the player's decision and outranks whatever the game offers.
    if (state.declined) {
        return { kind: 'decline' };
    }
    if ((state.version ?? 1) >= 2) {
        return decideCharLoginV2(state);
    }
    // ── Version 1 ─────────────────────────────────────────────────────────
    // Only password-credentials is spoken on version 1. If the server offers
    // other methods exclusively, decline so it falls back to its own login
    // rather than us showing a form that cannot satisfy it.
    if (state.methods.length > 0 && !state.methods.includes('password-credentials')) {
        return { kind: 'decline' };
    }
    if (state.account && state.password && !state.attempted) {
        return { kind: 'autofill', account: state.account, password: state.password };
    }
    // An attempt already went out this connection and the server is asking
    // again — it rejected it. Replaying the same credentials would loop
    // silently, so the player gets the form to correct them.
    if (state.attempted) {
        return { kind: 'prompt' };
    }
    // The password is saved, just not readable until the vault is opened.
    if (state.credentialsLocked) {
        return { kind: 'unlock', reason: 'read' };
    }
    // Nothing to send: hand the sign-in to the game's own login prompt with the
    // empty reply, straight away, as Mudlet does (GMCPAuthenticator::
    // selectAuthMethod → sendCredentials). Raising a popup instead left the
    // server waiting on it for as long as it stayed open (mudlet-web#362).
    return { kind: 'decline' };
}

/**
 * The version 2 ladder, mirroring `GMCPAuthenticator::attemptReconnect` →
 * `readStoredSignIn` → `selectAuthMethod`. The ordering is copied, not
 * rederived; each rung has a reason:
 *
 * 0. A locked vault that holds this profile's password or token is opened
 *    first — every later rung reads from it. A locked vault holding nothing
 *    for it is offered too, so a new sign-in can be kept. (Mudlet Web only.)
 * 1. A complete stored account **and** password, when the game accepts
 *    `password-credentials`, is the player's explicit choice — they typed both
 *    into this profile — so it outranks a token, which names whatever account
 *    last signed in rather than the character they want to play. Skipped while
 *    recovering from a rejected token, where the stored sign-in is read first.
 * 2. The stored sign-in: replay its token (not gated on `oauth` — a token is
 *    verified ahead of the advertised methods, and a password-only game may
 *    mint one), unless it was just rejected or is scoped to an encrypted
 *    transport this connection is not; else resume its provider, which *is*
 *    gated on `oauth` — a password-only game cannot restart a browser sign-in.
 * 3. Method selection: autofill a pair; the client-driven OAuth flow when the
 *    game is its own OpenID Provider over TLS; else the hand-off.
 *
 * Mudlet has no "already attempted" guard; it bounds a server that re-asks in
 * a loop with its one-attempt-a-second throttle (which the controller ports
 * too). We also keep per-connection guards, so the *second* ask after a
 * rejected autofill, token, resume or OAuth attempt lands the player on the
 * game's own sign-in screen rather than replaying what was just refused.
 */
function decideCharLoginV2(state: CharLoginRequestState): CharLoginAction {
    if (state.credentialsLocked) {
        return { kind: 'unlock', reason: 'read' };
    }
    // A sign-in that may end in a token, with a vault that could keep it if
    // the player opened it: ask before answering, because `token_storage` is
    // sent now and a token refused for it never arrives later.
    if (state.storageLocked && state.methods.length > 0) {
        return { kind: 'unlock', reason: 'store' };
    }
    const canAutofill = !!state.account && !!state.password && !state.attempted
        && acceptsPasswordCredentials(state);
    if (canAutofill && !state.tokenRejected) {
        return { kind: 'autofill', account: state.account!, password: state.password! };
    }
    const signIn = state.signIn;
    if (signIn?.account) {
        if (signIn.token && canReplayToken(state)) {
            return { kind: 'reconnect', account: signIn.account, token: signIn.token };
        }
        if (signIn.provider && !state.resumeAttempted && state.methods.includes('oauth')) {
            return { kind: 'resume', account: signIn.account, provider: signIn.provider };
        }
    }
    // ── selectAuthMethod ──────────────────────────────────────────────────
    if (canAutofill) {
        return { kind: 'autofill', account: state.account!, password: state.password! };
    }
    if (state.clientOAuthAvailable && state.methods.includes('oauth')) {
        return { kind: 'oauth' };
    }
    return { kind: 'decline' };
}

/** Whether the stored token may be replayed on this connection. */
function canReplayToken(state: CharLoginRequestState): boolean {
    if (state.tokenRejected || state.reconnectAttempted) return false;
    // Strict unless the issuing server explicitly said otherwise: a missing
    // requirement never widens a stored token's exposure.
    const secureOnly = state.signIn?.secureOnly ?? true;
    return !secureOnly || !!state.secureTransport;
}

/**
 * Whether a token would have been replayed but for the game-facing transport
 * being in the clear — the one case worth telling the player about, since their
 * saved sign-in silently stopped working and the reason is fixable. Answered by
 * re-running the ladder with the gate lifted, so the two cannot drift apart.
 */
export function charLoginTokenRefusedForCleartext(state: CharLoginRequestState): boolean {
    if (state.secureTransport) return false;
    return decideCharLoginRequest({ ...state, secureTransport: true }).kind === 'reconnect';
}

// ── Console wording (Mudlet's, from GMCPAuthenticator.cpp) ────────────────

/** Display names for the provider ids that arrive lowercase on the wire. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
    apple: 'Apple',
    discord: 'Discord',
    github: 'GitHub',
    google: 'Google',
    microsoft: 'Microsoft',
    slack: 'Slack',
    twitch: 'Twitch',
    x: 'X',
};

/** A provider id as a human-readable name. Unknown ids are capitalised rather
 *  than dropped. Empty for no provider. */
export function charLoginProviderName(provider?: string): string {
    if (!provider) return '';
    const known = PROVIDER_DISPLAY_NAMES[provider.toLowerCase()];
    if (known) return known;
    return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** Offered with a `Char.Login.URL` or the client-driven flow's sign-in page. A
 *  browser blocks a tab opened outside a user gesture, so where Mudlet
 *  launches the system browser we always offer the link. */
/** Mudlet's `GMCPAuthenticator::announceBrowserHandoff` wording. No link: the
 *  sign-in dialog carries it, and a game-linked page is printed by the game. */
export function charLoginSignInLinkMessage(provider?: string): string {
    const display = charLoginProviderName(provider);
    return display
        ? `Opening your browser to sign in with ${display}. Complete the login there, then return here.`
        : 'Opening your browser to sign in. Complete the login there, then return here.';
}

export const CHAR_LOGIN_INVALID_URL_MESSAGE =
    'The game sent an invalid sign-in link; cannot continue.';

export const CHAR_LOGIN_INSECURE_RECONNECT_MESSAGE =
    'Not using your saved sign-in because this connection is not encrypted; please sign in again.';

export function charLoginResumeMessage(provider: string): string {
    return `Resuming your ${charLoginProviderName(provider) || provider} sign-in with the game.`;
}

/** Shown once per sign-in attempt, on the first token that attempt saves. */
export const CHAR_LOGIN_TOKEN_SAVED_MESSAGE =
    "You'll be signed in automatically next time. "
    + 'Undo this with "Forget saved sign-in" in the profile\'s connection settings.';

/** Mudlet Web only: the game can hand over a sign-in to keep, but there is no
 *  vault to keep it in, so it was told `token_storage: false`. The line ends
 *  in {@link CHAR_LOGIN_NO_VAULT_LINK}, a link that opens vault setup. */
export const CHAR_LOGIN_NO_VAULT_MESSAGE = 'Want to stay signed in next time?';
export const CHAR_LOGIN_NO_VAULT_LINK = 'Set up saved logins';
/** Vault setup, opened from that link, finished. */
export const CHAR_LOGIN_VAULT_READY_MESSAGE =
    'Saved logins are set up. The next time you sign in, it will be kept.';

export const CHAR_LOGIN_TOKEN_SAVE_FAILED_MESSAGE =
    'Could not save your sign-in for next time; you may need to sign in again.';

export const CHAR_LOGIN_TOKEN_EXPIRED_MESSAGE =
    'Your saved sign-in has expired; reconnecting so you can sign in again.';

export const CHAR_LOGIN_OAUTH_FAILED_MESSAGE =
    'The browser sign-in could not be completed; reconnect to try again.';

export const CHAR_LOGIN_AUTHCODE_INSECURE_MESSAGE =
    'Cannot complete the sign-in because the connection is not encrypted.';

/**
 * The console line for credentials the game never answered at all: it closed the
 * connection instead of sending `Char.Login.Result`.
 *
 * Measured against Achaea (2026-08-02): a rejected `Char.Login.Credentials` gets
 * no result, no text, no close reason — the socket simply ends. The same wrong
 * password typed into its *text* login prints "Password incorrect. For recovery,
 * see …" before dropping, so the silence is specific to the GMCP path. Mudlet
 * only reports `Char.Login.Result`, so it is equally silent here; without this
 * line a mistyped password is indistinguishable from a network failure.
 */
export const CHAR_LOGIN_SILENT_DROP_MESSAGE =
    'Could not log in to the game: it closed the connection without answering. '
    + 'Games commonly do this when the account name or password is wrong.';

/**
 * The console line for a rejected login, in Mudlet's wording
 * (`GMCPAuthenticator::handleAuthResult`). Servers doing GMCP login usually send
 * no text of their own, so this is often the only trace of the failure.
 */
export function charLoginFailureMessage(message?: string): string {
    return message
        ? `Could not log in to the game: ${message}`
        : 'Could not log in to the game, is the login information correct?';
}
