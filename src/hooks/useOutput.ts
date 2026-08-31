import { useEffect, useRef, useCallback, useState } from 'react';
import { setupOutputRenderer, type OutputRendererControls, type MessageSource } from '../ui/output/OutputRenderer';

export const DEFAULT_STICKY_LINES = 50;

export interface UseStickyOutputOptions {
    stickyLines?: number;
    splitViewThreshold?: number;
    showTimestamps?: boolean;
    /** See OutputHandlerOptions.followTail. Omit for a normal scrollback. */
    followTail?: () => boolean;
}

export interface UseStickyOutputResult {
    outputRef: React.RefObject<HTMLDivElement | null>;
    sentinelRef: React.RefObject<HTMLDivElement | null>;
    stickyAreaRef: React.RefObject<HTMLDivElement | null>;
    isSplitView: boolean;
    scrollToBottom: () => void;
    controls: OutputRendererControls | null;
}

export function useStickyOutput(
    source: MessageSource | null,
    {
        stickyLines = DEFAULT_STICKY_LINES,
        splitViewThreshold = 1,
        showTimestamps = false,
        followTail,
    }: UseStickyOutputOptions = {},
): UseStickyOutputResult {
    // Held in a ref so the renderer — set up once — always calls through to the
    // caller's current predicate, and so a changing identity never re-runs the
    // setup effect (which would tear down and rebuild the console).
    const followTailRef = useRef(followTail);
    followTailRef.current = followTail;
    const outputRef = useRef<HTMLDivElement>(null);
    const sentinelRef = useRef<HTMLDivElement>(null);
    const stickyAreaRef = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<OutputRendererControls | null>(null);

    const isSplitViewRef = useRef(false);
    const suppressUntilRef = useRef(0);

    const [isSplitView, setIsSplitView] = useState(false);
    const [controls, setControls] = useState<OutputRendererControls | null>(null);

    // Toggle the sticky panel in one synchronous tick: populate/clear its
    // content AND flip its visibility class together, so they paint in the same
    // frame as the scroll. Relying on React state alone for visibility lags the
    // synchronous content change by a frame, which shows as a blink — an empty
    // panel flashing on the way down, or the latest lines vanishing on the way
    // up. React state is still updated for the resize handle / scroll-to-bottom
    // button, where a one-frame lag is harmless.
    const applySplitView = useCallback((next: boolean) => {
        isSplitViewRef.current = next;
        setIsSplitView(next);
        const outer = stickyAreaRef.current?.parentElement;
        if (next) {
            rendererRef.current?.populateStickyArea();
            outer?.classList.add('output-sticky--active');
        } else {
            outer?.classList.remove('output-sticky--active');
            rendererRef.current?.clearStickyArea();
        }
    }, []);

    const scrollToBottom = useCallback(() => {
        const el = outputRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        applySplitView(false);
    }, [applySplitView]);

    const handleScroll = useCallback(() => {
        const el = outputRef.current;
        if (!el || Date.now() < suppressUntilRef.current) return;
        const distFromBottom = Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
        const next = distFromBottom > splitViewThreshold;
        if (next !== isSplitViewRef.current) {
            applySplitView(next);
        }
    }, [splitViewThreshold, applySplitView]);

    // Fires before the browser scrolls — lets us show the sticky with zero visual delay.
    const handleWheel = useCallback((e: WheelEvent) => {
        const el = outputRef.current;
        if (!el || isSplitViewRef.current || Date.now() < suppressUntilRef.current) return;
        if (e.deltaY < 0) {
            const distFromBottom = Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
            if (distFromBottom <= splitViewThreshold) {
                applySplitView(true);
            }
        }
    }, [splitViewThreshold, applySplitView]);

    // Resizing the console must not cost the reader their place at the tail.
    //
    // Scroll offset is measured from the top, so when the viewport grows or
    // shrinks the distance to the bottom changes even though nothing was
    // scrolled — a console pinned to its newest line comes back showing its
    // oldest. No scroll event fires to correct it either, because nothing
    // scrolled: the box changed underneath.
    //
    // Only re-pins when the reader was already following the tail. Someone who
    // scrolled up to read (isSplitView) is left exactly where they were, which
    // is the entire point of having scrolled up.
    //
    // The suppression window is not belt-and-braces. scrollHeight is still the
    // pre-resize height when the observer runs — the console has not re-wrapped
    // yet — so this scroll lands short of the true bottom, and the scroll event
    // it fires reads to handleScroll as "the reader scrolled up" and raises the
    // sticky panel. Suppressing marks the scroll as ours, and the frame after
    // lands it on the height the re-wrap actually produced.
    useEffect(() => {
        const el = outputRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const pin = () => {
            if (isSplitViewRef.current) return;
            suppressUntilRef.current = Date.now() + 150;
            el.scrollTop = el.scrollHeight;
        };
        const observer = new ResizeObserver(() => {
            pin();
            requestAnimationFrame(pin);
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const outputEl = outputRef.current;
        const sentinelEl = sentinelRef.current;
        const stickyAreaEl = stickyAreaRef.current;
        if (!outputEl || !sentinelEl || !stickyAreaEl) return;

        outputEl.addEventListener('scroll', handleScroll, { passive: true });
        outputEl.addEventListener('wheel', handleWheel, { passive: true });

        const c = setupOutputRenderer(source, {
            outputWrapper: outputEl,
            sentinel: sentinelEl,
            stickyArea: stickyAreaEl,
            isSplitView: () => isSplitViewRef.current,
            stickyLines,
            suppressSplitView: (ms) => {
                suppressUntilRef.current = Date.now() + ms;
            },
            followTail: () => followTailRef.current?.() ?? true,
        });
        c.setTimestampVisibility(showTimestamps);
        rendererRef.current = c;
        setControls(c);

        return () => {
            rendererRef.current = null;
            setControls(null);
            outputEl.removeEventListener('scroll', handleScroll);
            outputEl.removeEventListener('wheel', handleWheel);
            c.teardown();
        };
    }, [source, handleScroll, handleWheel, stickyLines]);

    useEffect(() => {
        rendererRef.current?.setTimestampVisibility(showTimestamps);
    }, [showTimestamps]);

    return { outputRef, sentinelRef, stickyAreaRef, isSplitView, scrollToBottom, controls };
}
