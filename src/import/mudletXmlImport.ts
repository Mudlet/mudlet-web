import type { AliasNode, ButtonLocation, ButtonNode, ButtonOrientation, KeyNode, ScriptNode, TimerNode, TriggerNode, TriggerPattern, TriggerPatternType } from '../storage/schema';
import { asButtonRotation } from '../storage/schema';
import { qtKeyToDomCode, qtModifiersToList, QT_KEY_UNKNOWN } from '../mud/keybindings/qtKeys';
import { desanitizeControlChars } from './mudletControlChars';
import { remapLegacyColorPattern } from '../mud/triggers/legacyColorPatterns';
import { parseVariablePackage, type MudletVariable } from './mudletVariables';

// Mudlet triggerType integer → our TriggerPatternType
const MUDLET_PATTERN_TYPES: TriggerPatternType[] = [
    'substring',    // 0
    'regex',        // 1
    'startOfLine',  // 2
    'exactMatch',   // 3
    'luaFunction',  // 4
    'lineSpacer',   // 5
    'colorTrigger', // 6
    'prompt',       // 7
];

// Both accessors decode Mudlet's control-character placeholders. Desktop only
// decodes the <script> element (XMLimport.cpp, readScriptElement) and so reads
// a pattern or name containing one back mangled; decoding everywhere costs
// nothing — the placeholder lead never occurs in real content — and recovers
// those too.
function getText(el: Element, tag: string): string {
    return desanitizeControlChars(el.querySelector(`:scope > ${tag}`)?.textContent?.trim() ?? '');
}

// Like getText but preserves leading/trailing whitespace — use for fields where
// whitespace is semantic (trigger pattern strings, alias regex patterns).
function getRawText(el: Element, tag: string): string {
    return desanitizeControlChars(el.querySelector(`:scope > ${tag}`)?.textContent ?? '');
}

function isYes(el: Element, attr: string): boolean {
    return el.getAttribute(attr) === 'yes';
}

function directChildren(el: Element, leaf: string, group: string): Element[] {
    const containerEl = Array.from(el.children).find(c => c.tagName === 'children');
    const container = containerEl ?? el;
    return Array.from(container.children).filter(c => c.tagName === leaf || c.tagName === group);
}

function isGroup(el: Element): boolean {
    return isYes(el, 'isFolder') || el.tagName.endsWith('Group');
}

// Timer: "HH:MM:SS.mmm" or "MM:SS.mmm" → seconds
function parseTimerTime(s: string): number {
    const parts = s.split(':');
    if (parts.length === 3) {
        return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
    }
    if (parts.length === 2) {
        return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
    }
    return parseFloat(s) || 0;
}

export interface MudletImportResult {
    scripts: ScriptNode[];
    aliases: AliasNode[];
    triggers: TriggerNode[];
    timers: TimerNode[];
    keys: KeyNode[];
    buttons: ButtonNode[];
    warnings: string[];
    /**
     * The globals a `<VariablePackage>` carries, if any. A package may be
     * nothing BUT these — a module of variables, fonts, images or a map loads
     * completely and still leaves every one of the six item units empty — so an
     * install that only looked at the units took such a package for one that had
     * installed nothing at all.
     */
    variables?: MudletVariable[];
    /**
     * Why the document could not be read, when it could not. Set only for a
     * caller that asked to be TOLD rather than thrown at — an install carries on
     * with whatever loaded and reports the failure, because the package is
     * listed either way and a silent one is a package the player cannot account
     * for.
     */
    parseError?: string;
}

// Mudlet TAction.mLocation: 0=top, 1=bottom, 2=left, 3=right, 4=floating
const MUDLET_BUTTON_LOCATIONS: ButtonLocation[] = ['top', 'bottom', 'left', 'right', 'floating'];
// Mudlet TAction.mOrientation: 0=horizontal, 1=vertical
const MUDLET_BUTTON_ORIENTATIONS: ButtonOrientation[] = ['horizontal', 'vertical'];

export interface ParseOptions {
    /**
     * When set, every parsed node is tagged with this packageName, and a
     * top-level group of the same name is prepended to each non-empty
     * category as a parent for the imported tree. This mirrors Mudlet's
     * .mpackage import behaviour: items are organisationally grouped and
     * cleanly removable by tag.
     */
    packageName?: string;
    /**
     * Report a malformed document instead of throwing on it. An install wants
     * this: Mudlet's reader keeps whatever it read before the break and leaves
     * the package listed, so throwing here would refuse an install Mudlet
     * completes.
     */
    reportParseError?: boolean;
}

function parseScripts(els: Element[], parentId: string | null, out: ScriptNode[]): void {
    for (const el of els) {
        const id = crypto.randomUUID();
        const group = isGroup(el);
        const handlerListEl = Array.from(el.children).find(c => c.tagName === 'eventHandlerList');
        const eventHandlers = Array.from(handlerListEl?.children ?? [])
            .filter(c => c.tagName === 'string')
            .map(s => s.textContent?.trim() ?? '').filter(Boolean);
        out.push({ id, parentId, isGroup: group, name: getText(el, 'name'), enabled: isYes(el, 'isActive'), code: getText(el, 'script'), language: 'lua', eventHandlers, packageName: getText(el, 'packageName') || undefined });
        // Scripts (like triggers) can nest under a NON-folder parent: Mudlet's
        // TScript model lets a script carry both its own body and child scripts,
        // and its export nests the children directly inside the parent <Script>
        // (e.g. a "themes" script holding "dark"/"light"). Recurse
        // unconditionally — directChildren is empty for true leaves, so this is a
        // no-op there — otherwise those children are silently dropped and never
        // loaded (which broke packages like Muxlet whose theme registration lives
        // in such nested scripts).
        parseScripts(directChildren(el, 'Script', 'ScriptGroup'), id, out);
    }
}

function parseAliases(els: Element[], parentId: string | null, out: AliasNode[]): void {
    for (const el of els) {
        const id = crypto.randomUUID();
        const group = isGroup(el);
        out.push({ id, parentId, isGroup: group, name: getText(el, 'name'), enabled: isYes(el, 'isActive'), pattern: getRawText(el, 'regex'), command: getText(el, 'command'), code: getText(el, 'script'), language: 'lua', packageName: getText(el, 'packageName') || undefined });
        // Recurse unconditionally: desktop's readers descend into nested children
        // whatever `isFolder` says (XMLimport.cpp:1587 for Alias), and a non-folder
        // parent with children is a shape real packages ship. directChildren is
        // empty for true leaves, so this is a no-op there.
        parseAliases(directChildren(el, 'Alias', 'AliasGroup'), id, out);
    }
}

/**
 * The colorizer colours (XMLimport.cpp:1404 mFgColor, :1407 mBgColor). Mudlet
 * writes "transparent" for a channel left on "keep" — and older saves an empty
 * element — so only a real colour becomes one.
 *
 * Read regardless of isColorizerTrigger, which is carried separately: TTrigger
 * holds the colours independently of the switch (defaulting them to red/yellow
 * and exporting them either way), so gating on it here would erase a disabled
 * trigger's colours from the user's profile on the next link-mode flush.
 */
function parseHighlight(el: Element): TriggerNode['highlight'] {
    const colour = (tag: string): string | undefined => {
        const v = getText(el, tag);
        return v && v !== 'transparent' ? v : undefined;
    };
    const fg = colour('mFgColor');
    const bg = colour('mBgColor');
    return fg || bg ? { fg, bg } : undefined;
}

function parseTriggers(els: Element[], parentId: string | null, out: TriggerNode[]): void {
    for (const el of els) {
        if (isYes(el, 'isTempTrigger')) continue;
        const id = crypto.randomUUID();
        const group = isGroup(el);

        const codeListEl = Array.from(el.children).find(c => c.tagName === 'regexCodeList');
        const propListEl = Array.from(el.children).find(c => c.tagName === 'regexCodePropertyList');
        const patternEls = Array.from(codeListEl?.children ?? []).filter(c => c.tagName === 'string');
        const typeEls    = Array.from(propListEl?.children ?? []).filter(c => c.tagName === 'integer');

        const patterns: TriggerPattern[] = patternEls.map((p, i) => {
            const typeIdx = parseInt(typeEls[i]?.textContent?.trim() ?? '0') || 0;
            const type = MUDLET_PATTERN_TYPES[typeIdx] ?? 'substring';
            // Pattern text is preserved verbatim — leading/trailing whitespace
            // is significant for substring/exactMatch/regex matching.
            const text = desanitizeControlChars(p.textContent ?? '');
            // ...except a colour pattern from before Mudlet 3.17, which carries
            // an old palette index in a form nothing downstream understands.
            // Desktop rewrites it here too, unconditionally on every read
            // (XMLimport.cpp:1425). See legacyColorPatterns.
            return { text: type === 'colorTrigger' ? remapLegacyColorPattern(text) : text, type };
        });
        if (patterns.length === 0 && !group) patterns.push({ text: '', type: 'substring' });

        out.push({
            id, parentId, isGroup: group,
            name: getText(el, 'name'),
            enabled: isYes(el, 'isActive'),
            patterns,
            code: getText(el, 'script'),
            language: 'lua',
            command: getText(el, 'mCommand'),
            fireLength: parseInt(getText(el, 'mStayOpen')) || 0,
            multipleMatches: isYes(el, 'isPerlSlashGOption'),
            multiline: isYes(el, 'isMultiline'),
            delta: parseInt(getText(el, 'conditonLineDelta')) || 0,
            isFilter: isYes(el, 'isFilterTrigger'),
            // The node-level trigger kind (XMLimport.cpp:1380). Not the same
            // thing as the per-pattern kinds above, and desktop restores it on
            // load and on paste (EditorItemXMLHelpers.cpp:316), so dropping it
            // and writing 0 back rewrites the user's own profile.
            triggerType: parseInt(getText(el, 'triggerType')) || undefined,
            // Sound trigger (XMLimport.cpp:1358 for the switch, :1406 for the
            // file). TTrigger::execute plays the file on every fire.
            soundTrigger: isYes(el, 'isSoundTrigger') || undefined,
            soundFile: getText(el, 'mSoundFile') || undefined,
            // Legacy per-node colour trigger (XMLimport.cpp:1359 for the switch,
            // :1393/:1395 for the colours). Inert here — see TriggerNode — but
            // desktop keeps it across a save/load and so must we.
            //
            // Its isColorTriggerFg / isColorTriggerBg companions are deliberately
            // absent: desktop writes them from mColorTriggerFgAnsi/BgAnsi
            // (XMLexport.cpp:1009-1010) and never reads them back, so they carry
            // nothing a reload could restore.
            colorTrigger: isYes(el, 'isColorTrigger') || undefined,
            colorTriggerFgColor: getText(el, 'colorTriggerFgColor') || undefined,
            colorTriggerBgColor: getText(el, 'colorTriggerBgColor') || undefined,
            colorize: isYes(el, 'isColorizerTrigger'),
            highlight: parseHighlight(el),
            packageName: getText(el, 'packageName') || undefined,
        });
        // Triggers (unlike scripts/aliases/timers/keys) can nest under a non-folder
        // parent: Mudlet's chain-trigger model lets any trigger with children act as
        // a chain head, gating its descendants for `mStayOpen` lines after it fires.
        parseTriggers(directChildren(el, 'Trigger', 'TriggerGroup'), id, out);
    }
}

function parseTimers(els: Element[], parentId: string | null, out: TimerNode[]): void {
    for (const el of els) {
        if (isYes(el, 'isTempTimer')) continue;
        const id = crypto.randomUUID();
        const group = isGroup(el);
        out.push({ id, parentId, isGroup: group, name: getText(el, 'name'), enabled: isYes(el, 'isActive'), seconds: parseTimerTime(getText(el, 'time')), code: getText(el, 'script'), language: 'lua', command: getText(el, 'command'), repeat: true, packageName: getText(el, 'packageName') || undefined });
        // Unconditional, as in desktop's readTimerGroup (XMLimport.cpp:1517).
        parseTimers(directChildren(el, 'Timer', 'TimerGroup'), id, out);
    }
}

function parseButtons(els: Element[], parentId: string | null, out: ButtonNode[]): void {
    for (const el of els) {
        const id = crypto.randomUUID();
        const group = isGroup(el);

        const locIdx = parseInt(getText(el, 'location'));
        const oriIdx = parseInt(getText(el, 'orientation'));

        // Mudlet stores stylesheet under <css> on Action/ActionGroup nodes.
        const cssEl = Array.from(el.children).find(c => c.tagName === 'css' || c.tagName === 'stylesheetText');
        const styleSheet = cssEl?.textContent?.trim() || undefined;

        const node: ButtonNode = {
            id, parentId, isGroup: group,
            name: getText(el, 'name'),
            enabled: isYes(el, 'isActive'),
            orientation: MUDLET_BUTTON_ORIENTATIONS[oriIdx] ?? 'horizontal',
            location: MUDLET_BUTTON_LOCATIONS[locIdx] ?? 'top',
            columns: parseInt(getText(el, 'buttonColumn')) || 0,
            fillerOffset: parseInt(getText(el, 'buttonFillerOffset')) || undefined,
            rotation: asButtonRotation(parseInt(getText(el, 'buttonRotation'))),
            posX: parseInt(getText(el, 'posX')) || undefined,
            posY: parseInt(getText(el, 'posY')) || undefined,
            sizeX: parseInt(getText(el, 'sizeX')) || undefined,
            sizeY: parseInt(getText(el, 'sizeY')) || undefined,
            isPushDown: isYes(el, 'isPushButton'),
            // mButtonState: Mudlet stores 1=up, 2=down.
            buttonState: parseInt(getText(el, 'mButtonState')) === 2,
            icon: getText(el, 'icon') || undefined,
            tooltip: getText(el, 'tooltipText') || undefined,
            code: getText(el, 'script'),
            language: 'lua',
            command:     getText(el, 'commandButtonUp')   || undefined,
            commandDown: getText(el, 'commandButtonDown') || undefined,
            styleSheet,
            packageName: getText(el, 'packageName') || undefined,
        };
        out.push(node);
        // Unconditional, as in desktop's readActionGroup (XMLimport.cpp:1685).
        parseButtons(directChildren(el, 'Action', 'ActionGroup'), id, out);
    }
}

function parseKeys(els: Element[], parentId: string | null, out: KeyNode[], warnings: string[]): void {
    for (const el of els) {
        const id = crypto.randomUUID();
        const group = isGroup(el);
        const qtKey = parseInt(getText(el, 'keyCode')) || 0;
        const qtMod = parseInt(getText(el, 'keyModifier')) || 0;
        // "No key bound" has three spellings across Mudlet's history: Qt::Key(0),
        // Qt::Key_unknown (current), and -1 (the sentinel dlgTriggerEditor used
        // back when mKeyCode was a plain int). TKey::validateKeyBinding treats
        // them all as unset, so none of them is a broken import worth warning about.
        const unbound = qtKey === 0 || qtKey === -1 || qtKey === QT_KEY_UNKNOWN;
        // qtKeyToDomCode returns String(qtKey) as fallback for unmapped codes;
        // valid DOM codes always start with a letter, so the regex separates them.
        const mapped = unbound ? '' : qtKeyToDomCode(qtKey, qtMod);
        const key = /^[A-Za-z]/.test(mapped) ? mapped : '';
        if (!group && !key && !unbound) {
            warnings.push(`Key "${getText(el, 'name')}": unknown Qt key code ${qtKey} — keybinding imported with no key set`);
        }
        out.push({ id, parentId, isGroup: group, name: getText(el, 'name'), enabled: isYes(el, 'isActive'), key, modifiers: qtModifiersToList(qtMod), code: getText(el, 'script'), language: 'lua', command: getText(el, 'command'), packageName: getText(el, 'packageName') || undefined });
        // Unconditional, as in desktop's readKeyGroup (XMLimport.cpp:1816).
        parseKeys(directChildren(el, 'Key', 'KeyGroup'), id, out, warnings);
    }
}

/**
 * Warn about offset timers, which this client has no equivalent for.
 *
 * There is no `isOffsetTimer` element to read: in Mudlet a timer is an *offset*
 * timer purely by where it sits in the tree — "children of folder = regular
 * timers, children of timers = offset timers" (TTimer.h:75-84). Such a timer
 * never runs on its own clock. Its interval is measured from the moment its
 * parent fires (TTimer.cpp:255-265), and the normal start/stop walk skips it
 * entirely (TTimer.cpp:314, :329). Nothing here reproduces that, so whatever
 * happens to the nested timer, it is not what the profile asked for.
 *
 * Read off the document rather than the parsed tree so the warning does not
 * depend on whether the reader descended into the nested elements — the
 * shape is visible in the XML either way.
 */
function collectOffsetTimerWarnings(doc: Document, warnings: string[]): void {
    for (const pkg of Array.from(doc.getElementsByTagName('TimerPackage'))) {
        for (const el of Array.from(pkg.getElementsByTagName('Timer'))) {
            if (isGroup(el)) continue;
            const nested = directChildren(el, 'Timer', 'TimerGroup');
            if (nested.length === 0) continue;
            const names = nested.map(c => `"${getText(c, 'name')}"`).join(', ');
            warnings.push(
                `Timer "${getText(el, 'name')}" contains ${names}: Mudlet runs a timer nested under `
                + 'another timer as an offset timer, counting its interval from when the parent fires. '
                + 'This client has no offset timers, so those will not keep that relationship',
            );
        }
    }
}

/**
 * Everything before the line a parser error names, so what follows the break is
 * dropped rather than half-read. Returns the whole document when the message
 * carries no line, in which case the repair below simply has nothing to trim.
 */
function truncateAtError(xml: string, errorText: string): string {
    const line = /error on line (\d+)/i.exec(errorText);
    if (!line) return xml;
    const lines = xml.split('\n');
    const cut = Math.max(0, Number(line[1]) - 1);
    return lines.slice(0, cut).join('\n');
}

/**
 * Close the elements a truncated document left open, innermost first, so it
 * parses as the document it was on its way to being.
 *
 * A last line cut mid-tag cannot be closed into anything valid, so it is dropped
 * before the scan. Comments, CDATA, declarations and self-closing tags open
 * nothing and are stepped over.
 */
function closeOpenTags(xml: string): string | null {
    const lastOpen = xml.lastIndexOf('<');
    const body = lastOpen > xml.lastIndexOf('>') ? xml.slice(0, lastOpen) : xml;
    const stack: string[] = [];
    const tag = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[!?][^>]*>|<\/?([A-Za-z_][\w.:-]*)([^>]*)>/g;
    for (let m = tag.exec(body); m; m = tag.exec(body)) {
        const name = m[1];
        if (!name) continue;                       // comment, CDATA, declaration
        if (m[0].startsWith('</')) {
            const at = stack.lastIndexOf(name);
            if (at >= 0) stack.length = at;        // also closes anything left open inside
            continue;
        }
        if (!m[2]?.trimEnd().endsWith('/')) stack.push(name);
    }
    if (stack.length === 0) return null;           // nothing was open: no repair to make
    return body + stack.reverse().map(n => `</${n}>`).join('');
}

export function parseMudletXml(xml: string, opts: ParseOptions = {}): MudletImportResult {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) {
        const reason = `XML parse error: ${err.textContent?.split('\n')[0]}`;
        if (!opts.reportParseError) throw new Error(reason);
        // Mudlet reads a package XML with a STREAMING reader, so a document that
        // stops part-way keeps everything it had already read — the items above
        // the break are installed and the package runs. DOMParser is all or
        // nothing, so the document is repaired instead: cut at the line the
        // error names and close whatever was still open. What comes back is the
        // same items a streaming reader would have had, and the failure is still
        // reported either way.
        const repaired = closeOpenTags(truncateAtError(xml, err.textContent ?? ''));
        if (repaired) {
            const retry = new DOMParser().parseFromString(repaired, 'text/xml');
            if (!retry.getElementsByTagName('parsererror')[0]) {
                const result = parseMudletXml(repaired, { ...opts, reportParseError: false });
                return { ...result, warnings: [...result.warnings, reason], parseError: reason };
            }
        }
        return {
            scripts: [], aliases: [], triggers: [], timers: [], keys: [], buttons: [],
            warnings: [reason], parseError: reason,
        };
    }

    function pkgChildren(pkgTag: string, leaf: string, group: string): Element[] {
        return Array.from(doc.getElementsByTagName(pkgTag))
            .flatMap(pkg => Array.from(pkg.children).filter(c => c.tagName === leaf || c.tagName === group));
    }

    const result: MudletImportResult = { scripts: [], aliases: [], triggers: [], timers: [], keys: [], buttons: [], warnings: [] };
    parseScripts( pkgChildren('ScriptPackage',  'Script',  'ScriptGroup'),  null, result.scripts);
    parseAliases( pkgChildren('AliasPackage',   'Alias',   'AliasGroup'),   null, result.aliases);
    parseTriggers(pkgChildren('TriggerPackage', 'Trigger', 'TriggerGroup'), null, result.triggers);
    parseTimers(  pkgChildren('TimerPackage',   'Timer',   'TimerGroup'),   null, result.timers);
    parseKeys(    pkgChildren('KeyPackage',     'Key',     'KeyGroup'),     null, result.keys, result.warnings);
    parseButtons( pkgChildren('ActionPackage',  'Action',  'ActionGroup'),  null, result.buttons);

    collectOffsetTimerWarnings(doc, result.warnings);

    // The globals a package carries. Kept off the six unit lists deliberately:
    // they are not items, cannot be tagged, and an uninstall does not take them
    // away — but a package may be nothing but these, and one that ignored them
    // read such a package as having installed nothing at all.
    const variablePkg = doc.getElementsByTagName('VariablePackage')[0];
    if (variablePkg) {
        const vars = parseVariablePackage(variablePkg).variables;
        if (vars.length > 0) result.variables = vars;
    }

    if (opts.packageName) {
        applyPackageTagging(result, opts.packageName);
    }
    return result;
}

/**
 * Wraps each non-empty category in a top-level group named after the package
 * and tags every node (wrapper included) with `packageName`. This is what makes
 * the imported items recognisable as a unit at uninstall time.
 */
function applyPackageTagging(result: MudletImportResult, packageName: string): void {
    type AnyNode = ScriptNode | AliasNode | TriggerNode | TimerNode | KeyNode | ButtonNode;
    const wrap = <T extends AnyNode>(arr: T[], makeGroup: (id: string) => T): T[] => {
        if (arr.length === 0) return arr;
        const groupId = crypto.randomUUID();
        for (const n of arr) {
            n.packageName = packageName;
            if (n.parentId === null) n.parentId = groupId;
        }
        const wrapper = makeGroup(groupId);
        wrapper.packageName = packageName;
        return [wrapper, ...arr];
    };

    result.scripts = wrap(result.scripts, id => ({
        id, parentId: null, isGroup: true, name: packageName, enabled: true,
        code: '', language: 'lua', eventHandlers: [],
    }));
    result.aliases = wrap(result.aliases, id => ({
        id, parentId: null, isGroup: true, name: packageName, enabled: true,
        pattern: '', command: '', code: '', language: 'lua',
    }));
    result.triggers = wrap(result.triggers, id => ({
        id, parentId: null, isGroup: true, name: packageName, enabled: true,
        patterns: [], code: '', language: 'lua',
        fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false,
    }));
    result.timers = wrap(result.timers, id => ({
        id, parentId: null, isGroup: true, name: packageName, enabled: true,
        seconds: 0, code: '', language: 'lua', repeat: false,
    }));
    result.keys = wrap(result.keys, id => ({
        id, parentId: null, isGroup: true, name: packageName, enabled: true,
        key: '', modifiers: [], code: '', language: 'lua',
    }));
    result.buttons = wrap(result.buttons, id => ({
        id, parentId: null, isGroup: true, name: packageName, enabled: true,
        orientation: 'horizontal', location: 'top', columns: 0,
        isPushDown: false, buttonState: false,
        code: '', language: 'lua',
    }));
}
