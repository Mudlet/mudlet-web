import { test, expect, type Page } from '@playwright/test';

/**
 * Does a profile that called saveProfile() open again as it was? (#259)
 *
 * saveProfile() writes a current/*.xml. Before the fix, that file alone made the
 * next open treat the profile as a linked Mudlet folder and take its package set
 * from the save — which listed none — so every reopen re-installed the default
 * packages (sysInstall for each) and forgot the ones the user installed.
 * Desktop raises no install event on a reopen and keeps the package list.
 *
 * Needs a real reload, so it lives in the reload suite (`yarn test:e2e:upgrade`).
 */

/** A package whose only script reports every sysInstall it sees, so a reopen
 *  that re-installs anything says so in the output. */
const VPKG_XML = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE MudletPackage><MudletPackage version="1.001">'
    + '<ScriptPackage><Script isActive="yes" isFolder="no"><name>vpkg</name><packageName></packageName>'
    + '<script>registerAnonymousEventHandler("sysInstall", function(_, n) echo("SYSINSTALL:" .. n .. "\\n") end)</script>'
    + '<eventHandlerList /></Script></ScriptPackage></MudletPackage>';

async function lua(page: Page, code: string) {
    const input = page.getByLabel('Command input').first();
    await input.fill(`lua ${code}`);
    await input.press('Enter');
}

test('saveProfile() does not change how the profile reopens', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto('/');
    await page.locator('.connection-tile__add, [class*="tile__add"]').first().click();
    await page.locator('#cs-name').fill('Saved');
    await page.locator('#cs-host').fill('example.com');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    // --- phase 1: install a package, then saveProfile() ---
    await page.getByRole('button', { name: 'Open Saved offline' }).click();
    // The default packages are in once run-lua-code answers.
    await expect(async () => {
        // Split, so the echoed command line itself can't match.
        await lua(page, 'echo("RE" .. "ADY\\n")');
        await expect(page.getByText('READY', { exact: true }).first()).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });

    await lua(page, `local f = io.open(getMudletHomeDir() .. "/vpkg.xml", "w") f:write([[${VPKG_XML}]]) f:close()`
        + ' installPackage(getMudletHomeDir() .. "/vpkg.xml")');
    await expect(page.getByText('SYSINSTALL:vpkg').first()).toBeVisible({ timeout: 30_000 });
    await lua(page, 'local ok, path = saveProfile() echo("SAVED:" .. tostring(ok) .. ":" .. tostring(path) .. "\\n")');
    await expect(page.getByText(/SAVED:true:.*current\/.*\.xml/).first()).toBeVisible({ timeout: 30_000 });
    // Let the profile's filesystem settle before the page goes away.
    await page.waitForTimeout(3_000);

    // --- phase 2: reopen ---
    await page.goto('/');
    await page.reload();
    await page.getByRole('button', { name: 'Open Saved offline' }).click();
    await expect(async () => {
        await lua(page, 'local p = getPackages() table.sort(p) echo("PKGS:" .. table.concat(p, ",") .. "\\n")');
        await expect(page.getByText(/PKGS:[\w-]/).first()).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });

    const pkgs = (await page.getByText(/PKGS:[\w-]/).first().textContent()) ?? '';
    expect(pkgs.replace(/^.*PKGS:/, '').trim().split(','), 'the installed package is still registered')
        .toContain('vpkg');
    await expect(page.getByText(/SYSINSTALL:\w/), 'nothing is re-installed on a reopen').toHaveCount(0);

    expect(errors, 'the reopen should raise nothing').toEqual([]);
});
