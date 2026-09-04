import {
    GMCP_IAC,
    GMCP_SB,
    GMCP_SE,
    MSDP_COMMAND_CODE,
    OPT_MSDP,
    MSDP_VAR,
    MSDP_VAL,
} from "./constants";
import { fromByteString, toByteString } from "./byteString";

// MSDP control bytes, as numeric codes for the byte-at-a-time parser below.
const VAR = 1;          // MSDP_VAR
const VAL = 2;          // MSDP_VAL
const TABLE_OPEN = 3;   // MSDP_TABLE_OPEN
const TABLE_CLOSE = 4;  // MSDP_TABLE_CLOSE
const ARRAY_OPEN = 5;   // MSDP_ARRAY_OPEN
const ARRAY_CLOSE = 6;  // MSDP_ARRAY_CLOSE
const CONTROL_BYTES = new Set([VAR, VAL, TABLE_OPEN, TABLE_CLOSE, ARRAY_OPEN, ARRAY_CLOSE]);

/**
 * Frame a Mudlet-style `sendMSDP(variable, ...values)` call as an MSDP
 * subnegotiation: `IAC SB MSDP MSDP_VAR <variable> [MSDP_VAL <value>]... IAC SE`.
 * The returned string is a Latin-1 byte-string ready for sendBytes.
 */
export function encodeMsdp(variable: string, values: string[]): string {
    let out = GMCP_IAC + GMCP_SB + OPT_MSDP + MSDP_VAR + toByteString(variable);
    for (const v of values) {
        out += MSDP_VAL + toByteString(v);
    }
    out += GMCP_IAC + GMCP_SE;
    return out;
}

export interface MsdpEnvelope {
    /** Top-level MSDP variable name (e.g. "HEALTH", "ROOM"). */
    path: string;
    /** Decoded value: a string, an array, or a nested string-keyed object. */
    value: unknown;
}

/**
 * Recursive-descent parser for the MSDP value grammar. `data` is the
 * subnegotiation body with the leading OPT_MSDP byte already stripped; `i` is
 * the cursor into it. MSDP nests via MSDP_TABLE_OPEN/CLOSE (string-keyed) and
 * MSDP_ARRAY_OPEN/CLOSE (ordered), with scalar leaves running until the next
 * control byte.
 *
 * Malformed input is handled the way Mudlet's TLuaInterpreter::msdp2Lua does
 * (TLuaInterpreter.cpp:4117-4297 @124ee8b5f). Mudlet reassembles the payload as
 * JSON and hands it to yajl one top-level variable at a time, so its behaviour
 * on the malformed cases is a property of that reassembly rather than of the
 * protocol document:
 *
 *  - Adjacent top-level values with no ARRAY_OPEN are the specification's
 *    "string values together for command-like variables" and become a list
 *    (`no_array_marker_bug`, set at :4233 and applied at :4197/:4285). The flag
 *    is scoped to the variable that carried the list (reset at :4202), and is
 *    set only outside a structure (`if (!nest)` at :4232) — inside one, an array
 *    carries its own markers.
 *  - A close marker for a table/array the game never opened marks the variable
 *    malformed (:4150, :4167) and Mudlet drops it outright rather than letting
 *    yajl decide (:4188-4192 mid-message, :4279-4291 at the end). A dropped
 *    variable is never handed to setMSDPTable, so it raises no event either.
 *  - A structure still open when the subnegotiation ends is the same kind of
 *    imbalance the other way (`nest` at :4279) and is dropped identically —
 *    IAC SE already arrived, so no more data is coming for it.
 *
 * Variables ahead of a malformed one are unaffected: only the variable carrying
 * the imbalance is dropped.
 */
class MsdpParser {
    private i = 0;
    /** The variable being read closed a table/array that was never opened. */
    private malformed = false;
    /** The variable being read left a table/array open at end of input. */
    private truncated = false;
    constructor(private readonly data: string) {}

    /** Top-level variables in wire order. Mudlet flushes each one separately, so
     *  a repeated name arrives twice rather than collapsing into one entry. */
    parseTopLevel(): MsdpEnvelope[] {
        const out: MsdpEnvelope[] = [];
        const n = this.data.length;
        // Held back until the variable is known to be complete: a stray close
        // marker after its value still belongs to it.
        let pending: MsdpEnvelope | null = null;
        const flush = () => {
            if (pending && !this.malformed && !this.truncated) out.push(pending);
            pending = null;
            this.malformed = false;
            this.truncated = false;
        };
        while (this.i < n) {
            const c = this.data.charCodeAt(this.i);
            if (c === VAR) {
                flush();
                this.i++;
                const key = this.readScalar();
                let value: unknown = "";
                if (this.i < n && this.data.charCodeAt(this.i) === VAL) {
                    this.i++;
                    value = this.readValue();
                    if (this.i < n && this.data.charCodeAt(this.i) === VAL) {
                        // unmarked list: MSDP_VAL MSDP_VAL ... at the top level
                        const list: unknown[] = [value];
                        while (this.i < n && this.data.charCodeAt(this.i) === VAL) {
                            this.i++;
                            list.push(this.readValue());
                        }
                        value = list;
                    }
                }
                pending = { path: key, value };
            } else {
                if (c === TABLE_CLOSE || c === ARRAY_CLOSE) this.malformed = true;
                this.i++; // skip stray bytes between pairs
            }
        }
        flush();
        return out;
    }

    private readValue(): unknown {
        const c = this.data.charCodeAt(this.i);
        if (c === TABLE_OPEN) return this.readTable();
        if (c === ARRAY_OPEN) return this.readArray();
        if (c === TABLE_CLOSE || c === ARRAY_CLOSE) {
            // nothing is open here, so this closes a structure the game never
            // started; leave the byte for the caller's stray-byte skip
            this.malformed = true;
            return "";
        }
        return this.readScalar();
    }

    private readTable(): Record<string, unknown> {
        this.i++; // consume TABLE_OPEN
        const out: Record<string, unknown> = {};
        const n = this.data.length;
        while (this.i < n && this.data.charCodeAt(this.i) !== TABLE_CLOSE) {
            if (this.data.charCodeAt(this.i) === VAR) {
                this.i++;
                const key = this.readScalar();
                if (this.i < n && this.data.charCodeAt(this.i) === VAL) {
                    this.i++;
                    out[key] = this.readValue();
                } else {
                    out[key] = "";
                }
            } else {
                this.i++; // skip stray bytes
            }
        }
        if (this.i < n) this.i++; // consume TABLE_CLOSE
        else this.truncated = true; // ran out of input with the table still open
        return out;
    }

    private readArray(): unknown[] {
        this.i++; // consume ARRAY_OPEN
        const out: unknown[] = [];
        const n = this.data.length;
        while (this.i < n && this.data.charCodeAt(this.i) !== ARRAY_CLOSE) {
            if (this.data.charCodeAt(this.i) === VAL) {
                this.i++;
                out.push(this.readValue());
            } else {
                this.i++; // skip stray bytes
            }
        }
        if (this.i < n) this.i++; // consume ARRAY_CLOSE
        else this.truncated = true; // ran out of input with the array still open
        return out;
    }

    /** Read a run of bytes up to (not including) the next control byte. */
    private readScalar(): string {
        const start = this.i;
        const n = this.data.length;
        while (this.i < n && !CONTROL_BYTES.has(this.data.charCodeAt(this.i))) {
            this.i++;
        }
        // MSDP names are ASCII but values may carry UTF-8. Malformed bytes are
        // substituted rather than reported: unlike GMCP there's no envelope to
        // name in a warning, and a bad value is already visible as such.
        return fromByteString(this.data.substring(start, this.i)).text;
    }
}

export interface MsdpStreamOptions {
    onEnvelope: (payload: MsdpEnvelope) => void;
}

/** Mirror of createGmcpStream for MSDP subnegotiations. The handler receives a
 *  subnegotiation body whose first byte is the MSDP option code (69); each
 *  top-level variable is emitted as its own envelope. A variable the parser
 *  dropped as malformed yields no envelope at all, so no arrival event fires
 *  for data the game never finished sending. */
export const createMsdpStream = ({ onEnvelope }: MsdpStreamOptions) => {
    return (data: string) => {
        if (data.length === 0 || data.charCodeAt(0) !== MSDP_COMMAND_CODE) return;
        for (const envelope of new MsdpParser(data.substring(1)).parseTopLevel()) {
            onEnvelope(envelope);
        }
    };
};
