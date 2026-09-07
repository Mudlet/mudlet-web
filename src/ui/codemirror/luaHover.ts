import { EditorView, hoverTooltip } from '@codemirror/view';
import { HOVER_MAP } from '../../scripting/lua/luaCompletions';

// Lua-specific hover tooltip styling — bolted on top of the shared chrome.
export const luaHoverTheme = EditorView.theme({
    '.cm-lua-hover': {
        padding: '6px 10px',
        fontFamily: 'var(--font-mono)',
        fontSize: '12px',
        maxWidth: '360px',
    },
    '.cm-lua-hover__header': {
        display: 'flex',
        alignItems: 'baseline',
        gap: '2px',
        flexWrap: 'wrap',
    },
    '.cm-lua-hover__name': {
        color: 'var(--accent)',
        fontWeight: '500',
    },
    '.cm-lua-hover__sig': {
        color: 'var(--text-dim)',
    },
    '.cm-lua-hover__info': {
        marginTop: '5px',
        color: 'var(--text-dim)',
        fontSize: '11px',
        lineHeight: '1.5',
    },
});

/** Signature + description for the Mudlet function under the pointer. Shared by
 *  the script editor and by a `.lua` file opened from the file browser — the
 *  same code deserves the same tooltip whichever door you came in through. */
export const luaHover = hoverTooltip((view, pos) => {
    const word = view.state.wordAt(pos);
    if (!word) return null;

    const label = view.state.sliceDoc(word.from, word.to);
    if (!label || !/^[a-zA-Z_]/.test(label)) return null;

    // Walk left to pick up any dotted namespace prefix (e.g. "mudlet.windows.")
    const lookback = view.state.sliceDoc(Math.max(0, word.from - 60), word.from);
    const prefixMatch = lookback.match(/([\w.]+\.)$/);
    const prefix = prefixMatch ? prefixMatch[1] : '';
    const fullName = prefix + label;

    // Most-specific match first, then bare label as fallback
    const entry = HOVER_MAP.get(fullName) ?? HOVER_MAP.get(label);
    if (!entry) return null;

    const infoText = typeof entry.info === 'string' ? entry.info : null;
    if (!entry.detail && !infoText) return null;

    return {
        pos: word.from,
        end: word.to,
        above: true,
        arrow: true,
        create() {
            const dom = document.createElement('div');
            dom.className = 'cm-lua-hover';

            const header = document.createElement('div');
            header.className = 'cm-lua-hover__header';

            const nameEl = document.createElement('span');
            nameEl.className = 'cm-lua-hover__name';
            nameEl.textContent = fullName;
            header.appendChild(nameEl);

            if (entry.detail) {
                const sigEl = document.createElement('span');
                sigEl.className = 'cm-lua-hover__sig';
                sigEl.textContent = entry.detail;
                header.appendChild(sigEl);
            }

            dom.appendChild(header);

            if (infoText) {
                const infoEl = document.createElement('div');
                infoEl.className = 'cm-lua-hover__info';
                infoEl.textContent = infoText;
                dom.appendChild(infoEl);
            }

            return { dom };
        },
    };
});
