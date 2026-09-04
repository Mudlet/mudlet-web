import { describe, it, expect } from 'vitest';
import { findBundledGame } from '../../src/mud/games/bundledGames';
import {
    PLAYABLE_GAMES,
    findGameByLink,
    gameLinkUrl,
    gameSlug,
    profilesForGame,
} from '../../src/mud/games/gameLinks';
import type { MudConnection } from '../../src/storage';

function conn(c: Partial<MudConnection> & { name: string }): MudConnection {
    return { id: c.name, mode: 'mud', ...c } as MudConnection;
}

describe('gameSlug', () => {
    it('makes a URL-safe id out of a game name', () => {
        expect(gameSlug('Astaria')).toBe('astaria');
        expect(gameSlug('Avalon.de')).toBe('avalon-de');
        expect(gameSlug('God Wars II')).toBe('god-wars-ii');
        expect(gameSlug('Federation 2 Community Edition')).toBe('federation-2-community-edition');
    });

    // A link is `?play=<slug>`, so two games sharing one would make a link
    // ambiguous — and it would resolve to whichever the catalogue lists first.
    it('is unique across the catalogue', () => {
        const slugs = PLAYABLE_GAMES.map(g => gameSlug(g.name));
        expect(new Set(slugs).size).toBe(slugs.length);
        expect(slugs.every(s => /^[a-z0-9][a-z0-9-]*$/.test(s))).toBe(true);
    });
});

describe('findGameByLink', () => {
    it('resolves a slug, and the exact name a hand-written link might use', () => {
        expect(findGameByLink('astaria')?.name).toBe('Astaria');
        expect(findGameByLink('Astaria')?.name).toBe('Astaria');
        expect(findGameByLink('avalon-de')?.name).toBe('Avalon.de');
        expect(findGameByLink('Avalon.de')?.name).toBe('Avalon.de');
        expect(findGameByLink('  achaea  ')?.name).toBe('Achaea');
    });

    it('refuses anything the client cannot dial', () => {
        expect(findGameByLink('not-a-game')).toBeNull();
        expect(findGameByLink('')).toBeNull();
        expect(findGameByLink(null)).toBeNull();
        // In the catalogue, but a local stub with no port — nothing to connect to.
        expect(findBundledGame('Mudlet Tutorial')).not.toBeNull();
        expect(findGameByLink('mudlet-tutorial')).toBeNull();
        // A real address, but a Busted harness for testing Mudlet, not a MUD.
        expect(findBundledGame('Mudlet self-test')).not.toBeNull();
        expect(findGameByLink('mudlet-self-test')).toBeNull();
    });
});

describe('PLAYABLE_GAMES', () => {
    it('offers the MUDs and nothing else', () => {
        const names = PLAYABLE_GAMES.map(g => g.name);
        expect(names).not.toContain('Mudlet Tutorial');
        expect(names).not.toContain('Mudlet self-test');
        expect(names).toContain('Astaria');
        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });
});

describe('gameLinkUrl', () => {
    it('is the link a website pastes behind a "Play <game>" button', () => {
        expect(gameLinkUrl(findBundledGame('Astaria')!, 'https://mudlet.org/web/'))
            .toBe('https://mudlet.org/web/?play=astaria');
        // Round-trips: whatever the builder writes, the reader resolves.
        for (const game of PLAYABLE_GAMES) {
            const url = new URL(gameLinkUrl(game, 'https://example.com/'));
            expect(findGameByLink(url.searchParams.get('play'))).toBe(game);
        }
    });

    it('keeps the parameters the host page already had', () => {
        expect(gameLinkUrl(findBundledGame('Achaea')!, 'https://example.com/?theme=dark'))
            .toBe('https://example.com/?theme=dark&play=achaea');
    });
});

describe('profilesForGame', () => {
    const achaea = findBundledGame('Achaea')!;

    it('matches on the host, whatever the profile is called', () => {
        const mine = conn({ name: 'My main', host: 'ACHAEA.COM', port: 23 });
        expect(profilesForGame(achaea, [mine, conn({ name: 'Other', host: 'aetolia.com', port: 23 })]))
            .toEqual([mine]);
    });

    it('matches on the name too, for a profile with no host to compare', () => {
        const ws = conn({ name: 'Achaea', mode: 'websocket', url: 'wss://example.com' });
        // uniqueConnectionName renames a repeat, and that is still the same game.
        const second = conn({ name: 'Achaea (2)', mode: 'websocket', url: 'wss://example.com' });
        expect(profilesForGame(achaea, [ws, second])).toEqual([ws, second]);
    });

    it('counts a game reachable under an alternate hostname', () => {
        const mg = findBundledGame('MorgenGrauen')!;
        const p = conn({ name: 'MG', host: 'mg.mud.de', port: 23 });
        expect(profilesForGame(mg, [p])).toEqual([p]);
    });

    it('is empty for a game the player has never set up', () => {
        expect(profilesForGame(achaea, [conn({ name: 'Aetolia', host: 'aetolia.com', port: 23 })]))
            .toEqual([]);
    });
});
