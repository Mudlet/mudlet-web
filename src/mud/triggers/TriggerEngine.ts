import PCRE from './pcre/Pcre2';
import type { TriggerNode, TriggerPattern } from '../../storage/schema';
import { buildEffectivelyEnabledIds } from '../../storage/schema';

export type { TriggerNode };

// A capture-group value. `undefined` marks a group that did not participate in
// the match (e.g. an optional `(...)?` that wasn't present) — Mudlet surfaces
// those as `nil` in the `matches` table, which a JS `undefined` becomes when
// pushed to Lua. (PCRE2 reports such groups as PCRE2_UNSET; JS RegExp already
// yields `undefined`, so this keeps both matcher paths consistent.)
type Capture = string | undefined;

type TempFn = (
    matches: Capture[],
    spans?: {
        captureSpans: CaptureSpan[];
        namedSpans?: Record<string, CaptureSpan>;
        matchSpan?: CaptureSpan;
    },
    namedGroups?: Record<string, string>,
) => void;

/**
 * Result of matching a trigger pattern against a line.
 *
 * `captureSpans` and `namedSpans` describe where each capture sits in the
 * source line — needed by `selectCaptureGroup` so it can re-select the
 * actual occurrence rather than picking the first textual match. Spans line
 * up positionally with `captures` (so `captureSpans[0]` is the position of
 * `captures[0]`, i.e. capture group 1). Both are optional because non-PCRE
 * matchers (substring/exactMatch/etc.) don't produce capture-group spans.
 */
type CaptureSpan = { start: number; length: number };
type MatchResult = {
    captures: Capture[];
    matchedText: string;
    namedGroups?: Record<string, string>;
    captureSpans?: CaptureSpan[];
    namedSpans?: Record<string, CaptureSpan>;
    matchStart?: number;
};

type Matcher = (line: string, isPrompt: boolean) => MatchResult | null;

/**
 * What `matchPerm`/`processAndTrigger` hand back to the engine. Adds the
 * trigger node and the AND-trigger-only `multimatches` array on top of the
 * raw `MatchResult`.
 */
export type TriggerMatch = {
    trigger: TriggerNode;
    captures: Capture[];
    matchedText: string;
    multimatches?: Capture[][];
    namedGroups?: Record<string, string>;
    captureSpans?: CaptureSpan[];
    namedSpans?: Record<string, CaptureSpan>;
    matchStart?: number;
};

/**
 * Fold every occurrence a "match all" pattern found into the one MatchResult the
 * trigger fires with. Mudlet keeps a single capture list across the whole
 * match-all loop, so `matches` reads {whole1, groups1…, whole2, groups2…} — a
 * flat run, not a nested one. The spans follow the same layout so
 * selectCaptureGroup(n) still points at the text matches[n] names.
 */
function mergeAllMatches(results: MatchResult[]): MatchResult | null {
    const first = results[0];
    if (!first) return null;
    if (results.length === 1) return first;
    const captures = [...first.captures];
    const captureSpans = [...(first.captureSpans ?? [])];
    const namedGroups = { ...first.namedGroups };
    const namedSpans = { ...first.namedSpans };
    for (const r of results.slice(1)) {
        captures.push(r.matchedText, ...r.captures);
        captureSpans.push(
            { start: r.matchStart ?? 0, length: r.matchedText.length },
            ...(r.captureSpans ?? r.captures.map(() => ({ start: 0, length: 0 }))),
        );
        // A named group repeated across occurrences keeps the FIRST one, which is
        // what a single-match trigger would have reported — later occurrences are
        // reachable positionally.
        for (const [name, value] of Object.entries(r.namedGroups ?? {})) {
            if (!(name in namedGroups)) namedGroups[name] = value;
        }
        for (const [name, span] of Object.entries(r.namedSpans ?? {})) {
            if (!(name in namedSpans)) namedSpans[name] = span;
        }
    }
    return {
        captures,
        matchedText: first.matchedText,
        matchStart: first.matchStart,
        captureSpans,
        namedGroups: Object.keys(namedGroups).length > 0 ? namedGroups : undefined,
        namedSpans: Object.keys(namedSpans).length > 0 ? namedSpans : undefined,
    };
}

function matchResultToTriggerMatch(trigger: TriggerNode, r: MatchResult): TriggerMatch {
    return {
        trigger,
        captures: r.captures,
        matchedText: r.matchedText,
        namedGroups: r.namedGroups,
        captureSpans: r.captureSpans,
        namedSpans: r.namedSpans,
        matchStart: r.matchStart,
    };
}

type PcreInstance = InstanceType<typeof PCRE>;
type PcreMatchGroup = { start: number; end: number; match: string; name?: string; group?: number };
type PcreMatch = { length: number; [k: number]: PcreMatchGroup; [k: string]: PcreMatchGroup | number };

/** Kicked off at module load so PCRE is ready by the time anything matches. */
const pcreReadyPromise = PCRE.init();

// DEBUG: diagnose pcre2-wasm-universal's hardcoded 1000-iter cap in matchAll.
function logSafetyLimit(callsite: string, pattern: string, subject: string): void {
    const ansiCount = (subject.match(/\x1b\[/g) ?? []).length;
    console.error('[matchAll safety limit]', {
        callsite,
        pattern,
        subjectLength: subject.length,
        ansiEscapeCount: ansiCount,
        subjectHead: subject.slice(0, 200),
        subjectTail: subject.slice(-200),
    });
}

type CompiledOrEntry = {
    kind: 'or';
    item: TriggerNode;
    tests: Array<Matcher>;
    testAll: ((line: string) => MatchResult[]) | null;
    depth: number;
};

type CompiledAndEntry = {
    kind: 'and';
    item: TriggerNode;
    conditions: Array<{ test: Matcher | null; spacer: number }>;
    depth: number;
};

type CompiledEntry = CompiledOrEntry | CompiledAndEntry;

/** A trigger enrolled for the current line because it was created while that
 *  line was being processed. Permanent triggers are named by their node id and
 *  temporary ones by their engine id — both can be created from a script. */
type SameLineEntry =
    | { kind: 'temp'; id: number }
    | { kind: 'perm'; id: string };

/** The lineage a trigger created mid-pass belongs to, and how many generations
 *  deep it sits in it. Absent on a trigger that was not created while a line was
 *  being processed. See TriggerEngine.addedWhileProcessing. */
interface SameLineChain {
    chainId: number;
    generation: number;
}

/** A session-scoped temporary trigger. `seq` is its registration order in the
 *  unified list (see TriggerEngine's ordering notes). */
type TempEntryBase = {
    fn: TempFn;
    seq: number;
    sameLine?: SameLineChain;
    name?: string;
    /** Run when the ENGINE stops this trigger of its own accord (a runaway
     *  lineage), so its owner can tear down what it holds — the Lua callback,
     *  the id isActive() reads. Not called for an ordinary disposal, where the
     *  owner is the one doing the stopping. */
    onStopped?: () => void;
};

/** What a caller can tell the engine about a temp trigger beyond its pattern. */
export interface TempOptions {
    /** As the runaway report names it. Mudlet uses the trigger's id when the
     *  call carried no name of its own. */
    name?: string;
    onStopped?: () => void;
}

type TempEntry =
    | ({ kind: 'regex'; re: PcreInstance } & TempEntryBase)
    | ({ kind: 'substring'; pattern: string } & TempEntryBase)
    | ({ kind: 'startOfLine'; pattern: string } & TempEntryBase)
    | ({ kind: 'exactMatch'; pattern: string } & TempEntryBase)
    | ({ kind: 'prompt' } & TempEntryBase)
    | ({ kind: 'line'; countdown: number; remaining: number; skipFirst: boolean } & TempEntryBase);

/**
 * One node in the unified processing list — either a permanent compiled entry
 * or a temporary trigger (referenced by its `temp` map id). `path` is the chain
 * of registration seqs from the root ancestor down to the node; sorting by it
 * lexicographically yields Mudlet's pre-order forest walk (a root immediately
 * followed by its descendants) with roots — including appended temps — ordered
 * by creation. Leading with ancestor seqs keeps a parent before its children
 * regardless of the child's own seq, so re-parenting can't break a chain.
 */
type UnifiedEntry =
    | { kind: 'perm'; perm: CompiledEntry; path: number[] }
    | { kind: 'temp'; id: number; path: number[] };

/** Lexicographic compare of two seq paths; the shorter (ancestor) sorts first. */
function comparePath(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
}

/**
 * Cached compile result for a single trigger node, keyed by item.id in
 * TriggerEngine.cache. The `signature` captures the fields that determine the
 * compiled shape (patterns + flags that switch AND/OR/testAll). On loadPerm,
 * entries whose signature matches are reused — their PCRE instances stay
 * alive, and only `item` ref + `depth` are updated in place. This is what
 * makes enable/disable churn cheap: flipping the enabled bit doesn't touch
 * the signature, so no PCRE recompiles. `compiled === null` records that
 * the item has no compilable tests (so we don't retry on every load).
 */
type CachedEntry = {
    signature: string;
    compiled: CompiledEntry | null;
    pcreInstances: PcreInstance[];
};

// JSON.stringify on every node every loadPerm is the dominant self-time cost
// inside loadPerm — the persisted blob has hundreds of pattern arrays and the
// stringify shows up in CPU profiles. Cache by node reference: zustand
// produces a new object only when fields actually change, so a TriggerNode
// whose patterns/flags didn't change is reference-equal to its prior loadPerm
// entry and the cached signature is reused. A toggle of `enabled` still
// produces a new node ref, but the recomputed signature is identical to the
// prior one, so the cache hit in TriggerEngine.cache survives the toggle.
const signatureCache = new WeakMap<TriggerNode, string>();
function signatureOf(item: TriggerNode): string {
    const hit = signatureCache.get(item);
    if (hit !== undefined) return hit;
    const sig = JSON.stringify({
        p: item.patterns,
        ml: !!item.multiline,
        mm: !!item.multipleMatches,
        g: !!item.isGroup,
    });
    signatureCache.set(item, sig);
    return sig;
}

type AndState = {
    nextIdx: number;
    startLine: number;
    waitUntilLine: number;
    captures: Capture[][];
    /** What each condition matched, kept alongside its captures because a
     *  `multimatches` row leads with the whole match (Mudlet's capture list
     *  starts at PCRE group 0) before the capture groups. */
    matchedTexts: string[];
    namedGroups: Array<Record<string, string>>;
};

/** Mutable ref so the Lua eval function can be swapped in after compilation. */
const luaEvalRef: { fn: ((code: string, line: string) => boolean) | null } = { fn: null };

/** Mutable ref for the buffer-aware colour check. Wired by ScriptingEngine to
 *  `ScriptingAPI.currentLineMatchesColor`, which inspects the live
 *  AnsiAwareBuffer on the main console (the trigger engine itself only sees
 *  the plain-text line, so the check has to come from outside). Used by the
 *  `colorTrigger` pattern branch — see `buildMatcher`. */
const colorMatchRef: {
    fn: ((fg: number, bg: number, window: { start: number; length: number } | null) => boolean) | null;
} = { fn: null };

/** The stretch of the ORIGINAL line a colour trigger may look at: the whole line
 *  normally, and only the parent's capture for a child of a filter — a colour
 *  outside that capture is not the child's to see. Set around each item's tests
 *  in matchPermEntryOnce, which is the only place that knows the window. */
const colorWindowRef: { window: { start: number; length: number } | null } = { window: null };

/** Where the same-line runaway report is printed. See setRunawayReporter. */
const runawayReportRef: { fn: ((text: string) => void) | null } = { fn: null };

/** Switches off a permanent trigger the engine stopped as part of a runaway
 *  lineage. Wired by ScriptingEngine to the store; unset the stop only reaches
 *  temporaries. */
const permDisableRef: { fn: ((nodeId: string) => void) | null } = { fn: null };

/** How many generations one lineage of triggers created while a line is being
 *  processed may reach before it is stopped. Mudlet's
 *  `TriggerUnit::scmMaxSameLineGenerations`. */
const MAX_SAME_LINE_GENERATIONS = 1000;

/** How many triggers created while processing one line are offered that line at
 *  all, across every lineage. Mudlet's `scmMaxSameLineCreationsPerLine`. */
const MAX_SAME_LINE_CREATIONS_PER_LINE = 20000;

/** Minimum gap between two runaway reports. */
const RUNAWAY_REPORT_INTERVAL_MS = 10000;

/** Parse a `"fg,bg"` colour-trigger pattern text into a `[fg, bg]` pair. Both
 *  default to -1 ("any") when missing or non-numeric. Mudlet uses ANSI
 *  palette indices 0..255 plus -1 for "any". */
/** The engine hands the matchers the line with the newline that ended it still
 *  attached (Host::runTriggers appends one), so a pattern may anchor on it —
 *  `foo\n$` is a legitimate way to say "and nothing followed". The `line`
 *  variable a script reads is the text alone, and so is anything a matcher with
 *  no match text of its own reports as `matches[1]`. */
function withEol(line: string): string {
    return line.endsWith('\n') ? line : line + '\n';
}

function stripEol(line: string): string {
    return line.endsWith('\n') ? line.slice(0, -1) : line;
}

function parseColorPattern(text: string): [number, number] {
    // Mudlet's own wire form, which is what an imported package or profile
    // carries: `ANSI_COLORS_F{003}_B{IGNORE}`. IGNORE is "any colour here", the
    // same as the -1 the plain form uses; DEFAULT is TTrigger's scmDefault
    // (-2), the console's own colour — a colour to match, not an "any". The
    // colour snapshot marks a segment left on the default with the same -2, so
    // the sentinel needs no translation.
    const mudlet = /^ANSI_COLORS_F\{(\d+|DEFAULT|IGNORE)\}_B\{(\d+|DEFAULT|IGNORE)\}$/.exec(text.trim());
    if (mudlet) {
        const channel = (token: string) =>
            token === 'IGNORE' ? -1 : token === 'DEFAULT' ? -2 : Math.trunc(Number(token));
        return [channel(mudlet[1]), channel(mudlet[2])];
    }
    const parts = text.split(',').map(s => s.trim());
    const fg = parts[0] !== undefined && parts[0] !== '' && Number.isFinite(Number(parts[0])) ? Math.trunc(Number(parts[0])) : -1;
    const bg = parts[1] !== undefined && parts[1] !== '' && Number.isFinite(Number(parts[1])) ? Math.trunc(Number(parts[1])) : -1;
    return [fg, bg];
}

function pcreToMatchResult(m: PcreMatch): MatchResult {
    const captures: Capture[] = [];
    const captureSpans: CaptureSpan[] = [];
    const namedGroups: Record<string, string> = {};
    const namedSpans: Record<string, CaptureSpan> = {};
    // pcre2-wasm-universal reports `m.length` as ovector pair count, which includes
    // the full match at index 0 — so capture groups are at 1..length-1, not 1..length.
    for (let i = 1; i < m.length; i++) {
        const cap = m[i] as PcreMatchGroup | undefined;
        // PCRE2 sets ovector to PCRE2_UNSET (start === -1) for groups that didn't
        // participate (e.g. an absent optional `(...)?`). Surface those as
        // `undefined` so the `matches` table reports `nil` at that slot — Mudlet's
        // behaviour (and what JS RegExp already yields for unmatched groups). The
        // span stays a zero-length placeholder to keep span indices aligned.
        const matched = cap && cap.start >= 0;
        captures.push(matched ? cap!.match : undefined);
        captureSpans.push({
            start: matched ? cap!.start : 0,
            length: matched ? cap!.end - cap!.start : 0,
        });
        if (matched && cap!.name) {
            namedGroups[cap!.name] = cap!.match;
            namedSpans[cap!.name] = { start: cap!.start, length: cap!.end - cap!.start };
        }
    }
    return {
        captures,
        matchedText: m[0].match,
        matchStart: m[0].start,
        captureSpans,
        namedGroups: Object.keys(namedGroups).length > 0 ? namedGroups : undefined,
        namedSpans: Object.keys(namedSpans).length > 0 ? namedSpans : undefined,
    };
}

// Mudlet compiles every trigger regex with PCRE2_UTF | PCRE2_UCP (TTrigger.cpp),
// so `\w`/`\d`/`\S` classify by Unicode property rather than by ASCII and a
// non-Latin line matches the same patterns a Latin one does. The wasm build here
// takes options as start-of-pattern verbs rather than a flags word; PCRE2 accepts
// a run of them, so a pattern carrying its own `(*...)` still compiles. Note the
// library runs in 16-bit mode, which makes UTF mean UTF-16: offsets stay in the
// code units JS strings are indexed by, so nothing downstream has to convert.
const UNICODE_VERBS = '(*UTF)(*UCP)';

/**
 * Compile a PCRE pattern. Returns null if compilation fails, with the failure
 * sticky-cached so we don't retry on every match.
 */
function compilePcre(pattern: string): PcreInstance | null {
    try { return new PCRE(UNICODE_VERBS + pattern); }
    catch { return null; }
}

function buildMatcher(p: TriggerPattern, register: (re: PcreInstance) => void): Matcher | null {
    switch (p.type) {
        case 'regex': {
            if (!p.text) return null;
            const re = compilePcre(p.text);
            if (!re) return null;
            register(re);
            return (line) => {
                const m = re.match(line) as PcreMatch | null;
                if (!m) return null;
                return pcreToMatchResult(m);
            };
        }
        case 'substring':
            if (!p.text) return null;
            return (line) => line.includes(p.text) ? { captures: [], matchedText: p.text } : null;
        case 'startOfLine':
            if (!p.text) return null;
            return (line) => line.startsWith(p.text) ? { captures: [], matchedText: p.text } : null;
        case 'exactMatch':
            if (!p.text) return null;
            // The haystack carries the trailing newline the engine appends; an
            // exact match is against the line without it (TTrigger::match_exact_match
            // chops one for the same reason).
            return (line) => stripEol(line) === p.text ? { captures: [], matchedText: p.text } : null;
        case 'prompt':
            return (_line, isPrompt) => isPrompt ? { captures: [], matchedText: '' } : null;
        case 'luaFunction': {
            const code = p.text;
            return (line) => {
                if (!luaEvalRef.fn) return null;
                const text = stripEol(line);
                return luaEvalRef.fn(code, text) ? { captures: [], matchedText: text } : null;
            };
        }
        case 'colorTrigger': {
            // `pattern.text` carries "fg,bg" as ANSI palette indices (-1 = any).
            // Empty / unparsable values fall through to -1, so a freshly-added
            // perm color trigger (`text: ''`) matches every line until the user
            // picks specific colours. The actual buffer scan runs via
            // `colorMatchRef.fn`, which ScriptingEngine wires to
            // `ScriptingAPI.currentLineMatchesColor`.
            const [fg, bg] = parseColorPattern(p.text);
            return (line) => {
                if (!line) return null;
                if (!colorMatchRef.fn) return null;
                return colorMatchRef.fn(fg, bg, colorWindowRef.window)
                    ? { captures: [], matchedText: stripEol(line) } : null;
            };
        }
        case 'lineSpacer':
            return null;
    }
}

export class TriggerEngine {
    private readonly temp = new Map<number, TempEntry>();
    /** Key for this engine's own temp map — see PatternEngine.nextInternalId. */
    private nextInternalId = 1;
    // True while processTemp is iterating. A `line` temp trigger created during
    // a handler (mid-pass) sets skipFirst so it doesn't tick on the line it was
    // created on — `from` then counts from the next line regardless of whether
    // the trigger was created from a handler, timer, or alias.
    private inProcessTemp = false;
    private permCompiled: CompiledEntry[] = [];
    private allById = new Map<string, TriggerNode>();

    // ── Unified ordering (Mudlet `mTriggerRootNodeList`) ──────────────────────
    // Mudlet keeps permanent and temporary triggers in ONE ordered list and
    // fires them front-to-back; runtime-created temps land after the package's
    // permanent triggers (which were registered earlier). mudix mirrors that
    // with a single monotonic registration counter shared by both:
    //   - permReg assigns a stable seq to each permanent node the first time it
    //     is seen, persisted across loadPerm rebuilds (so edits/toggles don't
    //     reshuffle order, and a perm added at runtime sorts AFTER existing
    //     temps — exactly like Mudlet's appended root list).
    //   - addTemp/addTempLine draw the next seq, so a temp sorts after every
    //     perm that existed when it was created.
    // `unified` is the merged, path-sorted processing list (see rebuildOrder);
    // `process()` walks it in one interleaved pass.
    private regCounter = 1;
    private permReg = new Map<string, number>();
    private unified: UnifiedEntry[] = [];
    private orderDirty = true;

    // ── triggers created while a line is being processed ─────────────────────
    // Mudlet walks its root list live, so a trigger a script arms mid-pass is
    // reached in the same iteration and gets a shot at the line being processed
    // — behaviour capture scripts lean on ("match the room title, then arm a
    // trigger for the line it is on"). mudix iterates a snapshot, so those have
    // to be collected and offered the line afterwards, which is what
    // `addedWhileProcessing` is for.
    //
    // That opens the door a trigger can walk through forever: one that arms a
    // copy of itself extends the list in front of the loop and the line never
    // finishes. Each mid-pass creation therefore joins a *lineage* — the same
    // one as the trigger whose script created it, one generation on — and a
    // lineage that reaches MAX_SAME_LINE_GENERATIONS is stopped whole. A script
    // arming a batch of unrelated triggers makes a generation of one-deep
    // lineages however big the batch, so it is never mistaken for a runaway.
    private processingDepth = 0;
    private addedWhileProcessing: (SameLineEntry | null)[] = [];
    /** Lineage of each permanent ROOT trigger enrolled for the current line. */
    private permSameLine = new Map<string, SameLineChain>();
    /** Lineage id → name of the trigger whose script started it, for the report. */
    private sameLineChainStarters = new Map<number, string>();
    private lastSameLineChainId = 0;
    private currentSameLineChainId = 0;
    private currentSameLineGeneration = 0;
    /** The name of the trigger whose script is running, for the abort report. */
    private currentExecutingTriggerName: string | null = null;
    /** When the runaway report was last posted, so a runaway whose creator
     *  outlives its line cannot bury the game text. */
    private lastRunawayReportAt = 0;

    // Per-item compile cache. Surviving items between loadPerm calls keep their
    // compiled state (and PCRE instances) here; only items whose signature
    // changed are recompiled, and only items removed entirely have their PCREs
    // freed. Items currently disabled stay cached so re-enabling is free.
    private cache = new Map<string, CachedEntry>();

    // Chain state: maps chain-head trigger ID → last line number on which chain
    // is open. A chain head is any trigger with children (group or not) — Mudlet
    // lets a leaf trigger with its own script also act as a chain head for the
    // nested triggers it contains.
    private lineCounter = 0;
    private readonly chainOpenUntil = new Map<string, number>();

    // IDs of triggers that have at least one child. Recomputed in loadPerm so
    // matchPerm and the chain-access helpers can answer "is this a chain head?"
    // without scanning the full tree per call.
    private hasChildren = new Set<string>();

    // AND state: per-trigger progress for multiline AND triggers
    private andStates = new Map<string, AndState[]>();
    /** Triggers still firing on their own after completing, and the match they
     *  re-report while they do. See the fire-length branch in matchPermEntryOnce. */
    private keepFiring = new Map<string, { until: number; match: TriggerMatch }>();

    // Filter state: chainHeadId → last matched/captured text
    private filterActiveText = new Map<string, string>();
    /** Every offering a filter makes to its children this line: one per
     *  capture group, or the whole match when it has none. See openChain. */
    private filterCaptures = new Map<string, { text: string; offset: number }[]>();
    // Parallel to filterActiveText: the offset of that text within the ORIGINAL
    // line. A descendant matching against the filtered text produces spans
    // relative to it, so selectCaptureGroup/selectString need this offset added
    // back to land on the real line (Mudlet #7886).
    private filterActiveOffset = new Map<string, number>();

    /** Resolves once PCRE wasm is initialized and patterns can be compiled. */
    static ready(): Promise<void> {
        return pcreReadyPromise.then(() => undefined);
    }

    /** Number of live session-scoped temp triggers (Mudlet `getProfileStats` temp count). */
    get tempCount(): number {
        return this.temp.size;
    }

    /**
     * Register a temp trigger. `kind` selects the match strategy:
     *   - `'regex'`     — PCRE, same syntax as permanent triggers (Mudlet
     *                     `tempRegexTrigger`). The callback receives
     *                     `[fullMatch, capture1, capture2, ...]`; unmatched
     *                     optional groups surface as empty strings.
     *   - `'substring'` — literal `String.prototype.includes` (Mudlet
     *                     `tempTrigger`). The callback receives `[pattern]`
     *                     so capture-group access against the substring is a
     *                     no-op rather than a metacharacter trap.
     *   - `'startOfLine'`— literal `String.prototype.startsWith` (Mudlet
     *                     `tempBeginOfLineTrigger`). Not anchored regex —
     *                     just a prefix check, which is why it's cheap.
     *                     Callback receives `[pattern]`.
     *   - `'exactMatch'`— full-line equality (Mudlet
     *                     `tempExactMatchTrigger`). Callback receives `[line]`.
     *   - `'prompt'`    — fires on every line the server flags as a prompt
     *                     (Mudlet `tempPromptTrigger`); `pattern` is ignored.
     *                     Callback receives `[line]`.
     * Invalid regex patterns return a no-op disposer so callers don't need
     * to special-case compile failures.
     */
    addTemp(
        pattern: string,
        fn: TempFn,
        kind: 'regex' | 'substring' | 'startOfLine' | 'exactMatch' | 'prompt' = 'regex',
        opts: TempOptions = {},
    ): () => void {
        const id = this.nextInternalId++;
        const seq = this.regCounter++;
        const { name, onStopped } = opts;
        if (kind === 'prompt') {
            this.temp.set(id, { kind, fn, seq, name, onStopped });
        } else if (kind === 'substring' || kind === 'startOfLine' || kind === 'exactMatch') {
            this.temp.set(id, { kind, pattern, fn, seq, name, onStopped });
        } else {
            const re = compilePcre(pattern);
            if (!re) return () => {};
            this.temp.set(id, { kind: 'regex', re, fn, seq, name, onStopped });
        }
        this.registerSameLineCreation(id);
        this.orderDirty = true;
        return () => {
            const entry = this.temp.get(id);
            if (!entry) return;
            if (entry.kind === 'regex') entry.re.destroy();
            this.temp.delete(id);
            this.orderDirty = true;
        };
    }

    /**
     * Mudlet `tempLineTrigger(from, howMany, fn)`. A position-based trigger with
     * no pattern: it fires `fn([lineText])` on `howMany` consecutive lines,
     * starting `from` lines ahead (`from = 1` → the next line). It self-expires
     * after the last fire. When created from within a handler, the line on which
     * it was created is skipped (see `inProcessTemp`/`skipFirst`) so `from`
     * counts from the next line in every creation context. Returns a disposer
     * for early cancellation.
     */
    addTempLine(from: number, howMany: number, fn: TempFn): () => void {
        const id = this.nextInternalId++;
        // `from` counts from the line being processed when there is one, and
        // from the next line otherwise — so a trigger armed mid-pass has one
        // more line ahead of it than the same call made from a timer. `from = 0`
        // therefore means "this line", which only a mid-pass call can reach.
        const ahead = Math.max(0, Math.trunc(from) || 0);
        this.temp.set(id, {
            kind: 'line',
            countdown: this.processingDepth > 0 ? ahead + 1 : Math.max(1, ahead),
            remaining: Math.max(1, Math.trunc(howMany) || 1),
            skipFirst: false,
            fn,
            seq: this.regCounter++,
        });
        this.registerSameLineCreation(id);
        this.orderDirty = true;
        return () => { this.temp.delete(id); this.orderDirty = true; };
    }

    loadPerm(items: TriggerNode[]): void {
        this.allById = new Map(items.map(i => [i.id, i]));
        const enabledIds = buildEffectivelyEnabledIds(items);

        // Assign each permanent node a stable registration seq the first time we
        // see it (in store/document order, where a parent always precedes its
        // children). Reusing the seq across reloads keeps order stable through
        // edits/toggles; a node added at runtime draws the current counter, so
        // it sorts after temps created before it — matching Mudlet's appended
        // root list. Prune seqs for nodes that were deleted.
        const liveIds = new Set<string>();
        for (const item of items) {
            liveIds.add(item.id);
            if (!this.permReg.has(item.id)) this.permReg.set(item.id, this.regCounter++);
        }
        for (const id of this.permReg.keys()) {
            if (!liveIds.has(id)) this.permReg.delete(id);
        }
        this.orderDirty = true;

        const hasChildren = new Set<string>();
        for (const it of items) {
            if (it.parentId) hasChildren.add(it.parentId);
        }
        this.hasChildren = hasChildren;
        const compiledIds = new Set<string>();
        const nextCache = new Map<string, CachedEntry>();
        const newCompiled: CompiledEntry[] = [];

        for (const item of items) {
            if (!item.patterns || item.patterns.length === 0) continue;

            const sig = signatureOf(item);
            const depth = this.computeDepth(item);
            let entry = this.cache.get(item.id);

            if (entry && entry.signature === sig) {
                // Reuse: same compile shape. Update mutable bits in place so
                // matchPerm sees the latest item ref (for code/name/highlight/
                // fireLength/delta/isFilter) and the latest depth (parentId
                // could have changed without touching the signature).
                this.cache.delete(item.id);
                if (entry.compiled) {
                    entry.compiled.item = item;
                    entry.compiled.depth = depth;
                }
            } else {
                if (entry) {
                    for (const re of entry.pcreInstances) re.destroy();
                    this.cache.delete(item.id);
                }
                entry = this.compileItem(item, depth, sig);
            }

            nextCache.set(item.id, entry);

            if (entry.compiled && enabledIds.has(item.id)) {
                newCompiled.push(entry.compiled);
                compiledIds.add(item.id);
            }
        }

        // Anything still in the old cache map is an item that was removed from
        // the trigger list entirely — destroy its PCREs.
        for (const e of this.cache.values()) {
            for (const re of e.pcreInstances) re.destroy();
        }
        this.cache = nextCache;

        // Sort by depth so parents (chain heads) are always processed before children.
        newCompiled.sort((a, b) => a.depth - b.depth);
        this.permCompiled = newCompiled;

        // Clean up AND states for triggers no longer compiled
        for (const id of this.andStates.keys()) {
            if (!compiledIds.has(id)) this.andStates.delete(id);
        }
    }

    /** Fresh compile for an item not present in the cache. Returns a CachedEntry
     * with `compiled: null` when no patterns produced a usable matcher — that
     * negative result is cached so we don't retry on every loadPerm. */
    private compileItem(item: TriggerNode, depth: number, signature: string): CachedEntry {
        const instances: PcreInstance[] = [];
        const register = (re: PcreInstance) => { instances.push(re); };
        let compiled: CompiledEntry | null = null;

        // Mudlet compacts a blank pattern out of the list as it stores the
        // trigger (TTrigger::setRegexCodeList), so nothing downstream ever sees
        // one; a prompt pattern is the single kind that legitimately carries no
        // text. The OR branch would drop a blank anyway — buildMatcher refuses
        // it — but an AND trigger would turn it into a condition nothing can
        // satisfy, and the trigger then silently never fires (Mudlet#9851). The
        // editor filters blank rows out, so these arrive from a perm*Trigger()
        // call or a hand-written package XML with an empty <string>.
        const patterns = item.patterns.filter(p => p.text !== '' || p.type === 'prompt');

        if (!item.isGroup && item.multiline) {
            // AND trigger: compile as a sequence of conditions
            const conditions: Array<{ test: Matcher | null; spacer: number }> = [];
            for (const p of patterns) {
                if (p.type === 'lineSpacer') {
                    const n = parseInt(p.text, 10);
                    conditions.push({ test: null, spacer: isNaN(n) || n < 1 ? 1 : n });
                } else {
                    const test = buildMatcher(p, register);
                    conditions.push({ test, spacer: 0 });
                }
            }
            if (conditions.length > 0) {
                compiled = { kind: 'and', item, conditions, depth };
            }
        } else {
            // OR trigger (or group): any pattern fires
            const tests: Matcher[] = [];
            let testAll: ((line: string) => MatchResult[]) | null = null;

            for (const pattern of patterns) {
                const test = buildMatcher(pattern, register);
                if (test) tests.push(test);

                // multipleMatches only for non-group regex patterns
                if (!item.isGroup && item.multipleMatches && pattern.type === 'regex' && pattern.text) {
                    const re = compilePcre(pattern.text);
                    if (re) {
                        register(re);
                        const triggerName = item.name;
                        const patternText = pattern.text;
                        testAll = (line: string) => {
                            const results: MatchResult[] = [];
                            let pcreMatches: PcreMatch[];
                            try {
                                pcreMatches = re.matchAll(line) as PcreMatch[];
                            } catch (err) {
                                if (err instanceof Error && err.message.includes('safety limit exceeded')) {
                                    logSafetyLimit(`trigger:${triggerName}(multipleMatches)`, patternText, line);
                                }
                                throw err;
                            }
                            for (const m of pcreMatches) {
                                results.push(pcreToMatchResult(m));
                            }
                            return results;
                        };
                    }
                }
            }

            if (tests.length > 0) {
                compiled = { kind: 'or', item, tests, testAll, depth };
            }
        }

        return { signature, compiled, pcreInstances: instances };
    }

    // ── Temp triggers (session-scoped, created by scripts) ────────────────────

    processTemp(line: string, isPrompt = false): void {
        const haystack = withEol(line);
        const prev = this.inProcessTemp;
        this.inProcessTemp = true;
        this.processingDepth++;
        try {
            // The map is walked live rather than snapshotted, so a trigger armed
            // by one of these handlers is reached in this same walk — the
            // temp-only equivalent of what `process()` needs its
            // addedWhileProcessing loop for.
            for (const [id, entry] of this.temp) {
                this.fireTempEntry(id, entry, haystack, isPrompt);
            }
        } finally {
            this.inProcessTemp = prev;
            this.endPass();
        }
    }

    /** Leave a processing pass, and once the outermost one is over, forget the
     *  lineages it tracked: a trigger that outlives the line it was created on
     *  is no longer part of one, so what IT creates later starts counting
     *  afresh. */
    private endPass(): void {
        this.processingDepth--;
        if (this.processingDepth > 0) return;
        for (const added of this.addedWhileProcessing) {
            if (added?.kind !== 'temp') continue;
            const entry = this.temp.get(added.id);
            if (entry) entry.sameLine = undefined;
        }
        this.addedWhileProcessing = [];
        this.permSameLine.clear();
        this.sameLineChainStarters.clear();
    }

    /** Match + fire a single temp trigger against `line`. Self-expiring `line`
     *  triggers delete themselves (and dirty the unified order) when spent. */
    private fireTempEntry(id: number, entry: TempEntry, line: string, isPrompt: boolean): void {
        // Named as the trigger whose script is running, and carrying its
        // lineage, so anything it arms is enrolled behind it rather than
        // starting a lineage of its own.
        this.runAsTrigger(entry.name ?? '', entry.sameLine, () =>
            this.fireTempEntryInner(id, entry, line, isPrompt));
    }

    private fireTempEntryInner(id: number, entry: TempEntry, line: string, isPrompt: boolean): void {
        if (entry.kind === 'line') {
            // Position-based: skip the creation-line tick, count down `from`,
            // then fire on each of the next `remaining` lines, self-expiring.
            if (entry.skipFirst) { entry.skipFirst = false; return; }
            if (entry.countdown > 1) { entry.countdown--; return; }
            entry.fn([stripEol(line)]);
            entry.remaining--;
            if (entry.remaining <= 0) { this.temp.delete(id); this.orderDirty = true; }
            return;
        }
        if (entry.kind === 'prompt') {
            if (isPrompt) entry.fn([stripEol(line)]);
            return;
        }
        if (entry.kind === 'substring') {
            if (line.includes(entry.pattern)) entry.fn([entry.pattern]);
            return;
        }
        if (entry.kind === 'startOfLine') {
            if (line.startsWith(entry.pattern)) entry.fn([entry.pattern]);
            return;
        }
        if (entry.kind === 'exactMatch') {
            const text = stripEol(line);
            if (text === entry.pattern) entry.fn([text]);
            return;
        }
        const m = entry.re.match(line) as PcreMatch | null;
        if (!m) return;
        const result = pcreToMatchResult(m);
        entry.fn(
            [result.matchedText, ...result.captures],
            {
                captureSpans: result.captureSpans ?? [],
                namedSpans: result.namedSpans,
                matchSpan: result.matchStart !== undefined
                    ? { start: result.matchStart, length: result.matchedText.length }
                    : undefined,
            },
            result.namedGroups,
        );
    }

    // ── Perm triggers (persisted, visible in UI) ──────────────────────────────

    matchPerm(line: string, isPrompt = false): TriggerMatch[] {
        const currentLine = this.lineCounter++;
        const seen = new Set<string>();
        const results: TriggerMatch[] = [];
        for (const entry of this.permCompiled) {
            this.matchPermEntry(entry, line, isPrompt, currentLine, seen, results);
        }
        return results;
    }

    /**
     * Match one permanent compiled entry against `line`, appending any matches
     * to `out`. Updates chain/AND/filter state exactly as the old inline loop
     * did. `seen` dedupes a single OR/group item within one line pass; it is
     * shared across all entries processed for that line.
     */
    private matchPermEntry(
        entry: CompiledEntry,
        line: string,
        isPrompt: boolean,
        currentLine: number,
        seen: Set<string>,
        out: TriggerMatch[],
    ): void {
        // A filter offering more than one capture runs everything below it once
        // per capture — see openChain. The offering is swapped in around each
        // run so getEffectiveLine/getEffectiveOffset, and everything that reads
        // them, need know nothing about it.
        const filterId = this.innermostFilterId(entry.item);
        const captures = filterId ? this.filterCaptures.get(filterId) : undefined;
        if (!filterId || !captures || captures.length < 2) {
            this.matchPermEntryOnce(entry, line, isPrompt, currentLine, seen, out, '');
            return;
        }
        for (let i = 0; i < captures.length; i++) {
            this.filterActiveText.set(filterId, captures[i].text);
            this.filterActiveOffset.set(filterId, captures[i].offset);
            // Each offering is its own pass as far as the once-per-line dedupe
            // is concerned, or only the first would reach a child.
            this.matchPermEntryOnce(entry, line, isPrompt, currentLine, seen, out, `#${i}`);
        }
        this.filterActiveText.set(filterId, captures[0].text);
        this.filterActiveOffset.set(filterId, captures[0].offset);
    }

    /** The nearest filter ancestor of `item`, or null when it has none. */
    private innermostFilterId(item: TriggerNode): string | null {
        let parentId = item.parentId;
        while (parentId) {
            const parent = this.allById.get(parentId);
            if (!parent) return null;
            if (parent.isFilter) return parent.id;
            parentId = parent.parentId;
        }
        return null;
    }

    private matchPermEntryOnce(
        entry: CompiledEntry,
        line: string,
        isPrompt: boolean,
        currentLine: number,
        seen: Set<string>,
        out: TriggerMatch[],
        seenSuffix: string,
    ): void {
        const { item } = entry;
        if (!this.isChainAccessible(item, currentLine)) return;
        const seenKey = item.id + seenSuffix;
        // A colour trigger under a filter may only look at the stretch of the
        // line its parent captured — see colorWindowRef.
        const previousColorWindow = colorWindowRef.window;

        const effectiveLine = this.getEffectiveLine(item, line);
        // Offset of effectiveLine within the original line (non-zero only under a
        // filter ancestor). openChain consumes the UNSHIFTED result (it adds this
        // offset itself); pushed matches are re-based onto the original line.
        const effOffset = this.getEffectiveOffset(item);
        const isChainHead = item.isGroup || this.hasChildren.has(item.id);
        colorWindowRef.window = effectiveLine === line
            ? null
            : { start: effOffset, length: effectiveLine.length };

        try {
            if (item.isGroup) {
                // Chain head: match opens the chain for children.
                if (seen.has(seenKey)) return;
                // Groups are always OR-compiled
                const orEntry = entry as CompiledOrEntry;
                let result: MatchResult | null = null;
                for (const test of orEntry.tests) {
                    result = test(effectiveLine, isPrompt);
                    if (result !== null) break;
                }
                if (result !== null) {
                    seen.add(seenKey);
                    this.openChain(item, currentLine, result);
                    if (item.code) {
                        out.push(matchResultToTriggerMatch(item, this.shiftResultSpans(result, effOffset)));
                    }
                }
            } else if (entry.kind === 'and') {
                const completed = this.processAndTrigger(entry, effectiveLine, isPrompt, currentLine);
                for (const r of completed) {
                    if (isChainHead) {
                        this.openChain(item, currentLine, {
                            captures: r.captures,
                            matchedText: r.matchedText,
                        });
                    }
                    out.push(r);
                }
                // A fire length keeps the trigger going for that many more lines —
                // Mudlet's mKeepFiring, set on every completion and spent one line
                // at a time. Only a childless trigger re-runs its own script; one
                // with children is holding the chain open FOR them.
                const fireLength = item.fireLength ?? 0;
                if (completed.length > 0 && fireLength > 0 && !this.hasChildren.has(item.id)) {
                    this.keepFiring.set(item.id, {
                        until: currentLine + fireLength,
                        match: completed[completed.length - 1],
                    });
                } else if (completed.length === 0) {
                    const keep = this.keepFiring.get(item.id);
                    if (keep && currentLine <= keep.until) out.push(keep.match);
                    else if (keep) this.keepFiring.delete(item.id);
                }
            } else {
                // OR entry (non-group)
                if (entry.testAll) {
                    // "Match all occurrences" fires the trigger ONCE and hands it
                    // every occurrence at the same time: Mudlet appends each
                    // further match's whole-match-plus-captures to the same
                    // capture list (TTrigger::match_perl, mPerlSlashGOption), so
                    // matches[1] is the first whole match and the rest of the
                    // occurrences follow the first one's groups. Firing once per
                    // occurrence instead would run the script N times and show it
                    // only one match each.
                    const merged = mergeAllMatches(entry.testAll(effectiveLine));
                    if (merged !== null) {
                        if (isChainHead) this.openChain(item, currentLine, merged);
                        out.push(matchResultToTriggerMatch(item, this.shiftResultSpans(merged, effOffset)));
                    }
                } else {
                    if (seen.has(seenKey)) return;
                    let result: MatchResult | null = null;
                    for (const test of entry.tests) {
                        result = test(effectiveLine, isPrompt);
                        if (result !== null) break;
                    }
                    if (result !== null) {
                        seen.add(seenKey);
                        if (isChainHead) this.openChain(item, currentLine, result);
                        out.push(matchResultToTriggerMatch(item, this.shiftResultSpans(result, effOffset)));
                    }
                }
            }
        } finally {
            colorWindowRef.window = previousColorWindow;
        }
    }

    // ── Unified pass (permanent + temporary, in registration order) ───────────

    /**
     * Mudlet-faithful single pass: walk the one ordered list of permanent and
     * temporary triggers (see the ordering notes on the fields) and, for each
     * node in turn, match + act on it before moving to the next. Permanent
     * matches are handed to `exec` inline (the caller runs the trigger's
     * command/code); temporary triggers fire their own callback. Because a
     * runtime temp sorts after the permanent triggers that existed when it was
     * created, a permanent trigger on a line runs before a temp that also
     * matches it — which is exactly the order Mudlet produces.
     *
     * The processing list is snapshotted up front (like Mudlet's
     * `copyOfNodeList`), so triggers created mid-pass don't fire on the current
     * line, and `inProcessTemp` is saved/restored to stay correct under the
     * re-entrancy a handler can cause via `feedTriggers`.
     */
    process(line: string, isPrompt: boolean, exec: (match: TriggerMatch) => void): void {
        const haystack = withEol(line);
        if (this.orderDirty) this.rebuildOrder();
        const snapshot = this.unified;
        const currentLine = this.lineCounter++;
        const seen = new Set<string>();
        const matches: TriggerMatch[] = [];
        const prev = this.inProcessTemp;
        this.inProcessTemp = true;
        this.processingDepth++;
        // Entries below this index belong to an outer (nested feedTriggers) pass
        // and are already in this pass's snapshot.
        const firstAddedThisPass = this.addedWhileProcessing.length;
        try {
            for (const u of snapshot) {
                if (u.kind === 'temp') {
                    // Re-fetch: an earlier handler this pass may have disposed it.
                    const cur = this.temp.get(u.id);
                    if (cur) this.fireTempEntry(u.id, cur, haystack, isPrompt);
                } else {
                    matches.length = 0;
                    this.matchPermEntry(u.perm, haystack, isPrompt, currentLine, seen, matches);
                    for (const m of matches) this.execPerm(m, exec);
                }
            }
            // Now the triggers armed during that walk, which the snapshot could
            // not contain. The list grows in front of this loop as they arm
            // more, so each generation gets its shot at the same line — and the
            // budget below is the only thing that ends a lineage that keeps
            // re-creating itself.
            for (let i = firstAddedThisPass; i < this.addedWhileProcessing.length; i++) {
                if (i - firstAddedThisPass >= MAX_SAME_LINE_CREATIONS_PER_LINE) {
                    console.warn(`[TriggerEngine] more than ${MAX_SAME_LINE_CREATIONS_PER_LINE} `
                        + 'triggers were created while processing one line, so the rest are not being offered it');
                    break;
                }
                const added = this.addedWhileProcessing[i];
                if (added === null) continue;
                const sameLine = this.sameLineOf(added);
                if (!sameLine) continue;
                if (sameLine.generation > MAX_SAME_LINE_GENERATIONS) {
                    // The whole lineage goes, so its remaining members are gone
                    // by the time this loop reaches them and it trips only once.
                    this.stopSameLineCreationLoop(sameLine.chainId);
                    continue;
                }
                if (added.kind === 'temp') {
                    const entry = this.temp.get(added.id);
                    if (entry) this.fireTempEntry(added.id, entry, line, isPrompt);
                    continue;
                }
                const perm = this.permCompiled.find(e => e.item.id === added.id);
                if (!perm) continue;
                matches.length = 0;
                this.matchPermEntry(perm, line, isPrompt, currentLine, seen, matches);
                for (const m of matches) this.execPerm(m, exec);
            }
        } finally {
            this.inProcessTemp = prev;
            this.endPass();
        }
    }

    /**
     * Enrol a trigger armed while a line was being processed, so the pass can
     * offer it that line, and put it in a lineage: the one belonging to the
     * trigger whose script armed it, a generation on, or a new one when the
     * script predates the line.
     */
    private registerSameLineCreation(id: number): void {
        if (this.processingDepth === 0) return;
        const entry = this.temp.get(id);
        if (!entry) return;
        entry.sameLine = this.nextSameLineChain();
        this.addedWhileProcessing.push({ kind: 'temp', id });
    }

    /**
     * The same, for a permanent trigger a script created mid-pass. Only ROOT
     * triggers carry a lineage: one sitting in a folder creates on the folder's
     * behalf, and reading the child's own (always empty) lineage instead would
     * start a fresh one every round — which never deepens and so never trips.
     */
    notePermCreated(node: TriggerNode, root: TriggerNode): void {
        if (this.processingDepth === 0) return;
        if (!this.permSameLine.has(root.id)) this.permSameLine.set(root.id, this.nextSameLineChain());
        this.addedWhileProcessing.push({ kind: 'perm', id: node.id });
    }

    /** Join the lineage of the trigger whose script is running, a generation on;
     *  or start one when that script predates the line. */
    private nextSameLineChain(): SameLineChain {
        let chainId = this.currentSameLineChainId;
        if (!chainId) {
            chainId = ++this.lastSameLineChainId;
            this.sameLineChainStarters.set(chainId, this.currentExecutingTriggerName ?? '');
        }
        return { chainId, generation: this.currentSameLineGeneration + 1 };
    }

    /** The lineage of something enrolled for this line, whichever kind it is. */
    private sameLineOf(added: SameLineEntry): SameLineChain | undefined {
        if (added.kind === 'temp') return this.temp.get(added.id)?.sameLine;
        const node = this.allById.get(added.id);
        return node ? this.permSameLine.get(this.rootIdOf(node)) : undefined;
    }

    /** The root ancestor's id — the node a lineage is recorded against. */
    private rootIdOf(node: TriggerNode): string {
        let cur = node;
        const guard = new Set<string>([cur.id]);
        while (cur.parentId) {
            const parent = this.allById.get(cur.parentId);
            if (!parent || guard.has(parent.id)) break;
            guard.add(parent.id);
            cur = parent;
        }
        return cur.id;
    }

    /** Run a permanent trigger's script inside its lineage, so what it creates
     *  is enrolled behind it rather than starting a lineage of its own. */
    private execPerm(m: TriggerMatch, exec: (match: TriggerMatch) => void): void {
        this.runAsTrigger(
            m.trigger.name,
            this.permSameLine.get(this.rootIdOf(m.trigger)),
            () => exec(m));
    }

    /**
     * Run `fn` as the script of the trigger named `name`, so anything it arms
     * joins that trigger's lineage rather than starting one of its own.
     */
    runAsTrigger<T>(name: string, sameLine: SameLineChain | undefined, fn: () => T): T {
        const prevName = this.currentExecutingTriggerName;
        const prevChain = this.currentSameLineChainId;
        const prevGeneration = this.currentSameLineGeneration;
        this.currentExecutingTriggerName = name;
        this.currentSameLineChainId = sameLine?.chainId ?? 0;
        this.currentSameLineGeneration = sameLine?.generation ?? 0;
        try {
            return fn();
        } finally {
            this.currentExecutingTriggerName = prevName;
            this.currentSameLineChainId = prevChain;
            this.currentSameLineGeneration = prevGeneration;
        }
    }

    /**
     * End a lineage that keeps arming triggers which match the line being
     * processed. Stopping the pass alone would not do: what it created is still
     * live, so the next line would start with a budget's worth of them and each
     * would spawn a budget's worth again. Only this lineage is disowned — a
     * capture trigger an unrelated script armed on the same line belongs to a
     * lineage of its own and is left alone.
     */
    private stopSameLineCreationLoop(chainId: number): void {
        let stopped = 0;
        for (let i = 0; i < this.addedWhileProcessing.length; i++) {
            const added = this.addedWhileProcessing[i];
            if (added === null) continue;
            if (this.sameLineOf(added)?.chainId !== chainId) continue;
            if (added.kind === 'temp') {
                const entry = this.temp.get(added.id);
                if (!entry) continue;
                // Through the owner as well as the map: what makes a trigger
                // gone to isActive() and to the Lua callback registry is its
                // owner's teardown, not this entry disappearing.
                entry.onStopped?.();
                if (this.temp.has(added.id)) {
                    if (entry.kind === 'regex') entry.re.destroy();
                    this.temp.delete(added.id);
                }
            } else {
                // A permanent trigger is switched off rather than removed —
                // there is no removal API for one, and the player's own copy of
                // it has to survive being stopped.
                const node = this.allById.get(added.id);
                if (!node) continue;
                permDisableRef.fn?.(added.id);
            }
            // Nulled rather than spliced out: the loop in process() is walking
            // this list by index, and shifting entries under it would skip a
            // trigger's turn at the line.
            this.addedWhileProcessing[i] = null;
            stopped++;
            this.orderDirty = true;
        }
        this.reportRunaway(this.sameLineChainStarters.get(chainId) ?? '', stopped);
    }

    /** Tell the player, at most once every REPORT interval — a runaway whose
     *  creator outlives the line trips on every matching line, and an unthrottled
     *  report would bury the game text it is trying to explain. */
    private reportRunaway(triggerName: string, stopped: number): void {
        const now = Date.now();
        if (this.lastRunawayReportAt && now - this.lastRunawayReportAt < RUNAWAY_REPORT_INTERVAL_MS) return;
        this.lastRunawayReportAt = now;
        const created = `${stopped} trigger(s) created while processing this line have been stopped: `
            + 'temporary ones removed, permanent ones switched off until the profile is reloaded.';
        const who = triggerName ? `trigger '${triggerName}' (or another trigger it creates)` : 'a trigger (or another trigger it creates)';
        runawayReportRef.fn?.(
            `[ ERROR ] - Trigger processing stopped to prevent a freeze: ${who} keeps creating new `
            + 'triggers that match the line being processed, so that line never finishes. '
            + `${created} Create the trigger once, outside its own script, or give it a pattern `
            + 'that does not match the line it is created on.');
    }

    /** Where the runaway report is printed. ScriptingEngine wires this to the
     *  main console; unset (tests, teardown) the report is dropped. */
    setRunawayReporter(fn: ((text: string) => void) | null): void {
        runawayReportRef.fn = fn;
    }

    /** How the engine switches off a permanent trigger it stopped. */
    setPermDisabler(fn: ((nodeId: string) => void) | null): void {
        permDisableRef.fn = fn;
    }

    /** Rebuild the merged, path-sorted processing list from the current
     *  permanent entries and temporary triggers. Called lazily from process()
     *  when either source changed. */
    private rebuildOrder(): void {
        const entries: UnifiedEntry[] = [];
        for (const perm of this.permCompiled) {
            entries.push({ kind: 'perm', perm, path: this.permPath(perm.item) });
        }
        for (const [id, t] of this.temp) {
            entries.push({ kind: 'temp', id, path: [t.seq] });
        }
        entries.sort((a, b) => comparePath(a.path, b.path));
        this.unified = entries;
        this.orderDirty = false;
    }

    /** The registration-seq path from the root ancestor down to `item`. */
    private permPath(item: TriggerNode): number[] {
        const chain: number[] = [];
        let cur: TriggerNode | undefined = item;
        const guard = new Set<string>();
        while (cur && !guard.has(cur.id)) {
            guard.add(cur.id);
            chain.push(this.permReg.get(cur.id) ?? 0);
            cur = cur.parentId ? this.allById.get(cur.parentId) : undefined;
        }
        return chain.reverse();
    }

    setLuaEval(fn: ((code: string, line: string) => boolean) | null): void {
        luaEvalRef.fn = fn;
    }

    /**
     * Wire the buffer-aware colour check used by `colorTrigger` patterns. The
     * matcher receives the parsed `(fg, bg)` indices and asks the registered
     * callback whether the line just appended to the main console carries any
     * segment with those colours. ScriptingEngine sets this to delegate to
     * `ScriptingAPI.currentLineMatchesColor`. Passing `null` disables every
     * colour trigger (e.g. during runtime teardown).
     */
    setColorMatcher(fn: ((fg: number, bg: number, window: { start: number; length: number } | null) => boolean) | null): void {
        colorMatchRef.fn = fn;
    }

    destroy(): void {
        for (const entry of this.temp.values()) {
            if (entry.kind === 'regex') entry.re.destroy();
        }
        this.temp.clear();
        this.permCompiled = [];
        for (const e of this.cache.values()) {
            for (const re of e.pcreInstances) re.destroy();
        }
        this.cache.clear();
        this.allById.clear();
        this.chainOpenUntil.clear();
        this.lineCounter = 0;
        this.andStates.clear();
        this.keepFiring.clear();
        this.filterActiveText.clear();
        this.filterActiveOffset.clear();
        this.filterCaptures.clear();
        this.hasChildren.clear();
        this.permReg.clear();
        this.unified = [];
        this.regCounter = 1;
        this.orderDirty = true;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Advance every state an AND trigger has in flight against this line, and
     * report the ones that completed on it.
     *
     * States are a LIST, not one: a trigger whose first condition matches twice
     * before its second ever does has two matches part-way through, and both
     * complete when that second condition finally arrives. Keeping a single
     * state let the newer one overwrite the older, so only one ever fired.
     */
    private processAndTrigger(
        entry: CompiledAndEntry,
        effectiveLine: string,
        isPrompt: boolean,
        currentLine: number,
    ): TriggerMatch[] {
        const { item, conditions } = entry;
        const delta = item.delta ?? 0;
        // A state that has waited longer than the trigger's line delta allows is
        // gone before this line is offered to it.
        const states = (this.andStates.get(item.id) ?? [])
            .filter(state => !(delta > 0 && currentLine - state.startLine > delta));

        // The first condition matching always starts a state, however many are
        // already under way — that is what lets two of them complete together.
        const first = conditions[0];
        if (first && first.spacer === 0 && first.test) {
            const opened = first.test(effectiveLine, isPrompt);
            if (opened) {
                states.push({
                    nextIdx: 1,
                    startLine: currentLine,
                    waitUntilLine: currentLine,
                    captures: [opened.captures],
                    matchedTexts: [opened.matchedText],
                    namedGroups: [opened.namedGroups ?? {}],
                });
            }
        }

        const stillWaiting: AndState[] = [];
        const fired: TriggerMatch[] = [];
        for (const state of states) {
            this.advanceAndState(state, conditions, effectiveLine, isPrompt, currentLine);
            if (state.nextIdx >= conditions.length) fired.push(this.andMatch(item, state));
            else stillWaiting.push(state);
        }
        this.andStates.set(item.id, stillWaiting);
        return fired;
    }

    /** Carry one in-flight state as far through the remaining conditions as this
     *  line takes it. Several can be satisfied by the same line. */
    private advanceAndState(
        state: AndState,
        conditions: CompiledAndEntry['conditions'],
        effectiveLine: string,
        isPrompt: boolean,
        currentLine: number,
    ): void {
        while (state.nextIdx < conditions.length) {
            if (currentLine < state.waitUntilLine) break;
            const cond = conditions[state.nextIdx];

            if (cond.spacer > 0) {
                // Line spacer: set the wait and advance, then stop for this line.
                state.waitUntilLine = currentLine + cond.spacer;
                state.nextIdx++;
                break;
            }
            if (!cond.test) {
                // A null test outside a spacer should not happen — skip it.
                state.nextIdx++;
                continue;
            }
            const result = cond.test(effectiveLine, isPrompt);
            if (!result) break;
            state.captures.push(result.captures);
            state.matchedTexts.push(result.matchedText);
            state.namedGroups.push(result.namedGroups ?? {});
            state.nextIdx++;
        }
    }

    /** The match a completed AND state reports: every line's captures, in order,
     *  as `multimatches`. */
    private andMatch(item: TriggerNode, state: AndState): TriggerMatch {
        const lastNamedGroups = state.namedGroups[state.namedGroups.length - 1] ?? {};
        return {
            trigger: item,
            captures: state.captures.flat(),
            matchedText: '',
            multimatches: state.captures.map((c, i) => [state.matchedTexts[i], ...c]),
            namedGroups: Object.keys(lastNamedGroups).length > 0 ? lastNamedGroups : undefined,
        };
    }

    /**
     * Record a chain-head match: open the chain for `fireLength` more lines and,
     * if the trigger is also a filter, stash the captured/matched text so
     * descendants see it as their effective input.
     */
    private openChain(item: TriggerNode, currentLine: number, result: { captures: Capture[]; matchedText: string; captureSpans?: CaptureSpan[]; matchStart?: number }): void {
        this.chainOpenUntil.set(item.id, currentLine + (item.fireLength ?? 0));
        if (item.isFilter) {
            // Every capture is offered to the children, not just the first:
            // Mudlet's TTrigger::match runs `filter()` once per capture group
            // when there is more than one, so a parent matching `hit (\\w+) for
            // (\\d+)` hands its children "orc" and then "12". With no capture
            // group at all there is one offering, the whole match.
            const base = this.getEffectiveOffset(item);
            const captured: { text: string; span?: CaptureSpan }[] = [];
            result.captures.forEach((text, i) => {
                if (text !== undefined) captured.push({ text, span: result.captureSpans?.[i] });
            });
            this.filterCaptures.set(item.id, captured.length > 0
                ? captured.map(c => ({ text: c.text, offset: base + (c.span?.start ?? result.matchStart ?? 0) }))
                : [{ text: result.matchedText, offset: base + (result.matchStart ?? 0) }]);
            this.filterActiveText.set(item.id, result.captures[0] ?? result.matchedText);
            // Where the filtered text starts in the ORIGINAL line: this item's own
            // effective offset, plus where the captured/matched text sits within
            // the (possibly already filtered) line this item matched against. A
            // filter on the first capture group uses that group's span; one with
            // no capture group passes its whole match, so use the match start.
            const usesCapture = result.captures[0] !== undefined && result.captureSpans?.[0] !== undefined;
            const spanStart = usesCapture ? result.captureSpans![0].start : (result.matchStart ?? 0);
            this.filterActiveOffset.set(item.id, this.getEffectiveOffset(item) + spanStart);
        }
    }

    /**
     * Mudlet `setTriggerStayOpen(name, lines)`: keep the named chain head(s)
     * open for `lines` more lines of input, starting from the line currently
     * being processed. This is transient runtime state — it mutates only the
     * `chainOpenUntil` window, never the persisted `fireLength` on the node, so
     * the trigger's stored definition is untouched and the override expires
     * naturally as input scrolls past.
     *
     * `matchPerm` post-increments `lineCounter`, so during a trigger's script
     * the line just matched is `lineCounter - 1`; the window math then mirrors
     * `openChain` exactly. Negative counts clamp to 0 (open for the current
     * line only). `ids` are resolved by name by the caller.
     */
    setStayOpen(ids: string[], lines: number): void {
        const currentLine = this.lineCounter - 1;
        const openUntil = currentLine + Math.max(0, Math.trunc(lines));
        for (const id of ids) {
            this.chainOpenUntil.set(id, openUntil);
        }
    }

    /**
     * Returns the effective line to match against for `item`.
     * If a filter-trigger ancestor has active filter text, that text is used instead.
     * Innermost filter wins.
     */
    private getEffectiveLine(item: TriggerNode, originalLine: string): string {
        let effective = originalLine;
        let parentId = item.parentId;
        while (parentId) {
            const parent = this.allById.get(parentId);
            if (!parent) break;
            if (parent.isFilter) {
                const filtered = this.filterActiveText.get(parentId);
                if (filtered !== undefined) effective = filtered;
                // innermost filter wins, so break after first filter ancestor we find going up
                // (we walk from child up so first one found IS the innermost)
                break;
            }
            parentId = parent.parentId;
        }
        return effective;
    }

    /** The offset within the ORIGINAL line at which `item`'s effective (filtered)
     *  input begins — 0 unless it sits under a filter ancestor. Mirrors
     *  getEffectiveLine: the innermost filter ancestor's recorded offset. */
    private getEffectiveOffset(item: TriggerNode): number {
        let parentId = item.parentId;
        while (parentId) {
            const parent = this.allById.get(parentId);
            if (!parent) break;
            if (parent.isFilter) {
                return this.filterActiveOffset.get(parentId) ?? 0;
            }
            parentId = parent.parentId;
        }
        return 0;
    }

    /** Return a copy of `r` with every span (matchStart, captureSpans, namedSpans)
     *  shifted by `offset` — used to re-base a filtered descendant's spans onto
     *  the original line so selectCaptureGroup/selectString hit the right column.
     *  Zero-length (unmatched-group) placeholders keep length 0. */
    private shiftResultSpans(r: MatchResult, offset: number): MatchResult {
        if (!offset) return r;
        return {
            ...r,
            matchStart: r.matchStart !== undefined ? r.matchStart + offset : undefined,
            captureSpans: r.captureSpans?.map(s => ({ start: s.start + offset, length: s.length })),
            namedSpans: r.namedSpans
                ? Object.fromEntries(Object.entries(r.namedSpans).map(([k, s]) => [k, { start: s.start + offset, length: s.length }]))
                : undefined,
        };
    }

    /**
     * A trigger is chain-accessible if every patterned ancestor has an open
     * chain (matched within the last fireLength lines, inclusive of the current
     * line). Pattern-less ancestors (pure folders) always grant access. This
     * applies regardless of whether the ancestor is a folder or a leaf with its
     * own script — Mudlet treats any patterned trigger with children as a chain
     * head.
     */
    private isChainAccessible(item: TriggerNode, currentLine: number): boolean {
        let parentId = item.parentId;
        while (parentId) {
            const parent = this.allById.get(parentId);
            if (!parent) break;
            if (parent.patterns && parent.patterns.length > 0) {
                const openUntil = this.chainOpenUntil.get(parentId);
                if (openUntil === undefined || openUntil < currentLine) return false;
            }
            parentId = parent.parentId;
        }
        return true;
    }

    private computeDepth(item: TriggerNode): number {
        let depth = 0;
        let parentId = item.parentId;
        while (parentId) {
            const parent = this.allById.get(parentId);
            if (!parent) break;
            depth++;
            parentId = parent.parentId;
        }
        return depth;
    }
}
