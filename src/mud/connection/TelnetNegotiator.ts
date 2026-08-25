import type { EventBus } from "../../core/EventBus";
import {
    buildNewEnvironVars,
    CHARSET_DO,
    CHARSET_WILL,
    computeMtts,
    encodeMnesIs,
    encodeNaws,
    EOR_DO,
    GMCP_DO,
    GMCP_IAC,
    GMCP_SB,
    GMCP_SE,
    GMCP_WILL,
    LINEMODE_DONT,
    LINEMODE_WONT,
    MSDP_DO,
    MSDP_WILL,
    MSP_DO,
    MSP_WILL,
    MSSP_DO,
    MSSP_WILL,
    MXP_DO,
    MXP_WILL,
    NAWS_WILL,
    NEW_ENVIRON_USERVAR,
    NEW_ENVIRON_VAR,
    NEW_ENVIRON_WILL,
    NEW_ENVIRON_WONT,
    OPT_TTYPE,
    parseMnesRequest,
    selectMnesVars,
    MNES_UNMAINTAINED,
    SGA_DONT,
    TTYPE_IS,
    TTYPE_SEND,
    TTYPE_WILL,
    type MnesVar,
} from "../protocol";
import { CLIENT_NAME, CLIENT_VERSION, TERMINAL_TYPE } from "../../version";
import type { MudClientEvents } from "../events";
import { debugMspEnabled, debugTelnetEnabled } from "./telnetDebug";

// Telnet command bytes.
const IAC = 0xFF;
const SE = 0xF0, SB = 0xFA, WILL = 0xFB, WONT = 0xFC, DO = 0xFD, DONT = 0xFE;

// Telnet option bytes the negotiator handles natively (or deliberately leaves
// to a sibling handler). Everything else goes through the supported-options
// registry or is surfaced as a `telnet.event`.
const OPT_ECHO = 1, OPT_SGA = 3, OPT_TTYPE_NUM = 24, OPT_EOR = 25, OPT_NAWS = 31,
    OPT_LINEMODE = 34, OPT_NEW_ENVIRON_NUM = 39, OPT_CHARSET_NUM = 42, OPT_MSDP = 69,
    OPT_MSSP = 70, OPT_MCCP1 = 85, OPT_MCCP2 = 86, OPT_MSP = 90, OPT_MXP = 91, OPT_GMCP = 201;

/** Options the client negotiates natively — excluded from `sysTelnetEvent`
 *  so script handlers see only "everything else". */
const HARDCODED = new Set<number>([
    OPT_ECHO, OPT_SGA, OPT_TTYPE_NUM, OPT_EOR, OPT_NAWS, OPT_LINEMODE, OPT_NEW_ENVIRON_NUM,
    OPT_CHARSET_NUM, OPT_MSDP, OPT_MSSP, OPT_MCCP1, OPT_MCCP2, OPT_MSP, OPT_MXP, OPT_GMCP,
]);

/** The exact sequence of options a server running KaVir's protocol snippet
 *  offers/requests, in order (`expectedOrderForKaVirHandler`, ctelnet.cpp).
 *  Such a server parses a decimal version out of the TTYPE client-name reply
 *  and silently caps colour support at 16 without one, so matching this order
 *  is Mudlet's cue to switch `versionInTTYPE` on. ATCP (200) is in the middle:
 *  the snippet offers it even though mudix doesn't speak it, and the whole
 *  point of the fingerprint is that it is *this* list in *this* order — so it
 *  is spelled out here rather than derived from the options we handle. */
const OPT_ATCP_NUM = 200;
const KAVIR_NEGOTIATION_ORDER: readonly number[] = [
    OPT_TTYPE_NUM, OPT_NAWS, OPT_CHARSET_NUM, OPT_MSDP, OPT_MSSP, OPT_ATCP_NUM, OPT_MSP, OPT_MXP,
];

/** In-band MXP line-mode sequence `ESC[<n>z` (n optional). Its presence means
 *  the server is speaking MXP even if it skipped the telnet option-91 handshake.
 *  Non-global so `.test()` stays stateless. */
const MXP_LINE_MODE_RE = /\x1b\[[0-9]*z/;

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
    /** Whether the game-facing transport is TLS (MTTS SSL bit, NEW-ENVIRON TLS var). */
    secureTransport: boolean;
    /** Whether to advertise screen-reader use (MTTS SCREEN READER bit,
     *  NEW-ENVIRON SCREEN_READER var) — Mudlet's `advertiseScreenReader` config
     *  key. Default false; some MUDs adjust their output (e.g. suppress ASCII
     *  art, add extra room-description detail) when this is set. */
    screenReaderAdvertised: boolean;
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
    /** GMCP came up — send the Core.Hello / Core.Supports.Set handshake
     *  (latched by the owner so a re-offer doesn't re-announce). */
    onGmcpNegotiated(): void;
    /** CHARSET came up — kick off the client-driven REQUEST listing our
     *  preferred encodings. */
    onCharsetNegotiated(): void;
    /** Current inbound encoding (IANA label) — drives the MTTS UTF-8 bit and
     *  the MNES/NEW-ENVIRON CHARSET variable. */
    getEncoding(): string;
    /** The server's option-negotiation order matched KaVir's protocol snippet —
     *  it wants a version in our TTYPE reply. Fired at most once per connection;
     *  the owner turns `versionInTTYPE` on and redials. */
    onKaVirProtocolDetected(): void;
}

/**
 * Telnet option negotiation for a MUD session. Owns the WILL/WONT/DO/DONT
 * response policy, the per-session negotiation latches (TTYPE cycle position,
 * MXP started, NAWS accepted), the Mudlet `addSupportedTelnetOption` registry,
 * and the `telnet.event` (sysTelnetEvent) surface for everything unrecognized.
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
    /** Per-incoming-frame dedupe. Keys below 0x100 mark a natively-handled
     *  option as already answered this frame (mirroring the old one-response-
     *  per-frame `includes()` behavior); keys `(cmd << 8) | opt` mark a
     *  `telnet.event` as already raised. Telnet sequences can repeat across
     *  frames, so we only suppress duplicates within a single frame to avoid
     *  event storms. */
    private readonly frameSeen = new Set<number>();
    /** Trailing bytes of a frame that might be the start of a split IAC
     *  sequence (a bare IAC, IAC WILL with no option byte yet, or an IAC SB
     *  whose IAC SE hasn't arrived) — prepended to the next frame so
     *  negotiation commands split across WebSocket frames aren't missed. */
    private carry = "";
    /** MTTS cycle position. The server issues SB TTYPE SEND repeatedly; we walk
     *  through client name (0), terminal type (1), then the MTTS bitvector (2+).
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
    /** True once we've sent IAC WILL NAWS this session (proactively on connect,
     *  or in response to a server-initiated IAC DO NAWS), so we don't re-offer. */
    private nawsWillSent = false;
    /** True once the server has accepted NAWS (IAC DO NAWS). Gates whether a
     *  window-size change is pushed to the server. */
    private nawsNegotiated = false;
    /** True once MSP has actually been negotiated (either direction) this
     *  connection. Mirrors Mudlet's `ctelnet::enableMSP` — the profile config
     *  only decides whether we're willing to negotiate; this records that we
     *  did. See {@link isMspNegotiated}. */
    private mspNegotiated = false;
    /** Latest known main output window size in character columns × rows, fed in
     *  by the session's resize observer via setWindowSize(). Null until the UI
     *  has measured the grid at least once. Deliberately NOT cleared by reset()
     *  so a reconnect keeps reporting the current grid. */
    private windowSize: { cols: number; rows: number } | null = null;
    /** Latches true once the server has asked us to suppress go-ahead (IAC WILL
     *  SGA). mudix refuses SGA (line mode only), but records the request:
     *  combined with active server echo it's the character-at-a-time signature
     *  the owner uses to raise `sysCharacterModeDetected`. Reset on connect(). */
    private serverRequestedSGA = false;

    constructor(
        private readonly flags: TelnetNegotiatorFlags,
        private readonly eventBus: EventBus<MudClientEvents>,
        private readonly hooks: TelnetNegotiatorHooks,
    ) {}

    /** Clear the per-connection latches (call on connect). */
    reset(): void {
        this.frameSeen.clear();
        this.carry = "";
        this.ttypeStep = 0;
        this.mxpStarted = false;
        this.nawsWillSent = false;
        this.nawsNegotiated = false;
        this.mspNegotiated = false;
        this.serverRequestedSGA = false;
        this.negotiationOrder = [];
        this.kaVirDetected = false;
    }

    /** Whether MSP was actually negotiated with the server this connection —
     *  Mudlet's `ctelnet::enableMSP`, distinct from the profile's `enableMSP`
     *  config (which only decides whether we agree to negotiate at all). Gates
     *  `receiveMSP`, which Mudlet refuses unless the option is live. */
    isMspNegotiated(): boolean {
        return this.mspNegotiated;
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

    /** The WebSocket handshake completed — proactively offer NAWS (RFC 1073
     *  has the window-owning side send WILL). The server replies IAC DO NAWS —
     *  handled in processFrame — at which point we send the actual dimensions.
     *  Harmless if the server doesn't support it (it answers DONT or ignores us). */
    onSocketOpen(): void {
        if (this.flags.nawsEnabled && !this.nawsWillSent) {
            this.hooks.sendRaw(NAWS_WILL);
            this.nawsWillSent = true;
        }
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
     *  to the server once NAWS has been negotiated, and only when it changed. */
    setWindowSize(cols: number, rows: number): void {
        const c = Math.max(0, Math.trunc(cols));
        const r = Math.max(0, Math.trunc(rows));
        if (this.windowSize && this.windowSize.cols === c && this.windowSize.rows === r) return;
        this.windowSize = { cols: c, rows: r };
        if (this.nawsNegotiated) this.sendNawsSize();
    }

    /** Walk one incoming frame (post-MCCP Latin-1 byte-string) for telnet IAC
     *  sequences: answer WILL/WONT/DO/DONT per the option policy, auto-respond
     *  to registered supported options, raise `telnet.event` for everything
     *  else (including SB of unrecognized options), and watch for in-band MXP
     *  line-mode sequences on servers that skip the option-91 handshake. */
    processFrame(data: string): void {
        const buf = this.carry + data;
        this.carry = "";
        this.frameSeen.clear();
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
                if (i + 2 < n) this.noticeSubnegotiation(buf.charCodeAt(i + 2));
                i = end + 2;
                continue;
            }
            if (cmd >= WILL && cmd <= DONT) {
                if (i + 2 >= n) { this.carry = buf.slice(i); break; } // split negotiation — wait
                this.handleNegotiationCommand(cmd, buf.charCodeAt(i + 2));
                i += 3;
                continue;
            }
            i += 2; // 2-byte command (GA, EOR, NOP, …) — nothing to negotiate
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

    /** One WILL/WONT/DO/DONT for `opt`. Natively-handled options are answered
     *  at most once per frame (matching the old `includes()`-based scan); the
     *  supported-options registry answers every occurrence; anything left is
     *  surfaced as a `telnet.event`. */
    private handleNegotiationCommand(cmd: number, opt: number): void {
        this.trackKaVirNegotiation(cmd, opt);
        if (HARDCODED.has(opt)) {
            if (this.frameSeen.has(opt)) return;
            this.frameSeen.add(opt);
            this.respondToKnownOption(cmd, opt);
            return;
        }
        if (this.supportedTelnetOptions.has(opt)) {
            if (cmd === WILL) this.hooks.sendRaw(String.fromCharCode(IAC, DO, opt));
            if (cmd === DO) this.hooks.sendRaw(String.fromCharCode(IAC, WILL, opt));
            return;
        }
        this.emitTelnetEvent(cmd, opt);
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
        switch (opt) {
            case OPT_ECHO:
            case OPT_MCCP1:
            case OPT_MCCP2:
                // Negotiated by EchoHandler / MccpHandler, which see the same
                // frame independently — nothing to do here.
                return;
            case OPT_SGA:
                // Server offers Suppress-Go-Ahead (IAC WILL SGA, option 3) →
                // we REFUSE it (IAC DONT SGA), matching Mudlet: mudix operates
                // in line mode only. A DONT is still a definitive answer, so
                // strict servers don't stall; and refusing keeps `IAC GA`
                // un-suppressed, which mudix's prompt detection relies on.
                // We record the request — SGA plus active server echo is the
                // character-at-a-time signature the owner watches for.
                if (cmd === WILL) {
                    this.hooks.sendRaw(SGA_DONT);
                    this.serverRequestedSGA = true;
                    this.eventBus.emit('protocol.rejected', 'SUPPRESS_GO_AHEAD');
                }
                return;
            case OPT_LINEMODE:
                // LINEMODE (RFC 1184, option 34) would hand line editing /
                // forwarding policy to the server. mudix does its own local
                // line editing and never delegates it, so — like Mudlet — we
                // refuse in both directions: DONT to the server's WILL, WONT
                // to its DO.
                if (cmd === WILL) {
                    this.hooks.sendRaw(LINEMODE_DONT);
                    this.eventBus.emit('protocol.rejected', 'LINEMODE');
                } else if (cmd === DO) {
                    this.hooks.sendRaw(LINEMODE_WONT);
                    this.eventBus.emit('protocol.rejected', 'LINEMODE');
                }
                return;
            case OPT_EOR:
                // Server announces it will mark prompts with IAC EOR (telnet
                // option 25, IAC WILL EOR) → we accept (IAC DO EOR). The EOR
                // markers then drive prompt detection the same way IAC GA does.
                // Many Diku/Circle-derived servers (e.g. The Last Outpost) won't
                // send the login prompt until this option is acknowledged.
                if (cmd === WILL) this.hooks.sendRaw(EOR_DO);
                return;
            case OPT_TTYPE_NUM:
                // Server asks us to identify our terminal (IAC DO TTYPE).
                // Agree (IAC WILL TTYPE); the actual name/type/MTTS values
                // follow via the SB TTYPE SEND subnegotiation handled in
                // handleTtypeSubneg(). Many MUDs (e.g. Kallisti) won't offer
                // MSDP/GMCP until this handshake completes.
                if (f.mttsEnabled && cmd === DO) this.hooks.sendRaw(TTYPE_WILL);
                return;
            case OPT_NAWS:
                if (!f.nawsEnabled) return;
                if (cmd === DO) {
                    // Server accepted our WILL NAWS (or requested it outright)
                    // → start reporting window size. If the server initiated
                    // without seeing our WILL (rare), send WILL first. Then
                    // push the current dimensions and re-send on every resize.
                    if (!this.nawsWillSent) {
                        this.hooks.sendRaw(NAWS_WILL);
                        this.nawsWillSent = true;
                    }
                    const firstAccept = !this.nawsNegotiated;
                    this.nawsNegotiated = true;
                    this.sendNawsSize();
                    if (firstAccept) this.eventBus.emit('naws.negotiated');
                } else if (cmd === DONT) {
                    // Server declined window-size reporting — stop pushing it.
                    this.nawsNegotiated = false;
                }
                return;
            case OPT_NEW_ENVIRON_NUM:
                // NEW-ENVIRON is asymmetric — the client owns the variables —
                // so we only handle the DO direction (a WILL would mean the
                // server has env vars, which this protocol doesn't use). MNES
                // and plain NEW-ENVIRON share telnet option 39 and differ only
                // in the variable set reported (handled in
                // handleNewEnvironSubneg); either toggle being on means we
                // answer the option. MNES takes precedence when both are on.
                if (cmd !== DO) return;
                if (f.mnesEnabled || f.newEnvironEnabled) {
                    this.hooks.sendRaw(NEW_ENVIRON_WILL);
                    this.eventBus.emit('mnes.negotiated', f.mnesEnabled ? 'MNES' : 'NEW-ENVIRON');
                } else {
                    // Both disabled → explicitly decline (IAC WONT NEW-ENVIRON).
                    // A bare DO with no WILL/WONT answer leaves strict servers
                    // waiting on the option before they continue (e.g. before
                    // sending the login prompt), so silence is not an option here.
                    this.hooks.sendRaw(NEW_ENVIRON_WONT);
                }
                return;
            case OPT_CHARSET_NUM:
                // Accept CHARSET from either direction and drive the exchange
                // by proactively sending our REQUEST listing preferred
                // encodings (UTF-8 first). Mudlet does the same — without the
                // REQUEST many servers stay on their default codec and never
                // switch.
                if (!f.charsetEnabled) return;
                if (cmd === WILL) {
                    this.hooks.sendRaw(CHARSET_DO);
                    this.hooks.onCharsetNegotiated();
                } else if (cmd === DO) {
                    this.hooks.sendRaw(CHARSET_WILL);
                    this.hooks.onCharsetNegotiated();
                }
                return;
            case OPT_MSDP:
                // Telnet negotiation is symmetric and many servers (e.g.
                // Legends of Kallisti) start MSDP with IAC DO MSDP; without the
                // DO branch we'd never reply and never fire msdp.negotiated.
                if (!f.msdpEnabled) return;
                if (cmd === WILL) {
                    this.hooks.sendRaw(MSDP_DO);
                    this.eventBus.emit('msdp.negotiated');
                } else if (cmd === DO) {
                    this.hooks.sendRaw(MSDP_WILL);
                    this.eventBus.emit('msdp.negotiated');
                }
                return;
            case OPT_MSSP:
                // Server offers MSSP → accept; it then sends its status fields
                // in a single SB MSSP … SE subnegotiation handled by msspStream.
                if (!f.msspEnabled) return;
                if (cmd === WILL) {
                    this.hooks.sendRaw(MSSP_DO);
                    this.eventBus.emit('mssp.negotiated');
                } else if (cmd === DO) {
                    this.hooks.sendRaw(MSSP_WILL);
                    this.eventBus.emit('mssp.negotiated');
                }
                return;
            case OPT_MSP:
                // In practice most MUDs just inline `!!SOUND(...)` tags without
                // ever negotiating, so this is rarely hit; when it is, we want
                // the option enabled so subnegotiated tags route through the
                // MSP parser.
                if (!f.mspEnabled) return;
                if (cmd === WILL) {
                    this.hooks.sendRaw(MSP_DO);
                    this.mspNegotiated = true;
                    this.eventBus.emit('msp.negotiated');
                    if (debugMspEnabled()) console.debug('[mudix.msp] negotiated: server WILL → client DO');
                } else if (cmd === DO) {
                    this.hooks.sendRaw(MSP_WILL);
                    this.mspNegotiated = true;
                    this.eventBus.emit('msp.negotiated');
                    if (debugMspEnabled()) console.debug('[mudix.msp] negotiated: server DO → client WILL');
                } else if (cmd === WONT || cmd === DONT) {
                    // The server can withdraw MSP mid-session; Mudlet clears its
                    // enableMSP here too, so the latch must be able to go false
                    // without waiting for a disconnect.
                    this.mspNegotiated = false;
                    if (debugMspEnabled()) console.debug('[mudix.msp] server withdrew MSP');
                }
                return;
            case OPT_MXP:
                // From here the server embeds in-band MXP markup; the scripting
                // engine parses it once it sees mxp.negotiated. Symmetric —
                // many servers (e.g. Aardwolf) start MXP with IAC DO MXP.
                if (!f.mxpEnabled) return;
                if (cmd === WILL) {
                    this.hooks.sendRaw(MXP_DO);
                    this.startMxp(true);
                } else if (cmd === DO) {
                    this.hooks.sendRaw(MXP_WILL);
                    this.startMxp(true);
                }
                return;
            case OPT_GMCP:
                // Symmetric: server offers (WILL) or requests (DO) GMCP; either
                // way we agree and announce ourselves via the Core.Hello
                // handshake (latched by the owner).
                if (!f.gmcpEnabled) return;
                if (cmd === WILL) {
                    this.hooks.sendRaw(GMCP_DO);
                    this.hooks.onGmcpNegotiated();
                    this.eventBus.emit('gmcp.negotiated');
                } else if (cmd === DO) {
                    this.hooks.sendRaw(GMCP_WILL);
                    this.hooks.onGmcpNegotiated();
                    this.eventBus.emit('gmcp.negotiated');
                }
                return;
        }
    }

    /** Raise `telnet.event` for an SB of an option we neither handle natively
     *  nor auto-negotiate (type 5 in Mudlet's sysTelnetEvent mapping). */
    private noticeSubnegotiation(opt: number): void {
        if (HARDCODED.has(opt) || this.supportedTelnetOptions.has(opt)) return;
        this.emitTelnetEvent(SB, opt);
    }

    /** `type` mirrors Mudlet's TLuaInterpreter mapping: 1=WILL, 2=WONT, 3=DO,
     *  4=DONT, 5=SB. Deduped per (command, option) within the frame so a server
     *  that spams the same option doesn't flood handlers. */
    private emitTelnetEvent(cmd: number, opt: number): void {
        const key = (cmd << 8) | opt;
        if (this.frameSeen.has(key)) return;
        this.frameSeen.add(key);
        const typeNum = cmd === WILL ? 1 : cmd === WONT ? 2 : cmd === DO ? 3 : cmd === DONT ? 4 : 5;
        const cmdName = cmd === WILL ? 'WILL' : cmd === WONT ? 'WONT' : cmd === DO ? 'DO' : cmd === DONT ? 'DONT' : 'SB';
        this.eventBus.emit('telnet.event', typeNum, opt, `IAC ${cmdName} ${opt}`);
    }

    /** Reply to a TERMINAL-TYPE / MTTS subnegotiation. `subneg` is the SB body
     *  with the option byte (24) at [0]; [1] is the request kind (1 = SEND). We
     *  answer `IAC SB TTYPE IS <value> IAC SE`, cycling client name → terminal
     *  type → MTTS capability bitvector on successive SENDs, then repeating the
     *  last value to signal the list is exhausted (RFC 1091 + the MTTS standard). */
    handleTtypeSubneg(subneg: string): void {
        if (!this.flags.mttsEnabled) return;
        if (subneg.charCodeAt(1) !== TTYPE_SEND.charCodeAt(0)) return; // only handle SEND
        // MTTS bitvector tracks live state (UTF-8 encoding, TLS transport); the
        // static bits (ANSI, 256 colours, OSC colour palette, truecolour) are
        // always on. See computeMtts.
        const mtts = computeMtts({
            utf8: this.hooks.getEncoding() === 'utf-8',
            tls: this.flags.secureTransport,
            screenReader: this.flags.screenReaderAdvertised,
        });
        // `mVersionInTTYPE`: append our version to the client-name step only —
        // the terminal-type and MTTS steps are unchanged (ctelnet.cpp case 0).
        const clientName = this.flags.versionInTTYPE ? `${CLIENT_NAME} ${CLIENT_VERSION}` : CLIENT_NAME;
        const cycle = [clientName, TERMINAL_TYPE, `MTTS ${mtts}`];
        const value = cycle[Math.min(this.ttypeStep, cycle.length - 1)];
        if (this.ttypeStep < cycle.length - 1) this.ttypeStep++;
        this.hooks.sendRaw(GMCP_IAC + GMCP_SB + OPT_TTYPE + TTYPE_IS + value + GMCP_IAC + GMCP_SE);
    }

    /** Handle an `IAC SB MXP IAC SE` subnegotiation. Per spec it carries no
     *  payload — it merely confirms MXP is active — so we just start MXP. The
     *  actual MXP markup arrives in-band and is parsed downstream by the
     *  scripting engine. */
    handleMxpSubneg(): void {
        if (!this.flags.mxpEnabled) return;
        this.startMxp(true);
    }

    /** Answer an `IAC SB NEW-ENVIRON SEND … IAC SE` request, framed as
     *  `IAC SB NEW-ENVIRON IS <marker> … VALUE … IAC SE`. Telnet option 39 is
     *  shared by two modes: MNES reports the five core variables framed as VAR;
     *  plain NEW-ENVIRON reports the core set plus an extended capability set,
     *  framed as USERVAR. MNES takes precedence when both toggles are on
     *  (matching Mudlet). The server may request specific variables or send a
     *  bare SEND for all; selectMnesVars handles both. No-op when the option is
     *  off for this profile or on a malformed/non-SEND body. */
    handleNewEnvironSubneg(subneg: string): void {
        const f = this.flags;
        // MNES precedence: when on, it restricts the reported set to the core
        // five regardless of whether plain NEW-ENVIRON is also enabled.
        const extended = !f.mnesEnabled && f.newEnvironEnabled;
        if (!f.mnesEnabled && !f.newEnvironEnabled) return;
        const request = parseMnesRequest(subneg);
        if (!request.isSend) return;
        // MNES knows IPADDRESS but does not supply it, so a server asking for it
        // is answered "undefined" rather than ignored. Plain NEW-ENVIRON has no
        // such name: everything it defines, it reports.
        const vars = selectMnesVars(
            request,
            this.collectNewEnvironVars(extended),
            extended ? [] : MNES_UNMAINTAINED,
        );
        // A request naming only variables we do not report selects nothing, and
        // the two modes say so differently (cTelnet::sendIsMNESValues frames each
        // variable as its own subnegotiation, so no variables means no traffic at
        // all; sendIsNewEnvironValues frames one reply either way and lets it come
        // back empty). Following each keeps a server's own parser on the path it
        // already handles for Mudlet.
        if (vars.length === 0 && !extended) return;
        const marker = extended ? NEW_ENVIRON_USERVAR : NEW_ENVIRON_VAR;
        this.hooks.sendRaw(encodeMnesIs(vars, marker));
    }

    /** Build the option-39 variable set from live client state. CHARSET tracks
     *  the negotiated encoding; the extended NEW-ENVIRON capabilities derive from
     *  the game-facing transport (TLS — false in proxy mode) and the measured
     *  output grid (WORD_WRAP). The static identity (CLIENT_NAME/VERSION, MTTS,
     *  TERMINAL_TYPE) and the capability defaults live in buildNewEnvironVars. */
    private collectNewEnvironVars(extended: boolean): MnesVar[] {
        const encoding = this.hooks.getEncoding();
        const charset = encoding === 'utf-8' ? 'UTF-8' : encoding.toUpperCase();
        return buildNewEnvironVars({
            charset,
            utf8: encoding === 'utf-8',
            tls: this.flags.secureTransport,
            wrapColumns: this.windowSize?.cols ?? 0,
            screenReader: this.flags.screenReaderAdvertised,
        }, extended);
    }

    /** Latch MXP on for this session and notify listeners. Idempotent — only the
     *  first call emits `mxp.negotiated`; later calls (repeat WILL/DO, in-band
     *  detection on subsequent frames) are no-ops. `viaTelnet` distinguishes a
     *  real option-91 handshake from in-band-only detection (see the event doc). */
    private startMxp(viaTelnet: boolean): void {
        if (this.mxpStarted) return;
        this.mxpStarted = true;
        this.eventBus.emit('mxp.negotiated', viaTelnet);
    }

    /** Send the current window size as an `IAC SB NAWS … IAC SE` subnegotiation.
     *  Falls back to a conventional 80×24 terminal default when the UI hasn't
     *  reported a real size yet — better than the NAWS 0×0 "no preference"
     *  sentinel, which some servers treat as "disable wrapping". */
    private sendNawsSize(): void {
        const { cols, rows } = this.windowSize ?? { cols: 80, rows: 24 };
        if (debugTelnetEnabled()) {
            const fallback = this.windowSize ? '' : ' (fallback — no size measured yet)';
            // eslint-disable-next-line no-console
            console.debug(`[mudix.telnet OUT] SB NAWS ${cols}x${rows}${fallback}`);
        }
        this.hooks.sendRaw(encodeNaws(cols, rows));
    }
}
