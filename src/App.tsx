import { useEffect, useRef, useState } from 'react';
import { ConnectionScreen } from './ui/ConnectionScreen';
import { BrandLoginScreen } from './ui/BrandLoginScreen';
import { SettingsModal } from './ui/SettingsModal';
import { ProfileBusyScreen } from './ui/ProfileBusyScreen';
import { FolderPermissionScreen } from './ui/FolderPermissionScreen';
import { ProfileSession } from './ProfileSession';
import { acquireProfileLock, isProfileLockHeld } from './utils/profileLock';
import { ProfileVFS } from './scripting/vfs/ProfileVFS';
import { registerVfs, unregisterVfs } from './scripting/vfs/vfsBridge';
import { loadProfileData } from './storage/profileVfsData';
import { isMudletProfileVfs, loadMudletLinkedProfile } from './import/mudletLink';
import { loadFolderHandle, checkFolderPermission, requestFolderPermission, clearFolderHandle } from './scripting/vfs/folderHandleStore';
import { ensurePersistentStorage } from './storage/persistentStorage';
import { useAppStore, type MudConnection } from './storage';
import { GAME_LINK_PARAM, findGameByLink } from './mud/games/gameLinks';
import { getBrand, isBrandedMode, brandConnectionData, matchBrandProfile } from './branding';

/**
 * Best-effort (re)grant of a linked profile's folder permission. Must be called
 * from within a user gesture (the Open/Connect click) — `requestPermission`
 * needs transient activation, which the cold-start mount effect doesn't have, so
 * without this a linked profile silently falls back to IndexedDB and loads empty.
 * No-ops for non-folder profiles and on the deep-link path (no activation).
 */
async function ensureFolderPermission(connectionId: string): Promise<void> {
    try {
        const handle = await loadFolderHandle(connectionId);
        if (!handle) return;
        if ((await checkFolderPermission(handle)) === 'granted') return;
        await requestFolderPermission(handle);
    } catch {
        /* best-effort — the mount falls back to IDB if it's still not granted */
    }
}

export default function App() {
    const [activeConnection, setActiveConnection] = useState<MudConnection | null>(null);
    const [autoConnect, setAutoConnect] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    // Single-owner lock state for the open profile. The session is mounted only
    // once we own the lock ('held'); 'acquiring' is the brief wait for a free
    // lock, 'waiting' means another tab currently owns the profile.
    const [lockPhase, setLockPhase] = useState<'none' | 'acquiring' | 'waiting' | 'held'>('none');
    // The open profile's VFS, mounted here (after the lock, before the session
    // renders) so per-profile data is available synchronously at first paint.
    // App owns its lifecycle; the engine just consumes it.
    const [profileVfs, setProfileVfs] = useState<ProfileVFS | null>(null);
    // Linked-folder permission gate: when a Mudlet-linked profile is opened but
    // the browser hasn't granted folder access (e.g. a fresh deep-link load, no
    // gesture to prompt with), we block on a decision screen instead of mounting
    // an empty local copy. `folderGateHandle` is the folder we need access to;
    // `folderRetry` re-runs the mount effect after the user grants or unlinks.
    const [folderGateHandle, setFolderGateHandle] = useState<FileSystemDirectoryHandle | null>(null);
    const [folderRetry, setFolderRetry] = useState(0);
    const patchConnection = useAppStore(s => s.patchConnection);

    const deepLinkProfileId = useRef(new URLSearchParams(window.location.search).get('profile'));
    // `&connect=1` (set by loadProfile in another tab) auto-dials on open instead
    // of just opening the profile. Read once, alongside the profile id.
    const deepLinkConnect = useRef(new URLSearchParams(window.location.search).get('connect') === '1');
    // `?play=<game>` names one of the bundled games — a "Play Astaria" link from
    // a website. The connection screen offers it (existing profiles for it, or a
    // prefilled Add form); nothing is created or dialed without a click, so a
    // bookmarked link is safe to open again and again. Ignored in branded builds,
    // which target one MUD and never show the catalogue.
    const [linkedGame, setLinkedGame] = useState(() => (
        isBrandedMode() ? null : findGameByLink(new URLSearchParams(window.location.search).get(GAME_LINK_PARAM))
    ));
    // Theme is per-profile with a global launcher fallback. While a profile is
    // open (lock held), its own theme override wins; on the connection screen /
    // busy screen we use the launcher theme. Applied in one place so there's a
    // single owner of document.documentElement.dataset.theme.
    const launcherTheme = useAppStore(s => s.client.theme);
    const profileTheme = useAppStore(s => (activeConnection ? s.connectionProfile[activeConnection.id]?.theme : undefined));
    const effectiveTheme = (activeConnection && lockPhase === 'held' && profileTheme) ? profileTheme : launcherTheme;
    useEffect(() => {
        document.documentElement.dataset.theme = effectiveTheme;
    }, [effectiveTheme]);

    const connections = useAppStore(s => s.connections);
    const addConnection    = useAppStore(s => s.addConnection);
    const updateConnection = useAppStore(s => s.updateConnection);
    const removeConnection = useAppStore(s => s.removeConnection);

    const brand = getBrand();

    // Branded single-profile builds seed the managed profile on first launch
    // (per-login profiles are created at login time instead). Idempotent via
    // the store state, so StrictMode's double effect run and every later
    // launch are no-ops.
    useEffect(() => {
        if (brand.profileMode === 'perLogin') return;
        const seed = brandConnectionData(brand);
        if (!seed || useAppStore.getState().connections.length > 0) return;
        addConnection(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const setProfileQuery = (id: string | null) => {
        // Branded builds keep the URL clean — no ?profile= is written (a
        // reload lands on the login form anyway, since credentials are never
        // persisted). Deep links are still honored when present, and closing
        // a profile still cleans one up.
        if (id && isBrandedMode()) return;
        const url = new URL(window.location.href);
        if (id) url.searchParams.set('profile', id);
        else url.searchParams.delete('profile');
        window.history.replaceState(null, '', url.toString());
    };

    // The game link has been offered; drop it so it can't fire twice, and take
    // the parameter out of the address bar so a later reload lands on the plain
    // launcher rather than re-opening the prompt.
    const clearGameLink = () => {
        setLinkedGame(null);
        const url = new URL(window.location.href);
        if (!url.searchParams.has(GAME_LINK_PARAM)) return;
        url.searchParams.delete(GAME_LINK_PARAM);
        window.history.replaceState(null, '', url.toString());
    };

    const openProfile = (connection: MudConnection, withConnect: boolean) => {
        setAutoConnect(withConnect);
        // Opening a profile is the point the user commits real data to browser
        // storage, and it's a click, so Firefox's permission prompt has the
        // activation it wants. Fire-and-forget: nothing below depends on it, and
        // a refusal only means the storage docs' "export to back up" advice
        // matters more.
        void ensurePersistentStorage();
        const proceed = () => {
            setActiveConnection(connection);
            setProfileQuery(connection.id);
        };
        // Linked Mudlet profile: try to (re)grant folder permission while we still
        // hold the click's user activation, so the mount uses the folder instead of
        // silently falling back to IDB. Best-effort — proceed regardless.
        if (connection.mudletLinked) {
            void ensureFolderPermission(connection.id).finally(proceed);
        } else {
            proceed();
        }
    };

    // Open (but don't dial) when the page is loaded with ?profile=<id>.
    // User can hit Connect from the toolbar to actually dial.
    useEffect(() => {
        const id = deepLinkProfileId.current;
        if (!id || activeConnection) return;
        const conn = connections.find(c => c.id === id);
        if (!conn) return;
        deepLinkProfileId.current = null;
        const forceConnect = deepLinkConnect.current;
        deepLinkConnect.current = false;
        openProfile(conn, forceConnect || (conn.autoReconnect ?? false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connections]);


    const handleCloseProfile = () => {
        setActiveConnection(null);
        setProfileQuery(null);
    };

    // Folder-gate decisions. Grant runs requestPermission directly off the click
    // (gesture preserved — the handle was loaded when the gate appeared), then
    // re-runs the mount. Unlink drops the folder link so the profile opens local.
    const handleGrantFolder = () => {
        const fh = folderGateHandle;
        setFolderGateHandle(null);
        const done = () => setFolderRetry(n => n + 1);
        if (fh) requestFolderPermission(fh).catch(() => {}).finally(done);
        else done();
    };
    const handleUnlinkFolder = () => {
        if (activeConnection) {
            void clearFolderHandle(activeConnection.id).catch(() => {});
            patchConnection(activeConnection.id, { mudletLinked: undefined });
        }
        setFolderGateHandle(null);
        setFolderRetry(n => n + 1);
    };

    // Hold the profile's cross-tab lock for as long as it's open here. The
    // session below is only rendered once we own it, so its VFS/SQLite/map are
    // never mounted concurrently with another tab's. Releasing on cleanup (and
    // the browser's auto-release on tab close) hands ownership to any tab queued
    // behind us.
    useEffect(() => {
        if (!activeConnection) { setLockPhase('none'); setProfileVfs(null); setFolderGateHandle(null); return; }
        const id = activeConnection.id;
        const linked = activeConnection.mudletLinked;
        const ctrl = new AbortController();
        let cancelled = false;
        let mountedVfs: ProfileVFS | null = null;
        setLockPhase('acquiring');
        setProfileVfs(null);
        setFolderGateHandle(null);
        // Pick the right initial message: if another tab already holds it, show
        // the "waiting" screen rather than a flash of "opening".
        void isProfileLockHeld(id).then(held => {
            if (!cancelled && held) setLockPhase(p => (p === 'held' ? p : 'waiting'));
        });
        const handle = acquireProfileLock(id, ctrl.signal);
        handle.acquired.then(async () => {
            if (cancelled) return;
            // Linked-folder permission gate: if this is a Mudlet-linked profile and
            // the folder isn't accessible, block on a decision screen (grant/unlink)
            // rather than silently mounting an empty local copy. We hold the lock
            // meanwhile; the user's choice bumps folderRetry to re-run this effect.
            if (linked) {
                const fh = await loadFolderHandle(id).catch(() => null);
                if (fh && (await checkFolderPermission(fh)) !== 'granted') {
                    if (cancelled) return;
                    setFolderGateHandle(fh);
                    return;
                }
            }
            if (cancelled) return;
            // Mount the profile's VFS up front, before the session renders, so
            // per-profile data is ready synchronously at first paint. The engine
            // consumes this instance; App owns register/flush/unmount.
            let vfs: ProfileVFS | null = null;
            try {
                vfs = await ProfileVFS.mount(id);
            } catch (e) {
                console.error('[App] profile VFS mount failed:', e);
            }
            if (cancelled) {
                // Acquired + mounted but we're already tearing down — clean up.
                if (vfs) { const v = vfs; void v.flush().finally(() => v.unmount()); }
                return;
            }
            if (vfs) {
                registerVfs(id, vfs);
                mountedVfs = vfs;
                // A linked Mudlet folder (current/*.xml present) is loaded from its
                // newest save on every open, so Mudlet-side edits show up; the
                // .mudix sidecar layers mudix-only state on top. Otherwise seed
                // from .mudix/profile.json (and run the one-time v21 migration)
                // before the session renders, so the profile's settings/layout/
                // protocols are present for the synchronous reads.
                if (isMudletProfileVfs(vfs)) {
                    loadMudletLinkedProfile(vfs, id, new Date().toISOString());
                } else {
                    loadProfileData(vfs, id);
                }
            }
            setProfileVfs(vfs);
            setLockPhase('held');
        }).catch(() => { /* aborted */ });
        return () => {
            cancelled = true;
            ctrl.abort();
            handle.release();
            if (mountedVfs) {
                const v = mountedVfs;
                unregisterVfs(id);
                void v.flush().finally(() => v.unmount());
            }
        };
        // folderRetry re-runs the mount after the user resolves the folder gate.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeConnection, folderRetry]);

    const handleToggleSettings = () => setSettingsOpen(v => !v);

    if (activeConnection) {
        // A linked profile whose folder access isn't granted blocks here until the
        // user grants or unlinks — rather than silently opening an empty copy.
        if (folderGateHandle) {
            return (
                <FolderPermissionScreen
                    name={activeConnection.name}
                    onGrant={handleGrantFolder}
                    onUnlink={handleUnlinkFolder}
                    onBack={handleCloseProfile}
                />
            );
        }
        // Never mount the session until we own the lock — that's what keeps the
        // profile's on-disk state single-writer across tabs.
        if (lockPhase !== 'held') {
            return (
                <ProfileBusyScreen
                    name={activeConnection.name}
                    waiting={lockPhase === 'waiting'}
                    onBack={handleCloseProfile}
                />
            );
        }
        return (
            <ProfileSession
                key={activeConnection.id}
                connection={activeConnection}
                autoConnect={autoConnect}
                vfs={profileVfs}
                settingsOpen={settingsOpen}
                onToggleSettings={handleToggleSettings}
                onCloseProfile={handleCloseProfile}
            />
        );
    }

    // Landing contract for a brand-supplied screen: open a profile by id, and
    // find-or-create the brand's managed profile (patching e.g. login creds
    // first). Reads fresh store state so an ensure → open sequence works
    // within one event handler.
    const openProfileById = (id: string, connect: boolean) => {
        const conn = useAppStore.getState().connections.find(c => c.id === id);
        if (conn) openProfile(conn, connect);
    };
    const ensureBrandProfile = (account?: string): string => {
        const seed = brandConnectionData(brand, brand.profileMode === 'perLogin' ? account : undefined);
        if (!seed) throw new Error('ensureBrandProfile: the brand does not configure a MUD target');
        const existing = matchBrandProfile(useAppStore.getState().connections, brand, account);
        if (existing) {
            // The brand config is the source of truth for its managed profile(s) —
            // re-sync the connection target on every login instead of freezing it
            // at whatever it was when the profile was first created, so editing
            // brand.mud takes effect without the user clearing storage.
            patchConnection(existing.id, seed);
            return existing.id;
        }
        return addConnection(seed);
    };
    // Branded mode never shows profile creation/selection: the landing is a
    // login form — the brand's own Landing when provided, else the built-in
    // one. Stock builds keep the connection picker.
    const Landing = brand.Landing ?? (brand.mud ? BrandLoginScreen : undefined);

    return (
        <div className="app">
            {Landing ? (
                <Landing
                    connections={connections}
                    openProfile={openProfileById}
                    ensureBrandProfile={ensureBrandProfile}
                    openSettings={handleToggleSettings}
                />
            ) : (
            <ConnectionScreen
                connections={connections}
                connecting={false}
                connectingId={null}
                onConnect={(conn) => openProfile(conn, true)}
                onOpen={(conn) => openProfile(conn, conn.autoReconnect ?? false)}
                onAdd={addConnection}
                onUpdate={updateConnection}
                onDelete={removeConnection}
                onOpenSettings={handleToggleSettings}
                linkedGame={linkedGame}
                onLinkedGameHandled={clearGameLink}
            />
            )}
            {settingsOpen && (
                <SettingsModal
                    onClose={handleToggleSettings}
                    connectionId={null}
                    vfs={null}
                />
            )}
        </div>
    );
}
