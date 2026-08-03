import type { ProfileVFS } from './ProfileVFS';
import { vfsUrlFor } from './vfsBridge';
import { isQtResourcePath, qtResourceUrl } from '../../assets/qt-resources';

// Match url(<ref>) where <ref> is unquoted, single-quoted, or double-quoted.
// The CSS spec allows whitespace around the ref but no balanced parens inside,
// which is fine for the asset URLs scripts emit.
const URL_RE = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/g;

const PASSTHROUGH_PREFIX = /^(?:https?:|data:|blob:|\/__vfs\/)/i;

/**
 * Map one asset reference onto the URL the service worker serves, or return
 * null when it must be left alone (empty, or already an absolute http/data/
 * blob/__vfs URL). Paths are resolved through the VFS (honouring its cwd and
 * profile root) and rebased onto the profile root.
 *
 * Shared by the stylesheet rewriter and the label-HTML rewriter so `url(...)`
 * in a stylesheet and `<img src>` in label rich text resolve identically.
 */
export function vfsRefToUrl(ref: string, connectionId: string, vfs: ProfileVFS): string | null {
    const trimmed = ref.trim();
    if (!trimmed) return null;
    if (PASSTHROUGH_PREFIX.test(trimmed)) return null;
    // `:/…` is Mudlet's Qt resource bundle, not the profile VFS — resolving it
    // as a VFS path would produce a /__vfs/ URL for a file that was never there.
    if (isQtResourcePath(trimmed)) return qtResourceUrl(trimmed);
    const resolved = vfs.resolvePath(trimmed);
    const profilePrefix = `${vfs.profilePath}/`;
    const within = resolved.startsWith(profilePrefix)
        ? resolved.slice(profilePrefix.length)
        : resolved.replace(/^\//, '');
    return vfsUrlFor(connectionId, within);
}

/**
 * Rewrite `url(<local-path>)` references in a Qt/CSS stylesheet to
 * `url(/__vfs/<connectionId>/<path>)` so the registered service worker can
 * serve the bytes from the connection's ProfileVFS. Already-absolute http/data/
 * blob/__vfs URLs pass through untouched.
 *
 * Paths are resolved through the VFS (which honours its cwd and profile root)
 * and rebased onto the profile root before being put into the URL.
 */
export function rewriteVfsUrlsInCss(css: string, connectionId: string, vfs: ProfileVFS): string {
    return css.replace(URL_RE, (full, dq: string | undefined, sq: string | undefined, raw: string | undefined) => {
        const url = vfsRefToUrl(dq ?? sq ?? raw ?? '', connectionId, vfs);
        return url === null ? full : `url("${url}")`;
    });
}
