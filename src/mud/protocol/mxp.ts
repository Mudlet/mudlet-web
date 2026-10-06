// MXP (MUD eXtension Protocol) — telnet option 91. An in-band, HTML-like markup
// language servers embed in the normal text stream once option 91 is negotiated.
// It carries text formatting (`<B>`, `<COLOR>`, `<FONT>`), clickable links
// (`<SEND>`, `<A>`), entities (`&lt;`, `&#160;`), custom element/entity
// definitions (`<!ELEMENT>`, `<!ENTITY>`, `<V>`), and per-line security modes via
// the `ESC[#z` CSI sequence. This parser turns one raw line (which may also carry
// ordinary ANSI SGR) into rendered {@link BufferSegment}s plus a clean,
// entity-decoded plain string for trigger matching and a list of link ranges the
// scripting engine wires into clickable hyperlinks.
//
// Reference: https://www.zuggsoft.com/zmud/mxp.htm
//
// Design notes:
//  - DOM/session-free and unit-testable. Link click behaviour (send command vs.
//    open URL) is built in the scripting engine, which has session access; this
//    module only reports *where* links are and *what* they target.
//  - The parser owns SGR carry across lines when MXP is active: it walks every
//    byte, applying ANSI SGR through `FormatState.applySgr` and layering MXP tag
//    formatting on the same pen, then returns the end-of-line snapshot.
//  - Heavy/rare tags (frames, images, gauges, dest/relocate/filter) are
//    parsed-and-discarded: the tag is consumed so it never renders literally,
//    while any enclosed text still renders inline.

import { FormatState, applyOscPalette, parseSgrCodes } from "../text/FormatState";
import type { BufferSegment, FormatColor, FormatStateSnapshot, FormatHyperlink } from "../text/FormatState";
import { mxpColor } from "../text/colorParsers";
import { scanEscape, cursorForwardCount, cursorForwardSpaces, parseOsc8Payload, classifyHyperlinkUri } from "../text/ansiEscapes";
import { parseOsc8Uri, HyperlinkPresetRegistry } from "../text/hyperlinkConfig";
import type { MspCommand, MspKind } from "./msp";
import { CLIENT_NAME, CLIENT_VERSION } from "../../version";
import { quoteLuaLiteral } from "./luaLiteral";

/** A link tag that is open — everything the close needs to finish it, since
 *  the command may only be resolvable once the wrapped text is known (`&text;`
 *  stands for it). */
interface LinkState {
    start: number;
    /** The command(s) or address, entities already filled in — all but
     *  `&text;`, which waits for the close. */
    href: string;
    hint?: string;
    kind: "command" | "url" | "prompt";
    /** Which tag made it: an `<A>` opens its address, a `<SEND>` runs it. */
    tag: "send" | "a";
    destName: string | null;
    /** Its entry in the link store — see {@link MxpParser.storeLink}. */
    id: number;
    /** `EXPIRE=name`: an `<EXPIRE name>` later retires it. */
    expire?: string;
    /** The text the tag wrapped as the game sent it, which is what `&text;`
     *  stands for. Not the same as the text shown: a tag inside it that could
     *  not be acted on is shown as text, but it was never content. */
    content: string;
}

/** A clickable region the parser found, expressed as offsets into `plain`. The
 *  engine builds the actual `FormatHyperlink` (with session/URL behaviour). */
export interface MxpLink {
    /** Start offset into the line's plain text (inclusive). */
    start: number;
    /** End offset into the line's plain text (exclusive). */
    end: number;
    /** `url` → open in a browser tab; `command` → send to the MUD;
     *  `prompt` → write it to the command line and leave it there for the
     *  player to edit and submit (a SEND carrying the PROMPT flag). */
    kind: "command" | "url" | "prompt";
    /** The single command or URL fired on left-click. */
    payload: string;
    /** Tooltip / title text. */
    hint?: string;
    /** Present when the SEND carried a `cmd1|cmd2|…` list — the engine renders a
     *  right-click popup of `cmds` labelled by `hints`. */
    prompts?: { cmds: string[]; hints: string[] };
    /** The link's id in the parser's link store; a click asks
     *  {@link MxpParser.isLinkLive} with it whether an `<EXPIRE>` retired it. */
    id: number;
}

/** A `<FRAME>` window-lifecycle command the parser surfaces to the session.
 *  The parser is session-free, so it only reports the request; the consumer
 *  (ScriptingEngine) maps it onto a mini-console via the window manager. */
export interface MxpFrameCommand {
    /** Frame name (the window id). */
    name: string;
    /** Upper-cased attribute keys → raw string values. Flag attributes
     *  (`INTERNAL`/`EXTERNAL`/`FLOATING`) are present with value `"true"`.
     *  `ACTION` is `open` (default) / `close` / `focus`; geometry lives in
     *  `ALIGN`/`LEFT`/`TOP`/`WIDTH`/`HEIGHT`. */
    attrs: Record<string, string>;
    /** Name of the `<DEST>` frame that was open when this tag was seen, if any.
     *  A `<FRAME>` nested inside a `<DEST>` is laid out *inside* that frame
     *  rather than against the main window — Mudlet's `mCurrentDestination`
     *  check in TMxpFrameManager::layoutInternalFrame. The parser batches frames
     *  and redirects into separate arrays, so the association has to travel with
     *  the command. */
    dest?: string;
}

/** Text the parser redirected into a named frame via `<DEST>…</DEST>`. */
export interface MxpRedirect {
    /** Target frame name (matches an `MxpFrameCommand.name`). */
    frame: string;
    /** Styled segments of the redirected text. */
    segments: BufferSegment[];
    /** Plain text of the redirected run. */
    plain: string;
    /** Clickable regions inside this run, offset into `plain`. Separate from
     *  `MxpLineResult.links` because the two index different strings. */
    links: MxpLink[];
    /** `EOL` attr (or the network line ended mid-DEST): the write is a complete
     *  line. */
    eol: boolean;
    /** `EOF` attr: clear the frame before writing (status-frame replace). */
    eof: boolean;
}

/** The result of parsing one raw MXP line. */
export interface MxpLineResult {
    /** Styled segments, ready for `new AnsiAwareBuffer(segments)`. */
    segments: BufferSegment[];
    /** MXP-stripped, ANSI-stripped, entity-decoded text — for trigger matching. */
    plain: string;
    /** End-of-line SGR/format pen, carried into the next line (replaces
     *  `computeTrailingState` while MXP is active). */
    trailingSnapshot?: FormatStateSnapshot;
    /** Clickable regions discovered on this line. */
    links: MxpLink[];
    /** `<FRAME>` commands seen on this line (window create/close). Omitted when none. */
    frames?: MxpFrameCommand[];
    /** Text redirected into frames via `<DEST>` on this line. Omitted when none. */
    redirects?: MxpRedirect[];
    /** `<SOUND>`/`<MUSIC>` audio triggers seen on this line, shaped as
     *  {@link MspCommand} so the consumer can route them through the same
     *  SoundManager path as MSP. Omitted when none. */
    sounds?: MspCommand[];
}

type MxpMode = "open" | "secure" | "locked";
/** The mode in force right now: one of the three, or TEMP SECURE (`ESC[4z`),
 *  which is a mode of its own in Mudlet (MXP_MODE_TEMP_SECURE) — it replaces
 *  the line's mode until the next recognised tag, then hands over to the
 *  default mode rather than back to the line's. */
type LineMode = MxpMode | "tempSecure";

interface ElementDef {
    name: string;
    /** Replacement markup, e.g. `<FONT COLOR=&col;><B>`. */
    template: string;
    /** Declared attribute names, in positional order. */
    atts: string[];
    /** Default attribute values keyed by lowercased name. */
    attDefaults: Record<string, string>;
    /** FLAG="…" bookkeeping (captured, not yet surfaced to scripts). */
    flag?: string;
    /** Usable in OPEN line mode (the `OPEN` keyword). */
    open: boolean;
    /** No closing tag (the `EMPTY` keyword). */
    empty: boolean;
}

interface OpenTag {
    name: string;
    /** Pen snapshot to restore when this tag closes. */
    closeFmt: FormatStateSnapshot;
    /** Set for `<SEND>`/`<A>` — accumulates the link target + display range.
     *  `destName` is the `<DEST>` frame that was open when the tag started, and
     *  names which text sink `start` indexes into: redirected text accrues to
     *  `destPlain`, so a link inside a `<DEST>` measured against the main line
     *  would span nothing and be dropped. */
    link?: LinkState;
    /** Set for `<V name>` — captures the enclosed plain text into `entities`. */
    varName?: string;
    varStart?: number;
    /** Set for `<COLOR>`/`<FONT>` — on close, pop one entry off `mxpColorStack`. */
    colorOverride?: boolean;
}


/** Prefix for the client→server `<SUPPORTS>`/`<VERSION>` handshake replies. The
 *  `ESC[1z` secure-line-mode marker tells the server's MXP parser this inbound
 *  line is an MXP response, not a user command. Without it, servers that gate
 *  MXP input on the secure marker (e.g. Discworld) treat the reply as ordinary
 *  text — so `<SUPPORTS …>` lands in the login prompt as a bogus character name.
 *  Matches Mudlet, which sends `\n\x1b[1z<SUPPORTS …>\n` (TMxpSupportTagHandler).
 *  The terminating newline is appended by the transport (`MudClient.send`). */
const MXP_SECURE_REPLY_PREFIX = "\x1b[1z";

/** Tags honored in OPEN line mode (safe formatting + structure). Everything else
 *  — SEND/A, definitions, V — requires SECURE mode, which is MXP's whole point:
 *  it stops server-echoed user text containing `<send>` from forging clickable
 *  commands. */
const OPEN_MODE_TAGS = new Set<string>([
    "b", "bold", "strong", "i", "italic", "em", "u", "underline",
    "s", "strikeout", "strike", "del", "h", "high", "color", "c", "font",
    "br", "sbr", "nobr", "p", "hr",
]);

/** What `<SUPPORT>` answers with: every element this parser acts on, and for
 *  each the attributes it reads. `+element` / `+element.attribute` for what is
 *  here, `-name` for anything asked about that is not — so a game can tell a
 *  client that ignores FRAME from one that has no idea what FRAME is.
 *
 *  Kept beside the dispatch in {@link MxpParser.handleOpenTag}: it is that
 *  dispatch this describes, and a tag added there without an entry here is a
 *  tag games are told this client does not have. Mirrors the shape of Mudlet's
 *  mSupportedMxpElements (TMxpTagProcessor), minus the IMAGE that Mudlet deliberately
 *  leaves unadvertised too. */
const SUPPORTED_ELEMENTS: ReadonlyMap<string, readonly string[]> = new Map([
    // Version control
    ['version', []],
    ['support', []],
    // Variables and entities
    ['var', ['publish']],
    ['v', ['publish']],
    ['entity', ['name', 'value', 'desc', 'private', 'publish', 'delete', 'add', 'remove']],
    ['element', ['name', 'definition', 'att', 'tag', 'flag', 'open', 'delete', 'empty']],
    // Status bars: consumed without being drawn, as they are in Mudlet
    ['stat', ['max', 'caption']],
    ['gauge', ['max', 'caption', 'color']],
    // Line spacing
    ['br', []],
    ['sbr', []],
    ['nobr', []],
    ['p', []],
    ['hr', []],
    // Links
    ['send', ['href', 'hint', 'prompt', 'expire']],
    ['a', ['href', 'hint', 'expire']],
    ['expire', ['name']],
    // Colour and font
    ['color', ['fore', 'back']],
    ['c', ['fore', 'back']],
    ['font', ['color', 'back']],
    // Media (MSP compatibility)
    ['sound', ['fname', 'v', 'l', 'p', 't', 'u']],
    ['music', ['fname', 'v', 'l', 'p', 'c', 't', 'u']],
    // Frames and redirection
    ['frame', ['name', 'action', 'internal', 'external', 'align', 'left', 'right',
        'top', 'bottom', 'width', 'height', 'scrolling', 'floating', 'title']],
    ['dest', ['name', 'eol', 'eof']],
    // Text formatting
    ['b', []], ['bold', []], ['strong', []],
    ['i', []], ['italic', []], ['em', []],
    ['u', []], ['underline', []],
    ['s', []], ['strikeout', []], ['strike', []], ['del', []],
    ['h', []], ['high', []],
]);

/** The entities every game gets — Mudlet's TEntityResolver table, whole: the
 *  ASCII punctuation names, `&tab;` and `&newline;`, and HTML's Latin-1 set.
 *  Names are case-sensitive here (`&Auml;` is not `&auml;`); a name that
 *  matches none exactly is tried again lowercased, as Mudlet tries it. A game's
 *  own `<!ENTITY>` of the same name is looked up first and wins.
 *  `&nbsp;` is a plain space, as in Mudlet — U+00A0 would make every trigger
 *  pattern with a space in it miss the text. A Map, so a name like
 *  `&constructor;` is not found on Object's prototype. */
const BUILTIN_ENTITIES: ReadonlyMap<string, string> = new Map(Object.entries({
    tab: "\t", newline: "\n", excl: "!", quot: "\"", num: "#", dollar: "$", percnt: "%", amp: "&",
    apos: "'", lpar: "(", rpar: ")", ast: "*", plus: "+", comma: ",", period: ".", sol: "/",
    colon: ":", semi: ";", lt: "<", equals: "=", gt: ">", quest: "?", commat: "@", lsqb: "[",
    bsol: "\\", rsqb: "]", hat: "^", lowbar: "_", grave: "`", lcub: "{", verbar: "|", rcub: "}",
    nbsp: " ", iexcl: "¡", cent: "¢", pound: "£", curren: "¤", yen: "¥", brvbar: "¦", sect: "§",
    dot: "¨", copy: "©", ordf: "ª", laquo: "«", not: "¬", shy: "\u00ad", reg: "®", macr: "¯",
    deg: "°", plusmn: "±", divide: "÷", times: "×", sup2: "²", sup3: "³", acute: "´", uml: "¨",
    micro: "µ", para: "¶", middot: "·", cedil: "¸", sup1: "¹", ordm: "º", raquo: "»", frac14: "¼",
    frac12: "½", frac34: "¾", iquest: "¿", Aacute: "Á", aacute: "á", Acirc: "Â", acirc: "â",
    AElig: "Æ", aelig: "æ", Agrave: "À", agrave: "à", Aring: "Å", aring: "å", Atilde: "Ã",
    atilde: "ã", Auml: "Ä", auml: "ä", Ccedil: "Ç", ccedil: "ç", Eacute: "É", eacute: "é",
    Ecirc: "Ê", ecirc: "ê", Egrave: "È", egrave: "è", Euml: "Ë", euml: "ë", Iacute: "Í",
    iacute: "í", Icirc: "Î", icirc: "î", Igrave: "Ì", igrave: "ì", Iuml: "Ï", iuml: "ï", ETH: "Ð",
    eth: "ð", Ntilde: "Ñ", ntilde: "ñ", Oacute: "Ó", oacute: "ó", Ocirc: "Ô", ocirc: "ô",
    Ograve: "Ò", ograve: "ò", Oslash: "Ø", oslash: "ø", Otilde: "Õ", otilde: "õ", Ouml: "Ö",
    ouml: "ö", Uacute: "Ú", uacute: "ú", Ucirc: "Û", ucirc: "û", Ugrave: "Ù", ugrave: "ù",
    Uuml: "Ü", uuml: "ü", Yacute: "Ý", yacute: "ý", THORN: "Þ", thorn: "þ", szlig: "ß",
}));

/** Tags the MXP spec defines that this parser consumes without acting on —
 *  structural ones and the heavy ones it deliberately leaves alone. Anything
 *  neither here, in {@link SUPPORTED_ELEMENTS}, nor a custom element is not MXP
 *  at all and is shown as the text it is, the way Mudlet's TMxpProcessor shows
 *  a tag no handler took. */
const CONSUMED_ELEMENTS = new Set<string>([
    "image", "relocate", "user", "password", "filter", "reset",
    "mxp", "script", "small", "tt", "samp", "center", "h1", "h2", "h3", "h4",
    "h5", "h6", "li", "ol", "ul", "attlist", "tag",
]);

/** Valueless words a `<SEND>` may carry alongside its command, so the command
 *  is the first positional that is none of them (`<SEND "look" PROMPT>`). */
const SEND_FLAGS = new Set(["prompt", "hint", "expire"]);

/** Cap on a held partial escape sequence. Beyond this it was never a real one,
 *  so it is dropped rather than swallowing the rest of the stream. */
const MAX_PENDING = 256;
/** How many links that carry an `EXPIRE` name are remembered. A link that
 *  falls off the end can no longer be retired — Mudlet's store recycles its ids
 *  after as many (TLinkStore::scmMaxLinks). */
const MAX_EXPIRING_LINKS = 20000;
/** How many custom elements may be expanding inside one another at once —
 *  TMxpCustomElementTagHandler's `maxElementExpansionDepth`: far deeper than
 *  any game nests its elements, shallow enough that a chain of thousands a
 *  game defines cannot exhaust the stack. */
const MAX_ELEMENT_EXPANSION_DEPTH = 32;
/** Narrowest an `<HR>` rule may be drawn, however narrow the window wraps.
 *  Mudlet's `TMxpMudlet::getWrapWidth` floor. */
const HR_MIN_WIDTH = 40;

export class MxpParser {
    private readonly opts: {
        send: (raw: string) => void;
        onElementEvent?: (
            name: string,
            attrs: Record<string, string>,
            body?: { text: string; actions: string[] },
        ) => void;
        onFrame?: (frame: MxpFrameCommand) => boolean;
        hasFrame?: (name: string) => boolean;
        wrapWidth?: () => number;
    };

    // --- persistent across the whole session ---
    private elements = new Map<string, ElementDef>();
    /** The custom elements whose definitions are running right now, innermost
     *  last — TMxpCustomElementTagHandler's `mElementsBeingExpanded`. See
     *  {@link mayExpand}. */
    private readonly expanding = new Set<string>();
    private entities = new Map<string, string>();
    private lineMode: LineMode = "open";
    /** Mudlet's mMXP_DEFAULT — the mode a newline, an `ESC[3z` reset and the
     *  end of a temp-secure tag return to. Null is OPEN, the initial default. */
    private lockedMode: MxpMode | null = null;
    private stack: OpenTag[] = [];
    /** Active MXP `<COLOR>`/`<FONT>` fg/bg overrides, innermost last. While
     *  non-empty, the top entry's colours are painted over whatever the ANSI
     *  pen holds — matching Mudlet, where an open MXP colour element overrides
     *  embedded ANSI SGR (TBuffer.cpp: `if (hasFgColor()) c.mFgColor = ...`).
     *  Stays in sync with the colour tags on `stack` (pushed in openColor,
     *  popped in finalizeTag). */
    private mxpColorStack: { fg: FormatColor | null; bg: FormatColor | null }[] = [];
    /** Partial tag/entity held from the end of the previous line. */
    private pendingTag = "";
    /** Whether the line being parsed came off the socket — see {@link parseLine}. */
    private fromServer = true;
    /** Active `<DEST>` target frame (persists across lines until `</DEST>`), or
     *  null when output flows to the main window. While set, appended text and
     *  flushed runs route to `destOut`/`destPlain` instead of `out`/`plain`. */
    private destName: string | null = null;
    private destEol = false;
    private destEof = false;
    /** OSC 8 preset definitions seen this session (shared with the ANSI path
     *  when the engine supplies a registry). */
    private presets: HyperlinkPresetRegistry;
    /** Set while the processor is forced on: the lock to secure mode it came
     *  with then holds against a game's `ESC[5z`/`ESC[7z` (and the locked start
     *  a bare `IAC SB MXP IAC SE` asks for) — Mudlet's shouldLockModeToSecure. */
    private forcedSecure = false;

    // --- the link store: Mudlet's TLinkStore, as far as MXP needs it ---
    /** Id of the newest link; ids are never reused, so a click on a link long
     *  gone from the store still finds nothing rather than someone else's. */
    private linkSeq = 0;
    /** The newest link and the Lua its click runs — what a custom element's
     *  `mxp.<element>.actions` reports (TLinkStore::getCurrentLinks). Emptied
     *  when an `<EXPIRE>` retires it. */
    private currentLink: { id: number; actions: string[]; expire?: string } | null = null;
    /** Every link made with an `EXPIRE` name, oldest first: the name while it
     *  is live, null once an `<EXPIRE>` has retired it. */
    private expiringLinks = new Map<number, string | null>();

    // --- per-line scratch (reset at the start of parseLine) ---
    private fmt: FormatState = new FormatState();
    private out: BufferSegment[] = [];
    private run = "";
    private plain = "";
    private links: MxpLink[] = [];
    /** `<FRAME>` commands and `<DEST>` redirects accumulated this line. */
    private frames: MxpFrameCommand[] = [];
    private redirects: MxpRedirect[] = [];
    /** `<SOUND>`/`<MUSIC>` commands accumulated this line. */
    private sounds: MspCommand[] = [];
    /** Redirected-text scratch — the current `<DEST>` run's segments/plain/links. */
    private destOut: BufferSegment[] = [];
    private destPlain = "";
    private destLinks: MxpLink[] = [];

    constructor(opts: {
        send: (raw: string) => void;
        presets?: HyperlinkPresetRegistry;
        /** Fired whenever a server-defined custom element is used, with the
         *  tag's attributes resolved the way Mudlet resolves them (see
         *  {@link elementEventAttrs}). Backs the Lua `mxp` table. `body` is
         *  carried by the tags that wrap text and act on it — a `<SEND>` reports
         *  the text it wrapped and the commands its click would run. */
        onElementEvent?: (
            name: string,
            attrs: Record<string, string>,
            body?: { text: string; actions: string[] },
        ) => void;
        /** Carry out a `<FRAME>` as it is read, answering whether it could be:
         *  false leaves the tag in the line as text, which is what a game sees
         *  when it names a frame that is not open or a name that is not a plain
         *  word. Without this the commands are collected into the result for a
         *  caller to run afterwards, which cannot report a refusal in time. */
        onFrame?: (frame: MxpFrameCommand) => boolean;
        /** Whether a frame of this name is open for a `<DEST>` to write into.
         *  Text sent to one that is not stays where it was, in the main line
         *  (Mudlet leaves it in the line it was building when the frame has no
         *  sink). Without this every `<DEST>` is redirected and the caller
         *  decides afterwards. */
        hasFrame?: (name: string) => boolean;
        /** Columns the main window wraps at — how wide `<HR>` draws its rule.
         *  Mudlet's `TMxpClient::getWrapWidth`, whose own fallback is 80. */
        wrapWidth?: () => number;
    }) {
        this.opts = opts;
        this.presets = opts.presets ?? new HyperlinkPresetRegistry();
    }

    /**
     * Lock the parser to secure line mode (or release the lock). Mudlet does
     * this whenever the MXP processor is forced on without an option-91
     * handshake (ctelnet.cpp: MXP_MODE_CODE_LOCK_SECURE): such servers are
     * IRE-style and never send mode switches, they just use secure tags — and
     * without the lock every definition tag would be ignored as unsafe.
     */
    lockSecureMode(locked: boolean): void {
        this.forcedSecure = locked;
        this.setLockedMode(locked ? "secure" : null);
    }

    /** Set the mode every line falls back to — the `ESC[5z`/`6z`/`7z` lock,
     *  reachable from outside because a bare `IAC SB MXP IAC SE` starts the
     *  processor locked (cTelnet sets MXP_MODE_CODE_LOCK_LOCKED for it): such
     *  a server has negotiated nothing, so until it sends a mode of its own
     *  nothing it writes is markup. */
    setLockedMode(mode: "open" | "secure" | "locked" | null): void {
        // A forced processor keeps its secure lock, as it does against the
        // game's own ESC[5z/7z (see applyLineMode).
        if (this.forcedSecure && mode !== "secure" && mode !== null && this.lockedMode === "secure") return;
        this.lockedMode = mode;
        this.lineMode = mode ?? "open";
    }

    /** Whether a link is still there to click: false once an `<EXPIRE>` has
     *  retired the name it was made with (TLinkStore::expireLinks), when a
     *  click on it runs nothing. */
    isLinkLive(id: number): boolean {
        return this.expiringLinks.get(id) !== null;
    }

    /** Clear all cross-line state. Called on (re)connect so a new session starts
     *  with no leftover definitions, open tags, or modes. */
    reset(): void {
        this.elements.clear();
        this.entities.clear();
        this.lineMode = "open";
        this.lockedMode = null;
        this.stack = [];
        this.mxpColorStack = [];
        this.pendingTag = "";
        this.destName = null;
        this.destEol = false;
        this.destEof = false;
        this.fmt = new FormatState();
        this.out = [];
        this.run = "";
        this.plain = "";
        this.links = [];
        this.frames = [];
        this.redirects = [];
        this.sounds = [];
        this.destOut = [];
        this.destPlain = "";
        this.destLinks = [];
        this.presets.clear();
    }

    /** Parse one raw line (post telnet-strip, post UTF-8 decode), which may carry
     *  ANSI SGR, MXP tags, `ESC[#z` modes, and entities. `baseSnapshot` is the
     *  carried pen from the previous line.
     *
     *  `fromServer` false means the line was synthesised locally (feedTriggers).
     *  Such a line's `ESC[#z` is consumed but does not switch mode, matching
     *  Mudlet's `isFromServer` gate on `mMxpProcessor.setMode` — otherwise a
     *  script feeding a captured game line would leave the parser in whatever
     *  mode that capture ended on, and the next real tag would be discarded as
     *  unsafe. */
    parseLine(rawLine: string, baseSnapshot?: FormatStateSnapshot, fromServer = true): MxpLineResult {
        this.fromServer = fromServer;
        const input = this.pendingTag + rawLine;
        this.pendingTag = "";

        this.fmt = new FormatState(baseSnapshot);
        this.out = [];
        this.run = "";
        this.plain = "";
        this.links = [];
        this.frames = [];
        this.redirects = [];
        this.sounds = [];
        // destName/destEol/destEof persist across lines (until </DEST>); only the
        // per-line accumulators reset.
        this.destOut = [];
        this.destPlain = "";
        this.destLinks = [];

        this.parseFragment(input, 0);
        this.flushRun();
        // A still-open <DEST> at end of line: the network line break is a real
        // line break inside the frame, so emit this line's redirected run with
        // eol=true. destName stays set so the next line keeps redirecting.
        if (this.destName !== null && (this.destOut.length > 0 || this.destPlain.length > 0)) {
            this.redirects.push({
                frame: this.destName, segments: this.destOut, plain: this.destPlain,
                links: this.destLinks,
                eol: true, eof: this.destEof,
            });
            this.destOut = [];
            this.destPlain = "";
            this.destLinks = [];
            // EOF clears once, on the first write of the block.
            this.destEof = false;
        }
        // A held partial escape means we're logically mid-line, so the
        // transient line mode (and temp-secure) must survive into the
        // continuation.
        if (this.pendingTag === "") this.resetTransientMode();

        const trailing = this.fmt.toSnapshot();
        const result: MxpLineResult = { segments: this.out, plain: this.plain, trailingSnapshot: trailing, links: this.links };
        if (this.frames.length > 0) result.frames = this.frames;
        if (this.redirects.length > 0) result.redirects = this.redirects;
        if (this.sounds.length > 0) result.sounds = this.sounds;
        return result;
    }

    private effectiveMode(): LineMode {
        // The current line's mode. Lock modes (5/6/7) only change the *default*
        // that `resetTransientMode` restores at the start of each new line — they
        // are NOT an override that beats a per-line mode tag (0/1/2). Servers that
        // wrap each control in `ESC[1z…ESC[7z` (e.g. Avalon) rely on a later
        // `ESC[1z` re-entering secure mode for the current line even though the
        // locked default is "locked"; returning `lockedMode` here instead would
        // make every tag after the first `ESC[7z` render as literal text.
        return this.lineMode;
    }

    private resetTransientMode(): void {
        // A line that ends in OPEN mode takes the tags it left open with it:
        // only a secure line's tags are the game's to close
        // (TMxpProcessor::resetToDefaultMode).
        if (this.lineMode === "open") this.closeOpenModeTags();
        // Transient OPEN/SECURE/LOCKED (modes 0/1/2) last only for the current
        // line; at the newline we revert to the locked mode, or OPEN by default.
        this.lineMode = this.lockedMode ?? "open";
    }

    /** Take off the styling open tags put on — bold, italic, underline,
     *  strikeout and colour — when the mode moves away from OPEN, the way
     *  Mudlet's resetTextProperties drops its counters and colour stacks.
     *  Links and variables are left running: that call does not touch them. */
    private closeOpenModeTags(): void {
        if (!this.stack.some(t => !t.link && t.varName === undefined)) return;
        this.flushRun();
        const kept: OpenTag[] = [];
        // Innermost first, so the outermost tag's "before" is what is left.
        for (let k = this.stack.length - 1; k >= 0; k--) {
            const tag = this.stack[k];
            if (tag.link || tag.varName !== undefined) {
                kept.unshift(tag);
                continue;
            }
            if (tag.colorOverride && this.mxpColorStack.length > 0) this.mxpColorStack.pop();
            const before = tag.closeFmt;
            switch (tag.name) {
                case "b": case "bold": case "strong": case "h": case "high":
                    this.fmt.bold = before.bold; break;
                case "i": case "italic": case "em":
                    this.fmt.italic = before.italic; break;
                case "u": case "underline":
                    this.fmt.underline = before.underline; break;
                case "s": case "strikeout": case "strike": case "del":
                    this.fmt.strikethrough = before.strikethrough; break;
            }
        }
        this.stack = kept;
    }

    // ---- text emission ----

    /** Add text to the line. `markup` marks text that is markup put back —
     *  a tag that could not be acted on, shown as what it was — which the
     *  links open around it do not count as the text they wrap (Mudlet inserts
     *  such a tag straight into the line, past the handlers' handleContent). */
    private appendText(s: string, markup = false): void {
        if (s.length === 0) return;
        this.run += s;
        // While a <DEST> is open, plain text accrues to the redirect buffer, not
        // the main line (so it never reaches the main window or its triggers).
        if (this.destName === null) this.plain += s;
        else this.destPlain += s;
        if (!markup) for (const tag of this.stack) if (tag.link) tag.link.content += s;
    }

    /** `CSI n C` (cursor forward): n spaces painted in the background colour,
     *  as TBuffer writes them (see cursorForwardCount). They go straight into
     *  the line, past any open link's content, the way Mudlet appends them to
     *  mMudLine without the MXP handlers seeing them. */
    private appendCursorForward(count: number): void {
        this.flushRun();
        this.appendText(" ".repeat(count), true);
        this.flushRun(true);
    }

    private flushRun(transparent = false): void {
        if (this.run.length === 0) return;
        // The attributes the characters are written with, not the pen: on one
        // of the sixteen ANSI colours bold only picks the bright twin and the
        // text itself is not bold — an MXP <B> included, which sets the same
        // bold the SGR does (TBuffer's `mIsDefaultColor ? mBold : false`).
        const state = this.fmt.toCellSnapshot();
        // An open MXP <COLOR>/<FONT> colour wins over the ANSI pen (Mudlet
        // semantics): the ANSI fg/bg still tracks in `fmt` so it resumes once
        // the colour tag closes, but it isn't what gets painted meanwhile.
        const override = this.mxpColorStack[this.mxpColorStack.length - 1];
        if (override) {
            if (override.fg) state.foreground = override.fg;
            if (override.bg) state.background = override.bg;
        }
        if (transparent) state.foreground = state.background ? { ...state.background } : undefined;
        // Route the run to the active <DEST> frame, or to the main line.
        if (this.destName === null) this.out.push({ text: this.run, state });
        else this.destOut.push({ text: this.run, state });
        this.run = "";
    }

    // ---- scanner ----

    private parseFragment(text: string, depth: number): void {
        let i = 0;
        const n = text.length;
        while (i < n) {
            const ch = text[i];

            if (ch === "\x1b") {
                const esc = scanEscape(text, i);
                if (esc.kind === "incomplete") {
                    // Sequence cut off at end of input — hold for the next line.
                    if (depth === 0 && n - i <= MAX_PENDING) this.pendingTag = text.slice(i);
                    return;
                }
                if (esc.kind === "csi" && esc.finalByte === "m") {
                    // The same reading as the plain ANSI path, sub-parameters
                    // and all — null when no parameter could be read at all.
                    const sgr = parseSgrCodes(esc.params ?? "");
                    if (sgr) {
                        this.flushRun();
                        this.fmt.applySgr(sgr);
                    }
                } else if (esc.kind === "csi" && esc.finalByte === "C") {
                    // Stopping at the main window's right margin, measured
                    // from the line written so far (cursorForwardSpaces).
                    const column = (this.destName === null ? this.plain : this.destPlain).length;
                    const spaces = cursorForwardSpaces(cursorForwardCount(esc.params), column, this.opts.wrapWidth?.());
                    if (spaces > 0) this.appendCursorForward(spaces);
                } else if (esc.kind === "csi" && esc.finalByte === "z") {
                    // Consumed either way — it is never text — but only obeyed
                    // when the game sent it. See parseLine's `fromServer`.
                    this.flushRun();
                    // Only a plain number is a mode: `ESC[z` or `ESC[1;2z` is
                    // ignored, not read as mode 0 or 1 (TMxpProcessor::setMode
                    // drops a code that is not an integer).
                    const code = esc.params ?? "";
                    if (this.fromServer && /^\d+$/.test(code)) this.applyLineMode(parseInt(code, 10));
                } else if (esc.kind === "osc" && esc.oscPayload !== undefined) {
                    // OSC 8 hyperlink: open/close a clickable link on the
                    // following text. The URI is stashed on the pen and the
                    // engine wires its click behaviour after the buffer is
                    // built (bindUrlHyperlinks); a disallowed scheme is ignored.
                    const link = parseOsc8Payload(esc.oscPayload);
                    if (link) {
                        this.flushRun();
                        if (link.uri === "") {
                            this.fmt.hyperlink = undefined;
                        } else {
                            const result = parseOsc8Uri(link.uri, this.presets);
                            if (result?.kind === "link" && classifyHyperlinkUri(result.command)) {
                                const hl: FormatHyperlink = { url: result.command };
                                if (Object.keys(result.config).length > 0) hl.config = result.config;
                                if (link.id) hl.linkId = link.id;
                                this.fmt.hyperlink = hl;
                            }
                            // preset definition / disallowed scheme: leave as-is.
                        }
                    } else {
                        // `ESC]P`/`ESC]R` colour palette redefinition (no
                        // text/state change — retargets colour tables for
                        // following runs).
                        applyOscPalette(esc.oscPayload);
                    }
                }
                // Every other recognized sequence (non-OSC-8 OSC commands,
                // cursor moves, erase, charset designation, DCS strings, …) is
                // consumed and never rendered as literal text.
                i = esc.end;
                continue;
            }

            if (ch === "<") {
                const next = text[i + 1];
                // A real MXP tag opens with a letter, '/', or '!'. Anything else
                // (e.g. "5 < 10") is literal text — and in a locked line all
                // markup is literal.
                const looksLikeTag = next !== undefined && /[a-zA-Z!/]/.test(next);
                if (this.effectiveMode() === "locked" || !looksLikeTag) {
                    this.appendText("<");
                    i++;
                    continue;
                }
                const { close, restart } = scanTag(text, i);
                const cutAt = text.indexOf("\x1b", i + 1);
                // A second `<` before the tag closed — outside quotes, and not
                // in a comment — means the first never was one: what was read
                // of it is text, and the new `<` starts afresh (TMxpProcessor's
                // nested-'<' recovery). Read as one tag instead, `a<b and <3> ok`
                // lost "b and <3" and turned bold.
                if (restart !== -1 && (cutAt === -1 || restart < cutAt)) {
                    this.appendText(text.slice(i, restart), true);
                    i = restart;
                    continue;
                }
                // An ANSI escape cannot be part of a tag, so one arriving
                // before the tag closed cuts it short: what was read of it is
                // shown as the text it was, in the colours in use before the
                // escape, and the escape then acts as usual (TBuffer's
                // `abortCurrentTag()` on an ESC while a tag is being built).
                if (cutAt !== -1 && (close === -1 || cutAt < close)) {
                    this.appendText(text.slice(i, cutAt), true);
                    i = cutAt;
                    continue;
                }
                if (close === -1) {
                    // Unterminated at the end of the line: a tag cannot span
                    // lines, so what was read of it is text, and the next line
                    // starts clean (TMxpProcessor rejects a tag a newline
                    // arrives inside). Holding it instead swallowed the line
                    // after it whole.
                    this.appendText(text.slice(i), true);
                    return;
                }
                this.handleTag(text.slice(i + 1, close), depth);
                i = close + 1;
                continue;
            }

            if (ch === "&") {
                if (this.effectiveMode() === "locked") {
                    this.appendText("&");
                    i++;
                    continue;
                }
                // An entity left unfinished at the end of the line is text: the
                // newline ends it, as it ends a tag, so `call AT&T` keeps its
                // `&T` and the next line is its own (Mudlet/Mudlet#9439).
                const semi = text.indexOf(";", i + 1);
                if (semi !== -1 && semi - i <= 33) {
                    const decoded = this.decodeEntity(text.slice(i + 1, semi));
                    if (decoded !== null) {
                        this.appendText(decoded);
                        i = semi + 1;
                        continue;
                    }
                }
                this.appendText("&");
                i++;
                continue;
            }

            // Plain run up to the next special character.
            let k = i;
            while (k < n) {
                const c = text[k];
                if (c === "\x1b" || c === "<" || c === "&") break;
                k++;
            }
            this.appendText(text.slice(i, k));
            i = k;
        }
    }

    // ---- line modes ----

    private applyLineMode(n: number): void {
        // Leaving OPEN for anything but OPEN closes the tags it left open
        // (TMxpProcessor::setMode); a reset closes everything regardless.
        if (this.lineMode === "open" && (n === 1 || n === 2 || n === 6 || n === 7)) {
            // A forced processor ignores 7, and so keeps what it would close.
            if (!(n === 7 && this.forcedSecure && this.lockedMode === "secure")) this.closeOpenModeTags();
        }
        switch (n) {
            case 0: this.lineMode = "open"; break;
            case 1: this.lineMode = "secure"; break;
            case 2: this.lineMode = "locked"; break;
            case 3:
                // Reset: close everything and drop the styling, then fall back
                // to the DEFAULT mode — which a lock (ESC[5z/6z/7z, or the
                // locked start of a bare IAC SB MXP IAC SE) set and a reset
                // keeps. Mudlet: `mMXP_MODE = mMXP_DEFAULT`; it is not OPEN.
                this.closeAllTags();
                this.fmt.reset();
                this.lineMode = this.lockedMode ?? "open";
                break;
            case 4: this.lineMode = "tempSecure"; break;
            case 5: case 7:
                // A forced processor holds its secure lock against a game
                // that would unlock it (shouldLockModeToSecure).
                if (this.forcedSecure && this.lockedMode === "secure") break;
                this.lockedMode = this.lineMode = n === 5 ? "open" : "locked";
                break;
            case 6: this.lockedMode = "secure"; this.lineMode = "secure"; break;
        }
    }

    /** The style id a game named with `<VERSION styleId>`, stamped onto every
     *  later VERSION answer. Nothing takes it back off — an empty attribute is
     *  dropped by the parser before it gets here, so `<VERSION "">` is just a
     *  bare VERSION — and it lasts as long as the session that set it. */
    private mxpStyle: string | null = null;

    private closeAllTags(): void {
        this.flushRun();
        for (let k = this.stack.length - 1; k >= 0; k--) this.finalizeTag(this.stack[k]);
        this.stack.length = 0;
    }

    // ---- tags ----

    /** `mapValue`, when given, is applied to every attribute once the tag has
     *  been read — how a custom element's values reach the tags of its
     *  definition. Filling them in before the read would let a value with a
     *  quote in it end the attribute it was put in and write attributes of its
     *  own. */
    private handleTag(raw: string, depth: number, mapValue?: (value: string) => string): void {
        const trimmed = raw.trim();
        if (trimmed === "") return;

        const mode = this.effectiveMode();
        const secure = mode === "secure" || mode === "tempSecure";
        // Temp-secure (mode 4) lasts for one recognised tag, after which the
        // DEFAULT mode is in force for the rest of the line — not whatever the
        // line was in before (TMxpProcessor::processMxpInput). A name Mudlet
        // does not know is rejected before that point and leaves it pending.
        if (mode === "tempSecure" && this.isRecognisedTag(trimmed)) {
            this.lineMode = this.lockedMode ?? "open";
        }

        if (trimmed.startsWith("!")) {
            if (!secure || !this.handleDefinition(trimmed)) this.showAsText(raw);
            return;
        }
        if (trimmed.startsWith("/")) {
            const name = trimmed.slice(1).trim().split(/[\s>]/)[0].toLowerCase();
            if (!secure && !this.openAllowed(name)) {
                this.showAsText(raw);
                return;
            }
            if (!this.isKnownTag(name)) {
                this.showAsText(raw);
                return;
            }
            this.handleCloseTag(name);
            return;
        }

        const sp = firstWhitespace(trimmed);
        const name = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
        const attrStr = sp === -1 ? "" : trimmed.slice(sp + 1);

        if ((!secure && !this.openAllowed(name)) || !this.isKnownTag(name)) {
            this.showAsText(raw);
            return;
        }
        this.handleOpenTag(name, attrStr, depth, raw, mapValue);
    }

    /** A tag the current line mode does not allow is shown to the player as
     *  the text it literally is, brackets and all — Mudlet re-inserts the raw
     *  tag content the same way (HANDLER_INSERT_ENTITY_SYS). Swallowing it
     *  instead would hide half a game's output on an OPEN line and leave the
     *  other half — the text the tag wrapped — with no explanation. */
    private showAsText(raw: string): void {
        this.appendText("<" + raw + ">", true);
    }

    private isKnownTag(name: string): boolean {
        return SUPPORTED_ELEMENTS.has(name) || CONSUMED_ELEMENTS.has(name) || this.elements.has(name);
    }

    /** Whether Mudlet would recognise a tag (its trimmed raw text) as MXP —
     *  the definitions it lists in allMxpTags, or a known element, open or
     *  closing. What it does not recognise it rejects as text before the
     *  temp-secure mode is spent. */
    private isRecognisedTag(trimmed: string): boolean {
        if (trimmed.startsWith("!")) return /^!(element|el|attlist|at|entity|en|tag|--)(?![a-z])/i.test(trimmed);
        const body = trimmed.startsWith("/") ? trimmed.slice(1).trim() : trimmed;
        return this.isKnownTag(body.split(/[\s>]/)[0].toLowerCase());
    }

        private openAllowed(name: string): boolean {
        if (OPEN_MODE_TAGS.has(name)) return true;
        const def = this.elements.get(name);
        return def ? def.open : false;
    }

    private handleOpenTag(
        name: string, attrStr: string, depth: number, raw = "", mapValue?: (value: string) => string,
    ): void {
        const { named, positional, firstIsPositional } = parseAttrs(attrStr, mapValue);
        const def = this.elements.get(name);
        if (def) {
            this.expandElement(def, named, positional, depth);
            return;
        }

        switch (name) {
            case "b": case "bold": case "strong":
                this.openFormat(name, () => { this.fmt.bold = true; }); break;
            case "i": case "italic": case "em":
                this.openFormat(name, () => { this.fmt.italic = true; }); break;
            case "u": case "underline":
                this.openFormat(name, () => { this.fmt.underline = true; }); break;
            case "s": case "strikeout": case "strike": case "del":
                this.openFormat(name, () => { this.fmt.strikethrough = true; }); break;
            case "h": case "high":
                this.openFormat(name, () => { this.fmt.bold = true; }); break;
            case "color": case "c":
                this.openColor(name, named.get("fore") ?? positional[0], named.get("back") ?? positional[1]); break;
            case "font":
                // FACE and SIZE are read and thrown away — a MUD does not get to
                // pick the font — but they still hold the first two positions the
                // colours are counted from (TMxpFontTagHandler: FACE 0, SIZE 1,
                // COLOR 2, BACK 3).
                this.openColor(name, named.get("color") ?? named.get("fore") ?? positional[2],
                    named.get("back") ?? named.get("bgcolor") ?? positional[3]); break;
            case "send": {
                // <SEND "look" PROMPT> — the command is the first positional
                // that is not one of the flags, and PROMPT switches the click
                // from sending to seeding the command line. With none, the
                // command is the text the tag wraps.
                const flags = new Set(positional.map(p => p.toLowerCase()));
                const href = named.get("href") ?? named.get("hr")
                    ?? positional.find(p => !SEND_FLAGS.has(p.toLowerCase()));
                const hint = named.get("hint") ?? named.get("title");
                const prompt = flags.has("prompt") || named.has("prompt");
                this.openLink("send", href || "&text;", hint, prompt ? "prompt" : "command", named.get("expire"));
                break;
            }
            case "a": {
                // The address is HREF, or a first word that has no value, or —
                // for a bare <A> — the text it wraps. An A with attributes and
                // none of them an address is no link at all, and is shown as
                // the text it is (TMxpLinkTagHandler::getHref).
                const bare = named.size === 0 && positional.length === 0;
                const href = bare ? "&text;"
                    : named.has("href") ? named.get("href")
                    : firstIsPositional ? positional[0]
                    : undefined;
                if (!href) {
                    this.showAsText(raw);
                    break;
                }
                this.openLink("a", href, named.get("hint") ?? named.get("title"), "url", named.get("expire"));
                break;
            }
            case "expire": {
                // <EXPIRE name> / <EXPIRE NAME=name>: retire every link made
                // with that EXPIRE name. One that names nothing is not a tag
                // Mudlet can act on, and is shown as text.
                const group = named.get("name") ?? positional[0];
                if (!group) this.showAsText(raw);
                else this.expireLinks(group);
                break;
            }
            case "v": case "var":
                this.openVar(named.get("name") ?? positional[0] ?? ""); break;
            case "br":
                this.appendText("\n"); break;
            case "sbr":
                this.appendText(" "); break;
            case "hr":
                // Mudlet's TMxpHRTagHandler: the rule is not drawn, it is fed
                // back through the parser as text — a newline to commit
                // whatever the line held, the dashes, and a newline to leave
                // the next text on a line of its own. Its width is the main
                // window's wrap column, with a forty column floor.
                this.appendText(`\n${"-".repeat(Math.max(this.opts.wrapWidth?.() ?? 80, HR_MIN_WIDTH))}\n`);
                break;
            case "frame":
                this.handleFrameTag(named, positional, raw); break;
            case "dest":
                this.handleDestTag(named, positional, raw); break;
            case "sound":
                this.handleSoundTag("sound", named, positional); break;
            case "music":
                this.handleSoundTag("music", named, positional); break;
            case "support":
                this.answerSupport(positional); break;
            case "version":
                this.answerVersion(positional); break;
            default:
                // Structural no-ops (p, nobr) and discarded heavy tags (image,
                // gauge, relocate, …): consume the tag, render nothing for it.
                // Only known tags get here — handleTag shows the rest as text.
                // Any enclosed text still renders since the close handler ignores
                // unmatched closing tags.
                break;
        }
    }



    /** Hand a finished `<SEND>` to Lua the way Mudlet does: the `mxp.send`
     *  table and an `mxp.send` event, carrying the tag's attributes, the text it
     *  wrapped, and the Lua each of its commands would run — `send(…)`, or
     *  `printCmdLine(…)` for a PROMPT, the command quoted by
     *  {@link quoteLuaLiteral}. Queued on the closing tag because
     *  until then the caption is not known, and the caption is what `&text;`
     *  resolves to in every one of those (TMxpMudlet::setCaptionForSendEvent).
     *
     *  A script reads this to act on a link the game drew — to relabel it, to
     *  run something of its own alongside it, or to count what a shop offered.
     *  The command list is reported whole even where the click can only fire
     *  the first of them. */
    private reportSend(link: LinkState, text: string, resolvedHref: string, actions: string[]): void {
        const report = this.opts.onElementEvent;
        if (!report) return;
        const attrs: Record<string, string> = {};
        if (link.href !== "&text;") attrs.href = resolvedHref;
        if (link.hint !== undefined) attrs.hint = link.hint.replace(/&text;/gi, text);
        if (link.kind === "prompt") attrs.prompt = "";
        report("send", attrs, { text, actions });
    }
    /** `<SUPPORT>` asks what this client can do. Bare, it lists everything;
     *  named, it answers about exactly what was asked, in the order it was asked
     *  — `element` for the whole element and its attributes, `element.attribute`
     *  for one of them, `element.*` for the whole element again, and a leading
     *  minus for anything not here. A game reads this to decide which of its
     *  markup to send, so answering about something we do not do would cost it
     *  the fallback it has for clients that lack it. */
    private answerSupport(requested: string[]): void {
        const out: string[] = [];
        const whole = (element: string) => {
            out.push(`+${element}`);
            for (const attr of SUPPORTED_ELEMENTS.get(element) ?? []) out.push(`+${element}.${attr}`);
        };
        if (requested.length === 0) {
            for (const element of SUPPORTED_ELEMENTS.keys()) whole(element);
        } else {
            for (const raw of requested) {
                const asked = raw.toLowerCase();
                const dot = asked.indexOf(".");
                if (dot === -1) {
                    if (SUPPORTED_ELEMENTS.has(asked)) whole(asked);
                    else out.push(`-${asked}`);
                    continue;
                }
                const element = asked.slice(0, dot);
                const attr = asked.slice(dot + 1);
                const attrs = SUPPORTED_ELEMENTS.get(element);
                if (!attrs) out.push(`-${asked}`);
                else if (attr === "*") whole(element);
                else if (attrs.includes(attr)) out.push(`+${element}.${attr}`);
                else out.push(`-${element}.${attr}`);
            }
        }
        this.opts.send(`${MXP_SECURE_REPLY_PREFIX}<SUPPORTS ${out.join(" ")}>`);
    }

    /** `<VERSION>` asks who this client is; `<VERSION styleId>` instead names a
     *  style the game wants its answers stamped with from then on, and is not
     *  answered at all. MXP=1.0 is the protocol version we speak; CLIENT and
     *  VERSION are our own identity (see src/version.ts). Unquoted, as Mudlet
     *  sends it — a game's parser may be no more than a split on spaces. */
    private answerVersion(positional: string[]): void {
        const style = positional[0];
        if (style !== undefined && style !== "") {
            this.mxpStyle = style;
            return;
        }
        const styleAttr = this.mxpStyle === null ? "" : ` STYLE=${this.mxpStyle}`;
        this.opts.send(`${MXP_SECURE_REPLY_PREFIX}<VERSION MXP=1.0 CLIENT=${CLIENT_NAME}`
            + ` VERSION=${CLIENT_VERSION}${styleAttr}>`);
    }
    /** `<FRAME name [action] [internal|external|floating] [left|top|width|height]
     *  [scrolling] [title]>` — record a window create/close request for the
     *  consumer. NAME is the first positional or the NAME attribute; valueless
     *  flags (INTERNAL/EXTERNAL/FLOATING) become `"true"`. */
    private handleFrameTag(named: Map<string, string>, positional: string[], raw: string): void {
        let name = named.get("name");
        let flagStart = 0;
        if (!name) { name = positional[0]; flagStart = 1; }
        name = (name ?? "").trim();
        if (name === "") { this.showAsText(raw); return; }
        this.flushRun(); // commit any preceding main text before the command
        const attrs: Record<string, string> = {};
        for (const [k, v] of named) if (k !== "name") attrs[k.toUpperCase()] = v;
        for (let i = flagStart; i < positional.length; i++) attrs[positional[i].toUpperCase()] = "true";
        attrs.NAME = name;
        const cmd: MxpFrameCommand = { name, attrs };
        if (this.destName !== null) cmd.dest = this.destName;
        if (!this.opts.onFrame) {
            this.frames.push(cmd);
            return;
        }
        // Acted on here rather than collected, because whether it worked
        // decides what the line says: a FRAME naming a window that is not
        // there, or a name that is not a plain word, is a tag the client
        // could not carry out, and Mudlet leaves such a tag in the stream as
        // text rather than swallowing it (MXP_TAG_NOT_HANDLED). Doing that
        // after the line was assembled would put the tag on the wrong line.
        if (!this.opts.onFrame(cmd)) this.showAsText(raw);
    }

    /** `<DEST name [eol] [eof]>` — start redirecting enclosed text into `name`.
     *  NAME is the NAME attribute or the first non-flag positional. Persists
     *  until `</DEST>` (or end of line). A nameless DEST is a tag Mudlet cannot
     *  act on, and is shown as text; one naming a frame that is not open is
     *  taken out, but its text stays in the line it was part of — Mudlet keeps
     *  building the main line when the destination has no sink to flush to. */
    private handleDestTag(named: Map<string, string>, positional: string[], raw: string): void {
        const flags = new Set(positional.map(p => p.toLowerCase()));
        let name = named.get("name");
        if (!name) name = positional.find(p => { const l = p.toLowerCase(); return l !== "eol" && l !== "eof"; });
        name = (name ?? "").trim();
        if (name === "") {
            this.showAsText(raw);
            return;
        }
        if (this.opts.hasFrame && !this.opts.hasFrame(name)) {
            // Nowhere to send it: close any redirect already running, and let
            // the text carry on in the main line.
            if (this.destName !== null) this.closeDest(this.destEol);
            return;
        }
        // Close any frame already being redirected to (nested/sequential DEST).
        if (this.destName !== null) this.closeDest(this.destEol);
        this.flushRun(); // commit preceding main text before switching sink
        this.destName = name;
        this.destEol = flags.has("eol") || named.has("eol");
        this.destEof = flags.has("eof") || named.has("eof");
        this.destOut = [];
        this.destPlain = "";
        this.destLinks = [];
    }

    /** `<SOUND fname [V=vol] [L=loops] [P=priority] [T=type] [U=url]>` and
     *  `<MUSIC fname [V=vol] [L=loops] [C=continue] [T=type] [U=url]>` — MXP's
     *  audio triggers (https://www.zuggsoft.com/zmud/mxp.htm#Sound). They carry
     *  the same fields as MSP's `!!SOUND`/`!!MUSIC`, so surface them as an
     *  {@link MspCommand} and let the consumer route them through the same
     *  SoundManager path. FNAME is the FNAME attribute or the first positional;
     *  the literal `Off` (also `off`) stops playback. A fileless tag is ignored. */
    private handleSoundTag(kind: MspKind, named: Map<string, string>, positional: string[]): void {
        const file = (named.get("fname") ?? positional[0] ?? "").trim();
        if (file === "") return;
        // Normalise `off`/`OFF` to the canonical `Off` the consumer stops on.
        const cmd: MspCommand = { kind, file: file.toLowerCase() === "off" ? "Off" : file };
        const url = named.get("u");
        if (url) cmd.url = url;
        const v = parseInt(named.get("v") ?? "", 10);
        if (Number.isFinite(v)) cmd.volume = v < 0 ? 0 : v > 100 ? 100 : v;
        const l = parseInt(named.get("l") ?? "", 10);
        if (Number.isFinite(l)) cmd.loops = l;
        if (kind === "sound") {
            const p = parseInt(named.get("p") ?? "", 10);
            if (Number.isFinite(p)) cmd.priority = p < 0 ? 0 : p > 100 ? 100 : p;
        } else if (named.get("c") === "1") {
            cmd.continueIfPlaying = true;
        }
        const type = named.get("t");
        if (type) cmd.type = type;
        this.sounds.push(cmd);
    }

    /** Finalize the current `<DEST>` run into a redirect and stop redirecting. */
    private closeDest(eol: boolean): void {
        if (this.destName === null) return;
        this.flushRun();
        if (this.destOut.length > 0 || this.destPlain.length > 0) {
            this.redirects.push({
                frame: this.destName, segments: this.destOut, plain: this.destPlain,
                links: this.destLinks,
                eol, eof: this.destEof,
            });
        }
        this.destName = null;
        this.destEol = false;
        this.destEof = false;
        this.destOut = [];
        this.destPlain = "";
        this.destLinks = [];
        // Mudlet's clearMxpDestination() ends with resetCurrentTextFormat(): the
        // pen goes back to the profile's own colours rather than to whatever was
        // in force before the redirect. Without it, colour a game sets inside a
        // frame's content follows the text back out and repaints the main
        // window — the frame's SGR is written for the frame.
        this.fmt.reset();
    }

    private openFormat(name: string, mutate: () => void): void {
        const before = this.fmt.toSnapshot();
        this.flushRun();
        mutate();
        this.stack.push({ name, closeFmt: before });
    }

    private openColor(name: string, fore?: string, back?: string): void {
        const before = this.fmt.toSnapshot();
        this.flushRun();
        // Layer this element's colours over the current override (inheriting the
        // parent's where this tag omits one), rather than writing into the ANSI
        // pen — so embedded ANSI SGR can't repaint the span. Always push a
        // matching entry so the close in finalizeTag stays balanced, mirroring
        // Mudlet's pushColor/popColor pairing for every COLOR/FONT tag.
        const top = this.mxpColorStack[this.mxpColorStack.length - 1];
        const fg = (fore ? mxpColor(fore) : null) ?? top?.fg ?? null;
        const bg = (back ? mxpColor(back) : null) ?? top?.bg ?? null;
        this.mxpColorStack.push({ fg, bg });
        this.stack.push({ name, closeFmt: before, colorOverride: true });
    }

    private openLink(
        tag: "send" | "a",
        href: string,
        hint: string | undefined,
        kind: "command" | "url" | "prompt",
        expire: string | undefined,
    ): void {
        const before = this.fmt.toSnapshot();
        this.flushRun();
        // Visual cue: underline the link text. Colour is left to whatever the
        // server set so server-coloured links keep their colour; the engine adds
        // the pointer cursor + click handler.
        this.fmt.underline = true;
        const sink = this.destName === null ? this.plain : this.destPlain;
        // The game's entities go into the command and hint now, as Mudlet's
        // SEND fills them in at the start tag (they may hold `|` separators);
        // `&text;` is not one, and waits for the text.
        const link: LinkState = {
            start: sink.length,
            href: tag === "send" ? this.interpolateEntities(href) : href,
            hint: hint !== undefined && tag === "send" ? this.interpolateEntities(hint) : hint,
            kind, tag, destName: this.destName, id: 0, expire: expire || undefined, content: "",
        };
        // Stored at the start tag, as Mudlet's are, so the newest link is this
        // one while its text is still arriving.
        link.id = this.storeLink(this.linkActions(link, ""), link.expire);
        this.stack.push({ name: tag, closeFmt: before, link });
    }

    /** The Lua each of a link's commands runs, `&text;` filled with `text`
     *  before the command is quoted, so nothing the game wrote in either can
     *  end the string it is put in (TMxpSendTagHandler::actionFor). */
    private linkActions(link: LinkState, text: string): string[] {
        const target = link.href.replace(/&text;/gi, text);
        if (link.tag === "a") return [`openUrl(${quoteLuaLiteral(target)})`];
        const command = link.kind === "prompt" ? "printCmdLine" : "send";
        const cmds = target.split("|").filter(c => c.trim().length > 0);
        return (cmds.length > 0 ? cmds : [text]).map(c => `${command}(${quoteLuaLiteral(c)})`);
    }

    /** Record a new link as the newest — TLinkStore::addLinks. */
    private storeLink(actions: string[], expire: string | undefined): number {
        const id = ++this.linkSeq;
        this.currentLink = { id, actions, expire };
        if (expire !== undefined) {
            this.expiringLinks.set(id, expire);
            if (this.expiringLinks.size > MAX_EXPIRING_LINKS) {
                this.expiringLinks.delete(this.expiringLinks.keys().next().value!);
            }
        }
        return id;
    }

    /** `<EXPIRE name>`: the links made with that name stop working, and if the
     *  newest is one of them there is no newest link left to report
     *  (TLinkStore::expireLinks removes them from the store outright). */
    private expireLinks(name: string): void {
        for (const [id, group] of this.expiringLinks) {
            if (group === name) this.expiringLinks.set(id, null);
        }
        if (this.currentLink?.expire === name) this.currentLink.actions = [];
    }

    /** Replace `&name;` with the game's entity of that name, or a built-in
     *  one; anything that names neither is left as it was (TEntityResolver's
     *  interpolate) — which is what keeps `&text;` for the close to fill. */
    private interpolateEntities(s: string): string {
        if (!s.includes("&")) return s;
        return s.replace(/&([^;&]*);/g, (m, name: string) => {
            if (name.toLowerCase() === "text") return m;
            return this.decodeEntity(name) ?? m;
        });
    }

    private openVar(varName: string): void {
        this.stack.push({ name: "v", closeFmt: this.fmt.toSnapshot(), varName, varStart: this.plain.length });
    }

    private handleCloseTag(name: string): void {
        // </DEST> isn't a formatting tag on the stack — it ends text redirection.
        // eol attr controls whether the frame write is a complete line.
        if (name === "dest") {
            if (this.destName !== null) this.closeDest(this.destEol);
            return;
        }
        for (let k = this.stack.length - 1; k >= 0; k--) {
            if (this.stack[k].name === name) {
                this.flushRun();
                // Lenient nesting: finalize this tag and any unclosed tags above it.
                for (let m = this.stack.length - 1; m >= k; m--) this.finalizeTag(this.stack[m]);
                const restore = this.stack[k].closeFmt;
                this.stack.length = k;
                this.fmt = new FormatState(restore);
                return;
            }
        }
        // A custom element with nothing open to close — an EMPTY one, which
        // never leaves a marker: close what its definition opens, innermost
        // first, as Mudlet's handleEndTag does for any element with a
        // definition (`<!ELEMENT rd '<COLOR red><B>' EMPTY>` makes `</rd>` a
        // `</B></COLOR>`) — only its opening tags, as a closing tag in a
        // definition is ignored, and not for an element already being closed
        // or past the expansion cap (mayExpand). Anything else is a stray
        // close, and is ignored.
        const def = this.elements.get(name);
        if (!def || !this.mayExpand(name)) return;
        const opened = [...def.template.matchAll(/<\s*([A-Za-z][\w-]*)/g)].map(m => m[1].toLowerCase());
        this.expanding.add(name);
        try {
            for (let k = opened.length - 1; k >= 0; k--) this.handleCloseTag(opened[k]);
        } finally {
            this.expanding.delete(name);
        }
    }

    /** TMxpCustomElementTagHandler::mayExpand: a game can define an element
     *  that expands to itself, directly or through other elements, or a chain
     *  of elements long enough to exhaust the stack. An element already being
     *  expanded, or one past {@link MAX_ELEMENT_EXPANSION_DEPTH} of them, is
     *  handled without running its definition. */
    private mayExpand(name: string): boolean {
        return this.expanding.size < MAX_ELEMENT_EXPANSION_DEPTH && !this.expanding.has(name);
    }

    private finalizeTag(tag: OpenTag): void {
        if (tag.colorOverride && this.mxpColorStack.length > 0) this.mxpColorStack.pop();
        if (tag.link) {
            const link = tag.link;
            // Resolve against the sink the link's text actually went into, and
            // collect it there: a <SEND> inside a <DEST> belongs to that frame's
            // redirect, not to the main line.
            const intoDest = link.destName !== null && link.destName === this.destName;
            const sink = intoDest ? this.destPlain : this.plain;
            const collect = intoDest ? this.destLinks : this.links;
            const end = sink.length;
            const text = sink.slice(link.start, end);
            // `&text;` is the text the tag wrapped as the game sent it, not as
            // it is shown: markup inside it that was put back as text is not
            // part of it.
            const payload = link.href.replace(/&text;/gi, link.content);
            const actions = this.linkActions(link, link.content);
            if (this.currentLink?.id === link.id && this.isLinkLive(link.id)) this.currentLink.actions = actions;
            // An <A> keeps its "url" kind whatever its address: Mudlet's action
            // for one is always openUrl(…), so nothing in it reaches the game.
            const kind = link.kind;
            if (payload && end > link.start) {
                // Split, but not trimmed: a trailing space is part of the command a
                // game means to be completed (<SEND "tell Zugg " PROMPT>), and Mudlet
                // keeps it. Only a segment that is nothing but space is dropped.
                const cmds = payload.split("|").filter(c => c.trim().length > 0);
                const hintParts = link.hint !== undefined ? link.hint.replace(/&text;/gi, link.content).split("|") : [];
                if (cmds.length > 1) {
                    collect.push({
                        start: link.start, end,
                        kind,
                        payload: cmds[0],
                        hint: hintParts[0] ?? text,
                        prompts: { cmds, hints: hintParts.slice(1) },
                        id: link.id,
                    });
                } else {
                    collect.push({
                        start: link.start, end,
                        kind,
                        payload: cmds[0] ?? text,
                        hint: hintParts[0] ?? link.hint,
                        id: link.id,
                    });
                }
            }
            if (link.tag === "send") this.reportSend(link, link.content.trim(), payload, actions);
        }
        if (tag.varName !== undefined && tag.varName !== "") {
            this.entities.set(tag.varName.toLowerCase(), this.plain.slice(tag.varStart ?? this.plain.length, this.plain.length));
        }
    }

    // ---- definitions ----

    /** A `<!…>` definition. False when it is not one Mudlet can act on — an
     *  element with nothing after its name, an entity with no name — which is
     *  then shown as the text it is. */
    private handleDefinition(raw: string): boolean {
        const body = raw.slice(1); // drop leading '!'
        const km = /^\s*([A-Za-z]+)/.exec(body);
        if (!km) return true;
        const keyword = km[1].toUpperCase();
        const rest = body.slice(km[0].length);
        if (keyword === "ELEMENT" || keyword === "EL") return this.defineElement(rest);
        if (keyword === "ENTITY" || keyword === "EN") return this.defineEntity(rest);
        // ATTLIST and others are accepted but ignored.
        return true;
    }

    private defineElement(rest: string): boolean {
        const toks = tokenizeAttrs(rest);
        // A name and nothing to define it with (TMxpElementDefinitionHandler).
        if (toks.length < 2) return false;
        const name = toks[0].value.toLowerCase();
        if (!name) return false;
        let template = "";
        let templateSeen = false;
        const atts: string[] = [];
        const attDefaults: Record<string, string> = {};
        let flag: string | undefined;
        let open = false, empty = false, del = false;
        for (let k = 1; k < toks.length; k++) {
            const t = toks[k];
            if (t.key !== undefined) {
                const key = t.key.toLowerCase();
                if (key === "att") {
                    for (const a of t.value.split(/\s+/).filter(Boolean)) {
                        const eq = a.indexOf("=");
                        if (eq >= 0) {
                            const an = a.slice(0, eq).toLowerCase();
                            atts.push(an);
                            attDefaults[an] = a.slice(eq + 1);
                        } else {
                            atts.push(a.toLowerCase());
                        }
                    }
                } else if (key === "flag") {
                    flag = t.value;
                }
                // tag=, etc. ignored
            } else {
                const up = t.value.toUpperCase();
                if (up === "OPEN") open = true;
                else if (up === "EMPTY") empty = true;
                else if (up === "DELETE") del = true;
                else if (!templateSeen) { template = t.value; templateSeen = true; }
            }
        }
        if (del) { this.elements.delete(name); return true; }
        this.elements.set(name, { name, template, atts, attDefaults, flag, open, empty });
        return true;
    }

    private defineEntity(rest: string): boolean {
        const toks = tokenizeAttrs(rest);
        if (toks.length === 0) return false;
        const name = toks[0].value;
        if (!name) return false;
        let del = false;
        let value = "";
        let valueSeen = false;
        for (let k = 1; k < toks.length; k++) {
            const t = toks[k];
            if (t.key !== undefined) continue;
            const up = t.value.toUpperCase();
            if (up === "DELETE") del = true;
            else if (up === "PRIVATE" || up === "PUBLISH" || up === "ADD" || up === "REMOVE") continue;
            else if (!valueSeen) { value = t.value; valueSeen = true; }
        }
        if (del) { this.entities.delete(name.toLowerCase()); return true; }
        this.entities.set(name.toLowerCase(), value);
        return true;
    }

    private expandElement(def: ElementDef, named: Map<string, string>, positional: string[], depth: number): void {
        // One that may not expand (mayExpand) is still handled — its event
        // below is reported — but its definition does not run, and it leaves
        // no marker: on desktop its `</name>` is handled as doing nothing, and
        // a marker would have that close revert the definition of the element
        // around it that it is the self-reference of.
        if (this.mayExpand(def.name)) {
            const before = this.fmt.toSnapshot();
            this.flushRun();
            // Push the close marker *below* the tags the template will open, so
            // `</name>` reverts everything the definition introduced. An EMPTY
            // element is not closed, so it gets none — see handleCloseTag for a
            // game that closes one anyway.
            if (!def.empty) this.stack.push({ name: def.name, closeFmt: before });
            this.expanding.add(def.name);
            try {
                this.runTemplate(def.template, this.elementValues(def, named, positional), depth + 1);
            } finally {
                this.expanding.delete(def.name);
            }
        }
        // Reported once the definition has run, as Mudlet reports it after
        // handling the tag: `actions` is the newest link's, which may be the
        // one the definition just made.
        this.opts.onElementEvent?.(def.name, elementEventAttrs(def, named, positional), {
            text: "", actions: this.currentLink ? [...this.currentLink.actions] : [],
        });
    }

    /** `&att;` → the value the tag gave that attribute, by name or by the
     *  position the definition declared it at, else its default; anything else
     *  is left alone for the entity pass (TMxpCustomElementTagHandler's
     *  mapAttributes). */
    private elementValues(def: ElementDef, named: Map<string, string>, positional: string[]): (s: string) => string {
        const vals: Record<string, string> = { ...def.attDefaults };
        def.atts.forEach((an, idx) => { if (positional[idx] !== undefined) vals[an] = positional[idx]; });
        for (const [k, v] of named) vals[k.toLowerCase()] = v;
        return (s: string) => s.includes("&")
            ? s.replace(/&([^;&]*);/g, (m, an: string) => {
                const key = an.toLowerCase();
                return Object.prototype.hasOwnProperty.call(vals, key) ? vals[key] : m;
            })
            : s;
    }

    /** Run a definition's markup. Its tags are read first and filled in after,
     *  attribute by attribute, so a value cannot rewrite the tag it lands in:
     *  a quote in it stays in the value. The text between them is filled in
     *  and read as the game's own. Per the MXP spec a definition holds only
     *  opening tags, so a closing tag in one is skipped, as
     *  TMxpCustomElementTagHandler::handleStartTag skips it — `'<B>x</B>'`
     *  leaves its element bold until the element itself is closed. */
    private runTemplate(template: string, fill: (s: string) => string, depth: number): void {
        let textStart = 0;
        let i = 0;
        while (i < template.length) {
            if (template[i] === "<" && /[a-zA-Z!/]/.test(template[i + 1] ?? "")) {
                const close = findTagEnd(template, i);
                if (close === -1) break;
                if (i > textStart) this.parseFragment(fill(template.slice(textStart, i)), depth);
                const tag = template.slice(i + 1, close);
                if (!tag.trimStart().startsWith("/")) this.handleTag(tag, depth, fill);
                i = close + 1;
                textStart = i;
                continue;
            }
            i++;
        }
        if (textStart < template.length) this.parseFragment(fill(template.slice(textStart)), depth);
    }

    // ---- entities ----

    /** What `&ent;` stands for, or null when it names nothing. A game's
     *  entities are kept under their lowercased names, as Mudlet's
     *  registerEntity keeps them. */
    private decodeEntity(ent: string): string | null {
        if (ent.length === 0) return null;
        if (ent[0] === "#") {
            const num = ent[1] === "x" || ent[1] === "X"
                ? parseInt(ent.slice(2), 16)
                : parseInt(ent.slice(1), 10);
            if (Number.isFinite(num) && num >= 0 && num <= 0x10ffff) {
                try { return String.fromCodePoint(num); } catch { return null; }
            }
            return null;
        }
        // TEntityResolver::getResolution: the game's own first, by any case,
        // so a game can redefine `&lt;` or `&amp;`; then the built-in name as
        // written, then lowercased.
        const lc = ent.toLowerCase();
        return this.entities.get(lc) ?? BUILTIN_ENTITIES.get(ent) ?? BUILTIN_ENTITIES.get(lc) ?? null;
    }
}

/** Split a parsed MXP line into one entry per *visual* line. MXP `<BR>` tags
 *  become embedded `\n`s in the parser's plain text and segments — Discworld
 *  sends a whole room (description, exits, contents, prompt) as a single network
 *  line delimited by `<BR>` — but a render path that emits one line per result
 *  would collapse them all together. So we split the segments at every `\n`,
 *  re-slicing each segment's text and remapping each link's `plain`-offset range
 *  into the subline it falls on. The `\n` separators are dropped (each subline
 *  renders on its own). The fast path (no embedded newline) returns the result
 *  untouched, sharing the original arrays. */
export function splitMxpResultLines(
    r: MxpLineResult,
): { plain: string; segments: BufferSegment[]; links: MxpLink[] }[] {
    if (r.plain.indexOf("\n") === -1) {
        return [{ plain: r.plain, segments: r.segments, links: r.links }];
    }

    const out: { plain: string; segments: BufferSegment[]; links: MxpLink[] }[] = [];
    // Plain-text range [start, end) each subline occupies in the full r.plain,
    // used to remap link offsets afterwards.
    const ranges: { start: number; end: number }[] = [];
    let segs: BufferSegment[] = [];
    let plain = "";
    let base = 0;

    const closeLine = () => {
        ranges.push({ start: base, end: base + plain.length });
        out.push({ plain, segments: segs, links: [] });
        base += plain.length + 1; // +1 for the dropped '\n' separator
        segs = [];
        plain = "";
    };

    for (const seg of r.segments) {
        const pieces = seg.text.split("\n");
        for (let p = 0; p < pieces.length; p++) {
            if (p > 0) closeLine();
            if (pieces[p].length > 0) {
                segs.push({ text: pieces[p], state: seg.state });
                plain += pieces[p];
            }
        }
    }
    closeLine();

    for (const link of r.links) {
        for (let k = 0; k < ranges.length; k++) {
            const { start, end } = ranges[k];
            if (link.start >= start && link.start < end) {
                const remStart = link.start - start;
                const remEnd = Math.min(link.end, end) - start;
                if (remEnd > remStart) out[k].links.push({ ...link, start: remStart, end: remEnd });
                break;
            }
        }
    }
    return out;
}

// ---- module-local helpers ----

/** Find the `>` that closes the tag starting at `start` (the `<`), skipping any
 *  `>` that sits inside a quoted attribute value. Returns -1 if unterminated.
 *  Essential for definitions like `<!ELEMENT x "<COLOR red>" …>` whose template
 *  contains a literal `>`. */
function findTagEnd(text: string, start: number): number {
    let quote = "";
    for (let j = start + 1; j < text.length; j++) {
        const c = text[j];
        if (quote) {
            if (c === quote) quote = "";
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if (c === ">") {
            return j;
        }
    }
    return -1;
}

/** Read the tag starting at `start` (the `<`) up to whichever comes first
 *  outside a quoted value: the `>` that closes it (`close`), or another `<`
 *  that shows it never was a tag (`restart`). The other is -1, and both are
 *  when the line ends first. A comment (`<!--`) takes `<` as text, as Mudlet's
 *  tag builder does. */
function scanTag(text: string, start: number): { close: number; restart: number } {
    if (text.startsWith("<!--", start)) return { close: findTagEnd(text, start), restart: -1 };
    let quote = "";
    for (let j = start + 1; j < text.length; j++) {
        const c = text[j];
        if (quote) {
            if (c === quote) quote = "";
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if (c === ">") {
            return { close: j, restart: -1 };
        } else if (c === "<") {
            return { close: -1, restart: j };
        }
    }
    return { close: -1, restart: -1 };
}

function firstWhitespace(s: string): number {
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === " " || c === "\t" || c === "\n" || c === "\r") return i;
    }
    return -1;
}

interface AttrToken { key?: string; value: string; }

/** Read a `"…"` / `'…'` run starting at the opening quote `at`. Returns the
 *  inner text and the index just past the closing quote (or end of string). */
function readQuoted(s: string, at: number): { value: string; next: number } {
    const q = s[at];
    let j = at + 1;
    const vstart = j;
    while (j < s.length && s[j] !== q) j++;
    const value = s.slice(vstart, j);
    return { value, next: j < s.length ? j + 1 : j };
}

/** Tokenize a tag's attribute string into ordered `{key?, value}` tokens.
 *  Handles `key=value`, `key="quoted"`, `key='quoted'`, bare `value`, and
 *  quoted positional `"value"`. No escape processing inside quotes (MXP has none). */
function tokenizeAttrs(s: string): AttrToken[] {
    const out: AttrToken[] = [];
    let i = 0;
    const n = s.length;
    while (i < n) {
        while (i < n && isSpace(s[i])) i++;
        if (i >= n) break;

        if (s[i] === '"' || s[i] === "'") {
            const { value, next } = readQuoted(s, i);
            out.push({ value });
            i = next;
            continue;
        }

        const start = i;
        while (i < n && !isSpace(s[i]) && s[i] !== "=" && s[i] !== '"' && s[i] !== "'") i++;
        const word = s.slice(start, i);

        if (i < n && s[i] === "=") {
            i++; // skip '='
            let value: string;
            if (i < n && (s[i] === '"' || s[i] === "'")) {
                const q = readQuoted(s, i);
                value = q.value;
                i = q.next;
            } else {
                const vstart = i;
                while (i < n && !isSpace(s[i])) i++;
                value = s.slice(vstart, i);
            }
            out.push({ key: word, value });
        } else {
            out.push({ value: word });
        }
    }
    return out;
}

function isSpace(c: string): boolean {
    return c === " " || c === "\t" || c === "\n" || c === "\r";
}

/**
 * The attribute map a custom-element use publishes to scripts, mirroring
 * Mudlet's TMxpMudlet::enqueueMxpEvent:
 *  - every attribute the tag actually carried, under its own name — for a
 *    positional token that IS the token text, which is why a tag written as
 *    `RItem "Sword"` shows up as `mxp.ritem.sword`;
 *  - each attribute name the element DECLARED via `ATT=`, resolved positionally,
 *    so declaring `ATT="Name"` makes the first positional token reachable as
 *    `mxp.rmob.name` with the value's case intact, falling back to the declared
 *    default.
 * Keys are lowercased where they land in Lua, not here.
 */
function elementEventAttrs(
    def: ElementDef,
    named: Map<string, string>,
    positional: string[],
): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const token of positional) attrs[token] = '';
    for (const [k, v] of named) attrs[k] = v;
    def.atts.forEach((attrName, idx) => {
        const lower = attrName.toLowerCase();
        if (named.has(lower)) attrs[attrName] = named.get(lower)!;
        else if (positional[idx] !== undefined) attrs[attrName] = positional[idx];
        else if (lower in def.attDefaults) attrs[attrName] = def.attDefaults[lower];
    });
    return attrs;
}

/** Split a tag's attribute string into named and positional values, each
 *  value passed through `mapValue` once it has been read. `firstIsPositional`
 *  says whether the first attribute written was a bare word. */
function parseAttrs(
    attrStr: string,
    mapValue?: (value: string) => string,
): { named: Map<string, string>; positional: string[]; firstIsPositional: boolean } {
    const named = new Map<string, string>();
    const positional: string[] = [];
    const tokens = tokenizeAttrs(attrStr);
    for (const t of tokens) {
        const value = mapValue ? mapValue(t.value) : t.value;
        if (t.key !== undefined) named.set(t.key.toLowerCase(), value);
        else positional.push(value);
    }
    return { named, positional, firstIsPositional: tokens.length > 0 && tokens[0].key === undefined };
}
