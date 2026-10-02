// Main-thread sqlite-wasm client. Synchronous from Lua's POV — there is no
// worker hop, no postMessage, no Promises in the trigger hot path.
//
// Two layers of storage:
//   - A database a script opens by path lives, while any connection has it
//     open, as a real file in the wasm build's in-memory filesystem, opened
//     through sqlite's "unix" VFS. Every connection is its OWN sqlite handle on
//     that file, so they behave as desktop's handles on a disk file do: the
//     unix VFS tracks locks per inode inside the process, so a second
//     connection reads only committed data, a writer is refused while a reader
//     holds its lock, and closing one connection leaves the others alone.
//     (memdb's shared mode was the obvious alternative and is wrong: a pending
//     write lock there refuses every new reader, where a file lets them read.)
//   - Cross-session persistence is the profile VFS. A store's committed state
//     is exported (through a "keeper" handle that never holds a transaction, so
//     the export can only see committed pages) to its VFS path by the caller's
//     `persist` callback — debounced after writes, on demand via flush(), and
//     always when the last connection closes. The in-memory file is then
//     deleted; the next open reads the VFS file again.
//
// A path containing ":memory:" opens a private in-memory database instead, as
// LuaSQL's SQLITE_OPEN_MEMORY does on desktop: never shared, never written out.
import sqlite3InitModule, {type Database, type PreparedStatement, type SqlValue, type Sqlite3Static} from '@sqlite.org/sqlite-wasm';

type ExecResult =
    | { kind: 'rows'; rows: SqlValue[][]; columns: string[] }
    | { kind: 'changes'; changes: number };

/** A cell as LuaSQL hands it to Lua: a number (INTEGER and REAL alike — Lua 5.1
 *  has only doubles, and desktop converts an int64 with a plain C cast), the raw
 *  bytes of a TEXT or BLOB, or null. */
export type LuasqlCell = number | Uint8Array | null;

export type LuasqlExecResult =
    /** A statement with result columns: a cursor's shape. Its rows are read by
     *  {@link SqliteClient.cursorFetch}, as LuaSQL reads them on first fetch. */
    | { kind: 'cursor'; cursorId: number; columns: Uint8Array[]; declTypes: (Uint8Array | null)[]; wrote: boolean }
    | { kind: 'changes'; changes: number }
    | { kind: 'error'; message: Uint8Array };

export interface LuasqlFetchResult {
    rows: LuasqlCell[][];
    /** The error that stopped the rows early, as sqlite3_errmsg reports it. */
    error: Uint8Array | null;
    /** Whether the cursor still holds something (its read lock) to release. */
    holding: boolean;
}

export interface OpenOptions {
    readOnly?: boolean;
    /** Writes the store's committed bytes to its durable home. */
    persist?: (bytes: Uint8Array) => void;
}

const SNAPSHOT_DEBOUNCE_MS = 500;
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;

/** The raw C exports this client calls directly: pointers are plain numbers in
 *  the 32-bit build, and nothing here should pass through xWrap's string
 *  conversion, which is exactly the UTF-8 decode that loses non-UTF-8 bytes. */
interface RawExports {
    sqlite3_step(pStmt: number): number;
    sqlite3_reset(pStmt: number): number;
    sqlite3_finalize(pStmt: number): number;
    sqlite3_column_count(pStmt: number): number;
    sqlite3_column_type(pStmt: number, i: number): number;
    sqlite3_column_double(pStmt: number, i: number): number;
    sqlite3_column_text(pStmt: number, i: number): number;
    sqlite3_column_blob(pStmt: number, i: number): number;
    sqlite3_column_bytes(pStmt: number, i: number): number;
    sqlite3_column_name(pStmt: number, i: number): number;
    sqlite3_column_decltype(pStmt: number, i: number): number;
    sqlite3_stmt_readonly(pStmt: number): number;
    sqlite3_txn_state(pDb: number, zSchema: number): number;
    sqlite3_changes(pDb: number): number;
    sqlite3_errmsg(pDb: number): number;
}

interface Store {
    key: string;
    /** The database's file in the wasm filesystem. */
    fsName: string;
    keeper: Database;
    handles: Set<number>;
    dirty: boolean;
    persist: ((bytes: Uint8Array) => void) | null;
    timer: ReturnType<typeof setTimeout> | null;
}

interface Handle {
    db: Database;
    store: Store | null;
    cursors: Set<number>;
}

interface Cursor {
    dbId: number;
    /** The prepared statement, reset after execute's first step; 0 once read. */
    pStmt: number;
    /** A statement holding the read lock while the cursor has rows left. */
    holder: PreparedStatement | null;
}

let sqlite3: Sqlite3Static | null = null;
let initError: Error | null = null;

export const sqliteReady: Promise<void> = (async () => {
    try {
        sqlite3 = await sqlite3InitModule();
    } catch (e) {
        initError = e instanceof Error ? e : new Error(String(e));
    }
})();

export class SqliteClient {
    private readonly handles = new Map<number, Handle>();
    private readonly stores = new Map<string, Store>();
    private readonly cursors = new Map<number, Cursor>();
    private nextId = 1;
    private nextCursorId = 1;
    private nextFile = 1;
    private flushing = false;
    private unlinkFn: ((pVfs: unknown, name: string) => number) | null = null;

    private get s(): Sqlite3Static {
        if (initError) throw new Error('sqlite init failed: ' + initError.message);
        if (!sqlite3) throw new Error('sqlite not initialized — await sqliteReady before use');
        return sqlite3;
    }

    private get x(): RawExports {
        return this.s.wasm.exports as unknown as RawExports;
    }

    /** Why sqlite cannot be used (its wasm failed to load), or null when it
     *  can. Callers that run during startup check this rather than touching
     *  the module, so a failed load costs only the database API. */
    unavailable(): string | null {
        if (initError) return 'sqlite init failed: ' + initError.message;
        if (!sqlite3) return 'sqlite not initialized';
        return null;
    }

    /** The SQLite library version, or null when sqlite failed to load. */
    version(): string | null {
        return this.unavailable() ? null : this.s.capi.sqlite3_libversion();
    }

    /** Whether a connection to `path` is open, i.e. its live state is here and
     *  not (only) in its durable home. */
    isLive(path: string): boolean {
        return this.stores.has(path);
    }

    /**
     * Open a new connection to the database at `path`. Every call is its own
     * handle. `preload` seeds the database only when no connection to it is
     * open; an open one is authoritative.
     */
    open(path: string, preload?: Uint8Array, options: OpenOptions = {}): number {
        if (path.includes(':memory:')) return this.openMemory();
        const s = this.s;
        let store = this.stores.get(path);
        if (!store) {
            const fsName = `/mudlet-sql-${this.nextFile++}.db`;
            this.unlink(fsName);
            this.unlink(`${fsName}-journal`);
            if (preload && preload.byteLength > 0) s.capi.sqlite3_js_posix_create_file(fsName, preload);
            const keeper = new s.oo1.DB({filename: fsName, flags: 'c', vfs: 'unix'});
            store = {key: path, fsName, keeper, handles: new Set(), dirty: false, persist: null, timer: null};
            this.stores.set(path, store);
        }
        if (options.persist) store.persist = options.persist;
        let db: Database;
        try {
            db = new s.oo1.DB({filename: store.fsName, flags: options.readOnly ? 'r' : 'c', vfs: 'unix'});
        } catch (e) {
            if (store.handles.size === 0) this.teardown(store);
            throw e;
        }
        return this.register(db, store);
    }

    /** A private in-memory database (LuaSQL's ":memory:"). */
    openMemory(): number {
        return this.register(new this.s.oo1.DB(':memory:', 'c'), null);
    }

    private register(db: Database, store: Store | null): number {
        const s = this.s;
        // Accept a double-quoted string where no such identifier exists, the way
        // the SQLite that desktop Mudlet links does. It is a misfeature SQLite
        // keeps only for compatibility and this build turns off by default — but
        // turning it off changes what `DB.lua` means, not just what it accepts.
        // Its table-rebuild path emits `SELECT "_row_id", "name", "desc" FROM
        // people_bak` naming every column of the NEW schema, including ones the
        // backup table has not got, and relies on those resolving to string
        // literals. With DQS off that is a hard error and db:create dies partway
        // through a migration, having already dropped the table.
        s.capi.sqlite3_db_config(db.pointer!, s.capi.SQLITE_DBCONFIG_DQS_DML, 1, 0);
        s.capi.sqlite3_db_config(db.pointer!, s.capi.SQLITE_DBCONFIG_DQS_DDL, 1, 0);
        const dbId = this.nextId++;
        this.handles.set(dbId, {db, store, cursors: new Set()});
        store?.handles.add(dbId);
        return dbId;
    }

    private handle(dbId: number): Handle {
        const h = this.handles.get(dbId);
        if (!h) throw new Error('invalid dbId');
        return h;
    }

    /** Run every statement in `sql` (the file browser's read-only queries). */
    exec(dbId: number, sql: string): ExecResult {
        const db = this.handle(dbId).db;
        const rows: SqlValue[][] = [];
        const columns: string[] = [];
        db.exec({
            sql,
            rowMode: 'array',
            resultRows: rows,
            columnNames: columns,
        });
        if (columns.length === 0) {
            return { kind: 'changes', changes: db.changes() as number };
        }
        return { kind: 'rows', rows, columns };
    }

    /** NUL-terminated C string at `ptr`, as raw bytes. */
    private cstrBytes(ptr: number): Uint8Array {
        const heap = this.s.wasm.heap8u();
        let end = ptr;
        while (heap[end] !== 0) end++;
        return heap.slice(ptr, end);
    }

    private errmsg(pDb: number): Uint8Array {
        return this.cstrBytes(this.x.sqlite3_errmsg(pDb));
    }

    /**
     * LuaSQL's conn:execute (ls_sqlite3.c conn_execute): prepare the FIRST
     * statement in `sql` — anything after it is ignored, as sqlite3_prepare's
     * tail is — and step it once. A statement with result columns becomes a
     * cursor (reset, to be run by cursorFetch); otherwise the result is
     * sqlite3_changes(). `sql` is bytes, so text that is not UTF-8 reaches
     * sqlite unchanged.
     */
    luasqlExec(dbId: number, sql: Uint8Array): LuasqlExecResult {
        const h = this.handle(dbId);
        const s = this.s;
        const {wasm, capi} = s;
        const x = this.x;
        const pDb = h.db.pointer as unknown as number;
        const pSql = wasm.alloc(sql.byteLength + 1) as unknown as number;
        let pStmt = 0;
        let rc: number;
        const stack = wasm.pstack.pointer;
        try {
            wasm.heap8u().set(sql, pSql);
            wasm.heap8u()[pSql + sql.byteLength] = 0;
            const ppStmt = wasm.pstack.allocPtr() as unknown as number;
            rc = capi.sqlite3_prepare_v3(pDb as never, pSql, sql.byteLength, 0, ppStmt, 0);
            pStmt = wasm.peekPtr(ppStmt as never) as unknown as number;
        } finally {
            wasm.pstack.restore(stack);
            wasm.dealloc(pSql as never);
        }
        if (rc !== 0) return {kind: 'error', message: this.errmsg(pDb)};
        // Nothing but whitespace or comments: desktop steps a NULL statement and
        // reports whatever sqlite3_errmsg then says.
        if (!pStmt) return {kind: 'error', message: this.errmsg(pDb)};

        const res = x.sqlite3_step(pStmt);
        const numcols = x.sqlite3_column_count(pStmt);
        if (res === SQLITE_ROW || (res === SQLITE_DONE && numcols > 0)) {
            const columns: Uint8Array[] = [];
            const declTypes: (Uint8Array | null)[] = [];
            for (let i = 0; i < numcols; i++) {
                columns.push(this.cstrBytes(x.sqlite3_column_name(pStmt, i)));
                const pType = x.sqlite3_column_decltype(pStmt, i);
                declTypes.push(pType ? this.cstrBytes(pType) : null);
            }
            const wrote = x.sqlite3_stmt_readonly(pStmt) === 0;
            x.sqlite3_reset(pStmt);
            const cursorId = this.nextCursorId++;
            this.cursors.set(cursorId, {dbId, pStmt, holder: null});
            h.cursors.add(cursorId);
            return {kind: 'cursor', cursorId, columns, declTypes, wrote};
        }
        if (res === SQLITE_DONE) {
            x.sqlite3_finalize(pStmt);
            return {kind: 'changes', changes: x.sqlite3_changes(pDb)};
        }
        const message = this.errmsg(pDb);
        x.sqlite3_finalize(pStmt);
        return {kind: 'error', message};
    }

    /**
     * Run a cursor's statement to the end and hand back every row. Reading them
     * all in one call keeps the bridge to one crossing per query; what desktop's
     * row-at-a-time cursor also does is hold its read lock until the rows run
     * out, so while there are rows the cursor keeps a statement of its own
     * mid-step on the connection, and cursorClose lets it go.
     */
    cursorFetch(cursorId: number): LuasqlFetchResult {
        const cur = this.cursors.get(cursorId);
        if (!cur || !cur.pStmt) return {rows: [], error: null, holding: !!cur};
        const h = this.handle(cur.dbId);
        const x = this.x;
        const heap = () => this.s.wasm.heap8u();
        const pDb = h.db.pointer as unknown as number;
        const p = cur.pStmt;
        const ncols = x.sqlite3_column_count(p);
        const rows: LuasqlCell[][] = [];
        let rc = x.sqlite3_step(p);
        // Whether the statement took a read transaction: one that reads no
        // table holds no lock on desktop either.
        const locked = rc === SQLITE_ROW && x.sqlite3_txn_state(pDb, 0) >= 1;
        while (rc === SQLITE_ROW) {
            const row: LuasqlCell[] = new Array(ncols);
            for (let i = 0; i < ncols; i++) {
                switch (x.sqlite3_column_type(p, i)) {
                    case 1: // SQLITE_INTEGER — (double)int64, as lua_pushnumber does
                    case 2: // SQLITE_FLOAT
                        row[i] = x.sqlite3_column_double(p, i);
                        break;
                    case 3: { // SQLITE_TEXT
                        const ptr = x.sqlite3_column_text(p, i);
                        const n = x.sqlite3_column_bytes(p, i);
                        row[i] = heap().slice(ptr, ptr + n);
                        break;
                    }
                    case 4: { // SQLITE_BLOB
                        const ptr = x.sqlite3_column_blob(p, i);
                        const n = x.sqlite3_column_bytes(p, i);
                        row[i] = n === 0 ? new Uint8Array(0) : heap().slice(ptr, ptr + n);
                        break;
                    }
                    default:
                        row[i] = null;
                }
            }
            rows.push(row);
            rc = x.sqlite3_step(p);
        }
        const error = rc === SQLITE_DONE ? null : this.errmsg(pDb);
        x.sqlite3_finalize(p);
        cur.pStmt = 0;
        if (locked && rows.length > 0 && error === null) {
            try {
                const holder = h.db.prepare('SELECT 1 FROM sqlite_schema UNION ALL SELECT 1');
                if (holder.step()) cur.holder = holder;
                else holder.finalize();
            } catch { /* could not take the lock again: nothing to hold */ }
        }
        if (!cur.holder) this.dropCursor(cursorId);
        return {rows, error, holding: !!cur.holder};
    }

    /** The cursor is closed (or ran out): finalize what it still has. */
    cursorClose(cursorId: number): void {
        this.dropCursor(cursorId);
    }

    private dropCursor(cursorId: number): void {
        const cur = this.cursors.get(cursorId);
        if (!cur) return;
        this.cursors.delete(cursorId);
        this.handles.get(cur.dbId)?.cursors.delete(cursorId);
        if (cur.pStmt) this.x.sqlite3_finalize(cur.pStmt);
        if (cur.holder) {
            try { cur.holder.finalize(); } catch { /* connection already gone */ }
        }
    }

    /** sqlite3_exec of fixed transaction-control SQL; the error text as raw
     *  bytes, or null on success. */
    script(dbId: number, sql: string): Uint8Array | null {
        const h = this.handle(dbId);
        const pDb = h.db.pointer!;
        const rc = this.s.capi.sqlite3_exec(pDb, sql, 0, 0, 0);
        return rc === 0 ? null : this.errmsg(pDb as unknown as number);
    }

    lastInsertRowid(dbId: number): number {
        return Number(this.s.capi.sqlite3_last_insert_rowid(this.handle(dbId).db.pointer!));
    }

    /** Note that `dbId` may have changed its database; it is written out after
     *  the debounce, or sooner by flush(). */
    markDirty(dbId: number): void {
        const store = this.handles.get(dbId)?.store;
        if (!store || !store.persist) return;
        store.dirty = true;
        if (store.timer) clearTimeout(store.timer);
        store.timer = setTimeout(() => {
            store.timer = null;
            this.flushStore(store);
        }, SNAPSHOT_DEBOUNCE_MS);
    }

    /** Write `path`'s committed state out now if it has changed. Cheap when it
     *  has not, so it can sit in front of every read of the file. */
    flush(path: string): void {
        const store = this.stores.get(path);
        if (store?.dirty) this.flushStore(store);
    }

    flushAll(): void {
        for (const store of this.stores.values()) {
            if (store.dirty) this.flushStore(store);
        }
    }

    private flushStore(store: Store): void {
        if (this.flushing || !store.dirty || !store.persist) return;
        this.flushing = true;
        try {
            if (store.timer) { clearTimeout(store.timer); store.timer = null; }
            let bytes: Uint8Array;
            try {
                bytes = this.s.capi.sqlite3_js_db_export(store.keeper.pointer!);
            } catch (e) {
                // Another connection holds the file exclusively (mid-commit, or
                // in an EXCLUSIVE transaction): try again later.
                console.warn('[sql snapshot]', store.key, e);
                store.timer = setTimeout(() => { store.timer = null; this.flushStore(store); }, SNAPSHOT_DEBOUNCE_MS);
                return;
            }
            store.dirty = false;
            try {
                store.persist(bytes);
            } catch (e) {
                console.warn('[sql snapshot]', store.key, e);
            }
        } finally {
            this.flushing = false;
        }
    }

    /** Close one connection: sqlite3_close, which rolls back whatever it never
     *  committed. The last connection to a database writes it out first. */
    close(dbId: number): void {
        const h = this.handles.get(dbId);
        if (!h) return;
        for (const cursorId of [...h.cursors]) this.dropCursor(cursorId);
        this.handles.delete(dbId);
        try { h.db.close(); } catch (e) { console.warn('[sql close]', e); }
        const store = h.store;
        if (!store) return;
        store.handles.delete(dbId);
        if (store.handles.size === 0) this.teardown(store);
    }

    private teardown(store: Store): void {
        this.flushStore(store);
        if (store.timer) { clearTimeout(store.timer); store.timer = null; }
        try { store.keeper.close(); } catch { /* already closed */ }
        this.unlink(store.fsName);
        this.unlink(`${store.fsName}-journal`);
        if (this.stores.get(store.key) === store) this.stores.delete(store.key);
    }

    private unlink(fsName: string): void {
        const s = this.s;
        if (!this.unlinkFn) {
            this.unlinkFn = (s.wasm as unknown as {
                xWrap(name: string, ret: string, args: string[]): (pVfs: unknown, name: string) => number;
            }).xWrap('sqlite3__wasm_vfs_unlink', 'int', ['sqlite3_vfs*', 'string']);
        }
        try { this.unlinkFn(s.capi.sqlite3_vfs_find('unix'), fsName); } catch { /* not there */ }
    }
}

let _instance: SqliteClient | null = null;

export function getSqliteClient(): SqliteClient {
    if (!_instance) _instance = new SqliteClient();
    return _instance;
}
