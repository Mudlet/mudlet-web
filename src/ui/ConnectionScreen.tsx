import { useEffect, useRef, useState } from 'react';
import { CircleHelp, Info } from 'lucide-react';
import { Button, useConfirm } from './components';
import { ConnectionFormModal } from './ConnectionFormModal';
import { ConnectionGrid } from './ConnectionGrid';
import { BundledGameGrid, connectionFromGame } from './BundledGameGrid';
import { GameLinkPrompt } from './GameLinkPrompt';
import { profilesForGame } from '../mud/games/gameLinks';
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
    const reorderConnections = useAppStore(s => s.reorderConnections);
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
    } | null>(null);
    // The game a `?play=` link named, waiting on the "existing or new?" choice.
    const [gamePrompt, setGamePrompt] = useState<BundledGame | null>(null);
    const vaultSaver = useVaultSaver();
    const [aboutOpen, setAboutOpen] = useState(false);
    // Opened either from the tools row (default topic) or from the import row's
    // "how do I do this?" link, which jumps straight to the migration guide.
    const [helpTopic, setHelpTopic] = useState<string | null>(null);
    const [exportOpen, setExportOpen] = useState(false);
    const [importing, setImporting] = useState(false);
    const [importError, setImportError] = useState<string | null>(null);
    // Profiles whose modules couldn't be resolved from the imported tree — the
    // modal asks the user to upload or drop each file before that profile is
    // provisioned. A queue, not a single slot: one multi-profile zip can hold
    // several profiles that each need modules, and a slot would drop all but the last.
    const [pendingImports, setPendingImports] = useState<{ bundle: MudletProfileBundle; unresolved: MudletModuleRef[] }[]>([]);
    const zipInputRef = useRef<HTMLInputElement>(null);
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

    // Auto-resolve modules found in the imported tree; defer to the modal for the
    // rest, otherwise provision the profile immediately.
    const beginImport = async (bundle: MudletProfileBundle) => {
        const { resolved, unresolved } = resolveModulesFromTree(bundle);
        for (const r of resolved) addModuleToBundle(bundle, r.ref.key, r.xmlBytes);
        if (unresolved.length) { setPendingImports(q => [...q, { bundle, unresolved }]); return; }
        await importMudletProfile(bundle);
    };

    const handleImportFolder = () => {
        if (!dirPicker) return;
        void runImport(async () => beginImport(await bundleFromDirectory(await dirPicker.call(window))));
    };

    // Link (not copy): the folder stays the source of truth; current/*.xml is
    // re-read on every open.
    const handleLinkFolder = () => {
        if (!dirPicker) return;
        void runImport(async () => { await linkMudletFolder(await dirPicker.call(window)); });
    };

    const handleZipChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        void runImport(async () => {
            const bytes = new Uint8Array(await file.arrayBuffer());
            // A mudix export holds every selected profile in one archive, so a
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
            for (const u of uploads) addModuleToBundle(p.bundle, u.key, u.bytes);
            await importMudletProfile(p.bundle);
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
                    Permanently delete <strong>{c.name}</strong>? Its scripts, aliases, triggers and saved layout
                    will be removed. This cannot be undone.
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

    return (
        <>
        <div className="connection-screen">
            <div className="connection-panel">
                <div className="connection-panel-tools">
                    <button className="connection-settings-btn" onClick={onOpenSettings} type="button" aria-label="Settings">
                        ⚙
                    </button>
                    <button className="connection-help-btn" onClick={() => setHelpTopic('migrating')} type="button" aria-label="Help">
                        <CircleHelp size={16} />
                    </button>
                    <button className="connection-about-btn" onClick={() => setAboutOpen(true)} type="button" aria-label={`About ${brand.appName}`}>
                        <Info size={16} />
                    </button>
                </div>
                <div className="connection-brand">
                    {brand.logoUrl && (
                        <img className="connection-brand-logo" src={brand.logoUrl} alt="" aria-hidden="true" />
                    )}
                    {brand.appName}
                </div>

                <ConnectionGrid
                    connections={connections}
                    connecting={connecting}
                    connectingId={connectingId}
                    editingId={editor?.connection?.id ?? null}
                    openIds={openIds}
                    onConnect={onConnect}
                    onOpen={onOpen}
                    onEdit={(c) => setEditor({ connection: c })}
                    onDelete={(c) => { void handleDelete(c); }}
                    onReorder={reorderConnections}
                    onAddClick={() => setEditor({ connection: null })}
                />

                {/* Profile-level actions belong with the profiles, above the
                    game catalogue rather than below the length of it. A bare row
                    of buttons doesn't say what a "Mudlet folder" is or where to
                    find one, so it's captioned and linked to the guide. */}
                <div className="connection-import-caption">
                    Already play in Mudlet? Bring your profile — triggers, scripts, packages
                    and map — across.{' '}
                    <button type="button" className="connection-import-help" onClick={() => setHelpTopic('migrating')}>
                        How?
                    </button>
                </div>
                <div className="connection-import-row" style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                    {dirPicker && (
                        <Button variant="secondary" size="sm" onClick={handleImportFolder} disabled={connecting || importing}
                            title="Copy a desktop Mudlet profile folder in — usually ~/.config/mudlet/profiles/<name>. Your folder on disk is left untouched">
                            {importing ? 'Importing…' : 'Import Mudlet folder…'}
                        </Button>
                    )}
                    <Button variant="secondary" size="sm" onClick={() => zipInputRef.current?.click()} disabled={connecting || importing}
                        title="Import a zipped Mudlet profile folder, or a .zip exported from Mudlet Web">
                        {importing && !dirPicker ? 'Importing…' : 'Import .zip…'}
                    </Button>
                    {dirPicker && (
                        <Button variant="secondary" size="sm" onClick={handleLinkFolder} disabled={connecting || importing}
                            title="Link a Mudlet profile folder — it stays the source of truth and is re-read from its newest save on every open">
                            Link Mudlet folder…
                        </Button>
                    )}
                    {connections.length > 0 && (
                        <Button variant="secondary" size="sm" onClick={() => setExportOpen(true)} disabled={connecting || importing}
                            title="Download profiles as a Mudlet-format .zip — importable here, on another Mudlet Web address, or in desktop Mudlet">
                            Export profiles…
                        </Button>
                    )}
                    {/* Renders nothing in a build with no credential vault. */}
                    <VaultManageButton connections={connections} disabled={connecting || importing} />
                </div>
                {importError && (
                    <div className="connection-import-error" style={{ color: 'var(--danger, #e06c75)', fontSize: 12, textAlign: 'center' }}>
                        Import failed: {importError}
                    </div>
                )}

                {/* Only the stock client offers them: a branded build targets
                    one MUD and has no use for a directory of others. */}
                {!brand.mud && (
                    <BundledGameGrid
                        connections={connections}
                        busy={connecting || importing}
                        onPlay={openGameForm}
                    />
                )}

                <input ref={zipInputRef} type="file" accept=".zip" style={{ display: 'none' }} onChange={handleZipChange} />
            </div>
        </div>
        {editor && (
            <ConnectionFormModal
                connection={editor.connection}
                preset={editor.preset}
                // "Add", not "Connect": submitting creates the profile and hands
                // it back to the launcher. Someone setting up a game may want to
                // install packages or open it offline before ever dialing.
                title={editor.game ? `Add ${editor.game.name}` : undefined}
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
