import mudletColors from './mudletColors.json';
import type { FormatColor, FormatStateSnapshot, RgbColor } from './FormatState';

const MUDLET_COLORS = mudletColors as unknown as Record<string, [number, number, number]>;

/** The colour names Mudlet's MXP `<COLOR>`/`<FONT>` resolves — exactly the
 *  table behind Qt's `QColor(name)` (qcolor.cpp `rgbTbl`): the SVG 1.0 keyword
 *  names plus `transparent`, which a TChar stores as black since only the RGB is
 *  kept. Packed `0xRRGGBB`; looked up lowercased with spaces and tabs removed,
 *  as Qt looks them up. */
const SVG_COLORS: Record<string, number> = {
    aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aqua: 0x00ffff, aquamarine: 0x7fffd4,
    azure: 0xf0ffff, beige: 0xf5f5dc, bisque: 0xffe4c4, black: 0x000000, blanchedalmond: 0xffebcd,
    blue: 0x0000ff, blueviolet: 0x8a2be2, brown: 0xa52a2a, burlywood: 0xdeb887, cadetblue: 0x5f9ea0,
    chartreuse: 0x7fff00, chocolate: 0xd2691e, coral: 0xff7f50, cornflowerblue: 0x6495ed,
    cornsilk: 0xfff8dc, crimson: 0xdc143c, cyan: 0x00ffff, darkblue: 0x00008b, darkcyan: 0x008b8b,
    darkgoldenrod: 0xb8860b, darkgray: 0xa9a9a9, darkgreen: 0x006400, darkgrey: 0xa9a9a9,
    darkkhaki: 0xbdb76b, darkmagenta: 0x8b008b, darkolivegreen: 0x556b2f, darkorange: 0xff8c00,
    darkorchid: 0x9932cc, darkred: 0x8b0000, darksalmon: 0xe9967a, darkseagreen: 0x8fbc8f,
    darkslateblue: 0x483d8b, darkslategray: 0x2f4f4f, darkslategrey: 0x2f4f4f,
    darkturquoise: 0x00ced1, darkviolet: 0x9400d3, deeppink: 0xff1493, deepskyblue: 0x00bfff,
    dimgray: 0x696969, dimgrey: 0x696969, dodgerblue: 0x1e90ff, firebrick: 0xb22222,
    floralwhite: 0xfffaf0, forestgreen: 0x228b22, fuchsia: 0xff00ff, gainsboro: 0xdcdcdc,
    ghostwhite: 0xf8f8ff, gold: 0xffd700, goldenrod: 0xdaa520, gray: 0x808080, green: 0x008000,
    greenyellow: 0xadff2f, grey: 0x808080, honeydew: 0xf0fff0, hotpink: 0xff69b4,
    indianred: 0xcd5c5c, indigo: 0x4b0082, ivory: 0xfffff0, khaki: 0xf0e68c, lavender: 0xe6e6fa,
    lavenderblush: 0xfff0f5, lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd, lightblue: 0xadd8e6,
    lightcoral: 0xf08080, lightcyan: 0xe0ffff, lightgoldenrodyellow: 0xfafad2, lightgray: 0xd3d3d3,
    lightgreen: 0x90ee90, lightgrey: 0xd3d3d3, lightpink: 0xffb6c1, lightsalmon: 0xffa07a,
    lightseagreen: 0x20b2aa, lightskyblue: 0x87cefa, lightslategray: 0x778899,
    lightslategrey: 0x778899, lightsteelblue: 0xb0c4de, lightyellow: 0xffffe0, lime: 0x00ff00,
    limegreen: 0x32cd32, linen: 0xfaf0e6, magenta: 0xff00ff, maroon: 0x800000,
    mediumaquamarine: 0x66cdaa, mediumblue: 0x0000cd, mediumorchid: 0xba55d3,
    mediumpurple: 0x9370db, mediumseagreen: 0x3cb371, mediumslateblue: 0x7b68ee,
    mediumspringgreen: 0x00fa9a, mediumturquoise: 0x48d1cc, mediumvioletred: 0xc71585,
    midnightblue: 0x191970, mintcream: 0xf5fffa, mistyrose: 0xffe4e1, moccasin: 0xffe4b5,
    navajowhite: 0xffdead, navy: 0x000080, oldlace: 0xfdf5e6, olive: 0x808000, olivedrab: 0x6b8e23,
    orange: 0xffa500, orangered: 0xff4500, orchid: 0xda70d6, palegoldenrod: 0xeee8aa,
    palegreen: 0x98fb98, paleturquoise: 0xafeeee, palevioletred: 0xdb7093, papayawhip: 0xffefd5,
    peachpuff: 0xffdab9, peru: 0xcd853f, pink: 0xffc0cb, plum: 0xdda0dd, powderblue: 0xb0e0e6,
    purple: 0x800080, red: 0xff0000, rosybrown: 0xbc8f8f, royalblue: 0x4169e1,
    saddlebrown: 0x8b4513, salmon: 0xfa8072, sandybrown: 0xf4a460, seagreen: 0x2e8b57,
    seashell: 0xfff5ee, sienna: 0xa0522d, silver: 0xc0c0c0, skyblue: 0x87ceeb, slateblue: 0x6a5acd,
    slategray: 0x708090, slategrey: 0x708090, snow: 0xfffafa, springgreen: 0x00ff7f,
    steelblue: 0x4682b4, tan: 0xd2b48c, teal: 0x008080, thistle: 0xd8bfd8, tomato: 0xff6347,
    turquoise: 0x40e0d0, violet: 0xee82ee, wheat: 0xf5deb3, white: 0xffffff, whitesmoke: 0xf5f5f5,
    yellow: 0xffff00, yellowgreen: 0x9acd32, transparent: 0x000000,
};

/** Qt's 16-bit channel to the 8 bits a TChar keeps (`qt_div_257`). */
const div257 = (x: number) => (x - (x >> 8) + 0x80) >> 8;

/** `#RGB`, `#RRGGBB`, `#AARRGGBB` (alpha dropped), `#RRRGGGBBB` and
 *  `#RRRRGGGGBBBB`, read the way Qt's `get_hex_rgb` reads them. */
function qtHexColor(s: string): FormatColor | null {
    const hex = s.slice(1);
    if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
    const at = (from: number, len: number) => parseInt(hex.slice(from, from + len), 16);
    let r: number, g: number, b: number;
    switch (hex.length) {
        case 12: r = at(0, 4); g = at(4, 4); b = at(8, 4); break;
        case 9:
            r = at(0, 3); g = at(3, 3); b = at(6, 3);
            r = (r << 4) | (r >> 8); g = (g << 4) | (g >> 8); b = (b << 4) | (b >> 8);
            break;
        case 8: r = at(2, 2) * 0x101; g = at(4, 2) * 0x101; b = at(6, 2) * 0x101; break;
        case 6: r = at(0, 2) * 0x101; g = at(2, 2) * 0x101; b = at(4, 2) * 0x101; break;
        case 3: r = at(0, 1) * 0x1111; g = at(1, 1) * 0x1111; b = at(2, 1) * 0x1111; break;
        default: return null;
    }
    return { space: 'rgb', r: div257(r), g: div257(g), b: div257(b) };
}

/** Resolve an MXP color spec into a {@link FormatColor}, or null when
 *  unrecognized — what Mudlet's `QColor(name)` accepts (a hex form or a
 *  colour name, see {@link SVG_COLORS}), then, as this client's own
 *  additions, `rgb(r,g,b)` and the Mudlet palette names.
 *  Used by the MXP parser for `<COLOR>`/`<FONT>` foreground and background. */
export function mxpColor(spec: string): FormatColor | null {
    const s = spec.trim();
    if (!s) return null;
    if (s[0] === '#') return qtHexColor(s);
    const svg = SVG_COLORS[s.replace(/[ \t]/g, '').toLowerCase()];
    if (svg !== undefined) {
        return { space: 'rgb', r: (svg >> 16) & 0xff, g: (svg >> 8) & 0xff, b: svg & 0xff };
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
    const mud = MUDLET_COLORS[s] ?? MUDLET_COLORS[s.toLowerCase()];
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
 * The palette {@link cechoToAnsiFast} resolves names against, as a Lua table
 * constructor (`{["red"]={255,0,0},…}`). Mudlet's cecho reads the live
 * `color_table` for every tag, so a script that sets `color_table.red` changes
 * what `<red>` draws. The fast-path wrapper in LuaRuntime compares each tag's
 * `color_table` entry with this table and hands the call back to the Lua
 * `xEcho` whenever they disagree — a per-tag lookup, and only overridden
 * names pay for the slow path.
 */
export function cechoFastPaletteLua(): string {
    const parts: string[] = [];
    for (const [name, c] of Object.entries(MUDLET_COLORS)) {
        parts.push(`[${JSON.stringify(name)}]={${c[0]},${c[1]},${c[2]}}`);
    }
    return `{${parts.join(',')}}`;
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
