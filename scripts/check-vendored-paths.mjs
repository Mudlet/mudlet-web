// Fail a pull request that edits a vendored Mudlet tree by hand.
//
// The vendored trees are mirrors of Mudlet/Mudlet and change only by syncing —
// `scripts/sync-mudlet-{lua,specs,games}.mjs`, run daily by
// `.github/workflows/sync-mudlet-upstream.yml`. A hand edit there is invisible
// drift: the next sync silently reverts it, and until then a failing spec may be
// local damage rather than the parity gap it is supposed to mean. A gap is closed
// in Mudlet Web's own code, recorded in `e2e/knownDivergences.ts`, or fixed
// upstream — see "Vendored Mudlet trees" in CLAUDE.md.
//
//   node scripts/check-vendored-paths.mjs                     # HEAD against origin/master
//   node scripts/check-vendored-paths.mjs --base <ref> --head <ref> [--head-branch <name>]
//
// The diff is `base...head` — against the merge base, so it is exactly what the
// PR adds. That is also what makes a triage PR (one whose BASE is a sync branch)
// come out right: the sync content is already in its base, so only the triage's
// own commits are checked, and a hand edit among them still fails.
//
// Exempt:
//   - a PR whose head is one of the sync workflow's own branches, from this
//     repository (not a fork's branch of the same name), and then only for the
//     paths that branch's scripts write;
//   - the Mudlet Web-only files inside the trees, which the sync scripts leave
//     alone (HAND_MAINTAINED below).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LUA = 'scripts/sync-mudlet-lua.mjs';
const SPECS = 'scripts/sync-mudlet-specs.mjs';
const GAMES = 'scripts/sync-mudlet-games.mjs';

/** The sync workflow's branches (its matrix `branch:`), and the scripts each runs. */
export const SYNC_BRANCHES = {
    'chore/sync-mudlet-upstream': [LUA, SPECS],
    'chore/sync-mudlet-games': [GAMES],
};

/**
 * Every path a sync script writes, with the script that owns it. A trailing `/`
 * is a whole tree: each script mirrors its tree and deletes what is gone
 * upstream, so nothing in it is safe to edit except HAND_MAINTAINED.
 */
export const VENDORED = [
    { path: 'src/scripting/lua/mudlet-lua/', script: LUA },
    { path: 'src/import/defaults/', script: LUA },
    { path: 'src/scripting/lua/specs/', script: SPECS },
    // Header and footer included — the script writes the whole file.
    { path: 'src/mud/games/bundledGames.ts', script: GAMES },
    // Logos; the script drops any no game references.
    { path: 'src/mud/games/icons/', script: GAMES },
];

/**
 * Files inside a vendored tree that are Mudlet Web's own. Mirrors what the sync
 * scripts themselves leave alone: `localOnly` in sync-mudlet-lua.mjs, and the
 * SYNCED.md that sync-mudlet-specs.mjs skips. Each SYNCED.md is still partly
 * written by its sync (the pinned-commit lines) — the prose around them is not.
 */
export const HAND_MAINTAINED = [
    'src/scripting/lua/mudlet-lua/SYNCED.md',
    'src/scripting/lua/mudlet-lua/3rdparty/lulpeg.lua',
    'src/scripting/lua/specs/SYNCED.md',
];

/** The VENDORED entry owning `path`, or null when it is not vendored at all. */
export function vendoredEntry(path) {
    if (HAND_MAINTAINED.includes(path)) return null;
    return VENDORED.find(v => (v.path.endsWith('/') ? path.startsWith(v.path) : path === v.path)) ?? null;
}

/**
 * The changed paths this PR may not carry, each with the script that should
 * have produced it. `headBranch` exempts a sync branch's own paths, and only
 * when `sameRepo` — a fork can name a branch anything.
 */
export function offendingPaths(paths, { headBranch = '', sameRepo = true } = {}) {
    const allowed = (sameRepo && SYNC_BRANCHES[headBranch]) || [];
    return paths
        .map(path => ({ path, entry: vendoredEntry(path) }))
        .filter(({ entry }) => entry && !allowed.includes(entry.script))
        .map(({ path, entry }) => ({ path, script: entry.script }));
}

/** The failure report: every offending file, grouped under the script that owns it. */
export function formatReport(offending) {
    const byScript = new Map();
    for (const { path, script } of offending) byScript.set(script, [...(byScript.get(script) ?? []), path]);
    const lines = [
        `${offending.length} vendored Mudlet file(s) changed by hand in this pull request:`,
        '',
    ];
    for (const [script, paths] of byScript) {
        lines.push(`  synced by ${script}:`);
        for (const p of paths) lines.push(`    ${p}`);
    }
    lines.push(
        '',
        'These trees mirror Mudlet/Mudlet and change only through the sync scripts above,',
        'which .github/workflows/sync-mudlet-upstream.yml runs daily. Revert these files',
        `(git checkout <base> -- <path>) and instead:`,
        '  - close the gap in Mudlet Web\'s own code (ScriptingAPI, LuaRuntime bindings, ...);',
        '  - or record it in e2e/knownDivergences.ts;',
        '  - or fix it upstream in Mudlet, and let the next sync bring it in.',
        'See "Vendored Mudlet trees" in CLAUDE.md.',
    );
    return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main(argv) {
    const opt = (name, fallback) => {
        const i = argv.indexOf(name);
        return i === -1 ? fallback : argv[i + 1];
    };
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });

    const base = opt('--base', 'origin/master');
    const head = opt('--head', 'HEAD');
    // No --head-branch means a local run: the checked-out branch stands in.
    const headBranch = opt('--head-branch', null)
        ?? git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    const sameRepo = opt('--same-repo', 'true') === 'true';

    // --no-renames so a move lists both ends; -z so no path comes back quoted.
    const changed = git('diff', '--name-only', '--no-renames', '-z', `${base}...${head}`)
        .split('\0').filter(Boolean);
    const offending = offendingPaths(changed, { headBranch, sameRepo });

    if (SYNC_BRANCHES[headBranch] && sameRepo) {
        console.log(`Head is the sync branch ${headBranch}: `
            + `${SYNC_BRANCHES[headBranch].join(' and ')} output is exempt.`);
    }
    if (!offending.length) {
        console.log(`No hand edits to vendored Mudlet trees in ${base}...${head} `
            + `(${changed.length} file(s) changed).`);
        return 0;
    }
    if (process.env.GITHUB_ACTIONS) {
        for (const { path, script } of offending) {
            console.log(`::error file=${path}::Vendored Mudlet file — change it only via ${script}, never by hand.`);
        }
    }
    console.error(formatReport(offending));
    return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    process.exit(main(process.argv.slice(2)));
}
