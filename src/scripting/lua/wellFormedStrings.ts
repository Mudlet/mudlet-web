/**
 * Unpaired UTF-16 surrogates on their way into Lua.
 *
 * A buffer edit by column can split a surrogate pair — selectSection() over
 * half an emoji, insertText() between its halves — and leave a lone surrogate
 * in the line, exactly as it does in Mudlet's QString buffer. What differs is
 * the trip into Lua. Mudlet converts with QString::toUtf8(), whose encoder
 * drops a lone surrogate outright (its error handler writes a '?' through a
 * copy of the output pointer, so the next character overwrites it). wasmoon
 * converts with emscripten's stringToUTF8, which assumes every high surrogate
 * is followed by a low one: it fuses a lone high surrogate with whatever comes
 * next, swallowing that character into a bogus astral code point, and turns a
 * lone low surrogate into a four-byte sequence too. So `getSelection()` over
 * the first half of 😀 answered U+1F400 🐀 instead of desktop's "".
 *
 * Every JS string wasmoon hands to Lua goes through `lua_pushstring`, so that
 * one entry point drops lone surrogates the way toUtf8() does.
 */

// With the u flag a pair is one code point, so this matches only lone halves.
const LONE_SURROGATE = /\p{Surrogate}/gu;

type WellFormedString = string & { isWellFormed?: () => boolean };

/** `s` without its unpaired surrogates, as QString::toUtf8() would encode it. */
export function dropLoneSurrogates(s: string): string {
    const probe = (s as WellFormedString).isWellFormed;
    if (probe ? probe.call(s) : !/[\uD800-\uDFFF]/.test(s)) return s;
    return s.replace(LONE_SURROGATE, '');
}

interface PushStringApi {
    lua_pushstring: (L: number, s: string | null) => void;
}

const PATCHED = Symbol('wellFormedPush');

/** Make `api.lua_pushstring` drop lone surrogates from the strings it pushes. */
export function installWellFormedPush(api: PushStringApi): void {
    const marked = api as PushStringApi & { [PATCHED]?: true };
    if (marked[PATCHED]) return;
    const push = api.lua_pushstring.bind(api);
    api.lua_pushstring = (L, s) => push(L, typeof s === 'string' ? dropLoneSurrogates(s) : s);
    marked[PATCHED] = true;
}
