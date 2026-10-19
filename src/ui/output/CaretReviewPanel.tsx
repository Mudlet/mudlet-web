import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { MudSession } from '../../mud/MudSession';
import { useProfileField } from '../../storage';
import { handleLinkNavKeydown } from './linkNavigation';
import { isOutputBlock } from './outputRows';
import {
    matchCaretToggle,
    outputLineElements,
    cloneOutputLine,
    isNearBottom,
    type CaretShortcut,
} from './caretMode';

/**
 * Caret mode / reading cursor (Mudlet's caret mode, web-native).
 *
 * When the user's configured `caretShortcut` is pressed, a focusable review
 * panel mirrors the main output's rendered lines (text + working links) and
 * takes focus, so a screen reader can navigate the scrollback by char/word/line
 * with its own virtual cursor — and reach links — without the live output's
 * additions-only ARIA region getting in the way. Escape, the close button, or
 * the toggle key again exits and returns focus to the command line.
 *
 * The mirror is kept live by a MutationObserver on the main output: appends and
 * evictions are reflected as they happen, so the panel never goes stale while
 * open. We clone the already-rendered DOM (rather than re-deriving from the
 * Console model) because the DOM is the faithful "what's on screen" source —
 * blank lines and inline command echoes included.
 */
export function CaretReviewPanel({
    session,
    commandInputRef,
}: {
    session: MudSession;
    commandInputRef?: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
}) {
    const config = useProfileField('config');
    const shortcut = (config?.caretShortcut as CaretShortcut | undefined) ?? 'none';
    const [open, setOpen] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    // openRef lets the global key handler read the latest state without
    // re-subscribing on every toggle (and avoids a stale-closure read).
    const openRef = useRef(false);
    useEffect(() => { openRef.current = open; }, [open]);

    const close = useCallback(() => {
        setOpen(false);
        commandInputRef?.current?.focus();
    }, [commandInputRef]);

    // Global toggle: the configured shortcut opens/closes caret mode. Disabled
    // entirely when 'none'. We don't hijack the key while the user is typing in
    // some *other* text field/editor — only from the command line, the output,
    // the panel itself, or no focus.
    useEffect(() => {
        if (shortcut === 'none') return;
        const onKey = (e: KeyboardEvent) => {
            if (!matchCaretToggle(e, shortcut)) return;
            const active = document.activeElement as HTMLElement | null;
            const cmd = commandInputRef?.current ?? null;
            const inPanel = scrollRef.current?.contains(active) ?? false;
            const editingElsewhere = !!active && active !== cmd && !inPanel &&
                (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
            if (editingElsewhere) return;
            e.preventDefault();
            if (openRef.current) close();
            else setOpen(true);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [shortcut, commandInputRef, close]);

    // While open: populate the panel from the current output, keep it mirrored
    // with a MutationObserver, focus it, and own the in-panel key handling.
    useEffect(() => {
        if (!open) return;
        const scroll = scrollRef.current;
        const mainOutput = session.windows.getElement('main');
        if (!scroll || !mainOutput) { setOpen(false); return; }

        // origEl → its clone, for reflecting evictions (a removed output line
        // drops its mirror). WeakMap: entries vanish with the originals.
        const cloneByOrig = new WeakMap<HTMLElement, HTMLElement>();
        scroll.replaceChildren();
        for (const line of outputLineElements(mainOutput)) {
            const clone = cloneOutputLine(line);
            cloneByOrig.set(line, clone);
            scroll.appendChild(clone);
        }
        scroll.scrollTop = scroll.scrollHeight; // start at the newest line

        // Lines arrive and leave as rows inside scrollback blocks, and as whole
        // blocks (outputRows.ts), so the observer watches the subtree and only
        // looks at what was added to or taken from the scroller or a block.
        const rowsOf = (n: Node): HTMLElement[] => {
            if (!(n instanceof HTMLElement)) return [];
            if (n.classList.contains('output-msg')) return [n];
            return isOutputBlock(n) ? outputLineElements(n) : [];
        };
        const observer = new MutationObserver((mutations) => {
            const stick = isNearBottom(scroll);
            for (const m of mutations) {
                const target = m.target;
                if (target !== mainOutput && !(target instanceof HTMLElement && isOutputBlock(target))) continue;
                m.addedNodes.forEach((n) => {
                    for (const row of rowsOf(n)) {
                        // A new block's row is reported twice: once with the
                        // block, once added to it.
                        if (cloneByOrig.has(row) || !row.isConnected) continue;
                        const clone = cloneOutputLine(row);
                        cloneByOrig.set(row, clone);
                        scroll.appendChild(clone);
                    }
                });
                m.removedNodes.forEach((n) => {
                    for (const row of rowsOf(n)) {
                        const clone = cloneByOrig.get(row);
                        if (clone) { clone.remove(); cloneByOrig.delete(row); }
                    }
                });
            }
            if (stick) scroll.scrollTop = scroll.scrollHeight;
        });
        observer.observe(mainOutput, { childList: true, subtree: true });

        // Capture-phase so we settle Escape and link-nav before the
        // document-level main-output link handler (whose Ctrl+] would otherwise
        // yank focus into the live output); only when focus is inside the panel.
        const onDocKey = (e: KeyboardEvent) => {
            const target = e.target as Node | null;
            if (!target || !scroll.contains(target)) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopImmediatePropagation();
                close();
                return;
            }
            if (handleLinkNavKeydown(e, scroll)) e.stopImmediatePropagation();
        };
        document.addEventListener('keydown', onDocKey, true);

        scroll.focus();

        return () => {
            observer.disconnect();
            document.removeEventListener('keydown', onDocKey, true);
        };
    }, [open, session, close]);

    if (!open) return null;
    return (
        <div className="caret-review" role="region" aria-label="Output review">
            <div className="caret-review-header">
                <span>Output review — arrow keys to read, Tab/Ctrl+] to links, Esc to exit</span>
                <button
                    type="button"
                    className="caret-review-close"
                    onClick={close}
                    aria-label="Exit output review"
                >
                    ✕
                </button>
            </div>
            <div
                ref={scrollRef}
                className="caret-review-scroll"
                role="document"
                aria-label="Scrollback"
                tabIndex={-1}
            />
        </div>
    );
}
