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
function matchAllCaptures(input: string, re: RegExp): { all: string[]; index: number; named: Record<string, string> } | null {
    // The stored RegExp has no `g` (it is also used for plain `.match()`), and
    // `lastIndex` on a shared instance would leak between calls — so the loop
    // drives its own clone.
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    const all: string[] = [];
    // Named groups sit alongside the positional ones on the same table in
    // Lua. A group on a branch that did not take part in the match has no
    // capture to offer, so it is left out rather than written as an empty
    // string — TAlias skips a PCRE2_UNSET slot for the same reason.
    const named: Record<string, string> = {};
    let index = -1;
    let m: RegExpExecArray | null;
    while ((m = g.exec(input)) !== null) {
        if (index < 0) index = m.index;
        all.push(m[0]);
        for (let i = 1; i < m.length; i++) all.push(m[i] ?? '');
        for (const [name, value] of Object.entries(m.groups ?? {})) {
            if (value !== undefined && named[name] === undefined) named[name] = value;
        }
        if (m[0] === '') {
            // A zero-width match leaves lastIndex where it was, so step past it
            // — by a whole code point, or the step would split a surrogate pair.
            const cp = input.codePointAt(g.lastIndex);
            g.lastIndex += cp !== undefined && cp > 0xffff ? 2 : 1;
            if (g.lastIndex > input.length) break;
        }
    }
    return index < 0 ? null : { all, index, named };
}

export class AliasEngine extends PatternEngine<AliasNode> {
    // ── Temp aliases (session-scoped, created by scripts) ─────────────────────

    /**
     * Fire EVERY matching temp alias, and report whether any did.
     *
     * Not "the first one": `AliasUnit::processDataStream` walks the whole unit
     * and calls `match()` on each active alias, so two aliases on one command
     * both run — which is how a package can add its own handling of a command
     * the player already has an alias for, and what the corpus pins by putting
     * two aliases on one pattern and expecting both to see it.
     *
     * The walk is over a snapshot, as Mudlet's is (issue #4297): an alias's
     * script may create or kill one, and mutating the map underneath the
     * iterator is precisely what the deferred reap exists to avoid. One killed
     * by an earlier fire is skipped rather than run, which is what `isActive()`
     * decides on the desktop side.
     */
    processTemp(input: string): boolean {
        let fired = false;
        for (const [id, { pattern }] of [...this.temp]) {
            // A null pattern is an alias that exists but can never match — see
            // PatternEngine.addTemp.
            if (!pattern) continue;
            const hit = matchAllCaptures(input, pattern);
            if (!hit) continue;
            // Re-read rather than trusting the snapshot's entry: killAlias
            // unsubscribes, and an alias taken out while this pass was running
            // must not still fire.
            const live = this.temp.get(id);
            if (!live) continue;
            live.fn(asMatchArray(hit.all, hit.index, input, hit.named));
            fired = true;
        }
        return fired;
    }

    // ── Perm aliases (persisted, visible in UI) ────────────────────────────────

    /** Every perm alias the input matches, in tree order — all of them fire,
     *  for the reason {@link processTemp} gives. `matchedText` is the portion of
     *  `input` the regex actually matched (Mudlet's `matches[1]`), which differs
     *  from the whole input for an unanchored pattern. */
    matchAllPerm(input: string): { alias: AliasNode; matchedText: string; captures: string[]; named: Record<string, string> }[] {
        const hits: { alias: AliasNode; matchedText: string; captures: string[]; named: Record<string, string> }[] = [];
        for (const { item, re } of this.permCompiled) {
            const hit = matchAllCaptures(input, re);
            if (hit) hits.push({ alias: item, matchedText: hit.all[0], captures: hit.all.slice(1), named: hit.named });
        }
        return hits;
    }
}

/** The temp-alias callback is typed against `RegExpMatchArray` and only ever
 *  read as a list, but `input` is part of that contract — so hand back a real
 *  one carrying the accumulated captures. */
function asMatchArray(all: string[], index: number, input: string, named: Record<string, string>): RegExpMatchArray {
    const out = all as RegExpMatchArray;
    out.index = index;
    out.input = input;
    // Only when the pattern actually named something, so the common case
    // stays indistinguishable from a plain RegExp match.
    if (Object.keys(named).length > 0) out.groups = named;
    return out;
}
