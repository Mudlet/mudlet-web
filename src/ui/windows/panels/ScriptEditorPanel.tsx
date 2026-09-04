import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { AlertCircle, Braces, Clock, Filter, Folder, FolderOpen, FolderPlus, Keyboard, MousePointerClick, Package, Shuffle, FileCode2, Trash2, Zap } from 'lucide-react';
import { Button, Input, ContextMenu, FileSourceButton, useConfirm, type PickedFile } from '../../components';
import { VariablesView } from './VariablesView';
import { useAppStore, useProfileField } from '../../../storage';
import { isPackageRemovable } from '../../../branding';
import { DEFAULT_ANSI_PALETTE } from '../../../mud/text/colors';
import type { AliasNode, ButtonLocation, ButtonNode, ButtonOrientation, KeyNode, PackageManifest, ScriptNode, TimerNode, TriggerNode, TriggerPattern, TriggerPatternType } from '../../../storage/schema';
import { isEffectivelyEnabled, MAX_CONDITION_LINE_DELTA } from '../../../storage/schema';
import type { MudSession, ScriptLogSource, ScriptLogSourceKind } from '../../../mud/MudSession';
import type { ProfileVFS } from '../../../scripting/vfs/ProfileVFS';
import type { ScriptingEngine } from '../../../scripting/ScriptingEngine';
import { LuaEditor } from './LuaEditor';
import { installModuleFromVfsPath, installPackageFromBytes, installPackageFromFile, uninstallPackageFiles } from '../../../import/packageInstaller';
import { PackageRepositoryModal } from './PackageRepositoryModal';
import { PackageExportModal, type ExportCategory } from './PackageExportModal';
import type { PackageRepoEntry } from '../../../import/packageRepository';
import { DEFAULT_PROXY_URL } from '../../../storage';
import { renderMarkdown } from '../../markdown';
import xterm256 from '../../../mud/text/xterm256';
import './ScriptEditorPanel.css';

type Category = 'scripts' | 'aliases' | 'triggers' | 'timers' | 'keys' | 'buttons' | 'packages' | 'errors' | 'variables';
type EditCategory = Exclude<Category, 'errors' | 'packages' | 'variables'>;
type AnyNode = ScriptNode | AliasNode | TriggerNode | TimerNode | KeyNode | ButtonNode;

const EDIT_CATEGORIES: EditCategory[] = ['scripts', 'aliases', 'triggers', 'timers', 'keys', 'buttons'];

const CATEGORY_LABELS: Record<EditCategory, string> = {
    scripts: 'Scripts',
    aliases: 'Aliases',
    triggers: 'Triggers',
    timers: 'Timers',
    keys: 'Keys',
    buttons: 'Buttons',
};

const CATEGORY_SINGULAR: Record<EditCategory, string> = {
    scripts: 'Script',
    aliases: 'Alias',
    triggers: 'Trigger',
    timers: 'Timer',
    keys: 'Key',
    buttons: 'Button',
};

const BUTTON_GROUP_SINGULAR = 'Toolbar';

const CATEGORY_ICON: Record<EditCategory, React.ElementType> = {
    scripts:  FileCode2,
    aliases:  Shuffle,
    triggers: Zap,
    timers:   Clock,
    keys:     Keyboard,
    buttons:  MousePointerClick,
};

const BUTTON_LOCATIONS: ButtonLocation[] = ['top', 'bottom', 'left', 'right', 'floating'];
const BUTTON_ORIENTATIONS: ButtonOrientation[] = ['horizontal', 'vertical'];

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'Dead']);

function formatCode(code: string): string {
    if (!code) return '';
    if (code.startsWith('Key'))    return code.slice(3);
    if (code.startsWith('Digit'))  return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
    return code;
}

function formatKeyCombo(key: string, modifiers: string[]): string {
    if (!key) return '';
    const parts = [...modifiers.map(m => m[0].toUpperCase() + m.slice(1)), formatCode(key)];
    return parts.join('+');
}

function secsToHMSM(total: number) {
    const totalMs = Math.round(total * 1000);
    const ms = totalMs % 1000;
    const totalSecs = Math.floor(totalMs / 1000);
    const s = totalSecs % 60;
    const totalMins = Math.floor(totalSecs / 60);
    const m = totalMins % 60;
    const h = Math.floor(totalMins / 60);
    return { h, m, s, ms };
}

function isAncestorOf(ancestorId: string, itemId: string, items: AnyNode[]): boolean {
    const byId = new Map(items.map(i => [i.id, i]));
    let node = byId.get(itemId);
    while (node?.parentId) {
        if (node.parentId === ancestorId) return true;
        node = byId.get(node.parentId);
    }
    return false;
}

const ICON_SIZE = 13;
const ICON_STROKE = 1.6;

function ItemIcon({ category, isGroup, isExpanded, hasChildren = false }: { category: Category; isGroup: boolean; isExpanded: boolean; hasChildren?: boolean }) {
    if (isGroup) {
        const F = isExpanded ? FolderOpen : Folder;
        return <F size={ICON_SIZE} strokeWidth={ICON_STROKE} className="script-editor__item-icon script-editor__item-icon--folder" />;
    }
    const props = { size: ICON_SIZE, strokeWidth: ICON_STROKE, className: 'script-editor__item-icon' };
    // Mudlet shows a funnel on a leaf trigger that holds nested child triggers
    // — the visual cue that it acts as a chain head, not just a one-off match.
    if (category === 'triggers' && hasChildren) {
        return <Filter {...props} className="script-editor__item-icon script-editor__item-icon--chainhead" />;
    }
    switch (category) {
        case 'scripts':  return <FileCode2          {...props} />;
        case 'aliases':  return <Shuffle            {...props} />;
        case 'triggers': return <Zap                {...props} />;
        case 'timers':   return <Clock              {...props} />;
        case 'keys':     return <Keyboard           {...props} />;
        case 'buttons':  return <MousePointerClick  {...props} />;
        default:         return null;
    }
}

/** Build a flat, ordered render list from a tree stored as a flat array.
 *  Any node with children is expandable — Mudlet allows leaf triggers to act
 *  as chain heads with descendants, so descent isn't gated on isGroup. */
function flattenTree<T extends { id: string; parentId: string | null; isGroup: boolean }>(
    items: T[],
    parentId: string | null,
    expanded: Set<string>,
    depth = 0,
): Array<{ item: T; depth: number }> {
    const result: Array<{ item: T; depth: number }> = [];
    for (const item of items.filter(i => i.parentId === parentId)) {
        result.push({ item, depth });
        const hasChildren = items.some(i => i.parentId === item.id);
        if (hasChildren && expanded.has(item.id)) {
            result.push(...flattenTree(items, item.id, expanded, depth + 1));
        }
    }
    return result;
}

const EMPTY: never[] = [];

const PATTERN_TYPE_LABELS: Record<TriggerPatternType, string> = {
    substring:    'substring',
    regex:        'perl regex',
    startOfLine:  'start of line',
    exactMatch:   'exact match',
    luaFunction:  'lua function',
    lineSpacer:   'line spacer',
    colorTrigger: 'color trigger',
    prompt:       'prompt',
};

const PATTERN_TYPE_COLORS: Record<TriggerPatternType, string> = {
    substring:    '#000000',
    regex:        '#0000ff',
    startOfLine:  '#ff0000',
    exactMatch:   '#00ff00',
    luaFunction:  '#00ffff',
    lineSpacer:   '#ff00ff',
    colorTrigger: '#c0c0c0',
    prompt:       '#ffff00',
};

const PATTERN_NEEDS_TEXT = new Set<TriggerPatternType>(['substring', 'regex', 'startOfLine', 'exactMatch', 'luaFunction']);

/** The `text` a pattern row should carry after its type changes.
 *
 *  `colorTrigger` stores `"fg,bg"` and `lineSpacer` stores a line count, so
 *  neither can inherit a regex left over from the previous type — and a regex
 *  must not inherit `"-1,-1"` or `"2"` either. Mudlet gets this for free by
 *  giving each type its own widget (`dlgTriggerEditor.cpp:7196-7239`); here one
 *  `text` field is shared, so it is reset explicitly whenever the type crosses
 *  into or out of one of the two structured kinds. */
export function retypePatternText(text: string, from: TriggerPatternType, to: TriggerPatternType): string {
    if (from === to) return text;
    const structured = (t: TriggerPatternType) => t === 'colorTrigger' || t === 'lineSpacer';
    if (!structured(from) && !structured(to)) return text;
    if (to === 'colorTrigger') return '-1,-1';
    // Mudlet's spin box defaults to 0 (QSpinBox's default value).
    if (to === 'lineSpacer') return '0';
    return '';
}

/** Names for the 16 basic ANSI palette entries the colour picker shows by
 *  default. Indices 16..255 (the xterm 6×6×6 cube + 24-step greyscale) are
 *  available via the "more…" expander, but the named row covers the colours
 *  most MUD-side colour triggers actually target. */
const ANSI_NAMES_16: ReadonlyArray<string> = [
    'black', 'maroon', 'green', 'olive', 'navy', 'purple', 'teal', 'silver',
    'gray', 'red', 'lime', 'yellow', 'blue', 'fuchsia', 'cyan', 'white',
];

/** Parse a `"fg,bg"` colour-trigger pattern text into a `[fg, bg]` pair. Both
 *  default to -1 ("any") when missing or non-numeric. Mirrors the parser in
 *  TriggerEngine. */
function parseColorPattern(text: string): [number, number] {
    const parts = text.split(',').map(s => s.trim());
    const parse = (s: string | undefined): number => {
        if (s === undefined || s === '') return -1;
        const n = Number(s);
        return Number.isFinite(n) ? Math.trunc(n) : -1;
    };
    return [parse(parts[0]), parse(parts[1])];
}

function formatColorPattern(fg: number, bg: number): string {
    return `${fg},${bg}`;
}

function colorPickerLabel(index: number): string {
    if (index < 0) return 'any';
    if (index < ANSI_NAMES_16.length) return ANSI_NAMES_16[index];
    return `#${index}`;
}

const ICON_MIME: Record<string, string> = {
    png:  'image/png',
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
    gif:  'image/gif',
    webp: 'image/webp',
    svg:  'image/svg+xml',
    bmp:  'image/bmp',
    ico:  'image/x-icon',
};

function PackageDescription({ text }: { text: string }) {
    const [expanded, setExpanded] = useState(false);
    const [overflows, setOverflows] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const html = useMemo(() => renderMarkdown(text), [text]);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        setOverflows(el.scrollHeight > el.clientHeight + 1);
    }, [html]);

    return (
        <div className="script-editor__pkg-desc-wrap">
            <div
                ref={ref}
                className={`script-editor__pkg-desc${expanded ? ' script-editor__pkg-desc--expanded' : ''}`}
                // renderMarkdown sanitizes via DOMPurify.
                dangerouslySetInnerHTML={{ __html: html }}
            />
            {(overflows || expanded) && (
                <button
                    className="script-editor__pkg-desc-toggle"
                    onClick={() => setExpanded(e => !e)}
                >
                    {expanded ? 'Show less' : 'Show more'}
                </button>
            )}
        </div>
    );
}

function PackageIcon({ vfs, pkg }: { vfs: ProfileVFS | null; pkg: PackageManifest }) {
    const [url, setUrl] = useState<string | null>(null);

    useEffect(() => {
        if (!vfs || !pkg.icon) { setUrl(null); return; }
        const pkgDir = `${vfs.profilePath}/${pkg.name}`;
        // Mudlet stores package icons at <pkgDir>/.mudlet/Icon/<icon>; fall back to <pkgDir>/<icon>.
        const candidates = [`${pkgDir}/.mudlet/Icon/${pkg.icon}`, `${pkgDir}/${pkg.icon}`];
        const path = candidates.find(p => vfs.exists(p));
        if (!path) { setUrl(null); return; }
        let revoke: string | null = null;
        try {
            const bytes = vfs.readBinaryFile(path);
            const ext = pkg.icon.split('.').pop()?.toLowerCase() ?? '';
            const mime = ICON_MIME[ext] ?? 'application/octet-stream';
            const blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
            revoke = blobUrl;
            setUrl(blobUrl);
        } catch {
            setUrl(null);
        }
        return () => { if (revoke) URL.revokeObjectURL(revoke); };
    }, [vfs, pkg.name, pkg.icon]);

    return (
        <div className={`script-editor__pkg-icon-frame${url ? ' script-editor__pkg-icon-frame--has-icon' : ''}`}>
            {url
                ? <img className="script-editor__pkg-icon-img" src={url} alt="" />
                : <Package className="script-editor__pkg-icon-fallback" size={28} strokeWidth={1.4} />}
        </div>
    );
}

function PatternTypeSelect({ value, onChange }: { value: TriggerPatternType; onChange: (t: TriggerPatternType) => void }) {
    const [open, setOpen] = useState(false);
    const [pos, setPos]   = useState({ x: 0, y: 0 });
    const btnRef          = useRef<HTMLButtonElement>(null);

    const toggle = () => {
        if (!open && btnRef.current) {
            const r = btnRef.current.getBoundingClientRect();
            setPos({ x: r.left, y: r.bottom + 2 });
        }
        setOpen(v => !v);
    };

    return (
        <>
            <button
                ref={btnRef}
                type="button"
                className="script-editor__pattern-type-btn"
                onClick={toggle}
            >
                <span className="script-editor__pattern-type-swatch" style={{ background: PATTERN_TYPE_COLORS[value] }} />
                <span className="script-editor__pattern-type-label">{PATTERN_TYPE_LABELS[value]}</span>
                <span className="script-editor__pattern-type-arrow">▾</span>
            </button>
            {open && (
                <ContextMenu x={pos.x} y={pos.y} onClose={() => setOpen(false)}>
                    {(Object.entries(PATTERN_TYPE_LABELS) as [TriggerPatternType, string][]).map(([t, label]) => (
                        <button
                            key={t}
                            type="button"
                            className={`ctx-menu__item script-editor__pattern-type-option${t === value ? ' script-editor__pattern-type-option--active' : ''}`}
                            onClick={() => { onChange(t); setOpen(false); }}
                        >
                            <span className="script-editor__pattern-type-swatch" style={{ background: PATTERN_TYPE_COLORS[t] }} />
                            {label}
                        </button>
                    ))}
                </ContextMenu>
            )}
        </>
    );
}

/** xterm 256-colour cube laid out in numerical order, 36 indices per row.
 *  Because `index = 16 + r*36 + g*6 + b`, 36 contiguous values share the
 *  same red component — so row 0 is the "no red" slice (16..51, varies
 *  green×blue), row 1 the next red step (52..87), …, row 5 the max-red
 *  slice (196..231). The result reads top→bottom as a smooth red ramp
 *  while every cell sits at a predictable numerical offset. */
const XTERM_CUBE_ROWS: number[][] = (() => {
    const rows: number[][] = [];
    for (let r = 0; r < 6; r++) {
        const start = 16 + r * 36;
        rows.push(Array.from({ length: 36 }, (_, i) => start + i));
    }
    return rows;
})();

/** Greyscale ramp indices 232..255 — the bottom 24-step grey strip in the
 *  xterm 256-colour palette. Already left-to-right dark→light. */
const XTERM_GREYS: number[] = Array.from({ length: 24 }, (_, i) => 232 + i);

/** Approximate contrast helper: white text on indices where the perceptual
 *  luma is low, black otherwise. Used so the index labels on the cube grid
 *  stay readable against arbitrary backgrounds. */
function luma(hex: string): number {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return 0.5;
    const r = parseInt(m[1], 16) / 255;
    const g = parseInt(m[2], 16) / 255;
    const b = parseInt(m[3], 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Full xterm 256-colour picker for a single channel (FG or BG) of a
 * `colorTrigger` pattern. The popover surfaces:
 *   - the "any" sentinel (-1 in pattern.text)
 *   - the 16 named ANSI colours (indices 0..15)
 *   - the 6×6×6 colour cube (indices 16..231) laid out as 6 rows of 36
 *     cells with index labels readable against each background
 *   - the 24-step greyscale ramp (indices 232..255)
 *   - a number-entry input synced bidirectionally with the live selection
 *
 * Clicking any cell commits and closes; the popover clamps to stay on-screen
 * when its natural anchor would overflow the viewport.
 */
function ColorChannelPicker({
    label, value, onChange,
}: {
    label: string;
    value: number;
    onChange: (next: number) => void;
}) {
    const [open, setOpen] = useState(false);
    const [pos, setPos]   = useState({ x: 0, y: 0 });
    const [customInput, setCustomInput] = useState('');
    const btnRef         = useRef<HTMLButtonElement>(null);

    // Per-profile ANSI palette overrides (Settings → Colors). Only indices
    // 0..15 are overridable; the xterm cube and greyscale ramp keep their
    // hardcoded values. Resolved at render so a settings tweak re-paints the
    // picker immediately. Pattern matching at runtime still keys on the
    // palette *index* (not RGB), so changing a colour in Settings doesn't
    // change which lines a colour trigger fires on — just how its swatch
    // looks here.
    const ansiPalette = useProfileField('ansiPalette');
    const HEX_RE = /^#[0-9a-f]{6}$/i;
    const paletteColor = (index: number): string => {
        if (index < 0 || index >= xterm256.length) return 'transparent';
        if (index < 16) {
            const override = ansiPalette?.[index];
            if (typeof override === 'string' && HEX_RE.test(override)) return override;
            return DEFAULT_ANSI_PALETTE[index] ?? xterm256[index];
        }
        return xterm256[index];
    };

    // Picker is wide; anchor underneath the button but clamp inside the
    // viewport so it doesn't disappear off-screen for buttons near the right
    // edge of the script editor.
    const POPOVER_WIDTH = 880;
    const POPOVER_HEIGHT = 420;

    const toggle = () => {
        if (!open && btnRef.current) {
            const r = btnRef.current.getBoundingClientRect();
            const margin = 8;
            const maxX = window.innerWidth - POPOVER_WIDTH - margin;
            const x = Math.max(margin, Math.min(r.left, maxX));
            const wantY = r.bottom + 2;
            const maxY = window.innerHeight - POPOVER_HEIGHT - margin;
            const y = wantY > maxY ? Math.max(margin, r.top - POPOVER_HEIGHT - 2) : wantY;
            setPos({ x, y });
            setCustomInput(value >= 0 ? String(value) : '');
        }
        setOpen(v => !v);
    };

    const swatchBg = value < 0 ? 'transparent' : paletteColor(value);
    const indicator = value < 0 ? '∅' : '';

    const commit = (n: number) => { onChange(n); setOpen(false); };

    const applyCustom = () => {
        const trimmed = customInput.trim();
        if (trimmed === '') return;
        const n = Math.trunc(Number(trimmed));
        if (Number.isFinite(n) && n >= 0 && n <= 255) commit(n);
    };

    // Sync the number input when the user clicks a swatch — keeps the
    // numeric field in step with the visual selection if the picker stays
    // open across multiple picks (it currently closes on commit, but this
    // future-proofs against changing that).
    useEffect(() => {
        if (open) setCustomInput(value >= 0 ? String(value) : '');
    }, [value, open]);

    return (
        <>
            <button
                ref={btnRef}
                type="button"
                className="script-editor__pattern-color-btn"
                onClick={toggle}
                title={`${label}: ${colorPickerLabel(value)}`}
            >
                <span className="script-editor__pattern-color-label">{label}</span>
                <span
                    className="script-editor__pattern-color-swatch"
                    style={{ background: swatchBg }}
                >{indicator}</span>
                <span className="script-editor__pattern-color-name">{colorPickerLabel(value)}</span>
            </button>
            {open && (
                <ContextMenu x={pos.x} y={pos.y} onClose={() => setOpen(false)}>
                    <div className="script-editor__color-picker">
                        <div className="script-editor__color-picker-header">
                            <span className="script-editor__color-picker-title">
                                {label === 'FG' ? 'Foreground' : 'Background'}
                            </span>
                            <span className="script-editor__color-picker-current">
                                <span
                                    className="script-editor__color-picker-current-swatch"
                                    style={{ background: swatchBg }}
                                >{indicator}</span>
                                <span>{colorPickerLabel(value)}</span>
                                {value >= 0 && (
                                    <span className="script-editor__color-picker-hex">{paletteColor(value)}</span>
                                )}
                            </span>
                        </div>

                        <button
                            type="button"
                            className={`script-editor__color-picker-any${value < 0 ? ' script-editor__color-picker-any--active' : ''}`}
                            onClick={() => commit(-1)}
                            title="match any colour (Mudlet -1)"
                        >∅ Any colour</button>

                        <div className="script-editor__color-picker-section-label">ANSI 16</div>
                        <div className="script-editor__color-picker-ansi-row">
                            {ANSI_NAMES_16.map((name, idx) => {
                                const hex = paletteColor(idx);
                                return (
                                <button
                                    key={idx}
                                    type="button"
                                    className={`script-editor__color-picker-ansi-cell${value === idx ? ' script-editor__color-picker-cell--active' : ''}`}
                                    style={{ background: hex, color: luma(hex) > 0.55 ? '#000' : '#fff' }}
                                    onClick={() => commit(idx)}
                                    title={`${idx} — ${name} (${hex})`}
                                >{idx}</button>
                                );
                            })}
                        </div>

                        <div className="script-editor__color-picker-section-label">6×6×6 cube (16-231)</div>
                        <div className="script-editor__color-picker-cube">
                            {XTERM_CUBE_ROWS.map((row, ri) => (
                                <div key={ri} className="script-editor__color-picker-cube-row">
                                    {row.map(idx => (
                                        <button
                                            key={idx}
                                            type="button"
                                            className={`script-editor__color-picker-cube-cell${value === idx ? ' script-editor__color-picker-cell--active' : ''}`}
                                            style={{ background: xterm256[idx], color: luma(xterm256[idx]) > 0.55 ? '#000' : '#fff' }}
                                            onClick={() => commit(idx)}
                                            title={`${idx} — ${xterm256[idx]}`}
                                        >{idx}</button>
                                    ))}
                                </div>
                            ))}
                        </div>

                        <div className="script-editor__color-picker-section-label">Greyscale (232-255)</div>
                        <div className="script-editor__color-picker-grey-row">
                            {XTERM_GREYS.map(idx => (
                                <button
                                    key={idx}
                                    type="button"
                                    className={`script-editor__color-picker-grey-cell${value === idx ? ' script-editor__color-picker-cell--active' : ''}`}
                                    style={{ background: xterm256[idx], color: luma(xterm256[idx]) > 0.55 ? '#000' : '#fff' }}
                                    onClick={() => commit(idx)}
                                    title={`${idx} — ${xterm256[idx]}`}
                                >{idx}</button>
                            ))}
                        </div>

                        <div className="script-editor__color-picker-custom">
                            <span>Index:</span>
                            <input
                                type="number"
                                min={0}
                                max={255}
                                value={customInput}
                                onChange={e => setCustomInput(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        applyCustom();
                                    }
                                }}
                                placeholder="0-255"
                            />
                            <button
                                type="button"
                                className="script-editor__color-picker-apply"
                                onClick={applyCustom}
                            >Apply</button>
                            {customInput !== '' && Number.isFinite(Number(customInput)) && Number(customInput) >= 0 && Number(customInput) <= 255 && (
                                <span
                                    className="script-editor__color-picker-preview"
                                    style={{ background: paletteColor(Math.trunc(Number(customInput))) }}
                                    title="preview"
                                />
                            )}
                        </div>
                    </div>
                </ContextMenu>
            )}
        </>
    );
}

const DEFAULT_LUA = `-- Mudlet-compatible Lua script
-- Core:
--   send(text)                              send a command to the MUD
--   sendAll(cmd1, cmd2, ...)                send multiple commands
--   echo(text) / echo(window, text)         plain output
--   cecho("<green>text<r>")                 named-color output (Mudlet color tags)
--   decho("<0,255,0>text<r>")               decimal RGB output
--   hecho("#00ff00text#r")                  hex RGB output
-- Timers:
--   id = tempTimer(seconds, fn)             one-shot timer
--   id = tempTimer(seconds, fn, true)       repeating timer
--   killTimer(id)
-- Aliases:
--   id = tempAlias(pattern, fn)             fn receives: matches[1]=full, matches[2..]=captures
--   killAlias(id)
-- Triggers:
--   id = tempTrigger(pattern, fn)           fn receives: matches[1]=full, matches[2..]=captures
--   killTrigger(id)
-- Events:
--   id = registerAnonymousEventHandler(event, fn)
--   killAnonymousEventHandler(id)
--   raiseEvent(name, ...)
-- Windows:
--   openUserWindow(name)                    open a text panel
--   clearWindow(name)
--   setUserWindowTitle(name, title)
-- GMCP:
--   gmcp.Module.SubKey                      auto-populated from server packets

registerAnonymousEventHandler("sysConnectionEvent", function()
    echo("Connected!\\n")
end)
`;

interface LogEntry {
    text: string;
    level: 'error' | 'info';
    timestamp: Date;
    source?: ScriptLogSource;
}

const KIND_TO_CATEGORY: Record<ScriptLogSourceKind, EditCategory> = {
    script:  'scripts',
    alias:   'aliases',
    trigger: 'triggers',
    timer:   'timers',
    key:     'keys',
    button:  'buttons',
};

const CATEGORY_TO_KIND: Record<EditCategory, ScriptLogSourceKind> = {
    scripts:  'script',
    aliases:  'alias',
    triggers: 'trigger',
    timers:   'timer',
    keys:     'key',
    buttons:  'button',
};

function formatTime(d: Date): string {
    return d.toTimeString().slice(0, 8);
}

// Matches Lua-error path tokens like `arkadia/skrypty/config/scripts_config.lua:107`
// or `/profiles/<id>/foo.lua:42`. Allows /, ., _, -, alnum in path segments.
// (?<=[\s\[(:'"`]|^) anchors the start so we don't mid-word-match.
const VFS_PATH_RE = /(?<=^|[\s\[(:'"`])((?:\/[\w.-]+)*[\w.-]+(?:\/[\w.-]+)+\.lua)(?::(\d+))?/g;

// Split an error-log entry's text into renderable segments, turning every
// substring that matches a VFS-resolvable .lua path into a clickable token.
// Returns plain strings for non-matching segments and { path, line } objects
// for matches. The caller resolves the path against the VFS at click time.
function segmentLogText(
    text: string,
    canOpen: (relOrAbs: string) => boolean,
): Array<string | { match: string; path: string; line?: number }> {
    const out: Array<string | { match: string; path: string; line?: number }> = [];
    let cursor = 0;
    VFS_PATH_RE.lastIndex = 0;
    for (let m = VFS_PATH_RE.exec(text); m; m = VFS_PATH_RE.exec(text)) {
        const [whole, path, lineStr] = m;
        if (!canOpen(path)) continue;
        if (m.index > cursor) out.push(text.substring(cursor, m.index));
        out.push({
            match: whole,
            path,
            ...(lineStr ? { line: parseInt(lineStr, 10) } : {}),
        });
        cursor = m.index + whole.length;
    }
    if (cursor < text.length) out.push(text.substring(cursor));
    return out.length > 0 ? out : [text];
}

/** config.lua's `created` field is free-form; render as a localized date when parseable, raw otherwise. */
function formatPackageDate(raw: string): string {
    const t = Date.parse(raw);
    if (isNaN(t)) return raw;
    return new Date(t).toLocaleDateString();
}

interface ScriptEditorPanelProps {
    connectionId: string;
    session: MudSession;
    vfs: ProfileVFS | null;
    scriptingEngineRef?: React.RefObject<ScriptingEngine | null>;
    initialListWidth?: number;
    onSplitsChange?: (listWidth: number) => void;
    onOpenVfsFile?: (path: string, line?: number) => void;
}

/** Imperative API exposed to the title-bar search box. */
export interface ScriptEditorPanelHandle {
    /** Switch to the item's category, expand its ancestors, select it, and —
     *  when a line is given — move the editor cursor there. */
    navigateToItem: (category: EditCategory, id: string, line?: number) => void;
}

export const ScriptEditorPanel = forwardRef<ScriptEditorPanelHandle, ScriptEditorPanelProps>(function ScriptEditorPanel({ connectionId, session, vfs, scriptingEngineRef, initialListWidth, onSplitsChange, onOpenVfsFile }, ref) {
    const confirm = useConfirm();
    const [category, setCategory] = useState<Category>('scripts');
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const scripts     = useAppStore(s => s.connectionScripts[connectionId] ?? EMPTY);
    const aliases     = useAppStore(s => s.connectionAliases[connectionId] ?? EMPTY);
    const triggers    = useAppStore(s => s.connectionTriggers[connectionId] ?? EMPTY);
    const timers      = useAppStore(s => s.connectionTimers[connectionId] ?? EMPTY);
    const keybindings = useAppStore(s => s.connectionKeybindings[connectionId] ?? EMPTY);
    const buttons     = useAppStore(s => s.connectionButtons[connectionId] ?? EMPTY);

    const addScript        = useAppStore(s => s.addScript);
    const updateScript     = useAppStore(s => s.updateScript);
    const removeScript     = useAppStore(s => s.removeScript);
    const moveScript       = useAppStore(s => s.moveScript);
    const addAlias         = useAppStore(s => s.addAlias);
    const updateAlias      = useAppStore(s => s.updateAlias);
    const removeAlias      = useAppStore(s => s.removeAlias);
    const moveAlias        = useAppStore(s => s.moveAlias);
    const addTrigger       = useAppStore(s => s.addTrigger);
    const updateTrigger    = useAppStore(s => s.updateTrigger);
    const removeTrigger    = useAppStore(s => s.removeTrigger);
    const moveTrigger      = useAppStore(s => s.moveTrigger);
    const addTimer         = useAppStore(s => s.addTimer);
    const updateTimer      = useAppStore(s => s.updateTimer);
    const removeTimer      = useAppStore(s => s.removeTimer);
    const moveTimer        = useAppStore(s => s.moveTimer);
    const addKeybinding    = useAppStore(s => s.addKeybinding);
    const updateKeybinding = useAppStore(s => s.updateKeybinding);
    const removeKeybinding = useAppStore(s => s.removeKeybinding);
    const moveKeybinding   = useAppStore(s => s.moveKeybinding);
    const addButton        = useAppStore(s => s.addButton);
    const updateButton     = useAppStore(s => s.updateButton);
    const removeButton     = useAppStore(s => s.removeButton);
    const moveButton       = useAppStore(s => s.moveButton);
    const packages         = useAppStore(s => s.connectionPackages[connectionId] ?? EMPTY);
    const installPackage   = useAppStore(s => s.installPackage);
    const uninstallPackage = useAppStore(s => s.uninstallPackage);

    const [importError, setImportError] = useState<string | null>(null);
    const [showRepository, setShowRepository] = useState(false);
    const [showExport, setShowExport] = useState(false);
    /** Set when the exporter is opened from a right-click in the tree: that item
     *  and its subtree start out checked, as in Mudlet. */
    const [exportPreselect, setExportPreselect] = useState<{ category: ExportCategory; id: string } | null>(null);
    const updatePackageManifest = useAppStore(s => s.updatePackageManifest);
    // Read fresh on every install so live edits to the proxy URL take effect.
    const proxyUrlGetter = useCallback(() => {
        const state = useAppStore.getState();
        const c = state.connections.find(x => x.id === connectionId);
        return c?.proxyUrl?.trim() || state.client.userProxyUrl || DEFAULT_PROXY_URL;
    }, [connectionId]);

    const importAs = useCallback(async (file: File, kind: 'package' | 'module', sourcePath?: string) => {
        if (!vfs) {
            setImportError('VFS not ready — wait for the profile to finish loading');
            return;
        }
        try {
            const { manifest, data } = await installPackageFromFile(file, vfs, { kind, ...(sourcePath ? { sourcePath } : {}) });
            // installPackage commits the new scripts to the store; the
            // engine's store subscription synchronously loads them into Lua
            // before this call returns. By the time notifyPackageInstalled
            // raises sysInstallPackage, all handlers are already registered.
            installPackage(connectionId, manifest, data);
            scriptingEngineRef?.current?.notifyPackageInstalled(manifest.name);
            const total = data.scripts.length + data.aliases.length + data.triggers.length + data.timers.length + data.keys.length;
            setImportError(null);
            const label = kind === 'module' ? 'module' : 'package';
            const now = new Date();
            const newEntries: LogEntry[] = [{ text: `Installed ${label} "${manifest.name}" (${total} items) from ${file.name}`, level: 'info', timestamp: now }];
            for (const w of data.warnings) newEntries.push({ text: `Warning: ${w}`, level: 'error', timestamp: now });
            setLogs(prev => [...prev, ...newEntries]);
            setErrorLog(prev => [...prev, ...newEntries]);
            const warnCount = data.warnings.length;
            if (warnCount > 0) setUnreadErrors(prev => prev + warnCount);
        } catch (err) {
            setImportError(err instanceof Error ? err.message : String(err));
        }
    }, [connectionId, installPackage, scriptingEngineRef, vfs]);

    const handleInstallFromRepository = useCallback(async (entry: PackageRepoEntry, bytes: Uint8Array) => {
        if (!vfs) throw new Error('VFS not ready — wait for the profile to finish loading');
        // Re-use the existing install pipeline so repository installs land in the
        // same store state and emit the same sysInstallPackage event as a file import.
        const { manifest, data } = installPackageFromBytes(entry.filename, bytes, vfs);
        await vfs.flush();
        installPackage(connectionId, manifest, data);
        scriptingEngineRef?.current?.notifyPackageInstalled(manifest.name);
        const total = data.scripts.length + data.aliases.length + data.triggers.length + data.timers.length + data.keys.length;
        const now = new Date();
        const newEntries: LogEntry[] = [{ text: `Installed package "${manifest.name}" (${total} items) from Mudlet repository`, level: 'info', timestamp: now }];
        for (const w of data.warnings) newEntries.push({ text: `Warning: ${w}`, level: 'error', timestamp: now });
        setLogs(prev => [...prev, ...newEntries]);
        setErrorLog(prev => [...prev, ...newEntries]);
        if (data.warnings.length > 0) setUnreadErrors(prev => prev + data.warnings.length);
    }, [connectionId, installPackage, scriptingEngineRef, vfs]);

    const handleImportFile = useCallback(async (picked: PickedFile[]) => {
        const first = picked[0];
        if (!first) return;
        // A VFS pick carries its path so the installer can tell that the archive
        // already lives inside the package dir it is about to unpack into.
        await importAs(first.file, 'package', first.vfsPath);
    }, [importAs]);

    const handleImportModuleFromVfs = useCallback((absolutePath: string) => {
        if (!vfs) {
            setImportError('VFS not ready — wait for the profile to finish loading');
            return;
        }
        try {
            const { manifest, data } = installModuleFromVfsPath(absolutePath, vfs);
            installPackage(connectionId, manifest, data);
            scriptingEngineRef?.current?.notifyPackageInstalled(manifest.name);
            void vfs.flush();
            const total = data.scripts.length + data.aliases.length + data.triggers.length + data.timers.length + data.keys.length;
            setImportError(null);
            const now = new Date();
            const newEntries: LogEntry[] = [{ text: `Installed module "${manifest.name}" (${total} items) from VFS path ${absolutePath}`, level: 'info', timestamp: now }];
            for (const w of data.warnings) newEntries.push({ text: `Warning: ${w}`, level: 'error', timestamp: now });
            setLogs(prev => [...prev, ...newEntries]);
            setErrorLog(prev => [...prev, ...newEntries]);
            const warnCount = data.warnings.length;
            if (warnCount > 0) setUnreadErrors(prev => prev + warnCount);
        } catch (err) {
            setImportError(err instanceof Error ? err.message : String(err));
        }
    }, [connectionId, installPackage, scriptingEngineRef, vfs]);

    /** Modules picked from the profile are referenced in place (a plain XML stays
     *  the source of truth at the path the user chose); an upload from the
     *  computer has to be copied into the VFS first. */
    const handleImportModulePick = useCallback(async (picked: PickedFile[]) => {
        const first = picked[0];
        if (!first) return;
        if (first.vfsPath) handleImportModuleFromVfs(first.vfsPath);
        else await importAs(first.file, 'module');
    }, [handleImportModuleFromVfs, importAs]);

    const handleSyncModule = useCallback(async (moduleName: string) => {
        const engine = scriptingEngineRef?.current;
        if (!engine) return;
        try {
            await engine.syncModuleToFile(moduleName);
            const now = new Date();
            setLogs(prev => [...prev, { text: `Synced module "${moduleName}" to file`, level: 'info', timestamp: now }]);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setLogs(prev => [...prev, { text: `Sync failed for "${moduleName}": ${msg}`, level: 'error', timestamp: new Date() }]);
        }
    }, [scriptingEngineRef]);

    const handleReloadModule = useCallback((moduleName: string) => {
        const engine = scriptingEngineRef?.current;
        if (!engine) return;
        const ok = engine.reloadModuleFromFile(moduleName);
        const now = new Date();
        setLogs(prev => [...prev, { text: ok ? `Reloaded module "${moduleName}" from file` : `Reload failed for "${moduleName}"`, level: ok ? 'info' : 'error', timestamp: now }]);
    }, [scriptingEngineRef]);

    const handleToggleModuleSync = useCallback((moduleName: string, sync: boolean) => {
        updatePackageManifest(connectionId, moduleName, { sync });
    }, [connectionId, updatePackageManifest]);

    const handleUninstall = useCallback(async (packageName: string) => {
        // Capture the manifest before the store mutation — modules unlink without
        // touching disk, so we need the kind flag to make that decision after the
        // store entry is gone.
        const manifest = packages.find(p => p.name === packageName);
        // Raise sysUninstall/sysUninstallPackage before removing the
        // package's items from the store so the package's own handlers can
        // still run during cleanup.
        scriptingEngineRef?.current?.notifyPackageUninstalled(packageName);
        uninstallPackage(connectionId, packageName);
        if (vfs && manifest) {
            try { await uninstallPackageFiles(manifest, vfs); }
            catch (err) { console.warn('[ScriptEditor] failed to remove package files:', err); }
        }
        const now = new Date();
        const label = manifest?.kind === 'module' ? 'module' : 'package';
        setLogs(prev => [...prev, { text: `Uninstalled ${label} "${packageName}"`, level: 'info', timestamp: now }]);
    }, [connectionId, scriptingEngineRef, uninstallPackage, vfs]);

    const [selectedId, setSelectedId] = useState<string | null>(null);

    // Common edit state
    const [editName, setEditName]     = useState('');
    const [editCode, setEditCode]     = useState('');
    // Alias extra
    const [editPattern, setEditPattern]   = useState('');
    const [editCommand, setEditCommand]   = useState('');
    // Trigger extra
    const [editPatterns, setEditPatterns] = useState<TriggerPattern[]>([]);
    const [editFireLength, setEditFireLength] = useState(0);
    const [editMultipleMatches, setEditMultipleMatches] = useState(false);
    const [editMultiline, setEditMultiline] = useState(false);
    const [editDelta, setEditDelta] = useState(0);
    const [editIsFilter, setEditIsFilter] = useState(false);
    const [editHighlightFg, setEditHighlightFg] = useState('');
    const [editHighlightBg, setEditHighlightBg] = useState('');
    const [editTriggerCommand, setEditTriggerCommand] = useState('');
    // Timer extra
    const [editHours,   setEditHours]   = useState(0);
    const [editMinutes, setEditMinutes] = useState(1);
    const [editSecs,    setEditSecs]    = useState(0);
    const [editMs,      setEditMs]      = useState(0);
    const [editRepeat, setEditRepeat]   = useState(true);
    // Key extra
    const [editKey, setEditKey]               = useState('');
    const [editModifiers, setEditModifiers]   = useState<string[]>([]);
    const [capturing, setCapturing]           = useState(false);
    const [editKeyCommand, setEditKeyCommand] = useState('');
    // Timer extra (command)
    const [editTimerCommand, setEditTimerCommand] = useState('');
    // Script extra: event handlers (newline-separated)
    const [editEventHandlers, setEditEventHandlers] = useState('');
    // Button extra
    const [editButtonCommand,     setEditButtonCommand]     = useState('');
    const [editButtonCommandDown, setEditButtonCommandDown] = useState('');
    const [editButtonIcon,        setEditButtonIcon]        = useState('');
    const [editButtonTooltip,     setEditButtonTooltip]     = useState('');
    const [editButtonIsPushDown,  setEditButtonIsPushDown]  = useState(false);
    const [editButtonStyleSheet,  setEditButtonStyleSheet]  = useState('');
    // Toolbar (button group) extra
    const [editToolbarLocation,    setEditToolbarLocation]    = useState<ButtonLocation>('top');
    const [editToolbarOrientation, setEditToolbarOrientation] = useState<ButtonOrientation>('horizontal');
    const [editToolbarColumns,     setEditToolbarColumns]     = useState(0);

    const [dirty, setDirty] = useState(false);
    // Backfill from the session-level buffer so entries that fired before this
    // panel was first mounted (e.g. errors during initial script load) survive.
    const [logs, setLogs] = useState<LogEntry[]>(() =>
        session.scriptLog.map(e => ({
            text: e.text, level: e.level, timestamp: new Date(e.timestamp),
            ...(e.source ? { source: e.source } : {}),
        })),
    );
    const [errorLog, setErrorLog] = useState<LogEntry[]>(() =>
        session.scriptLog
            .filter(e => e.level === 'error')
            .map(e => ({
                text: e.text, level: e.level, timestamp: new Date(e.timestamp),
                ...(e.source ? { source: e.source } : {}),
            })),
    );
    const [unreadErrors, setUnreadErrors] = useState(() =>
        session.scriptLog.reduce((n, e) => n + (e.level === 'error' ? 1 : 0), 0),
    );

    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; targetId: string | null } | null>(null);
    const logEndRef      = useRef<HTMLDivElement>(null);
    const errorLogEndRef = useRef<HTMLDivElement>(null);
    // Bumped on each error-row jump click. Carried into LuaEditor's `gotoLine`
    // prop and into a useEffect that performs the parent-tree expansion + scroll
    // — using a revision (rather than only `line`) makes repeated jumps to the
    // same row work, and decouples the request from the editor lifecycle.
    const [pendingJump, setPendingJump] = useState<{
        kind: ScriptLogSourceKind; id: string; line?: number; revision: number;
    } | null>(null);

    const [listWidth, setListWidth]     = useState(() => initialListWidth ?? 180);

    // Click handler for the "→" button on error log rows. Switches category if
    // needed (the [category] effect will clear selection; our jump effect below
    // re-applies it after the swap), expands ancestors so the row is visible,
    // and — if a line is known — moves the editor cursor to it via LuaEditor's
    // `gotoLine` prop. Bumping `revision` makes repeat clicks always re-trigger.
    const jumpRevisionRef = useRef(0);
    const handleErrorJump = useCallback((source: ScriptLogSource) => {
        jumpRevisionRef.current += 1;
        setPendingJump({
            kind: source.kind, id: source.id,
            ...(source.line !== undefined ? { line: source.line } : {}),
            revision: jumpRevisionRef.current,
        });
    }, []);

    const handleItemContextMenu = useCallback((e: React.MouseEvent, id: string) => {
        e.preventDefault();
        e.stopPropagation();
        setSelectedId(id);
        setCtxMenu({ x: e.clientX, y: e.clientY, targetId: id });
    }, []);

    const handlePaneContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY, targetId: null });
    }, []);

    const handleContextDelete = useCallback((id: string) => {
        if (category === 'scripts')        removeScript(connectionId, id);
        else if (category === 'aliases')   removeAlias(connectionId, id);
        else if (category === 'triggers')  removeTrigger(connectionId, id);
        else if (category === 'timers')    removeTimer(connectionId, id);
        else if (category === 'keys')      removeKeybinding(connectionId, id);
        else                               removeButton(connectionId, id);
        setSelectedId(prev => prev === id ? null : prev);
        setCtxMenu(null);
    }, [category, connectionId, removeScript, removeAlias, removeTrigger, removeTimer, removeKeybinding, removeButton]);

    // Drag-and-drop state
    const [dragId, setDragId]   = useState<string | null>(null);
    const [dragOver, setDragOver] = useState<{ id: string; intent: 'before' | 'into' | 'after' } | null>(null);

    const items: AnyNode[] =
        category === 'scripts'  ? scripts    :
        category === 'aliases'  ? aliases    :
        category === 'triggers' ? triggers   :
        category === 'timers'   ? timers     :
        category === 'keys'     ? keybindings:
        category === 'buttons'  ? buttons    :
        EMPTY;

    const treeEntries = flattenTree(items, null, expanded);
    const selected = items.find(i => i.id === selectedId) ?? null;

    // Navigation driven by the title-bar search box: reuse the error-jump
    // machinery to switch category, expand ancestors, select the item, and — for
    // a code occurrence — move the cursor to its line.
    useImperativeHandle(ref, () => ({
        navigateToItem: (cat: EditCategory, id: string, line?: number) => {
            jumpRevisionRef.current += 1;
            setPendingJump({
                kind: CATEGORY_TO_KIND[cat], id,
                ...(line !== undefined ? { line } : {}),
                revision: jumpRevisionRef.current,
            });
        },
    }), []);

    // The inline log under the editor is scoped to the currently opened item:
    // only entries whose source.id matches the selection are shown. The Errors
    // tab uses the separate `errorLog` buffer and is unaffected.
    const visibleLogs = useMemo(
        () => selectedId ? logs.filter(e => e.source?.id === selectedId) : [],
        [logs, selectedId],
    );

    // Stable identity prevents the LuaEditor's gotoLine effect from re-firing
    // (yanking the cursor) on every parent re-render — e.g. while the user is
    // typing in the editor and triggering setEditCode.
    const editorGotoLine = useMemo(
        () => (pendingJump && pendingJump.line !== undefined && pendingJump.id === selectedId
            ? { line: pendingJump.line, revision: pendingJump.revision }
            : null),
        [pendingJump, selectedId],
    );

    const childCounts = new Map<string, number>();
    for (const it of items) {
        if (it.parentId) childCounts.set(it.parentId, (childCounts.get(it.parentId) ?? 0) + 1);
    }

    useEffect(() => {
        setSelectedId(null);
        setCapturing(false);
        setDirty(false);
        setExpanded(new Set());
    }, [category]);

    // When a jump request comes in (error log click), switch category if needed,
    // expand all ancestor groups so the entity is visible in the tree, and
    // select it. Runs after the [category] effect above, so it re-applies the
    // selection that effect just cleared. Items can be empty during the swap
    // render — guarding on items.length avoids a no-op selection of a missing id.
    // lastAppliedJumpRevisionRef stops the effect from re-yanking the user back
    // when they navigate away after a jump: the effect depends on `category` and
    // `items`, so clicking a different tab would otherwise re-run and force the
    // category back to the jump target. Each jump bumps revision, so the user's
    // navigation re-runs of this effect see an already-applied revision and bail.
    const lastAppliedJumpRevisionRef = useRef(0);
    useEffect(() => {
        if (!pendingJump) return;
        if (pendingJump.revision === lastAppliedJumpRevisionRef.current) return;
        const targetCategory = KIND_TO_CATEGORY[pendingJump.kind];
        if (category !== targetCategory) {
            setCategory(targetCategory);
            return;
        }
        // Mark applied as soon as we land on the right category, even if the
        // target item turns out to be missing — otherwise a stale jump pointing
        // at a deleted item would still trap the user on this category.
        lastAppliedJumpRevisionRef.current = pendingJump.revision;
        if (items.length === 0) return;
        const byId = new Map(items.map(i => [i.id, i]));
        let cur = byId.get(pendingJump.id);
        if (!cur) return;
        const ancestorIds: string[] = [];
        while (cur?.parentId) {
            ancestorIds.push(cur.parentId);
            cur = byId.get(cur.parentId);
        }
        if (ancestorIds.length > 0) {
            setExpanded(prev => {
                const next = new Set(prev);
                for (const a of ancestorIds) next.add(a);
                return next;
            });
        }
        setSelectedId(pendingJump.id);
    }, [pendingJump, category, items]);

    useEffect(() => {
        if (!selected) return;
        setEditName(selected.name);
        // New unsaved scripts have code='' in the store; show the template so the
        // user has a starting point, and mark dirty so "Save & Run" is active.
        const isNewScript = category === 'scripts' && !selected.isGroup && selected.code === '';
        setEditCode(isNewScript ? DEFAULT_LUA : selected.code);
        if (category === 'aliases') {
            setEditPattern((selected as AliasNode).pattern ?? '');
            setEditCommand((selected as AliasNode).command ?? '');
        }
        if (category === 'triggers') {
            const t = selected as TriggerNode;
            setEditPatterns(t.patterns ?? []);
            setEditFireLength(t.fireLength ?? 0);
            setEditMultipleMatches(t.multipleMatches ?? false);
            setEditMultiline(t.multiline ?? false);
            setEditDelta(t.delta ?? 0);
            setEditIsFilter(t.isFilter ?? false);
            setEditHighlightFg(t.highlight?.fg ?? '');
            setEditHighlightBg(t.highlight?.bg ?? '');
            setEditTriggerCommand(t.command ?? '');
        }
        if (category === 'scripts') setEditEventHandlers((selected as ScriptNode).eventHandlers?.join('\n') ?? '');
        if (category === 'timers') {
            const t = selected as TimerNode;
            const { h, m, s, ms } = secsToHMSM(t.seconds);
            setEditHours(h);
            setEditMinutes(m);
            setEditSecs(s);
            setEditMs(ms);
            setEditRepeat(t.repeat);
            setEditTimerCommand(t.command ?? '');
        }
        if (category === 'keys') {
            const k = selected as KeyNode;
            setEditKey(k.key);
            setEditModifiers(k.modifiers);
            setEditKeyCommand(k.command ?? '');
        }
        if (category === 'buttons') {
            const b = selected as ButtonNode;
            setEditButtonCommand(b.command ?? '');
            setEditButtonCommandDown(b.commandDown ?? '');
            setEditButtonIcon(b.icon ?? '');
            setEditButtonTooltip(b.tooltip ?? '');
            setEditButtonIsPushDown(b.isPushDown);
            setEditButtonStyleSheet(b.styleSheet ?? '');
            setEditToolbarLocation(b.location);
            setEditToolbarOrientation(b.orientation);
            setEditToolbarColumns(b.columns ?? 0);
        }
        setCapturing(false);
        setDirty(isNewScript);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedId, category]);

    useEffect(() => {
        // Re-sync from the session buffer in case entries were appended between
        // the useState initializer and this effect running.
        setLogs(session.scriptLog.map(e => ({
            text: e.text, level: e.level, timestamp: new Date(e.timestamp),
            ...(e.source ? { source: e.source } : {}),
        })));
        setErrorLog(session.scriptLog
            .filter(e => e.level === 'error')
            .map(e => ({
                text: e.text, level: e.level, timestamp: new Date(e.timestamp),
                ...(e.source ? { source: e.source } : {}),
            })));

        let initialErrors = 0;
        for (const e of session.scriptLog) if (e.level === 'error') initialErrors++;
        setUnreadErrors(initialErrors);

        return session.events.on('script.log', (text, level, source) => {
            const entry: LogEntry = {
                text: text ?? '', level: level ?? 'info', timestamp: new Date(),
                ...(source ? { source } : {}),
            };
            setLogs(prev => [...prev, entry]);
            setErrorLog(prev => [...prev, entry]);
            if (level === 'error') setUnreadErrors(prev => prev + 1);
        });
    }, [session, connectionId]);

    // Clear unread badge when visiting the Errors tab
    useEffect(() => {
        if (category === 'errors') setUnreadErrors(0);
    }, [category]);

    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: 'instant' });
    }, [visibleLogs]);

    useEffect(() => {
        errorLogEndRef.current?.scrollIntoView({ behavior: 'instant' });
    }, [errorLog]);

    useEffect(() => {
        if (!capturing) return;
        const onKeyDown = (e: globalThis.KeyboardEvent) => {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.code === 'Escape') { setCapturing(false); return; }
            if (MODIFIER_KEYS.has(e.key)) return;
            const mods: string[] = [];
            if (e.ctrlKey)  mods.push('ctrl');
            if (e.shiftKey) mods.push('shift');
            if (e.altKey)   mods.push('alt');
            if (e.metaKey)  mods.push('meta');
            setEditKey(e.code);
            setEditModifiers(mods);
            setCapturing(false);
            setDirty(true);
        };
        document.addEventListener('keydown', onKeyDown, { capture: true });
        return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
    }, [capturing]);

    const handleDragStart = (e: React.DragEvent, id: string) => {
        if ((e.target as HTMLElement).closest('.script-editor__item-expand')) {
            e.preventDefault();
            return;
        }
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', id);
        // Delay so the item doesn't immediately look "dragging" before the ghost renders
        setTimeout(() => setDragId(id), 0);
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>, item: AnyNode) => {
        if (!dragId || dragId === item.id || isAncestorOf(dragId, item.id, items)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = e.currentTarget.getBoundingClientRect();
        const relY = (e.clientY - rect.top) / rect.height;
        // Any node accepts a child drop — Mudlet allows nesting under leaves in
        // every category (chain-head triggers, but also organisational nesting
        // for scripts/aliases/timers/keys/buttons).
        const intent: 'before' | 'into' | 'after' =
            relY > 0.3 && relY < 0.7 ? 'into' :
            relY < 0.5 ? 'before' : 'after';
        setDragOver(prev => (prev?.id === item.id && prev?.intent === intent) ? prev : { id: item.id, intent });
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>, target: AnyNode) => {
        e.preventDefault();
        const id = dragId ?? e.dataTransfer.getData('text/plain');
        if (!id || id === target.id || isAncestorOf(id, target.id, items)) return;

        const intent = dragOver?.intent ?? 'before';

        let newParentId: string | null;
        let insertBeforeId: string | null;

        if (intent === 'into') {
            newParentId = target.id;
            insertBeforeId = null;
        } else if (
            intent === 'after' &&
            expanded.has(target.id) &&
            items.some(i => i.parentId === target.id)
        ) {
            // The "after" line cue under an expanded node with children sits
            // between the parent row and its first child, so land the drop at
            // that exact slot. Applies to any expanded node — group or leaf
            // chain head — whose children are currently visible.
            newParentId = target.id;
            insertBeforeId = items.find(i => i.parentId === target.id)?.id ?? null;
        } else {
            newParentId = target.parentId;
            if (intent === 'before') {
                insertBeforeId = target.id;
            } else {
                const siblings = items.filter(i => i.parentId === target.parentId);
                const idx = siblings.findIndex(i => i.id === target.id);
                insertBeforeId = siblings[idx + 1]?.id ?? null;
            }
        }

        if (category === 'scripts')        moveScript(connectionId, id, newParentId, insertBeforeId);
        else if (category === 'aliases')   moveAlias(connectionId, id, newParentId, insertBeforeId);
        else if (category === 'triggers')  moveTrigger(connectionId, id, newParentId, insertBeforeId);
        else if (category === 'timers')    moveTimer(connectionId, id, newParentId, insertBeforeId);
        else if (category === 'keys')      moveKeybinding(connectionId, id, newParentId, insertBeforeId);
        else                               moveButton(connectionId, id, newParentId, insertBeforeId);

        // Auto-expand the group we dropped into
        if (intent === 'into') {
            setExpanded(prev => { const next = new Set(prev); next.add(target.id); return next; });
        }

        setDragId(null);
        setDragOver(null);
    };

    const handleDragEnd = () => {
        setDragId(null);
        setDragOver(null);
    };

    const listWidthRef = useRef(listWidth);
    listWidthRef.current = listWidth;

    const handleListResizeStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = listWidthRef.current;
        const onMove = (ev: MouseEvent) => {
            setListWidth(Math.max(120, Math.min(400, startWidth + ev.clientX - startX)));
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            onSplitsChange?.(listWidthRef.current);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }, [onSplitsChange]);

    const createItem = useCallback((asGroup: boolean, parentId: string | null) => {
        if (parentId) {
            setExpanded(prev => { const next = new Set(prev); next.add(parentId); return next; });
        }
        let id: string;
        if (category === 'scripts') {
            id = addScript(connectionId, {
                name: asGroup ? 'New Group' : 'New Script',
                language: 'lua',
                code: '',
                enabled: true,
                isGroup: asGroup,
                parentId,
                eventHandlers: [],
            });
        } else if (category === 'aliases') {
            id = addAlias(connectionId, {
                name: asGroup ? 'New Group' : 'New Alias',
                pattern: '',
                command: '',
                language: 'lua',
                code: '',
                enabled: true,
                isGroup: asGroup,
                parentId,
            });
        } else if (category === 'triggers') {
            id = addTrigger(connectionId, {
                name: asGroup ? 'New Group' : 'New Trigger',
                patterns: asGroup ? [] : [{ text: '', type: 'regex' }],
                language: 'lua',
                code: '',
                enabled: true,
                isGroup: asGroup,
                parentId,
                fireLength: 0,
                multipleMatches: false,
                multiline: false,
                delta: 0,
                isFilter: false,
            });
        } else if (category === 'timers') {
            id = addTimer(connectionId, {
                name: asGroup ? 'New Group' : 'New Timer',
                seconds: 60,
                language: 'lua',
                code: '',
                repeat: true,
                enabled: true,
                isGroup: asGroup,
                parentId,
            });
        } else if (category === 'keys') {
            id = addKeybinding(connectionId, {
                name: asGroup ? 'New Group' : 'New Key',
                key: '',
                modifiers: [],
                language: 'lua',
                code: '',
                enabled: true,
                isGroup: asGroup,
                parentId,
            });
        } else {
            id = addButton(connectionId, {
                name: asGroup ? 'New Toolbar' : 'New Button',
                language: 'lua',
                code: '',
                enabled: true,
                isGroup: asGroup,
                parentId,
                orientation: 'horizontal',
                location: 'top',
                columns: 0,
                isPushDown: false,
                buttonState: false,
            });
        }
        setSelectedId(id);
    }, [category, connectionId, addScript, addAlias, addTrigger, addTimer, addKeybinding, addButton]);

    const handleNew = (asGroup = false) => {
        // When the selection is already acting as a parent — a folder, or a
        // leaf that has nested children — new items land inside it. Otherwise
        // they become siblings of the selection (or roots if nothing is
        // selected).
        const selectedHasChildren = selected ? (childCounts.get(selected.id) ?? 0) > 0 : false;
        const parentId = selected && (selected.isGroup || selectedHasChildren)
            ? selected.id
            : selected?.parentId ?? null;
        createItem(asGroup, parentId);
    };

    const handleToggle = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        const item = items.find(i => i.id === id);
        if (!item) return;
        if (category === 'scripts')        updateScript(connectionId, id, { enabled: !item.enabled });
        else if (category === 'aliases')   updateAlias(connectionId, id, { enabled: !item.enabled });
        else if (category === 'triggers')  updateTrigger(connectionId, id, { enabled: !item.enabled });
        else if (category === 'timers')    updateTimer(connectionId, id, { enabled: !item.enabled });
        else if (category === 'keys')      updateKeybinding(connectionId, id, { enabled: !item.enabled });
        else                               updateButton(connectionId, id, { enabled: !item.enabled });
    };

    const handleToggleExpand = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const handleSave = () => {
        if (!selectedId || !selected) return;
        setLogs([]);
        if (category === 'scripts') {
            const handlers = editEventHandlers.split('\n').map(s => s.trim()).filter(Boolean);
            // The store subscription re-runs a script only when its code or event
            // handlers actually change. When neither did — clicking "Run", or
            // re-saving an unedited script — the subscription is a no-op, so force
            // the run explicitly. When they did change, the subscription already
            // runs it; forcing again here would execute the body twice.
            const prevHandlers = (selected as ScriptNode).eventHandlers ?? [];
            const subscriptionWillRun = selected.code !== editCode
                || prevHandlers.join('\n') !== handlers.join('\n');
            updateScript(connectionId, selectedId, { name: editName, language: 'lua', code: editCode, eventHandlers: handlers });
            if (!subscriptionWillRun) scriptingEngineRef?.current?.runScript(selectedId);
        } else if (category === 'aliases') {
            updateAlias(connectionId, selectedId, { name: editName, pattern: editPattern, command: editCommand, language: 'lua', code: editCode });
        } else if (category === 'triggers') {
            const highlight = (editHighlightFg || editHighlightBg)
                ? { fg: editHighlightFg || undefined, bg: editHighlightBg || undefined }
                : undefined;
            updateTrigger(connectionId, selectedId, {
                name: editName,
                patterns: editPatterns,
                language: 'lua',
                code: editCode,
                fireLength: editFireLength,
                multipleMatches: editMultipleMatches,
                multiline: editMultiline,
                delta: editDelta,
                isFilter: editIsFilter,
                highlight,
                command: editTriggerCommand || undefined,
            });
        } else if (category === 'timers') {
            const seconds = editHours * 3600 + editMinutes * 60 + editSecs + editMs / 1000;
            updateTimer(connectionId, selectedId, { name: editName, seconds, repeat: editRepeat, language: 'lua', code: editCode, command: editTimerCommand || undefined });
        } else if (category === 'keys') {
            updateKeybinding(connectionId, selectedId, { name: editName, key: editKey, modifiers: editModifiers, language: 'lua', code: editCode, command: editKeyCommand || undefined });
        } else {
            // buttons
            if (selected.isGroup) {
                updateButton(connectionId, selectedId, {
                    name: editName,
                    language: 'lua',
                    code: editCode,
                    location: editToolbarLocation,
                    orientation: editToolbarOrientation,
                    columns: editToolbarColumns,
                    styleSheet: editButtonStyleSheet || undefined,
                });
            } else {
                updateButton(connectionId, selectedId, {
                    name: editName,
                    language: 'lua',
                    code: editCode,
                    command: editButtonCommand || undefined,
                    isPushDown: editButtonIsPushDown,
                    commandDown: editButtonIsPushDown ? (editButtonCommandDown || undefined) : undefined,
                    icon:      editButtonIcon    || undefined,
                    tooltip:   editButtonTooltip || undefined,
                    styleSheet: editButtonStyleSheet || undefined,
                });
            }
        }
        setDirty(false);
    };

    const handleDelete = () => {
        if (!selectedId) return;
        if (category === 'scripts')        removeScript(connectionId, selectedId);
        else if (category === 'aliases')   removeAlias(connectionId, selectedId);
        else if (category === 'triggers')  removeTrigger(connectionId, selectedId);
        else if (category === 'timers')    removeTimer(connectionId, selectedId);
        else if (category === 'keys')      removeKeybinding(connectionId, selectedId);
        else                               removeButton(connectionId, selectedId);
        setSelectedId(null);
    };

    const isEditCategory = category !== 'errors' && category !== 'packages' && category !== 'variables';
    const categoryLabel = isEditCategory ? CATEGORY_LABELS[category as EditCategory].toLowerCase() : '';
    const emptyMsg = items.length === 0
        ? `No ${categoryLabel} yet — click "+ New" to create one`
        : `Select a ${categoryLabel.replace(/s$/, '')} to edit`;

    return (
        <div className="script-editor">
            {/* Category nav */}
            <div className="script-editor__nav">
                {EDIT_CATEGORIES.map(cat => {
                    const Icon = CATEGORY_ICON[cat];
                    return (
                        <button
                            key={cat}
                            className={`script-editor__nav-btn script-editor__nav-btn--row${category === cat ? ' script-editor__nav-btn--active' : ''}`}
                            onClick={() => setCategory(cat)}
                        >
                            <Icon size={13} strokeWidth={1.6} className="script-editor__nav-icon" />
                            <span className="script-editor__nav-label">{CATEGORY_LABELS[cat]}</span>
                        </button>
                    );
                })}
                <button
                    className={`script-editor__nav-btn script-editor__nav-btn--row${category === 'variables' ? ' script-editor__nav-btn--active' : ''}`}
                    onClick={() => setCategory('variables')}
                >
                    <Braces size={13} strokeWidth={1.6} className="script-editor__nav-icon" />
                    <span className="script-editor__nav-label">Variables</span>
                </button>
                <div className="script-editor__nav-sep" />
                <button
                    className={`script-editor__nav-btn script-editor__nav-btn--row${category === 'errors' ? ' script-editor__nav-btn--active' : ''}`}
                    onClick={() => setCategory('errors')}
                >
                    <AlertCircle size={13} strokeWidth={1.6} className="script-editor__nav-icon" />
                    <span className="script-editor__nav-label">Errors</span>
                    {unreadErrors > 0 && (
                        <span className="script-editor__error-badge">{unreadErrors > 99 ? '99+' : unreadErrors}</span>
                    )}
                </button>
                <div className="script-editor__nav-sep" />
                <button
                    className={`script-editor__nav-btn script-editor__nav-btn--row${category === 'packages' ? ' script-editor__nav-btn--active' : ''}`}
                    onClick={() => setCategory('packages')}
                >
                    <Package size={13} strokeWidth={1.6} className="script-editor__nav-icon" />
                    <span className="script-editor__nav-label">Packages</span>
                    {packages.length > 0 && (
                        <span className="script-editor__error-badge" style={{ background: '#3a3a3a' }}>{packages.length}</span>
                    )}
                </button>
            </div>
            {showRepository && (
                <PackageRepositoryModal
                    installedNames={new Set(packages.map(p => p.name))}
                    proxyUrl={proxyUrlGetter()}
                    onClose={() => setShowRepository(false)}
                    onInstall={handleInstallFromRepository}
                />
            )}
            {showExport && (
                <PackageExportModal
                    connectionId={connectionId}
                    vfs={vfs}
                    preselect={exportPreselect}
                    onClose={() => { setShowExport(false); setExportPreselect(null); }}
                    onExported={text => setLogs(prev => [...prev, { text, level: 'info', timestamp: new Date() }])}
                />
            )}

            {/* Item list — hidden on the Errors and Packages tabs */}
            {isEditCategory && <div className="script-editor__list" style={{ width: listWidth }}>
                <div className="script-editor__list-resize" onMouseDown={handleListResizeStart} />
                <div className="script-editor__list-header">
                    <Button variant="secondary" size="sm" onClick={() => handleNew(false)}>+ New</Button>
                    <Button variant="secondary" size="sm" onClick={() => handleNew(true)}>+ {category === 'buttons' ? BUTTON_GROUP_SINGULAR : 'Group'}</Button>
                </div>
                <div
                    className="script-editor__items"
                    onDragLeave={e => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null);
                    }}
                    onContextMenu={handlePaneContextMenu}
                >
                    {treeEntries.map(({ item, depth }) => {
                        const effective = isEffectivelyEnabled(item, items);
                        const isSelected = item.id === selectedId;
                        const isExpanded = expanded.has(item.id);
                        const isOver = dragOver?.id === item.id;
                        const childCount = childCounts.get(item.id) ?? 0;
                        const hasChildren = childCount > 0;
                        const isEmptyGroup = item.isGroup && !hasChildren;
                        return (
                            <div
                                key={item.id}
                                draggable
                                className={[
                                    'script-editor__item',
                                    isSelected ? 'script-editor__item--selected' : '',
                                    item.isGroup ? 'script-editor__item--group' : '',
                                    isEmptyGroup ? 'script-editor__item--empty-group' : '',
                                    !effective ? 'script-editor__item--inherited-disabled' : '',
                                    item.id === dragId ? 'script-editor__item--dragging' : '',
                                    isOver && dragOver!.intent === 'before' ? 'script-editor__item--drop-before' : '',
                                    isOver && dragOver!.intent === 'after'  ? 'script-editor__item--drop-after'  : '',
                                    isOver && dragOver!.intent === 'into'   ? 'script-editor__item--drop-into'   : '',
                                ].filter(Boolean).join(' ')}
                                onClick={() => setSelectedId(item.id)}
                                style={{ paddingLeft: `${8 + depth * 14}px` }}
                                onDragStart={e => handleDragStart(e, item.id)}
                                onDragOver={e => handleDragOver(e, item)}
                                onDrop={e => handleDrop(e, item)}
                                onDragEnd={handleDragEnd}
                                onContextMenu={e => handleItemContextMenu(e, item.id)}
                            >
                                {hasChildren || item.isGroup ? (
                                    <button
                                        className="script-editor__item-expand"
                                        onClick={e => handleToggleExpand(item.id, e)}
                                        tabIndex={-1}
                                        title={isEmptyGroup ? 'Empty group' : (isExpanded ? 'Collapse' : 'Expand')}
                                    >
                                        <ItemIcon category={category} isGroup={item.isGroup} isExpanded={isExpanded && hasChildren} hasChildren={hasChildren} />
                                    </button>
                                ) : (
                                    <span className="script-editor__item-spacer">
                                        <ItemIcon category={category} isGroup={false} isExpanded={false} />
                                    </span>
                                )}
                                <input
                                    type="checkbox"
                                    checked={item.enabled}
                                    onChange={() => {}}
                                    onClick={e => handleToggle(item.id, e)}
                                    style={{ accentColor: 'var(--accent)', cursor: 'pointer', flexShrink: 0 }}
                                />
                                <span className="script-editor__item-name">
                                    {item.name}
                                    {hasChildren && (
                                        <span className="script-editor__item-count">{childCount}</span>
                                    )}
                                    {'key' in item && (item as KeyNode).key && (
                                        <span className="script-editor__item-key">
                                            {formatKeyCombo((item as KeyNode).key, (item as KeyNode).modifiers)}
                                        </span>
                                    )}
                                </span>
                            </div>
                        );
                    })}
                </div>
            </div>}
            {/* end item list */}

            {/* Variables view — the live _G tree with a save-list checkbox per entry */}
            {category === 'variables' && (
                <VariablesView connectionId={connectionId} scriptingEngineRef={scriptingEngineRef} />
            )}

            {/* Packages view */}
            {category === 'packages' && (
                <div className="script-editor__error-log-view">
                    <div className="script-editor__error-log-header">
                        <span className="script-editor__error-log-title">
                            {packages.length === 0 ? 'No packages installed' : `${packages.length} installed`}
                        </span>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                            {importError && <span className="script-editor__import-error" title={importError}>Import failed: {importError}</span>}
                            <FileSourceButton
                                vfs={vfs}
                                label="Import Package…"
                                accept=".xml,.mpackage,.zip"
                                pickerTitle="Import package from profile files"
                                title="Import a Mudlet package (.mpackage / .zip / .xml) from your computer or from this profile's files"
                                onPick={files => void handleImportFile(files)}
                            />
                            <FileSourceButton
                                vfs={vfs}
                                label="Import Module…"
                                accept=".xml,.mpackage,.zip"
                                pickerTitle="Import module from profile files"
                                title="Import as module — the on-disk XML is the source of truth and is reloaded on every profile open. A module picked from this profile is referenced in place."
                                onPick={files => void handleImportModulePick(files)}
                            />
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => { setExportPreselect(null); setShowExport(true); }}
                                title="Bundle scripts, aliases, triggers, timers, keys, buttons and files into a .mpackage"
                            >
                                Export Package…
                            </Button>
                            <Button variant="primary" size="sm" onClick={() => setShowRepository(true)} disabled={!vfs}>
                                Browse Repository…
                            </Button>
                        </div>
                    </div>
                    <div className="script-editor__error-log-entries">
                        {packages.length === 0 ? (
                            <span className="script-editor__log-empty">
                                Click "Browse Repository…" above to install community packages from the Mudlet
                                repository, or "Import file…" to upload a local .mpackage / .zip / .xml file.
                            </span>
                        ) : (
                            packages.map(pkg => {
                                const created = pkg.created ? formatPackageDate(pkg.created) : null;
                                const installed = new Date(pkg.installedAt).toLocaleString();
                                const isModule = pkg.kind === 'module';
                                return (
                                    <div key={pkg.name} className="script-editor__pkg-card">
                                        <div className="script-editor__pkg-header">
                                            <PackageIcon vfs={vfs} pkg={pkg} />
                                            <div className="script-editor__pkg-heading">
                                                <div className="script-editor__pkg-title">
                                                    {pkg.title || pkg.name}
                                                    {isModule && <span className="script-editor__pkg-tag" style={{ marginLeft: 8, fontSize: 10, padding: '1px 6px', border: '1px solid var(--accent)', color: 'var(--accent)', borderRadius: 3 }}>MODULE</span>}
                                                </div>
                                                <div className="script-editor__pkg-byline">
                                                    {pkg.name !== (pkg.title || pkg.name) && <span>{pkg.name}</span>}
                                                    {pkg.version && <><span className="script-editor__pkg-byline-sep">·</span><span>v{pkg.version}</span></>}
                                                    {pkg.author && <><span className="script-editor__pkg-byline-sep">·</span><span>{pkg.author}</span></>}
                                                </div>
                                            </div>
                                            {isPackageRemovable(pkg.name) && (
                                            <button
                                                className="script-editor__error-log-clear"
                                                onClick={async () => {
                                                    const ok = await confirm<boolean>({
                                                        title: isModule ? 'Uninstall module?' : 'Uninstall package?',
                                                        tone: 'danger',
                                                        message: isModule ? (
                                                            <>
                                                                Uninstall <strong>{pkg.title || pkg.name}</strong>? All scripts, aliases,
                                                                triggers, timers and keys it added will be removed. The XML file on
                                                                disk is left untouched — the module is only unlinked.
                                                            </>
                                                        ) : (
                                                            <>
                                                                Uninstall <strong>{pkg.title || pkg.name}</strong>? All scripts, aliases,
                                                                triggers, timers and keys it added will be removed, along with its files
                                                                in <code>/{pkg.name}/</code>.
                                                            </>
                                                        ),
                                                        buttons: [
                                                            { label: 'Cancel', value: false, variant: 'secondary' },
                                                            { label: 'Uninstall', value: true, variant: 'danger', autoFocus: true },
                                                        ],
                                                        dismissValue: false,
                                                    });
                                                    if (ok) handleUninstall(pkg.name);
                                                }}
                                            >
                                                Uninstall
                                            </button>
                                            )}
                                        </div>
                                        {pkg.description && <PackageDescription text={pkg.description} />}
                                        <div className="script-editor__pkg-footer">
                                            {pkg.sourceFile ?? `${pkg.name}.mpackage`}
                                            {created && <> · created {created}</>}
                                            {' · installed '}{installed}
                                        </div>
                                        {isModule && (
                                            <div className="script-editor__pkg-module-actions" style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={!!pkg.sync}
                                                        onChange={e => handleToggleModuleSync(pkg.name, e.target.checked)}
                                                        style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                                                    />
                                                    Sync edits to file
                                                </label>
                                                <label
                                                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}
                                                    title="Load priority. Negative values load this module before profile scripts. Takes effect on the next reload."
                                                >
                                                    Priority
                                                    <input
                                                        className="input"
                                                        type="number"
                                                        value={pkg.priority ?? 0}
                                                        onChange={e => {
                                                            const v = parseInt(e.target.value, 10);
                                                            updatePackageManifest(connectionId, pkg.name, { priority: Number.isFinite(v) ? v : 0 });
                                                        }}
                                                        style={{ width: 70, height: 22, padding: '0 6px' }}
                                                    />
                                                </label>
                                                <button
                                                    className="script-editor__error-log-clear"
                                                    onClick={() => handleSyncModule(pkg.name)}
                                                    title="Write the current in-app state back to the module's XML file"
                                                >
                                                    Sync to file
                                                </button>
                                                <button
                                                    className="script-editor__error-log-clear"
                                                    onClick={() => handleReloadModule(pkg.name)}
                                                    title="Discard in-app changes and re-parse the XML file from disk"
                                                >
                                                    Reload from file
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            )}

            {/* Errors view */}
            {category === 'errors' && (
                <div className="script-editor__error-log-view">
                    <div className="script-editor__error-log-header">
                        <span className="script-editor__error-log-title">
                            {errorLog.length === 0 ? 'No output yet' : `${errorLog.length} entr${errorLog.length === 1 ? 'y' : 'ies'}`}
                        </span>
                        <button
                            className="script-editor__error-log-clear"
                            onClick={() => { session.clearScriptLog(); setErrorLog([]); setLogs([]); setUnreadErrors(0); }}
                            disabled={errorLog.length === 0}
                        >
                            Clear
                        </button>
                    </div>
                    <div className="script-editor__error-log-entries">
                        {errorLog.length === 0 ? (
                            <span className="script-editor__log-empty">Lua errors and script output will appear here.</span>
                        ) : (
                            errorLog.map((entry, i) => {
                                const segments = vfs && onOpenVfsFile
                                    ? segmentLogText(entry.text, p => vfs.exists(p))
                                    : [entry.text];
                                return (
                                    <div key={i} className={`script-editor__error-log-entry script-editor__error-log-entry--${entry.level}`}>
                                        <span className="script-editor__error-log-time">{formatTime(entry.timestamp)}</span>
                                        <span className="script-editor__error-log-text">
                                            {segments.map((seg, j) => typeof seg === 'string'
                                                ? <span key={j}>{seg}</span>
                                                : (
                                                    <button
                                                        key={j}
                                                        type="button"
                                                        className="script-editor__error-log-path"
                                                        onClick={() => onOpenVfsFile?.(seg.path, seg.line)}
                                                        title={`Open ${seg.path}${seg.line !== undefined ? ` (line ${seg.line})` : ''} in file browser`}
                                                    >
                                                        {seg.match}
                                                    </button>
                                                ))}
                                        </span>
                                        {entry.source && (
                                            <button
                                                className="script-editor__error-log-jump"
                                                type="button"
                                                onClick={() => handleErrorJump(entry.source!)}
                                                title={`Open ${entry.source.kind} "${entry.source.name}"${entry.source.line !== undefined ? ` at line ${entry.source.line}` : ''}`}
                                                aria-label={`Open ${entry.source.kind} ${entry.source.name}`}
                                            >
                                                →
                                            </button>
                                        )}
                                    </div>
                                );
                            })
                        )}
                        <div ref={errorLogEndRef} />
                    </div>
                </div>
            )}

            {/* Editor pane */}
            {isEditCategory && selected ? (
                <div className="script-editor__pane">
                    <div className="script-editor__meta">
                        <div className="script-editor__meta-row">
                            {selected.isGroup && (
                                <span className="script-editor__group-badge">{category === 'buttons' ? BUTTON_GROUP_SINGULAR : 'Group'}</span>
                            )}
                            <Input
                                className="script-editor__name"
                                value={editName}
                                onChange={e => { setEditName(e.target.value); setDirty(true); }}
                                placeholder="Name"
                            />
                        </div>
                        {category === 'aliases' && (
                            <>
                                <div className="script-editor__meta-row">
                                    <Input
                                        className="script-editor__pattern"
                                        value={editPattern}
                                        onChange={e => { setEditPattern(e.target.value); setDirty(true); }}
                                        placeholder="Pattern (regex)"
                                    />
                                </div>
                                <div className="script-editor__meta-row">
                                    <Input
                                        className="script-editor__pattern"
                                        value={editCommand}
                                        onChange={e => { setEditCommand(e.target.value); setDirty(true); }}
                                        placeholder="Command (%1, %2… = captures)"
                                    />
                                </div>
                            </>
                        )}
                        {category === 'triggers' && (
                            <>
                                {/* Patterns */}
                                <div className="script-editor__meta-row script-editor__meta-row--col">
                                    <span className="script-editor__field-label">Patterns</span>
                                    <div className="script-editor__pattern-list">
                                        <div className="script-editor__pattern-rows">
                                        {editPatterns.map((p, i) => {
                                            const [colorFg, colorBg] = p.type === 'colorTrigger' ? parseColorPattern(p.text) : [-1, -1];
                                            const setColor = (fg: number, bg: number) => {
                                                const next = [...editPatterns];
                                                next[i] = { ...next[i], text: formatColorPattern(fg, bg) };
                                                setEditPatterns(next);
                                                setDirty(true);
                                            };
                                            return (
                                            <div key={i} className="script-editor__pattern-row">
                                                <PatternTypeSelect
                                                    value={p.type}
                                                    onChange={t => {
                                                        const next = [...editPatterns];
                                                        next[i] = { ...next[i], type: t, text: retypePatternText(next[i].text, p.type, t) };
                                                        setEditPatterns(next);
                                                        setDirty(true);
                                                    }}
                                                />
                                                {p.type === 'lineSpacer' ? (
                                                    /* Mudlet shows a dedicated spin box for this type instead of
                                                     * the pattern line edit, and saves its value as the pattern
                                                     * string (dlgTriggerEditor.cpp:7207-7217, :5829-5830). Its
                                                     * range is QSpinBox's default 0..99
                                                     * (ui/trigger_pattern_edit.ui:187). */
                                                    <input
                                                        type="number"
                                                        className="script-editor__pattern-spacer"
                                                        min={0}
                                                        max={99}
                                                        value={p.text === '' ? '0' : p.text}
                                                        aria-label="Lines to skip"
                                                        title="Number of lines to skip before the next condition is tested"
                                                        onChange={e => {
                                                            const n = Math.max(0, Math.min(99, Math.trunc(Number(e.target.value) || 0)));
                                                            const next = [...editPatterns];
                                                            next[i] = { ...next[i], text: String(n) };
                                                            setEditPatterns(next);
                                                            setDirty(true);
                                                        }}
                                                    />
                                                ) : p.type === 'colorTrigger' ? (
                                                    <div className="script-editor__pattern-color-pair">
                                                        <ColorChannelPicker
                                                            label="FG"
                                                            value={colorFg}
                                                            onChange={fg => setColor(fg, colorBg)}
                                                        />
                                                        <ColorChannelPicker
                                                            label="BG"
                                                            value={colorBg}
                                                            onChange={bg => setColor(colorFg, bg)}
                                                        />
                                                    </div>
                                                ) : (
                                                    <input
                                                        type="text"
                                                        className="script-editor__pattern-text"
                                                        value={p.text}
                                                        disabled={!PATTERN_NEEDS_TEXT.has(p.type)}
                                                        placeholder={p.type === 'luaFunction' ? 'function name' : 'pattern'}
                                                        spellCheck={false}
                                                        onChange={e => {
                                                            const next = [...editPatterns];
                                                            next[i] = { ...next[i], text: e.target.value };
                                                            setEditPatterns(next);
                                                            setDirty(true);
                                                        }}
                                                    />
                                                )}
                                                <button
                                                    type="button"
                                                    className="script-editor__pattern-remove"
                                                    onClick={() => { setEditPatterns(editPatterns.filter((_, j) => j !== i)); setDirty(true); }}
                                                    title="Remove pattern"
                                                >×</button>
                                            </div>
                                            );
                                        })}
                                        </div>
                                        <button
                                            type="button"
                                            className="script-editor__pattern-add"
                                            onClick={() => { setEditPatterns([...editPatterns, { text: '', type: 'regex' }]); setDirty(true); }}
                                        >+ Add pattern</button>
                                    </div>
                                </div>

                                {/* Command */}
                                <div className="script-editor__meta-row">
                                    <Input
                                        className="script-editor__pattern"
                                        value={editTriggerCommand}
                                        onChange={e => { setEditTriggerCommand(e.target.value); setDirty(true); }}
                                        placeholder="Command to send (%1..%9 = captures)"
                                    />
                                </div>

                                {/* Matching & Highlight sections (side by side when space allows) */}
                                <div className="script-editor__trigger-cards-row">
                                    {/* Matching section */}
                                    <div className="script-editor__trigger-card">
                                        <span className="script-editor__trigger-card-label">Matching</span>
                                        <div className="script-editor__trigger-card-row">
                                            <label className="script-editor__trigger-opt">
                                                <input
                                                    type="checkbox"
                                                    checked={editMultipleMatches}
                                                    onChange={e => { setEditMultipleMatches(e.target.checked); setDirty(true); }}
                                                />
                                                Multiple matches
                                            </label>
                                            <label className="script-editor__trigger-opt script-editor__trigger-opt--fire">
                                                Fire length
                                                <input
                                                    type="number"
                                                    className="script-editor__fire-length"
                                                    value={editFireLength}
                                                    min={0}
                                                    title="0 = only the current line; N = also open for N more lines"
                                                    onChange={e => {
                                                        const v = parseInt(e.target.value, 10);
                                                        setEditFireLength(isNaN(v) || v < 0 ? 0 : v);
                                                        setDirty(true);
                                                    }}
                                                />
                                            </label>
                                        </div>
                                        <div className="script-editor__trigger-card-row">
                                            <label className="script-editor__trigger-opt">
                                                <input
                                                    type="checkbox"
                                                    checked={editMultiline}
                                                    onChange={e => { setEditMultiline(e.target.checked); setDirty(true); }}
                                                />
                                                AND (multiline)
                                            </label>
                                            {editMultiline && (
                                                <label className="script-editor__trigger-opt script-editor__trigger-opt--fire">
                                                    within
                                                    <input
                                                        type="number"
                                                        className="script-editor__fire-length"
                                                        value={editDelta}
                                                        min={0}
                                                        max={MAX_CONDITION_LINE_DELTA}
                                                        title="How many lines after the one matching the first condition the remaining conditions have to match in. 0 = all of them on that one line."
                                                        onChange={e => {
                                                            const v = parseInt(e.target.value, 10);
                                                            setEditDelta(isNaN(v) || v < 0 ? 0 : Math.min(v, MAX_CONDITION_LINE_DELTA));
                                                            setDirty(true);
                                                        }}
                                                    />
                                                    lines
                                                </label>
                                            )}
                                        </div>
                                    </div>

                                    {/* Highlight section */}
                                    <div className="script-editor__trigger-card">
                                        <span className="script-editor__trigger-card-label">Highlight</span>
                                        <div className="script-editor__trigger-card-row">
                                            <label className="script-editor__trigger-opt">
                                                <input
                                                    type="checkbox"
                                                    checked={!!editHighlightFg}
                                                    onChange={e => { setEditHighlightFg(e.target.checked ? '#ff0000' : ''); setDirty(true); }}
                                                />
                                                FG
                                            </label>
                                            <input
                                                type="color"
                                                className="script-editor__color-pick"
                                                value={editHighlightFg || '#ff0000'}
                                                disabled={!editHighlightFg}
                                                onChange={e => { setEditHighlightFg(e.target.value); setDirty(true); }}
                                            />
                                            <div className="script-editor__trigger-card-divider" />
                                            <label className="script-editor__trigger-opt">
                                                <input
                                                    type="checkbox"
                                                    checked={!!editHighlightBg}
                                                    onChange={e => { setEditHighlightBg(e.target.checked ? '#000080' : ''); setDirty(true); }}
                                                />
                                                BG
                                            </label>
                                            <input
                                                type="color"
                                                className="script-editor__color-pick"
                                                value={editHighlightBg || '#000080'}
                                                disabled={!editHighlightBg}
                                                onChange={e => { setEditHighlightBg(e.target.value); setDirty(true); }}
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* Chain section — visible whenever this trigger could be a chain head
                                    (a folder, or a leaf with at least one nested child trigger). */}
                                {(selected.isGroup || (childCounts.get(selected.id) ?? 0) > 0) && (
                                    <div className="script-editor__trigger-card">
                                        <span className="script-editor__trigger-card-label">Chain</span>
                                        <div className="script-editor__trigger-card-row">
                                            <label className="script-editor__trigger-opt">
                                                <input
                                                    type="checkbox"
                                                    checked={editIsFilter}
                                                    onChange={e => { setEditIsFilter(e.target.checked); setDirty(true); }}
                                                />
                                                Filter (pass match to children)
                                            </label>
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                        {category === 'scripts' && (
                            <div className="script-editor__meta-row script-editor__meta-row--col">
                                <span className="script-editor__field-label">Event handlers (one per line — fires the global function named after this script)</span>
                                <textarea
                                    className="script-editor__patterns"
                                    value={editEventHandlers}
                                    onChange={e => { setEditEventHandlers(e.target.value); setDirty(true); }}
                                    placeholder="sysConnectionEvent"
                                    spellCheck={false}
                                />
                            </div>
                        )}
                        {category === 'keys' && (
                            <>
                                <div className="script-editor__meta-row">
                                    <button
                                        type="button"
                                        className={`script-editor__key-capture${capturing ? ' script-editor__key-capture--active' : ''}`}
                                        onClick={() => setCapturing(c => !c)}
                                    >
                                        {capturing
                                            ? 'Press a key… (Esc to cancel)'
                                            : (formatKeyCombo(editKey, editModifiers) || 'Click to capture key')}
                                    </button>
                                </div>
                                {!selected.isGroup && (
                                    <div className="script-editor__meta-row">
                                        <Input
                                            className="script-editor__pattern"
                                            value={editKeyCommand}
                                            onChange={e => { setEditKeyCommand(e.target.value); setDirty(true); }}
                                            placeholder="Command to send"
                                        />
                                    </div>
                                )}
                            </>
                        )}
                        {category === 'timers' && (
                            <div className="script-editor__meta-row">
                                <span className="script-editor__field-label">Every</span>
                                <input
                                    type="number"
                                    className="script-editor__time-part"
                                    value={editHours}
                                    min={0}
                                    onChange={e => { setEditHours(Math.max(0, Number(e.target.value))); setDirty(true); }}
                                />
                                <span className="script-editor__field-label">h</span>
                                <input
                                    type="number"
                                    className="script-editor__time-part"
                                    value={editMinutes}
                                    min={0}
                                    max={59}
                                    onChange={e => { setEditMinutes(Math.max(0, Math.min(59, Number(e.target.value)))); setDirty(true); }}
                                />
                                <span className="script-editor__field-label">m</span>
                                <input
                                    type="number"
                                    className="script-editor__time-part"
                                    value={editSecs}
                                    min={0}
                                    max={59}
                                    onChange={e => { setEditSecs(Math.max(0, Math.min(59, Number(e.target.value)))); setDirty(true); }}
                                />
                                <span className="script-editor__field-label">s</span>
                                <input
                                    type="number"
                                    className="script-editor__time-part"
                                    value={editMs}
                                    min={0}
                                    max={999}
                                    onChange={e => { setEditMs(Math.max(0, Math.min(999, Number(e.target.value)))); setDirty(true); }}
                                />
                                <span className="script-editor__field-label">ms</span>
                                <label className="script-editor__repeat">
                                    <input
                                        type="checkbox"
                                        checked={editRepeat}
                                        onChange={e => { setEditRepeat(e.target.checked); setDirty(true); }}
                                    />
                                    Repeat
                                </label>
                            </div>
                        )}
                        {category === 'timers' && !selected.isGroup && (
                            <div className="script-editor__meta-row">
                                <Input
                                    className="script-editor__pattern"
                                    value={editTimerCommand}
                                    onChange={e => { setEditTimerCommand(e.target.value); setDirty(true); }}
                                    placeholder="Command to send"
                                />
                            </div>
                        )}
                        {category === 'buttons' && selected.isGroup && (
                            <div className="script-editor__meta-row">
                                <span className="script-editor__field-label">Location</span>
                                <select
                                    className="script-editor__lang-select"
                                    value={editToolbarLocation}
                                    onChange={e => { setEditToolbarLocation(e.target.value as ButtonLocation); setDirty(true); }}
                                >
                                    {BUTTON_LOCATIONS.map(loc => (
                                        <option key={loc} value={loc}>{loc[0].toUpperCase() + loc.slice(1)}</option>
                                    ))}
                                </select>
                                <span className="script-editor__field-label">Orientation</span>
                                <select
                                    className="script-editor__lang-select"
                                    value={editToolbarOrientation}
                                    onChange={e => { setEditToolbarOrientation(e.target.value as ButtonOrientation); setDirty(true); }}
                                >
                                    {BUTTON_ORIENTATIONS.map(o => (
                                        <option key={o} value={o}>{o[0].toUpperCase() + o.slice(1)}</option>
                                    ))}
                                </select>
                                <span className="script-editor__field-label">
                                    {editToolbarOrientation === 'horizontal' ? 'Rows' : 'Columns'}
                                </span>
                                <input
                                    type="number"
                                    className="script-editor__time-part"
                                    value={editToolbarColumns}
                                    min={0}
                                    title={editToolbarOrientation === 'horizontal'
                                        ? '0 = single row; N = wrap into N rows (Mudlet buttonColumn)'
                                        : '0 = single column; N = wrap into N columns (Mudlet buttonColumn)'}
                                    onChange={e => {
                                        const v = parseInt(e.target.value, 10);
                                        setEditToolbarColumns(isNaN(v) || v < 0 ? 0 : v);
                                        setDirty(true);
                                    }}
                                />
                            </div>
                        )}
                        {category === 'buttons' && !selected.isGroup && (
                            <>
                                <div className="script-editor__meta-row">
                                    <Input
                                        className="script-editor__pattern"
                                        value={editButtonCommand}
                                        onChange={e => { setEditButtonCommand(e.target.value); setDirty(true); }}
                                        placeholder={editButtonIsPushDown ? 'Command (up — released)' : 'Command to send'}
                                    />
                                </div>
                                {editButtonIsPushDown && (
                                    <div className="script-editor__meta-row">
                                        <Input
                                            className="script-editor__pattern"
                                            value={editButtonCommandDown}
                                            onChange={e => { setEditButtonCommandDown(e.target.value); setDirty(true); }}
                                            placeholder="Command (down — pressed)"
                                        />
                                    </div>
                                )}
                                <div className="script-editor__meta-row">
                                    <Input
                                        className="script-editor__pattern"
                                        value={editButtonIcon}
                                        onChange={e => { setEditButtonIcon(e.target.value); setDirty(true); }}
                                        placeholder="Icon path (relative to profile root)"
                                    />
                                </div>
                                <div className="script-editor__meta-row">
                                    <Input
                                        className="script-editor__pattern"
                                        value={editButtonTooltip}
                                        onChange={e => { setEditButtonTooltip(e.target.value); setDirty(true); }}
                                        placeholder="Tooltip"
                                    />
                                </div>
                                <div className="script-editor__meta-row">
                                    <label className="script-editor__trigger-opt">
                                        <input
                                            type="checkbox"
                                            checked={editButtonIsPushDown}
                                            onChange={e => { setEditButtonIsPushDown(e.target.checked); setDirty(true); }}
                                        />
                                        Two-state (push-down) button
                                    </label>
                                </div>
                            </>
                        )}
                        {category === 'buttons' && (
                            <div className="script-editor__meta-row script-editor__meta-row--col">
                                <span className="script-editor__field-label">Stylesheet (stored, not yet applied)</span>
                                <textarea
                                    className="script-editor__patterns"
                                    value={editButtonStyleSheet}
                                    onChange={e => { setEditButtonStyleSheet(e.target.value); setDirty(true); }}
                                    placeholder="QPushButton { ... }"
                                    spellCheck={false}
                                />
                            </div>
                        )}
                    </div>

                    <LuaEditor
                        value={editCode}
                        onChange={code => { setEditCode(code); setDirty(true); }}
                        onSave={handleSave}
                        gotoLine={editorGotoLine}
                    />

                    <div className="script-editor__log">
                        {visibleLogs.length === 0
                            ? <span className="script-editor__log-empty">No output</span>
                            : visibleLogs.map((entry, i) => (
                                <div key={i} className={`script-editor__log-entry script-editor__log-entry--${entry.level}`}>
                                    {entry.text}
                                </div>
                            ))
                        }
                        <div ref={logEndRef} />
                    </div>

                    <div className="script-editor__actions">
                        <Button variant="ghost" size="sm" onClick={handleDelete}>Delete</Button>
                        <Button variant="primary" size="sm" onClick={handleSave}>
                            {category === 'scripts'
                                ? (dirty ? 'Save & Run' : 'Run')
                                : (dirty ? 'Save' : 'Saved')}
                        </Button>
                    </div>
                </div>
            ) : (
                isEditCategory && <div className="script-editor__empty">{emptyMsg}</div>
            )}

            {ctxMenu && isEditCategory && (
                <ContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}>
                    {ctxMenu.targetId !== null && (
                        <>
                            <button
                                className="ctx-menu__item"
                                onClick={() => {
                                    setExportPreselect({ category: category as ExportCategory, id: ctxMenu.targetId! });
                                    setShowExport(true);
                                    setCtxMenu(null);
                                }}
                            >
                                <Package size={13} strokeWidth={1.6} />
                                Export as Package…
                            </button>
                            <button
                                className="ctx-menu__item ctx-menu__item--danger"
                                onClick={() => handleContextDelete(ctxMenu.targetId!)}
                            >
                                <Trash2 size={13} strokeWidth={1.6} />
                                Delete
                            </button>
                            <div className="ctx-menu__sep" />
                        </>
                    )}
                    <button
                        className="ctx-menu__item"
                        onClick={() => {
                            const parentId = ctxMenu.targetId !== null
                                ? (items.find(i => i.id === ctxMenu.targetId)?.parentId ?? null)
                                : null;
                            createItem(false, parentId);
                            setCtxMenu(null);
                        }}
                    >
                        {React.createElement(CATEGORY_ICON[category as EditCategory], { size: 13, strokeWidth: 1.6 })}
                        Add {CATEGORY_SINGULAR[category as EditCategory]}
                    </button>
                    <button
                        className="ctx-menu__item"
                        onClick={() => {
                            const parentId = ctxMenu.targetId !== null
                                ? (items.find(i => i.id === ctxMenu.targetId)?.parentId ?? null)
                                : null;
                            createItem(true, parentId);
                            setCtxMenu(null);
                        }}
                    >
                        <FolderPlus size={13} strokeWidth={1.6} />
                        Add {category === 'buttons' ? BUTTON_GROUP_SINGULAR : 'Group'}
                    </button>
                </ContextMenu>
            )}
        </div>
    );
});
