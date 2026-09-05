// The Mudlet Web service worker. Two jobs that share nothing but this file:
//
//  1. ProfileVFS-backed assets at /__vfs/<connectionId>/<path>. The page is the
//     source of truth for VFS contents (the SW can't share folder handles or
//     always-open the same IDB store), so each request round-trips to the client
//     via MessageChannel.
//
//  2. The app shell — the built HTML, JS, CSS and WASM — cached so an installed
//     Mudlet Web opens offline instead of the browser's error page. There is no
//     game to play without a network, but profiles, scripts, triggers, maps and
//     logs all live in browser storage, and reaching them shouldn't need one.
//     The manifest has advertised `display: standalone` since day one; this is
//     what backs the promise (issue #71).

const CACHE_NAME = 'mudix-vfs-v1';
const APP_CACHE = 'mudix-app-v1';
// Scope path always ends with '/'. On a root-served deploy this is '/'; on
// GitHub Pages or any subpath deploy it's '/<repo>/'. The intercept prefix is
// '<scope>__vfs/' so SW-controlled URLs stay inside scope.
const SCOPE_PATH = new URL(self.registration.scope).pathname;
const PREFIX = `${SCOPE_PATH}__vfs/`;
// The one entry every navigation resolves to. Deep links (?profile=<id>) must
// not each earn a cache entry of their own, and any of them is served by this
// same document.
const SHELL_URL = SCOPE_PATH;
// Where the build id of the cached generation is kept — inside the cache it
// describes, so it survives the SW being killed and restarted without a second
// storage API. `__`-prefixed like `__vfs/`, which no real asset path uses.
const BUILD_KEY = `${SCOPE_PATH}__app-build`;
const READ_TIMEOUT_MS = 5000;
// Whether this registration is allowed to cache the app at all. Set from the
// script URL by the page (`vfs-sw.js?app-shell=1`), which only a built app asks
// for — a dev server has no content-hashed assets to cache, and caching the
// files it does serve under fixed names is cost with no offline to show for it.
// It has to be known here, at evaluation time, because the first fetch event can
// arrive long before any message from the page.
const APP_SHELL = new URL(self.location.href).searchParams.get('app-shell') === '1';

// What may be cached as part of the app. Deliberately narrow rather than
// "anything same-origin": it admits Vite's content-hashed output and the static
// files index.html names, and nothing else. That is also what keeps `yarn dev`
// honest — a dev server serves modules from /src/, /@vite/ and /node_modules/,
// none of which match, so hot reload never races a cached copy.
const HASHED_ASSET = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/;
// The handful of app files that keep a fixed name: the icons and manifest
// index.html points at, and the WASM the plugin emits at the scope root
// (libpcre2.wasm) rather than into assets/.
const STATIC_FILE = /\/(?:manifest\.webmanifest|icon[a-z0-9-]*\.(?:svg|png)|favicon\.ico|[^/]+\.wasm)$/;

// Every app-cache lookup ignores Vary, and it is not an optimisation — without
// it the app does not load offline at all. Static hosts answer these files with
// `Vary: Origin` (vite preview and GitHub Pages both do), and Vite's built HTML
// asks for its bundle with `crossorigin`, so the parser's request carries an
// `Origin` header that the copy stored by `cache.add()` does not. Cache matching
// then declares them different requests, the cache misses, and the fetch behind
// it fails with the network gone — a blank page, from a cache holding exactly
// the right bytes under exactly the right URL. None of these responses actually
// differ by origin: they are static files on one origin.
const MATCH = { ignoreVary: true };

function inScope(url) {
    return url.origin === self.location.origin
        && url.pathname.startsWith(SCOPE_PATH)
        && !url.pathname.startsWith(PREFIX);
}

function isAppAsset(url) {
    return inScope(url) && (HASHED_ASSET.test(url.pathname) || STATIC_FILE.test(url.pathname));
}

self.addEventListener('install', (event) => {
    self.skipWaiting();
    if (APP_SHELL) event.waitUntil(cacheShell());
});

self.addEventListener('activate', (event) => event.waitUntil((async () => {
    // Anything left by an older worker of ours under a name this one no longer
    // uses. Scoped to the `mudix-` prefix rather than "every cache on the
    // origin": a branded build embeds this worker in somebody else's site, and
    // their caches are none of our business.
    const names = await caches.keys();
    await Promise.all(names
        .filter((n) => n.startsWith('mudix-') && n !== CACHE_NAME && n !== APP_CACHE)
        .map((n) => caches.delete(n)));
    await self.clients.claim();
})()));

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith(PREFIX)) {
        event.respondWith(handle(event, url));
        return;
    }
    if (!APP_SHELL) return;
    // Navigations go to the network first, so a deploy is picked up on the next
    // load rather than whenever the cache happens to turn over; the cached shell
    // is strictly the offline answer.
    if (request.mode === 'navigate' && url.pathname.startsWith(SCOPE_PATH)) {
        event.respondWith(shellFirst(request));
        return;
    }
    if (!inScope(url)) return;
    // Hashed filenames are immutable by construction: a changed file is a
    // changed URL, so a hit is never stale and revalidating one would be a
    // round-trip spent to be told nothing.
    if (HASHED_ASSET.test(url.pathname)) event.respondWith(cacheFirst(request));
    // The fixed-name files can change under the same URL, so they are answered
    // from the cache and refreshed behind it — offline-proof without ever
    // pinning a stale icon or an old libpcre2.wasm to a dev server.
    else if (STATIC_FILE.test(url.pathname)) event.respondWith(staleWhileRevalidate(request));
});

async function cacheShell() {
    try {
        const cache = await caches.open(APP_CACHE);
        // `reload` so an install triggered by a reload of a stale page doesn't
        // seed the cache from the HTTP cache's copy of the old document.
        await cache.put(SHELL_URL, await fetch(new Request(SHELL_URL, { cache: 'reload' })));
    } catch {
        // Installed while offline, or the shell 404s under this scope. The first
        // successful navigation fills it in.
    }
}

async function shellFirst(request) {
    const cache = await caches.open(APP_CACHE);
    try {
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') {
            cache.put(SHELL_URL, response.clone()).catch(() => {});
        }
        return response;
    } catch {
        return (await cache.match(SHELL_URL, MATCH)) ?? Response.error();
    }
}

async function cacheFirst(request) {
    const cache = await caches.open(APP_CACHE);
    const hit = await cache.match(request, MATCH);
    if (hit) return hit;
    try {
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') {
            cache.put(request, response.clone()).catch(() => {});
        }
        return response;
    } catch {
        return Response.error();
    }
}

async function staleWhileRevalidate(request) {
    const cache = await caches.open(APP_CACHE);
    const hit = await cache.match(request, MATCH);
    const network = fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
            cache.put(request, response.clone()).catch(() => {});
        }
        return response;
    });
    if (hit) {
        // Let the refresh finish after the response has gone out.
        network.catch(() => {});
        return hit;
    }
    try {
        return await network;
    } catch {
        return Response.error();
    }
}

/**
 * Cache everything the page has already loaded, on the page's say-so.
 *
 * A first visit is not controlled by the worker until it claims, by which time
 * the bundle has been fetched uncached — so without this, offline would only
 * work from the *second* visit. The page sends the resource list it actually
 * loaded (chunks and WASM included), which is more than this file could guess.
 * Chunks loaded lazily later in an uncontrolled first session are the one gap,
 * and they are picked up by `cacheFirst` on the next visit.
 */
async function precacheApp({ build, urls }) {
    let cache = await caches.open(APP_CACHE);
    const wanted = (Array.isArray(urls) ? urls : []).filter((raw) => {
        try { return isAppAsset(new URL(raw, self.location.href)); } catch { return false; }
    });
    // A deploy renames every hashed asset, so the previous generation's entries
    // are unreachable dead weight — drop the lot rather than grow forever.
    // Keyed off the *app's* build id, not a constant in this file: this file
    // changes about once a year, so a version bumped here would never fire.
    //
    // Only ever on a list with something in it. An empty one means the page
    // could not enumerate what it loaded, and emptying a working cache on the
    // strength of that would leave the app less able to open offline than
    // before, which is the opposite of the point.
    const stamped = await cache.match(BUILD_KEY, MATCH);
    if (wanted.length > 0 && (stamped ? await stamped.text() : null) !== build) {
        await caches.delete(APP_CACHE);
        cache = await caches.open(APP_CACHE);
        await cache.put(BUILD_KEY, new Response(build));
        await cacheShell();
    }
    await Promise.all(wanted.map(async (url) => {
        if (await cache.match(url, MATCH)) return;
        // One asset that has since 404'd must not take the rest with it, which
        // is what cache.addAll() would do.
        try { await cache.add(url); } catch { /* keep going */ }
    }));
}

async function handle(event, url) {
    const rest = url.pathname.slice(PREFIX.length).split('/').filter(Boolean);
    if (rest.length < 2) return new Response('Bad request', { status: 400 });
    const connectionId = decodeURIComponent(rest[0]);
    const filePath = '/' + rest.slice(1).map(decodeURIComponent).join('/');

    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    if (cached) return cached;

    const client = await pickClient(event);
    if (!client) {
        // Either there's no app tab loaded (direct URL hit in fresh tab) or
        // the only candidate is the tab currently navigating to this URL.
        return new Response('No app tab loaded; open mudix first', { status: 503 });
    }

    const reply = await ask(client, { type: 'vfs:read', connectionId, path: filePath });
    if (!reply || !reply.ok) {
        return new Response(reply?.error ?? 'Not found', { status: 404 });
    }

    const headers = new Headers();
    headers.set('Content-Type', reply.contentType || 'application/octet-stream');
    // no-store keeps this response out of the browser's own HTTP cache, which
    // has no validator to revalidate against (we set none) and would otherwise
    // race our explicit Cache Storage entry above — that race is what produced
    // stale 304-with-no-body responses for cached images. The Cache Storage
    // entry (invalidated on writes via postMessage) is the only cache that
    // should own this decision.
    headers.set('Cache-Control', 'no-store');
    const response = new Response(reply.bytes, { headers });
    cache.put(event.request, response.clone()).catch(() => {});
    return response;
}

async function pickClient(event) {
    // Prefer the client that issued this request — for sub-resource fetches
    // that's the loaded app page, which can reply immediately.
    const requestingId = event.clientId || event.resultingClientId || '';
    if (requestingId) {
        const c = await self.clients.get(requestingId);
        if (c && isUsable(c)) return c;
    }
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const usable = all.filter(isUsable);
    return usable.find((c) => c.focused) ?? usable[0] ?? null;
}

// Skip clients that are themselves navigating to a /__vfs/ URL — those are
// fresh tabs in the middle of loading the SW response; they have no JS running
// and can't reply, so picking one guarantees a timeout.
function isUsable(client) {
    try {
        return !new URL(client.url).pathname.startsWith(PREFIX);
    } catch {
        return false;
    }
}

function ask(client, message) {
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => {
            channel.port1.close();
            resolve({ ok: false, error: 'timeout' });
        }, READ_TIMEOUT_MS);
        channel.port1.onmessage = (e) => {
            clearTimeout(timer);
            channel.port1.close();
            resolve(e.data);
        };
        client.postMessage(message, [channel.port2]);
    });
}

self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === 'vfs:invalidate') {
        event.waitUntil(invalidate(data));
    } else if (data.type === 'app:precache' && APP_SHELL) {
        event.waitUntil(precacheApp(data));
    }
});

async function invalidate({ connectionId, path }) {
    if (!connectionId) {
        await caches.delete(CACHE_NAME);
        return;
    }
    const cache = await caches.open(CACHE_NAME);
    const connPrefix = `${PREFIX}${encodeURIComponent(connectionId)}/`;
    const keys = await cache.keys();
    if (path) {
        const segs = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
        const target = `${connPrefix}${segs}`;
        await Promise.all(
            keys
                .filter((req) => new URL(req.url).pathname === target)
                .map((req) => cache.delete(req)),
        );
        return;
    }
    await Promise.all(
        keys
            .filter((req) => new URL(req.url).pathname.startsWith(connPrefix))
            .map((req) => cache.delete(req)),
    );
}
