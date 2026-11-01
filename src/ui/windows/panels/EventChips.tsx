import { useRef, useState } from 'react';
import { Glyph } from '../../design/glyphs';

/**
 * A script's event handlers as desktop's editor shows them (ChipRow on the
 * `ui/design-language` branch): one chip per event name with a cross that
 * removes it, and a dashed "+ Add event" button that becomes a field while a
 * name is typed. Enter or a comma adds the name, Escape gives up, Backspace in
 * an empty field takes the last chip off.
 *
 * The value is the editor's existing newline-separated string, so the save
 * path and everything downstream of it are unchanged.
 */
export function EventChips({ value, onChange }: { value: string; onChange: (next: string) => void }) {
    const names = value.split('\n').map(s => s.trim()).filter(Boolean);
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    const commit = (list: string[]) => onChange(list.join('\n'));

    const add = () => {
        const name = draft.trim();
        if (name && !names.includes(name)) commit([...names, name]);
        setDraft('');
    };

    return (
        <div className="event-chips" role="group" aria-label="Events">
            {names.map(name => (
                <span key={name} className="ui-chip event-chips__chip">
                    {name}
                    <button
                        type="button"
                        className="event-chips__remove"
                        aria-label={`Remove event ${name}`}
                        title={`Remove ${name}`}
                        onClick={() => commit(names.filter(n => n !== name))}
                    >
                        <Glyph name="editor-clear" size={11} />
                    </button>
                </span>
            ))}
            {adding ? (
                <input
                    ref={inputRef}
                    className="event-chips__field"
                    autoFocus
                    value={draft}
                    placeholder="Event name"
                    aria-label="New event name"
                    spellCheck={false}
                    onChange={e => setDraft(e.target.value.replace(/,/g, ''))}
                    onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ',') {
                            e.preventDefault();
                            add();
                        } else if (e.key === 'Escape') {
                            e.stopPropagation();
                            setDraft('');
                            setAdding(false);
                        } else if (e.key === 'Backspace' && draft === '' && names.length > 0) {
                            commit(names.slice(0, -1));
                        }
                    }}
                    onBlur={() => { add(); setAdding(false); }}
                />
            ) : (
                <button type="button" className="event-chips__add" onClick={() => setAdding(true)}>
                    + Add event
                </button>
            )}
        </div>
    );
}
