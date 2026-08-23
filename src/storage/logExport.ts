import { strToU8, zipSync } from 'fflate';
import { appendEntries, createSession, getSessionEntries, type LogEntry, type LogSession } from './logStorage';

/** Two-digit zero-pad. */
function pad(n: number): string {
    return n < 10 ? `0${n}` : `${n}`;
}

/** `YYYY-MM-DD HH-MM-SS`, safe for filenames. */
export function formatSessionFileStamp(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** `HH:MM:SS` for per-line timestamps. */
export function formatTime(ts: number): string {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `YYYY-MM-DD HH:MM:SS` for session labels. */
export function formatDateTime(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function sanitizeFilename(name: string): string {
    return name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim() || 'log';
}

function escapeHtml(s: string): string {
    // Quotes matter: this also escapes values that land inside an attribute
    // (the `class="…"` on each line div below).
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const DOC_STYLE = `
  body { margin: 0; background: #0b0b0b; color: #d4d4d4;
    font: 13px/1.45 "Cascadia Code", "Consolas", monospace; }
  header { padding: 12px 16px; border-bottom: 1px solid #2a2a2a; position: sticky; top: 0;
    background: #0b0b0b; }
  header h1 { margin: 0 0 4px; font-size: 15px; }
  header .meta { color: #8a8a8a; font-size: 12px; }
  main { padding: 8px 16px; }
  .line { white-space: pre-wrap; word-break: break-word; }
  .line .ts { color: #5a5a5a; margin-right: 8px; user-select: none; }
  .line.echo { color: #7aa2f7; }
  .line.error { color: #f7768e; }
`;

/** A standalone, self-contained HTML document for one session. */
export function buildSessionHtml(session: LogSession, entries: LogEntry[]): string {
    const title = `${escapeHtml(session.connectionName)} — ${formatDateTime(session.startedAt)}`;
    const lines = entries.map(e =>
        `<div class="line ${escapeHtml(e.type)}">` +
        `<span class="ts">${formatTime(e.timestamp)}</span>${e.html}</div>`,
    ).join('\n');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${DOC_STYLE}</style>
</head>
<body>
<header>
<h1>${escapeHtml(session.connectionName)}</h1>
<div class="meta">${formatDateTime(session.startedAt)} – ${formatDateTime(session.endedAt)} · ${session.entryCount} lines</div>
</header>
<main>
${lines}
</main>
</body>
</html>`;
}

/** Trigger a browser download for an in-memory blob. */
export function downloadBlob(filename: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick so the click has a chance to start.
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

function sessionBaseName(session: LogSession): string {
    return sanitizeFilename(`${session.connectionName} ${formatSessionFileStamp(session.startedAt)}`);
}

/** Download one session as a standalone `.html` file. */
export async function exportSessionHtml(session: LogSession): Promise<void> {
    const entries = await getSessionEntries(session.id);
    const html = buildSessionHtml(session, entries);
    downloadBlob(`${sessionBaseName(session)}.html`, new Blob([html], { type: 'text/html' }));
}

/** Bundle several sessions into one `.zip`, one HTML file per session. */
export async function exportSessionsZip(sessions: LogSession[]): Promise<void> {
    const files: Record<string, Uint8Array> = {};
    const used = new Set<string>();
    for (const session of sessions) {
        const entries = await getSessionEntries(session.id);
        let name = `${sessionBaseName(session)}.html`;
        // Disambiguate the rare collision (same name + second).
        let i = 2;
        while (used.has(name)) name = `${sessionBaseName(session)} (${i++}).html`;
        used.add(name);
        files[name] = strToU8(buildSessionHtml(session, entries));
    }
    const zipped = zipSync(files, { level: 6 });
    const stamp = formatSessionFileStamp(Date.now());
    // Copy into a fresh ArrayBuffer-backed view so Blob gets a plain BlobPart.
    downloadBlob(`mudix-logs ${stamp}.zip`, new Blob([zipped.slice()], { type: 'application/zip' }));
}

/** Shape of the JSON export/import payload. */
export interface LogExportJson {
    version: 1;
    exportedAt: number;
    sessions: Array<{ session: LogSession; entries: LogEntry[] }>;
}

/** Export sessions (with their entries) to a `.json` file. */
export async function exportSessionsJson(sessions: LogSession[]): Promise<void> {
    const payload: LogExportJson = { version: 1, exportedAt: Date.now(), sessions: [] };
    for (const session of sessions) {
        const entries = await getSessionEntries(session.id);
        payload.sessions.push({ session, entries });
    }
    const stamp = formatSessionFileStamp(Date.now());
    downloadBlob(`mudix-logs ${stamp}.json`, new Blob([JSON.stringify(payload)], { type: 'application/json' }));
}

/**
 * Import a previously exported JSON payload. Each session is re-keyed with a
 * fresh id so re-importing never clobbers an existing session, and entry rows
 * drop their old auto-increment ids. Returns the number of sessions imported.
 */
export async function importSessionsJson(text: string): Promise<number> {
    const parsed = JSON.parse(text) as LogExportJson;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
        throw new Error('Unrecognized log export file');
    }
    let count = 0;
    for (const { session, entries } of parsed.sessions) {
        const newId = crypto.randomUUID();
        const rekeyed: LogEntry[] = entries.map(e => {
            const { id: _drop, ...rest } = e;
            return { ...rest, sessionId: newId };
        });
        await createSession({ ...session, id: newId, entryCount: rekeyed.length });
        await appendEntries(rekeyed);
        count++;
    }
    return count;
}
