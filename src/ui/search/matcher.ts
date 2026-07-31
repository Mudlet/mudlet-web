/**
 * The query compiler shared by every search bar in the app (the script editor's
 * `ScriptSearch`, the output find bar). Turns a raw query plus the case/regex
 * toggles into something that hands back match ranges for any string.
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

/** Compile a search bar query into a matcher honouring the case / regex flags. */
export function buildMatcher(pattern: string, matchCase: boolean, useRegex: boolean): SearchMatcher {
    if (!pattern) return { valid: true, ranges: () => NO_RANGES };
    if (useRegex) {
        let re: RegExp;
        try {
            re = new RegExp(pattern, matchCase ? 'g' : 'gi');
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
