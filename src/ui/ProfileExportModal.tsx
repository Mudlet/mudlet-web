import { useState } from 'react';
import { Download } from 'lucide-react';
import { ResizableModal } from './ResizableModal';
import { Button } from './components';
import { downloadBlob, formatSessionFileStamp } from '../storage/logExport';
import { collectProfileExport } from '../import/collectProfileExport';
import { buildProfilesZip, type ProfileExportSource } from '../import/mudletProfileExport';
import type { MudConnection } from '../storage/schema';
import { formatBytes } from '../utils/formatBytes';

// Export profiles as a Mudlet-format .zip — one folder per selected profile.
// The same archive imports back through "Import .zip…" (here or on another
// deployment) and can be dropped into desktop Mudlet's profile directory.

interface Props {
    connections: MudConnection[];
    onClose: () => void;
}

export function ProfileExportModal({ connections, onClose }: Props) {
    const [selected, setSelected] = useState<Set<string>>(() => new Set(connections.map(c => c.id)));
    const [progress, setProgress] = useState<{ done: number; total: number; name: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<{ filename: string; size: number; count: number } | null>(null);

    const busy = progress !== null;
    const chosen = connections.filter(c => selected.has(c.id));

    const toggle = (id: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const setAll = (on: boolean) => setSelected(on ? new Set(connections.map(c => c.id)) : new Set());

    const handleExport = async () => {
        setError(null);
        setResult(null);
        const sources: ProfileExportSource[] = [];
        try {
            for (const [i, c] of chosen.entries()) {
                setProgress({ done: i, total: chosen.length, name: c.name });
                // Sequential on purpose: each profile mounts its own VFS, and
                // concurrent mounts of several profiles would multiply peak
                // memory by the size of the largest maps.
                sources.push(await collectProfileExport(c, { includeLogs: true }));
            }
            const now = new Date();
            const zipped = buildProfilesZip(sources, now);
            const filename = `mudlet-web-profiles ${formatSessionFileStamp(now.getTime())}.zip`;
            // Copy into a fresh ArrayBuffer-backed view so Blob gets a plain BlobPart.
            downloadBlob(filename, new Blob([zipped.slice()], { type: 'application/zip' }));
            setResult({ filename, size: zipped.byteLength, count: sources.length });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setProgress(null);
        }
    };

    return (
        <ResizableModal
            title="Export profiles"
            onClose={onClose}
            defaultW={520}
            defaultH={560}
            minW={380}
            minH={320}
            bodyClassName="profile-export"
        >
            <p className="profile-export__intro">
                Downloads a <code>.zip</code> holding one folder per profile — scripts, aliases,
                triggers, timers, keys, buttons, saved variables, settings, packages, map and session
                logs. Load it back with <strong>Import .zip…</strong>, here or on another Mudlet Web
                address; it also opens in desktop Mudlet.
            </p>

            <div className="profile-export__toolbar">
                <span className="profile-export__count">
                    {chosen.length} of {connections.length} selected
                </span>
                <span className="profile-export__spacer" />
                <Button variant="secondary" size="sm" onClick={() => setAll(true)} disabled={busy}>All</Button>
                <Button variant="secondary" size="sm" onClick={() => setAll(false)} disabled={busy}>None</Button>
            </div>

            <ul className="profile-export__list">
                {connections.map(c => (
                    <li key={c.id}>
                        <label className="profile-export__item">
                            <input
                                type="checkbox"
                                checked={selected.has(c.id)}
                                onChange={() => toggle(c.id)}
                                disabled={busy}
                            />
                            <span className="profile-export__name">{c.name}</span>
                            <span className="profile-export__addr">
                                {c.mode === 'websocket' ? (c.url ?? '') : `${c.host ?? ''}:${c.port ?? 23}`}
                            </span>
                        </label>
                    </li>
                ))}
            </ul>

            {progress && (
                <p className="profile-export__status" role="status">
                    Reading {progress.name}… ({progress.done + 1} of {progress.total})
                </p>
            )}
            {result && (
                <p className="profile-export__status profile-export__status--ok" role="status">
                    Exported {result.count} profile{result.count === 1 ? '' : 's'} — {result.filename} ({formatBytes(result.size)})
                </p>
            )}
            {error && <p className="profile-export__status profile-export__status--error" role="alert">{error}</p>}

            <div className="profile-export__actions">
                <Button variant="secondary" onClick={onClose} disabled={busy}>Close</Button>
                <Button onClick={() => void handleExport()} disabled={busy || !chosen.length}>
                    <Download size={14} />
                    {busy ? 'Exporting…' : `Export ${chosen.length || ''}`.trim()}
                </Button>
            </div>
        </ResizableModal>
    );
}
