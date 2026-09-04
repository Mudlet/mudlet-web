import type { BundledGame } from './bundledGames';

/**
 * Mudlet's catalogue carries each game's off-site links as a small HTML
 * fragment (`websiteInfo`), which desktop drops straight into a `website_entry`
 * label (`dlgConnectionProfiles.cpp`). A browser must not do the same: the
 * fragment is vendored upstream data, and injecting foreign HTML into the page
 * to render two anchors is a poor trade. So we read the anchors out and let the
 * caller render real elements.
 */

export interface GameLink {
    /** Anchor text as shown — "Website", "Forum", "Discord". */
    label: string;
    href: string;
}

/** `<a href='…'>Label</a>`, either quote style, any attribute order. */
const ANCHOR = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;

const ENTITIES: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ',
};

function decodeEntities(s: string): string {
    return s.replace(/&(#\d+|[a-z]+);/gi, (whole, name: string) => {
        const key = name.toLowerCase();
        if (key in ENTITIES) return ENTITIES[key];
        if (key.startsWith('#')) {
            const code = Number(key.slice(1));
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        return whole;
    });
}

/** Strip any nested markup and collapse whitespace, so the label is plain text. */
function textOf(html: string): string {
    return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** A label that is just the link's own address, which about half the catalogue
 *  uses (`<a href='http://www.bat.org'>http://www.bat.org</a>`): no spaces, and
 *  it reads as a hostname. */
function isBareUrlLabel(label: string): boolean {
    return !/\s/.test(label) && /^(https?:\/\/)?(\S+\.)+[a-z]{2,}(\/\S*)?$/i.test(label);
}

/** What to show for a link. A real label ("Website", "Discord", "Foros") is
 *  kept; a bare address becomes its hostname, so a narrow tile gets
 *  "aardwolf.com" rather than a wrapping "http://www.aardwolf.com". Desktop
 *  prints the fragment as-is, but it has a whole dialog column to do it in. */
function displayLabel(label: string, href: string): string {
    if (!isBareUrlLabel(label)) return label;
    try {
        return new URL(href).hostname.replace(/^www\./, '');
    } catch {
        return label;
    }
}

/** http(s) only. The catalogue holds nothing else, and a `javascript:` href
 *  reaching an anchor we render would be ours to answer for. */
function isSafeHref(href: string): boolean {
    try {
        return ['http:', 'https:'].includes(new URL(href).protocol);
    } catch {
        return false;
    }
}

/** The off-site links a game's `websiteInfo` names, in the order it lists them.
 *  Anchors with no label, no usable href, or a duplicate href are dropped. */
export function parseWebsiteLinks(websiteInfo: string | undefined): GameLink[] {
    if (!websiteInfo) return [];
    const out: GameLink[] = [];
    const seen = new Set<string>();
    for (const [, dq, sq, inner] of websiteInfo.matchAll(ANCHOR)) {
        const href = decodeEntities((dq ?? sq ?? '').trim());
        const label = textOf(inner);
        if (!label || !isSafeHref(href) || seen.has(href)) continue;
        seen.add(href);
        out.push({ label: displayLabel(label, href), href });
    }
    return out;
}

/** Whether `game` should show for a catalogue filter of `query`. Matches the
 *  name, the address and the blurb, so both "achaea" and "roleplay" find
 *  something; an empty query matches everything. */
export function gameMatchesQuery(game: BundledGame, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${game.name} ${game.hostUrl} ${game.port} ${game.description}`.toLowerCase().includes(q);
}
