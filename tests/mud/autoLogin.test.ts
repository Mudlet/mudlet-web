import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    TextAutoLogin,
    AUTO_LOGIN_USERNAME_DELAY_MS,
    AUTO_LOGIN_PASSWORD_DELAY_MS,
    type AutoLoginCredentials,
} from '../../src/mud/autoLogin';

/**
 * cTelnet's text auto-login: `mTimerLogin` (2 s from the game connecting) and
 * `mTimerPass` (1 s after the name), and nothing else moves either step.
 * Issue #237 items 4 and 5.
 */
describe('text auto-login', () => {
    let creds: AutoLoginCredentials;
    let sent: string[];
    let autoLogin: TextAutoLogin;

    beforeEach(() => {
        vi.useFakeTimers();
        creds = { account: 'Pp-vcn', password: 'hunter2' };
        sent = [];
        autoLogin = new TextAutoLogin({
            readCredentials: () => creds,
            sendLogin: (account) => sent.push(`login:${account}`),
            sendPassword: (password) => sent.push(`pass:${password}`),
        });
    });

    afterEach(() => {
        autoLogin.cancel();
        vi.useRealTimers();
    });

    it('uses Mudlet\'s delays', () => {
        expect(AUTO_LOGIN_USERNAME_DELAY_MS).toBe(2000);
        expect(AUTO_LOGIN_PASSWORD_DELAY_MS).toBe(1000);
    });

    // Item 5: a GA-marked "Press ENTER to continue" splash used to get the name
    // at 42 ms. There is no prompt input to this class at all now — only time.
    it('sends the name at two seconds and the password a second later', () => {
        autoLogin.start();
        vi.advanceTimersByTime(AUTO_LOGIN_USERNAME_DELAY_MS - 1);
        expect(sent).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(sent).toEqual(['login:Pp-vcn']);
        vi.advanceTimersByTime(AUTO_LOGIN_PASSWORD_DELAY_MS - 1);
        expect(sent).toEqual(['login:Pp-vcn']);
        vi.advanceTimersByTime(1);
        expect(sent).toEqual(['login:Pp-vcn', 'pass:hunter2']);
    });

    // Item 4: slot_send_login sends the login whenever it is not empty.
    it('sends a saved name even with no password saved', () => {
        creds = { account: 'Pp-vcn', password: '' };
        autoLogin.start();
        vi.advanceTimersByTime(10_000);
        expect(sent).toEqual(['login:Pp-vcn']);
    });

    // Host::hasAutoLoginCredentials needs the login too.
    it('sends nothing with only a password saved', () => {
        creds = { account: '', password: 'hunter2' };
        autoLogin.start();
        vi.advanceTimersByTime(10_000);
        expect(sent).toEqual([]);
    });

    // Mudlet reads the Host's login when the timer fires, so a login saved (or
    // a vault unlocked) during the wait is the one that goes out.
    it('reads the credentials when each step fires', () => {
        creds = { account: '', password: '' };
        autoLogin.start();
        vi.advanceTimersByTime(1_000);
        creds = { account: 'Late', password: 'pw' };
        vi.advanceTimersByTime(3_000);
        expect(sent).toEqual(['login:Late', 'pass:pw']);
    });

    // cancelLoginTimers — a disconnect, or GMCP Char.Login taking over.
    it('sends nothing once cancelled', () => {
        autoLogin.start();
        vi.advanceTimersByTime(AUTO_LOGIN_USERNAME_DELAY_MS);
        autoLogin.cancel();
        vi.advanceTimersByTime(10_000);
        expect(sent).toEqual(['login:Pp-vcn']);
        expect(autoLogin.pending).toBe(false);
    });

    it('starts over on a new connection', () => {
        autoLogin.start();
        vi.advanceTimersByTime(1_500);
        autoLogin.start();
        vi.advanceTimersByTime(1_500);
        expect(sent).toEqual([]);
        vi.advanceTimersByTime(500);
        expect(sent).toEqual(['login:Pp-vcn']);
    });
});
