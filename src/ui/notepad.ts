/**
 * Mudlet's Notepad (`dlgNotepad`) — the per-profile scratch pad on the main
 * toolbar, as a set of named tabs.
 *
 * Kept where and how desktop keeps it, so a profile moved between the two
 * keeps its notes: `notes.json` in the profile's home directory
 * (`getMudletHomeDir() .. "/notes.json"`), shaped
 * `{ version: 1, tabs: [{ name, content }], activeTab }`. Before tabs, desktop
 * kept one plain-text note in `notes_utf8.txt` (and before that `notes.txt`);
 * with no `notes.json` the first of those found becomes a tab named "Notes",
 * as `dlgNotepad::migrateOldNotesFile` does. The old file is left in place.
 */
import type { ProfileVFS } from '../scripting/vfs/ProfileVFS';

export const NOTES_FILE = 'notes.json';
/** Desktop's pre-tab files, newest first — the order `migrateOldNotesFile` tries them. */
export const LEGACY_NOTES_FILES = ['notes_utf8.txt', 'notes.txt'] as const;

/** Name of the tab a fresh, unreadable or migrated notepad starts with. */
export const DEFAULT_TAB_NAME = 'Notes';
/** Name of a tab added with + or Ctrl+T. */
export const NEW_TAB_NAME = 'New Note';

/**
 * How long typing must pause before the notes are written. Desktop saves on a
 * two-minute timer and on close, which is safe there because closing the
 * window is the only way out; a browser tab can be closed, reloaded or
 * discarded with the dialog open, so the wait is short here.
 */
export const NOTES_SAVE_DELAY_MS = 1000;

/** Desktop's `mSendTimer` interval: one line every 300ms, the first after the
 *  first tick, so a pasted list doesn't flood the game. */
export const NOTES_SEND_INTERVAL_MS = 300;

export interface NoteTab {
    name: string;
    content: string;
}

export interface NotepadData {
    tabs: NoteTab[];
    activeTab: number;
}

export function notesPath(vfs: ProfileVFS, file: string = NOTES_FILE): string {
    return `${vfs.profilePath}/${file}`;
}

const fresh = (content = ''): NotepadData => ({ tabs: [{ name: DEFAULT_TAB_NAME, content }], activeTab: 0 });

/**
 * `notes.json`'s text as a notepad, with desktop's `restore()` leniency: a
 * file that is not JSON, not an object, or has no tabs opens as one empty
 * "Notes" tab rather than failing, and an out-of-range `activeTab` is ignored.
 */
export function parseNotepad(json: string): NotepadData {
    let root: unknown;
    try { root = JSON.parse(json); } catch { return fresh(); }
    if (!root || typeof root !== 'object' || Array.isArray(root)) return fresh();
    const { tabs, activeTab } = root as { tabs?: unknown; activeTab?: unknown };
    if (!Array.isArray(tabs) || tabs.length === 0) return fresh();
    const parsed = tabs.map((t): NoteTab => {
        const o = (t && typeof t === 'object' ? t : {}) as { name?: unknown; content?: unknown };
        // An empty name is "New Note" on desktop: addTab() treats it as unnamed.
        const name = typeof o.name === 'string' && o.name !== '' ? o.name : NEW_TAB_NAME;
        return { name, content: typeof o.content === 'string' ? o.content : '' };
    });
    const active = typeof activeTab === 'number' && Number.isInteger(activeTab)
        && activeTab >= 0 && activeTab < parsed.length ? activeTab : 0;
    return { tabs: parsed, activeTab: active };
}

/** What `dlgNotepad::save()` writes (Qt's indented JSON is four spaces). */
export function serializeNotepad(data: NotepadData): string {
    return `${JSON.stringify({ version: 1, tabs: data.tabs, activeTab: data.activeTab }, null, 4)}\n`;
}

function readText(vfs: ProfileVFS, file: string): string | null {
    const path = notesPath(vfs, file);
    try {
        return vfs.exists(path) ? vfs.readFile(path) : null;
    } catch (e) {
        console.warn(`[Notepad] could not read ${file}:`, e);
        return null;
    }
}

/** The profile's notes: `notes.json`, else a migrated single note, else one empty tab. */
export function loadNotepad(vfs: ProfileVFS): NotepadData {
    const json = readText(vfs, NOTES_FILE);
    if (json !== null) return parseNotepad(json);
    for (const legacy of LEGACY_NOTES_FILES) {
        const text = readText(vfs, legacy);
        if (text !== null) return fresh(text);
    }
    return fresh();
}

export function saveNotepad(vfs: ProfileVFS, data: NotepadData): void {
    vfs.writeFile(notesPath(vfs), serializeNotepad(data));
}

/** Moves the tab at `from` to `to` (tabs are drag-movable, as desktop's are),
 *  keeping the same tab active. */
export function moveTab(data: NotepadData, from: number, to: number): NotepadData {
    if (from === to || from < 0 || to < 0 || from >= data.tabs.length || to >= data.tabs.length) return data;
    const tabs = data.tabs.slice();
    const [tab] = tabs.splice(from, 1);
    tabs.splice(to, 0, tab);
    const active = data.tabs[data.activeTab];
    return { tabs, activeTab: tabs.indexOf(active) };
}

/** Closes a tab; the last one cannot be closed (`dlgNotepad::closeTab`). */
export function closeTab(data: NotepadData, index: number): NotepadData {
    if (data.tabs.length <= 1 || index < 0 || index >= data.tabs.length) return data;
    const tabs = data.tabs.filter((_, i) => i !== index);
    let active = data.activeTab;
    if (index < active || active >= tabs.length) active -= 1;
    return { tabs, activeTab: Math.max(0, active) };
}

/**
 * The next case-insensitive occurrence of `query` from the selection, wrapping
 * around the end (or the start, going backwards) — `QPlainTextEdit::find`,
 * retried from the other end as `slot_findNext`/`slot_findPrevious` do.
 * Forward search starts after the selection, so a repeated Find steps on
 * rather than finding the match already selected. Null when there is none.
 */
export function findInNotes(
    text: string,
    query: string,
    selStart: number,
    selEnd: number,
    backwards = false,
): { start: number; end: number } | null {
    if (query === '') return null;
    const hay = text.toLowerCase();
    const needle = query.toLowerCase();
    let at: number;
    if (backwards) {
        at = selStart > 0 ? hay.lastIndexOf(needle, selStart - 1) : -1;
        if (at === -1) at = hay.lastIndexOf(needle);
    } else {
        at = hay.indexOf(needle, selEnd);
        if (at === -1) at = hay.indexOf(needle);
    }
    return at === -1 ? null : { start: at, end: at + query.length };
}

/** How many times `query` occurs (case-insensitively), for the find bar. */
export function countInNotes(text: string, query: string): number {
    if (query === '') return 0;
    const hay = text.toLowerCase();
    const needle = query.toLowerCase();
    let n = 0;
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) n++;
    return n;
}

/** The line the caret is on (`QTextCursor::LineUnderCursor`), without its newline. */
export function lineAt(text: string, caret: number): string {
    const start = text.lastIndexOf('\n', caret - 1) + 1;
    const end = text.indexOf('\n', caret);
    return text.slice(start, end === -1 ? text.length : end);
}

/**
 * What a send queue actually sends: each line with the prepend text in front,
 * blank lines skipped (`slot_sendNextLine` passes over them, though they still
 * take their 300ms turn — the caller keeps that pacing).
 */
export function lineToSend(line: string, prepend: string): string | null {
    return line === '' ? null : prepend + line;
}
