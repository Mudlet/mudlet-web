// Main-thread sqlite-wasm client. Synchronous from Lua's POV — there is no
// worker hop, no postMessage, no Promises in the trigger hot path.
//
// Trade vs. the previous SAHPool worker:
//   - Persistence is via the existing ProfileVFS round-trip (export bytes →
//     vfs.writeBinaryFile). The DB itself lives in WASM memory.
//   - Module init is async (one-time), but happens before any Lua runs:
//     LuaRuntime.create awaits sqliteReady before installing the bridge.
//   - exec runs on the main thread. For typical MUD-scale workloads this is
//     fine; if it ever isn't, snapshot export can be moved to a worker without
//     re-introducing async on the call path.
import sqlite3InitModule, {type Database, type SqlValue, type Sqlite3Static} from '@sqlite.org/sqlite-wasm';

type ExecResult =
    | { kind: 'rows'; rows: SqlValue[][]; columns: string[] }
    | { kind: 'changes'; changes: number };

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
    private readonly dbs = new Map<number, Database>();
    // path → live dbId, so a reopen of an already-open path reuses the same
    // in-memory DB instead of stranding it (see open()/liveId()).
    private readonly idByPath = new Map<string, number>();
    private readonly pathById = new Map<number, string>();
    private nextId = 1;

    // The dbId of a currently-open connection to `path`, or undefined if none.
    liveId(path: string): number | undefined {
        return this.idByPath.get(path);
    }

    private get s(): Sqlite3Static {
        if (initError) throw new Error('sqlite init failed: ' + initError.message);
        if (!sqlite3) throw new Error('sqlite not initialized — await sqliteReady before use');
        return sqlite3;
    }

    open(path: string, preload?: Uint8Array): number {
        // Reuse a live connection to the same path (DB.lua reconnects without
        // closing — see __sql_open). The live DB is authoritative over any
        // preload bytes, so ignore them here.
        const existing = this.idByPath.get(path);
        if (existing != null) return existing;

        const sqlite3 = this.s;
        // The DB itself lives in WASM memory (`:memory:`); cross-session
        // persistence is the snapshot back to the ProfileVFS in setupSqlBridge.
        // We track `path` only to reuse a live handle on reconnect (see above).
        const db = new sqlite3.oo1.DB(':memory:', 'c');
        // Accept a double-quoted string where no such identifier exists, the way
        // the SQLite that desktop Mudlet links does. It is a misfeature SQLite
        // keeps only for compatibility and this build turns off by default — but
        // turning it off changes what `DB.lua` means, not just what it accepts.
        // Its table-rebuild path emits `SELECT "_row_id", "name", "desc" FROM
        // people_bak` naming every column of the NEW schema, including ones the
        // backup table has not got, and relies on those resolving to string
        // literals. With DQS off that is a hard error and db:create dies partway
        // through a migration, having already dropped the table.
        sqlite3.capi.sqlite3_db_config(db.pointer!, sqlite3.capi.SQLITE_DBCONFIG_DQS_DML, 1, 0);
        sqlite3.capi.sqlite3_db_config(db.pointer!, sqlite3.capi.SQLITE_DBCONFIG_DQS_DDL, 1, 0);
        if (preload && preload.byteLength > 0) {
            // sqlite3_deserialize takes ownership of the byte buffer once we
            // pass FREEONCLOSE — copy into sqlite-managed memory so the
            // caller's Uint8Array stays valid and we don't double-free.
            const bytes = preload.byteLength;
            const ptr = sqlite3.wasm.alloc(bytes);
            sqlite3.wasm.heap8u().set(preload, ptr);
            const flags = sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE
                | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE;
            const rc = sqlite3.capi.sqlite3_deserialize(db.pointer!, 'main', ptr, bytes, bytes, flags);
            if (rc !== sqlite3.capi.SQLITE_OK) {
                sqlite3.wasm.dealloc(ptr);
                db.close();
                throw new Error(`sqlite3_deserialize failed: rc=${rc}`);
            }
        }
        const dbId = this.nextId++;
        this.dbs.set(dbId, db);
        this.idByPath.set(path, dbId);
        this.pathById.set(dbId, path);
        return dbId;
    }

    exec(dbId: number, sql: string): ExecResult {
        const db = this.dbs.get(dbId);
        if (!db) throw new Error('invalid dbId');
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

    exportFile(dbId: number): Uint8Array {
        const db = this.dbs.get(dbId);
        if (!db) throw new Error('invalid dbId');
        // Returns a fresh Uint8Array containing the full DB image — usable as
        // a regular .sqlite file.
        return this.s.capi.sqlite3_js_db_export(db.pointer!);
    }

    close(dbId: number): void {
        const db = this.dbs.get(dbId);
        if (!db) return;
        db.close();
        this.dbs.delete(dbId);
        const path = this.pathById.get(dbId);
        if (path !== undefined) {
            this.pathById.delete(dbId);
            // Only clear the path→id mapping if it still points at this dbId
            // (defensive; one path maps to one live id at a time).
            if (this.idByPath.get(path) === dbId) this.idByPath.delete(path);
        }
    }

    // Single-quote escape — sufficient for SQLite TEXT literals. Mudlet's
    // luasql.sqlite3:escape() does the same.
    escape(s: string): string {
        return String(s).replace(/'/g, "''");
    }
}

let _instance: SqliteClient | null = null;

export function getSqliteClient(): SqliteClient {
    if (!_instance) _instance = new SqliteClient();
    return _instance;
}
