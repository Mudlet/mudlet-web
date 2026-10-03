import type { AliasNode } from '../../storage/schema';
import { PatternEngine, type AliasPattern } from '../PatternEngine';
import { PCRE2_NO_UTF_CHECK, type Pcre2Match } from '../triggers/pcre/Pcre2';

export type { AliasNode };

/** One permanent alias a command matched — see AliasEngine.forEachPermMatch. */
export interface PermAliasMatch {
    alias: AliasNode;
    matchedText: string;
    captures: string[];
    named: Record<string, string>;
}

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
function matchAllCaptures(input: string, pattern: AliasPattern): { all: string[]; index: number; named: Record<string, string> } | null {
    const re = pattern.compiled();
    if (!re) return null;
    const all: string[] = [];
    // Named groups sit alongside the positional ones on the same table in
    // Lua. A group on a branch that did not take part in the match has no
    // capture to offer, so it is left out rather than written as an empty
    // string — TAlias skips a PCRE2_UNSET slot for the same reason.
    const named: Record<string, string> = {};
    let index = -1;
    let start = 0;
    let m: Pcre2Match | null;
    // Only the first call checks the input is valid UTF-16 (see Pcre2.matchAll).
    let options = 0;
    while ((m = re.matchFrom(input, start, options)) !== null) {
        options = PCRE2_NO_UTF_CHECK;
        const whole = m[0];
        if (index < 0) index = whole.start;
        // pcre2_match returns one more than the highest group that took part,
        // and TAlias copies exactly that many — so a trailing optional group
        // that matched nothing adds no entry, while an unset one before a set
        // one still holds its place as an empty string.
        let last = m.length - 1;
        while (last > 0 && m[last].start < 0) last--;
        all.push(whole.match);
        for (let i = 1; i <= last; i++) all.push(m[i].start >= 0 ? m[i].match : '');
        for (let i = 1; i < m.length; i++) {
            const { name, start: at, match } = m[i];
            if (name !== undefined && at >= 0 && named[name] === undefined) named[name] = match;
        }
        if (whole.end > whole.start) {
            start = whole.end;
        } else {
            // A zero-width match would be found again at the same offset, so
            // step past it — by a whole code point, since PCRE2 in UTF-16 mode
            // rejects an offset that splits a surrogate pair.
            if (whole.end >= input.length) break;
            const cp = input.codePointAt(whole.end);
            start = whole.end + (cp !== undefined && cp > 0xffff ? 2 : 1);
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
        for (const id of [...this.temp.keys()]) {
            if (this.fireTemp(id, input)) fired = true;
        }
        return fired;
    }

    /** Match one temp alias against `input` and run it if it hits. */
    private fireTemp(id: number, input: string): boolean {
        const entry = this.temp.get(id);
        // A null pattern is an alias that exists but can never match — see
        // PatternEngine.addTemp.
        if (!entry?.pattern) return false;
        const hit = matchAllCaptures(input, entry.pattern);
        if (!hit) return false;
        // Re-read rather than trusting the snapshot's entry: killAlias
        // unsubscribes, and an alias taken out while this pass was running
        // must not still fire.
        const live = this.temp.get(id);
        if (!live) return false;
        live.fn(asMatchArray(hit.all, hit.index, input, hit.named));
        return true;
    }

    /**
     * A command's whole alias pass: every matching alias, temporary and
     * permanent alike, in the one order desktop's `mAliasRootNodeList` holds
     * them — creation order, with a permanent subtree walked where its root
     * sits (see PatternEngine's unified ordering). Running all the temps first
     * put a tempAlias made after a permAlias ahead of it (mudlet-web#327).
     * Temps fire themselves; each permanent hit goes to `firePerm` as it is
     * reached, for the reason {@link forEachPermMatch} gives. Both lists are
     * the ones that stood when the pass began. True when anything fired.
     */
    process(input: string, firePerm: (hit: PermAliasMatch) => void): boolean {
        const steps: { seq: number; at: number; temp?: number; perm?: string }[] = [];
        for (const [id, { seq }] of this.temp) steps.push({ seq, at: 0, temp: id });
        this.permOrder.forEach((id, i) => {
            steps.push({ seq: this.permRootSeq.get(id) ?? Number.MAX_SAFE_INTEGER, at: i + 1, perm: id });
        });
        steps.sort((a, b) => a.seq - b.seq || a.at - b.at);
        let fired = false;
        for (const step of steps) {
            if (step.temp !== undefined) {
                if (this.fireTemp(step.temp, input)) fired = true;
            } else if (step.perm !== undefined && this.firePermIfMatched(step.perm, input, firePerm)) {
                fired = true;
            }
        }
        return fired;
    }

    // ── Perm aliases (persisted, visible in UI) ────────────────────────────────

    /**
     * Walk the perm aliases in tree order and hand each one the input matches
     * to `fire` as it is reached — all of them fire, for the reason
     * {@link processTemp} gives. `matchedText` is the portion of `input` the
     * regex actually matched (Mudlet's `matches[1]`), which differs from the
     * whole input for an unanchored pattern.
     *
     * Match-then-fire, one alias at a time, rather than collecting every match
     * first: `AliasUnit::processDataStream` asks each alias `isActive()` as it
     * reaches it, so an earlier alias's `disableAlias`/`enableAlias` decides
     * whether a later one runs in the same pass (issue #284). The walk is over
     * the list as it stood when the pass began — a new alias waits for the
     * next command — but each step reads the live state, which the toggle has
     * already reloaded through the store subscription.
     */
    forEachPermMatch(input: string, fire: (hit: PermAliasMatch) => void): void {
        for (const id of this.permOrder) this.firePermIfMatched(id, input, fire);
    }

    private firePermIfMatched(id: string, input: string, fire: (hit: PermAliasMatch) => void): boolean {
        const entry = this.permById.get(id);
        if (!entry) return false;
        const hit = matchAllCaptures(input, entry.re);
        if (!hit) return false;
        fire({ alias: entry.item, matchedText: hit.all[0], captures: hit.all.slice(1), named: hit.named });
        return true;
    }

    /** Every perm alias the input matches, in tree order, without firing any.
     *  A command goes through {@link forEachPermMatch} instead. */
    matchAllPerm(input: string): PermAliasMatch[] {
        const hits: PermAliasMatch[] = [];
        this.forEachPermMatch(input, hit => hits.push(hit));
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
