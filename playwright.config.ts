import { defineConfig, devices } from '@playwright/test';
import { isFresh } from './e2e/bustedRecord';

// Single execution path for Mudlet's busted suite: drive the REAL mudix app in a
// browser (not the node thin-layer), so the full ScriptingEngine — trigger/alias
// dispatch, timer pump, overlay/Geyser geometry — is wired exactly as in
// production. The dev server runs with VITE_BUSTED=1 (via `vite --mode busted`),
// which bundles the spec corpus and exposes window.__runBusted.
//
// The run has two halves. globalSetup (e2e/bustedRecord.ts) does all the browser
// work: it sweeps the 41 specs in parallel contexts and writes the results.
// Playwright loads test files only after global setup, so e2e/busted.spec.ts can
// then build the test tree out of that recording — one test() per Mudlet it(),
// each a pure assertion over a verdict that is already in. Nothing is committed
// and nothing is generated ahead of a run, so there is no manifest to regenerate
// and nothing that can drift from the corpus.
const fresh = isFresh();

export default defineConfig({
    testDir: './e2e',
    globalSetup: './e2e/bustedRecord.ts',
    // The tests are pure functions of the recording — no page, no browser — so
    // they fan out freely and cost milliseconds each. (They used to take a
    // browser context apiece, which was ~60% of the suite's wall clock.)
    fullyParallel: true,
    workers: '50%',
    forbidOnly: !!process.env.CI,
    retries: 0,
    timeout: 30_000,
    // No global timeout on the run itself: the corpus sweep in globalSetup is the
    // long pole (~35s warm, more on a small CI box) and is not covered by the
    // per-test timeout above.
    reporter: process.env.CI
        ? [['junit', { outputFile: 'playwright-report/results.xml' }], ['list']]
        : [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL: 'http://localhost:5174',
        trace: 'on-first-retry',
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
    // Only globalSetup needs the app, so a run that reuses its recording (see
    // isFresh: nothing under src/ or e2e/ has changed since) skips the server
    // altogether — which is what makes re-running a single it() from an IDE
    // instant rather than a fresh sweep of the whole corpus.
    //
    // Dedicated port 5174 (not the default 5173 `npm run dev` uses): with
    // reuseExistingServer on, this guarantees we only ever reuse a busted-mode
    // server, never a developer's plain dev server that lacks VITE_BUSTED.
    webServer: fresh ? undefined : {
        command: 'npm run dev:busted',
        url: 'http://localhost:5174',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
