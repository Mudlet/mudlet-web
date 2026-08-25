// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpService } from '../../src/scripting/http/HttpService';
import { githubRawUrl } from '../../src/utils/githubRawUrl';

/**
 * Mudlet packages address the package repository through github.com's `/raw/`
 * links — mpkg builds every download off one. Qt follows the 302 they answer
 * with; a browser cannot, because that response carries an *empty*
 * `Access-Control-Allow-Origin`, which fails the CORS check before the redirect
 * is ever followed. Left alone, mpkg's catalog download and every install off it
 * fail on a profile with no proxy configured, and pay a doomed round trip on one
 * that has.
 *
 * So we follow it ourselves. What the events report is still the url the script
 * asked for: mpkg matches a failed download by checking the reported url ends
 * with its catalog filename, and Other.lua's installPackage-from-url wrapper
 * matches on the save path it chose from that url.
 */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const MPKG_REPO = 'https://github.com/Mudlet/mudlet-package-repository/raw/refs/heads/main/packages';

function service(emit: (event: string, args: unknown[]) => void, vfs: unknown = null) {
    return new HttpService(emit, () => vfs as never, () => undefined, fn => fn());
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('githubRawUrl', () => {
    it('redirects a github.com /raw/ link to the raw host itself', () => {
        expect(githubRawUrl(`${MPKG_REPO}/mpkg.packages.json`)).toBe(
            'https://raw.githubusercontent.com/Mudlet/mudlet-package-repository/refs/heads/main/packages/mpkg.packages.json');
    });

    it('carries the query and fragment across', () => {
        expect(githubRawUrl('https://github.com/o/r/raw/main/x.mpackage?v=2#frag'))
            .toBe('https://raw.githubusercontent.com/o/r/main/x.mpackage?v=2#frag');
    });

    it('leaves everything else alone', () => {
        // A /blob/ link serves an HTML page, not the file — rewriting it would
        // hand back bytes nobody asked for.
        for (const url of [
            'https://github.com/Mudlet/Mudlet/blob/development/README.md',
            'https://github.com/Mudlet/Mudlet',
            'https://raw.githubusercontent.com/o/r/main/x',
            'https://example.invalid/raw/x',
            'file:///profiles/test/x.mpackage',
        ]) expect(githubRawUrl(url), url).toBe(url);
    });
});

describe('downloadFile from a github.com /raw/ url', () => {
    it('fetches the raw host and still reports the url the script asked for', async () => {
        const fetched: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            fetched.push(String(url));
            return new Response('{"packages":[]}', { status: 200 });
        }));
        const written: string[] = [];
        const vfs = { writeBinaryFile: (p: string) => { written.push(p); } };
        const events: Array<[string, unknown[]]> = [];
        const requested = `${MPKG_REPO}/mpkg.packages.json`;

        service((e, a) => events.push([e, a]), vfs)
            .downloadFile('/profiles/test/mpkg.packages.json', requested);
        await flush();

        expect(fetched).toEqual([
            'https://raw.githubusercontent.com/Mudlet/mudlet-package-repository/refs/heads/main/packages/mpkg.packages.json']);
        expect(written).toEqual(['/profiles/test/mpkg.packages.json']);
        const done = events.find(([e]) => e === 'sysDownloadDone');
        expect(done?.[1][0]).toBe('/profiles/test/mpkg.packages.json');
        // The progress event names the url, and mpkg-style handlers match on it.
        const progress = events.find(([e]) => e === 'sysDownloadFileProgress');
        expect(progress?.[1][0]).toBe(requested);
    });

    it('reports a failure against the requested url, not the rewritten one', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404, statusText: 'Not Found' })));
        const events: Array<[string, unknown[]]> = [];
        const requested = `${MPKG_REPO}/mpkg.packages.json`;

        service((e, a) => events.push([e, a]), { writeBinaryFile: () => {} })
            .downloadFile('/profiles/test/mpkg.packages.json', requested);
        await flush();

        const error = events.find(([e]) => e === 'sysDownloadError');
        expect(error?.[1][2]).toBe(requested);
    });
});
