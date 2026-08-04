// Default happy-dom environment: parseMudletXml needs DOMParser.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    ALL_DEFAULTS,
    stockDefaults,
    resolveDefaultPackages,
    connectionHost,
    ensureDefaultPackages,
    IRE_MAPPER_GAMES,
    GAMES_WITH_OWN_UI,
    isNewProfile,
} from '../../src/import/defaultPackages';
import { installPackageFromBytes } from '../../src/import/packageInstaller';
import { useAppStore } from '../../src/storage/appStore';
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';

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
    'gui-drop.xml': 'src/import/defaults/gui-drop/gui-drop.xml',
};

/** What a profile on `host` ends up with. Defaults to a newly-created profile —
 *  the `createdAt` stamp addConnection writes — so the mapper/run-lua-code cases
 *  below aren't quietly also asserting the starter-UI gate. */
const NEW_PROFILE = { createdAt: '2026-08-02T00:00:00.000Z' };
const namesFor = (host?: string, conn: { createdAt?: string } = NEW_PROFILE) =>
    stockDefaults(host, conn).map(d => d.name);

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
                .toEqual(['run-lua-code', 'generic_mapper', 'gui-drop', 'mudlet-base-ui']);
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
            .toEqual(['run-lua-code', 'mudlet-mapper', 'generic_mapper', 'gui-drop', 'mudlet-base-ui']);
    });

    describe('starter UI', () => {
        // Mirrors mudlet.cpp: appended unless TGameDetails flags the game as
        // providing its own interface via its bundled loader.
        it('ships on games that provide no interface of their own', () => {
            for (const host of ['elephant.org', 'alteraeon.com', 'stickmud.com', undefined]) {
                expect(namesFor(host), `host ${host}`).toContain('mudlet-base-ui');
            }
        });

        it('stands aside for games whose own loader installs a full UI', () => {
            for (const host of GAMES_WITH_OWN_UI) {
                expect(namesFor(host), `host ${host}`).not.toContain('mudlet-base-ui');
            }
        });

        it('stays off profiles that predate the createdAt stamp', () => {
            // No stamp = the profile existed before the starter UI did, so
            // someone may already have a layout. Mudix's stand-in for Mudlet's
            // experiencedMudletPlayer() check. Everything else still installs.
            const established = namesFor('elephant.org', {});
            expect(established).not.toContain('mudlet-base-ui');
            expect(established).toEqual(['run-lua-code', 'generic_mapper', 'gui-drop']);
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
