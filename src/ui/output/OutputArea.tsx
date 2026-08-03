import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { MudSession } from '../../mud/MudSession';
import { useStickyOutput, DEFAULT_STICKY_LINES } from '../../hooks/useOutput';
import { useAppStore, useProfileField, useConnectionId } from '../../storage';
import { StickyOutputPanel } from './StickyOutputPanel';
import { OutputSearchBar } from './OutputSearchBar';
import { searchStepDirection } from './outputSearch';
import type { OutputMenuExtraItem } from './OutputContextMenu';
import { ScreenReaderLog } from './ScreenReaderLog';
import { CaretReviewPanel } from './CaretReviewPanel';
import { LabelOverlay } from '../labels/LabelOverlay';
import { CommandLineOverlay } from '../cmdline/CommandLineOverlay';
import { ScrollBoxOverlay } from '../scrollbox/ScrollBoxOverlay';
import { backgroundImageStyle } from './backgroundImageStyle';

interface OutputAreaProps {
    session: MudSession;
    stickyLines?: number;
    commandInputRef?: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
}

export function OutputArea({ session, stickyLines = DEFAULT_STICKY_LINES, commandInputRef }: OutputAreaProps) {
    const connectionId = useConnectionId();
    const outputBackgroundString = useProfileField('outputBackground');
    const outputBackgroundColor = useProfileField('outputBackgroundColor');
    const outputBackgroundImage = useProfileField('outputBackgroundImage');
    const outputBackground = outputBackgroundColor
        ? `rgba(${outputBackgroundColor.r}, ${outputBackgroundColor.g}, ${outputBackgroundColor.b}, ${outputBackgroundColor.a / 255})`
        : outputBackgroundString;
    const outputBackgroundExtra = backgroundImageStyle(outputBackgroundImage) ?? undefined;
    const outputForeground = useProfileField('outputForeground');
    const showTimestamps = useProfileField('showTimestamps');
    const fontSize = useProfileField('fontSize');
    const wrapAt = useProfileField('outputWrapAt');
    const wrapIndent = useProfileField('outputWrapIndent');
    const wrapHangingIndent = useProfileField('outputWrapHangingIndent');
    const borders = useProfileField('outputBorders');
    const borderColor = useProfileField('outputBorderColor');
    const patchConnectionProfile = useAppStore(s => s.patchConnectionProfile);
    // Mudlet's f3SearchEnabled — the accessibility mode for buffer search. See
    // the F3 effect below and OutputSearchBar's `a11ySearch` prop.
    const config = useProfileField('config');
    const a11ySearch = (config?.f3SearchEnabled as boolean | undefined) ?? false;

    const { outputRef, sentinelRef, stickyAreaRef, isSplitView, scrollToBottom, controls } =
        useStickyOutput(session.events, { stickyLines, showTimestamps });
    const viewportRef = useRef<HTMLDivElement>(null);
    const overlayHostRef = useRef<HTMLDivElement>(null);
    const [searchOpen, setSearchOpen] = useState(false);
    // Bumped on every Ctrl+F so a second press re-focuses and re-seeds the
    // already-open bar instead of being a no-op.
    const [searchFocusNonce, setSearchFocusNonce] = useState(0);

    // The split-view panel shows cloned lines, so search highlights only appear
    // there if it is rebuilt from the freshly marked originals. No-op when the
    // player is scrolled to the bottom and the panel is hidden.
    const isSplitViewRef = useRef(isSplitView);
    isSplitViewRef.current = isSplitView;
    const refreshSticky = useCallback(() => {
        if (isSplitViewRef.current) controls?.populateStickyArea();
    }, [controls]);

    const openSearch = useCallback(() => {
        setSearchOpen(true);
        setSearchFocusNonce(n => n + 1);
    }, []);

    // Ctrl/Cmd+F opens the find bar. Capture phase, like the quick-open palette
    // in ProfileSession, so it wins over the browser's own find. Skipped while
    // typing in a textarea or code editor, which own their own find.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
            // Match the physical key as well as the character. On a non-Latin
            // layout (Cyrillic, Greek) Ctrl+F reports `key` as that layout's
            // letter, and synthetic events may carry no `key` at all — either
            // way `code` still identifies the F key, so a layout switch does
            // not silently hand the shortcut back to the browser's own find.
            if (e.code !== 'KeyF' && e.key !== 'f' && e.key !== 'F') return;
            const target = e.target as HTMLElement | null;
            // The command line is itself a textarea and holds focus almost all
            // the time, so "focus is in a textarea" cannot mean "leave Ctrl+F
            // alone" — that hands the shortcut straight back to the browser.
            // Only a real code editor (the Lua script editor, contentEditable)
            // or some other textarea keeps it.
            if (target?.isContentEditable) return;
            if (target instanceof HTMLTextAreaElement && !target.classList.contains('command-input')) return;
            e.preventDefault();
            e.stopPropagation();
            openSearch();
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [openSearch]);

    // Mudlet's f3SearchEnabled: F3 / Shift+F3 reach buffer search even when the
    // find bar is closed. Mudlet's search box lives permanently in the console
    // toolbar, so its F3 always has something to drive; ours is a transient
    // overlay, so the key has to summon it first. Once open, the bar owns F3
    // (its own capture-phase handler steps through the results) — hence the
    // early-out on `searchOpenRef`, read through a ref so this listener does not
    // resubscribe on every open/close.
    //
    // With the setting off, F3 still steps an already-open bar; only this
    // bar-closed entry point is gated, so turning the default-false key on adds
    // reach rather than taking a working shortcut away.
    const searchOpenRef = useRef(searchOpen);
    searchOpenRef.current = searchOpen;
    useEffect(() => {
        if (!a11ySearch) return;
        const onKey = (e: KeyboardEvent) => {
            if (searchStepDirection(e) === null) return;
            if (searchOpenRef.current) return;
            e.preventDefault();
            openSearch();
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [a11ySearch, openSearch]);

    // Mudlet addMouseEvent: custom entries folded into the output right-click
    // menu. Evaluated lazily when the menu opens (the registry can change).
    const getMenuExtraItems = useCallback((): OutputMenuExtraItem[] =>
        session.mouseEvents.list().map(item => ({
            label: item.displayName,
            tooltip: item.tooltip || undefined,
            onClick: () => session.mouseEvents.dispatch(item.uniqueName),
        })), [session]);

    useEffect(() => {
        session.markOutputReady();
        return () => session.markOutputGone();
    }, [session]);

    useEffect(() => {
        session.windows.registerMainOutput(outputRef.current);
        session.windows.registerMainViewport(viewportRef.current);
        session.windows.registerMainOverlayHost(overlayHostRef.current);
        return () => {
            session.windows.registerMainOutput(null);
            session.windows.registerMainViewport(null);
            session.windows.registerMainOverlayHost(null);
        };
    }, [session, outputRef]);

    // Mudlet setBorderTop/Bottom/Left/Right insets the console; labels still
    // own the full main-viewport so they can be placed in the carved area.
    const contentStyle: React.CSSProperties = {
        paddingTop: borders?.top || undefined,
        paddingRight: borders?.right || undefined,
        paddingBottom: borders?.bottom || undefined,
        paddingLeft: borders?.left || undefined,
        background: borderColor
            ? `rgba(${borderColor.r}, ${borderColor.g}, ${borderColor.b}, ${borderColor.a / 255})`
            : undefined,
    };

    return (
        <>
            <div className="output-area-content" ref={viewportRef} style={contentStyle}>
                <StickyOutputPanel
                    outputRef={outputRef}
                    sentinelRef={sentinelRef}
                    stickyAreaRef={stickyAreaRef}
                    isSplitView={isSplitView}
                    scrollToBottom={scrollToBottom}
                    background={outputBackground}
                    backgroundExtra={outputBackgroundExtra}
                    foreground={outputForeground}
                    showTimestamps={showTimestamps}
                    onToggleTimestamps={() => connectionId && patchConnectionProfile(connectionId, { showTimestamps: !showTimestamps })}
                    onFind={openSearch}
                    getMenuExtraItems={getMenuExtraItems}
                    commandInputRef={commandInputRef}
                    fontSize={fontSize}
                    wrapAt={wrapAt}
                    wrapIndent={wrapIndent}
                    wrapHangingIndent={wrapHangingIndent}
                />
                <CaretReviewPanel session={session} commandInputRef={commandInputRef} />
                {searchOpen && (
                    <OutputSearchBar
                        session={session}
                        outputRef={outputRef}
                        focusNonce={searchFocusNonce}
                        onClose={() => setSearchOpen(false)}
                        refreshSticky={refreshSticky}
                        commandInputRef={commandInputRef}
                        a11ySearch={a11ySearch}
                    />
                )}
            </div>
            <ScreenReaderLog session={session} />
            {/* Establishes a stacking context (see .main-overlay-root in App.css) so
                these widgets' per-instance z-index ordinals (overlayLayerOrder.ts,
                bounded but arbitrary within it) stay contained below floating
                windows and app modals instead of leaking into the root stacking
                context and painting over them. Main-parented nested windows
                (mini-consoles, embedded mapper) are ALSO portaled into this same
                element (registerMainOverlayHost) — NOT a separate sibling — so a
                window's z-index and a label's z-index compete in ONE stacking
                context and the overlayZ ranks actually order them against each
                other. Portaling a window into any other wrapper reintroduces the
                "map paints over every label" bug. */}
            <div className="main-overlay-root" ref={overlayHostRef}>
                <LabelOverlay manager={session.labels} parent="main" />
                <CommandLineOverlay manager={session.cmdLines} parent="main" />
                <ScrollBoxOverlay manager={session.scrollBoxes} labels={session.labels} cmdLines={session.cmdLines} parent="main" />
            </div>
        </>
    );
}
