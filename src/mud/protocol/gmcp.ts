import { fromByteString, toByteString, toHex } from "./byteString";
import { GMCP_COMMAND_CODE, GMCP_IAC, GMCP_SB, GMCP_SE, TELNET_EOR, TELNET_GA } from "./constants";

export interface GmcpEnvelope {
    path: string;
    value: unknown;
}

/** GMCP module carrying a server package-install request. Both of its wire
 *  formats route to `onClientGui` rather than riding the normal envelope. */
const CLIENT_GUI_MODULE = "client.gui";

export type TelnetOptionHandler = (data: string) => string;

export const createTelnetOptionParser = (
    onSubnegotiation: (data: string) => void,
    opts: {
        /** When true, an inbound IAC GA / IAC EOR is replaced by a newline
         *  rather than stripped — Mudlet's `mFORCE_GA_OFF` behaviour
         *  (`cTelnet::processSocketData` pushes `'\n'` in place of the marker
         *  instead of treating it as a prompt). Doing the substitution here,
         *  inside the sequence parser, keeps it positional: the newline lands
         *  exactly where the marker was, and a `\xFF\xF9` byte pair inside a
         *  subnegotiation payload is never mistaken for one. */
        promptMarkerAsNewline?: boolean;
    } = {},
): TelnetOptionHandler => {
    return (optionData: string) => {
        // Only IAC SB … IAC SE carries a payload to extract; every other matched
        // sequence (2-byte commands like GA/EOR/NOP, 3-byte WILL/WONT/DO/DONT)
        // is pure control with nothing to process — strip it. Keyed on the byte
        // after IAC being SB rather than on length, since commands are now
        // matched at their true 2- or 3-byte width.
        if (optionData.charCodeAt(1) === GMCP_SB.charCodeAt(0)) {
            onSubnegotiation(optionData.substring(2, optionData.length - 2));
            return "";
        }
        if (opts.promptMarkerAsNewline && (optionData === TELNET_GA || optionData === TELNET_EOR)) {
            return "\n";
        }
        return "";
    };
};

const IAC_SE = GMCP_IAC + GMCP_SE;
const CODE_SB = 0xFA;
const CODE_WILL = 0xFB;
const CODE_DONT = 0xFE;

/**
 * Consume every complete telnet sequence in `data`, replacing each with what
 * `handler` returns, and return the text that is left.
 *
 * A single forward scan with the same semantics as TELNET_OPTION_REGEX
 * (`IAC SB … IAC SE` up to the first IAC SE, else `IAC WILL/WONT/DO/DONT x`,
 * else `IAC x`), so `handler` sees exactly the sequences the regex matched.
 * It replaced the regex because the lazy SB branch rescans to end-of-buffer
 * from every IAC SB whose terminator never comes — quadratic on a run of
 * IAC SB from a hostile server. Here the terminator search runs once: when it
 * fails, no later IAC SB can find one either, so it is not repeated; when it
 * succeeds, the scan resumes past it.
 *
 * Unfinished sequences, as the regex left them: a lone trailing IAC is
 * dropped, `IAC WILL` at the very end is consumed as a two-byte command, and
 * so is an `IAC SB` with no IAC SE after it. (MudClient holds a sequence split
 * across frames back for the next one before calling this — `scanTelnetFrame`.)
 *
 * A NUL goes too. cTelnet::processSocketData drops `\0` from the text stream
 * outside a subnegotiation (it is the padding half of telnet's `CR NUL`), so
 * it never reaches the buffer; kept, it cut `line`, getCurrentLine() and
 * getLines() short at the NUL and shifted every position after it
 * (mudlet-web#272). Subnegotiation payloads go to `handler` intact, so a NUL
 * inside one is untouched.
 */
export const stripTelnetSequences = (data: string, handler: TelnetOptionHandler): string => {
    let iac = data.indexOf(GMCP_IAC);
    if (iac === -1) return data.includes("\0") ? data.replace(/\0/g, "") : data;

    const len = data.length;
    let out = "";
    let last = 0;
    // Set once a search for IAC SE from some point has failed: none exists
    // past it, so no later IAC SB can be terminated.
    let noTerminator = false;
    while (iac !== -1) {
        if (iac > last) out += data.substring(last, iac);
        const next = iac + 1;
        if (next >= len) {
            // Lone trailing IAC.
            last = len;
            break;
        }
        const cmd = data.charCodeAt(next);
        let end = -1;
        if (cmd === CODE_SB && !noTerminator) {
            const se = data.indexOf(IAC_SE, iac + 2);
            if (se === -1) noTerminator = true;
            else end = se + 2;
        }
        if (end === -1) end = cmd >= CODE_WILL && cmd <= CODE_DONT && next + 1 < len ? iac + 3 : iac + 2;
        const replacement = handler(data.substring(iac, end));
        // An IAC in a replacement is stripped like any other stray IAC; its
        // NULs go with the text's below.
        if (replacement) out += replacement.includes(GMCP_IAC) ? replacement.replace(/\xFF/g, "") : replacement;
        last = end;
        iac = data.indexOf(GMCP_IAC, end);
    }
    if (last < len) out += data.substring(last);
    // Text between sequences holds no IAC: every one starts a sequence or is
    // the trailing one dropped above.
    return out.includes("\0") ? out.replace(/\0/g, "") : out;
};

const parseGmcpPayload = (
    data: string,
    onMessage: (type: string, payload: unknown) => void,
    onRawClientGui?: (payload: string) => void,
    onMalformedEncoding?: (type: string, rawBody: string) => void,
): void => {
    if (data.length === 0) return;

    const firstChar = data.charCodeAt(0);
    if (firstChar !== GMCP_COMMAND_CODE) {
        return;
    }

    // GMCP bodies are JSON, which RFC 8259 §8.1 and Mudlet's
    // `cTelnet::setGMCPVariables` both take as always UTF-8, independent of the
    // session's text encoding. A non-conformant server may still send another
    // encoding, and only we can notice: a bad sequence never breaks the JSON
    // (every structural character is ASCII, continuation bytes are all >= 0x80),
    // so `JSON.parse` succeeds and the corruption stays inside string values.
    const rawBody = data.substring(1);
    const { text: gmcpData, malformed } = fromByteString(rawBody);
    if (!gmcpData.length) return;

    // Name and body are separated by the first space — unless a newline comes
    // first, in which case that is the separator instead. Games do pretty-print
    // their GMCP, and `Room.Info\n{...}` is a name and a body, not a module name
    // with a newline in it (cTelnet::setGMCPVariables makes the same choice).
    const firstSpace = gmcpData.indexOf(" ");
    const firstNewline = gmcpData.indexOf("\n");
    const sep = (firstSpace !== -1 && (firstNewline === -1 || firstSpace < firstNewline))
        ? firstSpace
        : firstNewline;
    const type = (sep === -1 ? gmcpData : gmcpData.substring(0, sep)).trim();
    let payload = sep === -1 ? "" : gmcpData.substring(sep + 1);

    if (malformed) onMalformedEncoding?.(type, rawBody);

    // The data part is optional per the GMCP spec — a message may be just a
    // module name with no body (`Core.Ping` is the one every game sends). An
    // empty object, not an empty string: a script reading gmcp.Core.Ping is
    // reading a table, and Mudlet hands it `{}`.
    if (payload.trim() === "") {
        onMessage(type, {});
        return;
    }

    // A raw ESC is not valid inside a JSON string, and games leak them —
    // colour codes inside a message's text. Escaping rather than stripping keeps
    // the byte the game sent, which the script can then act on; without it
    // JSON.parse rejects the whole message over one character it could have
    // read. Mudlet does the same replace, for every module and not just one.
    payload = payload.replace(/\x1B/g, "\\u001B");

    let gmcp: unknown;
    try {
        gmcp = JSON.parse(payload);
    } catch (error) {
        // Client.GUI has a second, pre-JSON wire format — `<version>\n<url>`
        // — so a body that doesn't parse isn't necessarily malformed. Mudlet
        // (cTelnet::setGMCPVariables) treats "not a JSON object" as the signal
        // to try that form, and only this module gets the fallback. It goes out
        // on its own channel, never as an envelope: Mudlet returns before
        // setGMCPTable for this shape, keeping it out of the Lua `gmcp` table.
        if (type.toLowerCase() === CLIENT_GUI_MODULE && onRawClientGui) {
            onRawClientGui(payload);
            return;
        }
        // A non-conformant server can send a GMCP body that isn't valid JSON.
        // Nothing we can do but drop it — log the module name, the decoded body
        // and the wire bytes (not just the error) so the offending message is
        // identifiable, and use warn rather than error since it's the server's
        // fault, not a bug here. The hex matters when the body is the problem:
        // by this point every bad sequence has decoded to the same U+FFFD.
        console.warn(
            `Error parsing GMCP JSON for "${type}":`,
            JSON.stringify(payload),
            `raw bytes: ${toHex(rawBody)}`,
            error,
        );
        return;
    }

    // Outside the try: it guards the parse, not the consumer. An error thrown
    // downstream (`atob` on a malformed gmcp_msgs body, say) would otherwise be
    // caught here and reported as the server sending bad JSON — blaming the
    // wrong party for a bug of ours, and demoting it to a warn for the same
    // reason.
    onMessage(type, gmcp);
};

export const encodeGmcp = (path: string, payload: unknown): string => {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
    return `${GMCP_IAC}${GMCP_SB}${String.fromCharCode(GMCP_COMMAND_CODE)}${toByteString(`${path} ${data}`)}${GMCP_IAC}${GMCP_SE}`;
};

/** Encode a GMCP frame from a single pre-formatted body (e.g. `"Module.Sub args"`).
 *  Mudlet's `sendGMCP` semantics — the caller controls the body between IAC SB
 *  GMCP and IAC SE — except that the body is transcoded to UTF-8 rather than to
 *  the session's outgoing encoding, so a JS caller can't use it to place arbitrary
 *  raw bytes on the wire: `U+00FF` goes out as `c3 bf`, not as `ff`. UTF-8 is what
 *  the GMCP spec asks for, and it's also what keeps a 0xFF byte (which would need
 *  IAC-escaping inside a subnegotiation) out of the body in the first place.
 *
 *  From Lua the same limit holds, but it isn't this call that imposes it — the
 *  bytes are gone a layer earlier. wasmoon marshals Lua→JS strings through
 *  `UTF8ToString`, which UTF-8-*decodes* them, so `"\1\200"` reaches `sendGMCP`
 *  as `U+0001 U+0200` and `"\1\255"` as a lone surrogate. Re-encoding here
 *  restores the caller's original Lua bytes rather than destroying them.
 *  Carrying genuinely arbitrary bytes across that bridge needs numbers, or the
 *  `%XX` armoring the VFS io path uses. */
export const encodeGmcpRaw = (message: string): string => {
    return `${GMCP_IAC}${GMCP_SB}${String.fromCharCode(GMCP_COMMAND_CODE)}${toByteString(message)}${GMCP_IAC}${GMCP_SE}`;
};

export interface GmcpStreamOptions {
    onEnvelope: (payload: GmcpEnvelope) => void;
    /** Called for gmcp_msgs subnegotiations (base64-encoded text with a type field). */
    onMessage?: (text: string, type: string) => void;
    /** Called for every `Client.GUI` request, in whichever wire format it
     *  arrived: the parsed `{url, version}` object, or the legacy raw
     *  `<version>\n<url>` string. Split out from `onEnvelope` so the install has
     *  one entry point for both formats, and so the legacy one — which Mudlet
     *  keeps out of the Lua `gmcp` table — has somewhere to go that isn't the
     *  table-populating path. The JSON form still emits its envelope as well,
     *  and does so first, so scripts observe it before the install runs. */
    onClientGui?: (payload: unknown) => void;
    /** Text decoder used for gmcp_msgs payloads. Defaults to UTF-8. */
    textEncoding?: string;
}

export const createGmcpStream = ({
    onEnvelope,
    onMessage,
    onClientGui,
    textEncoding = 'utf-8',
}: GmcpStreamOptions) => {
    // Once per module rather than once per message, mirroring Mudlet's
    // `mEncodingWarningIssued`: a server that mis-encodes every `Room.Info`
    // would otherwise paper the console. Per-stream, so reconnecting reports
    // it again.
    const malformedWarned = new Set<string>();

    return (data: string) => {
        parseGmcpPayload(
            data,
            (type, payload) => {
                if (type.toLowerCase() === "gmcp_msgs" && onMessage) {
                    // Everything that reads the payload goes inside the guard.
                    // `atob` throws on a `text` field that isn't base64, the
                    // TextDecoder ctor on an unsupported `textEncoding`, and a
                    // literal `gmcp_msgs null` body — valid JSON — throws on the
                    // property access itself. Caught here rather than left to
                    // the caller's frame-level handler: the body parsed as JSON,
                    // so this is a bad gmcp_msgs payload and nothing else in the
                    // frame should be lost over it. Reported on its own terms,
                    // not as a JSON error.
                    let text: string;
                    let msgType: string;
                    try {
                        msgType = (payload as { type: string }).type ?? "";
                        const binaryString = atob((payload as { text: string }).text ?? "");
                        text = new TextDecoder(textEncoding).decode(
                            Uint8Array.from(binaryString, c => c.charCodeAt(0))
                        );
                    } catch (error) {
                        console.warn("Malformed gmcp_msgs payload:", JSON.stringify(payload), error);
                        return;
                    }
                    onMessage(text, msgType);
                    return;
                }
                onEnvelope({ path: type, value: payload });
                if (type.toLowerCase() === CLIENT_GUI_MODULE) onClientGui?.(payload);
            },
            raw => onClientGui?.(raw),
            (type, rawBody) => {
                if (malformedWarned.has(type)) return;
                malformedWarned.add(type);
                console.warn(
                    `GMCP body for "${type}" is not valid UTF-8 — GMCP is always UTF-8,`
                    + ` independent of the session encoding. Some characters were replaced.`,
                    `raw bytes: ${toHex(rawBody)}`,
                );
            },
        );
    };
};
