import { outputRows } from './outputRows';

/**
 * Caret mode / reading cursor — keyboard-navigable review of the scrollback for
 * screen-reader users (Mudlet's caret mode, ported web-natively).
 *
 * Rather than reimplement Mudlet's painted caret + boundary-finding over a
 * custom-drawn widget, we mirror the already-rendered output DOM into a
 * focusable review surface and let the browser + assistive tech provide real
 * char/word/line navigation and announcements for free (the `CaretReviewPanel`
 * component). This module holds the surface-independent, DOM-level helpers so
 * they're unit-testable without React.
 */

/** The toggle key the `caretShortcut` config selects. `none` disables the
 *  feature; the rest mirror Mudlet's Host::CaretShortcut enum. */
export type CaretShortcut = 'none' | 'tab' | 'ctrltab' | 'f6';

/** True when `e` is the configured caret-mode toggle. Bare Tab / Ctrl+Tab / F6
 *  each require no *other* modifiers so they don't fire on Shift+Tab, Alt+F6,
 *  etc. `none` (or any unknown value) never matches. Pure — reads only `key`
 *  and the modifier flags. */
export function matchCaretToggle(e: KeyboardEvent, shortcut: CaretShortcut): boolean {
    switch (shortcut) {
        case 'tab':
            return e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
        case 'ctrltab':
            return e.key === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
        case 'f6':
            return e.key === 'F6' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
        default:
            return false;
    }
}

/** The rendered line elements under the main output wrapper, in order. Each
 *  logical line is one `div.output-msg`, inside a scrollback block
 *  (outputRows.ts); the height:0 sticky sentinel and any other children are
 *  skipped (mirrors WindowManager.lineElements). */
export function outputLineElements(outputEl: HTMLElement): HTMLElement[] {
    return outputRows(outputEl);
}

/**
 * Clone one rendered output line for the review surface and revive its links.
 *
 * `cloneNode(true)` copies the text and inline colour styles faithfully but NOT
 * the per-element click/contextmenu listeners (they're attached imperatively in
 * FormatState, closing over the link descriptor). So for each clickable run we
 * re-dispatch the clone's click/context-menu to the *original* element — which
 * still owns the real send/prompt/url/spoiler action — and tag it `role="link"`
 * so assistive tech announces and reaches it. Original and clone share document
 * order within the line, so pairing by index is stable.
 */
export function cloneOutputLine(orig: HTMLElement): HTMLElement {
    const clone = orig.cloneNode(true) as HTMLElement;
    const origLinks = orig.querySelectorAll<HTMLElement>('[data-output-clickable]');
    const cloneLinks = clone.querySelectorAll<HTMLElement>('[data-output-clickable]');
    const n = Math.min(origLinks.length, cloneLinks.length);
    for (let i = 0; i < n; i++) {
        const origLink = origLinks[i];
        const cloneLink = cloneLinks[i];
        if (!cloneLink.getAttribute('role')) cloneLink.setAttribute('role', 'link');
        cloneLink.addEventListener('click', (e) => {
            e.preventDefault();
            origLink.click();
        });
        cloneLink.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const r = cloneLink.getBoundingClientRect();
            origLink.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true, cancelable: true,
                clientX: Math.round(r.left), clientY: Math.round(r.bottom),
            }));
        });
    }
    return clone;
}

/** Whether a scroll container is within `threshold` px of its bottom — used to
 *  decide if the review surface should follow new output to the end (Mudlet's
 *  "auto-scroll only when the caret is already at the end") or hold position so
 *  the user can keep reading where they are. */
export function isNearBottom(el: HTMLElement, threshold = 32): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}
