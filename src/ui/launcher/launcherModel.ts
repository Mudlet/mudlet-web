import type { BundledGame } from '../../mud/games/bundledGames';
import { validateHost, validatePort, validateWsUrl, type MudConnection } from '../../storage';

/**
 * The launcher's non-visual logic: ordering profiles by when they were last
 * played, the colours a profile with no icon is drawn in, and the "Where to?"
 * search. Kept free of React so each rule is testable on its own.
 */

/** Profiles most recently played first. Never-played profiles follow, in their
 *  stored order — so a player upgrading from the drag-ordered launcher sees
 *  their own arrangement until they start playing, rather than a shuffle. */
export function sortByLastPlayed(connections: readonly MudConnection[]): MudConnection[] {
    return connections
        .map((c, index) => ({ c, index }))
        .sort((a, b) => {
            const ta = a.c.lastConnectedAt ?? -1;
            const tb = b.c.lastConnectedAt ?? -1;
            return tb !== ta ? tb - ta : a.index - b.index;
        })
        .map(({ c }) => c);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago" — coarse on purpose:
 *  it orients ("which one did I play last?"), it isn't a log. Null when the
 *  profile has never been played. */
export function formatLastPlayed(ts: number | undefined, now = Date.now()): string | null {
    if (ts === undefined) return null;
    const ago = Math.max(0, now - ts);
    if (ago < MINUTE) return 'just now';
    if (ago < HOUR) return plural(Math.floor(ago / MINUTE), 'minute');
    if (ago < DAY) return plural(Math.floor(ago / HOUR), 'hour');
    const days = Math.floor(ago / DAY);
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    if (days < 30) return plural(Math.floor(days / 7), 'week');
    if (days < 365) return plural(Math.floor(days / 30), 'month');
    return plural(Math.floor(days / 365), 'year');
}

function plural(n: number, unit: string): string {
    return n === 1 ? `1 ${unit} ago` : `${n} ${unit}s ago`;
}

/** FNV-1a — a small, well-spread string hash, so similar names ("Achaea",
 *  "Achaea (2)") still land on clearly different colours. */
function hash(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

export interface Aurora {
    /** Near-black background tinted toward the main hue. */
    base: string;
    /** The swept colours: main hue, a neighbour, and a contrasting accent. */
    colors: [string, string, string];
    /** Where the conic sweep starts, in degrees. */
    angle: number;
    /** Centre of the sweep, as percentages of the box. */
    at: [number, number];
}

/** The aurora a profile with no icon is drawn with. Derived from the name
 *  alone, so a profile looks the same on every visit and in every tab, and
 *  nothing has to be stored. */
export function auroraFor(name: string): Aurora {
    const h = hash(name || '?');
    const hue = h % 360;
    const neighbour = (hue + 40 + ((h >>> 9) % 40)) % 360;
    const accent = (hue + 150 + ((h >>> 15) % 60)) % 360;
    return {
        base: `hsl(${hue} 30% 5%)`,
        colors: [`hsl(${hue} 60% 34%)`, `hsl(${neighbour} 50% 30%)`, `hsl(${accent} 55% 26%)`],
        angle: (h >>> 3) % 360,
        at: [25 + ((h >>> 11) % 30), 40 + ((h >>> 19) % 30)],
    };
}

/** CSS `background` for an aurora, ready for an inline style. */
export function auroraBackground(a: Aurora): string {
    const [c1, c2, c3] = a.colors;
    return `conic-gradient(from ${a.angle}deg at ${a.at[0]}% ${a.at[1]}%, ${a.base} 0deg, ${c1} 70deg, ${c2} 140deg, ${a.base} 220deg, ${c3} 300deg, ${a.base} 360deg)`;
}

/** A server typed straight into the search box. */
export type TypedAddress =
    | { mode: 'mud'; host: string; port: number; label: string }
    | { mode: 'websocket'; url: string; label: string };

/**
 * Read `host`, `host:port` or a `ws(s)://` URL out of the search box. A bare
 * word is only taken as a host when it is `localhost` — otherwise every name
 * typed while searching ("achaea") would also be offered as a server.
 */
export function parseTypedAddress(query: string): TypedAddress | null {
    const text = query.trim();
    if (!text) return null;
    if (/^wss?:\/\//i.test(text)) {
        const v = validateWsUrl(text);
        return v.ok ? { mode: 'websocket', url: v.url, label: v.url } : null;
    }
    const m = /^([^\s:/]+)(?::(\d+))?$/.exec(text);
    if (!m) return null;
    const [, hostText, portText] = m;
    if (!portText && !hostText.includes('.') && hostText.toLowerCase() !== 'localhost') return null;
    const host = validateHost(hostText);
    if (!host.ok) return null;
    const port = validatePort(portText ?? '');
    if (!port.ok) return null;
    return { mode: 'mud', host: host.host, port: port.port, label: `${host.host}:${port.port}` };
}

/** Whether `query` matches as a word prefix or substring of any of `fields` —
 *  "ach" finds Achaea, "mud.org" finds aardmud.org. */
function matches(query: string, fields: (string | undefined)[]): boolean {
    return fields.some(f => !!f && f.toLowerCase().includes(query));
}

export interface LauncherResults {
    profiles: MudConnection[];
    games: BundledGame[];
    address: TypedAddress | null;
}

export const SEARCH_GROUP_LIMIT = 5;

/**
 * What the "Where to?" box offers for `query`: the player's profiles, catalogue
 * games, and the text itself as a server address when it reads as one.
 * Descriptions are deliberately not searched — "dark" would match half the
 * catalogue, and the box is for going somewhere, not browsing.
 */
export function searchLauncher(
    query: string,
    connections: readonly MudConnection[],
    games: readonly BundledGame[],
): LauncherResults {
    const q = query.trim().toLowerCase();
    if (!q) return { profiles: [], games: [], address: null };
    const profiles = sortByLastPlayed(connections)
        .filter(c => matches(q, [c.name, c.host, c.url]))
        .slice(0, SEARCH_GROUP_LIMIT);
    const gameHits = games
        .filter(g => matches(q, [g.name, g.hostUrl, ...(g.alternateHostUrls ?? [])]))
        .slice(0, SEARCH_GROUP_LIMIT);
    return { profiles, games: gameHits, address: parseTypedAddress(query) };
}

/** The profile the "Continue playing" banner features: the one played most
 *  recently, or — before anything has been played — the first in the
 *  player's own order. */
export function pickHero(connections: readonly MudConnection[]): MudConnection | null {
    let best: MudConnection | null = null;
    for (const c of connections) {
        if (c.lastConnectedAt !== undefined && (best?.lastConnectedAt ?? -1) < c.lastConnectedAt) best = c;
    }
    return best ?? connections[0] ?? null;
}

/**
 * Fold a new order of the grid's profiles back into the full stored order.
 * The banner's profile isn't in the grid, so it keeps the slot it had —
 * otherwise every drag would shove it to the end, and it would reappear
 * there once another profile took the banner.
 */
export function mergeGridOrder(allIds: readonly string[], gridIds: readonly string[]): string[] {
    const inGrid = new Set(gridIds);
    let i = 0;
    return allIds.map(id => (inGrid.has(id) ? gridIds[i++] : id));
}
