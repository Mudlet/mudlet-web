/**
 * Mudlet's `tempKey(...)` (and Qt-rooted Mudlet bindings in general) reference
 * keys by Qt::Key integer code. The browser KeyEngine matches against
 * `KeyboardEvent.code`, so Lua-supplied Qt codes need a translation step.
 *
 * Coverage focuses on keys scripts actually bind: arrows, function keys,
 * editing keys, navigation, modifiers, letters, digits, numpad, symbols.
 * Qt codes that have no DOM equivalent (Direction_*, screen-control keys,
 * dead keys) fall through and the matcher silently fails — same as Mudlet
 * on platforms where the key isn't reachable.
 *
 * Reference: https://doc.qt.io/qt-6/qt.html#Key-enum
 */
const QT_KEY_TO_DOM_CODE: Record<number, string> = {
    0x01000000: 'Escape',
    0x01000001: 'Tab',
    0x01000002: 'Tab',                // Backtab — DOM has no separate code
    0x01000003: 'Backspace',
    0x01000004: 'Enter',              // Qt::Key_Return → main Enter
    0x01000005: 'NumpadEnter',        // Qt::Key_Enter  → numpad Enter
    0x01000006: 'Insert',
    0x01000007: 'Delete',
    0x01000008: 'Pause',
    0x01000009: 'PrintScreen',
    0x0100000B: 'NumLock',            // Qt::Key_Clear maps to NumLock 5 on PC keyboards
    0x01000010: 'Home',
    0x01000011: 'End',
    0x01000012: 'ArrowLeft',
    0x01000013: 'ArrowUp',
    0x01000014: 'ArrowRight',
    0x01000015: 'ArrowDown',
    0x01000016: 'PageUp',
    0x01000017: 'PageDown',
    0x01000020: 'ShiftLeft',
    0x01000021: 'ControlLeft',
    0x01000022: 'MetaLeft',
    0x01000023: 'AltLeft',
    0x01000024: 'AltRight',           // Qt::Key_AltGr
    0x01000025: 'CapsLock',
    0x01000026: 'NumLock',
    0x01000027: 'ScrollLock',
    0x01000030: 'F1',
    0x01000031: 'F2',
    0x01000032: 'F3',
    0x01000033: 'F4',
    0x01000034: 'F5',
    0x01000035: 'F6',
    0x01000036: 'F7',
    0x01000037: 'F8',
    0x01000038: 'F9',
    0x01000039: 'F10',
    0x0100003A: 'F11',
    0x0100003B: 'F12',
    0x0100003C: 'F13',
    0x0100003D: 'F14',
    0x0100003E: 'F15',
    0x0100003F: 'F16',
    0x01000040: 'F17',
    0x01000041: 'F18',
    0x01000042: 'F19',
    0x01000043: 'F20',
    0x01000044: 'F21',
    0x01000045: 'F22',
    0x01000046: 'F23',
    0x01000047: 'F24',
    0x01000053: 'ContextMenu',        // Qt::Key_Menu

    // ASCII-range Qt codes coincide with character codes. 0–9 → DigitN,
    // A–Z → KeyN. Both are the values `event.code` reports for top-row
    // digits and the alpha row.
    0x20: 'Space',
    0x21: 'Digit1',                   // ! shares DOM code with 1
    0x22: 'Quote',                    // "
    0x23: 'Digit3',                   // #
    0x24: 'Digit4',                   // $
    0x25: 'Digit5',                   // %
    0x26: 'Digit7',                   // &
    0x27: 'Quote',                    // '
    0x28: 'Digit9',                   // (
    0x29: 'Digit0',                   // )
    0x2A: 'Digit8',                   // *
    0x2B: 'Equal',                    // +
    0x2C: 'Comma',                    // ,
    0x2D: 'Minus',                    // -
    0x2E: 'Period',                   // .
    0x2F: 'Slash',                    // /
    0x3A: 'Semicolon',                // :
    0x3B: 'Semicolon',                // ;
    0x3C: 'Comma',                    // <
    0x3D: 'Equal',                    // =
    0x3E: 'Period',                   // >
    0x3F: 'Slash',                    // ?
    0x40: 'Digit2',                   // @
    0x5B: 'BracketLeft',              // [
    0x5C: 'Backslash',
    0x5D: 'BracketRight',
    0x5E: 'Digit6',                   // ^
    0x5F: 'Minus',                    // _
    0x60: 'Backquote',
    0x7B: 'BracketLeft',              // {
    0x7C: 'Backslash',                // |
    0x7D: 'BracketRight',             // }
    0x7E: 'Backquote',                // ~
};

/**
 * Keypad overrides: when Qt::KeypadModifier is set, these ASCII-range codes
 * resolve to their Numpad* DOM-code variants rather than the main-keyboard
 * equivalents. Digits 0–9 are handled by the range check (no table entry).
 */
const QT_KEYPAD_OVERRIDES: Record<number, string> = {
    0x2A: 'NumpadMultiply',           // *
    0x2B: 'NumpadAdd',                // +
    0x2D: 'NumpadSubtract',           // -
    0x2E: 'NumpadDecimal',            // .
    0x2F: 'NumpadDivide',             // /
    0x3D: 'NumpadEqual',              // =
};

/** Qt::KeypadModifier — set by Mudlet when a binding came from the numpad. */
export const QT_KEYPAD_MODIFIER = 0x20000000;

/** Qt::Key_unknown — what Mudlet stores for a key item with nothing bound to it. */
export const QT_KEY_UNKNOWN = 0x01ffffff;

/**
 * Translate a Qt::Key integer (or already-translated DOM `KeyboardEvent.code`
 * string) into a DOM `KeyboardEvent.code`. Mudlet `tempKey` accepts both;
 * passing a string straight through lets users pre-resolve when they prefer.
 *
 * When `modifier` includes Qt::KeypadModifier, digit and symbol codes resolve
 * to their Numpad* DOM variants — DOM `KeyboardEvent.code` distinguishes
 * numpad keys from the main keyboard while Qt::Key alone does not.
 */
export function qtKeyToDomCode(key: string | number, modifier = 0): string {
    if (typeof key === 'string') return key;
    if (!Number.isFinite(key)) return String(key);

    if ((modifier & QT_KEYPAD_MODIFIER) !== 0) {
        if (key >= 0x30 && key <= 0x39) return 'Numpad' + String.fromCharCode(key);
        const numpad = QT_KEYPAD_OVERRIDES[key];
        if (numpad) return numpad;
    }

    // Digit row: Qt::Key_0..Key_9 == 0x30..0x39
    if (key >= 0x30 && key <= 0x39) return 'Digit' + String.fromCharCode(key);
    // Alpha row: Qt::Key_A..Key_Z == 0x41..0x5A
    if (key >= 0x41 && key <= 0x5A) return 'Key' + String.fromCharCode(key);

    return QT_KEY_TO_DOM_CODE[key] ?? String(key);
}

/**
 * Translate a Qt::KeyboardModifier bitmask into an array of modifier names
 * that match the {ctrl,shift,alt,meta} strings KeyEngine compares against.
 *
 * Qt::ShiftModifier   = 0x02000000
 * Qt::ControlModifier = 0x04000000
 * Qt::AltModifier     = 0x08000000
 * Qt::MetaModifier    = 0x10000000
 * Qt::KeypadModifier  = 0x20000000  (ignored — DOM `code` already encodes "Numpad*")
 * Qt::GroupSwitchMod. = 0x40000000  (ignored — X11-only)
 */
export function qtModifiersToList(modifier: number): string[] {
    const mods: string[] = [];
    if (modifier & 0x04000000) mods.push('ctrl');
    if (modifier & 0x02000000) mods.push('shift');
    if (modifier & 0x08000000) mods.push('alt');
    if (modifier & 0x10000000) mods.push('meta');
    return mods;
}

/** Inverse of qtModifiersToList — {ctrl,shift,alt,meta} names → Qt bitmask. */
export function listToQtModifiers(modifiers: string[]): number {
    let m = 0;
    if (modifiers.includes('ctrl')) m |= 0x04000000;
    if (modifiers.includes('shift')) m |= 0x02000000;
    if (modifiers.includes('alt')) m |= 0x08000000;
    if (modifiers.includes('meta')) m |= 0x10000000;
    return m;
}

// Inverse of QT_KEY_TO_DOM_CODE. The forward map is many-to-one (e.g. both
// 0x21 '!' and the digit row land on 'Digit1'); first-writer-wins collapses each
// DOM code to one canonical Qt key, which round-trips ordinary binds. The
// digit/letter/numpad ranges are handled directly in domCodeToQtKey below.
const DOM_CODE_TO_QT_KEY: Record<string, number> = (() => {
    const r: Record<string, number> = {};
    for (const [qt, code] of Object.entries(QT_KEY_TO_DOM_CODE)) {
        if (!(code in r)) r[code] = Number(qt);
    }
    return r;
})();

/**
 * Inverse of qtKeyToDomCode for the common case — a DOM `KeyboardEvent.code`
 * back to a Qt::Key integer. Used by getKeyCode() to report a permanent key
 * binding (stored as a DOM code) in Mudlet's Qt terms. Returns undefined for a
 * code with no Qt mapping.
 */
export function domCodeToQtKey(code: string): number | undefined {
    const letter = /^Key([A-Z])$/.exec(code);
    if (letter) return letter[1].charCodeAt(0); // 'A' → 0x41 (Qt::Key_A)
    const digit = /^Digit([0-9])$/.exec(code);
    if (digit) return digit[1].charCodeAt(0);    // '0' → 0x30 (Qt::Key_0)
    const numpad = /^Numpad([0-9])$/.exec(code);
    if (numpad) return numpad[1].charCodeAt(0);
    return DOM_CODE_TO_QT_KEY[code];
}
