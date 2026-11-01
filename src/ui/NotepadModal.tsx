import { useCallback, useEffect, useRef, useState } from 'react';
import { ResizableModal } from './ResizableModal';
import { Button, ContextMenu } from './components';
import type { ProfileVFS } from '../scripting/vfs/ProfileVFS';
import { useAppStore } from '../storage';
import {
    closeTab, countInNotes, findInNotes, lineAt, lineToSend, loadNotepad, moveTab, saveNotepad,
    NEW_TAB_NAME, NOTES_FILE, NOTES_SAVE_DELAY_MS, NOTES_SEND_INTERVAL_MS, type NotepadData,
} from './notepad';

interface NotepadModalProps {
    connectionId: string;
    connectionName: string;
    vfs: ProfileVFS | null;
    /** Sends one command as if typed — aliases and the local echo included,
     *  as desktop's `Host::send` does for the notepad's send buttons. */
    onSend: (command: string) => void;
    onClose: () => void;
}

type SaveState = 'saved' | 'pending' | 'error';

/**
 * Mudlet's Notepad (`dlgNotepad`): named tabs of free text kept per profile in
 * `notes.json`, with a find bar and controls that send the notes to the game
 * line by line.
 *
 * Written a beat after typing stops, on every tab change, on close and when the
 * page is hidden, so a closed browser tab does not take the last sentence with
 * it. Escape does not close the window — dlgNotepad is a QMainWindow, and
 * Escape there closes the find bar.
 */
export function NotepadModal({ connectionId, connectionName, vfs, onSend, onClose }: NotepadModalProps) {
    const savedBounds = useAppStore(s => s.connectionModalBounds[connectionId]?.['notepad']);
    const saveModalBounds = useAppStore(s => s.saveModalBounds);
    const sendControls = useAppStore(s => s.connectionProfile[connectionId]?.notepadSendControls === true);
    const patchProfile = useAppStore(s => s.patchConnectionProfile);

    const [data, setData] = useState<NotepadData>(() => (vfs
        ? loadNotepad(vfs)
        : { tabs: [{ name: 'Notes', content: '' }], activeTab: 0 }));
    const [saveState, setSaveState] = useState<SaveState>('saved');
    const dataRef = useRef(data);
    const dirtyRef = useRef(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // One textarea per tab, kept mounted, so each keeps its own caret, scroll
    // and undo history the way each of desktop's QPlainTextEdits does.
    const areas = useRef(new Map<NoteTabKey, HTMLTextAreaElement>());
    const [keys, setKeys] = useState<NoteTabKey[]>(() => data.tabs.map(newKey));

    const [renaming, setRenaming] = useState<number | null>(null);
    const [menu, setMenu] = useState<{ x: number; y: number; index: number | null } | null>(null);
    const dragFrom = useRef<number | null>(null);

    const [findOpen, setFindOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [notFound, setNotFound] = useState(false);
    const findRef = useRef<HTMLInputElement>(null);

    const [prepend, setPrepend] = useState('');
    const [sending, setSending] = useState(false);
    const sendTimer = useRef<ReturnType<typeof setInterval> | null>(null);

    const save = useCallback(() => {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        if (!vfs || !dirtyRef.current) return;
        try {
            saveNotepad(vfs, dataRef.current);
            dirtyRef.current = false;
            setSaveState('saved');
        } catch (e) {
            console.warn('[Notepad] could not save notes:', e);
            setSaveState('error');
        }
    }, [vfs]);

    /** Apply a change; `immediate` saves now (tab operations), otherwise after
     *  typing pauses. */
    const update = (next: NotepadData, immediate = false) => {
        dataRef.current = next;
        setData(next);
        dirtyRef.current = true;
        setSaveState('pending');
        if (timerRef.current) clearTimeout(timerRef.current);
        if (immediate) save();
        else timerRef.current = setTimeout(save, NOTES_SAVE_DELAY_MS);
    };

    useEffect(() => {
        const onVisibility = () => { if (document.visibilityState === 'hidden') save(); };
        window.addEventListener('pagehide', save);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            window.removeEventListener('pagehide', save);
            document.removeEventListener('visibilitychange', onVisibility);
            save();
        };
    }, [save]);

    const stopSending = useCallback(() => {
        if (sendTimer.current) { clearInterval(sendTimer.current); sendTimer.current = null; }
        setSending(false);
    }, []);
    useEffect(() => stopSending, [stopSending]);

    const active = data.activeTab;
    const activeKey = keys[active];
    const activeText = data.tabs[active]?.content ?? '';
    const currentArea = () => areas.current.get(keys[dataRef.current.activeTab]);

    const selectTab = (index: number) => {
        if (index === data.activeTab) return;
        update({ ...data, activeTab: index });
    };

    const addTab = () => {
        const next = { tabs: [...data.tabs, { name: NEW_TAB_NAME, content: '' }], activeTab: data.tabs.length };
        setKeys(k => [...k, newKey()]);
        update(next, true);
        requestAnimationFrame(() => currentArea()?.focus());
    };

    const removeTab = (index: number) => {
        const next = closeTab(data, index);
        if (next === data) return;
        setKeys(k => k.filter((_, i) => i !== index));
        update(next, true);
    };

    const closeOthers = (index: number) => {
        if (data.tabs.length <= 1) return;
        setKeys(k => [k[index]]);
        update({ tabs: [data.tabs[index]], activeTab: 0 }, true);
    };

    const rename = (index: number, name: string) => {
        setRenaming(null);
        const trimmed = name.trim();
        // Desktop ignores an empty or unchanged name.
        if (trimmed === '' || trimmed === data.tabs[index].name) return;
        update({ ...data, tabs: data.tabs.map((t, i) => (i === index ? { ...t, name: trimmed } : t)) }, true);
    };

    const reorder = (from: number, to: number) => {
        const next = moveTab(data, from, to);
        if (next === data) return;
        setKeys(k => { const out = k.slice(); const [m] = out.splice(from, 1); out.splice(to, 0, m); return out; });
        update(next, true);
    };

    const setText = (value: string) => {
        update({ ...data, tabs: data.tabs.map((t, i) => (i === active ? { ...t, content: value } : t)) });
    };

    // ── Find ───────────────────────────────────────────────────────────────
    useEffect(() => { if (findOpen) findRef.current?.select(); }, [findOpen]);

    const selectMatch = (area: HTMLTextAreaElement, start: number, end: number) => {
        area.setSelectionRange(start, end);
        // A textarea only scrolls to a selection it was given while focused in
        // some engines, so bring the match's line into view by hand.
        const lineHeight = parseFloat(getComputedStyle(area).lineHeight) || 18;
        const top = (area.value.slice(0, start).split('\n').length - 1) * lineHeight;
        if (top < area.scrollTop || top > area.scrollTop + area.clientHeight - lineHeight) {
            area.scrollTop = Math.max(0, top - area.clientHeight / 2);
        }
    };

    const find = (backwards: boolean, fromStart = false, q = query) => {
        const area = currentArea();
        if (!area || q === '') { setNotFound(false); return; }
        const hit = findInNotes(area.value, q, fromStart ? 0 : area.selectionStart, fromStart ? 0 : area.selectionEnd, backwards);
        setNotFound(hit === null);
        if (hit) selectMatch(area, hit.start, hit.end);
    };

    const closeFind = () => {
        setFindOpen(false);
        setNotFound(false);
        currentArea()?.focus();
    };

    // ── Sending ────────────────────────────────────────────────────────────
    const startSending = (lines: string[]) => {
        stopSending();
        const queue = lines.slice();
        const pre = prepend;
        setSending(true);
        sendTimer.current = setInterval(() => {
            if (queue.length === 0) { stopSending(); return; }
            const out = lineToSend(queue.shift()!, pre);
            if (out !== null) onSend(out);
        }, NOTES_SEND_INTERVAL_MS);
    };

    const sendAll = () => startSending(activeText.split('\n'));
    const sendLine = () => {
        const area = currentArea();
        const line = area ? lineAt(area.value, area.selectionStart) : '';
        if (line !== '') startSending([line]);
    };
    const sendSelection = () => {
        const area = currentArea();
        const sel = area ? area.value.slice(area.selectionStart, area.selectionEnd) : '';
        if (sel !== '') startSending(sel.split('\n'));
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
        const key = e.key.toLowerCase();
        if (mod && key === 'f') {
            e.preventDefault();
            if (findOpen) findRef.current?.select(); else setFindOpen(true);
        } else if (mod && key === 't') {
            // Desktop's new-tab key. Most browsers keep Ctrl+T for themselves
            // and never deliver it; where it does arrive, it does what it says.
            e.preventDefault();
            addTab();
        } else if (mod && key === 's') {
            // Autosave has it covered, and the browser's "Save page" is never
            // what is meant inside a text editor.
            e.preventDefault();
            save();
        } else if (e.key === 'F3') {
            e.preventDefault();
            if (!findOpen) setFindOpen(true); else find(e.shiftKey);
        }
    };

    const matches = findOpen ? countInNotes(activeText, query) : 0;
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
            defaultW={640}
            defaultH={480}
            minW={320}
            minH={220}
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
                <div
                    className="notepad__tabs"
                    role="tablist"
                    aria-label="Notes"
                    onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, index: null }); }}
                >
                    {data.tabs.map((tab, i) => (
                        <div
                            key={keys[i]}
                            className={`notepad__tab${i === active ? ' notepad__tab--active' : ''}`}
                            role="tab"
                            aria-selected={i === active}
                            tabIndex={i === active ? 0 : -1}
                            draggable={renaming !== i}
                            onDragStart={e => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move'; }}
                            onDragOver={e => { if (dragFrom.current !== null) e.preventDefault(); }}
                            onDrop={e => {
                                e.preventDefault();
                                if (dragFrom.current !== null) reorder(dragFrom.current, i);
                                dragFrom.current = null;
                            }}
                            onDragEnd={() => { dragFrom.current = null; }}
                            onClick={() => selectTab(i)}
                            onDoubleClick={() => setRenaming(i)}
                            onContextMenu={e => {
                                e.preventDefault();
                                e.stopPropagation();
                                setMenu({ x: e.clientX, y: e.clientY, index: i });
                            }}
                            onKeyDown={e => {
                                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                                    e.preventDefault();
                                    const n = data.tabs.length;
                                    selectTab((i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n);
                                } else if (e.key === 'F2') {
                                    e.preventDefault();
                                    setRenaming(i);
                                }
                            }}
                            title={tab.name}
                        >
                            {renaming === i ? (
                                <input
                                    className="notepad__tab-rename"
                                    defaultValue={tab.name}
                                    aria-label="New name"
                                    autoFocus
                                    onFocus={e => e.target.select()}
                                    onClick={e => e.stopPropagation()}
                                    onBlur={e => rename(i, e.target.value)}
                                    onKeyDown={e => {
                                        e.stopPropagation();
                                        if (e.key === 'Enter') rename(i, e.currentTarget.value);
                                        else if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
                                    }}
                                />
                            ) : (
                                <span className="notepad__tab-name">{tab.name}</span>
                            )}
                            {data.tabs.length > 1 && (
                                <button
                                    type="button"
                                    className="notepad__tab-close"
                                    title="Close tab"
                                    aria-label={`Close ${tab.name}`}
                                    tabIndex={-1}
                                    onClick={e => { e.stopPropagation(); removeTab(i); }}
                                >✕</button>
                            )}
                        </div>
                    ))}
                    <button
                        type="button"
                        className="notepad__tab-add"
                        title="Add new note tab (Ctrl+T)"
                        aria-label="Add new note tab"
                        onClick={addTab}
                    >+</button>
                </div>

                <div className="notepad__pages">
                    {data.tabs.map((tab, i) => (
                        <textarea
                            key={keys[i]}
                            ref={el => { if (el) areas.current.set(keys[i], el); else areas.current.delete(keys[i]); }}
                            className="notepad__text"
                            hidden={i !== active}
                            value={tab.content}
                            onChange={e => setText(e.target.value)}
                            onBlur={save}
                            spellCheck={false}
                            role="tabpanel"
                            aria-label={`${tab.name} — notes for ${connectionName}, saved to ${NOTES_FILE} in the profile folder`}
                            disabled={!vfs}
                            autoFocus={keys[i] === activeKey}
                        />
                    ))}
                </div>

                {findOpen && (
                    <div className="notepad__find" role="search">
                        <input
                            ref={findRef}
                            className="notepad__find-input"
                            type="text"
                            value={query}
                            placeholder="Find"
                            aria-label="Find in note"
                            aria-invalid={notFound}
                            onChange={e => {
                                setQuery(e.target.value);
                                // As desktop: typing searches again from the top.
                                find(false, true, e.target.value);
                            }}
                            onKeyDown={e => {
                                if (e.key === 'Enter') { e.preventDefault(); find(e.shiftKey); }
                                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
                            }}
                        />
                        <span className="notepad__find-count" aria-live="polite">
                            {query === '' ? '' : matches === 0 ? 'No matches' : `${matches} match${matches === 1 ? '' : 'es'}`}
                        </span>
                        <Button size="sm" variant="ghost" title="Find previous (Shift+Enter)" disabled={!query} onClick={() => find(true)}>↑</Button>
                        <Button size="sm" variant="ghost" title="Find next (Enter)" disabled={!query} onClick={() => find(false)}>↓</Button>
                        <Button size="sm" variant="ghost" title="Close find bar (Escape)" onClick={closeFind}>✕</Button>
                    </div>
                )}

                <div className="notepad__toolbar">
                    <button
                        type="button"
                        className="notepad__send-toggle"
                        aria-expanded={sendControls}
                        aria-label="Send controls"
                        title={sendControls ? 'Hide send controls' : 'Show send controls'}
                        onClick={() => patchProfile(connectionId, { notepadSendControls: !sendControls })}
                    >{sendControls ? '▾' : '▸'}</button>
                    {sendControls && (
                        <>
                            <Button size="sm" variant="secondary" onClick={sendAll}>Send all</Button>
                            <Button size="sm" variant="secondary" onClick={sendLine}>Send line</Button>
                            <Button size="sm" variant="secondary" onClick={sendSelection}>Send selection</Button>
                            <span className="notepad__toolbar-sep" />
                            <label className="notepad__prepend">
                                Prepend
                                <input
                                    type="search"
                                    value={prepend}
                                    placeholder="Text to prepend to lines"
                                    onChange={e => setPrepend(e.target.value)}
                                />
                            </label>
                            <Button size="sm" variant="secondary" disabled={!sending} onClick={stopSending}>Stop</Button>
                        </>
                    )}
                </div>
            </div>

            {menu && (
                <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} label="Note tab actions">
                    <button type="button" className="ctx-menu__item" onClick={() => { setMenu(null); addTab(); }}>New Tab</button>
                    {menu.index !== null && (
                        <>
                            <div className="ctx-menu__sep" role="separator" />
                            <button type="button" className="ctx-menu__item" onClick={() => { setMenu(null); setRenaming(menu.index); }}>Rename Tab</button>
                            {data.tabs.length > 1 && (
                                <>
                                    <button type="button" className="ctx-menu__item" onClick={() => { setMenu(null); removeTab(menu.index!); }}>Close Tab</button>
                                    <div className="ctx-menu__sep" role="separator" />
                                    <button type="button" className="ctx-menu__item" onClick={() => { setMenu(null); closeOthers(menu.index!); }}>Close Other Tabs</button>
                                </>
                            )}
                        </>
                    )}
                </ContextMenu>
            )}
        </ResizableModal>
    );
}

/** A tab's identity across renames and moves, for React keys and the textarea map. */
type NoteTabKey = number;
let nextKey = 1;
const newKey = (): NoteTabKey => nextKey++;
