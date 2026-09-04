import { sanitizeControlChars } from './mudletControlChars';
import type {
    AliasNode,
    ButtonNode,
    KeyNode,
    ScriptNode,
    TimerNode,
    TriggerNode,
    TriggerPatternType,
} from '../storage/schema';

// Inverse of mudletXmlImport.ts. Produces XML compatible with Mudlet's package
// format and round-trips through parseMudletXml. Module sync writes back through
// this serializer: each module owns one XML file, and on flush every node tagged
// with the module's package name is re-emitted in the same hierarchy.

const MUDLET_PATTERN_TYPES: TriggerPatternType[] = [
    'substring', 'regex', 'startOfLine', 'exactMatch',
    'luaFunction', 'lineSpacer', 'colorTrigger', 'prompt',
];
function patternTypeIndex(t: TriggerPatternType): number {
    const i = MUDLET_PATTERN_TYPES.indexOf(t);
    return i >= 0 ? i : 0;
}

const CODE_TO_QT_KEY: Record<string, number> = {
    Space: 32,
    Digit0: 48, Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52,
    Digit5: 53, Digit6: 54, Digit7: 55, Digit8: 56, Digit9: 57,
    KeyA: 65, KeyB: 66, KeyC: 67, KeyD: 68, KeyE: 69, KeyF: 70,
    KeyG: 71, KeyH: 72, KeyI: 73, KeyJ: 74, KeyK: 75, KeyL: 76,
    KeyM: 77, KeyN: 78, KeyO: 79, KeyP: 80, KeyQ: 81, KeyR: 82,
    KeyS: 83, KeyT: 84, KeyU: 85, KeyV: 86, KeyW: 87, KeyX: 88,
    KeyY: 89, KeyZ: 90,
    Escape: 16777216, Tab: 16777217, Backspace: 16777219,
    Enter: 16777220, NumpadEnter: 16777221,
    Insert: 16777222, Delete: 16777223,
    Home: 16777232, End: 16777233,
    ArrowLeft: 16777234, ArrowUp: 16777235,
    ArrowRight: 16777236, ArrowDown: 16777237,
    PageUp: 16777238, PageDown: 16777239,
    F1: 16777264,  F2: 16777265,  F3: 16777266,  F4: 16777267,
    F5: 16777268,  F6: 16777269,  F7: 16777270,  F8: 16777271,
    F9: 16777272,  F10: 16777273, F11: 16777274, F12: 16777275,
    // Numpad codes share Qt::Key values with their main-keyboard counterparts;
    // the numpad distinction is carried by Qt::KeypadModifier in keyModifier.
    Numpad0: 48, Numpad1: 49, Numpad2: 50, Numpad3: 51, Numpad4: 52,
    Numpad5: 53, Numpad6: 54, Numpad7: 55, Numpad8: 56, Numpad9: 57,
    NumpadMultiply: 42, NumpadAdd: 43, NumpadSubtract: 45,
    NumpadDecimal: 46, NumpadDivide: 47, NumpadEqual: 61,
};

const QT_SHIFT = 33554432, QT_CTRL = 67108864, QT_ALT = 134217728, QT_META = 268435456;
const QT_KEYPAD = 536870912;
function modifiersToQt(mods: string[], key: string): number {
    let bits = 0;
    for (const m of mods) {
        const k = m.toLowerCase();
        if      (k === 'shift') bits |= QT_SHIFT;
        else if (k === 'ctrl')  bits |= QT_CTRL;
        else if (k === 'alt')   bits |= QT_ALT;
        else if (k === 'meta')  bits |= QT_META;
    }
    // NumpadEnter has its own dedicated Qt::Key, so it doesn't need the flag;
    // every other Numpad* key shares a Qt::Key with its main-keyboard counterpart
    // and the modifier is the only thing that disambiguates them.
    if (key.startsWith('Numpad') && key !== 'NumpadEnter') bits |= QT_KEYPAD;
    return bits;
}

const BUTTON_LOCATIONS = ['top', 'bottom', 'left', 'right', 'floating'];
const BUTTON_ORIENTATIONS = ['horizontal', 'vertical'];

// Control characters are placeholder-encoded before the entity escape: XML 1.0
// cannot represent them at all, and a raw one here yields a document that the
// linked-profile write-back then grafts a <parsererror> into.
function escapeXml(s: string): string {
    return sanitizeControlChars(s).replace(/[&<>"']/g, ch => (
        ch === '&' ? '&amp;'  :
        ch === '<' ? '&lt;'   :
        ch === '>' ? '&gt;'   :
        ch === '"' ? '&quot;' : '&apos;'
    ));
}

function formatTimerSeconds(s: number): string {
    const total = Math.max(0, s);
    const hours = Math.floor(total / 3600);
    const mins  = Math.floor((total % 3600) / 60);
    const secs  = total - hours * 3600 - mins * 60;
    const wholeSecs = Math.floor(secs);
    const ms = Math.round((secs - wholeSecs) * 1000);
    const pad = (n: number, width = 2) => String(n).padStart(width, '0');
    return `${pad(hours)}:${pad(mins)}:${pad(wholeSecs)}.${pad(ms, 3)}`;
}

interface TreeNode {
    id: string;
    parentId: string | null;
    isGroup: boolean;
}

function buildChildrenMap<T extends TreeNode>(nodes: T[]): Map<string | null, T[]> {
    const m = new Map<string | null, T[]>();
    for (const n of nodes) {
        const arr = m.get(n.parentId) ?? [];
        arr.push(n);
        m.set(n.parentId, arr);
    }
    return m;
}

class XmlBuilder {
    private parts: string[] = [];
    private depth = 0;
    private readonly indent = '    ';

    private pad(): string { return this.indent.repeat(this.depth); }

    open(tag: string, attrs: Record<string, string> = {}): void {
        const a = Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('');
        this.parts.push(`${this.pad()}<${tag}${a}>\n`);
        this.depth++;
    }

    close(tag: string): void {
        this.depth--;
        this.parts.push(`${this.pad()}</${tag}>\n`);
    }

    /** Self-closed element with attributes only. */
    selfClose(tag: string, attrs: Record<string, string> = {}): void {
        const a = Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('');
        this.parts.push(`${this.pad()}<${tag}${a}/>\n`);
    }

    /** Element with text content on a single line. */
    leaf(tag: string, value: string): void {
        if (value === '' || value == null) {
            this.parts.push(`${this.pad()}<${tag}></${tag}>\n`);
            return;
        }
        this.parts.push(`${this.pad()}<${tag}>${escapeXml(value)}</${tag}>\n`);
    }

    raw(s: string): void { this.parts.push(s); }

    build(): string { return this.parts.join(''); }
}

interface ExportOptions {
    /**
     * If set, top-level groups whose name matches this string and whose nodes are tagged
     * with the same packageName are inlined: their children are emitted as roots, not the
     * wrapper itself. Mirrors `applyPackageTagging` in mudletXmlImport — a wrapper named
     * after the package is created on import; serializing without stripping it would
     * cause double-wrapping on the next reload.
     */
    stripWrapperName?: string;
    packageName?: string;
}

// Mudlet encodes a node's boolean flags as ATTRIBUTES on the <Trigger>/<Alias>/…
// element (not child elements), and reads them back as attributes — so `attrsFor`
// supplies the full per-type attribute set. The child elements + their order are
// emitted by `emitBody`, matching Mudlet's XMLexport.cpp exactly (verified against
// real Mudlet saves). Getting this wrong makes Mudlet mis-parse and load nothing.
function emitSubtree<T extends TreeNode>(
    xml: XmlBuilder,
    children: T[] | undefined,
    childMap: Map<string | null, T[]>,
    leafTag: string,
    groupTag: string,
    attrsFor: (node: T, isGroup: boolean) => Record<string, string>,
    emitBody: (xml: XmlBuilder, node: T, isGroup: boolean) => void,
): void {
    if (!children) return;
    for (const node of children) {
        const tag = node.isGroup ? groupTag : leafTag;
        xml.open(tag, attrsFor(node, node.isGroup));
        emitBody(xml, node, node.isGroup);
        // Non-group nodes can still have children (Mudlet allows leaf triggers
        // to act as chain heads with descendants), so always recurse if any exist.
        const grandChildren = childMap.get(node.id);
        if (grandChildren && grandChildren.length > 0) {
            emitSubtree(xml, grandChildren, childMap, leafTag, groupTag, attrsFor, emitBody);
        }
        xml.close(tag);
    }
}

/** The isActive/isFolder attributes every node carries (in Mudlet's order). */
function baseAttrs(enabled: boolean, isGroup: boolean): Record<string, string> {
    return { isActive: enabled ? 'yes' : 'no', isFolder: isGroup ? 'yes' : 'no' };
}

/**
 * Find the top-level wrapper group (if any) that `applyPackageTagging` would have
 * inserted, and return the children to emit at the package-level. If no wrapper
 * is found, returns the original roots.
 */
function unwrapPackageRoots<T extends TreeNode & { name: string; packageName?: string }>(
    // Unread, but kept as the inference site for `T` — the callers' node array is
    // what pins the generic; `childMap` alone would infer it from a weaker position.
    _nodes: T[],
    childMap: Map<string | null, T[]>,
    opts: ExportOptions,
): T[] {
    if (!opts.stripWrapperName) return childMap.get(null) ?? [];
    const roots = childMap.get(null) ?? [];
    const wrapperRoots = roots.filter(r =>
        r.isGroup && r.name === opts.stripWrapperName && (!opts.packageName || r.packageName === opts.packageName),
    );
    if (wrapperRoots.length === 0) return roots;
    const out: T[] = [];
    for (const r of roots) {
        if (wrapperRoots.includes(r)) {
            const kids = childMap.get(r.id) ?? [];
            for (const k of kids) out.push(k);
        } else {
            out.push(r);
        }
    }
    return out;
}

// All emit functions below mirror Mudlet's XMLexport.cpp writers exactly —
// attributes and child-element order verified against real Mudlet profile saves.

function emitScripts(xml: XmlBuilder, nodes: ScriptNode[], opts: ExportOptions): void {
    xml.open('ScriptPackage');
    const childMap = buildChildrenMap(nodes);
    const roots = unwrapPackageRoots(nodes, childMap, opts);
    emitSubtree(xml, roots, childMap, 'Script', 'ScriptGroup',
        (n, g) => baseAttrs(n.enabled, g),
        (xml, n) => {
            xml.leaf('name', n.name);
            xml.leaf('packageName', n.packageName ?? '');
            xml.leaf('script', n.code ?? '');
            xml.open('eventHandlerList');
            for (const e of (n.eventHandlers ?? [])) xml.leaf('string', e);
            xml.close('eventHandlerList');
        });
    xml.close('ScriptPackage');
}

function emitAliases(xml: XmlBuilder, nodes: AliasNode[], opts: ExportOptions): void {
    xml.open('AliasPackage');
    const childMap = buildChildrenMap(nodes);
    const roots = unwrapPackageRoots(nodes, childMap, opts);
    emitSubtree(xml, roots, childMap, 'Alias', 'AliasGroup',
        (n, g) => baseAttrs(n.enabled, g),
        (xml, n) => {
            xml.leaf('name', n.name);
            xml.leaf('script', n.code ?? '');
            xml.leaf('command', n.command ?? '');
            xml.leaf('packageName', n.packageName ?? '');
            xml.leaf('regex', n.pattern ?? '');
        });
    xml.close('AliasPackage');
}

function emitTriggers(xml: XmlBuilder, nodes: TriggerNode[], opts: ExportOptions): void {
    xml.open('TriggerPackage');
    const childMap = buildChildrenMap(nodes);
    const roots = unwrapPackageRoots(nodes, childMap, opts);
    emitSubtree(xml, roots, childMap, 'Trigger', 'TriggerGroup',
        (n, g) => ({
            ...baseAttrs(n.enabled, g),
            isTempTrigger: 'no',
            isMultiline: n.multiline ? 'yes' : 'no',
            isPerlSlashGOption: n.multipleMatches ? 'yes' : 'no',
            isColorizerTrigger: n.highlight ? 'yes' : 'no',
            isFilterTrigger: n.isFilter ? 'yes' : 'no',
            isSoundTrigger: 'no',
            isColorTrigger: 'no',
            isColorTriggerFg: 'no',
            isColorTriggerBg: 'no',
        }),
        (xml, n) => {
            xml.leaf('name', n.name);
            xml.leaf('script', n.code ?? '');
            xml.leaf('triggerType', '0');
            xml.leaf('conditonLineDelta', String(n.delta ?? 0));
            xml.leaf('mStayOpen', String(n.fireLength ?? 0));
            xml.leaf('mCommand', n.command ?? '');
            xml.leaf('packageName', n.packageName ?? '');
            xml.leaf('mFgColor', n.highlight?.fg || 'transparent');
            xml.leaf('mBgColor', n.highlight?.bg || 'transparent');
            xml.leaf('mSoundFile', '');
            xml.leaf('colorTriggerFgColor', '#000000');
            xml.leaf('colorTriggerBgColor', '#000000');
            xml.open('regexCodeList');
            for (const p of (n.patterns ?? [])) xml.leaf('string', p.text ?? '');
            xml.close('regexCodeList');
            xml.open('regexCodePropertyList');
            for (const p of (n.patterns ?? [])) xml.leaf('integer', String(patternTypeIndex(p.type)));
            xml.close('regexCodePropertyList');
        });
    xml.close('TriggerPackage');
}

function emitTimers(xml: XmlBuilder, nodes: TimerNode[], opts: ExportOptions): void {
    xml.open('TimerPackage');
    const childMap = buildChildrenMap(nodes);
    const roots = unwrapPackageRoots(nodes, childMap, opts);
    emitSubtree(xml, roots, childMap, 'Timer', 'TimerGroup',
        (n, g) => ({ ...baseAttrs(n.enabled, g), isTempTimer: 'no', isOffsetTimer: 'no' }),
        (xml, n) => {
            xml.leaf('name', n.name);
            xml.leaf('script', n.code ?? '');
            xml.leaf('command', n.command ?? '');
            xml.leaf('packageName', n.packageName ?? '');
            xml.leaf('time', formatTimerSeconds(n.seconds ?? 0));
        });
    xml.close('TimerPackage');
}

function emitKeys(xml: XmlBuilder, nodes: KeyNode[], opts: ExportOptions): void {
    xml.open('KeyPackage');
    const childMap = buildChildrenMap(nodes);
    const roots = unwrapPackageRoots(nodes, childMap, opts);
    emitSubtree(xml, roots, childMap, 'Key', 'KeyGroup',
        (n, g) => baseAttrs(n.enabled, g),
        (xml, n) => {
            xml.leaf('name', n.name);
            xml.leaf('packageName', n.packageName ?? '');
            xml.leaf('script', n.code ?? '');
            xml.leaf('command', n.command ?? '');
            xml.leaf('keyCode', String(CODE_TO_QT_KEY[n.key] ?? 0));
            xml.leaf('keyModifier', String(modifiersToQt(n.modifiers ?? [], n.key)));
        });
    xml.close('KeyPackage');
}

function emitButtons(xml: XmlBuilder, nodes: ButtonNode[], opts: ExportOptions): void {
    xml.open('ActionPackage');
    const childMap = buildChildrenMap(nodes);
    const roots = unwrapPackageRoots(nodes, childMap, opts);
    const idx = (arr: string[], v: string) => String(Math.max(0, arr.indexOf(v)));
    emitSubtree(xml, roots, childMap, 'Action', 'ActionGroup',
        (n, g) => ({ ...baseAttrs(n.enabled, g), isPushButton: n.isPushDown ? 'yes' : 'no', isFlatButton: 'no', useCustomLayout: 'no' }),
        (xml, n) => {
            xml.leaf('name', n.name);
            xml.leaf('packageName', n.packageName ?? '');
            xml.leaf('script', n.code ?? '');
            xml.leaf('css', n.styleSheet ?? '');
            xml.leaf('commandButtonUp', n.command ?? '');
            xml.leaf('commandButtonDown', n.commandDown ?? '');
            xml.leaf('icon', n.icon ?? '');
            xml.leaf('orientation', idx(BUTTON_ORIENTATIONS, n.orientation));
            xml.leaf('location', idx(BUTTON_LOCATIONS, n.location));
            xml.leaf('posX', String(n.posX ?? 0));
            xml.leaf('posY', String(n.posY ?? 0));
            xml.leaf('mButtonState', n.buttonState ? '2' : '1');
            xml.leaf('sizeX', String(n.sizeX ?? 0));
            xml.leaf('sizeY', String(n.sizeY ?? 0));
            xml.leaf('buttonColumn', String(n.columns ?? 0));
            xml.leaf('buttonRotation', '0');
        });
    xml.close('ActionPackage');
}

export interface SerializeInput {
    scripts: ScriptNode[];
    aliases: AliasNode[];
    triggers: TriggerNode[];
    timers: TimerNode[];
    keys: KeyNode[];
    buttons: ButtonNode[];
}

/**
 * Serialize a Mudlet-package node set back to XML. When `packageName` is supplied,
 * a top-level wrapper group of that name (the one that `applyPackageTagging`
 * inserts on import) is unwrapped — its children become package-level roots —
 * so the document round-trips back to the same structure on re-import.
 */
export function serializeMudletXml(input: SerializeInput, packageName?: string): string {
    const opts: ExportOptions = packageName
        ? { stripWrapperName: packageName, packageName }
        : {};
    const xml = new XmlBuilder();
    xml.raw('<?xml version="1.0" encoding="UTF-8"?>\n');
    xml.raw('<!DOCTYPE MudletPackage>\n');
    xml.open('MudletPackage', { version: '1.001' });
    // Package order matches Mudlet's XMLexport (Trigger, Timer, Alias, Action,
    // Script, Key) so a linked-profile write-back produces a minimal diff against
    // Mudlet's own saves.
    emitTriggers(xml, input.triggers, opts);
    emitTimers(xml,   input.timers,   opts);
    emitAliases(xml,  input.aliases,  opts);
    emitButtons(xml,  input.buttons,  opts);
    emitScripts(xml,  input.scripts,  opts);
    emitKeys(xml,     input.keys,     opts);
    xml.close('MudletPackage');
    return xml.build();
}
