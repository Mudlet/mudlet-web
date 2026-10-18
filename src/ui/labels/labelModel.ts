/**
 * The text-side half of Mudlet's `TLabelModel` (src/TLabelModel.cpp): what a
 * label does to the text and the stylesheet it is given, kept apart from the
 * widget so it can be ported line for line. Two jobs:
 *
 *  - {@link styleSheetWithoutBackgroundImage}, which `resetBackgroundImage`
 *    applies to the label's own stylesheet;
 *  - the link-styling pass (`TLabelModel::styleLinks` and friends): every
 *    `<a href=…>` in a label's text gets an inline `style` carrying the colours
 *    `setLinkStyle` asked for, because QTextDocument reads neither the widget
 *    stylesheet nor the palette for link colours. `getLabelText` answers with
 *    the styled text, so the pass has to happen here, and each tag it rewrote is
 *    remembered so the text can be given back as it was written — on
 *    `resetLinkStyle`, and when a script echoes what it read back.
 *
 * Indices are UTF-16 code units, which is what both QString and a JS string
 * index by, so the scanners carry over unchanged.
 */

/** A tag the last styling pass rewrote, and what it was given as. */
export interface StyledAnchor {
    styled: string;
    original: string;
}

/** The link-styling state a label carries between passes (TLabelModel's
 *  `mUnstyledText`, `mStyledText` and `mStyledAnchors`). */
export interface LinkStyleState {
    /** The text the last pass was given, before any styling. */
    unstyled: string;
    /** What the last pass produced. */
    styled: string;
    anchors: StyledAnchor[];
}

export interface LinkStyle {
    color?: string;
    visitedColor?: string;
    underline: boolean;
}

// ── Stylesheet ──────────────────────────────────────────────────────────────

/** Qt's QChar::isSpace, near enough: what a JS `\s` matches. */
const isSpace = (c: string) => /\s/.test(c);

/** Index just past the quoted string or comment starting at i, or i when none
 *  starts there. */
function pastQuoteOrComment(sheet: string, i: number): number {
    const c = sheet[i];
    if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < sheet.length && sheet[j] !== c) {
            j += sheet[j] === '\\' ? 2 : 1;
        }
        return Math.min(j + 1, sheet.length);
    }
    if (c === '/' && i + 1 < sheet.length && sheet[i + 1] === '*') {
        const end = sheet.indexOf('*/', i + 2);
        return end < 0 ? sheet.length : end + 2;
    }
    return i;
}

/** The end of the background-image declaration starting at i, or i when none
 *  starts there; a url() may hold a ';' of its own, as a data: URI does. Qt
 *  reads property names in any case. */
function pastBackgroundImageDeclaration(sheet: string, i: number): number {
    const property = 'background-image';
    if (sheet.slice(i, i + property.length).toLowerCase() !== property) return i;
    let j = i + property.length;
    while (j < sheet.length && isSpace(sheet[j])) ++j;
    if (j === sheet.length || sheet[j] !== ':') return i;
    let parentheses = 0;
    while (++j < sheet.length) {
        const skipped = pastQuoteOrComment(sheet, j);
        if (skipped !== j) {
            j = skipped - 1;
            continue;
        }
        const c = sheet[j];
        if (c === '(') {
            ++parentheses;
        } else if (c === ')' && parentheses > 0) {
            --parentheses;
        } else if (parentheses === 0 && c === ';') {
            return j + 1;
        } else if (parentheses === 0 && c === '}') {
            return j;
        }
    }
    return j;
}

/**
 * `sheet` with every background-image declaration taken out, and nothing else
 * touched. Comments, quoted strings and a url()'s contents hold no declarations
 * and no braces, as in CSS; a declaration starts the sheet or follows a ';' or
 * a rule's '}', so selector text such as `QLabel#background-image:hover` is not
 * one. Geyser.Label carries a Lua copy of the same scanner and the specs
 * compare the two character for character, so this follows the C++ exactly.
 */
export function styleSheetWithoutBackgroundImage(sheet: string): string {
    let result = '';
    let copiedUpTo = 0;
    let braces = 0;
    let parentheses = 0;
    let declarationCanStart = true;
    let i = 0;
    while (i < sheet.length) {
        const skipped = pastQuoteOrComment(sheet, i);
        if (skipped !== i) {
            if (sheet[i] !== '/') declarationCanStart = false;
            i = skipped;
            continue;
        }
        const c = sheet[i];
        if (c === '(') {
            ++parentheses;
        } else if (c === ')' && parentheses > 0) {
            --parentheses;
        }
        if (parentheses > 0) {
            ++i;
            continue;
        }
        if (braces === 0 && declarationCanStart) {
            const end = pastBackgroundImageDeclaration(sheet, i);
            if (end !== i) {
                result += sheet.slice(copiedUpTo, i);
                copiedUpTo = end;
                i = end;
                continue;
            }
        }
        if (c === '{') {
            ++braces;
        } else if (c === '}' && braces > 0) {
            --braces;
        }
        if (!isSpace(c)) declarationCanStart = c === ';' || c === '}';
        ++i;
    }
    return result + sheet.slice(copiedUpTo);
}

// ── Links ───────────────────────────────────────────────────────────────────

/**
 * Whether `text` holds an anchor tag: a `<a` followed by whitespace whose
 * closing `>` comes before any other `<`. Not a case-insensitive
 * contains("<a "): that cannot tell a tag from prose.
 */
export function containsAnchorTag(text: string): boolean {
    let close = -1;
    for (let at = text.indexOf('<'); at >= 0 && at + 2 < text.length; at = text.indexOf('<', at + 1)) {
        const tagName = text[at + 1];
        if ((tagName !== 'a' && tagName !== 'A') || !isSpace(text[at + 2])) continue;
        // Re-searched only once the walk passes the last '>' found, keeping the
        // scans linear.
        if (close < at) {
            close = text.indexOf('>', at + 3);
            // no tag anywhere past here can be closed either
            if (close < 0) return false;
        }
        const nextOpen = text.indexOf('<', at + 3);
        if (nextOpen < 0 || close < nextOpen) return true;
    }
    return false;
}

// Qt's QRegularExpression \s, without Unicode properties: ASCII whitespace
// only, so an anchor split by a non-breaking space is clickable but unstyled.
const WS = '[ \\t\\n\\r\\f\\v]';

/** The closing quote has to be the one that opened the value: a Lua command
 *  link holds the other kind. Deliberately strict (lowercase, href first, no
 *  spacing around `=`) — the shape Mudlet's own HTML generation produces. */
const ANCHOR_TAG = new RegExp(`<a${WS}+href=("[^"]*"|'[^']*')([^>]*)>`, 'g');

/** One attribute with the whitespace before it, if any — Qt also reads one
 *  written straight after a quote. Sticky: matched only where reading stopped. */
const ANCHOR_ATTRIBUTE = new RegExp(
    `${WS}*([^ \\t\\n\\r\\f\\v=>"']+)(?:${WS}*=${WS}*(?:"[^"]*"|'[^']*'|[^ \\t\\n\\r\\f\\v>"']*))?`, 'y');

/** The attributes are read one after another from the start, so that neither
 *  `data-style=` nor a value holding "style=" is taken for a style attribute;
 *  reading stops at the first thing that is not one. */
function withoutStyleAttributes(attributes: string): string {
    let result = '';
    let at = 0;
    while (at < attributes.length) {
        ANCHOR_ATTRIBUTE.lastIndex = at;
        const attribute = ANCHOR_ATTRIBUTE.exec(attributes);
        if (!attribute || attribute[0].length === 0) break;
        if (attribute[1].toLowerCase() !== 'style') result += attribute[0];
        at = ANCHOR_ATTRIBUTE.lastIndex;
    }
    return result + attributes.slice(at);
}

/** QString::toHtmlEscaped. */
function htmlEscaped(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Text read back with getLabelText() carries the anchor tags the last pass
 * rewrote; each is put back as it was given. Any other tag is the script's own.
 * `current` is what the label shows now: once a picture, a movie or a
 * stylesheet's qproperty-text has taken the place of what the last pass showed,
 * nothing is recognised.
 */
function withoutInjectedLinkStyles(text: string, state: LinkStyleState | undefined, current: string): string {
    if (!state || state.anchors.length === 0 || current !== state.styled) return text;
    let result = '';
    let copied = 0;
    const restored = state.anchors.map(() => false);
    for (const match of text.matchAll(ANCHOR_TAG)) {
        const start = match.index ?? 0;
        for (let i = 0; i < state.anchors.length; ++i) {
            if (!restored[i] && state.anchors[i].styled === match[0]) {
                result += text.slice(copied, start) + state.anchors[i].original;
                copied = start + match[0].length;
                restored[i] = true;
                break;
            }
        }
    }
    return result + text.slice(copied);
}

/**
 * TLabelModel::styleLinks: style every anchor in `text`, returning the styled
 * text and the state the next pass needs. Only the tags shown now are
 * recognised when read back, and only unchanged.
 */
function styleLinks(text: string, style: LinkStyle | undefined, visited: ReadonlySet<string> | undefined):
    { text: string; state: LinkStyleState } {
    const state: LinkStyleState = { unstyled: text, styled: text, anchors: [] };
    if (!style || (!style.color && !style.visitedColor) || !containsAnchorTag(text)) {
        return { text, state };
    }
    let styled = '';
    let copied = 0;
    for (const match of text.matchAll(ANCHOR_TAG)) {
        const start = match.index ?? 0;
        const hrefPart = match[1];
        const url = hrefPart.slice(1, -1);
        let linkStyle = '';
        if (visited?.has(url) && style.visitedColor) {
            linkStyle += `color: ${htmlEscaped(style.visitedColor)}; `;
        } else if (style.color) {
            linkStyle += `color: ${htmlEscaped(style.color)}; `;
        }
        if (!style.underline) linkStyle += 'text-decoration: none; ';
        if (!linkStyle) continue;
        // Overwrites any style attribute the link has rather than merging.
        const replacement = `<a href=${hrefPart} style="${linkStyle.trim()}"${withoutStyleAttributes(match[2])}>`;
        styled += text.slice(copied, start) + replacement;
        copied = start + match[0].length;
        state.anchors.push({ styled: replacement, original: match[0] });
    }
    styled += text.slice(copied);
    state.styled = styled;
    return { text: styled, state };
}

/** TLabelModel::linkStyledText — what TLabel::setText shows for `text`, with
 *  whatever the last pass injected into it put back first. */
export function linkStyledText(
    text: string, style: LinkStyle | undefined, visited: ReadonlySet<string> | undefined,
    state: LinkStyleState | undefined, current: string,
): { text: string; state: LinkStyleState } {
    return styleLinks(withoutInjectedLinkStyles(text, state, current), style, visited);
}

/** TLabelModel::restyledText — the last pass's input styled again, after the
 *  link style or the visited links changed. */
export function restyledText(
    style: LinkStyle | undefined, visited: ReadonlySet<string> | undefined, state: LinkStyleState,
): { text: string; state: LinkStyleState } {
    return styleLinks(state.unstyled, style, visited);
}
