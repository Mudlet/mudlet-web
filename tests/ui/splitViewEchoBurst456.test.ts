// mudlet-web#456: after a script echoed a lot of output, the main window
// dropped into split-scrollback on its own and stopped following new lines.
// #447 made the tail scroll one-per-frame, but the split-view suppression was
// still armed only when a line was appended. A frame of layout over the grown
// scrollback could outlast that 250 ms window, so the scroll event seen before
// the queued tail scroll ran read as the reader scrolling up.
//
// (JSX is avoided so the file stays a plain .test.ts, matching the include glob.)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setupOutputRenderer } from '../../src/ui/output/OutputRenderer';
import { useStickyOutput, type UseStickyOutputResult } from '../../src/hooks/useOutput';

let frames: FrameRequestCallback[];
const runFrame = () => { const due = frames; frames = []; for (const cb of due) cb(0); };

beforeEach(() => {
    document.body.replaceChildren();
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

/** Gives an element a fake scroll geometry the test controls. */
function fakeGeometry(el: HTMLElement, clientHeight = 100) {
    let height = clientHeight;
    let top = 0;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
    Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (v: number) => { top = Math.max(0, Math.min(v, height - clientHeight)); },
    });
    return { grow: (h: number) => { height = h; } };
}

describe('mudlet-web#456: renderer tail scroll', () => {
    function mount(split = { on: false }) {
        const wrapper = document.createElement('div');
        const sentinel = document.createElement('div');
        wrapper.appendChild(sentinel);
        const stickyArea = document.createElement('div');
        document.body.append(wrapper, stickyArea);
        const geo = fakeGeometry(wrapper);
        const suppress = vi.fn();
        const controls = setupOutputRenderer(null, {
            outputWrapper: wrapper, sentinel, stickyArea,
            isSplitView: () => split.on, stickyLines: 5, suppressSplitView: suppress,
        });
        return { wrapper, controls, suppress, split, ...geo };
    }

    it('re-arms the split-view suppression when the tail scroll runs, not only on append', () => {
        const { controls, suppress } = mount();
        controls.push('line', 'mud');
        suppress.mockClear();
        runFrame();
        expect(suppress).toHaveBeenCalledWith(250);
    });

    it('reports a queued tail scroll until the frame runs it', () => {
        const { controls } = mount();
        expect(controls.isTailScrollQueued()).toBe(false);
        controls.push('line', 'mud');
        expect(controls.isTailScrollQueued()).toBe(true);
        runFrame();
        expect(controls.isTailScrollQueued()).toBe(false);
    });

    it('a tail scroll queued before the reader entered split view leaves them where they are', () => {
        const { wrapper, controls, split, grow } = mount();
        controls.push('line', 'mud');
        grow(1000);
        wrapper.scrollTop = 300;
        split.on = true;
        runFrame();
        expect(wrapper.scrollTop).toBe(300);
    });
});

describe('mudlet-web#456: useStickyOutput under an echo burst', () => {
    let root: Root | null = null;
    afterEach(() => { act(() => { root?.unmount(); }); root = null; });

    function mount() {
        const seen: { current: UseStickyOutputResult | null } = { current: null };
        function Probe() {
            const r = useStickyOutput(null);
            seen.current = r;
            return createElement('div', null,
                createElement('div', null, createElement('div', { ref: r.stickyAreaRef })),
                createElement('div', { ref: r.outputRef }, createElement('div', { ref: r.sentinelRef })),
            );
        }
        const host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        act(() => { root!.render(createElement(Probe)); });
        const output = seen.current!.outputRef.current!;
        const geo = fakeGeometry(output);
        const scroll = () => act(() => { output.dispatchEvent(new Event('scroll')); });
        return { seen, output, scroll, ...geo };
    }

    it('a long frame after a burst does not drop the console into split view', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { seen, output, scroll, grow } = mount();
        const controls = seen.current!.controls!;

        for (let i = 0; i < 1000; i++) controls.push(`line ${i}`, 'script');
        grow(100_000);
        // Layout of the grown scrollback takes longer than the 250 ms window
        // armed when the lines were appended…
        vi.setSystemTime(Date.now() + 400);
        // …and a scroll event lands before the queued tail scroll runs.
        scroll();
        expect(seen.current!.isSplitView).toBe(false);

        act(() => runFrame());
        expect(output.scrollTop).toBe(100_000 - 100);

        // The next tick's lines arrive, and the scroll event the tail write
        // fired is only dispatched after another long frame.
        for (let i = 0; i < 1000; i++) controls.push(`more ${i}`, 'script');
        grow(200_000);
        vi.setSystemTime(Date.now() + 400);
        scroll();
        expect(seen.current!.isSplitView).toBe(false);

        act(() => runFrame());
        controls.push('MORE1', 'script');
        grow(200_020);
        act(() => runFrame());
        expect(output.scrollHeight - output.scrollTop - output.clientHeight).toBe(0);
        expect(seen.current!.isSplitView).toBe(false);
    });

    it('the reader scrolling up with nothing queued still opens split view', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { seen, output, scroll, grow } = mount();
        const controls = seen.current!.controls!;
        controls.push('line', 'mud');
        grow(5000);
        act(() => runFrame());
        vi.setSystemTime(Date.now() + 1000);
        output.scrollTop = 1000;
        scroll();
        expect(seen.current!.isSplitView).toBe(true);
    });
});
