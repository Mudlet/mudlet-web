// Assets the library build ships as plain files next to the bundle:
// - vfs-sw.js: emitted into consumer builds by the mudix/vite plugin.
// - default-package archives: referenced from dist-lib/index.js as external
//   relative `?url` imports (see vite.lib.config.ts), resolved and emitted by the
//   consumer's Vite. Rollup rewrites those specifiers relative to the output
//   root, so each file has to land at the same path under dist-lib that it has
//   under src.
//
// Only the archives defaultPackages.ts actually imports are copied, not all of
// src/import/defaults/ — that directory mirrors every package Mudlet ships
// (~5 MB), and vendoring one is not preinstalling it. The list is read straight
// out of defaultPackages.ts so adding a default can't silently miss this step.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULTS_SRC = 'src/import/defaultPackages.ts';

// Every `from './defaults/…?url'` in defaultPackages.ts, as a path under src/.
const assets = [...readFileSync(DEFAULTS_SRC, 'utf8')
    .matchAll(/from\s+'\.\/(defaults\/[^']+?)\?url'/g)]
    .map(m => `import/${m[1]}`);
if (!assets.length) throw new Error(`no ?url default-package imports found in ${DEFAULTS_SRC}`);

mkdirSync('dist-lib', { recursive: true });
copyFileSync('public/vfs-sw.js', 'dist-lib/vfs-sw.js');
for (const rel of assets) {
    mkdirSync(`dist-lib/${dirname(rel)}`, { recursive: true });
    copyFileSync(`src/${rel}`, `dist-lib/${rel}`);
}
console.log(`copy-lib-assets: vfs-sw.js + ${assets.length} default-package asset(s)`);
