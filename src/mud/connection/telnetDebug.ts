/**
 * localStorage-gated diagnostic logging for the MUD connection. Each gate is
 * toggled from the browser console (e.g. `localStorage.setItem('mudix.debugTelnet',
 * '1')`) and read live on every use, so logging can be flipped mid-session
 * without a reconnect.
 */

function gateEnabled(key: string): boolean {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1';
    } catch {
        return false;
    }
}

/**
 * `mudix.debugTelnet` — log every telnet command/subnegotiation byte seen on
 * each incoming frame, and every byte-string we send. Used to investigate
 * protocol-negotiation issues (GMCP/MSDP/MCCP not enabling) by revealing
 * exactly what crosses the wire in both directions.
 */
export function debugTelnetEnabled(): boolean {
    return gateEnabled('mudix.debugTelnet');
}

/**
 * `mudix.debugFrames` — log WebSocket frame boundaries for the MUD stream.
 * Used to investigate "extra line break" issues that surface when long MUD
 * lines arrive split across multiple WebSocket frames.
 */
export function debugFramesEnabled(): boolean {
    return gateEnabled('mudix.debugFrames');
}

/**
 * `mudix.debugMsp` — log MSP negotiation, parsed `!!SOUND`/`!!MUSIC` tags
 * (inline and subneg), and their dispatch into the SoundManager. Use this to
 * confirm whether a MUD is actually emitting MSP and whether the client is
 * routing it through.
 */
export function debugMspEnabled(): boolean {
    return gateEnabled('mudix.debugMsp');
}

/**
 * `mudix.debugGmcp` — log every parsed GMCP message's path and (truncated) body
 * as it arrives. Used to see exactly which modules a server drives — e.g.
 * whether login audio comes over `Client.Media.*` GMCP vs. MSP tags.
 */
export function debugGmcpEnabled(): boolean {
    return gateEnabled('mudix.debugGmcp');
}

/**
 * `mudix.debugGa` — log every IAC GA / IAC EOR prompt marker the server sends,
 * plus the one-time moment the client latches into GA-driven prompt mode. Use
 * this to confirm whether a MUD actually signals its prompts (GA-less MUDs rely
 * on the `promptTimeoutMs` idle-flush fallback instead).
 */
export function debugGaEnabled(): boolean {
    return gateEnabled('mudix.debugGa');
}

const TELNET_CMD_NAMES: Record<number, string> = {
    239: 'EOR', 240: 'SE', 241: 'NOP', 249: 'GA', 250: 'SB',
    251: 'WILL', 252: 'WONT', 253: 'DO', 254: 'DONT',
};
const TELNET_OPT_NAMES: Record<number, string> = {
    1: 'ECHO', 3: 'SGA', 24: 'TTYPE', 25: 'EOR', 31: 'NAWS', 32: 'TSPEED',
    42: 'CHARSET', 69: 'MSDP', 70: 'MSSP', 85: 'MCCP1', 86: 'MCCP2', 90: 'MSP',
    91: 'MXP', 93: 'ZMP', 201: 'GMCP', 255: 'IAC',
};

/** Scan a Latin-1 byte-string for telnet IAC sequences and log them in
 *  human-readable form. Logs SB option codes too (e.g. `SB GMCP` / `SB MSDP`). */
export function logTelnetNegotiation(label: string, s: string): void {
    const seqs: string[] = [];
    for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) !== 0xFF) continue; // not IAC
        const cmd = s.charCodeAt(i + 1);
        if (cmd === 250) { // SB <opt> ... — just name the option
            const opt = s.charCodeAt(i + 2);
            seqs.push(`SB ${TELNET_OPT_NAMES[opt] ?? opt}`);
        } else if (cmd >= 251 && cmd <= 254) { // WILL/WONT/DO/DONT <opt>
            const opt = s.charCodeAt(i + 2);
            seqs.push(`${TELNET_CMD_NAMES[cmd]} ${TELNET_OPT_NAMES[opt] ?? opt}`);
        } else if (TELNET_CMD_NAMES[cmd]) {
            seqs.push(TELNET_CMD_NAMES[cmd]);
        }
    }
    // eslint-disable-next-line no-console
    console.debug(`[mudix.telnet ${label}] bytes=${s.length}`,
        seqs.length ? seqs.join(' | ') : '(no IAC sequences)');
}

/** GMCP modules whose bodies carry a secret — never logged.
 *
 *  `Char.Login.Credentials` carries the player's password;
 *  `Char.Login.Reconnect` carries a bearer token that signs in *without* one,
 *  and `Char.Login.AuthCode` carries an authorization code and its PKCE
 *  verifier, which together let anyone holding them redeem the code. A debug
 *  log is pasted into bug reports, so all three are as bad to print as the
 *  password was. Matched as prefixes of the lowercased body. */
const SECRET_GMCP_MODULES = [
    'char.login.credentials',
    'char.login.reconnect',
    'char.login.authcode',
];

/** Escape control and high bytes so a subnegotiation body reads unambiguously
 *  in the console (a lone `\x00` separator in MSDP, say, or a stray IAC). */
function escapeBytes(s: string): string {
    return s.replace(/[^\x20-\x7E]/g, c =>
        `\\x${c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`);
}

/**
 * Log an outbound byte-string: the IAC sequences it carries plus the verbatim
 * body of every subnegotiation, so a handshake payload a server rejects (a GMCP
 * body it refuses to parse, say) is visible exactly as we framed it — the
 * inbound `logTelnetNegotiation` only names options, which isn't enough to tell
 * a malformed body from a well-formed one.
 *
 * Bodies only: plain command text is reported as a byte count, never content,
 * because `send()` also carries typed passwords. The `Char.Login` messages in
 * {@link SECRET_GMCP_MODULES} are redacted for the same reason.
 */
export function logOutboundBytes(s: string): void {
    const parts: string[] = [];
    let plainBytes = 0;
    for (let i = 0; i < s.length;) {
        if (s.charCodeAt(i) !== 0xFF) { plainBytes++; i++; continue; }
        const cmd = s.charCodeAt(i + 1);
        if (cmd === 250) { // SB <opt> … IAC SE
            const opt = s.charCodeAt(i + 2);
            const end = s.indexOf('\xFF\xF0', i + 3);
            const body = end === -1 ? s.substring(i + 3) : s.substring(i + 3, end);
            const name = TELNET_OPT_NAMES[opt] ?? String(opt);
            const secret = opt === 201
                && SECRET_GMCP_MODULES.some(m => body.toLowerCase().startsWith(m));
            parts.push(`SB ${name} ${secret ? '<redacted>' : JSON.stringify(escapeBytes(body))}`);
            i = end === -1 ? s.length : end + 2;
        } else if (cmd >= 251 && cmd <= 254) { // WILL/WONT/DO/DONT <opt>
            const opt = s.charCodeAt(i + 2);
            parts.push(`${TELNET_CMD_NAMES[cmd]} ${TELNET_OPT_NAMES[opt] ?? opt}`);
            i += 3;
        } else {
            parts.push(TELNET_CMD_NAMES[cmd] ?? `IAC ${cmd}`);
            i += 2;
        }
    }
    if (plainBytes > 0) parts.push(`<${plainBytes} text byte(s)>`);
    // eslint-disable-next-line no-console
    console.debug(`[mudix.telnet out] bytes=${s.length}`,
        parts.length ? parts.join(' | ') : '(empty)');
}
