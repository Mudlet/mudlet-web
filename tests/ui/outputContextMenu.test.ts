import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AnsiAwareBuffer } from '../../src/mud/text/FormatState';
import { elementBuffers } from '../../src/ui/output/OutputRenderer';
import {
    hasCopyableLines, searchSelectionOnline, copySelectionAsHtml, selectAll,
} from '../../src/ui/output/outputCopy';
import { resolveSearchEngine, SEARCH_ENGINES, DEFAULT_SEARCH_ENGINE } from '../../src/storage/schema';

let container: HTMLElement;

beforeEach(() => {
    document.body.replaceChildren();
    container = document.createElement('div');
    container.className = 'output-wrapper';
    document.body.appendChild(container);
});

afterEach(() => {
    vi.restoreAllMocks();
    window.getSelection()?.removeAllRanges();
});

/** A rendered row, optionally carrying the buffer the copy paths need.
 *
 *  No timestamp span: the real one is `user-select: none` so it never lands in
 *  a selection, and happy-dom does not honour that, which would put the
 *  timestamp text into everything read back from `Selection.toString()`. */
function addLine(text: string, withBuffer = true): HTMLElement {
    const el = document.createElement('div');
    el.className = 'output-msg';
    el.innerHTML =
        '<div class="output-msg-text">'
        + `<span class="output-msg-content">${text}</span>`
        + '</div>';
    container.appendChild(el);
    if (withBuffer) {
        elementBuffers.set(el, {
            toHtml: () => text,
            toStyledRuns: () => [{ text, color: undefined, bold: false, italic: false, underline: false }],
        } as unknown as AnsiAwareBuffer);
    }
    return el;
}

describe('resolveSearchEngine', () => {
    it('keeps a name it knows', () => {
        expect(resolveSearchEngine('DuckDuckGo')).toBe('DuckDuckGo');
        expect(resolveSearchEngine('Bing')).toBe('Bing');
    });

    it('falls back for an unset or unknown name, as Host::getSearchEngine does', () => {
        expect(resolveSearchEngine(undefined)).toBe(DEFAULT_SEARCH_ENGINE);
        expect(resolveSearchEngine('')).toBe(DEFAULT_SEARCH_ENGINE);
        expect(resolveSearchEngine('Altavista')).toBe(DEFAULT_SEARCH_ENGINE);
    });

    it('never resolves to a name with no query prefix behind it', () => {
        for (const name of ['Bing', 'DuckDuckGo', 'Google', 'nonsense', undefined]) {
            expect(SEARCH_ENGINES[resolveSearchEngine(name)]).toBeTruthy();
        }
    });
});

describe('searchSelectionOnline', () => {
    it('opens the configured engine with the selection percent-encoded', () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null);
        addLine('a rusty key');
        selectAll(container);

        searchSelectionOnline('DuckDuckGo');

        expect(open).toHaveBeenCalledTimes(1);
        const url = open.mock.calls[0][0] as string;
        expect(url.startsWith('https://duckduckgo.com/?q=')).toBe(true);
        expect(url).toContain('rusty%20key');
    });

    // A real browser puts a newline between the rows a multi-line selection
    // spans; desktop flattens those to spaces (`getSelectedText(QChar::Space)`)
    // because a search box wants one query, not a block of text. happy-dom's
    // Selection.toString() runs the rows together instead, so the newline here
    // is inside a line's own text.
    it('flattens newlines and runs of whitespace into single spaces', () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null);
        addLine('first   line\nsecond line');
        selectAll(container);

        searchSelectionOnline('Google');

        const url = open.mock.calls[0][0] as string;
        expect(url).not.toContain('%0A');
        expect(decodeURIComponent(url.slice(SEARCH_ENGINES.Google.length))).toBe('first line second line');
    });

    it('falls back to the default engine for an unknown name', () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null);
        addLine('hello');
        selectAll(container);

        searchSelectionOnline('Altavista');

        expect((open.mock.calls[0][0] as string).startsWith(SEARCH_ENGINES[DEFAULT_SEARCH_ENGINE])).toBe(true);
    });

    it('does nothing when nothing is selected', () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null);
        addLine('hello');

        searchSelectionOnline('Google');

        expect(open).not.toHaveBeenCalled();
    });
});

describe('hasCopyableLines', () => {
    it('is false for a console that has printed nothing', () => {
        expect(hasCopyableLines(container)).toBe(false);
    });

    it('is false when a row carries no buffer to re-serialise', () => {
        addLine('unbacked', false);
        expect(hasCopyableLines(container)).toBe(false);
    });

    // This is what gates "Copy as image": with no selection it copies the
    // visible area, so only an empty console can disable it.
    it('is true as soon as one row has a buffer, with or without a selection', () => {
        addLine('something');
        expect(hasCopyableLines(container)).toBe(true);
    });
});

describe('copySelectionAsHtml', () => {
    function captureClipboardHtml(): { html: () => string } {
        let written = '';
        vi.stubGlobal('ClipboardItem', undefined);
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: (s: string) => { written = s; return Promise.resolve(); } },
        });
        return { html: () => written };
    }

    it('titles the document after the app and the profile, never the codename', async () => {
        const clip = captureClipboardHtml();
        addLine('you see a door');
        selectAll(container);

        await copySelectionAsHtml(container, 'Achaea');

        const html = clip.html();
        expect(html).toContain('<title>Mudlet Web, console extract from Achaea</title>');
        expect(html).toContain('name="generator"');
        expect(html).not.toContain('Mudix');
    });

    it('omits the profile clause when the console has no name to give', async () => {
        const clip = captureClipboardHtml();
        addLine('you see a door');
        selectAll(container);

        await copySelectionAsHtml(container);

        expect(clip.html()).toContain('<title>Mudlet Web console extract</title>');
    });
});
