import { useState, useEffect } from 'react';
import type { ProfileVFS } from '../../scripting/vfs/ProfileVFS';
import type { OutputFontSource } from '../../storage';
import { Button } from './Button';
import { FileSourceButton, type PickedFile } from './FileSourceButton';
import { Input } from './Input';
import {
    ensureFontAvailable,
    isFontAvailable,
    queryLocalFonts,
    isLocalFontApiSupported,
    loadFontFromUrl,
    loadFontFromVfs,
    diagnoseFontProbe,
    setLocalFontsCache,
    type FontProbeReport,
    type LocalFontEntry,
} from '../../utils/fontLoader';

const FONTS_DIR = 'fonts';
const FONT_FILE_RE = /\.(ttf|otf|woff2?|ttc)$/i;

type Tab = 'name' | 'system' | 'url' | 'vfs';

interface FontPickerProps {
    value: OutputFontSource | undefined;
    onChange: (next: OutputFontSource | undefined) => void;
    vfs: ProfileVFS | null;
    /** What is drawn with when nothing is chosen. The main display falls back to
     *  the browser's monospace; the map's room symbols to the bundled Bitstream
     *  Vera Sans Mono — so the picker has to be told, rather than assert one. */
    fallbackLabel?: string;
}

function initialTab(value: OutputFontSource | undefined): Tab {
    if (value?.kind === 'url') return 'url';
    if (value?.kind === 'vfs') return 'vfs';
    return 'name';
}

export function FontPicker({ value, onChange, vfs, fallbackLabel = 'default monospace' }: FontPickerProps) {
    const [tab, setTab] = useState<Tab>(() => initialTab(value));

    return (
        <div className="font-picker">
            <div className="font-picker__current">
                {value
                    ? <span>Active: <strong>{value.family}</strong> <em className="font-picker__kind">({value.kind})</em></span>
                    : <span className="font-picker__muted">No font set — using {fallbackLabel}.</span>}
                {value && (
                    <Button variant="ghost" size="sm" onClick={() => onChange(undefined)}>Reset</Button>
                )}
            </div>
            <div className="font-picker__tabs">
                {(['name', 'system', 'url', 'vfs'] as const).map(t => (
                    <button
                        key={t}
                        type="button"
                        className={`font-picker__tab${tab === t ? ' font-picker__tab--active' : ''}`}
                        onClick={() => setTab(t)}
                    >
                        {t === 'name' ? 'By name' : t === 'system' ? 'Installed' : t === 'url' ? 'From URL' : 'From file'}
                    </button>
                ))}
            </div>
            <div className="font-picker__body">
                {tab === 'name'   && <NameTab   value={value} onChange={onChange} />}
                {tab === 'system' && <SystemTab value={value} onChange={onChange} />}
                {tab === 'url'    && <UrlTab    value={value} onChange={onChange} />}
                {tab === 'vfs'    && <VfsTab    value={value} onChange={onChange} vfs={vfs} />}
            </div>
            {value?.family && <FontPreview family={value.family} />}
        </div>
    );
}

// ── By name ──────────────────────────────────────────────────────────────────

interface SubProps {
    value: OutputFontSource | undefined;
    onChange: (next: OutputFontSource | undefined) => void;
}

function NameTab({ value, onChange }: SubProps) {
    const [name, setName] = useState(value?.kind === 'system' ? value.family : '');
    const trimmed = name.trim();
    const [valid, setValid] = useState<boolean | null>(() => (trimmed ? isFontAvailable(trimmed) : null));
    const [report, setReport] = useState<FontProbeReport | null>(null);

    useEffect(() => {
        if (!trimmed) { setValid(null); setReport(null); return; }
        setValid(isFontAvailable(trimmed));
        let cancelled = false;
        ensureFontAvailable(trimmed).then(ok => { if (!cancelled) setValid(ok); });
        diagnoseFontProbe(trimmed).then(r => { if (!cancelled) setReport(r); });
        return () => { cancelled = true; };
    }, [trimmed]);

    return (
        <div className="font-picker__name">
            <div className="font-picker__row">
                <Input
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="e.g. Cascadia Code"
                    spellCheck={false}
                />
                <Button
                    onClick={() => onChange({ kind: 'system', family: trimmed })}
                    disabled={!trimmed}
                >
                    Apply
                </Button>
            </div>
            {trimmed && (
                <p className={`font-picker__validity${valid ? ' font-picker__validity--ok' : ' font-picker__validity--bad'}`}>
                    {valid ? '✓ Detected on this system.' : '✗ Not detected — applying anyway will fall back to monospace.'}
                </p>
            )}
            {report && <ProbeDebug report={report} />}
        </div>
    );
}

function ProbeDebug({ report }: { report: FontProbeReport }) {
    return (
        <details className="font-picker__debug" style={{ marginTop: 8, fontSize: 12, fontFamily: 'monospace' }}>
            <summary style={{ cursor: 'pointer' }}>Probe diagnostics</summary>
            <div style={{ marginTop: 6, padding: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4 }}>
                <div>family: <strong>{report.family}</strong></div>
                <div>probe text: {report.text}</div>
                <div>size: {report.fontSizePx}px</div>
                <div>document.fonts.check(): <strong>{String(report.fontsCheckSays)}</strong> (unreliable, ignored)</div>
                <div>document.fonts.load() returned faces: <strong>{report.fontsLoadFaces}</strong></div>
                <div>FontFaceSet size: <strong>{report.fontFamiliesInSet}</strong></div>
                <table style={{ marginTop: 6, borderCollapse: 'collapse', width: '100%' }}>
                    <thead>
                        <tr>
                            <th style={{ textAlign: 'left', padding: '2px 6px' }}>fallback</th>
                            <th style={{ textAlign: 'right', padding: '2px 6px' }}>baseline</th>
                            <th style={{ textAlign: 'right', padding: '2px 6px' }}>w/ candidate</th>
                            <th style={{ textAlign: 'center', padding: '2px 6px' }}>diverges?</th>
                        </tr>
                    </thead>
                    <tbody>
                        {report.rows.map(r => (
                            <tr key={r.fallback}>
                                <td style={{ padding: '2px 6px' }}>{r.fallback}</td>
                                <td style={{ padding: '2px 6px', textAlign: 'right' }}>{r.baselineWidth}px</td>
                                <td style={{ padding: '2px 6px', textAlign: 'right' }}>{r.candidateWidth}px</td>
                                <td style={{ padding: '2px 6px', textAlign: 'center' }}>{r.diverges ? '✓' : '✗'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <div style={{ marginTop: 6 }}>verdict: <strong>{report.available ? 'available' : 'not detected'}</strong></div>
            </div>
        </details>
    );
}

// ── Installed (Local Font Access) ────────────────────────────────────────────

function SystemTab({ value, onChange }: SubProps) {
    const supported = isLocalFontApiSupported();
    const [families, setFamilies] = useState<string[] | null>(null);
    const [filter, setFilter] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    // True until we know whether a prior permission grant lets us auto-query;
    // prevents the "grant permission" button from flashing before auto-query starts.
    const [checkingPermission, setCheckingPermission] = useState(supported);

    const handleQuery = async () => {
        setLoading(true);
        setError(null);
        try {
            const list = await queryLocalFonts();
            const set = new Set<string>();
            for (const f of list as LocalFontEntry[]) set.add(f.family);
            const sorted = [...set].sort((a, b) => a.localeCompare(b));
            setFamilies(sorted);
            setLocalFontsCache(sorted);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    };

    // If the user has already granted local-fonts permission in a previous
    // session, skip the gesture-gated button and query immediately.
    useEffect(() => {
        if (!supported) return;
        let cancelled = false;
        const perms = (navigator as Navigator & { permissions?: { query: (d: { name: string }) => Promise<PermissionStatus> } }).permissions;
        if (!perms?.query) { setCheckingPermission(false); return; }
        perms.query({ name: 'local-fonts' }).then(status => {
            if (cancelled) return;
            if (status.state === 'granted') handleQuery();
            setCheckingPermission(false);
        }).catch(() => {
            if (!cancelled) setCheckingPermission(false);
        });
        return () => { cancelled = true; };
    }, [supported]);

    if (!supported) {
        return (
            <p className="font-picker__hint">
                Your browser doesn't support the Local Font Access API (Chromium-only).
                Use one of the other tabs to pick a font.
            </p>
        );
    }

    if (checkingPermission || (loading && !families)) {
        return <FontListSkeleton />;
    }

    if (!families) {
        return (
            <div className="font-picker__name">
                <p className="font-picker__hint">
                    Click below to grant permission and list installed fonts.
                </p>
                <Button onClick={handleQuery} disabled={loading}>
                    {loading ? 'Querying…' : 'List installed fonts'}
                </Button>
                {error && <p className="font-picker__validity font-picker__validity--bad">{error}</p>}
            </div>
        );
    }

    const filtered = filter
        ? families.filter(f => f.toLowerCase().includes(filter.toLowerCase()))
        : families;

    return (
        <>
            <div className="font-picker__row">
                <Input
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    placeholder={`Filter ${families.length} families…`}
                    spellCheck={false}
                />
                <Button variant="ghost" size="sm" onClick={handleQuery} disabled={loading}>Refresh</Button>
            </div>
            <div className="font-picker__list">
                {filtered.length === 0 && <p className="font-picker__empty">No matches.</p>}
                {filtered.map(family => (
                    <button
                        key={family}
                        type="button"
                        className={`font-picker__item${value?.family === family ? ' font-picker__item--selected' : ''}`}
                        style={{ fontFamily: `"${family}", monospace` }}
                        onClick={() => onChange({ kind: 'system', family })}
                    >
                        {family}
                    </button>
                ))}
            </div>
        </>
    );
}

function FontListSkeleton() {
    return (
        <div className="font-picker__name" aria-busy="true" aria-live="polite">
            <div className="font-picker__row">
                <div className="font-picker__skeleton-input" />
            </div>
            <div className="font-picker__list">
                {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="font-picker__item font-picker__skeleton-item">
                        <span className="font-picker__skeleton-bar" style={{ width: `${40 + ((i * 13) % 50)}%` }} />
                    </div>
                ))}
            </div>
        </div>
    );
}

// ── From URL (Google Fonts etc.) ─────────────────────────────────────────────

function guessFamilyFromUrl(url: string): string {
    try {
        const u = new URL(url);
        const fam = u.searchParams.get('family');
        if (!fam) return '';
        // Google Fonts: "Fira+Code:wght@400;700" → "Fira Code"
        return fam.split(':')[0].replace(/\+/g, ' ');
    } catch {
        return '';
    }
}

function UrlTab({ value, onChange }: SubProps) {
    const [url, setUrl] = useState(value?.kind === 'url' ? value.url : '');
    const [family, setFamily] = useState(value?.kind === 'url' ? value.family : '');
    const [familyTouched, setFamilyTouched] = useState(false);
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

    // Auto-fill family from URL if user hasn't typed one.
    useEffect(() => {
        if (familyTouched || !url.trim()) return;
        const guess = guessFamilyFromUrl(url.trim());
        if (guess) setFamily(guess);
    }, [url, familyTouched]);

    const handleApply = async () => {
        const f = family.trim();
        const u = url.trim();
        if (!f || !u) return;
        setLoading(true);
        setStatus(null);
        try {
            await loadFontFromUrl(f, u);
            const ok = isFontAvailable(f);
            onChange({ kind: 'url', family: f, url: u });
            setStatus(ok
                ? { ok: true,  msg: '✓ Loaded.' }
                : { ok: false, msg: 'Stylesheet linked, but family not detected — check name spelling and CORS.' });
        } catch (e) {
            setStatus({ ok: false, msg: e instanceof Error ? e.message : String(e) });
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="font-picker__name">
            <p className="font-picker__hint">
                Paste a CSS URL (e.g. <code>https://fonts.googleapis.com/css2?family=Fira+Code</code>).
                The family field auto-fills from Google Fonts URLs.
            </p>
            <Input
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="Stylesheet URL"
                spellCheck={false}
            />
            <Input
                value={family}
                onChange={e => { setFamily(e.target.value); setFamilyTouched(true); }}
                placeholder="Font family name (must match @font-face)"
                spellCheck={false}
            />
            <div className="font-picker__row">
                <Button onClick={handleApply} disabled={loading || !family.trim() || !url.trim()}>
                    {loading ? 'Loading…' : 'Load & apply'}
                </Button>
            </div>
            {status && (
                <p className={`font-picker__validity${status.ok ? ' font-picker__validity--ok' : ' font-picker__validity--bad'}`}>
                    {status.msg}
                </p>
            )}
        </div>
    );
}

// ── From VFS file ────────────────────────────────────────────────────────────

interface VfsTabProps extends SubProps {
    vfs: ProfileVFS | null;
}

function listFontFiles(vfs: ProfileVFS): string[] {
    const dir = `${vfs.profilePath}/${FONTS_DIR}`;
    if (!vfs.exists(dir)) return [];
    try {
        return vfs.readdir(dir).filter(name => FONT_FILE_RE.test(name)).sort();
    } catch {
        return [];
    }
}

function VfsTab({ value, onChange, vfs }: VfsTabProps) {
    const [files, setFiles] = useState<string[]>(() => (vfs ? listFontFiles(vfs) : []));
    const [selected, setSelected] = useState(value?.kind === 'vfs' ? value.path : '');
    const [family, setFamily] = useState(value?.kind === 'vfs' ? value.family : '');
    const [familyTouched, setFamilyTouched] = useState(false);
    const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        setFiles(vfs ? listFontFiles(vfs) : []);
    }, [vfs]);

    // Auto-fill family from filename if user hasn't typed one.
    useEffect(() => {
        if (familyTouched || !selected) return;
        const base = selected.substring(selected.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
        if (base) setFamily(base);
    }, [selected, familyTouched]);

    if (!vfs) {
        return <p className="font-picker__hint">No profile mounted — connect first to use VFS-stored fonts.</p>;
    }

    const dir = `${vfs.profilePath}/${FONTS_DIR}`;

    const handleAddFont = async (picked: PickedFile[]) => {
        const first = picked[0];
        if (!first) return;
        try {
            // A font already under fonts/ is selected where it lies — copying it
            // onto itself would only produce a duplicate entry.
            if (first.vfsPath && first.vfsPath.startsWith(`${dir}/`)) {
                setSelected(first.vfsPath);
                setFiles(listFontFiles(vfs));
                return;
            }
            if (!vfs.exists(dir)) vfs.mkdir(dir);
            const path = `${dir}/${first.file.name}`;
            vfs.writeBinaryFile(path, new Uint8Array(await first.file.arrayBuffer()));
            setFiles(listFontFiles(vfs));
            setSelected(path);
        } catch (err) {
            setStatus({ ok: false, msg: err instanceof Error ? err.message : String(err) });
        }
    };

    const handleApply = async () => {
        const f = family.trim();
        if (!f || !selected) return;
        setLoading(true);
        setStatus(null);
        try {
            await loadFontFromVfs(f, selected, vfs);
            onChange({ kind: 'vfs', family: f, path: selected });
            setStatus({ ok: true, msg: '✓ Loaded.' });
        } catch (e) {
            setStatus({ ok: false, msg: e instanceof Error ? e.message : String(e) });
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="font-picker__name">
            <p className="font-picker__hint">
                Font files live under <code>{FONTS_DIR}/</code> in your profile (.ttf/.otf/.woff/.woff2).
            </p>
            <div className="font-picker__row">
                <FileSourceButton
                    vfs={vfs}
                    variant="ghost"
                    label="Add font…"
                    accept=".ttf,.otf,.woff,.woff2,.ttc"
                    pickerTitle="Pick a font from profile files"
                    location={dir}
                    onPick={files => void handleAddFont(files)}
                    onError={msg => setStatus({ ok: false, msg })}
                />
            </div>
            <div className="font-picker__list">
                {files.length === 0 && <p className="font-picker__empty">No font files in {FONTS_DIR}/</p>}
                {files.map(name => {
                    const path = `${dir}/${name}`;
                    return (
                        <button
                            key={name}
                            type="button"
                            className={`font-picker__item${selected === path ? ' font-picker__item--selected' : ''}`}
                            onClick={() => setSelected(path)}
                        >
                            {name}
                        </button>
                    );
                })}
            </div>
            <Input
                value={family}
                onChange={e => { setFamily(e.target.value); setFamilyTouched(true); }}
                placeholder="Family name to register as"
                spellCheck={false}
            />
            <div className="font-picker__row">
                <Button onClick={handleApply} disabled={loading || !selected || !family.trim()}>
                    {loading ? 'Loading…' : 'Apply'}
                </Button>
            </div>
            {status && (
                <p className={`font-picker__validity${status.ok ? ' font-picker__validity--ok' : ' font-picker__validity--bad'}`}>
                    {status.msg}
                </p>
            )}
        </div>
    );
}

// ── Preview ──────────────────────────────────────────────────────────────────

function FontPreview({ family }: { family: string }) {
    return (
        <div className="font-picker__preview" style={{ fontFamily: `"${family}", monospace` }}>
            <div>The quick brown fox jumps over the lazy dog.</div>
            <div>0123456789  !@#$%^&amp;*()  iIlL10 oO0</div>
        </div>
    );
}
