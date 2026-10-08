// Issue #450: "Link Mudlet folder…" read none of the files desktop keeps a
// profile's connection details in — `encoding`, `ssl_tsl`, `login`, `password`
// (serialised QStrings, see #455) and `command_history_main` — so a linked
// profile read a Latin-1 game as UTF-8, connected in plaintext, and lost its
// auto-login and history. A linked folder now reads them with the import's own
// reader, on link and on every open, and writes this client's changes to the
// encoding, TLS and character name back in desktop's format.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { strFromU8, strToU8 } from 'fflate';

vi.mock('../../src/scripting/vfs/folderHandleStore', () => ({ saveFolderHandle: vi.fn(async () => {}) }));
vi.mock('../../src/storage/mapStorage', () => ({ saveMap: vi.fn(async () => {}) }));

import {
    desktopProfileFileUpdates,
    linkedConnectionFilesChanged,
    linkedHistoryMarkerKey,
    loadMudletLinkedProfile,
    mergeLinkedCommandHistory,
    type LinkedVfsReader,
} from '../../src/import/mudletLink';
import { linkMudletFolder } from '../../src/import/applyMudletProfile';
import { useAppStore } from '../../src/storage/appStore';
import { PROFILE_DATA_PATH } from '../../src/storage/profileVfsData';
import { historyStorageKey, loadHistory, saveHistory } from '../../src/ui/commandHistory';
import { encodeProfileData } from '../../src/import/qtProfileData';

/** Bytes from a hex dump, spaces ignored. */
function hex(dump: string): Uint8Array {
    return Uint8Array.from(dump.replace(/\s+/g, '').match(/../g)!, b => parseInt(b, 16));
}

// Byte for byte what desktop's writeProfileData leaves (issue #455).
const DESKTOP = {
    encoding: hex('00000014 0049 0053 004f 0020 0038 0038 0035 0039 002d 0031'), // "ISO 8859-1"
    sslChecked: hex('00000002 0032'), // "2"
    login: hex('00000008 0048 0065 0072 006f'), // "Hero"
    password: hex('00000012 0073 0065 0063 0072 0065 0074 0031 0032 0033'), // "secret123"
};

const SAVE = 'current/2026-06-26#11-57-29.xml';
const XML = '<?xml version="1.0"?><MudletPackage version="1.001"><HostPackage><Host>'
    + '<name>Desk</name><url>game.example</url><port>4000</port></Host></HostPackage></MudletPackage>';

/** An in-memory linked folder: path → bytes (or text), with mtimes. */
function folder(contents: Record<string, string | Uint8Array>, mtimes: Record<string, number> = {}) {
    const files = new Map(Object.entries(contents).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v]));
    const vfs: LinkedVfsReader & { files: typeof files } = {
        files,
        exists: p => files.has(p) || [...files.keys()].some(f => f.startsWith(`${p}/`)),
        readdir: p => [...new Set([...files.keys()].filter(f => f.startsWith(`${p}/`)).map(f => f.slice(p.length + 1).split('/')[0]))],
        stat: p => (files.has(p) ? { mtime: new Date(mtimes[p] ?? 1) } : null),
        readFile: p => strFromU8(files.get(p) ?? new Uint8Array()),
        readBinaryFile: p => {
            const b = files.get(p);
            if (!b) throw new Error(`ENOENT: ${p}`);
            return b;
        },
    };
    return vfs;
}

function addLinked(extra: Record<string, unknown> = {}): string {
    return useAppStore.getState().addConnection({ name: 'Desk', mode: 'mud', host: 'game.example', port: 4000, mudletLinked: true, ...extra });
}
const conn = (id: string) => useAppStore.getState().connections.find(c => c.id === id)!;

describe('opening a linked folder reads desktop\'s profile files', () => {
    it('takes the server encoding, TLS and character name from them', () => {
        const id = addLinked();
        const vfs = folder({ [SAVE]: XML, encoding: DESKTOP.encoding, ssl_tsl: DESKTOP.sslChecked, login: DESKTOP.login });
        expect(loadMudletLinkedProfile(vfs, id, 'now')).toBe(true);
        expect(useAppStore.getState().connectionProfile[id]?.serverEncoding).toBe('ISO 8859-1');
        expect(conn(id)).toMatchObject({ tls: true, charLoginAccount: 'Hero' });
    });

    it('lets the encoding file win over the sidecar\'s copy, so a desktop change arrives', () => {
        const id = addLinked();
        const vfs = folder({
            [SAVE]: XML,
            encoding: encodeProfileData('WINDOWS-1250'),
            [PROFILE_DATA_PATH]: JSON.stringify({ profile: { serverEncoding: 'ISO 8859-1' } }),
        });
        loadMudletLinkedProfile(vfs, id, 'now');
        expect(useAppStore.getState().connectionProfile[id]?.serverEncoding).toBe('WINDOWS-1250');
    });

    it('lets an encoding file Mudlet Web cannot decode win too, so the sidecar\'s copy is not written back over it', () => {
        const id = addLinked();
        const vfs = folder({
            [SAVE]: XML,
            encoding: encodeProfileData('EBCDIC-NOPE'),
            [PROFILE_DATA_PATH]: JSON.stringify({ profile: { serverEncoding: 'ISO 8859-1' } }),
        });
        loadMudletLinkedProfile(vfs, id, 'now');
        const serverEncoding = useAppStore.getState().connectionProfile[id]?.serverEncoding;
        expect(serverEncoding).toBeUndefined();
        expect(desktopProfileFileUpdates(vfs, { serverEncoding })).toEqual({});
    });

    it('keeps the sidecar\'s encoding when there is no encoding file', () => {
        const id = addLinked();
        loadMudletLinkedProfile(folder({
            [SAVE]: XML,
            [PROFILE_DATA_PATH]: JSON.stringify({ profile: { serverEncoding: 'ISO 8859-1' } }),
        }), id, 'now');
        expect(useAppStore.getState().connectionProfile[id]?.serverEncoding).toBe('ISO 8859-1');
    });

    it('falls back to the save\'s mSslTsl without an ssl_tsl file', () => {
        const id = addLinked();
        loadMudletLinkedProfile(folder({ [SAVE]: XML.replace('<Host>', '<Host mSslTsl="yes">') }), id, 'now');
        expect(conn(id).tls).toBe(true);
    });

    it('clears the character name when desktop emptied its login file, and keeps it without one', () => {
        const cleared = addLinked({ charLoginAccount: 'Old' });
        loadMudletLinkedProfile(folder({ [SAVE]: XML, login: encodeProfileData('') }), cleared, 'now');
        expect(conn(cleared).charLoginAccount).toBeUndefined();

        const kept = addLinked({ charLoginAccount: 'Mine' });
        loadMudletLinkedProfile(folder({ [SAVE]: XML }), kept, 'now');
        expect(conn(kept).charLoginAccount).toBe('Mine');
    });

    it('leaves TLS to the URL scheme on a websocket connection', () => {
        const id = addLinked({ mode: 'websocket', url: 'ws://game.example' });
        loadMudletLinkedProfile(folder({ [SAVE]: XML, ssl_tsl: DESKTOP.sslChecked }), id, 'now');
        expect(conn(id).tls).toBeUndefined();
    });
});

describe('a linked folder\'s command history', () => {
    const ID = 'linked-history-450';
    beforeEach(() => {
        localStorage.removeItem(historyStorageKey(ID));
        localStorage.removeItem(linkedHistoryMarkerKey(ID));
    });

    it('is merged in, desktop\'s commands first, when the file is new', () => {
        saveHistory(['score', 'look'], historyStorageKey(ID));
        mergeLinkedCommandHistory(folder({ command_history_main: '\nnorth\nLOOK\n' }, { command_history_main: 5 }), ID);
        expect(loadHistory(historyStorageKey(ID))).toEqual(['north', 'LOOK', 'score']);
    });

    it('is left alone while the file is unchanged, and merged again once it changes', () => {
        const first = folder({ command_history_main: 'north' }, { command_history_main: 5 });
        mergeLinkedCommandHistory(first, ID);
        saveHistory(['kill rat', 'north'], historyStorageKey(ID));
        mergeLinkedCommandHistory(first, ID);
        expect(loadHistory(historyStorageKey(ID))).toEqual(['kill rat', 'north']);

        mergeLinkedCommandHistory(folder({ command_history_main: 'south\nnorth' }, { command_history_main: 9 }), ID);
        expect(loadHistory(historyStorageKey(ID))).toEqual(['south', 'north', 'kill rat']);
    });

    it('is read when the profile opens, capped at its save size', () => {
        const id = addLinked();
        localStorage.removeItem(historyStorageKey(id));
        const xml = XML.replace('<Host>', '<Host CommandLineHistorySaveSize="2">');
        loadMudletLinkedProfile(folder({ [SAVE]: xml, command_history_main: 'a\nb\nc' }), id, 'now');
        expect(loadHistory(historyStorageKey(id))).toEqual(['a', 'b']);
    });
});

describe('writing this client\'s changes back to the folder', () => {
    it('writes nothing when the files already say the same', () => {
        const vfs = folder({ encoding: DESKTOP.encoding, ssl_tsl: DESKTOP.sslChecked, login: DESKTOP.login });
        expect(desktopProfileFileUpdates(vfs, { serverEncoding: 'ISO 8859-1', tls: true, login: 'Hero' })).toEqual({});
        // Another spelling of the same encoding is the same encoding.
        expect(desktopProfileFileUpdates(folder({ encoding: encodeProfileData('iso-8859-1') }), { serverEncoding: 'ISO 8859-1' })).toEqual({});
    });

    it('writes a changed value in desktop\'s own format', () => {
        const vfs = folder({ encoding: encodeProfileData('UTF-8'), ssl_tsl: encodeProfileData('0'), login: encodeProfileData('Old') });
        const out = desktopProfileFileUpdates(vfs, { serverEncoding: 'ISO 8859-1', tls: true, login: 'Hero' });
        expect(out).toEqual({ encoding: DESKTOP.encoding, ssl_tsl: DESKTOP.sslChecked, login: DESKTOP.login });
    });

    it('creates no file only to say what its absence means', () => {
        expect(desktopProfileFileUpdates(folder({}), { tls: false })).toEqual({});
    });

    it('creates one for a value desktop would otherwise not know', () => {
        expect(desktopProfileFileUpdates(folder({}), { tls: true, login: 'Hero' })).toEqual({ ssl_tsl: DESKTOP.sslChecked, login: DESKTOP.login });
    });

    it('empties the login file when the character name is cleared', () => {
        expect(desktopProfileFileUpdates(folder({ login: DESKTOP.login }), {})).toEqual({ login: encodeProfileData('') });
    });

    it('is due when TLS or the character name changes on a linked connection, and only then', () => {
        const base = { mudletLinked: true, mode: 'mud' as const, tls: false, charLoginAccount: 'Hero' };
        expect(linkedConnectionFilesChanged({ ...base, tls: true }, base)).toBe(true);
        expect(linkedConnectionFilesChanged({ ...base, charLoginAccount: 'Other' }, base)).toBe(true);
        expect(linkedConnectionFilesChanged({ ...base }, base)).toBe(false);
        expect(linkedConnectionFilesChanged({ ...base, mudletLinked: undefined, tls: true }, base)).toBe(false);
        expect(linkedConnectionFilesChanged(undefined, base)).toBe(false);
    });

    it('never names the password', () => {
        const out = desktopProfileFileUpdates(folder({ password: DESKTOP.password }), { serverEncoding: 'UTF-8', tls: true, login: 'Hero' });
        expect(Object.keys(out)).not.toContain('password');
    });
});

describe('linking a folder', () => {
    /** A FileSystemDirectoryHandle over an in-memory tree, enough for linkMudletFolder. */
    function dirHandle(name: string, tree: Record<string, Uint8Array | string>): FileSystemDirectoryHandle {
        const fileHandle = (fname: string, bytes: Uint8Array) => ({
            kind: 'file', name: fname,
            getFile: async () => ({
                lastModified: 1,
                arrayBuffer: async () => bytes.slice().buffer,
                text: async () => strFromU8(bytes),
            }),
        });
        const dir = (prefix: string, dname: string): unknown => ({
            kind: 'directory', name: dname,
            async getFileHandle(n: string) {
                const v = tree[prefix + n];
                if (v === undefined) throw Object.assign(new Error('NotFound'), { name: 'NotFoundError' });
                return fileHandle(n, typeof v === 'string' ? strToU8(v) : v);
            },
            async getDirectoryHandle(n: string) {
                if (!Object.keys(tree).some(k => k.startsWith(`${prefix}${n}/`))) throw new Error('NotFound');
                return dir(`${prefix}${n}/`, n);
            },
            async *entries() {
                const names = new Set(Object.keys(tree).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length).split('/')[0]));
                for (const n of names) {
                    const v = tree[prefix + n];
                    yield [n, v === undefined ? dir(`${prefix}${n}/`, n) : fileHandle(n, typeof v === 'string' ? strToU8(v) : v)];
                }
            },
        });
        return dir('', name) as FileSystemDirectoryHandle;
    }

    it('reads TLS, the character name and the password from desktop\'s files', async () => {
        const result = await linkMudletFolder(dirHandle('Desk', {
            [SAVE]: XML, ssl_tsl: DESKTOP.sslChecked, login: DESKTOP.login, password: DESKTOP.password,
        }));
        expect(result.password).toBe('secret123');
        expect(result.warnings).toEqual([]);
        expect(conn(result.connectionId)).toMatchObject({ mudletLinked: true, tls: true, charLoginAccount: 'Hero' });
        expect(JSON.stringify(conn(result.connectionId))).not.toContain('secret123');
    });

    it('warns about an encoding Mudlet Web cannot decode', async () => {
        const result = await linkMudletFolder(dirHandle('Desk', { [SAVE]: XML, encoding: encodeProfileData('EBCDIC-NOPE') }));
        expect(result.warnings.some(w => w.includes('EBCDIC-NOPE'))).toBe(true);
        expect(result.password).toBeUndefined();
    });
});
