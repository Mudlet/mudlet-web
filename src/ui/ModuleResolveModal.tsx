import { useMemo, useRef, useState } from 'react';
import { Button } from './components';
import { useModalFocus } from './components/useModalFocus';
import type { MudletModuleRef } from '../import/mudletHost';

export interface ModuleUpload {
    key: string;
    bytes: Uint8Array;
}

interface Props {
    /** Modules whose external XML file couldn't be found in the imported tree. */
    modules: MudletModuleRef[];
    /** Called when every module has been decided — uploaded modules are folded
     *  in, the rest dropped. */
    onComplete: (uploads: ModuleUpload[]) => void;
    /** Abort the whole import. */
    onCancel: () => void;
}

type Decision =
    | { action: 'pending' }
    | { action: 'remove' }
    | { action: 'upload'; bytes: Uint8Array; filename: string };

/**
 * After a Mudlet-profile import, modules that load from an external local XML
 * file (which a browser can't read, and that wasn't found inside the profile)
 * are listed here. For each, the user uploads its `.xml` or drops it. The import
 * only proceeds once every module is decided.
 */
export function ModuleResolveModal({ modules, onComplete, onCancel }: Props) {
    const ref = useModalFocus<HTMLDivElement>(onCancel);
    const [decisions, setDecisions] = useState<Record<string, Decision>>(
        () => Object.fromEntries(modules.map(m => [m.key, { action: 'pending' } as Decision])),
    );
    const fileRef = useRef<HTMLInputElement>(null);
    const activeKey = useRef<string | null>(null);

    const allDecided = useMemo(
        () => modules.every(m => decisions[m.key]?.action !== 'pending'),
        [modules, decisions],
    );

    const pickFile = (key: string) => { activeKey.current = key; fileRef.current?.click(); };

    const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        const key = activeKey.current;
        e.target.value = '';
        if (!file || !key) return;
        const bytes = new Uint8Array(await file.arrayBuffer());
        setDecisions(d => ({ ...d, [key]: { action: 'upload', bytes, filename: file.name } }));
    };

    const finish = () => {
        const uploads: ModuleUpload[] = [];
        for (const m of modules) {
            const d = decisions[m.key];
            if (d?.action === 'upload') uploads.push({ key: m.key, bytes: d.bytes });
        }
        onComplete(uploads);
    };

    return (
        <>
            <div className="modal-overlay" onClick={onCancel} />
            <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label="Resolve modules" style={{ maxWidth: 560 }}>
                <div className="modal-header">
                    <span className="modal-title">Imported profile uses {modules.length} module{modules.length === 1 ? '' : 's'}</span>
                    <button className="modal-close" onClick={onCancel} type="button" aria-label="Close">✕</button>
                </div>
                <div className="modal-body">
                    <p style={{ marginTop: 0, opacity: 0.8, fontSize: 13 }}>
                        These modules load from a file on your computer that mudlet can't read. Upload each module's
                        <code> .xml</code>, or drop it from the profile.
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {modules.map(m => {
                            const d = decisions[m.key] ?? { action: 'pending' };
                            return (
                                <div key={m.key} style={{
                                    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                                    border: '1px solid var(--border, #2a2a2a)', borderRadius: 6,
                                }}>
                                    <div style={{ minWidth: 0, flex: 1 }}>
                                        <div style={{ fontWeight: 600 }}>{m.key}</div>
                                        <div style={{ fontSize: 11, opacity: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {m.filepath}
                                        </div>
                                    </div>
                                    {d.action === 'upload' && (
                                        <span style={{ fontSize: 12, color: 'var(--accent)' }}>✓ {d.filename}</span>
                                    )}
                                    {d.action === 'remove' && (
                                        <span style={{ fontSize: 12, opacity: 0.5 }}>removed</span>
                                    )}
                                    <Button variant="secondary" size="sm" onClick={() => pickFile(m.key)}>
                                        {d.action === 'upload' ? 'Replace…' : 'Upload…'}
                                    </Button>
                                    <Button
                                        variant={d.action === 'remove' ? 'primary' : 'secondary'}
                                        size="sm"
                                        onClick={() => setDecisions(s => ({ ...s, [m.key]: { action: 'remove' } }))}
                                    >
                                        Remove
                                    </Button>
                                </div>
                            );
                        })}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                        <Button variant="secondary" onClick={onCancel}>Cancel import</Button>
                        <Button variant="primary" onClick={finish} disabled={!allDecided}>Finish import</Button>
                    </div>
                </div>
                <input ref={fileRef} type="file" accept=".xml" style={{ display: 'none' }} onChange={onFile} />
            </div>
        </>
    );
}
