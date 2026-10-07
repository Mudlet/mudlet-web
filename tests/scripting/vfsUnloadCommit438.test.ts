// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { StoreFS, mount, umount, writeFileSync, readFileSync } from '@zenfs/core';
import { IndexedDBStore } from '@zenfs/dom';
import { commitSyncWritesImmediately } from '../../src/scripting/vfs/idbCommit';

/**
 * #438: a file written in sysExitEvent as the tab closes was gone on the next
 * load, so Geyser Adjustable.Container layouts reset. ZenFS's sync writes
 * issue their IndexedDB requests at once but leave the transaction to
 * auto-commit, which Chromium does from the page, after the requests' success
 * events reach it — and a closing page never gets them, so the transaction is
 * aborted with it.
 *
 * FakeDb models exactly that: a transaction's writes become durable when it
 * is committed explicitly, or when the event loop has delivered every one of
 * its success events. "Closing the page" is simply not yielding to the event
 * loop before reading back what was durable.
 */

class FakeRequest<T = unknown> {
    result!: T;
    error: unknown = null;
    onsuccess: (() => void) | null = null;
    onerror: ((e: { preventDefault(): void }) => void) | null = null;
}

class FakeTx {
    private ops: Array<[number, Uint8Array | null]> = [];
    private pending = 0;
    finished = false;
    oncomplete: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    error = null;
    constructor(private db: FakeDb) {}

    objectStore() {
        const request = <T>(result: T): FakeRequest<T> => {
            const req = new FakeRequest<T>();
            req.result = result;
            this.pending++;
            setTimeout(() => {
                req.onsuccess?.();
                // Chromium's auto-commit: the page saw every request finish.
                if (--this.pending === 0 && !this.finished) this.finish();
            }, 0);
            return req;
        };
        return {
            put: (value: Uint8Array, key: number) => {
                const copy = new Uint8Array(value);
                this.db.view.set(key, copy);
                this.ops.push([key, copy]);
                return request(key);
            },
            delete: (key: number) => {
                this.db.view.delete(key);
                this.ops.push([key, null]);
                return request(undefined);
            },
            get: (key: number) => request(this.db.view.get(key)),
            getAllKeys: () => request([...this.db.view.keys()]),
        };
    }

    commit(): void {
        if (this.finished) throw new Error('InvalidStateError');
        this.finish();
    }

    abort(): void { this.finished = true; }

    private finish(): void {
        this.finished = true;
        for (const [key, value] of this.ops) {
            if (value) this.db.durable.set(key, value);
            else this.db.durable.delete(key);
        }
        this.oncomplete?.();
    }
}

class FakeDb {
    /** What this page reads back: every write it has issued. */
    readonly view: Map<number, Uint8Array>;
    /** What the next page load will find. */
    readonly durable: Map<number, Uint8Array>;
    constructor(readonly name: string, seed = new Map<number, Uint8Array>()) {
        this.view = new Map(seed);
        this.durable = new Map(seed);
    }
    transaction() { return new FakeTx(this); }
}

const tick = () => new Promise(r => setTimeout(r, 5));

/** What @zenfs/dom's IndexedDB backend does on create, over a FakeDb. */
async function openFs(db: FakeDb): Promise<StoreFS<IndexedDBStore>> {
    const store = new IndexedDBStore(db as unknown as IDBDatabase);
    const tx = store.transaction();
    for (const id of await tx.keys()) await tx.get(id);
    const fs = new StoreFS(store);
    await fs.ready();
    await tick();
    return fs;
}

/** Write a file the way a sysExitEvent handler does as the page goes, then
 *  "close the page" without returning to the event loop, and load again. */
async function writeAtUnloadAndReload(eager: boolean): Promise<string | null> {
    const db = new FakeDb('profile');
    const fs = await openFs(db);
    if (eager) commitSyncWritesImmediately(fs);
    mount('/p', fs);
    writeFileSync('/p/layout.lua', 'return { x = 10 }');
    umount('/p');
    const survived = new Map(db.durable);

    const next = await openFs(new FakeDb('profile', survived));
    mount('/p', next);
    try {
        return String(readFileSync('/p/layout.lua', 'utf8'));
    } catch {
        return null;
    } finally {
        umount('/p');
    }
}

describe('VFS writes made as the page closes (#438)', () => {
    it('are lost when the IndexedDB transaction is left to auto-commit', async () => {
        // The model reproduces the report: without the fix, the file is gone.
        expect(await writeAtUnloadAndReload(false)).toBeNull();
    });

    it('survive once sync writes commit their transaction explicitly', async () => {
        expect(await writeAtUnloadAndReload(true)).toBe('return { x = 10 }');
    });

    it('leaves writes made during play intact', async () => {
        const db = new FakeDb('profile');
        const fs = await openFs(db);
        commitSyncWritesImmediately(fs);
        mount('/p', fs);
        writeFileSync('/p/a.txt', 'one');
        writeFileSync('/p/a.txt', 'two');
        await tick();
        umount('/p');
        const next = await openFs(new FakeDb('profile', new Map(db.durable)));
        mount('/p', next);
        expect(String(readFileSync('/p/a.txt', 'utf8'))).toBe('two');
        umount('/p');
    });
});
