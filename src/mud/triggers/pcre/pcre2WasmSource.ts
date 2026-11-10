/**
 * Fetches libpcre2.wasm, the module wasm/pcre2/build.sh builds.
 *
 * It is served from beside the page (`libpcre2.wasm`), where the Mudlet Web
 * Vite plugin serves it in dev and emits it in a build — the app's and any
 * consumer's alike (see pcre2WasmPlugin in vite-plugin/vite.ts). Resolving it
 * against the page, not the bundle, keeps that one path right for both, and
 * the app-shell service worker caches it there.
 *
 * Under vitest this module is swapped for tests/support/pcre2WasmSource.ts,
 * which reads the file from disk (see vitest.config.ts).
 */
export async function loadPcre2Wasm(): Promise<ArrayBuffer> {
    const url = new URL('libpcre2.wasm', globalThis.location.href);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not load ${url}: HTTP ${res.status}`);
    return res.arrayBuffer();
}
