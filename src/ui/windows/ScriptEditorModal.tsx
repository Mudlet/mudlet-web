import { useRef } from 'react';
import { ScriptEditorPanel } from './panels/ScriptEditorPanel';
import type { ScriptEditorPanelHandle } from './panels/ScriptEditorPanel';
import { ScriptSearch } from './panels/ScriptSearch';
import { useAppStore } from '../../storage';
import { ResizableModal } from '../ResizableModal';
import type { MudSession } from '../../mud/MudSession';
import type { ProfileVFS } from '../../scripting/vfs/ProfileVFS';
import type { ScriptingEngine } from '../../scripting/ScriptingEngine';

const MIN_W = 500;
const MIN_H = 320;
const DEFAULT_W = 900;
const DEFAULT_H = 640;

interface Props {
    connectionId: string;
    session: MudSession;
    vfs: ProfileVFS | null;
    scriptingEngineRef?: React.RefObject<ScriptingEngine | null>;
    onClose: () => void;
    onOpenVfsFile?: (path: string, line?: number) => void;
}

export function ScriptEditorModal({ connectionId, session, vfs, scriptingEngineRef, onClose, onOpenVfsFile }: Props) {
    const savedBounds = useAppStore(s => s.connectionScriptEditorBounds[connectionId]);
    const saveBounds  = useAppStore(s => s.saveScriptEditorBounds);

    const boundsRef = useRef(savedBounds ?? null);
    const panelRef = useRef<ScriptEditorPanelHandle>(null);

    return (
        <ResizableModal
            title="Scripts"
            className="script-editor-modal"
            onClose={onClose}
            // Escape belongs to what's inside: ScriptEditorPanel's key capture,
            // LuaEditor and ScriptSearch each claim it, exactly as Mudlet's
            // dlgTriggerEditor spends it on leaving key-grab mode. It is a
            // QMainWindow, not a QDialog, for that reason.
            closeOnEscape={false}
            savedBounds={savedBounds}
            onBoundsChange={b => {
                boundsRef.current = { ...boundsRef.current, ...b };
                saveBounds(connectionId, boundsRef.current!);
            }}
            minW={MIN_W}
            minH={MIN_H}
            defaultW={DEFAULT_W}
            defaultH={DEFAULT_H}
            headerExtra={
                <ScriptSearch
                    connectionId={connectionId}
                    onNavigate={(category, id, line) => panelRef.current?.navigateToItem(category, id, line)}
                />
            }
        >
            <ScriptEditorPanel
                ref={panelRef}
                connectionId={connectionId}
                session={session}
                vfs={vfs}
                scriptingEngineRef={scriptingEngineRef}
                initialListWidth={savedBounds?.listWidth}
                onSplitsChange={(listWidth) => {
                    boundsRef.current = { ...boundsRef.current, listWidth };
                    saveBounds(connectionId, boundsRef.current!);
                }}
                onOpenVfsFile={onOpenVfsFile}
            />
        </ResizableModal>
    );
}
