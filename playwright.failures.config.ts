import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Dedicated config for the busted triage runner. Run with `yarn busted:failures`
// (optionally `SPECS=Other,Media yarn busted:failures`).
//
// Like playwright.manifest.config.ts, this inverts the default testMatch —
// e2e/bustedFailures.ts is not a *.spec.ts, so it never runs in the normal
// suite — and reuses the base webServer (the VITE_BUSTED dev server) and
// browser. Reporter is `list` only: the runner's own console output is the
// report, and an HTML report of a single test adds nothing.
export default defineConfig({
    ...base,
    testMatch: /bustedFailures\.ts$/,
    reporter: [['list']],
});
