// Parse / serialize Mudlet's profile <VariablePackage> — the GUI-flagged saved
// Lua globals block of a Mudlet profile XML. This is NOT package automation
// (triggers/aliases/…, see mudletXmlImport.ts); it's profile-level user state
// that lives in the Lua global namespace, so the profile-load path restores it
// into _G and the profile-save path captures it back out (LuaRuntime bridge,
// wired separately).
//
// Format pinned from real Mudlet 4.x output (see the round-trip test):
//   <VariablePackage>
//     <HiddenVariables />
//     <VariableGroup>                 (a table; valueType 5; children nested inside)
//       <name>demoVar</name>
//       <keyType>4</keyType>          (4 = string key, 3 = numeric key)
//       <value></value>              (empty for tables)
//       <valueType>5</valueType>
//       <Variable>                    (a leaf)
//         <name>n</name>
//         <keyType>4</keyType>
//         <value>42</value>
//         <valueType>3</valueType>    (1 boolean, 3 number, 4 string)
//       </Variable>
//       … more children, recursing into nested <VariableGroup>s …
//     </VariableGroup>
//   </VariablePackage>

import { desanitizeControlChars, sanitizeControlChars } from './mudletControlChars';

// Mudlet writes the Lua type integer (subset of LUA_T*) for both keyType and
// valueType. Only these four are ever saved; functions/userdata/threads are
// skipped by Mudlet on export and we never emit them.
export const LUA_TBOOLEAN = 1;
export const LUA_TNUMBER = 3;
export const LUA_TSTRING = 4;
export const LUA_TTABLE = 5;

/** How a variable's key is typed in its parent table. Lua only distinguishes
 *  string vs number keys here (Mudlet never saves other key types). */
export type VarKeyKind = 'string' | 'number';

/** Scalar value types we round-trip. Tables are represented by `children`. */
export type VarValueType = 'boolean' | 'number' | 'string' | 'table';

/**
 * One saved variable (or table entry). `name` is the key as written in <name>
 * — for a numeric key it's the number stringified ("7"). `value` is Mudlet's
 * string form of the scalar ("true"/"42"/"3.5"/raw string); it is '' and unused
 * for tables, whose entries live in `children`.
 */
export interface MudletVariable {
    name: string;
    keyKind: VarKeyKind;
    valueType: VarValueType;
    value: string;
    children?: MudletVariable[];
}

export interface MudletVariablePackage {
    /** <HiddenVariables> names. Round-tripped verbatim; the populated inner
     *  format is unverified (only ever observed empty) so we preserve whatever
     *  <name> entries are present without interpreting them. */
    hidden: string[];
    variables: MudletVariable[];
}

// ── parsing ──────────────────────────────────────────────────────────────────

function keyKindFromInt(n: number): VarKeyKind {
    return n === LUA_TNUMBER ? 'number' : 'string';
}

function valueTypeFromInt(n: number): VarValueType {
    switch (n) {
        case LUA_TBOOLEAN: return 'boolean';
        case LUA_TNUMBER:  return 'number';
        case LUA_TTABLE:   return 'table';
        // Anything else (incl. LUA_TSTRING) round-trips as a string so we never
        // drop a value we don't specifically recognise.
        default:           return 'string';
    }
}

/** Direct child <tag> text, preserving whitespace (string values/keys can have
 *  significant leading/trailing spaces). */
function childText(el: Element, tag: string): string {
    return desanitizeControlChars(el.querySelector(`:scope > ${tag}`)?.textContent ?? '');
}

/** Direct child <Variable>/<VariableGroup> elements (a group's table entries). */
function varChildren(el: Element): Element[] {
    return Array.from(el.children).filter(
        c => c.tagName === 'Variable' || c.tagName === 'VariableGroup',
    );
}

function parseNode(el: Element): MudletVariable {
    const name = childText(el, 'name');
    const keyKind = keyKindFromInt(Number(childText(el, 'keyType')));
    // A <VariableGroup> is always a table; trust the tag over valueType.
    if (el.tagName === 'VariableGroup' || Number(childText(el, 'valueType')) === LUA_TTABLE) {
        return { name, keyKind, valueType: 'table', value: '', children: varChildren(el).map(parseNode) };
    }
    return {
        name,
        keyKind,
        valueType: valueTypeFromInt(Number(childText(el, 'valueType'))),
        value: childText(el, 'value'),
    };
}

/** Parse a `<VariablePackage>` element. */
export function parseVariablePackage(pkg: Element): MudletVariablePackage {
    const hiddenEl = pkg.querySelector(':scope > HiddenVariables');
    const hidden = hiddenEl
        ? Array.from(hiddenEl.querySelectorAll(':scope > name')).map(n => n.textContent ?? '')
        : [];
    return { hidden, variables: varChildren(pkg).map(parseNode) };
}

/** Parse the first `<VariablePackage>` out of a full Mudlet profile XML string.
 *  Returns an empty package when there is none. */
export function parseVariablePackageXml(xml: string): MudletVariablePackage {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) throw new Error(`XML parse error: ${err.textContent?.split('\n')[0]}`);
    const pkg = doc.getElementsByTagName('VariablePackage')[0];
    return pkg ? parseVariablePackage(pkg) : { hidden: [], variables: [] };
}

/**
 * Coerce a loosely-typed variable tree (e.g. the result of `JSON.parse` on a
 * `yajl.to_string` capture from the Lua side) into well-formed `MudletVariable`s.
 * Notably, yajl can't tell an empty Lua table from an empty array, so an empty
 * `children`/root arrives as `{}` rather than `[]`; this normalises those back to
 * arrays and drops anything that isn't a recognisable node.
 */
export function normalizeVariableTree(raw: unknown): MudletVariable[] {
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeNode).filter((n): n is MudletVariable => n !== null);
}

function normalizeNode(n: unknown): MudletVariable | null {
    if (!n || typeof n !== 'object') return null;
    const o = n as Record<string, unknown>;
    const name = String(o.name ?? '');
    const keyKind: VarKeyKind = o.keyKind === 'number' ? 'number' : 'string';
    if (o.valueType === 'table') {
        const kids = Array.isArray(o.children) ? o.children : [];
        return {
            name, keyKind, valueType: 'table', value: '',
            children: kids.map(normalizeNode).filter((c): c is MudletVariable => c !== null),
        };
    }
    const valueType: VarValueType =
        o.valueType === 'boolean' ? 'boolean' : o.valueType === 'number' ? 'number' : 'string';
    return { name, keyKind, valueType, value: String(o.value ?? '') };
}

// ── serializing ──────────────────────────────────────────────────────────────

function keyTypeInt(kind: VarKeyKind): number {
    return kind === 'number' ? LUA_TNUMBER : LUA_TSTRING;
}

function valueTypeInt(t: VarValueType): number {
    switch (t) {
        case 'boolean': return LUA_TBOOLEAN;
        case 'number':  return LUA_TNUMBER;
        case 'table':   return LUA_TTABLE;
        default:        return LUA_TSTRING;
    }
}

// Element text only needs &/</> escaped; quotes are legal in text content and
// Mudlet leaves them raw there.
function escapeText(s: string): string {
    return sanitizeControlChars(s).replace(/[&<>]/g, ch => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
}

// Mudlet sorts table entries by name (codepoint) on export; capture from _G via
// pairs() is otherwise unordered, so sorting also gives us stable output.
function byName(a: MudletVariable, b: MudletVariable): number {
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function serializeNode(v: MudletVariable, indent: string): string {
    const tag = v.valueType === 'table' ? 'VariableGroup' : 'Variable';
    const inner = indent + '\t';
    const lines = [
        `${indent}<${tag}>`,
        `${inner}<name>${escapeText(v.name)}</name>`,
        `${inner}<keyType>${keyTypeInt(v.keyKind)}</keyType>`,
        `${inner}<value>${v.valueType === 'table' ? '' : escapeText(v.value)}</value>`,
        `${inner}<valueType>${valueTypeInt(v.valueType)}</valueType>`,
    ];
    if (v.valueType === 'table') {
        for (const child of [...(v.children ?? [])].sort(byName)) {
            lines.push(serializeNode(child, inner));
        }
    }
    lines.push(`${indent}</${tag}>`);
    return lines.join('\n');
}

/**
 * Serialize a `<VariablePackage>` to Mudlet's exact textual format (tab indent).
 * `indent` is the leading indent of the `<VariablePackage>` line itself (one tab
 * inside `<MudletPackage>` in a real profile). Top-level variables and table
 * children are emitted name-sorted to match Mudlet and keep output stable.
 */
export function serializeVariablePackage(pkg: MudletVariablePackage, indent = '\t'): string {
    const inner = indent + '\t';
    const lines = [`${indent}<VariablePackage>`];
    if (pkg.hidden.length === 0) {
        lines.push(`${inner}<HiddenVariables />`);
    } else {
        lines.push(`${inner}<HiddenVariables>`);
        for (const name of pkg.hidden) lines.push(`${inner}\t<name>${escapeText(name)}</name>`);
        lines.push(`${inner}</HiddenVariables>`);
    }
    for (const v of [...pkg.variables].sort(byName)) lines.push(serializeNode(v, inner));
    lines.push(`${indent}</VariablePackage>`);
    return lines.join('\n');
}
