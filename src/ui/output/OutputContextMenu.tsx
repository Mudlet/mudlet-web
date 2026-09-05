import { ContextMenu } from '../components';

export interface OutputMenuExtraItem {
    label: string;
    tooltip?: string;
    onClick: () => void;
}

interface OutputContextMenuProps {
    x: number;
    y: number;
    /** Whether the selection touches this window (gates the copy actions). */
    hasSelection: boolean;
    /** Whether this console holds any line at all. "Copy as image" needs only
     *  this, since it falls back to the visible area. */
    hasContent: boolean;
    onSelectAll: () => void;
    onCopy: () => void;
    onCopyHtml: () => void;
    onCopyImage: () => void;
    /** Display name of the configured web-search engine, e.g. "Google". */
    searchEngine: string;
    onSearchOnline: () => void;
    /** Mudlet's "Analyse characters" — omitted unless the profile's "Enable
     *  text analyzer" preference is on, exactly as desktop gates it
     *  (TTextEdit::contextMenuEvent, src/TTextEdit.cpp:2482). */
    onAnalyseText?: () => void;
    /** Opens the find bar — only the main console passes this. */
    onFind?: () => void;
    /** Timestamp toggle — only the main console passes these. */
    showTimestamps?: boolean;
    onToggleTimestamps?: () => void;
    /** Script-provided entries (Mudlet addMouseEvent). */
    extraItems?: OutputMenuExtraItem[];
    onClose: () => void;
}

export function OutputContextMenu({
    x,
    y,
    hasSelection,
    hasContent,
    onSelectAll,
    onCopy,
    onCopyHtml,
    onCopyImage,
    searchEngine,
    onSearchOnline,
    onAnalyseText,
    onFind,
    showTimestamps,
    onToggleTimestamps,
    extraItems,
    onClose,
}: OutputContextMenuProps) {
    const run = (fn: () => void) => () => { fn(); onClose(); };
    // Mudlet spells out why an entry is greyed rather than leaving the user to
    // guess (`noSelectionHint` in TTextEdit::contextMenuEvent).
    const noSelection = hasSelection ? undefined : 'Select some text in the console first.';
    const noContent = hasContent ? undefined : 'This console is empty, there is nothing to copy.';

    return (
        <ContextMenu x={x} y={y} onClose={onClose}>
            <button className="ctx-menu__item" type="button" onClick={run(onSelectAll)}>
                <span className="ctx-menu__check" />
                Select all
            </button>
            <button
                className="ctx-menu__item"
                type="button"
                disabled={!hasSelection}
                title={noSelection}
                onClick={run(onCopy)}
            >
                <span className="ctx-menu__check" />
                Copy
            </button>
            <button
                className="ctx-menu__item"
                type="button"
                disabled={!hasSelection}
                title={noSelection}
                onClick={run(onCopyHtml)}
            >
                <span className="ctx-menu__check" />
                Copy as HTML
            </button>
            {/* Not gated on the selection: with none, this copies the visible
                area, so the only thing that can stop it is an empty console. */}
            <button
                className="ctx-menu__item"
                type="button"
                disabled={!hasContent}
                title={noContent}
                onClick={run(onCopyImage)}
            >
                <span className="ctx-menu__check" />
                Copy as image
            </button>

            <div className="ctx-menu__sep" />
            <button
                className="ctx-menu__item"
                type="button"
                disabled={!hasSelection}
                title={noSelection}
                onClick={run(onSearchOnline)}
            >
                <span className="ctx-menu__check" />
                Search on {searchEngine}
            </button>

            {/* Desktop only builds this entry when there is a selection at all,
                so there is no greyed-out state to inherit — but greying it, as
                the copy entries are greyed, says why it does nothing better
                than an entry that comes and goes. */}
            {onAnalyseText && (
                <button
                    className="ctx-menu__item"
                    type="button"
                    disabled={!hasSelection}
                    title={hasSelection
                        ? 'Show the Unicode codepoints in the selection (only the first line!)'
                        : noSelection}
                    onClick={run(onAnalyseText)}
                >
                    <span className="ctx-menu__check" />
                    Analyse characters
                </button>
            )}

            {onFind && (
                <>
                    <div className="ctx-menu__sep" />
                    <button className="ctx-menu__item" type="button" onClick={run(onFind)}>
                        <span className="ctx-menu__check" />
                        Find…
                        <span className="ctx-menu__shortcut">Ctrl+F</span>
                    </button>
                </>
            )}

            {onToggleTimestamps && (
                <>
                    <div className="ctx-menu__sep" />
                    <button className="ctx-menu__item" type="button" onClick={run(onToggleTimestamps)}>
                        <span className="ctx-menu__check">{showTimestamps ? '✓' : ''}</span>
                        Show timestamps
                    </button>
                </>
            )}

            {extraItems && extraItems.length > 0 && (
                <>
                    <div className="ctx-menu__sep" />
                    {extraItems.map((item, i) => (
                        <button
                            key={`${item.label}-${i}`}
                            className="ctx-menu__item"
                            type="button"
                            title={item.tooltip}
                            onClick={run(item.onClick)}
                        >
                            <span className="ctx-menu__check" />
                            {item.label}
                        </button>
                    ))}
                </>
            )}
        </ContextMenu>
    );
}
