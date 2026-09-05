import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { resolve } from 'path';
import { buildDefine } from './buildInfo';

// LuaRuntime imports `wasmoon-lua5.1/dist/liblua5.1.wasm?url` and passes the
// result to Lua.create({customWasmUri}). In the app build that `?url` is a
// same-origin web URL Vite emits as an asset — correct. Under vitest it instead
// resolves to the root-relative web path `/node_modules/.../liblua5.1.wasm`,
// which wasmoon then hands to emscripten's node loader (fs.readFileSync). On
// Windows a leading-slash path reads from the drive root (`E:\node_modules\...`),
// so the WASM isn't found. Rewrite that one import to the file's absolute fs
// path — what wasmoon resolved to itself before customWasmUri was introduced.
function wasmoonWasmFsUrl(): Plugin {
  const abs = resolve('node_modules/wasmoon-lua5.1/dist/liblua5.1.wasm');
  return {
    name: 'wasmoon-wasm-fs-url',
    enforce: 'pre',
    resolveId(id) {
      if (id.includes('wasmoon-lua5.1/dist/liblua5.1.wasm') && id.includes('?url')) {
        return '\0wasmoon-wasm-fs-url';
      }
    },
    load(id) {
      if (id === '\0wasmoon-wasm-fs-url') {
        return `export default ${JSON.stringify(abs)};`;
      }
    },
  };
}

// Tests run through Vite, so the bundled Lua (`?raw` imports + the
// `import.meta.glob('./mudlet-lua/**/*.lua')`), JSON imports, and extensionless
// TS imports resolve exactly as in the app build. happy-dom supplies the
// document / window / localStorage that ScriptingAPI touches; wasmoon's WASM is
// loaded from node's filesystem.
export default defineConfig({
  plugins: [wasmoonWasmFsUrl()],
  // A Mudlet package archive is a zip, not source — LuaRuntime carries the
  // busted fixture archives into the VFS with `?inline`, which reaches the
  // asset pipeline and needs the extension declared. The app build gets this
  // from the mudix Vite plugin; the test runner doesn't load that plugin.
  // The map fixtures are plain `.zip`; scoped to the fixture tree so a bare
  // `.zip` import anywhere else keeps meaning what it means today.
  assetsInclude: ['**/*.mpackage', '**/specs/fixtures/**/*.zip'],
  // Same build-time constants the app/lib builds inject, so src/version.ts
  // resolves under test instead of throwing on an undefined global.
  define: buildDefine(),
  test: {
    // Default DOM env for future component tests; runtime/Lua suites opt into
    // the node environment per-file (`// @vitest-environment node`) so the WASM
    // libraries load from the filesystem.
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // wasmoon WASM init + bundled-Lua load is ~1s on a cold runtime.
    testTimeout: 20000,
    server: {
      deps: {
        // Emscripten glue in pcre2-wasm-universal uses __dirname, which is
        // undefined when node loads the package's "type":"module" files as ESM.
        // Inlining routes it through Vite's transform, which shims __dirname/
        // __filename so the WASM resolves + loads from node_modules via fs.
        inline: ['pcre2-wasm-universal'],
      },
    },
  },
});
