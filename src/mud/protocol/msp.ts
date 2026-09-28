// MUD Sound Protocol (MSP, zMUD). Servers embed `!!SOUND(...)` and
// `!!MUSIC(...)` triplets into regular MUD text to trigger sound effects and
// background music. The tags are intended for the client and must be stripped
// from the rendered output. Either form may also arrive inside an
// `IAC SB MSP ... IAC SE` telnet subnegotiation, which carries the same body
// (e.g. `!!SOUND(zap.wav V=80)`) — almost no MUD wraps them, but the spec
// allows it.
//
// Reference: http://www.zuggsoft.com/zmud/msp.htm

import { MSP_COMMAND_CODE } from "./constants";

export type MspKind = "sound" | "music";

/** Parsed `!!SOUND` / `!!MUSIC` command. Numeric fields fall back to undefined
 *  when the server omits the key — the consumer (SoundManager) substitutes its
 *  own defaults rather than having parser-level defaults bleed downstream. */
export interface MspCommand {
    kind: MspKind;
    /** Filename or the literal `Off` (case-sensitive per spec) to stop playback. */
    file: string;
    /** U= field — explicit URL the file can be downloaded from. */
    url?: string;
    /** V= field — volume 0..100 on the MSP scale. */
    volume?: number;
    /** L= field — loop count. -1 = forever, otherwise positive integer. */
    loops?: number;
    /** P= field — priority 0..100. Only meaningful for `!!SOUND`. */
    priority?: number;
    /** C= field — `1` = if same is already playing, keep it (no restart). */
    continueIfPlaying?: boolean;
    /** T= field — channel / tag string. */
    type?: string;
}

const TAG_HEAD = /!!(SOUND|MUSIC)\(/;

/**
 * Stateful MSP parser. `feed()` parses `!!SOUND(...)` / `!!MUSIC(...)` tags out
 * of text a script hands to `receiveMSP()` — game text itself is never parsed,
 * as in Mudlet — returning the remaining `text`. Parsed commands are
 * delivered as `commands`. The parser holds back a partial tag (`!!SOUND(...`
 * with no closing `)` yet) until the next chunk supplies the rest, so tags
 * split across WebSocket frames still parse correctly.
 */
export class MspParser {
    /** Partial tag carried over from the previous chunk, including the
     *  leading `!!`. Empty when no tag is in progress. */
    private pending = "";

    feed(input: string): { text: string; commands: MspCommand[] } {
        const data = this.pending + input;
        this.pending = "";

        let out = "";
        const commands: MspCommand[] = [];
        let i = 0;
        // Length of the longest tag head (`!!SOUND(` / `!!MUSIC(`).
        const HEAD_LEN = 8;
        while (i < data.length) {
            const start = data.indexOf("!!", i);
            if (start === -1) {
                out += data.substring(i);
                break;
            }
            // Emit literal text up to the candidate marker.
            out += data.substring(i, start);
            // If we don't have enough characters to recognise (or rule out) a
            // tag head, buffer from `!!` and wait for the next chunk.
            if (data.length - start < HEAD_LEN) {
                this.pending = data.substring(start);
                return { text: out, commands };
            }
            const head = data.substring(start, start + HEAD_LEN);
            const match = TAG_HEAD.exec(head);
            if (!match) {
                // Not a tag we care about — emit the `!!` and keep scanning.
                out += "!!";
                i = start + 2;
                continue;
            }
            const openParen = start + match[0].length;
            const close = data.indexOf(")", openParen);
            if (close === -1) {
                // Partial tag — buffer from `!!` onward and stop emitting.
                this.pending = data.substring(start);
                return { text: out, commands };
            }
            const kind: MspKind = match[1] === "SOUND" ? "sound" : "music";
            const body = data.substring(openParen, close);
            const cmd = parseBody(kind, body);
            if (cmd) commands.push(cmd);
            i = close + 1;
        }
        return { text: out, commands };
    }

    /** Drop any partial-tag buffer. Called on disconnect / reconnect. */
    reset(): void {
        this.pending = "";
    }

    /** Parse the body of an `IAC SB MSP ... IAC SE` subnegotiation. The body
     *  byte[0] is the option code (90); the rest is the raw tag text (often
     *  `!!SOUND(...)`) per the spec, though some implementations send just the
     *  body inside the parens. We try both. A subnegotiation is framed as a
     *  whole unit by the time it reaches us, so we don't share parser state
     *  with the in-band stream — running `feed()` here would let a malformed
     *  subneg leak a partial-tag buffer into the next inline chunk. */
    feedSubneg(subneg: string): MspCommand[] {
        if (subneg.charCodeAt(0) !== MSP_COMMAND_CODE) return [];
        const body = subneg.substring(1).trim();
        if (body.length === 0) return [];
        const out: MspCommand[] = [];
        // Standard form: full `!!SOUND(...)` syntax. Scan with a local cursor
        // so multiple tags in one subneg all parse.
        const re = /!!(SOUND|MUSIC)\(([^)]*)\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(body)) !== null) {
            const kind: MspKind = m[1] === "SOUND" ? "sound" : "music";
            const cmd = parseBody(kind, m[2]);
            if (cmd) out.push(cmd);
        }
        if (out.length > 0) return out;
        // Loose fallback: some servers emit just `SOUND filename ...` without
        // the !! / parens wrapper. Recognise the leading keyword and parse.
        const loose = /^(SOUND|MUSIC)\s+(.+)$/i.exec(body);
        if (loose) {
            const kind: MspKind = loose[1].toUpperCase() === "SOUND" ? "sound" : "music";
            const cmd = parseBody(kind, loose[2]);
            if (cmd) out.push(cmd);
        }
        return out;
    }
}

/** Parse the inner body of a `!!SOUND(...)` / `!!MUSIC(...)` tag. The first
 *  whitespace-delimited token is the filename (or `Off`); the rest are
 *  case-insensitive single-letter KEY=VALUE pairs. Returns null only when the
 *  body has no filename at all. */
function parseBody(kind: MspKind, body: string): MspCommand | null {
    const trimmed = body.trim();
    if (trimmed.length === 0) return null;
    const tokens = trimmed.split(/\s+/);
    const file = tokens[0];
    if (!file) return null;
    const cmd: MspCommand = { kind, file };
    for (let i = 1; i < tokens.length; i++) {
        const eq = tokens[i].indexOf("=");
        if (eq <= 0) continue;
        const key = tokens[i].substring(0, eq).toUpperCase();
        const value = tokens[i].substring(eq + 1);
        switch (key) {
            case "U": cmd.url = value; break;
            case "V": {
                const n = parseInt(value, 10);
                if (Number.isFinite(n)) cmd.volume = clamp(n, 0, 100);
                break;
            }
            case "L": {
                const n = parseInt(value, 10);
                if (Number.isFinite(n)) cmd.loops = n;
                break;
            }
            case "P": {
                const n = parseInt(value, 10);
                if (Number.isFinite(n)) cmd.priority = clamp(n, 0, 100);
                break;
            }
            case "C": cmd.continueIfPlaying = value === "1"; break;
            case "T": cmd.type = value; break;
        }
    }
    return cmd;
}

function clamp(n: number, lo: number, hi: number): number {
    return n < lo ? lo : n > hi ? hi : n;
}
