import { fromByteString, toByteString, toHex } from "./byteString";
import { GMCP_COMMAND_CODE, GMCP_IAC, GMCP_SB, GMCP_SE, TELNET_EOR, TELNET_GA, TELNET_OPTION_REGEX, TELNET_OPTION_REGEX_NO_SB } from "./constants";

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

export const stripTelnetSequences = (data: string, handler: TelnetOptionHandler): string => {
    // After the regex consumes every complete telnet sequence, the only stray
    // IAC (\xFF) left is a lone trailing one — an option/command split across
    // frames — so drop it. (We no longer blanket-strip \xF9, which the old
    // regex mis-handled for GA and which is a legitimate text byte otherwise.)
    const re = data.includes(GMCP_IAC + GMCP_SE) ? TELNET_OPTION_REGEX : TELNET_OPTION_REGEX_NO_SB;
    return data.replace(re, handler).replace(/\xFF/g, "");
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

    // The data part is optional per the GMCP spec — a message may be just a
    // module name with no body (e.g. the server's `Core.Ping` reply, which is
    // documented to carry no body). Treat a missing/blank body as an empty
    // value rather than dropping the whole message.
    const spaceIndex = gmcpData.indexOf(" ");
    const type = (spaceIndex === -1 ? gmcpData : gmcpData.substring(0, spaceIndex)).trim();
    let payload = spaceIndex === -1 ? "" : gmcpData.substring(spaceIndex + 1);

    if (malformed) onMalformedEncoding?.(type, rawBody);

    if (payload.trim() === "") {
        onMessage(type, "");
        return;
    }

    // Replace literal ESC characters inside JSON strings so JSON.parse succeeds
    if (type.toLowerCase() === "gmcp_msgs") {
        payload = payload.replace(//g, "\\u001B");
    }

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
 *  the session's outgoing encoding, so it can't be used to place arbitrary raw
 *  bytes on the wire. UTF-8 is what the GMCP spec asks for, and it's also what
 *  keeps a 0xFF byte (which would need IAC-escaping inside a subnegotiation)
 *  out of the body in the first place. */
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
