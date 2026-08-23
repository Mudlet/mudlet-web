import { GMCP_COMMAND_CODE, GMCP_IAC, GMCP_SB, GMCP_SE, TELNET_EOR, TELNET_GA, TELNET_OPTION_REGEX, TELNET_OPTION_REGEX_NO_SB } from "./constants";

export interface GmcpEnvelope {
    path: string;
    value: unknown;
}

/** GMCP module carrying a server package-install request. Both of its wire
 *  formats route to `onClientGui` rather than riding the normal envelope. */
const CLIENT_GUI_MODULE = "client.gui";

export type TelnetOptionHandler = (data: string) => string;

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });
const utf8Encoder = new TextEncoder();

/** Decode a Latin-1 byte-string (one char per byte, as MudClient produces from
 *  the socket) as UTF-8. GMCP bodies are JSON, which the spec — and Mudlet's
 *  `cTelnet::setGMCPVariables`, whose comment reads "JSON (and thus the GMCP
 *  data) is always utf8" — defines as always UTF-8, independent of the
 *  session's text encoding. */
const fromByteString = (s: string): string => {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
    return utf8Decoder.decode(bytes);
};

/** UTF-8-encode into a Latin-1 byte-string, for MudClient.sendBytes (which
 *  writes `charCodeAt(i) & 0xff` per char). The inverse of fromByteString. */
export const toByteString = (s: string): string => {
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
    const re = data.includes(GMCP_IAC + GMCP_SE) ? TELNET_OPTION_REGEX : TELNET_OPTION_REGEX_NO_SB;
    return data.replace(re, handler).replace(/\xFF/g, "");
};

const parseGmcpPayload = (
    data: string,
    onMessage: (type: string, payload: unknown) => void,
    onRawClientGui?: (payload: string) => void,
): void => {
    if (data.length === 0) return;

    const firstChar = data.charCodeAt(0);
    if (firstChar !== GMCP_COMMAND_CODE) {
        return;
    }

    const gmcpData = fromByteString(data.substring(1));
    if (!gmcpData.length) return;

    // The data part is optional per the GMCP spec — a message may be just a
    // module name with no body (e.g. the server's `Core.Ping` reply, which is
    // documented to carry no body). Treat a missing/blank body as an empty
    // value rather than dropping the whole message.
    const spaceIndex = gmcpData.indexOf(" ");
    const type = (spaceIndex === -1 ? gmcpData : gmcpData.substring(0, spaceIndex)).trim();
    let payload = spaceIndex === -1 ? "" : gmcpData.substring(spaceIndex + 1);

    if (payload.trim() === "") {
        onMessage(type, "");
        return;
    }

    // Replace literal ESC characters inside JSON strings so JSON.parse succeeds
    if (type.toLowerCase() === "gmcp_msgs") {
        payload = payload.replace(//g, "\\u001B");
    }

    try {
        const gmcp = JSON.parse(payload);
        onMessage(type, gmcp);
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
        // Nothing we can do but drop it — log the module name + raw body (not
        // just the error) so the offending message is identifiable, and use
        // warn rather than error since it's the server's fault, not a bug here.
        console.warn(`Error parsing GMCP JSON for "${type}":`, JSON.stringify(payload), error);
    }
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
    return (data: string) => {
        parseGmcpPayload(
            data,
            (type, payload) => {
                if (type.toLowerCase() === "gmcp_msgs" && onMessage) {
                    const msgType = (payload as { type: string }).type ?? "";
                    const binaryString = atob((payload as { text: string }).text ?? "");
                    const text = new TextDecoder(textEncoding).decode(
                        Uint8Array.from(binaryString, c => c.charCodeAt(0))
                    );
                    onMessage(text, msgType);
                    return;
                }
                onEnvelope({ path: type, value: payload });
                if (type.toLowerCase() === CLIENT_GUI_MODULE) onClientGui?.(payload);
            },
            raw => onClientGui?.(raw),
        );
    };
};
