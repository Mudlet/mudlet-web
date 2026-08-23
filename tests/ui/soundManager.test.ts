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
