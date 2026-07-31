import { useCallback, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { HardDrive, FolderOpen } from 'lucide-react';
import { Button } from './Button';
import { ContextMenu } from './ContextMenu';
import { VfsPickerModal } from '../VfsPickerModal';
import type { ProfileVFS } from '../../scripting/vfs/ProfileVFS';

// One trigger, two sources. Everywhere the app used to only accept an upload
// from the user's computer, the profile's own VFS is an equally valid source —
// packages, fonts, maps and sounds usually already live there, and re-uploading
// a file the profile is holding is busywork.
//
// Both sources hand back plain `File` objects so call sites keep the code they
// already had for `<input type="file">`; a VFS pick additionally carries its
// absolute path for callers that want to reference the file in place rather
// than copy its bytes.

export interface PickedFile {
    file: File;
    /** Absolute VFS path — set only when the file came from the profile. */
    vfsPath?: string;
}

export interface FileSourceOptions {
    vfs: ProfileVFS | null;
    /** `accept` for the OS picker; also derives the VFS filter when `vfsAccept` is absent. */
    accept?: string;
    /** Filename filter for the VFS tree. Pass `null` to show every file. */
    vfsAccept?: RegExp | null;
    multiple?: boolean;
    /** Start directory for the VFS picker. */
    location?: string;
    /** Title of the VFS picker window. */
    pickerTitle?: string;
    onPick: (files: PickedFile[]) => void | Promise<void>;
    /** Surfaces a VFS read failure; falls back to console.warn when absent. */
    onError?: (message: string) => void;
}

const WILDCARD_EXTENSIONS: Record<string, string[]> = {
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],
    audio: ['wav', 'mp3', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus'],
    video: ['mp4', 'webm', 'ogv', 'mov', 'mkv', 'avi'],
};

/**
 * Turn an `accept` attribute into a filename filter for the VFS tree.
 * Extensions and `type/*` wildcards translate; a concrete MIME type
 * (`application/json`) doesn't, since VFS entries carry no content type — those
 * contribute nothing, and an accept list of only such entries filters nothing
 * rather than hiding every file.
 */
export function acceptToRegExp(accept?: string): RegExp | undefined {
    if (!accept) return undefined;
    const exts: string[] = [];
    for (const raw of accept.split(',')) {
        const entry = raw.trim().toLowerCase();
        if (!entry) continue;
        if (entry.startsWith('.')) {
            exts.push(entry.slice(1));
        } else if (entry.endsWith('/*')) {
            exts.push(...(WILDCARD_EXTENSIONS[entry.slice(0, -2)] ?? []));
        }
    }
    if (exts.length === 0) return undefined;
    const escaped = [...new Set(exts)].map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`\\.(${escaped.join('|')})$`, 'i');
}

function basename(path: string): string {
    return path.substring(path.lastIndexOf('/') + 1) || path;
}

/**
 * Headless half of the dual-source picker, for call sites whose trigger isn't a
 * plain `Button` (the map overlay's own buttons, hamburger menu entries).
 * Render `elements` anywhere in the subtree and call `open(triggerElement)`.
 */
export function useFileSource({
    vfs, accept, vfsAccept, multiple = false, location = '', pickerTitle, onPick, onError,
}: FileSourceOptions): { open: (anchor: HTMLElement | DOMRect | null) => void; elements: ReactNode } {
    const inputRef = useRef<HTMLInputElement>(null);
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const [picking, setPicking] = useState(false);

    const report = useCallback((msg: string) => {
        if (onError) onError(msg); else console.warn('[useFileSource]', msg);
    }, [onError]);

    const open = useCallback((anchor: HTMLElement | DOMRect | null) => {
        // With no profile mounted there's only one source, so skip the menu.
        if (!vfs) { inputRef.current?.click(); return; }
        const rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
        setMenu(rect ? { x: rect.left, y: rect.bottom + 4 } : { x: 0, y: 0 });
    }, [vfs]);

    const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = '';
        if (files.length) await onPick(files.map(file => ({ file })));
    }, [onPick]);

    const handleVfsPick = useCallback(async (paths: string[]) => {
        setPicking(false);
        if (!vfs || paths.length === 0) return;
        const picked: PickedFile[] = [];
        for (const path of paths) {
            try {
                const bytes = vfs.readBinaryFile(path);
                picked.push({ file: new File([bytes.slice()], basename(path)), vfsPath: path });
            } catch (err) {
                report(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        if (picked.length) await onPick(picked);
    }, [vfs, onPick, report]);

    const filter = vfsAccept === undefined ? acceptToRegExp(accept) : (vfsAccept ?? undefined);

    const elements = (
        <>
            <input
                ref={inputRef}
                type="file"
                {...(accept ? { accept } : {})}
                multiple={multiple}
                hidden
                onChange={e => void handleUpload(e)}
            />
            {menu && (
                <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
                    <button
                        className="ctx-menu__item"
                        onClick={() => { setMenu(null); inputRef.current?.click(); }}
                    >
                        <HardDrive size={13} strokeWidth={1.6} />
                        From computer…
                    </button>
                    <button
                        className="ctx-menu__item"
                        onClick={() => { setMenu(null); setPicking(true); }}
                    >
                        <FolderOpen size={13} strokeWidth={1.6} />
                        From profile files…
                    </button>
                </ContextMenu>
            )}
            {picking && (
                <VfsPickerModal
                    vfs={vfs}
                    mode={multiple ? 'files' : 'file'}
                    title={pickerTitle ?? 'Select from profile files'}
                    location={location}
                    {...(filter ? { accept: filter } : {})}
                    onDone={paths => void handleVfsPick(paths)}
                />
            )}
        </>
    );

    return { open, elements };
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'icon' | 'danger';

// `onError` is dropped from the button attributes: ours reports a VFS read
// failure as a string, which is not the DOM's error-event handler.
interface FileSourceButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'onError'>, FileSourceOptions {
    label: ReactNode;
    variant?: ButtonVariant;
    size?: 'sm' | 'md';
}

export function FileSourceButton({
    vfs, label, accept, vfsAccept, multiple, location, pickerTitle, onPick, onError,
    variant = 'secondary', size = 'sm', ...buttonProps
}: FileSourceButtonProps) {
    const { open, elements } = useFileSource({
        vfs, accept, vfsAccept, multiple, location, pickerTitle, onPick, onError,
    });
    return (
        <>
            <Button variant={variant} size={size} onClick={e => open(e.currentTarget)} {...buttonProps}>
                {label}
            </Button>
            {elements}
        </>
    );
}
