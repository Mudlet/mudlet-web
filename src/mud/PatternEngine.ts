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
    protected readonly temp = new Map<number, { pattern: RegExp; fn: TempFn }>();
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

    addTemp(pattern: string | RegExp, fn: TempFn): () => void {
        const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
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
