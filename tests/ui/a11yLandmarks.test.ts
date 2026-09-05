// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StickyOutputPanel } from '../../src/ui/output/StickyOutputPanel';
import { MAIN_OUTPUT_ID, COMMAND_INPUT_ID } from '../../src/ui/landmarks';

// The session screen had no landmarks, no headings and no skip links, and the
// scrollback itself was anonymous — Tab-reachable only through Chrome's
// "focusable scrollable region" behaviour, which the other browsers do not all
// provide. These pin the structure the skip links navigate to.

const nullRef = () => ({ current: null });

const render = (props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(StickyOutputPanel, {
        outputRef: nullRef(),
        sentinelRef: nullRef(),
        stickyAreaRef: nullRef(),
        isSplitView: false,
        scrollToBottom: () => {},
        ...props,
    } as never));

describe('main console output region', () => {
    const html = render({ regionId: MAIN_OUTPUT_ID, regionLabel: 'Achaea game output' });

    it('is an id a skip link can target', () => {
        expect(html).toMatch(new RegExp(`id="${MAIN_OUTPUT_ID}"`));
    });

    it('is a named region', () => {
        expect(html).toMatch(/role="region"/);
        expect(html).toMatch(/aria-label="Achaea game output"/);
    });

    it('is an explicit tab stop rather than an incidentally focusable scroller', () => {
        expect(html).toMatch(/tabindex="0"/i);
    });

    it('is not a live region — ScreenReaderLog is, and two would double-speak', () => {
        expect(html).not.toMatch(/role="log"/);
        expect(html).not.toMatch(/aria-live/);
    });
});

describe('script-window output', () => {
    // TextPanel already wraps its console in its own labelled region, so the
    // panel must not nest a second one inside it.
    const html = render({ sourceName: 'myWindow', className: 'window-text-panel' });

    it('adds no region of its own', () => {
        expect(html).not.toMatch(/role="region"/);
        expect(html).not.toMatch(/tabindex/i);
    });
});

describe('viewport meta', () => {
    const head = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

    it('does not block pinch zoom (WCAG 1.4.4)', () => {
        const meta = head.match(/<meta name="viewport"[^>]*>/)![0];
        expect(meta).not.toMatch(/user-scalable\s*=\s*no/);
        expect(meta).not.toMatch(/maximum-scale/);
    });
});

describe('landmark ids', () => {
    it('are the ones the skip links and their targets both use', () => {
        // Guards against the two halves drifting apart if either is inlined again.
        expect(MAIN_OUTPUT_ID).toBe('mudix-output');
        expect(COMMAND_INPUT_ID).toBe('mudix-command-input');
    });
});
