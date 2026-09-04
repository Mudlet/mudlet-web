/**
 * The query compiler shared by every search bar in the app (the script editor's
 * `ScriptSearch`, the output find bar). Turns a raw query plus the
 * case/regex/whole-word toggles into something that hands back match ranges for
 * any string.
 */

/** Half-open `[start, end)` character offsets of one match. */
export type MatchRange = [number, number];

export interface SearchMatcher {
    /** False when `useRegex` was set and the pattern failed to compile — the
     *  caller shows the input as invalid rather than reporting "no results". */
    valid: boolean;
    ranges: (s: string) => MatchRange[];
}

const NO_RANGES: MatchRange[] = [];

/** Escape every regex metacharacter, so a literal needle can be embedded in a
 *  pattern — `QRegularExpression::escape` in desktop's whole-word path. */
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a search bar query into a matcher honouring the case / regex /
 * whole-word flags.
 *
 * `wholeWord` follows `dlgTriggerEditor::findSearchMatch`
 * (dlgTriggerEditor.cpp:13128-13148): the escaped needle wrapped in `\b…\b`. It
 * composes with regex mode too, which desktop has no equivalent for since its
 * search has no regex option — there the pattern is bracketed as written rather
 * than escaped, so `gold|silver` matches either word whole.
 */
export function buildMatcher(
    pattern: string,
    matchCase: boolean,
    useRegex: boolean,
    wholeWord = false,
): SearchMatcher {
    if (!pattern) return { valid: true, ranges: () => NO_RANGES };
    if (useRegex || wholeWord) {
        const source = useRegex ? pattern : escapeRegex(pattern);
        let re: RegExp;
        try {
            re = new RegExp(wholeWord ? `\\b(?:${source})\\b` : source, matchCase ? 'g' : 'gi');
        } catch {
            return { valid: false, ranges: () => NO_RANGES };
        }
        return {
            valid: true,
            ranges: (s) => {
                const out: MatchRange[] = [];
                re.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = re.exec(s)) !== null) {
                    out.push([m.index, m.index + m[0].length]);
                    if (m[0].length === 0) re.lastIndex++; // never spin on a zero-width match
                }
                return out;
            },
        };
    }
    const needle = matchCase ? pattern : pattern.toLowerCase();
    return {
        valid: true,
        ranges: (s) => {
            const hay = matchCase ? s : s.toLowerCase();
            const out: MatchRange[] = [];
            for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
                out.push([i, i + needle.length]);
            }
            return out;
        },
    };
}
