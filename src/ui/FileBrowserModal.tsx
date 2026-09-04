import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import { Folder, FolderOpen, FolderPlus, FolderUp, File, RefreshCw, LucideFolderPen, Upload, Trash2, Home, Link, Unlink, Play, Download, FolderDown } from 'lucide-react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { zipSync } from 'fflate';
import { ResizableModal } from './ResizableModal';
// Imported from the module directly rather than the './components' barrel: the
// barrel re-exports FileSourceButton, which reaches VfsPickerModal → this file,
// so going through it would close a runtime import cycle.
import { ContextMenu } from './components/ContextMenu';
import { useAppStore } from '../storage';
import { downloadBlob } from '../storage/logExport';
import type { ProfileVFS } from '../scripting/vfs/ProfileVFS';
import { getSqliteClient } from '../db/sqliteClient';
import { CodeEditorPreview, EDITABLE_EXTENSIONS } from './CodeEditorPreview';
import { MarkdownPreview } from './MarkdownPreview';
import { JsonPreview } from './JsonPreview';
import {
    isFolderLinkSupported,
    loadFolderHandle,
    saveFolderHandle,
    clearFolderHandle,
    checkFolderPermission,
    requestFolderPermission,
    type FolderPermissionState,
} from '../scripting/vfs/folderHandleStore';
import {
    walkFolderHandle,
    walkVfsTree,
    diffSides,
    copyVfsToFolder,
    copyFolderToIdb,
    type DiffResult,
    type SideKind,
} from '../scripting/vfs/folderSync';
import { MergeConflictModal } from './MergeConflictModal';

// ─── VFS Move Helpers ──────────────────────────────────────────────────────

function canMove(srcPath: string, destDirPath: string): boolean {
    const srcParent = srcPath.substring(0, srcPath.lastIndexOf('/'));
    if (destDirPath === srcParent) return false;           // already there
    if (destDirPath === srcPath) return false;             // self
    if (destDirPath.startsWith(srcPath + '/')) return false; // own descendant
    return true;
}

function copyDirRecursive(vfs: ProfileVFS, srcDir: string, destDir: string): void {
    vfs.mkdir(destDir);
    for (const name of vfs.readdir(srcDir)) {
        const src = `${srcDir}/${name}`;
        const dest = `${destDir}/${name}`;
        if (vfs.stat(src)?.type === 'dir') {
            copyDirRecursive(vfs, src, dest);
        } else {
            vfs.writeFile(dest, vfs.readFile(src));
        }
    }
}

function moveVFSNode(vfs: ProfileVFS, srcPath: string, destDirPath: string): void {
    const name = srcPath.substring(srcPath.lastIndexOf('/') + 1);
    const destPath = `${destDirPath}/${name}`;
    const info = vfs.stat(srcPath);
    if (!info) throw new Error(`Not found: ${srcPath}`);
    if (info.type === 'file') {
        vfs.writeFile(destPath, vfs.readFile(srcPath));
        vfs.deleteFile(srcPath);
    } else {
        copyDirRecursive(vfs, srcPath, destPath);
        vfs.rmdir(srcPath);
    }
}

// ─── Download Helpers ──────────────────────────────────────────────────────

function safeDownloadName(name: string): string {
    return name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim() || 'download';
}

// Flatten a VFS directory into fflate's { path: bytes } map, relative to
// `prefix`. Empty directories are emitted as explicit `dir/` entries so the
// archive round-trips the layout. Unreadable files are skipped rather than
// failing the whole export.
export function collectZipEntries(
    vfs: ProfileVFS,
    dirPath: string,
    prefix: string,
    out: Record<string, Uint8Array>,
    depth = 0,
): void {
    if (depth > 24) return;
    let names: string[];
    try { names = vfs.readdir(dirPath); } catch { return; }
    if (names.length === 0) {
        if (prefix) out[prefix] = new Uint8Array(0);
        return;
    }
    for (const name of names) {
        const full = `${dirPath}/${name}`;
        if (vfs.stat(full)?.type === 'dir') {
            collectZipEntries(vfs, full, `${prefix}${name}/`, out, depth + 1);
        } else {
            try {
                const raw = vfs.readBinaryFile(full);
                // Copy out of ZenFS's Buffer view — it can carry a non-zero
                // byteOffset over a shared backing store.
                const bytes = new Uint8Array(raw.byteLength);
                bytes.set(raw);
                out[`${prefix}${name}`] = bytes;
            } catch (err) {
                console.error(`[download] skipped ${full}:`, err);
            }
        }
    }
}

function downloadVfsFile(vfs: ProfileVFS, node: VFSNode): void {
    const raw = vfs.readBinaryFile(node.path);
    const bytes = new Uint8Array(raw.byteLength);
    bytes.set(raw);
    downloadBlob(safeDownloadName(node.name), new Blob([bytes], { type: 'application/octet-stream' }));
}

function downloadVfsDir(vfs: ProfileVFS, dirPath: string, zipName: string): void {
    const entries: Record<string, Uint8Array> = {};
    collectZipEntries(vfs, dirPath, '', entries);
    const zipped = zipSync(entries, { level: 6 });
    downloadBlob(
        `${safeDownloadName(zipName)}.zip`,
        new Blob([zipped.slice()], { type: 'application/zip' }),
    );
}

// ─── Preview Strategy System ───────────────────────────────────────────────

interface PreviewProps {
    content: string;
    filename: string;
    path: string;
    vfs: ProfileVFS;
    // Editable strategies wire these so the modal can prompt on unsaved file
    // switches and refresh tree metadata (size, etc.) after a save.
    onDirtyChange?: (dirty: boolean) => void;
    onSaved?: () => void;
    // Optional jump-to-line request. Bumps `revision` for re-fire on repeat.
    gotoLine?: { line: number; revision: number } | null;
}

interface FilePreviewStrategy {
    canPreview: (filename: string) => boolean;
    // Binary strategies skip the text-decode step in handleSelect — the
    // Preview component is responsible for reading bytes itself.
    isBinary?: boolean;
    Preview: React.FC<PreviewProps>;
}

const TEXT_PREVIEW_LIMIT = 1_000_000; // 1 MB — anything larger is truncated

// Sniff the first 4KB. A single NUL byte virtually never appears in text
// formats, so it's the most reliable signal; a high density of other control
// bytes is the secondary check for NUL-free binary blobs (e.g. some image
// containers, UTF-16 files — those will look binary, which is acceptable).
function looksBinary(bytes: Uint8Array): boolean {
    const sample = bytes.subarray(0, Math.min(4096, bytes.byteLength));
    if (sample.byteLength === 0) return false;
    let nonPrintable = 0;
    for (let i = 0; i < sample.byteLength; i++) {
        const b = sample[i];
        if (b === 0) return true;
        if (b < 9 || (b > 13 && b < 32) || b === 127) nonPrintable++;
    }
    return nonPrintable / sample.byteLength > 0.3;
}

type PlainTextState =
    | { kind: 'loading' }
    | { kind: 'binary'; size: number }
    | { kind: 'text'; text: string; truncated: boolean; size: number }
    | { kind: 'error'; message: string };

function PlainTextPreview({ path, vfs }: PreviewProps) {
    const [state, setState] = useState<PlainTextState>({ kind: 'loading' });

    useEffect(() => {
        setState({ kind: 'loading' });
        try {
            const bytes = vfs.readBinaryFile(path);
            const size = bytes.byteLength;
            if (looksBinary(bytes)) {
                setState({ kind: 'binary', size });
                return;
            }
            const truncated = size > TEXT_PREVIEW_LIMIT;
            const slice = truncated ? bytes.subarray(0, TEXT_PREVIEW_LIMIT) : bytes;
            try {
                const text = new TextDecoder('utf-8', { fatal: true }).decode(slice);
                setState({ kind: 'text', text, truncated, size });
            } catch {
                setState({ kind: 'binary', size });
            }
        } catch (e) {
            setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
        }
    }, [path, vfs]);

    if (state.kind === 'loading') return <p className="vfs-preview-empty">Reading…</p>;
    if (state.kind === 'error') {
        return (
            <div className="vfs-preview-error">
                <span className="vfs-preview-error-label">Cannot read file</span>
                <span>{state.message}</span>
            </div>
        );
    }
    if (state.kind === 'binary') {
        return (
            <p className="vfs-preview-empty">
                Binary file — {formatSize(state.size)}. No preview available.
            </p>
        );
    }
    return (
        <>
            {state.truncated && (
                <p className="vfs-preview-empty" style={{ borderBottom: '1px solid var(--border, #333)' }}>
                    Showing first {formatSize(TEXT_PREVIEW_LIMIT)} of {formatSize(state.size)} — preview truncated.
                </p>
            )}
            <pre className="vfs-preview-text">{state.text}</pre>
        </>
    );
}

const SQL_PAGE_SIZE = 50;

// SQLite identifier quoting — double-quote, escape embedded ".
function quoteIdent(s: string): string {
    return '"' + s.replace(/"/g, '""') + '"';
}

function renderCell(v: unknown): ReactNode {
    if (v === null || v === undefined) {
        return <span className="vfs-sql-null">NULL</span>;
    }
    if (v instanceof Uint8Array) {
        return <span className="vfs-sql-blob">{`<BLOB ${v.byteLength}B>`}</span>;
    }
    if (typeof v === 'bigint') return v.toString();
    const s = String(v);
    return s.length > 200 ? s.substring(0, 200) + '…' : s;
}

function SqlitePreview({ path, vfs }: PreviewProps) {
    const [dbId, setDbId] = useState<number | null>(null);
    const [tables, setTables] = useState<string[]>([]);
    const [selectedTable, setSelectedTable] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let openedDbId: number | null = null;
        const sql = getSqliteClient();
        setLoading(true);
        setError(null);
        setTables([]);
        setSelectedTable(null);
        setDbId(null);
        try {
            const raw = vfs.readBinaryFile(path);
            // Defensive copy: ZenFS may return a Buffer slice with non-zero
            // byteOffset, which sqlite-wasm's deserialize rejects.
            const bytes = new Uint8Array(raw.byteLength);
            bytes.set(raw);
            if (bytes.byteLength < 100) {
                throw new Error(`File is only ${bytes.byteLength} bytes — too small to be a SQLite database`);
            }
            const id = sql.open(path, bytes);
            openedDbId = id;
            const r = sql.exec(
                id,
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            );
            setTables(r.kind === 'rows' ? r.rows.map(row => String(row[0])) : []);
            setDbId(id);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
        return () => {
            if (openedDbId !== null) {
                try { sql.close(openedDbId); } catch { /* already closed */ }
            }
        };
    }, [path, vfs]);

    if (loading) return <p className="vfs-preview-empty">Reading database…</p>;
    if (error) {
        return (
            <div className="vfs-preview-error">
                <span className="vfs-preview-error-label">Cannot open database</span>
                <span>{error}</span>
            </div>
        );
    }
    if (dbId === null) return null;
    if (selectedTable) {
        // key={selectedTable} forces a remount on table change so internal
        // state (page, total) resets cleanly without a useEffect race.
        return (
            <SqliteTableView
                key={selectedTable}
                dbId={dbId}
                table={selectedTable}
                onBack={() => setSelectedTable(null)}
            />
        );
    }
    return <SqliteTableList tables={tables} onSelect={setSelectedTable} />;
}

function SqliteTableList({ tables, onSelect }: { tables: string[]; onSelect: (t: string) => void }) {
    if (tables.length === 0) return <p className="vfs-preview-empty">No tables.</p>;
    return (
        <div className="vfs-sql-list">
            <div className="vfs-sql-header">
                {tables.length} table{tables.length === 1 ? '' : 's'}
            </div>
            {tables.map(name => (
                <button
                    key={name}
                    type="button"
                    className="vfs-sql-table-btn"
                    onClick={() => onSelect(name)}
                >
                    {name}
                </button>
            ))}
        </div>
    );
}

function SqliteTableView({ dbId, table, onBack }: { dbId: number; table: string; onBack: () => void }) {
    const [page, setPage] = useState(0);
    const [rows, setRows] = useState<unknown[][]>([]);
    const [columns, setColumns] = useState<string[]>([]);
    const [total, setTotal] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Row count — fetch once per (dbId, table).
    useEffect(() => {
        const sql = getSqliteClient();
        try {
            const r = sql.exec(dbId, `SELECT COUNT(*) FROM ${quoteIdent(table)}`);
            if (r.kind === 'rows' && r.rows.length > 0) {
                setTotal(Number(r.rows[0][0]) | 0);
            }
        } catch { /* surfaced by the data-fetch effect */ }
    }, [dbId, table]);

    // Page data.
    useEffect(() => {
        const sql = getSqliteClient();
        setLoading(true);
        setError(null);
        try {
            const offset = page * SQL_PAGE_SIZE;
            const r = sql.exec(
                dbId,
                `SELECT * FROM ${quoteIdent(table)} LIMIT ${SQL_PAGE_SIZE} OFFSET ${offset}`,
            );
            if (r.kind === 'rows') {
                setRows(r.rows);
                setColumns(r.columns);
            } else {
                setRows([]);
                setColumns([]);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, [dbId, table, page]);

    const totalPages = total !== null ? Math.max(1, Math.ceil(total / SQL_PAGE_SIZE)) : null;
    const canPrev = page > 0;
    const canNext = total === null ? rows.length === SQL_PAGE_SIZE : (page + 1) * SQL_PAGE_SIZE < total;

    return (
        <div className="vfs-sql-view">
            <div className="vfs-sql-toolbar">
                <button type="button" className="vfs-sql-back" onClick={onBack}>‹ Tables</button>
                <span className="vfs-sql-table-name">{table}</span>
                <span className="vfs-sql-meta">
                    {total !== null && `${total} row${total === 1 ? '' : 's'}`}
                </span>
            </div>

            {error ? (
                <div className="vfs-preview-error">
                    <span className="vfs-preview-error-label">Query failed</span>
                    <span>{error}</span>
                </div>
            ) : loading && rows.length === 0 ? (
                <p className="vfs-preview-empty">Loading…</p>
            ) : columns.length === 0 ? (
                <p className="vfs-preview-empty">Empty table.</p>
            ) : (
                <div className="vfs-sql-table-wrap">
                    <table className="vfs-sql-table">
                        <thead>
                            <tr>
                                {columns.map((c, i) => <th key={`${c}-${i}`}>{c}</th>)}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row, ri) => (
                                <tr key={ri}>
                                    {row.map((v, ci) => <td key={ci}>{renderCell(v)}</td>)}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <div className="vfs-sql-pager">
                <button type="button" disabled={!canPrev || loading} onClick={() => setPage(p => Math.max(0, p - 1))}>
                    ‹ Prev
                </button>
                <span className="vfs-sql-page-info">
                    Page {page + 1}{totalPages !== null && ` of ${totalPages}`}
                </span>
                <button type="button" disabled={!canNext || loading} onClick={() => setPage(p => p + 1)}>
                    Next ›
                </button>
            </div>
        </div>
    );
}

const IMAGE_MIME: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
    avif: 'image/avif',
};

function getImageMime(filename: string): string | null {
    const dot = filename.lastIndexOf('.');
    if (dot < 0) return null;
    return IMAGE_MIME[filename.substring(dot + 1).toLowerCase()] ?? null;
}

function ImagePreview({ filename, path, vfs }: PreviewProps) {
    const [url, setUrl]     = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [dims, setDims]   = useState<{ w: number; h: number } | null>(null);
    const [size, setSize]   = useState(0);

    useEffect(() => {
        setUrl(null);
        setError(null);
        setDims(null);
        let objectUrl: string | null = null;
        try {
            const raw = vfs.readBinaryFile(path);
            // Defensive copy: ZenFS may return a Buffer view with a non-zero
            // byteOffset, which Blob would still accept but copying keeps the
            // backing buffer independent of any later writes.
            const bytes = new Uint8Array(raw.byteLength);
            bytes.set(raw);
            const mime = getImageMime(filename) ?? 'application/octet-stream';
            const blob = new Blob([bytes], { type: mime });
            objectUrl = URL.createObjectURL(blob);
            setUrl(objectUrl);
            setSize(bytes.byteLength);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        return () => {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [path, filename, vfs]);

    if (error) {
        return (
            <div className="vfs-preview-error">
                <span className="vfs-preview-error-label">Cannot read image</span>
                <span>{error}</span>
            </div>
        );
    }
    if (!url) return null;
    return (
        <div className="vfs-image-preview">
            <div className="vfs-image-frame">
                <img
                    className="vfs-image"
                    src={url}
                    alt={filename}
                    onLoad={e => {
                        const img = e.currentTarget;
                        setDims({ w: img.naturalWidth, h: img.naturalHeight });
                    }}
                    onError={() => setError('Failed to decode image')}
                />
            </div>
            <div className="vfs-image-meta">
                {dims && <span>{dims.w} × {dims.h}</span>}
                <span>{formatSize(size)}</span>
            </div>
        </div>
    );
}

const AUDIO_MIME: Record<string, string> = {
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/ogg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    webm: 'audio/webm',
};

function getAudioMime(filename: string): string | null {
    const dot = filename.lastIndexOf('.');
    if (dot < 0) return null;
    return AUDIO_MIME[filename.substring(dot + 1).toLowerCase()] ?? null;
}

function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '–:––';
    const total = Math.round(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function AudioPreview({ filename, path, vfs }: PreviewProps) {
    const [url, setUrl]       = useState<string | null>(null);
    const [error, setError]   = useState<string | null>(null);
    const [size, setSize]     = useState(0);
    const [duration, setDuration] = useState<number | null>(null);

    useEffect(() => {
        setUrl(null);
        setError(null);
        setDuration(null);
        let objectUrl: string | null = null;
        try {
            const raw = vfs.readBinaryFile(path);
            const bytes = new Uint8Array(raw.byteLength);
            bytes.set(raw);
            const mime = getAudioMime(filename) ?? 'application/octet-stream';
            const blob = new Blob([bytes], { type: mime });
            objectUrl = URL.createObjectURL(blob);
            setUrl(objectUrl);
            setSize(bytes.byteLength);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        return () => {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [path, filename, vfs]);

    if (error) {
        return (
            <div className="vfs-preview-error">
                <span className="vfs-preview-error-label">Cannot read audio</span>
                <span>{error}</span>
            </div>
        );
    }
    if (!url) return null;
    return (
        <div className="vfs-audio-preview">
            <audio
                className="vfs-audio"
                controls
                preload="metadata"
                src={url}
                onLoadedMetadata={e => setDuration(e.currentTarget.duration)}
                onError={() => setError('Failed to decode audio')}
            />
            <div className="vfs-audio-meta">
                {duration !== null && <span>{formatDuration(duration)}</span>}
                <span>{formatSize(size)}</span>
            </div>
        </div>
    );
}

function fileExtLower(filename: string): string {
    const i = filename.lastIndexOf('.');
    return i >= 0 ? filename.substring(i + 1).toLowerCase() : '';
}

const plainTextStrategy: FilePreviewStrategy = { canPreview: () => true, isBinary: true, Preview: PlainTextPreview };
const sqliteStrategy: FilePreviewStrategy = {
    canPreview: (n) => /\.(db|sqlite|sqlite3)$/i.test(n),
    isBinary: true,
    Preview: SqlitePreview,
};
const imageStrategy: FilePreviewStrategy = {
    canPreview: (n) => getImageMime(n) !== null,
    isBinary: true,
    Preview: ImagePreview,
};
const audioStrategy: FilePreviewStrategy = {
    canPreview: (n) => getAudioMime(n) !== null,
    isBinary: true,
    Preview: AudioPreview,
};
const codeEditorStrategy: FilePreviewStrategy = {
    canPreview: (n) => EDITABLE_EXTENSIONS.has(fileExtLower(n)),
    Preview: CodeEditorPreview,
};
const markdownStrategy: FilePreviewStrategy = {
    canPreview: (n) => /\.(md|markdown)$/i.test(n),
    Preview: MarkdownPreview,
};
const jsonStrategy: FilePreviewStrategy = {
    canPreview: (n) => /\.json$/i.test(n),
    Preview: JsonPreview,
};

// Add new strategies here — order matters, first match wins
const previewStrategies: FilePreviewStrategy[] = [sqliteStrategy, imageStrategy, audioStrategy, markdownStrategy, jsonStrategy, codeEditorStrategy, plainTextStrategy];

function getPreviewStrategy(filename: string): FilePreviewStrategy {
    return previewStrategies.find(s => s.canPreview(filename)) ?? plainTextStrategy;
}

// ─── VFS Tree ──────────────────────────────────────────────────────────────

export interface VFSNode {
    name: string;
    path: string;
    type: 'file' | 'dir';
    children?: VFSNode[];
    size?: number;
}

// Shared with FilePickerModal (the invokeFileDialog picker).
export function buildTree(vfs: ProfileVFS, dirPath: string, depth = 0): VFSNode[] {
    if (depth > 12) return [];
    try {
        const entries = vfs.readdir(dirPath);
        const nodes = entries.map(name => {
            const fullPath = `${dirPath}/${name}`;
            const info = vfs.stat(fullPath);
            const type = info?.type ?? 'file';
            const node: VFSNode = { name, path: fullPath, type };
            if (type === 'dir') node.children = buildTree(vfs, fullPath, depth + 1);
            else node.size = info?.size ?? 0;
            return node;
        });
        return nodes.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
    } catch { return []; }
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Tree Node ─────────────────────────────────────────────────────────────

interface DragHandlers {
    dragPath: string | null;
    dropTarget: string | null;
    onDragStart: (e: React.DragEvent, node: VFSNode) => void;
    onDragEnd: () => void;
    onDragOverDir: (e: React.DragEvent, path: string) => void;
    onDragLeaveDir: (path: string) => void;
    onDropOnDir: (e: React.DragEvent, path: string) => void;
}

interface RenameState {
    path: string | null;
    value: string;
    onChange: (value: string) => void;
    onCommit: (node: VFSNode) => void;
    onCancel: () => void;
}

interface TreeNodeProps {
    node: VFSNode;
    depth: number;
    expanded: Set<string>;
    selectedPath: string | null;
    uploadDir: string;
    onToggle: (path: string) => void;
    onSelect: (node: VFSNode) => void;
    onContextMenu: (e: React.MouseEvent, node: VFSNode) => void;
    dnd: DragHandlers;
    rename: RenameState;
}

function RenameInput({ node, rename }: { node: VFSNode; rename: RenameState }) {
    // Select the basename (everything before the final dot) on focus so the
    // user can replace the name without first clearing the extension.
    const onFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
        const v = e.currentTarget.value;
        const dot = node.type === 'file' ? v.lastIndexOf('.') : -1;
        e.currentTarget.setSelectionRange(0, dot > 0 ? dot : v.length);
    }, [node.type]);

    return (
        <input
            autoFocus
            className="vfs-rename-input"
            value={rename.value}
            onChange={e => rename.onChange(e.target.value)}
            onFocus={onFocus}
            onClick={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}
            onBlur={() => rename.onCommit(node)}
            onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); rename.onCommit(node); }
                else if (e.key === 'Escape') { e.preventDefault(); rename.onCancel(); }
            }}
        />
    );
}

function TreeNode({ node, depth, expanded, selectedPath, uploadDir, onToggle, onSelect, onContextMenu, dnd, rename }: TreeNodeProps) {
    const isOpen       = expanded.has(node.path);
    const isSelected   = node.path === selectedPath;
    const isDragging   = dnd.dragPath === node.path;
    const isDropTarget = dnd.dropTarget === node.path;
    const isRenaming   = rename.path === node.path;
    const indent       = depth * 16;

    const dragAttrs = {
        draggable: !isRenaming,
        onDragStart: (e: React.DragEvent) => dnd.onDragStart(e, node),
        onDragEnd: dnd.onDragEnd,
    };

    if (node.type === 'dir') {
        return (
            <div>
                <div
                    className={`vfs-row vfs-dir${isDropTarget ? ' vfs-drop-target' : ''}${isDragging ? ' vfs-dragging' : ''}`}
                    style={{ paddingLeft: indent + 4 }}
                    onClick={() => { if (!isRenaming) onToggle(node.path); }}
                    onContextMenu={e => onContextMenu(e, node)}
                    onDragOver={e => dnd.onDragOverDir(e, node.path)}
                    onDragLeave={() => dnd.onDragLeaveDir(node.path)}
                    onDrop={e => dnd.onDropOnDir(e, node.path)}
                    {...dragAttrs}
                >
                    <span className="vfs-chevron">
                        {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    </span>
                    <span className="vfs-icon">
                        {isOpen ? <FolderOpen size={13} /> : <Folder size={13} />}
                    </span>
                    {isRenaming
                        ? <RenameInput node={node} rename={rename} />
                        : <span className="vfs-name">{node.name}/</span>}
                    {!isRenaming && uploadDir === node.path && (
                        <span className="vfs-upload-indicator" title="Upload target">
                            <Upload size={10} />
                        </span>
                    )}
                </div>
                {isOpen && node.children?.map(child => (
                    <TreeNode
                        key={child.path}
                        node={child}
                        depth={depth + 1}
                        expanded={expanded}
                        selectedPath={selectedPath}
                        uploadDir={uploadDir}
                        onToggle={onToggle}
                        onSelect={onSelect}
                        onContextMenu={onContextMenu}
                        dnd={dnd}
                        rename={rename}
                    />
                ))}
            </div>
        );
    }

    return (
        <div
            className={`vfs-row vfs-file${isSelected ? ' vfs-selected' : ''}${isDragging ? ' vfs-dragging' : ''}`}
            style={{ paddingLeft: indent + 20 }}
            onClick={() => { if (!isRenaming) onSelect(node); }}
            onContextMenu={e => onContextMenu(e, node)}
            {...dragAttrs}
        >
            <span className="vfs-icon"><File size={13} /></span>
            {isRenaming
                ? <RenameInput node={node} rename={rename} />
                : <span className="vfs-name">{node.name}</span>}
            {!isRenaming && node.size !== undefined && <span className="vfs-size">{formatSize(node.size)}</span>}
        </div>
    );
}

// ─── Preview Panel ─────────────────────────────────────────────────────────

interface PreviewPanelProps {
    file: VFSNode | null;
    content: string | null;
    error: string | null;
    vfs: ProfileVFS | null;
    onDirtyChange: (dirty: boolean) => void;
    onSaved: () => void;
    gotoLine?: { line: number; revision: number } | null;
}

function PreviewPanel({ file, content, error, vfs, onDirtyChange, onSaved, gotoLine }: PreviewPanelProps): ReactNode {
    if (!file) return <p className="vfs-preview-empty">Select a file to preview</p>;
    if (error) {
        return (
            <div className="vfs-preview-error">
                <span className="vfs-preview-error-label">Cannot read file</span>
                <span>{error}</span>
            </div>
        );
    }
    if (!vfs) return null;
    const strategy = getPreviewStrategy(file.name);
    if (!strategy.isBinary && content === null) return null;
    // key={path} forces a clean remount on file switch so editor state and
    // dirty flags can't leak between files.
    return (
        <strategy.Preview
            key={file.path}
            content={content ?? ''}
            filename={file.name}
            path={file.path}
            vfs={vfs}
            onDirtyChange={onDirtyChange}
            onSaved={onSaved}
            gotoLine={gotoLine ?? null}
        />
    );
}

// ─── Modal ─────────────────────────────────────────────────────────────────

type CtxMenuState = { x: number; y: number; node: VFSNode };

interface FileBrowserModalProps {
    connectionId: string;
    vfs: ProfileVFS | null;
    onClose: () => void;
    // Optional path to select on open/refresh — used by the Cmd+P quick-open
    // palette and ScriptEditorModal to reveal a file in the tree and load its
    // preview. initialPathTick bumps on each programmatic open so the selection
    // effect re-fires even when the same path is picked twice in a row.
    initialPath?: string | null;
    initialPathTick?: number;
    // Line to scroll-and-position the cursor on once the preview opens.
    // Read alongside `initialPath`/`initialPathTick` so error-log hyperlinks
    // like `foo.lua:42` land on line 42.
    initialLine?: number;
    // When set, .dat files get a "Play replay" context-menu action that hands
    // the VFS path back (ProfileSession starts the Mudlet-replay playback).
    onPlayReplay?: (path: string) => void;
}

export function FileBrowserModal({ connectionId, vfs, onClose, initialPath, initialPathTick, initialLine, onPlayReplay }: FileBrowserModalProps) {
    const savedBounds     = useAppStore(s => s.connectionModalBounds[connectionId]?.['files']);
    const saveModalBounds = useAppStore(s => s.saveModalBounds);
    const connectionName  = useAppStore(s => s.connections.find(c => c.id === connectionId)?.name);

    // ── Tree rebuild ──────────────────────────────────────────────────────

    const [rev, setRev] = useState(0);
    const bumpRev = useCallback(() => setRev(r => r + 1), []);

    const [resyncing, setResyncing] = useState(false);
    const refresh = useCallback(async () => {
        if (previewDirtyRef.current) {
            const ok = window.confirm('Refresh will discard your unsaved edits. Continue?');
            if (!ok) return;
        }
        if (vfs?.source === 'folder') {
            setResyncing(true);
            try { await vfs.resync(); }
            catch (err) { console.error('[VFS] resync failed:', err); }
            finally { setResyncing(false); }
        }
        bumpRev();
        setSelectedFile(null);
        setPreviewContent(null);
        setPreviewError(null);
        setPreviewDirty(false);
    }, [bumpRev, vfs]);

    const tree = useMemo(() => {
        if (!vfs) return [];
        return buildTree(vfs, vfs.profilePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vfs, rev]);

    // ── Expand/collapse ───────────────────────────────────────────────────

    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const handleToggle = useCallback((path: string) => {
        setExpanded(prev => {
            const next = new Set(prev);
            next.has(path) ? next.delete(path) : next.add(path);
            return next;
        });
    }, []);

    const pruneExpanded = useCallback((removedPath: string) => {
        setExpanded(prev => {
            const next = new Set(prev);
            for (const k of next) {
                if (k === removedPath || k.startsWith(removedPath + '/')) next.delete(k);
            }
            return next;
        });
    }, []);

    // ── Selection / preview ───────────────────────────────────────────────

    const [selectedFile, setSelectedFile] = useState<VFSNode | null>(null);
    const [previewContent, setPreviewContent] = useState<string | null>(null);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [previewDirty, setPreviewDirty] = useState(false);
    // Goto-line request handed to editable previews. `revision` is monotonic
    // so the same line can be re-jumped on a fresh hyperlink click.
    const [previewGoto, setPreviewGoto] = useState<{ line: number; revision: number } | null>(null);

    // Editable strategies pipe their dirty flag up here so the modal can guard
    // against losing unsaved changes when the user picks another file/closes.
    const previewDirtyRef = useRef(false);
    previewDirtyRef.current = previewDirty;

    const confirmDiscardIfDirty = useCallback((currentName: string | undefined) => {
        if (!previewDirtyRef.current) return true;
        const name = currentName ?? 'this file';
        return window.confirm(`Discard unsaved changes to ${name}?`);
    }, []);

    const handleSelect = useCallback((node: VFSNode) => {
        if (selectedFile && node.path === selectedFile.path) return; // re-click no-op
        if (!confirmDiscardIfDirty(selectedFile?.name)) return;
        setPreviewDirty(false);
        setSelectedFile(node);
        if (!vfs) return;
        // Binary previews (e.g. SQLite) read the file themselves — don't try
        // to UTF-8-decode the bytes here.
        if (getPreviewStrategy(node.name).isBinary) {
            setPreviewContent(null);
            setPreviewError(null);
            return;
        }
        try {
            setPreviewContent(vfs.readFile(node.path));
            setPreviewError(null);
        } catch (e) {
            setPreviewContent(null);
            setPreviewError(String(e));
        }
    }, [vfs, selectedFile, confirmDiscardIfDirty]);

    const handlePreviewSaved = useCallback(() => {
        // Refresh tree so the file's size badge reflects the new contents.
        bumpRev();
    }, [bumpRev]);

    // Programmatic file open (Cmd+P quick-open, script editor "reveal in
    // files"). Expands parent dirs in the tree, then routes through
    // handleSelect so its dirty-edit guard still prompts before switching.
    // initialPathTick re-triggers this even when the same path is picked
    // twice in a row. Accepts both absolute paths and VFS-relative paths
    // (the latter come from error-log hyperlinks, which Lua emits relative
    // to the profile root).
    useEffect(() => {
        if (!initialPath || !vfs) return;
        const root = vfs.profilePath;
        const abs = initialPath.startsWith(root + '/') || initialPath === root
            ? initialPath
            : `${root}/${initialPath.replace(/^\/+/, '')}`;
        const info = vfs.stat(abs);
        if (!info) return;
        // Directory targets (e.g. openUrl("file:" .. getMudletHomeDir()))
        // just expand the tree down to the dir so the user can browse it.
        if (info.type === 'dir') {
            if (abs === root) return;
            const rel = abs.substring(root.length + 1);
            const parts = rel.split('/');
            setExpanded(prev => {
                const next = new Set(prev);
                let cur = root;
                for (const part of parts) {
                    cur = `${cur}/${part}`;
                    next.add(cur);
                }
                return next;
            });
            return;
        }
        const rel = abs.substring(root.length + 1);
        const parts = rel.split('/');
        if (parts.length > 1) {
            setExpanded(prev => {
                const next = new Set(prev);
                let cur = root;
                for (let i = 0; i < parts.length - 1; i++) {
                    cur = `${cur}/${parts[i]}`;
                    next.add(cur);
                }
                return next;
            });
        }
        const name = parts[parts.length - 1];
        handleSelect({ name, path: abs, type: 'file', size: info.size });
        // Queue the line jump even when initialLine is undefined (the editor
        // ignores nulls): the previous request is replaced so a stale jump
        // from an earlier open can't fire after a no-line click.
        setPreviewGoto(initialLine !== undefined
            ? { line: initialLine, revision: (initialPathTick ?? Date.now()) }
            : null);
    }, [initialPath, initialPathTick, initialLine, vfs, handleSelect]);

    const handleCloseModal = useCallback(() => {
        if (!confirmDiscardIfDirty(selectedFile?.name)) return;
        onClose();
    }, [confirmDiscardIfDirty, selectedFile, onClose]);

    const clearSelection = useCallback((removedPath: string) => {
        setSelectedFile(prev => {
            if (prev && (prev.path === removedPath || prev.path.startsWith(removedPath + '/'))) {
                setPreviewContent(null);
                setPreviewError(null);
                setPreviewDirty(false);
                return null;
            }
            return prev;
        });
    }, []);

    // ── Upload ────────────────────────────────────────────────────────────

    const [uploadDir, setUploadDir] = useState<string>(vfs?.profilePath ?? '');
    const uploadDirRef = useRef<string>(vfs?.profilePath ?? '');
    const uploadInputRef = useRef<HTMLInputElement>(null);
    const uploadFolderInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const path = vfs?.profilePath ?? '';
        uploadDirRef.current = path;
        setUploadDir(path);
    }, [vfs]);

    const handleUploadClick = useCallback(() => uploadInputRef.current?.click(), []);
    const handleUploadFolderClick = useCallback(() => uploadFolderInputRef.current?.click(), []);

    const handleUploadHere = useCallback((dirPath: string) => {
        uploadDirRef.current = dirPath;
        setUploadDir(dirPath);
        setCtxMenu(null);
        uploadInputRef.current?.click();
    }, []);

    const handleUploadFolderHere = useCallback((dirPath: string) => {
        uploadDirRef.current = dirPath;
        setUploadDir(dirPath);
        setCtxMenu(null);
        uploadFolderInputRef.current?.click();
    }, []);

    const resetUploadDir = useCallback(() => {
        const path = vfs?.profilePath ?? '';
        uploadDirRef.current = path;
        setUploadDir(path);
    }, [vfs]);

    // Write a batch of picked/dropped Files into the VFS under targetDir,
    // preserving any folder layout carried on webkitRelativePath. Shared by
    // the upload buttons (handleUpload) and drag-and-drop from the OS.
    const uploadFiles = useCallback((files: File[], targetDir: string) => {
        if (!vfs || files.length === 0) return;
        // Always read as ArrayBuffer and write as binary. UTF-8 text files
        // round-trip cleanly because ZenFS stores them as raw bytes; reading
        // them later via vfs.readFile decodes UTF-8 back to the original
        // string. Reading as text first would silently corrupt binary files
        // (SQLite DBs, images, zips) by trying to UTF-8-decode random bytes.
        let pending = files.length;
        for (const file of files) {
            const reader = new FileReader();
            // webkitRelativePath is set when the user picked a folder — it
            // looks like "myfolder/sub/file.txt" and we preserve that layout
            // under the target dir. Plain file picks/drops leave it empty.
            const relPath = file.webkitRelativePath || file.name;
            const destPath = `${targetDir}/${relPath}`;
            reader.onload = () => {
                try {
                    const bytes = new Uint8Array(reader.result as ArrayBuffer);
                    const slash = destPath.lastIndexOf('/');
                    if (slash > targetDir.length) {
                        vfs.mkdir(destPath.substring(0, slash));
                    }
                    vfs.writeBinaryFile(destPath, bytes);
                } catch (err) {
                    console.error(`Upload failed for ${relPath}:`, err);
                }
                if (--pending === 0) bumpRev();
            };
            reader.onerror = () => { if (--pending === 0) bumpRev(); };
            reader.readAsArrayBuffer(file);
        }
    }, [vfs, bumpRev]);

    const handleUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = '';
        if (!vfs) return;
        uploadFiles(files, uploadDirRef.current || vfs.profilePath);
    }, [vfs, uploadFiles]);

    // ── New folder ────────────────────────────────────────────────────────

    const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
    const [newFolderName, setNewFolderName] = useState('');

    const handleNewFolderHere = useCallback((parentPath: string) => {
        setCtxMenu(null);
        setNewFolderParent(parentPath);
        setNewFolderName('');
        // Ensure the parent dir is expanded so the new folder appears
        setExpanded(prev => {
            const next = new Set(prev);
            next.add(parentPath);
            return next;
        });
    }, []);

    const handleCreateFolder = useCallback((e: React.FormEvent) => {
        e.preventDefault();
        const name = newFolderName.trim();
        if (!name || !vfs || !newFolderParent) { setNewFolderParent(null); return; }
        try {
            vfs.mkdir(`${newFolderParent}/${name}`);
            bumpRev();
        } catch (err) {
            console.error('Create folder failed:', err);
        }
        setNewFolderParent(null);
        setNewFolderName('');
    }, [newFolderName, newFolderParent, vfs, bumpRev]);

    const cancelNewFolder = useCallback(() => {
        setNewFolderParent(null);
        setNewFolderName('');
    }, []);

    // ── Context menu ──────────────────────────────────────────────────────

    const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);

    const handleContextMenu = useCallback((e: React.MouseEvent, node: VFSNode) => {
        e.preventDefault();
        e.stopPropagation();
        setCtxMenu({ x: e.clientX, y: e.clientY, node });
    }, []);

    // Right-click on empty tree-panel area → root context menu
    const handleTreeBgContextMenu = useCallback((e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest('.vfs-row')) return;
        e.preventDefault();
        if (!vfs) return;
        setCtxMenu({ x: e.clientX, y: e.clientY, node: { name: '', path: vfs.profilePath, type: 'dir' } });
    }, [vfs]);

    // ── Inline rename ─────────────────────────────────────────────────────

    const [renamingPath, setRenamingPath] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');

    const handleRename = useCallback((node: VFSNode) => {
        setCtxMenu(null);
        if (!vfs) return;
        if (node.path === vfs.profilePath) return;
        setRenamingPath(node.path);
        setRenameValue(node.name);
    }, [vfs]);

    const cancelRename = useCallback(() => {
        setRenamingPath(null);
        setRenameValue('');
    }, []);

    const commitRename = useCallback((node: VFSNode) => {
        if (!vfs) { cancelRename(); return; }
        const newName = renameValue.trim();
        if (!newName || newName === node.name) { cancelRename(); return; }
        if (newName.includes('/')) {
            window.alert('Name cannot contain "/"');
            return;
        }
        const parent = node.path.substring(0, node.path.lastIndexOf('/'));
        const newPath = `${parent}/${newName}`;
        if (vfs.exists(newPath)) {
            window.alert(`"${newName}" already exists`);
            return;
        }
        try {
            vfs.rename(node.path, newPath);
            clearSelection(node.path);
            pruneExpanded(node.path);
            bumpRev();
        } catch (err) {
            console.error('Rename failed:', err);
            window.alert(`Rename failed: ${(err as Error).message}`);
        } finally {
            cancelRename();
        }
    }, [vfs, renameValue, pruneExpanded, clearSelection, bumpRev, cancelRename]);

    const renameState: RenameState = {
        path: renamingPath,
        value: renameValue,
        onChange: setRenameValue,
        onCommit: commitRename,
        onCancel: cancelRename,
    };

    const handleDelete = useCallback((node: VFSNode) => {
        setCtxMenu(null);
        if (!vfs) return;
        try {
            if (node.type === 'file') {
                vfs.deleteFile(node.path);
            } else {
                vfs.rmdir(node.path);
                pruneExpanded(node.path);
            }
            clearSelection(node.path);
            bumpRev();
        } catch (e) {
            console.error('Delete failed:', e);
        }
    }, [vfs, pruneExpanded, clearSelection, bumpRev]);

    // ── Download ──────────────────────────────────────────────────────────

    // Zipping is synchronous and blocks the UI, so flag it while it runs —
    // a large profile (fonts, sounds, maps) can take a moment.
    const [zipping, setZipping] = useState(false);

    const runDownload = useCallback((fn: () => void) => {
        setZipping(true);
        // Yield to the event loop so the disabled/greyed button gets a chance
        // to paint before zipSync takes the main thread. A timeout rather than
        // requestAnimationFrame: rAF never fires in a background tab, which
        // would leave the download silently stuck.
        setTimeout(() => {
            try {
                fn();
            } catch (err) {
                console.error('Download failed:', err);
                window.alert(`Download failed: ${(err as Error).message}`);
            } finally {
                setZipping(false);
            }
        });
    }, []);

    const handleDownload = useCallback((node: VFSNode) => {
        setCtxMenu(null);
        if (!vfs) return;
        if (node.type === 'file') {
            runDownload(() => downloadVfsFile(vfs, node));
        } else {
            const name = node.path === vfs.profilePath
                ? (connectionName || 'profile')
                : node.name;
            runDownload(() => downloadVfsDir(vfs, node.path, name));
        }
    }, [vfs, connectionName, runDownload]);

    const handleDownloadAll = useCallback(() => {
        if (!vfs) return;
        runDownload(() => downloadVfsDir(vfs, vfs.profilePath, connectionName || 'profile'));
    }, [vfs, connectionName, runDownload]);

    // ── Drag & Drop ───────────────────────────────────────────────────────

    const [dragPath, setDragPath] = useState<string | null>(null);
    const dragPathRef = useRef<string | null>(null);
    const [dropTarget, setDropTarget] = useState<string | null>(null);

    const handleDragStart = useCallback((e: React.DragEvent, node: VFSNode) => {
        dragPathRef.current = node.path;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', node.path);
        // Defer so the ghost image captures the undimmed element
        setTimeout(() => setDragPath(node.path), 0);
    }, []);

    const handleDragEnd = useCallback(() => {
        dragPathRef.current = null;
        setDragPath(null);
        setDropTarget(null);
    }, []);

    const handleDragOverDir = useCallback((e: React.DragEvent, dirPath: string) => {
        e.preventDefault();
        // OS file drag (vs. an internal node move): types carries 'Files'.
        // getData is blocked during dragover, so detect via types here.
        if (e.dataTransfer.types.includes('Files')) {
            e.dataTransfer.dropEffect = 'copy';
            setDropTarget(prev => prev === dirPath ? prev : dirPath);
            return;
        }
        const src = dragPathRef.current;
        if (src && canMove(src, dirPath)) {
            e.dataTransfer.dropEffect = 'move';
            setDropTarget(prev => prev === dirPath ? prev : dirPath);
        } else {
            e.dataTransfer.dropEffect = 'none';
        }
    }, []);

    const handleDragLeaveDir = useCallback((dirPath: string) => {
        setDropTarget(prev => prev === dirPath ? null : prev);
    }, []);

    const handleDropOnDir = useCallback((e: React.DragEvent, destDirPath: string) => {
        e.preventDefault();
        setDropTarget(null);
        // Files dropped from the OS → upload into this directory. Stop here so
        // the drop doesn't also bubble to the tree panel's catch-all handler.
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            e.stopPropagation();
            uploadFiles(Array.from(e.dataTransfer.files), destDirPath);
            return;
        }
        const srcPath = e.dataTransfer.getData('text/plain') || dragPathRef.current;
        dragPathRef.current = null;
        setDragPath(null);
        if (!srcPath || !vfs || !canMove(srcPath, destDirPath)) return;
        try {
            moveVFSNode(vfs, srcPath, destDirPath);
            clearSelection(srcPath);
            pruneExpanded(srcPath);
            bumpRev();
        } catch (err) {
            console.error('Move failed:', err);
        }
    }, [vfs, clearSelection, pruneExpanded, bumpRev, uploadFiles]);

    // Catch-all for OS files dropped on empty tree space (or anywhere not over
    // a specific directory): upload into the current target dir, else the root.
    const [panelDropActive, setPanelDropActive] = useState(false);
    const handlePanelDragOver = useCallback((e: React.DragEvent) => {
        if (!vfs || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setPanelDropActive(true);
    }, [vfs]);
    const handlePanelDragLeave = useCallback((e: React.DragEvent) => {
        // Only clear when the pointer actually leaves the panel, not when it
        // crosses into a child row (relatedTarget still inside the panel).
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setPanelDropActive(false);
    }, []);
    const handlePanelDrop = useCallback((e: React.DragEvent) => {
        setPanelDropActive(false);
        if (!vfs || e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        uploadFiles(Array.from(e.dataTransfer.files), uploadDirRef.current || vfs.profilePath);
    }, [vfs, uploadFiles]);

    const dnd: DragHandlers = {
        dragPath, dropTarget,
        onDragStart: handleDragStart,
        onDragEnd: handleDragEnd,
        onDragOverDir: handleDragOverDir,
        onDragLeaveDir: handleDragLeaveDir,
        onDropOnDir: handleDropOnDir,
    };

    // ── Folder link state ─────────────────────────────────────────────────

    const linkSupported = isFolderLinkSupported();
    const [linkedHandle, setLinkedHandle] = useState<FileSystemDirectoryHandle | null>(null);
    const [linkedPerm, setLinkedPerm] = useState<FolderPermissionState>('prompt');
    const [linkNotice, setLinkNotice] = useState<string | null>(null);

    const refreshLinkState = useCallback(async () => {
        if (!connectionId || !linkSupported) {
            setLinkedHandle(null);
            return;
        }
        const h = await loadFolderHandle(connectionId).catch(() => null);
        setLinkedHandle(h);
        setLinkedPerm(h ? await checkFolderPermission(h) : 'prompt');
    }, [connectionId, linkSupported]);

    useEffect(() => { void refreshLinkState(); }, [refreshLinkState]);

    // Pending link operation: the user picked a folder, but the two sides
    // overlapped. We hold the handle here while the merge modal is open so
    // applying / cancelling can finish the link or back out cleanly.
    const [mergePending, setMergePending] = useState<{
        handle: FileSystemDirectoryHandle;
        diff: DiffResult;
    } | null>(null);
    const [linkBusy, setLinkBusy] = useState(false);

    // Materialize the user's choices into the folder, then commit the link.
    // Folder is the next mount's source of truth: anything we want preserved
    // has to live on disk before we save the handle.
    const finalizeLink = useCallback(async (
        handle: FileSystemDirectoryHandle,
        diff: DiffResult,
        resolutions: Map<string, SideKind>,
    ) => {
        if (!vfs) return;
        // Paths we need to write into the folder: every local-only file, plus
        // every conflict the user resolved in local's favor (overwrites the
        // folder copy). Folder-only files and folder-resolved conflicts are
        // already on disk — nothing to do for them.
        const toCopy: string[] = diff.onlyLocal.map(f => f.path);
        for (const c of diff.conflicts) {
            if (resolutions.get(c.path) === 'local') toCopy.push(c.path);
        }
        let copyNote = '';
        if (toCopy.length > 0) {
            const { copied, failed } = await copyVfsToFolder(vfs, handle, toCopy);
            copyNote = failed.length > 0
                ? ` Copied ${copied}/${toCopy.length} (${failed.length} failed — see console).`
                : ` Copied ${copied} local file${copied === 1 ? '' : 's'} into the folder.`;
            if (failed.length > 0) console.warn('[link] copy failures:', failed);
        }
        await saveFolderHandle(connectionId, handle);
        setLinkedHandle(handle);
        setLinkedPerm('granted');
        setLinkNotice(`Linked "${handle.name}".${copyNote} Close and reopen this profile to mount it.`);
    }, [vfs, connectionId]);

    const handleLinkFolder = useCallback(async () => {
        if (!linkSupported || !window.showDirectoryPicker) return;
        let handle: FileSystemDirectoryHandle;
        try {
            handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        } catch {
            return; // user cancelled
        }
        const perm = await requestFolderPermission(handle);
        if (perm !== 'granted') {
            setLinkNotice(`Permission ${perm}. Folder not linked.`);
            return;
        }
        setLinkBusy(true);
        try {
            // Walk both sides to figure out which case we're in. The folder is
            // probed via the raw File System Access API — it is not yet mounted
            // as the profile VFS (and won't be until the user reopens the
            // profile), so vfs.* still describes the IDB-backed current state.
            const folderEntries = await walkFolderHandle(handle).catch(err => {
                console.warn('[link] folder walk failed:', err);
                return [];
            });
            const localEntries = vfs ? walkVfsTree(vfs) : [];
            const diff = diffSides(localEntries, folderEntries);

            if (diff.conflicts.length === 0) {
                // Either side may still be non-empty — copy any local-only
                // files into the folder so they survive the mount switch.
                await finalizeLink(handle, diff, new Map());
            } else {
                // Conflicting paths exist — defer to the merge picker. The
                // handle isn't saved yet; cancelling leaves the profile in its
                // current state.
                setMergePending({ handle, diff });
            }
        } finally {
            setLinkBusy(false);
        }
    }, [linkSupported, vfs, finalizeLink]);

    const handleMergeApply = useCallback(async (resolutions: Map<string, SideKind>) => {
        const pending = mergePending;
        if (!pending) return;
        setMergePending(null);
        setLinkBusy(true);
        try {
            await finalizeLink(pending.handle, pending.diff, resolutions);
        } finally {
            setLinkBusy(false);
        }
    }, [mergePending, finalizeLink]);

    const handleMergeCancel = useCallback(() => {
        setMergePending(null);
        setLinkNotice('Link cancelled.');
    }, []);

    const handleUnlinkFolder = useCallback(async () => {
        // If the active mount is folder-backed, mirror the folder content into
        // the IDB store first so the next mount (now IDB, since we're clearing
        // the handle) sees the same files instead of stale pre-link IDB content.
        let copyNote = '';
        if (vfs?.source === 'folder' && linkedHandle) {
            setLinkBusy(true);
            try {
                // Flush any pending folder-backed writes so what we walk on disk
                // matches what the user just edited.
                await vfs.flush().catch(() => { /* best-effort */ });
                const { copied, failed } = await copyFolderToIdb(linkedHandle, connectionId);
                copyNote = failed.length > 0
                    ? ` Copied ${copied} file${copied === 1 ? '' : 's'} to local storage (${failed.length} failed — see console).`
                    : ` Copied ${copied} file${copied === 1 ? '' : 's'} to local storage.`;
                if (failed.length > 0) console.warn('[unlink] copy failures:', failed);
            } catch (err) {
                console.error('[unlink] folder→IDB copy failed:', err);
                copyNote = ' (warning: copy to local storage failed — see console).';
            } finally {
                setLinkBusy(false);
            }
        }
        await clearFolderHandle(connectionId);
        setLinkedHandle(null);
        setLinkedPerm('prompt');
        setLinkNotice(`Folder unlinked.${copyNote} Close and reopen this profile to revert to local storage.`);
    }, [connectionId, vfs, linkedHandle]);

    const handleRegrantPermission = useCallback(async () => {
        if (!linkedHandle) return;
        const perm = await requestFolderPermission(linkedHandle);
        setLinkedPerm(perm);
        if (perm === 'granted') setLinkNotice('Permission granted. Close and reopen this profile to mount the folder.');
    }, [linkedHandle]);

    // ── Derived ───────────────────────────────────────────────────────────

    const isAtRoot = !vfs || uploadDir === vfs.profilePath;
    const uploadTitle = isAtRoot
        ? 'Upload to profile root'
        : `Upload to: ${uploadDir.substring((vfs?.profilePath.length ?? 0) + 1)}`;

    const newFolderLabel = newFolderParent === vfs?.profilePath
        ? '/'
        : `/${newFolderParent?.substring((vfs?.profilePath.length ?? 0) + 1)}/`;

    const isRoot = (node: VFSNode) => node.path === vfs?.profilePath;

    return (
        <>
            <ResizableModal
                title="Profile Files"
                onClose={handleCloseModal}
                // An inline edit owns Escape while it is open — cancelling the
                // rename or the new-folder entry, the way a QTreeWidget's item
                // editor consumes the key before its dialog ever sees it. The
                // dialog's own Escape-to-close resumes once the edit is done.
                // (Those handlers are React's, dispatched from the portal
                // container, so they run *after* the trap's native listener on
                // the dialog node — a stopPropagation there would be too late.)
                closeOnEscape={renamingPath === null && newFolderParent === null}
                savedBounds={savedBounds}
                onBoundsChange={b => saveModalBounds(connectionId, 'files', b)}
                defaultW={620}
                defaultH={520}
                minW={280}
                minH={200}
                headerExtra={
                    <>
                        <input
                            ref={uploadInputRef}
                            type="file"
                            multiple
                            style={{ display: 'none' }}
                            onChange={handleUpload}
                        />
                        <input
                            ref={uploadFolderInputRef}
                            type="file"
                            multiple
                            style={{ display: 'none' }}
                            onChange={handleUpload}
                            // webkitdirectory isn't typed in React's InputHTMLAttributes
                            // but it works in Chrome, Edge, Firefox, and Safari on desktop.
                            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                        />
                        {!isAtRoot && (
                            <button
                                className="modal-close"
                                title="Reset upload target to root"
                                onClick={resetUploadDir}
                            >
                                <Home size={13} />
                            </button>
                        )}
                        <button
                            className="modal-close"
                            title={uploadTitle}
                            onClick={handleUploadClick}
                            disabled={!vfs}
                        >
                            <Upload size={13} />
                        </button>
                        <button
                            className="modal-close"
                            title={isAtRoot ? 'Upload folder to profile root' : `Upload folder to: ${uploadDir.substring((vfs?.profilePath.length ?? 0) + 1)}`}
                            onClick={handleUploadFolderClick}
                            disabled={!vfs}
                        >
                            <FolderUp size={13} />
                        </button>
                        <button
                            className="modal-close"
                            title="Download the whole profile as a .zip"
                            onClick={handleDownloadAll}
                            disabled={!vfs || zipping}
                        >
                            <FolderDown size={13} style={zipping ? { opacity: 0.4 } : undefined} />
                        </button>
                        {linkSupported && (linkedHandle ? (
                            <button
                                className="modal-close"
                                title={`Unlink folder "${linkedHandle.name}"`}
                                onClick={handleUnlinkFolder}
                                disabled={linkBusy}
                            >
                                <Unlink size={13} style={linkBusy ? { opacity: 0.4 } : undefined} />
                            </button>
                        ) : (
                            <button
                                className="modal-close"
                                title="Link a folder on disk to this profile"
                                onClick={handleLinkFolder}
                                disabled={linkBusy}
                            >
                                <Link size={13} style={linkBusy ? { opacity: 0.4 } : undefined} />
                            </button>
                        ))}
                        <button
                            className="modal-close"
                            title={vfs?.source === 'folder' ? 'Resync from disk' : 'Refresh'}
                            onClick={refresh}
                            disabled={resyncing}
                        >
                            <RefreshCw size={13} style={resyncing ? { opacity: 0.4 } : undefined} />
                        </button>
                    </>
                }
            >
                {(linkedHandle || linkNotice) && (
                    <div className="vfs-link-banner" style={{ padding: '4px 8px', fontSize: 11, opacity: 0.85, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        {linkedHandle && (
                            <span>
                                {vfs?.source === 'folder'
                                    ? `Mounted from folder: ${vfs.folderName ?? linkedHandle.name}`
                                    : `Linked folder: ${linkedHandle.name} (close and reopen the profile to mount)`}
                            </span>
                        )}
                        {linkedHandle && linkedPerm !== 'granted' && vfs?.source !== 'folder' && (
                            <button className="modal-close" onClick={handleRegrantPermission} title="Re-grant folder permission">
                                Re-grant access
                            </button>
                        )}
                        {linkNotice && <span style={{ opacity: 0.7 }}>· {linkNotice}</span>}
                    </div>
                )}

                {vfs && (
                    <div
                        className={`vfs-path-bar${dropTarget === vfs.profilePath ? ' vfs-drop-target' : ''}`}
                        onContextMenu={e => handleContextMenu(e, { name: '', path: vfs.profilePath, type: 'dir' })}
                        onDragOver={e => handleDragOverDir(e, vfs.profilePath)}
                        onDragLeave={() => handleDragLeaveDir(vfs.profilePath)}
                        onDrop={e => handleDropOnDir(e, vfs.profilePath)}
                    >
                        {vfs.profilePath}
                    </div>
                )}

                {newFolderParent && (
                    <form className="vfs-new-folder-form" onSubmit={handleCreateFolder}>
                        <FolderPlus size={12} />
                        <span className="vfs-new-folder-label">{newFolderLabel}</span>
                        <input
                            autoFocus
                            className="vfs-new-folder-input"
                            value={newFolderName}
                            onChange={e => setNewFolderName(e.target.value)}
                            onKeyDown={e => e.key === 'Escape' && cancelNewFolder()}
                            placeholder="folder name…"
                        />
                    </form>
                )}

                <div className="vfs-split">
                    <div
                        className={`vfs-tree-panel${panelDropActive ? ' vfs-tree-panel--drop' : ''}`}
                        onContextMenu={handleTreeBgContextMenu}
                        onDragOver={handlePanelDragOver}
                        onDragLeave={handlePanelDragLeave}
                        onDrop={handlePanelDrop}
                    >
                        {!vfs ? (
                            <p className="vfs-empty">No profile mounted.</p>
                        ) : tree.length === 0 ? (
                            <p className="vfs-empty">Profile directory is empty.</p>
                        ) : (
                            <div className="vfs-tree">
                                {tree.map(node => (
                                    <TreeNode
                                        key={node.path}
                                        node={node}
                                        depth={0}
                                        expanded={expanded}
                                        selectedPath={selectedFile?.path ?? null}
                                        uploadDir={uploadDir}
                                        onToggle={handleToggle}
                                        onSelect={handleSelect}
                                        onContextMenu={handleContextMenu}
                                        dnd={dnd}
                                        rename={renameState}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                    <div className="vfs-preview-panel">
                        <PreviewPanel
                            file={selectedFile}
                            content={previewContent}
                            error={previewError}
                            vfs={vfs}
                            onDirtyChange={setPreviewDirty}
                            onSaved={handlePreviewSaved}
                            gotoLine={previewGoto}
                        />
                    </div>
                </div>
            </ResizableModal>

            {mergePending && (
                <MergeConflictModal
                    diff={mergePending.diff}
                    folderName={mergePending.handle.name}
                    onApply={handleMergeApply}
                    onCancel={handleMergeCancel}
                />
            )}

            {ctxMenu && (
                <ContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}>
                    {ctxMenu.node.type === 'dir' && (
                        <>
                            <button
                                className="ctx-menu__item"
                                type="button"
                                onClick={() => handleNewFolderHere(ctxMenu.node.path)}
                            >
                                <FolderPlus size={13} />
                                New folder{isRoot(ctxMenu.node) ? '' : ' here'}
                            </button>
                            <button
                                className="ctx-menu__item"
                                type="button"
                                onClick={() => handleUploadHere(ctxMenu.node.path)}
                            >
                                <Upload size={13} />
                                Upload here
                            </button>
                            <button
                                className="ctx-menu__item"
                                type="button"
                                onClick={() => handleUploadFolderHere(ctxMenu.node.path)}
                            >
                                <FolderUp size={13} />
                                Upload folder here
                            </button>
                            <button
                                className="ctx-menu__item"
                                type="button"
                                onClick={() => handleDownload(ctxMenu.node)}
                            >
                                <FolderDown size={13} />
                                {isRoot(ctxMenu.node) ? 'Download profile as .zip' : 'Download folder as .zip'}
                            </button>
                            <button
                                className="ctx-menu__item"
                                type="button"
                                onClick={() => handleRename(ctxMenu.node)}
                            >
                                <LucideFolderPen size={13} />
                                Rename
                            </button>
                            {!isRoot(ctxMenu.node) && (
                                <>
                                    <div className="ctx-menu__sep" />
                                    <button
                                        className="ctx-menu__item ctx-menu__item--danger"
                                        type="button"
                                        onClick={() => handleDelete(ctxMenu.node)}
                                    >
                                        <Trash2 size={13} />
                                        Delete folder
                                    </button>
                                </>
                            )}
                        </>
                    )}
                    {ctxMenu.node.type === 'file' && (
                        <>
                            {onPlayReplay && ctxMenu.node.name.toLowerCase().endsWith('.dat') && (
                                <button
                                    className="ctx-menu__item"
                                    type="button"
                                    onClick={() => { setCtxMenu(null); onPlayReplay(ctxMenu.node.path); }}
                                >
                                    <Play size={13} />
                                    Play replay
                                </button>
                            )}
                            <button
                                className="ctx-menu__item"
                                type="button"
                                onClick={() => handleDownload(ctxMenu.node)}
                            >
                                <Download size={13} />
                                Download
                            </button>
                            <button
                                className="ctx-menu__item"
                                type="button"
                                onClick={() => handleRename(ctxMenu.node)}
                            >
                                <LucideFolderPen size={13} />
                                Rename
                            </button>
                            <div className="ctx-menu__sep" />
                            <button
                                className="ctx-menu__item ctx-menu__item--danger"
                                type="button"
                                onClick={() => handleDelete(ctxMenu.node)}
                            >
                                <Trash2 size={13} />
                                Delete file
                            </button>
                        </>
                    )}
                </ContextMenu>
            )}
        </>
    );
}
