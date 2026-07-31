import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Folder, FolderOpen, File, Home, ChevronRight, ChevronDown } from 'lucide-react';
import { ResizableModal } from './ResizableModal';
import type { ProfileVFS } from '../scripting/vfs/ProfileVFS';
import { buildTree, type VFSNode } from './FileBrowserModal';

/**
 * The profile-VFS file/folder picker. Backs both Lua's `invokeFileDialog`
 * (single file or folder — see FilePickerModal) and the "pick from profile
 * files" half of every place the app would otherwise only take an upload from
 * the user's computer.
 *
 * `mode`:
 *  - `file`   — one file (QFileDialog::getOpenFileName)
 *  - `files`  — several files, checkbox per row
 *  - `folder` — one directory, files hidden (getExistingDirectory)
 */
export type VfsPickerMode = 'file' | 'files' | 'folder';

interface VfsPickerModalProps {
    vfs: ProfileVFS | null;
    mode: VfsPickerMode;
    title?: string;
    /** VFS path to reveal on open; '' or invalid falls back to the root. */
    location?: string;
    /** Filename filter — non-matching files are hidden (folders always show). */
    accept?: RegExp;
    /** Picked absolute VFS paths; an empty array means the user cancelled. */
    onDone: (paths: string[]) => void;
}

/** Resolve the requested start location to an existing dir under the profile
 *  root, tolerating relative paths and files (their parent dir is used). */
function resolveStartDir(vfs: ProfileVFS, location: string): string {
    const root = vfs.profilePath;
    let p = (location || '').trim().replace(/\/+$/, '');
    if (!p) return root;
    if (!p.startsWith(root)) p = `${root}/${p.replace(/^\/+/, '')}`;
    const st = vfs.stat(p);
    if (st?.type === 'dir') return p;
    if (st?.type === 'file') {
        const parent = p.substring(0, p.lastIndexOf('/'));
        if (vfs.stat(parent)?.type === 'dir') return parent;
    }
    return root;
}

/** Every ancestor dir between the root (exclusive) and `dir` (inclusive). */
function ancestorChain(root: string, dir: string): string[] {
    if (dir === root) return [];
    const chain: string[] = [];
    let p = dir;
    while (p.length > root.length) {
        chain.push(p);
        p = p.substring(0, p.lastIndexOf('/'));
    }
    return chain;
}

/** Children to render under `node` for this mode + accept filter. Folders are
 *  kept even when empty: a filter that hides every file still has to let the
 *  user walk the tree to see that for themselves. */
function visibleChildren(node: VFSNode, mode: VfsPickerMode, accept?: RegExp): VFSNode[] {
    const kids = node.children ?? [];
    if (mode === 'folder') return kids.filter(c => c.type === 'dir');
    if (!accept) return kids;
    return kids.filter(c => c.type === 'dir' || accept.test(c.name));
}

interface PickerRowProps {
    node: VFSNode;
    depth: number;
    mode: VfsPickerMode;
    accept?: RegExp;
    expanded: Set<string>;
    selected: Set<string>;
    onToggle: (path: string) => void;
    onSelect: (node: VFSNode) => void;
    onConfirm: (node: VFSNode) => void;
}

function PickerRow({ node, depth, mode, accept, expanded, selected, onToggle, onSelect, onConfirm }: PickerRowProps) {
    const indent = depth * 16;
    const isSelected = selected.has(node.path);

    if (node.type === 'dir') {
        const isOpen = expanded.has(node.path);
        const children = visibleChildren(node, mode, accept);
        return (
            <div>
                <div
                    className={`vfs-row vfs-dir${mode === 'folder' && isSelected ? ' vfs-selected' : ''}`}
                    style={{ paddingLeft: indent + 4 }}
                    onClick={() => { onToggle(node.path); if (mode === 'folder') onSelect(node); }}
                    onDoubleClick={() => { if (mode === 'folder') onConfirm(node); }}
                >
                    <span className="vfs-chevron">
                        {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    </span>
                    <span className="vfs-icon">
                        {isOpen ? <FolderOpen size={13} /> : <Folder size={13} />}
                    </span>
                    <span className="vfs-name">{node.name}/</span>
                </div>
                {isOpen && children.map(child => (
                    <PickerRow
                        key={child.path}
                        node={child}
                        depth={depth + 1}
                        mode={mode}
                        accept={accept}
                        expanded={expanded}
                        selected={selected}
                        onToggle={onToggle}
                        onSelect={onSelect}
                        onConfirm={onConfirm}
                    />
                ))}
            </div>
        );
    }

    // File rows only render in file/files mode (folder mode filters them out above).
    return (
        <div
            className={`vfs-row vfs-file${isSelected ? ' vfs-selected' : ''}`}
            style={{ paddingLeft: indent + (mode === 'files' ? 4 : 20) }}
            onClick={() => onSelect(node)}
            onDoubleClick={() => onConfirm(node)}
        >
            {mode === 'files' && (
                <input
                    type="checkbox"
                    className="vfs-check"
                    checked={isSelected}
                    onChange={() => onSelect(node)}
                    onClick={e => e.stopPropagation()}
                />
            )}
            <span className="vfs-icon"><File size={13} /></span>
            <span className="vfs-name">{node.name}</span>
        </div>
    );
}

export function VfsPickerModal({ vfs, mode, title, location = '', accept, onDone }: VfsPickerModalProps) {
    const root = vfs?.profilePath ?? '';

    const tree = useMemo(() => (vfs ? buildTree(vfs, root) : []), [vfs, root]);

    const [expanded, setExpanded] = useState<Set<string>>(() => {
        if (!vfs) return new Set();
        return new Set(ancestorChain(root, resolveStartDir(vfs, location)));
    });
    // Folder mode starts with the requested dir selected — "Select" right away
    // picks the start location, like QFileDialog.
    const [selected, setSelected] = useState<Set<string>>(() => {
        if (!vfs || mode !== 'folder') return new Set();
        return new Set([resolveStartDir(vfs, location)]);
    });

    const toggleExpand = (path: string) => setExpanded(prev => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path); else next.add(path);
        return next;
    });

    const select = (node: VFSNode) => setSelected(prev => {
        if (mode !== 'files') return new Set([node.path]);
        const next = new Set(prev);
        if (next.has(node.path)) next.delete(node.path); else next.add(node.path);
        return next;
    });

    const confirm = (paths: string[]) => onDone(paths);
    const chosen = [...selected];
    const rel = (p: string) => (p === root ? '(profile root)' : p.substring(root.length + 1));
    const displayPath =
        chosen.length === 0 ? (mode === 'folder' ? 'Select a folder…' : 'Select a file…')
        : chosen.length === 1 ? rel(chosen[0])
        : `${chosen.length} files selected`;

    const roots = tree.filter(n => n.type === 'dir' || (mode !== 'folder' && (!accept || accept.test(n.name))));

    // Portalled to <body>: this picker is opened from inside other modals (the
    // settings dialog, the package exporter), and `.modal` sets a transform —
    // which makes it the containing block for `position: fixed` descendants and
    // clips them to its own box. Rendering in place would trap the picker inside
    // the dialog that opened it.
    return createPortal(
        <ResizableModal
            title={title || (mode === 'folder' ? 'Select a folder' : mode === 'files' ? 'Select files' : 'Select a file')}
            onClose={() => confirm([])}
            className="vfs-picker-modal"
            defaultW={420}
            defaultH={480}
            minW={300}
            minH={280}
        >
            <div className="picker-tree-panel">
                {!vfs ? (
                    <p className="vfs-empty">No profile mounted.</p>
                ) : (
                    <div className="vfs-tree">
                        {mode === 'folder' && (
                            <div
                                className={`vfs-row vfs-dir${selected.has(root) ? ' vfs-selected' : ''}`}
                                style={{ paddingLeft: 4 }}
                                onClick={() => setSelected(new Set([root]))}
                                onDoubleClick={() => confirm([root])}
                            >
                                <span className="vfs-icon"><Home size={13} /></span>
                                <span className="vfs-name">(profile root)</span>
                            </div>
                        )}
                        {roots.map(node => (
                            <PickerRow
                                key={node.path}
                                node={node}
                                depth={0}
                                mode={mode}
                                accept={accept}
                                expanded={expanded}
                                selected={selected}
                                onToggle={toggleExpand}
                                onSelect={select}
                                onConfirm={n => confirm([n.path])}
                            />
                        ))}
                    </div>
                )}
            </div>
            <div className="merge-footer">
                <span className="picker-path" title={chosen.join(', ')}>{displayPath}</span>
                <button type="button" className="merge-btn-secondary" onClick={() => confirm([])}>
                    Cancel
                </button>
                <button
                    type="button"
                    className="merge-btn-primary"
                    disabled={chosen.length === 0}
                    onClick={() => confirm(chosen)}
                >
                    Select
                </button>
            </div>
        </ResizableModal>,
        document.body,
    );
}
