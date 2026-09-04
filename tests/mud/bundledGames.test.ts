import { describe, it, expect } from 'vitest';
import { BUNDLED_GAMES, findBundledGame, gameProvidesOwnUi } from '../../src/mud/games/bundledGames';
import { connectionFromGame } from '../../src/ui/BundledGameGrid';

/**
 * The catalogue is generated from Mudlet's TGameDetails.h by
 * scripts/sync-mudlet-games.mjs. These pin the shape rather than the content:
 * a regeneration that silently produced empty descriptions, dropped the
 * optional trailing fields, or mangled the multi-line qsl() concatenations
 * would still typecheck and still render — it would just quietly ship a worse
 * list than upstream's.
 */
describe('bundled game catalogue', () => {
    it('holds the whole list, each entry addressable', () => {
        expect(BUNDLED_GAMES.length).toBeGreaterThan(30);
        for (const game of BUNDLED_GAMES) {
            expect(game.name, JSON.stringify(game)).not.toBe('');
            expect(game.hostUrl, game.name).not.toBe('');
            expect(Number.isInteger(game.port), game.name).toBe(true);
        }
    });

    it('reassembles the multi-paragraph blurbs', () => {
        const achaea = findBundledGame('Achaea');
        expect(achaea).not.toBeNull();
        // The C++ source builds these out of many adjacent string literals, and
        // "\n\n" between paragraphs is an escape the parser has to have decoded.
        expect(achaea!.description).toContain('\n\n');
        expect(achaea!.description.length).toBeGreaterThan(200);
    });

    it('matches names exactly, as Mudlet does', () => {
        expect(findBundledGame('Achaea')?.name).toBe('Achaea');
        expect(findBundledGame('achaea')).toBeNull();
        expect(findBundledGame('Not A Game')).toBeNull();
    });

    it('keeps the optional trailing fields', () => {
        // Icesus is the last entry and carries providesOwnUi; a parser that
        // stopped at the seventh field would drop it silently.
        expect(findBundledGame('Icesus')?.providesOwnUi).toBe(true);
        expect(findBundledGame('Icesus')?.tlsEnabled).toBe(true);
        // MorgenGrauen is the one entry with alternate hostnames.
        expect(findBundledGame('MorgenGrauen')?.alternateHostUrls).toContain('mg.mud.de');
    });

    // A re-run with no Mudlet checkout to copy from carries the previous
    // generation's icons forward by name. That step used to scan the old file
    // with a lazy regex, which ran past a game that had no icon and gave it the
    // next game's — DarkMists wore God Wars II's banner, Rites of Passage wore
    // ZombieMUD's, and the Mudlet self-test (no icon at all) wore Accursed
    // Lands'. Wrong-but-plausible logos are exactly what nobody reviews, so the
    // invariant is pinned here rather than left to the script.
    it('gives every game its own logo, or none', () => {
        for (const game of BUNDLED_GAMES) {
            if (!game.iconFile) continue;
            expect(game.icon, game.name).not.toBe('');
            const named = game.icon.split('/').pop() ?? '';
            // Entries pointing at a .qrc alias (":/materiaMagicaIcon") name no
            // file — the sync resolves those through mudlet.qrc.
            if (/\.\w+$/.test(named)) expect(game.iconFile, game.name).toBe(named);
        }
    });

    it('reports own-UI games by any of their hostnames', () => {
        expect(gameProvidesOwnUi('mg.mud.de')).toBe(true);
        expect(gameProvidesOwnUi('MG.MUD.DE')).toBe(true);
        expect(gameProvidesOwnUi('achaea.com')).toBe(false);
    });
});

describe('connectionFromGame', () => {
    it('builds a proxied profile carrying the game\'s own blurb', () => {
        const conn = connectionFromGame(findBundledGame('Achaea')!);
        expect(conn).toMatchObject({ name: 'Achaea', mode: 'mud', host: 'achaea.com', port: 23 });
        expect(conn.description).toContain('Achaea');
        // Not a TLS game: the flag is left off rather than stored as false, so
        // the record reads the same as one the Add form would build.
        expect(conn.tls).toBeUndefined();
    });

    it('carries TLS for a game that needs it', () => {
        expect(connectionFromGame(findBundledGame('StickMUD')!).tls).toBe(true);
    });
});
