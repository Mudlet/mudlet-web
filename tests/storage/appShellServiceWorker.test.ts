// @vitest-environment node
//
// public/vfs-sw.js is a real service worker, not a module: nothing imports it,
// and it reads `self.registration.scope` the moment it is evaluated. So it is
// run here in a `vm` context with a hand-built worker global — a fake
// CacheStorage, a fetch that can be taken offline, and the event listeners the
// file registers captured on the way past. That buys assertions on the part
// nobody can test from the app: what the app-shell cache serves when the
// network is gone (issue #71).
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SW_SOURCE = readFileSync(
    fileURLToPath(new URL('../../public/vfs-sw.js', import.meta.url)),
    'utf8',
);

const SCOPE = 'https://mudlet-web.mudlet.org/';

/** Minimal CacheStorage: enough of the shape the worker uses, keyed by URL
 *  string so `match('/x')` and `match(new Request('/x'))` land on one entry.
 *
 *  Vary is modelled, because getting it wrong is what broke offline loading in
 *  the first place: a static host answers these files with `Vary: Origin`, and a
 *  `<script crossorigin>` sends an `Origin` header that the entry stored by
 *  `cache.add()` never had — so a lookup that honours Vary misses on the very
 *  bytes it is holding. */
class FakeCache {
    entries = new Map<string, { request: Request; response: Response }>();

    private key(request: RequestInfo): string {
        return new URL(typeof request === 'string' ? request : (request as Request).url, SCOPE).href;
    }

    async match(request: RequestInfo, options?: { ignoreVary?: boolean }): Promise<Response | undefined> {
        const hit = this.entries.get(this.key(request));
        if (!hit) return undefined;
        if (!options?.ignoreVary && !varyMatches(hit, request)) return undefined;
        return hit.response.clone();
    }

    async put(request: RequestInfo, response: Response): Promise<void> {
        const stored = typeof request === 'string' ? new Request(this.key(request)) : request;
        this.entries.set(this.key(request), { request: stored, response });
    }

    async add(request: RequestInfo): Promise<void> {
        // As the real one does: `add` builds its own request, which carries no
        // `Origin` — the asymmetry the worker has to survive.
        const built = new Request(new URL(typeof request === 'string' ? request : request.url, SCOPE));
        const response = await (globalThis as { __swFetch?: typeof fetch }).__swFetch!(built);
        if (!response.ok) throw new Error(`add failed: ${response.status}`);
        await this.put(built, response);
    }

    async keys(): Promise<Request[]> {
        return [...this.entries.keys()].map(url => new Request(url));
    }

    async delete(request: RequestInfo): Promise<boolean> {
        return this.entries.delete(this.key(request));
    }
}

function varyMatches(entry: { request: Request; response: Response }, incoming: RequestInfo): boolean {
    const vary = entry.response.headers.get('vary');
    if (!vary) return true;
    if (vary.trim() === '*') return false;
    const request = typeof incoming === 'string' ? new Request(new URL(incoming, SCOPE)) : incoming;
    return vary.split(',').every(name =>
        entry.request.headers.get(name.trim()) === request.headers.get(name.trim()));
}

class FakeCacheStorage {
    caches = new Map<string, FakeCache>();
    async open(name: string): Promise<FakeCache> {
        const existing = this.caches.get(name);
        if (existing) return existing;
        const created = new FakeCache();
        this.caches.set(name, created);
        return created;
    }
    async keys(): Promise<string[]> { return [...this.caches.keys()]; }
    async delete(name: string): Promise<boolean> { return this.caches.delete(name); }
}

interface Harness {
    listeners: Map<string, ((event: unknown) => void)[]>;
    cacheStorage: FakeCacheStorage;
    /** Flip to make every network request fail, as an offline tab does. */
    offline: boolean;
    /** Path → body served while online. A miss is a 404. */
    network: Map<string, string>;
    fetchCalls: string[];
    /** Dispatch a fetch event and return whatever respondWith was handed, or
     *  null when the worker declined to intercept. */
    request(url: string, init?: { mode?: string; method?: string; origin?: boolean }): Promise<Response | null>;
    message(data: unknown): Promise<void>;
    activate(): Promise<void>;
    install(): Promise<void>;
}

function loadWorker(network: Record<string, string>): Harness {
    const listeners = new Map<string, ((event: unknown) => void)[]>();
    const cacheStorage = new FakeCacheStorage();
    const state = {
        offline: false,
        network: new Map(Object.entries(network)),
        fetchCalls: [] as string[],
    };

    const swFetch = async (request: RequestInfo): Promise<Response> => {
        const url = new URL(typeof request === 'string' ? request : (request as Request).url, SCOPE);
        state.fetchCalls.push(url.pathname);
        if (state.offline) throw new TypeError('Failed to fetch');
        const body = state.network.get(url.pathname);
        if (body === undefined) return new Response('nope', { status: 404 });
        // `type` is read-only on a real Response and always 'basic' for a
        // same-origin load; the worker checks it before caching. `Vary: Origin`
        // is what a static host really sends here — vite preview and GitHub
        // Pages both do.
        const response = new Response(body, { status: 200, headers: { Vary: 'Origin' } });
        Object.defineProperty(response, 'type', { value: 'basic' });
        return response;
    };
    (globalThis as { __swFetch?: typeof swFetch }).__swFetch = swFetch;

    // A worker resolves relative URLs against its own script URL and accepts the
    // `cache` init option; undici's Request does neither, so both are smoothed
    // over here. Neither is what any test is asserting on.
    class ScopedRequest extends Request {
        constructor(input: RequestInfo | URL, init?: RequestInit & { cache?: string }) {
            const url = typeof input === 'string' || input instanceof URL
                ? new URL(String(input), SCOPE).href
                : input;
            const { cache: _ignored, ...rest } = init ?? {};
            super(url as RequestInfo, rest);
        }
    }

    const context = createContext({
        self: {
            registration: { scope: SCOPE },
            location: new URL(`${SCOPE}vfs-sw.js`),
            skipWaiting: () => {},
            clients: { claim: async () => {}, matchAll: async () => [], get: async () => null },
            addEventListener: (type: string, fn: (event: unknown) => void) => {
                listeners.set(type, [...(listeners.get(type) ?? []), fn]);
            },
        },
        caches: cacheStorage,
        fetch: swFetch,
        Response, Request: ScopedRequest, Headers, URL, MessageChannel, setTimeout, clearTimeout, console,
    });
    runInContext(SW_SOURCE, context);

    const waits: Promise<unknown>[] = [];
    const fire = (type: string, event: Record<string, unknown>) => {
        for (const fn of listeners.get(type) ?? []) fn(event);
    };

    return {
        listeners,
        cacheStorage,
        get offline() { return state.offline; },
        set offline(value: boolean) { state.offline = value; },
        network: state.network,
        fetchCalls: state.fetchCalls,
        async request(url, init) {
            // `origin: true` is a `<script crossorigin>` / `<link crossorigin>`
            // fetch — the shape Vite's built HTML asks for its bundle in.
            const request = new Request(new URL(url, SCOPE), {
                method: init?.method ?? 'GET',
                headers: init?.origin ? { Origin: SCOPE.replace(/\/$/, '') } : undefined,
            });
            // `mode` is a read-only accessor on the prototype and always 'cors'
            // on a hand-built Request; an own property shadows it, which is the
            // only way to present the worker with a navigation.
            Object.defineProperty(request, 'mode', { value: init?.mode ?? 'cors' });
            let responded: Promise<Response> | null = null;
            fire('fetch', {
                request,
                respondWith: (value: Promise<Response>) => { responded = value; },
                clientId: '',
            });
            return responded ? await responded : null;
        },
        async message(data) {
            waits.length = 0;
            fire('message', { data, waitUntil: (p: Promise<unknown>) => waits.push(p) });
            await Promise.all(waits);
        },
        async activate() {
            waits.length = 0;
            fire('activate', { waitUntil: (p: Promise<unknown>) => waits.push(p) });
            await Promise.all(waits);
        },
        async install() {
            waits.length = 0;
            fire('install', { waitUntil: (p: Promise<unknown>) => waits.push(p) });
            await Promise.all(waits);
        },
    };
}

// `request.mode` can't be set on a hand-built Request, so the worker has to read
// it from the object it is given. Patch the fetch event's request with the mode
// the test wants by wrapping the harness.
function navigation(harness: Harness, url: string): Promise<Response | null> {
    return harness.request(url, { mode: 'navigate' });
}

const SHELL = '<!doctype html><title>Mudlet Web</title>';
const NETWORK = {
    '/': SHELL,
    '/assets/index-hf1D-FYj.js': 'console.log(1)',
    '/assets/index-A1b2C3d4.css': 'body{}',
    '/manifest.webmanifest': '{}',
    // The pcre2 WASM is emitted at the scope root under a fixed name, not into
    // assets/ — without it the Lua side can't compile a single trigger pattern.
    '/libpcre2.wasm': 'wasm-bytes',
};

describe('app shell service worker', () => {
    let sw: Harness;

    beforeEach(async () => {
        sw = loadWorker(NETWORK);
        await sw.install();
    });

    it('caches the shell on install so a navigation survives going offline', async () => {
        expect(sw.cacheStorage.caches.get('mudix-app-v1')?.entries.has(`${SCOPE}`)).toBe(true);

        sw.offline = true;
        const response = await navigation(sw, '/');
        expect(await response!.text()).toBe(SHELL);
    });

    it('answers a deep link from the same cached shell', async () => {
        sw.offline = true;
        const response = await navigation(sw, '/?profile=abc123');
        expect(await response!.text()).toBe(SHELL);
    });

    it('goes to the network for navigations while online, and refreshes the cache', async () => {
        sw.network.set('/', '<!doctype html>updated');
        expect(await (await navigation(sw, '/'))!.text()).toBe('<!doctype html>updated');

        sw.offline = true;
        expect(await (await navigation(sw, '/'))!.text()).toBe('<!doctype html>updated');
    });

    it('serves hashed assets from cache without a second network round-trip', async () => {
        const first = await sw.request('/assets/index-hf1D-FYj.js');
        expect(await first!.text()).toBe('console.log(1)');

        const before = sw.fetchCalls.length;
        const second = await sw.request('/assets/index-hf1D-FYj.js');
        expect(await second!.text()).toBe('console.log(1)');
        expect(sw.fetchCalls.length).toBe(before);
    });

    it('caches the fixed-name WASM at the scope root, and serves it offline', async () => {
        expect(await (await sw.request('/libpcre2.wasm'))!.text()).toBe('wasm-bytes');

        sw.offline = true;
        expect(await (await sw.request('/libpcre2.wasm'))!.text()).toBe('wasm-bytes');
    });

    it('refreshes a fixed-name file behind the cached copy', async () => {
        await sw.request('/libpcre2.wasm');
        sw.network.set('/libpcre2.wasm', 'newer-wasm-bytes');

        // Served from cache while the refresh is in flight...
        expect(await (await sw.request('/libpcre2.wasm'))!.text()).toBe('wasm-bytes');
        await new Promise(resolve => setTimeout(resolve, 0));
        // ...and the next read has the new bytes, without ever having waited.
        expect(await (await sw.request('/libpcre2.wasm'))!.text()).toBe('newer-wasm-bytes');
    });

    it('declines dev-server module URLs, so hot reload is never served a stale copy', async () => {
        expect(await sw.request('/src/main.tsx')).toBeNull();
        expect(await sw.request('/@vite/client')).toBeNull();
        expect(await sw.request('/node_modules/.vite/deps/react.js')).toBeNull();
    });

    it('leaves VFS reads to the VFS handler rather than the app cache', async () => {
        // No app tab to answer the round-trip, but it is the VFS path that
        // replied — not a 404 from the asset cache.
        const response = await sw.request('/__vfs/conn-1/logo.png');
        expect(response!.status).toBe(503);
    });

    it('does not intercept non-GET requests', async () => {
        expect(await sw.request('/assets/index-hf1D-FYj.js', { method: 'POST' })).toBeNull();
    });

    describe('precache from the page', () => {
        it('caches what the page reports, filtered to app assets', async () => {
            await sw.message({
                type: 'app:precache',
                build: '0.5.0+abc1234',
                urls: [
                    `${SCOPE}assets/index-hf1D-FYj.js`,
                    `${SCOPE}assets/index-A1b2C3d4.css`,
                    `${SCOPE}__vfs/conn-1/logo.png`,
                    'https://stats.mudlet.org/js/',
                ],
            });

            const cache = sw.cacheStorage.caches.get('mudix-app-v1')!;
            expect([...cache.entries.keys()].sort()).toEqual([
                `${SCOPE}`,
                `${SCOPE}__app-build`,
                `${SCOPE}assets/index-A1b2C3d4.css`,
                `${SCOPE}assets/index-hf1D-FYj.js`,
            ]);

            sw.offline = true;
            expect(await (await sw.request('/assets/index-A1b2C3d4.css'))!.text()).toBe('body{}');
        });

        it('serves a precached asset to the crossorigin request the HTML actually makes', async () => {
            // The regression this exists for: `cache.add()` stores a request
            // with no `Origin`, the parser sends one, the response says
            // `Vary: Origin`, and honouring that turns a full cache into a
            // blank page the moment the network is gone.
            await sw.message({
                type: 'app:precache',
                build: '0.5.0+abc1234',
                urls: [`${SCOPE}assets/index-hf1D-FYj.js`],
            });

            sw.offline = true;
            const response = await sw.request('/assets/index-hf1D-FYj.js', { origin: true });
            expect(response!.status).toBe(200);
            expect(await response!.text()).toBe('console.log(1)');
        });

        it('drops the previous build wholesale when the build id changes', async () => {
            await sw.message({
                type: 'app:precache',
                build: '0.5.0+abc1234',
                urls: [`${SCOPE}assets/index-hf1D-FYj.js`],
            });

            sw.network.delete('/assets/index-hf1D-FYj.js');
            sw.network.set('/assets/index-Zz9Yy8Xx.js', 'console.log(2)');
            await sw.message({
                type: 'app:precache',
                build: '0.6.0+def5678',
                urls: [`${SCOPE}assets/index-Zz9Yy8Xx.js`],
            });

            const cache = sw.cacheStorage.caches.get('mudix-app-v1')!;
            expect([...cache.entries.keys()]).not.toContain(`${SCOPE}assets/index-hf1D-FYj.js`);
            expect([...cache.entries.keys()]).toContain(`${SCOPE}assets/index-Zz9Yy8Xx.js`);
            // and the shell is back, not lost with the generation it was in
            expect([...cache.entries.keys()]).toContain(`${SCOPE}`);
        });

        it('leaves a working cache alone when the page reports nothing', async () => {
            await sw.message({
                type: 'app:precache',
                build: '0.5.0+abc1234',
                urls: [`${SCOPE}assets/index-hf1D-FYj.js`],
            });
            await sw.message({ type: 'app:precache', build: '0.6.0+def5678', urls: [] });

            const cache = sw.cacheStorage.caches.get('mudix-app-v1')!;
            expect([...cache.entries.keys()]).toContain(`${SCOPE}assets/index-hf1D-FYj.js`);
        });

        it('keeps going when one reported asset has since 404d', async () => {
            await sw.message({
                type: 'app:precache',
                build: '0.5.0+abc1234',
                urls: [`${SCOPE}assets/gone-00000000.js`, `${SCOPE}assets/index-hf1D-FYj.js`],
            });

            const cache = sw.cacheStorage.caches.get('mudix-app-v1')!;
            expect([...cache.entries.keys()]).toContain(`${SCOPE}assets/index-hf1D-FYj.js`);
        });
    });

    it('clears its own outdated caches on activate', async () => {
        await sw.cacheStorage.open('mudix-app-v0-stale');
        await sw.activate();
        expect(await sw.cacheStorage.keys()).not.toContain('mudix-app-v0-stale');
    });

    it('leaves the VFS cache alone on activate', async () => {
        await sw.cacheStorage.open('mudix-vfs-v1');
        await sw.activate();
        expect(await sw.cacheStorage.keys()).toContain('mudix-vfs-v1');
    });

    it('leaves another app on the origin alone — a branded build is a guest there', async () => {
        await sw.cacheStorage.open('acme-shop-images');
        await sw.activate();
        expect(await sw.cacheStorage.keys()).toContain('acme-shop-images');
    });
});

describe('primeAppShellCache', () => {
    beforeEach(() => { vi.resetModules(); });

    it('hands the active worker the build id and the resources the page loaded', async () => {
        const postMessage = vi.fn();
        vi.stubGlobal('navigator', {
            serviceWorker: { ready: Promise.resolve({ active: { postMessage } }) },
        });
        vi.stubGlobal('performance', {
            getEntriesByType: () => [
                { name: `${SCOPE}assets/index-hf1D-FYj.js` },
                { name: `${SCOPE}assets/index-A1b2C3d4.css` },
            ],
        });
        vi.stubGlobal('document', { readyState: 'complete' });

        vi.useFakeTimers();
        const { primeAppShellCache, SETTLE_MS } = await import('../../src/utils/appShellCache');
        const done = primeAppShellCache();
        // Nothing goes out until the page has had its chance to finish loading
        // whatever it loads late.
        await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
        expect(postMessage).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await done;
        vi.useRealTimers();

        expect(postMessage).toHaveBeenCalledTimes(1);
        const message = postMessage.mock.calls[0][0];
        expect(message.type).toBe('app:precache');
        expect(message.build).toMatch(/^\d+\.\d+\.\d+/);
        expect(message.urls).toEqual([
            `${SCOPE}assets/index-hf1D-FYj.js`,
            `${SCOPE}assets/index-A1b2C3d4.css`,
        ]);
        vi.unstubAllGlobals();
    });

    it('is a no-op in a browser without service workers', async () => {
        vi.stubGlobal('navigator', {});
        const { primeAppShellCache } = await import('../../src/utils/appShellCache');
        await expect(primeAppShellCache()).resolves.toBeUndefined();
        vi.unstubAllGlobals();
    });
});
