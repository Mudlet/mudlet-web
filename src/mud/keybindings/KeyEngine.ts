import { ItemIdSequence } from '../ItemIdSequence';
import type { KeyNode } from '../../storage/schema';
import { buildEffectivelyEnabledIds, inTreeOrder } from '../../storage/schema';
import {
    bindingQtModifiers, domCodeToQtKey, isKeypadBinding, isPrintableQtKey, isQtKeypadEvent,
    keypadEventQtKey, printableEventQtKey,
} from './qtKeys';

export type { KeyNode };

type TempFn = () => void;

/** Mudlet getKeyCode() result — a Qt::Key integer + Qt::KeyboardModifier mask. */
export interface KeyCodeInfo {
    keyCode: number;
    modifiers: number;
}

/** What a binding is matched on: the DOM code it is stored under, its
 *  modifier names, and the Qt::Key it was made with when that says more than
 *  the code does (a shifted symbol, or a NumLock-off numpad key). */
interface Matchable {
    key: string;
    modifiers: string[];
    qtKey?: number;
}

/**
 * Whether `event` is the key `b` is bound to — desktop's `TKey::match`, which
 * compares the Qt::Key and the WHOLE modifier mask, Keypad bit included.
 *
 *  - Ctrl/Shift/Alt/Meta must be exactly the binding's.
 *  - A numpad binding only answers the numpad, and the main keyboard's keys
 *    only answer main-keyboard bindings: `permKey(Keypad, Key_8)` is numpad 8
 *    and never the top-row 8.
 *  - On the numpad the key is compared in Qt terms, so NumLock decides it as it
 *    does on desktop: numpad 8 is Key_8 with NumLock on and Key_Up with it off.
 *  - A binding made with a printable Qt key (permKey, tempKey, desktop XML,
 *    the recorder) is compared with the character the press produced, as Qt
 *    compares it — layout and all. `!` without Shift never fires on a US plain
 *    1 (Qt never reports `!` for it), while on AZERTY the unshifted `&/1` key
 *    is Key_Ampersand and Shift+it is Key_1|Shift, which a US-position match
 *    would put on the 7 key and on nothing respectively.
 *  - Otherwise — a named key, a binding stored only as a DOM code, or a press
 *    with no usable character — the DOM code (the physical key) decides.
 */
function matchesEvent(b: Matchable, event: KeyboardEvent): boolean {
    const { modifiers } = b;
    if (
        event.ctrlKey  !== modifiers.includes('ctrl')  ||
        event.shiftKey !== modifiers.includes('shift') ||
        event.altKey   !== modifiers.includes('alt')   ||
        event.metaKey  !== modifiers.includes('meta')
    ) return false;
    const keypad = isKeypadBinding(b.key, modifiers);
    if (keypad !== isQtKeypadEvent(event)) return false;
    if (keypad) {
        // 0 is "no Qt key known" (an unmapped string handed to tempKey).
        const want = b.qtKey || domCodeToQtKey(b.key);
        return want !== undefined && want === keypadEventQtKey(event);
    }
    if (isPrintableQtKey(b.qtKey)) {
        const typed = printableEventQtKey(event);
        if (typed !== undefined) return typed === b.qtKey;
    }
    return b.key !== '' && event.code === b.key;
}

interface TempKey {
    key: string;
    modifiers: string[];
    fn: TempFn;
    // The original Qt::Key / Qt modifier mask passed to tempKey, kept verbatim so
    // getKeyCode() round-trips exactly (the DOM-code translation is lossy).
    qtKey?: number;
    qtModifier?: number;
    /** Temp keys can be toggled by id, exactly like permanent ones — Mudlet's
     *  enableKey/disableKey and isActive() see no difference between them. */
    enabled: boolean;
    /** Killed, but not yet reaped. Mudlet frees a killed key in the deferred
     *  cleanup its unit runs at the end of a line, so until then the key is
     *  still findable while no longer firing: `exists` says 1, `isActive` says
     *  0, and a second `killKey` finds a corpse and answers false. */
    dead?: boolean;
    /** Its script did not compile. Mudlet still makes the key, but
     *  TKey::setScript leaves it unable to fire or report active, however it
     *  is switched. */
    uncompiled?: boolean;
    /** Place in the profile's one key list — see {@link KeyEngine.process}. */
    seq: number;
}

/** A permanent key's getKeyCode answer: the Qt::Key it was made with when
 *  known, else its code's, and the mask with the Keypad bit a Numpad* code
 *  implies. */
export function permKeyCode(node: Pick<KeyNode, 'key' | 'modifiers' | 'qtKey'>): KeyCodeInfo {
    return {
        keyCode: node.qtKey ?? domCodeToQtKey(node.key) ?? 0,
        modifiers: bindingQtModifiers(node.key, node.modifiers),
    };
}

export class KeyEngine {
    private readonly temp = new Map<number, TempKey>();
    private perm: KeyNode[] = [];
    /** Shared with every other engine in the profile — see ItemIdSequence. */
    private idSeq = new ItemIdSequence();
    setIdSequence(seq: ItemIdSequence): void { this.idSeq = seq; }

    // ── Unified ordering (Mudlet `mKeyRootNodeList`) ──────────────────────────
    // Desktop keeps temporary and permanent keys in ONE root list, in the order
    // they were created, and KeyUnit::processDataStream walks it front to back,
    // so the earlier-made key wins a key two bindings share. Numbered as
    // PatternEngine numbers aliases: a permanent key draws its seq the first
    // time it is seen (kept across reloads), a temp key when it is made, and a
    // permanent key sorts by its ROOT's seq — a subtree is walked whole where
    // its root sits.
    private regCounter = 1;
    private readonly permReg = new Map<string, number>();
    /** Each key in {@link perm} → the seq of the root it hangs under. */
    private permRootSeq = new Map<string, number>();

    // ── Temp keybindings (session-scoped, created by scripts) ─────────────────

    /** Number of live session-scoped temp keys (Mudlet `getProfileStats` temp
     *  count). Killed-but-unreaped keys are not live and don't count. */
    get tempCount(): number {
        let n = 0;
        for (const t of this.temp.values()) if (!t.dead) n++;
        return n;
    }

    addTemp(key: string, modifiers: string[], fn: TempFn, qt?: { keyCode: number; modifier: number; uncompiled?: boolean }): number {
        const id = this.idSeq.next();
        this.temp.set(id, {
            key, modifiers, fn, qtKey: qt?.keyCode, qtModifier: qt?.modifier, enabled: true,
            uncompiled: qt?.uncompiled === true, seq: this.regCounter++,
        });
        return id;
    }

    /** Whether a temp key with this id is live — backs exists(id, "key"). */
    hasTemp(id: number): boolean { return this.temp.has(id); }

    /** Whether a live temp key is enabled — backs isActive(id, "key"). */
    isTempEnabled(id: number): boolean {
        const t = this.temp.get(id);
        return t?.enabled === true && !t.uncompiled;
    }

    /** enableKey/disableKey with a numeric id. False when no temp key matches. */
    setTempEnabled(id: number, enabled: boolean): boolean {
        const t = this.temp.get(id);
        // A killed key is still findable until the reap, but re-enabling it
        // would resurrect something the caller already destroyed.
        if (!t || t.dead) return false;
        t.enabled = enabled;
        return true;
    }

    /**
     * Mudlet getKeyCode(idOrName) lookup. A numeric id resolves a temp key; a
     * string resolves a permanent key by name. Returns the Qt key code + modifier
     * mask, or null when nothing matches (caller turns that into nil + errMsg).
     */
    getKeyCode(idOrName: number | string): KeyCodeInfo | null {
        if (typeof idOrName === 'number') {
            const t = this.temp.get(idOrName);
            // A killed key is still findable until the reap, but it must not
            // answer for an id any more: temp ids and the numeric ids permanent
            // keys are handed share a counter space, so a corpse left sitting
            // here would shadow a permanent key that happens to match.
            if (!t || t.dead) return null;
            return {
                keyCode: t.qtKey ?? (typeof t.key === 'string' ? domCodeToQtKey(t.key) ?? 0 : t.key),
                modifiers: t.qtModifier ?? bindingQtModifiers(t.key, t.modifiers),
            };
        }
        const node = this.perm.find(k => k.name === idOrName);
        if (!node) return null;
        return permKeyCode(node);
    }

    killKey(id: number): boolean {
        const t = this.temp.get(id);
        // Nothing there, or a corpse waiting to be reaped: either way this call
        // achieved nothing and has to say so.
        if (!t || t.dead) return false;
        // Marked rather than dropped — see TempKey.dead. reapKilled() frees it.
        // `enabled` goes too, so isActive() and processTemp() both stand down.
        t.dead = true;
        t.enabled = false;
        return true;
    }

    /** Free every key killed since the last call. Runs once per processed line
     *  batch, mirroring the deferred cleanup Mudlet's TKeyUnit does. */
    reapKilled(): void {
        for (const [id, t] of this.temp) if (t.dead) this.temp.delete(id);
    }

    /** @param all Mudlet's "React to all keybindings on the same key": run
     *  every enabled match instead of stopping at the first. Snapshot the
     *  values first — a handler may create or kill a temp key, and mutating the
     *  map mid-iteration is exactly the case Mudlet's deferred `reapKilled`
     *  exists to avoid. */
    processTemp(event: KeyboardEvent, all = false): boolean {
        let fired = false;
        for (const t of [...this.temp.values()]) {
            if (!this.fireTemp(t, event)) continue;
            if (!all) return true;
            fired = true;
        }
        return fired;
    }

    /** Run one temp key if it is live and `event` is its key. */
    private fireTemp(t: TempKey, event: KeyboardEvent): boolean {
        if (!t.enabled || t.uncompiled || !matchesEvent(t, event)) return false;
        t.fn();
        return true;
    }

    /**
     * A keypress's whole key pass: temporary and permanent keys alike, in the
     * one order desktop's `mKeyRootNodeList` holds them (creation order, see
     * the unified-ordering note above). The first match fires and ends the
     * pass, unless `all` (Mudlet's "React to all keybindings on the same key")
     * asks for every match. Running all the temps first put a tempKey made
     * after a permKey ahead of it (mudlet-web#340). Temps fire themselves; a
     * permanent hit goes to `firePerm`. Both lists are snapshots taken when the
     * pass began — a handler may make, kill or toggle keys. True when anything
     * fired.
     */
    process(event: KeyboardEvent, all: boolean, firePerm: (binding: KeyNode) => void): boolean {
        const steps: { seq: number; at: number; temp?: TempKey; perm?: KeyNode }[] = [];
        for (const t of this.temp.values()) steps.push({ seq: t.seq, at: 0, temp: t });
        this.perm.forEach((binding, i) => {
            steps.push({ seq: this.permRootSeq.get(binding.id) ?? Number.MAX_SAFE_INTEGER, at: i + 1, perm: binding });
        });
        steps.sort((a, b) => a.seq - b.seq || a.at - b.at);
        let fired = false;
        for (const step of steps) {
            if (step.temp) {
                if (!this.fireTemp(step.temp, event)) continue;
            } else if (step.perm) {
                if (!matchesEvent(step.perm, event)) continue;
                firePerm(step.perm);
            }
            if (!all) return true;
            fired = true;
        }
        return fired;
    }

    // ── Perm keybindings (persisted, visible in UI) ────────────────────────────

    /** `blocked`: bindings whose code will not compile, which Mudlet leaves
     *  inactive — see buildEffectivelyEnabledIds. */
    loadPerm(keybindings: KeyNode[], blocked?: ReadonlySet<string>): void {
        // Store order puts a parent before its children, so registering in it
        // numbers a new root ahead of anything under it.
        this.reserveOrder(keybindings);
        const byId = new Map(keybindings.map(k => [k.id, k]));
        for (const id of this.permReg.keys()) {
            if (!byId.has(id)) this.permReg.delete(id);
        }
        const rootSeq = (node: KeyNode): number => {
            let cur = node;
            const seen = new Set<string>([cur.id]);
            while (cur.parentId) {
                const parent = byId.get(cur.parentId);
                if (!parent || seen.has(parent.id)) break;
                seen.add(parent.id);
                cur = parent;
            }
            return this.permReg.get(cur.id) ?? Number.MAX_SAFE_INTEGER;
        };
        const enabledIds = buildEffectivelyEnabledIds(keybindings, blocked);
        // A key with no DOM code can still be bound by the character it types
        // (Key_Eacute from an AZERTY profile has no US position at all).
        // Tree order, not store order: a key added later to an older group
        // sits inside that group, ahead of root keys made since (#336).
        this.perm = inTreeOrder(keybindings).filter(k => enabledIds.has(k.id) && (k.key || isPrintableQtKey(k.qtKey)));
        this.permRootSeq = new Map(this.perm.map(k => [k.id, rootSeq(k)]));
    }

    /**
     * Give the profile's saved keys their place in the firing order before any
     * script can make a temporary one. Desktop builds them from the profile
     * before a script runs, so a tempKey a script makes at load time sorts
     * after them — but here the scripts run before the first {@link loadPerm},
     * which then reuses the seqs reserved here.
     */
    reserveOrder(items: readonly { id: string }[]): void {
        for (const item of items) {
            if (!this.permReg.has(item.id)) this.permReg.set(item.id, this.regCounter++);
        }
    }

    /** The first permanent keybinding the event matches, in tree order — the
     *  permanent half of {@link process}, for callers that ask about the
     *  saved keys alone. */
    matchPerm(event: KeyboardEvent): KeyNode | null {
        return this.perm.find(b => matchesEvent(b, event)) ?? null;
    }

    /** Every permanent keybinding the event matches, in tree order. The list
     *  form of {@link matchPerm}, for Mudlet's "React to all keybindings on the
     *  same key". */
    matchAllPerm(event: KeyboardEvent): KeyNode[] {
        return this.perm.filter(b => matchesEvent(b, event));
    }

    /**
     * Which binding of this profile holds `key` + `modifiers` — Mudlet's
     * `KeyUnit::firstMatch`, asked with a key rather than an event.
     *
     * What needs it is `addCommand`: a key binding is the one holder a
     * command's shortcut cannot see, since it lives here and is matched from
     * the command line's key handling rather than by any menu or widget, so a
     * command placed on a binding's key takes the event and the binding simply
     * stops firing. Temporary and permanent are searched alike (they are one
     * list in Mudlet's key unit), and a temporary one answers with no name: it
     * is named after its own id, which names nothing a player could go and look
     * for.
     */
    holderOf(key: string, modifiers: string[]): { name: string; temporary: boolean } | null {
        const same = (bindingKey: string, bindingMods: string[]): boolean =>
            bindingKey === key
            && bindingMods.length === modifiers.length
            && bindingMods.every(m => modifiers.includes(m));
        for (const t of this.temp.values()) {
            if (!t.enabled || t.dead || t.uncompiled) continue;
            if (same(t.key, t.modifiers)) return { name: '', temporary: true };
        }
        for (const binding of this.perm) {
            if (same(binding.key, binding.modifiers)) return { name: binding.name, temporary: false };
        }
        return null;
    }

    destroy(): void {
        this.temp.clear();
        this.perm = [];
        this.permRootSeq = new Map();
    }
}
