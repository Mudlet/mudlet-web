import { describe, it, expect } from 'vitest';
import {
    auroraFor, formatLastPlayed, mergeGridOrder, parseTypedAddress, pickHero, searchLauncher, sortByLastPlayed, SEARCH_GROUP_LIMIT,
} from '../../src/ui/launcher/launcherModel';
import { nameInitials } from '../../src/ui/launcher/LauncherSearch';
import { PLAYABLE_GAMES } from '../../src/mud/games/gameLinks';
import type { MudConnection } from '../../src/storage';

const conn = (id: string, extra: Partial<MudConnection> = {}): MudConnection =>
    ({ id, name: id, mode: 'mud', host: `${id}.example.org`, port: 23, ...extra });

describe('sortByLastPlayed', () => {
    it('puts the most recently played first', () => {
        const order = sortByLastPlayed([
            conn('old', { lastConnectedAt: 100 }),
            conn('new', { lastConnectedAt: 300 }),
            conn('mid', { lastConnectedAt: 200 }),
        ]).map(c => c.id);
        expect(order).toEqual(['new', 'mid', 'old']);
    });

    it('keeps never-played profiles after played ones, in stored order', () => {
        const order = sortByLastPlayed([
            conn('a'), conn('played', { lastConnectedAt: 1 }), conn('b'), conn('c'),
        ]).map(c => c.id);
        expect(order).toEqual(['played', 'a', 'b', 'c']);
    });

    it('leaves an upgraded list (nothing played yet) in the order the player arranged', () => {
        const list = [conn('z'), conn('a'), conn('m')];
        expect(sortByLastPlayed(list).map(c => c.id)).toEqual(['z', 'a', 'm']);
    });

    it('does not mutate its input', () => {
        const list = [conn('a'), conn('b', { lastConnectedAt: 5 })];
        sortByLastPlayed(list);
        expect(list.map(c => c.id)).toEqual(['a', 'b']);
    });
});

describe('formatLastPlayed', () => {
    const now = Date.UTC(2026, 10, 1, 12);
    const ago = (ms: number) => formatLastPlayed(now - ms, now);
    const H = 3_600_000, D = 24 * H;

    it('is null for a profile never played', () => {
        expect(formatLastPlayed(undefined, now)).toBeNull();
    });

    it.each([
        [10_000, 'just now'],
        [60_000, '1 minute ago'],
        [5 * 60_000, '5 minutes ago'],
        [2 * H, '2 hours ago'],
        [D + H, 'yesterday'],
        [3 * D, '3 days ago'],
        [9 * D, '1 week ago'],
        [45 * D, '1 month ago'],
        [800 * D, '2 years ago'],
    ])('%i ms ago reads as "%s"', (ms, text) => {
        expect(ago(ms)).toBe(text);
    });

    it('treats a timestamp from the future (clock skew) as just now', () => {
        expect(formatLastPlayed(now + 60_000, now)).toBe('just now');
    });
});

describe('auroraFor', () => {
    it('gives the same profile the same colours every time', () => {
        expect(auroraFor('My test MUD')).toEqual(auroraFor('My test MUD'));
    });

    it('gives near-identical names clearly different colours', () => {
        expect(auroraFor('Achaea').colors[0]).not.toBe(auroraFor('Achaea (2)').colors[0]);
    });

    it('copes with an empty name', () => {
        expect(auroraFor('').colors).toHaveLength(3);
    });
});

describe('parseTypedAddress', () => {
    it.each([
        ['mud.example.org', 'mud.example.org', 23],
        ['mud.example.org:4000', 'mud.example.org', 4000],
        ['localhost:4000', 'localhost', 4000],
        ['localhost', 'localhost', 23],
        ['  10.0.0.5:7000 ', '10.0.0.5', 7000],
    ])('reads %s as a host and port', (text, host, port) => {
        expect(parseTypedAddress(text)).toMatchObject({ mode: 'mud', host, port });
    });

    it('reads a ws(s) URL as a WebSocket profile', () => {
        expect(parseTypedAddress('wss://mud.example.org/ws')).toMatchObject({ mode: 'websocket' });
    });

    it.each(['achaea', 'two words', 'mud.example.org:99999', 'host:port', ''])(
        'does not offer %j as a server', text => {
            expect(parseTypedAddress(text)).toBeNull();
        },
    );
});

describe('searchLauncher', () => {
    const profiles = [
        conn('Achaea main', { host: 'achaea.com', lastConnectedAt: 1 }),
        conn('Alt', { host: 'achaea.com', lastConnectedAt: 9 }),
        conn('Arkadia', { host: 'arkadia.rpg.pl' }),
    ];

    it('returns nothing for an empty box', () => {
        expect(searchLauncher('  ', profiles, PLAYABLE_GAMES)).toEqual({ profiles: [], games: [], address: null });
    });

    it('finds profiles by name or host, most recently played first', () => {
        expect(searchLauncher('achaea', profiles, []).profiles.map(p => p.id)).toEqual(['Alt', 'Achaea main']);
    });

    it('finds catalogue games by name', () => {
        expect(searchLauncher('aard', [], PLAYABLE_GAMES).games.map(g => g.name)).toContain('Aardwolf');
    });

    it('does not search game descriptions', () => {
        // "weight" appears only in Achaea's blurb.
        expect(searchLauncher('carries weight', [], PLAYABLE_GAMES).games).toEqual([]);
    });

    it('caps each group', () => {
        expect(searchLauncher('a', [], PLAYABLE_GAMES).games).toHaveLength(SEARCH_GROUP_LIMIT);
    });

    it('offers the text as a server when it reads as one', () => {
        expect(searchLauncher('mud.example.org:4000', profiles, PLAYABLE_GAMES).address)
            .toMatchObject({ host: 'mud.example.org', port: 4000 });
    });
});

describe('pickHero', () => {
    it('features the profile played most recently', () => {
        expect(pickHero([conn('a', { lastConnectedAt: 1 }), conn('b', { lastConnectedAt: 3 }), conn('c')])?.id).toBe('b');
    });

    it('falls back to the first profile in the player\'s order when none has been played', () => {
        expect(pickHero([conn('z'), conn('a')])?.id).toBe('z');
    });

    it('is null with no profiles', () => {
        expect(pickHero([])).toBeNull();
    });
});

describe('mergeGridOrder', () => {
    it('reorders the grid\'s profiles and leaves the banner\'s where it was', () => {
        // 'hero' sits third and isn't in the grid.
        expect(mergeGridOrder(['a', 'b', 'hero', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'hero', 'b']);
    });

    it('is the identity when nothing moved', () => {
        expect(mergeGridOrder(['a', 'hero', 'b'], ['a', 'b'])).toEqual(['a', 'hero', 'b']);
    });
});

describe('nameInitials', () => {
    it.each([
        ['My test MUD', 'MT'],
        ['alteraeon.com', 'AL'],
        ['Arkadia', 'AR'],
        ['  ', '?'],
    ])('%j → %s', (name, initials) => {
        expect(nameInitials(name)).toBe(initials);
    });
});
