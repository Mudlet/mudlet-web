// @vitest-environment node
//
// Node env, not happy-dom — same reason as server-media-gate.test.ts: wasmoon
// resolves its WASM off `import.meta.url`, and the Lua runtime is mocked away
// here anyway.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
        }),
    },
}));

const downloadFromUrl = vi.fn(async (_url: string, _proxy?: string) => new Uint8Array([1, 2, 3]));
vi.mock('../../src/import/remotePackageInstall', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/import/remotePackageInstall')>()),
    downloadFromUrl: (url: string, proxy?: string) => downloadFromUrl(url, proxy),
}));

const { MudSession } = await import('../../src/mud/MudSession');
const { AliasEngine } = await import('../../src/mud/aliases/AliasEngine');
const { TriggerEngine } = await import('../../src/mud/triggers/TriggerEngine');
const { TimerEngine } = await import('../../src/mud/timers/TimerEngine');
const { KeyEngine } = await import('../../src/mud/keybindings/KeyEngine');
const { ScriptingEngine } = await import('../../src/scripting/ScriptingEngine');
const { useAppStore } = await import('../../src/storage/appStore');
type MspCommand = import('../../src/mud/protocol/msp').MspCommand;

// Minimal DOM for the engine constructor. Installed after the imports — see
// server-media-gate.test.ts for why the ordering matters (pcre2 module init).
const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

// The MSP base URL announced by `U=` is one value per session, shared by
// !!SOUND and !!MUSIC — Mudlet keeps a single Host::mMediaLocationMSP and
// TMedia::parseUrl reads it for either kind. WillowdaleMUD (GoMud) is the case
// that pins it: on DO MSP it sends
//     IAC SB MSP "!!SOUND(Off U=https://www.willowdalemud.com)" IAC SE
//     IAC SB MSP "!!MUSIC(static/audio/music/Peaceful.mp3 V=100 L=-1 C=1)" IAC SE
// so the location arrives on a *sound* tag and is consumed by a *music* one.
// Tracking it per-kind left the music with no base URL and nothing played.

const CONN = 'msp-base-url-conn';

type EngineInternals = {
    handleMspCommand: (command: MspCommand) => Promise<void>;
    vfs: unknown;
};

describe('MSP base URL is shared across sound and music', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    let playMusic: ReturnType<typeof vi.spyOn>;
    let playSound: ReturnType<typeof vi.spyOn>;
    let written: string[];

    beforeEach(() => {
        downloadFromUrl.mockClear();
        written = [];
        // Replaced (not just appended) every run: the website-guess tests below
        // rewrite this record, and the guess is derived from it.
        useAppStore.setState(s => ({
            connections: [
                ...s.connections.filter(c => c.id !== CONN),
                { id: CONN, name: 'MSP', url: 'ws://example.invalid:4000' },
            ],
        }));
        session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        // Stand in for a mounted profile VFS: every lookup misses, so resolution
        // always takes the download path and we can assert the URL it builds.
        (engine as unknown as EngineInternals).vfs = {
            profilePath: `/profiles/${CONN}`,
            exists: () => false,
            writeBinaryFile: (path: string) => { written.push(path); },
        };
        playMusic = vi.spyOn(session.sounds, 'playMusic').mockResolvedValue(0);
        playSound = vi.spyOn(session.sounds, 'playSound').mockResolvedValue(0);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    const msp = (command: MspCommand) => (engine as unknown as EngineInternals).handleMspCommand(command);

    it('plays !!MUSIC against a base URL announced by !!SOUND(Off U=...)', async () => {
        await msp({ kind: 'sound', file: 'Off', url: 'https://www.willowdalemud.com' });
        await msp({
            kind: 'music', file: 'static/audio/music/Peaceful.mp3',
            volume: 100, loops: -1, continueIfPlaying: true,
        });

        expect(downloadFromUrl).toHaveBeenCalledTimes(1);
        expect(downloadFromUrl.mock.calls[0][0])
            .toBe('https://www.willowdalemud.com/static/audio/music/Peaceful.mp3');
        // Cached under media/ mirroring the server's own layout.
        expect(written).toEqual([`/profiles/${CONN}/media/static/audio/music/Peaceful.mp3`]);
        expect(playMusic).toHaveBeenCalledWith(expect.objectContaining({
            name: 'media/static/audio/music/Peaceful.mp3',
            volume: 100, loops: -1, continue: true, origin: 'game',
        }));
    });

    it('plays !!SOUND against a base URL announced by !!MUSIC(Off U=...)', async () => {
        await msp({ kind: 'music', file: 'Off', url: 'https://example.invalid/media/' });
        await msp({ kind: 'sound', file: 'zap.wav' });

        expect(downloadFromUrl.mock.calls[0][0]).toBe('https://example.invalid/media/zap.wav');
        expect(playSound).toHaveBeenCalledWith(expect.objectContaining({
            name: 'media/zap.wav', origin: 'game',
        }));
    });

    it('lets a per-command U= override the remembered base URL without clobbering it', async () => {
        await msp({ kind: 'sound', file: 'Off', url: 'https://base.invalid/' });
        await msp({ kind: 'sound', file: 'one.wav', url: 'https://other.invalid/' });
        await msp({ kind: 'sound', file: 'two.wav' });

        expect(downloadFromUrl.mock.calls.map(c => c[0])).toEqual([
            'https://other.invalid/one.wav',
            // The explicit U= became the new default — Mudlet's processUrl
            // writes every parsed URL back to mMediaLocationMSP.
            'https://other.invalid/two.wav',
        ]);
    });

    // With nothing announced, Mudlet guesses the MUD's own website
    // (TMedia::parseUrl → `https://www.<host>/media/`). The test connection is
    // websocket-mode, so the host comes off the endpoint URL.
    it('falls back to the MUD website when no base URL was ever announced', async () => {
        await msp({ kind: 'music', file: 'Peaceful.mp3' });

        expect(downloadFromUrl.mock.calls[0][0]).toBe('https://www.example.invalid/media/Peaceful.mp3');
        expect(playMusic).toHaveBeenCalledWith(expect.objectContaining({ name: 'media/Peaceful.mp3' }));
    });

    it('does not double up the www. prefix on an already-qualified host', async () => {
        useAppStore.setState(s => ({
            connections: s.connections.map(c => (c.id === CONN ? { ...c, url: 'ws://www.example.invalid:4000' } : c)),
        }));
        await msp({ kind: 'sound', file: 'zap.wav' });

        expect(downloadFromUrl.mock.calls[0][0]).toBe('https://www.example.invalid/media/zap.wav');
    });

    it('reports no base URL when the profile has no host to guess from', async () => {
        useAppStore.setState(s => ({
            connections: s.connections.map(c => (c.id === CONN ? { id: c.id, name: c.name, mode: 'mud' as const } : c)),
        }));
        await msp({ kind: 'music', file: 'Peaceful.mp3' });

        expect(downloadFromUrl).not.toHaveBeenCalled();
        expect(playMusic).not.toHaveBeenCalled();
    });

    it('prefers an announced base URL over the website guess', async () => {
        await msp({ kind: 'sound', file: 'Off', url: 'https://cdn.example.invalid/pack/' });
        await msp({ kind: 'music', file: 'Peaceful.mp3' });

        expect(downloadFromUrl.mock.calls[0][0]).toBe('https://cdn.example.invalid/pack/Peaceful.mp3');
    });
});
