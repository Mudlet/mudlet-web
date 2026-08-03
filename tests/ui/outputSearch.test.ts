import { describe, it, expect, beforeEach } from 'vitest';
import { buildMatcher } from '../../src/ui/search/matcher';
import {
    scanOutput, applyHighlights, clearHighlights, focusCurrentHit,
    findMatchIndex, indexNearViewport, matchLineText, searchStepDirection,
    seedFromSelection, shouldCloseSearchOnEscape, HIT_CLASS, CURRENT_HIT_CLASS,
} from '../../src/ui/output/outputSearch';

let container: HTMLElement;

beforeEach(() => {
    document.body.replaceChildren();
    container = document.createElement('div');
    container.className = 'output-wrapper';
    document.body.appendChild(container);
});

/** Mirrors the wrapper `createMessageWrapper` builds in OutputRenderer: the
 *  timestamp lives in its own span alongside the content span. */
function addLine(contentHtml: string, timestamp = '12:00:00.000'): HTMLElement {
    const el = document.createElement('div');
    el.className = 'output-msg';
    el.innerHTML =
        `<div class="output-msg-text">` +
        `<span class="output-timestamp">${timestamp}</span>` +
        `<span class="output-msg-content">${contentHtml}</span>` +
        `</div>`;
    container.appendChild(el);
    return el;
}

function marks(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(`mark.${HIT_CLASS}`)];
}

function search(query: string, matchCase = false, useRegex = false) {
    return scanOutput(container, buildMatcher(query, matchCase, useRegex));
}

describe('scanOutput', () => {
    it('finds every occurrence across lines, in document order', () => {
        addLine('A rusty key lies here.');
        addLine('Nothing of interest.');
        addLine('The rusty gate is rusty.');

        const found = search('rusty');
        expect(found).toHaveLength(3);
        expect(found[0].line).toBe(container.children[0]);
        expect(found[0].range).toEqual([2, 7]);
        expect(found[1].line).toBe(container.children[2]);
        expect(found[2].line).toBe(container.children[2]);
        expect(found[1].range[0]).toBeLessThan(found[2].range[0]);
    });

    it('is case-insensitive by default and exact with matchCase', () => {
        addLine('Rusty and rusty.');
        expect(search('rusty')).toHaveLength(2);
        expect(search('rusty', true)).toHaveLength(1);
        expect(search('Rusty', true)).toHaveLength(1);
    });

    it('does not search the timestamp column', () => {
        addLine('nothing here', '12:34:56.000');
        expect(search('12:34')).toHaveLength(0);
        expect(search('nothing')).toHaveLength(1);
    });

    it('offsets index the rendered text across ANSI colour spans', () => {
        // "The " + "rusty" + " gate" split into three coloured segments.
        addLine('<span style="color:#fff">The </span><span style="color:#f00">rusty</span><span> gate</span>');
        const found = search('rusty');
        expect(found).toHaveLength(1);
        expect(found[0].range).toEqual([4, 9]);
    });

    it('supports regex queries and reports an invalid pattern instead of matching', () => {
        addLine('You have 27 gold and 4 silver.');
        expect(search('\\d+', false, true)).toHaveLength(2);

        const bad = buildMatcher('(unclosed', false, true);
        expect(bad.valid).toBe(false);
        expect(scanOutput(container, bad)).toHaveLength(0);
    });

    it('skips lines with no content span', () => {
        const stray = document.createElement('div');
        stray.className = 'output-msg';
        stray.textContent = 'rusty';
        container.appendChild(stray);
        expect(search('rusty')).toHaveLength(0);
    });
});

describe('applyHighlights', () => {
    it('wraps each hit in a mark and flags only the current one', () => {
        addLine('rusty key, rusty gate');
        const found = search('rusty');
        applyHighlights(found, 1);

        const all = marks();
        expect(all).toHaveLength(2);
        expect(all.map(m => m.textContent)).toEqual(['rusty', 'rusty']);
        expect(all[0].classList.contains(CURRENT_HIT_CLASS)).toBe(false);
        expect(all[1].classList.contains(CURRENT_HIT_CLASS)).toBe(true);
    });

    it('leaves the line text unchanged', () => {
        const line = addLine('A rusty key lies here.');
        const before = line.querySelector('.output-msg-content')!.textContent;
        applyHighlights(search('rusty'), 0);
        expect(line.querySelector('.output-msg-content')!.textContent).toBe(before);
    });

    it('marks each crossed span when a hit straddles a colour change', () => {
        // "rus" and "ty" land in different segments — the tint must cover both.
        addLine('<span style="color:#f00">rus</span><span style="color:#0f0">ty key</span>');
        applyHighlights(search('rusty'), 0);

        const all = marks();
        expect(all).toHaveLength(2);
        expect(all.map(m => m.textContent).join('')).toBe('rusty');
        expect(all.every(m => m.classList.contains(CURRENT_HIT_CLASS))).toBe(true);
    });

    it('places every hit correctly when one line holds several', () => {
        addLine('ab ab ab');
        applyHighlights(search('ab'), 0);
        expect(marks()).toHaveLength(3);
        expect(container.querySelector('.output-msg-content')!.textContent).toBe('ab ab ab');
    });

    it('ignores matches whose line has been evicted from the DOM', () => {
        const line = addLine('rusty key');
        const found = search('rusty');
        line.remove();
        expect(() => applyHighlights(found, 0)).not.toThrow();
        expect(marks()).toHaveLength(0);
    });

    it('does nothing when there are no matches', () => {
        addLine('nothing here');
        applyHighlights(search('rusty'), -1);
        expect(marks()).toHaveLength(0);
    });

    it('tints matches even when the current index is out of range', () => {
        addLine('rusty key');
        applyHighlights(search('rusty'), -1);
        const all = marks();
        expect(all).toHaveLength(1);
        expect(all[0].classList.contains(CURRENT_HIT_CLASS)).toBe(false);
    });
});

describe('clearHighlights', () => {
    it('restores the exact markup it started with', () => {
        const html = '<span style="color:#f00">rus</span><span style="color:#0f0">ty key, rusty gate</span>';
        const line = addLine(html);
        const content = line.querySelector('.output-msg-content')!;
        const before = content.innerHTML;

        applyHighlights(search('rusty'), 0);
        expect(marks().length).toBeGreaterThan(0);

        clearHighlights(container);
        expect(marks()).toHaveLength(0);
        expect(content.innerHTML).toBe(before);
    });

    it('re-merges split text nodes so a rescan sees the original layout', () => {
        const line = addLine('rusty key, rusty gate');
        const content = line.querySelector('.output-msg-content')!;

        applyHighlights(search('rusty'), 0);
        clearHighlights(container);

        expect(content.childNodes).toHaveLength(1);
        expect(content.textContent).toBe('rusty key, rusty gate');
    });

    it('is safe to call when nothing is highlighted', () => {
        addLine('nothing here');
        expect(() => clearHighlights(container)).not.toThrow();
    });

    it('leaves a clean slate for a second search', () => {
        addLine('rusty key and a shiny sword');

        applyHighlights(search('rusty'), 0);
        clearHighlights(container);
        const second = search('shiny');
        applyHighlights(second, 0);

        const all = marks();
        expect(all).toHaveLength(1);
        expect(all[0].textContent).toBe('shiny');
    });
});

describe('findMatchIndex', () => {
    it('re-locates the same hit after a rescan', () => {
        addLine('rusty one');
        const second = addLine('rusty two');
        const before = search('rusty');

        // A new line arrives; the previously current hit shifts position.
        const fresh = document.createElement('div');
        fresh.className = 'output-msg';
        fresh.innerHTML = '<div class="output-msg-text"><span class="output-msg-content">rusty zero</span></div>';
        container.insertBefore(fresh, container.firstChild);

        const after = search('rusty');
        expect(findMatchIndex(after, before[1])).toBe(2);
        expect(after[2].line).toBe(second);
    });

    it('returns -1 for a hit that no longer exists, or for no target', () => {
        const line = addLine('rusty key');
        const before = search('rusty');
        line.remove();
        expect(findMatchIndex(search('rusty'), before[0])).toBe(-1);
        expect(findMatchIndex(before, null)).toBe(-1);
    });
});

describe('seedFromSelection', () => {
    /** Select the text of `node` (a text node) from `start` to `end`. */
    function select(node: Node, start: number, end: number): void {
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
    }

    it('seeds from text selected in the output', () => {
        const line = addLine('A rusty key lies here.');
        select(line.querySelector('.output-msg-content')!.firstChild!, 2, 7);
        expect(seedFromSelection(container)).toBe('rusty');
    });

    it('ignores a selection outside the output', () => {
        // The command line keeps the last command selected after sending; that
        // must never end up prefilling the find box.
        addLine('A rusty key lies here.');
        const elsewhere = document.createElement('div');
        elsewhere.textContent = 'lua echo("some long command")';
        document.body.appendChild(elsewhere);
        select(elsewhere.firstChild!, 0, elsewhere.textContent.length);
        expect(seedFromSelection(container)).toBe('');
    });

    it('ignores a collapsed selection, a missing container, and multi-line text', () => {
        const line = addLine('A rusty key lies here.');
        const text = line.querySelector('.output-msg-content')!.firstChild!;

        select(text, 3, 3);
        expect(seedFromSelection(container)).toBe('');

        select(text, 2, 7);
        expect(seedFromSelection(null)).toBe('');

        const multi = addLine('first');
        const second = addLine('second');
        const range = document.createRange();
        range.setStart(multi.querySelector('.output-msg-content')!.firstChild!, 0);
        range.setEnd(second.querySelector('.output-msg-content')!.firstChild!, 6);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        expect(seedFromSelection(container)).toBe('');
    });
});

describe('shouldCloseSearchOnEscape', () => {
    /** Dispatch a real Escape from `target` so `e.target` is set by the DOM,
     *  the way the document listener sees it. */
    function escapeFrom(target: HTMLElement, init: KeyboardEventInit = {}): KeyboardEvent {
        const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
        target.dispatchEvent(e);
        return e;
    }

    /** An element nested inside the profile-session shell, mirroring the real
     *  chain (e.g. `.app > .mudix-toolbar > .toolbar-actions > button`). */
    function inApp(...classes: string[]): HTMLElement {
        const app = document.createElement('div');
        app.className = 'app';
        document.body.appendChild(app);
        let node = app;
        for (const c of classes) {
            const child = document.createElement('div');
            child.className = c;
            node.appendChild(child);
            node = child;
        }
        return node;
    }

    /** Portaled to <body>, the way FloatingWindowLayer renders script windows. */
    function portaled(className: string): HTMLElement {
        const el = document.createElement('div');
        el.className = className;
        document.body.appendChild(el);
        return el;
    }

    it('closes from anywhere in the session shell', () => {
        expect(shouldCloseSearchOnEscape(escapeFrom(inApp('command-input')))).toBe(true);
        expect(shouldCloseSearchOnEscape(escapeFrom(inApp('main-viewport', 'output-area-content')))).toBe(true);
        // The toolbar counts too — closing a modal returns focus to the button
        // that opened it, and Escape from there should still dismiss the bar.
        expect(shouldCloseSearchOnEscape(escapeFrom(inApp('mudix-toolbar', 'toolbar-actions')))).toBe(true);
    });

    it('closes when nothing more specific holds focus', () => {
        expect(shouldCloseSearchOnEscape(escapeFrom(document.body))).toBe(true);
    });

    it('ignores any other key', () => {
        expect(shouldCloseSearchOnEscape(escapeFrom(document.body, { key: 'Enter' }))).toBe(false);
    });

    it('defers to a handler that already acted on the key', () => {
        // CommandBar preventDefaults Escape while an autocomplete ghost shows,
        // so that press dismisses the ghost and only the next one closes the bar.
        const cmd = inApp('command-input');
        cmd.addEventListener('keydown', e => e.preventDefault());
        expect(shouldCloseSearchOnEscape(escapeFrom(cmd))).toBe(false);
    });

    it('leaves Escape alone in a floating window, which portals outside .app', () => {
        expect(shouldCloseSearchOnEscape(escapeFrom(portaled('floating-window-root')))).toBe(false);
    });
});

describe('searchStepDirection', () => {
    const key = (init: KeyboardEventInit & { key: string }) => new KeyboardEvent('keydown', init);

    it('reads F3 as forwards and Shift+F3 as backwards', () => {
        expect(searchStepDirection(key({ key: 'F3' }))).toBe(1);
        expect(searchStepDirection(key({ key: 'F3', shiftKey: true }))).toBe(-1);
    });

    it('ignores any other key', () => {
        expect(searchStepDirection(key({ key: 'F4' }))).toBeNull();
        expect(searchStepDirection(key({ key: 'f' }))).toBeNull();
    });

    it('leaves Ctrl / Alt / Cmd + F3 to the browser and the OS', () => {
        expect(searchStepDirection(key({ key: 'F3', ctrlKey: true }))).toBeNull();
        expect(searchStepDirection(key({ key: 'F3', altKey: true }))).toBeNull();
        expect(searchStepDirection(key({ key: 'F3', metaKey: true }))).toBeNull();
        // ...including in combination with the Shift that would step backwards.
        expect(searchStepDirection(key({ key: 'F3', shiftKey: true, ctrlKey: true }))).toBeNull();
    });
});

// Both helpers exist for Mudlet's f3SearchEnabled accessibility mode, which
// announces each hit and parks its caret on it (focusOnSearchResultAndAnnounce).
describe('matchLineText', () => {
    it('returns the whole rendered line, not just the matched fragment', () => {
        addLine('A <span>rusty</span> key lies here.');
        const [match] = search('rusty');
        expect(matchLineText(match)).toBe('A rusty key lies here.');
    });

    it('excludes the timestamp column', () => {
        addLine('rusty', '09:41:00.000');
        expect(matchLineText(search('rusty')[0])).toBe('rusty');
    });
});

describe('focusCurrentHit', () => {
    it('focuses the current hit and leaves the others alone', () => {
        addLine('rusty one');
        addLine('rusty two');
        const found = search('rusty');
        applyHighlights(found, 1);

        expect(focusCurrentHit(container)).toBe(true);
        const current = container.querySelector<HTMLElement>(`mark.${CURRENT_HIT_CLASS}`);
        expect(document.activeElement).toBe(current);
        // Programmatically focusable only — it must not join the tab order,
        // and only the current hit is made focusable at all. (Checked via the
        // attribute: `.tabIndex` reads -1 for any element without one.)
        expect(current?.getAttribute('tabindex')).toBe('-1');
        expect(marks().filter(m => m.hasAttribute('tabindex'))).toHaveLength(1);
    });

    it('reports false when nothing is currently highlighted', () => {
        addLine('rusty one');
        // Tinted, but with the current index out of range — no current hit.
        applyHighlights(search('rusty'), 5);
        expect(focusCurrentHit(container)).toBe(false);
    });
});

describe('indexNearViewport', () => {
    it('returns -1 when there is nothing to jump to', () => {
        expect(indexNearViewport(container, [])).toBe(-1);
    });

    it('falls back to the most recent hit when none are laid out on screen', () => {
        // happy-dom reports zero-sized rects, so no match reads as "below the
        // fold" — the newest hit is the useful place to start.
        addLine('rusty one');
        addLine('rusty two');
        const found = search('rusty');
        const idx = indexNearViewport(container, found);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(found.length);
    });
});
