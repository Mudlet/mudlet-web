import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Dedicated config for the busted triage runner. Run with `yarn busted:failures`
// (optionally `SPECS=Other,Media yarn busted:failures`).
//
// This inverts the default testMatch — e2e/bustedFailures.ts is not a *.spec.ts,
// so it never runs in the normal suite. Reporter is `list` only: the runner's own
// console output is the report, and an HTML report of a single test adds nothing.
export default defineConfig({
    ...base,
    testMatch: /bustedFailures\.ts$/,
    // The triage runner sweeps the corpus itself, one spec at a time on its own
    // page, so it must not also pull in the recording globalSetup the normal
    // suite is built on — that would sweep all 41 specs before this run started,
    // and this run IS the sweep. It always needs the app, so the dev server is
    // declared here rather than inherited (the base config drops it whenever the
    // recording is still fresh).
    globalSetup: undefined,
    webServer: {
        command: 'npm run dev:busted',
        url: 'http://localhost:5174',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
    reporter: [['list']],
});
