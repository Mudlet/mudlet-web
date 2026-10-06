/**
 * GMCP `Char.Login` flow decisions.
 *
 * The server sends `Char.Login.Default` to ask for credentials and then waits,
 * withholding its text login prompt until the client answers. Answering is
 * therefore mandatory — every path here ends in a credentials reply (the empty
 * one when there is nothing to send), or a popup or vault unlock that will
 * produce one. `Char.Login.Result` reports the outcome, and a
 * server that rejects an attempt commonly re-sends `Char.Login.Default` to ask
 * again, so these rules run repeatedly within one connection.
 *
 * Mirrors Mudlet's `GMCPAuthenticator` (GMCPAuthenticator.cpp). Kept free of
 * React and session plumbing so the rules can be tested directly; the caller
 * supplies the per-connection state.
 */

/** What to do about a `Char.Login.Default` request. */
export type CharLoginAction =
    /** Reply with the empty `{}` form — "no credentials, use your next method". */
    | { kind: 'decline' }
    /** Send stored credentials without troubling the player. */
    | { kind: 'autofill'; account: string; password: string }
    /** Raise the credentials popup. */
    | { kind: 'prompt' }
    /** Ask to unlock the vault holding this profile's saved login. */
    | { kind: 'unlock' };

export interface CharLoginRequestState {
    /** The `type` list from `Char.Login.Default`; empty when the server sent none. */
    methods: string[];
    /** The player chose "Use text login" earlier this connection. */
    declined: boolean;
    /** Credentials have already been sent once this connection (stored or typed). */
    attempted: boolean;
    /** Stored/in-memory credentials, if any. */
    account?: string;
    password?: string;
    /** A saved password exists but sits in a locked vault, so it can't be read
     *  yet. Mudlet Web only — desktop has no vault to unlock. */
    credentialsLocked?: boolean;
}

/**
 * Decide how to answer a `Char.Login.Default`.
 *
 * The one automatic attempt per connection is the load-bearing rule: it makes a
 * saved login silent when it works, and guarantees that a *wrong* saved login
 * turns into a visible popup instead of a silent send-reject-send loop against
 * the server's repeated asks.
 */
export function decideCharLoginRequest(state: CharLoginRequestState): CharLoginAction {
    // Only password-credentials is implemented. If the server offers other
    // methods exclusively (e.g. oauth), decline so it falls back to its own
    // login rather than us showing a form that cannot satisfy it.
    if (state.methods.length > 0 && !state.methods.includes('password-credentials')) {
        return { kind: 'decline' };
    }
    // The player already opted into logging in by hand: keep answering (the
    // server blocks until we do) without reopening the form over the very
    // prompts they chose to type into.
    if (state.declined) {
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
        return { kind: 'unlock' };
    }
    // Nothing to send: hand the sign-in to the game's own login prompt with the
    // empty reply, straight away, as Mudlet does (GMCPAuthenticator::
    // selectAuthMethod → sendCredentials). Raising a popup instead left the
    // server waiting on it for as long as it stayed open (mudlet-web#362).
    return { kind: 'decline' };
}

/**
 * The console line for a rejected login, in Mudlet's wording
 * (`GMCPAuthenticator::handleAuthResult`). Servers doing GMCP login usually send
 * no text of their own, so this is often the only trace of the failure.
 */
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

export function charLoginFailureMessage(message?: string): string {
    return message
        ? `Could not log in to the game: ${message}`
        : 'Could not log in to the game, is the login information correct?';
}
