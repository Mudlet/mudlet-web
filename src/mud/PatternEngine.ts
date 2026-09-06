import { buildEffectivelyEnabledIds } from '../storage/schema';

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

export class PatternEngine<T extends PatternItem> {
    /** A null pattern is an item that can never match — an uncompilable or
     *  empty one. See {@link addTemp}. */
    protected readonly temp = new Map<number, { pattern: RegExp | null; fn: TempFn }>();
    /** Key for this engine's own temp map. NOT an item id: addTemp hands the
     *  caller an unsubscribe function, and the id Lua sees is allocated by the
     *  runtime from the profile's shared sequence. Drawing from that sequence
     *  here would burn a number per temp item and put permAlias/tempAlias out
     *  of step (Alias_spec pins the run of ids). */
    protected nextInternalId = 1;
    protected permCompiled: Array<{ item: T; re: RegExp }> = [];

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
     * //, which matches every command typed and consumed the lot.
     */
    addTemp(pattern: string | RegExp, fn: TempFn): () => void {
        let re: RegExp | null = null;
        if (typeof pattern !== 'string') {
            re = pattern;
        } else if (pattern !== '') {
            try {
                re = new RegExp(pattern);
            } catch {
                re = null; // never matches — see above
            }
        }
        const id = this.nextInternalId++;
        this.temp.set(id, { pattern: re, fn });
        return () => { this.temp.delete(id); };
    }

    loadPerm(items: T[]): void {
        this.permCompiled = [];
        const enabledIds = buildEffectivelyEnabledIds(items);
        for (const item of items) {
            if (!enabledIds.has(item.id)) continue;
            if (!item.pattern) continue;
            try {
                this.permCompiled.push({ item, re: new RegExp(item.pattern) });
            } catch {
                // skip invalid patterns
            }
        }
    }

    destroy(): void {
        this.temp.clear();
        this.permCompiled = [];
    }
}
