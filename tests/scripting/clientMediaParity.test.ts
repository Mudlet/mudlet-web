// @vitest-environment node
//
// Node env, not happy-dom: wasmoon resolves its WASM off `import.meta.url`,
// which is an unusable `http://localhost:3000/...` under happy-dom. The Lua
// runtime is mocked away below anyway — the engine boots one eagerly in its
// constructor and none of it is needed to exercise a GMCP dispatch gate.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
            setGmcpValue: () => {},
        }),
    },
}));

const { MudSession } = await import('../../src/mud/MudSession');
const { AliasEngine } = await import('../../src/mud/aliases/AliasEngine');
const { TriggerEngine } = await import('../../src/mud/triggers/TriggerEngine');
const { TimerEngine } = await import('../../src/mud/timers/TimerEngine');
const { KeyEngine } = await import('../../src/mud/keybindings/KeyEngine');
const { ScriptingEngine } = await import('../../src/scripting/ScriptingEngine');
const { useAppStore } = await import('../../src/storage/appStore');

// Enough DOM for the engine's constructor (beforeunload + visibilitychange).
// Installed AFTER the imports above, never at import time: pcre2 picks its
// node-vs-browser WASM loading during its own module init, and a `document`
// visible then flips it to fetch mode and it dies. Same rule as
// createTestRuntime's window stub.
const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

// Issue #185 — GMCP Client.Media (MCMP) drift against desktop Mudlet: Stop
// ignored its filters, Pause fell through to Play, tags kept their case,
// priority was never read, an unknown type played as a sound, and a bare
// `Client.Media` wasn't Default. Also covers how the sound/video loader turns
// a media name into VFS paths. The harness is the one server-media-gate uses.

const CONN = 'client-media-parity-conn';

type EngineInternals = {
    handleClientMedia: (action: string, value: unknown) => Promise<void>;
    resolveMediaFile: (file: string, baseUrl: string | undefined, logPrefix: string, debug: boolean) => Promise<string | null>;
    mediaPathCandidates: (path: string) => string[];
    gmcpMediaDefaultUrl: string;
    vfs: unknown;
};

describe('GMCP Client.Media parity', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Parity', url: 'ws://localhost' }],
            }));
        }
        session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    const internals = () => engine as unknown as EngineInternals;
    const media = (action: string, value: unknown) => internals().handleClientMedia(action, value);

    it('stops only the server sounds a Stop names, with the tag lowercased', async () => {
        const stopSounds = vi.spyOn(session.sounds, 'stopSounds').mockReturnValue(undefined);
        const stopMusic = vi.spyOn(session.sounds, 'stopMusic').mockReturnValue(undefined);
        await media('stop', { type: 'sound', tag: 'A', key: 'k', name: 'long.wav', priority: 40 });
        expect(stopMusic).not.toHaveBeenCalled();
        expect(stopSounds).toHaveBeenCalledWith({
            name: 'long.wav', key: 'k', tag: 'a', priority: 40, fadeout: undefined, origin: 'game',
        });
    });

    it('pauses on Pause and never plays', async () => {
        const resolve = vi.spyOn(internals(), 'resolveMediaFile');
        const play = vi.spyOn(session.sounds, 'playSound');
        const pause = vi.spyOn(session.sounds, 'pauseSounds').mockReturnValue(undefined);
        await media('pause', { name: 'long3.wav', type: 'sound' });
        expect(resolve).not.toHaveBeenCalled();
        expect(play).not.toHaveBeenCalled();
        expect(pause).toHaveBeenCalledWith(expect.objectContaining({ name: 'long3.wav', origin: 'game' }));
    });

    it('passes priority and a lowercased tag to a Play', async () => {
        vi.spyOn(internals(), 'resolveMediaFile').mockResolvedValue('media/long.wav');
        const play = vi.spyOn(session.sounds, 'playSound').mockResolvedValue(1);
        await media('play', { name: 'long.wav', tag: 'A', priority: '60' });
        expect(play).toHaveBeenCalledWith(expect.objectContaining({
            name: 'media/long.wav', tag: 'a', priority: 60, origin: 'game',
        }));
    });

    it('refuses a Play of a type Mudlet does not know', async () => {
        vi.spyOn(internals(), 'resolveMediaFile').mockResolvedValue('media/long.wav');
        const sound = vi.spyOn(session.sounds, 'playSound').mockResolvedValue(1);
        const music = vi.spyOn(session.sounds, 'playMusic').mockResolvedValue(1);
        await media('play', { name: 'long.wav', type: 'foo' });
        await media('play', { name: 'long.wav', type: 42 });
        expect(sound).not.toHaveBeenCalled();
        expect(music).not.toHaveBeenCalled();

        await media('play', { name: 'long.wav', type: 'MUSIC' });
        expect(music).toHaveBeenCalledTimes(1);
        await media('play', { name: 'long.wav', type: null });
        await media('play', { name: 'long.wav', type: '' });
        expect(sound).toHaveBeenCalledTimes(2);
    });

    it('treats a bare Client.Media as Default', () => {
        const play = vi.spyOn(session.sounds, 'playSound');
        session.events.emit('gmcp', { path: 'Client.Media', value: { url: 'https://example.invalid/media/' } });
        expect(internals().gmcpMediaDefaultUrl).toBe('https://example.invalid/media/');
        expect(play).not.toHaveBeenCalled();
    });

    it('resolves media names the way Mudlet does', () => {
        internals().vfs = { profilePath: '/profiles/p' };
        const candidates = (p: string) => internals().mediaPathCandidates(p);
        // getMudletHomeDir().."/media/x.wav" — used as it stands, never re-prefixed.
        expect(candidates('/profiles/p/media/short.wav')).toEqual(['/profiles/p/media/short.wav']);
        // A bare name lives in media/; the old profile-relative spelling still works.
        expect(candidates('short.wav')).toEqual(['/profiles/p/media/short.wav', '/profiles/p/short.wav']);
        expect(candidates('media/short.wav')[1]).toBe('/profiles/p/media/short.wav');
        expect(candidates('/media/short.wav')).toEqual(['/media/short.wav', '/profiles/p/media/short.wav']);
        internals().vfs = null;
    });
});
