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

export interface ClientGuiPayload {
    url: string;
    version?: string;
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
 *   - a string `"<version>\n<url>"` (legacy raw telnet) — version first, which
 *     is the opposite of what this parser assumed before
 * Returns null when neither shape applies or the URL is empty. Mudlet also
 * requires both fields in the legacy shape and drops the message otherwise, so
 * a lone line is only accepted as a bare URL from the JSON-ish path, never as a
 * half-decoded legacy pair.
 */
export function parseClientGuiPayload(value: unknown): ClientGuiPayload | null {
    if (value && typeof value === 'object') {
        const obj = value as { url?: unknown; version?: unknown };
        if (typeof obj.url === 'string' && obj.url.length > 0) {
            const out: ClientGuiPayload = { url: obj.url };
            const version = clientGuiVersion(obj.version);
            if (version !== undefined) out.version = version;
            return out;
        }
        return null;
    }
    if (typeof value === 'string') {
        const lines = value.split(/\r?\n/, 2).map(line => line.trim());
        if (lines.length > 1) {
            // Legacy raw-telnet pair: version first, url second. Mudlet drops
            // the message unless both are present, so a half pair is not
            // salvaged into a bare URL — the missing half could be either one.
            const [version, url] = lines;
            if (!version || !url) return null;
            return { url, version };
        }
        // Single line. Mudlet has no branch for this — its fallback needs two
        // lines — but a server quoting just the URL as a JSON string is
        // unambiguous, so it's accepted rather than dropped.
        return lines[0] ? { url: lines[0] } : null;
    }
    return null;
}
