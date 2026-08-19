import { test, expect } from '@playwright/test';
import { SPECS, SHARD, loadRecordedRun } from './bustedHarness';
import { KNOWN_DIVERGENCES, UNSUPPORTED_AREAS, knownDivergence } from './knownDivergences';

// Mudlet's busted *_spec.lua suite, run against the real mudix app in a browser.
// This is the single path for the whole corpus: because the live app wires the
// full ScriptingEngine (trigger/alias dispatch, timer pump) and renders real
// overlay/Geyser geometry, specs the node thin-layer couldn't exercise (triggers
// via feedTriggers, DOM-dependent widgets) run here too.
//
// The browser work all happened before this file was loaded: globalSetup
// (bustedRecord.ts) swept the corpus and wrote the results, which is legal
// because Playwright does global setup before it loads test files. So what's
// left here is bookkeeping — every Mudlet it() becomes its own Playwright test()
// so IDE runners (WebStorm/VS Code) and JUnit list it as a first-class node, and
// each one just reads its verdict out of the recording.
//
// Nothing in that chain is committed or generated ahead of time: the test names
// and their results come from the same run, so there is no manifest to keep in
// step and no drift to guard against.
//
// The price is paid in a fresh clone, and only there: `playwright test --list`
// runs the load phase WITHOUT global setup (that is Playwright's own task order
// for list mode), so an IDE populating its test tree before the suite has ever
// run sees the one placeholder below instead of 3300 nodes. Run `yarn test:e2e`
// once and the tree is complete — and stays complete, since every later run
// rewrites the recording. From then on a single it() re-runs in ~2s and the whole
// suite in under 10, because a run whose inputs are unchanged reuses the
// recording and never starts the app at all.

const run = loadRecordedRun();

if (!run) {
    // globalSetup writes the recording before this file is loaded, so this means
    // it did not run: a fresh clone listing tests (see above), or a config that
    // drops globalSetup on purpose (the triage runner's does).
    test('busted corpus was recorded', () => {
        throw new Error(
            'No e2e/.busted-results.json. It is written by globalSetup (e2e/bustedRecord.ts) — '
            + 'run `yarn test:e2e`, and check that the config in use still sets globalSetup.',
        );
    });
} else {
    for (const spec of SPECS) {
        const results = run.results[spec];
        const names = results?.tests.map(t => t.name) ?? [];

        test.describe(`${spec}_spec`, () => {
            names.forEach((name, idx) => {
                // Occurrence index disambiguates the rare case of two it()s sharing a
                // full name, so each test() title is unique and maps to the right run.
                const occ = names.slice(0, idx + 1).filter(n => n === name).length;
                const title = occ === 1 ? name : `${name} (#${occ})`;

                test(title, () => {
                    // An assertion mudix deliberately does not satisfy is marked
                    // expected-to-fail rather than skipped, so the day it starts
                    // passing is a red run telling us to delete the entry — see
                    // knownDivergences.ts.
                    const divergence = knownDivergence(spec, name);
                    if (divergence) test.fail(true, `known divergence: ${divergence.reason}`);

                    const t = results.tests[idx];
                    if (t.status === 'pending') {
                        test.skip(true, t.message || 'pending upstream stub');
                        return;
                    }
                    expect(t.status, t.message || name).toBe('success');
                });
            });

            // ── Errors raised outside any it() ───────────────────────────────
            // A spec that blew up while loading, in a describe body or in a
            // setup hook produces no test record at all, so it would otherwise
            // pass by having nothing to assert. Same for a spec whose recording
            // failed outright — bustedRecord.ts writes that as an error rather
            // than letting one bad boot take down the run.
            test(`${spec}: recorded cleanly`, () => {
                expect(results, `${spec} is missing from the recording`).toBeTruthy();
                expect(
                    results.failures.filter(f => f.name.endsWith('recording failed')).map(f => f.message),
                    `${spec} could not be recorded`,
                ).toEqual([]);
                expect(results.errors, `${spec}: ${results.errors} error(s) outside any it()`).toBe(0);
                expect(results.total, `${spec} ran no tests at all`).toBeGreaterThan(0);
            });
        });
    }

    // ── Unsupported areas still skip for the reason we recorded ─────────────
    // A whole area that cannot run here skips rather than fails, which makes it
    // look exactly like an area whose fixture we simply have not started. The
    // entry in knownDivergences.ts is what tells those apart — so it has to keep
    // matching something. When it stops, either upstream rewrote the gate or the
    // capability arrived, and both are worth a look rather than a silently wrong
    // note.
    test.describe('unsupported areas', () => {
        for (const area of UNSUPPORTED_AREAS.filter(a => SPECS.includes(a.spec))) {
            test(`${area.area} still skips for the recorded reason`, () => {
                const matching = (run.results[area.spec]?.tests ?? []).filter(t =>
                    t.status === 'pending' && (t.message ?? '').includes(area.pendingReason));
                expect(
                    matching.length,
                    `No ${area.spec} test skips with "${area.pendingReason}" any more. Either the capability `
                    + `arrived or upstream changed the gate — update or remove this entry in `
                    + `e2e/knownDivergences.ts rather than leaving it describing something that no longer happens.`,
                ).toBeGreaterThan(0);
            });
        }
    });

    // ── Divergence guard: every recorded divergence must still name a live it() ──
    // Without this, an it() renamed or dropped upstream would leave a dead entry in
    // knownDivergences.ts — and dead entries are worse than none: the next person
    // reads the list as the complete account of where mudix differs from Mudlet, and
    // a stale line makes that account wrong.
    test(`known divergences all name a live spec${SHARD ? ` (shard ${SHARD.index}/${SHARD.total})` : ''}`, () => {
        const dead: string[] = [];
        for (const [spec, divergences] of Object.entries(KNOWN_DIVERGENCES)) {
            // Under BUSTED_SHARD the other shards' specs were never recorded
            // here, so their divergences have nothing to check against — the
            // shard that owns the spec is the one that checks it.
            if (!SPECS.includes(spec)) continue;
            const names = new Set((run.results[spec]?.tests ?? []).map(t => t.name));
            for (const d of divergences) {
                if (!names.has(d.name)) dead.push(`${spec}: "${d.name}"`);
            }
        }
        expect(
            dead,
            'knownDivergences.ts names it()s that no longer exist — the spec was renamed or dropped '
            + 'upstream, so the entry is now hiding nothing and should be removed:\n  ' + dead.join('\n  '),
        ).toEqual([]);
    });
}
