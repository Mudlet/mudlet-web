import type { AnsiAwareBuffer } from './text/FormatState';
import type { MspCommand } from './protocol';
import type { ScriptLogSource } from './MudSession';
import type { CharLoginCapabilities, CharLoginUrl } from './protocol/charLoginFlow';

export type SessionStatus = 'disconnected' | 'connecting' | 'connected';

/** The peer certificate as reported by the proxy. Mirrors the four fields
 *  Mudlet shows (issuer / issued-to / expiry / serial) plus a little extra for
 *  diagnostics. All strings, already formatted for display. */
export interface TlsCertInfo {
    subject: string;
    subjectOrg: string;
    issuer: string;
    issuerOrg: string;
    validFrom: string;
    validTo: string;
    serial: string;
    fingerprint: string;
    altNames: string;
}

export interface TlsEstablished {
    /** Negotiated protocol, e.g. `TLSv1.3`. Empty when the proxy can't report it. */
    protocol: string;
    /** Negotiated cipher suite name. Empty when the proxy can't report it. */
    cipher: string;
    cert: TlsCertInfo | null;
    /** False when the proxy runtime cannot inspect certificates at all. */
    certInspection: boolean;
    /** Certificate faults tolerated because of the profile's ignore-flags. */
    acceptedDespite: string[];
    /** Cert-tolerance options this proxy was asked for but cannot honour. */
    unsupportedOptions: string[];
}

/** What the UI knows about the current connection's TLS state. */
export type TlsStatus =
    | { kind: 'established'; info: TlsEstablished }
    | { kind: 'error'; info: TlsError }
    /** TLS was asked for but nothing came back — see the `tls.timeout` event. */
    | { kind: 'timeout'; host: string; port: number };

export interface TlsError {
    /** Primary blocking fault, e.g. `CERT_HAS_EXPIRED`. */
    code: string;
    message: string;
    codes: string[];
    cert: TlsCertInfo | null;
    certInspection: boolean;
}

/** A pending Mudlet `invokeFileDialog(...)` request. The Lua handler that
 *  called it is suspended (parked coroutine) until `onPick` fires, so the UI
 *  must always resolve it eventually — pass the picked VFS path, or '' for
 *  cancel (Mudlet returns '' when the native dialog is dismissed too). */
export interface FileDialogRequest {
    /** What the script asked to pick: a file or a directory. */
    mode: 'file' | 'folder';
    /** Dialog title supplied by the script (may be ''). */
    title: string;
    /** VFS path to start browsing at; '' means the profile root. */
    location: string;
    /** Resolve the dialog. Must be called exactly once. */
    onPick: (path: string) => void;
}

export type MudClientEvents = {
    'open': [event: Event];
    'close': [event: CloseEvent];
    'error': [error: unknown];
    'client.connect': void;
    'client.disconnect': void;
    'client.error': [message: string];
    /** The WebSocket subprotocol the server selected from our advertised list
     *  (RFC 6455), or '' if none — only emitted when we advertised any. */
    'client.subprotocol': [protocol: string];
    /** The proxy completed a TLS handshake with the game and the link is
     *  carrying decrypted traffic. `cert` is null when the proxy cannot inspect
     *  certificates (the Cloudflare Worker runtime can't), in which case
     *  `certInspection` is false. `acceptedDespite` lists any certificate faults
     *  the profile's ignore-flags waved through — non-empty means encrypted but
     *  not authenticated. */
    'tls.established': [info: TlsEstablished];
    /** The proxy refused the game's certificate, or the TLS handshake failed.
     *  The connection is closing; `codes` carries every blocking fault. */
    'tls.error': [info: TlsError];
    /** TLS was requested but the link produced no evidence of a handshake before
     *  the deadline. Distinct from `tls.error` because the cause is ambiguous:
     *  a proxy too old to understand `&tls=1`, or a Cloudflare-Worker-backed
     *  proxy where a rejected certificate hangs silently instead of reporting. */
    'tls.timeout': [info: { host: string; port: number }];
    'gmcp.negotiated': void;
    'msdp.negotiated': void;
    'mssp.negotiated': void;
    'msp.negotiated': void;
    /** Fires when MNES / NEW-ENVIRON (telnet option 39) negotiation starts — the
     *  server sent IAC DO NEW-ENVIRON and the client agreed (IAC WILL). The
     *  client then answers the server's SEND request with its environment
     *  variables. The payload names the active mode — `'MNES'` (restricted core
     *  set) or `'NEW-ENVIRON'` (extended capability set) — so scripts can hook
     *  the right `sysProtocolEnabled` name. */
    'mnes.negotiated': string;
    /** Fires when NAWS (telnet option 31) negotiation completes — the client
     *  offered IAC WILL NAWS and the server replied IAC DO NAWS. From then on
     *  the client reports the main output area's character grid (columns × rows)
     *  and re-sends it whenever the window resizes. */
    'naws.negotiated': void;
    /** Fires when MXP (telnet option 91) starts for the session. The scripting
     *  engine flips its `mxpActive` flag on this so in-band MXP markup starts
     *  being parsed, and mirrors Mudlet's `sysProtocolEnabled('MXP')`.
     *  `viaTelnet` is true when started by a real option-91 handshake (server
     *  WILL/DO MXP) and false when inferred from in-band `ESC[<n>z` line modes
     *  on a server that skipped negotiation. Only telnet-negotiated MXP gets the
     *  `<SUPPORTS>`/`<VERSION>` handshake replies — an in-band-only server's
     *  inbound MXP channel isn't confirmed, so replying would spam it with
     *  invalid commands. */
    'mxp.negotiated': [viaTelnet: boolean];
    /** Fired for every `!!SOUND` / `!!MUSIC` tag parsed from the in-band text
     *  stream (or an `IAC SB MSP ... IAC SE` subnegotiation body). The
     *  scripting engine wires this to the SoundManager. */
    'msp': [command: MspCommand];
    /** Fires when a CHARSET (RFC 2066) negotiation completes — either the
     *  server's REQUEST was ACCEPTED or our advertised REQUEST was ACCEPTED.
     *  Argument is the IANA charset name as agreed (the wire spelling, e.g.
     *  "UTF-8"). */
    'charset.negotiated': [encoding: string];
    'socket.incoming': [data: string];
    'socket.outgoing': [data: string];
    'message': [text?: string | AnsiAwareBuffer, type?: string, timestamp?: number, isPrompt?: boolean];
    'flushLines': [groups: { text: string; type: string }[]];
    'gmcp': [payload: { path: string; value: unknown }];
    /** A `Client.GUI` server package-install request, in either wire format:
     *  the parsed `{url, version}` object, or the legacy raw `<version>\n<url>`
     *  string. Carried separately from `gmcp` because the legacy form never
     *  becomes a GMCP table entry — decoding both shapes is the install
     *  handler's job (parseClientGuiPayload), not this bus's. */
    'clientGui': [payload: unknown];
    'msdp': [payload: { path: string; value: unknown }];
    'mssp': [payload: { name: string; value: string }];
    'gmcp.core.ping': [value: unknown];
    /** Fires when the server requests GMCP login (Char.Login.Default). The
     *  argument is everything the frame advertised: the negotiated protocol
     *  version, the supported authentication methods (e.g.
     *  `["password-credentials"]`), and any client-driven OAuth capability. The
     *  session decides what to answer with (see charLoginFlow) and replies via
     *  `sendCharLoginCredentials` — a stored pair, or the empty reply, which is
     *  version 1's "fall back to the text login" and version 2's hand-off to the
     *  game's own sign-in screen. */
    'charLogin.request': [capabilities: CharLoginCapabilities];
    /** Fires on a GMCP `Char.Login.URL` — the game offering a web page to sign
     *  in on. `null` when the address was missing, unparseable, or carried a
     *  scheme other than http(s), which the session reports rather than
     *  rendering: the address arrives unauthenticated. Can arrive at any point
     *  in a session, not just at login. */
    'charLogin.url': [link: CharLoginUrl | null];
    /** Fires when the server reports a GMCP login outcome (Char.Login.Result).
     *  `success` is true on a successful authentication; on failure `message`
     *  carries the server's human-readable reason (e.g. "Invalid credentials"). */
    'charLogin.result': [result: { success: boolean; message?: string }];
    /** Fires when the command input should switch in/out of password masking.
     *  True only for a genuine password prompt (server enabled ECHO *after* it
     *  began sending output); a connect-time server-wide ECHO suppresses local
     *  echo without masking, so it does not raise this with `true`. */
    'telnet.echo': [maskInput: boolean];
    /** Mirror of Mudlet's `sysEchoAnomalyDetected`. Fires once per session when
     *  the server toggles `IAC WILL/WONT ECHO` ≥5 times within 5 s; at that
     *  point the client sends `IAC DONT ECHO` and refuses any further ECHO
     *  negotiation for the rest of the connection. */
    'telnet.echo.anomaly': void;
    /** Mudlet `sysTelnetEvent(type, option, message)` — fired for telnet
     *  IAC commands the client doesn't natively recognise (everything other
     *  than the hardcoded GMCP/MSDP/TTYPE/MCCP/ECHO negotiations). */
    'telnet.event': [type: number, option: number, message: string];
    /** Mudlet `raiseProtocolEvent("sysProtocolRejected", name)` — a telnet
     *  option mudix deliberately refuses. mudix, like Mudlet, operates in line
     *  mode only, so it rejects SUPPRESS_GO_AHEAD (option 3) and LINEMODE
     *  (option 34) rather than let the server switch it into character-at-a-
     *  time / server-driven line editing. The payload is the protocol name
     *  (`'SUPPRESS_GO_AHEAD'` or `'LINEMODE'`). */
    'protocol.rejected': [protocol: string];
    /** Mudlet `sysCharacterModeDetected`. Fires once per connection when the
     *  server has both asked to suppress go-ahead (IAC WILL SGA) *and* kept
     *  server-side echo on across a submitted game command — the
     *  character-at-a-time signature that mudix, a line-based client, can't
     *  drive well. The three-second delay is what separates it from an ordinary
     *  password mask, which negotiates the same pair but releases echo as soon
     *  as the masked line is in. Lets scripts / the UI warn the user that input
     *  may not behave as expected. */
    'charmode.detected': void;
    /** The server's telnet option-negotiation order matched KaVir's protocol
     *  snippet (Mudlet `cTelnet::trackKaVirNegotiation`). Such servers read a
     *  decimal version out of our TTYPE client-name reply and fall back to 16
     *  colours without one, so the owner switches `versionInTTYPE` on and
     *  redials. Fires at most once per connection, and never once the profile's
     *  `promptForVersionInTTYPE` latch is set. */
    'kavir.detected': void;
} & Record<string, any>;

export type MudEvents = MudClientEvents & {
    'status': [status: SessionStatus];
    'ping': [duration: number | null];
    'script.log': [text: string, level: 'error' | 'info', source?: ScriptLogSource];
    'output.ready': void;
    'script.deleteline': void;
    'script.clearwindow': void;
    'script.appendcmd': [text: string];
    'script.setcmd': [text: string];
    'script.clearcmd': void;
    'script.selectcmd': void;
    'script.cmdlinesuggestions': [items: string[]];
    /** Words Tab completion must never offer, whatever list they came from. */
    'script.cmdlineblacklist': [items: string[]];
    /** Whether the main command bar's history is persisted at all
     *  (setSaveCommandHistory); the size cap stays a separate setting. */
    'script.savecommandhistory': [save: boolean];
    'script.openvfs': [path: string];
    /** Fired by ScriptingAPI when Lua calls `invokeFileDialog(...)`. The UI
     *  (ProfileSession) shows the in-app VFS picker and resolves the request
     *  via `request.onPick`. See {@link FileDialogRequest}. */
    'script.filedialog': [request: FileDialogRequest];
    'prompt': void;
    'script.movecursorup': void;
    'script.movecursordown': void;
    /** A Mudlet-format replay started playing. Payload is the recording's
     *  total duration in milliseconds (sum of chunk offsets, at 1× speed). */
    'replay.start': [durationMs: number];
    /** The active replay finished or was aborted. */
    'replay.over': void;
    /** Replay recording was toggled on/off (the toolbar Record button state). */
    'replay.recording': [recording: boolean];
    /** The replay playback speed divisor changed (1..1024). */
    'replay.speed': [speed: number];
};
