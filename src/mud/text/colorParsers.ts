import mudletColors from './mudletColors.json';
import type { FormatColor, FormatStateSnapshot, RgbColor } from './FormatState';

const MUDLET_COLORS = mudletColors as unknown as Record<string, [number, number, number]>;

/** The CSS/HTML named-color table MXP servers draw on (`<COLOR fore=Red>`,
 *  `<FONT color=DodgerBlue>`). Mudlet's palette covers many of these but spells
 *  some differently and omits others, so MXP color resolution checks this map
 *  first (HTML semantics), then falls back to the Mudlet palette. Stored as
 *  packed `0xRRGGBB`; keys are lowercased at lookup. */
const HTML_COLORS: Record<string, number> = {
    black: 0x000000, silver: 0xc0c0c0, gray: 0x808080, grey: 0x808080,
    white: 0xffffff, maroon: 0x800000, red: 0xff0000, purple: 0x800080,
    fuchsia: 0xff00ff, magenta: 0xff00ff, green: 0x008000, lime: 0x00ff00,
    olive: 0x808000, yellow: 0xffff00, navy: 0x000080, blue: 0x0000ff,
    teal: 0x008080, aqua: 0x00ffff, cyan: 0x00ffff, orange: 0xffa500,
    gold: 0xffd700, pink: 0xffc0cb, brown: 0xa52a2a, tan: 0xd2b48c,
    beige: 0xf5f5dc, ivory: 0xfffff0, indigo: 0x4b0082, violet: 0xee82ee,
    crimson: 0xdc143c, coral: 0xff7f50, salmon: 0xfa8072, khaki: 0xf0e68c,
    orchid: 0xda70d6, plum: 0xdda0dd, turquoise: 0x40e0d0, lavender: 0xe6e6fa,
    skyblue: 0x87ceeb, dodgerblue: 0x1e90ff, royalblue: 0x4169e1,
    steelblue: 0x4682b4, slateblue: 0x6a5acd, midnightblue: 0x191970,
    forestgreen: 0x228b22, seagreen: 0x2e8b57, limegreen: 0x32cd32,
    olivedrab: 0x6b8e23, darkgreen: 0x006400, springgreen: 0x00ff7f,
    chartreuse: 0x7fff00, darkred: 0x8b0000, firebrick: 0xb22222,
    tomato: 0xff6347, orangered: 0xff4500, darkorange: 0xff8c00,
    goldenrod: 0xdaa520, chocolate: 0xd2691e, sienna: 0xa0522d,
    darkblue: 0x00008b, darkcyan: 0x008b8b, darkmagenta: 0x8b008b,
    deeppink: 0xff1493, hotpink: 0xff69b4, lightblue: 0xadd8e6,
    lightgreen: 0x90ee90, lightgray: 0xd3d3d3, lightgrey: 0xd3d3d3,
    darkgray: 0xa9a9a9, darkgrey: 0xa9a9a9, dimgray: 0x696969, dimgrey: 0x696969,
};

/** Resolve an MXP color spec — an HTML named color, `#RGB`, `#RRGGBB`, or
 *  `rgb(r,g,b)` — into a {@link FormatColor}, or null when unrecognized.
 *  Used by the MXP parser for `<COLOR>`/`<FONT>` foreground and background. */
export function mxpColor(spec: string): FormatColor | null {
    const s = spec.trim();
    if (!s) return null;
    const hexMatch = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(s);
    if (hexMatch) {
        let hex = hexMatch[1];
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        return {
            space: 'rgb',
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
        };
    }
    const rgbMatch = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(s);
    if (rgbMatch) {
        const clamp = (n: number) => (n < 0 ? 0 : n > 255 ? 255 : n);
        return {
            space: 'rgb',
            r: clamp(parseInt(rgbMatch[1], 10)),
            g: clamp(parseInt(rgbMatch[2], 10)),
            b: clamp(parseInt(rgbMatch[3], 10)),
        };
    }
    const lower = s.toLowerCase();
    const html = HTML_COLORS[lower];
    if (html !== undefined) {
        return { space: 'rgb', r: (html >> 16) & 0xff, g: (html >> 8) & 0xff, b: html & 0xff };
    }
    const mud = MUDLET_COLORS[s] ?? MUDLET_COLORS[lower];
    if (mud) return { space: 'rgb', r: mud[0], g: mud[1], b: mud[2] };
    return null;
}

export function namedColorToAnsi(name: string, bg = false): string {
    if (name === 'r' || name === 'reset') return '\x1b[0m';
    const c = MUDLET_COLORS[name];
    if (!c) return '';
    return `\x1b[${bg ? 48 : 38};2;${c[0]};${c[1]};${c[2]}m`;
}

/** Converts a named Mudlet color to a FormatStateSnapshot for buffer-level coloring. */
export function namedColorToState(name: string, bg = false): FormatStateSnapshot | null {
    if (name === 'r' || name === 'reset') return {};
    const c = MUDLET_COLORS[name];
    if (!c) return null;
    const color: RgbColor = { space: 'rgb', r: c[0], g: c[1], b: c[2] };
    return bg ? { background: color } : { foreground: color };
}

/** cecho: <color_name>text<r>  or  <b:color_name>text for background */
export function parseCecho(text: string): string {
    return text.replace(/<([^<>]+)>/g, (_, tag: string) => {
        if (tag.startsWith('b:')) return namedColorToAnsi(tag.slice(2), true);
        return namedColorToAnsi(tag);
    }) + '\x1b[0m';
}

/** decho: <r,g,b>text  or  <:r,g,b>text for background, <r> to reset */
export function parseDecho(text: string): string {
    return text
        .replace(/<(:?)(\d+),(\d+),(\d+)>/g, (_, bg, r, g, b) =>
            `\x1b[${bg ? 48 : 38};2;${r};${g};${b}m`)
        .replace(/<r>/g, '\x1b[0m') + '\x1b[0m';
}

/**
 * Fast-path for `decho`: the ANSI-escape equivalent of `str`, or `null` when the
 * string uses any decho feature {@link parseDecho} does NOT reproduce exactly as
 * Mudlet's Lua `xEcho` would. Callers (the native `decho` fast path) fall back to
 * the Lua `xEcho` on `null`, so output stays identical to Mudlet.
 *
 * Handled here (and only here): foreground `<r,g,b>`, background `<:r,g,b>` with
 * channels in 0..255, and the `<r>` reset. Deferred to Lua: combined `<fg:bg>`,
 * background alpha `<:r,g,b,a>`, text-style tags (`<b>`/`<i>`/`<u>`/`<s>`/`<o>`),
 * out-of-range channels, and any other `<...>` token — the conservative guard
 * from our design discussion, so a decho grammar we don't model degrades to
 * slow-but-correct rather than wrong.
 */
export function dechoToAnsiFast(str: string): string | null {
    const tags = str.match(/<[^<>]*>/g);
    if (tags) {
        for (const t of tags) {
            if (t === '<r>') continue;
            const m = /^<(:?)(\d{1,3}),(\d{1,3}),(\d{1,3})>$/.exec(t);
            if (!m) return null;
            if (+m[2] > 255 || +m[3] > 255 || +m[4] > 255) return null;
        }
    }
    return parseDecho(str);
}

/**
 * Fast-path for `cecho` — see {@link dechoToAnsiFast}. Handles ONLY a plain
 * foreground `<name>` (resolvable in the Mudlet colour table) and the
 * `<r>`/`<reset>` reset. Everything else falls back to Lua `xEcho`, because
 * {@link parseCecho}'s grammar and name resolution diverge from Mudlet's:
 *  - style tags `<b>`/`<i>`/`<u>`/`<s>`/`<o>` (parseCecho would treat `b` as a
 *    colour name),
 *  - combined `<fg:bg>` / `<fg,bg>` and `<:bg>` backgrounds, and the `<b:…>`
 *    form (Mudlet reads `<b:red>` as fg=b, bg=red — not "background red"),
 *  - unknown names (parseCecho drops the tag; Mudlet leaves it literal).
 *
 * The `ansi_NNN` / `ansiXxx` family IS fast-pathed: this palette and the runtime
 * `color_table` (seeded from {@link ../text/xterm256}) agree, verified by the
 * full-palette sweep in the parity test — which also fails loudly if they ever
 * drift again.
 */
export function cechoToAnsiFast(str: string): string | null {
    const tags = str.match(/<[^<>]*>/g);
    if (tags) {
        for (const t of tags) {
            const name = t.slice(1, -1);
            if (name === 'r' || name === 'reset') continue;
            if (/^\/?[biuso]$/.test(name)) return null;        // style tags
            if (!/^[a-zA-Z0-9_]+$/.test(name)) return null;    // combined/bg/`:`/`,`
            if (MUDLET_COLORS[name] === undefined) return null; // unknown → Mudlet keeps literal
        }
    }
    return parseCecho(str);
}

/**
 * Fast-path for `hecho` — see {@link dechoToAnsiFast}. Handles ONLY a plain
 * foreground `#RRGGBB` and the `#r` reset. Falls back to Lua `xEcho` for
 * everything {@link parseHecho} can't reproduce as Mudlet does:
 *  - the `|c…` / `|b` pipe forms and `\#` escapes,
 *  - `#:…` (not Mudlet syntax) and `#,…` / `#RRGGBB,…` backgrounds/combined,
 *  - style tags `#b`/`#i`/`#u`/`#s`/`#o`.
 */
export function hechoToAnsiFast(str: string): string | null {
    if (str.includes('|') || str.includes('\\')) return null;
    const re = /#/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(str))) {
        const rest = str.slice(m.index + 1);
        if (rest.charCodeAt(0) === 114 /* 'r' */) continue;    // #r reset
        if (!/^[0-9a-fA-F]{6}/.test(rest)) return null;         // not a plain fg colour
        if (rest.charAt(6) === ',') return null;                // combined fg,bg
    }
    return parseHecho(str);
}

/** hecho: #RRGGBBtext  or  #:RRGGBBtext for background, #r to reset */
export function parseHecho(text: string): string {
    return text
        .replace(/#(:?)([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})/g,
            (_, bg, rh, gh, bh) =>
                `\x1b[${bg ? 48 : 38};2;${parseInt(rh, 16)};${parseInt(gh, 16)};${parseInt(bh, 16)}m`)
        .replace(/#r/g, '\x1b[0m') + '\x1b[0m';
}
