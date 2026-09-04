import { useCallback, useRef } from 'react';
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

    // Stable identities: ScriptSearch memoises its whole scan on these, and the
    // scan walks every line of every script. Inline arrows here would re-run it
    // on every render of this modal — which includes every render of the
    // profile around it, i.e. while MUD output is arriving.
    const navigateToItem = useCallback(
        (category: Parameters<ScriptEditorPanelHandle['navigateToItem']>[0], id: string, line?: number) =>
            panelRef.current?.navigateToItem(category, id, line),
        [],
    );
    const navigateToVariable = useCallback(
        (name: string) => panelRef.current?.navigateToVariable(name),
        [],
    );

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
                    scriptingEngineRef={scriptingEngineRef}
                    onNavigate={navigateToItem}
                    onNavigateVariable={navigateToVariable}
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
