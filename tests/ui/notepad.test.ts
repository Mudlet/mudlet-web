import { describe, it, expect } from 'vitest';
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';
import {
    closeTab, countInNotes, findInNotes, lineAt, lineToSend, loadNotepad, moveTab, notesPath, parseNotepad, saveNotepad,
} from '../../src/ui/notepad';
import { buildAppMenus } from '../../src/ui/menu/appMenus';
import { APP_SHORTCUTS } from '../../src/ui/commands/appShortcuts';

// Mudlet's Notepad (dlgNotepad) keeps named tabs per profile in notes.json in
// the profile's home directory, migrating the older single-note text files.

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

describe('notes.json', () => {
    it('lives in the profile home, where getMudletHomeDir() points', () => {
        expect(notesPath(fakeVfs())).toBe('/profiles/abc/notes.json');
    });

    it('opens one empty "Notes" tab before anything was written', () => {
        expect(loadNotepad(fakeVfs())).toEqual({ tabs: [{ name: 'Notes', content: '' }], activeTab: 0 });
    });

    it('round-trips tabs and the active tab in desktop’s shape', () => {
        const vfs = fakeVfs();
        const data = { tabs: [{ name: 'Quests', content: 'kill the rat' }, { name: 'Shop', content: 'bread\nmilk' }], activeTab: 1 };
        saveNotepad(vfs, data);
        const written = JSON.parse(vfs.files.get('/profiles/abc/notes.json')!);
        expect(written).toEqual({ version: 1, ...data });
        expect(loadNotepad(vfs)).toEqual(data);
    });

    it('migrates desktop’s single pre-tab note, preferring notes_utf8.txt', () => {
        const vfs = fakeVfs();
        vfs.files.set('/profiles/abc/notes.txt', 'old');
        expect(loadNotepad(vfs)).toEqual({ tabs: [{ name: 'Notes', content: 'old' }], activeTab: 0 });
        vfs.files.set('/profiles/abc/notes_utf8.txt', 'newer');
        expect(loadNotepad(vfs).tabs[0].content).toBe('newer');
        // Once notes.json exists, the old files are not read again.
        saveNotepad(vfs, { tabs: [{ name: 'A', content: 'json' }], activeTab: 0 });
        expect(loadNotepad(vfs).tabs[0].content).toBe('json');
    });

    it('is as forgiving as desktop’s restore()', () => {
        const one = { tabs: [{ name: 'Notes', content: '' }], activeTab: 0 };
        expect(parseNotepad('not json')).toEqual(one);
        expect(parseNotepad('[]')).toEqual(one);
        expect(parseNotepad('{"tabs":[]}')).toEqual(one);
        expect(parseNotepad('{"tabs":[{"name":"","content":"x"}],"activeTab":7}'))
            .toEqual({ tabs: [{ name: 'New Note', content: 'x' }], activeTab: 0 });
    });
});

describe('tabs', () => {
    const three = { tabs: ['a', 'b', 'c'].map(name => ({ name, content: '' })), activeTab: 1 };
    const names = (d: typeof three) => d.tabs.map(t => t.name);

    it('never closes the last tab', () => {
        const one = { tabs: [{ name: 'a', content: '' }], activeTab: 0 };
        expect(closeTab(one, 0)).toBe(one);
    });

    it('keeps the same tab active when another closes', () => {
        const closedBefore = closeTab(three, 0);
        expect(names(closedBefore)).toEqual(['b', 'c']);
        expect(closedBefore.activeTab).toBe(0);
        expect(closeTab(three, 2).activeTab).toBe(1);
        // Closing the active last tab lands on its neighbour.
        expect(closeTab({ ...three, activeTab: 2 }, 2).activeTab).toBe(1);
    });

    it('moves a tab and follows the active one', () => {
        const moved = moveTab(three, 0, 2);
        expect(names(moved)).toEqual(['b', 'c', 'a']);
        expect(moved.tabs[moved.activeTab].name).toBe('b');
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
        expect(findInNotes(text, 'rat', 0, 3, true)!.start).toBe(23);
        expect(findInNotes(text, 'rat', 23, 26, true)!.start).toBe(12);
    });

    it('ignores case, as desktop’s find does, and reports no match', () => {
        expect(findInNotes(text, 'RAT', 0, 0)!.start).toBe(0);
        expect(findInNotes(text, 'mouse', 0, 0)).toBeNull();
        expect(findInNotes(text, '', 0, 0)).toBeNull();
        expect(countInNotes(text, 'rat')).toBe(3);
    });
});

describe('sending', () => {
    it('takes the line under the caret', () => {
        expect(lineAt('one\ntwo\nthree', 5)).toBe('two');
        expect(lineAt('one\ntwo', 0)).toBe('one');
        expect(lineAt('one\ntwo', 7)).toBe('two');
    });

    it('prepends, and skips blank lines', () => {
        expect(lineToSend('north', 'say ')).toBe('say north');
        expect(lineToSend('', 'say ')).toBeNull();
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
