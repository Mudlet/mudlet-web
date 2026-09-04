#!/usr/bin/env node
/**
 * Regenerate src/mud/games/bundledGames.ts from Mudlet's TGameDetails.h.
 *
 * The catalogue of games Mudlet ships with — names, addresses, and the blurbs
 * shown in the connection dialog — lives in one C++ header as a
 * `QList<GameDetail>` literal. mudix wants the same list (the same names have to
 * resolve for getProfileInformation, and the connection dialog offers the same
 * games), so rather than retyping several hundred lines of prose this parses the
 * header and writes the TypeScript equivalent.
 *
 *   node scripts/sync-mudlet-games.mjs [path-to-TGameDetails.h]
 *
 * With no argument it fetches the header from Mudlet's development branch.
 * Re-run it when the pin in src/scripting/lua/mudlet-lua/SYNCED.md moves.
 */
import { writeFileSync, readFileSync, mkdirSync, readdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../src/mud/games/bundledGames.ts');
const ICON_DIR = resolve(HERE, '../src/mud/games/icons');
/** Start of the generated array, as written into the output file. */
const ARRAY_ANCHOR = 'export const BUNDLED_GAMES: readonly BundledGame[] = ';
/** `development` — where Mudlet's games and their logos actually land. A
 *  release branch lags it, and so does any checkout more than a few days old. */
const UPSTREAM_SRC = 'https://raw.githubusercontent.com/Mudlet/Mudlet/development/src/';
const UPSTREAM = `${UPSTREAM_SRC}TGameDetails.h`;

/** Strip // and /* *\/ comments that sit outside a string literal. */
function stripComments(src) {
    let out = '';
    let inString = false;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (inString) {
            out += c;
            if (c === '\\') { out += src[++i] ?? ''; continue; }
            if (c === '"') inString = false;
            continue;
        }
        if (c === '"') { inString = true; out += c; continue; }
        if (c === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            out += '\n';
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i++;
            continue;
        }
        out += c;
    }
    return out;
}

/** Split on commas / braces that are not inside a string literal. */
function splitTopLevel(body) {
    const parts = [];
    let depth = 0, inString = false, current = '';
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (inString) {
            current += c;
            if (c === '\\') { current += body[++i] ?? ''; continue; }
            if (c === '"') inString = false;
            continue;
        }
        if (c === '"') { inString = true; current += c; continue; }
        if (c === '{' || c === '(') { depth++; current += c; continue; }
        if (c === '}' || c === ')') { depth--; current += c; continue; }
        if (c === ',' && depth === 0) { parts.push(current); current = ''; continue; }
        current += c;
    }
    if (current.trim()) parts.push(current);
    return parts;
}

/** The braced group bodies at the top level of `body`. */
function topLevelGroups(body) {
    const groups = [];
    let depth = 0, inString = false, start = -1;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (inString) {
            if (c === '\\') { i++; continue; }
            if (c === '"') inString = false;
            continue;
        }
        if (c === '"') { inString = true; continue; }
        if (c === '{') { if (depth === 0) start = i + 1; depth++; continue; }
        if (c === '}') { depth--; if (depth === 0) groups.push(body.slice(start, i)); }
    }
    return groups;
}

/** Concatenated contents of every "..." literal in the expression. QString()
 *  and an absent value both mean the empty string. */
function stringValue(expr) {
    let out = '';
    const re = /"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(expr))) {
        out += m[1]
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }
    return out;
}

function parseGames(src) {
    const clean = stripComments(src);
    const marker = clean.indexOf('scmDefaultGames = {');
    if (marker < 0) throw new Error('scmDefaultGames literal not found');
    const listBody = clean.slice(marker + 'scmDefaultGames = '.length);
    // The list's own braces are the first top-level group.
    const [body] = topLevelGroups(listBody);
    if (!body) throw new Error('scmDefaultGames body not found');

    return topLevelGroups(body).map(group => {
        const f = splitTopLevel(group).map(s => s.trim());
        const game = {
            name: stringValue(f[0] ?? ''),
            hostUrl: stringValue(f[1] ?? ''),
            port: parseInt(f[2] ?? '0', 10) || 0,
            tlsEnabled: /\btrue\b/.test(f[3] ?? ''),
            websiteInfo: stringValue(f[4] ?? ''),
            icon: stringValue(f[5] ?? ''),
            description: stringValue(f[6] ?? ''),
        };
        // Both trailing fields are optional and the C++ order is fixed:
        // providesOwnUi (a bool), then alternateHostUrls (a brace list).
        for (const extra of f.slice(7)) {
            if (/^\{/.test(extra)) {
                const urls = splitTopLevel(extra.replace(/^\{|\}$/g, ''))
                    .map(stringValue).filter(Boolean);
                if (urls.length) game.alternateHostUrls = urls;
            } else if (/\b(true|false)\b/.test(extra)) {
                game.providesOwnUi = /\btrue\b/.test(extra);
            }
        }
        return game;
    }).filter(g => g.name);
}

/** Some entries reference a `.qrc` alias rather than a path
 *  (`:/materiaMagicaIcon`), so the resource file is what resolves them. */
async function loadQrcAliases(checkoutSrc) {
    const qrc = checkoutSrc ? resolve(checkoutSrc, 'mudlet.qrc') : null;
    let text = '';
    if (qrc && existsSync(qrc)) text = readFileSync(qrc, 'utf8');
    else text = await fetchText(`${UPSTREAM_SRC}mudlet.qrc`) ?? '';
    const aliases = new Map();
    const re = /<file\s+alias="([^"]+)"\s*>([^<]+)<\/file>/g;
    let m;
    while ((m = re.exec(text))) aliases.set(m[1], m[2].trim());
    return aliases;
}

async function fetchText(url) {
    try {
        const res = await fetch(url);
        return res.ok ? await res.text() : null;
    } catch { return null; }
}

/** Download one logo into the vendored icon dir. Returns false (quietly) on
 *  any failure, so a run with no network still produces a catalogue. */
async function fetchIcon(relative, to) {
    try {
        const res = await fetch(UPSTREAM_SRC + relative.replaceAll('\\', '/'));
        if (!res.ok) return false;
        writeFileSync(to, Buffer.from(await res.arrayBuffer()));
        return true;
    } catch { return false; }
}

/**
 * Vendor each game's logo and record the filename on the entry.
 *
 * The icons are binary files beside the header rather than in it, so they come
 * from one of three places, in order: the Mudlet checkout when one was given,
 * `development` over HTTP otherwise (a checkout more than a few days old is
 * missing the newest games' logos, which is exactly when this matters), and
 * finally whatever a previous run already vendored, so a run with no network
 * degrades to keeping what it has instead of stripping every logo.
 *
 * The filename always comes from the entry's OWN icon path, so a game whose
 * logo can't be found ends up with none — it can never inherit its neighbour's.
 *
 * Icons land as ordinary files that Vite emits as assets, NOT inlined the way
 * `src/assets/qt-resources` inlines its handful: 1.7 MB of logos as data URIs
 * would go straight into the JS bundle for every user, whereas as files the
 * browser fetches only the tiles it draws.
 */
async function vendorIcons(games, checkoutSrc) {
    const aliases = await loadQrcAliases(checkoutSrc);
    mkdirSync(ICON_DIR, { recursive: true });

    const used = new Set();
    const missing = [];
    let copied = 0, fetched = 0, kept = 0;
    for (const game of games) {
        if (!game.icon) continue;
        const key = game.icon.replace(/^(:|qrc:)\/+/, '');
        const relative = aliases.get(key) ?? key;
        const file = basename(relative);
        const to = resolve(ICON_DIR, file);
        const from = checkoutSrc ? resolve(checkoutSrc, relative) : null;
        if (from && existsSync(from)) { copyFileSync(from, to); copied++; }
        else if (await fetchIcon(relative, to)) fetched++;
        else if (existsSync(to)) kept++;
        else { missing.push(`${game.name} (${game.icon})`); continue; }
        game.iconFile = file;
        used.add(file);
    }

    // Drop logos no game references any more. Skipped entirely if nothing
    // resolved (no network, no checkout) — that is not evidence they're stale.
    if (used.size) {
        for (const file of readdirSync(ICON_DIR)) {
            if (!used.has(file)) rmSync(resolve(ICON_DIR, file), { force: true });
        }
    }
    if (missing.length) console.warn(`no icon file for: ${missing.join(', ')}`);
    return { total: used.size, copied, fetched, kept };
}

const fromCheckout = process.argv[2] ? resolve(process.argv[2]) : null;
const source = fromCheckout
    ? readFileSync(fromCheckout, 'utf8')
    : await (await fetch(UPSTREAM)).text();

const games = parseGames(source);
if (games.length < 20) throw new Error(`only ${games.length} games parsed — the header shape must have changed`);
const icons = await vendorIcons(games, fromCheckout ? dirname(fromCheckout) : null);

const header = `// GENERATED by scripts/sync-mudlet-games.mjs — do not edit by hand.
//
// The games Mudlet ships with, vendored from its src/TGameDetails.h. mudix needs
// the same catalogue for two reasons: the connection dialog offers the same
// games, and Mudlet's profile-description API answers for a bundled game's name
// whether or not a profile of that name exists — a script asking about "Achaea"
// gets the blurb, not nil.
//
// Regenerate with: node scripts/sync-mudlet-games.mjs [path/to/TGameDetails.h]

/** One entry of Mudlet's bundled-game catalogue (its C++ \`GameDetail\`). */
export interface BundledGame {
    name: string;
    hostUrl: string;
    port: number;
    tlsEnabled: boolean;
    /** Small HTML fragment of website/forum/Discord links. */
    websiteInfo: string;
    /** Qt resource path of the game's icon, kept as the upstream identifier. */
    icon: string;
    /** Filename of the copy vendored in ./icons/, when one was available.
     *  Resolve it with \`gameIconUrl()\` rather than building a path by hand —
     *  the bundler only emits assets it can see referenced. */
    iconFile?: string;
    description: string;
    /** The game's own loader installs its full interface, so the generic
     *  starter UI is not preinstalled for it. */
    providesOwnUi?: boolean;
    /** Other hostnames the game answers on. */
    alternateHostUrls?: string[];
}

${ARRAY_ANCHOR}`;

const footer = `;

/** The bundled game called \`name\`, matched the way Mudlet matches it
 *  (TGameDetails::findGame — exact, case-sensitive). */
export function findBundledGame(name: string): BundledGame | null {
    return BUNDLED_GAMES.find(g => g.name === name) ?? null;
}

/** Whether the game reachable at \`hostUrl\` installs its own full interface,
 *  in which case the generic starter UI is not preinstalled (Mudlet's
 *  TGameDetails::gameProvidesOwnUi). */
export function gameProvidesOwnUi(hostUrl: string): boolean {
    const wanted = hostUrl.toLowerCase();
    return BUNDLED_GAMES.some(g => g.providesOwnUi
        && (g.hostUrl.toLowerCase() === wanted
            || (g.alternateHostUrls ?? []).some(u => u.toLowerCase() === wanted)));
}
`;

writeFileSync(OUT, header + JSON.stringify(games, null, 4) + footer, 'utf8');
console.log(`wrote ${games.length} games to ${OUT}`);
console.log(`icons: ${icons.total} vendored (${icons.copied} from the checkout, ${icons.fetched} fetched, ${icons.kept} already present)`);
