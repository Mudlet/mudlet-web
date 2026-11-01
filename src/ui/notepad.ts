/**
 * Mudlet's Notepad (`dlgNotepad`) — the per-profile scratch pad on the main
 * toolbar. Desktop keeps it as plain text in `notes.txt` in the profile's home
 * directory (`mudlet::getMudletPath(enums::profileDataItemPath, host,
 * "notes.txt")`), so it is the same file here: `getMudletHomeDir() ..
 * "/notes.txt"`, readable and writable from Lua, and carried by a profile
 * export the way desktop's profile folder carries it.
 */
import type { ProfileVFS } from '../scripting/vfs/ProfileVFS';

export const NOTES_FILE = 'notes.txt';

/**
 * How long typing must pause before the notes are written. Desktop saves on a
 * two-minute timer and on close, which is safe there because closing the
 * window is the only way out; a browser tab can be closed, reloaded or
 * discarded with the dialog open, so the wait is short here.
 */
export const NOTES_SAVE_DELAY_MS = 1000;

export function notesPath(vfs: ProfileVFS): string {
    return `${vfs.profilePath}/${NOTES_FILE}`;
}

/** The saved notes, or '' when there are none yet (desktop opens empty). */
export function readNotes(vfs: ProfileVFS): string {
    const path = notesPath(vfs);
    try {
        return vfs.exists(path) ? vfs.readFile(path) : '';
    } catch (e) {
        console.warn('[Notepad] could not read notes:', e);
        return '';
    }
}

export function writeNotes(vfs: ProfileVFS, text: string): void {
    vfs.writeFile(notesPath(vfs), text);
}

/**
 * The next occurrence of `query` in `text` from the selection, wrapping around
 * the end (or the start, going backwards) the way `QPlainTextEdit::find` with
 * dlgNotepad's wrap-around does. `selStart`/`selEnd` are the current
 * selection; searching forward starts after it, so a repeated Find steps to the
 * next match instead of finding the one already selected. Null when there is
 * no match at all.
 */
export function findInNotes(
    text: string,
    query: string,
    selStart: number,
    selEnd: number,
    { backwards = false, matchCase = false }: { backwards?: boolean; matchCase?: boolean } = {},
): { start: number; end: number } | null {
    if (query === '') return null;
    const hay = matchCase ? text : text.toLowerCase();
    const needle = matchCase ? query : query.toLowerCase();
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

/** How many times `query` occurs, for the find bar's count. */
export function countInNotes(text: string, query: string, matchCase = false): number {
    if (query === '') return 0;
    const hay = matchCase ? text : text.toLowerCase();
    const needle = matchCase ? query : query.toLowerCase();
    let n = 0;
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) n++;
    return n;
}
