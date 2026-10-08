import { AnsiAwareBuffer } from "../../mud/text/FormatState";
import { installLinkNavigation } from "./linkNavigation";
import {
    appendRow, clearRows, detachRow, lastRow, lastRows, nextRow, previousRow, rowAt, rowCount, rowIndex,
} from "./outputRows";

// Buffers are stored keyed by their wrapper element. The WeakMap means the
// AnsiAwareBuffer is garbage-collected automatically when its element is removed
// from the DOM and no longer referenced elsewhere.  Exported so other renderers
// (WindowManager text panels) can attach buffers to their own line elements.
export const elementBuffers = new WeakMap<Element, AnsiAwareBuffer>();

type MessageListener = (message?: string | AnsiAwareBuffer, type?: string, timestamp?: number, isPrompt?: boolean) => void;
export type MessageSource = {
    on(event: 'message', listener: MessageListener): () => void;
    on(event: 'script.deleteline', listener: () => void): () => void;
    on(event: 'script.clearwindow', listener: () => void): () => void;
    on(event: 'script.movecursorup', listener: () => void): () => void;
    on(event: 'script.movecursordown', listener: () => void): () => void;
};

export type CursorOps = {
    /** Plain text of the line at the current cursor position. */
    getLine: () => string;
    /** AnsiAwareBuffer of the line at the current cursor position, for in-place coloring. */
    getBuffer: () => AnsiAwareBuffer | null;
    /** Remove the line at the current cursor position. */
    deleteLine: () => void;
    /** Move the cursor one line toward older output. */
    moveUp: () => void;
    /** Move the cursor one line toward newer output. */
    moveDown: () => void;
    /** Move the cursor to an absolute line number (1 = oldest, getLineCount() = newest). */
    moveTo: (line: number) => void;
    /** 1-indexed line number of the cursor from the top of the buffer. */
    getLineNumber: () => number;
    /** Total number of lines currently in the output buffer. */
    getLineCount: () => number;
    /** Plain text of lines [from..to] (1-indexed, inclusive) as a JS string array. */
    getLines: (from: number, to: number) => string[];
};

/**
 * Creates cursor ops for a plain line container (text/miniconsole windows).
 * The container holds `div` line elements appended via appendChild — no sentinel.
 * Returns the ops plus an `onLineAppended` callback that must be called each
 * time a new line element is added, so the cursor resets to the latest line.
 */
export function createWindowCursorOps(container: HTMLElement): {
    ops: CursorOps;
    onLineAppended: (el: Element) => void;
} {
    let cursorEl: Element | null = null;
    let deletedPrev: Element | null = null;

    function resolve(): Element | null {
        return cursorEl ?? container.lastElementChild;
    }

    const ops: CursorOps = {
        getLine(): string {
            const el = resolve();
            return el ? (elementBuffers.get(el)?.text ?? '') : '';
        },

        getBuffer(): AnsiAwareBuffer | null {
            const el = resolve();
            return el ? (elementBuffers.get(el) ?? null) : null;
        },

        deleteLine(): void {
            const el = resolve();
            if (!el) return;
            deletedPrev = el.previousElementSibling;
            container.removeChild(el);
            cursorEl = null;
        },

        moveUp(): void {
            if (cursorEl === null) {
                if (deletedPrev !== null) {
                    cursorEl = deletedPrev;
                    deletedPrev = null;
                } else {
                    cursorEl = container.lastElementChild?.previousElementSibling ?? null;
                }
            } else {
                cursorEl = cursorEl.previousElementSibling;
            }
        },

        moveDown(): void {
            const current = resolve();
            if (!current) return;
            cursorEl = current.nextElementSibling;
            deletedPrev = null;
        },

        moveTo(line: number): void {
            const el = container.children[line - 1];
            if (el) { cursorEl = el; deletedPrev = null; }
        },

        getLineNumber(): number {
            const el = resolve();
            if (!el) return 0;
            const children = container.children;
            for (let i = 0; i < children.length; i++) {
                if (children[i] === el) return i + 1;
            }
            return 0;
        },

        getLineCount(): number {
            return container.childElementCount;
        },

        getLines(from: number, to: number): string[] {
            const result: string[] = [];
            const children = container.children;
            for (let i = from - 1; i < to && i < children.length; i++) {
                result.push(elementBuffers.get(children[i])?.text ?? '');
            }
            return result;
        },
    };

    return {
        ops,
        onLineAppended(el: Element): void {
            cursorEl = el;
            deletedPrev = null;
        },
    };
}

type OutputHandlerOptions = {
    outputWrapper: HTMLElement;
    sentinel: HTMLElement;
    stickyArea: HTMLElement;
    isSplitView: () => boolean;
    stickyLines: number;
    suppressSplitView?: (durationMs: number) => void;
    /** Whether new output should scroll the view to the tail. True for a
     *  scrollback; false for a console the writer rewrites wholesale — an MXP
     *  frame written with `<DEST … EOF>` — where following the tail makes the
     *  content slide as a multi-flush redraw lands. Read live on every write, so
     *  a console can become top-anchored after it is already mounted. */
    followTail?: () => boolean;
    /** Called once the cursor ops are ready; wire them to ScriptingAPI/session. */
    onCursorReady?: (ops: CursorOps) => void;
};

export type OutputRendererControls = {
    teardown: () => void;
    areTimestampsVisible: () => boolean;
    setTimestampVisibility: (visible: boolean) => void;
    toggleTimestampVisibility: () => void;
    populateStickyArea: () => void;
    clearStickyArea: () => void;
    push: (message: string | AnsiAwareBuffer, type?: string, timestamp?: number) => void;
    clear: () => void;
    /** True while a tail scroll is queued for the next frame — lines have
     *  landed that the view is about to follow. A scroll event seen in that
     *  window measures the view against content it has not caught up with
     *  yet, so it is not the reader scrolling away (#456). */
    isTailScrollQueued: () => boolean;
};

const TIMESTAMP_CLASS = 'output-show-timestamps';

function formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    const milliseconds = date.getMilliseconds().toString().padStart(3, '0');
    return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function createTimestampElement(timestamp: number): HTMLSpanElement {
    const timestampEl = document.createElement('span');
    timestampEl.classList.add('output-timestamp');
    timestampEl.textContent = formatTimestamp(timestamp);
    timestampEl.dataset.timestamp = `${timestamp}`;
    timestampEl.title = new Date(timestamp).toLocaleString();
    return timestampEl;
}

/**
 * `registerRender` false builds the row without claiming the buffer's render
 * registration. The split-view sticky area renders the *same* buffer a second
 * time; letting that copy register would point `rerender()`/`removeFromDom()`
 * at the sticky row, so eviction would strip the wrong copy and leave the
 * scrollback one behind.
 */
function createMessageWrapper(
    message: string | AnsiAwareBuffer,
    type: string | undefined,
    timestamp: number,
    registerRender: boolean = true
): HTMLDivElement {
    const wrapper = document.createElement('div');
    wrapper.classList.add('output-msg');
    if (type) {
        wrapper.classList.add(type);
    }

    const messageDiv = document.createElement('div');
    messageDiv.classList.add('output-msg-text');
    wrapper.dataset.timestamp = `${timestamp}`;

    const timestampEl = createTimestampElement(timestamp);
    const contentSpan = document.createElement('span');
    contentSpan.classList.add('output-msg-content');

    const buffer = typeof message === 'string' ? new AnsiAwareBuffer(message) : message;

    // Attach the buffer to the element so it can be retrieved via the cursor.
    elementBuffers.set(wrapper, buffer);

    if (buffer.length === 0) {
        contentSpan.innerHTML = '&nbsp;';
    } else {
        contentSpan.appendChild(buffer.toDom());
    }
    // Registered unconditionally, blank line included: a line that skipped this
    // had no render container at all, so `Console.evict()` could never drop it
    // and the scrollback filled with blank rows the buffer no longer knew about.
    // The wrapper goes with it so eviction takes the row, not just its content.
    if (registerRender) buffer.notifyRender(contentSpan, wrapper);

    contentSpan.style.whiteSpace = 'pre-wrap';

    messageDiv.appendChild(timestampEl);
    messageDiv.appendChild(contentSpan);
    wrapper.appendChild(messageDiv);

    return wrapper;
}

export function setupOutputRenderer(
    source: MessageSource | null,
    {
        outputWrapper,
        sentinel,
        stickyArea,
        isSplitView,
        stickyLines,
        suppressSplitView,
        followTail,
        onCursorReady,
    }: OutputHandlerOptions,
): OutputRendererControls {
    /** Scroll to the newest line, unless this console is pinned to the top. */
    const scrollToTail = () => {
        tailScrollQueued = false;
        // The reader scrolled away between the queue and this frame: leave them.
        if (isSplitView()) return;
        if (followTail && !followTail()) return;
        // Arm the suppression when the scroll happens, not only when the line
        // was added. After a big echo burst one frame of layout can outlast the
        // window armed at append time, and the scroll event this write fires
        // then read as the reader scrolling up and dropped the console into
        // split view for good (#456).
        suppressSplitView?.(250);
        outputWrapper.scrollTop = outputWrapper.scrollHeight;
    };
    // One tail scroll per frame, however many lines landed in it. Every line
    // used to queue its own callback, and each one read scrollHeight — a burst
    // of N lines was N scroll-geometry reads and N scroll writes in the same
    // frame, all but the first wasted, against a scrollback that only grows
    // (#443). The first callback of a frame lands on the tail of everything
    // drawn before it, which is all that was ever asked for.
    let tailScrollQueued = false;
    const queueScrollToTail = () => {
        if (tailScrollQueued) return;
        tailScrollQueued = true;
        requestAnimationFrame(scrollToTail);
    };
    let timestampsVisible = false;

    // ── Trigger cursor ────────────────────────────────────────────────────────
    //
    // `cursorEl`   — the row the cursor is currently pointing at.
    //                null means "the newest row", which is also the
    //                post-delete state.
    // `deletedPrev`— saved previous row of the one that was just deleted via
    //                deleteLine(). moveCursorUp() consumes this to land on the
    //                correct next row.
    //
    // Rows sit in scrollback blocks (outputRows.ts), so every step from row to
    // row goes through those helpers rather than through siblings.
    let cursorEl: Element | null = null;
    let deletedPrev: Element | null = null;

    function resolveElement(): Element | null {
        return cursorEl ?? lastRow(outputWrapper);
    }

    function deleteCursorLine(): void {
        const el = resolveElement();
        if (!el || el === sentinel) return;
        if (el === promptLineEl) promptLineEl = null;
        deletedPrev = previousRow(el);
        detachRow(el);
        cursorEl = null;
    }

    const cursorOps: CursorOps = {
        getLine(): string {
            const el = resolveElement();
            if (!el || el === sentinel) return '';
            return elementBuffers.get(el)?.text ?? '';
        },

        getBuffer(): AnsiAwareBuffer | null {
            const el = resolveElement();
            if (!el || el === sentinel) return null;
            return elementBuffers.get(el) ?? null;
        },

        deleteLine: deleteCursorLine,

        moveUp(): void {
            if (cursorEl === null) {
                if (deletedPrev !== null) {
                    cursorEl = deletedPrev;
                    deletedPrev = null;
                } else {
                    const latest = lastRow(outputWrapper);
                    cursorEl = latest ? previousRow(latest) : null;
                }
            } else {
                cursorEl = previousRow(cursorEl);
            }
        },

        moveDown(): void {
            const current = resolveElement();
            if (!current || current === sentinel) return;
            // Past the newest row the cursor is back on the newest row.
            cursorEl = nextRow(current);
            deletedPrev = null;
        },

        moveTo(line: number): void {
            // line is 1-indexed from the top of the buffer.
            const el = rowAt(outputWrapper, line - 1);
            if (el) {
                cursorEl = el;
                deletedPrev = null;
            }
        },

        getLineNumber(): number {
            const el = resolveElement();
            if (!el || el === sentinel) return 0;
            const idx = rowIndex(outputWrapper, el);
            return idx >= 0 ? idx + 1 : 0; // 1-indexed
        },

        getLineCount(): number {
            return rowCount(outputWrapper);
        },

        getLines(from: number, to: number): string[] {
            const result: string[] = [];
            let el: Element | null = rowAt(outputWrapper, from - 1);
            for (let i = from; el && i <= to; i++) {
                result.push(elementBuffers.get(el)?.text ?? '');
                el = nextRow(el);
            }
            return result;
        },
    };

    onCursorReady?.(cursorOps);

    // ── Message rendering ─────────────────────────────────────────────────────

    // Tracks the current partial-line element (script echo without a trailing \n).
    // On the next complete script line the partial is updated-in-place and finalized;
    // on any MUD/other output the partial stays as-is and a new element is added below.
    let partialLineEl: HTMLDivElement | null = null;
    let partialStickyEl: HTMLDivElement | null = null;

    // The open server prompt line (a line the server flagged as a prompt via
    // IAC GA/EOR — no trailing newline). Mudlet keeps the cursor at its end so
    // the next command echo lands inline ("- look"). We mirror that: when a
    // command echo arrives while this is set, we append it to the prompt
    // element instead of opening a new line. Any other output finalizes the
    // prompt as its own row and clears these.
    let promptLineEl: HTMLDivElement | null = null;
    let promptStickyEl: HTMLDivElement | null = null;

    function updateElementContent(
        el: HTMLDivElement,
        message: string | AnsiAwareBuffer,
        registerRender: boolean = true,
    ): void {
        const buffer = typeof message === 'string' ? new AnsiAwareBuffer(message) : message;
        elementBuffers.set(el, buffer);
        const contentSpan = el.querySelector('.output-msg-content') as HTMLElement | null;
        if (!contentSpan) return;
        if (buffer.length === 0) {
            contentSpan.innerHTML = '&nbsp;';
        } else {
            contentSpan.replaceChildren(buffer.toDom());
        }
        // Same as createMessageWrapper: register even the empty buffer, and
        // register the row alongside the content slot, so the line stays
        // evictable. `registerRender` false for the sticky copy of a line.
        if (registerRender) buffer.notifyRender(contentSpan, el);
    }

    function applyTimestampVisibility() {
        outputWrapper.classList.toggle(TIMESTAMP_CLASS, timestampsVisible);
        stickyArea.classList.toggle(TIMESTAMP_CLASS, timestampsVisible);
    }

    function maybeTrim(): void {
        // Eviction is handled by Console.evict() via removeFromDom(), which takes
        // the whole `.output-msg` row registered in createMessageWrapper — no DOM
        // trimming here.
    }

    /**
     * Redraw the open prompt line after a command echo joined it ("- " +
     * "look"). The console model does the joining (MudSession.echoCommand →
     * Console.appendToPromptLine) on the very buffer this row draws, clearing
     * its prompt flag as it does; the renderer only shows the result, so the
     * command is in the buffer exactly once. Returns false when the model kept
     * the echo on a line of its own (still flagged: a send() from inside a
     * trigger, or output came between) — the caller then draws it as a new row.
     */
    function redrawEchoedPrompt(target: HTMLDivElement, sticky: HTMLDivElement | null): boolean {
        const promptBuf = elementBuffers.get(target) as AnsiAwareBuffer | undefined;
        if (!promptBuf || promptBuf.isPrompt) return false;
        updateElementContent(target, promptBuf);
        if (sticky) updateElementContent(sticky, promptBuf, false);
        cursorEl = target;
        deletedPrev = null;
        if (!isSplitView()) {
            queueScrollToTail();
        }
        return true;
    }

    const handleMessage = (message?: string | AnsiAwareBuffer, type?: string, timestamp?: number, isPrompt?: boolean) => {
        if (message === undefined || message === null) {
            return;
        }

        const timestampValue = typeof timestamp === 'number' ? timestamp : Date.now();

        // ── Command echo: append inline to the open server prompt line ────────
        // Mudlet renders your sent command on the prompt line itself. If a prompt
        // is open, merge the echo into it; otherwise fall through and render it
        // as its own line below.
        if (type === 'echo' && promptLineEl) {
            const target = promptLineEl;
            const sticky = promptStickyEl;
            promptLineEl = null;
            promptStickyEl = null;
            if (redrawEchoedPrompt(target, sticky)) return;
        }

        // Any non-echo output closes the open prompt line: it stays as its own
        // finalized row and new content is rendered below it.
        if (type !== 'echo') {
            promptLineEl = null;
            promptStickyEl = null;
        }

        // 'trigger-echo' = trigger-mode cecho output (from flushDeferredEcho). Styled
        // as 'script' but always creates a fresh element — never updates the timer
        // partial. Map early so all branches below use the display class correctly.
        // Note: 'echo' (command echo from echoCommand) is left as-is; it already
        // falls to the normal path and correctly finalizes any pending partial.
        const effectiveType = type === 'trigger-echo' ? 'script' : type;

        // ── Partial script output (cecho / echo without trailing \n) ─────────
        // The ScriptingAPI emits 'script-partial' and keeps mainOutputBuffer so
        // subsequent cecho calls accumulate: combined = buffer + newText. We
        // update (or create) the partial element in-place — no new DOM node.
        if (type === 'script-partial') {
            if (partialLineEl) {
                updateElementContent(partialLineEl, message);
                if (partialStickyEl) updateElementContent(partialStickyEl, message, false);
                if (!isSplitView()) {
                    queueScrollToTail();
                }
            } else {
                const wrapper = createMessageWrapper(message, 'script', timestampValue);
                appendRow(outputWrapper, wrapper, sentinel);
                partialLineEl = wrapper;
                cursorEl = wrapper;
                deletedPrev = null;
                maybeTrim();
                if (isSplitView()) {
                    const stickyWrapper = createMessageWrapper(message, 'script', timestampValue, false);
                    stickyArea.appendChild(stickyWrapper);
                    partialStickyEl = stickyWrapper;
                    while (stickyArea.childElementCount > stickyLines) {
                        if (stickyArea.firstElementChild === partialStickyEl) break;
                        stickyArea.removeChild(stickyArea.firstElementChild!);
                    }
                } else {
                    suppressSplitView?.(250);
                    queueScrollToTail();
                }
            }
            return;
        }

        // ── Complete script line after a partial ──────────────────────────────
        // bufferText combines mainOutputBuffer + new text, so the emitted
        // complete line already contains the partial text. Update the existing
        // element in-place and finalize it (no new node added).
        // 'echo' (trigger mode) skips this — it always creates a fresh element.
        if (type === 'script' && partialLineEl) {
            updateElementContent(partialLineEl, message);
            if (partialStickyEl) updateElementContent(partialStickyEl, message, false);
            cursorEl = partialLineEl;
            deletedPrev = null;
            partialLineEl = null;
            partialStickyEl = null;
            if (!isSplitView()) {
                suppressSplitView?.(250);
                queueScrollToTail();
            }
            return;
        }

        // ── Normal: MUD output or first script line (no pending partial) ──────
        // Any non-partial message finalizes partial tracking so the next partial
        // starts a fresh line below the new element.
        partialLineEl = null;
        partialStickyEl = null;

        const wrapper = createMessageWrapper(message, effectiveType, timestampValue);

        appendRow(outputWrapper, wrapper, sentinel);

        // Reset the cursor to the freshly rendered line so trigger processing
        // that fires immediately after always starts at the right position.
        cursorEl = wrapper;
        deletedPrev = null;

        // Remember a server prompt line so the next command echo appends to it.
        if (isPrompt && type === 'mud') {
            promptLineEl = wrapper;
        }

        maybeTrim();

        if (isSplitView()) {
            const stickyWrapper = createMessageWrapper(message, effectiveType, timestampValue, false);
            stickyArea.appendChild(stickyWrapper);
            if (isPrompt && type === 'mud') {
                promptStickyEl = stickyWrapper;
            }
            while (stickyArea.childElementCount > stickyLines) {
                const firstSticky = stickyArea.firstElementChild;
                if (firstSticky) {
                    if (firstSticky === promptStickyEl) promptStickyEl = null;
                    stickyArea.removeChild(firstSticky);
                } else {
                    break;
                }
            }
        } else {
            if (suppressSplitView) {
                suppressSplitView(250);
            }
            queueScrollToTail();
        }
    };

    function clearStickyArea() {
        while (stickyArea.firstChild) {
            stickyArea.removeChild(stickyArea.firstChild);
        }
    }

    function populateStickyArea() {
        clearStickyArea();
        for (const el of lastRows(outputWrapper, stickyLines)) {
            stickyArea.appendChild(el.cloneNode(true));
        }
        applyTimestampVisibility();
    }

    let teardownSubscriptions = () => {};

    if (source) {
        const unsubscribeMessage = source.on('message', handleMessage);

        const unsubscribeDeleteLine = source.on('script.deleteline', deleteCursorLine);

        const unsubscribeClearWindow    = source.on('script.clearwindow',    clearAll);
        const unsubscribeMoveCursorUp   = source.on('script.movecursorup',   cursorOps.moveUp);
        const unsubscribeMoveCursorDown = source.on('script.movecursordown', cursorOps.moveDown);

        teardownSubscriptions = () => {
            unsubscribeMessage();
            unsubscribeDeleteLine();
            unsubscribeClearWindow();
            unsubscribeMoveCursorUp();
            unsubscribeMoveCursorDown();
        };
    }

    function clearAll() {
        clearStickyArea();
        partialLineEl = null;
        partialStickyEl = null;
        promptLineEl = null;
        promptStickyEl = null;
        clearRows(outputWrapper);
        cursorEl = null;
        deletedPrev = null;
    }

    // Ctrl+]/Ctrl+[ to jump between OSC 8 links in this output. Compose its
    // removal into teardown alongside the source subscriptions.
    const removeLinkNav = installLinkNavigation(outputWrapper);
    const subscriptionsTeardown = teardownSubscriptions;
    teardownSubscriptions = () => { subscriptionsTeardown(); removeLinkNav(); };

    return {
        teardown: teardownSubscriptions,
        areTimestampsVisible: () => timestampsVisible,
        setTimestampVisibility: (visible: boolean) => {
            timestampsVisible = visible;
            applyTimestampVisibility();
        },
        toggleTimestampVisibility: () => {
            timestampsVisible = !timestampsVisible;
            applyTimestampVisibility();
        },
        populateStickyArea,
        clearStickyArea,
        push: handleMessage,
        clear: clearAll,
        isTailScrollQueued: () => tailScrollQueued,
    };
}
