// Default happy-dom environment: parseMudletXml needs DOMParser.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    ALL_DEFAULTS,
    stockDefaults,
    resolveDefaultPackages,
    connectionHost,
    ensureDefaultPackages,
    IRE_MAPPER_GAMES,
    ownUiArrives,
    isNewProfile,
    gameLoader,
    setupIreDriverBugfix,
    IRE_DRIVER_BUGFIX_GAMES,
} from '../../src/import/defaultPackages';
import { installPackageFromBytes } from '../../src/import/packageInstaller';
import { useAppStore } from '../../src/storage/appStore';
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';
import { BUNDLED_GAMES } from '../../src/mud/games/bundledGames';

/**
 * Each default package declares metadata by hand (`name`, and optionally
 * `version`) that has to agree with what the archive itself produces:
 *
 * - `name` must equal the manifest name `installPackageFromBytes` derives from
 *   the archive's `config.lua`, because `ensureDefaultPackages` matches on it to
 *   decide "already installed". A mismatch means the package reinstalls on every
 *   single profile open.
 * - `version`, when declared, must equal the archive's — otherwise every open
 *   sees a version mismatch and reinstalls, wiping the package dir each time.
 *
 * Both failure modes are silent at runtime, so pin them here.
 */

/** Minimal in-memory stand-in for the handful of ProfileVFS methods the installer touches. */
function stubVfs(): ProfileVFS {
    const files = new Map<string, string | Uint8Array>();
    const dirs = new Set<string>();
    return {
        profilePath: '/profiles/test',
        exists: (p: string) => dirs.has(p) || files.has(p),
        mkdir: (p: string) => { dirs.add(p.replace(/\/$/, '')); },
        rmdir: (p: string) => { dirs.delete(p); },
        writeFile: (p: string, data: string) => { files.set(p, data); },
        writeBinaryFile: (p: string, data: Uint8Array) => { files.set(p, data); },
    } as unknown as ProfileVFS;
}

/**
 * Repo path of each default's bundled archive. The `?url` imports in
 * defaultPackages.ts resolve to build assets, so the source paths are repeated
 * here — a new default with no entry fails loudly rather than going unchecked.
 */
const ARCHIVE_PATHS: Record<string, string> = {
    'run-lua-code.mpackage': 'src/import/defaults/run-lua-code/run-lua-code.mpackage',
    'generic_mapper.mpackage': 'src/import/defaults/generic_mapper/generic_mapper.mpackage',
    'mudlet-mapper.xml': 'src/import/defaults/mudlet-mapper.xml',
    'mudlet-base-ui.mpackage': 'src/import/defaults/mudlet-base-ui/mudlet-base-ui.mpackage',
    'gui-drop.mpackage': 'src/import/defaults/gui-drop/gui-drop.mpackage',
    'mpkg.mpackage': 'src/import/defaults/mpkg/mpkg.mpackage',
    'echo.mpackage': 'src/import/defaults/echo/echo.mpackage',
    'enable-accessibility.mpackage': 'src/import/defaults/enable-accessibility/enable-accessibility.mpackage',
    'deleteOldProfiles.mpackage': 'src/import/defaults/deleteOldProfiles/deleteOldProfiles.mpackage',
    'CF-loader.mpackage': 'src/import/defaults/CF-loader/CF-loader.mpackage',
    'icesus-loader.mpackage': 'src/import/defaults/icesus-loader/icesus-loader.mpackage',
    'mg-loader.mpackage': 'src/import/defaults/mg-loader/mg-loader.mpackage',
    'MedBootstrap.mpackage': 'src/import/defaults/MedBootstrap/MedBootstrap.mpackage',
};

/** What a profile on `host` ends up with. Defaults to a newly-created profile —
 *  the `createdAt` stamp addConnection writes — so the mapper/run-lua-code cases
 *  below aren't quietly also asserting the starter-UI gate. */
const NEW_PROFILE = { createdAt: '2026-08-02T00:00:00.000Z' };
const namesFor = (host?: string, conn: { createdAt?: string } = NEW_PROFILE, serverGuiAccepted = true) =>
    stockDefaults(host, conn, serverGuiAccepted).map(d => d.name);

/** Every hostname — main and alternate — of the catalogue games with `ownUi`. */
const ownUiHosts = (ownUi: string) => BUNDLED_GAMES
    .filter(g => g.ownUi === ownUi)
    .flatMap(g => [g.hostUrl, ...(g.alternateHostUrls ?? [])]);
const LOADER_UI_HOSTS = ownUiHosts('bundledLoader');
const CLIENT_GUI_HOSTS = ownUiHosts('clientGui');
const GAMES_WITH_OWN_UI = [...LOADER_UI_HOSTS, ...CLIENT_GUI_HOSTS];

describe('default packages', () => {
    it('always ships exactly one mapper, so the map follows the player', () => {
        // centerview() is the only thing that moves the map view, and only a
        // mapper package calls it — no mapper means the map never follows.
        // Two would both fire on the same movement and fight over the view.
        const mapperNames = ['mudlet-mapper', 'generic_mapper'];
        for (const host of [undefined, 'stickmud.com', 'achaea.com', 'elephant.org', 'arkadia.rpg.pl']) {
            const mappers = namesFor(host).filter(n => mapperNames.includes(n));
            expect(mappers, `host ${host}`).toHaveLength(1);
        }
    });

    it('gives IRE-mapper games the IRE mapper, everyone else the generic one', () => {
        // Mirrors mudlet.cpp `setupPreInstallPackages`: mudlet-mapper.xml for
        // this host list, generic_mapper for everything else.
        for (const host of IRE_MAPPER_GAMES) {
            expect(namesFor(host), `host ${host}`).toContain('mudlet-mapper');
            expect(namesFor(host), `host ${host}`).not.toContain('generic_mapper');
        }
        for (const host of ['elephant.org', 'alteraeon.com', undefined]) {
            expect(namesFor(host), `host ${host}`).toContain('generic_mapper');
            expect(namesFor(host), `host ${host}`).not.toContain('mudlet-mapper');
        }
    });

    it('covers stickmud.com, the game that prompted vendoring the IRE mapper', () => {
        expect(IRE_MAPPER_GAMES).toContain('stickmud.com');
    });

    it('installs run-lua-code on every host', () => {
        expect(namesFor('stickmud.com')).toContain('run-lua-code');
        expect(namesFor(undefined)).toContain('run-lua-code');
    });

    it('installs echo, enable-accessibility and deleteOldProfiles on every host, as Mudlet does', () => {
        // `*` rows of defaultScripts in mudlet.cpp. Without echo, `` `echo `` —
        // the usual way to test a trigger — went to the game as plain text (#263).
        for (const host of [undefined, 'stickmud.com', 'elephant.org', ...GAMES_WITH_OWN_UI]) {
            for (const conn of [NEW_PROFILE, {}]) {
                const names = namesFor(host, conn);
                expect(names, `host ${host}`).toEqual(expect.arrayContaining(
                    ['echo', 'enable-accessibility', 'deleteOldProfiles']));
            }
        }
    });

    it('installs gui-drop on every host, new profile or not', () => {
        // mudlet.cpp lists it with the `*` game filter, alongside run-lua-code —
        // unconditional, unlike the starter UI. It stays inert until an image is
        // actually dropped, so there's nothing to withhold from an established
        // profile.
        for (const host of [undefined, 'stickmud.com', 'elephant.org', ...GAMES_WITH_OWN_UI]) {
            expect(namesFor(host), `host ${host}`).toContain('gui-drop');
            expect(namesFor(host, {}), `host ${host}, established`).toContain('gui-drop');
        }
    });

    it('installs mpkg on every host, new profile or not', () => {
        // mudlet.cpp lists it with the `*` game filter: the package manager is
        // how a player reaches the repository from the command line, and there
        // is nothing game-specific about that.
        for (const host of [undefined, 'stickmud.com', 'elephant.org', ...GAMES_WITH_OWN_UI]) {
            expect(namesFor(host), `host ${host}`).toContain('mpkg');
            expect(namesFor(host, {}), `host ${host}, established`).toContain('mpkg');
        }
    });

    it('leaves mpkg out of a busted build, as Mudlet does under MUDLET_TEST_MODE', async () => {
        // Package_spec asserts a test profile comes up without mpkg, because
        // mpkg reinstalls itself the moment the repository is ahead of the
        // bundled copy — mid-run, into the console the suite is asserting on.
        // TEST_BUILD is read at module load, so re-import under the stubbed env.
        vi.stubEnv('VITE_BUSTED', '1');
        vi.resetModules();
        try {
            const busted = await import('../../src/import/defaultPackages');
            for (const host of [undefined, 'stickmud.com', 'elephant.org']) {
                expect(busted.stockDefaults(host, NEW_PROFILE).map(d => d.name), `host ${host}`)
                    .not.toContain('mpkg');
                // Everything else is untouched — this excludes one package, not
                // a whole code path.
                expect(busted.stockDefaults(host, NEW_PROFILE).map(d => d.name), `host ${host}`)
                    .toContain('gui-drop');
            }
        } finally {
            vi.unstubAllEnvs();
            vi.resetModules();
        }
    });

    it('declares no version for mpkg, which upgrades itself', () => {
        // mpkg replaces its own install from the repository as soon as the
        // published version outruns the installed one. A declared version here
        // would read that newer copy as a mismatch on the next profile open and
        // reinstall the vendored archive over it — a downgrade every session.
        expect(ALL_DEFAULTS.find(d => d.name === 'mpkg')?.version).toBeUndefined();
    });

    it('matches hosts case-insensitively', () => {
        // connectionHost lowercases, so a profile typed as "StickMud.com" still matches.
        expect(connectionHost({ mode: 'mud', host: ' StickMud.COM ' })).toBe('stickmud.com');
        expect(namesFor(connectionHost({ mode: 'mud', host: ' StickMud.COM ' }))).toContain('mudlet-mapper');
    });

    it('derives the host from a websocket URL', () => {
        expect(connectionHost({ mode: 'websocket', url: 'wss://last-outpost.com/ws/telnet/' })).toBe('last-outpost.com');
        // Malformed or missing URLs just fall through to the generic mapper.
        expect(connectionHost({ mode: 'websocket', url: 'not a url' })).toBeUndefined();
        expect(connectionHost({ mode: 'websocket' })).toBeUndefined();
        expect(connectionHost(undefined)).toBeUndefined();
    });

    describe('brand override', () => {
        const brandPkg = { name: 'brand-mapper', filename: 'brand-mapper.mpackage', url: 'blob:brand' };

        it('installs the stock defaults when the brand has no opinion', () => {
            expect(resolveDefaultPackages(undefined, 'elephant.org').map(d => d.name))
                .toEqual(['run-lua-code', 'echo', 'enable-accessibility', 'deleteOldProfiles', 'generic_mapper', 'mpkg', 'gui-drop', 'mudlet-base-ui']);
        });

        it('installs nothing for an empty brand list', () => {
            // Explicitly empty is a decision, not a missing value.
            expect(resolveDefaultPackages([], 'elephant.org')).toEqual([]);
            expect(resolveDefaultPackages([], 'stickmud.com')).toEqual([]);
        });

        it('installs exactly the brand list, replacing the stock defaults', () => {
            // Including on a host that would otherwise get the IRE mapper — the
            // brand list is exact, so nothing of ours slips in alongside it.
            for (const host of ['brand.example', 'stickmud.com', undefined]) {
                expect(resolveDefaultPackages([brandPkg], host).map(d => d.name), `host ${host}`)
                    .toEqual(['brand-mapper']);
            }
        });
    });

    it('exposes every bundled default regardless of host', () => {
        // ALL_DEFAULTS is the superset the metadata checks below iterate; every
        // stock pick must come from it.
        for (const host of [undefined, 'stickmud.com', 'elephant.org']) {
            for (const def of stockDefaults(host)) expect(ALL_DEFAULTS).toContain(def);
        }
        expect(ALL_DEFAULTS.map(d => d.name))
            .toEqual(['run-lua-code', 'echo', 'enable-accessibility', 'deleteOldProfiles', 'mudlet-mapper', 'generic_mapper', 'mpkg', 'gui-drop', 'mudlet-base-ui',
                'CF_Loader', 'icesus-loader', 'mg-loader', 'MedBootstrap']);
    });

    describe('game loaders', () => {
        // Mirrors the loader rows of mudlet.cpp's defaultScripts: each game gets
        // its own loader, and only its own.
        const LOADERS: Record<string, string> = {
            'carrionfields.net': 'CF_Loader',
            'icesus.org': 'icesus-loader',
            'mg.mud.de': 'mg-loader',
            'mud.morgengrauen.info': 'mg-loader',
            'mg.morgengrauen.info': 'mg-loader',
            'morgengrauen.info': 'mg-loader',
            'medievia.com': 'MedBootstrap',
        };
        const loaderNames = new Set(Object.values(LOADERS));

        it('installs the game\'s loader on the game\'s hosts', () => {
            for (const [host, loader] of Object.entries(LOADERS)) {
                const names = namesFor(host);
                expect(names, `host ${host}`).toContain(loader);
                expect(names.filter(n => loaderNames.has(n)), `host ${host}`).toEqual([loader]);
            }
        });

        it('covers every game the catalogue says brings a bundled loader', () => {
            // Otherwise the starter UI would stand aside for an interface that
            // never arrives — a new profile with no UI at all (#442).
            for (const host of LOADER_UI_HOSTS) {
                expect(gameLoader(host), `host ${host}`).toBeDefined();
                expect(ownUiArrives(host, true), `host ${host}`).toBe(true);
            }
            expect(Object.keys(LOADERS).sort()).toEqual([...LOADER_UI_HOSTS].sort());
        });

        it('installs no loader anywhere else', () => {
            for (const host of [undefined, 'elephant.org', 'achaea.com', 'stickmud.com', ...CLIENT_GUI_HOSTS]) {
                expect(namesFor(host).filter(n => loaderNames.has(n)), `host ${host}`).toEqual([]);
            }
            // Exact hostnames, as Mudlet matches them — not a suffix.
            expect(gameLoader('www.carrionfields.net')).toBeUndefined();
        });

        it('matches hosts case-insensitively', () => {
            expect(namesFor(connectionHost({ mode: 'mud', host: 'CarrionFields.NET' }))).toContain('CF_Loader');
            expect(gameLoader('ICESUS.ORG')?.name).toBe('icesus-loader');
        });

        it('keeps generic_mapper alongside the loader, as Mudlet does', () => {
            // setupPreInstallPackages adds generic_mapper whenever the IRE mapper
            // isn't picked. The Icesus and MorgenGrauen packages the loaders
            // fetch remove it themselves; nothing here second-guesses that.
            for (const host of Object.keys(LOADERS)) {
                expect(namesFor(host), `host ${host}`).toContain('generic_mapper');
            }
        });

        it('installs the loader on established profiles too, like every default but the starter UI', () => {
            expect(namesFor('icesus.org', {})).toContain('icesus-loader');
        });
    });

    describe('starter UI', () => {
        // Mirrors mudlet.cpp's setupPreInstallPackages: appended unless the
        // game's own interface arrives — TGameDetails' OwnUi::BundledLoader
        // always, OwnUi::ClientGui only when the profile accepts server GUIs.
        it('ships on games that provide no interface of their own', () => {
            for (const host of ['elephant.org', 'achaea.com', undefined]) {
                expect(namesFor(host), `host ${host}`).toContain('mudlet-base-ui');
            }
        });

        it('reads which games bring their own UI from the catalogue', () => {
            // The four whose loader Mudlet bundles, MorgenGrauen by every name.
            expect(LOADER_UI_HOSTS).toEqual(expect.arrayContaining([
                'carrionfields.net', 'medievia.com', 'icesus.org',
                'mud.morgengrauen.info', 'mg.mud.de', 'mg.morgengrauen.info', 'morgengrauen.info',
            ]));
            expect(CLIENT_GUI_HOSTS.length).toBeGreaterThan(0);
        });

        it('stands aside for games whose own loader installs a full UI', () => {
            for (const host of LOADER_UI_HOSTS) {
                expect(namesFor(host), `host ${host}`).not.toContain('mudlet-base-ui');
                // The loader is bundled, so the profile's Client.GUI switch has no say.
                expect(namesFor(host, NEW_PROFILE, false), `host ${host}, no server GUI`)
                    .not.toContain('mudlet-base-ui');
            }
        });

        it('stands aside for Client.GUI games only while the profile accepts one', () => {
            for (const host of CLIENT_GUI_HOSTS) {
                expect(namesFor(host), `host ${host}`).not.toContain('mudlet-base-ui');
                // A refused Client.GUI never arrives, so nothing would take the space.
                expect(namesFor(host, NEW_PROFILE, false), `host ${host}, no server GUI`)
                    .toContain('mudlet-base-ui');
            }
        });

        it('matches hosts case-insensitively, as TGameDetails::gameOwnUi does', () => {
            expect(ownUiArrives('ICESUS.ORG', false)).toBe(true);
            expect(ownUiArrives(undefined, true)).toBe(false);
            expect(ownUiArrives('elephant.org', true)).toBe(false);
        });

        it('stays off profiles that predate the createdAt stamp', () => {
            // No stamp = the profile existed before the starter UI did, so
            // someone may already have a layout. Mudlet's stand-in for Mudlet's
            // experiencedMudletPlayer() check. Everything else still installs.
            const established = namesFor('elephant.org', {});
            expect(established).not.toContain('mudlet-base-ui');
            expect(established).toEqual(['run-lua-code', 'echo', 'enable-accessibility', 'deleteOldProfiles', 'generic_mapper', 'mpkg', 'gui-drop']);
        });

        it('treats a profile with no connection record as new', () => {
            // Tooling and previews pass nothing; there's no layout at risk.
            expect(stockDefaults('elephant.org').map(d => d.name)).toContain('mudlet-base-ui');
            expect(isNewProfile(undefined)).toBe(true);
            expect(isNewProfile({ createdAt: '2026-01-01T00:00:00.000Z' })).toBe(true);
            expect(isNewProfile({})).toBe(false);
        });

        it('skips a game reached under an alternate hostname', () => {
            // TGameDetails matches alternateHostUrls too, so MorgenGrauen's four
            // hostnames must all suppress it — not just its canonical one.
            expect(namesFor('mud.morgengrauen.info')).not.toContain('mudlet-base-ui');
            expect(namesFor('mg.mud.de')).not.toContain('mudlet-base-ui');
        });

        it('matches those hosts case-insensitively', () => {
            expect(namesFor(connectionHost({ mode: 'mud', host: 'Medievia.COM' })))
                .not.toContain('mudlet-base-ui');
        });
    });

    for (const def of ALL_DEFAULTS) {
        describe(def.name, () => {
            const path = ARCHIVE_PATHS[def.filename];
            it('has a known archive path in this test', () => {
                expect(path, `add ${def.filename} to ARCHIVE_PATHS`).toBeTruthy();
            });

            const installed = installPackageFromBytes(
                def.filename,
                new Uint8Array(readFileSync(path)),
                stubVfs(),
            );

            it('installs under the manifest name the list declares', () => {
                expect(installed.manifest.name).toBe(def.name);
            });

            it('declares the archive version, or none at all', () => {
                if (def.version !== undefined) {
                    expect(installed.manifest.version).toBe(def.version);
                }
            });

            it('parses into automation nodes without warnings', () => {
                const { data } = installed;
                const total = data.scripts.length + data.aliases.length
                    + data.triggers.length + data.timers.length + data.keys.length;
                expect(total).toBeGreaterThan(0);
                expect(data.warnings).toEqual([]);
            });
        });
    }

    describe('ensureDefaultPackages skips a loader whose interface is already installed', () => {
        it('does not fetch the loader when the game package is present', async () => {
            const fetchSpy = vi.fn(async () => { throw new Error('unexpected fetch'); });
            vi.stubGlobal('fetch', fetchSpy);
            try {
                const id = useAppStore.getState().addConnection({
                    name: 'icesus-has-ui', mode: 'mud', host: 'icesus.org', port: 23,
                });
                // Everything stock is installed already, plus the Icesus package
                // the loader would have downloaded.
                const present = stockDefaults('icesus.org', NEW_PROFILE)
                    .filter(d => d.name !== 'icesus-loader')
                    .map(d => ({ name: d.name, version: d.version, installedAt: '' }));
                useAppStore.setState(s => ({
                    connectionPackages: { ...s.connectionPackages, [id]: [...present, { name: 'Icesus', installedAt: '' }] },
                }));
                const installed = await ensureDefaultPackages(id, stubVfs());
                expect(installed).toEqual([]);
                expect(fetchSpy).not.toHaveBeenCalled();
            } finally {
                vi.unstubAllGlobals();
            }
        });
    });

    describe('setupIreDriverBugfix', () => {
        // Host::setupIreDriverBugfix: a new profile for an IRE game starts with
        // "fix unnecessary linebreaks" on, or every reply after a GA prompt
        // opens with a blank line (#437).
        const add = (conn: Record<string, unknown>) => useAppStore.getState().addConnection({
            name: 'ire', mode: 'mud', port: 23, ...conn,
        } as never);
        const fixFor = (id: string) => useAppStore.getState().connectionProfile[id]?.config?.fixUnnecessaryLinebreaks;

        it('covers the five IRE games, not every IRE-mapper game', () => {
            expect([...IRE_DRIVER_BUGFIX_GAMES].sort())
                .toEqual(['achaea.com', 'aetolia.com', 'imperian.com', 'lusternia.com', 'starmourn.com']);
            // StickMUD gets the IRE mapper but sends no stray newline.
            expect(IRE_DRIVER_BUGFIX_GAMES).not.toContain('stickmud.com');
        });

        it('turns the fix on for a new IRE profile', () => {
            for (const host of IRE_DRIVER_BUGFIX_GAMES) {
                const id = add({ host });
                setupIreDriverBugfix(id);
                expect(fixFor(id), `host ${host}`).toBe(true);
            }
        });

        it('matches the host case-insensitively, and from a websocket URL', () => {
            const typed = add({ host: ' Achaea.COM ' });
            setupIreDriverBugfix(typed);
            expect(fixFor(typed)).toBe(true);
            const ws = add({ mode: 'websocket', host: undefined, port: undefined, url: 'wss://aetolia.com/socket' });
            setupIreDriverBugfix(ws);
            expect(fixFor(ws)).toBe(true);
        });

        it('leaves every other game alone', () => {
            for (const host of ['stickmud.com', 'elephant.org', 'www.achaea.com', '']) {
                const id = add({ host });
                setupIreDriverBugfix(id);
                expect(fixFor(id), `host ${host}`).toBeUndefined();
            }
        });

        it('keeps an explicit choice and the rest of the config', () => {
            const off = add({ host: 'achaea.com' });
            useAppStore.getState().patchConnectionProfile(off, { config: { fixUnnecessaryLinebreaks: false, logInHTML: true } });
            setupIreDriverBugfix(off);
            expect(fixFor(off)).toBe(false);

            const other = add({ host: 'achaea.com' });
            useAppStore.getState().patchConnectionProfile(other, { config: { logInHTML: true } });
            setupIreDriverBugfix(other);
            expect(useAppStore.getState().connectionProfile[other]?.config)
                .toEqual({ logInHTML: true, fixUnnecessaryLinebreaks: true });
        });

        it('skips profiles imported or linked from Mudlet, which bring their own setting', () => {
            for (const flag of ['mudletImported', 'mudletLinked'] as const) {
                const id = add({ host: 'achaea.com', [flag]: true });
                setupIreDriverBugfix(id);
                expect(fixFor(id), flag).toBeUndefined();
            }
        });
    });

    describe('ensureDefaultPackages skips Mudlet-originated profiles', () => {
        // A profile imported or linked from Mudlet carries its own package set,
        // which is authoritative — we must never backfill the stock defaults it
        // deliberately lacks. The skip returns before any fetch/VFS write, so a
        // VFS that throws on every method proves nothing was installed.
        const explodingVfs = new Proxy({}, {
            get() { throw new Error('ensureDefaultPackages must not touch the VFS for imported/linked profiles'); },
        }) as unknown as ProfileVFS;

        for (const flag of ['mudletImported', 'mudletLinked'] as const) {
            it(`installs nothing for a ${flag} profile with no packages`, async () => {
                const id = useAppStore.getState().addConnection({
                    name: flag, mode: 'mud', host: 'elephant.org', port: 23, [flag]: true,
                });
                const installed = await ensureDefaultPackages(id, explodingVfs);
                expect(installed).toEqual([]);
                expect(useAppStore.getState().connectionPackages[id] ?? []).toEqual([]);
            });
        }
    });

    it('generic_mapper ships the mapping entry points', () => {
        const def = ALL_DEFAULTS.find(d => d.name === 'generic_mapper')!;
        const { data } = installPackageFromBytes(
            def.filename,
            new Uint8Array(readFileSync(ARCHIVE_PATHS[def.filename])),
            stubVfs(),
        );
        // The `map` alias is the package's whole user interface ("map basics",
        // "map help"), and centerview is what actually moves the map view —
        // without it an install would look successful but never follow the player.
        expect(data.aliases.some(a => (a.pattern ?? '').includes('map'))).toBe(true);
        const allCode = [...data.scripts, ...data.aliases, ...data.triggers]
            .map(n => n.code ?? '')
            .join('\n');
        expect(allCode).toContain('centerview');
    });
});
