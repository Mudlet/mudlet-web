import { findBundledGame, type BundledGame } from './bundledGames';

/**
 * Logos for the bundled games, vendored from Mudlet's `src/icons/` by
 * `scripts/sync-mudlet-games.mjs`.
 *
 * These are emitted as ordinary assets rather than inlined the way
 * `src/assets/qt-resources` inlines its handful. That module inlines because Lua
 * needs the bytes synchronously (`getImageSize` cannot await a fetch); nothing
 * here does. 1.7 MB of logos as data URIs would land in the JS bundle for every
 * user, including the ones who never open the game list — as files the browser
 * fetches only the tiles it actually draws, and caches them.
 *
 * `eager: true` so the map is a plain lookup: the values are URLs, not the
 * images, so nothing is downloaded by building it.
 */
const ICON_URLS: Record<string, string> = Object.fromEntries(
    Object.entries(
        import.meta.glob('./icons/*', { query: '?url', import: 'default', eager: true }) as Record<string, string>,
    ).map(([path, url]) => [path.replace('./icons/', ''), url]),
);

/** URL of a bundled game's logo, or null when it has none vendored. Accepts the
 *  entry or its exact name, so a caller holding only a profile name (which is
 *  the game's name for a profile made from the catalogue) can ask too. */
export function gameIconUrl(game: BundledGame | string | undefined): string | null {
    const entry = typeof game === 'string' ? findBundledGame(game) : game;
    const file = entry?.iconFile;
    return file ? ICON_URLS[file] ?? null : null;
}
