/**
 * Qt key-sequence parsing, as much of it as deciding whether to accept a
 * package's shortcut needs.
 *
 * Counting the steps in "Ctrl+Alt+F1, Ctrl+Alt+F2" looks like splitting on
 * commas until you meet the two characters that are both punctuation AND keys:
 *
 *   "Ctrl+,"        the comma key. One step, not two of nothing.
 *   "Ctrl++"        the plus key. One step whose last character is the same
 *                   one that joins a modifier to its key.
 *   "Ctrl+,, X"     the comma key, then a separator, then X. Two steps.
 *   "Ctrl++, X"     the plus key, then a separator, then X. Two steps — and
 *                   the reading that looks at what precedes the comma calls
 *                   this one, which is how a five-step sequence slipped past
 *                   the length check to be truncated by Qt after all.
 *
 * So this parses rather than splits: each step is its modifiers, then exactly
 * one key, and only a comma that follows a completed key is a separator. Qt
 * steps over that separator and the single space after it, which is why a
 * sequence written with a trailing one — what generating a list in a loop
 * produces — is the steps it names and not one more of nothing.
 */

import { QT_KEY_NAMES, keyNameToDomCode } from '../../mud/keybindings/qtKeys';

/** Qt's QKeySequence holds this many steps and silently drops the rest. */
export const MAX_STEPS = 4;

/** Every modifier word a step can carry, and what each means to a key binding
 *  — whose modifiers are the {ctrl,shift,alt,meta} names a KeyboardEvent
 *  reports. */
const MODIFIER_NAMES: Record<string, string> = {
    ctrl: 'ctrl', control: 'ctrl',
    alt: 'alt', option: 'alt',
    shift: 'shift',
    meta: 'meta', cmd: 'meta', command: 'meta',
};

const MODIFIERS = new Set(Object.keys(MODIFIER_NAMES));

/** Key names Qt knows that are more than one character long. Function keys are
 *  matched separately, being open-ended. Shared with the Qt→DOM translation,
 *  which has to spell the same set (see qtKeys.KEY_NAME_TO_DOM_CODE). */
const NAMED_KEYS = QT_KEY_NAMES;

export interface SequenceProblem {
    /** 'length' when the sequence has more steps than Qt can hold, 'key' when a
     *  step names something Qt cannot read. */
    kind: 'length' | 'key';
    /** The unreadable chunk, for a 'key' problem. */
    chunk?: string;
}

/** Whether Qt could read `token` as the key half of a step. */
function isKey(token: string): boolean {
    if (token.length === 0) return false;
    const lower = token.toLowerCase();
    if (token.length === 1) return true;               // any single character
    if (/^f([1-9]|[12]\d|3[0-5])$/.test(lower)) return true;  // F1 … F35
    return NAMED_KEYS.has(lower);
}

/**
 * The steps in a Qt key sequence, or a problem describing why it is not one.
 * An empty (or whitespace-only) shortcut is no shortcut at all and parses to
 * zero steps, which is not an error — a command may simply have no key.
 */
export function parseKeySequence(shortcut: string): { steps: string[] } | { problem: SequenceProblem } {
    const steps: string[] = [];
    let i = 0;
    const text = shortcut;

    const skipSpaces = () => { while (i < text.length && text[i] === ' ') i++; };

    skipSpaces();
    while (i < text.length) {
        const stepStart = i;
        // Modifiers, each ending in the '+' that joins it to what follows. A
        // '+' that is not preceded by a modifier word is the plus KEY, and the
        // loop below leaves it alone.
        for (;;) {
            const match = /^([A-Za-z]+)\+/.exec(text.slice(i));
            if (!match || !MODIFIERS.has(match[1].toLowerCase())) break;
            i += match[0].length;
        }
        // Exactly one key. ',' and '+' are keys here rather than punctuation:
        // reaching this point means a modifier has just been consumed, so
        // whatever stands next is what the modifiers apply to.
        let key: string;
        if (i < text.length && (text[i] === ',' || text[i] === '+')) {
            key = text[i];
            i++;
        } else {
            const end = text.indexOf(',', i);
            key = (end === -1 ? text.slice(i) : text.slice(i, end)).trimEnd();
            i += (end === -1 ? text.length - i : end - i);
        }
        if (!isKey(key)) {
            return { problem: { kind: 'key', chunk: text.slice(stepStart, i).trim() || key } };
        }
        steps.push(text.slice(stepStart, i).trim());
        // The separator, and the single space Qt allows after it. A trailing
        // one ends the sequence rather than promising another step.
        skipSpaces();
        if (i < text.length && text[i] === ',') {
            i++;
            skipSpaces();
        }
    }

    if (steps.length > MAX_STEPS) return { problem: { kind: 'length' } };
    return { steps };
}

/**
 * A shortcut as a key binding would hold it: one DOM `KeyboardEvent.code` plus
 * the modifiers pressed with it.
 *
 * Null for anything a binding cannot be: a sequence of more than one step (a
 * binding is one key and its modifiers, so a two-step sequence can never be the
 * one holding it — as `mudlet::addonShortcutUsable` decides with
 * `sequence.count() == 1`), an empty shortcut, or a key the browser has no code
 * for.
 */
export function shortcutAsBinding(shortcut: string): { code: string; modifiers: string[] } | null {
    const parsed = parseKeySequence(shortcut);
    if ('problem' in parsed) return null;
    if (parsed.steps.length !== 1) return null;
    const modifiers: string[] = [];
    let rest = parsed.steps[0];
    for (;;) {
        const match = /^([A-Za-z]+)\+/.exec(rest);
        const name = match && MODIFIER_NAMES[match[1].toLowerCase()];
        if (!match || !name) break;
        if (!modifiers.includes(name)) modifiers.push(name);
        rest = rest.slice(match[0].length);
    }
    const code = keyNameToDomCode(rest);
    return code ? { code, modifiers } : null;
}

/** The refusal a package should read, or null when the sequence is fine. */
export function shortcutProblemMessage(shortcut: string): string | null {
    const parsed = parseKeySequence(shortcut);
    if (!('problem' in parsed)) return null;
    if (parsed.problem.kind === 'length') {
        return `a shortcut can hold at most ${MAX_STEPS} steps and this one has more`
            + ' — Qt keeps the first 4 and drops the rest, binding a key nobody asked for';
    }
    return `'${parsed.problem.chunk}' is not a key sequence this client can read`;
}
