import { scanEscape } from "../text/ansiEscapes";
import {
    SERVER_WRAP_FLUSH_DELAY_MS,
    SERVER_WRAP_MAX_JOINED_LENGTH,
    SERVER_WRAP_WIDTH_DEFAULT,
    endsAtServerWrapColumn,
    joinWrappedLines,
    looksLikeWrappedProse,
    shouldCommitPendingBeforeJoin,
    visibleText,
} from "../text/serverWrap";

export const DEFAULT_PROMPT_TIMEOUT_MS = 300;

/**
 * Keep prompt-flush timeouts in a sane range. 0 disables the safety net (only
 * a real GA/EOR or the next chunk's newline will flush a partial tail) — handy
 * for tests but risky for GA-less MUDs. The upper bound stops a typo from
 * stalling output for minutes.
 */
export function clampPromptTimeout(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) return DEFAULT_PROMPT_TIMEOUT_MS;
    return Math.min(ms, 5000);
}

export interface LineAssemblerCallbacks {
    /** Deliver assembled whole lines (or a flushed prompt tail) downstream —
     *  the trigger pipeline and rendering treat each chunk as complete lines. */
    onChunk(text: string, ts: number): void;
    /** Fired after a prompt marker (IAC GA/EOR) flushed the held tail — the
     *  owner emits its `prompt` event here. */
    onPrompt(): void;
    /** Fired after an idle-timer flush so the owner can render any messages
     *  the flushed chunk produced (MudClient.flushMessageBuffer). */
    onIdleFlush(): void;
}

export interface LineAssemblerOptions {
    promptTimeoutMs?: number;
    /** Mudlet `Host::mUndoServerWrap` — rejoin lines the game hard-wrapped
     *  itself. Off by default; toggled live via setConfig. */
    undoServerWrap?: boolean;
    /** Mudlet `Host::mUndoServerWrapWidth` — the column the game wraps at. */
    undoServerWrapWidth?: number;
    /** Mudlet `mUSE_IRE_DRIVER_BUGFIX` — strip a spurious leading newline from
     *  GA-driven prompt blocks. Off by default; toggled live via
     *  setFixUnnecessaryLinebreaks (setConfig). */
    fixUnnecessaryLinebreaks?: boolean;
}

/**
 * Assembles the decoded MUD text stream into whole lines. WebSocket frames can
 * split a long line at an arbitrary byte (mid-word, mid-ANSI-escape), so the
 * trailing partial line of each frame is held back until the next frame
 * supplies the rest, a prompt marker (IAC GA/EOR) flushes it, or the idle
 * timer fires. Our render path finalizes every emitted chunk and has no
 * downstream open-line carry (unlike Mudlet's TBuffer), so the "line ends only
 * at \n or GA" invariant is enforced here. The live-partial parity work is
 * deferred — see docs/line-assembly-tbuffer-port.md.
 */
export class LineAssembler {
    /** Trailing text (after the last `\n`) held back from rendering until either
     *  the next frame supplies the rest of the line, a prompt marker arrives, or
     *  the idle-flush timer fires. Prevents spurious line breaks when a long MUD
     *  line is split across multiple WebSocket frames. */
    private pendingLineTail = "";
    private pendingTailTimer: number | null = null;
    private promptTimeoutMs: number;
    /** Set true once the server has sent IAC GA / IAC EOR at least once.
     *  Mirrors Mudlet's `mGA_Driver` latch (`cTelnet::gotRest`). From then on
     *  the held partial tail is flushed by the prompt marker rather than the
     *  idle timer. Note: unlike Mudlet's cTelnet — which posts GA-mode chunks
     *  verbatim and reassembles split lines in TBuffer — we keep buffering
     *  partial lines here, because our render path finalizes every emitted
     *  chunk and has no downstream open-line carry. */
    private _gaDriver = false;
    /** True at the start of a GA-driven data block — i.e. before any content of
     *  the current post-GA transmission has been seen. Drives the
     *  `fixUnnecessaryLinebreaks` leading-newline strip, which fires at most once
     *  per block. Set true on connect and after each prompt flush, cleared once
     *  the block's leading-newline question has been settled. */
    private atPromptBlockStart = true;
    private fixUnnecessaryLinebreaks: boolean;

    // ── server-wrap join (Mudlet TBuffer::append's mUndoServerWrap block) ────
    // A whole line the game may only have *appeared* to end, held back until its
    // continuation arrives to be joined onto it — or until the game goes quiet
    // and the flush timer commits it alone. Held raw (escapes and all): mudix's
    // styling is inline, so concatenation carries each half's colour across.
    private undoServerWrap: boolean;
    private undoServerWrapWidth: number;
    private serverWrapPending: string | null = null;
    /** Visible length of the last *game line* joined into the held text — what
     *  the next word is measured against, not the whole joined paragraph. */
    private serverWrapPendingSegmentLength = 0;
    private serverWrapTimer: number | null = null;
    /** When the held line falls due, so a blocked event loop can still commit it
     *  on demand — see {@link pumpServerWrapDue}. */
    private serverWrapDeadline: number | null = null;

    constructor(
        private readonly callbacks: LineAssemblerCallbacks,
        options: LineAssemblerOptions = {},
    ) {
        this.promptTimeoutMs = clampPromptTimeout(options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS);
        this.fixUnnecessaryLinebreaks = options.fixUnnecessaryLinebreaks ?? false;
        this.undoServerWrap = options.undoServerWrap ?? false;
        this.undoServerWrapWidth = options.undoServerWrapWidth ?? SERVER_WRAP_WIDTH_DEFAULT;
    }

    /** True once the session has latched into GA-driven prompt mode. */
    get gaDriver(): boolean {
        return this._gaDriver;
    }

    setPromptTimeoutMs(ms: number): void {
        this.promptTimeoutMs = clampPromptTimeout(ms);
    }

    getPromptTimeoutMs(): number {
        return this.promptTimeoutMs;
    }

    /** Mudlet `setConfig("fixUnnecessaryLinebreaks", …)`. Takes effect on the
     *  next GA-driven block; never retroactive. */
    setFixUnnecessaryLinebreaks(enabled: boolean): void {
        this.fixUnnecessaryLinebreaks = enabled;
    }

    /** Mudlet `setConfig("undoServerWrap", …)`. Turning it off commits anything
     *  held on the spot rather than stranding it until the next line. */
    setUndoServerWrap(enabled: boolean): void {
        this.undoServerWrap = enabled;
        if (!enabled) this.commitServerWrapPending(Date.now());
    }

    /** Mudlet `setConfig("undoServerWrapWidth", …)`. Applies from the next line;
     *  the held one was already judged against the previous column. */
    setUndoServerWrapWidth(width: number): void {
        this.undoServerWrapWidth = width;
    }

    /** Drop all held state (call on connect and after close). */
    reset(): void {
        this.pendingLineTail = "";
        this._gaDriver = false;
        this.atPromptBlockStart = true;
        this.clearTailTimer();
        this.serverWrapPending = null;
        this.serverWrapPendingSegmentLength = 0;
        this.clearServerWrapTimer();
    }

    /** Feed one frame's decoded text plus whether the frame carried a prompt
     *  marker (IAC GA/EOR). Emits only whole lines (text up to and including
     *  the last `\n`) and holds the trailing partial in `pendingLineTail`
     *  until the rest of the line arrives, a prompt marker flushes it, or the
     *  idle timer fires. */
    feed(decoded: string, hasPrompt: boolean, ts: number): void {
        if (decoded.length > 0) {
            this.clearTailTimer();
            let combined = this.pendingLineTail + decoded;
            // Mudlet's "Fix unnecessary linebreaks on GA servers": at the start
            // of a GA-driven block, drop a single spurious leading newline (the
            // IRE-driver bug). Done at block-start rather than at the GA — like
            // Mudlet's cTelnet::gotPrompt — because our render path emits whole
            // lines eagerly and can't retract them once the GA arrives. The block
            // after a GA begins at the very next byte, so its leading newline is
            // the same one Mudlet would strip from mMudData at the next GA.
            // (Deviation: Mudlet also strips the first block at the first GA via
            // buffering; we can't see that block is GA-driven until the GA lands,
            // so the very first transmission keeps its leading newline.)
            if (this.fixUnnecessaryLinebreaks && this._gaDriver && this.atPromptBlockStart) {
                const { result, decided } = stripLeadingPromptNewline(combined);
                if (decided) {
                    combined = result;
                    this.atPromptBlockStart = false;
                }
            }
            const lastNl = combined.lastIndexOf('\n');
            if (lastNl === -1) {
                this.pendingLineTail = combined;
            } else {
                const ready = combined.substring(0, lastNl + 1);
                this.pendingLineTail = combined.substring(lastNl + 1);
                this.emitServerLines(ready, ts);
            }
        }

        if (hasPrompt) {
            this.flush(ts);
            this._gaDriver = true;
            // The next data block (the next transmission) starts fresh, so its
            // leading newline is again a candidate for the IRE-bug strip above.
            this.atPromptBlockStart = true;
            this.callbacks.onPrompt();
        } else if (this.pendingLineTail.length > 0) {
            this.scheduleTailFlush();
        }
    }

    /** Flush a held-back partial line (text after the final `\n` of a frame).
     *  Triggered by prompt markers (IAC GA/EOR), the idle-flush timer, or
     *  socket close. Pushes the tail through the normal chunk path so triggers
     *  and rendering treat it as a complete line. */
    flush(ts: number, final = false): void {
        this.clearTailTimer();
        if (this.pendingLineTail.length === 0) return;
        let tail = this.pendingLineTail;
        // A prompt tail can end mid-ANSI-escape when the server splits e.g.
        // `…known? \x1b[K` across frames so the bare `\x1b` lands at the end of
        // one chunk. Flushing it now would drop the lone ESC (parseAnsiSegments
        // discards a truncated trailing escape) and then render the `[K` that
        // follows as literal text. So hold the incomplete escape back — like a
        // partial UTF-8 sequence — and let the next frame complete it. On a
        // genuine end-of-stream (`final`, i.e. socket close) there is no "next
        // frame", so flush everything verbatim.
        let held = "";
        if (!final) {
            const cut = incompleteEscapeTailStart(tail);
            if (cut !== -1) {
                held = tail.slice(cut);
                tail = tail.slice(0, cut);
            }
        }
        this.pendingLineTail = held;
        // Nothing renderable before the held escape — keep holding it (don't
        // reschedule: a never-completing escape would spin the timer forever;
        // the next inbound frame recombines it).
        if (tail.length === 0) return;
        // A flushed tail is a prompt, a timer-flushed fragment or the end of the
        // stream — every one of them a real line boundary, so anything held for
        // a wrap continuation was a complete line after all and goes first.
        // (Mudlet reaches the same conclusion from `ch` being '\xff' or '\r'
        // rather than '\n'.) Without this a prompt is swallowed into the
        // full-width line above it.
        this.commitServerWrapPending(ts);
        this.callbacks.onChunk(tail, ts);
    }

    // ── server-wrap join ────────────────────────────────────────────────────

    /**
     * Run the whole lines of one ready chunk through the server-wrap join and
     * emit what comes out. With the option off this is `onChunk(ready)` and
     * nothing else.
     *
     * Mudlet decides this per '\n' inside `TBuffer::append`, gated on the line
     * having come from the server: everything else (prompts, timer-flushed
     * fragments, MXP `<br>`, blank lines) is a real boundary. Here the gate is
     * structural — this is the only path whole server lines take, and
     * feedTriggers/echoes never reach it.
     */
    private emitServerLines(ready: string, ts: number): void {
        if (!this.undoServerWrap) {
            this.callbacks.onChunk(ready, ts);
            return;
        }
        // `ready` always ends in '\n', so the split's last element is the empty
        // string after it rather than a line of its own.
        const lines = ready.split('\n');
        lines.pop();
        let out = '';
        for (const line of lines) out += this.consumeServerLine(line);
        if (out.length > 0) this.callbacks.onChunk(out, ts);
    }

    /**
     * Offer one whole server line to the join. Returns the text to commit —
     * newline-terminated lines, or the empty string when the line was held back
     * for a continuation.
     */
    private consumeServerLine(line: string): string {
        // A blank line is a paragraph break, never a wrap: it ends the held
        // line and stands on its own. (Mudlet: `!mMudLine.isEmpty()`.)
        if (line.length === 0) {
            const pending = this.takeServerWrapPending();
            return pending === null ? '\n' : pending + '\n\n';
        }

        const visible = visibleText(line);
        const proseSegment = looksLikeWrappedProse(visible);
        let committed = '';

        if (this.serverWrapPending !== null) {
            const commitFirst = shouldCommitPendingBeforeJoin(visible, proseSegment, {
                visiblePending: visibleText(this.serverWrapPending),
                heldSegmentLength: this.serverWrapPendingSegmentLength,
                width: this.undoServerWrapWidth,
            });
            if (commitFirst) committed = this.takeServerWrapPending() + '\n';
        }

        // Judged before the held line is joined on, deliberately: ending at the
        // game's wrap column is a property of the segment as the game sent it,
        // not of the longer line it becomes.
        const segmentLooksWrapped = endsAtServerWrapColumn(visible.length, this.undoServerWrapWidth)
            && proseSegment;
        const segmentLength = visible.length;

        const joined = this.serverWrapPending === null
            ? line
            : joinWrappedLines(this.serverWrapPending, line);
        this.serverWrapPending = null;

        if (segmentLooksWrapped && visibleText(joined).length <= SERVER_WRAP_MAX_JOINED_LENGTH) {
            this.serverWrapPending = joined;
            this.serverWrapPendingSegmentLength = segmentLength;
            this.startServerWrapTimer();
            return committed;
        }
        return committed + joined + '\n';
    }

    /** Take the held line, if any, and stop its timer. */
    private takeServerWrapPending(): string | null {
        if (this.serverWrapPending === null) return null;
        const pending = this.serverWrapPending;
        this.serverWrapPending = null;
        this.serverWrapPendingSegmentLength = 0;
        this.clearServerWrapTimer();
        return pending;
    }

    /** Commit the held line on its own, as its own chunk. */
    private commitServerWrapPending(ts: number): boolean {
        const pending = this.takeServerWrapPending();
        if (pending === null) return false;
        this.callbacks.onChunk(pending + '\n', ts);
        return true;
    }

    /**
     * Commit a held line whose flush delay has elapsed. The timer below cannot
     * be relied on alone: a busted run is one synchronous call sitting on top of
     * the event loop, so no `setTimeout` of ours can fire until it returns. The
     * spec's `pumpEvents` reaches this instead, exactly as it reaches the Lua
     * timer queue and the replay player. Returns true when a line was committed.
     */
    pumpServerWrapDue(now: number = Date.now()): boolean {
        if (this.serverWrapDeadline === null || now < this.serverWrapDeadline) return false;
        if (!this.commitServerWrapPending(now)) return false;
        // Same tail as the timer's own callback: the committed line is only in
        // the message buffer until someone flushes it, and no inbound frame is
        // coming to do that — the game going quiet is the whole premise.
        this.callbacks.onIdleFlush();
        return true;
    }

    private startServerWrapTimer(): void {
        this.clearServerWrapTimer();
        this.serverWrapDeadline = Date.now() + SERVER_WRAP_FLUSH_DELAY_MS;
        this.serverWrapTimer = window.setTimeout(() => {
            this.serverWrapTimer = null;
            this.serverWrapDeadline = null;
            if (this.commitServerWrapPending(Date.now())) this.callbacks.onIdleFlush();
        }, SERVER_WRAP_FLUSH_DELAY_MS);
    }

    private clearServerWrapTimer(): void {
        if (this.serverWrapTimer !== null) {
            clearTimeout(this.serverWrapTimer);
            this.serverWrapTimer = null;
        }
        this.serverWrapDeadline = null;
    }

    private scheduleTailFlush(): void {
        if (this.pendingTailTimer !== null) return;
        this.pendingTailTimer = window.setTimeout(() => {
            this.pendingTailTimer = null;
            if (this.pendingLineTail.length === 0) return;
            this.flush(Date.now());
            this.callbacks.onIdleFlush();
        }, this.promptTimeoutMs);
    }

    private clearTailTimer(): void {
        if (this.pendingTailTimer !== null) {
            clearTimeout(this.pendingTailTimer);
            this.pendingTailTimer = null;
        }
    }
}

/**
 * Mudlet's "Fix unnecessary linebreaks on GA servers" core, ported from
 * `cTelnet::gotPrompt` (gated there on `mUSE_IRE_DRIVER_BUGFIX && mGA_Driver`).
 * IRE-style servers prepend a spurious <LF> to each GA-terminated transmission,
 * which renders as a blank line before every prompt block. This removes a single
 * leading newline from the front of a GA-driven block — first skipping any
 * leading ANSI SGR escape sequence, exactly as Mudlet does (`if (mMudData[j] ==
 * 0x1B) … scan to 'm'`).
 *
 * Returns the (possibly trimmed) string and `decided`:
 *  - `decided: true`  — the leading-newline question is settled for this block
 *    (a newline was removed, or the first real byte wasn't a newline).
 *  - `decided: false` — so far the block is *only* ANSI escapes, or ends inside
 *    an incomplete escape (no terminating 'm' yet). The caller should keep the
 *    block-start flag set and retry once more bytes arrive. (Mudlet never hits
 *    this case — it has the whole block in hand at GA time — but we decide
 *    incrementally as frames stream in.)
 */
function stripLeadingPromptNewline(s: string): { result: string; decided: boolean } {
    let i = 0;
    while (i < s.length) {
        if (s.charCodeAt(i) === 0x1b) {
            // Skip an ANSI escape up to and including its 'm' (SGR) terminator.
            let j = i + 1;
            while (j < s.length && s[j] !== 'm') j++;
            if (j >= s.length) return { result: s, decided: false }; // incomplete — wait
            i = j + 1;
            continue;
        }
        // First non-escape byte reached: strip it iff it's the spurious newline.
        if (s[i] === '\n') return { result: s.slice(0, i) + s.slice(i + 1), decided: true };
        return { result: s, decided: true };
    }
    // Ran off the end with only complete ANSI escapes — no content byte yet.
    return { result: s, decided: false };
}

/**
 * If `s` ends with an ANSI/ECMA-48 escape sequence that runs off the end of the
 * string (a bare trailing `\x1b`, or `\x1b[` / `\x1b]…` with no final byte yet),
 * return the index where that incomplete escape begins; otherwise -1. Used to
 * keep a partial escape attached to the start of the next frame instead of
 * flushing it split — which would drop the lone ESC and leak the completion
 * (e.g. `[K`) as literal text. A complete trailing escape returns -1 (nothing to
 * hold). Only the *last* escape can be incomplete, so checking it suffices.
 */
function incompleteEscapeTailStart(s: string): number {
    const esc = s.lastIndexOf("\x1b");
    if (esc === -1) return -1;
    return scanEscape(s, esc).kind === "incomplete" ? esc : -1;
}
