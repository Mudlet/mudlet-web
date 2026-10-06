// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';

// Issue #185: a media request's `url` is the directory the file lives in, and
// the file fetched is `url/name` (TMedia::getFileUrl) — not `url` itself.
class StubVFS {
    profilePath = '/profiles/test';
    files = new Set<string>();
    removed: string[] = [];
    exists(p: string): boolean { return this.files.has(p); }
    rmdir(p: string): void {
        this.removed.push(p);
        for (const f of [...this.files]) if (f === p || f.startsWith(`${p}/`)) this.files.delete(f);
    }
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

    // Issue #350: the ordered forms' url was dropped.
    it('fetches the url of the ordered load and play forms', () => {
        const download = spyDownload();
        expect(t.run('return (loadSoundFile("pre.wav", "http://h/"))')).toBe(true);
        expect(download).toHaveBeenLastCalledWith('/profiles/test/media/pre.wav', 'http://h/pre.wav');
        expect(t.run('return (loadMusicFile("msp1.wav", "http://h/"))')).toBe(true);
        expect(download).toHaveBeenLastCalledWith('/profiles/test/media/msp1.wav', 'http://h/msp1.wav');
        expect(t.run('return (playSoundFile("mid2.wav", 50, nil, nil, nil, nil, "pk", nil, nil, "http://h/"))')).toBe(true);
        expect(download).toHaveBeenLastCalledWith('/profiles/test/media/mid2.wav', 'http://h/mid2.wav');
        expect(t.run('return (playMusicFile("m.wav", 50, nil, nil, nil, nil, "mk", nil, nil, "http://h/"))')).toBe(true);
        expect(download).toHaveBeenLastCalledWith('/profiles/test/media/m.wav', 'http://h/m.wav');
    });

    it('plays the ordered form once its url has downloaded', () => {
        spyDownload();
        const play = vi.spyOn(t.session.sounds, 'playSound').mockResolvedValue(1);
        t.run('playSoundFile("mid3.wav", 50, nil, nil, nil, nil, "pk", nil, nil, "http://h/")');
        expect(play).not.toHaveBeenCalled();
        t.run('raiseEvent("sysDownloadDone", "/profiles/test/media/mid3.wav", 10)');
        expect(play).toHaveBeenCalledWith(expect.objectContaining({ name: 'mid3.wav', key: 'pk' }));
    });

    it('stops all media and deletes media/ on purgeMediaCache', () => {
        stub.files.add('/profiles/test/media');
        stub.files.add('/profiles/test/media/pre.wav');
        const purge = vi.spyOn(t.session.sounds, 'purgeCache');
        expect(t.run('return purgeMediaCache()')).toBe(true);
        expect(purge).toHaveBeenCalled();
        expect(stub.removed).toEqual(['/profiles/test/media']);
        expect(stub.files.size).toBe(0);
        stub.removed.length = 0;
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

// Issue #350: pause, paused lists, continue, finish, fadeaway and the video
// play's return value, as the Lua calls hand them down.
describe('media calls from Lua (#350)', () => {
    let t: TestRuntime;

    beforeAll(async () => { t = await createTestRuntime(); });
    afterAll(() => t.dispose());
    afterEach(() => { vi.restoreAllMocks(); });

    it('hands the whole pause filter down, not just the tag', () => {
        const pauseSounds = vi.spyOn(t.session.sounds, 'pauseSounds').mockReturnValue(undefined);
        const pauseMusic = vi.spyOn(t.session.sounds, 'pauseMusic').mockReturnValue(undefined);
        expect(t.run('return pauseSounds({key = "s1"})')).toBe(true);
        expect(pauseSounds).toHaveBeenCalledWith(expect.objectContaining({ key: 's1', origin: 'api' }));
        expect(t.run('return pauseMusic({key = "m1", name = "m1.wav"})')).toBe(true);
        expect(pauseMusic).toHaveBeenCalledWith(expect.objectContaining({ key: 'm1', name: 'm1.wav', origin: 'api' }));
        t.run('pauseSounds()');
        expect(pauseSounds).toHaveBeenLastCalledWith(expect.objectContaining({ key: undefined, tag: undefined }));
    });

    it('lists paused media', () => {
        vi.spyOn(t.session.sounds, 'getPaused').mockImplementation((_f, kind) =>
            kind === 'music' ? [{ name: 'm1.wav', key: 'm1', volume: 50 }] : [{ name: 's1.wav', key: 's1', volume: 40 }]);
        expect(t.run('local p = getPausedSounds() return #p .. p[1].name .. p[1].key .. p[1].volume')).toBe('1s1.wavs140');
        expect(t.run('local p = getPausedMusic() return #p .. p[1].name')).toBe('1m1.wav');
    });

    it('continues music by default, and restarts only when told to', () => {
        const play = vi.spyOn(t.session.sounds, 'playMusic').mockResolvedValue(1);
        t.run('playMusicFile({name = "long3.wav", key = "m"})');
        expect(play).toHaveBeenLastCalledWith(expect.objectContaining({ continue: true }));
        t.run('playMusicFile("long3.wav")');
        expect(play).toHaveBeenLastCalledWith(expect.objectContaining({ continue: true }));
        t.run('playMusicFile({name = "long3.wav", key = "m", ["continue"] = false})');
        expect(play).toHaveBeenLastCalledWith(expect.objectContaining({ continue: false }));
    });

    it('passes finish on, in both forms', () => {
        const sound = vi.spyOn(t.session.sounds, 'playSound').mockResolvedValue(1);
        const music = vi.spyOn(t.session.sounds, 'playMusic').mockResolvedValue(1);
        t.run('playSoundFile({name = "mid.wav", finish = 1000})');
        expect(sound).toHaveBeenLastCalledWith(expect.objectContaining({ finish: 1000 }));
        t.run('playMusicFile("mid.wav", nil, nil, nil, nil, nil, nil, nil, nil, nil, 1500)');
        expect(music).toHaveBeenLastCalledWith(expect.objectContaining({ finish: 1500 }));
    });

    it('passes fadeaway on to a stop', () => {
        const sounds = vi.spyOn(t.session.sounds, 'stopSounds').mockReturnValue(undefined);
        const music = vi.spyOn(t.session.sounds, 'stopMusic').mockReturnValue(undefined);
        t.run('stopSounds({fadeaway = true})');
        expect(sounds).toHaveBeenLastCalledWith(expect.objectContaining({ fadeaway: true }));
        t.run('stopSounds()');
        expect(sounds).toHaveBeenLastCalledWith(expect.objectContaining({ fadeaway: false }));
        t.run('stopMusic({fadeaway = true, fadeout = 300})');
        expect(music).toHaveBeenLastCalledWith(expect.objectContaining({ fadeaway: true, fadeout: 300 }));
        t.run('stopMusic(nil, nil, nil, true)');
        expect(music).toHaveBeenLastCalledWith(expect.objectContaining({ fadeaway: true }));
    });

    it('answers true from playVideoFile', () => {
        vi.spyOn(t.session.videos, 'play').mockResolvedValue(true);
        expect(t.run('return playVideoFile({name = "nosuch.mp4"})')).toBe(true);
    });
});
