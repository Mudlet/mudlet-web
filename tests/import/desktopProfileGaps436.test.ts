// Issue #436: importing a desktop Mudlet profile lost things desktop keeps
// beside, or inside, the save.
//
//  1. A zip import picked the map by name, so `map/autosave.dat` always beat a
//     newer dated map; desktop (and the folder import) go by file time.
//  2. The `encoding` file (server data encoding) was never read.
//  3. TLS — the `ssl_tsl` file and `<Host mSslTsl>` — was never read.
//  4. The saved login (`login`/`password` files) was never read.
//  5. Preferences kept as `<Host>` attributes (echo mode, blank lines, the IRE
//     linebreak fix, history size, GA off, compact input line, Unix EOL, F3
//     search, caret shortcut, control characters) were never read.
//  6. Migrated packages had no `declaredInfo`, so getPackageInfo was empty
//     (see tests/scripting/migratedPackageInfo436.test.ts for the engine half).
//  7. `command_history_main` was copied but never loaded.
//
// Issue #455: the profile-data files in 2–4 are serialised QStrings, not text;
// the fixtures below are the bytes desktop really writes.
import { describe, it, expect, beforeEach } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
    buildMudletProfileBundle,
    extractMudletProfileZip,
    parseCommandHistory,
    zipEntryMtimes,
} from '../../src/import/mudletProfileImport';
import { bundleToConnectionData, bundleToConnectionRecord, seedCommandHistory } from '../../src/import/applyMudletProfile';
import { applyProfileSettingsToHost, parseMudletHost } from '../../src/import/mudletHost';
import { buildProfileFolder, CONNECTION_SIDECAR_PATH } from '../../src/import/mudletProfileExport';
import { historyStorageKey, loadHistory } from '../../src/ui/commandHistory';
import type { MudConnection } from '../../src/storage/schema';

function profileXml(hostAttrs = ''): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <HostPackage>
    <Host ${hostAttrs}>
      <name>Desk</name>
      <url>game.example</url>
      <port>4000</port>
    </Host>
  </HostPackage>
</MudletPackage>`;
}

const SAVE = 'Desk/current/2026-06-26#11-57-29.xml';

function bundleWith(files: Record<string, string | Uint8Array>, hostAttrs = '') {
    const tree: Record<string, Uint8Array> = { [SAVE]: strToU8(profileXml(hostAttrs)) };
    for (const [k, v] of Object.entries(files)) tree[`Desk/${k}`] = typeof v === 'string' ? strToU8(v) : v;
    return buildMudletProfileBundle(tree);
}

/** Bytes from a hex dump, spaces ignored. */
function hex(dump: string): Uint8Array {
    const clean = dump.replace(/\s+/g, '');
    return Uint8Array.from(clean.match(/../g)!, b => parseInt(b, 16));
}

/**
 * The files exactly as desktop's `MudletApp::writeProfileData` leaves them — a
 * QDataStream (Qt_5_12) `QString`: big-endian uint32 byte length, then
 * UTF-16BE. Dumped from real desktop profiles (issue #455).
 */
const DESKTOP = {
    encoding: hex('00000014 0049 0053 004f 0020 0038 0038 0035 0039 002d 0031'), // "ISO 8859-1"
    sslChecked: hex('00000002 0032'), // "2" (Qt::Checked)
    sslUnchecked: hex('00000002 0030'), // "0"
    login: hex('00000008 0048 0065 0072 006f'), // "Hero"
    password: hex('00000012 0073 0065 0063 0072 0065 0074 0031 0032 0033'), // "secret123"
};

/** Any string in that format, for the cases no real dump covers. */
function qstring(text: string): Uint8Array {
    const out = [0, 0, 0, text.length * 2];
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        out.push(c >> 8, c & 0xff);
    }
    return Uint8Array.from(out);
}

describe('1. a zip import picks the newest map by modification time', () => {
    const older = new Date(2026, 5, 20, 10, 0, 0);
    const newer = new Date(2026, 5, 26, 11, 57, 0);

    it('takes a dated map that is newer than autosave.dat', () => {
        const zip = zipSync({
            [SAVE]: [strToU8(profileXml()), { mtime: newer }],
            'Desk/map/autosave.dat': [new Uint8Array([1]), { mtime: older }],
            'Desk/map/2026-06-26#11-57-00map.dat': [new Uint8Array([2]), { mtime: newer }],
        });
        expect(extractMudletProfileZip(zip).mapBytes).toEqual(new Uint8Array([2]));
    });

    it('takes autosave.dat when it is the newer one', () => {
        const zip = zipSync({
            [SAVE]: [strToU8(profileXml()), { mtime: newer }],
            'Desk/map/autosave.dat': [new Uint8Array([1]), { mtime: newer }],
            'Desk/map/2026-06-26#11-57-00map.dat': [new Uint8Array([2]), { mtime: older }],
        });
        expect(extractMudletProfileZip(zip).mapBytes).toEqual(new Uint8Array([1]));
    });

    it('matches the folder import given the same times', () => {
        const files = {
            [SAVE]: strToU8(profileXml()),
            'Desk/map/autosave.dat': new Uint8Array([1]),
            'Desk/map/2026-06-26#11-57-00map.dat': new Uint8Array([2]),
        };
        const mtimes = {
            [SAVE]: newer.getTime(),
            'Desk/map/autosave.dat': older.getTime(),
            'Desk/map/2026-06-26#11-57-00map.dat': newer.getTime(),
        };
        expect(buildMudletProfileBundle(files, 'x', mtimes).mapBytes).toEqual(new Uint8Array([2]));
    });

    it('picks the newest save by time as well, falling back to names on a tie', () => {
        const zip = zipSync({
            'Desk/current/2026-06-26#11-57-29.xml': [strToU8(profileXml('autoClearCommandLineAfterSend="no"')), { mtime: older }],
            'Desk/current/2026-06-20#10-00-00.xml': [strToU8(profileXml('autoClearCommandLineAfterSend="yes"')), { mtime: newer }],
        });
        expect(extractMudletProfileZip(zip).profile.settings.autoClearInput).toBe(true);
        // Everything zipped at once shares a time: the later timestamp name wins.
        const tied = zipSync({
            'Desk/current/2026-06-26#11-57-29.xml': [strToU8(profileXml('autoClearCommandLineAfterSend="no"')), { mtime: newer }],
            'Desk/current/2026-06-20#10-00-00.xml': [strToU8(profileXml('autoClearCommandLineAfterSend="yes"')), { mtime: newer }],
        });
        expect(extractMudletProfileZip(tied).profile.settings.autoClearInput).toBe(false);
    });

    it('reads entry times out of the central directory, keyed like unzipSync', () => {
        const zip = zipSync({
            'a.txt': [strToU8('a'), { mtime: older }],
            'dir/ż.txt': [strToU8('b'), { mtime: newer }],
        });
        const times = zipEntryMtimes(zip);
        expect(Object.keys(times).sort()).toEqual(['a.txt', 'dir/ż.txt']);
        expect(times['dir/ż.txt'] - times['a.txt']).toBe(newer.getTime() - older.getTime());
    });

    it('yields no times for bytes that are not a zip', () => {
        expect(zipEntryMtimes(new Uint8Array([1, 2, 3]))).toEqual({});
    });
});

describe('2. the server encoding', () => {
    it('is read from the profile\'s encoding file in Mudlet\'s spelling', () => {
        const bundle = bundleWith({ encoding: DESKTOP.encoding });
        expect(bundle.profile.settings.serverEncoding).toBe('ISO 8859-1');
        expect(bundleToConnectionData(bundle, 'now').profile.serverEncoding).toBe('ISO 8859-1');
        expect(bundle.files.encoding).toBeUndefined();
        expect(bundle.warnings).toEqual([]);
    });

    it('is brought to the listed spelling from an alias', () => {
        expect(bundleWith({ encoding: qstring('windows-1250') }).profile.settings.serverEncoding).toBe('WINDOWS-1250');
    });

    it('warns, and leaves UTF-8, for one Mudlet Web cannot decode', () => {
        const bundle = bundleWith({ encoding: qstring('EBCDIC-NOPE') });
        expect(bundle.profile.settings.serverEncoding).toBeUndefined();
        expect(bundle.warnings.some(w => w.includes('EBCDIC-NOPE'))).toBe(true);
    });

    it('still reads a hand-written plain-text file', () => {
        expect(bundleWith({ encoding: 'windows-1250\n' }).profile.settings.serverEncoding).toBe('WINDOWS-1250');
    });

    it('treats a null QString as no encoding', () => {
        const bundle = bundleWith({ encoding: hex('ffffffff') });
        expect(bundle.profile.settings.serverEncoding).toBeUndefined();
        expect(bundle.warnings).toEqual([]);
    });
});

describe('3. TLS', () => {
    it('is on when the ssl_tsl file holds Qt::Checked', () => {
        const bundle = bundleWith({ ssl_tsl: DESKTOP.sslChecked });
        expect(bundle.tls).toBe(true);
        expect(bundleToConnectionRecord(bundle)).toMatchObject({ mode: 'mud', host: 'game.example', port: 4000, tls: true });
        expect(bundle.files.ssl_tsl).toBeUndefined();
    });

    it('is on alongside the newest save\'s own mSslTsl="yes"', () => {
        expect(bundleWith({ ssl_tsl: DESKTOP.sslChecked }, 'mSslTsl="yes"').tls).toBe(true);
    });

    it('falls back to <Host mSslTsl> with no file, with the certificate exceptions', () => {
        const record = bundleToConnectionRecord(bundleWith({}, 'mSslTsl="yes" mSslIgnoreExpired="yes" mSslIgnoreSelfSigned="no" mSslIgnoreAll="no"'));
        expect(record.tls).toBe(true);
        expect(record.sslIgnoreExpired).toBe(true);
        expect(record.sslIgnoreSelfSigned).toBeUndefined();
    });

    it('lets the file, which the connection dialog keeps current, win over the save', () => {
        expect(bundleWith({ ssl_tsl: DESKTOP.sslUnchecked }, 'mSslTsl="yes"').tls).toBe(false);
    });

    it('falls back to the save when the file holds no check state', () => {
        expect(bundleWith({ ssl_tsl: hex('0000') }, 'mSslTsl="yes"').tls).toBe(true);
        expect(bundleWith({ ssl_tsl: 'yes' }, 'mSslTsl="yes"').tls).toBe(true);
    });

    it('still reads a hand-written plain-text file', () => {
        expect(bundleWith({ ssl_tsl: '2\n' }).tls).toBe(true);
    });

    it('stays unset when neither says', () => {
        expect(bundleToConnectionRecord(bundleWith({})).tls).toBeUndefined();
    });

    it('is dropped for a websocket profile, whose URL scheme decides it', () => {
        const bundle = bundleWith({ ssl_tsl: DESKTOP.sslChecked });
        bundle.files[CONNECTION_SIDECAR_PATH] = strToU8(JSON.stringify({ mode: 'websocket', url: 'wss://game.example' }));
        expect(bundleToConnectionRecord(bundle).tls).toBeUndefined();
    });
});

describe('4. the saved login', () => {
    it('fills the account from the login file', () => {
        const bundle = bundleWith({ login: DESKTOP.login });
        expect(bundle.login).toBe('Hero');
        expect(bundleToConnectionRecord(bundle).charLoginAccount).toBe('Hero');
        expect(bundle.files.login).toBeUndefined();
    });

    it('carries the password for the vault, never as a profile file', () => {
        const bundle = bundleWith({ login: DESKTOP.login, password: DESKTOP.password });
        expect(bundle.password).toBe('secret123');
        expect(bundle.files.password).toBeUndefined();
        expect(JSON.stringify(bundleToConnectionRecord(bundle))).not.toContain('secret123');
    });

    it('keeps the password exactly as saved, spaces and all', () => {
        expect(bundleWith({ password: qstring(' s3cret ') }).password).toBe(' s3cret ');
    });

    it('decodes characters beyond Latin-1', () => {
        expect(bundleWith({ login: qstring('Żółw') }).login).toBe('Żółw');
    });

    it('still reads hand-written plain-text files', () => {
        const bundle = bundleWith({ login: 'Hero\n', password: ' s3cret ' });
        expect(bundle.login).toBe('Hero');
        expect(bundle.password).toBe(' s3cret ');
    });

    it('leaves both unset when the profile saved none', () => {
        const bundle = bundleWith({});
        expect(bundle.login).toBeUndefined();
        expect(bundle.password).toBeUndefined();
        expect(bundleToConnectionRecord(bundle).charLoginAccount).toBeUndefined();
    });

    it('leaves both unset for null QStrings', () => {
        const bundle = bundleWith({ login: hex('ffffffff'), password: hex('ffffffff') });
        expect(bundle.login).toBeUndefined();
        expect(bundle.password).toBeUndefined();
    });
});

describe('5. preferences kept as <Host> attributes', () => {
    const ATTRS = [
        'commandEchoMode="2"', 'printCommand="yes"', 'blankLineBehaviour="ReplaceWithSpace"',
        'USE_IRE_DRIVER_BUGFIX="yes"', 'mUSE_FORCE_LF_AFTER_PROMPT="yes"', 'CommandLineHistorySaveSize="42"',
        'mFORCE_GA_OFF="yes"', 'CompactInputLine="yes"', 'mUSE_UNIX_EOL="yes"', 'f3SearchEnabled="yes"',
        'caretShortcut="CtrlTab"', 'ControlCharacterHandling="2"',
    ].join(' ');

    it('maps each onto the key getConfig reads', () => {
        expect(bundleWith({}, ATTRS).profile.settings.config).toEqual({
            showSentText: 'always',
            blankLinesBehaviour: 'replacewithspace',
            fixUnnecessaryLinebreaks: true,
            forceLfAfterPrompt: true,
            commandLineHistorySaveSize: 42,
            specialForceGAOff: true,
            compactInputLine: true,
            inputLineStrictUnixEndings: true,
            f3SearchEnabled: true,
            caretShortcut: 'ctrltab',
            controlCharacterHandling: 'oem',
        });
    });

    it('reads a pre-4.19 save\'s printCommand when there is no commandEchoMode', () => {
        expect(bundleWith({}, 'printCommand="no"').profile.settings.config?.showSentText).toBe('never');
        expect(bundleWith({}, 'printCommand="yes"').profile.settings.config?.showSentText).toBe('script');
    });

    it('reads ControlCharacterHandling 1 as picture and an unknown value as as-is', () => {
        expect(bundleWith({}, 'ControlCharacterHandling="1"').profile.settings.config?.controlCharacterHandling).toBe('picture');
        expect(bundleWith({}, 'ControlCharacterHandling="7"').profile.settings.config?.controlCharacterHandling).toBe('asis');
    });

    it('adds no config bag for a <Host> without any of them', () => {
        expect(bundleWith({}).profile.settings.config).toBeUndefined();
    });

    it('writes them back so an export carries the live values', () => {
        const doc = new DOMParser().parseFromString(profileXml(ATTRS), 'text/xml');
        const host = doc.getElementsByTagName('Host')[0];
        applyProfileSettingsToHost(host, {
            config: {
                showSentText: 'never', blankLinesBehaviour: 'hide', fixUnnecessaryLinebreaks: false,
                commandLineHistorySaveSize: 10, caretShortcut: 'f6', controlCharacterHandling: 'asis',
            },
        });
        expect(host.getAttribute('commandEchoMode')).toBe('0');
        expect(host.getAttribute('printCommand')).toBe('no');
        expect(host.getAttribute('blankLineBehaviour')).toBe('Hide');
        expect(host.getAttribute('USE_IRE_DRIVER_BUGFIX')).toBe('no');
        expect(host.getAttribute('CommandLineHistorySaveSize')).toBe('10');
        expect(host.getAttribute('caretShortcut')).toBe('F6');
        // XMLexport leaves AsIs out.
        expect(host.hasAttribute('ControlCharacterHandling')).toBe(false);
        // Untouched keys keep what the save had.
        expect(host.getAttribute('mFORCE_GA_OFF')).toBe('yes');
        expect(parseMudletHost(host).config).toMatchObject({
            showSentText: 'never', blankLinesBehaviour: 'hide', caretShortcut: 'f6', specialForceGAOff: true,
        });
    });
});

describe('6. migrated packages declare their info', () => {
    const XML = `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001"><HostPackage><Host><name>P</name>
  <mInstalledPackages><string>mpkg</string><string>echo</string></mInstalledPackages>
</Host></HostPackage></MudletPackage>`;
    const bundle = buildMudletProfileBundle({
        'P/current/2026-06-26#10-00-00.xml': strToU8(XML),
        'P/mpkg/config.lua': strToU8('mpackage = [[mpkg-renamed]]\nversion = "2.3.1"\nauthor = "demonnic"\ntitle = [[Package Manager]]\n'),
    });

    it('keeps what config.lua declared, verbatim, as getPackageInfo reads it', () => {
        expect(bundle.packages.find(p => p.name === 'mpkg')?.declaredInfo).toEqual({
            mpackage: 'mpkg-renamed', version: '2.3.1', author: 'demonnic', title: 'Package Manager',
        });
    });

    it('keeps the name <mInstalledPackages> knows it by', () => {
        expect(bundle.packages.map(p => p.name)).toEqual(['mpkg', 'echo']);
    });

    it('declares nothing for a package with no config.lua, as desktop reports', () => {
        expect(bundle.packages.find(p => p.name === 'echo')?.declaredInfo).toBeUndefined();
    });
});

describe('7. command history', () => {
    it('reads desktop\'s newest-first file, skipping blanks and repeats', () => {
        expect(parseCommandHistory('\nlook\r\nkill rat\nLOOK\n\nnorth')).toEqual(['look', 'kill rat', 'north']);
    });

    describe('seeding the command bar', () => {
        const ID = 'conn-436';
        beforeEach(() => localStorage.removeItem(historyStorageKey(ID)));

        it('puts the history where the command bar loads it from', () => {
            const bundle = bundleWith({ command_history_main: '\nlook\nkill rat\nnorth' });
            expect(bundle.commandHistory).toEqual(['look', 'kill rat', 'north']);
            seedCommandHistory(ID, bundle);
            expect(loadHistory(historyStorageKey(ID))).toEqual(['look', 'kill rat', 'north']);
        });

        it('caps it at the profile\'s CommandLineHistorySaveSize', () => {
            const bundle = bundleWith({ command_history_main: 'a\nb\nc' }, 'CommandLineHistorySaveSize="2"');
            seedCommandHistory(ID, bundle);
            expect(loadHistory(historyStorageKey(ID))).toEqual(['a', 'b']);
        });

        it('writes nothing for a profile without one', () => {
            seedCommandHistory(ID, bundleWith({}));
            expect(localStorage.getItem(historyStorageKey(ID))).toBeNull();
        });
    });
});

describe('an export writes those profile files from the live settings', () => {
    const connection: MudConnection = {
        id: 'c1', name: 'Desk', mode: 'mud', host: 'game.example', port: 4000, tls: true, charLoginAccount: 'Hero',
    };

    it('writes ssl_tsl, login and encoding as desktop reads them, and never a password', () => {
        const folder = buildProfileFolder({
            connection,
            data: { profile: { serverEncoding: 'ISO 8859-1' } } as never,
            files: { ssl_tsl: strToU8('0') },
        }, '2026-06-26#12-00-00');
        // Byte for byte what desktop writes, since its readProfileData reads
        // nothing else (issue #455).
        expect(folder.ssl_tsl).toEqual(DESKTOP.sslChecked);
        expect(folder.login).toEqual(DESKTOP.login);
        expect(folder.encoding).toEqual(DESKTOP.encoding);
        expect(folder.password).toBeUndefined();

        // …and they come back in on a re-import.
        const zipped: Record<string, Uint8Array> = {};
        for (const [k, v] of Object.entries(folder)) zipped[`Desk/${k}`] = v;
        const bundle = buildMudletProfileBundle(zipped);
        expect(bundle.tls).toBe(true);
        expect(bundle.login).toBe('Hero');
        expect(bundle.profile.settings.serverEncoding).toBe('ISO 8859-1');
    });
});
