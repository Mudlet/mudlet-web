// @vitest-environment node
//
// node, not happy-dom: TriggerEngine pulls in pcre2-wasm, which loads its WASM
// from the filesystem here instead of trying a streaming fetch.
import { describe, it, expect, vi } from 'vitest';
import { ScriptingAPI } from '../../src/scripting/ScriptingAPI';
import { NULL_ENGINE_HOST, type EngineHost } from '../../src/scripting/EngineHost';
import { MudSession } from '../../src/mud/MudSession';
import { AliasEngine } from '../../src/mud/aliases/AliasEngine';
import { TriggerEngine } from '../../src/mud/triggers/TriggerEngine';
import { TimerEngine } from '../../src/mud/timers/TimerEngine';
import { KeyEngine } from '../../src/mud/keybindings/KeyEngine';

/**
 * Real Mudlet (measured on 4.21.0-dev-c87a0607) applies NO teardown guard: a
 * sysExitEvent handler's connectToServer / reconnect / resetProfile are all
 * accepted, and only fail to land because the Qt event loop stops pumping.
 *
 * Mudlet Web deliberately diverges — its teardown is synchronous and cannot be
 * interrupted, so a resurrected socket or profile would race disposal. These
 * tests pin that divergence, and pin that it is *audible* rather than silent:
 * the silent version made `if wantReconnect then connect(url) end` in an exit
 * handler do nothing with no way for the script author to find out.
 */
function makeApi() {
    const session = new MudSession();
    const api = new ScriptingAPI(
        session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(),
        'teardown-test',
    );
    return { api, session };
}

/** A host standing in for a disposed engine: refuses and logs, as the real one does. */
function disposedHost(session: MudSession, log: string[]): EngineHost {
    const refuse = (call: string) => {
        const msg = `${call} ignored — the profile is shutting down.`;
        log.push(msg);
        session.events.emit('script.log', msg, 'error');
    };
    return {
        ...NULL_ENGINE_HOST,
        requestConnect: () => refuse('connect()'),
        requestReconnect: () => { refuse('reconnect()'); return false; },
        resetProfile: () => refuse('resetProfile()'),
    };
}

describe('teardown refusals are audible, not silent', () => {
    it('reconnect() goes through the host, not straight to the session', () => {
        const { api, session } = makeApi();
        const sessionReconnect = vi.spyOn(session, 'reconnect');
        const log: string[] = [];
        api.setHost(disposedHost(session, log));

        expect(api.reconnect()).toBe(false);
        // The regression this guards: reconnect() used to call
        // session.reconnect() directly, bypassing every teardown gate and
        // opening a socket mid-disposal.
        expect(sessionReconnect).not.toHaveBeenCalled();
        expect(log).toContain('reconnect() ignored — the profile is shutting down.');
        session.destroy();
    });

    it('connect() and resetProfile() report their refusal to script.log', () => {
        const { api, session } = makeApi();
        const log: string[] = [];
        const errors: string[] = [];
        session.events.on('script.log', (text, level) => {
            if (level === 'error') errors.push(text);
        });
        api.setHost(disposedHost(session, log));

        api.connect('ws://example.invalid');
        api.resetProfile();

        expect(errors.some(e => e.startsWith('connect()'))).toBe(true);
        expect(errors.some(e => e.startsWith('resetProfile()'))).toBe(true);
        session.destroy();
    });

    it('an unbound host is inert, not session-backed', () => {
        // Regression: the unbound host used to carry live fallbacks (dial the
        // session, send, emit flushLines), inherited from the old nullable-
        // callback design. That made destroy() self-defeating — it refuses
        // connect() in phase 1, then calls setHost(null) in phase 4, which
        // restored a host that would dial. A surviving DOM link handler
        // calling connect()/reconnect() after teardown reopened a socket the
        // disposal had just torn down.
        const { api, session } = makeApi();
        const sessionConnect = vi.spyOn(session, 'connect');
        const sessionReconnect = vi.spyOn(session, 'reconnect');

        api.setHost(null);
        expect(api.reconnect()).toBe(false);
        api.connect('ws://example.invalid');

        expect(sessionReconnect).not.toHaveBeenCalled();
        expect(sessionConnect).not.toHaveBeenCalled();
        session.destroy();
    });
});
