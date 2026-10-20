import { buildEffectivelyEnabledIds, inTreeOrder, isTempParentRef, tempParentRef, tempRootOf } from '../storage/schema';
import { ItemIdSequence } from './ItemIdSequence';
import Pcre2, { ENGINE_MATCH_LIMIT_VERB } from './triggers/pcre/Pcre2';

type TempFn = (matches: RegExpMatchArray) => void;

type PatternItem = {
    id: string;
    name: string;
    pattern: string;
    code: string;
    language: 'lua' | 'js';
    enabled: boolean;
    isGroup: boolean;
    parentId: string | null;
};

// Same verbs TriggerEngine prepends: Mudlet compiles alias patterns with
// PCRE2_UTF | PCRE2_UCP just as it does trigger ones, so `\w` and friends
// classify by Unicode property. See the note on UNICODE_VERBS there; the
// match limit is TriggerEngine's too (ENGINE_MATCH_LIMIT).
const UNICODE_VERBS = '(*UTF)(*UCP)' + ENGINE_MATCH_LIMIT_VERB;

/**
 * An alias pattern, compiled with PCRE2 the way TAlias::compileRegex does —
 * not as a JS RegExp, whose dialect has no inline `(?i)`/`(?x)`, no atomic or
 * possessive groups, no `\A`/`\Z`, and reads `\p{L}` as a literal `p{L}`.
 *
 * Compiled on first use rather than on construction: the PCRE wasm loads
 * asynchronously, and aliases (saved ones, and temp ones a script makes while
 * the profile loads) can be registered before it has. Nobody types a command
 * before then, so the first match is the earliest a compile is ever needed.
 * A pattern that fails to compile stays failed and never matches.
 */
export class AliasPattern {
    private re: Pcre2 | null = null;
    private failed = false;

    constructor(readonly source: string) {}

    /** The compiled pattern, or null while PCRE is still loading or when the
     *  pattern does not compile. */
    compiled(): Pcre2 | null {
        if (this.re || this.failed || !Pcre2.ready) return this.re;
        try {
            this.re = new Pcre2(UNICODE_VERBS + this.source);
        } catch {
            this.failed = true;
        }
        return this.re;
    }

    /** Whether PCRE has rejected the pattern — Mudlet's `mOK_init = false`,
     *  which leaves the alias inactive. False while PCRE is still loading. */
    invalid(): boolean {
        return Pcre2.ready && this.compiled() === null;
    }

    /** Free the wasm-side pattern. It never matches again afterwards. */
    destroy(): void {
        this.failed = true;
        this.re?.destroy();
        this.re = null;
    }
}

/** A temporary item: the temporary half of desktop's one tree per kind,
 *  keyed by the id the script was handed. A temp item is named after its id
 *  (startTempAlias: setName(QString::number(id))). */
export interface TempPatternItem {
    /** A null pattern is an empty one, which can never match; an
     *  uncompilable one is an AliasPattern that never compiles. See
     *  {@link PatternEngine.addTemp}. */
    pattern: AliasPattern | null;
    fn: TempFn;
    seq: number;
    /** enableAlias/disableAlias — Tree::mActive. */
    enabled: boolean;
    /** Killed, waiting for the deferred cleanup (mCleanupSet): no longer
     *  fires, and it and everything under it read as gone to exists/isActive/
     *  findItems, but it is still counted by getProfileStats until freed. */
    dead: boolean;
    /** Its script did not compile: made and findable, but never fires and
     *  isActive() says 0 (TAlias::setScript). */
    uncompiled: boolean;
    /** Run once when the item is killed or removed, to release its callback. */
    onFree?: () => void;
    freed?: boolean;
}

/** What a caller can tell the engine about a temp item. */
export interface TempPatternOptions {
    /** The id to file it under, drawn by the caller from the profile's shared
     *  sequence; the engine draws its own when absent (a bare test engine). */
    id?: number;
    uncompiled?: boolean;
    onFree?: () => void;
}

export class PatternEngine<T extends PatternItem> {
    protected readonly temp = new Map<number, TempPatternItem>();
    /** Fallback id source for a bare engine — see TempPatternOptions.id. */
    private idSeq = new ItemIdSequence();
    /** Each permanent item hanging off a temporary one (as of the last
     *  loadPerm) → that temporary root's id; and the parent refs in use. */
    protected permTempRoot = new Map<string, number>();
    private tempParentRefs = new Set<string>();
    private orphanedParents = new Set<string>();
    private onOrphans: (() => void) | null = null;
    protected permCompiled: Array<{ item: T; re: AliasPattern }> = [];
    /** {@link permCompiled} by item id — what is loaded and active right now. */
    protected permById = new Map<string, { item: T; re: AliasPattern }>();
    /** Every permanent item with a pattern, active or not, in tree order. A
     *  fresh array on each {@link loadPerm}, so a pass can keep walking the one
     *  it started with — Mudlet's `copyOfNodeList` — while a script it runs
     *  enables or disables items, which reloads this engine synchronously. */
    protected permOrder: readonly string[] = [];

    // ── Unified ordering (Mudlet `mAliasRootNodeList`) ────────────────────────
    // Desktop keeps temporary and permanent aliases in ONE root list, in the
    // order they were created, and walks it front to back — so a temp alias
    // made before a permAlias runs before it, and one made after runs after.
    // The same monotonic counter numbers both: a permanent item draws its seq
    // the first time it is seen (kept across reloads, so edits and toggles do
    // not reshuffle), a temp item draws one when it is made. A permanent item
    // sorts by its ROOT's seq — a subtree is walked whole where its root sits.
    protected regCounter = 1;
    private readonly permReg = new Map<string, number>();
    /** Each item in {@link permOrder} → the seq of the root it hangs under. */
    protected permRootSeq = new Map<string, number>();

    /** Temp items in the tree — killed ones too, until the cleanup frees them
     *  (desktop's getProfileStats walks the root list unfiltered). */
    get tempCount(): number {
        return this.temp.size;
    }

    /**
     * Register a temporary item. A pattern that will never match is still an
     * item: TAlias::compileRegex records a compile failure rather than refusing
     * to build the alias, and TAlias::match then returns false on every line
     * (`if (re == nullptr)`, and `mRegexCode.isEmpty()` a few lines later). The
     * caller gets a real id back either way, which is what lets a broken alias
     * be seen in the editor and repaired instead of vanishing.
     *
     * Both cases used to leak: an uncompilable pattern threw the RegExp
     * SyntaxError out through the Lua binding, and an EMPTY one compiled to
     * //, which matches every command typed and consumed the lot. A pattern
     * that PCRE rejects now simply never matches — see {@link AliasPattern}.
     */
    addTemp(pattern: string, fn: TempFn, opts: TempPatternOptions = {}): () => void {
        const id = this.createTemp(pattern, fn, opts);
        return () => this.removeTemp(id);
    }

    /** {@link addTemp}, handing back the item's id rather than a disposer. */
    createTemp(pattern: string, fn: TempFn, opts: TempPatternOptions = {}): number {
        const re = pattern !== '' ? new AliasPattern(pattern) : null;
        const id = opts.id ?? this.idSeq.next();
        this.temp.set(id, {
            pattern: re, fn, seq: this.regCounter++, enabled: true, dead: false,
            uncompiled: !!opts.uncompiled, onFree: opts.onFree,
        });
        return id;
    }

    /** Take a temp item out of the tree now, releasing its callback. Its
     *  permanent children are left for the owner to remove (see
     *  takeOrphanedParents). */
    removeTemp(id: number): void {
        const entry = this.temp.get(id);
        if (!entry) return;
        this.release(entry);
        this.temp.delete(id);
        entry.pattern?.destroy();
        const ref = tempParentRef(id);
        if (this.tempParentRefs.has(ref)) {
            this.orphanedParents.add(ref);
            this.onOrphans?.();
        }
    }

    private release(entry: TempPatternItem): void {
        if (entry.freed) return;
        entry.freed = true;
        entry.onFree?.();
    }

    /** Mudlet `killAlias` on a temp item: it stops at once and is queued for
     *  the deferred cleanup, which frees it with its whole subtree. False for
     *  an unknown id or one already waiting to be freed. */
    killTemp(id: number): boolean {
        const entry = this.temp.get(id);
        if (!entry || entry.dead) return false;
        entry.dead = true;
        this.release(entry);
        return true;
    }

    /** `killAlias(name)` for the temporaries: the newest live one so named. */
    killTempByName(name: string): boolean {
        const id = this.newestTempByName(name, false);
        return id !== null && this.killTemp(id);
    }

    /** Free every temp item killed since the last call — the unit's
     *  doCleanup(). */
    reapKilled(): void {
        for (const [id, entry] of [...this.temp]) if (entry.dead) this.removeTemp(id);
    }

    /** Tree keys of freed temp items that had permanent children, since the
     *  last call. Their owner removes those subtrees from the store. */
    takeOrphanedParents(): string[] {
        if (this.orphanedParents.size === 0) return [];
        const out = [...this.orphanedParents];
        this.orphanedParents.clear();
        return out;
    }

    /** Told when {@link takeOrphanedParents} has something to hand over. */
    setOrphanListener(fn: (() => void) | null): void {
        this.onOrphans = fn;
    }

    /** In the tree, killed or not. */
    hasTemp(id: number): boolean {
        return this.temp.has(id);
    }

    /** In the tree and not killed — what exists() counts. */
    hasLiveTemp(id: number): boolean {
        const entry = this.temp.get(id);
        return !!entry && !entry.dead;
    }

    /** Live, switched on and compiled — isActive(). */
    tempIsActive(id: number): boolean {
        const entry = this.temp.get(id);
        return !!entry && !entry.dead && entry.enabled && !entry.uncompiled;
    }

    /** Live temp ids, ascending, whose name — the id itself — passes `test`. */
    liveTempIds(test: (name: string) => boolean): number[] {
        const out: number[] = [];
        for (const [id, entry] of this.temp) if (!entry.dead && test(String(id))) out.push(id);
        return out.sort((a, b) => a - b);
    }

    /** The temp item named `name` — its id's exact spelling — or null; a
     *  killed one only when `includeDead` (perm* parent resolution). */
    newestTempByName(name: string, includeDead: boolean): number | null {
        const id = Number(name);
        if (!Number.isInteger(id) || String(id) !== name) return null;
        const entry = this.temp.get(id);
        return entry && (includeDead || !entry.dead) ? id : null;
    }

    /** enable/disable a live temp item. False for an unknown or killed one —
     *  re-enabling a corpse would resurrect it. */
    setTempEnabled(id: number, enabled: boolean): boolean {
        const entry = this.temp.get(id);
        if (!entry || entry.dead) return false;
        entry.enabled = enabled;
        return true;
    }

    /** The order seq of a permanent item's root: its own root's, or — for one
     *  hanging off a temporary item — that item's. */
    protected rootSeqOf(id: string): number {
        const temp = this.permTempRoot.get(id);
        if (temp !== undefined) return this.temp.get(temp)?.seq ?? Number.MAX_SAFE_INTEGER;
        return this.permRootSeq.get(id) ?? Number.MAX_SAFE_INTEGER;
    }

    /** Whether a permanent item's temporary root (if it has one) is live and
     *  active: desktop reaches it only through that parent's match(). */
    protected reachable(id: string): boolean {
        const temp = this.permTempRoot.get(id);
        return temp === undefined || this.tempIsActive(temp);
    }

    /**
     * Give the profile's saved items their place in the firing order before
     * any script can make a temporary one. Desktop builds them from the
     * profile XML before a script runs, so a temp item a script makes at load
     * time sorts after them — but here the scripts run before the first
     * {@link loadPerm}, which then reuses the seqs reserved here.
     */
    reserveOrder(items: readonly { id: string }[]): void {
        for (const item of items) {
            if (!this.permReg.has(item.id)) this.permReg.set(item.id, this.regCounter++);
        }
    }

    /** `blocked`: items whose code will not compile, which Mudlet leaves
     *  inactive — see buildEffectivelyEnabledIds. */
    loadPerm(items: T[], blocked?: ReadonlySet<string>): void {
        for (const { re } of this.permCompiled) re.destroy();
        this.permCompiled = [];
        this.permById = new Map();
        // Store order puts a parent before its children, so registering in it
        // numbers a new root ahead of anything under it.
        this.reserveOrder(items);
        const byId = new Map(items.map(i => [i.id, i]));
        for (const id of this.permReg.keys()) {
            if (!byId.has(id)) this.permReg.delete(id);
        }
        // Permanent items hanging off a temporary one (see TEMP_PARENT_PREFIX).
        this.permTempRoot = new Map();
        this.tempParentRefs.clear();
        for (const item of items) {
            if (isTempParentRef(item.parentId)) this.tempParentRefs.add(item.parentId);
        }
        if (this.tempParentRefs.size > 0) {
            for (const item of items) {
                const root = tempRootOf(item, byId);
                if (root !== null) this.permTempRoot.set(item.id, root);
            }
        }
        const rootSeq = (item: T): number => {
            let cur = item;
            const seen = new Set<string>([cur.id]);
            while (cur.parentId) {
                const parent = byId.get(cur.parentId);
                if (!parent || seen.has(parent.id)) break;
                seen.add(parent.id);
                cur = parent;
            }
            return this.permReg.get(cur.id) ?? Number.MAX_SAFE_INTEGER;
        };
        const order: string[] = [];
        const rootSeqs = new Map<string, number>();
        const enabledIds = buildEffectivelyEnabledIds(items, blocked);
        // Tree order, not store order: a child added later to an older group
        // runs inside that group, ahead of root items made since (#336).
        for (const item of inTreeOrder(items)) {
            if (!item.pattern) continue;
            order.push(item.id);
            rootSeqs.set(item.id, rootSeq(item));
            if (!enabledIds.has(item.id)) continue;
            // An invalid pattern is kept and simply never matches.
            const entry = { item, re: new AliasPattern(item.pattern) };
            this.permCompiled.push(entry);
            this.permById.set(item.id, entry);
        }
        this.permOrder = order;
        this.permRootSeq = rootSeqs;
    }

    /** Whether the permanent item `id` is loaded with a pattern PCRE rejects. */
    hasInvalidPattern(id: string): boolean {
        return this.permCompiled.some(({ item, re }) => item.id === id && re.invalid());
    }

    destroy(): void {
        for (const entry of this.temp.values()) {
            this.release(entry);
            entry.pattern?.destroy();
        }
        this.temp.clear();
        this.orphanedParents.clear();
        this.tempParentRefs.clear();
        this.permTempRoot = new Map();
        for (const { re } of this.permCompiled) re.destroy();
        this.permCompiled = [];
        this.permById = new Map();
        this.permOrder = [];
        this.permRootSeq = new Map();
    }
}
