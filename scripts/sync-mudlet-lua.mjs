// Re-sync the bundled Mudlet Lua tree (`src/scripting/lua/mudlet-lua/`) from
// upstream Mudlet.
//
// Sibling of sync-mudlet-specs.mjs, but with one structural difference: the spec
// corpus is a pure mirror, and this tree is not. mudix has to diverge from
// upstream in a handful of places (no MMCP in a browser tab, a coroutine-aware
// pcall for invokeFileDialog, …). Rather than let those edits sit in the tree as
// invisible drift, every one of them lives as a patch file under
// `scripts/mudlet-lua-patches/`, and this script does:
//
//   copy upstream verbatim  →  re-apply each patch  →  report what moved
//
// So the vendored tree stays reconstructible from (upstream commit + patches),
// and `git diff` after a sync shows exactly what Mudlet changed. A patch that no
// longer applies is a hard failure, not a silent skip — see --make-patch.
//
//   yarn sync:mudlet-lua                   # from GitHub, development branch
//   yarn sync:mudlet-lua --dry-run         # report only, touch nothing
//   yarn sync:mudlet-lua --ref v4.20.0     # any branch/tag/sha
//   yarn sync:mudlet-lua --from E:/Code/Mudlet [--fetch]   # local checkout
//   yarn sync:mudlet-lua --make-patch geyser/GeyserMiniConsole.lua
//                                          # record the working tree's local edit
//
// Nothing downstream needs maintenance: LuaRuntime.ts globs the whole tree into
// the /lua/ VFS namespace, so a brand-new upstream file is dofile()-able on its
// own. Two things are NOT automatic and the report says so: a new preinstalled
// package has to be wired into defaultPackages.ts, and `.mpackage` files reached
// by `?url` import need a line in scripts/copy-lib-assets.mjs.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'Mudlet/Mudlet';
const UPSTREAM_DIR = 'src/mudlet-lua/lua';
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEST_REL = 'src/scripting/lua/mudlet-lua';
const DEST_DIR = `${REPO_ROOT}${DEST_REL}/`;
const PATCH_DIR = fileURLToPath(new URL('../scripts/mudlet-lua-patches/', import.meta.url));
const SYNCED_MD = `${DEST_DIR}SYNCED.md`;

// Upstream files that live outside UPSTREAM_DIR but belong in the vendored tree.
// Mudlet keeps the Lua translation catalogue with the other translations and
// loads it from a resource path; mudix serves it from the same /lua/ VFS the
// rest of the tree uses, so LuaGlobal's loadTranslations() finds it in place.
const EXTRA_FILES = {
    'translations/lua/mudlet-lua.json': 'translations/mudlet-lua.json',
};

// Upstream paths deliberately not vendored. A trailing `/` means "prefix".
// Anything not listed here is mirrored, so a genuinely new upstream file shows
// up as `Added` rather than being silently dropped.
const EXCLUDE = [
    ['.gitignore', 'repo housekeeping, not runtime'],
    ['CoreMudlet.lua', 'LuaDoc-only stub body wrapped in `if false then` — never executes'],
    ['config.ld', 'LDoc generator config'],
    ['ldoc.css', 'LDoc generator stylesheet'],
];

// Files that live in the vendored tree but have no upstream counterpart, so the
// "gone upstream → delete" sweep has to leave them alone.
const LOCAL_ONLY = [
    'SYNCED.md',
    '3rdparty/lulpeg.lua',
];

// Only these get CRLF→LF normalisation; `.mpackage` is a zip and must round-trip
// byte-for-byte.
const TEXT_EXT = /\.(lua|json|xml|md|css|txt|ld)$/i;

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
    const i = argv.indexOf(name);
    if (i === -1) return fallback;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) die(`${name} needs a value`);
    return v;
};
const ref = opt('--ref', 'development');
const localRepo = opt('--from', null);
const dryRun = flag('--dry-run');
const doFetch = flag('--fetch');
const keepRemoved = flag('--keep-removed');
const makePatch = opt('--make-patch', null);

function die(msg) {
    console.error(`sync-mudlet-lua: ${msg}`);
    process.exit(1);
}

const lf = (buf) => Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
const normalise = (rel, buf) => (TEXT_EXT.test(rel) ? lf(buf) : buf);

// The vendored tree is written LF regardless of platform, and the patches are
// LF. A checkout with core.autocrlf=true would otherwise have git diff/apply
// convert underneath us and produce CRLF patch bodies that then fail to apply.
const gitLf = (args, options) =>
    execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], options);

const isExcluded = (rel) =>
    EXCLUDE.some(([p]) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));

// ── sources ──────────────────────────────────────────────────────────────────
// Each source resolves `ref` to a concrete commit up front and reads every file
// at that sha, so a push mid-run can't produce a half-old/half-new tree.

function localSource(repoPath) {
    const git = (...args) => execFileSync('git', ['-C', repoPath, ...args], { maxBuffer: 1 << 28 });
    const gitText = (...args) => git(...args).toString('utf8').trim();

    if (doFetch) {
        console.log(`Fetching ${ref} in ${repoPath} …`);
        execFileSync('git', ['-C', repoPath, 'fetch', 'origin', ref], { stdio: 'inherit' });
    }
    // Prefer the remote-tracking ref: a local `development` in a checkout that's
    // been sitting around is usually staler than origin's.
    let sha = null;
    for (const candidate of [`origin/${ref}`, ref]) {
        try {
            sha = gitText('rev-parse', '--verify', '--quiet', `${candidate}^{commit}`);
            if (sha) break;
        } catch { /* try the next candidate */ }
    }
    if (!sha) die(`ref "${ref}" not found in ${repoPath} (try --fetch)`);

    const tree = gitText('ls-tree', '-r', '--name-only', sha, `${UPSTREAM_DIR}/`)
        .split('\n')
        .map(p => p.slice(UPSTREAM_DIR.length + 1))
        .filter(Boolean);
    if (tree.length === 0) die(`nothing under ${UPSTREAM_DIR} at ${sha.slice(0, 8)}`);

    return {
        origin: repoPath,
        sha,
        date: gitText('log', '-1', '--format=%cs', sha),
        tree,
        read: (upstreamPath) => git('show', `${sha}:${upstreamPath}`),
    };
}

async function githubSource() {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'mudix-sync-mudlet-lua' };
    // Unauthenticated is 60 requests/hour and the tree walk costs a handful — a
    // token is only needed on a shared/CI IP that's already burned the budget.
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;

    const api = async (url) => {
        const res = await fetch(url, { headers });
        if (!res.ok) {
            die(`GitHub ${res.status} ${res.statusText} for ${url}`
                + (res.status === 403 ? ' — rate limited; set GITHUB_TOKEN or use --from <checkout>' : ''));
        }
        return res.json();
    };

    console.log(`Resolving ${REPO}@${ref} …`);
    const commit = await api(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(ref)}`);
    const sha = commit.sha;

    // Walk down to UPSTREAM_DIR one tree at a time, then list that subtree
    // recursively. Asking for the *root* tree with ?recursive=1 would work too,
    // but Mudlet is large enough that the response can come back `truncated`.
    let treeSha = commit.commit.tree.sha;
    for (const segment of UPSTREAM_DIR.split('/')) {
        const node = (await api(`https://api.github.com/repos/${REPO}/git/trees/${treeSha}`))
            .tree.find(e => e.path === segment && e.type === 'tree');
        if (!node) die(`${UPSTREAM_DIR} not found at ${sha.slice(0, 8)}`);
        treeSha = node.sha;
    }
    const listing = await api(`https://api.github.com/repos/${REPO}/git/trees/${treeSha}?recursive=1`);
    if (listing.truncated) die(`${UPSTREAM_DIR} listing truncated by GitHub — use --from <checkout>`);
    const tree = listing.tree.filter(e => e.type === 'blob').map(e => e.path);
    if (tree.length === 0) die(`nothing under ${UPSTREAM_DIR} at ${sha.slice(0, 8)}`);

    return {
        origin: `https://github.com/${REPO}`,
        sha,
        date: (commit.commit?.committer?.date ?? '').slice(0, 10),
        tree,
        read: async (upstreamPath) => {
            const url = `https://raw.githubusercontent.com/${REPO}/${sha}/${upstreamPath}`;
            const res = await fetch(url);
            if (!res.ok) die(`download failed (${res.status}) for ${upstreamPath}`);
            return Buffer.from(await res.arrayBuffer());
        },
    };
}

const source = localRepo ? localSource(localRepo) : await githubSource();

// dest-relative path → upstream repo path, for everything we intend to vendor.
const wanted = new Map();
for (const rel of source.tree.sort()) {
    if (!isExcluded(rel)) wanted.set(rel, `${UPSTREAM_DIR}/${rel}`);
}
for (const [upstreamPath, rel] of Object.entries(EXTRA_FILES)) wanted.set(rel, upstreamPath);

// ── --make-patch ─────────────────────────────────────────────────────────────
// Records the difference between pristine upstream and whatever is in the
// working tree right now. Use it after hand-editing a vendored file, or after a
// sync reports a patch that stopped applying: fix the file up by hand, then
// re-record. Patch paths are written relative to the vendored tree; the sync
// re-roots them with `git apply --directory`.
if (makePatch) {
    const rel = makePatch.replace(/\\/g, '/').replace(/^\.?\//, '');
    const upstreamPath = wanted.get(rel);
    if (!upstreamPath) die(`"${rel}" is not a vendored upstream file`);

    // Both sides go through tmp files normalised to LF. The working-tree copy
    // needs it as much as the download does: on a core.autocrlf=true checkout
    // every vendored file comes back CRLF, and diffing that against LF upstream
    // reports the whole file as changed.
    const tmpA = `${DEST_DIR}${rel}.upstream.tmp`;
    const tmpB = `${DEST_DIR}${rel}.local.tmp`;
    mkdirSync(dirname(tmpA), { recursive: true });
    writeFileSync(tmpA, lf(await source.read(upstreamPath)));
    writeFileSync(tmpB, lf(readFileSync(`${DEST_DIR}${rel}`)));

    let patch = '';
    try {
        // --no-index always exits 1 when there is a difference; 0 means identical.
        gitLf(['diff', '--no-index', '--', `${rel}.upstream.tmp`, `${rel}.local.tmp`],
            { cwd: DEST_DIR, maxBuffer: 1 << 28 });
    } catch (e) {
        patch = (e.stdout ?? Buffer.alloc(0)).toString('utf8');
        if (!patch) { die(`git diff failed for ${rel}`); }
    } finally {
        rmSync(tmpA, { force: true });
        rmSync(tmpB, { force: true });
    }
    if (!patch) die(`${rel} is identical to upstream — nothing to record`);

    // Rewrite the a/b headers so the patch reads (and applies) as rel → rel.
    const esc = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patch = patch
        .replace(new RegExp(`${esc}\\.(upstream|local)\\.tmp`, 'g'), rel)
        .replace(/\r\n/g, '\n');

    const dest = `${PATCH_DIR}${rel}.patch`;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, patch);
    console.log(`Wrote scripts/mudlet-lua-patches/${rel}.patch (${patch.split('\n').length} lines)`);
    console.log('Recorded against upstream '
        + `${source.sha.slice(0, 8)} — re-run the sync to confirm it applies cleanly.`);
    process.exit(0);
}

// ── sync ─────────────────────────────────────────────────────────────────────
console.log(`Source: ${source.origin} @ ${source.sha.slice(0, 8)} (${source.date}), `
    + `${wanted.size} vendored file(s)\n`);

const walk = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(`${dir}${e.name}/`, `${prefix}${e.name}/`) : [`${prefix}${e.name}`]);

mkdirSync(DEST_DIR, { recursive: true });
const leftover = new Set(walk(DEST_DIR).filter(p => !LOCAL_ONLY.includes(p)));

// dest-relative path → .patch file, so the copy loop knows which files it is
// about to overwrite with a pristine version that a patch will then re-diverge.
const patchFiles = (() => {
    try { return walk(PATCH_DIR).filter(p => p.endsWith('.patch')).sort(); }
    catch { return []; }
})();
const patchFor = new Map(patchFiles.map(p => [p.replace(/\.patch$/, ''), p]));

const added = [], updated = [], unchanged = [];
// Patched files are copied like any other but their verdict is deferred: the
// copy resets them to upstream, so judging them here would report every one as
// "Updated" on every run. Settled after the patches go back on.
const beforeCopy = new Map();
for (const [rel, upstreamPath] of [...wanted].sort()) {
    const next = normalise(rel, await source.read(upstreamPath));
    const dest = `${DEST_DIR}${rel}`;
    let prev = null;
    try { prev = normalise(rel, readFileSync(dest)); } catch { /* new file */ }

    const write = () => {
        if (dryRun) return;
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, next);
    };
    if (patchFor.has(rel)) {
        beforeCopy.set(rel, prev);
        write();
    } else if (prev && prev.equals(next)) {
        unchanged.push(rel);
    } else {
        (prev ? updated : added).push(prev ? `${rel} (${sizeDelta(rel, prev, next)})` : rel);
        write();
    }
    leftover.delete(rel);
}

// Left over locally = gone upstream (or newly excluded). Deleted by default: the
// tree is a mirror, and a file Mudlet retired shouldn't keep loading here.
const removed = [...leftover].sort();
if (!dryRun && !keepRemoved) for (const rel of removed) rmSync(`${DEST_DIR}${rel}`);

function sizeDelta(rel, prev, next) {
    if (!TEXT_EXT.test(rel)) return `${next.length - prev.length} bytes`;
    const d = next.toString().split('\n').length - prev.toString().split('\n').length;
    return d === 0 ? 'edited' : d > 0 ? `+${d} lines` : `${d} lines`;
}

// ── patches ──────────────────────────────────────────────────────────────────
// Applied after the copy, in sorted order, straight onto the freshly-written
// upstream files. `git apply` is exact-context by default; -C1 relaxes it enough
// to survive an unrelated edit landing next door, which is the common case.
const patched = [], failed = [], stale = [];
for (const [rel, patchRel] of patchFor) {
    if (!wanted.has(rel)) { stale.push(rel); continue; }
    if (dryRun) { patched.push(`${rel} (not applied — dry run)`); continue; }

    // `git apply` resolves patch paths against the top of the work tree, not the
    // cwd — running it from DEST_DIR makes it look for `Other.lua` at the repo
    // root, not find it, and print "Skipped patch" while *exiting 0*. So run
    // from the root with --directory, and confirm the file actually moved rather
    // than trusting the exit code.
    const path = `${PATCH_DIR}${patchRel}`;
    const before = readFileSync(`${DEST_DIR}${rel}`);
    let applied = false;
    for (const extra of [[], ['-C1']]) {
        try {
            gitLf(['apply', ...extra, `--directory=${DEST_REL}`, '--', path],
                { cwd: REPO_ROOT, stdio: 'pipe' });
        } catch { continue; /* try the next strictness level */ }
        if (readFileSync(`${DEST_DIR}${rel}`).equals(before)) continue;
        applied = true;
        patched.push(extra.length ? `${rel} (fuzzy, -C1)` : rel);
        break;
    }
    if (!applied) failed.push(rel);
}

// Deferred verdicts: compare the patched result against what was there before
// the copy. "Unchanged" here means the vendored file is byte-identical to what
// it was, which is the only reading that stays true across repeated syncs.
for (const [rel, prev] of beforeCopy) {
    const next = dryRun ? null : normalise(rel, readFileSync(`${DEST_DIR}${rel}`));
    if (!prev) added.push(`${rel} (patched)`);
    else if (dryRun || prev.equals(next)) unchanged.push(rel);
    else updated.push(`${rel} (${sizeDelta(rel, prev, next)}, after patch)`);
}

// ── SYNCED.md ────────────────────────────────────────────────────────────────
if (!dryRun) {
    let md = null;
    try { md = readFileSync(SYNCED_MD, 'utf8'); } catch { /* first run */ }
    if (md) {
        // Checked per-line rather than by comparing the whole file: when the
        // header already reads correctly the rewrite is a no-op, and that must
        // not look like "the pattern stopped matching".
        const rewrites = [
            // `ref` is dropped when it's just the sha again — pinning by full
            // sha would otherwise print it twice on the same line.
            [/^- Synced from commit: .*$/m,
                `- Synced from commit: \`${source.sha}\` `
                + `(${source.sha.startsWith(ref) ? '' : `${ref}, `}${source.date})`],
            [/^- Vendored files: \d+.*$/m,
                `- Vendored files: ${wanted.size} (plus ${LOCAL_ONLY.length} mudix-only, `
                + `${patchFiles.length} patched)`],
        ];
        let next = md;
        for (const [pattern, line] of rewrites) {
            if (!pattern.test(next)) {
                console.warn(`! SYNCED.md: no line matching ${pattern} — update it by hand.\n`);
                continue;
            }
            next = next.replace(pattern, line);
        }
        writeFileSync(SYNCED_MD, next);
    }
}

// ── report ───────────────────────────────────────────────────────────────────
const list = (label, items) => {
    if (!items.length) return;
    console.log(`${label} (${items.length}):`);
    for (const i of items) console.log(`  ${i}`);
};
list('Added', added);
list('Updated', updated);
list(keepRemoved ? 'Gone upstream (kept)' : 'Removed', removed);
list('Patched', patched);
list('Skipped (excluded)', source.tree.filter(isExcluded).sort()
    .map(p => `${p} — ${EXCLUDE.find(([e]) => (e.endsWith('/') ? p.startsWith(e) : p === e))[1]}`));
console.log(`Unchanged: ${unchanged.length}`);

if (stale.length) {
    console.warn('\n! Patches with no upstream file (excluded or retired) — delete them:');
    for (const rel of stale) console.warn(`    scripts/mudlet-lua-patches/${rel}.patch`);
}

const changed = added.length + updated.length + removed.length;
if (failed.length) {
    console.error('\n! Patches that no longer apply — the file is now pristine upstream,');
    console.error('  so the mudix change it carried is GONE from the tree:');
    for (const rel of failed) console.error(`    ${rel}`);
    console.error('\n  Re-apply the change by hand (the patch body says what it was), then:');
    console.error(`    node scripts/sync-mudlet-lua.mjs --make-patch ${failed[0]}`);
    process.exit(1);
}
if (dryRun) {
    console.log(`\nDry run — nothing written. ${changed} file(s) would change, `
        + `${patchFiles.length} patch(es) would be re-applied.`);
} else if (changed) {
    console.log('\nNext:');
    console.log('  git diff -- src/scripting/lua/mudlet-lua   # review what Mudlet changed');
    console.log('  yarn test                                  # unit suite');
    console.log('  yarn test:e2e                              # busted corpus against the real app');
    // The one coupling the tree can't express: defaultPackages.ts pins
    // generic_mapper's version so a bumped archive reinstalls over the old copy,
    // and there's a test asserting the two agree.
    if ([...added, ...updated].some(a => a.includes('.mpackage'))) {
        console.log('  ! an .mpackage moved — check src/import/defaultPackages.ts: a bumped');
        console.log('    archive needs its declared `version` bumped to match, and a NEW');
        console.log('    preinstalled package needs wiring in (exactly one mapper may be');
        console.log('    default — see CLAUDE.md) plus a line in scripts/copy-lib-assets.mjs.');
    }
} else {
    console.log('\nAlready up to date.');
}
