import { EventBus } from '../core/EventBus';
import { WindowManager } from '../ui/windows/WindowManager';
import { LabelManager } from '../ui/labels/LabelManager';
import { CommandLineManager } from '../ui/cmdline/CommandLineManager';
import { ScrollBoxManager } from '../ui/scrollbox/ScrollBoxManager';
import { OverlayLayerOrder } from '../ui/layout/overlayLayerOrder';
import { SoundManager } from '../ui/sound/SoundManager';
import { VideoManager } from '../ui/video/VideoManager';
import { CmdLineMenuRegistry } from '../ui/CmdLineMenuRegistry';
import { MouseEventRegistry } from '../ui/MouseEventRegistry';
import { MudClient, type MudClientOptions, SUPPORTED_SERVER_ENCODINGS, DEFAULT_SERVER_ENCODING, canonicalServerEncoding, canEncodeForServer } from './connection/MudClient';
import { PingTracker } from './connection/PingTracker';
import { ReplayPlayer } from './replay/ReplayPlayer';
import { ReplayRecorder } from './replay/ReplayRecorder';
import { parseReplay, replayDurationMs } from './replay/replayFormat';
import { type MudClientEvents, type MudEvents, type SessionStatus } from './events';
import type { Console } from './text/Console';
import { mxpColor } from './text/colorParsers';
import { AnsiAwareBuffer } from './text/FormatState';
import { SERVER_WRAP_WIDTH_DEFAULT } from './text/serverWrap';
import { setControlCharacterMode as setActiveControlCharacterMode, type ControlCharacterMode } from './text/controlCharacterMode';

export type { SessionStatus, MudEvents } from './events';
export type { ControlCharacterMode } from './text/controlCharacterMode';

export type MudSessionOptions = Omit<MudClientOptions, 'url'>;

/** Mudlet `showSentText` modes — controls local echo of commands you send.
 *  `never`: never echo. `script`: echo unless a script passes `send(cmd, false)`
 *  (the default). `always`: echo even when a script passes `send(cmd, false)`. */
export type ShowSentTextMode = 'never' | 'script' | 'always';

/** Mudlet `blankLinesBehaviour` modes — controls how empty server lines render.
 *  `show`: render the blank line as-is (default). `hide`: suppress it entirely.
 *  `replacewithspace`: render it as a single space (so screen readers announce
 *  it — Mudlet's QTBUG-105035 workaround). */
export type BlankLinesBehaviour = 'show' | 'hide' | 'replacewithspace';

export type ScriptLogSourceKind = 'script' | 'alias' | 'trigger' | 'timer' | 'key' | 'button';

export interface ScriptLogSource {
    kind: ScriptLogSourceKind;
    id: string;
    name: string;
    line?: number;
}

export interface ScriptLogEntry {
    text: string;
    level: 'error' | 'info';
    timestamp: number;
    source?: ScriptLogSource;
}

export class MudSession {
    readonly events = new EventBus<MudEvents>();
    // Shared z-order across nested windows/the embedded mapper, labels,
    // command lines, and scroll boxes — see overlayLayerOrder.ts.
    private readonly overlayLayerOrder = new OverlayLayerOrder();
    readonly windows = new WindowManager(this.overlayLayerOrder);
    readonly labels = new LabelManager(this.overlayLayerOrder);
    readonly cmdLines = new CommandLineManager(this.overlayLayerOrder);
    readonly scrollBoxes = new ScrollBoxManager(this.overlayLayerOrder);
    readonly sounds = new SoundManager();
    readonly videos = new VideoManager();
    readonly cmdLineMenu = new CmdLineMenuRegistry();
    readonly mouseEvents = new MouseEventRegistry();
    /** Per-window Console instances. 'main' registered by ScriptingAPI; named windows by WindowManager. */
    readonly consoles = new Map<string, Console>();
    private client: MudClient | null = null;
    /** The most recent URL passed to connect() — replayed by reconnect(). */
    private lastUrl: string | null = null;
    private pingTracker: PingTracker | null = null;
    private stateUnsubs: (() => void)[] = [];
    /** The profile's server encoding, as `getServerEncodingsList()` spells it.
     *  Lives here rather than on the client so it survives having none — see
     *  {@link getServerEncoding}. */
    private serverEncoding: string = DEFAULT_SERVER_ENCODING;
    private _status: SessionStatus = 'disconnected';
    private _ping: number | null = null;
    private _outputReady = false;
    private _destroyed = false;
    /** Latest main output area character grid (columns × rows), tracked here so
     *  it survives client teardown and seeds a freshly-created client on the
     *  next connect(). Fed by the WindowManager's main-console resize callback
     *  and forwarded to the live client for NAWS (telnet option 31). */
    private windowSize: { cols: number; rows: number } | null = null;

    /** Active Mudlet-format replay recording, or null. Fed from the
     *  `socket.incoming` tap in the constructor — the post-MCCP,
     *  pre-telnet-parsing stream, the same point Mudlet records at. */
    private replayRecorder: ReplayRecorder | null = null;
    /** Active replay playback, or null. */
    private replayPlayer: ReplayPlayer | null = null;
    /** Playback speed divisor (1..1024). Read per-chunk, so changing it
     *  mid-replay affects the remaining chunks — matching Mudlet. */
    private _replaySpeed = 1;

    /** Colors for the local echo of sent commands. Re-applied from the active
     *  profile by ProfileSession. `fg` defaults to Mudlet's olive; `bg` empty =
     *  no background. Consumed by echoCommand() to wrap the echo in ANSI. */
    commandEchoColor: { fg: string; bg: string } = { fg: '#717100', bg: '' };

    /** Mudlet `setConfig("showSentText", ...)`. Controls local echo of sent
     *  commands (the server-side ECHO suppression in `shouldEchoCommand` still
     *  applies independently). `script` (the default) echoes only when send()'s
     *  `echo` flag is set, so scripts can suppress per command via
     *  `send(cmd, false)`; `always` echoes even then; `never` never echoes.
     *  Toggled live by the config registry in ScriptingAPI. */
    showSentText: ShowSentTextMode = 'script';

    /** Mudlet `setConfig("blankLinesBehaviour", ...)`. Controls how empty server
     *  lines render in the main output. Read by ScriptingEngine.processFlushBatch
     *  per line; toggled live (and persisted) by the config registry in
     *  ScriptingAPI. */
    blankLinesBehaviour: BlankLinesBehaviour = 'show';

    /** Bounded script.log buffer so the editor panel can backfill entries that
     *  arrived before it was first opened (e.g. errors during initial load). */
    private static readonly SCRIPT_LOG_LIMIT = 500;
    private _scriptLog: ScriptLogEntry[] = [];

    private readonly options: MudSessionOptions;

    /** Warn before the tab closes while a connection is live. Owned here rather
     *  than by MudClient — a fresh client is created on every connect(), so a
     *  per-client listener would accumulate one leaked closure per reconnect. */
    private readonly beforeUnload = (event: Event) => {
        if (this.client?.isSocketOpen()) event.preventDefault();
    };

    constructor(options: MudSessionOptions = {}) {
        this.options = { ...options };
        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', this.beforeUnload);
        }
        this.windows.setConsoleRegistry(this.consoles);
        // The main output area reports its character grid here on every resize;
        // forward it to the client so NAWS (window size) stays in sync.
        this.windows.onMainConsoleResize = (cols, rows) => this.setWindowSize(cols, rows);
        // Status latch. Deliberately registered here, in the constructor, rather
        // than alongside the per-client subscriptions in connect(): EventBus
        // dispatches in registration order, and the ScriptingEngine subscribes to
        // the same `client.connect`/`client.disconnect` events to raise
        // sysConnectionEvent/sysDisconnectionEvent into Lua. Registering the
        // latch at dial time put it *after* the engine, so a Lua handler calling
        // getConnectionInfo() — which reads this status — saw the pre-transition
        // value: `connecting` during sysConnectionEvent and `connected` during
        // sysDisconnectionEvent, i.e. inverted on both edges. Mudlet has no such
        // window; cTelnet raises both events from the socket slots and reads the
        // live QAbstractSocket state, so `connected` is already correct there.
        // The session is always constructed before the engine that wraps it, so
        // latching here restores that ordering. These stay subscribed for the
        // session's lifetime (the bus is ours; destroy() clears it).
        this.events.on('client.connect', () => this.setStatus('connected'));
        this.events.on('client.disconnect', () => { this.setStatus('disconnected'); this.setPing(null); });
        this.events.on('error', () => this.setStatus('disconnected'));
        // Replay recording tap. `socket.incoming` carries the post-MCCP data
        // of every real network frame (and only real frames — replayed data is
        // injected below that emit, so a running replay is never re-recorded).
        this.events.on('socket.incoming', (data) => this.replayRecorder?.feed(data));
        this.events.on('script.log', (text, level, source) => {
            this._scriptLog.push({
                text: text ?? '',
                level: level ?? 'info',
                timestamp: Date.now(),
                ...(source ? { source } : {}),
            });
            if (this._scriptLog.length > MudSession.SCRIPT_LOG_LIMIT) {
                this._scriptLog.splice(0, this._scriptLog.length - MudSession.SCRIPT_LOG_LIMIT);
            }
        });
    }

    get scriptLog(): readonly ScriptLogEntry[] { return this._scriptLog; }
    clearScriptLog(): void { this._scriptLog = []; }

    get status(): SessionStatus { return this._status; }
    get ping(): number | null { return this._ping; }
    get outputReady(): boolean { return this._outputReady; }

    markOutputReady(): void {
        if (this._outputReady) return;
        this._outputReady = true;
        this.events.emit('output.ready');
    }

    markOutputGone(): void {
        this._outputReady = false;
    }

    connect(url: string): void {
        this.lastUrl = url;
        // A running replay feeds the same parsing pipeline the live socket is
        // about to use — interleaving them would corrupt telnet/GMCP state, so
        // dialing wins and the replay stops.
        this.abortReplay();
        // teardownClient() disconnects, which would otherwise leave the
        // "asked for it" flag raised over a dial that is very much wanted.
        this.teardownClient();
        this.deliberateDisconnect = false;
        // Synchronously re-measure the main console's char grid before dialing.
        // The resize observer that normally feeds windowSize is async, so a quick
        // connect (notably on mobile, where layout settles late) can otherwise
        // negotiate NAWS before the real size is known and ship the 80×24
        // fallback — leaving the server's first MOTD formatted for the wrong
        // width. A synchronous measure here closes that race (Mudlet gets the
        // size synchronously from Qt; this is the web equivalent).
        this.windows.remeasureMainGrid();
        const client = new MudClient({ url, ...this.options }, this.events as EventBus<MudClientEvents>);
        this.client = client;
        // Seed the fresh client with the last known window size so NAWS reports
        // the right grid as soon as the server negotiates it.
        if (this.windowSize) client.setWindowSize(this.windowSize.cols, this.windowSize.rows);

        this.pingTracker = new PingTracker(
            // Canonical GMCP: `Core.Ping` (PascalCase) carrying the last measured
            // latency — the spec's second documented request form. We used to
            // send the bare name, which the spec also allows, but servers that
            // JSON-parse everything after the module name unconditionally (LPC
            // ones calling `json_parse()`, notably) fail on the empty body and
            // print a parse error into the game output. A number is valid JSON
            // and satisfies both. sendGmcpRaw, not sendGmcp: the latter would
            // wrap it as an object body, which isn't this message's shape.
            (latencyMs) => client.sendGmcpRaw(`Core.Ping ${latencyMs}`),
            (d) => this.setPing(d),
            this.events,
        );

        // Per-client subscriptions only — the status latch lives in the
        // constructor so it always runs before the scripting engine's handlers.
        this.stateUnsubs = [
            this.events.on('client.error', (message) => this.reportConnectionError(message)),
            this.events.on('charset.negotiated', (name) => this.noteNegotiatedEncoding(name)),
        ];
        // Carry the profile's encoding onto the new socket, so a script that set
        // one before dialing isn't silently overridden by the client default.
        if (this.serverEncoding !== DEFAULT_SERVER_ENCODING) client.setServerEncoding(this.serverEncoding);

        this.setStatus('connecting');
        client.connect();
    }

    /**
     * Whether the last disconnect was asked for rather than suffered — Mudlet's
     * `mDontReconnect`. Auto-reconnect reads it so hanging up by hand, from the
     * toolbar or from Lua, is not immediately undone. Cleared by {@link connect}
     * so it only ever suppresses the one retry it was raised for.
     */
    deliberateDisconnect = false;

    disconnect(): void {
        this.deliberateDisconnect = true;
        this.client?.disconnect();
    }

    /** Whether a send() carrying the given per-call `echo` flag should produce a
     *  local echo, under the current showSentText mode. `script` defers to the
     *  flag; `always`/`never` ignore it. */
    private shouldEchoSentText(echo: boolean): boolean {
        if (this.showSentText === 'never') return false;
        if (this.showSentText === 'always') return true;
        return echo; // 'script'
    }

    /** Set by ScriptingAPI while trigger-mode echo deferral owns the main
     *  console's in-flight partial line (beginLine → flushDeferredEcho). Read
     *  by {@link echoCommand}, which must not close a partial the deferral is
     *  about to emit itself. */
    scriptEchoDeferred = false;

    /** Host::send's echo stage: print a command the player (or an item acting
     *  for them) sent, under the showSentText mode. `wantPrint` is the per-call
     *  flag `script` mode defers to — `always` and `never` overrule it. */
    echoSentCommand(text: string, wantPrint: boolean): void {
        if (this.shouldEchoSentText(wantPrint)) this.echoCommand(text);
    }

    echoCommand(text: string): void {
        if (this.showSentText === 'never') return;
        if (!this.client || this.client.shouldEchoCommand()) {
            const styled = this.styleEchoCommand(text);
            // Close any in-flight script partial (an `echo()` with no trailing
            // newline) before adding a line of our own. The renderer finalizes
            // the element showing that partial the moment this non-partial
            // 'echo' message arrives, but the console would keep accumulating
            // into the same partial — so the next flushOutput would emit the
            // whole accumulated line again and everything already on screen
            // would be drawn a second time, once more per command echoed. An
            // alias doing `echo("TEST")`, run repeatedly, grew a line of
            // TESTTESTTEST… that way. Mudlet has no such split: printCommand
            // writes straight into the buffer line echo() is building.
            // Skipped while trigger-mode echo deferral owns the partial —
            // flushDeferredEcho completes and emits it itself, and stealing it
            // here would drop a trigger's echo off the screen entirely.
            if (!this.scriptEchoDeferred) this.consoles.get('main')?.completePartialLine();
            // Into the buffer as well as onto the screen. Mudlet's echoed
            // command is part of the console's contents — getLines() and the
            // cursor APIs see it, and a trigger can match on it — so a version
            // that only reached the renderer left the model missing lines the
            // player could plainly read. appendLine (not echo) because the
            // renderer is driven by the event below: enqueueing it for the
            // drain path as well would render the command twice.
            this.consoles.get('main')?.appendLine(new AnsiAwareBuffer(styled));
            // No "> " prefix: Mudlet echoes the bare command, and OutputRenderer
            // appends it inline to the open server prompt line (e.g. "- look").
            this.events.emit('message', styled, 'echo', Date.now());
        }
    }

    /** Wrap the echoed command in ANSI truecolor escapes from commandEchoColor
     *  so it renders in the configured foreground (and optional background). */
    private styleEchoCommand(text: string): string {
        const fg = mxpColor(this.commandEchoColor.fg);
        const bg = this.commandEchoColor.bg ? mxpColor(this.commandEchoColor.bg) : null;
        let prefix = '';
        if (fg && fg.space === 'rgb') prefix += `\x1b[38;2;${fg.r};${fg.g};${fg.b}m`;
        if (bg && bg.space === 'rgb') prefix += `\x1b[48;2;${bg.r};${bg.g};${bg.b}m`;
        return prefix ? `${prefix}${text}\x1b[0m` : text;
    }

    /** `isGameCommand` mirrors `cTelnet::sendData`'s flag — see
     *  {@link MudClient.send}. Everything the player or a script submits is one;
     *  auto-login credentials are not, so they can't arm character-at-a-time
     *  detection. */
    send(text: string, echo = true, isGameCommand = true): void {
        this.echoSentCommand(text, echo);
        this.sendData(text, isGameCommand);
    }

    /**
     * `cTelnet::sendData` — put one command on the wire with **no** local echo
     * under any showSentText mode.
     *
     * Mudlet echoes player input exactly once, at the top of `Host::send`,
     * before the command separator split and before aliases see it (see
     * {@link ScriptingEngine.hostSend}); the parts that come out the far side
     * must not echo again. `send(text, false)` cannot express that — `always`
     * overrides the per-call flag — which is the same reason
     * {@link sendSecret} exists. Unlike sendSecret this is an ordinary command:
     * it still warns about text the server encoding can't carry.
     */
    sendData(text: string, isGameCommand = true): void {
        this.warnIfUnencodable(text);
        if (!this.client) return;
        this.client.send(text, isGameCommand);
    }

    /** Mudlet's `mEncodingWarningIssued`: once per encoding, not once per
     *  command, so a script sending in a loop doesn't paper the screen. Reset by
     *  {@link setServerEncoding} / {@link noteNegotiatedEncoding}, because the
     *  new encoding may have no trouble with what the old one couldn't say. */
    private encodingWarningIssued = false;

    /**
     * Warn when a command cannot survive the trip to the game — cTelnet::sendData
     * posts this before sending anyway, and so do we: the server may still make
     * something of what arrives, and silently dropping the command would be
     * worse than sending it mangled.
     *
     * Warning here rather than in MudClient is deliberate: the encoding belongs
     * to the profile, not the socket, and a player typing at a client that isn't
     * connected yet has just as much use for the notice.
     */
    private warnIfUnencodable(text: string): void {
        if (this.encodingWarningIssued || !text) return;
        if (canEncodeForServer(text, this.serverEncoding)) return;
        this.encodingWarningIssued = true;
        const styled = `\x1b[33m[ WARN ]  - Tried to send '${text}' to the game,`
            + ` but it is unlikely to understand it.\x1b[0m`;
        // Buffer as well as renderer, for the same reason echoCommand does it:
        // a line the player can read has to be a line getLines() and the cursor
        // APIs can see.
        this.consoles.get('main')?.appendLine(new AnsiAwareBuffer(styled));
        this.events.emit('message', styled, 'script', Date.now());
    }

    /** Send credentials/secrets that must NEVER be echoed locally — regardless of
     *  the showSentText mode (including `always`) or the server-echo state. Used
     *  for auto-login passwords. The normal `send(text, false)` only suppresses
     *  the echo in `script` mode; `always` would override it, so a password must
     *  take this path instead of relying on the per-call echo flag. */
    sendSecret(text: string): void {
        if (!this.client) return;
        this.client.send(text, false);
    }

    sendGmcpRaw(message: string): void {
        this.client?.sendGmcpRaw(message);
    }

    /** Reply to a GMCP `Char.Login.Default` request. Pass an account + password
     *  to authenticate, or no arguments to send the empty "fall back to text
     *  login" reply (the credentials popup's Cancel). The password is relayed
     *  straight to the wire and never persisted. */
    sendCharLoginCredentials(account?: string, password?: string): void {
        this.client?.sendCharLoginCredentials(account, password);
    }

    sendMSDP(variable: string, values: string[]): boolean {
        return this.client?.sendMSDP(variable, values) ?? false;
    }

    sendSocket(data: string): boolean {
        return this.client?.sendSocket(data) ?? false;
    }

    /** True when there is no live socket — see MudClient.isSocketUnconnected. */
    isSocketUnconnected(): boolean {
        return this.client?.isSocketUnconnected() ?? true;
    }

    /** Mudlet `feedTelnet(data)`. Injects raw bytes into the inbound pipeline as
     *  if the server had sent them.
     *
     *  Works with no connection, which is the state the API is *for*: Mudlet
     *  refuses to inject into a live socket (it would interleave with the real
     *  stream), so every caller — its own test suite included — is offline by
     *  definition. With no client there is no pipeline to inject into, so this
     *  borrows the detached one replay playback already builds for the same
     *  reason: the telnet/ANSI/trigger path needs no socket to run. */
    feedTelnet(data: string): void {
        this.ensureParsingClient().feedTelnet(data);
    }

    sendATCP(message: string): boolean {
        return this.client?.sendATCP(message) ?? false;
    }

    sendTelnetChannel102(msg: string): boolean {
        return this.client?.sendTelnetChannel102(msg) ?? false;
    }

    /** Whether MSP was negotiated on the live connection. False with no client,
     *  which is what a never-connected profile should report. */
    isMspNegotiated(): boolean {
        return this.client?.isMspNegotiated() ?? false;
    }

    // ── Mudlet replay (record + playback) ───────────────────────────────────

    get replaySpeed(): number { return this._replaySpeed; }
    get isReplayRecording(): boolean { return this.replayRecorder !== null; }
    get isReplaying(): boolean { return this.replayPlayer !== null; }

    /** Deliver any replay chunk that has come due. See ReplayPlayer.pumpDue —
     *  a script standing in for the event loop has to drive this queue too, or a
     *  replay it started never advances past its first chunk. */
    pumpReplay(): number { return this.replayPlayer?.pumpDue() ?? 0; }

    /** Set the playback speed divisor, clamped to Mudlet's 1..1024 range.
     *  Takes effect from the next chunk of an active replay. */
    setReplaySpeed(speed: number): void {
        const s = Math.max(1, Math.min(1024, Math.round(Number(speed) || 1)));
        if (s === this._replaySpeed) return;
        this._replaySpeed = s;
        this.events.emit('replay.speed', s);
    }

    /** Start recording the inbound stream to Mudlet's replay format. Returns
     *  false when a recording is already running. */
    startReplayRecording(): boolean {
        if (this.replayRecorder) return false;
        this.replayRecorder = new ReplayRecorder();
        this.events.emit('replay.recording', true);
        this.postReplayInfo('Replay recording has started.');
        return true;
    }

    /** Stop recording and return the captured stream as a Mudlet .dat file's
     *  bytes, or null when no recording was running. The caller decides where
     *  the bytes go (profile VFS, browser download, …). */
    stopReplayRecording(): Uint8Array | null {
        if (!this.replayRecorder) return null;
        const bytes = this.replayRecorder.encode();
        this.replayRecorder = null;
        this.events.emit('replay.recording', false);
        return bytes;
    }

    /** Start playing a Mudlet-format replay (the Lua `loadReplay` core).
     *  Works offline — with no live connection the chunks feed a detached
     *  client's parsing pipeline. Returns null on success or a human-readable
     *  failure reason (mirroring Mudlet's loadReplay error strings). */
    loadReplayData(bytes: Uint8Array): string | null {
        if (this.replayPlayer) return 'another one may already be in progress';
        const chunks = parseReplay(bytes);
        if (chunks === null) return 'replay file seems to be corrupt';
        const client = this.ensureParsingClient();
        const durationMs = replayDurationMs(chunks);
        this.replayPlayer = new ReplayPlayer(chunks, {
            speed: () => this._replaySpeed,
            feed: (data) => client.feedTelnet(data),
            onDone: () => {
                this.replayPlayer = null;
                this.postReplayInfo('The replay has ended.');
                this.events.emit('replay.over');
            },
        });
        this.postReplayInfo(`Loading replay: ${chunks.length} chunks covering ${formatReplayDuration(durationMs)}.`);
        this.events.emit('replay.start', durationMs);
        this.replayPlayer.start();
        return null;
    }

    /** Stop the active replay without delivering its remaining chunks.
     *  Returns false when no replay is running. */
    abortReplay(): boolean {
        if (!this.replayPlayer) return false;
        this.replayPlayer.abort();
        this.replayPlayer = null;
        this.postReplayInfo('The replay has been aborted.');
        this.events.emit('replay.over');
        return true;
    }

    /** The client whose parsing pipeline injected bytes feed into — replay
     *  chunks and feedTelnet alike. Reuses the live client when one exists;
     *  otherwise creates a detached MudClient that is never connect()ed — the
     *  inbound pipeline works without a socket, and any replies the injected IAC
     *  traffic provokes are dropped by the readyState guards, which is exactly
     *  right when nothing is listening for them. */
    private ensureParsingClient(): MudClient {
        if (!this.client) {
            this.client = new MudClient({ url: '', ...this.options }, this.events as EventBus<MudClientEvents>);
        }
        return this.client;
    }

    private postReplayInfo(text: string): void {
        this.events.emit('message', `\x1b[36m[ INFO ]\x1b[0m  - ${text}`, 'script', Date.now());
    }

    /** Mudlet `reconnect()`. Disconnect and redial the most recently connected
     *  URL (set by connect(), so it covers both the app and Lua connect paths).
     *  Returns false when nothing has been dialed yet. */
    reconnect(): boolean {
        if (!this.lastUrl) return false;
        this.connect(this.lastUrl);
        return true;
    }

    /**
     * Mudlet `getServerEncoding()` / `setServerEncoding(name)`.
     *
     * The encoding is the profile's, not the socket's: it can be read and
     * changed with nothing dialed, and the setting carries across a connect.
     * A live client is told about the change so its decoder follows, and a
     * CHARSET negotiation writes the agreed name back here — but the client is
     * not where the answer comes from. It used to be, which made both functions
     * inert until a connection existed, and the name they reported was the
     * decoder's IANA spelling ("utf-8") rather than the one the caller chose
     * ("UTF-8" as `getServerEncodingsList()` spells it).
     */
    getServerEncoding(): string {
        return this.serverEncoding;
    }

    setServerEncoding(name: string): boolean {
        // Canonical, not verbatim: "ISO 8859-1", "iso-8859-1" and "Latin-1" are
        // one encoding under three spellings, and getServerEncoding() has to
        // answer with the one getServerEncodingsList() offered.
        const label = canonicalServerEncoding(String(name ?? ''));
        if (!label) return false;
        // A client that refuses it (it decodes, we only label) leaves both sides
        // as they were, so the caller isn't told a switch happened that didn't.
        if (this.client && !this.client.setServerEncoding(label)) return false;
        this.serverEncoding = label;
        this.encodingWarningIssued = false;
        return true;
    }

    /** Called when CHARSET negotiation settles on a name, so the profile-level
     *  setting reflects what the connection actually agreed. */
    noteNegotiatedEncoding(name: string): void {
        this.serverEncoding = canonicalServerEncoding(name) ?? name;
        this.encodingWarningIssued = false;
    }

    /** Mudlet `getServerEncodingsList()`. The fixed set of encodings mudix can
     *  decode — available even before a connection is dialed. */
    getServerEncodingsList(): string[] {
        return [...SUPPORTED_SERVER_ENCODINGS];
    }

    /** Mudlet `addSupportedTelnetOption(option)`. Forwards to the live
     *  MudClient when one is attached so the option will be auto-negotiated
     *  on the next IAC WILL/DO from the server. Returns false when no client
     *  is wired up yet. */
    addSupportedTelnetOption(option: number): boolean {
        return this.client?.addSupportedTelnetOption(option) ?? false;
    }

    /** Updates both the active client (if any) and the stored options so the
     *  setting survives a reconnect. */
    setPromptTimeoutMs(ms: number): void {
        this.options.promptTimeoutMs = ms;
        this.client?.setPromptTimeoutMs(ms);
    }

    getPromptTimeoutMs(): number | null {
        return this.client?.getPromptTimeoutMs() ?? this.options.promptTimeoutMs ?? null;
    }

    /** Mudlet `setConfig("fixUnnecessaryLinebreaks", …)`. Updates the live client
     *  and the stored options so the setting survives a reconnect. */
    setFixUnnecessaryLinebreaks(enabled: boolean): void {
        this.options.fixUnnecessaryLinebreaks = enabled;
        this.client?.setFixUnnecessaryLinebreaks(enabled);
    }

    /** Mudlet `Host::mUndoServerWrap` / `mUndoServerWrapWidth`, as getConfig
     *  reads them back. */
    get undoServerWrap(): boolean {
        return this.options.undoServerWrap ?? false;
    }

    get undoServerWrapWidth(): number {
        return this.options.undoServerWrapWidth ?? SERVER_WRAP_WIDTH_DEFAULT;
    }

    /** Mudlet `setConfig("undoServerWrap", …)`. Updates the live client and the
     *  stored options so the setting survives a reconnect. */
    setUndoServerWrap(enabled: boolean): void {
        this.options.undoServerWrap = enabled;
        this.client?.setUndoServerWrap(enabled);
    }

    /** Mudlet `setConfig("undoServerWrapWidth", …)`. */
    setUndoServerWrapWidth(width: number): void {
        this.options.undoServerWrapWidth = width;
        this.client?.setUndoServerWrapWidth(width);
    }

    /** Commit a line held for a wrap continuation whose flush delay has passed —
     *  the busted `pumpEvents` path, which cannot wait for a real timer. */
    pumpServerWrap(): boolean {
        return this.client?.pumpServerWrapDue() ?? false;
    }

    /** Mudlet `setConfig("inputLineStrictUnixEndings", …)`. Live — the next
     *  command submitted uses the new line terminator. */
    setInputLineStrictUnixEndings(enabled: boolean): void {
        this.options.inputLineStrictUnixEndings = enabled;
        this.client?.setInputLineStrictUnixEndings(enabled);
    }

    /** Mudlet `setConfig("specialForceGAOff", …)`. Stored for the next dial, and
     *  applied at once to a client that is not connected — which is the state a
     *  profile driving `feedTelnet` is in, and the only one where Mudlet lets
     *  the change land early. See MudClient.setForceGaOff. */
    setSpecialForceGAOff(enabled: boolean): void {
        this.options.specialForceGAOff = enabled;
        this.client?.setForceGaOff(enabled);
    }

    /** Mudlet `setConfig("versionInTTYPE", …)` / `("promptForVersionInTTYPE", …)`.
     *  Stored only: TTYPE is negotiated at connect, so both take effect on the
     *  next dial — the same reconnect requirement Mudlet's own auto-detect works
     *  around by redialing for you. */
    setVersionInTTYPE(enabled: boolean, prompted?: boolean): void {
        this.options.versionInTTYPE = enabled;
        if (prompted !== undefined) this.options.promptForVersionInTTYPE = prompted;
    }

    /** Mudlet `setConfig("promptForMXPProcessorOn", …)` / `("specialForceMXPProcessorOn", …)`.
     *  Stored only — together they gate whether an in-band `ESC[<n>z` may still
     *  auto-start MXP, which the negotiator decides at connect. The *parser*
     *  side of `specialForceMXPProcessorOn` is applied live by ScriptingEngine;
     *  this is just the detection gate. */
    setMxpProcessorFlags(prompted: boolean, forced: boolean): void {
        this.options.promptForMXPProcessorOn = prompted;
        this.options.specialForceMXPProcessorOn = forced;
    }

    /** Mudlet `setConfig("controlCharacterHandling", …)`. Applies immediately —
     *  every console/text window re-renders control characters (and tab-stops)
     *  under the new mode on their next paint. */
    setControlCharacterMode(mode: ControlCharacterMode): void {
        setActiveControlCharacterMode(mode);
    }

    /** Update the telnet protocol toggles applied on the next connect.
     *  Mid-session changes do not retroactively renegotiate — the values are
     *  read by MudClient's constructor, so the next dial sees them. */
    setProtocolOptions(opts: { gmcpEnabled?: boolean; mttsEnabled?: boolean; msdpEnabled?: boolean; msspEnabled?: boolean; charsetEnabled?: boolean; mspEnabled?: boolean; mccpEnabled?: boolean; mxpEnabled?: boolean; mnesEnabled?: boolean; newEnvironEnabled?: boolean; secureTransport?: boolean; screenReaderAdvertised?: boolean; osc8HyperlinksEnabled?: boolean; nawsEnabled?: boolean; subprotocols?: string[] }): void {
        if (opts.gmcpEnabled !== undefined) this.options.gmcpEnabled = opts.gmcpEnabled;
        if (opts.mttsEnabled !== undefined) this.options.mttsEnabled = opts.mttsEnabled;
        if (opts.msdpEnabled !== undefined) this.options.msdpEnabled = opts.msdpEnabled;
        if (opts.msspEnabled !== undefined) this.options.msspEnabled = opts.msspEnabled;
        if (opts.charsetEnabled !== undefined) this.options.charsetEnabled = opts.charsetEnabled;
        if (opts.mspEnabled !== undefined) this.options.mspEnabled = opts.mspEnabled;
        if (opts.mccpEnabled !== undefined) this.options.mccpEnabled = opts.mccpEnabled;
        if (opts.mxpEnabled !== undefined) this.options.mxpEnabled = opts.mxpEnabled;
        if (opts.mnesEnabled !== undefined) this.options.mnesEnabled = opts.mnesEnabled;
        if (opts.newEnvironEnabled !== undefined) this.options.newEnvironEnabled = opts.newEnvironEnabled;
        if (opts.secureTransport !== undefined) this.options.secureTransport = opts.secureTransport;
        if (opts.screenReaderAdvertised !== undefined) this.options.screenReaderAdvertised = opts.screenReaderAdvertised;
        if (opts.osc8HyperlinksEnabled !== undefined) this.options.osc8HyperlinksEnabled = opts.osc8HyperlinksEnabled;
        if (opts.nawsEnabled !== undefined) this.options.nawsEnabled = opts.nawsEnabled;
        if (opts.subprotocols !== undefined) this.options.subprotocols = opts.subprotocols;
    }

    /** Record the main output area's character grid (columns × rows) and forward
     *  it to the live client for NAWS. Stored on the session so a client created
     *  on a later connect() is seeded with the current size. Called by the
     *  WindowManager whenever the main console's grid changes. */
    setWindowSize(cols: number, rows: number): void {
        this.windowSize = { cols, rows };
        this.client?.setWindowSize(cols, rows);
    }

    private teardownClient(): void {
        for (const unsub of this.stateUnsubs) unsub();
        this.stateUnsubs = [];
        this.pingTracker?.destroy();
        this.pingTracker = null;
        this.client?.disconnect();
        this.client = null;
    }

    get destroyed(): boolean { return this._destroyed; }

    /** Release resources that live outside the JS heap. In-memory state (maps,
     *  arrays, sub-managers) is reclaimed by GC once the instance is dropped, so
     *  this only handles the three things that don't self-clean: the WebSocket
     *  + ping timer (via `teardownClient`), Web Audio nodes, and any EventBus
     *  listeners with an AbortSignal cleanup still pending. Idempotent. */
    destroy(): void {
        if (this._destroyed) return;
        this._destroyed = true;
        // Silence replay machinery first — the player's timer chain would
        // otherwise keep feeding a torn-down pipeline. No lifecycle messages
        // during teardown; the output is going away anyway.
        this.replayPlayer?.abort();
        this.replayPlayer = null;
        this.replayRecorder = null;
        if (typeof window !== 'undefined') {
            window.removeEventListener('beforeunload', this.beforeUnload);
        }
        // Persist any pending map view changes (e.g. a just-changed per-area
        // zoom) before tearing down. The save is async but the worker + IDB
        // outlive this instance, so an in-app close still completes it.
        this.windows.flushMapSave();
        this.teardownClient();
        this.sounds.destroy();
        this.videos.destroy();
        this.events.clear();
    }

    private setStatus(status: SessionStatus): void {
        this._status = status;
        this.events.emit('status', status);
    }

    private setPing(duration: number | null): void {
        this._ping = duration;
        this.events.emit('ping', duration);
    }

    private reportConnectionError(message: string): void {
        const text = `[connection error] ${message}`;
        this.events.emit('message', text, 'error', Date.now());
        this.events.emit('script.log', text, 'error');
    }
}

/** hh:mm:ss for the replay-loading info line (Mudlet logs the same shape). */
function formatReplayDuration(ms: number): string {
    const totalSecs = Math.round(ms / 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(Math.floor(totalSecs / 3600))}:${p(Math.floor(totalSecs / 60) % 60)}:${p(totalSecs % 60)}`;
}
