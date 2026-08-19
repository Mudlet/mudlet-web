/**
 * Mudlet's `<XX>` byte placeholders for `feedTelnet(data)` —
 * `TLuaInterpreter::decodeBytes`.
 *
 * Lua strings are text, and the bytes a telnet stream is made of mostly are not:
 * `\xff\xf9` typed into a script is awkward to read and easy to get wrong, and a
 * profile that saves scripts as XML has to survive round-tripping them. So
 * Mudlet lets the data name its control bytes instead — `<T_IAC><T_GA>` for a
 * prompt marker, `<ESC>` for the start of an ANSI sequence — and decodes them
 * here before the bytes reach the parser.
 *
 * Anything that isn't a known tag is passed through unchanged, so ordinary text
 * containing `<` survives; `<<` and `>>` are the escapes for a literal one.
 */

/**
 * Version of the tag table, as Mudlet's `decodeBytes` reports it: feeding the
 * empty string yields this number as text rather than nothing, so a script can
 * ask which tags it can count on.
 */
export const TELNET_BYTE_TAG_TABLE_VERSION = 1;

/**
 * Tag → byte. Grouped as Mudlet groups them: hex digits, `O_`-prefixed telnet
 * options, ASCII abbreviations, and `T_`-prefixed telnet control codes.
 */
const BYTE_TAGS: Record<string, number> = {
    '<00>': 0x00, '<O_BINARY>': 0x00, '<NUL>': 0x00,
    '<01>': 0x01, '<O_ECHO>': 0x01, '<SOH>': 0x01,
    '<02>': 0x02, '<STX>': 0x02,
    '<03>': 0x03, '<O_SGA>': 0x03, '<ETX>': 0x03,
    '<04>': 0x04, '<EOT>': 0x04,
    '<05>': 0x05, '<O_STATUS>': 0x05, '<ENQ>': 0x05,
    '<06>': 0x06, '<ACK>': 0x06,
    '<07>': 0x07, '<BELL>': 0x07,
    '<08>': 0x08, '<BS>': 0x08,
    '<09>': 0x09, '<HTAB>': 0x09,
    '<0A>': 0x0a, '<LF>': 0x0a,
    '<0B>': 0x0b, '<VTAB>': 0x0b,
    '<0C>': 0x0c,
    '<0D>': 0x0d, '<CR>': 0x0d,
    '<0E>': 0x0e, '<SO>': 0x0e,
    '<0F>': 0x0f, '<SI>': 0x0f,
    '<10>': 0x10, '<DLE>': 0x10,
    '<11>': 0x11, '<DC1>': 0x11,
    // `<DC2>` is deliberately absent: Mudlet's table spells its key `<DC2`
    // without the closing delimiter, and tags are looked up whole, so no input
    // can ever match it. Adding it here would decode a byte desktop Mudlet
    // passes through as text.
    '<13>': 0x13, '<DC3>': 0x13,
    '<14>': 0x14, '<DC4>': 0x14,
    '<15>': 0x15, '<NAK>': 0x15,
    '<16>': 0x16, '<SYN>': 0x16,
    '<17>': 0x17, '<ETB>': 0x17,
    '<18>': 0x18, '<O_TERM>': 0x18, '<CAN>': 0x18,
    '<19>': 0x19, '<O_EOR>': 0x19, '<EM>': 0x19,
    '<1A>': 0x1a, '<SUB>': 0x1a,
    '<1B>': 0x1b, '<ESC>': 0x1b,
    '<1C>': 0x1c, '<FS>': 0x1c,
    '<1D>': 0x1d, '<GS>': 0x1d,
    '<1E>': 0x1e, '<RS>': 0x1e,
    '<1F>': 0x1f, '<O_NAWS>': 0x1f, '<US>': 0x1f,
    '<SP>': 0x20,
    '<O_NENV>': 0x27,
    '<O_CHARS>': 0x2a,
    '<O_KERMIT>': 0x2f,
    '<O_MSDP>': 0x45,
    '<O_MSSP>': 0x46,
    '<O_MCCP>': 0x55,
    '<O_MCCP2>': 0x56,
    '<O_MSP>': 0x5a,
    '<O_MXP>': 0x5b,
    '<O_ZENITH>': 0x5d,
    '<O_AARDWULF>': 0x66,
    '<DEL>': 0x7f,
    '<O_ATCP>': 0xc8,
    '<O_GMCP>': 0xc9,
    '<T_EOR>': 0xef,
    '<F0>': 0xf0, '<T_SE>': 0xf0,
    '<F1>': 0xf1, '<T_NOP>': 0xf1,
    '<F2>': 0xf2, '<T_DM>': 0xf2,
    '<F3>': 0xf3, '<T_BRK>': 0xf3,
    '<F4>': 0xf4, '<T_IP>': 0xf4,
    '<F5>': 0xf5, '<T_ABOP>': 0xf5,
    '<F6>': 0xf6, '<T_AYT>': 0xf6,
    '<F7>': 0xf7, '<T_EC>': 0xf7,
    '<F8>': 0xf8, '<T_EL>': 0xf8,
    '<F9>': 0xf9, '<T_GA>': 0xf9,
    '<FA>': 0xfa, '<T_SB>': 0xfa,
    '<FB>': 0xfb, '<T_WILL>': 0xfb,
    '<FC>': 0xfc, '<T_WONT>': 0xfc,
    '<FD>': 0xfd, '<T_DO>': 0xfd,
    '<FE>': 0xfe, '<T_DONT>': 0xfe,
    // `<FF>` names two bytes in Mudlet's table — form feed among the hex digits,
    // then IAC among the telnet codes. The later entry overwrites the earlier in
    // the hash it builds, so IAC is what it decodes to and form feed is only
    // reachable as `<0C>`. Kept that way round on purpose: `<FF>` beside
    // `<T_IAC>` is what scripts in the wild mean by it.
    '<FF>': 0xff, '<T_IAC>': 0xff,
};

/**
 * Decode Mudlet's `<XX>` byte placeholders into the bytes they name, as
 * `feedTelnet` does before handing data to the telnet parser.
 *
 * The result is a byte-string (each code unit ≤ 0xFF), which is what the inbound
 * pipeline takes — the same shape a decoded WebSocket frame arrives in.
 *
 * - `<<` yields a literal `<`, `>>` a literal `>`.
 * - An unknown `<…>` is left exactly as written, so prose and markup pass
 *   through: `<b>bold</b>` is text, not a failed decode.
 * - An unclosed `<` is likewise just a `<`.
 * - The empty string yields the tag table's version number as text, which is how
 *   a script asks what this build understands.
 */
export function decodeTelnetByteTags(input: string): string {
    if (input.length === 0) return String(TELNET_BYTE_TAG_TABLE_VERSION);

    let out = '';
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === '<') {
            if (input[i + 1] === '<') {
                out += '<';
                i++;
                continue;
            }
            const tagEnd = input.indexOf('>', i);
            if (tagEnd > i) {
                const tag = input.slice(i, tagEnd + 1);
                const byte = BYTE_TAGS[tag];
                out += byte === undefined ? tag : String.fromCharCode(byte);
                i = tagEnd;
                continue;
            }
        } else if (ch === '>' && input[i + 1] === '>') {
            out += '>';
            i++;
            continue;
        }
        out += ch;
    }
    return out;
}
