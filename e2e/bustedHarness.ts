import { devices, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Shared harness for Mudlet's busted *_spec.lua suite, run against the real mudix
// app in a browser. Imported by bustedRecord.ts (globalSetup, which records the
// corpus), by busted.spec.ts (which turns that recording into tests) and by
// bustedFailures.ts (the triage runner).

export type BustedFailure = { spec: string; name: string; message: string; trace?: string };
export type BustedTest = { spec: string; name: string; status: string; message?: string };
export type BustedResults = {
    total: number; passed: number; failed: number; errors: number; pending: number;
    failures: BustedFailure[];
    tests: BustedTest[];
};

// The browser context every spec runs in — the project's `use` block and the
// recording sweep alike, from this one definition, because they must not differ.
//
// Note what the descriptor decides: its user agent says Windows, so getOS()
// answers "windows" no matter what the run is really on, and the specs that
// branch on it assert their Windows side everywhere. Three of them fail the
// moment a context is created without it — Miscallaneous_spec looks for
// /proc/<pid> in the profile VFS, expects getWindowsCodepage() to refuse, and
// GeyserUserWindow_spec expects Qt's dock title bar to cost height. That is
// pre-existing (every context has always come from this descriptor); it is
// recorded here because the failure it produces looks like a real parity gap
// rather than a missing context option.
export const BUSTED_DEVICE = devices['Desktop Chrome'];

// The same, minus the key that only means something in a `use` block, so it can
// be handed straight to browser.newContext().
export const { defaultBrowserType: _defaultBrowserType, ...BUSTED_CONTEXT } = BUSTED_DEVICE;

// The specs directory the runtime bundles via import.meta.glob('./specs/**').
const SPECS_DIR = fileURLToPath(new URL('../src/scripting/lua/specs/', import.meta.url));

// A spec whose whole body sits behind `if not os.getenv(X) then return end`
// registers no it() unless X is set, and nothing here sets one: os.getenv answers
// nil to everything except MUDLET_TEST_MODE (see LuaRuntime.setupBustedBridge),
// because the other variables the corpus reads name fixtures that really are
// absent. The fuzzers upstream added this way — TelnetTriggerFuzz, BufferManipFuzz
// — are gated on MUDLET_FUZZ and drive a sanitizer build of Mudlet through
// feedTelnet: a diagnostic tool for the C++ client rather than a pass/fail spec,
// and nothing this build can run at all.
//
// Recording one is harmless; what fails is `<spec>: recorded cleanly`, which
// asserts a spec ran SOMETHING so that a spec blowing up on load cannot pass by
// having nothing left to assert. That guard is worth keeping, so the gated spec
// is dropped from the corpus instead — matched on the gate itself rather than by
// name, so the next env-gated spec upstream writes needs no maintenance here.
function envGated(spec: string): boolean {
    const source = fs.readFileSync(`${SPECS_DIR}${spec}_spec.lua`, 'utf8');
    return /^[ \t]*if not os\.getenv\(\s*["'][^"']+["']\s*\)\s*then\s*\r?\n[ \t]*return\s*\r?\n[ \t]*end/m.test(source);
}

// Every spec in src/scripting/lua/specs/ (`<Name>_spec.lua` → `<Name>`),
// discovered from disk rather than hand-listed, so a re-synced/added/removed spec
// needs no maintenance here — it just shows up, gets recorded, and gets its
// it()s asserted. (This runs in Node, so the filesystem read is available both to
// globalSetup and at collection time.) All of them pass in-app; when re-syncing a
// spec that isn't passing yet, expect per-it() failures until the gap is closed.
export const ALL_SPECS: string[] = fs.readdirSync(SPECS_DIR)
    .filter(f => f.endsWith('_spec.lua'))
    .map(f => f.slice(0, -'_spec.lua'.length))
    .filter(spec => !envGated(spec))
    .sort();

// ── Sharding ────────────────────────────────────────────────────────────────
// BUSTED_SHARD=<n>/<total> restricts a run to a slice of the corpus: it records
// only those specs and registers only their tests, so N runners each do 1/N of
// the browser work. That is not what Playwright's own --shard does — it slices
// the TEST list, and since every one of this suite's tests is an assertion over
// a recorded spec, each shard would still have to record the whole corpus to
// have anything to assert. The split has to happen at the spec, so it happens
// here.
//
// Sliced longest-first onto the emptiest shard, weighted by the spec file's
// size. Cost varies enormously across the corpus (UI_spec alone is 610 it()s),
// and a round-robin would leave one runner holding it plus its fair share of
// everything else. Size is the only cost signal available before a spec has ever
// run, and it tracks it() count closely enough to keep the shards even.
const shardEnv = process.env.BUSTED_SHARD;

function parseShard(value: string | undefined): { index: number; total: number } | null {
    if (!value) return null;
    const match = /^(\d+)\/(\d+)$/.exec(value.trim());
    const index = Number(match?.[1]);
    const total = Number(match?.[2]);
    if (!match || !(total >= 1) || !(index >= 1) || index > total) {
        throw new Error(`BUSTED_SHARD must look like "2/3", got "${value}"`);
    }
    return { index, total };
}

function shardSpecs(index: number, total: number): string[] {
    const weight = (spec: string) => fs.statSync(`${SPECS_DIR}${spec}_spec.lua`).size;
    const load = new Array<number>(total).fill(0);
    const shards: string[][] = Array.from({ length: total }, () => []);
    for (const spec of [...ALL_SPECS].sort((a, b) => weight(b) - weight(a))) {
        const lightest = load.indexOf(Math.min(...load));
        shards[lightest].push(spec);
        load[lightest] += weight(spec);
    }
    return shards[index - 1].sort();
}

export const SHARD = parseShard(shardEnv);

/** The specs this run is responsible for: its shard's slice, or all of them. */
export const SPECS: string[] = SHARD ? shardSpecs(SHARD.index, SHARD.total) : ALL_SPECS;

// Register the non-dialing connection (store v20) for every navigation on this
// page. The bogus ws URL + the deep-link's withConnect=false keep it from
// dialing; we only need a live profile so a LuaRuntime exists. addInitScript runs
// on every goto, so localStorage is re-seeded on each reopen().
export async function seedProfile(page: Page): Promise<void> {
    await page.addInitScript(() => {
        // Mudlet drives its suite with the `run-tests` package installed, and
        // several specs assert against the fixture that package carries rather
        // than building one: a nested filter-trigger hierarchy (UI_spec's
        // "nested triggers", Mudlet #7886) and items named for findItems to
        // search (Miscallaneous_spec). Reproduced here node-for-node from
        // src/import/defaults/run-tests/run-tests.xml — names, nesting, patterns
        // and enabled state all matter to some spec.
        //
        // Seeded rather than installed on purpose: the package also ships its
        // own copy of busted plus scripts that run the suite and quit on
        // sysLoadEvent, which would fight the runner this harness IS. Only the
        // fixture is wanted, so only the fixture is here.
        //
        // connectionTriggers/connectionScripts aren't normally in localStorage
        // (they live in the profile VFS), but a fresh profile has no VFS data,
        // so the seeded slices hydrate and survive — PROVIDED the seed carries
        // the CURRENT store version. A lower one sends it through appStore's
        // migrate, which drops every automation slice on purpose (they moved
        // into the VFS at v20), and the fixture silently never arrives. Keep
        // this in step with MUDIX_STORE_VERSION.
        const t = (
            id: string, name: string, parentId: string | null, pattern: string,
            code: string, isFilter: boolean, isGroup = false,
        ) => ({
            id, name, enabled: true, isGroup, parentId,
            patterns: pattern ? [{ text: pattern, type: 'regex' }] : [], code, language: 'lua',
            fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter,
        });
        localStorage.setItem('mudix_v1', JSON.stringify({
            version: 21,
            state: {
                // Mirror Mudlet's own test setup: the suite is designed to run
                // under a profile NAMED "Mudlet self-test" (DebugTools.lua keeps
                // `errorc` global only for that name) whose home dir contains
                // "mudlet" (MudletBusted_spec asserts getMudletHomeDir() does).
                // getProfileName() returns the name; getMudletHomeDir() is
                // /profiles/<id>, so the id carries the "mudlet" substring.
                connections: [{
                    id: 'mudlet-self-test',
                    name: 'Mudlet self-test',
                    mode: 'websocket',
                    url: 'ws://127.0.0.1:1/',
                    // Seeding localStorage directly bypasses addConnection, which
                    // is what normally stamps this. Without it the profile reads
                    // as pre-existing and stockDefaults withholds the starter UI
                    // (see isNewProfile) — and UI_spec is Mudlet's test suite for
                    // that very package, so every BaseUI.* test would fail on a
                    // missing global. Mudlet runs its suite on a fresh profile;
                    // this keeps ours equivalent.
                    createdAt: new Date().toISOString(),
                }],
                connectionTriggers: {
                    'mudlet-self-test': [
                        t('st-nested', 'Test selectCaptureGroup with nested hierarchy', null, '', '', false, true),
                        t('st-filter', 'Filter', 'st-nested', '^Foo Bar (Baz Qux)$', '', true, true),
                        t('st-notfilter', 'Not Filter', 'st-filter', '^Baz Qux$', '', false, true),
                        t('st-trigger', 'Trigger', 'st-notfilter', '^Baz (Qux)$', 'selectCaptureGroup(2)', false),
                    ],
                },
                // Disabled, as it is in the package: findItems only looks at
                // names, and an enabled script would run its body on load.
                connectionScripts: {
                    'mudlet-self-test': [{
                        id: 'st-test-scripts', name: 'test scripts', enabled: false,
                        isGroup: false, parentId: null, code: '', language: 'lua',
                    }],
                },
                // The fixture above comes FROM run-tests, so the package has to
                // be on the installed list as well: Mudlet runs this suite with
                // run-tests installed, and Package_spec checks getPackages() by
                // looking for it. Seeding the items without the manifest left
                // the profile in a state Mudlet never has — items belonging to a
                // package that is not installed.
                connectionPackages: {
                    'mudlet-self-test': [{ name: 'run-tests' }],
                },
            },
        }));
    });
}

// (Re)navigate to the seeded profile and wait for a stable runtime. Also resets
// state between specs: busted insulates Lua _G but NOT mudix's JS console
// (history/partial/cursor/selection), so running specs back-to-back in one page
// leaks console content between them. A fresh navigation rebuilds runtime+console.
//
// window.__runBusted is installed at the tail of LuaRuntime.setup(), but the app
// may recreate the runtime a couple of times during initial mount (React
// StrictMode remount + the deep-link connection effect), each time resetting the
// hook — so waiting for it to merely *exist* races a soon-to-be-destroyed runtime.
// Instead poll an actual trivial run until it returns.
//
// Lua answering is necessary but NOT sufficient: __runBusted goes live well
// before ScriptingEngine.start() finishes its initial load pass. perm aliases and
// perm triggers are written to the store only (createPermAlias et al), and reach
// the AliasEngine/TriggerEngine solely via the store subscription start() attaches
// at its very end; triggers additionally compile only once PCRE wasm resolves.
// Since a busted run is one synchronous doStringSync, a queued apply can never
// catch up mid-run — so a run started early makes every perm* spec (and the
// seeded nested-trigger fixture below) fail nondeterministically. __mudixBustedReady
// reports whether sysLoadEvent has fired, which the engine raises only once all
// of that is in place.
export async function reopen(page: Page, timeout = READY_TIMEOUT_MS): Promise<void> {
    await page.goto('/?profile=mudlet-self-test');
    await page.waitForFunction(
        () => {
            const w = window as unknown as {
                __runBusted?: (p: string) => { total?: number };
                __mudixBustedReady?: () => boolean;
            };
            if (typeof w.__mudixBustedReady !== 'function') return false;
            try {
                if (!w.__mudixBustedReady()) return false;
            } catch {
                return false; // runtime torn down mid-poll
            }
            if (typeof w.__runBusted !== 'function') return false;
            try {
                return (w.__runBusted('StringUtils').total ?? 0) > 0;
            } catch {
                return false;
            }
        },
        undefined,
        { timeout, polling: 500 },
    );
}

// Seed + navigate a fresh page into a ready runtime.
export async function bootProfile(page: Page, timeout?: number): Promise<void> {
    await seedProfile(page);
    await reopen(page, timeout);
}

// How long to wait for a boot before giving up on it. A healthy boot answers in
// 1–5s; what this really has to survive is the contention of several contexts
// booting at once, where one can be starved for a good while. It used to be 90s,
// and that made a lost boot expensive in exactly the wrong way: the recorder
// retries a spec that fails, so a flake cost the full wait AND the retry — one
// starved Discord boot turned a 12-spec shard from ~15s into 94s. Fail fast,
// retry with room to spare (see RETRY_READY_TIMEOUT_MS).
export const READY_TIMEOUT_MS = 45_000;
export const RETRY_READY_TIMEOUT_MS = 90_000;

export function runSpec(page: Page, spec: string): Promise<BustedResults> {
    return page.evaluate(
        (s) => (window as unknown as { __runBusted: (p: string) => BustedResults }).__runBusted(s),
        spec,
    );
}

// ── The recorded run ─────────────────────────────────────────────────────────
// Where globalSetup (bustedRecord.ts) leaves the corpus results, and what
// busted.spec.ts reads at collection time to build the test tree. Gitignored: it
// is rewritten by every run whose inputs changed, so a committed copy could only
// ever be a stale second source of truth.
export type RecordedRun = { fingerprint: string; results: Record<string, BustedResults> };
export const resultsPath = fileURLToPath(new URL('./.busted-results.json', import.meta.url));

export function loadRecordedRun(): RecordedRun | null {
    try {
        return JSON.parse(fs.readFileSync(resultsPath, 'utf8')) as RecordedRun;
    } catch {
        return null; // not recorded yet — globalSetup is about to
    }
}

// What a recorded run is a run OF: every input that could change its outcome —
// the app, the harness, the vendored Lua and the spec corpus alike. Cheap to
// compute (a stat per file, no reads) and it only has to answer one question:
// may the previous recording stand, or does this run have to sweep the corpus
// again? Anything not covered here would let a stale run be reused, so the list
// is deliberately coarse — src, e2e and the build config, whole.
const FINGERPRINT_ROOTS = ['src', 'e2e', 'index.html', 'package.json', 'vite.config.ts'];

export function fingerprint(): string {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const hash = createHash('sha1');
    const walk = (rel: string) => {
        const abs = root + rel;
        const stat = fs.statSync(abs, { throwIfNoEntry: false });
        if (!stat) return;
        if (stat.isDirectory()) {
            for (const entry of fs.readdirSync(abs).sort()) walk(`${rel}/${entry}`);
            return;
        }
        // The recording itself, and the triage runner's scratch output, are
        // products of a run — fingerprinting them would invalidate the very file
        // being written the moment it is written.
        if (rel.endsWith('.busted-results.json') || rel.endsWith('busted-failures.json')) return;
        hash.update([rel, stat.size, stat.mtimeMs].join('|') + ';');
    };
    for (const entry of FINGERPRINT_ROOTS) walk(entry);
    return hash.digest('hex');
}
