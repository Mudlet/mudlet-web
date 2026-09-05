import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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

const require = createRequire(import.meta.url);

const POLYFILLS: ('buffer' | 'stream' | 'events' | 'util')[] = ['buffer', 'stream', 'events', 'util'];

/** vfs-sw.js ships next to the compiled plugin in dist-lib (consumers) and in
 *  public/ when running from the mudix repo itself (source import). */
function resolveVfsSwPath(): string | null {
    for (const rel of ['./vfs-sw.js', '../public/vfs-sw.js']) {
        const p = fileURLToPath(new URL(rel, import.meta.url));
        if (existsSync(p)) return p;
    }
    return null;
}

/** Serves libpcre2.wasm at the root URL in dev (where emscripten looks for it
 *  when document.currentScript is null) and emits it to the build output.
 *  Resolved from wherever pcre2-wasm-universal lives relative to mudix. */
function pcre2WasmPlugin(): Plugin {
    // The wasm file isn't in the package's exports map — resolve the exported
    // ./libpcre2 entry (dist/libpcre2.js) and take its sibling.
    const wasmPath = join(dirname(require.resolve('pcre2-wasm-universal/libpcre2')), 'libpcre2.wasm');
    return {
        name: 'mudix:pcre2-wasm',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (req.url === '/libpcre2.wasm') {
                    res.setHeader('Content-Type', 'application/wasm');
                    res.end(readFileSync(wasmPath));
                    return;
                }
                next();
            });
        },
        generateBundle() {
            this.emitFile({
                type: 'asset',
                fileName: 'libpcre2.wasm',
                source: readFileSync(wasmPath),
            });
        },
    };
}

/** Serves/emits the VFS service worker at the site root so
 *  `registerVfsServiceWorker()` (called by MudletWebApp) finds it. Skipped when
 *  the consumer already ships its own copy in public/ — as the standalone
 *  mudix app does. */
function vfsServiceWorkerPlugin(): Plugin {
    const swPath = resolveVfsSwPath();
    let skip = false;
    return {
        name: 'mudix:vfs-sw',
        configResolved(config) {
            skip = !swPath || (!!config.publicDir && existsSync(join(config.publicDir, 'vfs-sw.js')));
        },
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (!skip && swPath && req.url?.split('?')[0] === '/vfs-sw.js') {
                    res.setHeader('Content-Type', 'text/javascript');
                    res.end(readFileSync(swPath));
                    return;
                }
                next();
            });
        },
        generateBundle() {
            if (skip || !swPath) return;
            this.emitFile({
                type: 'asset',
                fileName: 'vfs-sw.js',
                source: readFileSync(swPath, 'utf8'),
            });
        },
    };
}

export default function mudix(): PluginOption[] {
    return [
        {
            name: 'mudix:config',
            config: () => ({
                resolve: {
                    // Exactly one React instance, always. `mudlet-map-editor`
                    // declares react/react-dom as plain *dependencies* (not
                    // peers), so the moment its range outruns the range the
                    // app resolved, the package manager nests a second copy
                    // under the editor. The editor's `App` is then rendered by
                    // mudix's React while its hooks come from the nested one,
                    // whose dispatcher is null — "Invalid hook call", and with
                    // no error boundary above the lazy boundary the throw
                    // unmounts the whole root, so opening the map editor
                    // blanked the entire UI in dev and in production alike.
                    // Deduping is the structural fix: it survives the next
                    // version skew, and consumers of the library (which
                    // externalizes react) get it through this plugin too.
                    dedupe: ['react', 'react-dom'],
                },
                // A Mudlet package archive is a zip, not source. `?url` imports
                // get away without this (the explicit query short-circuits
                // import analysis), but `?inline` — which the busted fixtures
                // use to carry an archive into the VFS — reaches the asset
                // pipeline and needs the extension declared.
                // The map fixtures are plain `.zip`, and scoping that to the
                // fixture tree keeps a bare `.zip` import anywhere else meaning
                // what it means today.
                assetsInclude: ['**/*.mpackage', '**/specs/fixtures/**/*.zip'],
                optimizeDeps: {
                    // 'mudix': the library entry carries relative `?url` asset
                    // imports (external in the lib build); the dep optimizer's
                    // scanner treats the query as part of a filesystem path and
                    // dies on Windows (os error 123). Excluded, mudix is served
                    // through Vite's transform pipeline in dev, where `?url`
                    // works. Harmless in mudix's own repo (not a dep there).
                    exclude: ['pcre2-wasm-universal', '@mudlet/mudlet-web'],
                    // CJS deps reached from the excluded mudix entry must be
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
                    // mudix's own dev server, where the scanner finds the
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
                build: {
                    rollupOptions: {
                        onwarn(warning, defaultHandler) {
                            if (
                                warning.code === 'COMMONJS_VARIABLE_IN_ESM' &&
                                warning.id?.includes('pcre2-wasm-universal')
                            ) {
                                return;
                            }
                            defaultHandler(warning);
                        },
                    },
                },
            }),
        },
        nodePolyfills({ include: POLYFILLS }),
        pcre2WasmPlugin(),
        vfsServiceWorkerPlugin(),
    ];
}
