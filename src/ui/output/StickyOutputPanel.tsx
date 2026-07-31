import { useState, useEffect, useRef, useCallback } from 'react';
import type React from 'react';
import { OutputContextMenu, type OutputMenuExtraItem } from './OutputContextMenu';
import { restoreFocusAfterLinkClick } from './linkNavigation';
import {
    hasSelectionIn, selectAll, copySelectionText,
    copySelectionAsHtml, copySelectionAsImage,
} from './outputCopy';

const DEFAULT_STICKY_HEIGHT = 160;
const MIN_STICKY_HEIGHT = 40;

interface StickyOutputPanelProps {
    outputRef: React.RefObject<HTMLDivElement | null>;
    sentinelRef: React.RefObject<HTMLDivElement | null>;
    stickyAreaRef: React.RefObject<HTMLDivElement | null>;
    isSplitView: boolean;
    scrollToBottom: () => void;
    background?: string;
    /** Extra CSS layered on top of `background` — used to add background-image
     *  / border-image properties from Mudlet setBackgroundImage. */
    backgroundExtra?: React.CSSProperties;
    foreground?: string;
    showTimestamps?: boolean;
    onToggleTimestamps?: () => void;
    /** Opens the find bar from the right-click menu — main console only. */
    onFind?: () => void;
    /** Script-provided right-click entries (Mudlet addMouseEvent), evaluated
     *  lazily when the menu opens since the registry can change. */
    getMenuExtraItems?: () => OutputMenuExtraItem[];
    commandInputRef?: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
    className?: string;
    fontSize?: number;
    fontFamily?: string;
    wrapAt?: number;
    wrapIndent?: number;
    wrapHangingIndent?: number;
}

export function StickyOutputPanel({
    outputRef, sentinelRef, stickyAreaRef,
    isSplitView, scrollToBottom,
    background, backgroundExtra, foreground, showTimestamps, onToggleTimestamps,
    onFind, getMenuExtraItems,
    commandInputRef, className, fontSize, fontFamily, wrapAt, wrapIndent, wrapHangingIndent,
}: StickyOutputPanelProps) {
    const [stickyHeight, setStickyHeight] = useState(DEFAULT_STICKY_HEIGHT);
    const [contextMenu, setContextMenu] =
        useState<{ x: number; y: number; hasSelection: boolean; extraItems: OutputMenuExtraItem[] } | null>(null);
    const stickyOuterRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const outer = stickyOuterRef.current;
        const output = outputRef.current;
        if (!outer || !output) return;

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            output.scrollTop += e.deltaY;
        };

        let touchStartY = 0;
        const onTouchStart = (e: TouchEvent) => { touchStartY = e.touches[0].clientY; };
        const onTouchMove = (e: TouchEvent) => {
            e.preventDefault();
            const deltaY = touchStartY - e.touches[0].clientY;
            output.scrollTop += deltaY;
            touchStartY = e.touches[0].clientY;
        };

        outer.addEventListener('wheel', onWheel, { passive: false });
        outer.addEventListener('touchstart', onTouchStart, { passive: true });
        outer.addEventListener('touchmove', onTouchMove, { passive: false });
        return () => {
            outer.removeEventListener('wheel', onWheel);
            outer.removeEventListener('touchstart', onTouchStart);
            outer.removeEventListener('touchmove', onTouchMove);
        };
    }, [outputRef]);

    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!commandInputRef) return;
        const target = e.target as Element;
        if (target.closest('a, button, input, select, textarea')) return;
        if (window.getSelection()?.toString()) return;
        commandInputRef.current?.focus();
    };

    // A link's own click handler stops propagation, so `handleClick` above never
    // sees one — clicking a link would otherwise leave focus on the link span
    // instead of the command line. Capture phase catches it on the way down.
    const handleClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!commandInputRef) return;
        restoreFocusAfterLinkClick(e, () => commandInputRef.current);
    };

    const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        // We own the output's right-click menu; stop it bubbling to ancestor
        // handlers (the OutputArea folds its script entries in via extraItems).
        e.stopPropagation();
        const container = outputRef.current;
        setContextMenu({
            x: e.clientX,
            y: e.clientY,
            hasSelection: container ? hasSelectionIn(container) : false,
            extraItems: getMenuExtraItems?.() ?? [],
        });
    }, [outputRef, getMenuExtraItems]);

    const runCopyAction = useCallback((action: (container: HTMLElement) => void | Promise<void>) => {
        const container = outputRef.current;
        if (!container) return;
        Promise.resolve(action(container)).catch(err =>
            console.error('Output copy action failed:', err));
    }, [outputRef]);

    const handleResizeStart = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const startY = e.clientY;
        const startHeight = stickyHeight;
        const maxHeight = Math.floor((stickyOuterRef.current?.parentElement?.clientHeight ?? 600) * 0.8);
        const onMove = (ev: MouseEvent) => {
            const delta = startY - ev.clientY;
            setStickyHeight(Math.max(MIN_STICKY_HEIGHT, Math.min(startHeight + delta, maxHeight)));
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    };

    const containerClass = ['output-container', className].filter(Boolean).join(' ');

    // Mudlet wrap indents: continuation lines are indented by wrapHangingIndent
    // (CSS padding-left), and newline-started lines by wrapIndent — expressed
    // relative to the continuation indent via text-indent.
    const indent = wrapIndent ?? 0;
    const hanging = wrapHangingIndent ?? 0;
    const indentStyle: React.CSSProperties = (indent > 0 || hanging > 0) ? {
        ['--wrap-hanging' as string]: `${hanging}ch`,
        ['--wrap-indent' as string]: `${indent - hanging}ch`,
    } : {};

    const wrapStyle: React.CSSProperties | undefined = (background || backgroundExtra || foreground || fontSize || fontFamily || (wrapAt && wrapAt > 0) || indent > 0 || hanging > 0) ? {
        ...(background ? { background } : {}),
        ...(backgroundExtra ?? {}),
        ...(foreground ? { color: foreground } : {}),
        ...(fontSize ? { fontSize: `${fontSize}pt` } : {}),
        ...(fontFamily ? { fontFamily: `${fontFamily}, monospace` } : {}),
        ...(wrapAt && wrapAt > 0 ? { ['--wrap-cols' as string]: `${wrapAt}ch` } : {}),
        ...indentStyle,
    } : undefined;

    return (
        <div className={containerClass} onClick={handleClick} onClickCapture={handleClickCapture}>
            <div
                className="output-wrapper"
                ref={outputRef}
                style={wrapStyle}
                onContextMenu={handleContextMenu}
            >
                <div ref={sentinelRef} style={{ height: 0 }} />
            </div>

            {isSplitView && (
                <div
                    className="output-sticky-handle"
                    style={{ bottom: stickyHeight }}
                    onMouseDown={handleResizeStart}
                />
            )}

            <div
                className={`output-sticky${isSplitView ? ' output-sticky--active' : ''}`}
                ref={stickyOuterRef}
                style={{
                    height: stickyHeight,
                    ...(background ? { background } : {}),
                    ...(backgroundExtra ?? {}),
                    ...(foreground ? { color: foreground } : {}),
                    ...(fontSize ? { fontSize: `${fontSize}pt` } : {}),
                    ...(fontFamily ? { fontFamily: `${fontFamily}, monospace` } : {}),
                    ...(wrapAt && wrapAt > 0 ? { ['--wrap-cols' as string]: `${wrapAt}ch` } : {}),
                    ...indentStyle,
                }}
            >
                <div className="output-sticky-content" ref={stickyAreaRef} />
            </div>

            {isSplitView && (
                <button
                    className="scroll-to-bottom"
                    style={{ bottom: stickyHeight + 8 }}
                    onClick={scrollToBottom}
                    type="button"
                    aria-label="Scroll to bottom"
                >
                    ↓ new output
                </button>
            )}

            {contextMenu && (
                <OutputContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    hasSelection={contextMenu.hasSelection}
                    onSelectAll={() => runCopyAction(selectAll)}
                    onCopy={() => runCopyAction(copySelectionText)}
                    onCopyHtml={() => runCopyAction(copySelectionAsHtml)}
                    onCopyImage={() => runCopyAction(copySelectionAsImage)}
                    onFind={onFind}
                    showTimestamps={showTimestamps ?? false}
                    onToggleTimestamps={onToggleTimestamps}
                    extraItems={contextMenu.extraItems}
                    onClose={() => setContextMenu(null)}
                />
            )}
        </div>
    );
}
