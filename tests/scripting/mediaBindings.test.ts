// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';

// Issue #185: a media request's `url` is the directory the file lives in, and
// the file fetched is `url/name` (TMedia::getFileUrl) — not `url` itself.
class StubVFS {
    profilePath = '/profiles/test';
    files = new Set<string>();
    exists(p: string): boolean { return this.files.has(p); }
}

describe('media url fetch', () => {
    let t: TestRuntime;
    const stub = new StubVFS();

    beforeAll(async () => { t = await createTestRuntime({ vfs: stub as unknown as ProfileVFS }); });
    afterAll(() => t.dispose());
    afterEach(() => { vi.restoreAllMocks(); stub.files.clear(); });

    function spyDownload() {
        const http = (t.rt as unknown as { http: { downloadFile: (saveTo: string, url: string) => void } }).http;
        return vi.spyOn(http, 'downloadFile').mockImplementation(() => {});
    }

    it('joins the url directory with the file name', () => {
        const download = spyDownload();
        expect(t.run('return (loadSoundFile({name = "pre.wav", url = "http://h/"}))')).toBe(true);
        expect(download).toHaveBeenCalledWith('/profiles/test/media/pre.wav', 'http://h/pre.wav');
    });

    it('adds the separator a url without a trailing slash lacks', () => {
        const download = spyDownload();
        t.run('playSoundFile({name = "sfx/hit.wav", url = "http://h/sounds"})');
        expect(download).toHaveBeenCalledWith('/profiles/test/media/sfx/hit.wav', 'http://h/sounds/sfx/hit.wav');
    });

    it('fetches a url on its own as the file when no name is given', () => {
        const download = spyDownload();
        t.run('loadSoundFile({url = "http://h/only.wav"})');
        expect(download).toHaveBeenCalledWith('/profiles/test/media/only.wav', 'http://h/only.wav');
    });

    it('keeps only the filename of a name that climbs out of media/', () => {
        const download = spyDownload();
        t.run('loadSoundFile({name = "../evil.wav", url = "http://h/"})');
        expect(download).toHaveBeenCalledWith('/profiles/test/media/evil.wav', 'http://h/evil.wav');
    });

    it('does not fetch a file already in media/', () => {
        stub.files.add('/profiles/test/media/pre.wav');
        const download = spyDownload();
        t.run('loadSoundFile({name = "pre.wav", url = "http://h/"})');
        expect(download).not.toHaveBeenCalled();
    });
});

// Issue #185: stopSounds dropped its filter and stopped everything, and
// getPlayingSounds listed a server's MSP/GMCP sounds as well as the script's.
describe('stopSounds / getPlayingSounds filters from Lua', () => {
    let t: TestRuntime;

    beforeAll(async () => { t = await createTestRuntime(); });
    afterAll(() => t.dispose());
    afterEach(() => { vi.restoreAllMocks(); });

    it('hands the table filter down', () => {
        const stop = vi.spyOn(t.session.sounds, 'stopSounds').mockReturnValue(undefined);
        expect(t.run('return stopSounds({tag = "a", priority = 40})')).toBe(true);
        expect(stop).toHaveBeenCalledWith(expect.objectContaining({ tag: 'a', priority: 40, name: undefined }));
    });

    it('hands the ordered filter down', () => {
        const stop = vi.spyOn(t.session.sounds, 'stopSounds').mockReturnValue(undefined);
        t.run('stopSounds("long.wav")');
        expect(stop).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'long.wav' }));
        t.run('stopSounds(nil, "busted-key", nil, nil, true, 300)');
        expect(stop).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'busted-key', fadeout: 300 }));
    });

    it('stops everything with no filter', () => {
        const stop = vi.spyOn(t.session.sounds, 'stopSounds').mockReturnValue(undefined);
        t.run('stopSounds()');
        const f = stop.mock.calls[0][0] ?? {};
        expect([f.name, f.key, f.tag, f.priority]).toEqual([undefined, undefined, undefined, undefined]);
    });

    it('lists only script-started sounds', () => {
        const list = vi.spyOn(t.session.sounds, 'getPlaying').mockReturnValue([]);
        t.run('getPlayingSounds()');
        expect(list).toHaveBeenCalledWith(expect.objectContaining({ origin: 'api' }));
    });
});
