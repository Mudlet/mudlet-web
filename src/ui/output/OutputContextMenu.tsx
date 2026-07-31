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
    onSelectAll: () => void;
    onCopy: () => void;
    onCopyHtml: () => void;
    onCopyImage: () => void;
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
    onSelectAll,
    onCopy,
    onCopyHtml,
    onCopyImage,
    onFind,
    showTimestamps,
    onToggleTimestamps,
    extraItems,
    onClose,
}: OutputContextMenuProps) {
    const run = (fn: () => void) => () => { fn(); onClose(); };

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
                onClick={run(onCopy)}
            >
                <span className="ctx-menu__check" />
                Copy
            </button>
            <button
                className="ctx-menu__item"
                type="button"
                disabled={!hasSelection}
                onClick={run(onCopyHtml)}
            >
                <span className="ctx-menu__check" />
                Copy as HTML
            </button>
            <button
                className="ctx-menu__item"
                type="button"
                disabled={!hasSelection}
                onClick={run(onCopyImage)}
            >
                <span className="ctx-menu__check" />
                Copy as image
            </button>

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
