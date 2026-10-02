import type { MudSession } from '../mud/MudSession';
import { AnsiAwareBuffer } from '../mud/text/FormatState';
import { appendEntries, createSession, updateSession, type LogEntry } from '../storage/logStorage';

/**
 * How the file log is written. Mudlet's `logInHTML` picks between two genuinely
 * different documents, and the HTML one has to name the console's own font and
 * background — neither of which the logger can see for itself.
 */
export interface LogFormat {
    html: boolean;
    /** Resolved console font family, the one `getFont()` reports. */
    font?: string;
    /** Console background, painted behind the whole document as Mudlet does. */
    background?: { r: number; g: number; b: number };
    /** Console foreground — the body's text colour, and what an HTML log line
     *  names for text with no colour of its own (Host::mFgColor). */
    foreground?: { r: number; g: number; b: number };
}

const DEFAULT_LOG_FG = { r: 192, g: 192, b: 192 };
const DEFAULT_LOG_BG = { r: 0, g: 0, b: 0 };

/** Mudlet's HTML log preamble, as TConsoleModel::toggleLogging writes it: a
 *  strict-HTML wrapper, a title, and a stylesheet naming the console font,
 *  foreground and background, with the fallback families Mudlet appends. The
 *  body is written separately — a restarted log carries the old one forward. */
function htmlLogHeader(title: string, format?: LogFormat): string {
    const bg = format?.background ?? DEFAULT_LOG_BG;
    const fg = format?.foreground ?? DEFAULT_LOG_FG;
    const families = [format?.font, 'Courier New', 'Monospace', 'Courier']
        .filter((f): f is string => !!f)
        .filter((f, i, all) => all.indexOf(f) === i);
    return "<!DOCTYPE HTML PUBLIC '-//W3C//DTD HTML 4.01//EN' 'http://www.w3.org/TR/html4/strict.dtd'>\n"
        + '<html>\n'
        + " <head>\n"
        + "  <meta http-equiv='content-type' content='text/html; charset=utf-8'>"
        + "  <meta name='generator' content='Mudlet Web'>\n"
        + `  <title>Mudlet, log from ${escapeHtml(title)} profile</title>\n`
        + "  <style type='text/css'>\n"
        + `   <!-- body { font-family: '${families.join("', '")}'; font-size: 100%;`
        + ` line-height: 1.125em; white-space: nowrap; color:rgb(${fg.r},${fg.g},${fg.b});`
        + ` background-color:rgb(${bg.r},${bg.g},${bg.b});}\n`
        + '        span { white-space: pre-wrap; }\n'
        + '     -->\n'
        + '  </style>\n'
        + '  </head>\n';
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

/** The line TConsoleModel::toggleLogging opens and closes every log session
 *  with — `'Log session starting at 'hh:mm:ss' on 'dddd', 'd' 'MMMM' 'yyyy'.'`,
 *  e.g. "Log session starting at 06:16:55 on Thursday, 1 October 2026." */
export function logSessionLine(kind: 'starting' | 'ending', d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `Log session ${kind} at ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
        + ` on ${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}.`;
}

/** What a text log puts between two sessions written to one file: 80 × U+23AF. */
const TEXT_LOG_SESSION_RULE = '⎯'.repeat(80);

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const FLUSH_INTERVAL_MS = 1500;
/** Force a flush once the in-memory buffer reaches this many lines. */
const FLUSH_AT = 500;

/**
 * Transient partial lines (a script echo being built up character-by-character
 * before its newline). The completed line is re-emitted as 'script' /
 * 'trigger-echo', so logging the partials would just create duplicates.
 */
const SKIP_TYPES = new Set(['script-partial']);

/**
 * Records one gameplay session to IndexedDB. Subscribes to the session's
 * `message` event — the single choke point every line of output passes
 * through, including the player's own echoed commands (type 'echo') — and
 * snapshots each line's rendered HTML at emit time (before later trigger
 * gagging/recolouring can mutate the live buffer). Lines are buffered and
 * written in batches to keep IndexedDB traffic off the hot path.
 *
 * The session record is created lazily on the first flush that carries
 * entries, so opening a profile you never receive output in leaves no trace.
 */
export class SessionLogger {
    private readonly sessionId = crypto.randomUUID();
    private readonly startedAt = Date.now();
    private buffer: LogEntry[] = [];
    /** Absolute VFS path of the plain-text log, or null when there is no VFS to
     *  write one into. See {@link openLogFile}. */
    private logFilePath: string | null = null;
    /** Lines written to the text log but not yet flushed to the VFS. Kept
     *  separate from `buffer` (the IndexedDB batch) because the two flush on
     *  different triggers and the text log has to survive an IDB failure. */
    private fileBuffer: string[] = [];
    private seq = 0;
    private totalCount = 0;
    private flushTimer: ReturnType<typeof setInterval> | null = null;
    private unsubscribe: (() => void) | null = null;
    private sessionCreated = false;
    /** Serializes flushes so a size-triggered flush can't race the timer. */
    private flushing: Promise<void> = Promise.resolve();

    constructor(
        private readonly session: MudSession,
        private readonly connectionId: string,
        private readonly connectionName: string,
        /** Profile filesystem the plain-text log is written into. Optional: the
         *  IndexedDB record is the primary log and works without one. */
        private readonly vfs?: { profilePath: string; mkdir(p: string): void; writeFile(p: string, c: string): void; exists(p: string): boolean; readFile(p: string): string } | null,
    ) {}

    start(): void {
        if (this.unsubscribe) return;
        this.unsubscribe = this.session.events.on('message', (text, type, timestamp) => {
            this.capture(text, type, timestamp);
        });
        this.flushTimer = setInterval(() => { void this.flush(); }, FLUSH_INTERVAL_MS);
    }

    /** Where this session's plain-text log is being written, or null when the
     *  file log is off. Backs Mudlet's `startLogging` path return. */
    get filePath(): string | null {
        return this.logFilePath;
    }

    /**
     * Mudlet's `startLogging(true)` — begin mirroring output to a file as well.
     * Deliberately separate from {@link start}: recording to the log browser is
     * a Mudlet Web profile setting that is on by default, whereas Mudlet's file log
     * is something a player or script asks for. Sharing one switch would have
     * every profile quietly writing a file nobody asked for, and would make
     * `startLogging(true)` report "already on" for ever.
     *
     * The file is created up front, before any line has arrived, so a script can
     * hand its path straight to something else. Named as Mudlet names its own:
     * `<profile>/log/<yyyy-MM-dd#hh-mm-ss>.txt` — or `.html` when `format.html`
     * is set (Mudlet's `logInHTML`), which is a whole second document format
     * rather than the same lines with markup: a `<html>` wrapper, a stylesheet
     * naming the console's own font and background, and a closing tag pair only
     * {@link stopFileLog} writes.
     */
    startFileLog(format?: LogFormat): string | null {
        if (this.logFilePath) return this.logFilePath;
        this.logHtml = format?.html ?? false;
        this.logBackground = format?.background ?? DEFAULT_LOG_BG;
        this.logForeground = format?.foreground ?? DEFAULT_LOG_FG;
        this.openLogFile(format);
        return this.logFilePath;
    }

    /** Stop mirroring to the file, writing out whatever is buffered, then the
     *  "Log session ending at …" line — and, for an HTML log, the closing tags
     *  that make it a document. */
    stopFileLog(): void {
        if (this.logFilePath) {
            const end = logSessionLine('ending', new Date());
            this.fileBuffer.push(this.logHtml ? `<p>${end}</p>\n  </div></body>\n</html>\n` : `${end}\n`);
        }
        this.flushLogFile();
        this.logFilePath = null;
        this.logHtml = false;
    }

    /** Whether the open file log is HTML rather than plain text. */
    private logHtml = false;
    /** The console colours an HTML log line names for text with none of its own
     *  (and paints transparent backgrounds with). */
    private logBackground = DEFAULT_LOG_BG;
    private logForeground = DEFAULT_LOG_FG;

    private openLogFile(format?: LogFormat): void {
        if (!this.vfs) return;
        const d = new Date(this.startedAt);
        const p = (n: number, w = 2) => String(n).padStart(w, '0');
        const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
            + `#${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
        const path = `${this.vfs.profilePath}/log/${stamp}.${this.logHtml ? 'html' : 'txt'}`;
        try {
            this.vfs.mkdir(`${this.vfs.profilePath}/log`);
            // Never blank one that is already there. The name carries the
            // second this logger was built, so stopping and restarting logging
            // inside one session comes back to the same file, and truncating it
            // would throw away everything the first stretch had written. Mudlet
            // reopens it the way TConsoleModel::toggleLogging does: a text log
            // is appended to after a rule, and an HTML one is rebuilt with the
            // old body carried forward and an <hr> before the new session.
            const existing = this.vfs.exists(path) ? this.vfs.readFile(path) : '';
            const start = logSessionLine('starting', new Date());
            if (this.logHtml) {
                const lines = existing.split('\n');
                const open = lines.findIndex(l => l.includes('<body><div>'));
                let body = '  <body><div>\n';
                if (open >= 0) {
                    const close = lines.findIndex((l, i) => i > open && l.includes('</div></body>'));
                    body = lines.slice(open, close < 0 ? lines.length : close).map(l => `${l}\n`).join('')
                        + '  </div><hr><div>\n';
                }
                this.vfs.writeFile(path, htmlLogHeader(this.connectionName, format) + body + `<p>${start}</p>\n`);
            } else {
                // A few junk bytes (a BOM) at the start don't count as a session.
                const rule = existing.length > 5 ? `${TEXT_LOG_SESSION_RULE}\n` : '';
                this.vfs.writeFile(path, `${existing}${rule}${start}\n`);
            }
            this.logFilePath = path;
        } catch (err) {
            console.warn('[SessionLogger] could not open the log file', err);
            this.logFilePath = null;
        }
    }

    /** Append the buffered lines to the log file. ZenFS has no
     *  append mode we can rely on across both backends, so this re-writes the
     *  file with the new tail — hence the buffering. */
    private flushLogFile(): void {
        if (!this.vfs || !this.logFilePath || this.fileBuffer.length === 0) return;
        const tail = this.fileBuffer.join('');
        this.fileBuffer = [];
        try {
            const existing = this.vfs.exists(this.logFilePath) ? this.vfs.readFile(this.logFilePath) : '';
            this.vfs.writeFile(this.logFilePath, existing + tail);
        } catch (err) {
            console.warn('[SessionLogger] could not write to the log file', err);
        }
    }

    private capture(text?: string | AnsiAwareBuffer, type?: string, timestamp?: number): void {
        if (text === undefined || text === null) return;
        const entryType = type ?? 'mud';
        if (SKIP_TYPES.has(entryType)) return;

        // Snapshot the styled HTML now. For raw strings, route through a buffer
        // so any embedded ANSI is parsed and the text is HTML-escaped.
        const buffer = typeof text === 'string' ? new AnsiAwareBuffer(text) : text;
        this.buffer.push({
            sessionId: this.sessionId,
            seq: this.seq++,
            timestamp: timestamp ?? Date.now(),
            type: entryType,
            html: buffer.toHtml(),
            plain: buffer.text,
        });
        this.totalCount++;
        // An HTML log line is TBuffer::bufferToHtml's: spans naming both
        // colours, ending in <br> (the body is nowrap, so that is what breaks
        // the lines); a text log takes the plain line.
        if (this.logFilePath) {
            this.fileBuffer.push(this.logHtml
                ? buffer.toLogHtml({ foreground: this.logForeground, background: this.logBackground })
                : buffer.text + '\n');
        }
        if (this.buffer.length >= FLUSH_AT) void this.flush();
    }

    /**
     * Mudlet `appendLog(text)` — append an arbitrary line to the current log,
     * outside the normal output stream. Recorded with type 'appendLog'; any
     * embedded ANSI is parsed for the HTML snapshot.
     */
    appendLine(text: string): void {
        this.capture(text ?? '', 'appendLog');
    }

    /** Persist any buffered lines and bump the session's end time/count. */
    flush(): Promise<void> {
        this.flushLogFile();
        this.flushing = this.flushing.then(() => this.doFlush());
        return this.flushing;
    }

    private async doFlush(): Promise<void> {
        if (this.buffer.length === 0) return;
        const batch = this.buffer;
        this.buffer = [];
        try {
            if (!this.sessionCreated) {
                this.sessionCreated = true;
                await createSession({
                    id: this.sessionId,
                    connectionId: this.connectionId,
                    connectionName: this.connectionName,
                    startedAt: this.startedAt,
                    endedAt: Date.now(),
                    entryCount: 0,
                });
            }
            await appendEntries(batch);
            await updateSession(this.sessionId, { endedAt: Date.now(), entryCount: this.totalCount });
        } catch (err) {
            // Re-queue the batch so a transient IndexedDB error doesn't lose it.
            this.buffer = batch.concat(this.buffer);
            console.error('[SessionLogger] flush failed', err);
        }
    }

    /** Detach the listener and write out whatever is buffered. */
    async stop(): Promise<void> {
        if (this.flushTimer !== null) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        this.unsubscribe?.();
        this.unsubscribe = null;
        await this.flush();
    }
}
