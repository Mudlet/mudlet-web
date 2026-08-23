import { GMCP_COMMAND_CODE, GMCP_IAC, GMCP_SB, GMCP_SE, TELNET_EOR, TELNET_GA, TELNET_OPTION_REGEX } from "./constants";

export interface GmcpEnvelope {
    path: string;
    value: unknown;
}

/** GMCP module carrying a server package-install request. Both of its wire
 *  formats route to `onClientGui` rather than riding the normal envelope. */
const CLIENT_GUI_MODULE = "client.gui";

export type TelnetOptionHandler = (data: string) => string;

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });
const utf8StrictDecoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();

/** Decode a Latin-1 byte-string (one char per byte, as MudClient produces from
 *  the socket) as UTF-8. GMCP bodies are JSON, which RFC 8259 §8.1 and Mudlet's
 *  `cTelnet::setGMCPVariables` both take as always UTF-8, independent of the
 *  session's text encoding.
 *
 *  A non-conformant server may still send the body in some other encoding. We
 *  decode it leniently anyway — a U+FFFD in one field beats dropping the whole
 *  message — but report `malformed` so the caller can say so, because nothing
 *  downstream can: a bad sequence never breaks the JSON (every structural
 *  character is ASCII, and continuation bytes are all >= 0x80), so `JSON.parse`
 *  succeeds and the corruption is confined to string values. */
const fromByteString = (s: string): { text: string; malformed: boolean } => {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
    try {
        return { text: utf8StrictDecoder.decode(bytes), malformed: false };
    } catch {
        return { text: utf8Decoder.decode(bytes), malformed: true };
    }
};

/** Render a byte-string as hex, for diagnostics that would otherwise print the
 *  post-decode text — where every malformed sequence has already collapsed to
 *  an indistinguishable U+FFFD. Truncated: the head is where the fault is. */
const toHex = (s: string): string => {
    const shown = [...s.slice(0, 64)].map(c => (c.charCodeAt(0) & 0xff).toString(16).padStart(2, "0"));
    return shown.join(" ") + (s.length > 64 ? " …" : "");
};

/** UTF-8-encode into a Latin-1 byte-string, for MudClient.sendBytes (which
 *  writes `charCodeAt(i) & 0xff` per char). Inverse of fromByteString for
 *  well-formed input only — both directions are non-fatal, so invalid UTF-8
 *  inbound and lone surrogates outbound each collapse to U+FFFD rather than
 *  round-tripping. */
const toByteString = (s: string): string => {
    const bytes = utf8Encoder.encode(s);
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
};

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
    return data.replace(TELNET_OPTION_REGEX, handler).replace(/\xFF/g, "");
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
                    const msgType = (payload as { type: string }).type ?? "";
                    // `atob` throws on a `text` field that isn't base64, and the
                    // TextDecoder ctor on an unsupported `textEncoding`. Caught
                    // here rather than left to the caller's frame-level handler:
                    // the body parsed as JSON, so this is a bad gmcp_msgs
                    // payload and nothing else in the frame should be lost over
                    // it. Reported on its own terms, not as a JSON error.
                    let text: string;
                    try {
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
