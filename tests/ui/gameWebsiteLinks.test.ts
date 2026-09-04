import { describe, it, expect } from 'vitest';
import { parseWebsiteLinks, gameMatchesQuery } from '../../src/mud/games/websiteLinks';
import { PLAYABLE_GAMES } from '../../src/mud/games/gameLinks';
import type { BundledGame } from '../../src/mud/games/bundledGames';

function game(over: Partial<BundledGame> = {}): BundledGame {
    return {
        name: 'Achaea',
        hostUrl: 'achaea.com',
        port: 23,
        tlsEnabled: false,
        websiteInfo: '',
        icon: '',
        description: 'In Achaea, your name carries weight.',
        ...over,
    };
}

describe('parseWebsiteLinks', () => {
    it('reads the anchors the catalogue ships, in order', () => {
        expect(parseWebsiteLinks(
            "<a href='http://www.achaea.com/'>Website</a><br><a href='https://discord.gg/2v2upFTj8G'>Discord</a>",
        )).toEqual([
            { label: 'Website', href: 'http://www.achaea.com/' },
            { label: 'Discord', href: 'https://discord.gg/2v2upFTj8G' },
        ]);
    });

    it('accepts either quote style and any attribute order', () => {
        expect(parseWebsiteLinks(
            '<a target="_blank" href="https://example.com" rel="x">Forum</a>',
        )).toEqual([{ label: 'Forum', href: 'https://example.com' }]);
    });

    it('is empty for a game with no links', () => {
        expect(parseWebsiteLinks('')).toEqual([]);
        expect(parseWebsiteLinks(undefined)).toEqual([]);
        expect(parseWebsiteLinks('just some text')).toEqual([]);
    });

    // We render these as real anchors, so a scheme we would not want to hand a
    // click to must not survive the parse.
    it('keeps only http(s) hrefs', () => {
        expect(parseWebsiteLinks("<a href='javascript:alert(1)'>Click</a>")).toEqual([]);
        expect(parseWebsiteLinks("<a href='data:text/html,x'>Click</a>")).toEqual([]);
        expect(parseWebsiteLinks("<a href='/relative'>Click</a>")).toEqual([]);
        expect(parseWebsiteLinks("<a href='ftp://example.com'>Files</a>")).toEqual([]);
    });

    it('flattens nested markup and entities in the label', () => {
        expect(parseWebsiteLinks("<a href='https://example.com'><b>Web</b>&amp;Forum</a>"))
            .toEqual([{ label: 'Web&Forum', href: 'https://example.com' }]);
    });

    // A single-pass regex tag-strip hands `<scr<b>ipt>` back out as a whole tag
    // — it removes the inner `<b>` and closes the outer one up (CodeQL alert
    // 22). We parse, so the label reads as a browser reads it.
    it('flattens markup a single-pass tag strip would reassemble', () => {
        expect(parseWebsiteLinks("<a href='https://example.com'>Ho<scr<b>ipt>me</a>"))
            .toEqual([{ label: 'Hoipt>me', href: 'https://example.com' }]);
    });

    // The bare-address test used to be `(\S+\.)+[a-z]{2,}`, where `\S` matches
    // the dot as well — 20 repetitions of "!." already took 5ms and each one
    // after that doubled it (CodeQL alert 21). Nothing here may scale with the
    // label's length.
    it('answers a pathological label without backtracking', () => {
        const started = performance.now();
        expect(parseWebsiteLinks(`<a href='https://example.com'>${'!.'.repeat(60)}!</a>`))
            .toEqual([{ label: 'example.com', href: 'https://example.com' }]);
        expect(performance.now() - started).toBeLessThan(1000);
    });

    // About half the catalogue labels its one link with the address itself.
    it('shortens a bare-address label to its hostname', () => {
        expect(parseWebsiteLinks("<a href='http://www.aardwolf.com/'>http://www.aardwolf.com</a>"))
            .toEqual([{ label: 'aardwolf.com', href: 'http://www.aardwolf.com/' }]);
        expect(parseWebsiteLinks("<a href='https://astariamud.com'>astariamud.com</a>"))
            .toEqual([{ label: 'astariamud.com', href: 'https://astariamud.com' }]);
    });

    it('leaves a real label alone, even one naming a site', () => {
        expect(parseWebsiteLinks("<a href='https://example.com'>Website</a>")[0].label).toBe('Website');
        expect(parseWebsiteLinks("<a href='https://youtube.com/x'>Petria - YouTube</a>")[0].label)
            .toBe('Petria - YouTube');
        expect(parseWebsiteLinks("<a href='https://reinosdeleyenda.es/foro/'>Foros</a>")[0].label)
            .toBe('Foros');
    });

    it('drops an anchor with no label, and a repeated href', () => {
        expect(parseWebsiteLinks("<a href='https://example.com'></a>")).toEqual([]);
        expect(parseWebsiteLinks(
            "<a href='https://example.com'>Website</a><a href='https://example.com'>Home</a>",
        )).toEqual([{ label: 'Website', href: 'https://example.com' }]);
    });

    // The point of the feature: the data was vendored but never rendered.
    it('finds links for most of the real catalogue', () => {
        const withLinks = PLAYABLE_GAMES.filter(g => parseWebsiteLinks(g.websiteInfo).length > 0);
        expect(withLinks.length).toBeGreaterThan(PLAYABLE_GAMES.length / 2);
    });

    it('never yields a non-http(s) href across the whole catalogue', () => {
        for (const g of PLAYABLE_GAMES) {
            for (const link of parseWebsiteLinks(g.websiteInfo)) {
                expect(link.href).toMatch(/^https?:\/\//);
                expect(link.label).not.toBe('');
            }
        }
    });
});

describe('gameMatchesQuery', () => {
    it('matches everything on an empty or blank query', () => {
        expect(gameMatchesQuery(game(), '')).toBe(true);
        expect(gameMatchesQuery(game(), '   ')).toBe(true);
    });

    it('matches the name, case-insensitively', () => {
        expect(gameMatchesQuery(game(), 'ACHA')).toBe(true);
        expect(gameMatchesQuery(game(), 'aetolia')).toBe(false);
    });

    it('matches the address and the port', () => {
        expect(gameMatchesQuery(game(), 'achaea.com')).toBe(true);
        expect(gameMatchesQuery(game({ port: 4000 }), '4000')).toBe(true);
    });

    // Finding "Reinos de Leyenda" by scrolling past 36 tiles was the complaint;
    // searching the blurb is what makes a topic like "roleplay" findable too.
    it('matches the description', () => {
        expect(gameMatchesQuery(game(), 'carries weight')).toBe(true);
    });

    it('narrows the real catalogue to one game for a distinctive name', () => {
        const hits = PLAYABLE_GAMES.filter(g => gameMatchesQuery(g, 'reinos'));
        expect(hits.map(g => g.name)).toEqual(['Reinos de Leyenda']);
    });
});
