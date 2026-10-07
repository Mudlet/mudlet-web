// mudlet-web#443 item 2: every output update got slower as the main scrollback
// grew — the browser re-walked every row in PrePaint/Paint, and each line
// queued its own tail scroll that read scrollHeight.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setupOutputRenderer } from '../../src/ui/output/OutputRenderer';

const appCss = readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf8');

describe('mudlet-web#443: scrollback rendering cost', () => {
    let frames: FrameRequestCallback[];
    beforeEach(() => {
        document.body.replaceChildren();
        frames = [];
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    function mount(followTail?: () => boolean) {
        const wrapper = document.createElement('div');
        const sentinel = document.createElement('div');
        wrapper.appendChild(sentinel);
        const stickyArea = document.createElement('div');
        document.body.append(wrapper, stickyArea);
        let height = 0;
        const reads = { n: 0 };
        Object.defineProperty(wrapper, 'scrollHeight', { get: () => { reads.n++; return height; } });
        const controls = setupOutputRenderer(null, {
            outputWrapper: wrapper, sentinel, stickyArea,
            isSplitView: () => false, stickyLines: 5, followTail,
        });
        return { wrapper, controls, reads, grow: (h: number) => { height = h; } };
    }

    const runFrame = () => { const due = frames; frames = []; for (const cb of due) cb(0); };

    it('a burst of lines queues one tail scroll for the frame, not one per line', () => {
        const { wrapper, controls, reads, grow } = mount();
        for (let i = 0; i < 20; i++) controls.push(`line ${i}`, 'mud');
        expect(frames.length).toBe(1);
        grow(400);
        runFrame();
        expect(reads.n).toBe(1);
        expect(wrapper.scrollTop).toBe(400);

        // The next frame's lines queue a scroll of their own.
        controls.push('later', 'mud');
        expect(frames.length).toBe(1);
        grow(420);
        runFrame();
        expect(wrapper.scrollTop).toBe(420);
    });

    it('a console pinned to the top still skips the scroll, and re-arms after', () => {
        let follow = false;
        const { wrapper, controls, reads, grow } = mount(() => follow);
        controls.push('a', 'mud');
        grow(400);
        runFrame();
        expect(reads.n).toBe(0);
        expect(wrapper.scrollTop).toBe(0);
        follow = true;
        controls.push('b', 'mud');
        expect(frames.length).toBe(1);
        runFrame();
        expect(wrapper.scrollTop).toBe(400);
    });

    it('scrollback rows off screen skip rendering, as flat children of the scroller', () => {
        const rule = /\.output-wrapper\s*>\s*\.output-msg\s*\{([^}]*)\}/.exec(appCss);
        expect(rule).not.toBeNull();
        expect(rule![1]).toMatch(/content-visibility:\s*auto/);
        // A remembered height, so a wrapped row does not collapse off screen.
        expect(rule![1]).toMatch(/contain-intrinsic-block-size:\s*auto\b/);
    });
});
