import { buildEffectivelyEnabledIds } from '../storage/schema';
import Pcre2 from './triggers/pcre/Pcre2';

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
// classify by Unicode property. See the note on UNICODE_VERBS there.
const UNICODE_VERBS = '(*UTF)(*UCP)';

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

export class PatternEngine<T extends PatternItem> {
    /** A null pattern is an empty one, which can never match; an
     *  uncompilable one is an AliasPattern that never compiles. See
     *  {@link addTemp}. */
    protected readonly temp = new Map<number, { pattern: AliasPattern | null; fn: TempFn; seq: number }>();
    /** Key for this engine's own temp map. NOT an item id: addTemp hands the
     *  caller an unsubscribe function, and the id Lua sees is allocated by the
     *  runtime from the profile's shared sequence. Drawing from that sequence
     *  here would burn a number per temp item and put permAlias/tempAlias out
     *  of step (Alias_spec pins the run of ids). */
    protected nextInternalId = 1;
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

    /** Number of live session-scoped temp items (Mudlet `getProfileStats` temp count). */
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
    addTemp(pattern: string, fn: TempFn): () => void {
        const re = pattern !== '' ? new AliasPattern(pattern) : null;
        const id = this.nextInternalId++;
        this.temp.set(id, { pattern: re, fn, seq: this.regCounter++ });
        return () => {
            this.temp.delete(id);
            re?.destroy();
        };
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
        for (const item of items) {
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
        for (const { pattern } of this.temp.values()) pattern?.destroy();
        this.temp.clear();
        for (const { re } of this.permCompiled) re.destroy();
        this.permCompiled = [];
        this.permById = new Map();
        this.permOrder = [];
        this.permRootSeq = new Map();
    }
}
