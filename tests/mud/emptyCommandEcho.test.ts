// @vitest-environment node
//
// Mudlet's "Force new line on empty commands" (`mUSE_FORCE_LF_AFTER_PROMPT`),
// which only means anything alongside the GA linebreak fix. The rule is one
// line of Host::send (Host.cpp:1461):
//
//     if (!cmd.isEmpty() || !mUSE_IRE_DRIVER_BUGFIX || mUSE_FORCE_LF_AFTER_PROMPT)
//
// i.e. the echo is skipped only for an empty command, only while the fix is on,
// and only while the force flag is off. mudix echoed empty commands
// unconditionally before this, so a GA game with the fix on got the second
// blank line the fix exists to remove.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MudSession } from '../../src/mud/MudSession';

describe('empty-command echo', () => {
    let session: MudSession;
    let echoed: string[];

    beforeEach(() => {
        session = new MudSession();
        echoed = [];
        vi.spyOn(session, 'echoCommand').mockImplementation((text: string) => { echoed.push(text); });
    });

    afterEach(() => vi.restoreAllMocks());

    it('echoes an empty command by default — the fix is off', () => {
        session.echoSentCommand('', true);
        expect(echoed).toEqual(['']);
    });

    it('skips it once the GA linebreak fix is on', () => {
        session.setFixUnnecessaryLinebreaks(true);
        session.echoSentCommand('', true);
        expect(echoed).toEqual([]);
    });

    it('echoes it again when the force flag is set', () => {
        session.setFixUnnecessaryLinebreaks(true);
        session.forceLfAfterPrompt = true;
        session.echoSentCommand('', true);
        expect(echoed).toEqual(['']);
    });

    it('never touches a non-empty command, in any combination', () => {
        for (const fix of [false, true]) {
            for (const force of [false, true]) {
                echoed = [];
                session.setFixUnnecessaryLinebreaks(fix);
                session.forceLfAfterPrompt = force;
                session.echoSentCommand('north', true);
                expect(echoed).toEqual(['north']);
            }
        }
    });

    it('is checked before the showSentText mode, not instead of it', () => {
        // "never" still wins over a forced empty line — the force flag restores
        // the blank line the fix removed, it does not override the echo mode.
        session.setFixUnnecessaryLinebreaks(true);
        session.forceLfAfterPrompt = true;
        session.showSentText = 'never';
        session.echoSentCommand('', true);
        expect(echoed).toEqual([]);
    });
});
