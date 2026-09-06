/**
 * Binary armoring across the wasmoon bridge.
 *
 * wasmoon marshals strings between Lua and JS with emscripten's UTF8ToString /
 * stringToUTF8: Lua→JS stops at the first NUL byte and UTF-8-*decodes* the
 * rest, JS→Lua re-encodes chars >= 0x80 as multi-byte UTF-8. That is fine for
 * text and silently destructive for bytes — `feedTelnet("\229\254\13")` does
 * not deliver 0xE5 0xFE 0x0D, it delivers U+5F8D, because those three bytes
 * happen to look like one three-byte sequence to the decoder. A replay file's
 * int32 headers lost every \0 the same way.
 *
 * So every binding that carries game *bytes* rather than text crosses armored
 * as pure ASCII: a marker char (\2 = raw, \1 = encoded) followed by the payload
 * with NUL, '%' and 0x80–0xFF written as %XX escapes. `__mudix_armor` /
 * `__mudix_unarmor` in Bridge.lua are the Lua half of the same scheme, and
 * VFS.lua takes them as locals for its hot paths.
 *
 * A payload is a *byte-string*: one JS char per byte, 0x00–0xFF, which is what
 * the socket layer produces and what every telnet/encoding path downstream
 * expects.
 */

/** Marker for a payload that needed no escaping. */
const RAW = 2;
const NEEDS_ARMOR = /[\x00%\x80-\xff]/;

/** Byte-string → armored ASCII, for a value on its way into Lua. */
export function armor(s: string): string {
    if (!NEEDS_ARMOR.test(s)) return '\x02' + s;
    return '\x01' + s.replace(/[\x00%\x80-\xff]/g,
        c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

/** Armored ASCII → byte-string, for a value that has just come out of Lua. */
export function unarmor(s: string): string {
    const payload = s.substring(1);
    if (s.charCodeAt(0) === RAW) return payload;
    return payload.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}
