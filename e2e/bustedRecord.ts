import { chromium, type FullConfig } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    ALL_SPECS, bootProfile, runSpec, resultsPath, fingerprint,
    type BustedResults, type RecordedRun,
} from './bustedHarness';

// globalSetup: runs Mudlet's whole busted corpus against the real app ONCE, and
// writes the results where the spec file can read them at collection time.
//
// That ordering is the point. Playwright's runner does global setup BEFORE it
// loads test files (webServer plugin → globalSetup → load → run), so by the time
// busted.spec.ts is imported the results are on disk — which means the test tree
// can be built from them: one Playwright test() per Mudlet it(), with its verdict
// already decided. Nothing about the corpus has to be committed to know the tree
// in advance, and nothing can drift from it, because the names and the statuses
// come from the same run.
//
// The tests themselves then touch no browser at all. All ~3300 of them are pure
// assertions over this file, so they cost milliseconds instead of a browser
// context each — which is what the suite used to spend most of its wall clock on.

// Specs are independent: each gets its own browser context and its own app boot,
// so nothing leaks between them (busted insulates Lua _G, but not the JS console,
// the Geyser overlay, or the profile VFS — a reload is what resets those). That
// makes the corpus embarrassingly parallel; the only real limit is CPU, since
// every context instantiates wasmoon + pcre2 + sqlite WASM and then runs a whole
// spec. Measured on a 24-thread box: 6 at a time took the corpus from 4m0s to
// 35s, while 12 starved boots badly enough that the readiness wait timed out.
// Hence a quarter of the threads — but never fewer than two, since a small CI
// runner would otherwise record the whole corpus serially, and a context waiting
// on the app is not using a core anyway.
const cpus = os.availableParallelism?.() ?? os.cpus().length;
const CONCURRENCY = Math.max(2, Math.min(6, Math.floor(cpus / 4)));

async function recordSpec(
    browser: import('@playwright/test').Browser, baseURL: string | undefined, spec: string,
): Promise<BustedResults> {
    const context = await browser.newContext({ baseURL });
    try {
        const page = await context.newPage();
        await bootProfile(page);
        return await runSpec(page, spec);
    } catch (err) {
        // One spec that cannot even boot must not take the run down with it:
        // globalSetup throwing kills every test, including the 3200 that have
        // nothing to do with this spec. Recorded as an error instead, so the
        // spec's own guard is what goes red and says why.
        return {
            total: 0, passed: 0, failed: 0, errors: 1, pending: 0, tests: [],
            failures: [{ spec, name: `${spec}: recording failed`, message: String(err) }],
        };
    } finally {
        await context.close();
    }
}

const failedToRecord = (r: BustedResults) => r.failures.some(f => f.name.endsWith('recording failed'));

export default async function record(config: FullConfig): Promise<void> {
    if (isFresh()) {
        console.log(`busted: reusing ${path.basename(resultsPath)} (unchanged since it was recorded)`);
        return;
    }
    const baseURL = config.projects[0]?.use?.baseURL;
    const browser = await chromium.launch();
    const results: Record<string, BustedResults> = {};
    const [warmUp, ...rest] = ALL_SPECS;
    const queue = [...rest];
    let done = 0;
    const report = (spec: string) => console.log(
        `busted: ${String(++done).padStart(2)}/${ALL_SPECS.length} ${spec}`);
    const started = Date.now();
    try {
        // The first spec goes alone. The dev server is a Vite dev server, which
        // transforms the app's modules on demand and does it on one thread, so a
        // cold one meeting six simultaneous first loads serialises them all — and
        // measured that way it took long enough for two specs to blow the 90s
        // readiness wait, on a box where a warm server records the whole corpus
        // in 35s. One boot first warms the transform cache for the other 40.
        results[warmUp] = await recordSpec(browser, baseURL, warmUp);
        report(warmUp);

        await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
            for (let spec = queue.shift(); spec; spec = queue.shift()) {
                results[spec] = await recordSpec(browser, baseURL, spec);
                report(spec);
            }
        }));

        // A spec that could not be recorded gets one more try with the machine to
        // itself. A boot that lost a race for the CPU is the one failure here
        // that says nothing about mudix, and it would otherwise fail the spec's
        // guard — a red run for a reason no one can act on. A spec that fails
        // this pass too has something real to answer for.
        for (const spec of ALL_SPECS.filter(s => failedToRecord(results[s]))) {
            console.log(`busted: retrying ${spec} on its own`);
            results[spec] = await recordSpec(browser, baseURL, spec);
        }
    } finally {
        await browser.close();
    }
    const run: RecordedRun = { fingerprint: fingerprint(), results };
    fs.writeFileSync(resultsPath, JSON.stringify(run));
    console.log(`busted: recorded ${ALL_SPECS.length} specs in ${Math.round((Date.now() - started) / 1000)}s`);
}

// Re-record unless the last recording still describes this working tree.
//
// A run is only worth reusing if nothing it could depend on has changed, so the
// fingerprint covers the app source, the spec corpus and the harness alike (see
// fingerprint()). CI checks out fresh and therefore always records; locally, this
// is what makes re-running one it() from an IDE instant instead of a fresh sweep
// of all 41 specs, while still re-recording the moment you touch anything.
export function isFresh(): boolean {
    try {
        const run = JSON.parse(fs.readFileSync(resultsPath, 'utf8')) as RecordedRun;
        return run.fingerprint === fingerprint()
            && ALL_SPECS.every(spec => run.results[spec] !== undefined);
    } catch {
        return false;
    }
}

