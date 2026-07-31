import { zipSync, strToU8 } from 'fflate';
import { serializeMudletXml, type SerializeInput } from './mudletXmlExport';

// The inverse of packageInstaller: turn a selection of profile items plus some
// metadata into a Mudlet `.mpackage` — a zip holding `<name>.xml`, `config.lua`,
// an optional icon under `.mudlet/Icon/`, and any extra asset files.
//
// Layout and config.lua key order mirror Mudlet's dlgPackageExporter so the
// result installs in desktop Mudlet, and round-trips back through
// `installPackageFromBytes` (which reads the same config.lua keys) here.

export interface PackageExportMeta {
    /** Package identity — also the XML filename and the install directory name. */
    name: string;
    author?: string;
    title?: string;
    description?: string;
    version?: string;
    helpURL?: string;
    dependencies?: string[];
    /** Icon filename as stored under `.mudlet/Icon/`; empty when there's no icon. */
    icon?: string;
    /** ISO-8601 creation stamp. Passed in rather than read from the clock so the
     *  builders stay pure and testable. */
    created: string;
}

/** Strip characters that are illegal in zip entry / filesystem names. */
export function sanitizePackageName(raw: string, fallback = 'package'): string {
    const cleaned = raw.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
    return cleaned || fallback;
}

/**
 * Quote a value as a Lua long-bracket string, picking a bracket level the value
 * doesn't contain — Mudlet always writes plain `[[…]]`, which corrupts the file
 * when a description happens to hold `]]`.
 */
function luaLongString(value: string): string {
    let level = 0;
    while (value.includes(`]${'='.repeat(level)}]`)) level++;
    const eq = '='.repeat(level);
    // Lua strips one newline immediately after the opening bracket (so does our
    // config.lua reader), so a value that starts with one needs a second.
    const body = /^[\r\n]/.test(value) ? `\n${value}` : value;
    return `[${eq}[${body}]${eq}]`;
}

/**
 * Mudlet's `config.lua`: every key is written even when empty, in the order
 * dlgPackageExporter emits them, with `created` as a plain quoted string.
 */
export function buildConfigLua(meta: PackageExportMeta): string {
    const lines: string[] = [];
    const put = (key: string, value: string | undefined) =>
        lines.push(`${key} = ${luaLongString(value ?? '')}`);
    put('mpackage', meta.name);
    put('author', meta.author);
    put('icon', meta.icon);
    put('title', meta.title);
    put('description', meta.description);
    put('version', meta.version);
    put('helpURL', meta.helpURL);
    put('dependencies', (meta.dependencies ?? []).join(','));
    lines.push(`created = "${meta.created}"`);
    return `${lines.join('\n')}\n`;
}

interface TreeNode {
    id: string;
    parentId: string | null;
    isGroup: boolean;
}

/** Every descendant id of `rootId`, excluding the root itself. */
export function descendantIds<T extends TreeNode>(nodes: T[], rootId: string): string[] {
    const byParent = new Map<string | null, T[]>();
    for (const n of nodes) {
        const arr = byParent.get(n.parentId) ?? [];
        arr.push(n);
        byParent.set(n.parentId, arr);
    }
    const out: string[] = [];
    const walk = (id: string) => {
        for (const child of byParent.get(id) ?? []) {
            out.push(child.id);
            walk(child.id);
        }
    };
    walk(rootId);
    return out;
}

/**
 * Reduce a category's nodes to the selected ones, re-parenting any node whose
 * parent wasn't selected to the top level.
 *
 * Mudlet drops such a node instead: its exporter walks from the roots and never
 * reaches a selected child under an unselected group, so checking one trigger
 * inside a folder exports nothing. Re-rooting keeps the item and makes the
 * selection mean what it looks like; a fully-checked subtree serializes
 * identically either way.
 */
export function selectExportNodes<T extends TreeNode>(nodes: T[], selected: ReadonlySet<string>): T[] {
    return nodes
        .filter(n => selected.has(n.id))
        .map(n => (n.parentId !== null && !selected.has(n.parentId) ? { ...n, parentId: null } : n));
}

/** Ids of every category, as the modal tracks them. */
export interface PackageSelection {
    scripts: ReadonlySet<string>;
    aliases: ReadonlySet<string>;
    triggers: ReadonlySet<string>;
    timers: ReadonlySet<string>;
    keys: ReadonlySet<string>;
    buttons: ReadonlySet<string>;
}

/** Apply a selection across all six categories at once. */
export function selectExportInput(all: SerializeInput, selection: PackageSelection): SerializeInput {
    return {
        scripts:  selectExportNodes(all.scripts,  selection.scripts),
        aliases:  selectExportNodes(all.aliases,  selection.aliases),
        triggers: selectExportNodes(all.triggers, selection.triggers),
        timers:   selectExportNodes(all.timers,   selection.timers),
        keys:     selectExportNodes(all.keys,     selection.keys),
        buttons:  selectExportNodes(all.buttons,  selection.buttons),
    };
}

export function countSelected(input: SerializeInput): number {
    return input.scripts.length + input.aliases.length + input.triggers.length
        + input.timers.length + input.keys.length + input.buttons.length;
}

export interface PackageExportInput {
    meta: PackageExportMeta;
    /** Already filtered through `selectExportInput`. */
    nodes: SerializeInput;
    /** Extra files to carry, keyed by path relative to the package root. */
    assets?: Record<string, Uint8Array>;
    /** Icon bytes; stored at `.mudlet/Icon/<meta.icon>` when `meta.icon` is set. */
    iconBytes?: Uint8Array;
}

/** Normalize an asset path to a zip entry: no leading slash, no `..` segments. */
function normalizeEntryPath(path: string): string {
    return path
        .replace(/\\/g, '/')
        .split('/')
        .filter(seg => seg && seg !== '.' && seg !== '..')
        .join('/');
}

/**
 * Build the package's file map. `config.lua` and `<name>.xml` are written last
 * and always win: an asset list harvested from an installed package directory
 * contains the *previous* pair, and letting those through would ship stale
 * metadata alongside the freshly serialized items.
 */
export function buildPackageEntries(input: PackageExportInput): Record<string, Uint8Array> {
    const name = sanitizePackageName(input.meta.name);
    const xmlName = `${name}.xml`;
    const entries: Record<string, Uint8Array> = {};

    for (const [path, bytes] of Object.entries(input.assets ?? {})) {
        const clean = normalizeEntryPath(path);
        if (!clean || clean === 'config.lua' || clean === xmlName) continue;
        entries[clean] = bytes;
    }

    if (input.iconBytes && input.meta.icon) {
        entries[`.mudlet/Icon/${normalizeEntryPath(input.meta.icon)}`] = input.iconBytes;
    }

    entries['config.lua'] = strToU8(buildConfigLua({ ...input.meta, name }));
    // Passing the package name strips the wrapper group our importer adds, so
    // re-exporting an installed package doesn't nest it one level deeper each time.
    entries[xmlName] = strToU8(serializeMudletXml(input.nodes, name));
    return entries;
}

export function buildPackageZip(input: PackageExportInput): Uint8Array {
    // level 6: assets (images, sounds) are the bulk and the extra levels cost
    // more main-thread time than they save bytes.
    return zipSync(buildPackageEntries(input), { level: 6 });
}
