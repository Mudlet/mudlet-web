import type { ProfileVFS } from './ProfileVFS';
import { appShellCacheEnabled } from '../../utils/appShellCache';

// URL prefix the service worker intercepts. The leading directory matches the
// deploy base path (root '/' for top-level hosting, '/<repo>/' for GitHub Pages
// and similar subpath deploys), so generated URLs stay inside the SW scope.
function basePath(): string {
    if (typeof document === 'undefined') return '/';
    return new URL('./', document.baseURI).pathname;
}

export function vfsUrlPrefix(): string {
    return `${basePath()}__vfs`;
}

const MIME_BY_EXT: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
    mp4: 'video/mp4', webm: 'video/webm',
    json: 'application/json', txt: 'text/plain', html: 'text/html',
    css: 'text/css', js: 'application/javascript',
};

function mimeFor(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

const registry = new Map<string, ProfileVFS>();
let listenerInstalled = false;

/** Register a mounted profile so the service worker can read its files. */
export function registerVfs(connectionId: string, vfs: ProfileVFS): void {
    registry.set(connectionId, vfs);
    ensureListener();
}

/** Drop the mapping and clear cached responses for this connection. */
export function unregisterVfs(connectionId: string): void {
    registry.delete(connectionId);
    postToSw({ type: 'vfs:invalidate', connectionId });
}

/** Tell the SW to drop one cached file (call after writes). */
export function invalidateVfsPath(connectionId: string, path: string): void {
    postToSw({ type: 'vfs:invalidate', connectionId, path });
}

/** Build a URL the SW will resolve to bytes from `vfs.readBinaryFile(path)`. */
export function vfsUrlFor(connectionId: string, path: string): string {
    const norm = path.startsWith('/') ? path : `/${path}`;
    const segs = norm.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return `${vfsUrlPrefix()}/${encodeURIComponent(connectionId)}/${segs}`;
}

/**
 * Register the service worker and wait until it controls this page. Safe to
 * call multiple times; resolves to false if the browser doesn't support SWs
 * or registration failed.
 */
export async function registerVfsServiceWorker(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
    try {
        // The `app-shell` flag is how the worker learns whether this build wants
        // its shell cached; see `appShellCacheEnabled`. It rides in the script
        // URL because the worker has to know before it answers its first fetch,
        // which is well before any message from the page could reach it.
        await navigator.serviceWorker.register(
            appShellCacheEnabled ? 'vfs-sw.js?app-shell=1' : 'vfs-sw.js',
            { scope: './' },
        );
        await navigator.serviceWorker.ready;
        ensureListener();
        return true;
    } catch (err) {
        console.warn('[vfs-sw] registration failed:', err);
        return false;
    }
}

function ensureListener(): void {
    if (listenerInstalled) return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', handleMessage);
    listenerInstalled = true;
}

function handleMessage(event: MessageEvent): void {
    const data = event.data as { type?: string; connectionId?: string; path?: string } | null;
    if (!data || data.type !== 'vfs:read') return;
    const port = event.ports[0];
    if (!port) return;
    const vfs = registry.get(data.connectionId ?? '');
    if (!vfs) {
        port.postMessage({ ok: false, error: 'unknown-connection' });
        return;
    }
    try {
        // The URL's path component is rooted in the profile (e.g.
        // "/scripts/ui/x.png" → file at "<profilePath>/scripts/ui/x.png").
        // ProfileVFS.readBinaryFile treats leading-slash paths as absolute in
        // the global ZenFS namespace, so we have to splice in the profile
        // prefix ourselves.
        const reqPath = data.path ?? '/';
        const rel = reqPath.startsWith('/') ? reqPath : `/${reqPath}`;
        const bytes = vfs.readBinaryFile(`${vfs.profilePath}${rel}`);
        const contentType = mimeFor(reqPath);
        // Transfer the underlying buffer to skip a copy across the worker boundary.
        const buffer = bytes.buffer instanceof ArrayBuffer ? bytes.buffer : null;
        if (buffer) {
            port.postMessage({ ok: true, bytes, contentType }, [buffer]);
        } else {
            port.postMessage({ ok: true, bytes, contentType });
        }
    } catch (err) {
        port.postMessage({ ok: false, error: (err as Error).message });
    }
}

function postToSw(message: unknown): void {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.controller?.postMessage(message);
}
