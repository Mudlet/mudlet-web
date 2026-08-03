import { test } from '@playwright/test';
import fs from 'node:fs';
import { ALL_SPECS, seedProfile, reopen, runSpec, type BustedFailure } from './bustedHarness';

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
    const perSpec: { spec: string; passed: number; failed: number; errors: number; pending: number }[] = [];

    for (const spec of specs) {
        await reopen(page); // fresh console per spec; addInitScript re-seeds
        try {
            const r = await runSpec(page, spec);
            perSpec.push({ spec, passed: r.passed, failed: r.failed, errors: r.errors, pending: r.pending });
            for (const f of r.failures) all.push({ ...f, spec });
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

    const lines: string[] = [];
    for (const { spec, passed, failed, errors, pending } of perSpec) {
        if (!failed && !errors) continue;
        lines.push(`\n━━ ${spec}_spec — ${failed} failed, ${passed} passed`
            + `${errors ? `, ${errors} error(s) outside any it()` : ''}`
            + `${pending ? `, ${pending} pending` : ''}`);
        for (const f of all.filter(x => x.spec === spec)) {
            lines.push(`\n  ✗ ${f.name}`);
            // The message is the whole point of this runner; keep it intact
            // rather than truncating, but drop busted's blank padding lines.
            for (const l of (f.message ?? '').split('\n')) if (l.trim()) lines.push(`      ${l}`);
        }
    }
    const totals = perSpec.reduce((a, s) => ({
        passed: a.passed + s.passed, failed: a.failed + s.failed, errors: a.errors + s.errors,
    }), { passed: 0, failed: 0, errors: 0 });
    lines.push(`\n━━ TOTAL: ${totals.failed} failed, ${totals.passed} passed`
        + `${totals.errors ? `, ${totals.errors} error(s) outside any it()` : ''}`
        + ` across ${specs.length} spec(s)`);

    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    fs.writeFileSync(fs.realpathSync(new URL('.', OUT)) + '/busted-failures.json',
        JSON.stringify({ perSpec, failures: all }, null, 2) + '\n');
});
