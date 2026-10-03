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
//     `persist` callback — at the end of the task that wrote it, on demand via
//     flush(), and always when the last connection closes. Desktop's commit is
//     on disk at once, so a page closed half a second after a db:add must not
//     lose it. The in-memory file is then deleted; the next open reads the VFS
//     file again.
//   - Connections open through a shim of the unix VFS that maps a database's
//     real path (/profiles/<id>/Database_x.db) onto its in-memory file. sqlite
//     sees the real names, so PRAGMA database_list reports them, and a database
//     a statement opens by name (ATTACH, VACUUM INTO) is found in, or created
//     in, the profile as on desktop: the shim asks the FileHost for it and
//     makes it a store like any other.
//   - The profile VFS is the file, so a change made to it underneath an open
//     connection reaches that connection: bytes written over the file replace
//     the in-memory file in place (sqlite notices the new change counter, as it
//     does when another process writes a disk file), and a file removed or
//     renamed away leaves its connections on the unlinked file, where sqlite
//     refuses writes ("attempt to write a readonly database") and nothing is
//     written back.
//
// A path containing ":memory:" opens a private in-memory database instead, as
// LuaSQL's SQLITE_OPEN_MEMORY does on desktop: never shared, never written out.
import sqlite3InitModule, {type Database, type SqlValue, type Sqlite3Static} from '@sqlite.org/sqlite-wasm';

type ExecResult =
    | { kind: 'rows'; rows: SqlValue[][]; columns: string[] }
    | { kind: 'changes'; changes: number };

/** A cell as LuaSQL hands it to Lua: a number (INTEGER and REAL alike — Lua 5.1
 *  has only doubles, and desktop converts an int64 with a plain C cast), the raw
 *  bytes of a TEXT or BLOB, or null. */
export type LuasqlCell = number | Uint8Array | null;

export type LuasqlExecResult =
    /** A statement with result columns: a cursor's shape. Its rows are read by
     *  {@link SqliteClient.cursorFetch}, one step per fetch as LuaSQL reads them. */
    | { kind: 'cursor'; cursorId: number; columns: Uint8Array[]; declTypes: (Uint8Array | null)[]; wrote: boolean }
    | { kind: 'changes'; changes: number }
    | { kind: 'error'; message: Uint8Array };

export type LuasqlFetchResult =
    | { kind: 'row'; row: LuasqlCell[] }
    /** The rows ran out; the statement is finalized and the cursor gone. */
    | { kind: 'done' }
    /** The step failed, as sqlite3_errmsg reports it; the cursor is gone. */
    | { kind: 'error'; message: Uint8Array };

/** Where databases a statement opens by name (ATTACH, VACUUM INTO) live. */
export interface FileHost {
    /** The absolute path a database name stands for (relative names are
     *  relative to the Lua working directory). */
    resolve(name: string): string;
    /** The file at `abs`: its bytes, null when there is none but one can be
     *  created there, or false when it cannot be opened (no such directory, or
     *  a directory). */
    read(abs: string): Uint8Array | null | false;
    /** Write `abs`'s committed bytes to its durable home. */
    persist(abs: string, bytes: Uint8Array): void;
}

export interface OpenOptions {
    readOnly?: boolean;
    /** Writes the store's committed bytes to its durable home. */
    persist?: (bytes: Uint8Array) => void;
}

/** How long a committed write waits to be written out: to the end of the
 *  task, so a loop of db:add costs one export, but no longer — the page can
 *  close at any moment after. */
const SNAPSHOT_DELAY_MS = 0;
/** Retry after an export found the file locked exclusively. */
const SNAPSHOT_RETRY_MS = 500;
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;
const SQLITE_CANTOPEN = 14;
const SQLITE_OPEN_MAIN_DB = 0x100;
/** The significant digits desktop's SQLite (3.37) gives a REAL turned into
 *  text: CAST, TEXT affinity, quote(). 3.53 defaults to 17. */
const FP_DIGITS = 15;

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
    /** The database's real path, which sqlite is given. */
    key: string;
    /** The database's file in the wasm filesystem. */
    fsName: string;
    /** Opened on first export. */
    keeper: Database | null;
    /** Connections that have it open, as their main database or attached. */
    handles: Set<number>;
    dirty: boolean;
    persist: ((bytes: Uint8Array) => void) | null;
    timer: ReturnType<typeof setTimeout> | null;
    /** C strings of its mapped names (sqlite's unix VFS keeps the pointer). */
    cnames: Map<string, number>;
}

interface Handle {
    db: Database;
    store: Store | null;
    cursors: Set<number>;
    /** Stores this connection has opened by name (ATTACH, VACUUM INTO). */
    attached: Set<Store>;
}

interface Cursor {
    dbId: number;
    /** The prepared statement, reset after execute's first step. */
    pStmt: number;
}

/** The parts of sqlite-wasm's low-level API the VFS shim and round() use,
 *  typed as the 32-bit build has them: every pointer a plain number. */
interface RawWasm {
    alloc(n: number): number;
    dealloc(p: number): void;
    heap8u(): Uint8Array;
    peekPtr(p: number): number;
    pokePtr(p: number, v: number): void;
    functionEntry(p: number): (...args: number[]) => number;
    installFunction(sig: string, fn: (...args: number[]) => unknown): number;
    allocCString(s: string): number;
    cstrToJs(p: number): string;
    ptr: { size: number };
}

interface RawCapi {
    sqlite3_vfs: { structInfo: { sizeof: number; members: Record<string, { offset: number }> } };
    sqlite3_vfs_find(name: string): number;
    sqlite3_vfs_register(pVfs: number, makeDefault: number): number;
    sqlite3_db_config(pDb: number, op: number, a: number, b: number): number;
    sqlite3_create_function_v2(
        pDb: number, name: string, arity: number, flags: number, pApp: number,
        xFunc: number, xStep: number, xFinal: number, xDestroy: number,
    ): number;
    sqlite3_value_type(pVal: number): number;
    sqlite3_value_int(pVal: number): number;
    sqlite3_value_double(pVal: number): number;
    sqlite3_result_double(pCtx: number, v: number): void;
    SQLITE_DBCONFIG_FP_DIGITS: number;
    SQLITE_NULL: number;
    SQLITE_UTF8: number;
    SQLITE_DETERMINISTIC: number;
}

type XOpen = (pVfs: number, zName: number, pFile: number, flags: number, pOutFlags: number) => number;
type XName = (pVfs: number, zName: number, a: number, b: number) => number;
type XDelete = (pVfs: number, zName: number, syncDir: number) => number;

const AR_ROUND = [5.0e-01, 5.0e-02, 5.0e-03, 5.0e-04, 5.0e-05, 5.0e-06, 5.0e-07, 5.0e-08, 5.0e-09, 5.0e-10];
const f64 = new DataView(new ArrayBuffer(8));

/**
 * round(X, Y) as the SQLite desktop Mudlet links (3.37) computes it: Y=0 adds
 * a half and truncates; otherwise the value goes through its printf("%.*f"),
 * which adds the half-unit rounder plus a 3e-16 relative fudge and then
 * truncates to at most 16 significant digits. That fudge is why round(1.005, 2)
 * is 1.01 and round(2.675, 2) is 2.68 there, where 3.53's exact decimal
 * rounding gives 1.0 and 2.67. (3.37's printf sums in long double; the sum here
 * is a double, which only matters within an ulp of a rounding boundary.)
 */
export function round337(r: number, n: number): number {
    if (r < -4503599627370496.0 || r > 4503599627370496.0) return r;
    if (n === 0) return Math.trunc(r + (r < 0 ? -0.5 : 0.5));
    const neg = r < 0;
    const v = neg ? -r : r;
    let idx = n;
    let rounder = AR_ROUND[idx % 10];
    while (idx >= 10) { rounder *= 1.0e-10; idx -= 10; }
    const [m1, e1] = decompose(v);
    if (n + Math.trunc((e1 + 52) / 3) < 15) rounder += v * 3e-16;
    // v + rounder summed exactly (3.37 sums in long double, whose 64-bit
    // mantissa a double's would lose digits to), then truncated to n places.
    const [m2, e2] = decompose(rounder);
    const e = Math.min(e1, e2);
    const sum = (m1 << BigInt(e1 - e)) + (m2 << BigInt(e2 - e));
    const scaled = e >= 0 ? (sum << BigInt(e)) * 10n ** BigInt(n) : (sum * 10n ** BigInt(n)) >> BigInt(-e);
    const digits = scaled.toString().padStart(n + 1, '0').split('');
    let sig = 0;
    for (let i = 0; i < digits.length; i++) {
        if (sig === 0 && digits[i] === '0') continue;
        if (++sig > 16) digits[i] = '0';
    }
    const cut = digits.length - n;
    const out = Number(digits.slice(0, cut).join('') + '.' + digits.slice(cut).join(''));
    return neg ? -out : out;
}

/** A finite, non-negative double as mantissa * 2^exponent, exactly. */
function decompose(x: number): [bigint, number] {
    f64.setFloat64(0, x);
    const hi = f64.getUint32(0);
    const bits = (hi >>> 20) & 0x7ff;
    const m = (BigInt(hi & 0xfffff) << 32n) | BigInt(f64.getUint32(4));
    return bits === 0 ? [m, -1074] : [m | (1n << 52n), bits - 1075];
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

let nextClient = 1;

export class SqliteClient {
    private readonly handles = new Map<number, Handle>();
    private readonly stores = new Map<string, Store>();
    private readonly cursors = new Map<number, Cursor>();
    private nextId = 1;
    private nextCursorId = 1;
    private nextFile = 1;
    private flushing = false;
    private unlinkFn: ((pVfs: unknown, name: string) => number) | null = null;
    private host: FileHost | null = null;
    /** The connection whose statement is running, so a database it opens by
     *  name is counted as open by it. */
    private active: number | null = null;
    private vfsName: string | null = null;
    private roundPtr = 0;
    private readonly clientId = nextClient++;

    private get s(): Sqlite3Static {
        if (initError) throw new Error('sqlite init failed: ' + initError.message);
        if (!sqlite3) throw new Error('sqlite not initialized — await sqliteReady before use');
        return sqlite3;
    }

    private get x(): RawExports {
        return this.s.wasm.exports as unknown as RawExports;
    }

    private get raw(): { wasm: RawWasm; capi: RawCapi } {
        const s = this.s;
        return {wasm: s.wasm as unknown as RawWasm, capi: s.capi as unknown as RawCapi};
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

    /** Where databases opened by name from SQL live; null leaves such names to
     *  the wasm filesystem. */
    setFileHost(host: FileHost | null): void {
        this.host = host;
    }

    /** Clear `host`, unless another has replaced it since. */
    releaseFileHost(host: FileHost): void {
        if (this.host === host) this.host = null;
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
        const vfs = this.shimVfs();
        let store = this.stores.get(path);
        if (!store) store = this.createStore(path, preload);
        if (options.persist) store.persist = options.persist;
        let db: Database;
        try {
            db = new s.oo1.DB({filename: path, flags: options.readOnly ? 'r' : 'c', vfs});
        } catch (e) {
            if (store.handles.size === 0) this.teardown(store);
            throw e;
        }
        return this.register(db, store);
    }

    /** A private in-memory database (LuaSQL's ":memory:"). Through the shim
     *  all the same, so a database it ATTACHes by name is a profile file. */
    openMemory(): number {
        return this.register(new this.s.oo1.DB({filename: ':memory:', flags: 'c', vfs: this.shimVfs()}), null);
    }

    private createStore(key: string, preload?: Uint8Array | null): Store {
        const fsName = `/mudlet-sql-${this.clientId}-${this.nextFile++}.db`;
        this.unlink(fsName);
        this.unlink(`${fsName}-journal`);
        if (preload && preload.byteLength > 0) this.s.capi.sqlite3_js_posix_create_file(fsName, preload);
        const store: Store = {
            key, fsName, keeper: null, handles: new Set(), dirty: false, persist: null, timer: null, cnames: new Map(),
        };
        this.stores.set(key, store);
        return store;
    }

    private register(db: Database, store: Store | null): number {
        const s = this.s;
        const p = db.pointer!;
        // Accept a double-quoted string where no such identifier exists, the way
        // the SQLite that desktop Mudlet links does. It is a misfeature SQLite
        // keeps only for compatibility and this build turns off by default — but
        // turning it off changes what `DB.lua` means, not just what it accepts.
        // Its table-rebuild path emits `SELECT "_row_id", "name", "desc" FROM
        // people_bak` naming every column of the NEW schema, including ones the
        // backup table has not got, and relies on those resolving to string
        // literals. With DQS off that is a hard error and db:create dies partway
        // through a migration, having already dropped the table.
        s.capi.sqlite3_db_config(p, s.capi.SQLITE_DBCONFIG_DQS_DML, 1, 0);
        s.capi.sqlite3_db_config(p, s.capi.SQLITE_DBCONFIG_DQS_DDL, 1, 0);
        // A REAL turned into text gets desktop's 15 significant digits, so a Lua
        // number db:add stores in a TEXT column is the same text there and here
        // ("0.3", "1.0e+15", "9.007199254741e+15").
        const {capi} = this.raw;
        capi.sqlite3_db_config(p as unknown as number, capi.SQLITE_DBCONFIG_FP_DIGITS, FP_DIGITS, 0);
        this.installRound(p as unknown as number);
        const dbId = this.nextId++;
        this.handles.set(dbId, {db, store, cursors: new Set(), attached: new Set()});
        store?.handles.add(dbId);
        return dbId;
    }

    /** round() with desktop's arithmetic ({@link round337}); an application
     *  function of a built-in's name takes its place. */
    private installRound(pDb: number): void {
        const {capi, wasm} = this.raw;
        if (!this.roundPtr) {
            this.roundPtr = wasm.installFunction('v(pip)', (pCtx: number, argc: number, pArgv: number) => {
                const arg = (i: number) => wasm.peekPtr(pArgv + i * wasm.ptr.size);
                let n = 0;
                if (argc === 2) {
                    const a1 = arg(1);
                    if (capi.sqlite3_value_type(a1) === capi.SQLITE_NULL) return;
                    n = Math.min(30, Math.max(0, capi.sqlite3_value_int(a1)));
                }
                const a0 = arg(0);
                if (capi.sqlite3_value_type(a0) === capi.SQLITE_NULL) return;
                capi.sqlite3_result_double(pCtx, round337(capi.sqlite3_value_double(a0), n));
            });
        }
        const flags = capi.SQLITE_UTF8 | capi.SQLITE_DETERMINISTIC;
        for (const arity of [1, 2]) {
            capi.sqlite3_create_function_v2(pDb, 'round', arity, flags, 0, this.roundPtr, 0, 0, 0);
        }
    }

    // ── the VFS shim ─────────────────────────────────────────────────────────

    /** The name of the unix-VFS shim connections open through, registered on
     *  first use. */
    private shimVfs(): string {
        if (this.vfsName) return this.vfsName;
        const {capi, wasm} = this.raw;
        const info = capi.sqlite3_vfs.structInfo;
        const off = (m: string) => info.members[m].offset;
        const unix = capi.sqlite3_vfs_find('unix');
        const pVfs = wasm.alloc(info.sizeof);
        wasm.heap8u().copyWithin(pVfs, unix, unix + info.sizeof);
        const orig = <T>(m: string): T => wasm.functionEntry(wasm.peekPtr(unix + off(m))) as unknown as T;
        const xOpen = orig<XOpen>('xOpen');
        const xDelete = orig<XDelete>('xDelete');
        const xAccess = orig<XName>('xAccess');
        const xFullPathname = orig<XName>('xFullPathname');
        const install = (m: string, sig: string, fn: (...args: number[]) => number) =>
            wasm.pokePtr(pVfs + off(m), wasm.installFunction(sig, fn as (...args: number[]) => unknown));
        const name = `mudlet-unix-${this.clientId}`;
        wasm.pokePtr(pVfs + off('zName'), wasm.allocCString(name));
        wasm.pokePtr(pVfs + off('pNext'), 0);
        const mapped = (zName: number) => (zName && this.mapName(wasm.cstrToJs(zName))) || zName;

        install('xOpen', 'i(pppip)', (_v, zName, pFile, flags, pOutFlags) => {
            if (!zName) return xOpen(unix, zName, pFile, flags, pOutFlags);
            const path = wasm.cstrToJs(zName);
            let target = this.mapName(path);
            let store = target ? this.stores.get(path) ?? null : null;
            let created = false;
            if (!target && (flags & SQLITE_OPEN_MAIN_DB) && this.host) {
                // A database a statement names (ATTACH, VACUUM INTO) that no
                // connection has open: bring it in from the profile.
                const bytes = this.host.read(path);
                if (bytes === false) return SQLITE_CANTOPEN;
                store = this.createStore(path, bytes);
                const host = this.host;
                store.persist = b => host.persist(path, b);
                target = this.cname(store, '');
                created = true;
            }
            const rc = xOpen(unix, target || zName, pFile, flags, pOutFlags);
            if (store && (flags & SQLITE_OPEN_MAIN_DB)) {
                const h = this.active !== null ? this.handles.get(this.active) : undefined;
                if (rc === 0 && h && h.store !== store && !h.attached.has(store)) {
                    h.attached.add(store);
                    store.handles.add(this.active!);
                }
                if (created && rc !== 0 && store.handles.size === 0) this.teardown(store);
            }
            return rc;
        });
        install('xDelete', 'i(ppi)', (_v, zName, syncDir) => xDelete(unix, mapped(zName), syncDir));
        install('xAccess', 'i(ppip)', (_v, zName, flags, pResOut) => xAccess(unix, mapped(zName), flags, pResOut));
        install('xFullPathname', 'i(ppip)', (_v, zName, nOut, zOut) => {
            const path = wasm.cstrToJs(zName);
            // A store's key is already the full path; anything else is the
            // profile's to resolve, relative to the Lua working directory.
            const full = this.stores.has(path) ? path : this.host ? this.host.resolve(path) : null;
            if (full === null) return xFullPathname(unix, zName, nOut, zOut);
            const bytes = new TextEncoder().encode(full);
            if (bytes.length + 1 > nOut) return SQLITE_CANTOPEN;
            wasm.heap8u().set(bytes, zOut);
            wasm.heap8u()[zOut + bytes.length] = 0;
            return 0;
        });
        capi.sqlite3_vfs_register(pVfs, 0);
        this.vfsName = name;
        return name;
    }

    /** The in-memory file (as a C string) standing for `path`, a live store's
     *  database or one of its journals; 0 for a name no store has. */
    private mapName(path: string): number {
        const store = this.stores.get(path);
        if (store) return this.cname(store, '');
        for (const suffix of ['-journal', '-wal', '-shm']) {
            if (!path.endsWith(suffix)) continue;
            const db = this.stores.get(path.slice(0, -suffix.length));
            if (db) return this.cname(db, suffix);
        }
        return 0;
    }

    private cname(store: Store, suffix: string): number {
        let p = store.cnames.get(suffix);
        if (!p) {
            p = this.raw.wasm.allocCString(store.fsName + suffix);
            store.cnames.set(suffix, p);
        }
        return p;
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
        const prev = this.active;
        this.active = dbId;
        try {
            return this.luasqlExecOn(dbId, h, sql);
        } finally {
            this.active = prev;
        }
    }

    private luasqlExecOn(dbId: number, h: Handle, sql: Uint8Array): LuasqlExecResult {
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
            this.cursors.set(cursorId, {dbId, pStmt});
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
     * LuaSQL's cur:fetch: step the cursor's statement once and hand back that
     * row. One row per call, as desktop's cursor reads them, so whatever the
     * connection writes between two fetches — deleting a row the cursor has not
     * reached yet, updating one, inserting one — shows in what the cursor goes
     * on to return; and the statement, mid-step, holds the read lock until its
     * rows run out. The step that finds none finalizes it.
     */
    cursorFetch(cursorId: number): LuasqlFetchResult {
        const cur = this.cursors.get(cursorId);
        if (!cur) return {kind: 'done'};
        const h = this.handle(cur.dbId);
        const x = this.x;
        const p = cur.pStmt;
        const prev = this.active;
        this.active = cur.dbId;
        let rc: number;
        try {
            rc = x.sqlite3_step(p);
        } finally {
            this.active = prev;
        }
        if (rc !== SQLITE_ROW) {
            const message = rc === SQLITE_DONE ? null : this.errmsg(h.db.pointer as unknown as number);
            this.dropCursor(cursorId);
            return message ? {kind: 'error', message} : {kind: 'done'};
        }
        const ncols = x.sqlite3_column_count(p);
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
                    row[i] = this.s.wasm.heap8u().slice(ptr, ptr + n);
                    break;
                }
                case 4: { // SQLITE_BLOB
                    const ptr = x.sqlite3_column_blob(p, i);
                    const n = x.sqlite3_column_bytes(p, i);
                    row[i] = n === 0 ? new Uint8Array(0) : this.s.wasm.heap8u().slice(ptr, ptr + n);
                    break;
                }
                default:
                    row[i] = null;
            }
        }
        return {kind: 'row', row};
    }

    /** The cursor is closed: finalize its statement, letting its lock go. */
    cursorClose(cursorId: number): void {
        this.dropCursor(cursorId);
    }

    private dropCursor(cursorId: number): void {
        const cur = this.cursors.get(cursorId);
        if (!cur) return;
        this.cursors.delete(cursorId);
        this.handles.get(cur.dbId)?.cursors.delete(cursorId);
        if (cur.pStmt) this.x.sqlite3_finalize(cur.pStmt);
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

    /** Note that `dbId` may have changed its database, or one it has attached;
     *  they are written out at the end of the task, or sooner by flush(). */
    markDirty(dbId: number): void {
        const h = this.handles.get(dbId);
        if (!h) return;
        if (h.store) this.schedule(h.store);
        for (const store of h.attached) this.schedule(store);
    }

    private schedule(store: Store, delay = SNAPSHOT_DELAY_MS): void {
        if (!store.persist) return;
        store.dirty = true;
        if (store.timer) return;
        store.timer = setTimeout(() => {
            store.timer = null;
            this.flushStore(store);
        }, delay);
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
                if (!store.keeper) {
                    store.keeper = new this.s.oo1.DB({filename: store.key, flags: 'c', vfs: this.shimVfs()});
                }
                bytes = this.s.capi.sqlite3_js_db_export(store.keeper.pointer!);
            } catch (e) {
                // Another connection holds the file exclusively (mid-commit, or
                // in an EXCLUSIVE transaction): try again later.
                console.warn('[sql snapshot]', store.key, e);
                store.dirty = false;
                this.schedule(store, SNAPSHOT_RETRY_MS);
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

    /**
     * Bytes were written over `path` from outside sqlite (io, a restore, the
     * file browser). An open database takes them as its file's new contents,
     * written into the same in-memory file so every connection on it sees them
     * from its next statement, and what it had not yet written out is dropped:
     * the file is what was just written.
     */
    fileReplaced(path: string, read: () => Uint8Array): void {
        const store = this.stores.get(path);
        if (!store) return;
        // Dropped before reading, so the read barrier cannot write the old
        // state back over the new bytes.
        if (store.timer) { clearTimeout(store.timer); store.timer = null; }
        store.dirty = false;
        this.s.capi.sqlite3_js_posix_create_file(store.fsName, this.markChanged(store, read()));
    }

    /**
     * sqlite tells that another writer changed a file by its header: a
     * connection keeps its cached pages while the change counter matches, and
     * its parsed schema while the schema cookie does. Bytes copied over a
     * database can carry the same values as the file they replace (a backup
     * taken after as many commits), so where they match, the copy the
     * connections read gets them one higher than the file's current ones.
     */
    private markChanged(store: Store, bytes: Uint8Array): Uint8Array {
        if (bytes.byteLength < 100 || new TextDecoder().decode(bytes.subarray(0, 15)) !== 'SQLite format 3') return bytes;
        let page: Uint8Array | null = null;
        try {
            if (!store.keeper) store.keeper = new this.s.oo1.DB({filename: store.key, flags: 'c', vfs: this.shimVfs()});
            const v = store.keeper.selectValue('SELECT data FROM sqlite_dbpage WHERE pgno = 1');
            if (v instanceof Uint8Array && v.byteLength >= 100) page = v;
        } catch { /* not a database it can read: nothing cached to invalidate */ }
        if (!page) return bytes;
        const cur = new DataView(page.buffer, page.byteOffset, page.byteLength);
        const out = new Uint8Array(bytes);
        const next = new DataView(out.buffer);
        const same = (from: number, to: number) => page!.subarray(from, to).every((b, i) => b === out[from + i]);
        if (same(24, 40)) {
            const counter = (cur.getUint32(24) + 1) >>> 0;
            // the in-header page count is trusted only while 92 matches 24
            if (next.getUint32(92) === next.getUint32(24)) next.setUint32(92, counter);
            next.setUint32(24, counter);
        }
        if (same(40, 44)) next.setUint32(40, (cur.getUint32(40) + 1) >>> 0);
        return out;
    }

    /**
     * `path` (or a directory holding it) was removed or renamed away. Every
     * database there leaves its connections on the unlinked file, as a disk
     * file's do: they read what it held, sqlite refuses their writes, nothing
     * is written back, and the next connection to the path starts afresh.
     */
    fileRemoved(path: string): void {
        for (const store of [...this.stores.values()]) {
            if (store.key !== path && !store.key.startsWith(`${path}/`)) continue;
            if (store.timer) { clearTimeout(store.timer); store.timer = null; }
            store.dirty = false;
            store.persist = null;
            this.unlink(store.fsName);
            this.unlink(`${store.fsName}-journal`);
            this.stores.delete(store.key);
            if (store.handles.size === 0) this.teardown(store);
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
        for (const store of [h.store, ...h.attached]) {
            if (!store) continue;
            store.handles.delete(dbId);
            if (store.handles.size === 0) this.teardown(store);
        }
    }

    private teardown(store: Store): void {
        this.flushStore(store);
        if (store.timer) { clearTimeout(store.timer); store.timer = null; }
        try { store.keeper?.close(); } catch { /* already closed */ }
        store.keeper = null;
        this.unlink(store.fsName);
        this.unlink(`${store.fsName}-journal`);
        for (const p of store.cnames.values()) this.raw.wasm.dealloc(p);
        store.cnames.clear();
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
