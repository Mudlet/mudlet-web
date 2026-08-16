import { FormatState } from './FormatState';
import { AnsiAwareBuffer } from './FormatState';
import type { FormatStateSnapshot } from './FormatState';

/**
 * Self-contained text output entity — equivalent of Mudlet's TConsole.
 * Owns format state, line history, and cursor position.
 * The renderer is a pure consumer: it receives lines via takeLines() and
 * calls buf.notifyRender() so that rerender()/removeFromDom() can reach the DOM.
 */
export class Console {
    readonly format = new FormatState();

    private history: AnsiAwareBuffer[] = [];
    private pending:  AnsiAwareBuffer[] = [];
    private partial = new AnsiAwareBuffer();
    private cursorIdx = -1; // -1 = always resolve to last line
    // Persistent column position on the rendered-history cursor line. Tracked
    // independently of the active trigger lineBuffer (ScriptingAPI owns that).
    // moveUp/moveDown reset to 0 unless keepHorizontal is set; moveCursor/
    // moveTo set it explicitly. getCursorColumn clamps lazily to the current
    // line's length, so moves into shorter lines silently snap to end.
    private cursorCol = 0;
    private _maxLines = 1000;
    // Mudlet's setConsoleBufferSize takes a "size of batch deletion" — how many
    // lines it drops at once when the cap is exceeded. mudix evicts lazily down
    // to _maxLines (the observable cap is identical), but we round-trip the
    // value so getConsoleBufferSize reports back what a script set.
    // Mudlet's own default is a tenth of the line limit, which is also the
    // value setConsoleBufferSize clamps an over-large batch down to — so a
    // script that reads the default back and writes it again gets the same
    // number, rather than watching it change under it.
    private _batchDeleteSize = 100;
    /** Mudlet `sysBufferShrinkEvent(name, linesRemoved)` hook. Fired by
     *  `evict()` whenever the scrollback cap drops one or more lines from the
     *  head of `history`. Set by the owning session (ScriptingAPI for "main",
     *  WindowManager for named user windows). */
    onBufferShrink: ((linesRemoved: number) => void) | undefined;
    // Mudlet's TConsole treats `\n` as cursor advance — `moveCursorEnd` followed
    // by `echo("\n")` advances past the last line without producing a blank row.
    // Mudix completes the (empty) partial on `\n` and emits a blank message.
    // Set after moveCursorEnd to consume one leading `\n` as cursor-advance.
    private consumeLeadingNewline = false;

    // ── Format state ──────────────────────────────────────────────────────────

    setFgColor(r: number, g: number, b: number): void {
        this.format.foreground = { space: 'rgb', r, g, b };
    }

    setBgColor(r: number, g: number, b: number, a?: number): void {
        this.format.background = a !== undefined && a < 255
            ? { space: 'rgb', r, g, b, a }
            : { space: 'rgb', r, g, b };
    }

    setBold(v: boolean):          void { this.format.bold          = v || undefined; }
    setItalic(v: boolean):        void { this.format.italic        = v || undefined; }
    setUnderline(v: boolean):     void { this.format.underline     = v || undefined; }
    setStrikethrough(v: boolean): void { this.format.strikethrough = v || undefined; }
    setOverline(v: boolean):      void { this.format.overline      = v || undefined; }
    setReverse(v: boolean):       void { this.format.inverse       = v || undefined; }

    resetFormat(): void { this.format.reset(); }

    get maxLines(): number { return this._maxLines; }
    setMaxLines(n: number): void { this._maxLines = n; this.evict(); }

    get batchDeleteSize(): number { return this._batchDeleteSize; }
    setBatchDeleteSize(n: number): void { this._batchDeleteSize = n; }

    // ── Output ────────────────────────────────────────────────────────────────

    echo(text: string): void {
        if (this.consumeLeadingNewline) {
            this.consumeLeadingNewline = false;
            if (text.startsWith('\n') && this.partial.text.length === 0) {
                text = text.slice(1);
                if (text.length === 0) return;
            }
        }
        this.partial.appendBuffer(new AnsiAwareBuffer(text, this.format.toSnapshot()));

        if (!this.partial.text.includes('\n')) return;
        this.promotePartialLines();
    }

    /**
     * Move every newline-terminated line out of the in-flight `partial` and
     * into history, leaving whatever follows the last newline as the new
     * partial. Shared by `echo` and by `insertText`, which can put a newline
     * into the line being built just as an echo can.
     */
    private promotePartialLines(): void {
        const splits = this.partial.splitLines();
        const endsWithNewline = this.partial.text.endsWith('\n');
        const completeCount = endsWithNewline ? splits.length : splits.length - 1;

        for (let i = 0; i < completeCount; i++) {
            this.history.push(splits[i]);
            this.pending.push(splits[i]);
        }

        this.partial = endsWithNewline ? new AnsiAwareBuffer() : splits[splits.length - 1];
        this.evict();
    }

    /**
     * Append a pre-built complete line buffer to history. Used by the network
     * trigger pipeline: the line has already been parsed and is being added as
     * a single canonical entry, not via partial accumulation. The cursor is
     * placed on the new line at column 0 so triggers see Mudlet's "cursor on
     * the matching line at trigger fire" state. Does NOT enqueue into pending
     * — the renderer for network output drains via the 'message' event
     * pipeline; pending is reserved for script-driven echo flushes.
     */
    appendLine(buffer: AnsiAwareBuffer): void {
        this.history.push(buffer);
        this.cursorIdx = this.history.length - 1;
        this.cursorCol = 0;
        this.evict();
    }

    /**
     * Append a pre-formatted buffer as a new complete line — mirrors Mudlet's
     * TConsole::appendBuffer, the primitive behind the `appendBuffer`/`paste`
     * clipboard functions. Unlike `appendLine` (network pipeline) this also
     * enqueues into `pending` so the line reaches the renderer through the
     * normal drain path; the cursor resets to the end so a following
     * `selectCurrentLine` sees the pasted line.
     */
    appendBuffer(buffer: AnsiAwareBuffer): void {
        this.history.push(buffer);
        this.pending.push(buffer);
        this.cursorIdx = -1;
        this.cursorCol = 0;
        this.evict();
    }

    private evict(): void {
        let removed = 0;
        while (this.history.length > this._maxLines) {
            const evicted = this.history.shift()!;
            evicted.removeFromDom();
            if (this.cursorIdx > 0) this.cursorIdx--;
            removed++;
        }
        if (removed > 0) this.onBufferShrink?.(removed);
    }

    /** Drain newly completed lines to hand to the renderer. */
    takeLines(): AnsiAwareBuffer[] {
        const out = this.pending;
        this.pending = [];
        return out;
    }

    get currentPartial(): AnsiAwareBuffer { return this.partial; }

    /**
     * Promote the in-flight partial (an echo without a trailing newline, e.g.
     * a trigger's `cecho("\n text")`) into a finished history line and return
     * it, leaving a fresh empty partial behind. Returns null when nothing is
     * pending. Unlike `clear()`, the existing history is preserved so
     * line-number / selectString lookups for later lines in the same flush
     * batch stay valid — this is what lets a per-line trigger-echo flush place
     * the echoed line right after the line it was echoed on. The line is NOT
     * enqueued into `pending` (the caller emits it explicitly), so a following
     * `takeLines()` won't re-emit it.
     */
    completePartialLine(): AnsiAwareBuffer | null {
        if (this.partial.length === 0) return null;
        const buf = this.partial;
        this.history.push(buf);
        this.partial = new AnsiAwareBuffer();
        this.cursorIdx = -1;
        this.cursorCol = 0;
        this.evict();
        return buf;
    }

    clear(): void {
        this.history = [];
        this.pending = [];
        this.partial = new AnsiAwareBuffer();
        this.cursorIdx = -1;
        this.cursorCol = 0;
        this.consumeLeadingNewline = false;
    }

    /**
     * Discard only the in-flight partial (and the leading-newline latch),
     * leaving history/cursor untouched. `feedTriggers` uses this to drop a
     * stray partial left by a prior direct `echo()` without wiping accumulated
     * history — multiple `feedTriggers` calls must accumulate lines (Mudlet
     * appends fed text to the buffer), which a full `clear()` would destroy.
     */
    clearPartial(): void {
        this.partial = new AnsiAwareBuffer();
        this.consumeLeadingNewline = false;
    }

    // ── Cursor ────────────────────────────────────────────────────────────────

    private get cursor(): number {
        if (this.history.length === 0) return -1;
        if (this.cursorIdx < 0 || this.cursorIdx >= this.history.length) {
            return this.history.length - 1;
        }
        return this.cursorIdx;
    }

    // True when the cursor is "following the end" (never moved into history via
    // moveCursor/appendLine). In that state the line being built — the in-flight
    // `partial` from an echo without a trailing newline — IS the current line
    // (Mudlet's model), so getLine/getBuffer expose it. When the cursor has been
    // parked on a history line (moveCursor, or the matched line during trigger
    // processing) that history line is the current one and the partial is ignored.
    private get followingEnd(): boolean {
        return this.cursorIdx < 0 || this.cursorIdx >= this.history.length;
    }

    /**
     * Whether the line under the cursor is the in-flight `partial` — an echo
     * that hasn't seen its newline yet — rather than a finished history line.
     *
     * The distinction matters to every cursor-line operation, not just the
     * readers: Mudlet's cursor sits on the line being built, so `insertText`,
     * `replace` and friends have to reach it there. Reading it but not writing
     * it made `prefix()`/`suffix()` on an unfinished line silent no-ops.
     */
    private get onPartialLine(): boolean {
        return this.followingEnd && this.partial.length > 0;
    }

    getLine(): string {
        return this.currentBuffer()?.text ?? '';
    }
    getBuffer(): AnsiAwareBuffer | null {
        return this.currentBuffer();
    }

    /** The buffer the cursor is on: the partial when it is following the end,
     *  otherwise the history line it was parked on. */
    private currentBuffer(): AnsiAwareBuffer | null {
        if (this.onPartialLine) return this.partial;
        return this.history[this.cursor] ?? null;
    }

    /** Per-line prompt flag on the current cursor line. Mirrors Mudlet's TBuffer
     *  behaviour: `isPrompt()` follows the cursor, so moveCursor + isPrompt can
     *  inspect any historical line's prompt status, not just the most recent. */
    cursorOnPrompt(): boolean { return this.history[this.cursor]?.isPrompt ?? false; }

    deleteLine(): void {
        const idx = this.cursor;
        const buf = this.history[idx];
        if (!buf) return;
        buf.removeFromDom();
        this.history.splice(idx, 1);
        // Keep the cursor at the same row index (Mudlet: deleteLine leaves the
        // cursor on the line that shifts up into the slot). When the deleted line
        // was the last one, idx now equals history.length — a "past-end" cursor
        // one slot beyond the final line, which getLineNumber() reports verbatim.
        // Mudlet's moveCursorUp is getLineNumber()-based (move to curLine - 1), so
        // the past-end value lets the next moveCursorUp land on the new last line
        // rather than skipping it — what makes deleteMultiline walk every line.
        // Reads of line *content* still clamp to the last line via `cursor`.
        // Previously this clamped to length-1, dropping a line from the range.
        this.cursorIdx = idx;
    }

    /**
     * Insert `text` at the cursor (Mudlet `insertText`). Embedded `\n` split the
     * current line into multiple history lines (Mudlet issue #8945): the text up
     * to the first `\n` is inserted at the cursor column, each subsequent `\n`
     * starts a new line, and the remainder of the original line trails the last
     * inserted segment. For a single-line insert the cursor stays at the
     * insertion point (Mudlet's `insertText` does not advance `mUserCursor` — the
     * bundled GUIUtils `xEcho`/`cinsertText` loop advances it explicitly with its
     * own `moveCursor` after each segment; advancing here too would double-count
     * and push later color segments past their intended column). Returns false
     * when there's no current line to insert into (caller falls back to an echo).
     * Mid-buffer multi-line inserts update the buffer model fully; the
     * incremental renderer redraws the affected line(s) lazily.
     */
    insertText(text: string, state?: FormatStateSnapshot): boolean {
        const idx = this.cursor;
        const onPartial = this.onPartialLine;
        const cur = this.currentBuffer();
        if (!cur) return false;
        const col = Math.max(0, Math.min(this.getCursorColumn(), cur.length));
        cur.insert(col, text, state);
        if (!text.includes('\n')) {
            this.cursorCol = col;
            return true;
        }
        // Inserting into the line still being built: the newline finishes it, so
        // the completed part moves into history and the tail stays partial —
        // the same promotion `echo` does, and the only way the split can leave
        // both the buffer and the renderer consistent.
        if (onPartial) {
            this.promotePartialLines();
            return true;
        }
        // The current line now carries embedded newlines — split it into separate
        // history entries so getLineCount/getCurrentLine reflect the new lines.
        const lines = cur.splitLines();
        cur.removeFromDom();
        this.history.splice(idx, 1, ...lines);
        const segs = text.split('\n');
        this.cursorIdx = Math.min(idx + segs.length - 1, this.history.length - 1);
        this.cursorCol = segs[segs.length - 1].length;
        this.evict();
        return true;
    }

    /**
     * Move the cursor up `lines` rows. When `keepHorizontal` is false (the
     * default, matching Mudlet) the column resets to 0; when true the column
     * is preserved across the move and lazily clamps to the destination
     * line's length on read via `getCursorColumn`.
     */
    moveUp(lines: number = 1, keepHorizontal: boolean = false): boolean {
        const idx = this.cursor;
        if (idx <= 0) return false;
        const target = Math.max(0, idx - Math.max(1, Math.trunc(lines)));
        this.cursorIdx = target;
        if (!keepHorizontal) this.cursorCol = 0;
        return target !== idx;
    }

    moveDown(lines: number = 1, keepHorizontal: boolean = false): boolean {
        const idx = this.cursor;
        const last = this.history.length - 1;
        if (idx >= last) return false;
        const target = Math.min(last, idx + Math.max(1, Math.trunc(lines)));
        this.cursorIdx = target;
        if (!keepHorizontal) this.cursorCol = 0;
        return target !== idx;
    }

    /**
     * Seek the cursor to absolute line `line` (0-indexed). When `col` is
     * supplied, also set the column; otherwise the column is reset to 0 (the
     * Mudlet `moveCursor(x=0, y)` default).
     */
    moveTo(line: number, col: number = 0): boolean {
        if (!Number.isFinite(line) || line < 0) return false;
        if (!Number.isFinite(col) || col < 0) return false;
        // A line past the end of the buffer is refused outright rather than
        // clamped — Mudlet's TBuffer::moveCursor returns false for it, and a
        // script that asks for a line that isn't there wants to hear so.
        //
        // The bound is `history.length`, not `length - 1`: Mudlet's buffer
        // always keeps one open line past the last complete one (the line being
        // built), `getLastLineNumber` counts it, and it is a line to move onto
        // whether or not anything has been echoed into it yet. Refusing it left
        // moveCursorDown unable to reach the last line and prefix()/suffix()
        // unable to sit on an unfinished one. Parking there is "following the
        // end", which is exactly what `partial` is — and the index is kept
        // verbatim (as moveToEnd does) so getLineNumber reports the open line
        // rather than clamping back onto the last complete one.
        if (Math.trunc(line) > this.history.length) return false;
        this.cursorIdx = Math.trunc(line);
        this.cursorCol = Math.trunc(col);
        return true;
    }

    /**
     * Mudlet's `mUserCursor.x()` — the column on the cursor line. Lazily
     * clamped to the current line's length so a stale `cursorCol` from a
     * `keepHorizontal` move never reports past the end of a shorter line.
     */
    getCursorColumn(): number {
        if (this.onPartialLine) return Math.min(this.cursorCol, this.partial.text.length);
        const idx = this.cursor;
        if (idx < 0) return 0;
        const lineLen = this.history[idx]?.text.length ?? 0;
        return Math.min(this.cursorCol, lineLen);
    }

    /**
     * The column as it was set, unclamped. Mudlet keeps `mUserCursor.x()` raw
     * and only the operations that write through it decide what a column past
     * the end of the line means — `paste` pads out to it, which the clamped
     * reading above cannot express.
     */
    getCursorColumnRaw(): number {
        return this.cursorCol;
    }

    setCursorColumn(col: number): boolean {
        if (!Number.isFinite(col) || col < 0) return false;
        this.cursorCol = Math.trunc(col);
        return true;
    }

    /** Mark cursor as positioned at the end of existing rendered content, so the
     *  next leading `\n` is treated as cursor advance rather than a blank line.
     *  Pass `false` to clear the latch (e.g. when leaving trigger processing) so
     *  it can't leak onto an unrelated later echo. */
    markCursorAtEnd(value: boolean = true): void {
        this.consumeLeadingNewline = value;
    }

    // Mudlet's TConsole returns 0-indexed cursor.y() for getLineNumber and
    // (size - 1) for getLineCount/getLastLineNumber. An empty buffer reports
    // line index -1 to match Mudlet's "no current line" sentinel.
    getLineNumber(): number {
        const len = this.history.length;
        // The line being built is a real line to be on, and it sits after the
        // finished ones — reporting -1 for it told prefix()/suffix() there was
        // no current line to move to. An empty buffer with nothing echoed into
        // that line yet still has Mudlet's "no current line" sentinel.
        if (len === 0) return this.partial.length > 0 ? 0 : -1;
        if (this.onPartialLine) return len;
        // Following-end (cursorIdx < 0, after output/echo) reports as the last
        // line. An in-range or past-end cursorIdx is reported verbatim: after
        // deleteLine removes the last line the cursor sits one slot past the end
        // (cursorIdx === len), and Mudlet's getLineNumber()-driven moveCursorUp
        // relies on seeing that past-end value to step onto the new last line.
        if (this.cursorIdx < 0) return len - 1;
        return this.cursorIdx;
    }
    getLineCount(): number  { return this.history.length - 1; }

    /**
     * Mudlet `moveCursorEnd` — park the cursor on the empty line past the last
     * complete one, which is where Mudlet's buffer always keeps its "current"
     * entry (so `getLineNumber() == getLineCount()` right after). That slot is
     * one past `history`, which {@link moveTo} deliberately refuses, so it is
     * set here rather than routed through it.
     */
    moveToEnd(): void {
        this.cursorIdx = this.history.length;
        this.cursorCol = 0;
    }

    /**
     * Mudlet `getLines(from, to)` — the lines starting at the 0-based index
     * `from`, `abs(to - from)` of them (TConsole::getLines). Note that `to` is
     * exclusive and that neither bound is clamped by Mudlet; out-of-range
     * indices simply yield fewer lines here.
     */
    getLines(from: number, to: number): string[] {
        const start = Math.max(0, Math.trunc(from));
        const count = Math.abs(Math.trunc(to) - Math.trunc(from));
        return this.history.slice(start, start + count).map(b => b.text);
    }

    /**
     * Mudlet `getTimestamp(lineNumber)` — the wall-clock time (epoch ms) the
     * line entered the buffer. `lineNumber` is 1-based to match `getLines`
     * (Mudlet's timeBuffer reserves index 0); omit it to read the current
     * cursor line. Returns null when the line is out of range or the buffer
     * is empty. Formatting into Mudlet's "hh:mm:ss.zzz" string happens one
     * layer up, in ScriptingAPI.
     */
    getLineTimestamp(lineNumber?: number): number | null {
        const idx = lineNumber === undefined ? this.cursor : Math.trunc(lineNumber) - 1;
        if (idx < 0) return null;
        return this.history[idx]?.timestamp ?? null;
    }

    /**
     * Mudlet `wrapLine(lineNumber)` — re-display the line at `lineNumber`
     * (0-indexed, matching getLineNumber/getLineCount), re-interpreting its
     * embedded `\n` characters and re-wrapping to the current width. mudix
     * renders each line buffer with CSS `white-space: pre-wrap`, and the
     * rendered DOM node holds the very same buffer object as history (set via
     * `notifyRender`), so re-rendering that buffer in place is what makes any
     * `\n` show as line breaks — the documented use case after a `deleteLine()`
     * + `echo()` sequence left un-displayed newlines in the buffer. Returns
     * false when `lineNumber` is out of range.
     */
    /**
     * Mudlet `wrapLine(lineNumber)` — re-wrap one stored line to the console's
     * current wrap width, replacing it with as many buffer lines as it now
     * needs. That is a real buffer edit in Mudlet (TBuffer::wrapLine splits the
     * line in place), not a repaint: getLineCount and getLines see the split
     * afterwards.
     *
     * `wrapAt` of 0 (wrapping disabled) leaves the line alone and just
     * repaints. `indent` prefixes the first resulting line and `hangingIndent`
     * every continuation, matching setWindowWrapIndent /
     * setWindowWrapHangingIndent.
     */
    wrapLine(lineNumber: number, wrapAt = 0, indent = 0, hangingIndent = 0): boolean {
        if (!Number.isFinite(lineNumber)) return false;
        const idx = Math.trunc(lineNumber);
        const buf = this.history[idx];
        if (!buf) return false;
        const width = Math.trunc(wrapAt);
        if (!(width > 0)) { buf.rerender(); return true; }

        // Break positions on the ORIGINAL text; the indents shrink the usable
        // width but aren't inserted until afterwards, so they're accounted for
        // here rather than by re-measuring after each edit.
        const text = buf.text;
        const breaks: number[] = [];
        let lineStart = 0;
        let usable = Math.max(1, width - Math.max(0, indent));
        while (text.length - lineStart > usable) {
            const limit = lineStart + usable;
            // Prefer a word boundary, but never break before the line even
            // starts — a single word longer than the width is split hard.
            const space = text.lastIndexOf(' ', limit);
            const at = space > lineStart ? space : limit;
            breaks.push(at);
            lineStart = text[at] === ' ' ? at + 1 : at;
            usable = Math.max(1, width - Math.max(0, hangingIndent));
        }
        if (breaks.length === 0 && indent <= 0) { buf.rerender(); return true; }

        // Applied back-to-front so each insertion leaves the earlier offsets
        // valid. A break on a space keeps the space at the end of its line
        // (Mudlet trims at the break; rejoining normalises it away either way).
        const hang = hangingIndent > 0 ? ' '.repeat(hangingIndent) : '';
        for (let i = breaks.length - 1; i >= 0; i--) {
            const at = breaks[i];
            buf.insert(text[at] === ' ' ? at + 1 : at, `\n${hang}`);
        }
        if (indent > 0) buf.insert(0, ' '.repeat(indent));

        const lines = buf.splitLines();
        buf.removeFromDom();
        this.history.splice(idx, 1, ...lines);
        // The cursor tracked a line index that may have moved down.
        if (this.cursorIdx > idx) this.cursorIdx += lines.length - 1;
        return true;
    }
}
