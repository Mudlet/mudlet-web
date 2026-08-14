import { type Page } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Shared harness for Mudlet's busted *_spec.lua suite, run against the real mudix
// app in a browser. Imported by busted.spec.ts (the per-test suite + drift guard)
// and genBustedManifest.ts (the manifest generator).

export type BustedFailure = { spec: string; name: string; message: string; trace?: string };
export type BustedTest = { spec: string; name: string; status: string; message?: string };
export type BustedResults = {
    total: number; passed: number; failed: number; errors: number; pending: number;
    failures: BustedFailure[];
    tests: BustedTest[];
};

// The specs directory the runtime bundles via import.meta.glob('./specs/**').
const SPECS_DIR = fileURLToPath(new URL('../src/scripting/lua/specs/', import.meta.url));

// Every spec in src/scripting/lua/specs/ (`<Name>_spec.lua` → `<Name>`),
// discovered from disk rather than hand-listed, so a re-synced/added/removed spec
// needs no maintenance here — it just shows up. (busted.spec.ts and
// genBustedManifest.ts both run in Node, so the filesystem read is available at
// collection time.) All of them pass in-app and are asserted per-it() in
// busted.spec.ts; when re-syncing a spec that isn't passing yet, expect per-it()
// failures here until the gap is closed.
export const ALL_SPECS: string[] = fs.readdirSync(SPECS_DIR)
    .filter(f => f.endsWith('_spec.lua'))
    .map(f => f.slice(0, -'_spec.lua'.length))
    .sort();

// The committed per-it manifest: { spec: [fullName, ...] }. The drift guard
// fails if a spec's live it() set diverges from this, so regenerate with
// `npm run gen:busted-manifest` whenever specs are re-synced.
export const manifestPath = fileURLToPath(new URL('./busted.manifest.json', import.meta.url));

export function loadManifest(): Record<string, string[]> {
    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, string[]>;
    } catch {
        return {}; // not generated yet — per-it tests just don't materialise
    }
}

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
export async function reopen(page: Page): Promise<void> {
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
        { timeout: 90_000, polling: 500 },
    );
}

// Seed + navigate a fresh page into a ready runtime.
export async function bootProfile(page: Page): Promise<void> {
    await seedProfile(page);
    await reopen(page);
}

export function runSpec(page: Page, spec: string): Promise<BustedResults> {
    return page.evaluate(
        (s) => (window as unknown as { __runBusted: (p: string) => BustedResults }).__runBusted(s),
        spec,
    );
}

// One full run per spec, cached for the worker. The whole suite runs single-worker
// (workers:1, fullyParallel:false), so this module-scoped Map is shared across
// every test in the file: the first test for a spec boots a page and runs the
// whole spec; the rest (and the drift guard) reuse the cached results without
// touching their page. A single it() re-run in isolation just boots on cache miss.
const resultCache = new Map<string, BustedResults>();
export async function specResults(page: Page, spec: string): Promise<BustedResults> {
    const cached = resultCache.get(spec);
    if (cached) return cached;
    await bootProfile(page);
    const r = await runSpec(page, spec);
    resultCache.set(spec, r);
    return r;
}
