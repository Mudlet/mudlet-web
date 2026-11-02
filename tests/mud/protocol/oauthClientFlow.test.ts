// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import {
    OAUTH_CALLBACK_CHANNEL,
    OAuthClientFlow,
    acceptableEndpointUrl,
    buildAuthorizationUrl,
    codeChallengeS256,
    generateCodeVerifier,
    type OAuthChannel,
    type OAuthClientFlowOptions,
} from '../../../src/mud/protocol/oauthClientFlow';

describe('PKCE', () => {
    // RFC 7636 Appendix B.
    it('derives the RFC 7636 S256 challenge', async () => {
        expect(await codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
            .toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });

    it('generates a 43-character unreserved verifier', () => {
        const v = generateCodeVerifier();
        expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(generateCodeVerifier()).not.toBe(v);
    });
});

describe('endpoint and URL rules', () => {
    it('accepts https, and http only on loopback', () => {
        expect(acceptableEndpointUrl('https://id.example/x')).toBe(true);
        expect(acceptableEndpointUrl('http://127.0.0.1:8080/x')).toBe(true);
        expect(acceptableEndpointUrl('http://localhost/x')).toBe(true);
        expect(acceptableEndpointUrl('http://[::1]/x')).toBe(true);
        expect(acceptableEndpointUrl('http://id.example/x')).toBe(false);
        expect(acceptableEndpointUrl('javascript:alert(1)')).toBe(false);
        expect(acceptableEndpointUrl('not a url')).toBe(false);
    });

    it('builds the authorization request, keeping the endpoint\'s own query', () => {
        const url = new URL(buildAuthorizationUrl(
            'https://id.example/authorize?tenant=t', 'mudlet', ['openid', 'profile'],
            'https://web.mudlet.org/oauth-callback.html', 'st', 'ch', 'nn',
        ));
        const q = url.searchParams;
        expect(q.get('tenant')).toBe('t');
        expect(q.get('response_type')).toBe('code');
        expect(q.get('client_id')).toBe('mudlet');
        expect(q.get('scope')).toBe('openid profile');
        expect(q.get('redirect_uri')).toBe('https://web.mudlet.org/oauth-callback.html');
        expect(q.get('state')).toBe('st');
        expect(q.get('code_challenge')).toBe('ch');
        expect(q.get('code_challenge_method')).toBe('S256');
        expect(q.get('nonce')).toBe('nn');
    });
});

/** A BroadcastChannel stand-in that lets the test play the callback page. */
function fakeChannel() {
    const posted: unknown[] = [];
    const channel: OAuthChannel & { closed: boolean; deliver(data: unknown): void } = {
        onmessage: null,
        closed: false,
        postMessage: (m) => { posted.push(m); },
        close() { this.closed = true; },
        deliver(data) { this.onmessage?.({ data } as MessageEvent); },
    };
    return { channel, posted };
}

function discoveryFetch(doc: unknown, ok = true) {
    return vi.fn(async () => ({ ok, status: ok ? 200 : 404, json: async () => doc }) as unknown as Response);
}

function startFlow(over: Partial<OAuthClientFlowOptions> = {}) {
    const { channel, posted } = fakeChannel();
    const opened: string[] = [];
    const onCaptured = vi.fn();
    const onFailed = vi.fn();
    const channelNames: string[] = [];
    const flow = new OAuthClientFlow({
        discoveryUrl: 'https://id.example/.well-known/openid-configuration',
        clientId: 'mudlet',
        scopes: [],
        nonceRequired: true,
        redirectUri: 'https://web.mudlet.org/oauth-callback.html',
        onAuthorizationUrl: (u) => opened.push(u),
        onCaptured,
        onFailed,
        fetch: discoveryFetch({ authorization_endpoint: 'https://id.example/authorize' }),
        openChannel: (name) => { channelNames.push(name); return channel; },
        ...over,
    });
    flow.start();
    return { flow, channel, posted, opened, onCaptured, onFailed, channelNames };
}

/** Let the discovery fetch and the SHA-256 digest (real WebCrypto) resolve. */
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };

describe('OAuthClientFlow', () => {
    it('discovers the endpoint and hands back the code with its verifier', async () => {
        const t = startFlow();
        await settle();
        expect(t.channelNames).toEqual([OAUTH_CALLBACK_CHANNEL]);
        expect(t.opened).toHaveLength(1);
        const q = new URL(t.opened[0]).searchParams;
        // An empty scope list defaults to openid, as the standard says.
        expect(q.get('scope')).toBe('openid');
        const state = q.get('state')!;
        const nonce = q.get('nonce')!;
        expect(nonce).toBeTruthy();

        t.channel.deliver({ type: 'callback', state, code: 'abc' });
        expect(t.onFailed).not.toHaveBeenCalled();
        expect(t.onCaptured).toHaveBeenCalledTimes(1);
        const auth = t.onCaptured.mock.calls[0][0];
        expect(auth.code).toBe('abc');
        expect(auth.redirectUri).toBe('https://web.mudlet.org/oauth-callback.html');
        expect(auth.nonce).toBe(nonce);
        // The verifier is the one the challenge was made from.
        expect(await codeChallengeS256(auth.codeVerifier)).toBe(q.get('code_challenge'));
        expect(t.posted).toEqual([{ type: 'ack', state, ok: true }]);
        expect(t.channel.closed).toBe(true);
    });

    it('ignores callbacks belonging to another flow', async () => {
        const t = startFlow();
        await settle();
        t.channel.deliver({ type: 'callback', state: 'someone-else', code: 'x' });
        t.channel.deliver({ type: 'ack', state: 'x', ok: true });
        expect(t.onCaptured).not.toHaveBeenCalled();
        expect(t.onFailed).not.toHaveBeenCalled();
    });

    it('reports a provider error as a sign-in failure', async () => {
        const t = startFlow();
        await settle();
        const state = new URL(t.opened[0]).searchParams.get('state');
        t.channel.deliver({ type: 'callback', state, error: 'access_denied' });
        expect(t.onFailed).toHaveBeenCalledWith(expect.stringContaining('access_denied'), 'signin');
        expect(t.posted).toEqual([{ type: 'ack', state, ok: false }]);
    });

    it('reports discovery trouble as a setup failure', async () => {
        const cors = startFlow({ fetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) });
        await settle();
        expect(cors.onFailed).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch'), 'setup');
        expect(cors.opened).toEqual([]);

        const insecure = startFlow({ fetch: discoveryFetch({ authorization_endpoint: 'http://id.example/a' }) });
        await settle();
        expect(insecure.onFailed).toHaveBeenCalledWith(expect.stringContaining('authorization_endpoint'), 'setup');

        const badUrl = startFlow({ discoveryUrl: 'http://id.example/.well-known/openid-configuration' });
        expect(badUrl.onFailed).toHaveBeenCalledWith(expect.stringContaining('https'), 'setup');
    });

    it('says nothing after an abort', async () => {
        const t = startFlow();
        await settle();
        const state = new URL(t.opened[0]).searchParams.get('state');
        t.flow.abort();
        t.channel.deliver({ type: 'callback', state, code: 'late' });
        expect(t.onCaptured).not.toHaveBeenCalled();
        expect(t.onFailed).not.toHaveBeenCalled();
        expect(t.channel.closed).toBe(true);
    });

    it('times out', async () => {
        vi.useFakeTimers();
        try {
            const t = startFlow({ timeoutMs: 1000, fetch: vi.fn(() => new Promise<Response>(() => {})) });
            await vi.advanceTimersByTimeAsync(1000);
            expect(t.onFailed).toHaveBeenCalledWith(expect.stringContaining('timed out'), 'signin');
        } finally {
            vi.useRealTimers();
        }
    });
});
