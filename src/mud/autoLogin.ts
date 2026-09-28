/**
 * Text auto-login — Mudlet's `mTimerLogin` / `mTimerPass` pair in cTelnet.
 *
 * Desktop answers a text login on fixed timers and nothing else:
 * `slot_socketConnected` starts the login timer, `slot_send_login` sends the
 * saved character name when there is one and, when a password is saved too
 * (`Host::hasAutoLoginCredentials`), starts the password timer, and
 * `slot_send_pass` sends the password — "timer-based, independent of ECHO
 * mode". No prompt marker, no ECHO negotiation, moves either step earlier.
 *
 * Mudlet Web used to answer the first IAC GA/EOR with the name and the first
 * ECHO-off with the password. A game that greets with a GA-marked splash
 * ("Press ENTER to continue") took the name at 42 ms, answering a question the
 * game had not asked yet (issue #237). And the name was sent only when a
 * password was saved as well, where desktop sends it whenever it is set.
 *
 * Neither step echoes: both are `cTelnet::sendData`, below `Host::send` where
 * the command echo lives, and neither is a game command (so neither arms
 * character-at-a-time detection — the password prompt the name walks into is
 * exactly the ECHO+SGA state that detection is trying to tell apart).
 */

/** cTelnet's `AUTO_LOGIN_USERNAME_DELAY_MS`: connect → character name. */
export const AUTO_LOGIN_USERNAME_DELAY_MS = 2000;
/** cTelnet's `AUTO_LOGIN_PASSWORD_DELAY_MS`: character name → password. */
export const AUTO_LOGIN_PASSWORD_DELAY_MS = 1000;

export interface AutoLoginCredentials {
    account: string;
    password: string;
}

export interface TextAutoLoginDeps {
    /** Read at each step rather than at connect, as Mudlet reads the Host's
     *  login and password when its timers fire. */
    readCredentials: () => AutoLoginCredentials;
    /** `cTelnet::sendData(login)` — no echo, not a game command. */
    sendLogin: (account: string) => void;
    /** `cTelnet::sendData(pass, false)` — never shown, never echoed. */
    sendPassword: (password: string) => void;
    setTimeout?: (fn: () => void, ms: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
}

export class TextAutoLogin {
    private loginTimer: unknown = null;
    private passTimer: unknown = null;
    private readonly setTimer: (fn: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;

    constructor(private readonly deps: TextAutoLoginDeps) {
        this.setTimer = deps.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
        this.clearTimer = deps.clearTimeout
            ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    }

    /** The game link is up — `slot_socketConnected` starting `mTimerLogin`.
     *  Started on every connection, credentials or not: they are looked at
     *  only when the timer fires. */
    start(): void {
        this.cancel();
        this.loginTimer = this.setTimer(() => this.sendLogin(), AUTO_LOGIN_USERNAME_DELAY_MS);
    }

    /** `cancelLoginTimers` — the connection ended, or GMCP `Char.Login` has
     *  taken the login over. */
    cancel(): void {
        if (this.loginTimer !== null) this.clearTimer(this.loginTimer);
        if (this.passTimer !== null) this.clearTimer(this.passTimer);
        this.loginTimer = null;
        this.passTimer = null;
    }

    /** Whether either step is still to come. */
    get pending(): boolean {
        return this.loginTimer !== null || this.passTimer !== null;
    }

    private sendLogin(): void {
        this.loginTimer = null;
        const { account, password } = this.deps.readCredentials();
        if (account) this.deps.sendLogin(account);
        if (account && password) {
            this.passTimer = this.setTimer(() => this.sendPassword(), AUTO_LOGIN_PASSWORD_DELAY_MS);
        }
    }

    private sendPassword(): void {
        this.passTimer = null;
        const { password } = this.deps.readCredentials();
        if (password) this.deps.sendPassword(password);
    }
}
