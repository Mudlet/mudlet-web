// Telling the service worker what this build is made of, so it can be opened
// offline.
//
// The worker caches the app shell on its own once it controls a page, but a
// first visit finishes loading the bundle *before* the worker claims it — so
// left to itself, offline would only start working on the second visit. The
// page knows exactly what it loaded, chunks and WASM included, and says so.
//
// The build id rides along because a deploy renames every hashed asset: the
// worker drops the previous generation wholesale when the id changes, which is
// the only thing keeping the cache from growing forever. See public/vfs-sw.js.

import { CLIENT_VERSION, GIT_COMMIT } from '../version';

/**
 * Whether this build wants its shell cached at all.
 *
 * Only a built app does. A dev server has no content-hashed assets to cache
 * anyway, and the caching it *could* do — the icons, the manifest, the WASM the
 * plugin serves at the root — is pure cost there: a second copy written on every
 * boot, and a hot-reload hazard for the one file that isn't content-addressed.
 * It is measurable cost, too. The busted corpus boots the whole app 41 times in
 * parallel contexts, and on a four-core CI runner the extra work per boot was
 * enough to push readiness past its 90s timeout.
 *
 * Read at the two edges rather than inside the functions below, so the worker's
 * registration URL and the page's decision to speak to it can't disagree.
 */
export const appShellCacheEnabled: boolean = import.meta.env.PROD;

/** Identifies the deployed build. The commit is empty in a tarball install, so
 *  the version alone has to be able to carry it. */
const BUILD_ID = GIT_COMMIT ? `${CLIENT_VERSION}+${GIT_COMMIT}` : CLIENT_VERSION;

/** Everything the document has fetched so far, as absolute URLs. The worker
 *  filters this down to what it is willing to cache; sending the lot keeps the
 *  rule about *what* is app content in one place. */
function loadedResources(): string[] {
    if (typeof performance === 'undefined' || !performance.getEntriesByType) return [];
    try {
        return performance.getEntriesByType('resource').map(e => e.name);
    } catch {
        return [];
    }
}

/**
 * Hand the active worker this build's resource list, once the page has settled.
 * Safe to call when there is no worker, no support, or nothing loaded — it is a
 * best-effort optimisation of a cache the worker also fills on its own.
 */
export async function primeAppShellCache(): Promise<void> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    // After load *and* after the page has gone quiet. `load` is too early: the
    // WASM the Lua and regex engines are built on is still in flight then, and
    // this list is what the worker refills from after a deploy — sending a
    // half-finished one would drop pcre2 out of the cache until the next visit.
    await documentLoaded();
    await settled();
    try {
        const registration = await navigator.serviceWorker.ready;
        // `active` rather than `controller`: on the very first visit the worker
        // has not claimed this page yet, and that is precisely the visit whose
        // resource list is worth having.
        registration.active?.postMessage({
            type: 'app:precache',
            build: BUILD_ID,
            urls: loadedResources(),
        });
    } catch {
        // No registration (unsupported, or blocked by the browser's storage
        // settings). Nothing to prime.
    }
}

function documentLoaded(): Promise<void> {
    if (typeof document === 'undefined' || document.readyState === 'complete') return Promise.resolve();
    return new Promise(resolve => {
        window.addEventListener('load', () => resolve(), { once: true });
    });
}

/** How long after load to let stragglers arrive before taking the snapshot.
 *  A flat wait rather than an idle callback: the browser counts as idle while a
 *  WASM download is still in flight, which is exactly the case this is for. */
export const SETTLE_MS = 5000;

function settled(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, SETTLE_MS));
}
