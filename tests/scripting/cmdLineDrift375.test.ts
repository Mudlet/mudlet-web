// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// Issue #375, the scripting half: getCmdLine() reads the box as desktop's
// toPlainText() does, so a NBSP comes back as a space and U+2028/U+2029 as
// line feeds. A plain send() is left alone on both clients.

describe('getCmdLine as plain text (#375)', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => env.dispose());

    it('reads a non-breaking space on the main line as a space', () => {
        expect(env.run('printCmdLine("pp\\194\\160x") return getCmdLine()')).toBe('pp x');
    });

    it('reads U+2028 and U+2029 as line feeds', () => {
        expect(env.run('printCmdLine("a\\226\\128\\168b\\226\\128\\169c") return getCmdLine()')).toBe('a\nb\nc');
    });

    it('does the same for a named command line', () => {
        env.run('createCommandLine("cl1", 0, 0, 100, 20) printCmdLine("cl1", "pp\\194\\160x")');
        expect(env.run('return (getCmdLine("cl1"))')).toBe('pp x');
    });
});
