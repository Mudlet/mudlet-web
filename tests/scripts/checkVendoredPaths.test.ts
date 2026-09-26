// @vitest-environment node
/**
 * The vendored-tree guard (scripts/check-vendored-paths.mjs): which changed
 * paths a PR may not carry, and that its lists still agree with the sync
 * scripts and workflow they were read off.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    HAND_MAINTAINED,
    SYNC_BRANCHES,
    VENDORED,
    formatReport,
    offendingPaths,
    vendoredEntry,
} from '../../scripts/check-vendored-paths.mjs';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

describe('vendoredEntry', () => {
    it('matches everything under a vendored tree', () => {
        expect(vendoredEntry('src/scripting/lua/mudlet-lua/geyser/Geyser.lua')?.script)
            .toBe('scripts/sync-mudlet-lua.mjs');
        expect(vendoredEntry('src/import/defaults/run-lua-code/run-lua-code.xml')?.script)
            .toBe('scripts/sync-mudlet-lua.mjs');
        expect(vendoredEntry('src/scripting/lua/specs/fixtures/packages/x.mpackage')?.script)
            .toBe('scripts/sync-mudlet-specs.mjs');
        expect(vendoredEntry('src/mud/games/icons/achaea.png')?.script)
            .toBe('scripts/sync-mudlet-games.mjs');
    });

    it('matches a single vendored file exactly, not its neighbours', () => {
        expect(vendoredEntry('src/mud/games/bundledGames.ts')?.script).toBe('scripts/sync-mudlet-games.mjs');
        expect(vendoredEntry('src/mud/games/gameIcons.ts')).toBeNull();
        expect(vendoredEntry('src/mud/games/bundledGames.ts.bak')).toBeNull();
    });

    it('does not match a sibling that only shares a prefix', () => {
        expect(vendoredEntry('src/scripting/lua/mudlet-lua-extra/x.lua')).toBeNull();
        expect(vendoredEntry('src/import/defaultPackages.ts')).toBeNull();
        expect(vendoredEntry('src/scripting/lua/specsHarness.ts')).toBeNull();
    });

    it('exempts the Mudlet Web-only files inside the trees', () => {
        for (const p of HAND_MAINTAINED) expect(vendoredEntry(p)).toBeNull();
    });
});

describe('offendingPaths', () => {
    const mixed = [
        'src/scripting/ScriptingAPI.ts',
        'src/scripting/lua/mudlet-lua/Other.lua',
        'src/scripting/lua/specs/Other_spec.lua',
        'src/scripting/lua/specs/SYNCED.md',
        'src/mud/games/bundledGames.ts',
        'e2e/knownDivergences.ts',
    ];

    it('flags hand edits on an ordinary branch, naming the owning script', () => {
        expect(offendingPaths(mixed, { headBranch: 'feature/x' })).toEqual([
            { path: 'src/scripting/lua/mudlet-lua/Other.lua', script: 'scripts/sync-mudlet-lua.mjs' },
            { path: 'src/scripting/lua/specs/Other_spec.lua', script: 'scripts/sync-mudlet-specs.mjs' },
            { path: 'src/mud/games/bundledGames.ts', script: 'scripts/sync-mudlet-games.mjs' },
        ]);
    });

    it('passes a PR that touches only Mudlet Web code', () => {
        expect(offendingPaths(['src/scripting/ScriptingAPI.ts', 'e2e/knownDivergences.ts'])).toEqual([]);
    });

    it('exempts each sync branch only for the paths its own scripts write', () => {
        expect(offendingPaths(mixed, { headBranch: 'chore/sync-mudlet-upstream' }).map(o => o.path))
            .toEqual(['src/mud/games/bundledGames.ts']);
        expect(offendingPaths(mixed, { headBranch: 'chore/sync-mudlet-games' }).map(o => o.path))
            .toEqual(['src/scripting/lua/mudlet-lua/Other.lua', 'src/scripting/lua/specs/Other_spec.lua']);
    });

    it('does not exempt a fork branch that borrows a sync branch name', () => {
        expect(offendingPaths(mixed, { headBranch: 'chore/sync-mudlet-upstream', sameRepo: false }))
            .toHaveLength(3);
    });

    it('checks a triage PR (based on the sync branch) like any other head', () => {
        // Its base is the sync branch, so the diff holds only the triage's own
        // commits — and a triage head branch gets no exemption.
        expect(offendingPaths(['src/scripting/lua/mudlet-lua/Other.lua', 'e2e/knownDivergences.ts'],
            { headBranch: 'fix/triage-gap' })).toHaveLength(1);
    });
});

describe('formatReport', () => {
    it('names every offending file and points at the sync scripts', () => {
        const report = formatReport([
            { path: 'src/scripting/lua/mudlet-lua/Other.lua', script: 'scripts/sync-mudlet-lua.mjs' },
            { path: 'src/mud/games/bundledGames.ts', script: 'scripts/sync-mudlet-games.mjs' },
        ]);
        expect(report).toContain('src/scripting/lua/mudlet-lua/Other.lua');
        expect(report).toContain('src/mud/games/bundledGames.ts');
        expect(report).toContain('synced by scripts/sync-mudlet-lua.mjs');
        expect(report).toContain('synced by scripts/sync-mudlet-games.mjs');
        expect(report).toContain('e2e/knownDivergences.ts');
    });
});

// The lists above were read off the sync scripts and the workflow; these keep
// them from drifting apart.
describe('agreement with the sync scripts and workflow', () => {
    it('HAND_MAINTAINED covers sync-mudlet-lua.mjs localOnly, and the specs SYNCED.md', () => {
        const src = read('scripts/sync-mudlet-lua.mjs');
        const localOnly = [...src.matchAll(/^\s*dest: '([^']+)',[\s\S]*?localOnly: \[([^\]]*)\]/gm)]
            .flatMap(([, dest, list]) => [...list.matchAll(/'([^']+)'/g)].map(([, f]) => `${dest}/${f}`));
        expect(localOnly.length).toBeGreaterThan(0);
        expect([...HAND_MAINTAINED].sort()).toEqual(
            [...localOnly, 'src/scripting/lua/specs/SYNCED.md'].sort());
        // sync-mudlet-specs.mjs leaves exactly that one file out of its sweep.
        expect(read('scripts/sync-mudlet-specs.mjs')).toContain("filter(f => f !== 'SYNCED.md')");
    });

    it('VENDORED lists every tree sync-mudlet-lua.mjs mirrors', () => {
        const dests = [...read('scripts/sync-mudlet-lua.mjs').matchAll(/^\s*dest: '([^']+)',/gm)].map(m => m[1]);
        expect(dests.length).toBeGreaterThan(0);
        for (const dest of dests) expect(VENDORED.map(v => v.path)).toContain(`${dest}/`);
    });

    it('VENDORED lists what sync-mudlet-games.mjs writes', () => {
        const src = read('scripts/sync-mudlet-games.mjs');
        expect(src).toContain("resolve(HERE, '../src/mud/games/bundledGames.ts')");
        expect(src).toContain("resolve(HERE, '../src/mud/games/icons')");
    });

    it('SYNC_BRANCHES are the sync workflow’s branches', () => {
        const wf = read('.github/workflows/sync-mudlet-upstream.yml');
        const branches = [...wf.matchAll(/^\s+branch: (\S+)$/gm)].map(m => m[1]);
        expect(Object.keys(SYNC_BRANCHES).sort()).toEqual(branches.sort());
    });
});
