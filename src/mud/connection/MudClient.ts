import { EventBus } from "../../core/EventBus";
import { AnsiAwareBuffer } from "../text/FormatState";
import { createPassthroughProcessor, type ChunkProcessor } from "../triggers/ChunkProcessor";
import {
    CharsetHandler,
    CHARSET_COMMAND_CODE,
    CLIENT_NAME,
    CLIENT_VERSION,
    createGmcpStream,
    createMsdpStream,
    createMsspStream,
    createTelnetOptionParser,
    EchoHandler,
    encodeGmcp,
    encodeGmcpRaw,
    encodeMsdp,
    GMCP_COMMAND_CODE,
    GMCP_IAC,
    GMCP_SB,
    GMCP_SE,
    MccpHandler,
    MSDP_COMMAND_CODE,
    MSP_COMMAND_CODE,
    MspParser,
    MSSP_COMMAND_CODE,
    MXP_COMMAND_CODE,
    NEW_ENVIRON_COMMAND_CODE,
    OPT_ATCP,
    OPT_TELNET_102,
    SessionCodec,
    stripTelnetSequences,
    TELNET_EOR,
    TELNET_GA,
    TTYPE_COMMAND_CODE,
} from "../protocol";
import type { MudClientEvents, TlsEstablished, TlsError } from "../events";
import { LineAssembler } from "./LineAssembler";
import { TelnetNegotiator } from "./TelnetNegotiator";
import {
    debugFramesEnabled,
    debugGaEnabled,
    debugMspEnabled,
    debugTelnetEnabled,
    logOutboundBytes,
    logTelnetNegotiation,
} from "./telnetDebug";

export type { MudClientEvents } from "../events";
export { SUPPORTED_SERVER_ENCODINGS, DEFAULT_SERVER_ENCODING, canonicalServerEncoding, canEncodeForServer } from "../protocol";

export interface MudClientOptions {
    url: string;
    mccpEnabled?: boolean;
    commandEcho?: boolean;
    chunkProcessor?: ChunkProcessor;
    /** Milliseconds to hold a partial trailing line (text after the last `\n`)
     *  before flushing it as a prompt. Mirrors Mudlet's "Network packet timeout"
     *  preference; defaults to 300ms. Once a server has sent IAC GA or IAC EOR
     *  at least once, the client latches into "GA-driver" mode and the partial
     *  tail is flushed by the prompt marker instead of this timer — so the value
     *  only matters as an idle safety net (e.g. a line split across frames whose
     *  remainder never arrives). */
    promptTimeoutMs?: number;
    /** Whether to accept GMCP (telnet option 201) negotiation. Default true.
     *  When false, the client silently ignores IAC WILL/DO GMCP so the server
     *  never sees a positive ack and no GMCP envelopes flow. */
    gmcpEnabled?: boolean;
    /** Whether to accept TERMINAL-TYPE / MTTS (telnet option 24) negotiation.
     *  Default true. When false, IAC DO TTYPE is ignored so the server falls
     *  back to its non-MTTS code path. */
    mttsEnabled?: boolean;
    /** Whether to accept MSDP (telnet option 69) negotiation. Default false.
     *  When false, IAC WILL/DO MSDP is ignored and no MSDP envelopes flow. */
    msdpEnabled?: boolean;
    /** Whether to accept MSSP (telnet option 70) negotiation. Default true
     *  (matching Mudlet). When false, IAC WILL/DO MSSP is ignored and the
     *  server's status subnegotiation never arrives. */
    msspEnabled?: boolean;
    /** Whether to accept CHARSET (telnet option 42, RFC 2066) negotiation.
     *  Default true. When false, IAC WILL/DO CHARSET is ignored and the
     *  session stays on the UTF-8 baseline (so non-ASCII bytes from non-UTF-8
     *  MUDs render as replacement chars). */
    charsetEnabled?: boolean;
    /** Whether to enable MSP (MUD Sound Protocol, telnet option 90). Default
     *  false. When true the client negotiates the option and strips inline
     *  `!!SOUND(...)` / `!!MUSIC(...)` tags from MUD text, dispatching them
     *  as `msp` events. Always parses subnegotiations regardless of this flag
     *  once negotiated, but in-band parsing is gated to avoid eating literal
     *  text on MUDs that don't speak MSP. */
    mspEnabled?: boolean;
    /** Whether to accept MXP (telnet option 91) negotiation. Default true.
     *  When false, IAC WILL/DO MXP is ignored so the server never sees a
     *  positive ack and no in-band MXP markup is parsed (tags pass through as
     *  literal text). The actual tag parsing lives downstream in the scripting
     *  engine, gated on the `mxp.negotiated` event this client emits. */
    mxpEnabled?: boolean;
    /** Whether to answer telnet option 39 in MNES mode (Mud New-Environ
     *  Standard). Default false. When on, the client reports the five MNES core
     *  variables (CHARSET / CLIENT_NAME / CLIENT_VERSION / MTTS / TERMINAL_TYPE),
     *  framed as NEW_ENVIRON_VAR. MNES takes precedence over plain NEW-ENVIRON
     *  when both are enabled — matching Mudlet, which restricts the reported set
     *  to these five whenever MNES is active. */
    mnesEnabled?: boolean;
    /** Whether to answer telnet option 39 in plain NEW-ENVIRON mode (RFC 1572,
     *  "Client Variables Standard"). Default false. When on (and MNES off), the
     *  client reports the five core variables plus an extended capability set
     *  (ANSI, 256_COLORS, TRUECOLOR, UTF-8, TLS, WORD_WRAP, …), framed as
     *  NEW_ENVIRON_USERVAR. Mudlet exposes MNES and NEW-ENVIRON as two separate
     *  toggles over the same telnet option; mudix mirrors that. */
    newEnvironEnabled?: boolean;
    /** Whether the link to the *game server* is TLS-encrypted, reported as the
     *  NEW-ENVIRON `TLS` capability. Defaults to whether `url` is `wss://` — the
     *  correct answer for a direct websocket-mode connection. In proxy (`mud`)
     *  mode the caller passes the answer explicitly, because a `wss://` proxy URL
     *  only secures the browser↔proxy hop: the proxy↔MUD leg is plaintext telnet
     *  unless the profile enabled TLS (see connectionSecureTransport). */
    secureTransport?: boolean;
    /** Whether to advertise screen-reader use, reported as the MTTS SCREEN
     *  READER bit and the NEW-ENVIRON `SCREEN_READER` capability
     *  (`setConfig("advertiseScreenReader", …)`). Default false. */
    screenReaderAdvertised?: boolean;
    /** Whether to negotiate NAWS / window size (telnet option 31). Default true
     *  (matching Mudlet). When true the client offers IAC WILL NAWS on connect
     *  and, once the server accepts (IAC DO NAWS), reports the main output
     *  area's character grid (columns × rows) and re-sends it on every resize.
     *  When false the client never offers NAWS and ignores IAC DO NAWS. */
    nawsEnabled?: boolean;
    /** Mudlet's "Fix unnecessary linebreaks on GA servers"
     *  (`setConfig("fixUnnecessaryLinebreaks", …)`, host flag
     *  `mUSE_IRE_DRIVER_BUGFIX`). Default false. When true *and* the session is
     *  GA-driven, a single spurious leading newline is stripped from the start
     *  of each GA-terminated data block — the IRE-server bug Mudlet patches in
     *  `cTelnet::gotPrompt`. See LineAssembler. */
    fixUnnecessaryLinebreaks?: boolean;
    /** Mudlet's `setConfig("inputLineStrictUnixEndings", …)` (host flag
     *  `mUSE_UNIX_EOL`). Default false. When true a submitted command is
     *  terminated with a bare `\n` instead of the telnet-standard `\r\n`
     *  (`cTelnet::sendData` appends the CR only when the flag is off) — some
     *  Unix-y servers treat the CR as part of the command. */
    inputLineStrictUnixEndings?: boolean;
    /** Mudlet's `setConfig("specialForceGAOff", …)` (host flag `mFORCE_GA_OFF`).
     *  Default false. When true an inbound IAC GA / IAC EOR is *not* treated as
     *  a prompt marker: the session never latches into GA-driven mode and the
     *  marker becomes a plain newline in the data stream, exactly as
     *  `cTelnet::processSocketData` does in its `else` branch. For servers whose
     *  GA placement is wrong often enough that prompt detection does more harm
     *  than good. Read once per connect (Mudlet snapshots it in `connectIt`), so
     *  a mid-session change applies on the next dial. */
    specialForceGAOff?: boolean;
    /** Mudlet's `setConfig("promptForVersionInTTYPE", …)` (host flag
     *  `mPromptedForVersionInTTYPE`). Default false. Latches once the KaVir
     *  auto-detect has had its say for this profile, so a user who then turns
     *  `versionInTTYPE` back off isn't overridden on the next connect. */
    promptForVersionInTTYPE?: boolean;
    /** Mudlet's `setConfig("promptForMXPProcessorOn", …)` (host flag
     *  `mPromptedForMXPProcessorOn`). Default false. Latches once the in-band
     *  MXP auto-detect has fired for this profile; together with
     *  `specialForceMXPProcessorOn` it decides whether an `ESC[<n>z` from a
     *  server that never negotiated option 91 may still start MXP. */
    promptForMXPProcessorOn?: boolean;
    /** Mudlet's `setConfig("specialForceMXPProcessorOn", …)` (host flag
     *  `mForceMXPProcessorOn`). Default false. Only consulted here for the
     *  in-band-detection gate above — the parser-side effect lives in
     *  ScriptingEngine, which owns the MXP processor. */
    specialForceMXPProcessorOn?: boolean;
    /** Mudlet's `setConfig("versionInTTYPE", …)` (host flag `mVersionInTTYPE`).
     *  Default false. When true the first TTYPE cycle value carries our version
     *  after the client name (`MUDLET-WEB 1.2.3`). Off by default because the
     *  period is not a legal TTYPE character per RFC 1091 — but servers running
     *  KaVir's protocol snippet parse a version out of it and fall back to 16
     *  colours without one, so it's opt-in rather than absent. */
    versionInTTYPE?: boolean;
    /** WebSocket subprotocols to advertise in the opening handshake's
     *  `Sec-WebSocket-Protocol` header (RFC 6455), in preference order — the
     *  server selects at most one. Mutually-exclusive stream *modes*, not layers:
     *  `binary` (raw telnet over binary frames — the mode mudix decodes),
     *  `telnet` (FluffOS's equivalent name), `telnet.mudstandards.org` (the
     *  mudstandards.org proposal). Empty means open a bare socket. Advertising is
     *  a trade-off: some servers (FluffOS) route a *no-subprotocol* upgrade to a
     *  non-MUD handler and never send data, while others (e.g. last-outpost.com)
     *  *reject* an unrecognized subprotocol with HTTP 400 — hence the per-profile
     *  choice. The server's selection is read back from `socket.protocol` on open
     *  and emitted via `client.subprotocol`. */
    subprotocols?: string[];
}

/** The WebSocket subprotocol name for the mudstandards.org "full telnet stream
 *  over binary frames" profile (https://mudstandards.org/websocket/). mudix
 *  already speaks this wire format; advertising the name lets a conforming
 *  server confirm the dialect via the RFC 6455 handshake. */
export const MUD_TELNET_SUBPROTOCOL = 'telnet.mudstandards.org';

/** Converts raw bytes into a Latin-1 byte-string (charCode === byte for 0..255),
 *  exactly what atob() used to yield for the downstream telnet/MCCP pipeline.
 *  NB: TextDecoder('latin1') is *not* equivalent — that label maps to
 *  windows-1252 and mangles bytes 0x80–0x9F, so we map by hand. Chunked to stay
 *  within String.fromCharCode's argument limit on large frames. */
function bytesToLatin1(bytes: Uint8Array): string {
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return binary;
}

/**
 * The MUD-facing transport: telnet over a WebSocket (direct or via the
 * telnet→WebSocket proxy). Owns the socket lifecycle and the outbound send
 * paths; the protocol concerns are composed from dedicated pieces —
 * {@link TelnetNegotiator} (option negotiation + sysTelnetEvent),
 * {@link SessionCodec}/{@link CharsetHandler} (byte↔char encoding + CHARSET),
 * {@link LineAssembler} (partial-line buffering + prompt flushing),
 * `MccpHandler` (compression), `EchoHandler` (password masking), and the
 * GMCP/MSDP/MSSP subnegotiation streams.
 */
export class MudClient {
    private socket!: WebSocket;
    private readonly eventBus: EventBus<MudClientEvents>;
    private readonly chunkProcessor: ChunkProcessor;
    private messageBuffer: { text: string; type: string }[] = [];
    private readonly gmcpStream: (data: string) => void;
    private readonly msdpStream: (data: string) => void;
    private readonly msspStream: (data: string) => void;
    private readonly telnetOptionHandler: (optionData: string) => string;
    private readonly mccpHandler: MccpHandler;
    private readonly echoHandler: EchoHandler;
    private readonly negotiator: TelnetNegotiator;
    /** Latches once `sysCharacterModeDetected` has fired for this connection so
     *  the warning isn't repeated. Reset on each connect(). See
     *  {@link checkCharacterModePattern}. */
    private charModeDetected = false;
    /** Pending character-at-a-time verdict, armed by a submitted game command
     *  while ECHO+SGA are active and cancelled if the server releases ECHO
     *  first. Null when nothing is in flight. */
    private charModeTimer: ReturnType<typeof setTimeout> | null = null;
    /** Byte↔char codec for the session (inbound streaming decoder + outgoing
     *  encoding). Swapped between encodings by the CHARSET handler. */
    private readonly codec = new SessionCodec();
    private readonly charsetHandler: CharsetHandler;
    /** Whole-line assembly of the decoded text stream (partial-tail buffering,
     *  GA-driven prompt flushing, the idle-flush safety net). */
    private readonly assembler: LineAssembler;
    private readonly url: string;
    /** Buffers the start of a subnegotiation that arrived without its closing IAC SE. */
    private pendingSubneg = "";
    /** True once the WebSocket handshake has completed; used to differentiate
     *  "failed to connect" from "connection lost mid-session" in close events. */
    private opened = false;

    /** True once we've sent the GMCP `Core.Hello` / `Core.Supports.Set`
     *  handshake this session, so a server that re-offers GMCP doesn't make us
     *  announce ourselves twice. Reset on each connect(). */
    private gmcpHelloSent = false;

    /** Set when this dial asked the proxy for TLS (`&tls=1` in the URL), so the
     *  client knows to expect a `tls.established` control frame and to police
     *  the deadline below. */
    private readonly tlsRequested: boolean;
    /** True once the proxy confirmed the handshake, or once any game bytes have
     *  arrived (which can only happen through a working tunnel). */
    private tlsResolved = false;
    private tlsDeadline: ReturnType<typeof setTimeout> | null = null;

    commandEcho: boolean;
    /** Gates the in-band `!!SOUND(...)` / `!!MUSIC(...)` tag parsing — the tag
     *  bytes are legitimate text on non-MSP MUDs. */
    private readonly mspEnabled: boolean;
    private readonly mspParser = new MspParser();
    /** WebSocket subprotocols advertised on connect (see MudClientOptions). */
    private readonly subprotocols: string[];
    /** Mudlet `mUSE_UNIX_EOL` — terminate submitted commands with a bare `\n`.
     *  Read on every send, so a change applies to the next command (Mudlet reads
     *  the host flag in `sendData` too). */
    private strictUnixEndings: boolean;
    /** Mudlet `mFORCE_GA_OFF` — see MudClientOptions.specialForceGAOff. Mudlet
     *  snapshots the host flag into cTelnet at `connectIt`, so a mid-session
     *  change is deliberately not retroactive. Here that falls out for free:
     *  MudSession builds a fresh MudClient per connect from its stored options,
     *  so this is fixed for the life of the connection. */
    private readonly forceGaOff: boolean;

    constructor(
        {
            url,
            mccpEnabled = true,
            commandEcho = true,
            chunkProcessor,
            promptTimeoutMs,
            gmcpEnabled = true,
            mttsEnabled = true,
            msdpEnabled = false,
            msspEnabled = true,
            charsetEnabled = true,
            mspEnabled = false,
            mxpEnabled = true,
            mnesEnabled = false,
            newEnvironEnabled = false,
            secureTransport,
            screenReaderAdvertised = false,
            nawsEnabled = true,
            fixUnnecessaryLinebreaks = false,
            inputLineStrictUnixEndings = false,
            specialForceGAOff = false,
            versionInTTYPE = false,
            promptForVersionInTTYPE = false,
            promptForMXPProcessorOn = false,
            specialForceMXPProcessorOn = false,
            subprotocols = [],
        }: MudClientOptions,
        eventBus: EventBus<MudClientEvents>,
    ) {
        this.url = url;
        this.commandEcho = commandEcho;
        this.eventBus = eventBus;
        this.chunkProcessor = chunkProcessor ?? createPassthroughProcessor();
        this.mspEnabled = mspEnabled;
        this.subprotocols = subprotocols;
        this.strictUnixEndings = inputLineStrictUnixEndings;
        this.forceGaOff = specialForceGAOff;

        this.assembler = new LineAssembler(
            {
                onChunk: (text, ts) => this.chunkProcessor.processChunk(text, ts, this),
                onPrompt: () => this.eventBus.emit('prompt'),
                onIdleFlush: () => this.flushMessageBuffer(),
            },
            { promptTimeoutMs, fixUnnecessaryLinebreaks },
        );

        this.charsetHandler = new CharsetHandler(this.codec, charsetEnabled, {
            sendRaw: (data) => this.sendRaw(data),
            onNegotiated: (displayName) => this.eventBus.emit('charset.negotiated', displayName),
        });

        this.negotiator = new TelnetNegotiator(
            {
                gmcpEnabled,
                mttsEnabled,
                msdpEnabled,
                msspEnabled,
                charsetEnabled,
                mspEnabled,
                mxpEnabled,
                mnesEnabled,
                newEnvironEnabled,
                nawsEnabled,
                // Fall back to the URL scheme when the caller doesn't say —
                // correct for a direct websocket connection; proxy mode passes
                // its own answer, since a wss:// proxy URL says nothing about
                // whether the proxy↔game leg is encrypted.
                secureTransport: secureTransport ?? /^wss:/i.test(url),
                screenReaderAdvertised,
                versionInTTYPE,
                versionInTTYPEPrompted: promptForVersionInTTYPE,
                mxpInBandDetectionEnabled: specialForceMXPProcessorOn || !promptForMXPProcessorOn,
            },
            eventBus,
            {
                sendRaw: (data) => this.sendRaw(data),
                onGmcpNegotiated: () => this.sendGmcpHandshake(),
                onCharsetNegotiated: () => this.charsetHandler.sendRequest(),
                getEncoding: () => this.codec.encoding,
                onKaVirProtocolDetected: () => this.eventBus.emit('kavir.detected'),
            },
        );

        // The proxy contract is expressed in the URL, so that's where we learn
        // whether a TLS handshake is supposed to be happening on the far side.
        this.tlsRequested = /[?&]tls=1(?:&|$)/.test(url);

        this.gmcpStream = createGmcpStream({
            onEnvelope: ({ path, value }) => {
                this.handleCharLogin(path, value);
                (this.eventBus.emit as (event: string, ...args: unknown[]) => void)(`gmcp.${path}`, value);
                // GMCP module names are case-insensitive by convention, and the
                // ping tracker listens on a fixed lowercase event. Route the
                // server's Core.Ping reply regardless of spelling — the spec's
                // canonical reply is PascalCase `Core.Ping` with no body, which
                // `gmcp.${path}` alone would emit as `gmcp.Core.Ping`.
                if (path !== 'core.ping' && path.toLowerCase() === 'core.ping') {
                    this.eventBus.emit('gmcp.core.ping', value);
                }
                this.eventBus.emit('gmcp', { path, value });
            },
            onMessage: (text, type) => {
                this.messageBuffer.push({ text, type });
            },
            onClientGui: (payload) => {
                this.eventBus.emit('clientGui', payload);
            },
        });

        this.msdpStream = createMsdpStream({
            onEnvelope: ({ path, value }) => {
                (this.eventBus.emit as (event: string, ...args: unknown[]) => void)(`msdp.${path}`, value);
                this.eventBus.emit('msdp', { path, value });
            },
        });

        this.msspStream = createMsspStream({
            onEnvelope: ({ name, value }) => {
                (this.eventBus.emit as (event: string, ...args: unknown[]) => void)(`mssp.${name}`, value);
                this.eventBus.emit('mssp', { name, value });
            },
        });

        // A telnet subnegotiation body opens with its option code; route each
        // to its protocol handler and ignore the rest.
        this.telnetOptionHandler = createTelnetOptionParser((subneg) => {
            const code = subneg.charCodeAt(0);
            if (code === GMCP_COMMAND_CODE) this.gmcpStream(subneg);
            else if (code === MSDP_COMMAND_CODE) this.msdpStream(subneg);
            else if (code === MSSP_COMMAND_CODE) this.msspStream(subneg);
            else if (code === TTYPE_COMMAND_CODE) this.negotiator.handleTtypeSubneg(subneg);
            else if (code === CHARSET_COMMAND_CODE) this.charsetHandler.handleSubneg(subneg);
            else if (code === MSP_COMMAND_CODE) this.handleMspSubneg(subneg);
            else if (code === MXP_COMMAND_CODE) this.negotiator.handleMxpSubneg();
            else if (code === NEW_ENVIRON_COMMAND_CODE) this.negotiator.handleNewEnvironSubneg(subneg);
        }, { promptMarkerAsNewline: specialForceGAOff });
        this.mccpHandler = new MccpHandler((data) => this.sendRaw(data));
        this.mccpHandler.enabled = mccpEnabled;

        this.echoHandler = new EchoHandler(
            (data) => this.sendRaw(data),
            (maskInput) => {
                this.eventBus.emit('telnet.echo', maskInput);
                // The server released ECHO right after the masked line, so this
                // was a transient password prompt, not character-at-a-time mode:
                // cancel any pending detection (cTelnet's OPT_ECHO WONT branch).
                if (!this.echoHandler.serverEchoing) this.cancelCharacterModeDetection();
            },
            () => this.eventBus.emit('telnet.echo.anomaly'),
        );
    }

    /** Mudlet-parity character-at-a-time detection (cTelnet::sendData's
     *  `armCharacterModeDetection`). ECHO+SGA on its own is *not* the signature:
     *  an ordinary line-mode server masking a password negotiates exactly the
     *  same pair. The two are told apart by behaviour, so detection is armed
     *  only by a submitted game command and only decides {@link
     *  CHARACTER_MODE_DETECT_MS} later — a password mask sends WONT ECHO right
     *  after the masked line and cancels it first.
     *
     *  Re-armed on every game command so the window always measures from the
     *  most recent submission. */
    private armCharacterModeDetection(): void {
        if (this.charModeDetected) return;
        if (!this.negotiator.sgaRequested || !this.echoHandler.serverEchoing) return;
        if (this.charModeTimer !== null) clearTimeout(this.charModeTimer);
        this.charModeTimer = setTimeout(() => {
            this.charModeTimer = null;
            this.checkCharacterModePattern();
        }, CHARACTER_MODE_DETECT_MS);
    }

    private cancelCharacterModeDetection(): void {
        if (this.charModeTimer === null) return;
        clearTimeout(this.charModeTimer);
        this.charModeTimer = null;
    }

    /** The armed window elapsed with ECHO+SGA still active — a full input line
     *  was submitted without the server releasing echo, which a password prompt
     *  never does. Raise `sysCharacterModeDetected` once per connection so the
     *  UI / scripts can warn the user.
     *
     *  Accepted limitation (same as Mudlet's): this can't tell genuine
     *  character-at-a-time from the rarer cases of a buggy password prompt that
     *  never sends WONT ECHO, or a line-mode server using persistent
     *  server-side echo. We stay in line mode regardless and the message is
     *  only advisory. */
    private checkCharacterModePattern(): void {
        if (this.charModeDetected) return;
        if (!this.negotiator.sgaRequested || !this.echoHandler.serverEchoing) return;
        this.charModeDetected = true;
        this.eventBus.emit('charmode.detected');
    }

    setMccpEnabled(enabled: boolean): void {
        this.mccpHandler.enabled = enabled;
    }

    isMccpEnabled(): boolean {
        return this.mccpHandler.enabled;
    }

    /** Mudlet `setConfig("fixUnnecessaryLinebreaks", …)`. Takes effect on the
     *  next GA-driven block; never retroactive. */
    setFixUnnecessaryLinebreaks(enabled: boolean): void {
        this.assembler.setFixUnnecessaryLinebreaks(enabled);
    }

    /** Mudlet `setConfig("inputLineStrictUnixEndings", …)`. Live: `cTelnet::
     *  sendData` reads the host flag per send, so the next command submitted
     *  uses the new terminator. */
    setInputLineStrictUnixEndings(enabled: boolean): void {
        this.strictUnixEndings = enabled;
    }

    /** Mudlet `addSupportedTelnetOption(option)`. See TelnetNegotiator. */
    addSupportedTelnetOption(option: number): boolean {
        return this.negotiator.addSupportedTelnetOption(option);
    }

    setPromptTimeoutMs(ms: number): void {
        this.assembler.setPromptTimeoutMs(ms);
    }

    getPromptTimeoutMs(): number {
        return this.assembler.getPromptTimeoutMs();
    }

    connect(): void {
        if (this.socket) {
            this.socket.onmessage = null;
            this.socket.onclose = null;
            this.socket.onerror = null;
            this.socket.onopen = null;
        }
        this.mccpHandler.reset();
        this.echoHandler.reset();
        this.codec.reset();
        this.assembler.reset();
        this.negotiator.reset();
        this.charModeDetected = false;
        this.cancelCharacterModeDetection();
        this.gmcpHelloSent = false;
        // Redialling re-runs the handshake, so the previous verdict is stale.
        this.tlsResolved = false;
        if (this.tlsDeadline !== null) {
            clearTimeout(this.tlsDeadline);
            this.tlsDeadline = null;
        }
        this.mspParser.reset();

        try {
            // Advertise subprotocols only when configured — passing an empty
            // array still sends an (empty) Sec-WebSocket-Protocol header, so omit
            // the argument entirely in the common case to keep the bare handshake.
            this.socket = this.subprotocols.length > 0
                ? new WebSocket(this.url, this.subprotocols)
                : new WebSocket(this.url);
            // Receive raw binary frames instead of base64 text. The proxy worker
            // sends bytes directly; decoding base64 on every frame was the bulk
            // of its (and our) per-message CPU cost.
            this.socket.binaryType = "arraybuffer";

            this.socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
                try {
                    // Text frames are the proxy's out-of-band control channel;
                    // game bytes only ever arrive as binary. Proxies predating
                    // TLS support never send these, so this stays compatible.
                    if (typeof event.data === 'string') {
                        this.handleControlFrame(event.data);
                        return;
                    }
                    if (event.data.byteLength === 0) return;
                    // Any game byte proves the tunnel works end to end, so it
                    // also clears a pending TLS deadline — a proxy that reports
                    // no control frames still can't fake decrypted traffic.
                    if (this.tlsRequested && !this.tlsResolved) this.resolveTls();
                    const decodedData = bytesToLatin1(new Uint8Array(event.data));
                    const data = this.mccpHandler.processData(decodedData);
                    if (debugTelnetEnabled()) {
                        logTelnetNegotiation('raw', decodedData);
                        if (data !== decodedData) logTelnetNegotiation('post-mccp', data);
                    }
                    this.negotiator.processFrame(data);
                    this.echoHandler.processData(data);
                    this.eventBus.emit('socket.incoming', data);
                    try {
                        this.processIncomingData(data);
                    } catch (processingError) {
                        console.error('Error during data processing:', processingError);
                    }
                } catch (error) {
                    console.error('Error processing incoming message:', error);
                }
            };

            this.socket.onerror = (error: Event) => {
                this.eventBus.emit('error', error);
            };

            this.socket.onclose = (event: CloseEvent) => {
                // Closing without a single confirmed byte, while TLS was asked
                // for, is the other face of the same ambiguity the deadline
                // covers — report it now rather than waiting it out.
                if (this.tlsRequested && !this.tlsResolved) {
                    this.resolveTls();
                    this.eventBus.emit('tls.timeout', parseHostPort(this.url));
                }
                this.resolveTls();
                this.assembler.flush(Date.now(), true);
                this.eventBus.emit('close', event);
                if (isAbnormalClose(event)) {
                    this.eventBus.emit('client.error', formatCloseError(event, this.opened));
                }
                this.eventBus.emit('client.disconnect');
                this.opened = false;
                this.mccpHandler.reset();
                this.echoHandler.reset();
                this.pendingSubneg = "";
                this.mspParser.reset();
                this.negotiator.clearMspNegotiated();
                this.cancelCharacterModeDetection();
            };

            this.socket.onopen = (event: Event) => {
                this.opened = true;
                // Surface which subprotocol the server actually selected (empty
                // string when none was negotiated). Lets the UI/logs confirm a
                // `telnet.mudstandards.org` handshake succeeded vs. fell back.
                if (this.subprotocols.length > 0) {
                    const selected = this.socket.protocol;
                    this.eventBus.emit('client.subprotocol', selected);
                    if (debugTelnetEnabled()) {
                        // eslint-disable-next-line no-console
                        console.debug('[mudix.telnet subprotocol] requested',
                            this.subprotocols.join(', '), '→ selected',
                            selected ? `'${selected}'` : '(none)');
                    }
                }
                this.negotiator.onSocketOpen();
                // A TLS failure is not reliably reportable: an out-of-date proxy
                // ignores `&tls=1` and opens a plaintext socket to a port that
                // will never answer, and a Cloudflare-Worker proxy whose peer
                // cert is rejected goes silent indefinitely (measured: no error,
                // no close). Either way the symptom is the same — nothing ever
                // arrives — so treat prolonged silence as the failure signal.
                if (this.tlsRequested && !this.tlsResolved && this.tlsDeadline === null) {
                    this.tlsDeadline = setTimeout(() => {
                        this.tlsDeadline = null;
                        if (this.tlsResolved) return;
                        this.eventBus.emit('tls.timeout', parseHostPort(this.url));
                    }, TLS_HANDSHAKE_TIMEOUT_MS);
                }
                this.eventBus.emit('open', event);
                this.eventBus.emit('client.connect');
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.eventBus.emit('error', error);
            this.eventBus.emit('client.error', `Failed to open WebSocket: ${message}`);
        }
    }

    /** Stop policing the TLS deadline — the handshake is accounted for. */
    private resolveTls(): void {
        this.tlsResolved = true;
        if (this.tlsDeadline !== null) {
            clearTimeout(this.tlsDeadline);
            this.tlsDeadline = null;
        }
    }

    /** Decode one proxy control frame. Anything unrecognised is ignored so a
     *  newer proxy can add message types without breaking older clients. */
    private handleControlFrame(raw: string): void {
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return; // not our control channel; drop it rather than corrupt the stream
        }
        if (!msg || typeof msg.type !== 'string') return;

        if (msg.type === 'tls.established') {
            this.resolveTls();
            this.eventBus.emit('tls.established', {
                protocol: typeof msg.protocol === 'string' ? msg.protocol : '',
                cipher: typeof msg.cipher === 'string' ? msg.cipher : '',
                cert: (msg.cert ?? null) as TlsEstablished['cert'],
                certInspection: msg.certInspection !== false,
                acceptedDespite: Array.isArray(msg.acceptedDespite) ? msg.acceptedDespite as string[] : [],
                unsupportedOptions: Array.isArray(msg.unsupportedOptions) ? msg.unsupportedOptions as string[] : [],
            });
            return;
        }

        if (msg.type === 'tls.error') {
            // A reported failure is an answer, so the deadline has served its
            // purpose — let the specific error surface instead of a timeout.
            this.resolveTls();
            this.eventBus.emit('tls.error', {
                code: typeof msg.code === 'string' ? msg.code : 'TLS_ERROR',
                message: typeof msg.message === 'string' ? msg.message : '',
                codes: Array.isArray(msg.codes) ? msg.codes as string[] : [],
                cert: (msg.cert ?? null) as TlsError['cert'],
                certInspection: msg.certInspection !== false,
            });
        }
    }

    disconnect(): void {
        if (!this.socket) return;
        const socket = this.socket;
        // Idempotent on an already-torn-down socket. Without this, a second
        // disconnect() call — e.g. the Lua `disconnect` global re-entering via
        // a sysDisconnectionEvent handler, or teardownClient running after the
        // user clicked Disconnect — would re-emit `client.disconnect` and
        // re-enter the same chain. wasmoon's registry corrupts and the next
        // emitEvent crashes with an out-of-bounds wasm trap.
        const state = socket.readyState;
        if (state === WebSocket.CLOSED || state === WebSocket.CLOSING) return;
        // Null handlers first so a delayed onclose (server doesn't ACK the
        // close frame — happens with Cloudflare tunnels and unresponsive
        // servers) doesn't re-fire the cleanup after we've already
        // synthesized it below.
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.onopen = null;
        socket.close();
        this.assembler.flush(Date.now(), true);
        this.eventBus.emit('client.disconnect');
        this.opened = false;
        this.mccpHandler.reset();
        this.echoHandler.reset();
        this.pendingSubneg = '';
        this.mspParser.reset();
        this.negotiator.clearMspNegotiated();
        this.cancelCharacterModeDetection();
    }

    /** Whether MSP is live on this connection (negotiated, not merely allowed
     *  by the profile config) — gates Mudlet's receiveMSP. */
    isMspNegotiated(): boolean {
        return this.negotiator.isMspNegotiated();
    }

    /** Qt's QAbstractSocket::UnconnectedState — no socket at all, or one that
     *  has finished closing. CONNECTING/OPEN/CLOSING are all "not unconnected",
     *  which is the state feedTelnet refuses to inject into. */
    isSocketUnconnected(): boolean {
        return !this.socket || this.socket.readyState === WebSocket.CLOSED;
    }

    isSocketOpen(): boolean {
        return !!this.socket && this.socket.readyState === WebSocket.OPEN;
    }

    isPasswordMode(): boolean {
        return this.isSocketOpen() && this.echoHandler.passwordMode;
    }

    shouldEchoCommand(): boolean {
        if (!this.isSocketOpen()) return true;
        return !this.echoHandler.serverEchoing && this.commandEcho;
    }

    /** `isGameCommand` mirrors `cTelnet::sendData`'s third argument: only a real
     *  game command (typed or from a script's `send()`) may arm
     *  character-at-a-time detection. Credentials and internal protocol replies
     *  route through here too and must not. */
    send(message: string, isGameCommand = true): void {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return;
        }
        if (!this.echoHandler.serverEchoing) {
            this.eventBus.emit('socket.outgoing', message);
        }
        try {
            // `cTelnet::sendData`: the CR is appended only when mUSE_UNIX_EOL is
            // off, so strict-Unix mode submits the bare LF telnet would normally
            // pair it with.
            this.sendBytes(this.codec.encodeOutgoing(message + (this.strictUnixEndings ? "\n" : "\r\n")));
            if (isGameCommand) this.armCharacterModeDetection();
        } catch (error) {
            console.error('Error sending message:', error);
            this.eventBus.emit('error', error);
        }
    }

    private sendRaw(data: string): void {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return;
        }
        try {
            this.sendBytes(data);
        } catch (error) {
            console.error('Error sending raw data:', error);
        }
    }

    /** Encodes a Latin-1 byte-string to raw bytes and sends it as a binary
     *  WebSocket frame. The proxy worker expects binary, not base64. Every
     *  outbound byte funnels through here, so it's also where `mudix.debugTelnet`
     *  mirrors what we send. */
    private sendBytes(payload: string): void {
        if (debugTelnetEnabled()) logOutboundBytes(payload);
        const bytes = new Uint8Array(payload.length);
        for (let i = 0; i < payload.length; i++) {
            bytes[i] = payload.charCodeAt(i) & 0xff;
        }
        this.socket.send(bytes);
    }

    sendGmcp(path: string, payload: unknown = {}): void {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return;
        }
        try {
            this.sendBytes(encodeGmcp(path, payload));
        } catch (error) {
            console.error('Error sending GMCP message:', error);
            this.eventBus.emit('error', error);
        }
    }

    /** Announce ourselves to the server right after GMCP is negotiated, the way
     *  Mudlet does: `Core.Hello` identifies the client (name + version) and
     *  `Core.Supports.Set` lists the GMCP modules we understand. Many servers
     *  won't push any GMCP data (room, char, vitals, …) until they've received
     *  this hello, so without it GMCP effectively does nothing. Latched so a
     *  repeated WILL/DO GMCP doesn't re-announce. Reports our own identity
     *  (see src/version.ts), matching the TTYPE/MNES/MXP handshakes. */
    private sendGmcpHandshake(): void {
        if (this.gmcpHelloSent) return;
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        this.gmcpHelloSent = true;
        try {
            this.sendBytes(encodeGmcp('Core.Hello', {
                client: CLIENT_NAME,
                version: CLIENT_VERSION,
            }));
            // Mudlet's default Core.Supports.Set, minus "External.Discord 1"
            // (Mudlet only sends that when its Discord integration is active —
            // we have none) and minus the modules gated on Discord.
            this.sendBytes(encodeGmcp('Core.Supports.Set', [
                'Char 1',
                'Char.Skills 1',
                'Char.Items 1',
                'Room 1',
                'IRE.Rift 1',
                'IRE.Composer 1',
                'Client.Media 1',
                'Char.Login 1',
            ]));
        } catch (error) {
            console.error('Error sending GMCP handshake:', error);
            this.eventBus.emit('error', error);
        }
    }

    /** Route GMCP `Char.Login.*` messages. The server sends `Char.Login.Default
     *  { "type": [...] }` to request login and then *waits* for the client to
     *  supply credentials — withholding the normal text "By what name…" prompt
     *  until it hears back (servers that do this gate on the `Char.Login` module
     *  we advertise in `Core.Supports.Set`). We surface it as `charLogin.request`
     *  so the UI can pop a credentials form; the UI replies via
     *  `sendCharLoginCredentials`, or an empty reply (cancel) to fall back to the
     *  text login (the behaviour Mudlet/Mudlet#7377 is about). `Char.Login.Result`
     *  carries the outcome. Path match is case-insensitive — GMCP module casing
     *  varies between servers. */
    private handleCharLogin(path: string, value: unknown): void {
        const p = path.toLowerCase();
        if (p === 'char.login.default') {
            const type = (value as { type?: unknown } | null)?.type;
            const methods = Array.isArray(type) ? type.map(String) : [];
            this.eventBus.emit('charLogin.request', methods);
        } else if (p === 'char.login.result') {
            const v = (value ?? {}) as { success?: unknown; message?: unknown };
            // `success` may arrive as the string "true" rather than a JSON
            // boolean: some game drivers (LPMud/FluffOS and friends — StickMUD
            // does this) parse booleans but can't serialise them back out.
            // Mudlet accepts both spellings (GMCPAuthenticator::handleAuthResult);
            // reading only `=== true` reports a successful login as a failure.
            const success = v.success === true || v.success === 'true';
            this.eventBus.emit('charLogin.result', {
                success,
                message: typeof v.message === 'string' ? v.message : undefined,
            });
        }
    }

    /** Send the GMCP `Char.Login.Credentials` reply. With an account, sends
     *  `{ account, password }` (account may be `"account:character"` for games
     *  with both); with no account it sends the empty `{}` form — the spec's
     *  "no credentials, fall back to your next auth method" signal, used when the
     *  user cancels the popup. mudix never stores the password; it only relays it. */
    sendCharLoginCredentials(account?: string, password?: string): void {
        const payload = account ? { account, password: password ?? '' } : {};
        this.sendGmcp('Char.Login.Credentials', payload);
    }

    sendGmcpRaw(message: string): void {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return;
        }
        try {
            this.sendBytes(encodeGmcpRaw(message));
        } catch (error) {
            console.error('Error sending GMCP message:', error);
            this.eventBus.emit('error', error);
        }
    }

    /** Mudlet `sendMSDP(variable, ...values)`. Frames + sends an MSDP
     *  subnegotiation. Returns false when the socket isn't open. */
    sendMSDP(variable: string, values: string[]): boolean {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return false;
        }
        try {
            this.sendBytes(encodeMsdp(variable, values));
            return true;
        } catch (error) {
            console.error('Error sending MSDP message:', error);
            this.eventBus.emit('error', error);
            return false;
        }
    }

    /** Mudlet `sendATCP(message)`. Frames `IAC SB ATCP <message> IAC SE` (ATCP =
     *  telnet option 200, GMCP's predecessor) and sends it raw. Returns false
     *  when the socket isn't open. */
    sendATCP(message: string): boolean {
        return this.sendSubnegotiation(OPT_ATCP, message, 'ATCP');
    }

    /** Mudlet `sendTelnetChannel102(msg)`. Frames `IAC SB 102 <msg> IAC SE`
     *  (the zMUD generic out-of-band channel) and sends it raw. Returns false
     *  when the socket isn't open. */
    sendTelnetChannel102(msg: string): boolean {
        return this.sendSubnegotiation(OPT_TELNET_102, msg, 'telnet channel 102');
    }

    /** Frame a raw `IAC SB <opt> <payload> IAC SE` subnegotiation and send it
     *  with no encoding conversion (each char → one byte), like the other
     *  telnet negotiations. Shared by sendATCP / sendTelnetChannel102. */
    private sendSubnegotiation(opt: string, payload: string, label: string): boolean {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return false;
        }
        try {
            this.sendBytes(GMCP_IAC + GMCP_SB + opt + payload + GMCP_IAC + GMCP_SE);
            return true;
        } catch (error) {
            console.error(`Error sending ${label} message:`, error);
            this.eventBus.emit('error', error);
            return false;
        }
    }

    /** Mudlet `getServerEncoding()`. The IANA name of the decoder currently
     *  applied to the inbound stream — 'utf-8' until CHARSET negotiation (or an
     *  explicit setServerEncoding) swaps it. */
    getServerEncoding(): string {
        return this.codec.encoding;
    }

    /** Mudlet `setServerEncoding(name)`. Switch the inbound decoder to `name`
     *  (any value from getServerEncodingsList()). Returns false — leaving the
     *  current encoding untouched — when the name isn't one we can decode. */
    setServerEncoding(name: string): boolean {
        return this.charsetHandler.setServerEncoding(name);
    }

    /** Route an `IAC SB MSP ... IAC SE` body to the MSP parser and dispatch
     *  any parsed commands as `msp` events. Always runs when an MSP subneg
     *  arrives — once the server has bothered to wrap a tag, we trust it. */
    private handleMspSubneg(subneg: string): void {
        const commands = this.mspParser.feedSubneg(subneg);
        if (debugMspEnabled()) {
            if (commands.length === 0) {
                console.debug('[mudix.msp] subneg arrived but parsed 0 commands; body=', JSON.stringify(subneg.substring(1)));
            } else {
                console.debug(`[mudix.msp] subneg parsed ${commands.length} command(s):`, commands);
            }
        }
        for (const cmd of commands) this.eventBus.emit('msp', cmd);
    }

    /** Report the main output window's character grid (columns × rows) for NAWS.
     *  The session calls this on every output-area resize. See TelnetNegotiator. */
    setWindowSize(cols: number, rows: number): void {
        this.negotiator.setWindowSize(cols, rows);
    }

    /** Mudlet `sendSocket(data)`. Sends literal bytes over the socket with no
     *  telnet/encoding processing (each char becomes one byte). Returns false
     *  when the socket isn't open. */
    sendSocket(data: string): boolean {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return false;
        }
        try {
            this.sendBytes(data);
            return true;
        } catch (error) {
            console.error('Error in sendSocket:', error);
            this.eventBus.emit('error', error);
            return false;
        }
    }

    /** Mudlet `feedTelnet(data)`. Injects raw bytes into the inbound pipeline
     *  as if they had arrived from the server — they pass through telnet
     *  stripping, ANSI parsing, the trigger pipeline, and rendering. `data` is
     *  treated as a Latin-1 byte-string (matching incoming-frame handling). */
    feedTelnet(data: string): void {
        this.processIncomingData(data);
    }

    output(text?: string | AnsiAwareBuffer, type?: string, timestamp?: number): void {
        const ts = typeof timestamp === 'number' ? timestamp : Date.now();
        this.eventBus.emit('message', text, type, ts);
    }

    /** Push a line directly into the message buffer for trigger processing + rendering via flushLines. */
    pushLine(text: string, type: string): void {
        this.messageBuffer.push({ text, type });
    }

    private processIncomingData(rawData: string, timestamp?: number): void {
        const data = this.pendingSubneg + rawData;
        this.pendingSubneg = "";

        const incompleteAt = findIncompleteSubnegStart(data);
        let processable = data;
        if (incompleteAt !== -1) {
            this.pendingSubneg = data.substring(incompleteAt);
            processable = data.substring(0, incompleteAt);
        }

        // `mFORCE_GA_OFF`: the marker is still received, but it stops meaning
        // "prompt". The session never latches into GA-driven mode, and the
        // option parser has already turned the marker into a newline in the
        // sanitized text (see createTelnetOptionParser), matching the `'\n'`
        // Mudlet pushes in the else branch of its GA handling.
        const hasPrompt = !this.forceGaOff
            && (processable.includes(TELNET_GA) || processable.includes(TELNET_EOR));
        const sanitized = stripTelnetSequences(processable, this.telnetOptionHandler).replace(/\r/g, '');
        const decodedRaw = this.codec.decode(sanitized);
        // MSP in-band parsing: strip `!!SOUND(...)` / `!!MUSIC(...)` triplets
        // and dispatch them as events. Gated on mspEnabled because the tag
        // bytes are legitimate text on non-MSP MUDs (rare in practice but
        // possible inside log dumps and quoted strings).
        let decoded = decodedRaw;
        if (this.mspEnabled && decodedRaw.length > 0) {
            const { text, commands } = this.mspParser.feed(decodedRaw);
            decoded = text;
            if (commands.length > 0 && debugMspEnabled()) {
                console.debug(`[mudix.msp] inline parsed ${commands.length} command(s):`, commands);
            }
            for (const cmd of commands) this.eventBus.emit('msp', cmd);
        }
        const ts = typeof timestamp === 'number' ? timestamp : Date.now();

        if (debugFramesEnabled() && decoded.length > 0) {
            const endsWithNl = decoded.endsWith('\n');
            const tail = decoded.slice(-40).replace(/\n/g, '\\n').replace(/\x1B/g, '\\e');
            const head = decoded.slice(0, 40).replace(/\n/g, '\\n').replace(/\x1B/g, '\\e');
            // eslint-disable-next-line no-console
            console.debug(
                `[mudix.frame] bytes=${rawData.length} chars=${decoded.length} endsWithNl=${endsWithNl} hasPrompt=${hasPrompt}\n  head: ${JSON.stringify(head)}\n  tail: ${JSON.stringify(tail)}`,
            );
        }
        if (hasPrompt && debugGaEnabled()) {
            const marker = processable.includes(TELNET_GA) ? 'GA' : 'EOR';
            // eslint-disable-next-line no-console
            console.debug(
                `[mudix.ga] prompt marker IAC ${marker} received` +
                (this.assembler.gaDriver ? '' : ' — latching into GA-driven prompt mode'),
            );
        }

        this.assembler.feed(decoded, hasPrompt, ts);
        this.flushMessageBuffer();
    }

    flushMessageBuffer(): void {
        if (this.messageBuffer.length === 0) return;

        const groups: { text: string; type: string }[] = [];
        let currentType: string | null = null;
        let currentText = '';

        for (const message of this.messageBuffer) {
            if (message.type === currentType) {
                currentText += message.text;
            } else {
                if (currentType !== null) {
                    groups.push({ text: currentText, type: currentType });
                }
                currentType = message.type;
                currentText = message.text;
            }
        }
        if (currentType !== null) {
            groups.push({ text: currentText, type: currentType });
        }

        this.messageBuffer = [];
        this.eventBus.emit('flushLines', groups);
    }
}

/** How long a TLS-requested connection may stay silent before we call it a
 *  failure. Generous, because it also covers a MUD that is simply slow to
 *  greet — but bounded, because on some proxies a rejected certificate produces
 *  no error and no close at all, so silence is the only symptom there is. */
const TLS_HANDSHAKE_TIMEOUT_MS = 12_000;

/** How long ECHO+SGA must survive a submitted input line before it counts as
 *  character-at-a-time rather than a password mask — `cTelnet`'s
 *  CHARACTER_MODE_DETECT. See {@link MudClient.checkCharacterModePattern}. */
const CHARACTER_MODE_DETECT_MS = 3_000;

/** Recover the game's host/port from a proxy URL, for error messages. Falls
 *  back to empty/0 for a direct websocket URL, which carries neither. */
function parseHostPort(url: string): { host: string; port: number } {
    try {
        const params = new URL(url).searchParams;
        return { host: params.get('host') ?? '', port: parseInt(params.get('port') ?? '0', 10) || 0 };
    } catch {
        return { host: '', port: 0 };
    }
}

/**
 * 1000 = normal closure, 1005 = no status received (treat as normal when wasClean).
 * Anything else, or `wasClean=false`, is something the user should know about.
 */
function isAbnormalClose(event: CloseEvent): boolean {
    if (!event.wasClean) return true;
    return event.code !== 1000 && event.code !== 1005;

}

function formatCloseError(event: CloseEvent, wasOpened: boolean): string {
    const reason = event.reason?.trim();
    if (reason) return reason;
    if (event.code === 1006) {
        return wasOpened
            ? 'Connection lost (no close frame received from server)'
            : 'Failed to connect (proxy unreachable, blocked, or refused the connection)';
    }
    return wasOpened
        ? `Connection closed (code ${event.code})`
        : `Failed to connect (code ${event.code})`;
}

/**
 * Returns the index of the first IAC SB that has no matching IAC SE later in
 * the string, or -1 if every subnegotiation is complete.
 * Used to detect subnegotiations split across WebSocket frames.
 */
function findIncompleteSubnegStart(data: string): number {
    const IAC = 0xFF;
    const SB  = 0xFA;
    const SE  = 0xF0;
    let i = 0;
    while (i < data.length - 1) {
        if (data.charCodeAt(i) === IAC && data.charCodeAt(i + 1) === SB) {
            // Found start of subneg — scan forward for IAC SE
            let j = i + 2;
            let found = false;
            while (j < data.length - 1) {
                if (data.charCodeAt(j) === IAC && data.charCodeAt(j + 1) === SE) {
                    found = true;
                    i = j + 2;
                    break;
                }
                j++;
            }
            if (!found) return i;
        } else {
            i++;
        }
    }
    return -1;
}
