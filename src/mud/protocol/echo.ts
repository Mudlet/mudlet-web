import { ECHO_DO, ECHO_DONT } from "./constants";

const IAC = 0xFF, SB = 0xFA, SE = 0xF0;
const WILL = 0xFB, WONT = 0xFC, DO = 0xFD, DONT = 0xFE;
const ECHO_OPT = 0x01;


/** Mudlet-parity anomaly detection (cTelnet::checkEchoAnomalyPattern):
 *  if the raw ECHO state toggles ≥ ANOMALY_THRESHOLD times within
 *  ANOMALY_WINDOW_MS we conclude the server is misusing ECHO for
 *  per-line edit signalling and definitively refuse the option for the rest
 *  of the session by sending `IAC DONT ECHO` and ignoring further flips. */
const ANOMALY_THRESHOLD = 5;
const ANOMALY_WINDOW_MS = 5000;

/** Mudlet-parity safety net for servers that send `IAC WILL ECHO` for the
 *  password prompt but never follow up with `IAC WONT ECHO` after the user
 *  authenticates (network drop / server bug). We arm a one-shot timeout
 *  when password mode commits, but only during the first LOGIN_PHASE_MS of
 *  the connection so legitimate later password prompts (e.g. an admin
 *  command) aren't disturbed. The timer is cancelled when WONT arrives. */
const LOGIN_PHASE_MS = 5 * 60 * 1000;
const PASSWORD_TIMEOUT_MS = 60 * 1000;

export class EchoHandler {
    /** State exposed to UI / send-echo logic, committed on the negotiation
     *  itself as cTelnet does. True whenever the server is echoing for us, which
     *  means we must suppress our own local command echo to avoid showing every
     *  line twice. This is *not* the same as password masking — see
     *  `_passwordStyle` / `passwordMode`. */
    private _serverEchoing = false;
    /** Whether the *current* ECHO engagement should mask the input line. A
     *  server that enables ECHO during the opening negotiation burst — before
     *  it has printed any output — is doing session-wide remote echo (it will
     *  echo your name, commands, everything), not requesting a password. The
     *  classic Diku/ROM password pattern instead toggles `IAC WILL ECHO` on
     *  *after* the name prompt, right before "Password:". So we only treat an
     *  ECHO that engages after the server has already sent output as a password
     *  prompt. Captured at each OFF→ON transition. Mudlet masks on every ECHO;
     *  doing so here would hide the name on full-server-echo MUDs, which is the
     *  bug this distinction fixes. */
    private _passwordStyle = false;
    /** Set once the server has emitted any non-telnet output. Distinguishes a
     *  connect-time (server-wide) ECHO from a later (password) ECHO. */
    private sawAppData = false;
    private passwordSafetyTimer: ReturnType<typeof setTimeout> | null = null;
    private connectionStartAt = 0;
    private toggleCount = 0;
    private lastToggleAt = 0;
    private _anomalyDetected = false;
    private readonly sendRaw: (data: string) => void;
    private readonly onEchoChange: (maskInput: boolean) => void;
    private readonly onAnomalyDetected: (() => void) | undefined;

    constructor(
        sendRaw: (data: string) => void,
        onEchoChange: (maskInput: boolean) => void,
        onAnomalyDetected?: () => void,
    ) {
        this.sendRaw = sendRaw;
        this.onEchoChange = onEchoChange;
        this.onAnomalyDetected = onAnomalyDetected;
    }

    get serverEchoing(): boolean {
        return this._serverEchoing;
    }

    /** Whether the command input should be masked (password mode). Only true
     *  for an ECHO engagement that began after the server started sending
     *  output — a genuine password prompt — never for connect-time server-wide
     *  echo. */
    get passwordMode(): boolean {
        return this._serverEchoing && this._passwordStyle;
    }

    get anomalyDetected(): boolean {
        return this._anomalyDetected;
    }

    /** Scan the post-MCCP byte stream for true `IAC WILL/WONT ECHO`. Substring
     *  matching on the raw buffer is unsafe — GMCP/MSDP subnegotiation payloads
     *  can contain the same byte sequence (e.g. an unescaped IAC followed by
     *  MSDP_VAR=\x01), which would spuriously flip password mode every prompt
     *  on data-heavy servers like Legend of Kallisti. Walk the stream as
     *  telnet: skip SB…SE blocks entirely, honor IAC IAC escapes, and only act
     *  on top-level IAC WILL/WONT ECHO. */
    processData(data: string): void {
        let i = 0;
        while (i < data.length) {
            // Any byte outside a telnet command is server output. Seeing it
            // before an ECHO request is what tells a connect-time server-wide
            // echo apart from a mid-session password prompt.
            if (data.charCodeAt(i) !== IAC) { this.sawAppData = true; i++; continue; }
            const cmd = data.charCodeAt(i + 1);
            if (cmd === IAC) { i += 2; continue; }
            if (cmd === SB) {
                const end = findSubnegEnd(data, i + 2);
                i = end < 0 ? data.length : end + 2;
                continue;
            }
            if (cmd === WILL || cmd === WONT || cmd === DO || cmd === DONT) {
                if (data.charCodeAt(i + 2) === ECHO_OPT) {
                    if (cmd === WILL) this.setEchoing(true);
                    else if (cmd === WONT) this.setEchoing(false);
                }
                i += 3;
                continue;
            }
            i += 2;
        }
    }

    private setEchoing(on: boolean): void {
        // Anomaly is sticky for the session — once we've refused ECHO we don't
        // re-engage no matter what the server sends.
        if (this._anomalyDetected) return;
        if (on === this._serverEchoing) return;
        // Latch whether this engagement masks: a password prompt only if the
        // server had already printed output by the time it asked us to echo.
        if (on) this._passwordStyle = this.sawAppData;
        // The toggle counter is what stands between us and a server that misuses
        // ECHO for line editing — see trackToggleAndDetectAnomaly, which is
        // cTelnet::checkEchoAnomalyPattern down to the 5-in-5000ms constants.
        if (this.trackToggleAndDetectAnomaly()) return;
        // Committed on the negotiation itself, exactly where cTelnet calls
        // setRemoteEchoingActive(). There used to be half a second of debounce
        // in front of this, to keep a bouncing server from being acked on every
        // flip — but that is the job the anomaly counter above already does,
        // upstream and here, and the delay was visible where it must not be: a
        // script that negotiates ECHO and reads the command line in the same
        // breath saw the state before the prompt, and the masking a player is
        // owed arrived late.
        this._serverEchoing = on;
        this.sendRaw(on ? ECHO_DO : ECHO_DONT);
        this.onEchoChange(this.passwordMode);
        this.updatePasswordSafetyTimer();
        if (debugEchoEnabled()) {
            const mode = !this._serverEchoing ? 'OFF (normal)'
                : this.passwordMode ? 'ON (password mode)'
                : 'ON (server-wide echo, input not masked)';
            console.debug(`[mudix.echo] committed → ${mode}`);
        }
    }

    /** Arm / disarm the Mudlet-style "password mode never ended" safety
     *  timeout. Called right after a committed state change. */
    private updatePasswordSafetyTimer(): void {
        if (this.passwordSafetyTimer) {
            clearTimeout(this.passwordSafetyTimer);
            this.passwordSafetyTimer = null;
        }
        // Only password masking needs the "server never sent WONT" safety net.
        // Session-wide echo legitimately stays on for the whole connection, so
        // forcing it off after a timeout would re-enable local echo and double
        // every line.
        if (!this.passwordMode) return;
        if (this.connectionStartAt === 0) return;
        if (Date.now() - this.connectionStartAt >= LOGIN_PHASE_MS) return;
        this.passwordSafetyTimer = setTimeout(() => {
            this.passwordSafetyTimer = null;
            if (!this._serverEchoing) return;
            this._serverEchoing = false;
            this.sendRaw(ECHO_DONT);
            this.onEchoChange(false);
            if (debugEchoEnabled()) {
                console.warn(`[mudix.echo] password-mode safety timeout (${PASSWORD_TIMEOUT_MS}ms) — server never sent WONT ECHO, forcing OFF`);
            }
        }, PASSWORD_TIMEOUT_MS);
    }

    /** Mirror cTelnet::checkEchoAnomalyPattern. Increments a sliding-window
     *  toggle counter on every raw flip and, when the threshold is crossed,
     *  trips sticky anomaly state. Returns true when anomaly was tripped on
     *  this call (the caller should bail out). */
    private trackToggleAndDetectAnomaly(): boolean {
        const now = Date.now();
        if (this.lastToggleAt > 0 && now - this.lastToggleAt < ANOMALY_WINDOW_MS) {
            this.toggleCount++;
        } else {
            this.toggleCount = 1;
        }
        this.lastToggleAt = now;
        if (this.toggleCount < ANOMALY_THRESHOLD) return false;
        this.tripAnomaly();
        return true;
    }

    /** Refuse ECHO for the rest of the session: send `IAC DONT ECHO`, drop any
     *  the safety timer, force the UI back to normal, and notify
     *  the engine so a `sysEchoAnomalyDetected` Lua event can fire. */
    private tripAnomaly(): void {
        this._anomalyDetected = true;
        if (this.passwordSafetyTimer) {
            clearTimeout(this.passwordSafetyTimer);
            this.passwordSafetyTimer = null;
        }
        this.sendRaw(ECHO_DONT);
        if (this._serverEchoing) {
            this._serverEchoing = false;
            this.onEchoChange(false);
        }
        this.onAnomalyDetected?.();
        if (debugEchoEnabled()) {
            console.warn(`[mudix.echo] anomaly detected — refusing ECHO for the session`);
        }
    }

    reset(): void {
        if (this.passwordSafetyTimer) {
            clearTimeout(this.passwordSafetyTimer);
            this.passwordSafetyTimer = null;
        }
        this._passwordStyle = false;
        this.sawAppData = false;
        this.toggleCount = 0;
        this.lastToggleAt = 0;
        this._anomalyDetected = false;
        this.connectionStartAt = Date.now();
        if (this._serverEchoing) {
            this._serverEchoing = false;
            this.onEchoChange(false);
        }
    }
}

function debugEchoEnabled(): boolean {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem('mudix.debugEcho') === '1';
    } catch {
        return false;
    }
}

/** Find the offset of `IAC SE` (the end-of-subneg) at-or-after `from`. Skips
 *  embedded `IAC IAC` (escaped data IAC). Returns the index of the `IAC` byte
 *  of the closing pair, or -1 if the subneg is incomplete in this chunk. */
function findSubnegEnd(data: string, from: number): number {
    for (let i = from; i < data.length - 1; i++) {
        if (data.charCodeAt(i) !== IAC) continue;
        const next = data.charCodeAt(i + 1);
        if (next === IAC) { i++; continue; }
        if (next === SE) return i;
    }
    return -1;
}
