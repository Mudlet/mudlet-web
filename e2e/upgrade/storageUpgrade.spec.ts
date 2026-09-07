import { test, expect, type Page } from '@playwright/test';

/**
 * Does an existing user's browser survive the storage rename?
 *
 * Storage was renamed from `mudix_*` to `mudlet_*`, and `src/storage/
 * storageMigration.ts` is the only thing standing between an existing user and
 * a client that looks like a fresh install while their profiles sit unreachable
 * under the old names. That failure is silent, permanent from the user's side,
 * and — this is the point of running it here — invisible to type checking and to
 * every unit test in the suite. The rename shipped with a bug of exactly this
 * shape: a constant rewritten from `.mudix` to `.mudlet` turned the
 * dot-directory move into a no-op, and only driving a real browser caught it.
 *
 * The pre-rename state is *built* rather than committed. A fixture of a real
 * profile is 1.5 MB and would go stale the moment the VFS layout changed; here
 * the app itself produces the profile, and the test then renames its storage
 * back to the old names — the same copy the migration performs, in reverse. So
 * what is migrated is always genuine, current ZenFS output.
 *
 * Runs under its own config (`yarn test:e2e:upgrade`) against a *built* app: it
 * reloads the page, which the dev server does not survive reliably.
 */

/** Record count, total bytes and a checksum over every byte of a profile's
 *  filesystem, so "unchanged" means unchanged rather than "about the same". */
async function surveyProfileVfs(page: Page, connectionId: string, prefix: string) {
    return page.evaluate(async ({ id, pre }) => {
        const name = pre + id;
        const exists = (await indexedDB.databases()).some(d => d.name === name);
        if (!exists) return null;
        const db = await new Promise<IDBDatabase>((res, rej) => {
            const r = indexedDB.open(name);
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
        const store = db.objectStoreNames[0];
        const values = await new Promise<unknown[]>((res, rej) => {
            const req = db.transaction(store, 'readonly').objectStore(store).getAll();
            req.onsuccess = () => res(req.result as unknown[]);
            req.onerror = () => rej(req.error);
        });
        db.close();
        let bytes = 0, sum = 0;
        for (const v of values) {
            const u = v instanceof Uint8Array ? v : new Uint8Array((v as { buffer: ArrayBuffer }).buffer);
            bytes += u.length;
            for (let i = 0; i < u.length; i++) sum = (sum * 31 + u[i]) >>> 0;
        }
        return { store, records: values.length, bytes, sum };
    }, { id: connectionId, pre: prefix });
}

/**
 * Put this origin back the way it looked before the rename.
 *
 * The inverse of storageMigration: databases are copied under their old names
 * (with the object store inside a profile database renamed back too, since ZenFS
 * derives it from the database name), the localStorage keys are moved back, and
 * the completion markers are cleared so the migration runs again on next load.
 */
async function downgradeStorage(page: Page) {
    await page.evaluate(async () => {
        const copyDatabase = async (from: string, to: string) => {
            const source = await new Promise<IDBDatabase>((res, rej) => {
                const r = indexedDB.open(from);
                r.onsuccess = () => res(r.result);
                r.onerror = () => rej(r.error);
            });
            const stores = Array.from(source.objectStoreNames);
            const dump: Record<string, { keys: IDBValidKey[]; values: unknown[]; keyPath: unknown; autoIncrement: boolean }> = {};
            for (const s of stores) {
                const os = source.transaction(s, 'readonly').objectStore(s);
                const get = <T>(req: IDBRequest<T>) => new Promise<T>((res, rej) => {
                    req.onsuccess = () => res(req.result);
                    req.onerror = () => rej(req.error);
                });
                dump[s] = {
                    keys: await get(os.getAllKeys()),
                    values: await get(os.getAll()),
                    keyPath: os.keyPath,
                    autoIncrement: os.autoIncrement,
                };
            }
            source.close();

            // A profile's filesystem lives in a store named after its database.
            const renamed = (s: string) => (s === from ? to : s);
            const target = await new Promise<IDBDatabase>((res, rej) => {
                const r = indexedDB.open(to, 1);
                r.onupgradeneeded = () => {
                    for (const s of stores) {
                        r.result.createObjectStore(renamed(s), {
                            keyPath: (dump[s].keyPath as string) ?? undefined,
                            autoIncrement: dump[s].autoIncrement,
                        });
                    }
                };
                r.onsuccess = () => res(r.result);
                r.onerror = () => rej(r.error);
            });
            for (const s of stores) {
                await new Promise<void>((res, rej) => {
                    const tx = target.transaction(renamed(s), 'readwrite');
                    const os = tx.objectStore(renamed(s));
                    dump[s].values.forEach((v, i) => {
                        if (dump[s].keyPath) os.put(v); else os.put(v, dump[s].keys[i]);
                    });
                    tx.oncomplete = () => res();
                    tx.onerror = () => rej(tx.error);
                });
            }
            target.close();
            await new Promise<void>(res => {
                const r = indexedDB.deleteDatabase(from);
                r.onsuccess = () => res();
                r.onerror = () => res();
                r.onblocked = () => res();
            });
        };

        for (const { name } of await indexedDB.databases()) {
            if (name?.startsWith('mudlet_')) await copyDatabase(name, 'mudix_' + name.slice('mudlet_'.length));
        }

        for (const key of Object.keys(localStorage)) {
            if (key === 'mudlet_v1') { localStorage.setItem('mudix_v1', localStorage.getItem(key)!); localStorage.removeItem(key); }
            else if (key.startsWith('mudlet_history_')) {
                localStorage.setItem('cmd.history.' + key.slice('mudlet_history_'.length), localStorage.getItem(key)!);
                localStorage.removeItem(key);
            } else if (key.startsWith('mudlet_stopwatches_')) {
                localStorage.setItem('mudix_stopwatches_' + key.slice('mudlet_stopwatches_'.length), localStorage.getItem(key)!);
                localStorage.removeItem(key);
            } else if (key.startsWith('mudlet_names_migrated') || key.startsWith('mudlet_idb_names_migrated')) {
                localStorage.removeItem(key);   // so the migration runs again
            }
        }
    });
}

const localStorageKeys = (page: Page) => page.evaluate(() => Object.keys(localStorage).sort());
const databaseNames = (page: Page) =>
    page.evaluate(async () => (await indexedDB.databases()).map(d => d.name).filter(Boolean).sort());
const connections = (page: Page) => page.evaluate(() =>
    JSON.parse(localStorage.getItem('mudlet_v1') ?? '{"state":{"connections":[]}}')
        .state.connections.map((c: { id: string; name: string; host?: string }) =>
            ({ id: c.id, name: c.name, host: c.host })));

test('a browser from before the storage rename keeps its profile', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));

    // --- a profile made by the real app, with a real filesystem behind it ---
    await page.goto('/');
    await page.locator('.connection-tile__add, [class*="tile__add"]').first().click();
    await page.locator('#cs-name').fill('Achaea');
    await page.locator('#cs-host').fill('achaea.com');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    // The store blob is written on a debounce.
    await page.waitForFunction(() => {
        const raw = localStorage.getItem('mudlet_v1');
        return !!raw && JSON.parse(raw).state.connections.length > 0;
    }, undefined, { timeout: 30_000 });
    const [created] = await connections(page);

    // Opening it mounts the VFS and installs the default packages — that is what
    // makes this a real filesystem rather than an empty one.
    await page.getByRole('button', { name: 'Open Achaea offline' }).click();
    await expect(page.getByText(/Mudlet Mapper script/i).first()).toBeVisible({ timeout: 60_000 });

    const before = await surveyProfileVfs(page, created.id, 'mudlet_vfs_');
    expect(before, 'the profile should have a populated filesystem').not.toBeNull();
    expect(before!.records).toBeGreaterThan(5);

    // --- rewind this origin to how it looked before the rename ---
    await page.goto('/');   // leave the profile so nothing holds its database open
    await downgradeStorage(page);
    expect(await databaseNames(page)).toContain(`mudix_vfs_${created.id}`);
    expect(await localStorageKeys(page)).toContain('mudix_v1');

    // --- the upgrade: load the current build on top of it ---
    await page.reload();
    await expect(page.getByText('Achaea').first()).toBeVisible({ timeout: 60_000 });

    const listed = await connections(page);
    expect(listed).toHaveLength(1);
    expect(listed[0], 'the profile keeps its identity, not a new one')
        .toMatchObject({ id: created.id, name: 'Achaea', host: 'achaea.com' });

    // Opening it is what drives the database rename, which is lazy.
    await page.getByRole('button', { name: 'Open Achaea offline' }).click();
    await expect(page.getByText(/Mudlet Mapper script/i).first()).toBeVisible({ timeout: 60_000 });

    const after = await surveyProfileVfs(page, created.id, 'mudlet_vfs_');
    expect(after, 'the profile filesystem should have moved to the new name').not.toBeNull();
    expect(after!.store, 'the store inside is renamed with its database')
        .toBe(`mudlet_vfs_${created.id}`);
    // A fresh install would also be populated, so size alone proves nothing —
    // that the legacy database is *gone* is what says this data was moved.
    expect(after!.records).toBeGreaterThanOrEqual(before!.records);
    expect(after!.bytes).toBeGreaterThanOrEqual(before!.bytes);

    const names = await databaseNames(page);
    expect(names.filter(n => n!.startsWith('mudix')), 'no legacy database is left behind').toEqual([]);
    const keys = await localStorageKeys(page);
    expect(keys.filter(k => k.startsWith('mudix') || k.startsWith('cmd.history')),
        'no legacy localStorage key is left behind').toEqual([]);

    expect(errors, 'the upgrade should raise nothing').toEqual([]);
});
