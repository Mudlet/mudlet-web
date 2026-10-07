import type { FileSystem } from '@zenfs/core';

/** The parts of ZenFS's StoreFS transaction this module reaches into. */
interface WrappedTransaction {
    commitSync(): void;
    /** @zenfs/dom's IndexedDBTransaction, holding the real IDBTransaction. */
    raw?: { tx?: IDBTransaction };
}

/**
 * Make every synchronous write to an IndexedDB-backed StoreFS commit its
 * IndexedDB transaction there and then (#438).
 *
 * ZenFS issues a sync write's put/delete requests at once, but never calls
 * `IDBTransaction.commit()` — its `commitSync()` only marks the wrapper done
 * — so the transaction is left to auto-commit. Chromium auto-commits from the
 * page: once the requests' success events have been delivered back to it. A
 * write made while the page is going away (sysExitEvent on pagehide, where
 * Geyser's Adjustable.Container saves its layout) never gets those events, so
 * the transaction is aborted with the page and the file is lost. An explicit
 * commit hands the decision to the database itself, which finishes the
 * transaction whether or not the page is still there to hear about it.
 *
 * Only the sync path is touched: async operations await their requests
 * across tasks, and nothing here is in a hurry. A transaction that already
 * finished (it had nothing to do) refuses `commit()`; that is not an error.
 */
export function commitSyncWritesImmediately(fs: FileSystem): void {
    const store = fs as unknown as { transaction?: () => WrappedTransaction };
    if (typeof store.transaction !== 'function') return;
    const open = store.transaction.bind(fs);
    store.transaction = () => {
        const wrapped = open();
        const commitSync = wrapped.commitSync.bind(wrapped);
        wrapped.commitSync = () => {
            commitSync();
            const tx = wrapped.raw?.tx;
            if (typeof tx?.commit !== 'function') return;
            try { tx.commit(); } catch { /* already finished */ }
        };
        return wrapped;
    };
}
