import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './components';
import { getBrand, type BrandToolbarContext, type StockToolbarButton } from '../branding';
import type { SessionStatus } from '../mud/events';

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
const IconReconnect = () => <Icon><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></Icon>;
const IconDisconnect = () => <Icon><path d="M18.36 6.64a9 9 0 1 1-12.73 0" /><line x1="12" y1="2" x2="12" y2="12" /></Icon>;
const IconCloseProfile = () => <Icon><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></Icon>;
const IconRecord = () => <Icon><circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="9" /></Icon>;
const IconStopReplay = () => <Icon><rect x="7" y="7" width="10" height="10" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="9" /></Icon>;

export function Toolbar({ connectionName, status, ping, onDisconnect, onReconnect, onNewConnection, onOpenMap, onOpenScripts, onOpenFiles, onOpenLogs, onOpenDocs, onOpenHelp, onOpenSettings, replayRecording, onToggleReplayRecording, replaySpeed, onReplaySpeedChange, onReplayStop, onContextMenu, brandContext }: ToolbarProps) {
    const [menuOpen, setMenuOpen] = useState(false);
    const hamburgerRef = useRef<HTMLDivElement>(null);

    // Brand toolbar config: hide stock buttons, append brand buttons, restyle.
    const toolbarCfg = getBrand().toolbar;
    const hidden = new Set<StockToolbarButton>(toolbarCfg?.hide ?? []);
    const show = (id: StockToolbarButton) => !hidden.has(id);

    useEffect(() => {
        if (!menuOpen) return;
        const onDocPointer = (e: PointerEvent) => {
            if (!hamburgerRef.current?.contains(e.target as Node)) setMenuOpen(false);
        };
        document.addEventListener('pointerdown', onDocPointer);
        return () => document.removeEventListener('pointerdown', onDocPointer);
    }, [menuOpen]);

    const fire = (cb: () => void) => () => { setMenuOpen(false); cb(); };

    const onReportBug = () => {
        window.open('https://github.com/Mudlet/mudlet-web/issues/new', '_blank', 'noopener,noreferrer');
    };

    const isLive = status !== 'disconnected';
    const handleCloseProfile = () => {
        if (isLive) onDisconnect();
        onNewConnection();
    };

    const actions = (
        <>
            {show('scripts') && <Button variant="ghost" onClick={fire(onOpenScripts)}><IconScripts />Scripts</Button>}
            {show('files') && <Button variant="ghost" onClick={fire(onOpenFiles)}><IconFiles />Files</Button>}
            {show('map') && <Button variant="ghost" onClick={fire(onOpenMap)}><IconMap />Map</Button>}
            {show('logs') && <Button variant="ghost" onClick={fire(onOpenLogs)}><IconLogs />Logs</Button>}
            {show('record') && (
                <Button
                    variant="ghost"
                    className={replayRecording ? 'toolbar-record--on' : undefined}
                    title={replayRecording ? 'Stop recording of replay' : 'Start recording of replay (Mudlet .dat format, saved to the profile log folder)'}
                    onClick={fire(onToggleReplayRecording)}
                >
                    <IconRecord />{replayRecording ? 'Recording' : 'Record'}
                </Button>
            )}
            {replaySpeed !== null && (
                <span className="toolbar-replay-controls">
                    <Button variant="ghost" title="Slow down replay" onClick={() => onReplaySpeedChange(-1)}>−</Button>
                    <span className="toolbar-replay-speed" title="Replay speed">×{replaySpeed}</span>
                    <Button variant="ghost" title="Speed up replay" onClick={() => onReplaySpeedChange(1)}>+</Button>
                    <Button variant="ghost" title="Stop replay" onClick={fire(onReplayStop)}><IconStopReplay />Stop replay</Button>
                </span>
            )}
            {show('docs') && <Button variant="ghost" title="Lua scripting reference" onClick={fire(onOpenDocs)}><IconDocs />Docs</Button>}
            {show('help') && <Button variant="ghost" title="Profiles, connecting, storage and browser limits" onClick={fire(onOpenHelp)}><IconHelp />Help</Button>}
            {show('reportBug') && <Button variant="ghost" onClick={fire(onReportBug)}><IconBug />Report Bug</Button>}
            {show('settings') && <Button variant="ghost" onClick={fire(onOpenSettings)}><IconSettings />Settings</Button>}
            {brandContext && toolbarCfg?.buttons?.map(b => (
                <Button key={b.id} variant="ghost" title={b.title} onClick={fire(() => b.onClick(brandContext))}>
                    {b.icon}{b.label}
                </Button>
            ))}
            <span className="toolbar-sep" aria-hidden="true" />
            {show('connection') && (isLive
                ? <Button variant="ghost" className="toolbar-conn-btn" onClick={fire(onDisconnect)}><IconDisconnect />Disconnect</Button>
                : <Button variant="ghost" className="toolbar-conn-btn" onClick={fire(onReconnect)}><IconReconnect />Reconnect</Button>
            )}
            {show('close') && <Button variant="ghost" onClick={fire(handleCloseProfile)}><IconCloseProfile />Close</Button>}
        </>
    );

    return (
        <div className={`mudix-toolbar${toolbarCfg?.className ? ` ${toolbarCfg.className}` : ''}`} onContextMenu={onContextMenu}>
            {getBrand().logoUrl && (
                <img className="brand-logo" src={getBrand().logoUrl} alt="" aria-hidden="true" />
            )}
            <span className="brand">{getBrand().appName}</span>
            <span className="toolbar-connection-name">{connectionName}</span>
            <span
                className={`status-dot status-${status}`}
                title={status}
                aria-label={status}
            />
            {ping !== null && (
                <span className="ping">{Math.round(ping)} ms</span>
            )}
            <div className="toolbar-actions">{actions}</div>
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
                {menuOpen && (
                    <div className="toolbar-hamburger-menu" role="menu">
                        {actions}
                    </div>
                )}
            </div>
        </div>
    );
}
