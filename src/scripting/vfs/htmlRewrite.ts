import type { ProfileVFS } from './ProfileVFS';
import { rewriteVfsUrlsInCss, vfsRefToUrl } from './cssRewrite';

// Match a whole start tag, capturing its attribute run. Quoted attribute values
// are consumed as units so a `>` inside one (e.g. `alt="a > b"`) doesn't end the
// tag early. Matching tags — rather than scanning the raw string for `src=` —
// keeps text content untouched: a label that echoes the literal text
// `src="foo"` must not have it rewritten.
const TAG_RE = /<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>/g;

// One attribute inside a tag's attribute run: unquoted, single-, or
// double-quoted value.
const ATTR_RE = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;

/**
 * Rewrite profile-local asset references in Lua-supplied HTML to the
 * `/__vfs/<connectionId>/<path>` URLs the service worker serves.
 *
 * Mudlet renders `echo(labelName, html)` as Qt rich text, where
 * `<img src="/home/user/.config/mudlet/profiles/X/pkg/icon.png">` loads straight
 * off the local filesystem. In the browser there is no such filesystem — the
 * bytes live in the profile's ProfileVFS, reachable only through the service
 * worker — so those paths have to be rebased or the images silently 404 (on a
 * dev server they resolve to the SPA fallback `index.html`, which decodes as a
 * broken image).
 *
 * Two kinds of reference are rewritten:
 *   - `src` attributes (`<img>`, and anything else Qt resolves as a resource)
 *   - `url(...)` refs inside an inline `style` attribute, via the same
 *     stylesheet rewriter used for setLabelStyleSheet
 *
 * `href` is deliberately left alone: label links are navigation targets
 * (openUrl / setLinkStyle), not embedded resources, and rewriting them would
 * turn an anchor into a VFS fetch.
 *
 * Absolute http(s)/data:/blob:/already-`__vfs` references pass through
 * untouched, as do paths when no VFS is mounted.
 */
export function rewriteVfsUrlsInHtml(html: string, connectionId: string, vfs: ProfileVFS): string {
    if (!html || html.indexOf('<') === -1) return html;
    return html.replace(TAG_RE, (full, name: string, attrs: string, selfClose: string) => {
        if (!attrs) return full;
        let touched = false;
        const rewritten = attrs.replace(
            ATTR_RE,
            (attrFull, attrName: string, dq?: string, sq?: string, bare?: string) => {
                const lower = attrName.toLowerCase();
                const value = dq ?? sq ?? bare ?? '';

                if (lower === 'src') {
                    // Attribute values arrive HTML-escaped; resolve against the
                    // VFS in decoded form, then re-emit double-quoted with the
                    // value escaped, so the tag stays well-formed whichever
                    // quote style (or none) the source attribute used.
                    const url = vfsRefToUrl(decodeEntities(value), connectionId, vfs);
                    if (url === null) return attrFull;
                    touched = true;
                    return `${attrName}="${escapeForAttr(url)}"`;
                }

                if (lower === 'style') {
                    const css = rewriteVfsUrlsInCss(decodeEntities(value), connectionId, vfs);
                    if (css === decodeEntities(value)) return attrFull;
                    touched = true;
                    // The CSS rewriter emits url("...") with double quotes, so
                    // the attribute must not itself be double-quoted verbatim —
                    // escape rather than switching quote style, which would
                    // break on a value containing both.
                    return `${attrName}="${escapeForAttr(css)}"`;
                }

                return attrFull;
            },
        );
        if (!touched) return full;
        return `<${name}${rewritten}${selfClose}>`;
    });
}

/** Decode the entities an HTML attribute value can legally carry. Enough for
 *  the asset paths packages emit — full entity decoding isn't needed and would
 *  risk mangling a path that contains a bare `&`. */
function decodeEntities(value: string): string {
    return value
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&');
}

/** Escape a value for use inside a double-quoted HTML attribute. */
function escapeForAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
