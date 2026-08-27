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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
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

// Everything the bundle still imports by relative path has to exist in
// dist-lib, because nothing downstream will tell us otherwise: rollup leaves
// externalised specifiers untouched, this build reports success, and the
// failure surfaces only when a consumer runs `vite build` and gets
// UNRESOLVED_IMPORT for a file that was never published. That shipped once —
// the busted `.mpackage` fixtures were externalised by extension and are test
// data nobody copies (see isExternal in vite.lib.config.ts) — so verify it
// here, where the fix is one commit rather than a release.
const jsFiles = [];
const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) jsFiles.push(full);
    }
};
walk('dist-lib');

// `from './x'`, bare `import './x'`, and `import('./x')` alike; the query
// (`?url`, `?inline`) is part of the specifier but not of the filename.
const SPECIFIER = /(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g;
const missing = [];
for (const file of jsFiles) {
    const dir = dirname(file);
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
        const target = `${dir}/${spec.split('?')[0]}`;
        if (!existsSync(target)) missing.push(`${file} -> ${spec}`);
    }
}
if (missing.length) {
    throw new Error(
        `dist-lib imports ${missing.length} file(s) it does not ship — consumer builds ` +
        `would fail with UNRESOLVED_IMPORT:\n  ${missing.join('\n  ')}\n` +
        'Either copy the file here, or stop externalising it in vite.lib.config.ts.',
    );
}
console.log(`copy-lib-assets: ${jsFiles.length} emitted file(s) resolve cleanly`);
