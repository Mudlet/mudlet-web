// Persistent gameplay log storage. Mirrors the IndexedDB pattern in
// `mapStorage.ts` but uses two object stores: one row per recorded session
// (`sessions`) and one row per output line (`entries`). Logs can grow large,
// so they live in their own DB rather than the Zustand/localStorage store.

import { whenIdbNamesMigrated } from './storageMigration';

const DB_NAME = 'mudlet_logs';
const SESSION_STORE = 'sessions';
const ENTRY_STORE = 'entries';
const DB_VERSION = 1;

/** One recorded gameplay session (a single profile open). */
export interface LogSession {
    /** UUID; also the foreign key on every {@link LogEntry}. */
    id: string;
    connectionId: string;
    /** Display name captured at record time, so the browser can label the
     *  session even after the connection is renamed or deleted. */
    connectionName: string;
    startedAt: number;
    /** Updated on every flush; the wall-clock time of the last logged line. */
    endedAt: number;
    entryCount: number;
}

/** One captured output line. `html` is the styled, HTML-escaped render
 *  (snapshotted at emit time); `plain` is the unstyled text used for search. */
export interface LogEntry {
    /** Auto-increment key, assigned by IndexedDB on insert. */
    id?: number;
    sessionId: string;
    /** Monotonic ordering within the session (guards against equal timestamps). */
    seq: number;
    timestamp: number;
    /** Mirrors the `message` event type: 'mud' | 'echo' | 'script' | 'info' | … */
    type: string;
    html: string;
    plain: string;
}

async function openDb(): Promise<IDBDatabase> {
    // Was `mudix_logs` before the storage namespace rename.
    await whenIdbNamesMigrated();
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(SESSION_STORE)) {
                const sessions = db.createObjectStore(SESSION_STORE, { keyPath: 'id' });
                sessions.createIndex('connectionId', 'connectionId', { unique: false });
            }
            if (!db.objectStoreNames.contains(ENTRY_STORE)) {
                const entries = db.createObjectStore(ENTRY_STORE, { keyPath: 'id', autoIncrement: true });
                // Entries for one session are fetched/deleted via this index. Within
                // a session they come back in primary-key (insertion = seq) order.
                entries.createIndex('sessionId', 'sessionId', { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** Insert a session record (call once, on the first flush that has entries). */
export async function createSession(session: LogSession): Promise<void> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(SESSION_STORE, 'readwrite');
        tx.objectStore(SESSION_STORE).put(session);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** Merge a partial update into an existing session record (endedAt/entryCount). */
export async function updateSession(id: string, patch: Partial<LogSession>): Promise<void> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(SESSION_STORE, 'readwrite');
        const store = tx.objectStore(SESSION_STORE);
        const get = store.get(id);
        get.onsuccess = () => {
            const current = get.result as LogSession | undefined;
            if (current) store.put({ ...current, ...patch, id });
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** Append a batch of entries in a single transaction. */
export async function appendEntries(entries: LogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(ENTRY_STORE, 'readwrite');
        const store = tx.objectStore(ENTRY_STORE);
        for (const entry of entries) store.add(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** All sessions, newest first. Optionally filtered to one connection. */
export async function listSessions(connectionId?: string): Promise<LogSession[]> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(SESSION_STORE, 'readonly');
        const store = tx.objectStore(SESSION_STORE);
        const req = connectionId
            ? store.index('connectionId').getAll(IDBKeyRange.only(connectionId))
            : store.getAll();
        req.onsuccess = () => {
            const rows = (req.result as LogSession[]) ?? [];
            rows.sort((a, b) => b.startedAt - a.startedAt);
            resolve(rows);
        };
        req.onerror = () => reject(req.error);
    });
}

/** All entries for a session, in capture order. */
export async function getSessionEntries(sessionId: string): Promise<LogEntry[]> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(ENTRY_STORE, 'readonly');
        const req = tx.objectStore(ENTRY_STORE).index('sessionId').getAll(IDBKeyRange.only(sessionId));
        req.onsuccess = () => {
            const rows = (req.result as LogEntry[]) ?? [];
            rows.sort((a, b) => a.seq - b.seq);
            resolve(rows);
        };
        req.onerror = () => reject(req.error);
    });
}

/** Delete a session and every entry that belongs to it. */
export async function deleteSession(id: string): Promise<void> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([SESSION_STORE, ENTRY_STORE], 'readwrite');
        tx.objectStore(SESSION_STORE).delete(id);
        const cursorReq = tx.objectStore(ENTRY_STORE).index('sessionId').openKeyCursor(IDBKeyRange.only(id));
        cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
                tx.objectStore(ENTRY_STORE).delete(cursor.primaryKey);
                cursor.continue();
            }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** Delete several sessions (and their entries). */
export async function deleteSessions(ids: string[]): Promise<void> {
    for (const id of ids) await deleteSession(id);
}

/** Remove every log for a connection — called when the connection is deleted. */
export async function deleteSessionsForConnection(connectionId: string): Promise<void> {
    const sessions = await listSessions(connectionId);
    await deleteSessions(sessions.map(s => s.id));
}

/** Wipe all recorded logs across every connection. */
export async function clearAllLogs(): Promise<void> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([SESSION_STORE, ENTRY_STORE], 'readwrite');
        tx.objectStore(SESSION_STORE).clear();
        tx.objectStore(ENTRY_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
