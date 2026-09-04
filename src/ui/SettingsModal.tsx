import { Fragment, useState } from 'react';
import { useAppStore, selectProfileField, MAPPER_DEFAULTS, PLAYER_MARKER_DEFAULTS, MAP_INFO_BG_DEFAULT, PROTOCOL_DEFAULTS, WS_SUBPROTOCOL_CHOICES, SEARCH_ENGINES, resolveSearchEngine, type Theme, type OutputFontSource, type ProfileSettings, type MapperSettings, type PlayerMarkerSettings, type MapInfoBgColor, type ProtocolSettings } from '../storage';
import { PlayerMarkerPreview } from './PlayerMarkerPreview';
import { Input, FontPicker, Toggle, HelpTip, Button } from './components';
import { getThemeChoices, isBrandedMode } from '../branding';
import { useModalFocus } from './components/useModalFocus';
import { DEFAULT_ANSI_PALETTE } from '../mud/text/colors';
import { SERVER_WRAP_WIDTH_MIN, SERVER_WRAP_WIDTH_MAX, SERVER_WRAP_WIDTH_DEFAULT } from '../mud/text/serverWrap';
import { DEFAULT_HISTORY_SAVE_SIZE, MAX_HISTORY } from './commandHistory';
import type { ShowSentTextMode, ControlCharacterMode, BlankLinesBehaviour } from '../mud/MudSession';

const SHOW_SENT_TEXT_OPTIONS: { value: ShowSentTextMode; label: string }[] = [
    { value: 'script', label: 'Let scripts decide' },
    { value: 'always', label: 'Always echo' },
    { value: 'never',  label: 'Never echo' },
];
import type { ProfileVFS } from '../scripting/vfs/ProfileVFS';
import { SettingsShell, SubpageRow, type CardDefinition, type CategoryKey, type SubpageDefinition } from './settings/SettingsShell';
import { VaultManageButton } from './VaultManageButton';
import { getVault } from '../vault/vaultAccess';
import { TlsCertificateBox } from './TlsCertificateBox';
import type { TlsStatus } from '../mud/events';
import { effectiveProxyUrl, proxyCanInspectCertificates } from '../storage';

// Cased as Mudlet's own colour labels are (label_black, label_lBlack, …), so a
// player looking for the one they know finds the same words here.
const ANSI_LABELS = [
    'Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White',
    'Light black', 'Light red', 'Light green', 'Light yellow',
    'Light blue', 'Light magenta', 'Light cyan', 'Light white',
] as const;

const DEFAULT_BG_FALLBACK = '#090909';
const DEFAULT_FG_FALLBACK = '#d4d4d4';
const DEFAULT_INPUT_BG_FALLBACK = '#141414';
const DEFAULT_INPUT_FG_FALLBACK = '#d4d4d4';
const DEFAULT_CMD_ECHO_FG_FALLBACK = '#717100';
const DEFAULT_PROMPT_TIMEOUT_MS = 300;
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 48;
const MAX_BORDER_PX = 1000;
const MAX_WRAP_AT = 500;
const MAX_WRAP_INDENT = 200;
const EMPTY_BORDERS = { top: 0, right: 0, bottom: 0, left: 0 } as const;
type BorderSide = 'top' | 'right' | 'bottom' | 'left';

function isHexColor(s: string | undefined): s is string {
    return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
}

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
/** {r,g,b} → "#rrggbb" for the <input type="color"> swatch. */
function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}
/** "#rrggbb" → {r,g,b}; returns null for anything not a 6-digit hex color. */
function hexToRgb(s: string): { r: number; g: number; b: number } | null {
    if (!isHexColor(s)) return null;
    return { r: parseInt(s.slice(1, 3), 16), g: parseInt(s.slice(3, 5), 16), b: parseInt(s.slice(5, 7), 16) };
}

// Theme options come from the active brand (stock themes plus/minus the
// brand's own — see getThemeChoices), so they're resolved at render time.

/** The one subpage the web client has: Mudlet puts its ten telnet protocols
 *  behind a chevron on the Connection page, and mudix has twelve rows there. */
const SUBPAGES: SubpageDefinition[] = [
    { key: 'protocols', category: 'connection', title: 'Game protocols' },
];

const MUDLET_WIKI = 'https://wiki.mudlet.org/w';

/** Mudlet's sidebar link at the bottom of the settings dialog. Dropped in a
 *  branded build, which has no business sending its players to this wiki.
 *  Read at render time, not module scope: `setBrand()` runs from main.tsx and
 *  can land after this module is first imported. */
const supportLink = () => (isBrandedMode()
    ? undefined
    : { label: 'Mudlet support', url: 'https://wiki.mudlet.org' });

const DEFAULT_COMMAND_SEPARATOR = ';;';

// Per-name blurb for the WebSocket subprotocol checkboxes. Keyed by the wire
// name in WS_SUBPROTOCOL_CHOICES; the server selects at most one of the checked
// names (they're alternative stream modes, not layers).
const WS_SUBPROTOCOL_HINTS: Record<string, string> = {
    'binary': 'Raw telnet stream over binary frames — the mode mudix decodes. Accepted by FluffOS and last-outpost.com.',
    'telnet': "FluffOS's telnet handler (same wire format as binary, different name). Some servers reject it — e.g. last-outpost.com returns HTTP 400.",
    'telnet.mudstandards.org': 'The mudstandards.org WebSocket proposal — the same profile under the standardised name.',
};

type CaretShortcut = 'none' | 'tab' | 'ctrltab' | 'f6';
const CARET_SHORTCUT_OPTIONS: { value: CaretShortcut; label: string }[] = [
    { value: 'none',    label: 'Off' },
    { value: 'tab',     label: 'Tab' },
    { value: 'ctrltab', label: 'Ctrl+Tab' },
    { value: 'f6',      label: 'F6' },
];

const CONTROL_CHARACTER_OPTIONS: { value: ControlCharacterMode; label: string }[] = [
    { value: 'asis',    label: 'Nothing' },
    { value: 'picture', label: 'Unicode control pictures' },
    { value: 'oem',     label: 'CP437 (OEM font)-like' },
];

// Wording follows Mudlet's comboBox_blankLinesBehaviour, which sits on the same
// Accessibility tab there.
const BLANK_LINES_OPTIONS: { value: BlankLinesBehaviour; label: string }[] = [
    { value: 'show',             label: 'Show them' },
    { value: 'hide',             label: 'Hide them' },
    { value: 'replacewithspace', label: 'Replace with a space' },
];

interface SettingsModalProps {
    onClose: () => void;
    /** Active profile id; null on the connection screen (only theme is editable). */
    connectionId: string | null;
    vfs?: ProfileVFS | null;
    /** TLS state of the live session, when there is one. Drives the certificate
     *  box below the secure-connection reminder. */
    tlsStatus?: TlsStatus | null;
}

export function SettingsModal({ onClose, connectionId, vfs = null, tlsStatus = null }: SettingsModalProps) {
    const modalRef = useModalFocus<HTMLDivElement>(onClose);
    // Theme is per-profile with a launcher fallback: inside a profile the picker
    // shows/edits that profile's override; on the connection screen it edits the
    // launcher theme (client.theme).
    const launcherTheme = useAppStore(s => s.client.theme);
    const profileThemeOverride = useAppStore(s => (connectionId ? s.connectionProfile[connectionId]?.theme : undefined));
    const theme = profileThemeOverride ?? launcherTheme;
    // allowMudPackageInstall is per-profile (the row is hidden on the connection
    // screen). Default to true when not explicitly disabled.
    const allowMudPackageInstall = useAppStore(s => (connectionId ? selectProfileField(s, connectionId, 'allowMudPackageInstall') : undefined));
    const notificationsEnabled = useAppStore(s => s.client.notificationsEnabled);
    const patchClient = useAppStore(s => s.patchClient);
    const mudPackageInstallEnabled = allowMudPackageInstall !== false;
    // Mudlet's mAcceptServerMedia ("Allow server to download and play media").
    // Same undefined-means-true shape as allowMudPackageInstall above.
    const allowServerMedia = useAppStore(s => (connectionId ? selectProfileField(s, connectionId, 'allowServerMedia') : undefined));
    const serverMediaEnabled = allowServerMedia !== false;
    // Mudlet's checkBox_askTlsAvailable. Defaults on, and is switched off for
    // good when the user declines an MSSP secure-port offer.
    const askTlsAvailableSetting = useAppStore(s => (connectionId ? selectProfileField(s, connectionId, 'askTlsAvailable') : undefined));
    const askTlsAvailable = askTlsAvailableSetting !== false;
    // Notifications are opt-in (default off) and require browser permission.
    const notificationsSupported = typeof window !== 'undefined' && 'Notification' in window;
    const [notifPermission, setNotifPermission] = useState<NotificationPermission>(
        notificationsSupported ? Notification.permission : 'denied',
    );
    const notificationsOn = notificationsEnabled === true && notifPermission === 'granted';

    // Toggling on requests browser permission here — a real user gesture — so the
    // first script-driven showNotification fires without a surprise prompt. We
    // only flip the stored flag true when permission is actually granted.
    const handleNotificationsToggle = async (checked: boolean) => {
        if (!checked) {
            patchClient({ notificationsEnabled: false });
            return;
        }
        if (!notificationsSupported) return;
        let perm = Notification.permission;
        if (perm === 'default') {
            try { perm = await Notification.requestPermission(); }
            catch { /* some browsers reject without a gesture; leave as-is */ }
        }
        setNotifPermission(perm);
        patchClient({ notificationsEnabled: perm === 'granted' });
    };
    const outputBackground = useAppStore(s => selectProfileField(s, connectionId, 'outputBackground'));
    const outputForeground = useAppStore(s => selectProfileField(s, connectionId, 'outputForeground'));
    const inputBackground = useAppStore(s => selectProfileField(s, connectionId, 'inputBackground'));
    const inputForeground = useAppStore(s => selectProfileField(s, connectionId, 'inputForeground'));
    const commandEchoForeground = useAppStore(s => selectProfileField(s, connectionId, 'commandEchoForeground'));
    const commandEchoBackground = useAppStore(s => selectProfileField(s, connectionId, 'commandEchoBackground'));
    const ansiPalette = useAppStore(s => selectProfileField(s, connectionId, 'ansiPalette'));
    const serverRedefineColors = useAppStore(s => selectProfileField(s, connectionId, 'serverRedefineColors'));
    const serverRedefineOn = serverRedefineColors === true;
    // Mudlet 5.0's mEnableOSC8Hyperlinks / mUndoServerWrap(+Width). All default
    // the way Mudlet's Host fields do: OSC 8 on, the wrap-undo off at column 80.
    const osc8Hyperlinks = useAppStore(s => selectProfileField(s, connectionId, 'osc8Hyperlinks'));
    const osc8HyperlinksOn = osc8Hyperlinks !== false;
    const searchEngine = resolveSearchEngine(useAppStore(s => selectProfileField(s, connectionId, 'searchEngine')));
    const undoServerWrap = useAppStore(s => selectProfileField(s, connectionId, 'undoServerWrap'));
    const undoServerWrapOn = undoServerWrap === true;
    const undoServerWrapWidth = useAppStore(s => selectProfileField(s, connectionId, 'undoServerWrapWidth'));
    const outputFont = useAppStore(s => selectProfileField(s, connectionId, 'outputFont'));
    const fontSize = useAppStore(s => selectProfileField(s, connectionId, 'fontSize'));
    const outputWrapAt = useAppStore(s => selectProfileField(s, connectionId, 'outputWrapAt'));
    const outputWrapIndent = useAppStore(s => selectProfileField(s, connectionId, 'outputWrapIndent'));
    const outputWrapHangingIndent = useAppStore(s => selectProfileField(s, connectionId, 'outputWrapHangingIndent'));
    const promptTimeoutMs = useAppStore(s => selectProfileField(s, connectionId, 'promptTimeoutMs'));
    const loggingEnabled = useAppStore(s => selectProfileField(s, connectionId, 'loggingEnabled'));
    const loggingOn = loggingEnabled !== false;
    const notifyOnNewData = useAppStore(s => selectProfileField(s, connectionId, 'notifyOnNewData')) === true;
    const showErrorsInMainWindow = useAppStore(s => selectProfileField(s, connectionId, 'showErrorsInMainWindow')) === true;
    const fullscreen = useAppStore(s => selectProfileField(s, connectionId, 'fullscreen')) === true;
    const outputBorders = useAppStore(s => selectProfileField(s, connectionId, 'outputBorders'));
    const borders = outputBorders ?? EMPTY_BORDERS;
    const autoClearInput = useAppStore(s => selectProfileField(s, connectionId, 'autoClearInput')) === true;
    const commandSeparator = useAppStore(s => selectProfileField(s, connectionId, 'commandSeparator')) ?? '';
    const protocols = useAppStore(s => selectProfileField(s, connectionId, 'protocols'));
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
    const mapper = useAppStore(s => selectProfileField(s, connectionId, 'mapper'));
    const mapperRoomSize = mapper?.roomSize ?? MAPPER_DEFAULTS.roomSize;
    const mapperRoomShape = mapper?.roomShape ?? MAPPER_DEFAULTS.roomShape;
    const mapperBorders = mapper?.borders ?? MAPPER_DEFAULTS.borders;
    const mapperLineWidth = mapper?.lineWidth ?? MAPPER_DEFAULTS.lineWidth;
    const mapperBackgroundColor = mapper?.backgroundColor ?? MAPPER_DEFAULTS.backgroundColor;
    const mapperLineColor = mapper?.lineColor ?? MAPPER_DEFAULTS.lineColor;
    const mapperGridEnabled = mapper?.gridEnabled ?? MAPPER_DEFAULTS.gridEnabled;
    const mapperLodEnabled = mapper?.lodEnabled ?? MAPPER_DEFAULTS.lodEnabled;
    const marker = mapper?.playerMarker;
    const markerStrokeColor = marker?.strokeColor ?? PLAYER_MARKER_DEFAULTS.strokeColor;
    const markerStrokeAlpha = marker?.strokeAlpha ?? PLAYER_MARKER_DEFAULTS.strokeAlpha;
    const markerFillColor = marker?.fillColor ?? PLAYER_MARKER_DEFAULTS.fillColor;
    const markerFillAlpha = marker?.fillAlpha ?? PLAYER_MARKER_DEFAULTS.fillAlpha;
    const markerStrokeWidth = marker?.strokeWidth ?? PLAYER_MARKER_DEFAULTS.strokeWidth;
    const markerSizeFactor = marker?.sizeFactor ?? PLAYER_MARKER_DEFAULTS.sizeFactor;
    const markerDashLength = marker?.dashLength ?? PLAYER_MARKER_DEFAULTS.dashLength;
    const markerDashGap = marker?.dashGap ?? PLAYER_MARKER_DEFAULTS.dashGap;
    const markerDashEnabled = marker?.dashEnabled ?? PLAYER_MARKER_DEFAULTS.dashEnabled;
    const markerMatchRoomShape = marker?.matchRoomShape ?? PLAYER_MARKER_DEFAULTS.matchRoomShape;
    const markerCustomised = marker !== undefined && Object.keys(marker).length > 0;
    const config = useAppStore(s => selectProfileField(s, connectionId, 'config'));
    const mapInfoColor = (config?.mapInfoColor as MapInfoBgColor | undefined) ?? MAP_INFO_BG_DEFAULT;
    const rawHistorySaveSize = config?.commandLineHistorySaveSize;
    const historySaveSize = typeof rawHistorySaveSize === 'number' && Number.isFinite(rawHistorySaveSize)
        ? rawHistorySaveSize
        : DEFAULT_HISTORY_SAVE_SIZE;
    const showTabConnectionIndicators = (config?.showTabConnectionIndicators as boolean | undefined) ?? true;
    const fixUnnecessaryLinebreaks = (config?.fixUnnecessaryLinebreaks as boolean | undefined) ?? false;
    const enableBlinkText = (config?.enableBlinkText as boolean | undefined) ?? false;
    // Accessibility: mirror MUD output to an off-screen ARIA live region so the
    // user's screen reader narrates it. Defaults on (matches Mudlet); the
    // ScreenReaderLog component reads the same key.
    const announceIncomingText = (config?.announceIncomingText as boolean | undefined) ?? true;
    const enableClosedCaption = (config?.enableClosedCaption as boolean | undefined) ?? false;
    // Mudlet's three mute actions. The two stored keys are the same ones Lua's
    // setConfig writes; "mute all media" is derived (both on) rather than stored,
    // exactly as Mudlet derives its toolbar state from mMuteAPI && mMuteGame.
    const muteMediaAPI = (config?.muteMediaAPI as boolean | undefined) ?? false;
    const muteMediaGame = (config?.muteMediaGame as boolean | undefined) ?? false;
    const muteAllMedia = muteMediaAPI && muteMediaGame;
    const advertiseScreenReader = (config?.advertiseScreenReader as boolean | undefined) ?? false;
    const f3SearchEnabled = (config?.f3SearchEnabled as boolean | undefined) ?? false;
    const rawCaretShortcut = config?.caretShortcut;
    const caretShortcut: CaretShortcut =
        rawCaretShortcut === 'tab' || rawCaretShortcut === 'ctrltab' || rawCaretShortcut === 'f6'
            ? rawCaretShortcut
            : 'none';
    const rawControlCharacterHandling = config?.controlCharacterHandling;
    const controlCharacterHandling: ControlCharacterMode =
        rawControlCharacterHandling === 'oem' || rawControlCharacterHandling === 'picture'
            ? rawControlCharacterHandling
            : 'asis';
    const rawBlankLines = config?.blankLinesBehaviour;
    const blankLinesBehaviour: BlankLinesBehaviour =
        rawBlankLines === 'hide' || rawBlankLines === 'replacewithspace' ? rawBlankLines : 'show';
    // Mudlet's Special Options tab, minus the compression toggle mudix already
    // carries as the positive MCCP protocol switch above.
    const inputLineStrictUnixEndings = (config?.inputLineStrictUnixEndings as boolean | undefined) ?? false;
    const specialForceGAOff = (config?.specialForceGAOff as boolean | undefined) ?? false;
    const versionInTTYPE = (config?.versionInTTYPE as boolean | undefined) ?? false;
    const specialForceMXPProcessorOn = (config?.specialForceMXPProcessorOn as boolean | undefined) ?? false;
    // showSentText is stored as a mode string; legacy profiles may hold a boolean
    // (false ≙ never, true/unset ≙ script).
    const rawShowSentText = config?.showSentText;
    const showSentText: ShowSentTextMode =
        rawShowSentText === 'never' || rawShowSentText === 'always' ? rawShowSentText
        : rawShowSentText === false ? 'never'
        : 'script';
    const patchConnectionProfile = useAppStore(s => s.patchConnectionProfile);
    // Profile-scoped fields are only writable when a profile is active. On the
    // connection screen the modal hides those rows entirely.
    const patchProfile = (patch: Partial<ProfileSettings>) => {
        if (connectionId) patchConnectionProfile(connectionId, patch);
    };
    // The TLS/certificate options live on the *connection* record, not the
    // profile settings, but they have to be reachable from here: a rejected
    // certificate is discovered mid-session, and the connection editor is only
    // available after closing the profile.
    const patchConnectionRecord = useAppStore(s => s.patchConnection);
    const connections = useAppStore(s => s.connections);
    const activeConnection = connections.find(c => c.id === connectionId);
    const tlsProxyMode = (activeConnection?.mode ?? 'websocket') === 'mud';
    const userProxyUrl = useAppStore(s => s.client.userProxyUrl);
    // Two sources, cheapest first: the proxy URL tells us up front that a Worker
    // can't inspect certificates, and a live TLS connection settles it for sure
    // (covering a Worker on a custom domain, which the URL can't identify).
    const certOptionsSupported = activeConnection
        ? proxyCanInspectCertificates(effectiveProxyUrl(activeConnection, userProxyUrl))
            && !(tlsStatus?.kind === 'established' && tlsStatus.info.certInspection === false)
        : true;
    // Mapper is stored as a nested object so future renderer toggles share one
    // slot in ProfileSettings; patches merge into the current value so toggling
    // one field doesn't wipe siblings.
    const patchMapper = (patch: Partial<MapperSettings>) => {
        patchProfile({ mapper: { ...(mapper ?? {}), ...patch } });
    };
    // playerMarker nests one level deeper, so it needs its own merge for the
    // same reason — dragging the size slider must not clear the colours.
    const patchMarker = (patch: Partial<PlayerMarkerSettings>) => {
        patchMapper({ playerMarker: { ...(marker ?? {}), ...patch } });
    };
    // Merge into the Mudlet-compatible `config` bag (same slot ScriptingAPI's
    // setConfig writes), so the Settings UI and Lua setConfig stay in sync.
    const patchMapInfoColor = (patch: Partial<MapInfoBgColor>) => {
        patchProfile({ config: { ...(config ?? {}), mapInfoColor: { ...mapInfoColor, ...patch } } });
    };
    // Merge plain Mudlet `setConfig` keys into the same `config` bag the
    // scripting registry reads/writes, so Lua and the Settings UI stay in sync.
    const patchConfig = (patch: Record<string, unknown>) => {
        patchProfile({ config: { ...(config ?? {}), ...patch } });
    };
    // Same pattern as patchMapper — protocols share one slot so flipping one
    // toggle doesn't wipe the others.
    const patchProtocols = (patch: Partial<ProtocolSettings>) => {
        patchProfile({ protocols: { ...(protocols ?? {}), ...patch } });
    };

    const [category, setCategory] = useState<CategoryKey>('general');
    const [subpage, setSubpage] = useState<string | null>(null);
    const [fontPickerOpen, setFontPickerOpen] = useState(false);

    const handleFontChange = (next: OutputFontSource | undefined) => {
        patchProfile({ outputFont: next });
    };

    const [timeoutText, setTimeoutText] = useState(
        promptTimeoutMs !== undefined ? String(promptTimeoutMs) : '',
    );
    const [fontSizeText, setFontSizeText] = useState(String(fontSize));

    const handleTimeoutBlur = () => {
        const trimmed = timeoutText.trim();
        if (trimmed === '') {
            patchProfile({ promptTimeoutMs: undefined });
            return;
        }
        const parsed = parseInt(trimmed, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
            // Invalid input — revert display to stored value.
            setTimeoutText(promptTimeoutMs !== undefined ? String(promptTimeoutMs) : '');
            return;
        }
        const clamped = Math.min(parsed, 5000);
        setTimeoutText(String(clamped));
        patchProfile({ promptTimeoutMs: clamped });
    };

    const handleFontSizeBlur = () => {
        const parsed = parseInt(fontSizeText.trim(), 10);
        if (!Number.isFinite(parsed)) {
            setFontSizeText(String(fontSize));
            return;
        }
        const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, parsed));
        setFontSizeText(String(clamped));
        patchProfile({ fontSize: clamped });
    };

    // Word-wrap settings: wrap width (0 = off, blank = default 100) plus the
    // first-line and hanging continuation indents (both default 0). An empty
    // field clears the override; an invalid one reverts to the stored value.
    const [wrapAtText, setWrapAtText] = useState(outputWrapAt !== undefined ? String(outputWrapAt) : '');
    const [wrapIndentText, setWrapIndentText] = useState(outputWrapIndent !== undefined ? String(outputWrapIndent) : '');
    const [wrapHangingText, setWrapHangingText] = useState(outputWrapHangingIndent !== undefined ? String(outputWrapHangingIndent) : '');

    const makeWrapBlurHandler = (
        key: 'outputWrapAt' | 'outputWrapIndent' | 'outputWrapHangingIndent',
        max: number,
        text: string,
        setText: (s: string) => void,
        stored: number | undefined,
    ) => () => {
        const trimmed = text.trim();
        if (trimmed === '') {
            // Blank clears the override → falls back to the field's default.
            patchProfile({ [key]: undefined });
            setText('');
            return;
        }
        const parsed = parseInt(trimmed, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
            setText(stored !== undefined ? String(stored) : '');
            return;
        }
        const clamped = Math.min(parsed, max);
        setText(String(clamped));
        patchProfile({ [key]: clamped });
    };

    const handleWrapAtBlur = makeWrapBlurHandler('outputWrapAt', MAX_WRAP_AT, wrapAtText, setWrapAtText, outputWrapAt);
    const handleWrapIndentBlur = makeWrapBlurHandler('outputWrapIndent', MAX_WRAP_INDENT, wrapIndentText, setWrapIndentText, outputWrapIndent);
    const handleWrapHangingBlur = makeWrapBlurHandler('outputWrapHangingIndent', MAX_WRAP_INDENT, wrapHangingText, setWrapHangingText, outputWrapHangingIndent);

    // The column the game wraps at, for "undo the game's own wrapping". Unlike
    // the wrap fields above, blank doesn't clear an override — the join needs a
    // column, so an empty or out-of-range entry reverts to the stored value and
    // anything else is clamped into Mudlet's 20–500 range.
    const [undoWrapWidthText, setUndoWrapWidthText] = useState(
        String(undoServerWrapWidth ?? SERVER_WRAP_WIDTH_DEFAULT),
    );

    const handleUndoWrapWidthBlur = () => {
        const parsed = parseInt(undoWrapWidthText.trim(), 10);
        const fallback = String(undoServerWrapWidth ?? SERVER_WRAP_WIDTH_DEFAULT);
        if (!Number.isFinite(parsed)) { setUndoWrapWidthText(fallback); return; }
        const clamped = Math.min(SERVER_WRAP_WIDTH_MAX, Math.max(SERVER_WRAP_WIDTH_MIN, parsed));
        setUndoWrapWidthText(String(clamped));
        patchProfile({ undoServerWrapWidth: clamped });
    };

    const [historySaveSizeText, setHistorySaveSizeText] = useState(String(historySaveSize));

    const handleHistorySaveSizeBlur = () => {
        const parsed = parseInt(historySaveSizeText.trim(), 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
            setHistorySaveSizeText(String(historySaveSize));
            return;
        }
        const clamped = Math.min(parsed, MAX_HISTORY);
        setHistorySaveSizeText(String(clamped));
        patchConfig({ commandLineHistorySaveSize: clamped });
    };

    const [roomSizeText, setRoomSizeText] = useState(String(mapperRoomSize));
    const [lineWidthText, setLineWidthText] = useState(String(mapperLineWidth));

    const handleRoomSizeBlur = () => {
        const parsed = parseFloat(roomSizeText.trim());
        if (!Number.isFinite(parsed) || parsed <= 0) {
            setRoomSizeText(String(mapperRoomSize));
            return;
        }
        const clamped = Math.min(parsed, 10);
        setRoomSizeText(String(clamped));
        patchMapper({ roomSize: clamped });
    };

    const handleLineWidthBlur = () => {
        const parsed = parseFloat(lineWidthText.trim());
        if (!Number.isFinite(parsed) || parsed <= 0) {
            setLineWidthText(String(mapperLineWidth));
            return;
        }
        const clamped = Math.min(parsed, 1);
        setLineWidthText(String(clamped));
        patchMapper({ lineWidth: clamped });
    };

    const handleAnsiChange = (idx: number, value: string) => {
        const next: (string | undefined)[] = new Array(16);
        if (ansiPalette) for (let i = 0; i < 16; i++) next[i] = ansiPalette[i];
        next[idx] = value;
        patchProfile({ ansiPalette: next });
    };

    const handleAnsiResetCell = (idx: number) => {
        if (!ansiPalette) return;
        const next: (string | undefined)[] = new Array(16);
        for (let i = 0; i < 16; i++) next[i] = ansiPalette[i];
        next[idx] = undefined;
        // If nothing remains overridden, drop the whole array.
        const anySet = next.some(v => typeof v === 'string');
        patchProfile({ ansiPalette: anySet ? next : undefined });
    };

    const handleAnsiResetAll = () => patchProfile({ ansiPalette: undefined });

    // Reset every color on this tab — output, input, command echo, and the ANSI
    // palette — back to their built-in defaults in one action.
    const handleResetAllColors = () =>
        patchProfile({
            outputBackground: '',
            outputForeground: undefined,
            inputBackground: undefined,
            inputForeground: undefined,
            commandEchoForeground: undefined,
            commandEchoBackground: undefined,
            ansiPalette: undefined,
        });

    const colorsAreDefault =
        !outputBackground &&
        !outputForeground &&
        !inputBackground &&
        !inputForeground &&
        !commandEchoForeground &&
        !commandEchoBackground &&
        !ansiPalette;

    const handleBorderChange = (side: BorderSide, raw: string) => {
        // Empty input clears that side back to 0 (Mudlet's no-border state).
        // Negative or non-numeric input is ignored so the field's display value
        // (controlled by `borders`) snaps back on next render.
        const parsed = raw === '' ? 0 : parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed < 0) return;
        const clamped = Math.min(parsed, MAX_BORDER_PX);
        const next = { ...borders, [side]: clamped };
        // When all four sides are 0, drop the override entirely so the field
        // falls back to PROFILE_DEFAULTS (no border).
        const allZero = next.top === 0 && next.right === 0 && next.bottom === 0 && next.left === 0;
        patchProfile({ outputBorders: allZero ? undefined : next });
    };


    // The chevron row on the Connection page reports what is behind it, the way
    // Mudlet's "9 of 10 turned on" does.
    const protocolFlags = [
        charsetEnabled, gmcpEnabled, mccpEnabled, mnesEnabled, msdpEnabled, mspEnabled,
        msspEnabled, mttsEnabled, mxpEnabled, nawsEnabled, newEnvironEnabled,
    ];
    const protocolsOn = protocolFlags.filter(Boolean).length;
    const openProtocols = () => { setCategory('connection'); setSubpage('protocols'); };

    // Every card of the dialog, in sidebar order — the arrangement, titles and
    // description lines follow Mudlet's redesigned settings dialog. Only the
    // two client-wide cards survive on the connection screen, where there is no
    // profile to write the rest to.
    const cards: CardDefinition[] = [
        {
            id: 'notifications',
            category: 'general',
            title: 'Notifications',
            description: 'How Mudlet Web gets your attention while you are looking at something else.',
            keywords: 'notification, alert, desktop, taskbar, blink, flash, unread',
            body: (
                <>
                    <div className="settings-row">
                        <span className="settings-label" id="notifications-enabled-label">
                            Desktop notifications
                            <HelpTip label="About desktop notifications">
                                Let scripts raise desktop notifications via <code>showNotification()</code>.
                                {!notificationsSupported
                                    ? ' Your browser does not support notifications.'
                                    : notifPermission === 'denied'
                                    ? ' Notifications are blocked for this site — re-enable them in your browser’s site settings, then toggle this on.'
                                    : ' Enabling prompts your browser for permission so the first notification can show without interruption.'}
                            </HelpTip>
                        </span>
                        <Toggle
                            id="notifications-enabled"
                            aria-labelledby="notifications-enabled-label"
                            checked={notificationsOn}
                            disabled={!notificationsSupported || notifPermission === 'denied'}
                            onChange={next => { void handleNotificationsToggle(next); }}
                        />
                    </div>
                    {connectionId && (
                        <div className="settings-row">
                            <span className="settings-label" id="notify-new-data-label">
                                Notify on new data
                                <HelpTip label="About new-data notification">
                                    When the Mudlet Web tab is unfocused, flash the browser tab title as new
                                    output arrives — the web equivalent of Mudlet's taskbar blink. Clears
                                    when you return to the tab.
                                </HelpTip>
                            </span>
                            <Toggle
                                id="notify-new-data"
                                aria-labelledby="notify-new-data-label"
                                checked={notifyOnNewData}
                                onChange={next => patchProfile({ notifyOnNewData: next })}
                            />
                        </div>
                    )}
                </>
            ),
        },
        ...(connectionId ? [{
            id: 'logging',
            category: 'general' as const,
            title: 'Log options',
            description: 'Keeps what this profile sent and received so you can read it back later.',
            keywords: 'log, transcript, history, record, session',
            body: (
                <div className="settings-row">
                    <span className="settings-label" id="logging-enabled-label">
                        Record session logs
                        <HelpTip label="About session logging">
                            Save this profile's output and your typed commands to the persistent
                            log store, browsable from the toolbar's <code>Logs</code> button.
                        </HelpTip>
                    </span>
                    <Toggle
                        id="logging-enabled"
                        aria-labelledby="logging-enabled-label"
                        checked={loggingOn}
                        onChange={next => patchProfile({ loggingEnabled: next })}
                    />
                </div>
            ),
        }] : []),
        {
            id: 'theme',
            category: 'appearance',
            title: 'Theme',
            description: 'The light or dark look of Mudlet Web itself. The colours the game’s own text is drawn in live under Main display.',
            keywords: 'dark mode, light mode, night mode, theme, colour scheme, color scheme',
            body: (
                <div className="settings-row">
                    <label className="settings-label" htmlFor="theme-select">Theme</label>
                    <select
                        id="theme-select"
                        className="settings-select"
                        value={theme}
                        onChange={e => {
                            const next = e.target.value as Theme;
                            // Inside a profile, set its override; on the
                            // connection screen, set the launcher theme.
                            if (connectionId) patchProfile({ theme: next });
                            else patchClient({ theme: next });
                        }}
                    >
                        {getThemeChoices().map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                    </select>
                </div>
            ),
        },
        ...(!connectionId ? [] : [
        {
            id: 'toolbar',
            category: 'appearance' as const,
            title: 'Toolbar',
            // Mudlet's counterpart card is "Icons and toolbars" — it holds icon
            // sizes and menu/toolbar visibility, neither of which a browser
            // gives us; fullscreen is the one thing we have in that slot.
            description: 'How much of the client’s own interface stays on screen.',
            keywords: 'toolbar, hide buttons, fullscreen, distraction free, menu bar',
            body: (
                <div className="settings-row">
                    <span className="settings-label" id="fullscreen-mode-label">
                        Fullscreen mode
                        <HelpTip label="About fullscreen mode">
                            Hide the top toolbar so the output area fills the whole window. Move
                            the pointer to the top edge (or tab into the bar) to reveal it.
                        </HelpTip>
                    </span>
                    <Toggle
                        id="fullscreen-mode"
                        aria-labelledby="fullscreen-mode-label"
                        checked={fullscreen}
                        onChange={next => patchProfile({ fullscreen: next })}
                    />
                </div>
            ),
        },
        {
            id: 'profileTabs',
            category: 'appearance' as const,
            title: 'Profile tabs',
            description: 'Mudlet shows one tab per open profile; in a browser that tab is the page’s own.',
            keywords: 'tab, title, connection status, indicator',
            body: (
                <div className="settings-row">
                    <span className="settings-label" id="show-tab-connection-indicators-label">
                        Show connection status on tabs
                        <HelpTip label="About the connection indicator">
                            Show a connection-status dot in front of the profile name in
                            the browser tab/window title (Mudlet's
                            <code> showTabConnectionIndicators</code>). The profile name
                            is shown either way.
                        </HelpTip>
                    </span>
                    <Toggle
                        id="show-tab-connection-indicators"
                        aria-labelledby="show-tab-connection-indicators-label"
                        checked={showTabConnectionIndicators}
                        onChange={next => patchConfig({ showTabConnectionIndicators: next })}
                    />
                </div>
            ),
        },
        {
            id: 'font',
            category: 'mainDisplay' as const,
            title: 'Font',
            description: 'The typeface the game’s text is drawn in.',
            keywords: 'font, typeface, size, monospace, antialiasing',
            body: (
                <>
                    <div className="settings-row">
                        <label className="settings-label">Font:</label>
                        <div className="settings-font-summary">
                            {outputFont
                                ? <span className="settings-font-summary__name" style={{ fontFamily: `"${outputFont.family}", monospace` }}>
                                    <strong>{outputFont.family}</strong>
                                    <em className="settings-font-summary__kind">({outputFont.kind})</em>
                                  </span>
                                : <span className="settings-font-summary__muted">Default monospace</span>}
                            <Button variant="secondary" size="sm" onClick={() => setFontPickerOpen(true)}>
                                Change…
                            </Button>
                        </div>
                    </div>
                    <div className="settings-row">
                        <label className="settings-label" htmlFor="output-font-size">Size:</label>
                        <div className="settings-color-field">
                            <Input
                                id="output-font-size"
                                type="number"
                                min={MIN_FONT_SIZE}
                                max={MAX_FONT_SIZE}
                                step={1}
                                value={fontSizeText}
                                placeholder={String(DEFAULT_FONT_SIZE)}
                                onChange={e => setFontSizeText(e.target.value)}
                                onBlur={handleFontSizeBlur}
                            />
                            <span className="settings-unit">pt</span>
                        </div>
                    </div>
                </>
            ),
        },
        {
            id: 'displayColors',
            category: 'mainDisplay' as const,
            title: 'Colors',
            description: 'The colours behind and in front of the game’s text, and of the line you type into.',
            keywords: 'colour, color, background, foreground, echo',
            body: (
                <>
                    <div className="settings-colors-toolbar">
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={handleResetAllColors}
                            disabled={colorsAreDefault}
                        >
                            Reset all colors
                        </Button>
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="server-redefine-colors-label">
                            Server allowed to redefine these colors
                            <HelpTip label="About server color redefinition">
                                When on, the MUD server may remap the ANSI and 256-color
                                palette at runtime (via OSC 4 / 104 escape sequences) to
                                theme its own output. When off, those sequences are ignored
                                and your palette always wins. Matches Mudlet's option of the
                                same name.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="server-redefine-colors"
                            aria-labelledby="server-redefine-colors-label"
                            checked={serverRedefineOn}
                            onChange={next => patchProfile({ serverRedefineColors: next })}
                        />
                    </div>
                    <div className="settings-colors-grid">
                        <ColorCell
                            label="Background:"
                            value={outputBackground}
                            fallback={DEFAULT_BG_FALLBACK}
                            onChange={v => patchProfile({ outputBackground: v })}
                        />
                        <ColorCell
                            label="Foreground:"
                            value={outputForeground}
                            fallback={DEFAULT_FG_FALLBACK}
                            onChange={v => patchProfile({ outputForeground: v })}
                        />
                        <ColorCell
                            label="Command line background:"
                            value={inputBackground}
                            fallback={DEFAULT_INPUT_BG_FALLBACK}
                            onChange={v => patchProfile({ inputBackground: v })}
                        />
                        <ColorCell
                            label="Command line foreground:"
                            value={inputForeground}
                            fallback={DEFAULT_INPUT_FG_FALLBACK}
                            onChange={v => patchProfile({ inputForeground: v })}
                        />
                        <ColorCell
                            label="Command foreground:"
                            value={commandEchoForeground}
                            fallback={DEFAULT_CMD_ECHO_FG_FALLBACK}
                            onChange={v => patchProfile({ commandEchoForeground: v })}
                        />
                        <ColorCell
                            label="Command background:"
                            value={commandEchoBackground}
                            fallback={DEFAULT_BG_FALLBACK}
                            onChange={v => patchProfile({ commandEchoBackground: v })}
                            onClear={() => patchProfile({ commandEchoBackground: '' })}
                        />
                    </div>
                </>
            ),
        },
        {
            id: 'ansiPalette',
            category: 'mainDisplay' as const,
            title: 'ANSI palette',
            description: 'The sixteen basic colours the game names when it colours its own text — the ones SGR codes 30–37 / 90–97 and their background counterparts pick from. A change applies to lines rendered after it; output already on screen keeps the colours it was drawn with.',
            keywords: 'ansi, palette, 16 colours, 16 colors, sgr, bright, redefine',
            body: (
                <>
                    <div className="settings-colors-toolbar">
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={handleAnsiResetAll}
                            disabled={!ansiPalette}
                        >
                            Reset all
                        </Button>
                    </div>
                    <div className="settings-ansi-grid">
                        {Array.from({ length: 8 }, (_, row) => {
                            const dark = row;
                            const light = row + 8;
                            return (
                                <Fragment key={row}>
                                    <AnsiSwatch
                                        label={ANSI_LABELS[dark]}
                                        index={dark}
                                        value={ansiPalette?.[dark]}
                                        fallback={DEFAULT_ANSI_PALETTE[dark]}
                                        onChange={v => handleAnsiChange(dark, v)}
                                        onReset={() => handleAnsiResetCell(dark)}
                                    />
                                    <AnsiSwatch
                                        label={ANSI_LABELS[light]}
                                        index={light}
                                        value={ansiPalette?.[light]}
                                        fallback={DEFAULT_ANSI_PALETTE[light]}
                                        onChange={v => handleAnsiChange(light, v)}
                                        onReset={() => handleAnsiResetCell(light)}
                                    />
                                </Fragment>
                            );
                        })}
                    </div>
                </>
            ),
        },
        {
            id: 'borders',
            category: 'mainDisplay' as const,
            title: 'Borders',
            description: 'Empty space kept around the game’s text.',
            // Mudlet spells these out a row each ("Top border height:", …); the
            // four fields are one compact row here, so its words go in the
            // search index rather than on screen.
            keywords: 'top border height, bottom border height, left border width, right border width, margin, padding',
            body: (
                <div className="settings-row settings-row--top">
                    <label className="settings-label">Borders</label>
                    <div className="settings-borders">
                        {(['top', 'right', 'bottom', 'left'] as BorderSide[]).map(side => (
                            <label key={side} className="settings-border-field">
                                <span className="settings-border-side">{side}</span>
                                <Input
                                    type="number"
                                    min={0}
                                    max={MAX_BORDER_PX}
                                    step={1}
                                    value={String(borders[side])}
                                    onChange={e => handleBorderChange(side, e.target.value)}
                                />
                            </label>
                        ))}
                    </div>
                </div>
            ),
        },
        {
            id: 'wrapping',
            category: 'mainDisplay' as const,
            title: 'Word wrapping',
            description: 'Where long lines are broken — both the ones Mudlet Web breaks and the ones the game breaks for you.',
            keywords: 'wrap, word wrap, line length, columns, indent, hanging',
            body: (
                <>
                    <div className="settings-row">
                        <label className="settings-label" htmlFor="output-wrap-at">
                            Wrap lines at:
                            <HelpTip label="About line wrapping">
                                Wraps main-window output at that many characters
                                (Mudlet's <code>setWindowWrap("main", N)</code>).
                                Default <code>0</code> disables wrapping so lines fill
                                the window width.
                            </HelpTip>
                        </label>
                        <div className="settings-color-field">
                            <Input
                                id="output-wrap-at"
                                type="number"
                                min={0}
                                max={MAX_WRAP_AT}
                                step={1}
                                value={wrapAtText}
                                placeholder="0"
                                onChange={e => setWrapAtText(e.target.value)}
                                onBlur={handleWrapAtBlur}
                            />
                            <span className="settings-unit">characters</span>
                        </div>
                    </div>
                    <div className="settings-row">
                        <label className="settings-label" htmlFor="output-wrap-indent">
                            Indent wrapped lines by:
                            <HelpTip label="About the wrap indent">
                                Indents the start of each new line
                                (<code>setWindowWrapIndent</code>). Default 0.
                            </HelpTip>
                        </label>
                        <div className="settings-color-field">
                            <Input
                                id="output-wrap-indent"
                                type="number"
                                min={0}
                                max={MAX_WRAP_INDENT}
                                step={1}
                                value={wrapIndentText}
                                placeholder="0"
                                onChange={e => setWrapIndentText(e.target.value)}
                                onBlur={handleWrapIndentBlur}
                            />
                            <span className="settings-unit">characters</span>
                        </div>
                    </div>
                    <div className="settings-row">
                        <label className="settings-label" htmlFor="output-wrap-hanging">
                            Indent hanging wrapped lines by:
                            <HelpTip label="About the hanging indent">
                                Indents each wrapped continuation line
                                (<code>setWindowWrapHangingIndent</code>). Default 0.
                            </HelpTip>
                        </label>
                        <div className="settings-color-field">
                            <Input
                                id="output-wrap-hanging"
                                type="number"
                                min={0}
                                max={MAX_WRAP_INDENT}
                                step={1}
                                value={wrapHangingText}
                                placeholder="0"
                                onChange={e => setWrapHangingText(e.target.value)}
                                onBlur={handleWrapHangingBlur}
                            />
                            <span className="settings-unit">characters</span>
                        </div>
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="undo-server-wrap-label">
                            Undo the game's own wrapping (experimental)
                            <HelpTip label="About undoing the game's wrapping">
                                Some games wrap their own lines with no way to turn it
                                off, which makes triggers awkward to write: the text a
                                trigger sees can be split mid-sentence. This joins those
                                lines back together before triggers run, so patterns
                                always see whole lines and the wrap settings above apply
                                for display instead (Mudlet's
                                {' '}<code>undoServerWrap</code>). Set the column to the
                                width the game wraps at — very often 80.
                                {' '}<em>Experimental: it tells wrapped prose apart from
                                prompts, tables and ASCII art by their shape, so the odd
                                line can still be joined or left split when it should
                                not be.</em>
                            </HelpTip>
                        </span>
                        <Toggle
                            id="undo-server-wrap"
                            aria-labelledby="undo-server-wrap-label"
                            checked={undoServerWrapOn}
                            onChange={next => patchProfile({ undoServerWrap: next })}
                        />
                    </div>
                    {undoServerWrapOn && (
                        <div className="settings-row">
                            <label className="settings-label" htmlFor="undo-server-wrap-width">
                                The game wraps at:
                            </label>
                            <div className="settings-color-field">
                                <Input
                                    id="undo-server-wrap-width"
                                    type="number"
                                    min={SERVER_WRAP_WIDTH_MIN}
                                    max={SERVER_WRAP_WIDTH_MAX}
                                    step={1}
                                    value={undoWrapWidthText}
                                    placeholder={String(SERVER_WRAP_WIDTH_DEFAULT)}
                                    onChange={e => setUndoWrapWidthText(e.target.value)}
                                    onBlur={handleUndoWrapWidthBlur}
                                />
                                <span className="settings-unit">characters</span>
                            </div>
                        </div>
                    )}
                </>
            ),
        },
        {
            id: 'displayOptions',
            category: 'mainDisplay' as const,
            title: 'Display options',
            description: 'The rest of what the game’s text window does with what arrives.',
            keywords: 'hyperlink, link, clickable url, osc8, control character, CP437, tab, search engine, google, bing, duckduckgo, look up',
            body: (
                <>
                    <div className="settings-row">
                        <span className="settings-label" id="osc8-hyperlinks-label">
                            Enable OSC 8 hyperlinks from the server
                            <HelpTip label="About OSC 8 hyperlinks">
                                Render the clickable links a game sends as OSC 8 escape
                                sequences — commands to send, prompts to fill, tooltips
                                and right-click menus (Mudlet's
                                {' '}<code>enableOSC8Hyperlinks</code>). On by default.
                                Turning it off shows the linked text as plain output and
                                tells servers, over NEW-ENVIRON, not to send links at
                                all.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="osc8-hyperlinks"
                            aria-labelledby="osc8-hyperlinks-label"
                            checked={osc8HyperlinksOn}
                            onChange={next => patchProfile({ osc8Hyperlinks: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <label className="settings-label" htmlFor="control-character-handling">
                            Display control characters as:
                            <HelpTip label="About control character handling">
                                How raw control bytes (and tabs) from the MUD render in the
                                output (Mudlet's <code>controlCharacterHandling</code>).
                                <strong> Nothing</strong> shows them as-is (invisible, except
                                tabs still expand to the next tab stop).
                                <strong> Unicode control pictures</strong> shows each one as
                                its dedicated symbol (e.g. ␛ for Escape). <strong>CP437 (OEM
                                font)-like</strong> mimics an old DOS text window with
                                decorative glyphs (♥, ♦, ♪, …) instead — note tabs don't get
                                tab-stop spacing in this mode, matching Mudlet.
                            </HelpTip>
                        </label>
                        <select
                            id="control-character-handling"
                            className="settings-select"
                            value={controlCharacterHandling}
                            onChange={e => patchConfig({ controlCharacterHandling: e.target.value as ControlCharacterMode })}
                        >
                            {CONTROL_CHARACTER_OPTIONS.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                        </select>
                    </div>
                    <div className="settings-row">
                        <label className="settings-label" htmlFor="search-engine">
                            Search selected text on:
                            <HelpTip label="About the search engine">
                                Which site the output's right-click <strong>Search on …</strong>
                                {' '}entry opens for the text you have selected. Mudlet offers the
                                same three.
                            </HelpTip>
                        </label>
                        <select
                            id="search-engine"
                            className="settings-select"
                            value={searchEngine}
                            onChange={e => patchProfile({ searchEngine: e.target.value })}
                        >
                            {Object.keys(SEARCH_ENGINES).map(name => (
                                <option key={name} value={name}>{name}</option>
                            ))}
                        </select>
                    </div>
                </>
            ),
        },
        {
            id: 'commandLine',
            category: 'inputLine' as const,
            title: 'Input',
            description: 'How the line you type into behaves, and what it sends.',
            keywords: 'command, separator, history, echo, line ending, enter',
            body: (
                <>
                    <div className="settings-row">
                        <span className="settings-label" id="auto-clear-input-label">
                            Auto clear the input line after you sent text
                            <HelpTip label="About clearing the command line">
                                When on, the command bar empties after each Enter.
                                When off, the text stays selected so the next keystroke
                                overtypes it (and a bare Enter resends).
                            </HelpTip>
                        </span>
                        <Toggle
                            id="auto-clear-input"
                            aria-labelledby="auto-clear-input-label"
                            checked={autoClearInput}
                            onChange={next => patchProfile({ autoClearInput: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <label className="settings-label" htmlFor="command-separator">
                            Command separator:
                            <HelpTip label="About the command separator">
                                Splits one Enter into multiple commands — typing
                                <code> kill orc{DEFAULT_COMMAND_SEPARATOR}get all</code>
                                sends both as separate commands. Each split is run
                                through aliases independently. Leave blank to disable
                                splitting.
                            </HelpTip>
                        </label>
                        <Input
                            id="command-separator"
                            type="text"
                            value={commandSeparator}
                            placeholder={DEFAULT_COMMAND_SEPARATOR}
                            spellCheck={false}
                            onChange={e => patchProfile({ commandSeparator: e.target.value })}
                        />
                    </div>
                    <div className="settings-row">
                        <label className="settings-label" htmlFor="command-history-save-size">
                            Command history size:
                            <HelpTip label="About command history size">
                                How many recently sent commands to keep for recall and
                                Tab-completion (Mudlet's <code>commandLineHistorySaveSize</code>).
                                History is shared across profiles. Max {MAX_HISTORY}.
                            </HelpTip>
                        </label>
                        <Input
                            id="command-history-save-size"
                            type="number"
                            min={0}
                            max={MAX_HISTORY}
                            step={10}
                            value={historySaveSizeText}
                            placeholder={String(DEFAULT_HISTORY_SAVE_SIZE)}
                            onChange={e => setHistorySaveSizeText(e.target.value)}
                            onBlur={handleHistorySaveSizeBlur}
                        />
                    </div>
                    <div className="settings-row">
                        <label className="settings-label" htmlFor="show-sent-text">
                            Show sent commands:
                            <HelpTip label="About echoing sent commands">
                                Whether commands you send are echoed into the output
                                (Mudlet's <code>showSentText</code>). <strong>Let scripts
                                decide</strong> echoes unless a script suppresses it with
                                <code> send(cmd, false)</code> (e.g. passwords);
                                <strong> Always</strong> echoes even then;
                                <strong> Never</strong> never echoes.
                            </HelpTip>
                        </label>
                        <select
                            id="show-sent-text"
                            className="settings-select"
                            value={showSentText}
                            onChange={e => patchConfig({ showSentText: e.target.value as ShowSentTextMode })}
                        >
                            {SHOW_SENT_TEXT_OPTIONS.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                        </select>
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="strict-unix-endings-label">
                            Strict UNIX line endings
                            <HelpTip label="About strict UNIX line endings">
                                End each command you send with a bare line feed instead of the
                                telnet-standard carriage return + line feed (Mudlet's
                                <code> inputLineStrictUnixEndings</code>). For old UNIX servers
                                that can't handle Windows line endings and treat the stray
                                carriage return as part of the command. Off by default.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="strict-unix-endings"
                            aria-labelledby="strict-unix-endings-label"
                            checked={inputLineStrictUnixEndings}
                            onChange={next => patchConfig({ inputLineStrictUnixEndings: next })}
                        />
                    </div>
                </>
            ),
        },
        {
            id: 'mapView',
            category: 'mapper' as const,
            title: 'Map view',
            description: 'How rooms and exits are drawn.',
            learnMore: `${MUDLET_WIKI}/Manual:Mapper`,
            keywords: 'room, exit, grid, zoom, level of detail, performance',
            body: (
                <>
                    <div className="settings-row">
                        <label className="settings-label" htmlFor="mapper-room-size">Room size:</label>
                        <Input
                            id="mapper-room-size"
                            type="number"
                            min={0.1}
                            max={10}
                            step={0.05}
                            value={roomSizeText}
                            placeholder={String(MAPPER_DEFAULTS.roomSize)}
                            onChange={e => setRoomSizeText(e.target.value)}
                            onBlur={handleRoomSizeBlur}
                        />
                    </div>
                    <div className="settings-row">
                        <label className="settings-label" htmlFor="mapper-room-shape">Room shape:</label>
                        <select
                            id="mapper-room-shape"
                            className="settings-select"
                            value={mapperRoomShape}
                            onChange={e => patchMapper({ roomShape: e.target.value as MapperSettings['roomShape'] })}
                        >
                            <option value="rectangle">Rectangle</option>
                            <option value="roundedRectangle">Rounded rectangle</option>
                            <option value="circle">Circle</option>
                        </select>
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="mapper-borders-label">Show room borders</span>
                        <Toggle
                            id="mapper-borders"
                            aria-labelledby="mapper-borders-label"
                            checked={mapperBorders}
                            onChange={next => patchMapper({ borders: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <label className="settings-label" htmlFor="mapper-line-width">Exit size:</label>
                        <Input
                            id="mapper-line-width"
                            type="number"
                            min={0.001}
                            max={1}
                            step={0.005}
                            value={lineWidthText}
                            placeholder={String(MAPPER_DEFAULTS.lineWidth)}
                            onChange={e => setLineWidthText(e.target.value)}
                            onBlur={handleLineWidthBlur}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="mapper-grid-enabled-label">Show grid</span>
                        <Toggle
                            id="mapper-grid-enabled"
                            aria-labelledby="mapper-grid-enabled-label"
                            checked={mapperGridEnabled}
                            onChange={next => patchMapper({ gridEnabled: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="mapper-lod-label">Simplify dense levels</span>
                        <Toggle
                            id="mapper-lod"
                            aria-labelledby="mapper-lod-label"
                            checked={mapperLodEnabled}
                            onChange={next => patchMapper({ lodEnabled: next })}
                        />
                    </div>
                    <p className="settings-hint">
                        On a level with more than {MAPPER_DEFAULTS.lodExitBudget.toLocaleString()} rooms,
                        zoomed-out views drop exit lines — and past {MAPPER_DEFAULTS.lodRoomBudget.toLocaleString()} rooms
                        switch to a pixel overview — so panning stays responsive. Zooming in restores full detail.
                        Turn this off to always draw everything.
                    </p>
                </>
            ),
        },
        {
            id: 'mapColors',
            category: 'mapper' as const,
            title: 'Map colors',
            description: 'The colours the map itself is drawn in.',
            keywords: 'map colour, map color, background, exit line, info overlay',
            body: (
                <>
                    <div className="settings-colors-grid">
                        <ColorCell
                            label="Background"
                            value={mapperBackgroundColor}
                            fallback="#000000"
                            onChange={v => patchMapper({ backgroundColor: v })}
                            onClear={() => patchMapper({ backgroundColor: undefined })}
                        />
                        <ColorCell
                            label="Exit lines"
                            value={mapperLineColor}
                            fallback={MAPPER_DEFAULTS.lineColor}
                            onChange={v => patchMapper({ lineColor: v })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="mapper-info-bg-label">
                            Map info background:
                            <HelpTip label="About map info background">
                                Background behind the info overlay shown on top of the
                                map (Mudlet's <code>mapInfoColor</code>). The opacity
                                slider sets its alpha channel.
                            </HelpTip>
                        </span>
                        <div className="settings-mapinfo-bg" aria-labelledby="mapper-info-bg-label">
                            <label className="settings-ansi-swatch__bar" title="Map info background color" aria-label="Map info background color">
                                <input
                                    type="color"
                                    value={rgbToHex(mapInfoColor)}
                                    onChange={e => { const rgb = hexToRgb(e.target.value); if (rgb) patchMapInfoColor(rgb); }}
                                    aria-label="Map info background color"
                                />
                                <span
                                    className="settings-ansi-swatch__fill"
                                    style={{ background: `rgba(${mapInfoColor.r}, ${mapInfoColor.g}, ${mapInfoColor.b}, ${mapInfoColor.a / 255})` }}
                                />
                            </label>
                            <input
                                type="range"
                                className="settings-mapinfo-bg__alpha"
                                min={0}
                                max={255}
                                step={1}
                                value={mapInfoColor.a}
                                onChange={e => patchMapInfoColor({ a: Number(e.target.value) })}
                                aria-label="Map info background opacity"
                                title="Opacity"
                            />
                            <span className="settings-mapinfo-bg__alpha-readout">{Math.round((mapInfoColor.a / 255) * 100)}%</span>
                        </div>
                    </div>
                </>
            ),
        },
        {
            id: 'playerMarker',
            category: 'mapper' as const,
            title: 'Player room marker',
            description: 'The ring drawn on the room you are currently in. Only a mapper script tells the map which room that is — with no mapper installed, nothing is marked.',
            keywords: 'player marker, current room, ring, highlight, you are here',
            body: (
                <>
                    {markerCustomised && (
                        <div className="settings-colors-toolbar">
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => patchMapper({ playerMarker: undefined })}
                                title="Restore the default marker"
                            >
                                Reset
                            </Button>
                        </div>
                    )}
                    <div className="settings-marker">
                        <div className="settings-marker__controls">
                            <MarkerRange
                                id="marker-size"
                                label="Size"
                                min={0.4} max={3} step={0.05}
                                value={markerSizeFactor}
                                readout={`${markerSizeFactor.toFixed(2)}×`}
                                onChange={v => patchMarker({ sizeFactor: v })}
                            />
                            <MarkerRange
                                id="marker-stroke-width"
                                label="Thickness"
                                min={0.01} max={0.3} step={0.005}
                                value={markerStrokeWidth}
                                readout={markerStrokeWidth.toFixed(3)}
                                onChange={v => patchMarker({ strokeWidth: v })}
                            />
                            <MarkerColorRow
                                id="marker-stroke"
                                label="Outline"
                                color={markerStrokeColor}
                                alpha={markerStrokeAlpha}
                                onColor={v => patchMarker({ strokeColor: v })}
                                onAlpha={v => patchMarker({ strokeAlpha: v })}
                            />
                            <MarkerColorRow
                                id="marker-fill"
                                label="Fill"
                                color={markerFillColor}
                                alpha={markerFillAlpha}
                                onColor={v => patchMarker({ fillColor: v })}
                                onAlpha={v => patchMarker({ fillAlpha: v })}
                            />
                            <div className="settings-row">
                                <span className="settings-label" id="marker-dash-label">Dashed outline</span>
                                <Toggle
                                    id="marker-dash"
                                    aria-labelledby="marker-dash-label"
                                    checked={markerDashEnabled}
                                    onChange={next => patchMarker({ dashEnabled: next })}
                                />
                            </div>
                            <MarkerRange
                                id="marker-dash-length"
                                label="Dash"
                                min={0.01} max={0.5} step={0.01}
                                value={markerDashLength}
                                readout={markerDashLength.toFixed(2)}
                                disabled={!markerDashEnabled}
                                onChange={v => patchMarker({ dashLength: v })}
                            />
                            <MarkerRange
                                id="marker-dash-gap"
                                label="Gap"
                                min={0.01} max={0.5} step={0.01}
                                value={markerDashGap}
                                readout={markerDashGap.toFixed(2)}
                                disabled={!markerDashEnabled}
                                onChange={v => patchMarker({ dashGap: v })}
                            />
                            <div className="settings-row">
                                <span className="settings-label" id="marker-match-shape-label">
                                    Match room shape
                                    <HelpTip label="About matching room shape">
                                        Draw the marker as the room shape set above
                                        instead of always as a circle. Has no effect
                                        while rooms are already circles.
                                    </HelpTip>
                                </span>
                                <Toggle
                                    id="marker-match-shape"
                                    aria-labelledby="marker-match-shape-label"
                                    checked={markerMatchRoomShape}
                                    onChange={next => patchMarker({ matchRoomShape: next })}
                                />
                            </div>
                        </div>
                        <PlayerMarkerPreview mapper={mapper} />
                    </div>
                </>
            ),
        },
        {
            id: 'mediaMuting',
            category: 'media' as const,
            title: 'Muting',
            description: 'Silences what is playing without stopping it — a muted track keeps running and comes back mid-track when you unmute.',
            learnMore: `${MUDLET_WIKI}/Standards:MUD_Client_Media_Protocol`,
            keywords: 'mute, silence, sound, music, volume, audio, video',
            body: (
                <>
                    <div className="settings-row">
                        <span className="settings-label" id="mute-all-media-label">
                            Mute all media
                            <HelpTip label="About muting all media">
                                Silence every sound, music track, and video — both the ones
                                your own triggers and scripts start and the ones the game
                                sends (Mudlet's <strong>Mute all media</strong>). This is
                                just the two switches below moving together; it's on only
                                while both are. Muting doesn't stop anything — a track keeps
                                playing silently and comes back mid-track when you unmute.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="mute-all-media"
                            aria-labelledby="mute-all-media-label"
                            checked={muteAllMedia}
                            onChange={next => patchConfig({ muteMediaAPI: next, muteMediaGame: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="mute-media-api-label">
                            Mute sounds from Mudlet (triggers, scripts, etc.)
                            <HelpTip label="About muting script sounds">
                                Silence media started by your own profile —
                                <code> playSoundFile</code>, <code>playMusicFile</code>, and
                                <code> playVideoFile</code> (Mudlet's
                                <code> muteMediaAPI</code>). Leaves the game's own sounds
                                alone. Off by default.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="mute-media-api"
                            aria-labelledby="mute-media-api-label"
                            checked={muteMediaAPI}
                            onChange={next => patchConfig({ muteMediaAPI: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="mute-media-game-label">
                            Mute sounds from the game (MCMP, MSP)
                            <HelpTip label="About muting game sounds">
                                Silence media the server asks for: MSP
                                <code> !!SOUND</code>/<code>!!MUSIC</code> tags, the MXP
                                <code> &lt;SOUND&gt;</code>/<code>&lt;MUSIC&gt;</code> tags,
                                and MCMP — the GMCP <code>Client.Media</code> messages
                                (Mudlet's <code>muteMediaGame</code>). Leaves your own
                                scripts' sounds alone. Off by default.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="mute-media-game"
                            aria-labelledby="mute-media-game-label"
                            checked={muteMediaGame}
                            onChange={next => patchConfig({ muteMediaGame: next })}
                        />
                    </div>
                </>
            ),
        },
        {
            id: 'protocols',
            category: 'connection' as const,
            title: 'Game protocols',
            description: 'Extras Mudlet Web offers the game beyond plain text — sound, structured data, your window size and the like. The game decides which of them it uses.',
            learnMore: `${MUDLET_WIKI}/Manual:Supported_Protocols`,
            keywords: 'GMCP MSDP MSSP MSP MXP MTTS MNES NAWS CHARSET NEW-ENVIRON MCCP telnet negotiation compression',
            body: (
                <SubpageRow
                    label="Protocols to offer the game"
                    summary={`${protocolsOn} of ${protocolFlags.length} turned on`}
                    onOpen={openProtocols}
                />
            ),
        },
        {
            id: 'protocolList',
            category: 'connection' as const,
            subpage: 'protocols',
            title: 'Protocols to offer the game',
            description: 'Each one is a telnet option Mudlet Web will accept if the game asks for it. Changes take effect the next time you connect.',
            body: (
                <>
                    <div className="settings-row">
                        <span className="settings-label" id="protocol-charset-label">
                            CHARSET: Character Encoding Standard
                            <HelpTip label="About CHARSET">
                                Telnet option 42 (RFC 2066). Negotiates the character
                                encoding for the session — typically switches to UTF-8
                                so non-ASCII text (Polish, Cyrillic, box-drawing) renders
                                correctly. Disable to stay on the UTF-8 baseline without
                                negotiation.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="protocol-charset"
                            aria-labelledby="protocol-charset-label"
                            checked={charsetEnabled}
                            onChange={next => patchProtocols({ charset: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="protocol-gmcp-label">
                            GMCP: Generic Mud Communication Protocol
                            <HelpTip label="About GMCP">
                                Telnet option 201. Generic MUD Communication Protocol —
                                servers expose room, character and UI data as JSON
                                envelopes (the <code>gmcp</code> table in Lua). Disable
                                to negotiate as a vanilla telnet client.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="protocol-gmcp"
                            aria-labelledby="protocol-gmcp-label"
                            checked={gmcpEnabled}
                            onChange={next => patchProtocols({ gmcp: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="protocol-mccp-label">
                            MCCP: Mud Client Compression Protocol
                            <HelpTip label="About MCCP">
                                Telnet option 86 (MCCP2). MUD Client Compression Protocol —
                                when a server offers it, the client accepts and transparently
                                decompresses the stream, cutting bandwidth. On by default;
                                disable to force compression off (Mudlet's
                                <code>specialForceCompressionOff</code>) — the client ignores
                                the server's offer and the stream stays uncompressed, which is
                                handy when debugging the raw telnet bytes.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="protocol-mccp"
                            aria-labelledby="protocol-mccp-label"
                            checked={mccpEnabled}
                            onChange={next => patchProtocols({ mccp: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="protocol-mnes-label">
                            MNES: Mud New-Environ Standard
                            <HelpTip label="About MNES">
                                Telnet option 39, Mud New-Environ Standard — the restricted
                                subset of NEW-ENVIRON. When a server requests it, the client
                                reports just its <code>CHARSET</code>, <code>CLIENT_NAME</code>,
                                <code>CLIENT_VERSION</code>, <code>MTTS</code>, and
                                <code>TERMINAL_TYPE</code>. Off by default; enable for MUDs
                                that use it for client detection. Takes precedence over
                                NEW-ENVIRON when both are on.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="protocol-mnes"
                            aria-labelledby="protocol-mnes-label"
                            checked={mnesEnabled}
                            onChange={next => patchProtocols({ mnes: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="protocol-msdp-label">
                            MSDP: Mud Server Data Protocol
                            <HelpTip label="About MSDP">
                                Telnet option 69. Mud Server Data Protocol — a binary
                                alternative to GMCP for the same kind of structured
                                server data (the <code>msdp</code> table in Lua). Off
                                by default; enable only if your MUD prefers MSDP.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="protocol-msdp"
                            aria-labelledby="protocol-msdp-label"
                            checked={msdpEnabled}
                            onChange={next => patchProtocols({ msdp: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="protocol-msp-label">
                            MSP: Mud Sound Protocol
                            <HelpTip label="About MSP">
                                Telnet option 90. MUD Sound Protocol — strips inline
                                <code>!!SOUND(...)</code> and <code>!!MUSIC(...)</code> tags from
                                MUD text and plays them through the sound manager. Off by
                                default; enable for MUDs that send sound triggers.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="protocol-msp"
                            aria-labelledby="protocol-msp-label"
                            checked={mspEnabled}
                            onChange={next => patchProtocols({ msp: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="protocol-mssp-label">
                            MSSP: Mud Server Status Protocol
                            <HelpTip label="About MSSP">
                                Telnet option 70. Mud Server Status Protocol — the server
                                reports read-only status fields (player count, uptime,
                                codebase, …) once per connection into the <code>mssp</code>
                                table in Lua. On by default; harmless to leave enabled.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="protocol-mssp"
                            aria-labelledby="protocol-mssp-label"
                            checked={msspEnabled}
                            onChange={next => patchProtocols({ mssp: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="protocol-mtts-label">
                            MTTS: Mud Terminal Type Standard
                            <HelpTip label="About MTTS / TERMINAL-TYPE">
                                Telnet option 24. Identifies the client (name, terminal
                                type, capability bitvector — colors, UTF-8, truecolor).
                                Many MUDs gate MSDP/GMCP on this handshake completing.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="protocol-mtts"
                            aria-labelledby="protocol-mtts-label"
                            checked={mttsEnabled}
                            onChange={next => patchProtocols({ mtts: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="protocol-mxp-label">
                            MXP: Mud eXtension Protocol
                            <HelpTip label="About MXP">
                                Telnet option 91. MUD eXtension Protocol — parses in-band
                                HTML-like markup from the server: text formatting, clickable
                                <code>&lt;SEND&gt;</code>/<code>&lt;A&gt;</code> links, entities, and
                                custom element definitions. On by default; disable for MUDs
                                where literal angle-bracket text is being eaten.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="protocol-mxp"
                            aria-labelledby="protocol-mxp-label"
                            checked={mxpEnabled}
                            onChange={next => patchProtocols({ mxp: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="protocol-naws-label">
                            NAWS: Negotiate About Window Size
                            <HelpTip label="About NAWS">
                                Telnet option 31 (Negotiate About Window Size). Reports the
                                main output area's size in characters (columns × rows) to the
                                server and updates it whenever the window is resized. Servers
                                use it for word-wrap, pagination, and full-screen layouts. On
                                by default.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="protocol-naws"
                            aria-labelledby="protocol-naws-label"
                            checked={nawsEnabled}
                            onChange={next => patchProtocols({ naws: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="protocol-new-environ-label">
                            NEW-ENVIRON: Client Variables Standard
                            <HelpTip label="About NEW-ENVIRON">
                                Telnet option 39, Client Variables Standard (RFC 1572). Like
                                MNES but reports an extended capability set in addition to the
                                five core variables — <code>ANSI</code>, <code>256_COLORS</code>,
                                <code>TRUECOLOR</code>, <code>UTF-8</code>, <code>TLS</code>,
                                <code>WORD_WRAP</code>, <code>OSC_COLOR_PALETTE</code>,
                                the <code>OSC_HYPERLINKS_*</code> set and more — so servers can
                                tailor output to the client. On by default. When MNES is also
                                on, MNES wins.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="protocol-new-environ"
                            aria-labelledby="protocol-new-environ-label"
                            checked={newEnvironEnabled}
                            onChange={next => patchProtocols({ newEnviron: next })}
                        />
                    </div>
                    <p className="settings-hint">
                        Protocol changes take effect the next time you connect.
                    </p>
                </>
            ),
        },
        {
            id: 'wsSubprotocols',
            category: 'connection' as const,
            subpage: 'protocols',
            title: 'WebSocket subprotocol',
            description: 'What the browser offers in the WebSocket handshake. Applies to direct WebSocket connections, not to games reached through the telnet proxy.',
            keywords: 'websocket, subprotocol, binary, handshake, fluffos, sec-websocket-protocol',
            body: (
                <div className="settings-row settings-row--top">
                    <span className="settings-label" id="protocol-ws-subprotocols-label">
                        Offer
                        <HelpTip label="About WebSocket subprotocols">
                            The subprotocol names offered in the WebSocket opening
                            handshake (<code>Sec-WebSocket-Protocol</code>). The server
                            selects at most one of the checked names — these are
                            mutually-exclusive stream modes, not layers. Leave{' '}
                            <code>binary</code> checked in almost all cases: it's the raw
                            telnet stream mudix decodes, and it's accepted the most
                            widely. Some servers (FluffOS) route a no-subprotocol
                            connection to a non-MUD handler and send no data, so an empty
                            selection can leave the terminal blank; others reject an
                            unrecognized name with HTTP 400. Applies to direct WebSocket
                            connections, not the telnet proxy.
                        </HelpTip>
                    </span>
                    <div
                        className="settings-checkbox-group"
                        role="group"
                        aria-labelledby="protocol-ws-subprotocols-label"
                    >
                        {WS_SUBPROTOCOL_CHOICES.map(name => (
                            <label key={name} className="settings-checkbox" title={WS_SUBPROTOCOL_HINTS[name]}>
                                <input
                                    type="checkbox"
                                    checked={wsSubprotocols.includes(name)}
                                    onChange={e => {
                                        const set = new Set(wsSubprotocols);
                                        if (e.target.checked) set.add(name);
                                        else set.delete(name);
                                        patchProtocols({
                                            wsSubprotocols: WS_SUBPROTOCOL_CHOICES.filter(n => set.has(n)),
                                        });
                                    }}
                                />
                                <code>{name}</code>
                            </label>
                        ))}
                    </div>
                </div>
            ),
        },
        {
            id: 'compatibility',
            category: 'connection' as const,
            title: 'Compatibility',
            description: 'Workarounds for games whose servers do things their own way. Leave these off unless the game asks you to turn one on.',
            keywords: 'workaround, driver, legacy, ga, eor, ttype, mxp, linebreak, IRE',
            body: (
                <>
                    <div className="settings-row">
                        <span className="settings-label" id="fix-unnecessary-linebreaks-label">
                            Fix unnecessary linebreaks on GA servers
                            <HelpTip label="About fixing unnecessary linebreaks">
                                On GA-driven servers, strip a stray leading blank line that
                                some MUDs (IRE-style) prepend before each prompt block
                                (Mudlet's <code>fixUnnecessaryLinebreaks</code>). Off by
                                default; leave it off unless you see a spurious blank line
                                before every prompt.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="fix-unnecessary-linebreaks"
                            aria-labelledby="fix-unnecessary-linebreaks-label"
                            checked={fixUnnecessaryLinebreaks}
                            onChange={next => patchConfig({ fixUnnecessaryLinebreaks: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="special-force-ga-off-label">
                            Force telnet GA signal interpretation off
                            <HelpTip label="About forcing GA off">
                                Stop treating the telnet <code>GA</code>/<code>EOR</code> marker as
                                an end-of-prompt signal (Mudlet's <code>specialForceGAOff</code>).
                                Normally the first such marker switches mudix into GA-driven prompt
                                mode, where the marker — not a newline — is what ends a prompt line.
                                A few older drivers emit it in the wrong places, which chops output
                                into odd fragments; with this on the marker just becomes a line
                                break. Off by default.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="special-force-ga-off"
                            aria-labelledby="special-force-ga-off-label"
                            checked={specialForceGAOff}
                            onChange={next => patchConfig({ specialForceGAOff: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="version-in-ttype-label">
                            Send Mudlet version in terminal type
                            <HelpTip label="About sending the version in TTYPE">
                                Send our version number alongside the client name during telnet
                                TTYPE negotiation (Mudlet's <code>versionInTTYPE</code>). Off by
                                default, because the period it contains is not a legal TTYPE
                                character per RFC 1091 — Mudlet stopped sending it in 2024. Servers
                                running KaVir's protocol snippet read a version out of that field
                                and fall back to 16 colours without one, so mudix detects those
                                servers and turns this on for you.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="version-in-ttype"
                            aria-labelledby="version-in-ttype-label"
                            checked={versionInTTYPE}
                            onChange={next => patchConfig({ versionInTTYPE: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="force-mxp-processor-label">
                            Force MXP processing on
                            <HelpTip label="About forcing the MXP processor on">
                                Run the MXP parser even on servers that never negotiate telnet
                                option 91 (Mudlet's <code>specialForceMXPProcessorOn</code>). Also
                                locks the parser into secure mode, which such servers need — they
                                send secure tags like <code>&lt;SEND&gt;</code> without ever
                                switching mode, and those are discarded otherwise. To turn MXP off
                                entirely, leave this off and also switch off <strong>MXP</strong>
                                on the game protocols page. Off by default; mudix turns it on
                                automatically when it sees in-band MXP.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="force-mxp-processor"
                            aria-labelledby="force-mxp-processor-label"
                            checked={specialForceMXPProcessorOn}
                            onChange={next => patchConfig({ specialForceMXPProcessorOn: next })}
                        />
                    </div>
                </>
            ),
        },
        {
            id: 'network',
            category: 'connection' as const,
            title: 'Network',
            description: 'How long Mudlet Web waits for the rest of a slow message before drawing what it already has.',
            keywords: 'timeout, lag, latency, slow connection, prompt, packet',
            body: (
                <div className="settings-row">
                    <label className="settings-label" htmlFor="prompt-timeout">
                        Additional text wait time:
                        <HelpTip label="About prompt timeout">
                            How long to wait for the rest of a line before treating a partial chunk as a prompt.
                            Raise this if you see spurious mid-line breaks on a slow connection; lower it if
                            prompts on MUDs without IAC GA feel sluggish. Default {DEFAULT_PROMPT_TIMEOUT_MS}ms,
                            matching Mudlet's "Network packet timeout".
                        </HelpTip>
                    </label>
                    <div className="settings-color-field">
                        <Input
                            id="prompt-timeout"
                            type="number"
                            min={0}
                            max={5000}
                            step={50}
                            value={timeoutText}
                            placeholder={String(DEFAULT_PROMPT_TIMEOUT_MS)}
                            onChange={e => setTimeoutText(e.target.value)}
                            onBlur={handleTimeoutBlur}
                        />
                        <span className="settings-unit">ms</span>
                    </div>
                </div>
            ),
        },
        // Mudlet's one status hero: what the live connection's security actually
        // is, rather than what the settings below it ask for.
        ...(tlsStatus?.kind === 'established' ? [{
            id: 'securityStatus',
            category: 'privacy' as const,
            title: 'Connection security',
            description: 'What the connection you are on right now is actually protected by.',
            keywords: 'certificate, TLS, SSL, cipher, encrypted, secure',
            body: (
                <TlsCertificateBox
                    cert={tlsStatus.info.cert}
                    certInspection={tlsStatus.info.certInspection}
                    protocol={tlsStatus.info.protocol}
                    cipher={tlsStatus.info.cipher}
                    acceptedDespite={tlsStatus.info.acceptedDespite}
                />
            ),
        }] : []),
        ...(tlsProxyMode && activeConnection ? [{
            id: 'ssl',
            category: 'privacy' as const,
            title: 'TLS/SSL secure connection',
            description: 'Encrypts everything travelling between Mudlet Web and the game, so nobody in between can read it. The game has to offer a secure port of its own.',
            keywords: 'TLS, SSL, secure connection, encryption, certificate, self-signed, expired',
            body: (
                <>
                    <div className="settings-row">
                        <span className="settings-label" id="tls-enabled-label">
                            Secure connection (TLS)
                            <HelpTip label="About secure connections">
                                Ask the proxy to encrypt the link to the game. The game must offer a TLS
                                port — usually a different one from its plaintext port. Takes effect on
                                the next connect.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="tls-enabled"
                            aria-labelledby="tls-enabled-label"
                            checked={!!activeConnection.tls}
                            onChange={next => patchConnectionRecord(connectionId, { tls: next || undefined })}
                        />
                    </div>
                    {activeConnection.tls && !certOptionsSupported && (
                        <div className="tls-cert-options tls-cert-options--unavailable">
                            <span className="tls-cert-options-title">Certificate options unavailable</span>
                            <span className="tls-cert-options-hint">
                                This proxy runs on Cloudflare Workers, which cannot inspect the game's
                                certificate or override a validation failure. The link is still
                                encrypted, but only connects if the game's certificate is valid and
                                publicly trusted. Use a self-hosted Node proxy to accept an expired or
                                self-signed certificate.
                            </span>
                        </div>
                    )}
                    {activeConnection.tls && certOptionsSupported && (
                        <div className="tls-cert-options">
                            <span className="tls-cert-options-title">If the certificate can't be verified</span>
                            <label className="tls-cert-option">
                                <input
                                    type="checkbox"
                                    checked={!!activeConnection.sslIgnoreExpired}
                                    disabled={!!activeConnection.sslIgnoreAll}
                                    onChange={e => patchConnectionRecord(connectionId, { sslIgnoreExpired: e.target.checked || undefined })}
                                />
                                <span>Accept expired certificates</span>
                            </label>
                            <label className="tls-cert-option">
                                <input
                                    type="checkbox"
                                    checked={!!activeConnection.sslIgnoreSelfSigned}
                                    disabled={!!activeConnection.sslIgnoreAll}
                                    onChange={e => patchConnectionRecord(connectionId, { sslIgnoreSelfSigned: e.target.checked || undefined })}
                                />
                                <span>Accept self-signed certificates</span>
                            </label>
                            <label className="tls-cert-option">
                                <input
                                    type="checkbox"
                                    checked={!!activeConnection.sslIgnoreAll}
                                    onChange={e => patchConnectionRecord(connectionId, { sslIgnoreAll: e.target.checked || undefined })}
                                />
                                <span className="tls-cert-option-danger">
                                    Accept all certificate errors (unsecure)
                                </span>
                            </label>
                            <span className="tls-cert-options-hint">
                                Changing these doesn't reconnect on its own — reconnect to retry the
                                handshake.
                            </span>
                        </div>
                    )}
                </>
            ),
        }] : []),
        {
            // Beside the secure-connection card rather than inside it: asking
            // about an available secure port is exactly what someone with TLS
            // switched off wants.
            id: 'secureReminder',
            category: 'privacy' as const,
            keywords: 'TLS, SSL, secure connection, reminder, MSSP',
            body: (
                <div className="settings-row">
                    <span className="settings-label" id="ask-tls-available-label">
                        Allow secure connection reminder
                        <HelpTip label="About the secure connection reminder">
                            When a game advertises an encrypted port via MSSP, offer once to switch to it.
                            Declining the offer also turns this off for the profile.
                        </HelpTip>
                    </span>
                    <Toggle
                        id="ask-tls-available"
                        aria-labelledby="ask-tls-available-label"
                        checked={askTlsAvailable}
                        onChange={next => patchProfile({ askTlsAvailable: next })}
                    />
                </div>
            ),
        },
        ...(getVault() ? [{
            id: 'passwords',
            category: 'privacy' as const,
            title: 'Passwords',
            description: 'Where Mudlet Web keeps the passwords you have let it remember, encrypted on this device.',
            keywords: 'password, keyring, keychain, credentials, sign in, vault, autologin',
            body: (
                <div className="settings-row">
                    <span className="settings-label">Saved logins</span>
                    <VaultManageButton connections={connections} variant="row" />
                </div>
            ),
        }] : []),
        {
            id: 'serverPermissions',
            category: 'privacy' as const,
            title: 'Server permissions',
            description: 'What the game is allowed to put on your screen or play through your speakers without asking first.',
            keywords: 'permission, package install, GUI, media, download, Client.GUI, Client.Media',
            body: (
                <>
                    <div className="settings-row">
                        <span className="settings-label" id="allow-server-media-label">
                            Allow server to download and play media
                            <HelpTip label="About server media">
                                Let the MUD drive playback over GMCP
                                <code> Client.Media</code> (MCMP): files it names are
                                downloaded into this profile's <code>media/</code> folder
                                and played (Mudlet's <code>mAcceptServerMedia</code>).
                                Turning this off ignores those messages outright — nothing
                                is fetched and nothing plays, unlike muting under Sound and
                                media, which still downloads and plays silently. Needs GMCP
                                enabled in the game protocols. MSP has its own switch there
                                too. On by default.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="allow-server-media"
                            aria-labelledby="allow-server-media-label"
                            checked={serverMediaEnabled}
                            onChange={next => patchProfile({ allowServerMedia: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="allow-mud-package-install-label">
                            Allow server to install script packages
                            <HelpTip label="About MUD package installs">
                                When a connected MUD sends a <code>Client.GUI</code> GMCP message, automatically
                                download and install the package it points to. Disable to ignore those requests.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="allow-mud-package-install"
                            aria-labelledby="allow-mud-package-install-label"
                            checked={mudPackageInstallEnabled}
                            onChange={next => patchProfile({ allowMudPackageInstall: next })}
                        />
                    </div>
                </>
            ),
        },
        {
            id: 'screenReader',
            category: 'accessibility' as const,
            title: 'Screen reader',
            description: 'What your screen reader — and the game — are told about the text arriving.',
            keywords: 'screen reader, NVDA, JAWS, VoiceOver, Orca, accessibility, text to speech, TTS, spoken',
            body: (
                <>
                    <div className="settings-row">
                        <span className="settings-label" id="announce-incoming-text-label">
                            Announce incoming text in screen reader
                            <HelpTip label="About announcing incoming text">
                                Mirror MUD output to an off-screen live region so your
                                screen reader (NVDA, JAWS, VoiceOver, Orca) narrates each
                                new line in your own voice and braille settings (Mudlet's
                                <code> announceIncomingText</code>). On by default; it is
                                invisible and has no effect if you don't use a screen reader.
                                Turn it off to silence that narration.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="announce-incoming-text"
                            aria-labelledby="announce-incoming-text-label"
                            checked={announceIncomingText}
                            onChange={next => patchConfig({ announceIncomingText: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="advertise-screen-reader-label">
                            Advertise screen reader use via protocols supporting this notice (NEW-ENVIRON, MNES, MTTS)
                            <HelpTip label="About advertising screen-reader use">
                                Report screen-reader use to the MUD via MTTS/NEW-ENVIRON
                                (Mudlet's <code>advertiseScreenReader</code>). Some MUDs
                                adjust their output when they see this — e.g. trimming
                                ASCII art or adding extra room-description detail. Off by
                                default; takes effect on the next connect.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="advertise-screen-reader"
                            aria-labelledby="advertise-screen-reader-label"
                            checked={advertiseScreenReader}
                            onChange={next => patchConfig({ advertiseScreenReader: next })}
                        />
                    </div>
                </>
            ),
        },
        {
            id: 'accessibilityText',
            category: 'accessibility' as const,
            title: 'Text and media',
            description: 'What happens to the parts of the game’s output a reader cannot make sense of.',
            keywords: 'blank line, empty line, blink, caption, subtitle, hard of hearing',
            body: (
                <>
                    <div className="settings-row">
                        <label className="settings-label" htmlFor="blank-lines-behaviour">
                            When the game sends blank lines:
                            <HelpTip label="About blank lines from the game">
                                What to do with empty lines the game sends (Mudlet's
                                <code> blankLinesBehaviour</code>). <strong>Show them</strong>
                                renders them as-is. <strong>Hide them</strong> drops them
                                entirely. <strong>Replace with a space</strong> is Mudlet's
                                screen-reader workaround — some readers skip a truly empty line
                                but announce one holding a space. Only lines from the game are
                                affected, not echoes or client messages.
                            </HelpTip>
                        </label>
                        <select
                            id="blank-lines-behaviour"
                            className="settings-select"
                            value={blankLinesBehaviour}
                            onChange={e => patchConfig({ blankLinesBehaviour: e.target.value as BlankLinesBehaviour })}
                        >
                            {BLANK_LINES_OPTIONS.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                        </select>
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="enable-blink-text-label">
                            Enable blinking text
                            <HelpTip label="About blinking text">
                                Animate ANSI blink (SGR 5/6) as a smooth opacity pulse
                                (Mudlet's <code>enableBlinkText</code>). Off by default;
                                when off, blinking text is shown in italics instead.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="enable-blink-text"
                            aria-labelledby="enable-blink-text-label"
                            checked={enableBlinkText}
                            onChange={next => patchConfig({ enableBlinkText: next })}
                        />
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="enable-closed-caption-label">
                            Enable closed caption for media
                            <HelpTip label="About closed captions">
                                Print a short text line in the output whenever a sound,
                                music track, or video starts or stops — e.g.
                                <code> [sound "rain.wav" plays]</code> (Mudlet's
                                <code> enableClosedCaption</code>). Useful if you can't
                                hear game audio. Captions cover audio and video only, not
                                images. Off by default.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="enable-closed-caption"
                            aria-labelledby="enable-closed-caption-label"
                            checked={enableClosedCaption}
                            onChange={next => patchConfig({ enableClosedCaption: next })}
                        />
                    </div>
                </>
            ),
        },
        {
            id: 'accessibilityKeyboard',
            category: 'accessibility' as const,
            title: 'Keyboard',
            description: 'Reaching the scrollback without a mouse.',
            keywords: 'caret, review mode, F3, find, search, keyboard navigation',
            body: (
                <>
                    <div className="settings-row">
                        <label className="settings-label" htmlFor="caret-shortcut">
                            Switch between input line and main window using:
                            <HelpTip label="About caret mode">
                                The key that opens a keyboard-navigable review of the
                                scrollback (Mudlet's caret mode). In review mode, your
                                screen reader reads past output by character, word, and
                                line with its own cursor, and you can reach links with
                                <code> Ctrl+]</code>/<code>Ctrl+[</code>. Press the same
                                key (or <code>Esc</code>) to return to the command line.
                                <strong> Off</strong> disables it.
                            </HelpTip>
                        </label>
                        <select
                            id="caret-shortcut"
                            className="settings-select"
                            value={caretShortcut}
                            onChange={e => patchConfig({ caretShortcut: e.target.value as CaretShortcut })}
                        >
                            {CARET_SHORTCUT_OPTIONS.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                        </select>
                    </div>
                    <div className="settings-row">
                        <span className="settings-label" id="f3-search-enabled-label">
                            Enable F3 search shortcuts
                            <HelpTip label="About F3 search">
                                Make <code>F3</code> and <code>Shift+F3</code> jump to the
                                next and previous match in the scrollback (Mudlet's
                                <code> f3SearchEnabled</code>), opening the find bar if it
                                isn't already up. Each hit is announced to your screen
                                reader in full, takes keyboard focus, and is the only one
                                highlighted, so results are easy to follow one at a time.
                                Off by default — <code>F3</code> still steps through
                                results whenever the find bar is open.
                            </HelpTip>
                        </span>
                        <Toggle
                            id="f3-search-enabled"
                            aria-labelledby="f3-search-enabled-label"
                            checked={f3SearchEnabled}
                            onChange={next => patchConfig({ f3SearchEnabled: next })}
                        />
                    </div>
                </>
            ),
        },
        {
            id: 'developer',
            category: 'advanced' as const,
            title: 'Developer',
            description: 'Diagnostics for people writing packages and scripts. Leave these off for ordinary play.',
            learnMore: `${MUDLET_WIKI}/Manual:Scripting`,
            keywords: 'echo, error messages, script errors, Lua errors, debug, diagnostics',
            body: (
                <div className="settings-row">
                    <span className="settings-label" id="show-errors-main-window-label">
                        Echo Lua errors to the main console
                        <HelpTip label="About showing errors in the main window">
                            Mirror script, trigger, alias, and timer errors into the main output
                            window (in red), in addition to the script editor's <code>Errors</code>
                            tab — Mudlet's "Show errors in main console" behavior.
                        </HelpTip>
                    </span>
                    <Toggle
                        id="show-errors-main-window"
                        aria-labelledby="show-errors-main-window-label"
                        checked={showErrorsInMainWindow}
                        onChange={next => patchProfile({ showErrorsInMainWindow: next })}
                    />
                </div>
            ),
        },
        ]),
    ];

    return (
        <>
            <div className="modal-overlay" onClick={onClose} />
            <div ref={modalRef} className="modal settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
                <div className="modal-header">
                    <span className="modal-title">Settings</span>
                    <button className="modal-close" onClick={onClose} type="button" aria-label="Close">✕</button>
                </div>
                <SettingsShell
                    cards={cards}
                    subpages={SUBPAGES}
                    support={supportLink()}
                    category={category}
                    onCategory={setCategory}
                    subpage={subpage}
                    onSubpage={setSubpage}
                />
            </div>
            {fontPickerOpen && connectionId && (
                <>
                    <div className="modal-overlay font-picker-overlay" onClick={() => setFontPickerOpen(false)} />
                    <div className="modal font-picker-modal" role="dialog" aria-modal="true" aria-label="Choose font">
                        <div className="modal-header">
                            <span className="modal-title">Choose Font</span>
                            <button className="modal-close" onClick={() => setFontPickerOpen(false)} type="button" aria-label="Close">✕</button>
                        </div>
                        <div className="modal-body">
                            <FontPicker value={outputFont} onChange={handleFontChange} vfs={vfs} />
                        </div>
                    </div>
                </>
            )}
        </>
    );
}

interface MarkerRangeProps {
    id: string;
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    /** Pre-formatted display of `value` — the unit differs per control (a
     *  multiplier, a raw map-unit length), so the caller decides. */
    readout: string;
    disabled?: boolean;
    onChange: (next: number) => void;
}

/** Slider + readout for one numeric player-marker field. Commits on every
 *  input event rather than on blur (the pattern the text-entry mapper fields
 *  use) because the point of these is to drag them and watch the preview. */
function MarkerRange({ id, label, min, max, step, value, readout, disabled, onChange }: MarkerRangeProps) {
    return (
        <div className="settings-row">
            <label className="settings-label" htmlFor={id}>{label}</label>
            <input
                id={id}
                type="range"
                className="settings-marker__range"
                min={min}
                max={max}
                step={step}
                value={value}
                disabled={disabled}
                onChange={e => onChange(Number(e.target.value))}
            />
            <span className="settings-marker__readout">{readout}</span>
        </div>
    );
}

interface MarkerColorRowProps {
    id: string;
    label: string;
    color: string;
    /** 0..1, matching the renderer's alpha fields. */
    alpha: number;
    onColor: (next: string) => void;
    onAlpha: (next: number) => void;
}

/** Colour swatch + opacity slider. The swatch previews the colour at its
 *  actual alpha, so a fully transparent fill reads as transparent here rather
 *  than as a solid block that disagrees with the map. */
function MarkerColorRow({ id, label, color, alpha, onColor, onAlpha }: MarkerColorRowProps) {
    const rgb = hexToRgb(color);
    const fill = rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})` : color;
    return (
        <div className="settings-row">
            <span className="settings-label" id={`${id}-label`}>{label}</span>
            <div className="settings-marker__color" aria-labelledby={`${id}-label`}>
                <label className="settings-ansi-swatch__bar" title={label} aria-label={label}>
                    <input
                        type="color"
                        value={color}
                        onChange={e => onColor(e.target.value)}
                        aria-label={`${label} color`}
                    />
                    <span className="settings-ansi-swatch__fill settings-marker__swatch" style={{ background: fill }} />
                </label>
                <input
                    type="range"
                    className="settings-marker__range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={alpha}
                    onChange={e => onAlpha(Number(e.target.value))}
                    aria-label={`${label} opacity`}
                    title="Opacity"
                />
                <span className="settings-marker__readout">{Math.round(alpha * 100)}%</span>
            </div>
        </div>
    );
}

interface ColorCellProps {
    label: string;
    value: string | undefined;
    fallback: string;
    onChange: (next: string) => void;
    /** When provided, shows a clear button (only while a value is set) to unset the color. */
    onClear?: () => void;
}

function ColorCell({ label, value, fallback, onChange, onClear }: ColorCellProps) {
    const picked = isHexColor(value) ? value : fallback;
    const isSet = isHexColor(value);
    return (
        <Fragment>
            <span className="settings-ansi-swatch__label">{label}</span>
            <label className="settings-ansi-swatch__bar" title={label} aria-label={label}>
                <input
                    type="color"
                    value={picked}
                    onChange={e => onChange(e.target.value)}
                    aria-label={label}
                />
                <span className="settings-ansi-swatch__fill" style={{ background: picked }} />
                {onClear && isSet && (
                    <button
                        type="button"
                        className="settings-ansi-swatch__reset"
                        onClick={(e) => { e.preventDefault(); onClear(); }}
                        aria-label={`Clear ${label}`}
                        title="Clear (use none)"
                    >
                        ↺
                    </button>
                )}
            </label>
        </Fragment>
    );
}

interface AnsiSwatchProps {
    label: string;
    index: number;
    value: string | undefined;
    fallback: string;
    onChange: (next: string) => void;
    onReset: () => void;
}

function AnsiSwatch({ label, index, value, fallback, onChange, onReset }: AnsiSwatchProps) {
    const picked = isHexColor(value) ? value : fallback;
    const overridden = isHexColor(value) && value.toLowerCase() !== fallback.toLowerCase();
    return (
        <Fragment>
            <span className={`settings-ansi-swatch__label${overridden ? ' settings-ansi-swatch__label--overridden' : ''}`}>
                {label}:
            </span>
            <label className="settings-ansi-swatch__bar" title={label} aria-label={label}>
                <input
                    type="color"
                    value={picked}
                    onChange={e => onChange(e.target.value)}
                    aria-label={`${label} (ANSI ${index})`}
                />
                <span className="settings-ansi-swatch__fill" style={{ background: picked }} />
                {overridden && (
                    <button
                        type="button"
                        className="settings-ansi-swatch__reset"
                        onClick={(e) => { e.preventDefault(); onReset(); }}
                        aria-label={`Reset ${label} to default`}
                        title="Reset to default"
                    >
                        ↺
                    </button>
                )}
            </label>
        </Fragment>
    );
}
