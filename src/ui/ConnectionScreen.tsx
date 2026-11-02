import { useEffect, useRef, useState } from 'react';
import { ChevronDown, CircleHelp, Info, Settings } from 'lucide-react';
import { useConfirm } from './components';
import { ConnectionFormModal } from './ConnectionFormModal';
import { LauncherHero, ProfileShelf, type ProfileHandlers } from './launcher/ProfileSection';
import { GameSection } from './launcher/GameSection';
import { GameDetails } from './launcher/GameDetails';
import { LauncherSearch } from './launcher/LauncherSearch';
import { ActionMenu, type MenuAction } from './launcher/ActionMenu';
import { ProfileArt } from './launcher/ProfileArt';
import { mergeGridOrder, pickHero, type TypedAddress } from './launcher/launcherModel';
import './launcher/launcher.css';
import { GameLinkPrompt } from './GameLinkPrompt';
import { PLAYABLE_GAMES, connectionFromGame, profilesForGame } from '../mud/games/gameLinks';
import type { BundledGame } from '../mud/games/bundledGames';
import { useOpenProfiles } from './useOpenProfiles';
import { AboutModal } from './AboutModal';
import { HelpModal } from './HelpModal';
import { ProfileExportModal } from './ProfileExportModal';
import { ensurePersistentStorage } from '../storage/persistentStorage';
import { uniqueConnectionName, useAppStore, type MudConnection } from '../storage';
import { getBrand } from '../branding';
import { extractMudletProfileZipAll, resolveModulesFromTree, addModuleToBundle, type MudletProfileBundle } from '../import/mudletProfileImport';
import { importMudletProfile, bundleFromDirectory, linkMudletFolder } from '../import/applyMudletProfile';
import { ModuleResolveModal, type ModuleUpload } from './ModuleResolveModal';
import { useVaultSaver } from './useVaultSaver';
import { VaultManageButton } from './VaultManageButton';
import type { MudletModuleRef } from '../import/mudletHost';

interface Props {
    connections: MudConnection[];
    connecting: boolean;
    connectingId: string | null;
    onConnect: (connection: MudConnection) => void;
    onOpen: (connection: MudConnection) => void;
    onAdd: (data: Omit<MudConnection, 'id'>) => string;
    onUpdate: (id: string, data: Omit<MudConnection, 'id'>) => void;
    onDelete: (id: string) => void;
    onOpenSettings: () => void;
    /** A bundled game named by a `?play=<game>` deep link, offered once on
     *  mount. Null when the page wasn't opened from such a link. */
    linkedGame?: BundledGame | null;
    /** Called once `linkedGame` has been offered, so the caller can drop it
     *  from its state and clean the parameter out of the URL. */
    onLinkedGameHandled?: () => void;
}

export function ConnectionScreen({ connections, connecting, connectingId, onConnect, onOpen, onAdd, onUpdate, onDelete, onOpenSettings, linkedGame, onLinkedGameHandled }: Props) {
    const confirm = useConfirm();
    const brand = getBrand();
    // Which profiles other tabs currently hold open, so the grid can mark them
    // instead of letting a click land on the "waiting for the other tab" screen.
    // Paused mid-connect: the grid is about to be replaced by the session.
    const openIds = useOpenProfiles(!connecting);
    // null = editor closed; { connection: null } = add a new one; { connection: c } = edit c.
    // `game` marks the add-a-bundled-game flow: the form starts from `preset`
    // and dials the profile it creates, instead of just adding it to the list.
    const [editor, setEditor] = useState<{
        connection: MudConnection | null;
        preset?: Omit<MudConnection, 'id'>;
        game?: BundledGame;
        /** Overrides the dialog's own title — "Duplicate Achaea". */
        title?: string;
    } | null>(null);
    // The game a `?play=` link named, waiting on the "existing or new?" choice.
    const [gamePrompt, setGamePrompt] = useState<BundledGame | null>(null);
    // The game whose details card is open, from a tile or a search result.
    const [detailsGame, setDetailsGame] = useState<BundledGame | null>(null);
    const vaultSaver = useVaultSaver();
    const [aboutOpen, setAboutOpen] = useState(false);
    // Opened either from the tools row (default topic) or from the import row's
    // "how do I do this?" link, which jumps straight to the migration guide.
    const [helpTopic, setHelpTopic] = useState<string | null>(null);
    const [exportOpen, setExportOpen] = useState(false);
    const [importing, setImporting] = useState(false);
    const [importError, setImportError] = useState<string | null>(null);
    // What each imported profile could not carry over. A profile import used to
    // report success in total silence even when it dropped nodes and fields, so
    // every fidelity gap surfaced weeks later as a mystery (issue #45). Kept per
    // profile because one zip can hold several, and each has its own list.
    const [importWarnings, setImportWarnings] = useState<{ profile: string; warnings: string[] }[]>([]);
    const importWarningCount = importWarnings.reduce((n, e) => n + e.warnings.length, 0);
    // Profiles whose modules couldn't be resolved from the imported tree — the
    // modal asks the user to upload or drop each file before that profile is
    // provisioned. A queue, not a single slot: one multi-profile zip can hold
    // several profiles that each need modules, and a slot would drop all but the last.
    const [pendingImports, setPendingImports] = useState<{ bundle: MudletProfileBundle; unresolved: MudletModuleRef[] }[]>([]);
    const zipInputRef = useRef<HTMLInputElement>(null);
    const backupInputRef = useRef<HTMLInputElement>(null);
    // Directory import needs the File System Access API; fall back to .zip elsewhere.
    const dirPicker = (window as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;

    // The new connection lands in the store, so the list re-renders on its own.
    const runImport = async (fn: () => Promise<void>) => {
        setImporting(true);
        setImportError(null);
        // Someone importing a years-old Mudlet profile has just handed the browser
        // the data they'd most hate to lose — the best moment to ask for storage
        // that survives eviction. Best-effort and never blocks the import.
        void ensurePersistentStorage();
        try {
            await fn();
        } catch (err) {
            if ((err as { name?: string })?.name === 'AbortError') return; // user cancelled the picker
            setImportError(err instanceof Error ? err.message : String(err));
        } finally {
            setImporting(false);
        }
    };

    /** Provision one bundle and keep whatever it could not represent. The
     *  bundle collects warnings right through the import — the XML parse, each
     *  folded-in module, and the file/map copy — so this is the one place that
     *  has to read them. */
    const provision = async (bundle: MudletProfileBundle) => {
        const connectionId = await importMudletProfile(bundle);
        // A password desktop kept in the profile folder goes where Mudlet Web
        // keeps saved logins — the encrypted vault, setting it up or unlocking
        // it first if need be — and never into the profile's files.
        if (bundle.password) {
            if (vaultSaver.canSave) vaultSaver.save(connectionId, bundle.password);
            else bundle.warnings.push('The saved password was not imported: this browser has nowhere secure to keep it. Enter it again when you connect.');
        }
        if (bundle.warnings.length > 0) {
            setImportWarnings(w => [...w, { profile: bundle.name, warnings: [...bundle.warnings] }]);
        }
    };

    // Auto-resolve modules found in the imported tree; defer to the modal for the
    // rest, otherwise provision the profile immediately.
    const beginImport = async (bundle: MudletProfileBundle) => {
        const { resolved, unresolved } = resolveModulesFromTree(bundle);
        for (const r of resolved) addModuleToBundle(bundle, r.ref, r.xmlBytes, r.path);
        if (unresolved.length) { setPendingImports(q => [...q, { bundle, unresolved }]); return; }
        await provision(bundle);
    };

    const handleImportFolder = () => {
        if (!dirPicker) return;
        setImportWarnings([]);
        void runImport(async () => beginImport(await bundleFromDirectory(await dirPicker.call(window))));
    };

    // Link (not copy): the folder stays the source of truth; current/*.xml is
    // re-read on every open.
    const handleLinkFolder = () => {
        if (!dirPicker) return;
        setImportWarnings([]);
        void runImport(async () => {
            const dir = await dirPicker.call(window);
            const { connectionId, password, warnings } = await linkMudletFolder(dir);
            // As an import does with it (see provision) — the folder's own copy
            // stays put, since desktop still reads it.
            if (password) {
                if (vaultSaver.canSave) vaultSaver.save(connectionId, password);
                else warnings.push('The saved password was not imported: this browser has nowhere secure to keep it. Enter it again when you connect.');
            }
            if (warnings.length > 0) setImportWarnings(w => [...w, { profile: dir.name, warnings: [...warnings] }]);
        });
    };

    // A whole-origin backup taken from a previous Mudlet Web address, written by
    // the notice page left at the old one. Not a Mudlet artefact — it holds the
    // browser's own storage rather than a profile folder — so it gets its own
    // input and does not go through the bundle path above.
    const handleBackupChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        setImportWarnings([]);
        void runImport(async () => {
            const { parseBackup, importBackup } = await import('../import/backupImport');
            const result = await importBackup(parseBackup(await file.text()));
            if (result.warnings.length > 0) {
                setImportWarnings(w => [...w, { profile: 'Backup', warnings: result.warnings }]);
            }
        });
    };

    const handleZipChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        setImportWarnings([]);
        void runImport(async () => {
            const bytes = new Uint8Array(await file.arrayBuffer());
            // A Mudlet Web export holds every selected profile in one archive, so a
            // zip can yield several bundles; a plain Mudlet profile yields one.
            const bundles = extractMudletProfileZipAll(bytes, file.name.replace(/\.zip$/i, ''));
            for (const bundle of bundles) await beginImport(bundle);
        });
    };

    const finishPendingImport = (uploads: ModuleUpload[]) => {
        const p = pendingImports[0];
        if (!p) return;
        setPendingImports(q => q.slice(1));
        void runImport(async () => {
            for (const u of uploads) {
                addModuleToBundle(p.bundle, p.unresolved.find(m => m.key === u.key) ?? u.key, u.bytes);
            }
            await provision(p.bundle);
        });
    };

    // Picking a game opens the Add form with its host, port, TLS flag and blurb
    // already filled in — Mudlet's connection dialog does the same, and it
    // leaves room to rename the profile or set a login before dialing. The name
    // is pre-uniqued so a second Achaea profile arrives as "Achaea (2)" rather
    // than tripping the form's "already called that" error.
    const openGameForm = (game: BundledGame) => {
        setGamePrompt(null);
        setEditor({
            connection: null,
            game,
            preset: { ...connectionFromGame(game), name: uniqueConnectionName(game.name, connections) },
        });
    };

    // A ?play=<game> link, offered once. Someone arriving from a "Play Astaria"
    // button on a website may well already have an Astaria profile, and the link
    // can't know — so with any match we ask which they meant, and only go
    // straight to the form when there's nothing to choose between. Clicking a
    // tile skips this: the matching profiles are on screen right above it.
    const linkOffered = useRef(false);
    useEffect(() => {
        if (!linkedGame || linkOffered.current) return;
        linkOffered.current = true;
        onLinkedGameHandled?.();
        if (profilesForGame(linkedGame, connections).length > 0) setGamePrompt(linkedGame);
        else openGameForm(linkedGame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [linkedGame]);

    const handleDelete = async (c: MudConnection) => {
        const ok = await confirm<boolean>({
            title: 'Delete profile?',
            tone: 'danger',
            message: (
                <>
                    Permanently delete <strong>{c.name}</strong>? Its scripts, aliases, triggers, saved layout,
                    files, map and logs will be removed. This cannot be undone.
                </>
            ),
            buttons: [
                { label: 'Cancel', value: false, variant: 'secondary' },
                { label: 'Delete', value: true, variant: 'danger', autoFocus: true },
            ],
            dismissValue: false,
        });
        if (!ok) return;
        if (editor?.connection?.id === c.id) setEditor(null);
        onDelete(c.id);
    };

    /**
     * Mudlet's "Copy settings only" (`slot_copyOnlySettingsOfProfile`): a second
     * profile for the same game without retyping every field, which was the only
     * way to set up an alt (issue #56).
     *
     * Deliberately not Mudlet's full "Copy profile": scripts, packages and the
     * map live in this profile's own filesystem and IndexedDB, and duplicating
     * those is a different, much larger operation. The login is dropped too —
     * the point of a second profile is usually a second character, and a saved
     * password belongs to the profile id that owns it, not to a copy of it.
     *
     * The copy opens in the editor rather than being saved outright, so the name
     * and character can be set before it joins the list.
     */
    const handleDuplicate = (c: MudConnection) => {
        const { id: _id, charLoginAccount: _account, charLoginPassword: _password, ...settings } = c;
        setEditor({
            connection: null,
            preset: { ...settings, name: uniqueConnectionName(c.name, connections) },
            title: `Duplicate ${c.name}`,
        });
    };

    const busy = connecting || importing;
    const reorderConnections = useAppStore(s => s.reorderConnections);
    // The banner leads with the profile played last; the grid keeps the
    // player's own arrangement, which they set by dragging.
    const hero = pickHero(connections);
    const gridConnections = connections.filter(c => c.id !== hero?.id);
    const handlers: ProfileHandlers = {
        connecting, connectingId, openIds, onConnect, onOpen,
        onEdit: (c) => setEditor({ connection: c }),
        onDuplicate: handleDuplicate,
        onDelete: (c) => { void handleDelete(c); },
    };

    // A server typed into the search box becomes a new profile, filled in but
    // not dialled — the same "Add, not Connect" the catalogue follows.
    const handleTypedAddress = (a: TypedAddress) => {
        const preset: Omit<MudConnection, 'id'> = a.mode === 'mud'
            ? { name: uniqueConnectionName(a.host, connections), mode: 'mud', host: a.host, port: a.port }
            : { name: uniqueConnectionName(new URL(a.url).hostname || 'New profile', connections), mode: 'websocket', url: a.url };
        setEditor({ connection: null, preset });
    };

    const importActions: MenuAction[] = [
        ...(dirPicker ? [{ label: 'Import Mudlet folder…', onSelect: handleImportFolder, disabled: busy }] : []),
        { label: 'Import .zip…', onSelect: () => zipInputRef.current?.click(), disabled: busy },
        ...(dirPicker ? [{ label: 'Link Mudlet folder…', onSelect: handleLinkFolder, disabled: busy }] : []),
        { label: 'Import backup…', onSelect: () => backupInputRef.current?.click(), disabled: busy },
        ...(connections.length > 0 ? [{ label: 'Export profiles…', onSelect: () => setExportOpen(true), disabled: busy }] : []),
        { label: 'How do I bring a Mudlet profile?', onSelect: () => setHelpTopic('migrating') },
    ];
    const importMenu = (
        <ActionMenu label="Import or export profiles" actions={importActions} disabled={connecting}>
            {importing ? 'Importing…' : 'Import'}
            <ChevronDown size={14} aria-hidden="true" />
        </ActionMenu>
    );

    return (
        <>
        <div className="launcher">
            <div className="launcher__inner">
                <header className="launcher-top">
                    <div className="launcher-brand">
                        {brand.logoUrl && <img className="launcher-brand__logo" src={brand.logoUrl} alt="" aria-hidden="true" />}
                        <span className="launcher-brand__name">{brand.appName}</span>
                    </div>
                    <LauncherSearch
                        connections={connections}
                        games={brand.mud ? [] : PLAYABLE_GAMES}
                        disabled={connecting}
                        onConnect={onConnect}
                        onSelectGame={setDetailsGame}
                        onAddress={handleTypedAddress}
                    />
                    <div className="launcher-tools">
                        {/* Renders nothing in a build with no credential vault. */}
                        <VaultManageButton connections={connections} />
                        <button className="launcher-tool" onClick={onOpenSettings} type="button" aria-label="Settings" title="Settings">
                            <Settings size={18} aria-hidden="true" />
                        </button>
                        <button className="launcher-tool" onClick={() => setHelpTopic('migrating')} type="button" aria-label="Help" title="Help">
                            <CircleHelp size={18} aria-hidden="true" />
                        </button>
                        <button className="launcher-tool" onClick={() => setAboutOpen(true)} type="button" aria-label={`About ${brand.appName}`} title={`About ${brand.appName}`}>
                            <Info size={18} aria-hidden="true" />
                        </button>
                    </div>
                </header>

                {hero
                    ? <LauncherHero connection={hero} handlers={handlers} />
                    : (
                        <section className="launcher-welcome">
                            <ProfileArt icon={null} name={brand.appName} />
                            <div className="launcher-hero__scrim" />
                            <div className="launcher-welcome__inner">
                                <h1 className="launcher-welcome__title">Welcome to {brand.appName}</h1>
                                <p className="launcher-welcome__text">
                                    {brand.mud
                                        ? 'Set up a profile to start playing.'
                                        : 'Pick a game below, or type any server’s address into the search box above.'}
                                    {' '}Already play in Mudlet? Bring your profile — triggers, scripts, packages and map — across with{' '}
                                    <strong>Import</strong>.{' '}
                                    <button type="button" className="launcher-link" onClick={() => setHelpTopic('migrating')}>How?</button>
                                </p>
                            </div>
                        </section>
                    )}

                {importError && (
                    <div className="launcher-notice launcher-notice--error" role="alert">
                        Import failed: {importError}
                    </div>
                )}
                {/* An import that dropped something still succeeded, so this is a
                    notice and not an error: the profile is there, and this says
                    what it is missing. Dismissible, and replaced wholesale by the
                    next import. */}
                {importWarnings.length > 0 && (
                    <div className="launcher-notice" role="status">
                        <div className="launcher-notice__head">
                            <strong>
                                Imported, but {importWarningCount} thing{importWarningCount === 1 ? '' : 's'} could not be carried over
                            </strong>
                            <button type="button" className="launcher-link" onClick={() => setImportWarnings([])}>Dismiss</button>
                        </div>
                        {importWarnings.map(entry => (
                            <div key={entry.profile} className="launcher-notice__entry">
                                <div className="launcher-notice__profile">{entry.profile}</div>
                                <ul>
                                    {entry.warnings.map((w, i) => <li key={i}>{w}</li>)}
                                </ul>
                            </div>
                        ))}
                    </div>
                )}

                <ProfileShelf
                    connections={gridConnections}
                    handlers={handlers}
                    editingId={editor?.connection?.id ?? null}
                    onAddClick={() => setEditor({ connection: null })}
                    onReorder={(ids) => reorderConnections(mergeGridOrder(connections.map(c => c.id), ids))}
                    importMenu={importMenu}
                />

                {/* Only the stock client offers them: a branded build targets
                    one MUD and has no use for a directory of others. */}
                {!brand.mud && <GameSection connections={connections} onSelect={setDetailsGame} />}

                <input ref={zipInputRef} type="file" accept=".zip" style={{ display: 'none' }} onChange={handleZipChange} />
                <input ref={backupInputRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={handleBackupChange} />
            </div>
        </div>
        {detailsGame && (
            <GameDetails
                game={detailsGame}
                connections={connections}
                busy={busy}
                onPlay={(g) => { setDetailsGame(null); openGameForm(g); }}
                onConnect={(c) => { setDetailsGame(null); onConnect(c); }}
                onClose={() => setDetailsGame(null)}
            />
        )}
        {editor && (
            <ConnectionFormModal
                connection={editor.connection}
                preset={editor.preset}
                // "Add", not "Connect": submitting creates the profile and hands
                // it back to the launcher. Someone setting up a game may want to
                // install packages or open it offline before ever dialing.
                title={editor.title ?? (editor.game ? `Add ${editor.game.name}` : undefined)}
                firstConnection={connections.length === 0}
                busy={connecting}
                onAdd={onAdd}
                onUpdate={onUpdate}
                onClose={() => setEditor(null)}
                vaultSaver={vaultSaver}
            />
        )}
        {gamePrompt && (
            <GameLinkPrompt
                game={gamePrompt}
                profiles={profilesForGame(gamePrompt, connections)}
                busy={connecting || importing}
                onPlay={(c) => { setGamePrompt(null); onConnect(c); }}
                onOpen={(c) => { setGamePrompt(null); onOpen(c); }}
                onCreate={() => openGameForm(gamePrompt)}
                onClose={() => setGamePrompt(null)}
            />
        )}
        {/* Outside the editor on purpose: a vault setup/unlock step raised by
            saving a password has to outlive the form that asked for it. */}
        {vaultSaver.element}
        {pendingImports.length > 0 && (
            <ModuleResolveModal
                key={pendingImports[0].bundle.name}
                modules={pendingImports[0].unresolved}
                onComplete={finishPendingImport}
                onCancel={() => setPendingImports(q => q.slice(1))}
            />
        )}
        {exportOpen && (
            <ProfileExportModal connections={connections} onClose={() => setExportOpen(false)} />
        )}
        {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
        {helpTopic && <HelpModal initialTopic={helpTopic} onClose={() => setHelpTopic(null)} />}
        </>
    );
}
