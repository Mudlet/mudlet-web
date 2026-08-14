import { test } from '@playwright/test';
import fs from 'node:fs';
import {
    ALL_SPECS, seedProfile, reopen, runSpec, manifestPath,
} from './bustedHarness';

// Manifest generator for the per-test busted suite. Run via its own config so it
// never runs as part of the normal suite:  `npm run gen:busted-manifest`.
//
// It drives the real app once per spec, collects every it()'s full name, and
// writes e2e/busted.manifest.json — the static list busted.spec.ts reads at
// collection time to register one Playwright test() per Mudlet it(). Regenerate
// whenever the spec corpus is re-synced; the drift guard in busted.spec.ts fails
// until you do.
test('generate busted manifest', async ({ page }) => {
    // The whole corpus runs inside this one test, so it needs the same budget
    // the triage runner gives itself rather than the default per-test cap.
    // Package_spec alone takes minutes now that it has a body to run.
    test.setTimeout(30 * 60_000);
    await seedProfile(page);
    const manifest: Record<string, string[]> = {};
    let totalTests = 0;
    for (const spec of ALL_SPECS) {
        await reopen(page); // fresh console per spec; addInitScript re-seeds
        const r = await runSpec(page, spec);
        manifest[spec] = r.tests.map(t => t.name);
        totalTests += r.tests.length;
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    test.info().annotations.push({
        type: 'manifest',
        description: `${ALL_SPECS.length} specs, ${totalTests} tests → ${manifestPath}`,
    });
});
