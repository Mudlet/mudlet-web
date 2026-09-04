import type { WindowOpenOptions } from '../ui/windows/types';
import type { MudletVariable } from '../import/mudletVariables';
import { getBrand } from '../branding';

export const DEFAULT_PROXY_URL = 'wss://mudix.delwing.workers.dev';

export type ConnectionMode = 'mud' | 'websocket';

export interface MudConnection {
    id: string;
    name: string;
    mode?: ConnectionMode;  // undefined treated as 'websocket' for backward compat
    // websocket mode
    url?: string;
    // mud mode
    host?: string;
    port?: number;
    proxyUrl?: string;      // overrides DEFAULT_PROXY_URL when set
    /** When true, opening this profile (via the "Open" button or a `?profile=`
     *  deep link) immediately dials the connection instead of opening offline.
     *  `undefined`/`false` = open offline (default); the "Connect" button always
     *  dials regardless. */
    autoReconnect?: boolean;
    /** Profile icon shown on the connection-selection screen (Mudlet's profile
     *  icon, set by setProfileIcon / read by getProfileIcon / cleared by
     *  resetProfileIcon). Stored as a self-contained `data:` URI. Lives on the
     *  connection record (not the VFS-backed profile settings) so the picker
     *  screen can render it without mounting the profile. Empty/undefined =
     *  fall back to the auto-generated name tile. */
    icon?: string;
    /** GMCP `Char.Login` account/username. Prefills the login popup and the
     *  connection editor's credential fields. Non-sensitive on its own. Lives on
     *  the connection record so the editor can read/write it without mounting the
     *  profile. */
    charLoginAccount?: string;
    /** @deprecated The pre-vault plaintext password field. Nothing writes it any
     *  more: passwords now live encrypted in the credential vault
     *  (`vault/CredentialVault`), because this one sat in localStorage in the
     *  clear and the UI offering it had to warn against itself (issue #25).
     *
     *  Still *read* (see `utils/storedCredentials`) so an existing saved login
     *  keeps working, and folded into the vault — then deleted from here — the
     *  first time the user sets one up. Remove the field once enough releases
     *  have passed for that migration to have run everywhere. */
    charLoginPassword?: string;
    /** Set when this profile was created by linking a Mudlet folder (Link mode):
     *  the folder is the source of truth — its `current/*.xml` is re-read on every
     *  open and written back on save. Drives the linked badge on the connection
     *  screen. The folder handle itself lives in folderHandleStore (IndexedDB). */
    mudletLinked?: boolean;
    /** Set when this profile was created by importing (copying) a Mudlet profile
     *  folder/archive. Like {@link mudletLinked}, it marks the profile's own
     *  package set as authoritative: `ensureDefaultPackages` never adds the stock
     *  defaults (mapper, run-lua-code) to a Mudlet-originated profile that doesn't
     *  already ship them — Mudlet installs those only into brand-new profiles, so
     *  their absence in an imported profile is a real choice, not a gap to fill. */
    mudletImported?: boolean;
    /** ISO timestamp stamped by `addConnection` when the profile is created.
     *  **Absent means the profile predates this field**, which is exactly what
     *  it's for: it stands in for Mudlet's `experiencedMudletPlayer()` (any
     *  profile folder older than 6 months) so the starter UI only reaches
     *  profiles created after it shipped, and never lands on top of a layout
     *  someone already built. See `stockDefaults`. */
    createdAt?: string;
    /** Connect to the game over TLS — Mudlet's `mSslTsl` / the connection
     *  dialog's "secure connection" checkbox. Meaningful in `mud` (proxy) mode
     *  only: the browser cannot wrap a raw socket itself, so the proxy performs
     *  the handshake on our behalf (`&tls=1`). In `websocket` mode the URL
     *  scheme already decides it, so this flag is ignored there. */
    tls?: boolean;
    /** Tolerate an expired peer certificate (Mudlet's `mSslIgnoreExpired`). */
    sslIgnoreExpired?: boolean;
    /** Tolerate a self-signed peer certificate (Mudlet's `mSslIgnoreSelfSigned`). */
    sslIgnoreSelfSigned?: boolean;
    /** Tolerate *every* certificate fault, hostname mismatch included — this
     *  gives up the authentication half of TLS and leaves only encryption
     *  (Mudlet's `mSslIgnoreAll`, labelled "unsecure" in its UI).
     *
     *  ⚠ All three are honoured only by the Node proxy. The Cloudflare Worker
     *  runtime's `connect()` exposes no way to inspect or override certificate
     *  validation, so a worker-backed profile silently ignores them. */
    sslIgnoreAll?: boolean;
    /** The plaintext port in use before an MSSP-advertised TLS upgrade, kept so
     *  a failed upgrade can be reverted in one click. Cleared once a secure
     *  connection has actually worked. */
    preTlsPort?: number;
    /** Free-text profile description (Mudlet's profile "description" field, read/
     *  written by getProfileInformation / setProfileInformation /
     *  clearProfileInformation). Lives on the connection record — not the VFS-
     *  backed profile settings — so it's editable from the connection screen and
     *  visible to `getProfiles()` for every profile (open or not, across tabs via
     *  the synced connection index) without mounting each profile. */
    description?: string;
}

/** Stock theme ids plus any brand-defined theme id (`BrandConfig.themes`) —
 *  the `(string & {})` arm admits custom ids while keeping autocomplete for
 *  the stock ones. */
export type Theme = 'dark' | 'light' | 'graylight' | 'amber' | 'sky' | (string & {});

/**
 * Where the output font came from. `system` is the default — a name typed by
 * the user or chosen from `navigator.fonts.query()`; nothing is registered.
 * `url` injects a `<link rel="stylesheet">` into <head> (e.g. Google Fonts).
 * `vfs` reads font bytes from the active profile's VFS and registers them via
 * the FontFace API. URL/VFS sources need to be re-applied on every page load.
 */
export type OutputFontSource =
    | { kind: 'system'; family: string }
    | { kind: 'url'; family: string; url: string }
    | { kind: 'vfs'; family: string; path: string };

/** App-wide preferences that apply regardless of which profile is active. */
export interface ClientSettings {
    /** Launcher/default theme — used by the connection screen (no profile open)
     *  and as the fallback when a profile sets no theme of its own. A profile's
     *  own `ProfileSettings.theme` overrides this while that profile is open. */
    theme: Theme;
    /** The user's own deployed proxy URL (from the deploy wizard). When set,
     *  ConnectionScreen uses this as the placeholder/default instead of
     *  DEFAULT_PROXY_URL, so new connections route through the user's worker. */
    userProxyUrl?: string;
    /** Opt-in to desktop notifications (Mudlet's `showNotification`). `undefined`
     *  / `false` means off — `showNotification` is a no-op until the user enables
     *  this in Settings, which is also where the browser permission prompt is
     *  triggered (a real user gesture), so the first script notification can fire
     *  without a surprise permission pop-up. */
    notificationsEnabled?: boolean;
}

/** Per-profile settings. Scripts (setBorder, setFont, setBackgroundColor, …) and
 *  the in-profile settings modal write here. Each field's value falls through to
 *  PROFILE_DEFAULTS when the profile hasn't overridden it. */
export interface ProfileSettings {
    /** Per-profile theme override. Undefined = fall through to the launcher
     *  theme (`ClientSettings.theme`). Applied to the document while this
     *  profile is the foreground/open one. */
    theme?: Theme;
    /** When true (default — treat `undefined` as true), MUDs may request a
     *  package install via the `Client.GUI` GMCP message (URL downloaded and
     *  installed automatically). Disable to ignore those requests. Per-profile
     *  so each MUD is trusted independently. */
    allowMudPackageInstall?: boolean;
    /** When true (default — treat `undefined` as true), MUDs may drive playback
     *  through the GMCP `Client.Media` messages (MCMP): files named by the
     *  server are downloaded into the profile's `media/` folder and played.
     *  Disable to ignore those messages outright — nothing is fetched and
     *  nothing plays, which is what separates this from `muteMediaGame` (that
     *  one still downloads and plays, just silently). Mudlet's
     *  `mAcceptServerMedia` / "Allow server to download and play media", and
     *  like Mudlet it gates GMCP only — MSP has its own switch in
     *  `protocols.msp`. Per-profile, so each MUD is trusted independently. */
    allowServerMedia?: boolean;
    /** When true (default), a server that advertises a TLS port via MSSP prompts
     *  once to switch to it. Declining sets this false so the offer never
     *  reappears for this profile. Mudlet calls it `mAskTlsAvailable`
     *  ("Allow secure connection reminder"), settable from Lua via
     *  `setProfileConfig("askTlsAvailable", …)`. */
    askTlsAvailable?: boolean;
    showTimestamps: boolean;
    fontSize: number;
    outputBackground: string;
    /** Default text color for the main output area. Empty/undefined = theme default. */
    outputForeground?: string;
    /** Background of the command-line input. Empty/undefined = theme default. */
    inputBackground?: string;
    /** Text color of the command-line input. Empty/undefined = theme default. */
    inputForeground?: string;
    /** Foreground color for the local echo of commands you send. Empty/undefined = #717100. */
    commandEchoForeground?: string;
    /** Background color for the local echo of commands you send. Empty/undefined = none. */
    commandEchoBackground?: string;
    outputFont?: OutputFontSource;
    /** Mudlet setWindowWrap("main", N). 0/undefined disables character-based wrap
     *  (text fills the window width). */
    outputWrapAt?: number;
    /** Mudlet setWindowWrapIndent("main", N). Indent (chars) of newline-started lines. */
    outputWrapIndent?: number;
    /** Mudlet setWindowWrapHangingIndent("main", N). Indent (chars) of wrapped continuation lines. */
    outputWrapHangingIndent?: number;
    /** Mudlet setBackgroundColor for the main window. rgba 0..255. Takes precedence over outputBackground when set. */
    outputBackgroundColor?: { r: number; g: number; b: number; a: number };
    /** Mudlet setBackgroundImage for the main window. `url` is the resolved
     *  image href for modes 1-3, or the raw stylesheet body for mode 4 (style).
     *  `mode` mirrors `mudlet.BgImageMode`: 1=border (stretched), 2=center,
     *  3=tile, 4=style. Cleared by resetBackgroundImage(). */
    outputBackgroundImage?: { url: string; mode: number };
    /** Mudlet setBorderTop/Bottom/Left/Right. Pixel insets carved from the main window for label placement; 0 / undefined = no border. */
    outputBorders?: { top: number; right: number; bottom: number; left: number };
    /** Mudlet setBorderColor — fill color for the carved border area. rgba 0..255; undefined = inherit page background. */
    outputBorderColor?: { r: number; g: number; b: number; a: number };
    /** User-overridden ANSI 16-color palette. Indices 0–7 are the dark colors
     *  (black, red, green, yellow, blue, magenta, cyan, white); 8–15 are the
     *  bright variants. Each entry is `#rrggbb` or undefined (fall through to
     *  the built-in default). `undefined` for the whole array = no override. */
    ansiPalette?: (string | undefined)[];
    /** Mudlet "Allow server to redefine your colors". When enabled, the server
     *  may remap the ANSI/256 palette at runtime via OSC 4 (set color) / OSC 104
     *  (reset). When disabled, those sequences are ignored and the user palette
     *  stands. Off by default — only an explicit `true` enables it. */
    serverRedefineColors?: boolean;
    /** Mudlet 5.0's `Host::mEnableOSC8Hyperlinks` ("Enable OSC 8 hyperlinks").
     *  When disabled, an OSC 8 sequence that *opens* a link is ignored so the
     *  text renders plain, and the whole `OSC_HYPERLINKS_*` NEW-ENVIRON
     *  capability block reports "0" — the two things Mudlet's toggle drives
     *  (TBuffer::decodeOSC and cTelnet::getNewEnvironOSCHyperlinks*). A
     *  *closing* sequence is always honoured, or a link open when the toggle
     *  flipped would never end. On by default: only an explicit `false`
     *  disables it, matching Mudlet's `= true` default. Unlike most of these,
     *  Mudlet exposes no `setConfig` key for it — preferences and the profile
     *  XML only — so mudix doesn't invent one either. */
    osc8Hyperlinks?: boolean;
    /** Mudlet 5.0's `Host::mUndoServerWrap` ("Undo the game's own wrapping",
     *  experimental). Rejoins the lines a game hard-wrapped itself before
     *  triggers see them, so a pattern can't be split mid-sentence; the client's
     *  own wrap then applies for display. Off by default. Also readable and
     *  writable from Lua as `getConfig`/`setConfig("undoServerWrap", …)`. */
    undoServerWrap?: boolean;
    /** The column the game wraps at, for {@link undoServerWrap} — Mudlet's
     *  `mUndoServerWrapWidth`, bounded 20–500 and defaulting to 80 (very often
     *  the right answer). `setConfig("undoServerWrapWidth", …)`. */
    undoServerWrapWidth?: number;
    /** Mudlet "Network packet timeout": how long (ms) to buffer a partial line
     *  (text after the last `\n` of a WebSocket frame) before flushing it as a
     *  prompt. Mitigates spurious mid-line breaks when long MUD lines arrive
     *  fragmented. `undefined` = use MudClient's built-in default (300ms). */
    promptTimeoutMs?: number;
    /** Per-area MapPanel last-viewed z-level. Each area remembers which level
     *  you were on so switching between areas (or reopening the panel) restores
     *  it. Zoom is no longer kept here — it lives in the map file (per-area
     *  userData, see {@link MapStore.setAreaZoom}); pan isn't remembered at all
     *  (areas open centered on the area's middle). Updated when the level
     *  changes. */
    mapViewStates?: Record<number, {
        level: number;
    }>;
    /** The area id the user was viewing last. Restored as the initial
     *  area on panel mount; the matching {@link mapViewStates} entry drives
     *  the initial level. Falls through to the first area in the map. */
    mapLastAreaId?: number;
    /** Whether the map widget's control bar — area picker, z-level buttons,
     *  options menu — is shown. Mudlet's `Host::mShowPanel`: toggled by the
     *  collapse arrow drawn over the map, readable/writable from Lua as
     *  `getConfig`/`setConfig("mapperPanelVisible", …)`, and persisted per
     *  profile (Mudlet keeps it in the profile XML as `mShowPanel`). Treat
     *  `undefined` as true, matching Mudlet's default. Note this hides only the
     *  bar — the map window itself is `openMapWidget`/`closeMapWidget`. */
    mapperPanelVisible?: boolean;
    /** Record gameplay output (and your echoed commands) to the persistent log
     *  store, browsable via the toolbar's Logs button. Treat `undefined` as
     *  enabled so existing profiles opt in without a migration; set to `false`
     *  to stop recording for this profile. */
    loggingEnabled?: boolean;
    /** Flash the browser tab title (Mudlet's taskbar-blink equivalent) when new
     *  server data arrives while the mudix tab/window is unfocused. Off unless
     *  explicitly set to true. */
    notifyOnNewData?: boolean;
    /** Mirror script/trigger/alias/timer errors into the main output window (in
     *  red), in addition to the script editor's Errors tab. Mudlet's "Show
     *  errors in main console" preference. Off unless explicitly set to true. */
    showErrorsInMainWindow?: boolean;
    /** Fullscreen mode: hide the top toolbar so the output area fills the whole
     *  window, revealing the toolbar only when the pointer nears the top edge (or
     *  it takes keyboard focus). Off unless explicitly set to true. */
    fullscreen?: boolean;
    /** User-tunable subset of mudlet-map-renderer's Settings object. Fields
     *  are forwarded onto the live renderer.settings on mount and whenever
     *  the user changes them in the Mapper tab. Missing fields fall through
     *  to MAPPER_DEFAULTS, which in turn defer to the renderer's own
     *  createSettings() default for anything we don't override. */
    mapper?: MapperSettings;
    /** Clear the command line after sending. When false (default), the input is
     *  selected-all instead so the next keystroke overtypes it. */
    autoClearInput?: boolean;
    /** Separator that splits one Enter into multiple commands (Mudlet's
     *  "command separator", default `;;`). Each split is run through aliases
     *  and sent independently. Empty string disables splitting. */
    commandSeparator?: string;
    /** Per-profile telnet protocol toggles. Patches merge so flipping one
     *  field doesn't wipe siblings. Missing fields fall through to
     *  PROTOCOL_DEFAULTS. Takes effect on the next connect. */
    protocols?: ProtocolSettings;
    /** Names of packages the user explicitly uninstalled. Consulted by
     *  `ensureDefaultPackages` so a deleted default/brand package stays
     *  deleted instead of reinstalling on the next profile open (Mudlet's
     *  `deletedDefaultMuds` equivalent). A name is removed again when the
     *  package is (re)installed. Recorded for every uninstall — non-default
     *  names are inert. */
    uninstalledPackages?: string[];
    /** Catch-all bag for Mudlet `setConfig`/`getConfig` option keys that have no
     *  dedicated structured home above (accessibility, input-line, and other
     *  preferences mudix persists for round-trip fidelity but does not yet act
     *  on). Keys with a structured home — protocol toggles, mapper settings,
     *  autoClearInput — are NOT stored here; the registry in ScriptingAPI reads
     *  and writes their real fields so the Settings UI stays in sync. Merged
     *  shallowly on patch like {@link mapper}/{@link protocols}. */
    config?: Record<string, unknown>;
}

/** Per-profile telnet protocol toggles. Each field gates the client's
 *  negotiation response for one option — see MudClientOptions for the
 *  wire-level meaning. Add a new entry here (and a toggle in the General
 *  tab + a `MudClient` switch) when exposing another option. */
export interface ProtocolSettings {
    /** Telnet GMCP (option 201). */
    gmcp?: boolean;
    /** Telnet TERMINAL-TYPE / MTTS (option 24). */
    mtts?: boolean;
    /** Telnet MSDP (option 69). */
    msdp?: boolean;
    /** Telnet MSSP (option 70). Mud Server Status Protocol — populates the
     *  read-only `mssp` Lua table with the server's self-reported status. */
    mssp?: boolean;
    /** Telnet CHARSET (option 42 / RFC 2066). When enabled, the client
     *  accepts the server's REQUEST and switches its byte→char codec to the
     *  agreed encoding — typically UTF-8. */
    charset?: boolean;
    /** Telnet MSP / MUD Sound Protocol (option 90). When enabled, inline
     *  `!!SOUND(...)` and `!!MUSIC(...)` tags are stripped from text and
     *  routed to the sound manager. */
    msp?: boolean;
    /** Telnet MCCP / MUD Client Compression Protocol (option 86 / MCCP2). When
     *  enabled, the client accepts the server's `WILL COMPRESS2` and transparently
     *  inflates the stream (via pako). On by default; disabling it forces
     *  compression off — the client ignores the server's offer and never sends
     *  `DO COMPRESS2`, so the stream stays uncompressed (Mudlet's
     *  `specialForceCompressionOff`). */
    mccp?: boolean;
    /** Telnet MXP / MUD eXtension Protocol (option 91). When enabled, the
     *  client negotiates MXP and parses in-band HTML-like markup — formatting
     *  tags, clickable `<SEND>`/`<A>` links, entities, and custom element
     *  definitions — from the text stream. On by default. */
    mxp?: boolean;
    /** Telnet MNES — Mud New-Environ Standard (option 39). When enabled, the
     *  client reports the five MNES core variables (CHARSET / CLIENT_NAME /
     *  CLIENT_VERSION / MTTS / TERMINAL_TYPE) to servers that request them. Off
     *  by default. MNES is the restricted subset of NEW-ENVIRON below; when both
     *  are on, MNES wins (matching Mudlet, which exposes them as two toggles over
     *  the same telnet option). */
    mnes?: boolean;
    /** Telnet NEW-ENVIRON — Client Variables Standard (option 39, RFC 1572). When
     *  enabled (and MNES off), the client reports the five core variables plus an
     *  extended capability set (ANSI, 256_COLORS, TRUECOLOR, UTF-8, TLS,
     *  WORD_WRAP, OSC_COLOR_PALETTE, OSC_HYPERLINKS_*, …) framed as USERVAR.
     *  On by default — this is the block servers' baudtests show, and it's how
     *  Mudlet reports itself. */
    newEnviron?: boolean;
    /** Telnet NAWS / Negotiate About Window Size (option 31). When enabled, the
     *  client offers NAWS and reports the main output area's character grid
     *  (columns × rows) to the server, re-sending it on every resize. On by
     *  default — servers use it for word-wrap and pagination. */
    naws?: boolean;
    /** WebSocket subprotocols to advertise in the opening handshake's
     *  `Sec-WebSocket-Protocol` header (RFC 6455), in preference order — the
     *  server selects at most one. These are mutually-exclusive stream *modes*,
     *  not layers (see {@link WS_SUBPROTOCOL_CHOICES}). Defaults to `['binary']`:
     *  the raw telnet stream over binary frames is exactly what mudix decodes,
     *  and `binary` is accepted by both FluffOS and servers like last-outpost.com.
     *  An empty list opens a bare socket (no header). Applies to direct
     *  `websocket`-mode connections; the bundled telnet proxy ignores it. */
    wsSubprotocols?: string[];
}

/** Defaults used when a protocol field is undefined. Off-by-default for MSDP
 *  matches Mudlet's "MSDP support" preference; GMCP/MTTS/CHARSET/MSP/MSSP are on
 *  by default because most modern MUDs expect them (Mudlet also enables MSSP by
 *  default — it's read-only status the server pushes once per connection). MSP is on so `!!SOUND/!!MUSIC`
 *  tags are stripped and routed to sound inline (the zMUD model — most MSP MUDs
 *  never negotiate option 90, they just emit the tags); the tag bytes are
 *  legitimate text on non-MSP MUDs but that collision is rare in practice. */
export const PROTOCOL_DEFAULTS: Required<ProtocolSettings> = {
    gmcp: true,
    mtts: true,
    msdp: false,
    mssp: true,
    charset: true,
    msp: true,
    mccp: true,
    mxp: true,
    mnes: false,
    newEnviron: true,
    naws: true,
    wsSubprotocols: ['binary'],
};

/** The WebSocket subprotocol names mudix can advertise, in canonical preference
 *  order. Mutually-exclusive stream modes the server picks *one* of — not
 *  layers that stack:
 *  - `binary`  — raw telnet byte stream over WebSocket binary frames. Every byte
 *                (IAC, GMCP/MSDP, MCCP, high-bit charset) survives; this is the
 *                only mode mudix's binary-frame decoder actually consumes.
 *  - `telnet`  — FluffOS binds this to the same telnet handler as `binary`; an
 *                alternate name some servers register instead of `binary`.
 *  - `telnet.mudstandards.org` — the mudstandards.org WebSocket proposal, same
 *                on-the-wire profile under the standardised name.
 *  (`ascii` — text frames with telnet stripped — is deliberately omitted: it's a
 *  dumb-terminal mode mudix can't decode.) The Settings UI renders one checkbox
 *  per entry; the selection is passed to MudClient in this order so the server
 *  sees `binary` first. */
export const WS_SUBPROTOCOL_CHOICES = ['binary', 'telnet', 'telnet.mudstandards.org'] as const;

/** The boolean-valued protocol toggles — every {@link ProtocolSettings} field
 *  except the `string[]` {@link ProtocolSettings.wsSubprotocols}. Helpers that
 *  flip a single on/off protocol (Lua's `enableProtocol`, Mudlet `<Host>`
 *  import) key off this so they never touch the list-valued field. */
export type BooleanProtocolKey = {
    [K in keyof ProtocolSettings]-?: NonNullable<ProtocolSettings[K]> extends boolean ? K : never;
}[keyof ProtocolSettings];

/** User-tunable subset of the map renderer's Settings. Add new entries here
 *  (and a matching control in the Settings modal + a wire-up in MapPanel) as
 *  more renderer options get exposed. Keep all fields optional so the
 *  patcher can ship partial updates and unset fields fall through to the
 *  renderer's own createSettings() defaults. */
export interface MapperSettings {
    /** renderer.settings.roomSize — diameter/side of a room in map units. */
    roomSize?: number;
    /** renderer.settings.roomShape. */
    roomShape?: 'rectangle' | 'circle' | 'roundedRectangle';
    /** renderer.settings.borders — draw a stroke around each room. */
    borders?: boolean;
    /** renderer.settings.lineWidth — exit/edge stroke width in map units. */
    lineWidth?: number;
    /** renderer.settings.backgroundColor — hex (#rrggbb). Unset defaults to
     *  opaque black (#000000), matching Mudlet's 2D map; a transparent canvas
     *  composited over the window/page behind it incorrectly. */
    backgroundColor?: string;
    /** renderer.settings.lineColor — exit color, hex (#rrggbb). */
    lineColor?: string;
    /** Mudlet `TMap::mShowDefaultArea` — whether the unnamed catch-all area
     *  rooms land in before they are filed anywhere is offered in the area
     *  list. Set from Lua by `setDefaultAreaVisible`; read by MapPanel's area
     *  dropdown. Visible unless turned off. */
    showDefaultArea?: boolean;
    /** renderer.settings.gridEnabled — background grid overlay. */
    gridEnabled?: boolean;
    /** renderer.settings.lodEnabled — level-of-detail for very dense planes.
     *  Above {@link lodExitBudget} rooms on the drawn (area, z-level) the
     *  renderer drops exit lines, and above {@link lodRoomBudget} it replaces
     *  the vector scene with a raster overview (one box per room) until you
     *  zoom back in. On by default: the tiers only engage at densities where
     *  the full vector scene takes seconds per rebuild anyway. */
    lodEnabled?: boolean;
    /** renderer.settings.lodRoomBudget — rooms per plane above which zoomed-out
     *  views switch to the raster overview. */
    lodRoomBudget?: number;
    /** renderer.settings.lodExitBudget — rooms per plane above which exit lines
     *  are dropped but rooms still draw as real vector shapes. Set at or above
     *  {@link lodRoomBudget} to skip this tier entirely. */
    lodExitBudget?: number;
    /** renderer.settings.lodHitTestBudget — rooms on screen above which the
     *  hit-test index is skipped, so clicks and hover stop resolving to a room
     *  until you zoom in further. Measured against what the current viewport
     *  materialises, not the whole level. */
    lodHitTestBudget?: number;
    /** renderer.settings.playerMarker — styling for the ring drawn on the
     *  player's room. */
    playerMarker?: PlayerMarkerSettings;
}

/** Styling for the player-position marker — the ring the renderer draws on
 *  whichever room `updatePositionMarker()` was last given.
 *
 *  Mirrors the renderer's `PlayerMarkerStyle` one field at a time, except for
 *  the dash pattern: the renderer takes a `number[]`, but a pair of scalars
 *  patches independently and survives the JSON round-trip more simply, so
 *  {@link dashLength}/{@link dashGap} are recombined into `[len, gap]` in
 *  applyMapperSettings. Every field is optional — unset ones fall through to
 *  the renderer's own createSettings() defaults. */
export interface PlayerMarkerSettings {
    /** Outline colour, hex (#rrggbb). */
    strokeColor?: string;
    /** Outline opacity, 0..1. */
    strokeAlpha?: number;
    /** Fill colour, hex (#rrggbb). Only visible when {@link fillAlpha} > 0. */
    fillColor?: string;
    /** Fill opacity, 0..1. 0 leaves the marker a hollow ring. */
    fillAlpha?: number;
    /** Outline thickness in map units (roughly 0.01–0.3). */
    strokeWidth?: number;
    /** Multiplier on `roomSize`. 1.0 makes the marker exactly room-sized;
     *  the renderer's default (1.7) rings the room from outside. */
    sizeFactor?: number;
    /** Dash length in map units — only drawn when {@link dashEnabled}. */
    dashLength?: number;
    /** Gap between dashes in map units — only drawn when {@link dashEnabled}. */
    dashGap?: number;
    /** Dash the outline instead of drawing it solid. */
    dashEnabled?: boolean;
    /** Follow {@link MapperSettings.roomShape} instead of always drawing a
     *  circle. Rectangle/rounded-rectangle rooms only; a circle room is
     *  already a circle. */
    matchRoomShape?: boolean;
}

/** Mirrors the renderer's createSettings() defaults so the Settings modal can
 *  show meaningful placeholder/fallback values when a field is still
 *  undefined. MapPanel itself does NOT use these — it only forwards fields
 *  that the user has actually set, so the renderer's own defaults stay in
 *  charge for anything untouched. */
export const PLAYER_MARKER_DEFAULTS: Required<PlayerMarkerSettings> = {
    strokeColor: '#00e5b2',
    strokeAlpha: 1,
    fillColor: '#00e5b2',
    fillAlpha: 0,
    strokeWidth: 0.1,
    sizeFactor: 1.7,
    dashLength: 0.05,
    dashGap: 0.05,
    dashEnabled: true,
    matchRoomShape: false,
};

export const MAPPER_DEFAULTS: Required<MapperSettings> = {
    roomSize: 0.6,
    roomShape: 'rectangle',
    borders: true,
    lineWidth: 0.025,
    backgroundColor: '#000000',
    lineColor: '#e1ffe1',
    showDefaultArea: true,
    gridEnabled: false,
    // LOD budgets mirror the renderer's createSettings() defaults; `lodEnabled`
    // deliberately does NOT (the renderer defaults it off for back-compat,
    // mudix opts in — see MapperSettings.lodEnabled).
    lodEnabled: true,
    lodRoomBudget: 16000,
    lodExitBudget: 12000,
    lodHitTestBudget: 10000,
    playerMarker: PLAYER_MARKER_DEFAULTS,
};

/** RGBA channels (0..255) for the map-info widget background. Stored in the
 *  profile `config` bag under `mapInfoColor` (Mudlet's `setConfig` key) and
 *  painted by MapPanel behind the map-info lines. */
export interface MapInfoBgColor { r: number; g: number; b: number; a: number; }

/** Mudlet's default `mapInfoColor` (mMapInfoBg) — translucent grey. */
export const MAP_INFO_BG_DEFAULT: MapInfoBgColor = { r: 150, g: 150, b: 150, a: 120 };

/** Defaults for profile settings. Reads fall through to these whenever a
 *  profile hasn't set the field. */
export const PROFILE_DEFAULTS: ProfileSettings = {
    showTimestamps: false,
    fontSize: 11,
    outputBackground: '',
    autoClearInput: false,
    commandSeparator: ';;',
};

// ── Tree node base ────────────────────────────────────────────────────────────

interface BaseNode {
    id: string;
    name: string;
    enabled: boolean;
    isGroup: boolean;       // true = folder/group that may contain children
    parentId: string | null; // null = root level
    /** When set, this node was installed by a package; uninstall removes all nodes with the same tag. */
    packageName?: string;
}

// ── Package manifest (Mudlet .mpackage / XML import) ─────────────────────────

export type PackageKind = 'package' | 'module';

export interface PackageManifest {
    name: string;
    version?: string;
    author?: string;
    title?: string;
    description?: string;
    /** Filename of the icon inside the package dir (e.g. "mudlet.png"), as declared in config.lua. */
    icon?: string;
    /** Author-declared creation date from config.lua (free-form string, often ISO-8601). */
    created?: string;
    /** Path of the XML file inside the package directory, relative to <profilePath>/<name>/ */
    xmlPath?: string;
    /**
     * Modules only: absolute VFS path of the XML, when the module references a file
     * that lives outside the managed package directory. Reload and sync read/write
     * this path verbatim and no pkgDir is ever created. Mutually exclusive with
     * `xmlPath` in practice — if both are set, `xmlVfsPath` wins.
     */
    xmlVfsPath?: string;
    /** Source filename (e.g. "GenericMapper.mpackage"), useful for display. */
    sourceFile?: string;
    /** Absolute VFS path the install was given, when it came from one. This is
     *  what `getModulePath` answers with: the file the user picked, not whatever
     *  was unpacked out of it — a script uses it to reinstall, or to point the
     *  user back at their own file, and neither works with an internal path. */
    sourcePath?: string;
    /**
     * Exactly what the package's `config.lua` declared, keys lower-cased,
     * unmapped and unaugmented.
     *
     * This is what `getPackageInfo`/`getModuleInfo` answer with, so it has to
     * stay the package author's own set: Mudlet reports what the manifest said
     * and nothing more, which means a package that shipped no config.lua has no
     * info at all rather than a table of things mudix worked out for itself
     * (the derived name, the install timestamp). Absent when there was no
     * config.lua to read.
     */
    declaredInfo?: Record<string, string>;
    /** When the package was installed via a remote URL (e.g. a `Client.GUI`
     *  GMCP message), records the originating URL so subsequent install
     *  requests for the same URL can be deduplicated against this manifest
     *  even when the on-disk package name differs from the filename. */
    sourceUrl?: string;
    /** The version the *server* declared for this URL in its `Client.GUI`
     *  message — a delivery revision, not the package's own version. Mudlet
     *  keeps these apart too (`Host::mServerGUI_Package_version`): the package
     *  manifest keeps whatever version its author wrote, and only this field
     *  decides whether a `Client.GUI` request is a re-delivery of something
     *  already installed. Writing the server's value into `version` instead
     *  would make `getPackageInfo(name).version` report the server's counter,
     *  breaking any package that self-updates off its own version. */
    sourceVersion?: string;
    /** Wall-clock install time, ISO-8601. */
    installedAt: string;
    /**
     * 'package' (default) — parsed once, nodes persist in the store, source files may be discarded.
     * 'module'           — XML on disk is the source of truth; reloaded on profile open. With `sync`
     *                      enabled, in-app edits to the module's nodes are written back to the XML.
     */
    kind?: PackageKind;
    /** Modules only: when true, mutations to this module's nodes are flushed back to the XML on disk. */
    sync?: boolean;
    /**
     * Modules only: load priority. Mirrors Mudlet's TPackage::mPriority. Default 0.
     * Negative-priority modules load before profile scripts (useful for setting up
     * infrastructure that profile scripts rely on); non-negative priorities load
     * after. Within the same priority, modules load in install order.
     */
    priority?: number;
}

// ── Item types (mirrors Mudlet's TScript / TAlias / TTrigger / TTimer / TKey) ──

export interface ScriptNode extends BaseNode {
    code: string;
    language: 'lua' | 'js';
    eventHandlers: string[]; // event names this script handles (Mudlet TScript.mEventHandlerList)
}

export interface AliasNode extends BaseNode {
    pattern: string;   // single regex string (Mudlet TAlias.mRegexCode)
    command: string;   // plain command to send (%1..%9 = capture groups); Mudlet TAlias.mCommand
    code: string;
    language: 'lua' | 'js';
}

export type TriggerPatternType =
    | 'substring'
    | 'regex'
    | 'startOfLine'
    | 'exactMatch'
    | 'luaFunction'
    | 'lineSpacer'
    | 'colorTrigger'
    | 'prompt';

export interface TriggerPattern {
    text: string;
    type: TriggerPatternType;
}

export interface TriggerNode extends BaseNode {
    patterns: TriggerPattern[];  // one or more patterns — any match fires (Mudlet TTrigger.mPatterns)
    code: string;
    language: 'lua' | 'js';
    fireLength: number;          // chain length: 0 = only the current line; N = current + N more lines (groups with patterns only)
    multipleMatches: boolean;    // fire once per regex occurrence on a line, not just the first
    multiline: boolean;          // AND mode: all patterns must match in sequence
    delta: number;               // 0 = unlimited; N = max lines from first condition match to last
    isFilter: boolean;           // filter chain: pass captured/matched text to children instead of full line
    /**
     * Session-scoped: created by `tempComplexRegexTrigger`, which needs a real
     * trigger node rather than the flat temp-trigger primitive because it can
     * ask for multiline-AND, a filter chain, a fire length, a line delta — all
     * of them properties of a node in the tree — and can be named as another
     * trigger's parent.
     *
     * Not persisted (see serializeProfileData), and neither is anything hanging
     * under it: a permanent trigger parented to a temporary one goes when its
     * parent does, so saving it would restore a child pointing at a parent that
     * no longer exists.
     */
    temporary?: boolean;
    /**
     * Mudlet TTrigger::mIsColorizerTrigger — the master switch for `highlight`.
     * The colours below persist independently of it (desktop defaults them to
     * red/yellow and writes them whatever the switch says), so turning
     * colorization off and back on keeps them. Read it through `isColorizing`,
     * never directly: profiles written before this field existed carry only
     * `highlight`, and a highlight there meant the switch was on.
     */
    colorize?: boolean;
    highlight?: {                // built-in colorization applied to the matched text
        fg?: string;             // hex color e.g. "#ff0000"
        bg?: string;             // a channel left unset is Mudlet's "keep" (transparent)
    };
    command?: string;            // plain command to send on fire (%1..%9 = capture groups)
}

export interface TimerNode extends BaseNode {
    seconds: number;
    code: string;
    language: 'lua' | 'js';
    repeat: boolean;
    command?: string;    // plain command to send when the timer fires
}

export interface KeyNode extends BaseNode {
    key: string;         // KeyboardEvent.code value, e.g. "F1", "KeyA", "Numpad1"
    modifiers: string[]; // subset of ["ctrl", "shift", "alt", "meta"]
    code: string;
    language: 'lua' | 'js';
    command?: string;    // plain command to send when the keybinding fires
}

export type ButtonLocation = 'top' | 'bottom' | 'left' | 'right' | 'floating';
export type ButtonOrientation = 'horizontal' | 'vertical';

/**
 * Mudlet-style action node. Groups are toolbars; leaves are buttons.
 * Mirrors Mudlet's TAction (mLocation/mOrientation/mPushDownButton/...).
 * `styleSheet` is persisted but not applied yet (no stylesheet support).
 */
export interface ButtonNode extends BaseNode {
    // ── Group fields (toolbar) ──────────────────────────────────────────
    orientation: ButtonOrientation;
    location: ButtonLocation;
    /** Number of columns for the toolbar grid. 0 = auto / single line (Mudlet TToolBar.mButtonColumns). */
    columns: number;
    /** Floating-toolbar geometry (groups with location='floating'). */
    posX?: number;
    posY?: number;
    sizeX?: number;
    sizeY?: number;

    // ── Button fields (leaf) ────────────────────────────────────────────
    /** Two-state (push-down) button. */
    isPushDown: boolean;
    /** Current state for two-state buttons (false = up, true = down). */
    buttonState: boolean;
    /** Path to icon image, relative to the profile VFS root (typically inside a package dir). */
    icon?: string;
    tooltip?: string;

    // ── Actions ─────────────────────────────────────────────────────────
    /** Lua code; runs on every click regardless of state direction (Mudlet TAction.mScript). */
    code: string;
    language: 'lua' | 'js';
    /** Command sent on single-state click OR when a two-state button goes UP (Mudlet commandButtonUp). */
    command?: string;
    /** Command sent only when a two-state button goes DOWN (Mudlet commandButtonDown). */
    commandDown?: string;

    /** Accepted but currently unused — Mudlet stylesheet text. */
    styleSheet?: string;
}

/**
 * Whether a trigger colorizes the text it matched. `colorize` is authoritative;
 * a trigger from a profile saved before that field existed falls back to the old
 * rule, where a highlight's presence was itself the switch.
 */
export function isColorizing(t: Pick<TriggerNode, 'colorize' | 'highlight'>): boolean {
    return t.colorize ?? !!t.highlight;
}

// ── Tree utilities ────────────────────────────────────────────────────────────

/** Returns true if the item and all its ancestors are enabled. */
export function isEffectivelyEnabled<T extends { id: string; enabled: boolean; parentId: string | null }>(
    item: T,
    allItems: T[],
): boolean {
    const byId = new Map(allItems.map(i => [i.id, i]));
    let node: { enabled: boolean; parentId: string | null } | undefined = item;
    while (node) {
        if (!node.enabled) return false;
        if (!node.parentId) break;
        node = byId.get(node.parentId);
    }
    return true;
}

/**
 * One-pass build of the set of ids whose item and every ancestor is enabled.
 * Engines iterating large trees should call this once per loadPerm rather than
 * isEffectivelyEnabled per item — that path is O(N²) (rebuilds the id map on
 * every call); this is O(N) amortized via memoization.
 */
export function buildEffectivelyEnabledIds<T extends { id: string; enabled: boolean; parentId: string | null }>(
    items: T[],
): Set<string> {
    const byId = new Map<string, T>(items.map(i => [i.id, i]));
    const memo = new Map<string, boolean>();
    const visit = (item: T): boolean => {
        const cached = memo.get(item.id);
        if (cached !== undefined) return cached;
        // Tentatively mark enabled so a malformed cycle resolves rather than
        // recursing forever; overwritten below with the real answer.
        memo.set(item.id, true);
        if (!item.enabled) { memo.set(item.id, false); return false; }
        if (!item.parentId) return true;
        const parent = byId.get(item.parentId);
        const ok = !parent || visit(parent);
        memo.set(item.id, ok);
        return ok;
    };
    const out = new Set<string>();
    for (const item of items) if (visit(item)) out.add(item.id);
    return out;
}

export interface ModalBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Mudlet saveWindowLayout/loadWindowLayout snapshot — frozen copy of the
 * window hints + dock extents at the moment the script called save. A later
 * loadWindowLayout() re-applies these values to the live WindowManager.
 */
export interface WindowLayoutSnapshot {
    hints: Record<string, WindowOpenOptions>;
    dockExtents: Record<string, number>;
}

export interface ScriptEditorBounds extends ModalBounds {
    listWidth?: number;
}

/**
 * Mudlet saved-variables state for one profile (its `<VariablePackage>`).
 * `saveList` is the user-curated set of top-level global names flagged to
 * persist (Mudlet's VarUnit::mSaveList) — this is the configuration the
 * Variables view edits. `values` is the last captured snapshot of those
 * globals' contents, restored into `_G` on the next profile open. Captured
 * fresh from the live Lua state on each profile save, so it can lag the
 * running session between saves without harm.
 */
export interface ProfileVariables {
    saveList: string[];
    values: MudletVariable[];
}

export interface AppSchema {
    connections: MudConnection[];
    /** App-wide preferences that apply regardless of which profile is active
     *  (currently just theme). Settable from both the connection screen and
     *  in-profile settings modal. */
    client: ClientSettings;
    /** Per-profile setting overrides. Scripts (setBorderBottom, setFont, …)
     *  and the in-profile settings modal write here; unset fields fall through
     *  to PROFILE_DEFAULTS so script mutations stay scoped to one profile. */
    connectionProfile: Record<string, Partial<ProfileSettings>>;
    connectionWindowHints: Record<string, Record<string, WindowOpenOptions>>;
    /** Per-connection dock area extents: { left, right, top, bottom } in pixels. */
    connectionDockExtents: Record<string, Record<string, number>>;
    connectionScripts: Record<string, ScriptNode[]>;
    connectionAliases: Record<string, AliasNode[]>;
    connectionTriggers: Record<string, TriggerNode[]>;
    connectionTimers: Record<string, TimerNode[]>;
    connectionKeybindings: Record<string, KeyNode[]>;
    connectionButtons: Record<string, ButtonNode[]>;
    connectionScriptEditorBounds: Record<string, ScriptEditorBounds>;
    connectionModalBounds: Record<string, Record<string, ModalBounds>>;
    connectionPackages: Record<string, PackageManifest[]>;
    /** Per-connection saveWindowLayout snapshot — captured by Lua's
     *  `saveWindowLayout()`, restored by `loadWindowLayout()`. Missing key
     *  means no snapshot exists yet for that connection. */
    connectionLayoutSnapshots: Record<string, WindowLayoutSnapshot>;
    /** Per-connection Mudlet saved-variables (save-list + last captured values).
     *  Persisted in the profile VFS like the automation slices, not localStorage.
     *  Missing key = nothing flagged to save for that profile. */
    connectionVariables: Record<string, ProfileVariables>;
}

export const APP_DEFAULTS: AppSchema = {
    connections: [],
    client: { theme: 'dark' },
    connectionProfile: {},
    connectionWindowHints: {},
    connectionDockExtents: {},
    connectionScripts: {},
    connectionAliases: {},
    connectionTriggers: {},
    connectionTimers: {},
    connectionKeybindings: {},
    connectionButtons: {},
    connectionScriptEditorBounds: {},
    connectionModalBounds: {},
    connectionPackages: {},
    connectionLayoutSnapshots: {},
    connectionVariables: {},
};

/**
 * Reads a single ProfileSettings field for `connectionId`, falling through to
 * PROFILE_DEFAULTS when the profile hasn't set it. Returns the default when
 * `connectionId` is null (no active profile). Designed as a Zustand selector:
 * `useAppStore(s => selectProfileField(s, id, 'fontSize'))`.
 */
export function selectProfileField<K extends keyof ProfileSettings>(
    s: Pick<AppSchema, 'connectionProfile'>,
    connectionId: string | null,
    key: K,
): ProfileSettings[K] {
    if (connectionId) {
        const v = s.connectionProfile[connectionId]?.[key];
        if (v !== undefined) return v as ProfileSettings[K];
    }
    return PROFILE_DEFAULTS[key];
}

export function connectionUrl(c: MudConnection, userProxyUrl?: string): string {
    if (c.mode === 'mud') {
        // Precedence: connection-level proxy > user's deployed proxy > brand
        // proxy (white-label builds) > built-in default.
        const base = (c.proxyUrl?.trim() || userProxyUrl || getBrand().proxyUrl || DEFAULT_PROXY_URL).replace(/\/$/, '');
        let url = `${base}?host=${encodeURIComponent(c.host ?? '')}&port=${c.port ?? 23}`;
        if (c.tls) {
            // Ask the proxy to wrap the game socket in TLS. The cert-tolerance
            // flags are only sent when actually set, so an older proxy that
            // doesn't understand them still sees a URL it can parse.
            url += '&tls=1';
            if (c.sslIgnoreExpired) url += '&tlsIgnoreExpired=1';
            if (c.sslIgnoreSelfSigned) url += '&tlsIgnoreSelfSigned=1';
            if (c.sslIgnoreAll) url += '&tlsIgnoreAll=1';
        }
        return url;
    }
    return c.url ?? '';
}

/** The proxy a `mud`-mode connection will actually dial, applying the same
 *  precedence as {@link connectionUrl}: per-connection > user's own > brand >
 *  built-in default. */
export function effectiveProxyUrl(c: MudConnection, userProxyUrl?: string): string {
    return (c.proxyUrl?.trim() || userProxyUrl || getBrand().proxyUrl || DEFAULT_PROXY_URL).replace(/\/$/, '');
}

/**
 * Whether a proxy can inspect the game's certificate — and therefore whether
 * the "accept expired / self-signed / all" options mean anything.
 *
 * Only the Node proxy can: it uses `tls.connect` and reads the peer certificate.
 * A Cloudflare Worker cannot, because `cloudflare:sockets` `connect()` exposes
 * no certificate and no way to waive a validation failure — the options would be
 * silently ignored, so the UI disables them instead of pretending.
 *
 * Recognised by the `workers.dev` hostname, which covers the built-in default
 * proxy and anything deployed from `worker/`. A Worker on a custom domain can't
 * be told apart from a Node proxy up front; that case is corrected at runtime by
 * the `certInspection: false` flag the proxy reports on `tls.established`.
 */
export function proxyCanInspectCertificates(proxyUrl: string): boolean {
    try {
        // The scheme is ws/wss; URL parses those fine.
        const host = new URL(proxyUrl).hostname.toLowerCase();
        return !(host === 'workers.dev' || host.endsWith('.workers.dev'));
    } catch {
        return true; // unparseable — don't hide controls on a guess
    }
}

export function connectionDisplayAddr(c: MudConnection): string {
    if (c.mode === 'mud') return `${c.host ?? ''}:${c.port ?? 23}`;
    return c.url ?? '';
}

/** Whether the connection's link to the *game server* is TLS-encrypted — the
 *  signal reported as the NEW-ENVIRON `TLS` variable. In `websocket` mode the
 *  browser connects straight to the game, so a `wss://` URL is end-to-end TLS.
 *  In `mud` (proxy) mode the browser↔proxy hop being `wss://` says nothing about
 *  the proxy↔game hop: that leg is a plaintext telnet socket unless `tls` is set,
 *  which makes the proxy perform a TLS handshake with the game instead. */
export function connectionSecureTransport(c: MudConnection): boolean {
    if (c.mode === 'mud') return !!c.tls;
    return (c.url ?? '').trim().toLowerCase().startsWith('wss://');
}

/**
 * Whether `name` is already some other profile's, ignoring case.
 *
 * Case-insensitively, because that is how the scripting API resolves a profile
 * name (`getProfileInformation("ACHAEA")` finds the Achaea profile — Mudlet
 * looks the name up as a folder and the platforms it runs on mostly have
 * case-insensitive ones). Two profiles differing only in case would make those
 * calls pick between them arbitrarily.
 *
 * `exceptId` is the profile being edited, so renaming one to its own name is
 * not a clash.
 */
export function connectionNameTaken(name: string, connections: MudConnection[], exceptId?: string): boolean {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return false;
    return connections.some(c => c.id !== exceptId && c.name.trim().toLowerCase() === wanted);
}

/**
 * `name` if no other profile has it, otherwise the first free `name (2)`,
 * `name (3)`, … — the same shape Mudlet gives a profile copied over an existing
 * one.
 *
 * A last line of defence for the paths that create a profile without a form to
 * validate: importing a Mudlet folder or zip, seeding a brand's profile, or
 * starting a bundled game. Those must not fail on a name clash, but they must
 * not produce two profiles sharing a name either — `getProfiles()` is keyed by
 * name and would silently return only one of them, and every name-addressed
 * script API would resolve to whichever came first.
 */
export function uniqueConnectionName(name: string, connections: MudConnection[], exceptId?: string): string {
    const base = name.trim();
    if (!connectionNameTaken(base, connections, exceptId)) return base;
    for (let n = 2; ; n++) {
        const candidate = `${base} (${n})`;
        if (!connectionNameTaken(candidate, connections, exceptId)) return candidate;
    }
}
