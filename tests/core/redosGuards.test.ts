import { describe, it, expect } from 'vitest';
import { stripTelnetSequences, createTelnetOptionParser } from '../../src/mud/protocol/gmcp';
import { parseCecho, cechoToAnsiFast, dechoToAnsiFast } from '../../src/mud/text/colorParsers';
import { rewriteQtSelectors, patchStyleSheetBackgroundColor } from '../../src/ui/labels/qtCss';
import { rewriteVfsUrlsInCss } from '../../src/scripting/vfs/cssRewrite';
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';

/**
 * Regression guards for the catastrophic-backtracking / quadratic-rescan cases
 * CodeQL flagged (js/polynomial-redos, alerts #9-#14, #16).
 *
 * Each payload is one CodeQL described, at a size where the *old* code took
 * seconds to minutes. The budget is deliberately loose — these all complete in
 * single-digit milliseconds now, and every pre-fix timing below is 100x+ over
 * it, so the assertion is about complexity class, not machine speed.
 */
const BUDGET_MS = 2000;

function timed(label: string, fn: () => unknown): number {
    const t0 = performance.now();
    fn();
    const ms = performance.now() - t0;
    expect(ms, `${label} took ${ms.toFixed(0)}ms (budget ${BUDGET_MS}ms)`).toBeLessThan(BUDGET_MS);
    return ms;
}

describe('ReDoS guards', () => {
    it('strips telnet sequences linearly when the buffer holds no IAC SE', () => {
        // Was ~1.3s at 160KB: the IAC SB branch rescans to end-of-buffer looking
        // for a terminator that never arrives. A hostile server controls this.
        const handler = createTelnetOptionParser(() => {});
        const payload = '\xFF\xFA'.repeat(160_000);
        timed('stripTelnetSequences', () => stripTelnetSequences(payload, handler));
    });

    it('still parses subnegotiations once an IAC SE is present', () => {
        // The fast path only drops the SB branch when no IAC SE exists, so a
        // buffer that has one must behave exactly as before.
        const seen: string[] = [];
        const handler = createTelnetOptionParser(d => seen.push(d));
        const out = stripTelnetSequences('aÿúÉCore.Pingÿðb', handler);
        expect(seen).toEqual(['ÉCore.Ping']);
        expect(out).toBe('ab');
    });

    it('scans cecho/decho tags linearly on a run of unclosed "<"', () => {
        // Was ~262ms at 32KB and quadratic from there. Reachable whenever a
        // trigger pipes server text into cecho.
        const payload = '<'.repeat(200_000);
        timed('parseCecho', () => parseCecho(payload));
        timed('cechoToAnsiFast', () => cechoToAnsiFast(payload));
        timed('dechoToAnsiFast', () => dechoToAnsiFast(payload));
    });

    it('rewrites Qt selectors linearly on unterminated CSS comments', () => {
        // Quadratic: ~855ms at 160KB, ~27s at the 900KB used here. Needs a
        // early-outs, then many '/*' with no '*/'.
        const payload = 'QLabel { color: red; }' + '/*' + 'a/*'.repeat(300_000);
        timed('rewriteQtSelectors', () => rewriteQtSelectors(payload));
    });

    it('patches background-color linearly on a stylesheet with no ";"', () => {
        const payload = 'background-color:'.repeat(60_000);
        timed('patchStyleSheetBackgroundColor', () =>
            patchStyleSheetBackgroundColor(payload, 1, 2, 3, 255));
    });

    it('rewrites url() refs linearly on an unterminated url( + whitespace', () => {
        // The worst of the set: cubic. 5.6s at 4KB, ~108s at 8KB, before the fix.
        const vfs = { resolvePath: (p: string) => p, profilePath: '/p' } as unknown as ProfileVFS;
        const payload = 'url(' + ' '.repeat(200_000);
        timed('rewriteVfsUrlsInCss', () => rewriteVfsUrlsInCss(payload, 'c1', vfs));
    });
});
