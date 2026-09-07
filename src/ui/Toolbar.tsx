import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './components';
import { getBrand, type BrandCommand, type BrandToolbarContext, type StockToolbarButton } from '../branding';
import type { SessionStatus } from '../mud/events';
import type { AddonCommand } from './commands/addonCommands';
import { hostCommands } from './commands/hostCommands';
import { anchoredStyle, inPopupSurface, useAnchoredPopup } from './menu/anchoredPopup';
import { MenuBar } from './menu/MenuBar';
import { SplitButton } from './menu/SplitButton';
import { buildAppMenus } from './menu/appMenus';
import { placeCommands, type MenuNode, type PlacedCommand } from './menu/menuModel';
import type { ToolbarItem } from './menu/toolbarModel';
import { useConnectionId, useProfileField } from '../storage';
import { useAppStore } from '../storage/appStore';
import { useViewportMode } from '../hooks/useViewportMode';
import { useDocumentFullscreen } from '../hooks/useDocumentFullscreen';
import { useKeyboardShortcuts, type ShortcutBinding } from '../hooks/useKeyboardShortcuts';
import { boundShortcuts, shortcutLookup, shortcutPlatform, type AppCommandId } from './commands/appShortcuts';
import { useClientField } from '../storage';

interface ToolbarProps {
    connectionName: string;
    status: SessionStatus;
    ping: number | null;
    onDisconnect: () => void;
    onReconnect: () => void;
    onNewConnection: () => void;
    onOpenMap: () => void;
    onOpenScripts: () => void;
    onOpenFiles: () => void;
    onOpenLogs: () => void;
    onOpenDocs: () => void;
    onOpenHelp: () => void;
    onOpenSettings: () => void;
    /** The About dialog, reachable only from the menu bar — it lives at the
     *  session's top level rather than here, because a modal rendered inside
     *  the toolbar is inside the toolbar's stacking context (and, in
     *  fullscreen, inside its transform, which makes `position: fixed` resolve
     *  against the bar instead of the window). */
    onOpenAbout: () => void;
    /** Mudlet's Alt+L: put the keyboard back on the command line. Only ever
     *  reached from a shortcut — there is no button for it. */
    onFocusInputLine: () => void;
    /** Mudlet-format replay recording toggle state + handler. */
    replayRecording: boolean;
    onToggleReplayRecording: () => void;
    /** Playback speed of the active replay, or null when none is playing —
     *  the speed/stop controls only render mid-replay. */
    replaySpeed: number | null;
    onReplaySpeedChange: (direction: 1 | -1) => void;
    onReplayStop: () => void;
    onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
    /** Capabilities handed to brand toolbar buttons (send / raiseEvent). */
    brandContext?: BrandToolbarContext;
    /** Commands a package placed with addCommand, for the surfaces that put
     *  them on a bar. Drawn after the stock buttons, in placement order. */
    addonCommands?: AddonCommand[];
    /** The same commands for the surfaces that put them on the menu bar. A
     *  command asking for both is in both lists. */
    addonMenuCommands?: AddonCommand[];
    onAddonCommandClick?: (id: number) => void;
}

function Icon({ children }: { children: ReactNode }) {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="toolbar-icon"
        >
            {children}
        </svg>
    );
}

const IconScripts = () => <Icon><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></Icon>;
const IconFiles = () => <Icon><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></Icon>;
const IconMap = () => <Icon><polygon points="1 6 8 3 16 6 23 3 23 18 16 21 8 18 1 21 1 6" /><line x1="8" y1="3" x2="8" y2="18" /><line x1="16" y1="6" x2="16" y2="21" /></Icon>;
const IconLogs = () => <Icon><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></Icon>;
const IconDocs = () => <Icon><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></Icon>;
const IconSettings = () => <Icon><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></Icon>;
const IconHelp = () => <Icon><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></Icon>;
const IconBug = () => <Icon><path d="M8 2l1.88 1.88" /><path d="M14.12 3.88L16 2" /><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" /><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6z" /><path d="M12 20v-9" /><path d="M6.53 9C4.6 8.8 3 7.1 3 5" /><path d="M6 13H2" /><path d="M3 21c0-2.1 1.7-3.9 3.8-4" /><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" /><path d="M22 13h-4" /><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" /></Icon>;
/** The power glyph, on the Connect button the way Qt's plug icon is on Mudlet's. */
const IconConnect = () => <Icon><path d="M18.36 6.64a9 9 0 1 1-12.73 0" /><line x1="12" y1="2" x2="12" y2="12" /></Icon>;
const IconMute = () => <Icon><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></Icon>;
/** The same speaker with its waves back, for the button that gives sound back. */
const IconSound = () => <Icon><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /></Icon>;
const IconRecord = () => <Icon><circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="9" /></Icon>;
const IconStopReplay = () => <Icon><rect x="7" y="7" width="10" height="10" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="9" /></Icon>;

/** A placed command's icon: a package gives an image path, a host app or a
 *  brand gives a node. Both land in a box the stylesheet sizes, so a broken
 *  image leaves the name on its own rather than a torn image box. */
function CommandIcon({ icon }: { icon: ReactNode }) {
    if (icon === undefined || icon === null || icon === '') return null;
    return (
        <span className="addon-command-icon" aria-hidden="true">
            {typeof icon === 'string' ? <img src={icon} alt="" /> : icon}
        </span>
    );
}

/**
 * A brand's declared commands, seeded into the runtime registry so the two are
 * one list: `commands.remove('roll')` reaches a brand-declared command exactly
 * as it reaches one the host added later. They come and go with the session,
 * which is also when a brand's context (send / raiseEvent) exists at all.
 */
function useBrandCommands(commands: BrandCommand[] | undefined, ctx: BrandToolbarContext | undefined): void {
    useEffect(() => {
        if (!commands?.length || !ctx) return;
        const ids = commands.map(c => hostCommands.add({
            ...c,
            // A brand's handler is written against a live profile; the registry
            // hands null when there is none, which cannot happen while this
            // effect is mounted but is worth not pretending about.
            onClick: given => { if (given) c.onClick(given); },
        }));
        return () => { for (const id of ids) hostCommands.remove(id); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [commands, ctx?.connectionId]);
}

export function Toolbar({ connectionName, status, ping, onDisconnect, onReconnect, onNewConnection, onOpenMap, onOpenScripts, onOpenFiles, onOpenLogs, onOpenDocs, onOpenHelp, onOpenSettings, onOpenAbout, onFocusInputLine, replayRecording, onToggleReplayRecording, replaySpeed, onReplaySpeedChange, onReplayStop, onContextMenu, brandContext, addonCommands, addonMenuCommands, onAddonCommandClick }: ToolbarProps) {
    const [menuOpen, setMenuOpen] = useState(false);
    const hamburgerRef = useRef<HTMLDivElement>(null);
    const hamburgerMenuRef = useRef<HTMLDivElement>(null);
    // The two menu entries with no button of their own. Read here rather than
    // threaded down from the session: both are profile settings the store
    // already publishes, and the toolbar sits inside the profile's context.
    const connectionId = useConnectionId();
    const patchProfile = useAppStore(s => s.patchConnectionProfile);
    const showTimestamps = useProfileField('showTimestamps') === true;
    // Undefined defaults to enabled (see ProfileSettings.loggingEnabled).
    const loggingEnabled = useProfileField('loggingEnabled') !== false;
    // Shortcut overrides are application-wide, as Mudlet's shortcuts are.
    const shortcutOverrides = useClientField('shortcuts');
    const fullscreen = useDocumentFullscreen();

    // Mudlet's two media mute gates, which live in the profile's config bag
    // (the same slot `setConfig` and the settings dialog write). "All" is both
    // of them, as it is there — Mudlet's "Mute all media" is not a third gate.
    const configBag = (useProfileField('config') ?? {}) as Record<string, unknown>;
    const muteApi = configBag.muteMediaAPI === true;
    const muteGame = configBag.muteMediaGame === true;
    const muteAll = muteApi && muteGame;

    // Brand toolbar config: hide stock buttons, append brand buttons, restyle,
    // and rebuild either bar outright.
    const toolbarCfg = getBrand().toolbar;
    const hidden = new Set<StockToolbarButton>(toolbarCfg?.hide ?? []);
    const show = (id: StockToolbarButton) => !hidden.has(id);

    // Commands the host app placed through the exported registry, plus the
    // brand's own opening set (seeded into the same registry, so the two are
    // one list and `commands.remove()` can reach either).
    useBrandCommands(toolbarCfg?.commands, brandContext);
    const hosted = useSyncExternalStore(hostCommands.subscribe, hostCommands.list, hostCommands.list);

    // Mudlet's two bars, each with its own visibility setting. Absent means on.
    const menuBarSetting = useProfileField('showMenuBar') !== false;
    const toolBarSetting = useProfileField('showToolbar') !== false;
    // Below the desktop breakpoint the button row has nowhere near the width it
    // needs — that is what the hamburger has always been for — so the rows are
    // not the player's choice there: the menu row carries the hamburger and the
    // button row is not drawn at all.
    const compact = useViewportMode() !== 'desktop';
    // A brand can remove either bar outright, which the player's own setting
    // cannot undo — the two are different decisions. `false` removes it; a
    // function is a transform, and means the bar stays.
    const brandKeepsMenuBar = toolbarCfg?.menuBar !== false;
    const brandKeepsButtonBar = toolbarCfg?.buttonBar !== false;
    // Of the bars the brand kept, the settings refuse to switch the last one
    // off — so with either kept, one row is always drawn, and whichever is on
    // top carries the profile's name, status dot and ping (they belong to
    // neither bar). A brand that removed both gets no top bar at all, which is
    // a legitimate thing for an embedded client to want.
    const showMenuRow = brandKeepsMenuBar && (compact || menuBarSetting || !brandKeepsButtonBar);
    const showButtonRow = brandKeepsButtonBar && !compact
        && (toolBarSetting || !brandKeepsMenuBar);

    useEffect(() => {
        if (!menuOpen) return;
        const onDocPointer = (e: PointerEvent) => {
            if (!inPopupSurface(hamburgerRef.current, e.target)) setMenuOpen(false);
        };
        document.addEventListener('pointerdown', onDocPointer);
        return () => document.removeEventListener('pointerdown', onDocPointer);
    }, [menuOpen]);

    // The hamburger's list is a popup like any other menu: portaled to <body>
    // so the bar's own stacking context can't cap it, and placed against the
    // button. Right-aligned, as its stylesheet used to be.
    const hamburgerPlacement = useAnchoredPopup(
        menuOpen ? hamburgerRef.current : null, hamburgerMenuRef, 'end', menuOpen,
    );

    const fire = (cb: () => void) => () => { setMenuOpen(false); cb(); };

    const onReportBug = () => {
        window.open('https://github.com/Mudlet/mudlet-web/issues/new', '_blank', 'noopener,noreferrer');
    };

    const isLive = status !== 'disconnected';
    const handleCloseProfile = () => {
        if (isLive) onDisconnect();
        onNewConnection();
    };

    // Mudlet's Connect button: one action with the related ones behind an
    // arrow. Connect stays the default whatever the profile is doing, as it is
    // there — the button does not change under the pointer, and Disconnect is
    // one press of the arrow away.
    //
    // This is also the Games menu, built once and handed to both: the two are
    // the same control on two surfaces, and a list that had drifted apart
    // between them would be a bug nobody could see until they compared.
    // Mudlet's fourth entry, "Close Mudlet", has no counterpart — a page cannot
    // close the tab it is in. Connect and Reconnect are named separately as
    // Mudlet names them, and here run the same redial: both dial the address
    // the profile has stored, whether or not a session is already up.
    const keyOf = shortcutLookup(shortcutOverrides, shortcutPlatform());
    const connectionItems: MenuNode[] = show('connection') ? [
        { kind: 'action', id: 'connect', label: 'Connect', shortcut: keyOf('connect'), run: onReconnect },
        { kind: 'separator', id: 'connection-1' },
        { kind: 'action', id: 'disconnect', label: 'Disconnect', shortcut: keyOf('disconnect'), run: onDisconnect, disabled: !isLive },
        { kind: 'action', id: 'reconnect', label: 'Reconnect', shortcut: keyOf('reconnect'), run: onReconnect },
        ...(show('close') ? [
            { kind: 'separator', id: 'connection-2' } as MenuNode,
            { kind: 'action', id: 'closeProfile', label: 'Close profile', shortcut: keyOf('closeProfile'), run: handleCloseProfile } as MenuNode,
        ] : []),
    ] : [];

    // Mudlet's Mute button, whose own default action is "Mute all media" and is
    // checkable. The three entries write the same profile config bag the
    // settings dialog does; the scripting API subscribes to that bag and pushes
    // the gates onto the live sound and video managers.
    const setMute = (api: boolean, game: boolean) => {
        if (connectionId) {
            patchProfile(connectionId, { config: { ...configBag, muteMediaAPI: api, muteMediaGame: game } });
        }
    };
    const muteItems: MenuNode[] = [
        { kind: 'action', id: 'mute', label: 'Mute all media', shortcut: keyOf('mute'), checked: muteAll, run: () => setMute(!muteAll, !muteAll) },
        { kind: 'action', id: 'mute-api', label: 'Mute sounds from this client (triggers, scripts, …)', checked: muteApi, run: () => setMute(!muteApi, muteGame) },
        { kind: 'action', id: 'mute-game', label: 'Mute sounds from the game (MSP)', checked: muteGame, run: () => setMute(muteApi, !muteGame) },
    ];

    // Commands from the two sources that place them — a profile's Lua packages
    // and the host app's own registry — reduced to one list. Nothing below this
    // line cares which is which, which is the point: a white-label client's
    // command should sit in a menu exactly the way a package's does.
    const placed: PlacedCommand[] = [
        ...(addonMenuCommands ?? []).map((c): PlacedCommand => ({
            id: `lua:${c.id}`,
            name: c.name, icon: c.icon, tooltip: c.tooltip, menuPath: c.menuPath,
            shortcut: c.shortcut, enabled: c.enabled, checked: c.checked,
            run: () => onAddonCommandClick?.(c.id),
        })),
        ...hosted.filter(c => c.surfaces !== 'toolbar').map((c): PlacedCommand => ({
            id: `host:${c.id}`,
            name: c.name, icon: c.icon, tooltip: c.tooltip, menuPath: c.menuPath,
            shortcut: c.shortcut, enabled: c.enabled, checked: c.checked,
            run: () => c.onClick(brandContext ?? null),
        })),
    ];
    /** Those of them with a button, in placement order, plus the pulse a
     *  package's `setCommandPulse` asked for (the host API has no pulse). */
    const toolbarCommands = [
        ...(addonCommands ?? []).map(c => ({
            id: `lua:${c.id}`, name: c.name, icon: c.icon, tooltip: c.tooltip,
            enabled: c.enabled, checked: c.checked, pulse: c.pulse,
            run: () => onAddonCommandClick?.(c.id),
        })),
        ...hosted.filter(c => c.surfaces !== 'menu').map(c => ({
            id: `host:${c.id}`, name: c.name, icon: c.icon, tooltip: c.tooltip,
            enabled: c.enabled, checked: c.checked, pulse: null,
            run: () => c.onClick(brandContext ?? null),
        })),
    ];

    // Mudlet's menu bar, then whatever asked to hang off it. Built on every
    // render rather than memoised: every entry closes over a prop or a piece of
    // state that changes, so a memo would need all of them as dependencies and
    // would still rebuild whenever any one moved.
    const stockMenus = placeCommands(
        buildAppMenus({
            show,
            appName: getBrand().appName,
            connectionItems,
            replayRecording,
            replaySpeed,
            fullscreen: fullscreen.active,
            fullscreenAvailable: fullscreen.available,
            showToolbar: toolBarSetting,
            showTimestamps,
            muteItems,
            shortcutFor: keyOf,
            onOpenScripts,
            onOpenMap,
            onOpenFiles,
            onOpenLogs,
            onToggleReplayRecording,
            onReplayStop,
            onOpenSettings,
            onOpenDocs,
            onOpenHelp,
            onOpenAbout,
            onReportBug,
            onToggleTimestamps: () => {
                if (connectionId) patchProfile(connectionId, { showTimestamps: !showTimestamps });
            },
            onToggleFullscreen: fullscreen.toggle,
            onToggleToolbar: () => {
                if (connectionId) patchProfile(connectionId, { showToolbar: !toolBarSetting });
            },
        }),
        placed,
    );

    // The brand's turn, after everything else has had theirs.
    const menuBarCfg = toolbarCfg?.menuBar;
    const menus = typeof menuBarCfg === 'function' && brandContext
        ? menuBarCfg(stockMenus, brandContext)
        : stockMenus;

    // Below the menu bar's breakpoint the bar is gone, and a command that asked
    // for the menu only has no button in the row either — so the hamburger
    // carries those, or such a command would be unreachable on a phone.
    const menuOnlyCommands = [
        ...(addonMenuCommands ?? []).filter(c => c.surfaces === 'menu')
            .map(c => ({ id: `lua:${c.id}`, name: c.name, icon: c.icon, tooltip: c.tooltip,
                enabled: c.enabled, checked: c.checked, run: () => onAddonCommandClick?.(c.id) })),
        ...hosted.filter(c => c.surfaces === 'menu')
            .map(c => ({ id: c.id, name: c.name, icon: c.icon, tooltip: c.tooltip,
                enabled: c.enabled, checked: c.checked, run: () => c.onClick(brandContext ?? null) })),
    ];

    // ── Keyboard shortcuts ────────────────────────────────────────────────
    // Mudlet's menu accelerators, dispatched here because this is where every
    // one of these actions already is. A command a brand has hidden gets no
    // action and so no binding: the key stays free rather than firing something
    // the player cannot see.
    const shortcutActions: Record<AppCommandId, (() => void) | null> = {
        connect: show('connection') ? onReconnect : null,
        // Disconnecting a profile that is not connected is not an error worth
        // making, but it is not worth doing either.
        disconnect: show('connection') ? () => { if (isLive) onDisconnect(); } : null,
        reconnect: show('connection') ? onReconnect : null,
        closeProfile: show('close') ? handleCloseProfile : null,
        scriptEditor: show('scripts') ? onOpenScripts : null,
        map: show('map') ? onOpenMap : null,
        files: show('files') ? onOpenFiles : null,
        logs: show('logs') ? onOpenLogs : null,
        toggleReplay: show('record') ? onToggleReplayRecording : null,
        preferences: show('settings') ? onOpenSettings : null,
        toggleTimestamps: () => {
            if (connectionId) patchProfile(connectionId, { showTimestamps: !showTimestamps });
        },
        mute: show('mute') ? () => setMute(!muteAll, !muteAll) : null,
        toggleLogging: () => {
            if (connectionId) patchProfile(connectionId, { loggingEnabled: !loggingEnabled });
        },
        fullscreen: fullscreen.available ? fullscreen.toggle : null,
        toggleButtonBar: () => {
            if (connectionId) patchProfile(connectionId, { showToolbar: !toolBarSetting });
        },
        inputLine: onFocusInputLine,
        docs: show('docs') ? onOpenDocs : null,
        help: show('help') ? onOpenHelp : null,
        about: onOpenAbout,
    };

    const shortcutBindings: ShortcutBinding[] = [
        ...boundShortcuts(shortcutOverrides, shortcutPlatform())
            .flatMap(({ id, shortcut }) => {
                const run = shortcutActions[id];
                return run ? [{ shortcut, run }] : [];
            }),
        // Placed commands carry their own key, whoever placed them. A disabled
        // one keeps its binding reserved but does nothing, the same way its
        // button is drawn and does nothing — disabling a command has not given
        // the key back.
        ...placed.flatMap(c => (c.shortcut && c.enabled !== false
            ? [{ shortcut: c.shortcut, run: c.run }]
            : [])),
    ];
    useKeyboardShortcuts(shortcutBindings);

    // Mudlet's main-toolbar order (mudlet.cpp, `mpMainToolBar->addAction` and
    // `addWidget` in sequence), with this client's buttons standing in for the
    // ones it has: the seven editor actions (Triggers … Variables) are one
    // Script editor here, Manual is the Docs/Help pair, Notepad and Packages
    // are the Files browser, and Replay is the recorder. Mudlet's Discord,
    // MultiView and Full Screen buttons have no counterpart — the first two do
    // not exist here and the third is a menu entry now.
    //
    // `stacked` is the hamburger's layout, where a split button's popup would
    // be a popup inside a popup: there the default action and its menu entries
    // are drawn as plain siblings instead.
    const stockItems: ToolbarItem[] = [
        // The default action follows the session rather than staying Connect
        // the way Mudlet's does: on a client that is already connected, Connect
        // is the one thing on the button nobody wants, and the button is also
        // the clearest place to see that the session is up. The arrow's list
        // does not change — Connect is still in it, and still redials.
        show('connection') ? {
            kind: 'split', id: 'connection',
            title: isLive ? 'Disconnect from the game' : 'Connect to the game',
            menuLabel: 'Connection actions',
            items: connectionItems,
            icon: <IconConnect />,
            label: isLive ? 'Disconnect' : 'Connect',
            run: isLive ? onDisconnect : onReconnect,
        } : null,
        show('scripts') ? { kind: 'button', id: 'scripts', icon: <IconScripts />, label: 'Scripts', run: onOpenScripts } : null,
        show('mute') ? {
            kind: 'split', id: 'mute',
            title: muteAll ? 'Let sound and video play again' : 'Mute all sound and video',
            menuLabel: 'Mute options',
            items: muteItems,
            checked: muteAll,
            // Icon and label both name what the press will do, so the two
            // cannot disagree. Everything is already silent when it says
            // Unmute; the pressed styling says so as well.
            icon: muteAll ? <IconSound /> : <IconMute />,
            label: muteAll ? 'Unmute' : 'Mute',
            run: () => setMute(!muteAll, !muteAll),
        } : null,
        show('map') ? { kind: 'button', id: 'map', icon: <IconMap />, label: 'Map', run: onOpenMap } : null,
        show('docs') ? { kind: 'button', id: 'docs', icon: <IconDocs />, label: 'Docs', title: 'Lua scripting reference', run: onOpenDocs } : null,
        show('help') ? { kind: 'button', id: 'help', icon: <IconHelp />, label: 'Help', title: 'Profiles, connecting, storage and browser limits', run: onOpenHelp } : null,
        show('settings') ? { kind: 'button', id: 'settings', icon: <IconSettings />, label: 'Settings', run: onOpenSettings } : null,
        show('files') ? { kind: 'button', id: 'files', icon: <IconFiles />, label: 'Files', run: onOpenFiles } : null,
        show('logs') ? { kind: 'button', id: 'logs', icon: <IconLogs />, label: 'Logs', run: onOpenLogs } : null,
        show('record') ? {
            kind: 'button', id: 'record',
            className: replayRecording ? 'toolbar-record--on' : undefined,
            title: replayRecording ? 'Stop recording of replay' : 'Start recording of replay (Mudlet .dat format, saved to the profile log folder)',
            icon: <IconRecord />,
            label: replayRecording ? 'Recording' : 'Record',
            run: onToggleReplayRecording,
        } : null,
        replaySpeed !== null ? {
            kind: 'custom', id: 'replay-controls',
            node: (
                <span className="toolbar-replay-controls">
                    <Button variant="ghost" title="Slow down replay" onClick={() => onReplaySpeedChange(-1)}>−</Button>
                    <span className="toolbar-replay-speed" title="Replay speed">×{replaySpeed}</span>
                    <Button variant="ghost" title="Speed up replay" onClick={() => onReplaySpeedChange(1)}>+</Button>
                    <Button variant="ghost" title="Stop replay" onClick={fire(onReplayStop)}><IconStopReplay />Stop replay</Button>
                </span>
            ),
        } : null,
        show('reportBug') ? { kind: 'button', id: 'reportBug', icon: <IconBug />, label: 'Report Bug', run: onReportBug } : null,
        // The deprecated `buttons` list, still drawn where it always was.
        ...(brandContext ? (toolbarCfg?.buttons ?? []).map((b): ToolbarItem => ({
            kind: 'button', id: `brand:${b.id}`, icon: b.icon, label: b.label, title: b.title,
            run: () => b.onClick(brandContext),
        })) : []),
        // Commands a package or the host app placed. A disabled one keeps its
        // button and is drawn unavailable rather than disappearing, so the bar
        // does not reflow under the player every time something toggles one.
        // The pulse is a CSS variable pair the stylesheet animates between.
        ...toolbarCommands.map((c): ToolbarItem => ({
            kind: 'button',
            id: c.id,
            className: `addon-command${c.checked ? ' addon-command--checked' : ''}${c.pulse ? ' addon-command--pulsing' : ''}`,
            title: c.tooltip || c.name,
            disabled: c.enabled === false,
            checked: c.checked,
            icon: <CommandIcon icon={c.icon} />,
            label: c.name,
            style: c.pulse ? {
                ['--addon-pulse-a' as string]: c.pulse.colour,
                ['--addon-pulse-b' as string]: c.pulse.altColour,
                ['--addon-pulse-ms' as string]: `${c.pulse.intervalMs}ms`,
            } : undefined,
            run: c.run,
        })),
    ].filter((item): item is ToolbarItem => item !== null);

    // The brand's turn: it gets the finished list — stock buttons, its own, and
    // every package and host command — and returns what to draw.
    const buttonBarCfg = toolbarCfg?.buttonBar;
    const items = typeof buttonBarCfg === 'function' && brandContext
        ? buttonBarCfg(stockItems, brandContext)
        : stockItems;

    /** `stacked` is the hamburger's layout, where a split button's popup would
     *  be a popup inside a popup: there the default action and its menu entries
     *  are drawn as plain siblings instead. */
    const actions = (stacked: boolean) => items.map(item => {
        if (item.kind === 'custom') return <Fragment key={item.id}>{item.node}</Fragment>;
        if (item.kind === 'split') {
            return (
                <SplitButton
                    key={item.id}
                    title={item.title}
                    menuLabel={item.menuLabel}
                    items={item.items}
                    checked={item.checked}
                    onClick={item.run}
                    stacked={stacked}
                    onAnyAction={() => setMenuOpen(false)}
                >
                    {item.icon}{item.label}
                </SplitButton>
            );
        }
        return (
            <Button
                key={item.id}
                variant="ghost"
                className={item.className}
                title={item.title}
                disabled={item.disabled}
                aria-pressed={item.checked}
                style={item.style}
                // Qt gives a toolbar button Qt::NoFocus, so clicking one does
                // not take the keyboard away from the command line. A command
                // is clicked mid-play, and a player whose next keystrokes went
                // to a button instead of the game would rightly call it broken.
                // Preventing the default on mousedown is the web spelling of
                // it; the click still runs.
                onMouseDown={e => e.preventDefault()}
                onClick={fire(item.run)}
            >
                {item.icon}{item.label}
            </Button>
        );
    });

    // Whose profile this is and how it is doing, in two halves so the menu bar
    // can sit between them. Both go into whichever row stands at the top, so
    // hiding a bar never takes the status dot with it.
    const brandMark = (
        <>
            {getBrand().logoUrl && (
                <img className="brand-logo" src={getBrand().logoUrl} alt="" aria-hidden="true" />
            )}
            <span className="brand">{getBrand().appName}</span>
        </>
    );
    // The name is the row's flexible middle: it takes the slack, which pushes
    // the dot and the ping (and, in a single-row layout, the buttons) right.
    const statusBlock = (
        <>
            <span className="toolbar-connection-name">{connectionName}</span>
            <span
                className={`status-dot status-${status}`}
                title={status}
                aria-label={status}
            />
            {ping !== null && (
                <span className="ping">{Math.round(ping)} ms</span>
            )}
        </>
    );

    // The overflow the compact layouts use in place of the button row, which is
    // why it hangs off the menu row: below the desktop breakpoint that is the
    // only row there is. The stylesheet keeps it out of sight on wider windows,
    // where the buttons are on their own row already.
    const hamburger = (
        <div className="toolbar-hamburger" ref={hamburgerRef}>
            <button
                type="button"
                className="toolbar-hamburger-btn"
                onClick={() => setMenuOpen(v => !v)}
                aria-label="Menu"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
            >
                <span /><span /><span />
            </button>
            {menuOpen && createPortal(
                <div
                    ref={hamburgerMenuRef}
                    className="toolbar-hamburger-menu"
                    role="menu"
                    data-anchored-popup=""
                    style={anchoredStyle(hamburgerPlacement)}
                >
                    {actions(true)}
                    {menuOnlyCommands.length > 0 && <span className="toolbar-sep" aria-hidden="true" />}
                    {menuOnlyCommands.map(c => (
                        <Button
                            key={c.id}
                            variant="ghost"
                            title={c.tooltip || c.name}
                            disabled={!c.enabled}
                            aria-pressed={c.checked}
                            onClick={fire(c.run)}
                        >
                            <CommandIcon icon={c.icon} />
                            {c.name}
                        </Button>
                    ))}
                </div>,
                (hamburgerRef.current ?? document.body).ownerDocument.body,
            )}
        </div>
    );

    return (
        // Mudlet's two bars, stacked as they are there: the menus on top, the
        // buttons under them. The banner landmark is the pair of them, since
        // either row can be switched off.
        //
        // `.mudlet-toolbar` stays the menu row's class — it is a documented
        // brand-styling hook, and the brand's own className rides on it.
        <div
            className={`mudlet-topbar${showMenuRow && showButtonRow ? '' : ' mudlet-topbar--single'}`}
            role="banner"
            onContextMenu={onContextMenu}
        >
            {showMenuRow && (
                <div className={`mudlet-toolbar${toolbarCfg?.className ? ` ${toolbarCfg.className}` : ''}`}>
                    {brandMark}
                    {getBrand().toolbar?.menuBar !== false && <MenuBar menus={menus} />}
                    {statusBlock}
                    {hamburger}
                </div>
            )}
            {showButtonRow && (
                <div className="mudlet-buttonbar-row">
                    {!showMenuRow && brandMark}
                    {!showMenuRow && statusBlock}
                    <div className="toolbar-actions">{actions(false)}</div>
                </div>
            )}
        </div>
    );
}
