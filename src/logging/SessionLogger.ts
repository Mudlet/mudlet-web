import type { MudSession } from '../mud/MudSession';
import { AnsiAwareBuffer } from '../mud/text/FormatState';
import { appendEntries, createSession, updateSession, type LogEntry } from '../storage/logStorage';

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
     * Mudlet's `startLogging(true)` — begin mirroring output to a plain-text
     * file as well. Deliberately separate from {@link start}: recording to the
     * log browser is a mudix profile setting that is on by default, whereas
     * Mudlet's file log is something a player or script asks for. Sharing one
     * switch would have every profile quietly writing a text file nobody asked
     * for, and would make `startLogging(true)` report "already on" forever.
     *
     * The file is created up front, before any line has arrived, so a script can
     * hand its path straight to something else. Named as Mudlet names its own:
     * `<profile>/log/<yyyy-MM-dd#hh-mm-ss>.txt`.
     */
    startFileLog(): string | null {
        if (this.logFilePath) return this.logFilePath;
        this.openLogFile();
        return this.logFilePath;
    }

    /** Stop mirroring to the text file, writing out whatever is buffered. */
    stopFileLog(): void {
        this.flushLogFile();
        this.logFilePath = null;
    }

    private openLogFile(): void {
        if (!this.vfs) return;
        const d = new Date(this.startedAt);
        const p = (n: number, w = 2) => String(n).padStart(w, '0');
        const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
            + `#${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
        const path = `${this.vfs.profilePath}/log/${stamp}.txt`;
        try {
            this.vfs.mkdir(`${this.vfs.profilePath}/log`);
            // Only create it — never blank one that is already there. The name
            // carries the second this logger was built, so stopping and
            // restarting logging inside one session comes back to the same file,
            // and truncating it would throw away everything the first stretch
            // had written. Mudlet reopens for append.
            if (!this.vfs.exists(path)) this.vfs.writeFile(path, '');
            this.logFilePath = path;
        } catch (err) {
            console.warn('[SessionLogger] could not open the log file', err);
            this.logFilePath = null;
        }
    }

    /** Append the buffered plain-text lines to the log file. ZenFS has no
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
        if (this.logFilePath) this.fileBuffer.push(buffer.text + '\n');
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
