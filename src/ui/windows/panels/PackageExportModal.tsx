import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Braces, Shuffle, Zap, Clock, Keyboard, MousePointerClick, Folder, FileCode2 } from 'lucide-react';
import { ResizableModal } from '../../ResizableModal';
import { Button, FileSourceButton, FormField, type PickedFile } from '../../components';
import { useAppStore } from '../../../storage';
import { downloadBlob } from '../../../storage/logExport';
import type { ProfileVFS } from '../../../scripting/vfs/ProfileVFS';
import type {
    AliasNode, ButtonNode, KeyNode, PackageManifest, ScriptNode, TimerNode, TriggerNode,
} from '../../../storage/schema';
import type { SerializeInput } from '../../../import/mudletXmlExport';
import {
    buildPackageZip,
    countSelected,
    descendantIds,
    sanitizePackageName,
    selectExportInput,
} from '../../../import/packageExport';
import './PackageExportModal.css';

// Mudlet's package exporter (dlgPackageExporter), for the web client: pick items
// out of the profile's six automation trees, fill in the package metadata, and
// download a .mpackage that installs here and in desktop Mudlet.

export type ExportCategory = 'triggers' | 'aliases' | 'scripts' | 'timers' | 'keys' | 'buttons';

interface TreeItem {
    id: string;
    parentId: string | null;
    isGroup: boolean;
    name: string;
    packageName?: string;
}

const CATEGORY_LABEL: Record<ExportCategory, string> = {
    triggers: 'Triggers',
    aliases:  'Aliases',
    scripts:  'Scripts',
    timers:   'Timers',
    keys:     'Keys',
    buttons:  'Buttons',
};

const CATEGORY_ICON = {
    triggers: Zap,
    aliases:  Shuffle,
    scripts:  Braces,
    timers:   Clock,
    keys:     Keyboard,
    buttons:  MousePointerClick,
} as const;

// Mudlet's dialog lists Triggers first; keep the same reading order.
const CATEGORY_ORDER: ExportCategory[] = ['triggers', 'aliases', 'scripts', 'timers', 'keys', 'buttons'];

const EMPTY: never[] = [];

type SelectionState = Record<ExportCategory, Set<string>>;

function emptySelection(): SelectionState {
    return { triggers: new Set(), aliases: new Set(), scripts: new Set(), timers: new Set(), keys: new Set(), buttons: new Set() };
}

/** Flat, ordered render list with depth — the whole tree, always expanded:
 *  a selection UI that hides items behind collapsed folders invites shipping a
 *  package missing something the user believed was in it. */
function flatten<T extends TreeItem>(items: T[], parentId: string | null, depth = 0): Array<{ item: T; depth: number }> {
    const out: Array<{ item: T; depth: number }> = [];
    for (const item of items.filter(i => i.parentId === parentId)) {
        out.push({ item, depth });
        out.push(...flatten(items, item.id, depth + 1));
    }
    return out;
}

/** Every file under `dir`, keyed relative to it. */
function listFiles(vfs: ProfileVFS, dir: string): string[] {
    const out: string[] = [];
    const walk = (path: string, rel: string, depth: number) => {
        if (depth > 12) return;
        let names: string[];
        try { names = vfs.readdir(path); } catch { return; }
        for (const name of names) {
            const child = `${path}/${name}`;
            const childRel = rel ? `${rel}/${name}` : name;
            const info = vfs.stat(child);
            if (!info) continue;
            if (info.type === 'dir') walk(child, childRel, depth + 1);
            else out.push(childRel);
        }
    };
    walk(dir, '', 0);
    return out.sort();
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
    connectionId: string;
    vfs: ProfileVFS | null;
    /** Pre-check this item (and its subtree), as Mudlet does when the exporter is
     *  opened from a right-click in the editor tree. */
    preselect?: { category: ExportCategory; id: string } | null;
    onClose: () => void;
    /** Reported back for the editor's log pane. */
    onExported?: (message: string) => void;
}

export function PackageExportModal({ connectionId, vfs, preselect, onClose, onExported }: Props) {
    const triggers: TriggerNode[] = useAppStore(s => s.connectionTriggers[connectionId] ?? EMPTY);
    const aliases:  AliasNode[]   = useAppStore(s => s.connectionAliases[connectionId] ?? EMPTY);
    const scripts:  ScriptNode[]  = useAppStore(s => s.connectionScripts[connectionId] ?? EMPTY);
    const timers:   TimerNode[]   = useAppStore(s => s.connectionTimers[connectionId] ?? EMPTY);
    const keys:     KeyNode[]     = useAppStore(s => s.connectionKeybindings[connectionId] ?? EMPTY);
    const buttons:  ButtonNode[]  = useAppStore(s => s.connectionButtons[connectionId] ?? EMPTY);
    const packages: PackageManifest[] = useAppStore(s => s.connectionPackages[connectionId] ?? EMPTY);

    const nodesFor = useMemo<Record<ExportCategory, TreeItem[]>>(
        () => ({ triggers, aliases, scripts, timers, keys, buttons }),
        [triggers, aliases, scripts, timers, keys, buttons],
    );

    const preselectedNode = preselect ? nodesFor[preselect.category].find(n => n.id === preselect.id) ?? null : null;

    const [name, setName] = useState(() => preselectedNode?.name ?? '');
    const [title, setTitle] = useState('');
    const [author, setAuthor] = useState('');
    const [version, setVersion] = useState('');
    const [description, setDescription] = useState('');
    const [helpUrl, setHelpUrl] = useState('');
    const [dependencies, setDependencies] = useState('');
    const [iconName, setIconName] = useState('');
    const [iconBytes, setIconBytes] = useState<Uint8Array | null>(null);
    const [extraFiles, setExtraFiles] = useState<Array<{ name: string; bytes: Uint8Array }>>([]);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<{ filename: string; size: number; items: number } | null>(null);
    const [busy, setBusy] = useState(false);

    const [selection, setSelection] = useState<SelectionState>(() => {
        const sel = emptySelection();
        if (preselect && preselectedNode) {
            sel[preselect.category] = new Set([preselect.id, ...descendantIds(nodesFor[preselect.category], preselect.id)]);
        }
        return sel;
    });

    const cleanName = sanitizePackageName(name.trim(), '');

    // Re-exporting an installed package: adopt its metadata, so a version bump
    // doesn't mean retyping the author, title and description from memory.
    const matchedPackage = useMemo(
        () => packages.find(p => p.name.toLowerCase() === cleanName.toLowerCase()) ?? null,
        [packages, cleanName],
    );
    const adoptedRef = useRef<string | null>(null);
    useEffect(() => {
        if (!matchedPackage || adoptedRef.current === matchedPackage.name) return;
        adoptedRef.current = matchedPackage.name;
        setTitle(prev => prev || matchedPackage.title || '');
        setAuthor(prev => prev || matchedPackage.author || '');
        setVersion(prev => prev || matchedPackage.version || '');
        setDescription(prev => prev || matchedPackage.description || '');
        setIconName(prev => prev || matchedPackage.icon || '');
    }, [matchedPackage]);

    // Files already sitting in <profile>/<name>/ — the resources of a package
    // being re-exported. Mudlet pre-fills the same list when you pick an
    // installed package to update.
    const packageDir = vfs && cleanName ? `${vfs.profilePath}/${cleanName}` : null;
    const vfsFiles = useMemo(() => {
        if (!vfs || !packageDir || !vfs.exists(packageDir)) return EMPTY as string[];
        return listFiles(vfs, packageDir).filter(p => p !== 'config.lua' && p !== `${cleanName}.xml`);
    }, [vfs, packageDir, cleanName]);

    const [includedFiles, setIncludedFiles] = useState<Set<string>>(new Set());
    // Default every discovered resource to included; the list changes only when
    // the package name points at a different directory.
    useEffect(() => { setIncludedFiles(new Set(vfsFiles)); }, [vfsFiles]);

    const selectedInput: SerializeInput = useMemo(
        () => selectExportInput({ scripts, aliases, triggers, timers, keys, buttons }, selection),
        [scripts, aliases, triggers, timers, keys, buttons, selection],
    );
    const selectedCount = countSelected(selectedInput);

    const toggleItem = useCallback((category: ExportCategory, id: string, checked: boolean) => {
        setSelection(prev => {
            const next = new Set(prev[category]);
            // Checking a group takes its whole subtree, as Mudlet's tree cascade does.
            const ids = [id, ...descendantIds(nodesFor[category], id)];
            for (const each of ids) {
                if (checked) next.add(each); else next.delete(each);
            }
            return { ...prev, [category]: next };
        });
    }, [nodesFor]);

    const setCategoryAll = useCallback((category: ExportCategory, on: boolean) => {
        setSelection(prev => ({ ...prev, [category]: on ? new Set(nodesFor[category].map(n => n.id)) : new Set() }));
    }, [nodesFor]);

    const setAll = useCallback((on: boolean) => {
        setSelection(() => {
            const next = emptySelection();
            if (on) for (const cat of CATEGORY_ORDER) next[cat] = new Set(nodesFor[cat].map(n => n.id));
            return next;
        });
    }, [nodesFor]);

    const handleIcon = useCallback(async (picked: PickedFile[]) => {
        const first = picked[0];
        if (!first) return;
        setIconBytes(new Uint8Array(await first.file.arrayBuffer()));
        setIconName(first.file.name);
    }, []);

    const handleAddFiles = useCallback(async (picked: PickedFile[]) => {
        // Mudlet stages added files by basename at the package root; a VFS pick
        // is treated the same, so where it sat in the profile doesn't leak into
        // the archive layout.
        const loaded = await Promise.all(picked.map(async p => ({
            name: p.file.name,
            bytes: new Uint8Array(await p.file.arrayBuffer()),
        })));
        setExtraFiles(prev => [...prev.filter(p => !loaded.some(l => l.name === p.name)), ...loaded]);
    }, []);

    const handleExport = useCallback(() => {
        setError(null);
        setResult(null);
        if (!cleanName) { setError('A package name is required.'); return; }
        setBusy(true);
        try {
            const assets: Record<string, Uint8Array> = {};
            if (vfs && packageDir) {
                for (const rel of includedFiles) {
                    try {
                        assets[rel] = vfs.readBinaryFile(`${packageDir}/${rel}`);
                    } catch (err) {
                        console.warn('[PackageExportModal] unreadable resource skipped:', rel, err);
                    }
                }
            }
            for (const f of extraFiles) assets[f.name] = f.bytes;

            const zipped = buildPackageZip({
                meta: {
                    name: cleanName,
                    author: author.trim(),
                    title: title.trim(),
                    description,
                    version: version.trim(),
                    helpURL: helpUrl.trim(),
                    dependencies: dependencies.split(',').map(d => d.trim()).filter(Boolean),
                    icon: iconName.trim(),
                    created: new Date().toISOString(),
                },
                nodes: selectedInput,
                assets,
                ...(iconBytes ? { iconBytes } : {}),
            });
            const filename = `${cleanName}.mpackage`;
            downloadBlob(filename, new Blob([zipped.slice()], { type: 'application/zip' }));
            setResult({ filename, size: zipped.byteLength, items: selectedCount });
            onExported?.(`Exported package "${cleanName}" (${selectedCount} items, ${formatBytes(zipped.byteLength)})`);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }, [cleanName, vfs, packageDir, includedFiles, extraFiles, author, title, description, version,
        helpUrl, dependencies, iconName, iconBytes, selectedInput, selectedCount, onExported]);

    return (
        <ResizableModal
            title="Export package"
            onClose={onClose}
            defaultW={780}
            defaultH={640}
            minW={520}
            minH={420}
            bodyClassName="pkg-export"
        >
            <div className="pkg-export__cols">
                <div className="pkg-export__meta">
                    <FormField label="Package name">
                        <input
                            className="input"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder="my-package"
                            autoFocus
                        />
                    </FormField>
                    <div className="pkg-export__row">
                        <FormField label="Title">
                            <input className="input" value={title} onChange={e => setTitle(e.target.value)} />
                        </FormField>
                        <FormField label="Version">
                            <input className="input" value={version} onChange={e => setVersion(e.target.value)} placeholder="1.0" />
                        </FormField>
                    </div>
                    <FormField label="Author">
                        <input className="input" value={author} onChange={e => setAuthor(e.target.value)} />
                    </FormField>
                    <FormField label="Description">
                        <textarea
                            className="input pkg-export__textarea"
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            placeholder="Markdown is rendered in the package list."
                        />
                    </FormField>
                    <FormField label="Help URL">
                        <input className="input" value={helpUrl} onChange={e => setHelpUrl(e.target.value)} placeholder="https://…" />
                    </FormField>
                    <FormField label="Dependencies">
                        <input
                            className="input"
                            value={dependencies}
                            onChange={e => setDependencies(e.target.value)}
                            placeholder="comma-separated package names"
                        />
                    </FormField>

                    <div className="pkg-export__files">
                        <div className="pkg-export__files-head">
                            <span>Icon</span>
                            <FileSourceButton
                                vfs={vfs}
                                label="Choose…"
                                accept="image/*"
                                pickerTitle="Pick an icon from profile files"
                                location={packageDir ?? ''}
                                onPick={files => void handleIcon(files)}
                            />
                        </div>
                        <div className="pkg-export__icon-name">
                            {iconName
                                ? <><FileCode2 size={12} strokeWidth={1.6} />{iconName}{!iconBytes && vfsFiles.some(f => f.endsWith(`/${iconName}`) || f === iconName) ? ' (from package files)' : ''}</>
                                : <span className="pkg-export__muted">No icon</span>}
                            {iconName && (
                                <button
                                    className="pkg-export__remove"
                                    onClick={() => { setIconName(''); setIconBytes(null); }}
                                    title="Remove icon"
                                >×</button>
                            )}
                        </div>
                    </div>

                    <div className="pkg-export__files">
                        <div className="pkg-export__files-head">
                            <span>Files</span>
                            <FileSourceButton
                                vfs={vfs}
                                label="Add…"
                                multiple
                                pickerTitle="Add files from the profile"
                                location={packageDir ?? ''}
                                onPick={files => void handleAddFiles(files)}
                                onError={setError}
                            />
                        </div>
                        <div className="pkg-export__file-list">
                            {vfsFiles.length === 0 && extraFiles.length === 0 && (
                                <span className="pkg-export__muted">
                                    {cleanName
                                        ? `Nothing in /${cleanName}/ — add images, sounds or Lua modules to ship with the package.`
                                        : 'Name the package to pick up resources already in the profile.'}
                                </span>
                            )}
                            {vfsFiles.map(rel => (
                                <label key={rel} className="pkg-export__file">
                                    <input
                                        type="checkbox"
                                        checked={includedFiles.has(rel)}
                                        onChange={e => setIncludedFiles(prev => {
                                            const next = new Set(prev);
                                            if (e.target.checked) next.add(rel); else next.delete(rel);
                                            return next;
                                        })}
                                    />
                                    <span>{rel}</span>
                                </label>
                            ))}
                            {extraFiles.map(f => (
                                <label key={`extra:${f.name}`} className="pkg-export__file">
                                    <input type="checkbox" checked readOnly />
                                    <span>{f.name}</span>
                                    <button
                                        className="pkg-export__remove"
                                        onClick={() => setExtraFiles(prev => prev.filter(p => p.name !== f.name))}
                                        title="Remove"
                                    >×</button>
                                </label>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="pkg-export__items">
                    <div className="pkg-export__items-head">
                        <span className="pkg-export__items-title">{selectedCount} item{selectedCount === 1 ? '' : 's'} selected</span>
                        <Button variant="secondary" size="sm" onClick={() => setAll(true)}>All</Button>
                        <Button variant="secondary" size="sm" onClick={() => setAll(false)}>None</Button>
                    </div>
                    <div className="pkg-export__tree">
                        {CATEGORY_ORDER.map(cat => {
                            const nodes = nodesFor[cat];
                            const Icon = CATEGORY_ICON[cat];
                            const chosen = selection[cat].size;
                            return (
                                <div key={cat} className="pkg-export__cat">
                                    <div className="pkg-export__cat-head">
                                        <Icon size={13} strokeWidth={1.6} />
                                        <span className="pkg-export__cat-name">{CATEGORY_LABEL[cat]}</span>
                                        <span className="pkg-export__cat-count">{chosen ? `${chosen}/${nodes.length}` : nodes.length}</span>
                                        {nodes.length > 0 && (
                                            <>
                                                <button className="pkg-export__link" onClick={() => setCategoryAll(cat, true)}>all</button>
                                                <button className="pkg-export__link" onClick={() => setCategoryAll(cat, false)}>none</button>
                                            </>
                                        )}
                                    </div>
                                    {nodes.length === 0 ? (
                                        <div className="pkg-export__cat-empty">none</div>
                                    ) : flatten(nodes, null).map(({ item, depth }) => (
                                        <label
                                            key={item.id}
                                            className={`pkg-export__node${item.isGroup ? ' pkg-export__node--group' : ''}`}
                                            style={{ paddingLeft: `${10 + depth * 14}px` }}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={selection[cat].has(item.id)}
                                                onChange={e => toggleItem(cat, item.id, e.target.checked)}
                                            />
                                            {item.isGroup && <Folder size={12} strokeWidth={1.6} />}
                                            <span className="pkg-export__node-name">{item.name}</span>
                                            {item.packageName && <span className="pkg-export__node-pkg">{item.packageName}</span>}
                                        </label>
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>

            {error && <p className="pkg-export__status pkg-export__status--error" role="alert">{error}</p>}
            {result && (
                <p className="pkg-export__status pkg-export__status--ok" role="status">
                    Saved {result.filename} — {result.items} item{result.items === 1 ? '' : 's'}, {formatBytes(result.size)}
                </p>
            )}

            <div className="pkg-export__actions">
                <span className="pkg-export__hint">
                    {cleanName ? `${cleanName}.mpackage` : 'Give the package a name to export.'}
                </span>
                <Button variant="secondary" onClick={onClose}>Close</Button>
                <Button onClick={handleExport} disabled={busy || !cleanName}>
                    <Download size={14} />
                    Export
                </Button>
            </div>
        </ResizableModal>
    );
}
