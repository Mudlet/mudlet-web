/**
 * GMCP `Char.Login` flow decisions.
 *
 * The server sends `Char.Login.Default` to ask for credentials and then waits,
 * withholding its text login prompt until the client answers. Answering is
 * therefore mandatory — every path here ends in either a credentials reply or a
 * popup that will produce one. `Char.Login.Result` reports the outcome, and a
 * server that rejects an attempt commonly re-sends `Char.Login.Default` to ask
 * again, so these rules run repeatedly within one connection.
 *
 * Two protocol versions are in play, and they want opposite things from us:
 *
 * - **Version 1** is a password exchange. We raise `CharLoginModal`, the player
 *   types, and we relay. That is the pleasant answer for a password game and it
 *   is what every profile in the wild is talking to today.
 * - **Version 2** adds browser sign-in (Google, Discord, or the game's own
 *   account system). There the game owns the interactive sign-in screen and we
 *   automate *around* it — Mudlet's design note is explicit that the client does
 *   not render a pop-up of its own. Showing our modal *and* the game's sign-in
 *   page is the failure mode to avoid, so on version 2 the modal never opens:
 *   we either autofill a stored pair or send the empty `{}` hand-off.
 *
 * Mirrors Mudlet's `GMCPAuthenticator` (GMCPAuthenticator.{h,cpp}). Kept free of
 * React and session plumbing so the rules can be tested directly; the caller
 * supplies the per-connection state.
 */

/** The highest `Char.Login` version this client implements — the value
 *  advertised in `Core.Supports.Set` and the ceiling every negotiation is
 *  clamped to. Client-driven OAuth (`Char.Login.AuthCode`), the remaining
 *  version 2 capability, is deliberately not implemented; see
 *  {@link parseCharLoginDefault}. */
export const CHAR_LOGIN_CLIENT_VERSION = 2;

/** What to do about a `Char.Login.Default` request. */
export type CharLoginAction =
    /**
     * Reply with the empty `Char.Login.Credentials {}` form. One wire message,
     * two meanings, both of which want exactly these bytes:
     *
     * - version 1: "no credentials, use your next method" — the player hit
     *   *Use text login* and wants the game's `By what name…` prompt.
     * - version 2: the deliberate hand-off — "run your own sign-in screen",
     *   which is how a browser sign-in gets started. Mudlet sends it even when
     *   the profile has a stored password, so a saved password never blocks the
     *   player from reaching a provider choice.
     */
    | { kind: 'decline' }
    /** Send stored credentials without troubling the player. */
    | { kind: 'autofill'; account: string; password: string }
    /** Replay the saved password-less token — `Char.Login.Reconnect`. Version 2
     *  only, and only over an encrypted game-facing transport. */
    | { kind: 'reconnect'; account: string; token: string }
    /**
     * Ask the game to restart this provider's browser sign-in — the *resume*
     * form of `Char.Login.Credentials`, `{account, provider, version}`.
     *
     * The absence of a password, not the presence of `provider`, is what makes
     * it a resume. Sent when we remember how this account signs in but have no
     * usable token, so the player skips the provider menu.
     */
    | { kind: 'resume'; account: string; provider: string }
    /** Raise the credentials popup. Version 1 only. */
    | { kind: 'prompt' };

export interface CharLoginRequestState {
    /** Negotiated `Char.Login` version — `min(client, server)`, 1 when the
     *  server reported none. Absent is read as 1, so a caller that predates
     *  version 2 gets the version 1 rules unchanged. */
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
    /** Saved password-less reconnect token, and the account it names. Both are
     *  needed to replay one; the account is not the typed {@link account} (see
     *  `MudConnection.charLoginTokenAccount`). */
    token?: string;
    tokenAccount?: string;
    /** The provider this account signs in with, remembered from an earlier
     *  `Char.Login.URL`. Enough for a resume even with no token left. */
    provider?: string;
    /** Whether the link to the *game* is encrypted — `connectionSecureTransport()`,
     *  not "is the WebSocket wss:". A token is a bearer secret and never goes out
     *  in the clear. */
    secureTransport?: boolean;
    /** A token was rejected on a previous connection and the sign-in restarted.
     *  Read the store, but do not replay a token this once — see
     *  {@link decideCharLoginV2}. */
    tokenRejected?: boolean;
    /** A token has already been replayed once this connection. Mudlet bounds the
     *  same thing with its one-attempt-per-second throttle. */
    reconnectAttempted?: boolean;
}

/** Whether the game will accept `Char.Login.Credentials {account, password}`.
 *
 *  The two versions read an *absent* `type` list differently, deliberately.
 *  Version 1 servers in the wild send `Char.Login.Default {}` and expect the
 *  password exchange, so silence means yes. Version 2 lists its methods (that
 *  is what the list is for) and Mudlet tests `contains("password-credentials")`
 *  with no fallback, so silence means no — and falls through to the hand-off,
 *  which is a working sign-in rather than a form the game would refuse. */
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
    // server blocks until we do) without reopening the form over the very
    // prompts they chose to type into. Ahead of the version split because it is
    // the player's decision and outranks whatever the game offers.
    if (state.declined) {
        return { kind: 'decline' };
    }
    if ((state.version ?? 1) >= 2) {
        return decideCharLoginV2(state);
    }
    // ── Version 1, unchanged ──────────────────────────────────────────────
    // Only password-credentials is implemented. If the server offers other
    // methods exclusively (e.g. oauth), decline so it falls back to its own
    // login rather than us showing a form that cannot satisfy it.
    if (state.methods.length > 0 && !state.methods.includes('password-credentials')) {
        return { kind: 'decline' };
    }
    if (state.account && state.password && !state.attempted) {
        return { kind: 'autofill', account: state.account, password: state.password };
    }
    return { kind: 'prompt' };
}

/**
 * The version 2 ladder, mirroring `GMCPAuthenticator::attemptReconnect` →
 * `selectAuthMethod`. Each rung has a reason and the reasons are not obvious,
 * so the ordering is copied rather than rederived.
 *
 * 1. Just recovered from a rejected token? Read the store, but do not replay a
 *    token this once: the entry has been rewritten into a token-less resume
 *    hint, and replaying anything would risk looping straight back into another
 *    rejection.
 * 2. A complete stored account **and** password, when the game accepts
 *    `password-credentials`, is the player's explicit choice of sign-in method
 *    — they typed both into this profile deliberately — so it outranks a token,
 *    which names whatever account last signed in rather than the character they
 *    want to play.
 * 3. The game does not offer `oauth`? Then there is nothing to replay or resume
 *    against (tokens and the resume are part of the version 2 OAuth capability),
 *    so go straight to method selection.
 * 4. Otherwise read the stored sign-in: replay the token if there is one, else
 *    send the resume form for a remembered provider, else fall through.
 *
 * Method selection is the tail of this function:
 *
 * 1. `password-credentials` plus a complete stored pair → autofill.
 * 2. Client-driven OAuth would be Mudlet's next rung. It is not implementable
 *    in a browser today — see {@link parseCharLoginDefault} — so we skip it,
 *    exactly as Mudlet does on a connection where that capability is
 *    unavailable.
 * 3. Otherwise hand off with the empty `{}`, *even when the profile has a stored
 *    password* the game will not take, and let the player choose on the game's
 *    own sign-in page. The `Char.Login.URL` that answers this is what reaches
 *    the browser.
 */
function decideCharLoginV2(state: CharLoginRequestState): CharLoginAction {
    const havePair = !!state.account && !!state.password;
    // Mudlet has no "already attempted" concept on the autofill rung; it bounds
    // a server that re-asks in a loop by throttling sign-in attempts to one a
    // second, which means a wrong saved password is replayed against every
    // repeat ask for as long as the server keeps asking. We keep our
    // per-connection guard instead and fall through to the hand-off, so the
    // *second* ask lands the player on the game's own sign-in screen — where
    // they can fix it — rather than on the same rejected password again.
    // Strictly better than the loop, and it is the same rule version 1 already
    // uses to reach its popup. `reconnectAttempted` bounds the token replay the
    // same way.
    const canAutofill = havePair && !state.attempted && acceptsPasswordCredentials(state);
    // Rung 1 reads the store whatever else is true — including on a game not
    // offering oauth — because the whole point of that pass is to finish the
    // sign-in a rejected token interrupted. Rungs 2 and 3 skip the store: a
    // sendable stored pair outranks the token (rung 2), and a game not offering
    // oauth has nothing to replay or resume against (rung 3).
    //
    // Rung 2 keys on `canAutofill` rather than merely holding a pair: once those
    // credentials have been tried and refused they are no longer the player's
    // live choice, and a working token beats replaying a password the game just
    // rejected.
    const readStoredSignIn = state.tokenRejected
        || (!canAutofill && state.methods.includes('oauth'));
    if (readStoredSignIn) {
        // Rung 4. `tokenRejected` allows the read but not the replay: the stored
        // entry has just been rewritten into a token-less resume hint, and
        // replaying anything here risks looping back into another rejection.
        if (!state.tokenRejected && !state.reconnectAttempted && canReplayToken(state)) {
            return { kind: 'reconnect', account: state.tokenAccount!, token: state.token! };
        }
        // No usable token, but we remember how this account signs in: ask the
        // game to restart that provider's browser sign-in rather than drop the
        // player back on a provider menu.
        if (state.tokenAccount && state.provider) {
            return { kind: 'resume', account: state.tokenAccount, provider: state.provider };
        }
    }
    // ── Method selection ──────────────────────────────────────────────────
    if (canAutofill) {
        return { kind: 'autofill', account: state.account!, password: state.password! };
    }
    return { kind: 'decline' };
}

/** Whether a stored token is both present and safe to send. */
function canReplayToken(state: CharLoginRequestState): boolean {
    return !!state.token && !!state.tokenAccount && !!state.secureTransport;
}

/**
 * Whether a token would have been replayed but for the game-facing transport
 * being in the clear — the one case worth telling the player about, since their
 * saved sign-in silently stopped working and the reason is fixable (connect over
 * TLS). Mudlet reports it from inside `sendReconnect`, which returns false and
 * lets the ladder fall through to the resume or the hand-off; the decision here
 * is pure, so the caller asks separately.
 *
 * Answered by re-running the ladder with the gate lifted rather than by
 * restating its conditions, so the two cannot drift apart — a stored token on a
 * version 1 server, or on a game not offering `oauth`, was never going to be
 * replayed and is not worth a warning about encryption.
 */
export function charLoginTokenRefusedForCleartext(state: CharLoginRequestState): boolean {
    if (state.secureTransport) return false;
    return decideCharLoginRequest({ ...state, secureTransport: true }).kind === 'reconnect';
}

/** The console line for a token we refused to replay in the clear. Mudlet's
 *  wording (`GMCPAuthenticator::sendReconnect`). */
export const CHAR_LOGIN_INSECURE_RECONNECT_MESSAGE =
    'Not using your saved sign-in because this connection is not encrypted; please sign in again.';

/** The console line announcing a provider resume. Mudlet's wording
 *  (`GMCPAuthenticator::sendResume`). */
export function charLoginResumeMessage(provider: string): string {
    return `Resuming your ${charLoginProviderName(provider) || provider} sign-in with the game.`;
}

/** The console line shown once, on the first token a connection saves, so the
 *  player knows their sign-in will be remembered and where to undo it. Mudlet
 *  points at Preferences → Connection; ours lives on the profile's own editor. */
export const CHAR_LOGIN_TOKEN_SAVED_MESSAGE =
    "You'll be signed in automatically next time. "
    + 'Undo this with "Forget saved sign-in" in the profile\'s settings.';

/** The console line for a saved token the game no longer accepts. */
export const CHAR_LOGIN_TOKEN_EXPIRED_MESSAGE =
    'Your saved sign-in is no longer accepted; sign in again to save a new one.';

/**
 * Clamp the version a server reported in `Char.Login.Default` to what we
 * implement. The negotiated version is `min(client, server)`.
 *
 * Absent, non-numeric, or non-positive all mean 1: the spec's version is a
 * positive non-zero integer, and a version 1 server sends no field at all. A
 * value *above* what we implement is clamped down, not read as 1 — a version 5
 * server still speaks version 2 to us. Mirrors `saveSupportsSet`'s
 * `qBound(1, reportedVersion, 2)`.
 */
export function negotiateCharLoginVersion(reported: unknown): number {
    if (typeof reported !== 'number' || !Number.isFinite(reported)) return 1;
    const v = Math.trunc(reported);
    if (v < 1) return 1;
    return Math.min(v, CHAR_LOGIN_CLIENT_VERSION);
}

/** The client-driven OAuth capability a version 2 server advertises when it is
 *  itself an OpenID Provider. Parsed but never acted on — see
 *  {@link parseCharLoginDefault}. */
export interface CharLoginOAuthCapability {
    location: string;
    clientId: string;
    scopes: string[];
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

/**
 * Read a `Char.Login.Default` payload into capabilities.
 *
 * `secureTransport` is whether the link to the *game* is encrypted — the answer
 * `connectionSecureTransport()` gives, not "is the WebSocket wss:". In proxy
 * mode a `wss://` proxy URL only secures the browser↔proxy hop; the proxy↔game
 * leg is plaintext telnet unless the profile enabled TLS.
 *
 * The client-driven OAuth fields are read only on an encrypted transport,
 * because the `Char.Login.AuthCode` that completes that flow carries the
 * authorization code and the PKCE verifier together and must never travel in
 * the clear. Dropping them on cleartext silently selects the server-driven flow
 * instead, which is Mudlet's behaviour (`saveSupportsSet`).
 *
 * We then never act on them at all, because a browser cannot complete that
 * flow: Mudlet's `OAuthClientFlow` listens on `127.0.0.1:<port>` and uses a
 * loopback redirect URI, which RFC 8252 reserves for native clients. The web
 * equivalent is a redirect URI on our own origin, and that URI has to be
 * registered with the game's OpenID Provider against the game's `client_id` —
 * something no game has done for us. Until one does, `Char.Login.AuthCode` is
 * undeliverable however much PKCE we write, so we treat `oauth` exactly as
 * Mudlet treats it on a cleartext connection and use the server-driven flow.
 * Parsing it anyway keeps the capability visible to tests and to whoever picks
 * up that question.
 */
export function parseCharLoginDefault(value: unknown, secureTransport: boolean): CharLoginCapabilities {
    const obj = (value && typeof value === 'object' && !Array.isArray(value))
        ? value as Record<string, unknown>
        : {};
    const caps: CharLoginCapabilities = {
        version: negotiateCharLoginVersion(obj.version),
        // A non-string or empty entry would otherwise masquerade as a real
        // method and slip past the `includes` guards above.
        methods: Array.isArray(obj.type)
            ? obj.type.filter((t): t is string => typeof t === 'string' && t !== '')
            : [],
    };
    if (secureTransport) {
        const location = typeof obj.location === 'string' ? obj.location : '';
        const clientId = typeof obj.client_id === 'string' ? obj.client_id : '';
        if (location && clientId) {
            caps.oauth = {
                location,
                clientId,
                scopes: Array.isArray(obj.scopes)
                    ? obj.scopes.filter((s): s is string => typeof s === 'string' && s !== '')
                    : [],
                nonceRequired: obj.nonce === true,
            };
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
 * survive: never `javascript:`, `file:`, `data:`, or any other scheme handler,
 * whether we would open it or merely render it as a link. Returns null for
 * anything else, including a missing or unparseable `url`.
 *
 * Control characters are refused outright. We render the address into the
 * console inside an OSC 8 sequence, and an ESC in it would close that sequence
 * early and let the game paint arbitrary ANSI — or a second, differently-targeted
 * hyperlink — through what is supposed to be one link. `new URL()` would
 * percent-encode them, but rejecting is the honest answer: a sign-in address
 * with a raw ESC in it is not one a game meant to send.
 */
export function parseCharLoginUrl(value: unknown): CharLoginUrl | null {
    const obj = (value && typeof value === 'object' && !Array.isArray(value))
        ? value as Record<string, unknown>
        : {};
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

/** Display names for the provider ids that arrive lowercase on the wire, so the
 *  sign-in messages read naturally ("…to sign in with GitHub"). Mudlet's
 *  `providerDisplayName` table (GMCPAuthenticator.cpp). */
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
 *  than dropped — the game may support a provider we have never heard of, and
 *  its own name is a better label than nothing. Empty for no provider. */
export function charLoginProviderName(provider?: string): string {
    if (!provider) return '';
    const known = PROVIDER_DISPLAY_NAMES[provider.toLowerCase()];
    if (known) return known;
    return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/**
 * The console line offering a `Char.Login.URL`, in Mudlet's wording
 * (`GMCPAuthenticator::offerOrOpenSignInUrl`).
 *
 * Mudlet hands the address to `QDesktopServices::openUrl`, gated on the player
 * having sent input this connection so a server cannot open a browser
 * unprompted. We deliberately never call `window.open` for a server-supplied
 * URL: the platform already enforces exactly that rule (a popup outside a user
 * gesture is blocked), so making the player click costs nothing and the failure
 * mode is "nothing happened" rather than "the game opened a tab at you".
 *
 * The caller renders the address as an OSC 8 hyperlink; the sentence carries it
 * as text either way, so it stays readable and copyable even for a player who
 * has turned hyperlinks off.
 */
export function charLoginSignInLinkMessage(url: string, provider?: string): string {
    const display = charLoginProviderName(provider);
    return display
        ? `To sign in with ${display}, open this link in your browser: ${url}`
        : `To sign in, open this link in your browser: ${url}`;
}

/** The console line for a `Char.Login.URL` we refused to render — a scheme that
 *  is not http(s), or an address that does not parse. Mudlet's wording. */
export const CHAR_LOGIN_INVALID_URL_MESSAGE =
    'The game sent an invalid sign-in link; cannot continue.';

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
