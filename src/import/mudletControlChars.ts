// XML 1.0 has no way to carry most C0 control characters — not raw, and not as a
// numeric character reference either. Mudlet scripts embed them routinely all the
// same (a literal `\27[1;32m` ANSI escape inside an echo is the common case), so
// desktop rewrites every one of them to a two-character placeholder on save and
// reverses it on load:
//
//     U+FFFC OBJECT REPLACEMENT CHARACTER + the Control Pictures glyph for the byte
//
// See `XMLexport::sanitizeForQxml` (XMLexport.cpp) and `XMLimport::readScriptElement`
// (XMLimport.cpp). Without it the serializer emits a document that is invalid per
// XML 1.0: Chrome's DOMParser truncates it, Qt's QXmlStreamReader rejects it
// outright, and a linked-profile write-back lands a file desktop Mudlet can no
// longer load.
//
// The encoding here follows desktop's *decoder*, which is the self-consistent half
// of the pair — its encoder's table conflates decimal and hex for a handful of
// entries (`&#10;`, `&#16;`, `&#17;`, `&#23;`), so those bytes shift as they pass
// through desktop. Matching the decoder is what makes our output load correctly.

/** U+FFFC OBJECT REPLACEMENT CHARACTER — the lead half of every placeholder pair. */
const OBJ = '￼';
/** U+2400 SYMBOL FOR NULL … U+241F SYMBOL FOR UNIT SEPARATOR sit contiguously with the bytes they name. */
const PICTURES_BASE = 0x2400;
/** DEL (0x7F) is the one that breaks the pattern: U+2421 SYMBOL FOR DELETE. */
const DEL_PICTURE = 0x2421;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const PLACEHOLDERS = /￼([␀-␟␡])/g;

/**
 * Replace every control character XML cannot represent with Mudlet's placeholder
 * pair. Safe to run over any string bound for a document — text content and
 * attribute values alike. Tab, LF and CR are legal in XML 1.0 and left alone.
 *
 * Divergence: desktop has no mapping for NUL (0x00) at all, and so still emits a
 * document Qt rejects when a script holds one. We encode it as U+FFFC U+2400 — the
 * glyph the Control Pictures block reserves for it. Desktop will not decode that
 * back, leaving the placeholder visible in the script, but the file stays valid
 * and everything around the NUL survives.
 */
export function sanitizeControlChars(s: string): string {
    return s.replace(CONTROL_CHARS, ch => {
        const code = ch.charCodeAt(0);
        return OBJ + String.fromCharCode(code === 0x7F ? DEL_PICTURE : PICTURES_BASE + code);
    });
}

/** Inverse of {@link sanitizeControlChars}. */
export function desanitizeControlChars(s: string): string {
    // Cheap bail-out: the placeholder lead is absent from essentially every real
    // script, and this runs on every text node of every import.
    if (!s.includes(OBJ)) return s;
    return s.replace(PLACEHOLDERS, (_m, picture: string) => {
        const code = picture.charCodeAt(0);
        return String.fromCharCode(code === DEL_PICTURE ? 0x7F : code - PICTURES_BASE);
    });
}
