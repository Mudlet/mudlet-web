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

/*
 * Invalid UTF-8 on its way out of Lua.
 *
 * Every Lua string a binding receives — `send`, `echo`, `cecho`, and the rest
 * of the text API — is read with `lua_tolstring`, which wasmoon wraps with
 * emscripten's UTF8ToString. For a string of up to 16 bytes that is a
 * hand-written decoder that trusts every lead byte: a stray 0x80 swallows the
 * next three bytes into one bogus character ("x\128yzw" read as x + U+3AEB7),
 * a 0xFF ends the string, and an overlong form is decoded as a real character
 * ("\192\175" as "/"). Desktop reads the same bytes with QString::fromUtf8,
 * which turns each bad byte or sequence into U+FFFD and keeps the text after
 * it — which is what the browser's own (WHATWG) decoder does, so the read is
 * made with that instead. A script saved in Latin-1, or one that builds text
 * with string.char(>127), then sends and echoes what desktop does.
 *
 * Text that has to cross as bytes still goes armored (byteArmor.ts); this is
 * only about how a text argument is read.
 */

interface ToLStringApi {
    lua_tolstring: (L: number, index: number, size: number | null) => string;
    module: {
        _lua_tolstring: (L: number, index: number, size: number) => number;
        HEAPU8: Uint8Array;
    };
}

const PATCHED_READ = Symbol('desktopUtf8Read');
const utf8Read = new TextDecoder('utf-8', { ignoreBOM: true });

/** Make `api.lua_tolstring` decode the way QString::fromUtf8 does. It still
 *  stops at the first NUL, as UTF8ToString did, so nothing that relied on
 *  that changes. */
export function installDesktopUtf8Read(api: ToLStringApi): void {
    const marked = api as ToLStringApi & { [PATCHED_READ]?: true };
    if (marked[PATCHED_READ]) return;
    const mod = api.module;
    api.lua_tolstring = (L, index, size) => {
        const ptr = mod._lua_tolstring(L, index, size ?? 0);
        if (!ptr) return '';
        // Read the heap afresh: memory growth replaces the view.
        const heap = mod.HEAPU8;
        const end = heap.indexOf(0, ptr);
        const bytes = heap.subarray(ptr, end);
        // Short ASCII, the common case, skips the decoder's call overhead.
        if (bytes.length <= 64 && bytes.every(b => b < 0x80)) return String.fromCharCode(...bytes);
        return utf8Read.decode(bytes);
    };
    marked[PATCHED_READ] = true;
}
