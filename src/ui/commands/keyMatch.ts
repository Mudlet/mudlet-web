/**
 * Turning a keypress and a Qt key sequence into the same string, so the two can
 * be compared.
 *
 * `keySequence.ts` reads a sequence the way Qt writes one — "Ctrl+Alt+F1,
 * Ctrl+Alt+F2" — and says how many steps it has. This is the other half: one
 * step in a canonical spelling, and a `KeyboardEvent` reduced to the same
 * spelling. Neither side is authoritative about capitalisation or modifier
 * order, so both go through `canonicalStep` before anything is compared.
 *
 * The key half comes from `KeyboardEvent.code`, the physical key, rather than
 * `.key`. With Alt held, `.key` is whatever the layout produces — on a Mac
 * Alt+E is "´", on a German layout Alt+L is "@" — so a menu accelerator read
 * from `.key` fires on a different key on every layout. `.code` is also what
 * this client's own Lua keybindings match on (`qtKeys.ts`), so the two agree.
 */
import { parseKeySequence } from './keySequence';

/** Modifier spellings Qt accepts, mapped onto the four it actually has. */
const MODIFIER_ALIASES: Record<string, string> = {
    ctrl: 'ctrl', control: 'ctrl',
    alt: 'alt', option: 'alt',
    shift: 'shift',
    meta: 'meta', cmd: 'meta', command: 'meta',
};

/** The order modifiers are written in, so two spellings of one combination
 *  compare equal. Qt's own order, and the one the settings list shows. */
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const;

/**
 * One step in its canonical spelling: modifiers in a fixed order, lower case,
 * joined to the key by '+'. "Ctrl+Alt+L", "alt+ctrl+l" and "CTRL+ALT+L" all
 * become "ctrl+alt+l".
 */
export function canonicalStep(step: string): string {
    let rest = step.trim();
    const found = new Set<string>();
    for (;;) {
        // A word followed by '+'. Only consumed when the word is a modifier —
        // otherwise it is the key, and "Ctrl++" is the plus key rather than a
        // modifier named "".
        const match = /^([A-Za-z]+)\+/.exec(rest);
        if (!match) break;
        const modifier = MODIFIER_ALIASES[match[1].toLowerCase()];
        if (!modifier) break;
        found.add(modifier);
        rest = rest.slice(match[0].length);
    }
    const key = rest.trim().toLowerCase();
    return [...MODIFIER_ORDER.filter(m => found.has(m)), key].join('+');
}

/** A whole sequence as canonical steps, or null when Qt could not read it. */
export function canonicalSequence(shortcut: string): string[] | null {
    if (!shortcut.trim()) return null;
    const parsed = parseKeySequence(shortcut);
    if ('problem' in parsed) return null;
    return parsed.steps.map(canonicalStep);
}

/** Named keys whose DOM code differs from the name Qt writes. Everything not
 *  listed and not a letter, digit or function key is taken as-is, lowercased. */
const CODE_NAMES: Record<string, string> = {
    Escape: 'esc', Enter: 'return', NumpadEnter: 'enter', Space: 'space', Tab: 'tab',
    Backspace: 'backspace', Delete: 'del', Insert: 'ins',
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    PageUp: 'pgup', PageDown: 'pgdown', Home: 'home', End: 'end',
    CapsLock: 'capslock', NumLock: 'numlock', ScrollLock: 'scrolllock', Pause: 'pause',
    PrintScreen: 'print', ContextMenu: 'menu',
    Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Backquote: '`', Minus: '-', Equal: '=',
    NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/',
    NumpadDecimal: '.',
};

/** The key half of a step, from a physical key code. Null for a modifier key
 *  pressed on its own — holding Ctrl is not yet a shortcut. */
export function keyNameFromCode(code: string): string | null {
    if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code)) return null;
    const letter = /^Key([A-Z])$/.exec(code);
    if (letter) return letter[1].toLowerCase();
    const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
    if (digit) return digit[1];
    if (/^F([1-9]|[12]\d|3[0-5])$/.test(code)) return code.toLowerCase();
    return CODE_NAMES[code] ?? null;
}

/** A keypress in the same spelling as `canonicalStep`, or null when it is not
 *  a key a shortcut can be built from. */
export function stepFromEvent(e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string | null {
    const key = keyNameFromCode(e.code);
    if (!key) return null;
    const parts: string[] = [];
    if (e.ctrlKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    if (e.metaKey) parts.push('meta');
    parts.push(key);
    return parts.join('+');
}

/** Whether a step carries a modifier. A bare key is not safe to dispatch while
 *  the player is typing into something. */
export function stepHasModifier(step: string): boolean {
    return step.includes('+');
}

/** Written the way a person reads it: "Ctrl+Alt+L", "Alt+E", "F3". Steps in a
 *  multi-step sequence are joined with ", " as Qt writes them. */
export function formatSequence(steps: readonly string[]): string {
    const labels: Record<string, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Cmd' };
    return steps.map(step => {
        const parts = step.split('+');
        // The key is the last part — except for the '+' key itself, which
        // splits into a trailing empty string.
        const key = parts[parts.length - 1] === '' ? '+' : parts[parts.length - 1];
        const mods = parts.slice(0, parts[parts.length - 1] === '' ? -2 : -1);
        const keyLabel = key.length === 1 ? key.toUpperCase() : key.replace(/^f(\d+)$/, 'F$1');
        return [...mods.map(m => labels[m] ?? m), keyLabel].join('+');
    }).join(', ');
}
