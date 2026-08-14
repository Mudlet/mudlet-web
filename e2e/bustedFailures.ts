import { test } from '@playwright/test';
import fs from 'node:fs';
import { ALL_SPECS, seedProfile, reopen, runSpec, type BustedFailure } from './bustedHarness';
import { KNOWN_DIVERGENCES, knownDivergence } from './knownDivergences';

// Triage runner for the busted corpus:  `yarn busted:failures [Other,Media]`
//
// Same corpus and the same real app as busted.spec.ts, but one Playwright test
// for the whole sweep instead of one per Mudlet it(). That matters when you're
// working through a batch of failures: Playwright discards the worker after each
// failed test, which throws away bustedHarness's per-spec result cache, so the
// per-it() suite re-runs a whole spec for every failure it reports. Here each
// spec runs exactly once no matter how much is red, and every failure prints
// with its assertion message — the thing you actually need to fix it.
//
// Filter with SPECS (comma-separated, matched case-insensitively as substrings)
// to iterate on one area:  SPECS=Other yarn busted:failures
//
// Writes e2e/busted-failures.json alongside the console output so a run can be
// diffed against the previous one — the quickest way to see whether a fix moved
// the number and whether anything regressed.
const OUT = new URL('./busted-failures.json', import.meta.url);

const filter = (process.env.SPECS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const specs = filter.length
    ? ALL_SPECS.filter(s => filter.some(f => s.toLowerCase().includes(f)))
    : ALL_SPECS;

test('report busted failures', async ({ page }) => {
    test.setTimeout(30 * 60_000); // whole corpus in one test, ~17s per heavy spec
    if (!specs.length) throw new Error(`SPECS=${process.env.SPECS} matched no spec`);

    await seedProfile(page);
    const all: (BustedFailure & { spec: string })[] = [];
    const allPending: { spec: string; name: string; message?: string }[] = [];
    const perSpec: { spec: string; passed: number; failed: number; errors: number; pending: number }[] = [];

    for (const spec of specs) {
        await reopen(page); // fresh console per spec; addInitScript re-seeds
        try {
            const r = await runSpec(page, spec);
            perSpec.push({ spec, passed: r.passed, failed: r.failed, errors: r.errors, pending: r.pending });
            for (const f of r.failures) all.push({ ...f, spec });
            for (const t of r.tests) if (t.status === 'pending') allPending.push({ ...t, spec });
        } catch (err) {
            // A spec can take the Lua state down with it rather than failing an
            // assertion — a wasm "memory access out of bounds" aborts the whole
            // page.evaluate. Record it against the spec and carry on: the next
            // reopen() builds a fresh runtime, and one crashing spec must not
            // cost visibility into the other thirty-odd.
            perSpec.push({ spec, passed: 0, failed: 0, errors: 1, pending: 0 });
            all.push({
                spec,
                name: '<spec aborted — the Lua runtime died mid-run>',
                message: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // Assertions mudix deliberately does not satisfy are separated out rather
    // than printed as failures: this runner exists to show what is left to fix,
    // and three permanent entries at the top of every run train the eye to skim
    // past exactly the section that matters. They are still listed, at the end,
    // because "we chose this" has to stay visible to be re-litigated.
    const isDivergence = (f: { spec: string; name: string }) => !!knownDivergence(f.spec, f.name);
    const real = all.filter(f => !isDivergence(f));
    const diverged = all.filter(isDivergence);

    const lines: string[] = [];
    for (const { spec, passed, failed, errors, pending } of perSpec) {
        const specFailures = real.filter(x => x.spec === spec);
        // Counted, not derived by subtracting from `failed`: `all` also holds the
        // errors raised outside any it(), which that count does not include, so
        // the subtraction went negative for a spec that had one.
        const specDiverged = diverged.filter(x => x.spec === spec).length;
        if (!specFailures.length && !errors) continue;
        lines.push(`\n━━ ${spec}_spec — ${specFailures.length} failed, ${passed} passed`
            + `${errors ? `, ${errors} error(s) outside any it()` : ''}`
            + `${pending ? `, ${pending} pending` : ''}`
            + `${specDiverged ? `, ${specDiverged} known divergence(s)` : ''}`);
        for (const f of specFailures) {
            lines.push(`\n  ✗ ${f.name}`);
            // The message is the whole point of this runner; keep it intact
            // rather than truncating, but drop busted's blank padding lines.
            for (const l of (f.message ?? '').split('\n')) if (l.trim()) lines.push(`      ${l}`);
        }
    }
    const totals = perSpec.reduce((a, s) => ({
        passed: a.passed + s.passed, failed: a.failed + s.failed, errors: a.errors + s.errors,
    }), { passed: 0, failed: 0, errors: 0 });
    lines.push(`\n━━ TOTAL: ${real.length} failed, ${totals.passed} passed`
        + `${totals.errors ? `, ${totals.errors} error(s) outside any it()` : ''}`
        + `${diverged.length ? `, ${diverged.length} known divergence(s)` : ''}`
        + ` across ${specs.length} spec(s)`);

    if (diverged.length) {
        lines.push('\n━━ Known divergences (deliberate — see e2e/knownDivergences.ts)');
        for (const f of diverged) lines.push(`  · ${f.spec}: ${f.name}`);
    }
    // Sanity: every divergence we recorded should be among the failures, or the
    // entry has gone stale and is masking nothing. busted.spec.ts turns that into
    // a red run; here it is a line in the report, since this runner is advisory.
    const recorded = Object.values(KNOWN_DIVERGENCES).reduce((n, d) => n + d.length, 0);
    if (!filter.length && diverged.length < recorded) {
        lines.push(`\n  ! ${recorded - diverged.length} recorded divergence(s) did not fail — `
            + 'they may now pass; check e2e/knownDivergences.ts');
    }

    // Pending reasons, grouped. A skip is only informative if you can see why:
    // "fixture server not running" is a gap in the harness worth closing, while
    // "peer-to-peer TCP" is something this client can never do, and the two are
    // indistinguishable from a count. Written to the JSON rather than printed —
    // there are a couple of hundred, and the console output is for failures.
    const pendingByReason: Record<string, string[]> = {};
    for (const p of allPending) {
        (pendingByReason[p.message || '(no reason given)'] ??= []).push(`${p.spec}: ${p.name}`);
    }
    const pendingSummary = Object.entries(pendingByReason)
        .map(([reason, tests]) => ({ reason, count: tests.length, tests }))
        .sort((a, b) => b.count - a.count);

    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    fs.writeFileSync(fs.realpathSync(new URL('.', OUT)) + '/busted-failures.json',
        JSON.stringify({ perSpec, failures: all, pending: pendingSummary }, null, 2) + '\n');
});
