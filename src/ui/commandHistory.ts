// MRU command-line history with prefix/subsequence matching and LCP-based
// Tab-completion. Persisted in localStorage; case-insensitive de-duplication.

const STORAGE_PREFIX = 'mudlet_history';
export const MAX_HISTORY = 500;

/** Default number of entries persisted to localStorage when the profile hasn't
 *  set Mudlet's `commandLineHistorySaveSize`. Matches MAX_HISTORY so existing
 *  histories survive untouched until the user opts into a smaller save cap. */
export const DEFAULT_HISTORY_SAVE_SIZE = MAX_HISTORY;

/** localStorage key for a profile's command history. History is per-profile —
 *  one MUD's commands shouldn't surface in another's. The bare prefix (no
 *  connection) backs the connection screen before a profile is open. */
export function historyStorageKey(connectionId: string | null): string {
    return connectionId ? `${STORAGE_PREFIX}_${connectionId}` : STORAGE_PREFIX;
}

export function loadHistory(key: string): string[] {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX_HISTORY);
    } catch {
        return [];
    }
}

/** Persist the MRU history, keeping at most `saveSize` entries (Mudlet's
 *  `commandLineHistorySaveSize`). A negative size means "no cap"; the in-memory
 *  list is still bounded by MAX_HISTORY via {@link addToHistory}. */
export function saveHistory(items: string[], key: string, saveSize: number = DEFAULT_HISTORY_SAVE_SIZE): void {
    try {
        const capped = saveSize >= 0 && items.length > saveSize ? items.slice(0, saveSize) : items;
        localStorage.setItem(key, JSON.stringify(capped));
    } catch {
        // Storage may be full / disabled — non-fatal.
    }
}

export function addToHistory(history: string[], item: string): string[] {
    if (!item) return history;
    const lower = item.toLowerCase();
    const filtered = history.filter(h => h.toLowerCase() !== lower);
    filtered.unshift(item);
    if (filtered.length > MAX_HISTORY) filtered.length = MAX_HISTORY;
    return filtered;
}

export type MatchKind = 'prefix-start' | 'prefix-mid' | 'subseq';

export interface Match {
    item: string;
    mruIndex: number;
    kind: MatchKind;
    /** First match position used as the LCP anchor. */
    anchor: number;
    /** [start, end) ranges over `item` to visually highlight. */
    ranges: Array<[number, number]>;
}

const KIND_RANK: Record<MatchKind, number> = {
    'prefix-start': 0,
    'prefix-mid':   1,
    'subseq':       2,
};

export function matchHistory(prefix: string, history: string[], limit = 10): Match[] {
    if (!prefix) return [];
    const lowerPrefix = prefix.toLowerCase();
    const out: Match[] = [];
    for (let i = 0; i < history.length; i++) {
        const item = history[i];
        const lower = item.toLowerCase();
        // Skip exact match — suggestion would add nothing the user doesn't already have.
        if (lower === lowerPrefix) continue;
        if (lower.startsWith(lowerPrefix)) {
            out.push({
                item,
                mruIndex: i,
                kind: 'prefix-start',
                anchor: 0,
                ranges: [[0, prefix.length]],
            });
            continue;
        }
        const mid = lower.indexOf(lowerPrefix);
        if (mid > 0) {
            out.push({
                item,
                mruIndex: i,
                kind: 'prefix-mid',
                anchor: mid,
                ranges: [[mid, mid + prefix.length]],
            });
            continue;
        }
        const subseq = subsequenceRanges(lower, lowerPrefix);
        if (subseq) {
            out.push({
                item,
                mruIndex: i,
                kind: 'subseq',
                anchor: subseq[0][0],
                ranges: subseq,
            });
        }
    }
    out.sort((a, b) => {
        const k = KIND_RANK[a.kind] - KIND_RANK[b.kind];
        if (k !== 0) return k;
        return a.mruIndex - b.mruIndex;
    });
    if (out.length > limit) out.length = limit;
    return out;
}

function subsequenceRanges(item: string, prefix: string): Array<[number, number]> | null {
    if (prefix.length === 0) return [];
    const ranges: Array<[number, number]> = [];
    let pi = 0;
    for (let i = 0; i < item.length && pi < prefix.length; i++) {
        if (item[i] === prefix[pi]) {
            // Coalesce adjacent ranges so the highlight stays contiguous when
            // multiple consecutive characters match (looks much cleaner).
            const last = ranges[ranges.length - 1];
            if (last && last[1] === i) last[1] = i + 1;
            else ranges.push([i, i + 1]);
            pi++;
        }
    }
    return pi === prefix.length ? ranges : null;
}

/** Longest common prefix across all matches, measured from each match's anchor.
 *  Returns the would-be replacement string if it extends the current prefix,
 *  null otherwise. Case-insensitive comparison; the returned string preserves
 *  the casing of the top-ranked match. */
export function computeLcp(matches: Match[], prefix: string): string | null {
    if (matches.length === 0) return null;
    const slices = matches.map(m => m.item.slice(m.anchor));
    let lcpLen = slices[0].length;
    for (let i = 1; i < slices.length && lcpLen > 0; i++) {
        lcpLen = commonPrefixLen(slices[0], slices[i], lcpLen);
    }
    if (lcpLen <= prefix.length) return null;
    return slices[0].slice(0, lcpLen);
}

function commonPrefixLen(a: string, b: string, max: number): number {
    const limit = Math.min(a.length, b.length, max);
    let i = 0;
    while (i < limit && a[i].toLowerCase() === b[i].toLowerCase()) i++;
    return i;
}
