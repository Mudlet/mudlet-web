/**
 * The client-driven GMCP `Char.Login` v2 OAuth flow, for a browser.
 *
 * Port of Mudlet's `OAuthClientFlow` (development branch). When the game is its
 * own OpenID Provider it advertises a discovery document and a `client_id`; we
 * fetch the document, build the provider's authorization URL with a PKCE (S256)
 * challenge, wait for the provider to redirect back with an authorization code,
 * and hand `{code, code_verifier, redirect_uri, nonce}` to the caller, which
 * sends it to the game as `Char.Login.AuthCode`. The token exchange itself stays
 * on the game server.
 *
 * **The redirect is where a browser has to differ.** Desktop Mudlet listens on
 * `http://127.0.0.1:<random port>/` — an RFC 8252 loopback redirect, which a
 * provider registers once and accepts on any port. A web page cannot listen on a
 * socket, so our redirect is a real page on our own origin,
 * `oauth-callback.html` beside the app (or a branded build's
 * `oauthRedirectUrl`). The game's provider has to have registered that address
 * for its `client_id`, next to Mudlet's loopback one. The page reports the
 * provider's answer over a same-origin `BroadcastChannel`, which works whether
 * the sign-in ran in a popup, a tab or a tab the player opened by hand, and
 * survives a provider that severs `window.opener` with COOP.
 *
 * Opening the authorization URL is the caller's job — a browser only lets a
 * page open one from a user gesture, so it becomes a button — exactly as
 * Mudlet leaves launching the browser to `GMCPAuthenticator`.
 */

import { getBrand } from '../../branding';

/** One deadline covers the whole flow — discovery, the player's sign-in, the
 *  redirect — so an abandoned attempt cannot keep listening for ever. */
export const OAUTH_FLOW_TIMEOUT_MS = 5 * 60_000;

/** The channel `oauth-callback.html` reports on. Keep in step with that page. */
export const OAUTH_CALLBACK_CHANNEL = 'mudlet-web-oauth';

/** What `oauth-callback.html` posts: the redirect's parameters, verbatim. */
export interface OAuthCallbackMessage {
    type: 'callback';
    state?: string;
    code?: string;
    error?: string;
}

/** What the app answers so the page can tell the player how it went. */
export interface OAuthCallbackAck {
    type: 'ack';
    state: string;
    ok: boolean;
}

function base64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomUrlSafeToken(byteCount: number): string {
    const bytes = new Uint8Array(byteCount);
    crypto.getRandomValues(bytes);
    return base64Url(bytes);
}

/** 32 random bytes, base64url without padding: a 43-character verifier, the
 *  RFC 7636 minimum, from the required unreserved character set. */
export function generateCodeVerifier(): string {
    return randomUrlSafeToken(32);
}

/** RFC 7636 S256: base64url(SHA-256(ASCII(verifier))). */
export async function codeChallengeS256(codeVerifier: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
    return base64Url(new Uint8Array(digest));
}

/**
 * OAuth endpoints must be https; plain http is permitted solely for loopback
 * hosts, so self-hosted and test setups work without certificates. Mudlet's
 * `acceptableEndpointUrl`.
 */
export function acceptableEndpointUrl(raw: string): boolean {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return false;
    }
    if (!url.hostname) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    return host === '127.0.0.1' || host === '[::1]' || host === 'localhost';
}

export function buildAuthorizationUrl(
    authorizationEndpoint: string,
    clientId: string,
    scopes: string[],
    redirectUri: string,
    state: string,
    codeChallenge: string,
    nonce?: string,
): string {
    const url = new URL(authorizationEndpoint);
    const q = url.searchParams;
    q.append('response_type', 'code');
    q.append('client_id', clientId);
    q.append('redirect_uri', redirectUri);
    q.append('scope', scopes.join(' '));
    q.append('state', state);
    q.append('code_challenge', codeChallenge);
    q.append('code_challenge_method', 'S256');
    if (nonce) q.append('nonce', nonce);
    return url.toString();
}

/**
 * The redirect URI this build asks providers to send the player back to: a
 * branded build's `oauthRedirectUrl`, else `oauth-callback.html` beside the
 * app. It must be same-origin with the app — the callback reports over a
 * same-origin `BroadcastChannel` — and is what each game's provider has to
 * register for its `client_id`.
 */
export function defaultOAuthRedirectUri(): string | null {
    const override = getBrand().oauthRedirectUrl?.trim();
    try {
        if (typeof document === 'undefined') return override || null;
        return new URL(override || 'oauth-callback.html', document.baseURI).toString();
    } catch {
        return null;
    }
}

/** Whether this page can run the flow at all: WebCrypto (a secure context) for
 *  PKCE, and `BroadcastChannel` to hear the callback. */
export function clientOAuthSupported(): boolean {
    return typeof crypto !== 'undefined' && !!crypto.subtle
        && typeof BroadcastChannel !== 'undefined'
        && defaultOAuthRedirectUri() !== null;
}

/** What a successful flow hands back — exactly the `Char.Login.AuthCode` body,
 *  less the common fields. */
export interface OAuthAuthorization {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    nonce?: string;
}

/**
 * Which half failed. `setup` is everything before the player is involved —
 * discovery (commonly a provider that serves its discovery document without
 * CORS headers, which only a browser trips over), a bad endpoint — and the
 * caller can still fall back to the game's own sign-in. `signin` is the player's
 * attempt itself: the provider refused, the state did not match, or it timed
 * out.
 */
export type OAuthFailureStage = 'setup' | 'signin';

/** The slice of BroadcastChannel the flow uses; injectable for tests. */
export interface OAuthChannel {
    onmessage: ((ev: MessageEvent) => void) | null;
    postMessage(message: unknown): void;
    close(): void;
}

export interface OAuthClientFlowOptions {
    discoveryUrl: string;
    clientId: string;
    scopes: string[];
    nonceRequired: boolean;
    redirectUri: string;
    onAuthorizationUrl: (url: string) => void;
    onCaptured: (authorization: OAuthAuthorization) => void;
    onFailed: (logDetail: string, stage: OAuthFailureStage) => void;
    fetch?: typeof fetch;
    openChannel?: (name: string) => OAuthChannel;
    timeoutMs?: number;
}

/**
 * Single-use: create a fresh flow for each sign-in attempt. Reaches exactly one
 * terminal outcome — captured, failed or aborted — after which every late
 * callback, timer or message is ignored.
 */
export class OAuthClientFlow {
    private started = false;
    private completed = false;
    private channel: OAuthChannel | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private abortController: AbortController | null = null;
    private codeVerifier = '';
    private state = '';
    private nonce = '';

    constructor(private readonly opts: OAuthClientFlowOptions) {}

    get done(): boolean {
        return this.completed;
    }

    start(): void {
        if (this.started) {
            console.warn('OAuthClientFlow.start() called twice on one instance; ignoring the second call.');
            return;
        }
        this.started = true;
        const { discoveryUrl } = this.opts;
        if (!acceptableEndpointUrl(discoveryUrl)) {
            this.fail(`discovery URL must be https (or http on loopback): ${discoveryUrl}`, 'setup');
            return;
        }
        this.timer = setTimeout(
            () => this.fail('timed out waiting for the browser sign-in to complete', 'signin'),
            this.opts.timeoutMs ?? OAUTH_FLOW_TIMEOUT_MS,
        );
        this.abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
        void this.discover();
    }

    abort(): void {
        if (this.completed) return;
        this.completed = true;
        this.cleanup();
    }

    private async discover(): Promise<void> {
        const doFetch = this.opts.fetch ?? fetch;
        let endpoint: string;
        try {
            const response = await doFetch(this.opts.discoveryUrl, {
                signal: this.abortController?.signal,
                headers: { Accept: 'application/json' },
                credentials: 'omit',
                redirect: 'follow',
            });
            if (this.completed) return;
            if (!response.ok) {
                this.fail(`could not fetch the OpenID discovery document: HTTP ${response.status}`, 'setup');
                return;
            }
            const doc = await response.json() as unknown;
            if (this.completed) return;
            const value = doc && typeof doc === 'object' && !Array.isArray(doc)
                ? (doc as Record<string, unknown>).authorization_endpoint
                : undefined;
            endpoint = typeof value === 'string' ? value : '';
        } catch (error) {
            if (this.completed) return;
            // A TypeError here is usually CORS: the document exists, but its
            // server did not allow a browser page to read it.
            this.fail(`could not fetch the OpenID discovery document: ${error instanceof Error ? error.message : String(error)}`, 'setup');
            return;
        }
        if (!acceptableEndpointUrl(endpoint)) {
            this.fail('the discovery document has no usable https authorization_endpoint', 'setup');
            return;
        }

        const openChannel = this.opts.openChannel ?? ((name: string) => new BroadcastChannel(name) as OAuthChannel);
        try {
            this.channel = openChannel(OAUTH_CALLBACK_CHANNEL);
        } catch (error) {
            this.fail(`could not listen for the browser redirect: ${error instanceof Error ? error.message : String(error)}`, 'setup');
            return;
        }
        this.channel.onmessage = (ev) => this.handleCallback(ev.data);

        this.codeVerifier = generateCodeVerifier();
        this.state = randomUrlSafeToken(16);
        this.nonce = this.opts.nonceRequired ? randomUrlSafeToken(16) : '';
        const scopes = this.opts.scopes.length > 0 ? this.opts.scopes : ['openid'];
        let url: string;
        try {
            const challenge = await codeChallengeS256(this.codeVerifier);
            if (this.completed) return;
            url = buildAuthorizationUrl(
                endpoint, this.opts.clientId, scopes, this.opts.redirectUri, this.state, challenge, this.nonce || undefined,
            );
        } catch (error) {
            this.fail(`could not build the authorization request: ${error instanceof Error ? error.message : String(error)}`, 'setup');
            return;
        }
        this.opts.onAuthorizationUrl(url);
    }

    private handleCallback(data: unknown): void {
        if (this.completed || !data || typeof data !== 'object') return;
        const msg = data as Partial<OAuthCallbackMessage>;
        if (msg.type !== 'callback') return;
        // Every flow in every tab of this origin hears every callback, so one
        // carrying another flow's state is somebody else's — ignored, not a
        // failure. (Desktop's loopback listener is private to one flow, so
        // Mudlet treats a mismatch as forgery; here it is ordinary traffic.)
        if (typeof msg.state !== 'string' || msg.state !== this.state) return;

        if (msg.error) {
            this.ack(false);
            this.fail(`the provider returned an error: ${msg.error}`, 'signin');
            return;
        }
        const code = typeof msg.code === 'string' ? msg.code : '';
        if (!code) {
            this.ack(false);
            this.fail("the provider's redirect did not include an authorization code", 'signin');
            return;
        }
        this.ack(true);
        this.completed = true;
        const authorization: OAuthAuthorization = {
            code,
            codeVerifier: this.codeVerifier,
            redirectUri: this.opts.redirectUri,
            ...(this.nonce ? { nonce: this.nonce } : {}),
        };
        this.cleanup();
        this.opts.onCaptured(authorization);
    }

    private ack(ok: boolean): void {
        try {
            this.channel?.postMessage({ type: 'ack', state: this.state, ok } satisfies OAuthCallbackAck);
        } catch {
            // The page falls back to a neutral message.
        }
    }

    private fail(logDetail: string, stage: OAuthFailureStage): void {
        if (this.completed) return;
        this.completed = true;
        this.cleanup();
        this.opts.onFailed(logDetail, stage);
    }

    private cleanup(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.abortController?.abort();
        this.abortController = null;
        if (this.channel) {
            this.channel.onmessage = null;
            this.channel.close();
            this.channel = null;
        }
        // Single-use anti-forgery values and the PKCE secret. JS strings cannot
        // be scrubbed in place, as Mudlet's SecureStringUtils does; dropping the
        // references is the most a page can do.
        this.state = '';
        this.nonce = '';
        this.codeVerifier = '';
    }
}
