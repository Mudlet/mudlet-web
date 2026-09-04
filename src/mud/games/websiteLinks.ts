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

let parser: DOMParser | undefined;

/** The fragment, parsed. `parseFromString` is what a regex over `<a …>` can
 *  only approximate: it handles either quote style, any attribute order, and
 *  nested markup, and it decodes entities in text and attributes alike. The
 *  document it builds has no browsing context, so nothing in it runs or loads. */
function anchorsIn(html: string): HTMLAnchorElement[] {
    parser ??= new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    return [...doc.querySelectorAll<HTMLAnchorElement>('a[href]')];
}

/** An anchor's text, with any nested markup dropped and whitespace collapsed. */
function textOf(anchor: HTMLAnchorElement): string {
    return (anchor.textContent ?? '').replace(/\s+/g, ' ').trim();
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A label that is just the link's own address, which about half the catalogue
 *  uses (`<a href='http://www.bat.org'>http://www.bat.org</a>`): no spaces, and
 *  it parses as a host with a dot in it. The URL parser settles that without
 *  the ambiguous `(\S+\.)+` a hand-written pattern needs — `\S` matches the dot
 *  too, so a long dotless label makes it backtrack exponentially. */
function isBareUrlLabel(label: string): boolean {
    if (!label || /\s/.test(label)) return false;
    try {
        return new URL(HAS_SCHEME.test(label) ? label : `https://${label}`).hostname.includes('.');
    } catch {
        return false;
    }
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
    for (const anchor of anchorsIn(websiteInfo)) {
        // The attribute as written, not `.href` — that would resolve a relative
        // address against the page, and a relative address is one we drop.
        const href = (anchor.getAttribute('href') ?? '').trim();
        const label = textOf(anchor);
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
