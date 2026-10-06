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
    // Values from Qt's qnamespace.h: Key_CapsLock follows Key_Alt directly,
    // and Key_AltGr sits out at 0x01001103 with the international keys.
    0x01000024: 'CapsLock',           // Qt::Key_CapsLock
    0x01000025: 'NumLock',            // Qt::Key_NumLock
    0x01000026: 'ScrollLock',         // Qt::Key_ScrollLock
    0x01001103: 'AltRight',           // Qt::Key_AltGr
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
    // 0x01000053/54 are Key_Super_L/R, not the menu key.
    0x01000055: 'ContextMenu',        // Qt::Key_Menu

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

/** Qt::KeyboardModifier bits. */
export const QT_SHIFT_MODIFIER   = 0x02000000;
export const QT_CONTROL_MODIFIER = 0x04000000;
export const QT_ALT_MODIFIER     = 0x08000000;
export const QT_META_MODIFIER    = 0x10000000;

/**
 * Translate a Qt::KeyboardModifier bitmask into an array of modifier names
 * that match the {ctrl,shift,alt,meta,keypad} strings KeyEngine compares
 * against.
 *
 * Qt::KeypadModifier is kept as `keypad`: desktop's key matcher compares the
 * whole mask, so a binding on Keypad+Up (numpad 8 with NumLock off) is a
 * different key from the arrow, and `ArrowUp` alone cannot say which one it
 * is. A Numpad* DOM code says it by itself, so `keypad` is redundant there but
 * harmless. Qt::GroupSwitchModifier (0x40000000, X11-only) is ignored.
 */
export function qtModifiersToList(modifier: number): string[] {
    const mods: string[] = [];
    if (modifier & QT_CONTROL_MODIFIER) mods.push('ctrl');
    if (modifier & QT_SHIFT_MODIFIER) mods.push('shift');
    if (modifier & QT_ALT_MODIFIER) mods.push('alt');
    if (modifier & QT_META_MODIFIER) mods.push('meta');
    if (modifier & QT_KEYPAD_MODIFIER) mods.push('keypad');
    return mods;
}

/** Inverse of qtModifiersToList — {ctrl,shift,alt,meta,keypad} names → Qt bitmask. */
export function listToQtModifiers(modifiers: string[]): number {
    let m = 0;
    if (modifiers.includes('ctrl')) m |= QT_CONTROL_MODIFIER;
    if (modifiers.includes('shift')) m |= QT_SHIFT_MODIFIER;
    if (modifiers.includes('alt')) m |= QT_ALT_MODIFIER;
    if (modifiers.includes('meta')) m |= QT_META_MODIFIER;
    if (modifiers.includes('keypad')) m |= QT_KEYPAD_MODIFIER;
    return m;
}

/** Whether a stored binding is on the numpad: flagged `keypad`, or on a
 *  Numpad* DOM code (which only the numpad reports). */
export function isKeypadBinding(key: string, modifiers: readonly string[]): boolean {
    return modifiers.includes('keypad') || key.startsWith('Numpad');
}

/** A stored binding's Qt modifier mask, as desktop's getKeyCode and XML would
 *  carry it — the Keypad bit included for a Numpad* code (Key_Enter too: Qt
 *  reports the numpad Enter as Key_Enter with KeypadModifier). */
export function bindingQtModifiers(key: string, modifiers: string[]): number {
    return listToQtModifiers(modifiers) | (isKeypadBinding(key, modifiers) ? QT_KEYPAD_MODIFIER : 0);
}

/**
 * Whether a Qt::Key is a printable character — the ASCII and Latin-1 ranges,
 * where Qt::Key IS the (upper-cased) character the press produced. Qt reports
 * the character, not the key's position: Shift+1 is Key_Exclam on a US layout,
 * while on French AZERTY the same key gives Key_Ampersand plain and Key_1 with
 * Shift, and its A key (US Q) is Key_A. So a binding on one of these is matched
 * by the character the browser says was typed, never by the US position its
 * DOM code names.
 */
export function isPrintableQtKey(key: number | undefined): key is number {
    return key !== undefined && ((key >= 0x20 && key <= 0x7e) || (key >= 0xa0 && key <= 0xff));
}

/**
 * The printable Qt::Key a press produced, from `KeyboardEvent.key` — upper-cased
 * as Qt does (Key_A for `a`, Key_Eacute 0xC9 for `é`). Undefined when the press
 * named no single printable character (`Dead`, `Unidentified`, a named key, or a
 * script beyond Latin-1), in which case its position is all there is to go on.
 */
export function printableEventQtKey(e: Pick<KeyboardEvent, 'key' | 'altKey'>): number | undefined {
    // Option rewrites the character on a Mac (Option+A types `å`), but Qt
    // keys the press by the character without it, so the browser's `key` says
    // nothing Qt would; the position has to do.
    if (e.altKey && isMacPlatform()) return undefined;
    const key = e.key ?? '';
    if (key.length !== 1) return undefined;
    const upper = key.toUpperCase();
    // 'ÿ' upper-cases out of Latin-1 and 'ß' to two letters; Qt keeps both as is.
    const c = upper.length === 1 && upper.charCodeAt(0) <= 0xff ? upper.charCodeAt(0) : key.charCodeAt(0);
    return isPrintableQtKey(c) ? c : undefined;
}

/** Whether this browser runs on macOS, where Qt sets KeypadModifier on the
 *  arrow keys (they count as part of the keypad there, per Qt's docs), and
 *  takes the key from the character typed *without* Option. */
export function isMacPlatform(): boolean {
    if (typeof navigator === 'undefined') return false;
    const platform = navigator.platform
        || (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform
        || '';
    return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * Whether Qt would report this press with KeypadModifier: every numpad key,
 * and on macOS the arrow keys too. A binding desktop recorded on a Mac for
 * Alt+Up carries the Keypad bit, and matching it against the arrows (as desktop
 * on a Mac does) needs this; elsewhere the arrows are not the keypad.
 */
export function isQtKeypadEvent(e: Pick<KeyboardEvent, 'code' | 'location'>): boolean {
    return isKeypadEvent(e) || (isMacPlatform() && /^Arrow(Up|Down|Left|Right)$/.test(e.code ?? ''));
}

/** Whether a press is a numpad key, whatever NumLock makes of it. */
export function isKeypadEvent(e: Pick<KeyboardEvent, 'code' | 'location'>): boolean {
    return e.location === 3 /* DOM_KEY_LOCATION_NUMPAD */ || (e.code ?? '').startsWith('Numpad');
}

/** The `KeyboardEvent.key` names a numpad key reports with NumLock off, as the
 *  Qt::Key desktop gets for them (Key_Up|Keypad and so on). */
const KEYPAD_NAV_KEY_TO_QT: Record<string, number> = {
    ArrowUp: 0x01000013, ArrowDown: 0x01000015, ArrowLeft: 0x01000012, ArrowRight: 0x01000014,
    Home: 0x01000010, End: 0x01000011, PageUp: 0x01000016, PageDown: 0x01000017,
    Insert: 0x01000006, Delete: 0x01000007, Clear: 0x0100000B, Enter: 0x01000005,
};

/**
 * The Qt::Key desktop would get for a numpad press. Unlike `code`, which is
 * `Numpad8` whatever NumLock says, Qt reports what the key produced: Key_8 with
 * NumLock on, Key_Up with it off — which is how a NumLock-off walking binding
 * and a NumLock-on digit binding stay apart. Falls back to the code when the
 * browser gives no usable `key`.
 */
export function keypadEventQtKey(e: Pick<KeyboardEvent, 'code' | 'key'>): number | undefined {
    const key = e.key ?? '';
    if (key.length === 1) return key.toUpperCase().charCodeAt(0);
    const nav = KEYPAD_NAV_KEY_TO_QT[key];
    if (nav !== undefined) return nav;
    return domCodeToQtKey(e.code ?? '');
}

/**
 * The Qt::Key desktop would record for a press, for the key recorder: the
 * character it produced in the printable range (`!` for Shift+1 on a US
 * layout, `&` for the same key on AZERTY, upper case for letters, as Qt::Key_A
 * is), the numpad's NumLock-dependent key, and
 * otherwise the code's own key.
 */
export function eventQtKey(e: Pick<KeyboardEvent, 'code' | 'key' | 'location' | 'altKey'>): number | undefined {
    if (isQtKeypadEvent(e)) return keypadEventQtKey(e);
    return printableEventQtKey(e) ?? domCodeToQtKey(e.code ?? '');
}

/**
 * A press as the key + modifiers a binding stores. A numpad key with NumLock
 * off is stored under the key it produced (`ArrowUp`) and flagged `keypad`, so
 * it records the same Key_Up|Keypad desktop's recorder would.
 */
export function bindingFromEvent(e: KeyboardEvent): { key: string; modifiers: string[]; qtKey?: number } {
    const modifiers: string[] = [];
    if (e.ctrlKey)  modifiers.push('ctrl');
    if (e.shiftKey) modifiers.push('shift');
    if (e.altKey)   modifiers.push('alt');
    if (e.metaKey)  modifiers.push('meta');
    const qtKey = eventQtKey(e);
    if (isQtKeypadEvent(e)) {
        modifiers.push('keypad');
        if (KEYPAD_NAV_KEY_TO_QT[e.key] !== undefined && e.key !== 'Enter') {
            return { key: e.key, modifiers, qtKey };
        }
    }
    return { key: e.code, modifiers, qtKey };
}

// Inverse of QT_KEY_TO_DOM_CODE. The forward map is many-to-one (e.g. both
// 0x3A ':' and 0x3B ';' land on 'Semicolon'), so each DOM code needs one
// canonical Qt key: the one desktop Mudlet records for that key pressed on its
// own, i.e. the unshifted character (';' 59, '=' 61, "'" 39) — what a key item
// saved by desktop carries and what its key matcher compares against. First
// writer wins otherwise, and integer keys iterate in ascending order, which
// would pick the shifted ':' / '+' / '"' — hence the explicit overrides.
// The digit/letter/numpad-digit ranges are handled directly in domCodeToQtKey.
const DOM_CODE_CANONICAL_QT_KEY: Record<string, number> = {
    Quote: 0x27,                      // '  (not ")
    Equal: 0x3D,                      // =  (not +)
    Semicolon: 0x3B,                  // ;  (not :)
    NumLock: 0x01000025,             // Qt::Key_NumLock (not Key_Clear)
};

const DOM_CODE_TO_QT_KEY: Record<string, number> = (() => {
    const r: Record<string, number> = { ...DOM_CODE_CANONICAL_QT_KEY };
    for (const [qt, code] of Object.entries(QT_KEY_TO_DOM_CODE)) {
        if (!(code in r)) r[code] = Number(qt);
    }
    // Numpad symbols share their Qt::Key with the main keyboard; the numpad is
    // told apart by Qt::KeypadModifier, which the caller adds.
    for (const [qt, code] of Object.entries(QT_KEYPAD_OVERRIDES)) {
        if (!(code in r)) r[code] = Number(qt);
    }
    return r;
})();

/**
 * Inverse of qtKeyToDomCode — a DOM `KeyboardEvent.code` back to a Qt::Key
 * integer. Used by getKeyCode() to report a permanent key binding (stored as a
 * DOM code) in Mudlet's Qt terms, and by the Mudlet XML export to write a key
 * item's `<keyCode>`. Numpad codes return the shared main-keyboard Qt::Key; the
 * keypad flag lives in the modifier. Returns undefined for a code with no Qt
 * mapping.
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

/**
 * The names Qt's `QKeySequence` gives the keys that are more than one character
 * long, and the DOM `KeyboardEvent.code` each one means — so a shortcut written
 * the way Qt writes one ("Alt+F9", "Ctrl+Left") can be compared against a key
 * binding, which is stored as a DOM code.
 *
 * `null` where Qt can name a key the browser has no code for: no binding can
 * hold one, so nothing can clash over it. Function keys and the printable
 * single characters are not here — they go through {@link keyNameToDomCode}'s
 * own arms, which reach the ASCII half of QT_KEY_TO_DOM_CODE above.
 */
const KEY_NAME_TO_DOM_CODE: Record<string, string | null> = {
    space: 'Space', tab: 'Tab', backtab: 'Tab', backspace: 'Backspace',
    return: 'Enter', enter: 'NumpadEnter',
    ins: 'Insert', insert: 'Insert', del: 'Delete', delete: 'Delete',
    pause: 'Pause', print: 'PrintScreen', sysreq: null, clear: 'NumLock',
    home: 'Home', end: 'End',
    left: 'ArrowLeft', up: 'ArrowUp', right: 'ArrowRight', down: 'ArrowDown',
    pgup: 'PageUp', pageup: 'PageUp', pgdown: 'PageDown', pagedown: 'PageDown',
    capslock: 'CapsLock', numlock: 'NumLock', scrolllock: 'ScrollLock',
    esc: 'Escape', escape: 'Escape', menu: 'ContextMenu', help: 'Help',
    back: 'BrowserBack', forward: 'BrowserForward', stop: 'BrowserStop',
    refresh: 'BrowserRefresh',
    volumedown: 'AudioVolumeDown', volumemute: 'AudioVolumeMute', volumeup: 'AudioVolumeUp',
    mediaplay: 'MediaPlayPause', mediastop: 'MediaStop',
    mediaprevious: 'MediaTrackPrevious', medianext: 'MediaTrackNext',
    mediarecord: null, mediapause: null,
};

/** Every key name a Qt key sequence can spell out — what a shortcut parser has
 *  to recognise as the key half of a step. */
export const QT_KEY_NAMES: ReadonlySet<string> = new Set(Object.keys(KEY_NAME_TO_DOM_CODE));

/**
 * One key of a Qt key sequence ("F9", "Left", ",", "k") as the DOM
 * `KeyboardEvent.code` a key binding stores it under. Null when the name is not
 * a key Qt would read, or names one the browser cannot report.
 */
export function keyNameToDomCode(name: string): string | null {
    const lower = name.toLowerCase();
    if (lower in KEY_NAME_TO_DOM_CODE) return KEY_NAME_TO_DOM_CODE[lower];
    const fkey = /^f([1-9]|[12]\d|3[0-5])$/.exec(lower);
    if (fkey) return Number(fkey[1]) <= 24 ? `F${fkey[1]}` : null;
    if (name.length !== 1) return null;
    // A single character IS its Qt key code in the ASCII range, which is how
    // QT_KEY_TO_DOM_CODE spells the punctuation keys; letters are upper-cased
    // because Qt::Key_A is 'A'.
    const qt = name.toUpperCase().charCodeAt(0);
    const code = qtKeyToDomCode(qt);
    return code === String(qt) ? null : code;
}
