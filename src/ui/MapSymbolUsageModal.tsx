import { useMemo } from 'react';
import { useModalFocus } from './components/useModalFocus';
import { hex } from '../mud/text/textAnalyzer';

/** Desktop lists at most this many room ids per symbol and says so, "otherwise
 *  the whole dialog could be filled completely for a symbol that is used
 *  extensively e.g. on a wilderness type map" (dlgProfilePreferences.cpp:4220). */
const MAX_ROOMS_LISTED = 32;

interface Props {
    /** Each distinct symbol with the rooms carrying it, commonest first —
     *  `MapStore.roomSymbolUsage()`. */
    usage: { symbol: string; rooms: number[] }[];
    /** A ready-to-use CSS `font-family` value — the same stack the renderer is
     *  given (`applyMapperSettings`), so the sample column shows the symbol as
     *  the map draws it rather than as the UI font draws it. The caller
     *  composes it; a raw family name from the profile has to go through
     *  `cssFontFamilyLiteral` first. */
    symbolFont: string;
    onClose: () => void;
}

/**
 * Mudlet's "Show symbol usage…" dialog (`dlgProfilePreferences::showMapGlyph\
 * Usage` → `generateMapGlyphDisplay`, and the `glyph_usage.ui` table it fills).
 *
 * Desktop's table has six columns; this has four. The two that are missing are
 * its pair of sample cells — the symbol drawn with only the chosen font, and
 * drawn with any font the system has — together with the status icon that says
 * which of the two worked. All three answer one question, "can this font draw
 * this symbol", and it needs per-glyph coverage testing: `QFontMetrics::in\
 * FontUcs4`, which has no browser counterpart. `mudlet-map-renderer` draws the
 * string and lets the browser fall back, so the client cannot tell a symbol it
 * drew from one the fallback drew — and neither can this dialog. The columns it
 * does have are the ones the report is really for: which symbols a map uses,
 * how heavily, and where.
 */
export function MapSymbolUsageModal({ usage, symbolFont, onClose }: Props) {
    const ref = useModalFocus<HTMLDivElement>(onClose);

    const rows = useMemo(() => usage.map(entry => ({
        ...entry,
        // Code points, not UTF-16 units: a symbol outside the BMP is one
        // code point written as two units, and U+1F332 is what a player would
        // look up. Desktop uses `QString::toUcs4` for the same reason.
        codePoints: [...entry.symbol].map(ch => ch.codePointAt(0)!),
    })), [usage]);

    return (
        <>
            <div className="modal-overlay" onClick={onClose} />
            <div
                ref={ref}
                className="modal symbol-usage-modal"
                role="dialog"
                aria-modal="true"
                aria-label="Map symbol usage"
            >
                <div className="modal-header">
                    <span className="modal-title">Map symbol usage</span>
                    <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
                </div>
                <div className="modal-body">
                    {rows.length === 0 ? (
                        <p className="settings-hint">
                            No room in this map carries a symbol. Mapper scripts set them with
                            {' '}<code>setRoomChar</code>.
                        </p>
                    ) : (
                        <table className="symbol-usage-table">
                            <thead>
                                <tr>
                                    <th scope="col">Symbol</th>
                                    <th scope="col" title="The Unicode code point(s) the symbol is made of">Code point</th>
                                    <th scope="col" title="How many rooms in the whole map have this symbol">Rooms</th>
                                    <th scope="col" title={`The rooms with this symbol, up to ${MAX_ROOMS_LISTED}`}>Room ids</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(row => (
                                    <tr key={row.symbol}>
                                        <td
                                            className="symbol-usage-glyph"
                                            style={{ fontFamily: symbolFont }}
                                        >
                                            {row.symbol}
                                        </td>
                                        <td className="symbol-usage-code">
                                            {row.codePoints.map(cp => `U+${hex(cp, 4)}`).join(' ')}
                                        </td>
                                        <td className="symbol-usage-count">{row.rooms.length}</td>
                                        <td className="symbol-usage-rooms">
                                            {row.rooms.slice(0, MAX_ROOMS_LISTED).join(', ')}
                                            {row.rooms.length > MAX_ROOMS_LISTED && (
                                                <span className="settings-hint"> more — not shown…</span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        </>
    );
}
