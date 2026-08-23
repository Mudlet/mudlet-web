/**
 * Some keyboard shortcuts are owned by the browser (or the OS) and are handled
 * *above* the web page — Ctrl+T opens a new tab, Ctrl+W closes it, F12 opens
 * devtools. The page never receives the keydown (or can't suppress it), so a MUD
 * keybinding on one of these can never fire in mudix.
 *
 * Real Mudlet runs natively and binds these freely; opened in a browser they
 * silently do nothing, which is baffling. We scan the loaded keybindings on
 * profile open (and temp keys as scripts register them) and warn about the ones
 * the browser intercepts.
 *
 * We deliberately do NOT warn about page-level shortcuts the browser owns but a
 * page can still capture with preventDefault — Ctrl+R (reload), Ctrl+S (save),
 * Ctrl+P (print), Ctrl+F (find), F5, Ctrl+L, etc. mudix intercepts those, so they
 * work exactly like they do in Mudlet: while the client has keyboard focus.
 *
 * Keys are stored as DOM `KeyboardEvent.code` strings (see {@link KeyNode}), so we
 * match against codes like `KeyT`, `Digit1`, `F12`.
 */
import type { KeyNode } from '../../storage/schema';

export interface ReservedKeyWarning {
    node: KeyNode;
    combo: string;   // human-readable, e.g. "Ctrl+T"
    action: string;  // what the browser does, e.g. "open a new browser tab"
}

/** Platform accelerator — browser shortcuts use Cmd (meta) on macOS, Ctrl elsewhere. */
export type Accel = 'ctrl' | 'meta';

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const;
const MODIFIER_LABELS: Record<string, string> = {
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    meta: 'Cmd',
};

/** Detect the platform accelerator modifier, from `navigator.platform` on every
 *  call. Note that a `navigator` exists under vitest's node environment too, and
 *  reports the real host — so this is not a Ctrl fallback in tests, and a test
 *  that hard-codes one accelerator will pass on CI and fail on a Mac. Callers
 *  that need a fixed platform should pass `accel` explicitly. */
export function detectAccel(): Accel {
    if (typeof navigator !== 'undefined') {
        const platform =
            navigator.platform ||
            (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ||
            '';
        if (/mac|iphone|ipad|ipod/i.test(platform)) return 'meta';
    }
    return 'ctrl';
}

/** DOM `KeyboardEvent.code` → friendly single-key label for the combo display. */
function keyLabel(code: string): string {
    const letter = /^Key([A-Z])$/.exec(code);
    if (letter) return letter[1];
    const digit = /^Digit([0-9])$/.exec(code);
    if (digit) return digit[1];
    return code; // F11, F12, Tab, PageUp, ... already read well
}

/** Render a keybinding as a display combo like "Ctrl+Shift+I". */
export function formatKeyCombo(node: Pick<KeyNode, 'key' | 'modifiers'>): string {
    const mods = MODIFIER_ORDER.filter(m => node.modifiers.includes(m)).map(m => MODIFIER_LABELS[m]);
    return [...mods, keyLabel(node.key)].join('+');
}

/** Explanation appended to each warning line. */
export function reservedKeyNote(action: string): string {
    return `the browser will ${action} — this key can't reach mudix`;
}

interface ReservedDef {
    code: string;
    /** Required modifiers; the token `accel` resolves to the platform accelerator. */
    mods: Array<'accel' | 'ctrl' | 'shift' | 'alt' | 'meta'>;
    action: string;
}

const TAB_JUMP: ReservedDef[] = ['1', '2', '3', '4', '5', '6', '7', '8'].map(d => ({
    code: `Digit${d}`,
    mods: ['accel'],
    action: `jump to browser tab ${d}`,
}));

// Combos the browser handles above the page — a page can't capture these, so a
// keybinding on one never fires. `accel` is Ctrl (or Cmd on macOS); a few
// tab-navigation shortcuts use Ctrl literally on every platform.
const RESERVED: ReservedDef[] = [
    // ── Tab & window management ──
    { code: 'KeyT', mods: ['accel'], action: 'open a new browser tab' },
    { code: 'KeyN', mods: ['accel'], action: 'open a new browser window' },
    { code: 'KeyW', mods: ['accel'], action: 'close the browser tab' },
    { code: 'KeyT', mods: ['accel', 'shift'], action: 'reopen the last closed tab' },
    { code: 'KeyN', mods: ['accel', 'shift'], action: 'open a private/incognito window' },
    { code: 'KeyW', mods: ['accel', 'shift'], action: 'close the browser window' },
    { code: 'Tab', mods: ['ctrl'], action: 'switch browser tabs' },
    { code: 'Tab', mods: ['ctrl', 'shift'], action: 'switch browser tabs' },
    { code: 'PageUp', mods: ['accel'], action: 'switch browser tabs' },
    { code: 'PageDown', mods: ['accel'], action: 'switch browser tabs' },
    ...TAB_JUMP,
    { code: 'Digit9', mods: ['accel'], action: 'jump to the last browser tab' },

    // ── Developer tools & fullscreen ──
    { code: 'F11', mods: [], action: 'toggle browser fullscreen' },
    { code: 'F12', mods: [], action: 'open developer tools' },
    { code: 'KeyI', mods: ['accel', 'shift'], action: 'open developer tools' },
    { code: 'KeyJ', mods: ['accel', 'shift'], action: 'open developer tools' },
    { code: 'KeyC', mods: ['accel', 'shift'], action: 'open the element inspector' },
];

function canonicalMods(mods: readonly string[]): string {
    return MODIFIER_ORDER.filter(m => mods.includes(m)).join('+');
}

function resolveMods(mods: ReservedDef['mods'], accel: Accel): string[] {
    return mods.map(m => (m === 'accel' ? accel : m));
}

/**
 * Classify a single keybinding against the browser-reserved set. Returns the
 * browser action it collides with, or null when the combo is safe to bind.
 */
export function classifyReservedKey(
    node: Pick<KeyNode, 'key' | 'modifiers'>,
    accel: Accel = detectAccel(),
): string | null {
    if (!node.key) return null;
    const sig = canonicalMods(node.modifiers);
    for (const def of RESERVED) {
        if (def.code !== node.key) continue;
        if (canonicalMods(resolveMods(def.mods, accel)) !== sig) continue;
        return def.action;
    }
    return null;
}

/**
 * Scan a list of keybindings and return a warning for each one the browser
 * intercepts. Group nodes and keyless nodes are skipped; the caller is expected
 * to pass the effectively-enabled bindings (disabled binds never fire, so
 * warning about them would be noise).
 */
export function findReservedKeybindings(
    keys: KeyNode[],
    accel: Accel = detectAccel(),
): ReservedKeyWarning[] {
    const out: ReservedKeyWarning[] = [];
    for (const node of keys) {
        if (node.isGroup || !node.key) continue;
        const action = classifyReservedKey(node, accel);
        if (action) out.push({ node, combo: formatKeyCombo(node), action });
    }
    return out;
}
