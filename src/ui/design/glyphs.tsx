// Mudlet's design glyphs, by the file names desktop ships them under.
//
// Desktop draws every chrome glyph from a Lucide SVG in src/icons/ (the
// `ui/design-language` branch, docs/design-language.md §2), so a trigger is the
// same picture wherever it is offered. Those files are Lucide's own, unchanged,
// so here each name maps to the lucide-react component with the same path data
// rather than to a copy of the file. The mapping was taken by comparing path
// data; where desktop vendored an older Lucide drawing of the same icon
// (book-open, zap, volume-x, package, send, swords) the current one stands in.
//
// Desktop draws the glyphs at a stroke width of 1.5 rather than Lucide's 2 —
// the weight is a token (`scmGlyphStrokeWidth`), so it is one here too.

import type { LucideIcon, LucideProps } from 'lucide-react';
import {
    Accessibility, ArrowDownToLine, ArrowUpFromLine, Blocks, BookOpen, Box, Braces, Bug, ChartColumn, Check,
    ChevronDown, ChevronRight, ChevronUp, CircleAlert, ClipboardPaste, Funnel, CircleHelp, CirclePlay, CircleStop, CircleX, Columns2,
    Copy, Download, Eraser, EyeOff, FastForward, FileCode, FilePlus, Folder, FolderOpen, FolderPlus, Globe,
    Hash, HeartHandshake, Info, Keyboard, Library, Mail, Map as MapIcon, Maximize, MessagesSquare, Minimize,
    Minus, Monitor, MousePointerClick, NotebookPen, Package, Palette, Pause, Play, Plug, Plus, Power, Quote,
    Redo2, RefreshCw, Rewind, Save, SaveAll, Scale, Search, Send, Settings, ShieldCheck, SlidersHorizontal,
    SquareFunction, Swords, Terminal, Timer, TimerReset, ToggleLeft, Trash2, TriangleAlert, Undo2, Upload,
    Volume2, VolumeX, Wrench, X, Zap,
} from 'lucide-react';

/** Desktop's stroke width (`scmGlyphStrokeWidth`). */
export const GLYPH_STROKE_WIDTH = 1.5;

export const GLYPHS = {
    // Main toolbar (mudlet.cpp / TDetachedWindow.cpp)
    'toolbar-about': Info,
    'toolbar-connect': Plug,
    'toolbar-export': Upload,
    'toolbar-fullscreen': Maximize,
    'toolbar-fullscreen-exit': Minimize,
    'toolbar-manual': BookOpen,
    'toolbar-map': MapIcon,
    'toolbar-multiview': Columns2,
    'toolbar-notepad': NotebookPen,
    'toolbar-packages': Package,
    'toolbar-reconnect': RefreshCw,
    'toolbar-replay': CirclePlay,
    'toolbar-replay-faster': FastForward,
    'toolbar-replay-pause': Pause,
    'toolbar-replay-resume': Play,
    'toolbar-replay-slower': Rewind,
    'toolbar-replay-stop': CircleStop,
    'toolbar-settings': Settings,
    'toolbar-sound-off': VolumeX,
    'toolbar-sound-on': Volume2,
    // Script editor (dlgTriggerEditor.cpp) — the seven item kinds first
    'editor-triggers': Zap,
    'editor-aliases': Terminal,
    'editor-timers': Timer,
    'editor-buttons': MousePointerClick,
    'editor-scripts': FileCode,
    'editor-keys': Keyboard,
    'editor-variables': Braces,
    'editor-module': Blocks,
    'editor-activate': Power,
    'editor-add': Plus,
    'editor-add-group': FolderPlus,
    'editor-chevron-down': ChevronDown,
    'editor-clear': X,
    'editor-copy': Copy,
    'editor-debug': Bug,
    'editor-delete': Trash2,
    'editor-errors': CircleAlert,
    'editor-export': ArrowUpFromLine,
    'editor-filter': Funnel,
    'editor-folder': Folder,
    'editor-hidden': EyeOff,
    'editor-import': ArrowDownToLine,
    'editor-new-folder': FolderPlus,
    'editor-new-item': FilePlus,
    'editor-notice-error': CircleX,
    'editor-notice-info': Info,
    'editor-notice-warning': TriangleAlert,
    'editor-offset-timer': TimerReset,
    'editor-options': SlidersHorizontal,
    'editor-paste': ClipboardPaste,
    'editor-redo': Redo2,
    'editor-save-item': Save,
    'editor-save-profile': SaveAll,
    'editor-statistics': ChartColumn,
    'editor-type-boolean': ToggleLeft,
    'editor-type-function': SquareFunction,
    'editor-type-number': Hash,
    'editor-type-other': Box,
    'editor-type-string': Quote,
    'editor-undo': Undo2,
    // Settings sidebar (dlgProfilePreferences.cpp)
    'settings-accessibility': Accessibility,
    'settings-advanced': Wrench,
    'settings-appearance': Palette,
    'settings-chat': MessagesSquare,
    'settings-connection': Globe,
    'settings-display': Monitor,
    'settings-editor': FileCode,
    'settings-general': SlidersHorizontal,
    'settings-input': Terminal,
    'settings-mapper': MapIcon,
    'settings-privacy': ShieldCheck,
    'settings-search': Search,
    'settings-shortcuts': Keyboard,
    'settings-support': CircleHelp,
    // Package manager / exporter
    'packages-install': Download,
    'packages-install-file': FolderOpen,
    'packages-package': Package,
    'packages-update': RefreshCw,
    // Notepad, debug bar, choice marks
    'notepad-chevron-up': ChevronUp,
    'notepad-send-all': Send,
    'notepad-stop': CircleStop,
    'debug-clear': Eraser,
    'debug-pause': Pause,
    'debug-resume': Play,
    'control-check': Check,
    'control-minus': Minus,
    // About dialog
    'about-bug': Bug,
    'about-check': Check,
    'about-chevron-down': ChevronDown,
    'about-chevron-right': ChevronRight,
    'about-docs': BookOpen,
    'about-forums': MessagesSquare,
    'about-homepage': Globe,
    'about-license': Scale,
    'about-mail': Mail,
    'about-mudlet': Info,
    'about-supporters': HeartHandshake,
    'about-swords': Swords,
    'about-third-party': Library,
} satisfies Record<string, LucideIcon>;

export type GlyphName = keyof typeof GLYPHS;

export type GlyphProps = Omit<LucideProps, 'ref'> & (
    | { name: GlyphName; icon?: never }
    /** A Lucide icon desktop has no file for, drawn the same way. */
    | { icon: LucideIcon; name?: never }
);

/** One of desktop's glyphs at the design's stroke width. Decorative by
 *  default: the control it sits in carries the name. */
export function Glyph({ name, icon, size = 16, strokeWidth = GLYPH_STROKE_WIDTH, ...rest }: GlyphProps) {
    const Icon = icon ?? GLYPHS[name!];
    return <Icon size={size} strokeWidth={strokeWidth} aria-hidden="true" focusable="false" {...rest} />;
}
