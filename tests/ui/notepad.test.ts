import { describe, it, expect } from 'vitest';
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';
import { countInNotes, findInNotes, notesPath, readNotes, writeNotes } from '../../src/ui/notepad';
import { buildAppMenus } from '../../src/ui/menu/appMenus';
import { APP_SHORTCUTS } from '../../src/ui/commands/appShortcuts';

// Mudlet's Notepad (dlgNotepad) keeps one plain-text file per profile,
// notes.txt in the profile's home directory.

function fakeVfs(): ProfileVFS & { files: Map<string, string> } {
    const files = new Map<string, string>();
    return {
        files,
        profilePath: '/profiles/abc',
        exists: (p: string) => files.has(p),
        readFile: (p: string) => files.get(p)!,
        writeFile: (p: string, c: string) => { files.set(p, c); },
    } as unknown as ProfileVFS & { files: Map<string, string> };
}

describe('notes.txt', () => {
    it('lives in the profile home, where getMudletHomeDir() points', () => {
        expect(notesPath(fakeVfs())).toBe('/profiles/abc/notes.txt');
    });

    it('reads empty before anything was written, and round-trips text', () => {
        const vfs = fakeVfs();
        expect(readNotes(vfs)).toBe('');
        writeNotes(vfs, 'kill the rat\nbuy bread');
        expect(vfs.files.get('/profiles/abc/notes.txt')).toBe('kill the rat\nbuy bread');
        expect(readNotes(vfs)).toBe('kill the rat\nbuy bread');
    });
});

describe('the find bar', () => {
    const text = 'Rat here. A rat there. RAT!';

    it('steps forward past the current selection and wraps around', () => {
        const first = findInNotes(text, 'rat', 0, 0)!;
        expect(first).toEqual({ start: 0, end: 3 });
        const second = findInNotes(text, 'rat', first.start, first.end)!;
        expect(second.start).toBe(12);
        const third = findInNotes(text, 'rat', second.start, second.end)!;
        expect(third.start).toBe(23);
        expect(findInNotes(text, 'rat', third.start, third.end)).toEqual(first);
    });

    it('steps backwards and wraps to the last match', () => {
        expect(findInNotes(text, 'rat', 0, 3, { backwards: true })!.start).toBe(23);
        expect(findInNotes(text, 'rat', 23, 26, { backwards: true })!.start).toBe(12);
    });

    it('honours match case and reports no match', () => {
        expect(findInNotes(text, 'rat', 0, 0, { matchCase: true })!.start).toBe(12);
        expect(findInNotes(text, 'mouse', 0, 0)).toBeNull();
        expect(findInNotes(text, '', 0, 0)).toBeNull();
        expect(countInNotes(text, 'rat')).toBe(3);
        expect(countInNotes(text, 'rat', true)).toBe(1);
    });
});

describe('where Notepad is reached from', () => {
    it('has Mudlet’s Alt+N (Ctrl+N on macOS)', () => {
        const def = APP_SHORTCUTS.find(d => d.id === 'notepad')!;
        expect(def.defaultKey).toBe('Alt+N');
        expect(def.defaultKeyMac).toBe('Ctrl+N');
        expect(def.stock).toBe('notepad');
    });

    it('sits in the Toolbox menu, and goes when a brand hides it', () => {
        const noop = () => {};
        const ctx = {
            show: () => true, appName: 'Mudlet', connectionItems: [], replayRecording: false, replaySpeed: null,
            fullscreen: false, fullscreenAvailable: true, showToolbar: true, showTimestamps: false, muteItems: [],
            shortcutFor: () => undefined,
            onOpenScripts: noop, onOpenMap: noop, onOpenFiles: noop, onOpenNotepad: noop, onOpenLogs: noop,
            onToggleReplayRecording: noop, onReplayStop: noop, onOpenSettings: noop, onToggleTimestamps: noop,
            onToggleFullscreen: noop, onToggleToolbar: noop, onOpenDocs: noop, onOpenHelp: noop,
            onOpenAbout: noop, onReportBug: noop,
        };
        const toolbox = (show: (id: string) => boolean) =>
            buildAppMenus({ ...ctx, show }).find(m => m.id === 'toolbox')!.items
                .map(i => (i.kind === 'action' ? i.id : i.kind));
        expect(toolbox(() => true)).toContain('notepad');
        expect(toolbox(id => id !== 'notepad')).not.toContain('notepad');
    });
});
