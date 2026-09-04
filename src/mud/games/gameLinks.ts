import { BUNDLED_GAMES, findBundledGame, type BundledGame } from './bundledGames';
import type { MudConnection } from '../../storage';

/**
 * Deep links into the bundled-game catalogue, so a page elsewhere (mudlet.org's
 * game list, a MUD's own site) can hand someone a "Play Astaria" button that
 * lands them in the client with that game already picked.
 *
 * The link never creates anything on its own: the landing screen offers the
 * player's existing profiles for the game and a prefilled Add form, the same
 * choice a click on the game's tile gives. A bookmarked link is therefore safe
 * to open repeatedly — it can't quietly pile up profiles.
 */

/** Query parameter carrying the game — `?play=astaria`. */
export const GAME_LINK_PARAM = 'play';

/** URL-safe id for a game name: lowercase, runs of anything else collapsed to
 *  a single dash. "Avalon.de" → `avalon-de`, "God Wars II" → `god-wars-ii`.
 *  No two catalogue entries share a slug (pinned by a test). */
export function gameSlug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Catalogue entries that aren't games to offer. Mudlet's tutorial points at a
 *  local stub with no port — nothing to connect to here. "Mudlet self-test" has
 *  a real address but is a Busted harness for testing Mudlet itself, and Mudlet
 *  treats it as a special case throughout dlgConnectionProfiles rather than as
 *  one of the games; it has no place in a list of MUDs to play. */
const NOT_A_GAME = new Set(['Mudlet self-test']);

/**
 * The games this client offers — listed in the grid, and the only ones a
 * `?play=` link resolves to. Sorted by name, which is the order the grid draws
 * them in.
 */
export const PLAYABLE_GAMES: readonly BundledGame[] = BUNDLED_GAMES
    .filter(g => g.port > 0 && g.hostUrl && !NOT_A_GAME.has(g.name))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

/** The playable game a `?play=` value names. Accepts the slug or the exact
 *  name (`?play=Avalon.de` works as well as `?play=avalon-de`), so a hand-written
 *  link doesn't have to know the slugging rule. Null for anything else. */
export function findGameByLink(value: string | null | undefined): BundledGame | null {
    const wanted = (value ?? '').trim();
    if (!wanted) return null;
    const exact = findBundledGame(wanted);
    const slug = gameSlug(wanted);
    const game = exact ?? BUNDLED_GAMES.find(g => gameSlug(g.name) === slug) ?? null;
    return game && PLAYABLE_GAMES.includes(game) ? game : null;
}

/** The link that opens `game` in a client hosted at `base`. What you paste into
 *  a "Play <game>" button on a website. */
export function gameLinkUrl(game: BundledGame, base: string): string {
    const url = new URL(base);
    url.searchParams.set(GAME_LINK_PARAM, gameSlug(game.name));
    return url.toString();
}

/**
 * Whether `connection` is a profile for `game`.
 *
 * Matched on the host (including the game's alternate hostnames) so a profile
 * someone typed in by hand counts, and on the name so a websocket-mode profile
 * — which has no host — still does. `uniqueConnectionName` renames a repeat to
 * "Achaea (2)", so name matching accepts that suffix too.
 */
function matchesGame(game: BundledGame, connection: MudConnection): boolean {
    const host = connection.host?.trim().toLowerCase();
    if (host && [game.hostUrl, ...(game.alternateHostUrls ?? [])].some(h => h.toLowerCase() === host)) return true;
    const name = game.name.trim().toLowerCase();
    const own = connection.name.trim().toLowerCase();
    return own === name || own.startsWith(`${name} (`);
}

/** The player's existing profiles for `game`, in launcher order. */
export function profilesForGame(game: BundledGame, connections: MudConnection[]): MudConnection[] {
    return connections.filter(c => matchesGame(game, c));
}

/** The bundled game a profile is for, or null if it isn't one of them. What
 *  lets the launcher draw the game's logo on a profile that carries no icon of
 *  its own — including one renamed, or created as a second "Achaea (2)". */
export function findGameForConnection(connection: MudConnection): BundledGame | null {
    return PLAYABLE_GAMES.find(g => matchesGame(g, connection)) ?? null;
}
