// Match telnet sequences by their real command lengths so we don't over-consume
// the byte that follows a 2-byte command. Alternatives, in priority order:
//   1. IAC SB … IAC SE        — subnegotiation (variable length)
//   2. IAC {WILL|WONT|DO|DONT} <option>  — 3-byte option negotiation
//   3. IAC <command>          — 2-byte command (GA, EOR, NOP, …)
// The old pattern (`ÿ.[^ÿ]`) treated *every* command as 3 bytes, so a 2-byte
// IAC EOR/GA immediately followed by data (e.g. `IAC EOR \x1b[K`) ate the next
// byte — orphaning the `\x1b` and leaking `[K` as literal text.
export const TELNET_OPTION_REGEX = /\xFF\xFA[\s\S]*?\xFF\xF0|\xFF[\xFB-\xFE][\s\S]|\xFF[\s\S]/g;

// TELNET_OPTION_REGEX minus the subnegotiation branch, for buffers that hold
// no IAC SE. The SB branch scans forward for its terminator, so without one
// present it rescans to end-of-buffer from every IAC SB (quadratic: ~1.3s on
// 160KB of IAC SB from a hostile server). Skipping it there is exact —
// `IAC SB … IAC SE` cannot match when the buffer contains no IAC SE.
export const TELNET_OPTION_REGEX_NO_SB = /\xFF[\xFB-\xFE][\s\S]|\xFF[\s\S]/g;

// Telnet Go Ahead / End-of-Record — used by MUDs to signal a prompt line
export const TELNET_GA  = "\xFF\xF9"; // IAC GA  (249)
export const TELNET_EOR = "\xFF\xEF"; // IAC EOR (239)

// Telnet EOR *option* (RFC 885, option 25) — distinct from the IAC EOR command
// byte above. The server negotiates `IAC WILL EOR` to announce it will mark
// prompts with `IAC EOR`; the client confirms with `IAC DO EOR`. Without that
// confirmation some servers stall before showing the login prompt. Once active,
// the IAC EOR markers feed the same prompt detection as IAC GA.
export const TELOPT_EOR  = "\x19";          // 25
export const EOR_WILL = "\xFF\xFB\x19";     // IAC WILL EOR - server will send EOR prompt markers
export const EOR_DO   = "\xFF\xFD\x19";     // IAC DO EOR   - client accepts EOR prompt markers

// Telnet SGA (Suppress Go Ahead, RFC 858, option 3). Enabling SGA suppresses
// the `IAC GA` prompt marker and is the classic character-at-a-time signal.
// mudix — matching Mudlet (cTelnet.cpp) — operates in line mode only, so it
// *rejects* SGA: on `IAC WILL SGA` it replies `IAC DONT SGA`. A DONT is still a
// definitive answer (strict servers don't stall on it), and refusing keeps
// `IAC GA` un-suppressed so it can continue to drive prompt detection.
export const TELOPT_SGA  = "\x03";          // 3
export const SGA_WILL = "\xFF\xFB\x03";     // IAC WILL SGA  - server offers to suppress go-ahead
export const SGA_DO   = "\xFF\xFD\x03";     // IAC DO SGA    - (accept form; unused — mudix rejects SGA)
export const SGA_DONT = "\xFF\xFE\x03";     // IAC DONT SGA  - client refuses (stay in line mode)

// Telnet LINEMODE (RFC 1184, option 34). Negotiates who performs line editing
// and when a line is forwarded to the server. mudix — matching Mudlet — always
// does its own local line editing and sends whole lines on Enter, and never
// delegates that to the server, so it refuses LINEMODE in *both* directions:
// `IAC DONT LINEMODE` to the server's WILL, `IAC WONT LINEMODE` to its DO.
export const TELOPT_LINEMODE = "\x22";       // 34
export const LINEMODE_WILL = "\xFF\xFB\x22"; // IAC WILL LINEMODE - server offers line-mode control
export const LINEMODE_DO   = "\xFF\xFD\x22"; // IAC DO LINEMODE   - server requests we do line-mode
export const LINEMODE_DONT = "\xFF\xFE\x22"; // IAC DONT LINEMODE - refuse the server's offer
export const LINEMODE_WONT = "\xFF\xFC\x22"; // IAC WONT LINEMODE - refuse the server's request
export const GMCP_COMMAND_CODE = 201;
export const GMCP_IAC = "\xFF";
export const GMCP_SB = "\xFA";
export const GMCP_SE = "\xF0";

// MCCP2 (Mud Client Compression Protocol v2)
export const MCCP2_OPTION = 0x56; // Telnet option 86

// MSDP (Mud Server Data Protocol) — telnet option 69, with MSDP_VAR/MSDP_VAL
// framing bytes inside the IAC SB … IAC SE subnegotiation. (IAC/SB/SE reuse the
// GMCP_* byte constants above — they are the generic telnet command bytes.)
export const MSDP_COMMAND_CODE = 69;
export const OPT_MSDP = "\x45"; // 69
export const MSDP_VAR = "\x01"; // 1
export const MSDP_VAL = "\x02"; // 2
// Compound-value framing: tables (string-keyed) and arrays (ordered list).
export const MSDP_TABLE_OPEN  = "\x03"; // 3
export const MSDP_TABLE_CLOSE = "\x04"; // 4
export const MSDP_ARRAY_OPEN  = "\x05"; // 5
export const MSDP_ARRAY_CLOSE = "\x06"; // 6

// MSDP negotiation sequences
export const MSDP_WILL = "\xFF\xFB\x45"; // IAC WILL MSDP - server offers MSDP
export const MSDP_DO   = "\xFF\xFD\x45"; // IAC DO MSDP   - client requests MSDP

// MSSP (Mud Server Status Protocol) — telnet option 70. Once negotiated the
// server reports status fields (player count, uptime, codebase, hostname, …)
// in a single `IAC SB MSSP MSSP_VAR <name> MSSP_VAL <value> … IAC SE`
// subnegotiation, reusing MSDP's VAR/VAL framing bytes (1/2). Typically sent
// once right after the handshake. Used by MUD-list crawlers, but a client can
// negotiate it too to read the server's self-reported status.
export const MSSP_COMMAND_CODE = 70;
export const OPT_MSSP = "\x46"; // 70
export const MSSP_VAR = "\x01"; // 1 (same byte as MSDP_VAR)
export const MSSP_VAL = "\x02"; // 2 (same byte as MSDP_VAL)
export const MSSP_WILL = "\xFF\xFB\x46"; // IAC WILL MSSP - server offers MSSP
export const MSSP_DO   = "\xFF\xFD\x46"; // IAC DO MSSP   - client requests MSSP

// GMCP (Generic MUD Communication Protocol) negotiation sequences
export const GMCP_WILL = "\xFF\xFB\xC9"; // IAC WILL GMCP - server offers GMCP
export const GMCP_DO   = "\xFF\xFD\xC9"; // IAC DO GMCP   - client requests GMCP

// ATCP (Achaea Telnet Client Protocol) — telnet option 200, GMCP's predecessor.
// Same `IAC SB <opt> <payload> IAC SE` framing as GMCP. mudix only sends it
// (sendATCP); it doesn't negotiate ATCP inbound.
export const ATCP_COMMAND_CODE = 200;
export const OPT_ATCP = "\xC8"; // 200

// zMUD "channel 102" (telnet option 102) — a generic out-of-band data channel
// some zMUD/CMUD-era servers use. `IAC SB 102 <data> IAC SE` framing.
export const TELNET_102_COMMAND_CODE = 102;
export const OPT_TELNET_102 = "\x66"; // 102

// TERMINAL-TYPE (RFC 1091) / MTTS. Servers send IAC DO TTYPE and expect the
// client to identify itself before they continue negotiating (e.g. offering
// MSDP/GMCP). The subnegotiation cycle is: server SB TTYPE SEND IAC SE, client
// replies SB TTYPE IS <name> IAC SE — repeated to walk through client name,
// terminal type, and the MTTS capability bitvector.
export const TTYPE_COMMAND_CODE = 24;       // telnet option 24
export const OPT_TTYPE   = "\x18";          // 24
export const TTYPE_IS    = "\x00";          // 0 — "this IS my type"
export const TTYPE_SEND  = "\x01";          // 1 — "SEND me your type"
export const TTYPE_DO    = "\xFF\xFD\x18";  // IAC DO TTYPE   - server requests our type
export const TTYPE_WILL  = "\xFF\xFB\x18";  // IAC WILL TTYPE - client agrees to send it

// Telnet ECHO option (RFC 857)
export const ECHO_WILL = "\xFF\xFB\x01"; // IAC WILL ECHO - server will echo (suppress local echo)
export const ECHO_WONT = "\xFF\xFC\x01"; // IAC WONT ECHO - server won't echo (restore local echo)
export const ECHO_DO   = "\xFF\xFD\x01"; // IAC DO ECHO   - client accepts server echo
export const ECHO_DONT = "\xFF\xFE\x01"; // IAC DONT ECHO - client asks server to stop echoing

// MSP (MUD Sound Protocol) — telnet option 90. Negotiation just gates the
// in-band tag stream: once the option is on, `!!SOUND(...)` and `!!MUSIC(...)`
// triplets embedded in regular MUD text trigger sound/music playback. The
// protocol predates strict telnet framing — most servers send tags inline
// without ever negotiating SB MSP — but some implementations wrap the body
// inside `IAC SB MSP ... IAC SE`, so we accept both.
export const MSP_COMMAND_CODE = 90;
export const OPT_MSP = "\x5A";             // 90
export const MSP_WILL = "\xFF\xFB\x5A";    // IAC WILL MSP - client offers MSP
export const MSP_DO   = "\xFF\xFD\x5A";    // IAC DO MSP   - client/server requests MSP

// MXP (MUD eXtension Protocol) — telnet option 91. Negotiation just gates the
// in-band markup stream: once the option is on, the server may embed HTML-like
// tags (`<B>`, `<COLOR>`, `<SEND>`, `<A>`, `<!ELEMENT>`, entities) and line-mode
// switches (`ESC[#z`) directly in the regular text, which the MxpParser turns
// into styled segments and clickable links. The `IAC SB MXP IAC SE`
// subnegotiation (option 91) carries no payload — it just confirms MXP is on;
// the real protocol is entirely in-band. Reference: https://www.zuggsoft.com/zmud/mxp.htm
export const MXP_COMMAND_CODE = 91;
export const OPT_MXP = "\x5B";             // 91
export const MXP_WILL = "\xFF\xFB\x5B";    // IAC WILL MXP - server offers MXP
export const MXP_DO   = "\xFF\xFD\x5B";    // IAC DO MXP   - client/server requests MXP

// NEW-ENVIRON (RFC 1572) / MNES (Mud New-Environ Standard) — telnet option 39.
// The client owns environment variables, so negotiation is asymmetric: the
// server sends IAC DO NEW-ENVIRON, the client replies IAC WILL NEW-ENVIRON,
// then the server requests variables with `IAC SB NEW-ENVIRON SEND [VAR <name>…]
// IAC SE` and the client answers `IAC SB NEW-ENVIRON IS VAR <name> VALUE <value>
// … IAC SE`. MNES (https://tintin.mudhalla.net/protocols/mnes/) standardises the
// variable set a MUD client reports: CHARSET, CLIENT_NAME, CLIENT_VERSION, MTTS,
// TERMINAL_TYPE. Note the control-byte values overlap by position — the byte
// right after the option code is the command (IS/SEND/INFO), every later marker
// is structural (VAR/VALUE/ESC/USERVAR) — so IS and VAR are both 0, SEND and
// VALUE both 1, INFO and ESC both 2.
export const NEW_ENVIRON_COMMAND_CODE = 39;
export const OPT_NEW_ENVIRON = "\x27";        // 39
export const NEW_ENVIRON_IS   = "\x00";       // 0 — "here ARE my variables"
export const NEW_ENVIRON_SEND = "\x01";       // 1 — "SEND me these variables"
export const NEW_ENVIRON_INFO = "\x02";       // 2 — unsolicited update push
export const NEW_ENVIRON_VAR     = "\x00";    // 0 — standard variable marker
export const NEW_ENVIRON_VALUE   = "\x01";    // 1 — value marker
export const NEW_ENVIRON_ESC     = "\x02";    // 2 — escape next byte (RFC 1572)
export const NEW_ENVIRON_USERVAR = "\x03";    // 3 — user-defined variable marker
export const NEW_ENVIRON_DO   = "\xFF\xFD\x27"; // IAC DO NEW-ENVIRON  - server asks us to report
export const NEW_ENVIRON_WILL = "\xFF\xFB\x27"; // IAC WILL NEW-ENVIRON - we agree to report
export const NEW_ENVIRON_WONT = "\xFF\xFC\x27"; // IAC WONT NEW-ENVIRON - we decline to report (MNES off)

// MTTS (Mud Terminal Type Standard) capability bits, advertised by both the
// TTYPE cycle (as `MTTS <n>`) and MNES (as the MTTS variable). See
// https://tintin.mudhalla.net/protocols/mtts/.
export const MTTS_ANSI = 1;
export const MTTS_VT100 = 2;
export const MTTS_UTF8 = 4;
export const MTTS_256_COLORS = 8;
export const MTTS_MOUSE_TRACKING = 16;
export const MTTS_OSC_COLOR_PALETTE = 32;
export const MTTS_SCREEN_READER = 64;
export const MTTS_PROXY = 128;
export const MTTS_TRUECOLOR = 256;
export const MTTS_MNES = 512;
export const MTTS_MSLP = 1024;
export const MTTS_SSL = 2048;

/** Live capabilities that toggle the dynamic MTTS bits. The static bits (ANSI,
 *  256 colours, OSC colour palette, truecolour) are always on. */
export interface MttsCapabilities {
    /** UTF-8 is the active encoding (sets the UTF-8 bit). */
    utf8?: boolean;
    /** The game-facing transport is TLS-encrypted (sets the SSL bit). */
    tls?: boolean;
    /** MNES is negotiated (sets the MNES bit). */
    mnes?: boolean;
    /** A screen reader is being advertised (sets the SCREEN READER bit). */
    screenReader?: boolean;
}

/**
 * Compose the MTTS bitvector mudix advertises. Mirrors Mudlet's
 * `getNewEnvironMTTS`: ANSI + 256 COLORS + OSC COLOR PALETTE + TRUECOLOR are
 * always present (mudix's static terminal capabilities); UTF-8, SSL/TLS, MNES
 * and SCREEN READER are added from live state. With UTF-8 + TLS this yields
 * 2349, matching a default Mudlet connection.
 */
export function computeMtts(caps: MttsCapabilities = {}): number {
    let bits = MTTS_ANSI | MTTS_256_COLORS | MTTS_OSC_COLOR_PALETTE | MTTS_TRUECOLOR;
    if (caps.utf8) bits |= MTTS_UTF8;
    if (caps.tls) bits |= MTTS_SSL;
    if (caps.mnes) bits |= MTTS_MNES;
    if (caps.screenReader) bits |= MTTS_SCREEN_READER;
    return bits;
}

// NAWS (Negotiate About Window Size, RFC 1073) — telnet option 31. The client
// owns the window, so negotiation is client-driven: the client sends IAC WILL
// NAWS, the server replies IAC DO NAWS, then the client sends
// `IAC SB NAWS <w-hi> <w-lo> <h-hi> <h-lo> IAC SE` (16-bit big-endian columns
// then rows, IAC bytes doubled) and re-sends it whenever the output window
// resizes. We report the main output area's character grid — how many monospace
// columns/rows fit — matching what a terminal would report and what Mudlet
// sends. Servers use it for word-wrap, pagination, and full-screen UIs.
export const NAWS_COMMAND_CODE = 31;
export const OPT_NAWS  = "\x1F";          // 31
export const NAWS_WILL = "\xFF\xFB\x1F";  // IAC WILL NAWS - client offers window size
export const NAWS_DO   = "\xFF\xFD\x1F";  // IAC DO NAWS   - server accepts / requests it
export const NAWS_DONT = "\xFF\xFE\x1F";  // IAC DONT NAWS - server declines it

// CHARSET (RFC 2066) — telnet option 42. Either side advertises CHARSET, the
// other side accepts, then either side may send REQUEST listing IANA charset
// names; the receiver replies ACCEPTED <name> or REJECTED. The chosen encoding
// becomes the byte→char codec for both directions of the session. Modern MUDs
// use this almost exclusively to switch to UTF-8 from the telnet baseline of
// US-ASCII / Latin-1.
export const CHARSET_COMMAND_CODE = 42;
export const OPT_CHARSET = "\x2A";           // 42
export const CHARSET_REQUEST  = "\x01";      // 1 — "here are the charsets I support"
export const CHARSET_ACCEPTED = "\x02";      // 2 — "I'll use this one"
export const CHARSET_REJECTED = "\x03";      // 3 — "none of those work"
export const CHARSET_WILL = "\xFF\xFB\x2A";  // IAC WILL CHARSET
export const CHARSET_DO   = "\xFF\xFD\x2A";  // IAC DO CHARSET
