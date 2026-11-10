import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Plugin, PluginOption } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

/**
 * The `@mudlet/mudlet-web/vite` companion plugin. The library leaves all of its
 * heavyweight dependencies external, so the consumer's Vite processes them —
 * and needs the same handling the app build has: the pcre2 WASM file
 * at the site root, node polyfills on the main thread and in workers, and the
 * VFS service worker emitted into the output. One plugin call supplies all of
 * it:
 *
 *     import mudletWeb from '@mudlet/mudlet-web/vite';
 *     export default defineConfig({ plugins: [mudletWeb(), react()] });
 *
 * Mudlet Web's own vite.config.ts uses this plugin too (imported from source), so
 * the app build and consumer builds can't drift apart.
 */

const POLYFILLS: ('buffer' | 'stream' | 'events' | 'util')[] = ['buffer', 'stream', 'events', 'util'];

/** The static files the app needs at its root (vfs-sw.js, oauth-callback.html)
 *  ship next to the compiled plugin in dist-lib (consumers) and in public/ when
 *  running from the Mudlet Web repo itself (source import). */
function resolveStaticPath(name: string): string | null {
    for (const rel of [`./${name}`, `../public/${name}`]) {
        const p = fileURLToPath(new URL(rel, import.meta.url));
        if (existsSync(p)) return p;
    }
    return null;
}

/** Serves libpcre2.wasm (built by wasm/pcre2/build.sh) beside the page in dev,
 *  and emits it to the build output there, which is where pcre2WasmSource.ts
 *  fetches it from. Found next to the compiled plugin in dist-lib (consumers;
 *  copy-lib-assets puts it there) or in wasm/pcre2/ when running from the
 *  Mudlet Web repo itself. */
function pcre2WasmPlugin(): Plugin {
    const wasmPath = [`./libpcre2.wasm`, `../wasm/pcre2/libpcre2.wasm`]
        .map(rel => fileURLToPath(new URL(rel, import.meta.url)))
        .find(p => existsSync(p));
    if (!wasmPath) throw new Error('mudlet:pcre2-wasm: libpcre2.wasm not found next to the plugin or in wasm/pcre2/');
    const wasm = (): Uint8Array => readFileSync(wasmPath);
    return {
        name: 'mudlet:pcre2-wasm',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (req.url === '/libpcre2.wasm') {
                    res.setHeader('Content-Type', 'application/wasm');
                    res.end(wasm());
                    return;
                }
                next();
            });
        },
        generateBundle() {
            this.emitFile({
                type: 'asset',
                fileName: 'libpcre2.wasm',
                source: wasm(),
            });
        },
    };
}

/** Serves/emits a static file at the site root. Used for the VFS service
 *  worker, so `registerVfsServiceWorker()` (called by MudletWebApp) finds it,
 *  and for `oauth-callback.html`, the redirect target of the client-driven GMCP
 *  `Char.Login` browser sign-in (see oauthClientFlow.ts). Skipped when the
 *  consumer already ships its own copy in public/ — as the standalone Mudlet
 *  Web app does. */
function rootStaticFilePlugin(name: string, contentType: string): Plugin {
    const filePath = resolveStaticPath(name);
    let skip = false;
    return {
        name: `mudlet:static:${name}`,
        configResolved(config) {
            skip = !filePath || (!!config.publicDir && existsSync(join(config.publicDir, name)));
        },
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (!skip && filePath && req.url?.split('?')[0] === `/${name}`) {
                    res.setHeader('Content-Type', contentType);
                    res.end(readFileSync(filePath));
                    return;
                }
                next();
            });
        },
        generateBundle() {
            if (skip || !filePath) return;
            this.emitFile({
                type: 'asset',
                fileName: name,
                source: readFileSync(filePath, 'utf8'),
            });
        },
    };
}

export default function mudlet(): PluginOption[] {
    return [
        {
            name: 'mudlet:config',
            config: () => ({
                resolve: {
                    // Exactly one instance of each, always. `mudlet-map-editor`
                    // used to declare these as plain *dependencies*, so the
                    // moment its range outran the range the app resolved, the
                    // package manager nested a second copy under the editor.
                    // The editor's `App` was then rendered by Mudlet Web's React
                    // while its hooks came from the nested one, whose
                    // dispatcher is null — "Invalid hook call", and with no
                    // error boundary above the lazy boundary the throw
                    // unmounts the whole root, so opening the map editor
                    // blanked the entire UI in dev and in production alike.
                    // Editor 2.0.0 makes all of them peer dependencies, which
                    // is the fix at the source; this stays as the backstop that
                    // does not depend on the package manager hoisting correctly
                    // — and consumers of the library (which externalizes react)
                    // get it through this plugin too. Konva and the renderer
                    // are here for the same reason and not only for symmetry:
                    // two Konvas split the stage registry, and two renderers
                    // disagree on scene structure, both silently.
                    dedupe: ['react', 'react-dom', 'konva', 'mudlet-map-renderer'],
                },
                // A Mudlet package archive is a zip, not source. `?url` imports
                // get away without this (the explicit query short-circuits
                // import analysis), but `?inline` — which the busted fixtures
                // use to carry an archive into the VFS — reaches the asset
                // pipeline and needs the extension declared.
                // The map fixtures are plain `.zip` and binary `.dat`, and scoping
                // those to the fixture tree keeps a bare import of either anywhere
                // else meaning what it means today.
                assetsInclude: ['**/*.mpackage', '**/specs/fixtures/**/*.zip', '**/specs/fixtures/**/*.dat'],
                optimizeDeps: {
                    // 'Mudlet Web': the library entry carries relative `?url` asset
                    // imports (external in the lib build); the dep optimizer's
                    // scanner treats the query as part of a filesystem path and
                    // dies on Windows (os error 123). Excluded, Mudlet Web is served
                    // through Vite's transform pipeline in dev, where `?url`
                    // works. Harmless in Mudlet Web's own repo (not a dep there).
                    exclude: ['@mudlet/mudlet-web'],
                    // CJS deps reached from the excluded Mudlet Web entry must be
                    // pre-bundled explicitly (Vite doesn't interop CJS served
                    // raw). Extend this list if dev mode reports "does not
                    // provide an export named ..." for another dependency.
                    //
                    // 'mudlet-map-editor' stands for its whole subtree rather
                    // than the individual CJS leaves: the editor pulls in
                    // react-i18next, whose own deps (use-sync-external-store,
                    // html-parse-stringify > void-elements) are CJS, and which
                    // of them trips first depends on evaluation order. Listing
                    // the editor pre-bundles the lot in one go — and mirrors
                    // Mudlet Web's own dev server, where the scanner finds the
                    // `import('mudlet-map-editor')` in MapEditorModal and
                    // pre-bundles it anyway. Bare package names only, no
                    // subpaths: `mudlet-map-renderer/bigmap` and friends only
                    // exist in newer versions, and an unresolvable `include`
                    // entry is a hard dev-server startup failure.
                    include: [
                        'eventemitter3',
                        'wasmoon-lua5.1',
                        '@zenfs/core > readable-stream',
                        'mudlet-map-editor',
                    ],
                },
                // Workers don't inherit `plugins`; re-declare nodePolyfills so
                // the map parser worker (Buffer) gets the same shim it gets on
                // the main thread.
                worker: {
                    format: 'es' as const,
                    plugins: () => [nodePolyfills({ include: POLYFILLS })],
                },
            }),
        },
        nodePolyfills({ include: POLYFILLS }),
        pcre2WasmPlugin(),
        rootStaticFilePlugin('vfs-sw.js', 'text/javascript'),
        rootStaticFilePlugin('oauth-callback.html', 'text/html; charset=utf-8'),
    ];
}
