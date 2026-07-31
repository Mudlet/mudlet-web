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

// ProfileSettings.allowServerMedia — Mudlet's mAcceptServerMedia, "Allow server
// to download and play media". A *hard* block on GMCP Client.Media (MCMP),
// distinct from the muteMediaGame gate: muting still downloads and plays, just
// silently, while this drops the message before anything is resolved or
// fetched. Mudlet bails equally early (cTelnet::setGMCPVariables, and again at
// the top of TMedia::parseGMCP).
//
// Play/Load are asserted through Stop and Default instead of an actual
// playback: resolving a media file needs a mounted profile VFS, which this
// harness deliberately doesn't have. Stop and Default sit on the far side of
// the same gate, so they pin it just as well.

const CONN = 'server-media-gate-conn';

/** handleClientMedia is private; the gate is the whole point of the test, so
 *  reach it directly rather than standing up a socket + GMCP negotiation. */
type EngineInternals = {
    handleClientMedia: (action: string, value: unknown) => Promise<void>;
    gmcpMediaDefaultUrl: string;
};

describe('allowServerMedia gates GMCP Client.Media', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    let stopSounds: ReturnType<typeof vi.spyOn>;
    let stopMusic: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Gate', url: 'ws://localhost' }],
            }));
        }
        useAppStore.getState().patchConnectionProfile(CONN, { allowServerMedia: undefined });
        session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        stopSounds = vi.spyOn(session.sounds, 'stopSounds').mockReturnValue(undefined);
        stopMusic = vi.spyOn(session.sounds, 'stopMusic').mockReturnValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    const internals = () => engine as unknown as EngineInternals;
    const media = (action: string, value: unknown) => internals().handleClientMedia(action, value);

    it('dispatches server media by default (undefined means allowed)', async () => {
        await media('stop', {});
        expect(stopSounds).toHaveBeenCalledTimes(1);
        expect(stopMusic).toHaveBeenCalledTimes(1);
    });

    it('dispatches server media when explicitly allowed', async () => {
        useAppStore.getState().patchConnectionProfile(CONN, { allowServerMedia: true });
        await media('default', { url: 'https://example.invalid/sounds/' });
        expect(internals().gmcpMediaDefaultUrl).toBe('https://example.invalid/sounds/');
    });

    it('drops every Client.Media action when disallowed', async () => {
        useAppStore.getState().patchConnectionProfile(CONN, { allowServerMedia: false });

        await media('stop', {});
        expect(stopSounds).not.toHaveBeenCalled();
        expect(stopMusic).not.toHaveBeenCalled();

        // Not even the base URL is remembered — the message never gets parsed.
        await media('default', { url: 'https://example.invalid/sounds/' });
        expect(internals().gmcpMediaDefaultUrl).toBe('');

        await media('play', { name: 'rain.wav', type: 'sound' });
        await media('load', { name: 'rain.wav' });
        expect(stopSounds).not.toHaveBeenCalled();
    });

    it('resumes dispatching as soon as the setting is turned back on', async () => {
        useAppStore.getState().patchConnectionProfile(CONN, { allowServerMedia: false });
        await media('stop', {});
        expect(stopSounds).not.toHaveBeenCalled();

        // Read per message, not latched at connect — same as the mute gates.
        useAppStore.getState().patchConnectionProfile(CONN, { allowServerMedia: true });
        await media('stop', {});
        expect(stopSounds).toHaveBeenCalledTimes(1);
    });
});
