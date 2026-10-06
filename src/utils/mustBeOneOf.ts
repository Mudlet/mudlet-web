/**
 * The refusal Mudlet gives a value outside a fixed set of words, in the one
 * wording its API settled on: `<what> must be "a", "b" or "c", got "x"` — no
 * function-name prefix, double quotes, no comma before the "or".
 *
 * The Lua twin is `__mudlet_must_be_one_of` in `src/scripting/lua/Bridge.lua`;
 * keep the two in step.
 */
export function mustBeOneOf(what: string, values: readonly string[], got: unknown): string {
    const quoted = values.map(v => `"${v}"`);
    const list = quoted.length <= 1
        ? (quoted[0] ?? '')
        : `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`;
    return `${what} must be ${list}, got "${String(got)}"`;
}
