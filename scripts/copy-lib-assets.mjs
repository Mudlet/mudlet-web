// Assets the library build ships as plain files next to the bundle:
// - vfs-sw.js: emitted into consumer builds by the mudix/vite plugin.
// - *.mpackage: referenced from dist-lib/index.js as external relative `?url`
//   imports (see vite.lib.config.ts), resolved and emitted by the consumer's
//   Vite. Rollup rewrites those specifiers relative to the output root, so each
//   file has to land at the same path under dist-lib that it has under src.
import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// defaultPackages.ts entries that live in the vendored mudlet-lua mirror rather
// than in import/defaults/ — each keeps its source-relative path under dist-lib.
const VENDORED_MPACKAGES = [
    'scripting/lua/mudlet-lua/generic-mapper/generic_mapper.mpackage',
    'scripting/lua/mudlet-lua/base-ui/mudlet-base-ui.mpackage',
];

mkdirSync('dist-lib/import/defaults', { recursive: true });
copyFileSync('public/vfs-sw.js', 'dist-lib/vfs-sw.js');
cpSync('src/import/defaults', 'dist-lib/import/defaults', { recursive: true });
for (const rel of VENDORED_MPACKAGES) {
    mkdirSync(`dist-lib/${dirname(rel)}`, { recursive: true });
    copyFileSync(`src/${rel}`, `dist-lib/${rel}`);
}
