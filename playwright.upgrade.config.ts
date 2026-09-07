import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Dedicated config for the upgrade suite: does an existing user's browser
// survive a storage migration? Run with `yarn test:e2e:upgrade`.
//
// Separate from the busted suite for three reasons. It drives a browser, so it
// cannot ride the base config's optimisation of dropping the web server whenever
// the recording is still fresh. It must not pull in the recording globalSetup,
// which would sweep all 41 Mudlet specs before this run started. And it needs a
// *built* app rather than the dev server: the suite reloads the page to simulate
// an upgrade, and Vite's dev server does not survive that reliably — a stale
// module graph would make a passing run meaningless.
//
// Its own port so it can never reuse (or be reused by) a dev server, busted or
// otherwise, that is serving different bytes.
export default defineConfig({
    ...base,
    testDir: './e2e/upgrade',
    globalSetup: undefined,
    // One test, and it walks a whole app boot twice; the default 30s is tight.
    timeout: 180_000,
    fullyParallel: false,
    workers: 1,
    use: { ...base.use, baseURL: 'http://localhost:5177' },
    webServer: {
        command: 'npm run build && npx vite preview --port 5177 --strictPort',
        url: 'http://localhost:5177',
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
    },
    reporter: process.env.CI
        ? [['junit', { outputFile: 'playwright-report/upgrade-results.xml' }], ['list']]
        : [['list']],
});
