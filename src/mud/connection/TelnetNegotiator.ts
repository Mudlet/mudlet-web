import type { EventBus } from "../../core/EventBus";
import {
    buildNewEnvironVars,
    computeMtts,
    mnesIsReplies,
    newEnvironIsReply,
    encodeMsdp,
    encodeNaws,
    GMCP_IAC,
    GMCP_SB,
    GMCP_SE,
    MSDP_VAL,
    MSDP_VAR,
    OPT_TTYPE,
    OPT_MSDP as OPT_MSDP_BYTE,
    toByteString,
    TTYPE_IS,
    TTYPE_SEND,
    type MnesVar,
} from "../protocol";
import { fromByteString } from "../protocol/byteString";
import { CLIENT_NAME, CLIENT_VERSION, TERMINAL_TYPE } from "../../version";
import type { MudClientEvents } from "../events";
import { debugMspEnabled, debugTelnetEnabled } from "./telnetDebug";

// Telnet command bytes.
const IAC = 0xFF;
const SE = 0xF0, EOR = 0xEF, AYT = 0xF6, GA = 0xF9, SB = 0xFA, WILL = 0xFB, WONT = 0xFC, DO = 0xFD, DONT = 0xFE;
/** STATUS (RFC 859) subcommands. */
const STATUS_IS = 0, STATUS_SEND = 1;

/** Columns the timestamp gutter takes off the main console when it is shown —
 *  the length of Mudlet's `TBuffer::smTimeStampFormat` ("hh:mm:ss.zzz "). Desktop
 *  takes it off the NAWS width, so a game wraps to what is left beside it. */
export const TIMESTAMP_GUTTER_COLUMNS = 13;

/** Main console wrap column before the profile says otherwise — Mudlet's
 *  `Host::mWrapAt` default (and `PROFILE_DEFAULTS.outputWrapAt`). */
const DEFAULT_WRAP_AT = 100;

// Telnet option bytes the negotiator handles natively (or deliberately leaves
// to a sibling handler). Everything else gets the generic answer, which the
// supported-options registry and STATUS / TIMING-MARK adjust.
const OPT_ECHO = 1, OPT_SGA = 3, OPT_STATUS = 5, OPT_TIMING_MARK = 6, OPT_TTYPE_NUM = 24, OPT_EOR = 25, OPT_NAWS = 31,
    OPT_LINEMODE = 34, OPT_NEW_ENVIRON_NUM = 39, OPT_CHARSET_NUM = 42, OPT_MSDP = 69,
    OPT_MSSP = 70, OPT_MCCP1 = 85, OPT_MCCP2 = 86, OPT_MSP = 90, OPT_MXP = 91,
    OPT_TELNET_102_NUM = 102, OPT_ATCP_NUM = 200, OPT_GMCP = 201;

/** Options the client negotiates natively, each by its own rule below.
 *  Everything else takes the generic answer (see `respondToOtherOption`). */
const HARDCODED = new Set<number>([
    OPT_ECHO, OPT_SGA, OPT_TTYPE_NUM, OPT_EOR, OPT_NAWS, OPT_LINEMODE, OPT_NEW_ENVIRON_NUM,
    OPT_CHARSET_NUM, OPT_MSDP, OPT_MSSP, OPT_MCCP1, OPT_MCCP2, OPT_MSP, OPT_MXP,
    OPT_TELNET_102_NUM, OPT_ATCP_NUM, OPT_GMCP,
]);

/** Options whose subnegotiation payload `cTelnet::processTelnetCommand`
 *  consumes and returns from before raising `sysTelnetEvent` — whether or not
 *  the option is enabled. STATUS, TTYPE and everything else fall through. */
const SB_CONSUMED = new Set<number>([
    OPT_NEW_ENVIRON_NUM, OPT_CHARSET_NUM, OPT_MSDP, OPT_ATCP_NUM, OPT_GMCP,
    OPT_MSSP, OPT_MSP, OPT_MXP, OPT_TELNET_102_NUM,
]);

/** The exact sequence of options a server running KaVir's protocol snippet
 *  offers/requests, in order (`expectedOrderForKaVirHandler`, ctelnet.cpp).
 *  Such a server parses a decimal version out of the TTYPE client-name reply
 *  and silently caps colour support at 16 without one, so matching this order
 *  is Mudlet's cue to switch `versionInTTYPE` on. The whole point of the
 *  fingerprint is that it is *this* list in *this* order — so it is spelled out
 *  here rather than derived from the options we handle. */
const KAVIR_NEGOTIATION_ORDER: readonly number[] = [
    OPT_TTYPE_NUM, OPT_NAWS, OPT_CHARSET_NUM, OPT_MSDP, OPT_MSSP, OPT_ATCP_NUM, OPT_MSP, OPT_MXP,
];

/** Mudlet's name for each option that carries a sysProtocolEnabled /
 *  sysProtocolDisabled pair (`cTelnet::raiseProtocolEvent`). The spelling is
 *  what reaches Lua as the event's second argument, so it is Mudlet's and not
 *  ours: `NEW_ENVIRON` with underscores, `channel102` in lower camel case. */
const PROTOCOL_NAMES: ReadonlyMap<number, string> = new Map([
    [OPT_NAWS, 'NAWS'],
    [OPT_NEW_ENVIRON_NUM, 'NEW_ENVIRON'],
    [OPT_CHARSET_NUM, 'CHARSET'],
    [OPT_MSDP, 'MSDP'],
    [OPT_MSSP, 'MSSP'],
    [OPT_MSP, 'MSP'],
    [OPT_MXP, 'MXP'],
    [OPT_TELNET_102_NUM, 'channel102'],
    [OPT_ATCP_NUM, 'ATCP'],
    [OPT_GMCP, 'GMCP'],
]);

/**
 * In-band MXP line-mode sequence `ESC[<n>z`. Its presence means the server is
 * speaking MXP even if it skipped the telnet option-91 handshake.
 *
 * Exactly one digit, and only the eight modes MXP defines: 0 open, 1 secure,
 * 2 locked, 3 reset, 4 temp secure, 5 lock open, 6 lock secure, 7 lock locked
 * (cTelnet::containsMxpModeSwitch). A number MXP does not define is some other
 * escape sequence that happens to end in `z`, and turning MXP on for the rest
 * of the connection off the back of one is not something a WONT can be relied
 * on to undo. Non-global so `.test()` stays stateless.
 */
const MXP_LINE_MODE_RE = /\x1b\[[0-7]z/;

export interface TelnetNegotiatorFlags {
    gmcpEnabled: boolean;
    mttsEnabled: boolean;
    msdpEnabled: boolean;
    msspEnabled: boolean;
    charsetEnabled: boolean;
    mspEnabled: boolean;
    mxpEnabled: boolean;
    mnesEnabled: boolean;
    newEnvironEnabled: boolean;
    nawsEnabled: boolean;
    /** Whether to advertise screen-reader use (MTTS SCREEN READER bit,
     *  NEW-ENVIRON SCREEN_READER var) — Mudlet's `advertiseScreenReader` config
     *  key. Default false; some MUDs adjust their output (e.g. suppress ASCII
     *  art, add extra room-description detail) when this is set. */
    screenReaderAdvertised: boolean;
    /** Whether OSC 8 hyperlinks are enabled for this profile — Mudlet 5.0's
     *  `mEnableOSC8Hyperlinks`. Drives only the `OSC_HYPERLINKS_*` NEW-ENVIRON
     *  capability block here; the rendering side of the same toggle is a gate in
     *  the ANSI parser (see hyperlinkConfig's setOsc8HyperlinksEnabled). Default
     *  true, matching Mudlet. */
    osc8HyperlinksEnabled: boolean;
    /** Whether the first TTYPE cycle value carries our version after the client
     *  name — Mudlet's `versionInTTYPE` config key (`mVersionInTTYPE`). Default
     *  false: RFC 1091 doesn't permit the period, so Mudlet stopped sending it
     *  in 2024. Servers running KaVir's protocol snippet want it anyway (without
     *  a version they assume 1.0 and cap colour support at 16), which is what
     *  the KaVir auto-detect below turns it on for. */
    versionInTTYPE: boolean;
    /** Whether this profile has already been through the KaVir auto-detect —
     *  Mudlet's `promptForVersionInTTYPE` config key (`mPromptedForVersionInTTYPE`).
     *  When true the detector below is disabled, so a user who turned
     *  `versionInTTYPE` back off is not overridden on every reconnect. */
    versionInTTYPEPrompted: boolean;
    /** Whether an in-band `ESC[<n>z` may still auto-start MXP on a server that
     *  never negotiated telnet option 91. Mudlet gates its equivalent scan on
     *  `mForceMXPProcessorOn || !mPromptedForMXPProcessorOn`
     *  (`cTelnet::gotRest`): once the auto-detect has fired for a profile, only
     *  the forced-on state keeps it live — so a user who then turns
     *  `specialForceMXPProcessorOn` off is not re-overridden every connect. */
    mxpInBandDetectionEnabled: boolean;
}

export interface TelnetNegotiatorHooks {
    sendRaw(data: string): void;
    /** The server offered GMCP (IAC WILL GMCP) — send the Core.Hello /
     *  Core.Supports.Set handshake. Mudlet answers every offer with it,
     *  re-offers included — a server that switched GMCP off and on again has
     *  forgotten our modules. Not called for a server's IAC DO GMCP: Mudlet
     *  answers that with WILL alone and announces nothing until the server's
     *  own WILL (mudlet-web#362). */
    onGmcpNegotiated(): void;
    /** Current inbound encoding (IANA label) — drives the MTTS UTF-8 bit and
     *  the MNES/NEW-ENVIRON CHARSET variable. */
    getEncoding(): string;
    /** Whether MCCP may be taken up — false under `specialForceCompressionOff`.
     *  The server's offer is otherwise MccpHandler's to accept; this only lets
     *  the negotiator turn it down while that handler stands aside. */
    isMccpEnabled(): boolean;
    /** The server's option-negotiation order matched KaVir's protocol snippet —
     *  it wants a version in our TTYPE reply. Fired at most once per connection;
     *  the owner turns `versionInTTYPE` on and redials. */
    onKaVirProtocolDetected(): void;
}

/**
 * Telnet option negotiation for a MUD session. Owns the WILL/WONT/DO/DONT
 * response policy, the per-session negotiation latches (TTYPE cycle position,
 * MXP started, NAWS accepted), the Mudlet `addSupportedTelnetOption` registry,
 * and the `telnet.event` (sysTelnetEvent) surface raised for every command.
 *
 * `processFrame` makes a single position-aware walk over each incoming frame's
 * IAC sequences — skipping subnegotiation payloads and escaped `IAC IAC` bytes
 * so data bytes can't be mistaken for negotiation commands — and buffers a
 * trailing incomplete sequence for the next frame. Subnegotiation *bodies*
 * (SB … SE payloads) are not parsed here; they arrive via the handleXxxSubneg
 * methods, routed by MudClient's option parser.
 */
export class TelnetNegotiator {
    /** Mudlet `addSupportedTelnetOption(option)` registry. On IAC WILL <opt>
     *  we reply IAC DO <opt>; on IAC DO <opt> we reply IAC WILL <opt>. Options
     *  negotiated natively (GMCP/MSDP/TTYPE/…) are excluded — they have their
     *  own response logic. Survives reconnects (matches the old client-field
     *  lifetime: the registry lives as long as the client instance). */
    private readonly supportedTelnetOptions = new Set<number>();
    /** Trailing bytes of a frame that might be the start of a split IAC
     *  sequence (a bare IAC, IAC WILL with no option byte yet, or an IAC SB
     *  whose IAC SE hasn't arrived) — prepended to the next frame so
     *  negotiation commands split across WebSocket frames aren't missed. */
    private carry = "";
    /** MTTS cycle position — Mudlet's `mCycleCountMTTS`. The server issues SB
     *  TTYPE SEND repeatedly; we walk through client name (0), terminal type
     *  (1), the MTTS bitvector (2) and the bitvector again (3), then start over.
     *  Reset on each connect(). */
    private ttypeStep = 0;
    /** Latches true once MXP has started for this session — via telnet option 91
     *  negotiation OR by detecting an in-band MXP line-mode sequence (`ESC[<n>z`).
     *  Many MUDs enable MXP server-side and just start streaming tags without the
     *  telnet handshake, so the in-band signal is the reliable trigger. Reset on
     *  each connect(). */
    private mxpStarted = false;
    /** Rolling window of the last {@link KAVIR_NEGOTIATION_ORDER}`.length`
     *  options the server sent us a WILL/DO for, oldest first — Mudlet's
     *  `mNegotiationOrder`. Compared against the KaVir fingerprint after each
     *  push. Reset on each connect(). */
    private negotiationOrder: number[] = [];
    /** Latches once the KaVir fingerprint has matched this connection, so the
     *  detector fires the hook at most once even though a server may keep
     *  re-offering options. */
    private kaVirDetected = false;
    /** True once the server has accepted NAWS (IAC DO NAWS). Gates whether a
     *  window-size change is pushed to the server. */
    private nawsNegotiated = false;
    /** True once MSP has actually been negotiated (either direction) this
     *  connection. Mirrors Mudlet's `ctelnet::enableMSP` — the profile config
     *  only decides whether we're willing to negotiate; this records that we
     *  did. See {@link isMspNegotiated}. */
    private mspNegotiated = false;
    /** Latest known main output window size in character columns × rows, fed in
     *  by the session's resize observer via setWindowSize() — Mudlet's
     *  `mScreenWidth` × `mScreenHeight`. Null until the UI has measured the grid
     *  at least once. Deliberately NOT cleared by reset() so a reconnect keeps
     *  reporting the current grid. */
    private windowSize: { cols: number; rows: number } | null = null;
    /** The main console's wrap column — Mudlet's `Host::mWrapAt`; 0 means
     *  wrapping is off. Caps the NAWS width and is reported as WORD_WRAP.
     *  Survives reset() like the window size. */
    private wrapAt = DEFAULT_WRAP_AT;
    /** Whether the main console draws its timestamp gutter, which desktop takes
     *  off the NAWS width. */
    private timestampsShown = false;
    /** The NAWS width × height last sent this connection — Mudlet's `mNaws_x` /
     *  `mNaws_y` — so a change that leaves the reported size alone sends nothing.
     *  Null until the first report; cleared by reset() and by each DO NAWS. */
    private lastNaws: { width: number; height: number } | null = null;
    /** Latches true once the server has asked us to suppress go-ahead (IAC WILL
     *  SGA). Mudlet Web refuses SGA (line mode only), but records the request:
     *  combined with active server echo it's the character-at-a-time signature
     *  the owner uses to raise `sysCharacterModeDetected`. Reset on connect(). */
    private serverRequestedSGA = false;

    /** Option bytes currently negotiated on, for the protocols that carry a
     *  sysProtocolEnabled / sysProtocolDisabled pair. Mudlet keeps one bool per
     *  protocol (enableGMCP, enableMSSP, …) and reads it to decide whether
     *  turning an offer down is news; this is that set. Cleared by reset() with
     *  the rest of the per-connection latches.
     *  @see PROTOCOL_NAMES */
    private readonly enabledProtocols = new Set<number>();

    /** Mudlet's four per-option bitsets (`cTelnet::sendTelnetOption` keeps
     *  them), which decide whether a WONT/DONT or a repeated offer is answered:
     *  `hisOn` — we sent DO; `heAnnounced` — the server has sent WILL or WONT;
     *  `myOn` — we sent WILL; `announced` — we have sent WILL or WONT. Cleared by
     *  reset(). */
    private readonly hisOn = new Set<number>();
    private readonly heAnnounced = new Set<number>();
    private readonly myOn = new Set<number>();
    private readonly announced = new Set<number>();

    constructor(
        private readonly flags: TelnetNegotiatorFlags,
        private readonly eventBus: EventBus<MudClientEvents>,
        private readonly hooks: TelnetNegotiatorHooks,
    ) {}

    /** Clear the per-connection latches (call on connect). */
    reset(): void {
        this.carry = "";
        this.ttypeStep = 0;
        this.mxpStarted = false;
        this.nawsNegotiated = false;
        this.lastNaws = null;
        this.mspNegotiated = false;
        this.serverRequestedSGA = false;
        this.negotiationOrder = [];
        this.kaVirDetected = false;
        this.enabledProtocols.clear();
        this.hisOn.clear();
        this.heAnnounced.clear();
        this.myOn.clear();
        this.announced.clear();
    }

    /** Whether MSP was actually negotiated with the server this connection —
     *  Mudlet's `ctelnet::enableMSP`, distinct from the profile's `enableMSP`
     *  config (which only decides whether we agree to negotiate at all). Gates
     *  `receiveMSP`, which Mudlet refuses unless the option is live. */
    isMspNegotiated(): boolean {
        return this.mspNegotiated;
    }

    /** Whether GMCP (option 201) is live — Mudlet's `isGMCPEnabled()`, which
     *  `sendGMCP` refuses without: nothing goes to a server that has not taken
     *  the option up. */
    isGmcpEnabled(): boolean {
        return this.enabledProtocols.has(OPT_GMCP);
    }

    /** Whether ATCP (option 200) is live — Mudlet's `isATCPEnabled()`, the
     *  gate `sendATCP` refuses without, as `sendGMCP` does for GMCP. */
    isAtcpEnabled(): boolean {
        return this.enabledProtocols.has(OPT_ATCP_NUM);
    }

    /** Whether CHARSET (option 42) is live — Mudlet's `enableCHARSET`. A
     *  REQUEST subnegotiation is read only while it is, so a server that has
     *  withdrawn the option cannot go on changing the encoding. */
    isCharsetNegotiated(): boolean {
        return this.enabledProtocols.has(OPT_CHARSET_NUM);
    }

    /** Whether the server has taken zMUD channel 102 up this connection —
     *  Mudlet's `isChannel102Enabled()`. It is the only gate on
     *  `sendTelnetChannel102`: Mudlet frames and writes the subnegotiation
     *  whether or not a socket is still there and answers true either way, so
     *  a caller is told about the option rather than about the connection. */
    isChannel102Enabled(): boolean {
        return this.enabledProtocols.has(OPT_TELNET_102_NUM);
    }

    /** Whether we have agreed to the server's side of `opt` (sent it DO) and
     *  not since turned it off — Mudlet's `hisOptionState`. */
    isServerOptionOn(opt: number): boolean {
        return this.hisOn.has(opt);
    }

    /** Drop the negotiated-MSP latch without resetting the rest of the
     *  negotiation state — used on disconnect, where the option dies with the
     *  connection but reset() isn't otherwise run. */
    clearMspNegotiated(): void {
        this.mspNegotiated = false;
    }

    /** Whether the server has asked us to suppress go-ahead this connection
     *  (IAC WILL SGA). We refuse SGA, but the owner combines this with the
     *  echo state to detect character-at-a-time mode. */
    get sgaRequested(): boolean {
        return this.serverRequestedSGA;
    }

    /** Mudlet `addSupportedTelnetOption(option)`. Marks the telnet option byte
     *  (0..255) as one the client will accept: on the next IAC WILL <opt> we
     *  reply IAC DO <opt>; on IAC DO <opt> we reply IAC WILL <opt>. Natively
     *  negotiated options (GMCP=201, MSDP=69, TTYPE=24, …) don't need to be
     *  registered. Returns true if the option was newly added, false if it was
     *  already present. */
    addSupportedTelnetOption(option: number): boolean {
        if (!Number.isFinite(option)) return false;
        const opt = Math.trunc(option) & 0xff;
        if (this.supportedTelnetOptions.has(opt)) return false;
        this.supportedTelnetOptions.add(opt);
        return true;
    }

    /** Record the main output window's character grid (columns × rows) for NAWS.
     *  The value is stored regardless of negotiation state (so a client created
     *  on a later connect can be seeded with the current size); it's only sent
     *  to the server once NAWS has been negotiated, and only when the size it
     *  reports changed. */
    setWindowSize(cols: number, rows: number): void {
        this.windowSize = { cols: Math.max(0, Math.trunc(cols)), rows: Math.max(0, Math.trunc(rows)) };
        this.sendCurrentNaws();
    }

    /** Record the main console's wrap column (Mudlet's `Host::mWrapAt`; 0 for
     *  off). It caps the NAWS width, so a change re-reports the size the way
     *  desktop's `setWindowWrap("main", n)` does. */
    setWrapAt(wrapAt: number): void {
        this.wrapAt = Number.isFinite(wrapAt) ? Math.max(0, Math.trunc(wrapAt)) : DEFAULT_WRAP_AT;
        this.sendCurrentNaws();
    }

    /** Record whether the main console draws its timestamp gutter, which
     *  desktop takes off the NAWS width. */
    setTimestampsShown(shown: boolean): void {
        this.timestampsShown = shown;
        this.sendCurrentNaws();
    }

    /** Note option commands a sibling handler (EchoHandler, MccpHandler) put on
     *  the wire itself, so the option bitsets — and with them the STATUS reply
     *  and the repeat-offer checks — know about them, as Mudlet's single
     *  `sendTelnetOption` does. `data` is what was sent. */
    noteOptionsSent(data: string): void {
        for (let i = 0; i + 2 < data.length; i++) {
            if (data.charCodeAt(i) !== IAC) continue;
            const cmd = data.charCodeAt(i + 1);
            if (cmd === IAC) { i++; continue; }
            if (cmd < WILL || cmd > DONT) continue;
            this.trackOption(cmd, data.charCodeAt(i + 2));
            i += 2;
        }
    }

    /** Walk one incoming frame (post-MCCP Latin-1 byte-string) for telnet IAC
     *  sequences: answer WILL/WONT/DO/DONT per the option policy, raise
     *  `telnet.event` for every command but GA/EOR and consumed SBs (as Mudlet's
     *  `processTelnetCommand` does), and watch for in-band MXP line-mode
     *  sequences on servers that skip the option-91 handshake. */
    processFrame(data: string): void {
        const buf = this.carry + data;
        this.carry = "";
        const n = buf.length;
        let i = 0;
        while (i < n) {
            if (buf.charCodeAt(i) !== IAC) { i++; continue; }
            if (i + 1 >= n) { this.carry = buf.slice(i); break; } // split IAC — wait for the rest
            const cmd = buf.charCodeAt(i + 1);
            if (cmd === IAC) { i += 2; continue; } // escaped data byte, not a command
            if (cmd === SB) {
                // Skip the subnegotiation payload so its data bytes can't be
                // mistaken for negotiation commands; the body itself is parsed
                // downstream by the option parser. An SB without its closing
                // IAC SE is buffered for the next frame.
                let end = -1;
                let j = i + 2;
                while (j < n - 1) {
                    if (buf.charCodeAt(j) === IAC) {
                        if (buf.charCodeAt(j + 1) === SE) { end = j; break; }
                        j += 2; // escaped IAC (or stray command) inside the payload
                    } else {
                        j++;
                    }
                }
                if (end === -1) { this.carry = buf.slice(i); break; }
                // STATUS SEND (RFC 859): exactly `IAC SB STATUS SEND IAC SE`,
                // the only form Mudlet answers. Its subnegotiation is not one
                // the option parser routes, so it is answered here.
                if (end === i + 4 && buf.charCodeAt(i + 2) === OPT_STATUS && buf.charCodeAt(i + 3) === STATUS_SEND) {
                    this.sendStatusIs();
                }
                // Mudlet returns from its SB branch before the sysTelnetEvent
                // tail for every option it consumes itself; only STATUS, TTYPE
                // and options it doesn't handle reach Lua.
                if (!(i + 2 < end && SB_CONSUMED.has(buf.charCodeAt(i + 2)))) {
                    this.emitTelnetEvent(buf.slice(i, end + 2));
                }
                i = end + 2;
                continue;
            }
            if (cmd >= WILL && cmd <= DONT) {
                if (i + 2 >= n) { this.carry = buf.slice(i); break; } // split negotiation — wait
                this.handleNegotiationCommand(cmd, buf.charCodeAt(i + 2));
                this.emitTelnetEvent(buf.slice(i, i + 3));
                i += 3;
                continue;
            }
            // Are You There (RFC 854): Mudlet answers with a bare "YES", raw
            // bytes outside any encoding, and still raises the event below.
            if (cmd === AYT) this.hooks.sendRaw("YES");
            // 2-byte command (NOP, AYT, …) — nothing to negotiate. A stray SE
            // with no SB before it is dropped by Mudlet without an event.
            if (cmd !== SE) this.emitTelnetEvent(buf.slice(i, i + 2));
            i += 2;
        }

        if (this.flags.mxpEnabled && this.flags.mxpInBandDetectionEnabled
            && !this.mxpStarted && MXP_LINE_MODE_RE.test(buf)) {
            // No telnet handshake, but the server is emitting MXP line-mode
            // sequences (ESC[<n>z) — it's speaking MXP. Turn parsing on now,
            // before this frame's text is rendered, so the very lines carrying
            // the markup get parsed. `z` is not a standard ANSI CSI final, so
            // this signal is MXP-specific. viaTelnet=false: we don't send
            // handshake replies because the server's inbound MXP channel isn't
            // confirmed.
            this.startMxp(false);
        }
    }

    /** One WILL/WONT/DO/DONT for `opt`. Natively-handled options follow their
     *  own rules; everything else gets Mudlet's generic answer. Every
     *  occurrence is answered on its merits — no per-frame dedupe — so a
     *  server that turns an option off and on again within one packet is
     *  answered for each step, as Mudlet does. */
    private handleNegotiationCommand(cmd: number, opt: number): void {
        this.trackKaVirNegotiation(cmd, opt);
        if (cmd === WILL) this.heAnnounced.add(opt);
        if (HARDCODED.has(opt)) {
            this.respondToKnownOption(cmd, opt);
            return;
        }
        this.respondToOtherOption(cmd, opt);
    }

    /** Send `IAC <cmd> <opt>` and keep the four option bitsets in step, as
     *  Mudlet's `cTelnet::sendTelnetOption` does. */
    private sendOption(cmd: number, opt: number): void {
        this.trackOption(cmd, opt);
        this.hooks.sendRaw(String.fromCharCode(IAC, cmd, opt));
    }

    private trackOption(cmd: number, opt: number): void {
        switch (cmd) {
            case WILL: this.announced.add(opt); this.myOn.add(opt); break;
            case WONT: this.announced.add(opt); this.myOn.delete(opt); break;
            case DO: this.hisOn.add(opt); break;
            case DONT: this.hisOn.delete(opt); break;
        }
    }

    /** Mudlet's reply to STATUS SEND: `IAC SB STATUS IS`, then `WILL <opt>`
     *  for every option we have on and `DO <opt>` for every one we asked the
     *  server to have on, in option order, then `IAC SE`. Sent whether or not
     *  STATUS itself was negotiated, as desktop does. RFC 859 exempts the list
     *  from IAC escaping except for an option byte equal to SE (240), which is
     *  doubled. */
    private sendStatusIs(): void {
        let out = String.fromCharCode(IAC, SB, OPT_STATUS, STATUS_IS);
        for (let opt = 0; opt < 256; opt++) {
            const dup = opt === SE ? String.fromCharCode(opt) : "";
            if (this.myOn.has(opt)) out += String.fromCharCode(WILL, opt) + dup;
            if (this.hisOn.has(opt)) out += String.fromCharCode(DO, opt) + dup;
        }
        this.hooks.sendRaw(out + String.fromCharCode(IAC, SE));
    }

    /** The answer every option gets once nothing specific to it applies —
     *  Mudlet's fall-through branches in `processTelnetCommand`:
     *   - WILL: DO for STATUS, TERMINAL-TYPE and anything registered with
     *     `addSupportedTelnetOption`, DONT for the rest — unless we already
     *     sent DO, in which case the offer is only a repeat.
     *   - DO: WONT to TIMING-MARK always; otherwise, unless we already said
     *     WILL, WILL for STATUS, TERMINAL-TYPE and registered options, WONT
     *     for the rest.
     *   - WONT: DONT when we had it on or the server had announced it before
     *     (RFC 854's acknowledgement), silence for a first unprompted WONT.
     *   - DONT: WONT when we had it on or have never said anything about it.
     *  Silence to an offer is what leaves a strict server waiting. */
    private respondToOtherOption(cmd: number, opt: number): void {
        const accepted = opt === OPT_STATUS || opt === OPT_TTYPE_NUM || this.supportedTelnetOptions.has(opt);
        switch (cmd) {
            case WILL:
                if (!this.hisOn.has(opt)) this.sendOption(accepted ? DO : DONT, opt);
                return;
            case DO:
                if (opt === OPT_TIMING_MARK) this.sendOption(WONT, opt);
                else if (!this.myOn.has(opt)) this.sendOption(accepted ? WILL : WONT, opt);
                return;
            case WONT:
                if (this.hisOn.has(opt) || this.heAnnounced.has(opt)) this.sendOption(DONT, opt);
                this.heAnnounced.add(opt);
                return;
            case DONT:
                if (this.myOn.has(opt) || !this.announced.has(opt)) this.sendOption(WONT, opt);
                this.announced.add(opt);
                this.myOn.delete(opt);
                return;
        }
    }

    /** Mudlet `cTelnet::trackKaVirNegotiation`. Records the option of each
     *  inbound WILL/DO in a rolling window and fires the hook the first time the
     *  window equals the KaVir fingerprint. Recording happens before the
     *  per-frame response dedupe, so the order seen here is the order the server
     *  actually sent — the same thing Mudlet feeds its own tracker from
     *  `processTelnetCommand`. */
    private trackKaVirNegotiation(cmd: number, opt: number): void {
        if (this.kaVirDetected || this.flags.versionInTTYPEPrompted) return;
        if (cmd !== WILL && cmd !== DO) return;
        this.negotiationOrder.push(opt);
        if (this.negotiationOrder.length > KAVIR_NEGOTIATION_ORDER.length) {
            this.negotiationOrder.shift();
        }
        if (this.negotiationOrder.length !== KAVIR_NEGOTIATION_ORDER.length) return;
        if (!this.negotiationOrder.every((o, i) => o === KAVIR_NEGOTIATION_ORDER[i])) return;
        this.kaVirDetected = true;
        this.hooks.onKaVirProtocolDetected();
    }

    private respondToKnownOption(cmd: number, opt: number): void {
        const f = this.flags;
        // The server withdrawing an option is the same act for every protocol:
        // clear whatever state rode on it, then announce the loss. Mudlet raises
        // sysProtocolDisabled here whether or not the protocol was on (only a
        // WONT/DONT answering a request of our own is quiet), so this does too.
        if (cmd === WONT || cmd === DONT) {
            switch (opt) {
                case OPT_NAWS: this.nawsNegotiated = false; break;
                case OPT_MSP:
                    // The server can withdraw MSP mid-session; Mudlet clears its
                    // enableMSP here too, so the latch must be able to go false
                    // without waiting for a disconnect.
                    this.mspNegotiated = false;
                    if (debugMspEnabled()) console.debug('[mudlet.msp] server withdrew MSP');
                    break;
                case OPT_MXP:
                    // Mudlet stops the processor unless the profile forces it on;
                    // that call belongs to the owner (it holds the forced-on
                    // flag), so this only clears the latch that would otherwise
                    // refuse a later restart.
                    this.mxpStarted = false;
                    break;
            }
            if (PROTOCOL_NAMES.has(opt)) this.withdrawProtocol(opt);
            // Then acknowledge it like any other option. WONT ECHO is the one
            // exception: EchoHandler answers it, with the anomaly guard.
            if (!(cmd === WONT && opt === OPT_ECHO)) this.respondToOtherOption(cmd, opt);
            return;
        }
        switch (opt) {
            case OPT_MCCP1:
            case OPT_MCCP2:
                // With compression forced off (`specialForceCompressionOff`)
                // MccpHandler stands aside, and the offer is turned down here —
                // either version, as Mudlet's mFORCE_NO_COMPRESSION branch does,
                // and only while it is not already on, as for any WILL.
                if (cmd === WILL && !this.hooks.isMccpEnabled()) {
                    if (!this.hisOn.has(opt)) this.sendOption(DONT, opt);
                    return;
                }
                // Otherwise as for ECHO below.
                if (cmd === DO) this.respondToOtherOption(cmd, opt);
                return;
            case OPT_ECHO:
                // The server's WILL is negotiated by EchoHandler / MccpHandler,
                // which see the same frame independently. A DO asks us to echo
                // or compress, which we don't: refused like any other option.
                if (cmd === DO) this.respondToOtherOption(cmd, opt);
                return;
            case OPT_SGA:
                // Server offers Suppress-Go-Ahead (IAC WILL SGA, option 3) →
                // we REFUSE it (IAC DONT SGA), matching Mudlet: Mudlet Web operates
                // in line mode only. A DONT is still a definitive answer, so
                // strict servers don't stall; and refusing keeps `IAC GA`
                // un-suppressed, which Mudlet Web's prompt detection relies on.
                // We record the request — SGA plus active server echo is the
                // character-at-a-time signature the owner watches for.
                if (cmd === WILL) {
                    this.sendOption(DONT, opt);
                    this.serverRequestedSGA = true;
                    this.eventBus.emit('protocol.rejected', 'SUPPRESS_GO_AHEAD');
                } else {
                    // Asked to suppress go-ahead ourselves: nothing we send
                    // uses GA, so this is refused like any other option.
                    this.respondToOtherOption(cmd, opt);
                }
                return;
            case OPT_LINEMODE:
                // LINEMODE (RFC 1184, option 34) would hand line editing /
                // forwarding policy to the server. Mudlet Web does its own local
                // line editing and never delegates it, so — like Mudlet — we
                // refuse in both directions: DONT to the server's WILL, WONT
                // to its DO.
                this.sendOption(cmd === WILL ? DONT : WONT, opt);
                this.eventBus.emit('protocol.rejected', 'LINEMODE');
                return;
            case OPT_EOR:
                // Server announces it will mark prompts with IAC EOR (telnet
                // option 25, IAC WILL EOR) → we accept (IAC DO EOR). The EOR
                // markers then drive prompt detection the same way IAC GA does.
                // Many Diku/Circle-derived servers (e.g. The Last Outpost) won't
                // send the login prompt until this option is acknowledged.
                if (cmd === WILL) this.sendOption(DO, opt);
                else this.respondToOtherOption(cmd, opt);
                return;
            case OPT_TTYPE_NUM:
                // Server asks us to identify our terminal (IAC DO TTYPE).
                // Agree (IAC WILL TTYPE); the actual name/type/MTTS values
                // follow via the SB TTYPE SEND subnegotiation handled in
                // handleTtypeSubneg(). Many MUDs (e.g. Kallisti) won't offer
                // MSDP/GMCP until this handshake completes. Agreed whether or
                // not MTTS is on: that toggle only trims the SEND cycle below,
                // and silence left the server unable to identify us (#188).
                // The server offering its own terminal type (WILL) is taken up
                // by the generic answer, as in Mudlet.
                // Only while it is off: a repeated DO TTYPE goes unanswered,
                // as desktop's `!myOptionState` guard leaves it (#379).
                if (cmd === DO) {
                    if (!this.myOn.has(opt)) this.sendOption(WILL, opt);
                } else {
                    this.respondToOtherOption(cmd, opt);
                }
                return;
            case OPT_NAWS: {
                // The refusal here is announced whether or not NAWS was on —
                // Mudlet raises sysProtocolDisabled from its "user preference"
                // branch unconditionally, so a script waiting on window-size
                // reporting learns the profile turned the offer down. NAWS is
                // ours to report, so a server's WILL NAWS takes the generic
                // refusal.
                if (cmd !== DO) {
                    this.respondToOtherOption(cmd, opt);
                    return;
                }
                // The server asked for NAWS → start reporting window size.
                // Mudlet never offers it unprompted: it waits for this DO, then
                // answers WILL, pushes the current dimensions, and re-sends them
                // on every resize. A DO for NAWS we already have on is not
                // answered at all — not even with WONT when the profile has
                // since switched NAWS off (mudlet-web#379): desktop only
                // answers an option that is currently off.
                const firstAccept = !this.myOn.has(OPT_NAWS);
                if (firstAccept) {
                    if (!f.nawsEnabled) {
                        this.sendOption(WONT, opt);
                        this.nawsNegotiated = false;
                        this.enabledProtocols.delete(OPT_NAWS);
                        this.eventBus.emit('protocol.disabled', 'NAWS');
                        return;
                    }
                    this.sendOption(WILL, OPT_NAWS);
                    this.nawsNegotiated = true;
                    this.enabledProtocols.add(OPT_NAWS);
                    this.eventBus.emit('protocol.enabled', 'NAWS');
                }
                // The game asked for the size now: forget what was last sent
                // so it is answered even if unchanged (Mudlet zeroes mNaws_x/y).
                this.lastNaws = null;
                this.sendCurrentNaws();
                if (firstAccept) this.eventBus.emit('naws.negotiated');
                return;
            }
            case OPT_NEW_ENVIRON_NUM:
                // NEW-ENVIRON is asymmetric — the client owns the variables —
                // so only the DO direction starts the MNES exchange. A WILL is
                // still answered by the same toggle, as Mudlet does, so a
                // server offering it isn't left waiting. MNES and plain
                // NEW-ENVIRON share telnet option 39 and differ only in the
                // variable set reported (handled in handleNewEnvironSubneg).
                // Whether the option is answered at all is the NEW-ENVIRON
                // toggle's alone (`mEnableNEWENVIRON` in cTelnet): MNES only
                // narrows the reply, so with NEW-ENVIRON off a DO is refused
                // even when MNES is on, as desktop does.
                if (cmd !== DO) {
                    if (f.newEnvironEnabled) this.enableProtocol(cmd, opt);
                    else this.refuseProtocol(cmd, opt);
                    return;
                }
                if (f.newEnvironEnabled) {
                    this.enableProtocol(cmd, opt);
                    this.eventBus.emit('mnes.negotiated', f.mnesEnabled ? 'MNES' : 'NEW-ENVIRON');
                } else {
                    // Both disabled → explicitly decline (IAC WONT NEW-ENVIRON).
                    // A bare DO with no WILL/WONT answer leaves strict servers
                    // waiting on the option before they continue (e.g. before
                    // sending the login prompt), so silence is not an option here.
                    this.refuseProtocol(cmd, opt);
                }
                return;
            case OPT_CHARSET_NUM:
                // Accept CHARSET from either direction and wait for the
                // server's REQUEST, which CharsetHandler answers. Mudlet never
                // sends a REQUEST of its own ("Mudlet does not initiate
                // negotiations yet", ctelnet.cpp), and one crossing the
                // server's is a collision RFC 2066 makes the client lose.
                if (!f.charsetEnabled) {
                    this.refuseProtocol(cmd, opt);
                    return;
                }
                this.enableProtocol(cmd, opt);
                return;
            case OPT_MSDP:
                // Telnet negotiation is symmetric and many servers (e.g.
                // Legends of Kallisti) start MSDP with IAC DO MSDP; without the
                // DO branch we'd never reply and never fire msdp.negotiated.
                if (!f.msdpEnabled) {
                    this.refuseProtocol(cmd, opt);
                    return;
                }
                // A server's offer is answered, after the DO, with the MSDP
                // start sequence Mudlet sends: ask for the command list, then
                // report our name and version. A server's DO gets only WILL.
                this.enableProtocol(cmd, opt, cmd === WILL ? () => this.sendMsdpHello() : undefined);
                this.eventBus.emit('msdp.negotiated');
                return;
            case OPT_MSSP:
                // Server offers MSSP → accept; it then sends its status fields
                // in a single SB MSSP … SE subnegotiation handled by msspStream.
                if (!f.msspEnabled) {
                    this.refuseProtocol(cmd, opt);
                    return;
                }
                this.enableProtocol(cmd, opt);
                this.eventBus.emit('mssp.negotiated');
                return;
            case OPT_MSP:
                // In practice most MUDs just inline `!!SOUND(...)` tags without
                // ever negotiating, so this is rarely hit; when it is, we want
                // the option enabled so subnegotiated tags route through the
                // MSP parser.
                if (!f.mspEnabled) {
                    this.refuseProtocol(cmd, opt);
                    return;
                }
                this.enableProtocol(cmd, opt);
                this.mspNegotiated = true;
                this.eventBus.emit('msp.negotiated');
                if (debugMspEnabled()) {
                    console.debug(cmd === WILL
                        ? '[mudlet.msp] negotiated: server WILL → client DO'
                        : '[mudlet.msp] negotiated: server DO → client WILL');
                }
                return;
            case OPT_MXP:
                // From here the server embeds in-band MXP markup; the scripting
                // engine parses it once it sees mxp.negotiated. Symmetric —
                // many servers (e.g. Aardwolf) start MXP with IAC DO MXP.
                if (!f.mxpEnabled) {
                    this.refuseProtocol(cmd, opt);
                    return;
                }
                this.enableProtocol(cmd, opt);
                this.startMxp(true);
                return;
            case OPT_TELNET_102_NUM:
                // zMUD's generic out-of-band channel. Mudlet takes it up from
                // either direction and has no profile toggle to consult — there
                // is no "enable channel 102" setting.
                this.enableProtocol(cmd, opt);
                return;
            case OPT_ATCP_NUM:
                // ATCP is the protocol GMCP replaced, so Mudlet takes it up —
                // from either direction — only while the profile has GMCP
                // switched off, and turns it down (taking down an ATCP still up)
                // once GMCP is back on. A server's offer is answered, after the
                // DO, with the ATCP hello naming the client.
                if (f.gmcpEnabled) {
                    this.refuseProtocol(cmd, opt);
                    return;
                }
                this.enableProtocol(cmd, opt, cmd === WILL ? () => this.sendAtcpHello() : undefined);
                return;
            case OPT_GMCP:
                // Server offers (WILL) or requests (DO) GMCP; either way we
                // agree, but only an offer is answered with the Core.Hello
                // handshake (see onGmcpNegotiated) — Mudlet's ctelnet.cpp sends
                // nothing on DO until the server's WILL arrives. The handshake goes out
                // *before* sysProtocolEnabled is raised, as in Mudlet's
                // ctelnet.cpp: Core.Supports.Set replaces the server's whole
                // module list, so a `Core.Supports.Add` a script sends from its
                // sysProtocolEnabled handler must follow it or it is wiped.
                if (!f.gmcpEnabled) {
                    this.refuseProtocol(cmd, opt);
                    return;
                }
                this.enableProtocol(cmd, opt, cmd === WILL ? () => this.hooks.onGmcpNegotiated() : undefined);
                this.eventBus.emit('gmcp.negotiated');
                return;
        }
    }

    /** Take the option up: answer the server, latch it on and announce it as
     *  Mudlet's `sysProtocolEnabled`. Raised on every acceptance rather than
     *  only the first, matching `raiseProtocolEvent` — a server that re-offers
     *  mid-session re-announces. `beforeAnnounce` runs after the agreement is
     *  on the wire but before the event, for handshakes that must precede
     *  anything a script sends in response. */
    private enableProtocol(cmd: number, opt: number, beforeAnnounce?: () => void): void {
        this.sendOption(cmd === WILL ? DO : WILL, opt);
        this.enabledProtocols.add(opt);
        beforeAnnounce?.();
        this.eventBus.emit('protocol.enabled', PROTOCOL_NAMES.get(opt) ?? String(opt));
    }

    /** Turn an offer down because the profile has that protocol switched off.
     *  The refusal is announced only if we had the option on: declining one
     *  that was never taken up is not news, and Mudlet guards it the same way. */
    private refuseProtocol(cmd: number, opt: number): void {
        this.sendOption(cmd === WILL ? DONT : WONT, opt);
        if (this.enabledProtocols.delete(opt)) {
            this.eventBus.emit('protocol.disabled', PROTOCOL_NAMES.get(opt) ?? String(opt));
        }
    }

    /** The server withdrew the option (IAC WONT / IAC DONT). */
    private withdrawProtocol(opt: number): void {
        this.enabledProtocols.delete(opt);
        this.eventBus.emit('protocol.disabled', PROTOCOL_NAMES.get(opt) ?? String(opt));
    }

    /** Mudlet's ATCP hello, sent after `IAC DO ATCP` and again in answer to
     *  the server's `Auth.Request`: the client's name and version, then the
     *  modules it asks for. Mudlet's list less `composer`, since there is no
     *  ATCP composer here to answer `Client.Compose`. */
    sendAtcpHello(): void {
        const hello = `hello ${CLIENT_NAME} ${CLIENT_VERSION}\nchar_vitals 1\nroom_brief 1\nroom_exits 1\nmap_display 1\n`;
        this.hooks.sendRaw(GMCP_IAC + GMCP_SB + String.fromCharCode(OPT_ATCP_NUM) + toByteString(hello) + GMCP_IAC + GMCP_SE);
    }

    /** Mudlet's MSDP start sequence, sent after `IAC DO MSDP`:
     *  `LIST COMMANDS`, then `CLIENT_NAME` / `CLIENT_VERSION` in one frame. */
    private sendMsdpHello(): void {
        this.hooks.sendRaw(encodeMsdp('LIST', ['COMMANDS']));
        this.hooks.sendRaw(GMCP_IAC + GMCP_SB + OPT_MSDP_BYTE
            + MSDP_VAR + 'CLIENT_NAME' + MSDP_VAL + toByteString(CLIENT_NAME)
            + MSDP_VAR + 'CLIENT_VERSION' + MSDP_VAL + toByteString(CLIENT_VERSION)
            + GMCP_IAC + GMCP_SE);
    }

    /** Raise `telnet.event` (Mudlet's `sysTelnetEvent`) for one complete
     *  command, `raw` being its bytes from the IAC on. Mirrors the tail of
     *  `cTelnet::processTelnetCommand`: raised for every command — handled
     *  options included — except GA and EOR, which end nearly every prompt,
     *  and the subnegotiations of the options in `SB_CONSUMED`.
     *  `type` is the command byte itself (251 WILL, 250 SB, …), `option` the
     *  byte after it (0 for a two-byte command), and `message` the SB body
     *  between the option byte and IAC SE, or for anything shorter than a
     *  six-byte subnegotiation the whole command. Decoded as UTF-8, as Mudlet's
     *  QString conversion does. */
    private emitTelnetEvent(raw: string): void {
        const type = raw.charCodeAt(1);
        if (type === GA || type === EOR) return;
        const option = raw.length > 2 ? raw.charCodeAt(2) : 0;
        const body = raw.length >= 6 ? raw.slice(3, -2) : raw;
        this.eventBus.emit('telnet.event', type, option, fromByteString(body).text);
    }

    /** Reply to a TERMINAL-TYPE / MTTS subnegotiation. `subneg` is the SB body
     *  with the option byte (24) at [0]; [1] is the request kind (1 = SEND). We
     *  answer `IAC SB TTYPE IS <value> IAC SE`, walking Mudlet's
     *  `mCycleCountMTTS` cycle on successive SENDs: client name, terminal type,
     *  the MTTS bitvector, the bitvector again — the repeat is what tells the
     *  server the list is done (RFC 1091 + the MTTS standard) — and then back to
     *  the client name, so a server that re-detects the client later (after a
     *  copyover, say) is told who it is again. With MTTS off the cycle is just
     *  the client name, repeated — desktop Mudlet still identifies itself, it
     *  only skips the MTTS steps. */
    handleTtypeSubneg(subneg: string): void {
        if (subneg.charCodeAt(1) !== TTYPE_SEND.charCodeAt(0)) return; // only handle SEND
        let value: string;
        switch (this.ttypeStep) {
            case 0:
                // `mVersionInTTYPE`: append our version to the client-name step
                // only — the terminal-type and MTTS steps are unchanged.
                value = this.flags.versionInTTYPE ? `${CLIENT_NAME} ${CLIENT_VERSION}` : CLIENT_NAME;
                if (this.flags.mttsEnabled) this.ttypeStep = 1;
                break;
            case 1:
                value = TERMINAL_TYPE;
                this.ttypeStep = 2;
                break;
            default:
                value = `MTTS ${this.currentMtts()}`;
                this.ttypeStep = this.ttypeStep === 2 ? 3 : 0;
                break;
        }
        this.hooks.sendRaw(GMCP_IAC + GMCP_SB + OPT_TTYPE + TTYPE_IS + value + GMCP_IAC + GMCP_SE);
    }

    /** The MTTS bitvector from live state — Mudlet's `getNewEnvironMTTS`: UTF-8
     *  when that is the encoding, SCREEN READER when advertised, MNES when the
     *  profile has MNES and NEW-ENVIRON both on; the rest are static (see
     *  computeMtts, including why SSL always is). */
    private currentMtts(): number {
        return computeMtts({
            utf8: this.hooks.getEncoding() === 'utf-8',
            mnes: this.flags.mnesEnabled && this.flags.newEnvironEnabled,
            screenReader: this.flags.screenReaderAdvertised,
        });
    }

    /** Handle an `IAC SB MXP IAC SE` subnegotiation. Per spec it carries no
     *  payload — it merely confirms MXP is active — so we just start MXP. The
     *  actual MXP markup arrives in-band and is parsed downstream by the
     *  scripting engine. */
    handleMxpSubneg(): void {
        if (!this.flags.mxpEnabled) return;
        // No telnet reply is due — the server asked for nothing — but the
        // option is on from here, so it announces itself like any other.
        this.enabledProtocols.add(OPT_MXP);
        this.eventBus.emit('protocol.enabled', 'MXP');
        this.startMxp(true, true);
    }

    /** Answer an `IAC SB NEW-ENVIRON SEND … IAC SE` request. Telnet option 39
     *  is shared by two modes, each answered as Mudlet answers it: MNES
     *  (`sendIsMNESValues`) reports the five core variables framed as VAR, one
     *  reply per named variable; plain NEW-ENVIRON (`sendIsNewEnvironValues`)
     *  reports the core set plus an extended capability set, framed as USERVAR,
     *  in a single reply that lists unknown names as undefined and may come
     *  back empty. MNES takes precedence when both toggles are on. No-op when
     *  the option is off for this profile or on a non-SEND body. */
    handleNewEnvironSubneg(subneg: string): void {
        const f = this.flags;
        if (!f.newEnvironEnabled) return;
        // MNES precedence: when on, it restricts the reported set to the core
        // five regardless of whether plain NEW-ENVIRON is also enabled.
        const extended = !f.mnesEnabled;
        const vars = this.collectNewEnvironVars(extended);
        if (extended) {
            const reply = newEnvironIsReply(subneg, vars);
            if (reply !== null) this.hooks.sendRaw(reply);
            return;
        }
        for (const reply of mnesIsReplies(subneg, vars) ?? []) this.hooks.sendRaw(reply);
    }

    /** Build the option-39 variable set from live client state. CHARSET tracks
     *  the negotiated encoding and WORD_WRAP the main console's wrap column
     *  (Mudlet's `Host::mWrapAt`, not the window's width). The static identity
     *  (CLIENT_NAME/VERSION, TERMINAL_TYPE) and the capability defaults live in
     *  buildNewEnvironVars. */
    private collectNewEnvironVars(extended: boolean): MnesVar[] {
        const encoding = this.hooks.getEncoding();
        const charset = encoding === 'utf-8' ? 'UTF-8' : encoding.toUpperCase();
        return buildNewEnvironVars({
            charset,
            utf8: encoding === 'utf-8',
            mnes: this.flags.mnesEnabled && this.flags.newEnvironEnabled,
            wordWrap: this.wrapAt,
            screenReader: this.flags.screenReaderAdvertised,
            osc8Hyperlinks: this.flags.osc8HyperlinksEnabled,
        }, extended);
    }

    /** Latch MXP on for this session and notify listeners. Only the first call
     *  emits `mxp.negotiated`, and a later subnegotiation; other later calls
     *  (repeat WILL/DO, in-band detection on subsequent frames) are no-ops. `viaTelnet` distinguishes a
     *  real option-91 handshake from in-band-only detection (see the event doc),
     *  and `viaSubnegotiation` the bare `IAC SB MXP IAC SE` that starts the
     *  processor locked until the server sends a mode of its own. */
    private startMxp(viaTelnet: boolean, viaSubnegotiation = false): void {
        if (this.mxpStarted) {
            // Every `IAC SB MXP IAC SE` puts the processor back in locked mode,
            // not just one that comes first: the usual order is WILL, then SB,
            // and it is the SB that says nothing is markup until the game
            // switches modes (cTelnet sets MXP_MODE_CODE_LOCK_LOCKED on each).
            if (viaSubnegotiation) this.eventBus.emit('mxp.negotiated', viaTelnet, true);
            return;
        }
        this.mxpStarted = true;
        this.eventBus.emit('mxp.negotiated', viaTelnet, viaSubnegotiation);
    }

    /** Mudlet's `cTelnet::sendCurrentNAWS`: report the size the game should
     *  format for as an `IAC SB NAWS … IAC SE` subnegotiation — once NAWS is
     *  on, and only when it differs from what was last sent. The width is the
     *  smaller of the window's columns and the wrap column, less the timestamp
     *  gutter when one is drawn; a game told the full window width would wrap
     *  wider than the client does, and every long line would break twice.
     *  Wrapping switched off (wrap 0, which only the Settings field can set and
     *  desktop has no equivalent of) leaves the window width alone.
     *
     *  Falls back to a conventional 80×24 terminal when the UI hasn't reported a
     *  real size yet — better than the NAWS 0×0 "no preference" sentinel, which
     *  some servers treat as "disable wrapping". */
    private sendCurrentNaws(): void {
        if (!this.nawsNegotiated) return;
        const { cols, rows } = this.windowSize ?? { cols: 80, rows: 24 };
        const visible = this.wrapAt > 0 ? Math.min(cols, this.wrapAt) : cols;
        const width = Math.max(0, visible - (this.timestampsShown ? TIMESTAMP_GUTTER_COLUMNS : 0));
        if (rows <= 0) return; // Mudlet sends nothing while the console has no height
        if (this.lastNaws && this.lastNaws.width === width && this.lastNaws.height === rows) return;
        this.lastNaws = { width, height: rows };
        // Desktop's `sendNAWS` reads `enableNAWS` on every call, so switching
        // it off mid-session stops the reports at once (mudlet-web#379). The
        // size is still recorded as sent, as `sendCurrentNAWS` records it.
        if (!this.flags.nawsEnabled) return;
        if (debugTelnetEnabled()) {
            const fallback = this.windowSize ? '' : ' (fallback — no size measured yet)';
            // eslint-disable-next-line no-console
            console.debug(`[mudlet.telnet OUT] SB NAWS ${width}x${rows}${fallback}`);
        }
        this.hooks.sendRaw(encodeNaws(width, rows));
    }
}
