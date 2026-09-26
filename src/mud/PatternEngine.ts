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
    protected readonly temp = new Map<number, { pattern: AliasPattern | null; fn: TempFn }>();
    /** Key for this engine's own temp map. NOT an item id: addTemp hands the
     *  caller an unsubscribe function, and the id Lua sees is allocated by the
     *  runtime from the profile's shared sequence. Drawing from that sequence
     *  here would burn a number per temp item and put permAlias/tempAlias out
     *  of step (Alias_spec pins the run of ids). */
    protected nextInternalId = 1;
    protected permCompiled: Array<{ item: T; re: AliasPattern }> = [];

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
        this.temp.set(id, { pattern: re, fn });
        return () => {
            this.temp.delete(id);
            re?.destroy();
        };
    }

    /** `blocked`: items whose code will not compile, which Mudlet leaves
     *  inactive — see buildEffectivelyEnabledIds. */
    loadPerm(items: T[], blocked?: ReadonlySet<string>): void {
        for (const { re } of this.permCompiled) re.destroy();
        this.permCompiled = [];
        const enabledIds = buildEffectivelyEnabledIds(items, blocked);
        for (const item of items) {
            if (!enabledIds.has(item.id)) continue;
            if (!item.pattern) continue;
            // An invalid pattern is kept and simply never matches.
            this.permCompiled.push({ item, re: new AliasPattern(item.pattern) });
        }
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
    }
}
