/**
 * Fetch a package file from a remote URL, falling back through the configured
 * proxy on CORS / network failures. Mirrors the proxy logic in HttpService and
 * packageRepository — duplicated rather than imported to keep this module
 * focused on the small concern of "download bytes for a package install".
 */

import type { PackageManifest } from '../storage/schema';
import { githubRawUrl } from '../utils/githubRawUrl';

export async function downloadFromUrl(url: string, proxyUrlRaw?: string): Promise<Uint8Array> {
    const res = await fetchWithProxyFallback(url, proxyUrlRaw);
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
    return new Uint8Array(await res.arrayBuffer());
}

// Hosts that have already failed a direct fetch this session. Chrome logs the
// rejection to the console before our catch sees it, so once we know a host
// blocks CORS we skip the direct attempt on subsequent requests to keep the
// devtools noise down. Cleared on full reload (module state).
const proxyOnlyHosts = new Set<string>();

async function fetchWithProxyFallback(requested: string, proxyUrlRaw?: string): Promise<Response> {
    // github.com's `/raw/` redirect fails the browser's CORS check, so follow it
    // to raw.githubusercontent.com ourselves — see githubRawUrl. Packages linked
    // from a game's Client.GUI payload use that form as readily as mpkg does.
    const target = githubRawUrl(requested);
    const proxy = normalizeProxyBase(proxyUrlRaw);
    let host = '';
    try { host = new URL(target).host; } catch { /* malformed URL — fall through to direct fetch */ }
    if (proxy && host && proxyOnlyHosts.has(host)) {
        return fetch(`${proxy}/?url=${encodeURIComponent(target)}`);
    }
    try {
        return await fetch(target);
    } catch (err) {
        if (!proxy) throw err;
        if (host) proxyOnlyHosts.add(host);
        return fetch(`${proxy}/?url=${encodeURIComponent(target)}`);
    }
}

function normalizeProxyBase(raw: string | undefined): string | undefined {
    const trimmed = raw?.trim().replace(/\/$/, '');
    if (!trimmed) return undefined;
    if (trimmed.startsWith('wss://')) return 'https://' + trimmed.slice(6);
    if (trimmed.startsWith('ws://'))  return 'http://'  + trimmed.slice(5);
    return trimmed;
}

/** Pull the trailing path segment out of a URL, falling back when the URL is malformed. */
export function filenameFromUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const segment = parsed.pathname.split('/').filter(Boolean).pop();
        if (segment) return decodeURIComponent(segment);
    } catch { /* fall through */ }
    const stripped = url.split(/[?#]/, 1)[0];
    const segment = stripped.split('/').pop();
    return segment || 'package.xml';
}

/**
 * The name desktop gives a `Client.GUI` package (cTelnet's
 * handleGUIPackageInstallationAndUpgrade): the URL's last segment with the
 * package extensions and every dot, slash and backslash taken out. It is what desktop
 * looks for among the installed packages to tell a first install from an
 * upgrade — so a package the player installed by hand counts as installed.
 */
export function clientGuiPackageName(url: string): string {
    return filenameFromUrl(url)
        .replace(/\.(zip|trigger|xml|mpackage)/gi, '')
        .replace(/[/\\.]/g, '');
}

export interface ClientGuiPayload {
    url: string;
    version: string;
}

/**
 * Decide whether a `Client.GUI` request is a re-delivery of a package already
 * installed from the same URL — i.e. whether the install can be skipped.
 *
 * The comparison is against `sourceVersion` (the server's own delivery
 * revision, see PackageManifest.sourceVersion), never against the package's
 * own `version`: those are the two fields that must stay apart.
 *
 * When the server declares no version — either the message carries none, or it
 * carries a non-string one that `parseClientGuiPayload` drops — nothing
 * signals that anything changed, so a URL match alone is the whole answer.
 * Falling back to the package's own `version` here would re-conflate the two
 * fields, and would still reinstall on every connect for a package whose
 * author shipped no version at all.
 *
 * A manifest from before `sourceVersion` existed has none recorded, so a
 * versioned request reinstalls it once — that pass is what replaces the
 * server's value in `version` with the author's.
 */
export function isClientGuiRedelivery(
    existing: PackageManifest | undefined,
    version: string | undefined,
): boolean {
    if (!existing) return false;
    if (!version) return true;
    return existing.sourceVersion === version;
}

/**
 * Decode a `Client.Map` GMCP payload (the MMP map-location announcement).
 * Mudlet (Host::setMmpMapLocation) only accepts a JSON object with a valid
 * `url`; anything else is silently ignored. Returns null on that same basis.
 */
export function parseClientMapPayload(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const url = (value as { url?: unknown }).url;
    if (typeof url !== 'string' || url.length === 0) return null;
    try { new URL(url); } catch { return null; }
    return url;
}

/**
 * Coerce the `version` field of a `Client.GUI` object payload to the string the
 * rest of the pipeline expects. Servers that treat the field as a delivery
 * counter often send it unquoted (`"version": 1`), and dropping those left the
 * install with no revision to compare against — see isClientGuiRedelivery.
 * `String()` is enough because the value is only ever compared for equality
 * with the next message's; JSON collapses `1.0` to `1` before we see it, but
 * that mapping is stable, so both sides of the comparison agree.
 */
function clientGuiVersion(raw: unknown): string | undefined {
    if (typeof raw === 'string') return raw.length > 0 ? raw : undefined;
    // Finite check keeps NaN/Infinity — which JSON can't produce, but a Lua
    // sysInstall payload can — from becoming the literal version "NaN".
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    return undefined;
}

/**
 * Decode a `Client.GUI` GMCP payload. Mudlet supports two shapes
 * (cTelnet::setGMCPVariables):
 *   - a `{ url, version }` JSON object (current MMP-style format)
 *   - a string `"<version>\n<url>"` (legacy raw telnet) — version first
 * Mudlet acts on an offer only when it carries both a version and a URL
 * (handleGUIPackageInstallationAndUpgrade returns on either being empty), in
 * either shape, so neither a bare URL nor a half pair is salvaged: the version
 * is what tells a re-delivery from an upgrade, and without it there is nothing
 * to record against the install.
 */
export function parseClientGuiPayload(value: unknown): ClientGuiPayload | null {
    if (value && typeof value === 'object') {
        const obj = value as { url?: unknown; version?: unknown };
        if (typeof obj.url !== 'string' || obj.url.length === 0) return null;
        const version = clientGuiVersion(obj.version);
        return version === undefined ? null : { url: obj.url, version };
    }
    if (typeof value === 'string') {
        const lines = value.split(/\r?\n/, 2).map(line => line.trim());
        if (lines.length < 2) return null;
        const [version, url] = lines;
        if (!version || !url) return null;
        return { url, version };
    }
    return null;
}

/**
 * Whether a `Client.GUI` payload declines the built-in starter UI —
 * `{"baseui": false}`, which Mudlet (cTelnet::parseGUIBaseUiDeclinedFromJSON)
 * also takes spelled as the string "false", trimmed and in any case, since some
 * games' GMCP serializers can only write strings. Only the JSON object form can
 * decline: the raw telnet form carries a version and a URL and nothing else.
 */
export function clientGuiDeclinesBaseUi(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const baseui = (value as { baseui?: unknown }).baseui;
    if (typeof baseui === 'boolean') return !baseui;
    return typeof baseui === 'string' && baseui.trim().toLowerCase() === 'false';
}
