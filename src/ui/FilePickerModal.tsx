import type { ProfileVFS } from '../scripting/vfs/ProfileVFS';
import { VfsPickerModal } from './VfsPickerModal';

/**
 * The Lua `invokeFileDialog(...)` picker. The calling Lua handler is parked on
 * its coroutine until this resolves, so every exit path (Select, Cancel, the
 * header ✕) must call `onDone` — with the picked absolute VFS path, or '' for
 * cancel (Mudlet's return value for a dismissed dialog).
 *
 * The tree itself is VfsPickerModal, shared with the app's "pick from profile
 * files" buttons; this wrapper only narrows it to the single-path contract Lua
 * expects.
 */
interface FilePickerModalProps {
    vfs: ProfileVFS | null;
    mode: 'file' | 'folder';
    title: string;
    /** VFS path to reveal on open; '' or invalid falls back to the root. */
    location: string;
    onDone: (path: string) => void;
}

export function FilePickerModal({ vfs, mode, title, location, onDone }: FilePickerModalProps) {
    return (
        <VfsPickerModal
            vfs={vfs}
            mode={mode}
            title={title}
            location={location}
            onDone={paths => onDone(paths[0] ?? '')}
        />
    );
}
