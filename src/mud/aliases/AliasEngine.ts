import type { AliasNode } from '../../storage/schema';
import { PatternEngine } from '../PatternEngine';

export type { AliasNode };

/**
 * Mudlet's `TAlias::match` runs an unconditional global-match loop: after the
 * first match it keeps matching from the end of the previous one and appends
 * every match's whole-match-plus-captures to the SAME capture list, so `matches`
 * holds all of them flat. An anchored alias — the common case — matches once and
 * the list is the familiar `{whole, cap1, …}`; an unanchored one collects every
 * occurrence.
 *
 * Returned flat, in Mudlet's order. `null` when the pattern never matched, which
 * is what "this alias did not fire" means.
 */
function matchAllCaptures(input: string, re: RegExp): { all: string[]; index: number } | null {
    // The stored RegExp has no `g` (it is also used for plain `.match()`), and
    // `lastIndex` on a shared instance would leak between calls — so the loop
    // drives its own clone.
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    const all: string[] = [];
    let index = -1;
    let m: RegExpExecArray | null;
    while ((m = g.exec(input)) !== null) {
        if (index < 0) index = m.index;
        all.push(m[0]);
        for (let i = 1; i < m.length; i++) all.push(m[i] ?? '');
        if (m[0] === '') {
            // A zero-width match leaves lastIndex where it was, so step past it
            // — by a whole code point, or the step would split a surrogate pair.
            const cp = input.codePointAt(g.lastIndex);
            g.lastIndex += cp !== undefined && cp > 0xffff ? 2 : 1;
            if (g.lastIndex > input.length) break;
        }
    }
    return index < 0 ? null : { all, index };
}

export class AliasEngine extends PatternEngine<AliasNode> {
    // ── Temp aliases (session-scoped, created by scripts) ─────────────────────

    /** Returns true and fires the first matching temp alias. Stops at first match. */
    processTemp(input: string): boolean {
        for (const { pattern, fn } of this.temp.values()) {
            const hit = matchAllCaptures(input, pattern);
            if (hit) { fn(asMatchArray(hit.all, hit.index, input)); return true; }
        }
        return false;
    }

    // ── Perm aliases (persisted, visible in UI) ────────────────────────────────

    /** Returns the first matching perm alias, or null. `matchedText` is the
     *  portion of `input` the regex actually matched (Mudlet's `matches[1]`),
     *  which differs from the whole input for an unanchored pattern. */
    matchPerm(input: string): { alias: AliasNode; matchedText: string; captures: string[] } | null {
        for (const { item, re } of this.permCompiled) {
            const hit = matchAllCaptures(input, re);
            if (hit) return { alias: item, matchedText: hit.all[0], captures: hit.all.slice(1) };
        }
        return null;
    }
}

/** The temp-alias callback is typed against `RegExpMatchArray` and only ever
 *  read as a list, but `input` is part of that contract — so hand back a real
 *  one carrying the accumulated captures. */
function asMatchArray(all: string[], index: number, input: string): RegExpMatchArray {
    const out = all as RegExpMatchArray;
    out.index = index;
    out.input = input;
    return out;
}
