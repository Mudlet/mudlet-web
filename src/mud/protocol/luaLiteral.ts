// A string as a Lua long-bracket literal that holds it exactly — Mudlet's
// LuaLiteral::quote. An MXP link reports the Lua its click runs (the `actions`
// of the `mxp` table), and the command or address in that Lua is text the game
// wrote, so it has to stay inside the literal whatever it contains.

/**
 * Escalate the bracket level until the text can do none of three things:
 * close the literal outright; reopen it, which Lua 5.1 rejects under its
 * deprecated-nesting rule; or merge with the closing bracket appended after it
 * (text ending in `]` plus this level's `=` run is completed into a closer by
 * the first character of the real one). Terminates because none of the three
 * fits in text shorter than the `=` run it needs.
 *
 * Lua drops a newline straight after the opening bracket, so the one added
 * costs nothing and lets text that starts with a newline survive.
 */
export function quoteLuaLiteral(text: string): string {
    let equals = "";
    while (text.includes(`]${equals}]`) || text.includes(`[${equals}[`) || text.endsWith(`]${equals}`)) {
        equals += "=";
    }
    return `[${equals}[\n${text}]${equals}]`;
}
