import type { AliasNode, ButtonLocation, ButtonNode, ButtonOrientation, KeyNode, ScriptNode, TimerNode, TriggerNode, TriggerPattern, TriggerPatternType } from '../storage/schema';
import { qtKeyToDomCode, qtModifiersToList, QT_KEY_UNKNOWN } from '../mud/keybindings/qtKeys';

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

function getText(el: Element, tag: string): string {
    return el.querySelector(`:scope > ${tag}`)?.textContent?.trim() ?? '';
}

// Like getText but preserves leading/trailing whitespace — use for fields where
// whitespace is semantic (trigger pattern strings, alias regex patterns).
function getRawText(el: Element, tag: string): string {
    return el.querySelector(`:scope > ${tag}`)?.textContent ?? '';
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
        if (group) parseAliases(directChildren(el, 'Alias', 'AliasGroup'), id, out);
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
            // Pattern text is preserved verbatim — leading/trailing whitespace
            // is significant for substring/exactMatch/regex matching.
            return { text: p.textContent ?? '', type: MUDLET_PATTERN_TYPES[typeIdx] ?? 'substring' };
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
        if (group) parseTimers(directChildren(el, 'Timer', 'TimerGroup'), id, out);
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
        if (group) parseButtons(directChildren(el, 'Action', 'ActionGroup'), id, out);
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
        if (group) parseKeys(directChildren(el, 'Key', 'KeyGroup'), id, out, warnings);
    }
}

export function parseMudletXml(xml: string, opts: ParseOptions = {}): MudletImportResult {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) throw new Error(`XML parse error: ${err.textContent?.split('\n')[0]}`);

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
