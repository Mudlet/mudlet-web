import { describe, it, expect, beforeAll } from 'vitest';
import { SoundManager } from '../../src/ui/sound/SoundManager';

// Minimal fake Web Audio graph. SoundManager only touches a small slice of the
// API, so we stub exactly that surface and record every GainNode created so the
// test can read back the effective gain a source was given.
const createdGains: FakeGain[] = [];
/** Every FakeSource handed out, so a test can end one on demand — Web Audio
 *  reports the end of a source through onended, and nothing else does. */
const createdSources: FakeSource[] = [];

class FakeGainParam {
    value = 0;
    setValueAtTime(v: number) { this.value = v; }
    linearRampToValueAtTime(v: number) { this.value = v; }
    cancelScheduledValues() { /* no-op */ }
}
class FakeGain {
    gain = new FakeGainParam();
    connect<T>(node: T): T { return node; }
}
class FakeSource {
    buffer: unknown = null;
    loop = false;
    onended: (() => void) | null = null;
    connect<T>(node: T): T { return node; }
    start() { /* no-op */ }
    stop() { /* no-op */ }
}
class FakeAudioContext {
    state = 'running';
    currentTime = 0;
    sampleRate = 44100;
    destination = {};
    createBufferSource() { const s = new FakeSource(); createdSources.push(s); return s; }
    createGain() { const g = new FakeGain(); createdGains.push(g); return g; }
    createBuffer(_ch: number, len: number, sr: number) {
        return { duration: len / sr, getChannelData: () => new Float32Array(len) };
    }
    decodeAudioData(_buf: ArrayBuffer) {
        return Promise.resolve({ duration: 1, numberOfChannels: 1 } as unknown as AudioBuffer);
    }
    resume() { return Promise.resolve(); }
}

/** Play a sound and return the GainNode SoundManager attached to it (the first
 *  gain created during this call — the keepalive gain, if any, comes after). */
async function playAndGetGain(mgr: SoundManager, opts: Parameters<SoundManager['playSound']>[0]) {
    createdGains.length = 0;
    await mgr.playSound(opts);
    return createdGains[0];
}

describe('SoundManager per-origin mute gates', () => {
    beforeAll(() => {
        (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    });

    function makeManager() {
        const mgr = new SoundManager();
        // Loader just has to return some bytes; the fake decoder ignores them.
        mgr.setLoader(async () => new ArrayBuffer(8));
        return mgr;
    }

    it('plays at full gain by default and reports both origins audible', async () => {
        const mgr = makeManager();
        expect(mgr.isOriginMuted('api')).toBe(false);
        expect(mgr.isOriginMuted('game')).toBe(false);
        const g = await playAndGetGain(mgr, { name: 'a.wav', volume: 50, origin: 'api' });
        expect(g.gain.value).toBeCloseTo(0.5); // 50/100 * master(1)
    });

    it('silences a live source when its origin is muted, and restores it on unmute', async () => {
        const mgr = makeManager();
        const g = await playAndGetGain(mgr, { name: 'b.wav', volume: 80, origin: 'api' });
        expect(g.gain.value).toBeCloseTo(0.8);

        mgr.setOriginMuted('api', true);
        expect(mgr.isOriginMuted('api')).toBe(true);
        expect(g.gain.value).toBe(0); // silenced in place — not stopped

        mgr.setOriginMuted('api', false);
        expect(g.gain.value).toBeCloseTo(0.8); // audible again, mid-track
    });

    it('starts a new source silent while its origin is already muted', async () => {
        const mgr = makeManager();
        mgr.setOriginMuted('api', true);
        const g = await playAndGetGain(mgr, { name: 'c.wav', volume: 70, origin: 'api' });
        expect(g.gain.value).toBe(0);
        mgr.setOriginMuted('api', false);
        expect(g.gain.value).toBeCloseTo(0.7);
    });

    it('gates the two origins independently', async () => {
        const mgr = makeManager();
        const apiGain = await playAndGetGain(mgr, { name: 'api.wav', volume: 60, origin: 'api' });
        const gameGain = await playAndGetGain(mgr, { name: 'game.wav', volume: 60, origin: 'game' });

        // Muting the game origin leaves the API source audible.
        mgr.setOriginMuted('game', true);
        expect(gameGain.gain.value).toBe(0);
        expect(apiGain.gain.value).toBeCloseTo(0.6);

        // ...and vice versa.
        mgr.setOriginMuted('api', true);
        expect(apiGain.gain.value).toBe(0);
    });

    it('defaults the origin to api when unspecified', async () => {
        const mgr = makeManager();
        mgr.setOriginMuted('api', true);
        const g = await playAndGetGain(mgr, { name: 'd.wav', volume: 50 });
        expect(g.gain.value).toBe(0);
    });
});

// Mudlet's media events (TMedia.cpp) all carry the same five arguments: the
// source URL's filename, its path, the media type, and the key and tag the
// playback was given. Media_spec asserts exactly that shape — and cannot run
// here, because its own gate waits on sysMediaStarted through the browser event
// loop that a synchronous busted run sits on top of (see e2e/knownDivergences.ts
// for the same constraint on the TTS specs). So the payload is pinned here
// instead, against the real SoundManager.
describe('SoundManager media event payloads', () => {
    beforeAll(() => {
        (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    });

    function makeManager() {
        const mgr = new SoundManager();
        mgr.setLoader(async () => new ArrayBuffer(8));
        return mgr;
    }

    type Payload = [string, string, string, string, string];

    it('reports the file, path, type, key and tag when a sound starts', async () => {
        const mgr = makeManager();
        const started: Payload[] = [];
        mgr.onMediaStarted = (...args) => started.push(args as Payload);

        await mgr.playSound({ name: 'media/hit.wav', volume: 50, key: 'busted-key', tag: 'busted-tag' });

        expect(started).toEqual([['hit.wav', 'media/hit.wav', 'sound', 'busted-key', 'busted-tag']]);
    });

    it('names music as its own media type', async () => {
        const mgr = makeManager();
        const started: Payload[] = [];
        mgr.onMediaStarted = (...args) => started.push(args as Payload);

        await mgr.playMusic({ name: 'theme.mp3', volume: 50 });

        expect(started[0][2]).toBe('music');
    });

    it('sends empty strings, not undefined, for an absent key and tag', async () => {
        const mgr = makeManager();
        const started: Payload[] = [];
        mgr.onMediaStarted = (...args) => started.push(args as Payload);

        await mgr.playSound({ name: 'bare.wav', volume: 50 });

        // A nil in Lua would shift every argument after it, so a script reading
        // the tag positionally would read nothing at all.
        expect(started[0][3]).toBe('');
        expect(started[0][4]).toBe('');
    });

    it('gives the finished event the same five arguments as the started one', async () => {
        const mgr = makeManager();
        const started: Payload[] = [];
        const finished: Payload[] = [];
        mgr.onMediaStarted = (...args) => started.push(args as Payload);
        mgr.onMediaFinished = (...args) => finished.push(args as Payload);

        createdSources.length = 0;
        await mgr.playSound({ name: 'media/loop.wav', volume: 50, key: 'k', tag: 't' });
        createdSources[0].onended?.();

        expect(finished).toEqual(started);
    });

    it('does not announce a start for a sound whose decode fails', async () => {
        const mgr = makeManager();
        mgr.setLoader(async () => { throw new Error('no such file'); });
        const started: Payload[] = [];
        mgr.onMediaStarted = (...args) => started.push(args as Payload);

        expect(await mgr.playSound({ name: 'missing.wav', volume: 50 })).toBe(-1);
        expect(started).toEqual([]);
    });
});

// Closing a profile tears the session down synchronously, but a play that is
// still fetching + decoding its file has not created a source yet — so the stop
// pass finds nothing, and the sound starts a moment later with no manager left
// to reach it. The symptom is music that keeps playing after the profile is
// gone. Both stopAll() and destroy() have to reach in-flight plays too.
describe('SoundManager teardown during an in-flight play', () => {
    beforeAll(() => {
        (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    });

    /** A manager whose loader hangs until the returned `release` is called, so a
     *  test can tear down while a play is parked mid-decode. */
    function makePendingManager() {
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const mgr = new SoundManager();
        mgr.setLoader(async () => { await gate; return new ArrayBuffer(8); });
        return { mgr, release };
    }

    it('abandons a play whose decode finishes after destroy()', async () => {
        const { mgr, release } = makePendingManager();
        const started: string[] = [];
        mgr.onMediaStarted = (file) => started.push(file);

        const pending = mgr.playMusic({ name: 'late/theme.mp3', volume: 50 });
        mgr.destroy();          // profile closed while the file was still loading
        release();

        expect(await pending).toBe(-1);
        expect(started).toEqual([]);
        expect(mgr.getPlaying({}, 'music')).toEqual([]);
    });

    it('abandons a play whose decode finishes after stopAll()', async () => {
        const { mgr, release } = makePendingManager();
        const started: string[] = [];
        mgr.onMediaStarted = (file) => started.push(file);

        const pending = mgr.playSound({ name: 'late/hit.wav', volume: 50 });
        mgr.stopAll();          // e.g. resetProfile
        release();

        expect(await pending).toBe(-1);
        expect(started).toEqual([]);
        expect(mgr.getPlaying()).toEqual([]);
    });

    it('refuses a play started after destroy()', async () => {
        const mgr = new SoundManager();
        mgr.setLoader(async () => new ArrayBuffer(8));
        mgr.destroy();
        expect(await mgr.playSound({ name: 'after-close.wav', volume: 50 })).toBe(-1);
    });

    it('still plays normally after a stopAll that caught nothing', async () => {
        const mgr = new SoundManager();
        mgr.setLoader(async () => new ArrayBuffer(8));
        mgr.stopAll();
        expect(await mgr.playSound({ name: 'after-reset.wav', volume: 50 })).toBeGreaterThan(0);
    });
});

// Issue #185: media drift against desktop Mudlet. Each block pins one of the
// behaviours the side-by-side comparison found missing.
describe('SoundManager finite loop counts', () => {
    beforeAll(() => {
        (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    });

    function makeManager() {
        const mgr = new SoundManager();
        mgr.setLoader(async () => new ArrayBuffer(8));
        return mgr;
    }

    it('plays each pass on its own source and ends after the last one', async () => {
        const mgr = makeManager();
        const events: string[] = [];
        mgr.onMediaStarted = () => events.push('started');
        mgr.onMediaFinished = () => events.push('finished');

        createdSources.length = 0;
        await mgr.playSound({ name: 'short.wav', loops: 2 });
        // Never the loop flag: that only repeats forever, which is the bug.
        expect(createdSources).toHaveLength(1);
        expect(createdSources[0].loop).toBe(false);

        createdSources[0].onended?.();
        expect(createdSources).toHaveLength(2);
        expect(mgr.getPlaying()).toHaveLength(1);

        createdSources[1].onended?.();
        expect(createdSources).toHaveLength(2);
        expect(mgr.getPlaying()).toEqual([]);
        expect(events).toEqual(['started', 'finished', 'started', 'finished']);
    });

    it('keeps the loop flag for -1 and plays a single pass for 0 or below -1', async () => {
        const mgr = makeManager();
        createdSources.length = 0;
        await mgr.playSound({ name: 'forever.wav', loops: -1 });
        expect(createdSources[0].loop).toBe(true);

        for (const loops of [0, -5]) {
            createdSources.length = 0;
            await mgr.playSound({ name: `once${loops}.wav`, loops });
            expect(createdSources[0].loop).toBe(false);
            createdSources[0].onended?.();
            expect(createdSources).toHaveLength(1);
        }
    });

    it('does not start another pass once the sound is stopped', async () => {
        const mgr = makeManager();
        createdSources.length = 0;
        await mgr.playSound({ name: 'stopped.wav', loops: 3 });
        mgr.stopSounds();
        createdSources[0].onended?.();
        expect(createdSources).toHaveLength(1);
        expect(mgr.getPlaying()).toEqual([]);
    });
});

describe('SoundManager stop and pause filters', () => {
    beforeAll(() => {
        (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    });

    async function twoSounds(extraA: object = {}, extraB: object = {}) {
        const mgr = new SoundManager();
        mgr.setLoader(async () => new ArrayBuffer(8));
        await mgr.playSound({ name: 'media/long.wav', tag: 'a', key: 'ka', ...extraA });
        await mgr.playSound({ name: 'media/long2.wav', tag: 'b', key: 'kb', ...extraB });
        return mgr;
    }
    const names = (mgr: SoundManager) => mgr.getPlaying().map(p => p.name).sort();

    it('stops only the sound a tag names', async () => {
        const mgr = await twoSounds();
        mgr.stopSounds({ tag: 'a' });
        expect(names(mgr)).toEqual(['media/long2.wav']);
    });

    it('matches a name by its path or its trailing filename', async () => {
        const mgr = await twoSounds();
        mgr.stopSounds({ name: 'long.wav' });
        expect(names(mgr)).toEqual(['media/long2.wav']);
        mgr.stopSounds({ name: '/profiles/x/media/long2.wav' });
        expect(names(mgr)).toEqual([]);
    });

    it('stops by key, and everything with no filter', async () => {
        const mgr = await twoSounds();
        mgr.stopSounds({ key: 'kb' });
        expect(names(mgr)).toEqual(['media/long.wav']);
        mgr.stopSounds();
        expect(names(mgr)).toEqual([]);
    });

    it('treats a priority filter as a ceiling', async () => {
        const mgr = await twoSounds({ priority: 90 });
        // long2 has no priority, which counts as 0, so it sits under any ceiling.
        mgr.stopSounds({ priority: 10 });
        expect(names(mgr)).toEqual(['media/long.wav']);
        mgr.stopSounds({ priority: 95 });
        expect(names(mgr)).toEqual([]);
    });

    it('narrows to one origin', async () => {
        const mgr = await twoSounds({ origin: 'game' }, { origin: 'api' });
        mgr.stopSounds({ origin: 'game' });
        expect(names(mgr)).toEqual(['media/long2.wav']);
    });

    it('pauses only what a filter names', async () => {
        const mgr = await twoSounds();
        mgr.pauseSounds({ key: 'ka' });
        expect(names(mgr)).toEqual(['media/long2.wav']);
    });

    it('lists only the origin asked for', async () => {
        const mgr = await twoSounds({ origin: 'game' }, { origin: 'api' });
        expect(mgr.getPlaying({ origin: 'api' }).map(p => p.name)).toEqual(['media/long2.wav']);
        expect(mgr.getPlaying()).toHaveLength(2);
    });
});

describe('SoundManager priority', () => {
    beforeAll(() => {
        (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    });

    function makeManager() {
        const mgr = new SoundManager();
        mgr.setLoader(async () => new ArrayBuffer(8));
        return mgr;
    }

    it('refuses a sound while one of equal or higher priority plays', async () => {
        const mgr = makeManager();
        await mgr.playSound({ name: 'long.wav', priority: 60 });
        expect(await mgr.playSound({ name: 'long2.wav', priority: 50 })).toBe(-1);
        expect(await mgr.playSound({ name: 'long3.wav', priority: 60 })).toBe(-1);
        expect(mgr.getPlaying().map(p => p.name)).toEqual(['long.wav']);
    });

    it('takes over from lower-priority sounds, including those with none', async () => {
        const mgr = makeManager();
        await mgr.playSound({ name: 'none.wav' });
        await mgr.playSound({ name: 'low.wav', priority: 10 });
        expect(await mgr.playSound({ name: 'high.wav', priority: 90 })).toBeGreaterThan(0);
        expect(mgr.getPlaying().map(p => p.name)).toEqual(['high.wav']);
    });

    it('leaves a sound without a priority unaffected by one that has it', async () => {
        const mgr = makeManager();
        await mgr.playSound({ name: 'high.wav', priority: 90 });
        expect(await mgr.playSound({ name: 'plain.wav' })).toBeGreaterThan(0);
        expect(mgr.getPlaying()).toHaveLength(2);
    });

    it('clamps a priority into 1..100 and reports it', async () => {
        const mgr = makeManager();
        await mgr.playSound({ name: 'top.wav', priority: 500 });
        expect(mgr.getPlaying()[0].priority).toBe(100);
    });

    it('compares priority only within one origin', async () => {
        const mgr = makeManager();
        await mgr.playSound({ name: 'game.wav', priority: 90, origin: 'game' });
        expect(await mgr.playSound({ name: 'api.wav', priority: 10, origin: 'api' })).toBeGreaterThan(0);
        expect(mgr.getPlaying()).toHaveLength(2);
    });
});
