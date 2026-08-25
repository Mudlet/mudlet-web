/**
 * Rewrite a `github.com/<owner>/<repo>/raw/...` link to the
 * `raw.githubusercontent.com` URL it redirects to.
 *
 * github.com answers those links with a 302 whose `Access-Control-Allow-Origin`
 * header is present but *empty*, which fails the browser's CORS check outright:
 * the fetch dies on the redirect and never reaches the file. The host that
 * redirect points at — raw.githubusercontent.com — serves the same bytes and
 * sends `Access-Control-Allow-Origin: *`, so following it ourselves is the whole
 * fix. Qt's network stack never cared about any of this, so Mudlet packages ship
 * the github.com form: mpkg builds every repository download off
 * `https://github.com/Mudlet/mudlet-package-repository/raw/refs/heads/main/packages`,
 * and packageRepository.ts already hard-codes the raw host for the same reason.
 *
 * Only `/raw/` is rewritten. A `/blob/` link serves an HTML page, not the file,
 * so silently turning one into bytes would be a different (and wrong) answer.
 *
 * Anything else is returned unchanged.
 */
const GITHUB_RAW = /^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/]+)\/raw\/(.+)$/i;

export function githubRawUrl(url: string): string {
    const match = GITHUB_RAW.exec(url.trim());
    // The tail carries any query and fragment along with the path, which is what
    // GitHub's own Location header does.
    return match ? `https://raw.githubusercontent.com/${match[1]}/${match[2]}` : url;
}
