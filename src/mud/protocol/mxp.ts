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

import { FormatState, applyOscPaletteOps } from "../text/FormatState";
import type { BufferSegment, FormatColor, FormatStateSnapshot, FormatHyperlink } from "../text/FormatState";
import { mxpColor } from "../text/colorParsers";
import { scanEscape, parseOsc8Payload, classifyHyperlinkUri, parseOscColorPalette } from "../text/ansiEscapes";
import { parseOsc8Uri, HyperlinkPresetRegistry } from "../text/hyperlinkConfig";
import type { MspCommand, MspKind } from "./msp";
import { CLIENT_NAME, CLIENT_VERSION } from "../../version";

/** A clickable region the parser found, expressed as offsets into `plain`. The
 *  engine builds the actual `FormatHyperlink` (with session/URL behaviour). */
export interface MxpLink {
    /** Start offset into the line's plain text (inclusive). */
    start: number;
    /** End offset into the line's plain text (exclusive). */
    end: number;
    /** `url` → open in a browser tab; `command` → send to the MUD. */
    kind: "command" | "url";
    /** The single command or URL fired on left-click. */
    payload: string;
    /** Tooltip / title text. */
    hint?: string;
    /** Present when the SEND carried a `cmd1|cmd2|…` list — the engine renders a
     *  right-click popup of `cmds` labelled by `hints`. */
    prompts?: { cmds: string[]; hints: string[] };
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
    link?: { start: number; href?: string; hint?: string; isUrl: boolean; destName: string | null };
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
    "br", "sbr", "nobr", "p", "hr", "version", "support",
]);

/** Reported back to the server in response to `<SUPPORT>`. `+tag` = implemented,
 *  `-tag` = explicitly unsupported. Kept in sync with the dispatch in
 *  {@link MxpParser.handleOpenTag}. */
const SUPPORTED_TAGS = [
    "+b", "+i", "+u", "+s", "+h", "+high", "+strikeout", "+color", "+c", "+font",
    "+send", "+a", "+br", "+sbr", "+nobr", "+p", "+hr", "+var", "+version", "+support",
    "+frame", "+dest", "+sound", "+music",
    "-image", "-relocate", "-filter", "-gauge", "-stat",
];

/** Built-in XML/HTML entities. User and `<V>`-defined entities augment these via
 *  the per-session `entities` map. */
const BUILTIN_ENTITIES: Record<string, string> = {
    lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " ",
};

/** Cap on a held partial tag/entity. Beyond this it was never real markup, so it
 *  is flushed as literal text rather than swallowing the rest of the stream. */
const MAX_PENDING = 256;
/** An `&` plus characters an entity name may still be made of — Mudlet's
 *  `isalnum(c) || c == '#' || '.' || '-' || '_' || '&'` (`;` would have ended
 *  it). ASCII only, deliberately: Mudlet tests raw bytes, so the first byte of a
 *  non-ASCII character ends a name there too. */
const ENTITY_NAME_TAIL = /^&[0-9A-Za-z#.\-_&]+$/;
/** Recursion guard for custom-element template expansion. */
const MAX_DEPTH = 8;

export class MxpParser {
    private readonly opts: {
        send: (raw: string) => void;
        onElementEvent?: (name: string, attrs: Record<string, string>) => void;
    };

    // --- persistent across the whole session ---
    private elements = new Map<string, ElementDef>();
    private entities = new Map<string, string>();
    private lineMode: MxpMode = "open";
    private lockedMode: MxpMode | null = null;
    private tempSecure = false;
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
    /** Active `<DEST>` target frame (persists across lines until `</DEST>`), or
     *  null when output flows to the main window. While set, appended text and
     *  flushed runs route to `destOut`/`destPlain` instead of `out`/`plain`. */
    private destName: string | null = null;
    private destEol = false;
    private destEof = false;
    /** OSC 8 preset definitions seen this session (shared with the ANSI path
     *  when the engine supplies a registry). */
    private presets: HyperlinkPresetRegistry;

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
         *  {@link elementEventAttrs}). Backs the Lua `mxp` table. */
        onElementEvent?: (name: string, attrs: Record<string, string>) => void;
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
        this.lockedMode = locked ? "secure" : null;
        this.lineMode = this.lockedMode ?? "open";
    }

    /** Clear all cross-line state. Called on (re)connect so a new session starts
     *  with no leftover definitions, open tags, or modes. */
    reset(): void {
        this.elements.clear();
        this.entities.clear();
        this.lineMode = "open";
        this.lockedMode = null;
        this.tempSecure = false;
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
     *  carried pen from the previous line. */
    parseLine(rawLine: string, baseSnapshot?: FormatStateSnapshot): MxpLineResult {
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
        // A held partial tag means we're logically mid-line, so the transient
        // line mode (and temp-secure) must survive into the continuation.
        if (this.pendingTag === "") this.resetTransientMode();

        const trailing = this.fmt.toSnapshot();
        const result: MxpLineResult = { segments: this.out, plain: this.plain, trailingSnapshot: trailing, links: this.links };
        if (this.frames.length > 0) result.frames = this.frames;
        if (this.redirects.length > 0) result.redirects = this.redirects;
        if (this.sounds.length > 0) result.sounds = this.sounds;
        return result;
    }

    private effectiveMode(): MxpMode {
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
        // Transient OPEN/SECURE/LOCKED (modes 0/1/2) last only for the current
        // line; at the newline we revert to the locked mode, or OPEN by default.
        this.lineMode = this.lockedMode ?? "open";
        this.tempSecure = false;
    }

    // ---- text emission ----

    private appendText(s: string): void {
        if (s.length === 0) return;
        this.run += s;
        // While a <DEST> is open, plain text accrues to the redirect buffer, not
        // the main line (so it never reaches the main window or its triggers).
        if (this.destName === null) this.plain += s;
        else this.destPlain += s;
    }

    private flushRun(): void {
        if (this.run.length === 0) return;
        const state = this.fmt.toSnapshot();
        // An open MXP <COLOR>/<FONT> colour wins over the ANSI pen (Mudlet
        // semantics): the ANSI fg/bg still tracks in `fmt` so it resumes once
        // the colour tag closes, but it isn't what gets painted meanwhile.
        const override = this.mxpColorStack[this.mxpColorStack.length - 1];
        if (override) {
            if (override.fg) state.foreground = override.fg;
            if (override.bg) state.background = override.bg;
        }
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
                    this.flushRun();
                    this.fmt.applySgr(parseSgrParams(esc.params ?? ""));
                } else if (esc.kind === "csi" && esc.finalByte === "z") {
                    this.flushRun();
                    this.applyLineMode(parseInt(esc.params ?? "", 10) || 0);
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
                        // OSC 4/104 colour palette redefinition (no text/state
                        // change — retargets colour tables for following runs).
                        const palette = parseOscColorPalette(esc.oscPayload);
                        if (palette) applyOscPaletteOps(palette);
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
                const close = findTagEnd(text, i);
                if (close === -1) {
                    // Unterminated tag at end of input — hold it for the next line.
                    if (depth === 0 && n - i <= MAX_PENDING) {
                        this.pendingTag = text.slice(i);
                        return;
                    }
                    this.appendText("<");
                    i++;
                    continue;
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
                const semi = text.indexOf(";", i + 1);
                if (semi !== -1 && semi - i <= 33) {
                    const decoded = this.decodeEntity(text.slice(i + 1, semi));
                    if (decoded !== null) {
                        this.appendText(decoded);
                        i = semi + 1;
                        continue;
                    }
                } else if (semi === -1 && depth === 0) {
                    // Hold the tail for the next line ONLY while it could still
                    // become an entity — every character after the `&` one an
                    // entity name may contain. Mudlet ends a name at the first
                    // that is not (`TEntityHandler::handle`), and it tests bytes,
                    // so a space or the first byte of a non-ASCII character both
                    // end it: `Käse&Brötchen and &Ф too` is a line of text with
                    // two stray ampersands in it, not an entity spanning into
                    // the next line. Holding it swallowed the rest of the line
                    // and glued it to the line after (Mudlet/Mudlet#9439).
                    const rest = text.slice(i);
                    if (rest.length > 1 && rest.length <= 33 && ENTITY_NAME_TAIL.test(rest)) {
                        this.pendingTag = rest;
                        return;
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
        switch (n) {
            case 0: this.lineMode = "open"; break;
            case 1: this.lineMode = "secure"; break;
            case 2: this.lineMode = "locked"; break;
            case 3: // reset — close everything, back to defaults
                this.closeAllTags();
                this.fmt.reset();
                this.lineMode = "open";
                this.lockedMode = null;
                this.tempSecure = false;
                break;
            case 4: this.tempSecure = true; break;
            case 5: this.lockedMode = "open"; this.lineMode = "open"; break;
            case 6: this.lockedMode = "secure"; this.lineMode = "secure"; break;
            case 7: this.lockedMode = "locked"; this.lineMode = "locked"; break;
        }
    }

    private closeAllTags(): void {
        this.flushRun();
        for (let k = this.stack.length - 1; k >= 0; k--) this.finalizeTag(this.stack[k]);
        this.stack.length = 0;
    }

    // ---- tags ----

    private handleTag(raw: string, depth: number): void {
        const trimmed = raw.trim();
        if (trimmed === "") return;

        // Temp-secure (mode 4) makes exactly the next tag secure.
        const secure = this.tempSecure || this.effectiveMode() === "secure";
        this.tempSecure = false;

        if (trimmed.startsWith("!")) {
            if (secure) this.handleDefinition(trimmed);
            return;
        }
        if (trimmed.startsWith("/")) {
            const name = trimmed.slice(1).trim().split(/[\s>]/)[0].toLowerCase();
            this.handleCloseTag(name);
            return;
        }

        const sp = firstWhitespace(trimmed);
        const name = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
        const attrStr = sp === -1 ? "" : trimmed.slice(sp + 1);

        if (!secure && !this.openAllowed(name)) return; // discard secure-only tag in open mode
        this.handleOpenTag(name, attrStr, depth);
    }

    private openAllowed(name: string): boolean {
        if (OPEN_MODE_TAGS.has(name)) return true;
        const def = this.elements.get(name);
        return def ? def.open : false;
    }

    private handleOpenTag(name: string, attrStr: string, depth: number): void {
        const def = this.elements.get(name);
        if (def) {
            this.expandElement(def, attrStr, depth);
            return;
        }

        const { named, positional } = parseAttrs(attrStr);
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
                this.openColor(name, named.get("color") ?? named.get("fore"), named.get("back") ?? named.get("bgcolor")); break;
            case "send":
                this.openLink("send", named.get("href") ?? named.get("hr") ?? positional[0],
                    named.get("hint") ?? named.get("title"), false); break;
            case "a": {
                const href = named.get("href") ?? positional[0];
                const isUrl = !!href && /^(https?|mailto):/i.test(href);
                this.openLink("a", href, named.get("hint") ?? named.get("title"), isUrl);
                break;
            }
            case "v": case "var":
                this.openVar(named.get("name") ?? positional[0] ?? ""); break;
            case "br":
                this.appendText("\n"); break;
            case "sbr":
                this.appendText(" "); break;
            case "frame":
                this.handleFrameTag(named, positional); break;
            case "dest":
                this.handleDestTag(named, positional); break;
            case "sound":
                this.handleSoundTag("sound", named, positional); break;
            case "music":
                this.handleSoundTag("music", named, positional); break;
            case "support":
                this.opts.send(`${MXP_SECURE_REPLY_PREFIX}<SUPPORTS ${SUPPORTED_TAGS.join(" ")}>`); break;
            case "version":
                // MXP="1.0" is the *protocol* version we speak; CLIENT/VERSION
                // are our own identity (see src/version.ts).
                this.opts.send(`${MXP_SECURE_REPLY_PREFIX}<VERSION MXP="1.0" CLIENT="${CLIENT_NAME}" VERSION="${CLIENT_VERSION}">`); break;
            default:
                // Structural no-ops (p, nobr, hr) and discarded heavy tags (image,
                // gauge, relocate, …): consume the tag, render nothing for it.
                // Any enclosed text still renders since the close handler ignores
                // unmatched closing tags.
                break;
        }
    }

    /** `<FRAME name [action] [internal|external|floating] [left|top|width|height]
     *  [scrolling] [title]>` — record a window create/close request for the
     *  consumer. NAME is the first positional or the NAME attribute; valueless
     *  flags (INTERNAL/EXTERNAL/FLOATING) become `"true"`. */
    private handleFrameTag(named: Map<string, string>, positional: string[]): void {
        let name = named.get("name");
        let flagStart = 0;
        if (!name) { name = positional[0]; flagStart = 1; }
        name = (name ?? "").trim();
        if (name === "") return; // a nameless FRAME is ignored (matches Mudlet)
        this.flushRun(); // commit any preceding main text before the command
        const attrs: Record<string, string> = {};
        for (const [k, v] of named) if (k !== "name") attrs[k.toUpperCase()] = v;
        for (let i = flagStart; i < positional.length; i++) attrs[positional[i].toUpperCase()] = "true";
        attrs.NAME = name;
        const cmd: MxpFrameCommand = { name, attrs };
        if (this.destName !== null) cmd.dest = this.destName;
        this.frames.push(cmd);
    }

    /** `<DEST name [eol] [eof]>` — start redirecting enclosed text into `name`.
     *  NAME is the NAME attribute or the first non-flag positional. Persists
     *  until `</DEST>` (or end of line). A nameless DEST is ignored so its text
     *  renders inline, matching Mudlet (setMxpDestination fails → not handled). */
    private handleDestTag(named: Map<string, string>, positional: string[]): void {
        const flags = new Set(positional.map(p => p.toLowerCase()));
        let name = named.get("name");
        if (!name) name = positional.find(p => { const l = p.toLowerCase(); return l !== "eol" && l !== "eof"; });
        name = (name ?? "").trim();
        if (name === "") return;
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

    private openLink(name: string, href: string | undefined, hint: string | undefined, isUrl: boolean): void {
        const before = this.fmt.toSnapshot();
        this.flushRun();
        // Visual cue: underline the link text. Colour is left to whatever the
        // server set so server-coloured links keep their colour; the engine adds
        // the pointer cursor + click handler.
        this.fmt.underline = true;
        const sink = this.destName === null ? this.plain : this.destPlain;
        this.stack.push({ name, closeFmt: before, link: { start: sink.length, href, hint, isUrl, destName: this.destName } });
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
        // Stray closing tag with no matching open — ignore.
    }

    private finalizeTag(tag: OpenTag): void {
        if (tag.colorOverride && this.mxpColorStack.length > 0) this.mxpColorStack.pop();
        if (tag.link) {
            // Resolve against the sink the link's text actually went into, and
            // collect it there: a <SEND> inside a <DEST> belongs to that frame's
            // redirect, not to the main line.
            const intoDest = tag.link.destName !== null && tag.link.destName === this.destName;
            const sink = intoDest ? this.destPlain : this.plain;
            const collect = intoDest ? this.destLinks : this.links;
            const end = sink.length;
            const text = sink.slice(tag.link.start, end);
            let payload = tag.link.href;
            if (payload === undefined || payload === "") payload = text;
            else payload = payload.replace(/&text;/gi, text);
            if (payload && end > tag.link.start) {
                const cmds = payload.split("|").map(c => c.trim()).filter(c => c.length > 0);
                const hintParts = tag.link.hint !== undefined ? tag.link.hint.split("|") : [];
                if (cmds.length > 1) {
                    collect.push({
                        start: tag.link.start, end,
                        kind: tag.link.isUrl ? "url" : "command",
                        payload: cmds[0],
                        hint: hintParts[0] ?? text,
                        prompts: { cmds, hints: hintParts.slice(1) },
                    });
                } else {
                    collect.push({
                        start: tag.link.start, end,
                        kind: tag.link.isUrl ? "url" : "command",
                        payload: cmds[0] ?? text,
                        hint: hintParts[0] ?? tag.link.hint,
                    });
                }
            }
        }
        if (tag.varName !== undefined && tag.varName !== "") {
            this.entities.set(tag.varName, this.plain.slice(tag.varStart ?? this.plain.length, this.plain.length));
        }
    }

    // ---- definitions ----

    private handleDefinition(raw: string): void {
        const body = raw.slice(1); // drop leading '!'
        const km = /^\s*([A-Za-z]+)/.exec(body);
        if (!km) return;
        const keyword = km[1].toUpperCase();
        const rest = body.slice(km[0].length);
        if (keyword === "ELEMENT" || keyword === "EL") this.defineElement(rest);
        else if (keyword === "ENTITY" || keyword === "EN") this.defineEntity(rest);
        // ATTLIST and others are accepted but ignored.
    }

    private defineElement(rest: string): void {
        const toks = tokenizeAttrs(rest);
        if (toks.length === 0) return;
        const name = toks[0].value.toLowerCase();
        if (!name) return;
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
        if (del) { this.elements.delete(name); return; }
        this.elements.set(name, { name, template, atts, attDefaults, flag, open, empty });
    }

    private defineEntity(rest: string): void {
        const toks = tokenizeAttrs(rest);
        if (toks.length === 0) return;
        const name = toks[0].value;
        if (!name) return;
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
        if (del) { this.entities.delete(name); return; }
        this.entities.set(name, value);
    }

    private expandElement(def: ElementDef, attrStr: string, depth: number): void {
        if (depth >= MAX_DEPTH) return;
        const { named, positional } = parseAttrs(attrStr);
        this.opts.onElementEvent?.(def.name, elementEventAttrs(def, named, positional));
        const before = this.fmt.toSnapshot();
        this.flushRun();
        // Push the close marker *below* the tags the template will open, so
        // `</name>` reverts everything the definition introduced.
        if (!def.empty) this.stack.push({ name: def.name, closeFmt: before });
        this.parseFragment(this.substituteTemplate(def, named, positional), depth + 1);
    }

    private substituteTemplate(def: ElementDef, named: Map<string, string>, positional: string[]): string {
        const vals: Record<string, string> = { ...def.attDefaults };
        def.atts.forEach((an, idx) => { if (positional[idx] !== undefined) vals[an] = positional[idx]; });
        for (const [k, v] of named) vals[k.toLowerCase()] = v;
        return def.template.replace(/&(\w+);/g, (m, an: string) => {
            const key = an.toLowerCase();
            return key in vals ? vals[key] : m; // leave real entities (e.g. &lt;) intact
        });
    }

    // ---- entities ----

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
        const lc = ent.toLowerCase();
        if (lc in BUILTIN_ENTITIES) return BUILTIN_ENTITIES[lc];
        if (this.entities.has(ent)) return this.entities.get(ent)!;
        if (this.entities.has(lc)) return this.entities.get(lc)!;
        return null;
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

function parseSgrParams(s: string): number[] {
    if (s === "") return [0];
    return s.split(";").map(p => {
        const n = parseInt(p, 10);
        return Number.isFinite(n) ? n : 0;
    });
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

/** Split a tag's attribute string into named and positional values. */
function parseAttrs(attrStr: string): { named: Map<string, string>; positional: string[] } {
    const named = new Map<string, string>();
    const positional: string[] = [];
    for (const t of tokenizeAttrs(attrStr)) {
        if (t.key !== undefined) named.set(t.key.toLowerCase(), t.value);
        else positional.push(t.value);
    }
    return { named, positional };
}
