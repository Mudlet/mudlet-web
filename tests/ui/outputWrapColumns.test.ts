import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StickyOutputPanel } from '../../src/ui/output/StickyOutputPanel';

// `setWindowWrap(win, n)` reaches the DOM as `--wrap-cols`, which caps
// `.output-msg-content`'s max-width. Capping it at exactly `n`ch is a knife
// edge: a console line is not one text run — every colour change opens another
// inline box, and the browser rounds each box's advance up to a layout unit —
// so `n` columns spread over several runs measure a hair wider than `n`ch and
// the tail folds onto a second line. That is what put "Telnet" under
// "Transport" in a right-aligned stats panel while the uncoloured rows beside
// it sat flush. Mudlet has no such effect (TTextEdit paints an integer cell
// grid), so the slack is what keeps the two clients' line breaks in step.
//
// (JSX is avoided so the file stays a plain .test.ts, matching the include glob.)

const noRef = { current: null };

const baseProps = {
    outputRef: noRef as React.RefObject<HTMLDivElement | null>,
    sentinelRef: noRef as React.RefObject<HTMLDivElement | null>,
    stickyAreaRef: noRef as React.RefObject<HTMLDivElement | null>,
    isSplitView: false,
    scrollToBottom: () => {},
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
});

function wrapCols(wrapAt?: number): string | null {
    act(() => { root.render(createElement(StickyOutputPanel, { ...baseProps, wrapAt })); });
    const wrapper = host.querySelector<HTMLElement>('.output-wrapper')!;
    const value = wrapper.style.getPropertyValue('--wrap-cols');
    return value === '' ? null : value;
}

describe('--wrap-cols (setWindowWrap → max-width)', () => {
    it('carries half a column of slack past the pinned wrap width', () => {
        expect(wrapCols(66)).toBe('66.5ch');
    });

    it('keeps the slack under a full column, so column n + 1 still wraps', () => {
        // n + 1 columns need a whole extra `ch`; anything short of that breaks.
        const slack = Number(wrapCols(80)!.replace('ch', '')) - 80;
        expect(slack).toBeGreaterThan(0);
        expect(slack).toBeLessThan(1);
    });

    it('is unset when no wrap is pinned — the panel wraps at its own width', () => {
        expect(wrapCols(undefined)).toBe(null);
        expect(wrapCols(0)).toBe(null);
    });
});
