import { ViewportModeProvider } from './hooks/useViewportMode';
import { useEffect, useRef, useState } from 'react';
import { MAP_WIDGET_ID } from './ui/windows/types';
import { useMudSession } from './hooks/useMudSession';
import { useAutoReconnect } from './hooks/useAutoReconnect';
import { useEngines } from './hooks/useEngines';
import { Toolbar } from './ui/Toolbar';
import { CommandBar } from './ui/CommandBar';
import { BufferWordIndex } from './ui/bufferWords';
import { ContentLayout } from './ui/layout/ContentLayout';
import { ScriptEditorModal } from './ui/windows/ScriptEditorModal';
import { SettingsModal } from './ui/SettingsModal';
import { FileBrowserModal } from './ui/FileBrowserModal';
import { LogBrowserModal } from './ui/LogBrowserModal';
import { ScriptingDocsModal } from './ui/ScriptingDocsModal';
import { HelpModal } from './ui/HelpModal';
import { CharLoginModal } from './ui/CharLoginModal';
import { TlsUpgradeModal } from './ui/TlsUpgradeModal';
import { TlsAlertBanner } from './ui/TlsAlertBanner';
import { applyMsspVariable, emptyMsspTlsFacts, shouldOfferTlsUpgrade } from './mud/protocol/msspTls';
import {
    CHAR_LOGIN_SILENT_DROP_MESSAGE, charLoginFailureMessage, decideCharLoginRequest,
} from './mud/protocol/charLoginFlow';
import { describeCertCode, describeTlsFailure } from './mud/protocol/tlsCodes';
import type { TlsStatus } from './mud/events';
import { QuickOpenPalette } from './ui/QuickOpenPalette';
import { SessionLogger } from './logging/SessionLogger';
import { useAppStore, selectProfileField, ConnectionIdContext, connectionUrl, connectionSecureTransport, PROTOCOL_DEFAULTS, type MudConnection } from './storage';
import { DEFAULT_STICKY_LINES } from './hooks/useOutput';
import { applyOutputFont, primeLocalFontsCache } from './utils/fontLoader';
import { setBaseTitle, flashTitle, clearTitleFlash } from './utils/documentTitle';
import { getBrand, isBrandedMode } from './branding';
import { setSessionCredentials } from './utils/sessionCredentials';
import { readStoredLogin, pruneVaultEntries } from './utils/storedCredentials';
import { vaultNeedsUnlock } from './vault/vaultAccess';
import { useVaultSaver } from './ui/useVaultSaver';
import { VaultUnlockPrompt } from './ui/VaultUnlockPrompt';
import { applyAnsiPalette, setServerRedefineColorsAllowed, resetAllPaletteColors } from './mud/text/colors';
import { setOsc8HyperlinksEnabled } from './mud/text/hyperlinkConfig';
import { DEFAULT_CONSOLE_BUFFER_SIZE } from './mud/text/Console';
import type { MudSession, ControlCharacterMode } from './mud/MudSession';
import type { FileDialogRequest } from './mud/events';
import { replayFileName } from './mud/replay/replayFormat';
import { isTextEntryTarget } from './mud/keybindings/keyEventTarget';
import { FilePickerModal } from './ui/FilePickerModal';
import type { ProfileVFS } from './scripting/vfs/ProfileVFS';

// Mudlet parity (AUTO_LOGIN_USERNAME_DELAY_MS in Mudlet's cTelnet): how long
// to wait after connecting, with no IAC GA/EOR prompt marker seen, before
// sending the saved account name anyway. See the text-login auto-fill effect
// in ProfileSession for why this fallback exists.
const AUTO_LOGIN_USERNAME_FALLBACK_MS = 2000;

// Mudlet parity (AUTO_LOGIN_PASSWORD_DELAY_MS in Mudlet's cTelnet): how long to
// wait after sending the account name, with no ECHO-off signal seen, before
// sending the password anyway. Mudlet's slot_send_pass is timer-driven and
// explicitly independent of ECHO mode, because plenty of servers print a bare
// "Password:" prompt without ever negotiating IAC WILL ECHO (Federation 2 is
// one). Gating solely on ECHO leaves the password unsent forever on those.
const AUTO_LOGIN_PASSWORD_FALLBACK_MS = 1000;

interface Props {
    connection: MudConnection;
    /** If true, dial the WebSocket on mount. Offline mode skips this. */
    autoConnect: boolean;
    /** The profile's VFS, mounted by App before this renders. Available
     *  synchronously here (and to children), so first-render reads see it. */
    vfs: ProfileVFS | null;
    settingsOpen: boolean;
    onToggleSettings: () => void;
    onCloseProfile: () => void;
}

export function ProfileSession({ connection, autoConnect, vfs, settingsOpen, onToggleSettings, onCloseProfile }: Props) {
    const { session, status, ping, passwordMode, connect, disconnect, send } = useMudSession();

    const [command, setCommand] = useState('');
    const [scriptsOpen, setScriptsOpen] = useState(false);
    const [filesOpen, setFilesOpen] = useState<false | { initialPath?: string; initialLine?: number; pickedAt?: number }>(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [docsOpen, setDocsOpen] = useState(false);
    const [helpOpen, setHelpOpen] = useState(false);
    const [quickOpenOpen, setQuickOpenOpen] = useState(false);
    // GMCP Char.Login credentials popup. Non-null while the server is waiting on
    // a Char.Login.Default reply; `error` carries a previous attempt's failure.
    const [charLogin, setCharLogin] = useState<{ error?: string } | null>(null);
    // The MSSP-advertised secure-port offer. Non-null while the question is on
    // screen; `port` is the port the server says speaks TLS.
    const [tlsOffer, setTlsOffer] = useState<{ port: number } | null>(null);
    // Outcome of a TLS connection attempt, surfaced in the toolbar//status and
    // used to explain a failed upgrade. Null before anything is known.
    const [tlsStatus, setTlsStatus] = useState<TlsStatus | null>(null);
    // MSSP facts for this connection, and a latch so a server that re-sends its
    // status block can't stack duplicate offers. Refs, not state: they're read
    // inside event handlers and must never trigger a re-render themselves.
    const msspTlsFacts = useRef(emptyMsspTlsFacts());
    const tlsPromptInFlight = useRef(false);
    // `connection` is a snapshot taken when the profile was opened — App holds it
    // in state and never re-reads it. The TLS flow rewrites port/tls/preTlsPort
    // in the store, so anything rendered from those must use the live record.
    const liveConnection = useAppStore(s => s.connections.find(c => c.id === connection.id)) ?? connection;
    // Pending Lua invokeFileDialog requests. Each parks a Lua handler until its
    // onPick fires, so requests queue up and resolve strictly one at a time.
    const [fileDialogs, setFileDialogs] = useState<FileDialogRequest[]>([]);
    const [cmdLineSuggestions, setCmdLineSuggestions] = useState<string[]>([]);
    const [cmdLineBlacklist, setCmdLineBlacklist] = useState<string[]>([]);
    const [saveCommandHistory, setSaveCommandHistory] = useState(true);
    const [bufferWords, setBufferWords] = useState<BufferWordIndex | null>(null);
    // Mudlet-format replay: Record button state + the active playback's speed
    // (null while nothing is playing — the toolbar controls only render then).
    const [replayRecording, setReplayRecording] = useState(false);
    const [replaySpeed, setReplaySpeed] = useState<number | null>(null);
    const commandInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
    const windowContextMenuHandlerRef = useRef<((e: React.MouseEvent) => void) | null>(null);

    // Live mirror of the current command bar text — read by Lua's getCmdLine()
    // through the provider registered on the engine. Updated in render so the
    // provider always returns the latest value the user has typed.
    const commandRef = useRef(command);
    commandRef.current = command;
    // Last command actually sent. Used by the password-mode useEffect to tell
    // the leftover character-name case ("MyChar" still showing when the server
    // toggles ECHO) apart from a freshly-typed partial password.
    const lastSentRef = useRef('');
    // Auto-login state. `autoLoginStage` drives the text-login state machine
    // (send account at the first prompt, password when the server enters
    // password mode). `gmcpAutoTried` guards against re-sending stored GMCP
    // credentials in a loop when they're wrong. Both reset on each connect.
    const autoLoginStage = useRef<'idle' | 'name' | 'password'>('idle');
    const gmcpAutoTried = useRef(false);
    // Set when the user picks "Use text login" in the credentials popup. Servers
    // may re-send Char.Login.Default while their text login runs (StickMUD does,
    // once per menu step) — without this the form would keep re-appearing over
    // the very prompts the user chose to answer by hand. Reset on each connect.
    const gmcpLoginDeclined = useRef(false);
    // The account last handed to the server this connection (typed or auto-sent),
    // so a rejected attempt can re-open the popup on the account the player
    // actually used. Without it the retry form is prefilled from storage — which
    // is empty whenever "remember" was off — and they retype everything. The
    // password is deliberately not kept: it was just rejected, so the retry form
    // opens with it blank and the cursor already in that field.
    const lastLoginAttempt = useRef<{ account: string; save: boolean } | null>(null);
    // Reason text while the credential vault's unlock prompt is up, else null.
    const [vaultUnlock, setVaultUnlock] = useState<string | null>(null);
    // Set when the GMCP login request is the thing waiting on that unlock, so
    // dismissing the prompt falls through to the manual credentials form rather
    // than leaving the server waiting for a reply that never comes.
    const vaultPendingCharLogin = useRef(false);
    // "Not now" on the unlock prompt, remembered for this connection: a server
    // that re-asks for credentials must not re-raise a prompt already refused.
    // Cleared on each connect.
    const vaultDeclined = useRef(false);
    // Set while credentials are in flight and the server has said nothing back.
    // Cleared by a Char.Login.Result, by any server output (a game that lets us
    // in starts talking immediately), and by a disconnect the player asked for.
    // Still set at a disconnect ⇒ the game hung up on the login without a word,
    // which is worth saying out loud — see CHAR_LOGIN_SILENT_DROP_MESSAGE.
    const charLoginUnanswered = useRef(false);
    // Fallback timer for MUDs that never send IAC GA/EOR around their login
    // prompt (e.g. plain FluffOS/LPMud bare-telnet banners) — see the
    // text-login auto-fill effect below.
    const nameFallbackTimer = useRef<number | null>(null);
    // Fallback timer for MUDs that never switch ECHO off around their password
    // prompt — see the text-login auto-fill effect below.
    const passFallbackTimer = useRef<number | null>(null);

    const outputFont = useAppStore(s => selectProfileField(s, connection.id, 'outputFont'));
    const promptTimeoutMs = useAppStore(s => selectProfileField(s, connection.id, 'promptTimeoutMs'));
    const ansiPalette = useAppStore(s => selectProfileField(s, connection.id, 'ansiPalette'));
    const serverRedefineColors = useAppStore(s => selectProfileField(s, connection.id, 'serverRedefineColors'));
    const osc8Hyperlinks = useAppStore(s => selectProfileField(s, connection.id, 'osc8Hyperlinks'));
    const undoServerWrap = useAppStore(s => selectProfileField(s, connection.id, 'undoServerWrap'));
    const undoServerWrapWidth = useAppStore(s => selectProfileField(s, connection.id, 'undoServerWrapWidth'));
    const consoleBufferSize = useAppStore(s => selectProfileField(s, connection.id, 'consoleBufferSize'));
    const useMaxConsoleBufferSize = useAppStore(s => selectProfileField(s, connection.id, 'useMaxConsoleBufferSize'));
    /** The preference pair last pushed onto the session, so a re-render does not
     *  re-push it over a size a script set. Undefined until the first apply. */
    const appliedBufferSize = useRef<[number | undefined, boolean | undefined]>([undefined, undefined]);
    const autoClearInput = useAppStore(s => selectProfileField(s, connection.id, 'autoClearInput')) === true;
    const commandEchoForeground = useAppStore(s => selectProfileField(s, connection.id, 'commandEchoForeground'));
    const commandEchoBackground = useAppStore(s => selectProfileField(s, connection.id, 'commandEchoBackground'));
    // The saved GMCP Char.Login account. Not a secret, and it lives on the
    // connection record rather than in the VFS-backed profile settings so the
    // connection editor can read/write it without mounting the profile. The
    // password that goes with it lives in the credential vault — see
    // utils/storedCredentials for the full priority order.
    const charLoginAccount = useAppStore(s => s.connections.find(c => c.id === connection.id)?.charLoginAccount);
    const vaultSaver = useVaultSaver();
    const patchConnection = useAppStore(s => s.patchConnection);
    const protocols = useAppStore(s => selectProfileField(s, connection.id, 'protocols'));
    const gmcpEnabled = protocols?.gmcp ?? PROTOCOL_DEFAULTS.gmcp;
    const mttsEnabled = protocols?.mtts ?? PROTOCOL_DEFAULTS.mtts;
    const msdpEnabled = protocols?.msdp ?? PROTOCOL_DEFAULTS.msdp;
    const msspEnabled = protocols?.mssp ?? PROTOCOL_DEFAULTS.mssp;
    const charsetEnabled = protocols?.charset ?? PROTOCOL_DEFAULTS.charset;
    const mspEnabled = protocols?.msp ?? PROTOCOL_DEFAULTS.msp;
    const mccpEnabled = protocols?.mccp ?? PROTOCOL_DEFAULTS.mccp;
    const mxpEnabled = protocols?.mxp ?? PROTOCOL_DEFAULTS.mxp;
    const mnesEnabled = protocols?.mnes ?? PROTOCOL_DEFAULTS.mnes;
    const newEnvironEnabled = protocols?.newEnviron ?? PROTOCOL_DEFAULTS.newEnviron;
    const nawsEnabled = protocols?.naws ?? PROTOCOL_DEFAULTS.naws;
    const wsSubprotocols = protocols?.wsSubprotocols ?? PROTOCOL_DEFAULTS.wsSubprotocols;
    // Undefined defaults to enabled (see ProfileSettings.loggingEnabled).
    const loggingEnabled = useAppStore(s => selectProfileField(s, connection.id, 'loggingEnabled')) !== false;
    // Flash the tab title when server data arrives while the tab is unfocused
    // (Mudlet's "notify on new data" / taskbar blink). Off unless explicitly on.
    const notifyOnNewData = useAppStore(s => selectProfileField(s, connection.id, 'notifyOnNewData')) === true;
    // Mudlet's "Show errors in main console": mirror script errors into the main
    // output window (red), not just the script editor's Errors tab. Off by default.
    const showErrorsInMainWindow = useAppStore(s => selectProfileField(s, connection.id, 'showErrorsInMainWindow')) === true;
    const fullscreen = useAppStore(s => selectProfileField(s, connection.id, 'fullscreen')) === true;
    // Mudlet's `showTabConnectionIndicators` (config bag). Defaults to true; when
    // on, the window title is prefixed with a connection-status dot. mudix has no
    // tab strip, so the indicator (and always the profile name) live in the title.
    const profileConfig = useAppStore(s => selectProfileField(s, connection.id, 'config'));
    const showConnectionIndicator = (profileConfig?.showTabConnectionIndicators as boolean | undefined) ?? true;
    // Mudlet's "enable blinking text" (config bag). When on, ANSI blink (SGR
    // 5/6) renders as a smooth opacity pulse; when off (the default) it's shown
    // in italics instead. The blink classes are always emitted by
    // FormatState.toHtml — this root class picks the presentation (see
    // App.css). Toggled on the document root so it covers the main output, user
    // windows, and mini-consoles alike.
    const blinkTextEnabled = (profileConfig?.enableBlinkText as boolean | undefined) ?? false;
    const connectionWindowHints = useAppStore(s => s.connectionWindowHints);
    const connectionDockExtents = useAppStore(s => s.connectionDockExtents);
    const saveWindowHint = useAppStore(s => s.saveWindowHint);
    const saveDockExtents = useAppStore(s => s.saveDockExtents);

    // Seed window hints + dock extents on the fresh session synchronously during
    // render. They must be in place before child useEffects fire (e.g. DockRoot
    // emitting output.ready, which triggers scripts that call windows.open).
    // Keyed by session identity so the StrictMode synthetic swap re-seeds too.
    const seededFor = useRef<MudSession | null>(null);
    if (seededFor.current !== session) {
        seededFor.current = session;
        const hints   = connectionWindowHints[connection.id] ?? {};
        const extents = connectionDockExtents[connection.id];
        if (extents) session.windows.setDockExtentsFromStorage(extents);
        session.windows.setConnectionId(connection.id);
        session.windows.setWindowHints(hints);
    }
    // Protocol toggles need to be on the session's options before the
    // autoConnect effect dials — the MudClient reads them at construction. Set
    // synchronously during render (matching the seededFor pattern); user-driven
    // toggles after the first connect take effect on the next reconnect.
    // Advertise the configured WebSocket subprotocols (see
    // ProtocolSettings.wsSubprotocols) — but only for direct websocket-mode
    // connections. Proxy (`mud`) mode dials the telnet→WS proxy, which speaks a
    // raw telnet byte stream over binary frames negotiated out of band; it does
    // not select a subprotocol, and advertising one breaks proxies that don't
    // echo it back in the 101 (e.g. a Cloudflare Worker). Default ['binary']
    // otherwise — the raw telnet stream mudix decodes.
    const subprotocols = connection.mode === 'mud' ? [] : [...wsSubprotocols];
    // The NEW-ENVIRON TLS variable describes the game-facing link: a direct
    // wss:// connection is TLS, and in proxy mode it depends on whether the
    // profile asked the proxy to encrypt the upstream leg. Read live, so a TLS
    // upgrade is reported correctly on the connection it takes effect on.
    const secureTransport = connectionSecureTransport(liveConnection);
    // Mudlet's `advertiseScreenReader` (config bag). Read like the protocol
    // toggles above — the MTTS/NEW-ENVIRON negotiation only runs at connect
    // time, so a mid-session change takes effect on the next reconnect.
    const screenReaderAdvertised = (profileConfig?.advertiseScreenReader as boolean | undefined) ?? false;
    // Mudlet 5.0's mEnableOSC8Hyperlinks. Feeds the NEW-ENVIRON capability block
    // here (connect-time, like the toggles above); the rendering half is the
    // parser gate applied in an effect below.
    const osc8HyperlinksEnabled = osc8Hyperlinks !== false;
    session.setProtocolOptions({ gmcpEnabled, mttsEnabled, msdpEnabled, msspEnabled, charsetEnabled, mspEnabled, mccpEnabled, mxpEnabled, mnesEnabled, newEnvironEnabled, secureTransport, screenReaderAdvertised, osc8HyperlinksEnabled, nawsEnabled, subprotocols });
    // Mudlet 5.0's `undoServerWrap` / `undoServerWrapWidth` — rejoin the lines
    // the game hard-wrapped itself before triggers see them. Live: the line
    // assembler judges each new server line under the current setting, so this
    // applies without a reconnect.
    session.setUndoServerWrap(undoServerWrap === true);
    if (typeof undoServerWrapWidth === 'number') session.setUndoServerWrapWidth(undoServerWrapWidth);
    // Mudlet's "Main display size" (`consoleBufferSize`/`useMaxConsoleBufferSize`
    // — mudlet.cpp:2264-2271). Applied during render like the wrap settings
    // above, so the main console is sized before any output reaches it, and
    // re-applied live when the preference changes.
    //
    // On *change* only, unlike its neighbours here, because this setting has a
    // second writer: Lua's `setConsoleBufferSize("main", …)`. Pushing the
    // preference on every render meant a script's own size lasted until the next
    // React render and was then silently reverted — the preference is a default,
    // not a policy the session re-asserts. The settings above have no scripting
    // counterpart, so re-applying those is free.
    if (appliedBufferSize.current[0] !== consoleBufferSize
        || appliedBufferSize.current[1] !== useMaxConsoleBufferSize) {
        appliedBufferSize.current = [consoleBufferSize, useMaxConsoleBufferSize];
        session.setConsoleBufferSize(
            consoleBufferSize ?? DEFAULT_CONSOLE_BUFFER_SIZE,
            useMaxConsoleBufferSize === true,
        );
    }
    // Mudlet's "Fix unnecessary linebreaks on GA servers" (config bag, persisted
    // by setConfig). Applied during render — like the protocol toggles above —
    // so it's on the session's options before autoConnect dials, and re-applied
    // live whenever the config bag changes.
    session.setFixUnnecessaryLinebreaks((profileConfig?.fixUnnecessaryLinebreaks as boolean | undefined) ?? false);
    // Mudlet's `inputLineStrictUnixEndings` (config bag) — submit commands with a
    // bare LF instead of CRLF. Live, like Mudlet's per-send read of mUSE_UNIX_EOL.
    session.setInputLineStrictUnixEndings((profileConfig?.inputLineStrictUnixEndings as boolean | undefined) ?? false);
    // Mudlet's `specialForceGAOff` (config bag) — stop treating IAC GA/EOR as a
    // prompt marker. Read once per connect (see MudSession.setSpecialForceGAOff),
    // so like the protocol toggles this applies on the next dial.
    session.setSpecialForceGAOff((profileConfig?.specialForceGAOff as boolean | undefined) ?? false);
    // Mudlet's `versionInTTYPE` / `promptForVersionInTTYPE` (config bag) — carry
    // our version in the TTYPE client-name reply, and the latch recording that
    // the KaVir auto-detect below has already had its say. Negotiation runs at
    // connect, so both apply on the next dial.
    session.setVersionInTTYPE(
        (profileConfig?.versionInTTYPE as boolean | undefined) ?? false,
        (profileConfig?.promptForVersionInTTYPE as boolean | undefined) ?? false,
    );
    // Mudlet's `promptForMXPProcessorOn` / `specialForceMXPProcessorOn` (config
    // bag) — the gate on whether an in-band ESC[<n>z from a server that skipped
    // the option-91 handshake may still auto-start MXP. Read at connect by the
    // negotiator.
    session.setMxpProcessorFlags(
        (profileConfig?.promptForMXPProcessorOn as boolean | undefined) ?? false,
        (profileConfig?.specialForceMXPProcessorOn as boolean | undefined) ?? false,
    );
    // Mudlet's `controlCharacterHandling` (config bag) — how control characters
    // (and tabs) render across the console/text windows. Applied on every
    // render like the flags above, so a Lua setConfig() or a Settings change
    // takes effect immediately.
    const rawControlCharacterHandling = profileConfig?.controlCharacterHandling;
    const controlCharacterHandling: ControlCharacterMode =
        rawControlCharacterHandling === 'oem' || rawControlCharacterHandling === 'picture' ? rawControlCharacterHandling : 'asis';
    session.setControlCharacterMode(controlCharacterHandling);
    // Mudlet's `blankLinesBehaviour` (config bag) — how empty game lines render.
    // ScriptingAPI seeds this from the bag once at construction, which covers a
    // reload but not a later edit; re-applying it here on every render is what
    // makes the Settings-modal select take effect without one. `setConfig` writes
    // the session directly, so that path never depended on this.
    const rawBlankLines = profileConfig?.blankLinesBehaviour;
    session.blankLinesBehaviour =
        rawBlankLines === 'hide' || rawBlankLines === 'replacewithspace' ? rawBlankLines : 'show';

    const { engineRef } = useEngines(session, true, connection, vfs);

    // Auto-connect on mount. Re-runs if `session` swaps under StrictMode, so the
    // replacement session also dials. Held in a ref so a later prop change to
    // `autoConnect` doesn't re-trigger.
    const autoConnectRef = useRef(autoConnect);
    useEffect(() => {
        if (!autoConnectRef.current || session.destroyed) return;
        const url = connectionUrl(connection, useAppStore.getState().client.userProxyUrl);
        // Route through the engine's load gate: the dial is deferred until the
        // profile's scripts and triggers have finished loading, so their
        // sysConnectionEvent handlers and triggers are in place when the
        // connection event and the server's login banner arrive (Mudlet loads a
        // profile before it connects). The engine holds a single pending slot,
        // so a script that calls connect() during load supersedes this request
        // rather than opening a second socket. engineRef is populated by the
        // useEngines effect, declared first; fall back to dialing directly if it
        // somehow isn't there yet. A connection switch/unmount destroys the
        // engine, which drops the pending dial.
        const engine = engineRef.current;
        if (engine) {
            engine.requestConnect(url);
        } else {
            session.connect(url);
        }
    }, [session, connection, engineRef]);

    useEffect(() => {
        if (typeof promptTimeoutMs === 'number') {
            session.setPromptTimeoutMs(promptTimeoutMs);
        }
    }, [promptTimeoutMs, session]);

    useEffect(() => {
        document.documentElement.classList.toggle('blink-text-enabled', blinkTextEnabled);
        return () => { document.documentElement.classList.remove('blink-text-enabled'); };
    }, [blinkTextEnabled]);

    // Window title steady state: the profile name, prefixed with a
    // connection-status dot when showTabConnectionIndicators is on. Goes through
    // the central title controller so a new-data / alert() flash composes on top
    // instead of overwriting it.
    useEffect(() => {
        const dot = status === 'connected' ? '🟢' : status === 'connecting' ? '🟡' : '🔴';
        setBaseTitle(`${connection.name} — ${getBrand().appName}`, showConnectionIndicator ? dot : '');
    }, [connection.name, status, showConnectionIndicator]);

    // Restore the bare app title (and stop any flash) when the profile closes.
    useEffect(() => () => { clearTitleFlash(); setBaseTitle(getBrand().appName); }, []);

    // "Notify on new data": flash the title whenever the server flushes lines
    // while the tab is unfocused. flushLines is the server-only data path
    // (excludes local command echo), matching Mudlet's notify-on-incoming-data.
    // flashTitle() no-ops while focused and clears itself when the user returns.
    useEffect(() => {
        if (!notifyOnNewData) return;
        const onData = () => flashTitle();
        session.events.on('flushLines', onData);
        return () => session.events.off('flushLines', onData);
    }, [notifyOnNewData, session]);

    // Push the "show errors in main console" preference into the scripting
    // engine so printError can mirror errors to the main window when enabled.
    useEffect(() => {
        engineRef.current?.setShowErrorsInMainWindow(showErrorsInMainWindow);
    }, [showErrorsInMainWindow, connection.id, engineRef]);

    // Color for the local echo of sent commands (Settings → Colors). Empty
    // foreground falls back to Mudlet's olive; empty background = none.
    useEffect(() => {
        session.commandEchoColor = {
            fg: commandEchoForeground || '#717100',
            bg: commandEchoBackground || '',
        };
    }, [commandEchoForeground, commandEchoBackground, session]);

    // Per-profile ANSI palette override (Mudlet's Settings → Color). Mutates
    // the global colorCodes table so FormatState picks it up on the next parse;
    // restored to defaults on profile close so the connection screen / next
    // profile starts from a clean slate.
    useEffect(() => {
        applyAnsiPalette(ansiPalette);
        return () => applyAnsiPalette(undefined);
    }, [ansiPalette]);

    // Mudlet's "Allow server to redefine your colors" (default on). Gates the
    // global OSC 4/104 path. Turning it off also snaps the palette back to the
    // user's colors, revoking anything the server already redefined this session.
    useEffect(() => {
        const allowed = serverRedefineColors === true;
        setServerRedefineColorsAllowed(allowed);
        if (!allowed) resetAllPaletteColors();
        return () => setServerRedefineColorsAllowed(true);
    }, [serverRedefineColors]);

    // Mudlet 5.0's "OSC 8 hyperlinks" toggle (default on). Gates the parser so a
    // link the server opens renders as plain text; the capability half of the
    // same switch rides along with the protocol options above. Restored to the
    // default on unmount, since the flag is module-global and the next profile
    // opened has its own answer.
    useEffect(() => {
        setOsc8HyperlinksEnabled(osc8Hyperlinks !== false);
        return () => setOsc8HyperlinksEnabled(true);
    }, [osc8Hyperlinks]);

    // Record this session's output to the persistent log store. One logger per
    // profile-session lifetime; reconnects within the same mount append to it.
    // Toggling the setting off stops recording (and flushes what's buffered).
    // The active logger is held in a ref so Mudlet's startLogging(state) hook
    // (wired through ScriptingAPI below) can flip the recorder on/off without
    // racing the effect cleanup.
    const loggerRef = useRef<SessionLogger | null>(null);
    /** True when the live logger exists only because startLogging(true) asked
     *  for a file log — so startLogging(false) tears it down again. */
    const scriptOwnedLogger = useRef(false);
    useEffect(() => {
        if (!loggingEnabled) return;
        const logger = new SessionLogger(session, connection.id, connection.name, vfs);
        logger.start();
        loggerRef.current = logger;
        return () => { loggerRef.current = null; void logger.stop(); };
    }, [session, connection.id, connection.name, loggingEnabled, vfs]);

    // Mudlet `startLogging(state)` — when true, create a logger on demand;
    // when false, stop any active one. Returns true so scripts can chain
    // off the call's success.
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        // Mudlet's startLogging governs the TEXT log only. The log-browser
        // recording above is a separate, profile-level setting — turning the
        // file log off must not stop a recording the player asked for, and a
        // profile that records by default must not read as "already logging".
        engine.setLoggingToggler((enabled: boolean, format) => {
            if (enabled) {
                let live = loggerRef.current;
                if (!live) {
                    // Recording is off for this profile, but a script still gets
                    // its file log — the logger runs purely to feed it.
                    live = new SessionLogger(session, connection.id, connection.name, vfs);
                    live.start();
                    loggerRef.current = live;
                    scriptOwnedLogger.current = true;
                }
                return live.startFileLog(format) !== null;
            }
            const live = loggerRef.current;
            if (!live) return true;
            live.stopFileLog();
            if (scriptOwnedLogger.current) {
                scriptOwnedLogger.current = false;
                loggerRef.current = null;
                void live.stop();
            }
            return true;
        });
        // startLogging reports the file it is writing to, which only the live
        // logger knows.
        engine.setLoggingPathProvider(() => loggerRef.current?.filePath ?? null);
        return () => {
            engine.setLoggingToggler(null);
            engine.setLoggingPathProvider(null);
        };
    }, [session, connection.id, connection.name, engineRef, vfs]);

    // Mudlet `appendLog(text)` → append a line to the live logger, and
    // `closeMudlet()` → disconnect + return to the connection screen.
    //
    // `session`/`connection`/`vfs` are dependencies because useEngines builds
    // the engine from exactly those, and rebuilds it when any changes — and it
    // does change: `vfs` starts null and arrives once the profile filesystem
    // mounts. Without them this ran once, on a commit where engineRef was often
    // still null, and never again — leaving appendLog() and closeMudlet() bound
    // to nothing for the rest of the session.
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.setLogAppender((text: string) => loggerRef.current?.appendLine(text));
        engine.setCloseProfileCallback(() => onCloseProfile());
        return () => {
            engine.setLogAppender(null);
            engine.setCloseProfileCallback(null);
        };
    }, [engineRef, onCloseProfile, session, connection, vfs]);

    // Index words from this session's output for argument-word Tab completion in
    // the command bar. Lives for the session's lifetime; one per connection.
    useEffect(() => {
        const index = new BufferWordIndex(session);
        index.start();
        setBufferWords(index);
        return () => { index.stop(); setBufferWords(null); };
    }, [session]);

    useEffect(() => {
        void applyOutputFont(outputFont, vfs);
    }, [outputFont, vfs]);

    // Warm the Local Font Access cache once per profile mount so the first
    // call to getAvailableFonts() from Lua sees installed system fonts. Silent
    // — only queries when permission is already granted; never prompts.
    useEffect(() => { void primeLocalFontsCache(); }, []);

    // When the server toggles IAC ECHO we clear the command line, but only if
    // the current text is the last command we sent — i.e. the character name
    // still showing because autoClearInput is off. If the user has already
    // started typing fresh password chars during the echo-debounce window we
    // keep them (mirrors Mudlet's TCommandLine "partial password" scenario).
    // Leaving password mode always clears, otherwise the password would
    // briefly surface as plaintext on the way back out.
    useEffect(() => {
        if (passwordMode) {
            if (commandRef.current && commandRef.current === lastSentRef.current) {
                setCommand('');
            }
        } else {
            setCommand('');
        }
    }, [passwordMode]);

    useEffect(() => {
        const unsub1 = session.events.on('script.appendcmd', (text: string) => {
            setCommand(prev => prev + text);
        });
        const unsub2 = session.events.on('script.setcmd', (text: string) => {
            setCommand(text);
            // Mudlet sendCmdLine ends with selectAll; replicate so the user can
            // overtype or hit Backspace to clear without manually selecting.
            queueMicrotask(() => {
                const el = commandInputRef.current;
                if (!el) return;
                el.focus();
                el.select();
            });
        });
        const unsub3 = session.events.on('script.clearcmd', () => {
            setCommand('');
        });
        const unsub4 = session.events.on('script.openvfs', (path: string) => {
            setFilesOpen({ initialPath: path, pickedAt: Date.now() });
        });
        const unsub5 = session.events.on('script.cmdlinesuggestions', (items: string[]) => {
            setCmdLineSuggestions(items);
        });
        const unsub5b = session.events.on('script.cmdlineblacklist', (items: string[]) => {
            setCmdLineBlacklist(items);
        });
        const unsub5c = session.events.on('script.savecommandhistory', (save: boolean) => {
            setSaveCommandHistory(save);
        });
        // Mudlet selectCmdLineText — highlight all text in the command bar so the
        // next keystroke overtypes it (same selectAll behaviour as script.setcmd).
        const unsub6 = session.events.on('script.selectcmd', () => {
            queueMicrotask(() => {
                const el = commandInputRef.current;
                if (!el) return;
                el.focus();
                el.select();
            });
        });
        // GMCP Char.Login: the server asks for credentials.
        const unsub7 = session.events.on('charLogin.request', (methods) => {
            // GMCP login takes over — disarm the text-login state machine.
            autoLoginStage.current = 'idle';
            const stored = readStoredLogin(connection.id);
            const action = decideCharLoginRequest({
                methods,
                declined: gmcpLoginDeclined.current,
                attempted: gmcpAutoTried.current,
                account: stored.account,
                password: stored.password,
            });
            if (action.kind === 'decline') {
                session.sendCharLoginCredentials();
                return;
            }
            if (action.kind === 'autofill') {
                gmcpAutoTried.current = true;
                // Saved credentials just went out, so a retry form should open
                // with the save box still ticked — that is what "saved" means
                // here, whether they came from the vault or from memory.
                lastLoginAttempt.current = { account: action.account, save: true };
                charLoginUnanswered.current = true;
                session.sendCharLoginCredentials(action.account, action.password);
                return;
            }
            // A locked vault holding this profile's password is the reason we
            // have nothing to send: ask to open it rather than for a password
            // the user already saved. Safe to do here and not at connect time —
            // the server blocks until we answer, so there is no race to lose.
            if (!vaultDeclined.current && vaultNeedsUnlock(connection.id)) {
                vaultPendingCharLogin.current = true;
                setVaultUnlock(`${connection.name} has a saved login. Unlock it to sign in.`);
                return;
            }
            // Servers re-send Char.Login.Default to ask again after rejecting an
            // attempt. If the popup is already up showing that rejection, keep it
            // — replacing the state with a blank one wipes the message and the
            // player is left staring at an unexplained second form.
            setCharLogin(prev => prev ?? {});
        });
        // Char.Login.Result: on failure re-open the popup with the server's
        // message; on success the popup was already dismissed on submit. Once the
        // user has opted into the text login, the outcome is theirs to read in the
        // output — a failure there must not resurrect the form.
        const unsub8 = session.events.on('charLogin.result', (result) => {
            charLoginUnanswered.current = false;
            if (result.success) { setCharLogin(null); return; }
            // Report the failure in the output too, the way Mudlet does
            // (GMCPAuthenticator::handleAuthResult). The popup is not a reliable
            // place for it on its own: a server that rejects a login commonly
            // drops the connection straight after, which tears the popup down,
            // and a server doing GMCP login withholds its text output — so
            // without this the attempt fails with nothing on screen at all.
            postLoginMessage(charLoginFailureMessage(result.message));
            if (gmcpLoginDeclined.current) return;
            setCharLogin(prev => ({ ...prev, error: result.message || 'Login failed.' }));
        });
        // A reconnect/disconnect invalidates any pending login prompt — and if
        // the credentials we sent are still unanswered, this drop *is* the
        // game's answer. Say so before the popup goes, or the attempt ends as an
        // unexplained disconnect (measured on Achaea; see the message's docs).
        const unsub9 = session.events.on('client.disconnect', () => {
            if (charLoginUnanswered.current) {
                charLoginUnanswered.current = false;
                postLoginMessage(CHAR_LOGIN_SILENT_DROP_MESSAGE);
            }
            setCharLogin(null);
        });
        // Any server output means the game is still talking to us, so the login
        // was not answered with a silent hangup — whatever happens later is a
        // normal disconnect.
        const unsub11 = session.events.on('flushLines', () => {
            charLoginUnanswered.current = false;
        });
        // Lua invokeFileDialog: queue the request; the FilePickerModal below
        // shows the head of the queue and resolves it via onPick.
        const unsub10 = session.events.on('script.filedialog', (request: FileDialogRequest) => {
            setFileDialogs(prev => [...prev, request]);
        });
        return () => { unsub1(); unsub2(); unsub3(); unsub4(); unsub5(); unsub5b(); unsub5c(); unsub6(); unsub7(); unsub8(); unsub9(); unsub10(); unsub11(); };
    }, [session]);

    // MSSP-advertised secure port, plus the outcome of any TLS handshake.
    // Mirrors Mudlet's cTelnet::promptTlsConnectionAvailable: a server that
    // advertises a TLS port gets to ask, once, whether to switch to it.
    useEffect(() => {
        const t1 = session.events.on('mssp', ({ name, value }) => {
            msspTlsFacts.current = applyMsspVariable(msspTlsFacts.current, name, value);
            const conn = useAppStore.getState().connections.find(c => c.id === connection.id) ?? connection;
            const ask = selectProfileField(useAppStore.getState(), connection.id, 'askTlsAvailable') ?? true;
            if (!shouldOfferTlsUpgrade({
                facts: msspTlsFacts.current,
                host: conn.host ?? '',
                port: conn.port ?? 23,
                tlsEnabled: !!conn.tls,
                askTlsAvailable: ask,
                promptInFlight: tlsPromptInFlight.current,
                proxyMode: (conn.mode ?? 'websocket') === 'mud',
            })) return;
            // Latch before showing, so repeated advertisements can't stack dialogs.
            tlsPromptInFlight.current = true;
            const port = msspTlsFacts.current.tlsPort;
            postTlsMessage(`A more secure connection on port ${port} is available.`);
            setTlsOffer({ port });
        });
        const t2 = session.events.on('tls.established', (info) => {
            setTlsStatus({ kind: 'established', info });
            // A working secure connection retires the revert affordance.
            if (useAppStore.getState().connections.find(c => c.id === connection.id)?.preTlsPort !== undefined) {
                useAppStore.getState().patchConnection(connection.id, { preTlsPort: undefined });
            }
            const parts = [info.protocol, info.cipher].filter(Boolean).join(', ');
            postTlsMessage(`Secure connection made${parts ? ` (${parts})` : ''}.`);
            if (info.acceptedDespite.length > 0) {
                postTlsMessage(
                    `Certificate accepted even though ${info.acceptedDespite.map(describeCertCode).join(', and ')}.`,
                    true,
                );
            }
            if (info.unsupportedOptions.length > 0) {
                postTlsMessage(
                    'This proxy cannot override certificate validation, so the certificate options you set were ignored.',
                    true,
                );
            }
        });
        const t3 = session.events.on('tls.error', (info) => {
            setTlsStatus({ kind: 'error', info });
            // Not always a certificate: TLS aimed at a plaintext port fails the
            // handshake with no certificate in sight, and saying otherwise sent
            // the user looking for a setting that doesn't exist. See
            // describeTlsFailure, and cTelnet's equivalent at ctelnet.cpp:865.
            const { summary, remedy } = describeTlsFailure(info);
            postTlsMessage(summary, true);
            if (remedy) postTlsMessage(remedy, true);
        });
        const t4 = session.events.on('tls.timeout', ({ host, port }) => {
            setTlsStatus({ kind: 'timeout', host, port });
            postTlsMessage(
                `No response on the secure port ${port}. Either the proxy is too old to support TLS, `
                + 'or the game rejected the connection.',
                true,
            );
        });
        // A fresh dial invalidates the previous connection's verdict.
        const t5 = session.events.on('client.connect', () => {
            msspTlsFacts.current = emptyMsspTlsFacts();
            setTlsStatus(null);
        });
        const t6 = session.events.on('client.disconnect', () => {
            tlsPromptInFlight.current = false;
            setTlsOffer(null);
        });
        return () => { t1(); t2(); t3(); t4(); t5(); t6(); };
    }, [session, connection]);

    // KaVir protocol-handler detection. Mirrors Mudlet's autoEnableTTYPEVersion:
    // the server's option-negotiation order fingerprints KaVir's snippet, which
    // parses a decimal version out of the TTYPE client-name reply and quietly
    // caps us at 16 colours without one. TTYPE is only negotiated at connect, so
    // — like Mudlet — turning the setting on means redialing to use it. The
    // `promptForVersionInTTYPE` latch is written first so this happens once per
    // profile and the reconnect can't re-trigger it.
    useEffect(() => {
        return session.events.on('kavir.detected', () => {
            const bag = useAppStore.getState().connectionProfile[connection.id]?.config ?? {};
            if (bag.promptForVersionInTTYPE) return;
            useAppStore.getState().patchConnectionProfile(connection.id, {
                config: { ...bag, promptForVersionInTTYPE: true, versionInTTYPE: true },
            });
            session.setVersionInTTYPE(true, true);
            postKaVirMessage(
                'This game appears to use KaVir\'s protocol handler, which works best when the client '
                + 'reports its version number during connection. Version reporting in terminal type has '
                + 'been automatically enabled for improved colour support. Reconnecting…',
            );
            disconnect();
            redialFromStore();
        });
    }, [session, connection.id]);

    // Replay state → toolbar. Playback can start outside the UI too (Lua
    // loadReplay), so both controls track the session's events rather than
    // local click handlers.
    useEffect(() => {
        const u1 = session.events.on('replay.recording', (recording: boolean) => setReplayRecording(recording));
        const u2 = session.events.on('replay.start', () => setReplaySpeed(session.replaySpeed));
        const u3 = session.events.on('replay.over', () => setReplaySpeed(null));
        const u4 = session.events.on('replay.speed', (speed: number) => setReplaySpeed(prev => (prev === null ? null : speed)));
        return () => { u1(); u2(); u3(); u4(); };
    }, [session]);

    const postReplayMessage = (text: string, isError = false) => {
        session.events.emit(
            'message',
            isError ? `\x1b[31m[ WARN ]\x1b[0m  - ${text}` : `\x1b[36m[ INFO ]\x1b[0m  - ${text}`,
            'script',
            Date.now(),
        );
    };

    /** Console notice about a GMCP Char.Login outcome, in Mudlet's house style
     *  (`[ WARN ]  - Could not log in to the game…`). */
    const postLoginMessage = (text: string) => {
        session.events.emit('message', `\x1b[33m[ WARN ]  - ${text}\x1b[0m`, 'script', Date.now());
    };

    /** Console notice from the KaVir TTYPE-version auto-detect, in Mudlet's
     *  house style. (The MXP auto-detect posts its own, from ScriptingEngine —
     *  that one is raised where the MXP processor lives.) */
    const postKaVirMessage = (text: string) => {
        session.events.emit('message', `\x1b[36m[ INFO ]\x1b[0m  - ${text}`, 'script', Date.now());
    };

    /** Console notice about the secure connection, in Mudlet's house style —
     *  `[ INFO ]` for progress, `[ ALERT ]` for a refusal or a downgrade. */
    const postTlsMessage = (text: string, isAlert = false) => {
        session.events.emit(
            'message',
            isAlert ? `\x1b[31m[ ALERT ]\x1b[0m - ${text}` : `\x1b[36m[ INFO ]\x1b[0m  - ${text}`,
            'script',
            Date.now(),
        );
    };

    const handleToggleReplayRecording = () => {
        if (!session.isReplayRecording) {
            session.startReplayRecording();
            return;
        }
        const bytes = session.stopReplayRecording();
        if (!bytes) return;
        const name = replayFileName(new Date());
        // Absolute path — the Lua runtime may have chdir()ed the VFS cwd.
        const vfsPath = vfs ? `${vfs.profilePath}/log/${name}` : null;
        if (vfs && vfsPath) {
            try {
                vfs.writeBinaryFile(vfsPath, bytes);
                postReplayMessage(`Replay recording saved. Play it back with loadReplay(getMudletHomeDir() .. "/log/${name}") or from Files → log.`);
                return;
            } catch (err) {
                console.error('Failed to save replay to VFS:', err);
            }
        }
        // No profile filesystem (or the write failed) — hand the file to the
        // browser as a download so the recording isn't lost.
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
        postReplayMessage(`Replay recording downloaded as ${name}.`);
    };

    const handlePlayReplay = (path: string) => {
        if (!vfs) return;
        let bytes: Uint8Array;
        try {
            bytes = vfs.readBinaryFile(path);
        } catch {
            postReplayMessage(`Cannot read replay file "${path}".`, true);
            return;
        }
        const error = session.loadReplayData(bytes);
        if (error) {
            postReplayMessage(`Cannot start replay: ${error}.`, true);
        } else {
            setFilesOpen(false);
        }
    };

    // Text-login auto-fill for MUDs without GMCP login. When the profile has
    // saved credentials, send the account at the first server prompt and the
    // password when the server switches to password mode (IAC ECHO off) —
    // mirroring Mudlet's saved-login. Armed on connect; disarmed after use, on
    // disconnect, or when GMCP Char.Login takes over (see charLogin.request).
    useEffect(() => {
        const readCreds = () => readStoredLogin(connection.id);
        const clearNameFallback = () => {
            if (nameFallbackTimer.current !== null) {
                window.clearTimeout(nameFallbackTimer.current);
                nameFallbackTimer.current = null;
            }
        };
        const clearPassFallback = () => {
            if (passFallbackTimer.current !== null) {
                window.clearTimeout(passFallbackTimer.current);
                passFallbackTimer.current = null;
            }
        };
        // Send the password and leave the login state machine. Reached either
        // from the ECHO-off signal or, on servers that never send one, from the
        // fallback timer started when the account went out. Whichever arrives
        // first wins: the stage guard makes the loser a no-op.
        const sendPassword = () => {
            clearPassFallback();
            if (autoLoginStage.current !== 'password') return;
            const { password } = readCreds();
            autoLoginStage.current = 'idle';
            if (password) session.sendSecret(password);
        };
        // First prompt ≈ the "By what name?" prompt: send the account (echoed,
        // since the server echoes it back off here just like a typed name).
        // Called either from the real 'prompt' event (IAC GA/EOR) or, absent
        // one, from the fallback timer below.
        const sendAccount = () => {
            clearNameFallback();
            if (autoLoginStage.current !== 'name') return;
            const { account } = readCreds();
            if (!account) { autoLoginStage.current = 'idle'; return; }
            autoLoginStage.current = 'password';
            // Echoed locally (the server echoes a typed name back the same way),
            // but not a game command: like Mudlet's `sendData(getLogin())` it
            // must not arm character-at-a-time detection, since the password
            // prompt it walks into is exactly the ECHO+SGA state that detection
            // is trying to tell apart from the real thing.
            send(account, true, false);
            passFallbackTimer.current = window.setTimeout(sendPassword, AUTO_LOGIN_PASSWORD_FALLBACK_MS);
        };
        const onConnect = () => {
            gmcpAutoTried.current = false;
            gmcpLoginDeclined.current = false;
            lastLoginAttempt.current = null;
            charLoginUnanswered.current = false;
            vaultDeclined.current = false;
            clearNameFallback();
            // A text-login game gives no signal we can wait behind — the name
            // prompt arrives when it arrives — so a locked vault has to be
            // offered here, at connect, rather than at the moment its password
            // is wanted. Missing the window costs an autofill, not a login: the
            // player types instead. GMCP games are usually done unlocking by the
            // time Char.Login arrives; the handler there re-raises this prompt
            // if they aren't, since the server waits for our reply either way.
            if (vaultNeedsUnlock(connection.id)) {
                setVaultUnlock(`${connection.name} has a saved login. Unlock it to sign in.`);
            }
            const { account, password } = readCreds();
            autoLoginStage.current = account && password ? 'name' : 'idle';
            if (autoLoginStage.current === 'name') {
                // Some MUDs (e.g. plain FluffOS/LPMud bare-telnet banners) never
                // send IAC GA/EOR at all, so the 'prompt' event that normally
                // drives sendAccount would never fire and the account would sit
                // unsent forever. Mirrors Mudlet's mTimerLogin — a fixed delay
                // from connect, independent of any telnet signal — as a backstop
                // for exactly these servers. Superseded (cleared) by a real
                // 'prompt' event if one arrives first.
                nameFallbackTimer.current = window.setTimeout(sendAccount, AUTO_LOGIN_USERNAME_FALLBACK_MS);
            }
        };
        const onPrompt = () => sendAccount();
        // Server enters password mode (ECHO off) → send the password via the
        // secret path so it never surfaces as plaintext, even under the
        // showSentText='always' echo mode.
        const onEcho = (mask: boolean) => {
            if (!mask) return;
            sendPassword();
        };
        const onDisconnect = () => {
            autoLoginStage.current = 'idle';
            clearNameFallback();
            clearPassFallback();
        };
        const u1 = session.events.on('client.connect', onConnect);
        const u2 = session.events.on('prompt', onPrompt);
        const u3 = session.events.on('telnet.echo', onEcho);
        const u4 = session.events.on('client.disconnect', onDisconnect);
        return () => { u1(); u2(); u3(); u4(); clearNameFallback(); clearPassFallback(); };
    }, [session, connection.id, connection.name, send]);

    // Register the getCmdLine provider on the engine. Effect re-runs when the
    // engine instance changes (connection swap). Suggestions state is reset
    // here too because the new engine starts with an empty Set.
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.setCmdLineProvider(() => commandRef.current);
        setCmdLineSuggestions([]);
        return () => engine.setCmdLineProvider(null);
    }, [session, connection.id, engineRef]);

    // Mirror every command-bar edit into the engine. Lua's getCmdLine() reads
    // that mirror rather than this state, because a script that stages text
    // (printCmdLine / sendCmdLine) and reads it back in the same chunk cannot
    // wait for a re-render — the staging call updates the mirror itself. The two
    // writers are last-write-wins, which is correct in both directions.
    useEffect(() => {
        engineRef.current?.setCmdLineValue(command);
    }, [command, engineRef]);

    // Drain disk-backed VFS writes before navigation. Folder-linked profiles
    // use async write-through; without this, edits made just before close can
    // be lost. visibilitychange fires more reliably on mobile/PWA than unload.
    useEffect(() => {
        const flush = () => { vfs?.flush(); };
        const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
        window.addEventListener('beforeunload', flush);
        document.addEventListener('visibilitychange', onVis);
        return () => {
            window.removeEventListener('beforeunload', flush);
            document.removeEventListener('visibilitychange', onVis);
        };
    }, [vfs]);

    // Global keydown listener — fires keybindings, but not while the user is
    // typing into a real text field (script editor, modal inputs). The command
    // line is not one of those: it is a textarea that holds focus all session,
    // so it has to pass keys through — see isTextEntryTarget.
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isTextEntryTarget(e.target)) return;
            if (engineRef.current?.processKey(e)) e.preventDefault();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [engineRef]);

    // Quick-open (Cmd+Shift+P / Ctrl+Shift+P). Fires regardless of focus so it
    // also works from inside CodeMirror editors and the command bar.
    //
    // Deliberately not the bare Ctrl+P this used to be: that swallowed the
    // browser's Print dialog for as long as the app had focus, and it is
    // Preferences on desktop Mudlet, so the one keystroke meant two different
    // things depending on which client you were in. Shift+ is the palette
    // chord users already know from editors, and it collides with nothing.
    useEffect(() => {
        const handleQuickOpen = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
                if (!vfs) return;
                e.preventDefault();
                e.stopPropagation();
                setQuickOpenOpen(true);
            }
        };
        document.addEventListener('keydown', handleQuickOpen, true);
        return () => document.removeEventListener('keydown', handleQuickOpen, true);
    }, [vfs]);

    useEffect(() => {
        session.windows.onWindowHint        = (id, hint) => saveWindowHint(connection.id, id, hint);
        session.windows.onWindowClosed      = (id)        => saveWindowHint(connection.id, id, { autoOpen: false });
        session.windows.onDockExtentsChange = (extents)   => saveDockExtents(connection.id, extents);
        session.windows.onMapOpen           = ()          => engineRef.current?.notifyMapOpen();
        return () => {
            session.windows.onWindowHint        = undefined;
            session.windows.onWindowClosed      = undefined;
            session.windows.onDockExtentsChange = undefined;
            session.windows.onMapOpen           = undefined;
        };
    }, [session, connection.id, saveWindowHint, saveDockExtents, engineRef]);

    // Hanging up on ourselves is not the game refusing the login, so drop the
    // "unanswered credentials" latch before the disconnect event fires.
    const handleDisconnect = () => { charLoginUnanswered.current = false; disconnect(); };

    /**
     * The vault unlock prompt closed. When a GMCP `Char.Login` request was the
     * thing waiting on it, answer that request now — with the credentials the
     * unlock just made readable, or by falling through to the manual form.
     * Leaving it unanswered would hang the login: the server withholds its own
     * prompt until we reply.
     */
    const handleVaultUnlockDone = (result: 'created' | 'unlocked' | 'closed') => {
        setVaultUnlock(null);
        if (result === 'closed') vaultDeclined.current = true;
        else pruneVaultEntries();
        if (!vaultPendingCharLogin.current) return;
        vaultPendingCharLogin.current = false;
        const stored = readStoredLogin(connection.id);
        if (result !== 'closed' && stored.account && stored.password) {
            gmcpAutoTried.current = true;
            lastLoginAttempt.current = { account: stored.account, save: true };
            charLoginUnanswered.current = true;
            session.sendCharLoginCredentials(stored.account, stored.password);
            return;
        }
        setCharLogin(prev => prev ?? {});
    };
    // Reads the store rather than the `connection` snapshot, so a reconnect after
    // a TLS upgrade dials the new secure port instead of the original one.
    const handleReconnect  = () => redialFromStore();

    // What the profile's "Auto-connect" option now also means: keep trying when
    // the link drops, the way Mudlet's mAutoReconnect does. The callbacks are
    // wrapped rather than passed directly because both are defined further down
    // this component body.
    useAutoReconnect({
        session,
        enabled: liveConnection.autoReconnect ?? false,
        redial: () => redialFromStore(),
        postInfo: text => postConnectionInfo(text),
    });

    /** A console line in Mudlet's house style, for the connection's own news. */
    const postConnectionInfo = (text: string) => {
        session.events.emit('message', `[36m[ INFO ][0m  - ${text}`, 'script', Date.now());
    };

    /** Redial using the connection record as it stands in the store right now,
     *  rather than the `connection` prop captured at render — the TLS handlers
     *  below have just rewritten port/tls and need the updated URL. */
    const redialFromStore = () => {
        const state = useAppStore.getState();
        const conn = state.connections.find(c => c.id === connection.id) ?? connection;
        connect(connectionUrl(conn, state.client.userProxyUrl));
    };

    /** Accept the MSSP secure-port offer: drop the plaintext link, move to the
     *  advertised port with TLS on, and redial. Mirrors Mudlet's
     *  slot_tlsUpgradeResponse(true) — including persisting the choice. */
    const handleAcceptTlsUpgrade = () => {
        const port = tlsOffer?.port;
        setTlsOffer(null);
        tlsPromptInFlight.current = false;
        if (!port) return;
        disconnect();
        // Remember where we came from so a failed upgrade can be undone.
        useAppStore.getState().patchConnection(connection.id, {
            port,
            tls: true,
            preTlsPort: useAppStore.getState().connections.find(c => c.id === connection.id)?.port ?? connection.port ?? 23,
        });
        postTlsMessage(`Switching to port ${port} with encryption…`);
        redialFromStore();
    };

    /** Decline: remember not to ask again for this profile. Mudlet also cycles
     *  the connection here purely to flush its read buffer; mudix has no such
     *  need, so the session simply carries on undisturbed. */
    const handleDeclineTlsUpgrade = () => {
        setTlsOffer(null);
        tlsPromptInFlight.current = false;
        useAppStore.getState().patchConnectionProfile(connection.id, { askTlsAvailable: false });
    };

    /** Undo an upgrade that didn't work: back to the remembered plaintext port. */
    const handleRevertTls = () => {
        const conn = useAppStore.getState().connections.find(c => c.id === connection.id) ?? connection;
        const port = conn.preTlsPort ?? 23;
        disconnect();
        useAppStore.getState().patchConnection(connection.id, { port, tls: false, preTlsPort: undefined });
        // Reverting *is* a verdict on the advertised port: without this, the very
        // next MSSP block would offer the same broken upgrade again, and the user
        // would be stuck in an accept/fail/revert loop.
        useAppStore.getState().patchConnectionProfile(connection.id, { askTlsAvailable: false });
        setTlsStatus(null);
        postTlsMessage(
            `Reverted to port ${port} without encryption. Re-enable "Allow secure connection reminder" `
            + 'in Settings → Network to be offered the secure port again.',
        );
        redialFromStore();
    };

    const handleOpenMap = () => {
        if (session.windows.isVisible(MAP_WIDGET_ID)) {
            session.windows.hide(MAP_WIDGET_ID);
        } else {
            session.windows.open(MAP_WIDGET_ID, { kind: 'map', title: 'Map', position: 'right', autoOpen: true });
        }
    };

    const handleOpenScripts  = () => setScriptsOpen(v => !v);
    const handleOpenFiles    = () => setFilesOpen(v => v ? false : {});
    const handleOpenVfsFile  = (initialPath: string, initialLine?: number) =>
        setFilesOpen({ initialPath, ...(initialLine !== undefined ? { initialLine } : {}), pickedAt: Date.now() });

    const handleSend = () => {
        // The command box is multi-line (Ctrl/Shift+Enter stages newlines), so a
        // single Enter can carry several lines — each line is its own command,
        // exactly as Mudlet's TCommandLine splits before calling Host::send once
        // per line. Everything else (the local echo, the command separator
        // split, the alias pass) belongs to Host::send and lives one level down
        // in ScriptingEngine.hostSend, because Mudlet echoes the whole line
        // *before* splitting it and *before* the aliases can swallow it.
        for (const line of command.split('\n')) {
            if (engineRef.current) {
                engineRef.current.sendCommand(line);
            } else {
                // Before the engine is ready (offline profile, init race) there
                // is no alias pipeline to run and no separator handling; echo=true
                // still lets session.send apply the showSentText mode itself.
                send(line, true);
            }
        }
        lastSentRef.current = command;
        if (autoClearInput) {
            setCommand('');
        } else {
            commandInputRef.current?.select();
        }
    };

    // Capabilities handed to brand-defined toolbar buttons: send a command as
    // if typed, or raise a Mudlet event for the profile's script handlers.
    // The observed root. A callback ref rather than useRef: the observer has to
    // re-run when the element actually arrives, and a ref object never triggers
    // that render.
    const [appEl, setAppEl] = useState<HTMLDivElement | null>(null);

    const brandToolbarContext = {
        connectionId: connection.id,
        send: (text: string) => send(text),
        raiseEvent: (event: string, ...args: unknown[]) => engineRef.current?.raiseEvent(event, args),
    };

    return (
        <ConnectionIdContext.Provider value={connection.id}>
        {/* The responsive mode is measured from this element rather than from
            the window: embedded in a page, the window is not the client. A
            560px frame on a 2560px screen was reading as a phone. */}
        <div ref={setAppEl} className={fullscreen ? 'app app--fullscreen' : 'app'}>
        <ViewportModeProvider element={appEl}>
            {fullscreen && <div className="app-topbar-hover-zone" aria-hidden="true" />}
            <Toolbar
                connectionName={connection.name}
                status={status}
                ping={ping}
                brandContext={brandToolbarContext}
                onDisconnect={handleDisconnect}
                onReconnect={handleReconnect}
                onNewConnection={onCloseProfile}
                onOpenMap={handleOpenMap}
                onOpenScripts={handleOpenScripts}
                onOpenFiles={handleOpenFiles}
                onOpenLogs={() => setLogsOpen(true)}
                onOpenDocs={() => setDocsOpen(true)}
                onOpenHelp={() => setHelpOpen(true)}
                onOpenSettings={onToggleSettings}
                replayRecording={replayRecording}
                onToggleReplayRecording={handleToggleReplayRecording}
                replaySpeed={replaySpeed}
                onReplaySpeedChange={dir => session.setReplaySpeed(dir > 0 ? session.replaySpeed * 2 : session.replaySpeed / 2)}
                onReplayStop={() => session.abortReplay()}
                onContextMenu={e => windowContextMenuHandlerRef.current?.(e)}
            />
            {settingsOpen && (
                <SettingsModal
                    onClose={onToggleSettings}
                    connectionId={connection.id}
                    vfs={vfs}
                    tlsStatus={tlsStatus}
                />
            )}
            {tlsStatus && tlsStatus.kind !== 'established' && (
                <TlsAlertBanner
                    status={tlsStatus}
                    revertPort={liveConnection.preTlsPort}
                    onRevert={handleRevertTls}
                    onDismiss={() => setTlsStatus(null)}
                />
            )}
            <div className="app-content">
                <ContentLayout
                    session={session}
                    manager={session.windows}
                    connectionId={connection.id}
                    stickyLines={DEFAULT_STICKY_LINES}
                    commandInputRef={commandInputRef}
                    contextMenuHandlerRef={windowContextMenuHandlerRef}
                    scriptingEngineRef={engineRef}
                    vfs={vfs}
                    commandBar={
                        <CommandBar
                            command={command}
                            onCommandChange={setCommand}
                            passwordMode={passwordMode}
                            commandInputRef={commandInputRef}
                            onSubmit={handleSend}
                            cmdLineMenu={session.cmdLineMenu}
                            suggestions={cmdLineSuggestions}
                            blacklist={cmdLineBlacklist}
                            saveHistory={saveCommandHistory}
                            bufferWords={bufferWords}
                        />
                    }
                />
            </div>
            {scriptsOpen && (
                <ScriptEditorModal
                    connectionId={connection.id}
                    session={session}
                    vfs={vfs}
                    scriptingEngineRef={engineRef}
                    onClose={() => setScriptsOpen(false)}
                    onOpenVfsFile={handleOpenVfsFile}
                />
            )}
            {filesOpen && (
                <FileBrowserModal
                    connectionId={connection.id}
                    vfs={vfs}
                    initialPath={filesOpen.initialPath ?? null}
                    initialPathTick={filesOpen.pickedAt}
                    initialLine={filesOpen.initialLine}
                    onClose={() => setFilesOpen(false)}
                    onPlayReplay={handlePlayReplay}
                />
            )}
            {logsOpen && (
                <LogBrowserModal
                    connectionId={connection.id}
                    connectionName={connection.name}
                    vfs={vfs}
                    onClose={() => setLogsOpen(false)}
                />
            )}
            {docsOpen && (
                <ScriptingDocsModal
                    connectionId={connection.id}
                    onClose={() => setDocsOpen(false)}
                />
            )}
            {helpOpen && (
                <HelpModal
                    connectionId={connection.id}
                    onClose={() => setHelpOpen(false)}
                />
            )}
            {fileDialogs.length > 0 && (
                <FilePickerModal
                    key={fileDialogs.length /* remount per request so tree/selection reset */}
                    vfs={vfs}
                    mode={fileDialogs[0].mode}
                    title={fileDialogs[0].title}
                    location={fileDialogs[0].location}
                    onDone={path => {
                        const req = fileDialogs[0];
                        setFileDialogs(prev => prev.slice(1));
                        req.onPick(path);
                    }}
                />
            )}
            {quickOpenOpen && vfs && (
                <QuickOpenPalette
                    vfs={vfs}
                    onPick={path => handleOpenVfsFile(path)}
                    onClose={() => setQuickOpenOpen(false)}
                />
            )}
            {tlsOffer && (
                <TlsUpgradeModal
                    port={tlsOffer.port}
                    onAccept={handleAcceptTlsUpgrade}
                    onDecline={handleDeclineTlsUpgrade}
                />
            )}
            {/* The secure-port offer wins the race when a server volunteers MSSP
                and GMCP Char.Login in the same burst (StickMUD sends MSSP ~600ms
                in, alongside the login request). Accepting the upgrade drops the
                connection, so collecting credentials first would throw them away
                and ask twice; declining renders this immediately afterwards. */}
            {vaultUnlock && !tlsOffer && (
                <VaultUnlockPrompt reason={vaultUnlock} onDone={handleVaultUnlockDone} />
            )}
            {vaultSaver.element}
            {charLogin && !tlsOffer && !vaultUnlock && (
                <CharLoginModal
                    connectionName={connection.name}
                    error={charLogin.error}
                    // On a retry, prefill from the attempt the server just
                    // rejected rather than from storage (which holds nothing when
                    // the password was never saved) — and blank the password, so
                    // the field that most likely needs fixing takes focus.
                    initialAccount={lastLoginAttempt.current?.account
                        || readStoredLogin(connection.id).account
                        || charLoginAccount}
                    initialPassword={lastLoginAttempt.current
                        ? '' : readStoredLogin(connection.id).password}
                    initialSave={lastLoginAttempt.current?.save}
                    // Branded builds never persist credentials, and a build with
                    // no vault has nowhere to put one.
                    allowSave={!isBrandedMode() && vaultSaver.canSave}
                    saveNote={vaultSaver.note}
                    restoreFocusTo={() => commandInputRef.current}
                    onSubmit={(account, password, save) => {
                        // Optimistic close: most servers proceed on success. A
                        // failure re-opens the popup via the charLogin.result
                        // handler with the server's message.
                        setCharLogin(null);
                        // We have now spent this connection's one automatic
                        // attempt. A Char.Login.Default that arrives after this
                        // (servers re-ask after rejecting) must raise the form
                        // again rather than silently replay what just failed.
                        gmcpAutoTried.current = true;
                        lastLoginAttempt.current = { account, save };
                        charLoginUnanswered.current = true;
                        if (isBrandedMode()) {
                            // Branded builds never persist credentials — keep
                            // them in memory for this page's reconnects only.
                            setSessionCredentials(connection.id, { account, password });
                        } else {
                            // The account is not a secret and stays on the
                            // connection record; the password goes to the vault,
                            // which may first ask to be created or unlocked.
                            patchConnection(connection.id, {
                                charLoginAccount: account || undefined,
                                // Any pre-vault plaintext copy is superseded here
                                // whichever way the box was ticked.
                                charLoginPassword: undefined,
                            });
                            vaultSaver.save(connection.id, save ? password : null);
                        }
                        session.sendCharLoginCredentials(account, password);
                    }}
                    onCancel={() => {
                        // Empty reply → server falls back to its text login.
                        setCharLogin(null);
                        gmcpLoginDeclined.current = true;
                        session.sendCharLoginCredentials();
                    }}
                />
            )}
        </ViewportModeProvider>
        </div>
        </ConnectionIdContext.Provider>
    );
}
