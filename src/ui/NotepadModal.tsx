import { useCallback, useEffect, useRef, useState } from 'react';
import { ResizableModal } from './ResizableModal';
import { Button } from './components';
import type { ProfileVFS } from '../scripting/vfs/ProfileVFS';
import { useAppStore } from '../storage';
import { countInNotes, findInNotes, NOTES_FILE, NOTES_SAVE_DELAY_MS, readNotes, writeNotes } from './notepad';

interface NotepadModalProps {
    connectionId: string;
    connectionName: string;
    vfs: ProfileVFS | null;
    onClose: () => void;
}

type SaveState = 'saved' | 'pending' | 'error';

/**
 * Mudlet's Notepad: free text kept per profile in `notes.txt`. Written a beat
 * after typing stops, and again on close and when the page is hidden, so a
 * closed tab does not take the last sentence with it.
 *
 * Escape does not close it — dlgNotepad is a QMainWindow, and Escape there
 * closes the find bar (`dlgNotepad.cpp`). Ctrl+F opens that bar.
 */
export function NotepadModal({ connectionId, connectionName, vfs, onClose }: NotepadModalProps) {
    const savedBounds = useAppStore(s => s.connectionModalBounds[connectionId]?.['notepad']);
    const saveModalBounds = useAppStore(s => s.saveModalBounds);

    const [text, setText] = useState(() => (vfs ? readNotes(vfs) : ''));
    const [saveState, setSaveState] = useState<SaveState>('saved');
    const textRef = useRef(text);
    const dirtyRef = useRef(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const areaRef = useRef<HTMLTextAreaElement>(null);

    const [findOpen, setFindOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [matchCase, setMatchCase] = useState(false);
    const [notFound, setNotFound] = useState(false);
    const findRef = useRef<HTMLInputElement>(null);

    const save = useCallback(() => {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        if (!vfs || !dirtyRef.current) return;
        try {
            writeNotes(vfs, textRef.current);
            dirtyRef.current = false;
            setSaveState('saved');
        } catch (e) {
            console.warn('[Notepad] could not save notes:', e);
            setSaveState('error');
        }
    }, [vfs]);

    const onChange = (value: string) => {
        setText(value);
        textRef.current = value;
        dirtyRef.current = true;
        setSaveState('pending');
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(save, NOTES_SAVE_DELAY_MS);
    };

    // Save on close (unmount) and whenever the page is going away or hidden.
    useEffect(() => {
        const flush = () => save();
        const onVisibility = () => { if (document.visibilityState === 'hidden') save(); };
        window.addEventListener('pagehide', flush);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            window.removeEventListener('pagehide', flush);
            document.removeEventListener('visibilitychange', onVisibility);
            save();
        };
    }, [save]);

    useEffect(() => {
        if (findOpen) findRef.current?.select();
    }, [findOpen]);

    const find = (backwards: boolean) => {
        const area = areaRef.current;
        if (!area) return;
        const hit = findInNotes(text, query, area.selectionStart, area.selectionEnd, { backwards, matchCase });
        setNotFound(query !== '' && hit === null);
        if (!hit) return;
        area.focus();
        area.setSelectionRange(hit.start, hit.end);
        // Bring the match into view: a textarea scrolls to its caret on focus
        // only in some engines, so do it by line as a fallback.
        const lineHeight = parseFloat(getComputedStyle(area).lineHeight) || 18;
        const line = text.slice(0, hit.start).split('\n').length - 1;
        const top = line * lineHeight;
        if (top < area.scrollTop || top > area.scrollTop + area.clientHeight - lineHeight) {
            area.scrollTop = Math.max(0, top - area.clientHeight / 2);
        }
    };

    const closeFind = () => {
        setFindOpen(false);
        setNotFound(false);
        areaRef.current?.focus();
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        const mod = e.ctrlKey || e.metaKey;
        if (mod && !e.altKey && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            if (findOpen) findRef.current?.select();
            else setFindOpen(true);
        } else if (mod && !e.altKey && e.key.toLowerCase() === 's') {
            // Nothing to do that autosave has not, but the browser's own
            // "Save page" is never what is meant inside a text editor.
            e.preventDefault();
            save();
        } else if (e.key === 'F3') {
            e.preventDefault();
            if (!findOpen) setFindOpen(true);
            else find(e.shiftKey);
        }
    };

    const matches = findOpen ? countInNotes(text, query, matchCase) : 0;
    const status = !vfs ? null
        : saveState === 'error' ? <span className="notepad__status notepad__status--error">Not saved</span>
        : saveState === 'pending' ? <span className="notepad__status">Unsaved…</span>
        : <span className="notepad__status">Saved</span>;

    return (
        <ResizableModal
            title={`${connectionName} - Notes`}
            onClose={onClose}
            savedBounds={savedBounds}
            onBoundsChange={b => saveModalBounds(connectionId, 'notepad', b)}
            defaultW={560}
            defaultH={480}
            minW={280}
            minH={200}
            className="notepad"
            bodyClassName="notepad__body"
            headerExtra={status}
            closeOnEscape={false}
        >
            <div className="notepad__content" onKeyDown={onKeyDown}>
                {!vfs && (
                    <div className="notepad__warning" role="alert">
                        This profile’s file system is not mounted, so notes cannot be saved.
                    </div>
                )}
                <textarea
                    ref={areaRef}
                    className="notepad__text"
                    value={text}
                    onChange={e => onChange(e.target.value)}
                    onBlur={save}
                    spellCheck={false}
                    aria-label={`Notes for ${connectionName}, saved to ${NOTES_FILE} in the profile folder`}
                    disabled={!vfs}
                />
                {findOpen && (
                    <div className="notepad__find" role="search">
                        <input
                            ref={findRef}
                            className="notepad__find-input"
                            type="text"
                            value={query}
                            placeholder="Find"
                            aria-label="Find in notes"
                            aria-invalid={notFound}
                            onChange={e => { setQuery(e.target.value); setNotFound(false); }}
                            onKeyDown={e => {
                                if (e.key === 'Enter') { e.preventDefault(); find(e.shiftKey); }
                                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
                            }}
                        />
                        <span className="notepad__find-count" aria-live="polite">
                            {query === '' ? '' : matches === 0 ? 'No matches' : `${matches} match${matches === 1 ? '' : 'es'}`}
                        </span>
                        <label className="notepad__find-case">
                            <input type="checkbox" checked={matchCase} onChange={e => setMatchCase(e.target.checked)} />
                            Match case
                        </label>
                        <Button size="sm" variant="ghost" title="Previous match (Shift+Enter)" disabled={!query} onClick={() => find(true)}>↑</Button>
                        <Button size="sm" variant="ghost" title="Next match (Enter)" disabled={!query} onClick={() => find(false)}>↓</Button>
                        <Button size="sm" variant="ghost" title="Close find bar (Escape)" onClick={closeFind}>✕</Button>
                    </div>
                )}
            </div>
        </ResizableModal>
    );
}
