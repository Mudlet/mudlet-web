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
 * control byte. Tolerant of truncation/garbage: stops cleanly at end of input.
 */
class MsdpParser {
    private i = 0;
    constructor(private readonly data: string) {}

    parseTopLevel(): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        const n = this.data.length;
        while (this.i < n) {
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
                this.i++; // skip stray bytes between pairs
            }
        }
        return out;
    }

    private readValue(): unknown {
        const c = this.data.charCodeAt(this.i);
        if (c === TABLE_OPEN) return this.readTable();
        if (c === ARRAY_OPEN) return this.readArray();
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
 *  top-level variable is emitted as its own envelope. */
export const createMsdpStream = ({ onEnvelope }: MsdpStreamOptions) => {
    return (data: string) => {
        if (data.length === 0 || data.charCodeAt(0) !== MSDP_COMMAND_CODE) return;
        const vars = new MsdpParser(data.substring(1)).parseTopLevel();
        for (const path of Object.keys(vars)) {
            onEnvelope({ path, value: vars[path] });
        }
    };
};
