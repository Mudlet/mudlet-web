import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from '../components/useModalFocus';
import { analyseText, byteToLuaCode, firstLineOf, hex } from '../../mud/text/textAnalyzer';

interface Props {
    /** The raw selection, as taken from the console. Trimmed to its first line
     *  here rather than by the caller, so the modal can say that it did. */
    selection: string;
    onClose: () => void;
}

/**
 * Mudlet's "Analyse characters" report (`TTextEdit::slot_analyseSelection`),
 * as a dialog rather than as a tooltip.
 *
 * Desktop builds the table into the context-menu item's tooltip and shows it on
 * hover, which works because a Qt tooltip can be arbitrarily large and stays up
 * while the menu does. In a browser the menu item is a `<button>` and its
 * `title` is a one-line string the OS draws — so the report gets a dialog of
 * its own, where it can also be selected and copied, which the tooltip never
 * allowed.
 *
 * The table is transposed from desktop's: Mudlet lays characters out across the
 * page in rows of about sixteen, which suits a fixed-size tooltip and means a
 * long selection wraps into a block. Here each character is a row, so the
 * columns stay aligned however long the selection is and the dialog scrolls
 * the way every other list in the app does.
 */
export function TextAnalyzerModal({ selection, onClose }: Props) {
    const ref = useModalFocus<HTMLDivElement>(onClose);
    const { line, truncated } = useMemo(() => firstLineOf(selection), [selection]);
    const rows = useMemo(() => analyseText(line), [line]);

    // Into <body>, not where it is declared. The dialog is opened from inside
    // the console, out of a selection that is still live behind it — and a node
    // inserted within a selected range is painted selected, so the whole table
    // came up in the browser's selection highlight. (Rendering under the console
    // would also inherit its font and colours, which the report is not.)
    return createPortal(
        <>
            <div className="modal-overlay" onClick={onClose} />
            <div
                ref={ref}
                className="modal analyzer-modal"
                role="dialog"
                aria-modal="true"
                aria-label="Analyse characters"
            >
                <div className="modal-header">
                    <span className="modal-title">Analyse characters</span>
                    <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
                </div>
                <div className="modal-body analyzer-body">
                    {truncated && (
                        <p className="settings-hint">
                            Only the first line of the selection is analysed, as in desktop Mudlet.
                        </p>
                    )}
                    {rows.length === 0 ? (
                        <p className="settings-hint">The selection is empty.</p>
                    ) : (
                        <table className="analyzer-table">
                            <thead>
                                <tr>
                                    <th scope="col" title="Position of the character in the line, counting UTF-16 code units as Lua's string library does not">#</th>
                                    <th scope="col" title="The character as the game drew it, or a name in braces for one that draws as nothing">Character</th>
                                    <th scope="col" title="The Unicode code point(s) making up this character">Code point</th>
                                    <th scope="col" title="Position of the character's first byte in the UTF-8 string Lua sees">Byte</th>
                                    <th scope="col" title="The character's bytes as Lua's string library stores them">UTF-8</th>
                                    <th scope="col" title="How to write this character inside a Lua string literal — paste this into a pattern to match a character you cannot type">Lua escape</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(row => (
                                    <tr key={row.utf16Index}>
                                        <td className="analyzer-num">{row.utf16Index}</td>
                                        <td className="analyzer-glyph">
                                            {row.label
                                                ? <span className="analyzer-label">{row.label}</span>
                                                : row.text}
                                        </td>
                                        <td className="analyzer-mono">
                                            {row.codePoints.map(cp => `U+${hex(cp, 4)}`).join(' ')}
                                        </td>
                                        <td className="analyzer-num">{row.utf8Index}</td>
                                        <td className="analyzer-mono">
                                            {row.utf8Bytes.map(b => `0x${hex(b, 2).toLowerCase()}`).join(' ')}
                                        </td>
                                        <td className="analyzer-mono">
                                            {row.utf8Bytes.map(byteToLuaCode).join('')}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        </>,
        document.body,
    );
}
