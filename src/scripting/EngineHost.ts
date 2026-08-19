import type { TriggerPattern } from '../storage/schema';
import type { InstallOutcome } from './ScriptingAPI';

/**
 * The item families the tree-walking APIs accept, lowercased — Mudlet's
 * "'alias', 'button', 'script', 'keybind', 'timer' or 'trigger'", plus the
 * 'key' spelling the engine already treats as 'keybind'. Lives here rather than
 * on the engine so the no-op host below answers the same list: a runtime with no
 * engine wired has no items, but it still knows what an item type IS, and
 * reporting a valid type as invalid would send a caller looking for a typo.
 */
export const KNOWN_ITEM_TYPES: ReadonlySet<string> = new Set(
    ['alias', 'button', 'script', 'key', 'keybind', 'timer', 'trigger']);

/**
 * Everything {@link ScriptingAPI} needs from {@link ScriptingEngine}.
 *
 * `ScriptingAPI` is constructed before the engine (the engine takes the API in
 * its own constructor), so the API cannot simply hold an engine reference — the
 * dependency is genuinely circular in construction order. That used to be
 * worked around with 57 individual nullable callback fields, each with its own
 * `setXxxCallback` setter and its own `?.() ?? fallback` at the call site:
 * ~400 lines of indirection where a missed wiring failed silently at runtime.
 *
 * This interface replaces all of that with a single late-bound reference. The
 * method names are the engine's own — `ScriptingEngine` satisfies the interface
 * with the methods it already had, so binding is `api.setHost(this)` once.
 *
 * Members are grouped the way the engine groups them, not alphabetically.
 */
/** What tempComplexRegexTrigger asks for: a session-scoped trigger carrying
 *  everything a permanent one can. See ScriptingEngine.createTempComplexTrigger. */
export interface TempComplexTriggerSpec {
    name: string;
    patterns: TriggerPattern[];
    code: string;
    multiline: boolean;
    isFilter: boolean;
    multipleMatches: boolean;
    fireLength: number;
    delta: number;
    highlight?: { fg?: string; bg?: string };
}

export interface EngineHost {
    // ── Script execution & input pipeline ────────────────────────────────────

    /** Run a chunk of Lua on behalf of a clicked hyperlink. Errors are reported
     *  through the API's error channel rather than thrown. */
    runLinkCode(code: string): void;

    /** Push text through the full alias pipeline, sending it to the MUD if no
     *  alias consumes it. Backs Mudlet's `expandAlias`. */
    expandAlias(text: string, echo: boolean): void;

    /** Raise `sysDataSendRequest` and report whether a handler vetoed the send
     *  by calling `denyCurrentSend()`. */
    dispatchSendRequest(text: string): boolean;

    /** Dial a connection through the engine's load gate, so a `connect()` made
     *  during initial script load defers until scripts and triggers are ready. */
    requestConnect(url: string): void;

    /** Mudlet `reconnect()` — redial the last URL. Goes through the engine so
     *  it observes the same teardown gate as {@link requestConnect}; calling
     *  `session.reconnect()` directly would open a socket during disposal. */
    requestReconnect(): boolean;

    /** Run a synthetic batch of lines through the same pipeline as network
     *  output, so `feedTriggers` shares ordering semantics with real data. */
    processFlushBatch(groups: { text: string; type: string }[]): void;

    /** Apply any coalesced trigger/alias reloads immediately instead of on the
     *  scheduled microtask. The Mudlet `perm…`, `enableTrigger` and
     *  `disableTrigger` families take effect at once, so a script that creates
     *  or toggles a trigger and then feeds a line in the same chunk must see the
     *  new state — the microtask cannot run until that chunk returns. */
    flushPendingApplies(): void;

    /** Raise a Mudlet event with the given arguments. */
    raiseEvent(event: string, args: unknown[]): void;

    // ── Packages ─────────────────────────────────────────────────────────────

    installPackageFromVfsPath(path: string): InstallOutcome;
    uninstallPackageByName(name: string): boolean;
    getPackageNames(): string[];
    getPackageInfo(name: string): Record<string, string>;
    setPackageInfo(name: string, key: string, value: string): boolean;

    // ── Modules ──────────────────────────────────────────────────────────────

    installModuleFromPath(path: string): InstallOutcome;
    uninstallModuleByName(name: string): boolean;
    syncModuleToFile(name: string): Promise<void>;
    /** Write every module flagged to sync back out to its own file. */
    saveSyncedModules(): void;
    reloadModuleFromFile(name: string): boolean;
    setModuleSync(name: string, sync: boolean): void;
    getModuleSync(name: string): boolean;
    setModulePriority(name: string, priority: number): boolean;
    getModulePriority(name: string): number;
    getModuleNames(): string[];
    getModulePath(name: string): string | null;
    setModuleInfo(name: string, key: string, value: string): boolean;
    /** Module manifest fields as a flat record, with any Lua-set overrides
     *  applied. Null when no module by that name is installed. */
    getModuleInfoRecord(name: string): Record<string, unknown> | null;

    // ── Profile filesystem ───────────────────────────────────────────────────

    /** Rewrite VFS-relative `url(...)` references in a stylesheet to the paths
     *  the service worker serves. Returns the CSS unchanged with no VFS. */
    rewriteCss(css: string): string;

    /** Rewrite profile-local asset refs (`<img src>`, inline `style` url(...))
     *  in Lua-supplied HTML to the paths the service worker serves. Returns the
     *  HTML unchanged with no VFS. */
    rewriteHtml(html: string): string;

    /** Read raw bytes from the profile VFS, or null if missing/unreadable.
     *  Backs synchronous binary consumers such as setMovie's GIF decoder. */
    readFileBytes(path: string): Uint8Array | null;

    /** Write raw bytes into the VFS, creating parent directories. False with no
     *  VFS or when the write throws. Paths are absolute, so this also reaches
     *  outside the profile — the shared window layout lives beside the profiles
     *  folder, not inside one. */
    writeFileBytes(path: string, bytes: Uint8Array): boolean;

    /** Absolute VFS path of the directory that holds every profile folder —
     *  Mudlet's configuration directory, where files shared between profiles
     *  (the window layout) live. Null with no VFS. */
    configDirectory(): string | null;

    // ── Automation tree: enable / disable ────────────────────────────────────

    toggleScriptByName(name: string, enabled: boolean): boolean;
    toggleTriggerByName(name: string, enabled: boolean): boolean;
    toggleTimerByName(name: string, enabled: boolean): boolean;
    toggleAliasByName(name: string, enabled: boolean): boolean;
    toggleKeyByName(name: string, enabled: boolean): boolean;
    /** Null when the toolbar moved, otherwise why it did not. */
    toggleToolBarByName(name: string, show: boolean): string | null;
    setTriggerStayOpenByName(name: string, lines: number): boolean;

    // ── Automation tree: queries ─────────────────────────────────────────────

    /** The saved keybinding carrying this numeric id, or null — getKeyCode
     *  resolves a permanent key by the id permKey returned, not only by name. */
    keyNodeByNumericId(numericId: number): { key: string; modifiers: string[] } | null;

    /** Mudlet's Host::setForceMXPProcessorOn — run the in-band MXP parser with
     *  no option-91 handshake. */
    setForceMxpProcessorOn(on: boolean): void;

    /** Mudlet `exists(nameOrId, type)` — count of matching items. */
    existsByName(nameOrId: string | number, type: string): number;
    /** enable/disable a script-created temp trigger or alias by its numeric id.
     *  False when no live temp item has that id. */
    setTempItemEnabled(id: number, enabled: boolean): boolean;

    /** Mudlet `isActive(nameOrId, type)` — count of matching *active* items. */
    isActiveByName(nameOrId: string | number, type: string, checkAncestors: boolean): number;
    ancestorsById(
        id: number,
        type: string,
    ): Array<{ id: number; name: string; node: string; isActive: boolean }> | null;
    findItemsByName(name: string, type: string, exact: boolean, caseSensitive: boolean): number[] | null;
    /** Whether `type` names an item family at all. */
    isKnownItemType(type: string): boolean;
    /** Next id from the profile's single item-id sequence. Temporary items draw
     *  from it too, so a temp and a permanent item can never collide. */
    allocateItemId(): number;
    isAncestorsActiveById(id: number, type: string): boolean | null;
    getProfileStats(): Record<string, unknown>;

    // ── Automation tree: permanent-item constructors ─────────────────────────
    // Each returns the new item's numeric id, or -1 on failure (unknown parent
    // group, duplicate name, …) — Mudlet's convention.

    createPermScript(name: string, parent: string, code: string): number;
    createPermRegexTrigger(name: string, parent: string, regexes: string[], code: string): number;
    createPermSubstringTrigger(name: string, parent: string, patterns: string[], code: string): number;
    createTempComplexTrigger(spec: TempComplexTriggerSpec): number;
    removeTemporaryTriggerById(id: number): boolean;
    createPermBeginOfLineStringTrigger(name: string, parent: string, patterns: string[], code: string): number;
    createPermExactMatchTrigger(name: string, parent: string, patterns: string[], code: string): number;
    createPermPromptTrigger(name: string, parent: string, code: string): number;
    createPermAlias(name: string, parent: string, pattern: string, code: string): number;
    createPermTimer(name: string, parent: string, delay: number, code: string): number;
    /** `modifier` arrives as a Qt::KeyboardModifier int; the engine translates
     *  it back into `["ctrl", …]` strings to store on the KeyNode. */
    createPermKey(name: string, parent: string, modifier: number, key: string | number, code: string): number;
    createTempButton(toolbar: string, name: string, code: string, orientation: number): number;
    createTempButtonToolbar(name: string, orientation: number, location: number): number;

    // ── Buttons & scripts ────────────────────────────────────────────────────

    /** True when the state actually changed; false when it already was that. */
    setButtonStateByName(name: string, state: boolean): boolean;
    getButtonStateByName(name: string): boolean | null;
    /** Which of Mudlet's button refusals applies to `name`. */
    buttonKindByName(name: string): 'missing' | 'plain' | 'pushdown';
    setButtonStyleSheetByName(name: string, css: string): boolean;
    setScriptByName(name: string, code: string, pos: number): number;
    getScriptByName(name: string, pos: number): { code: string; id: number } | null;
    /** Remove the script with this numeric id; true when one was removed. */
    removeScriptById(id: number): boolean;
    /** Mudlet's killTimer/killAlias/killTrigger/killKey by permanent-item name. */
    killByName(kind: 'timer' | 'alias' | 'trigger' | 'key', name: string): boolean;

    // ── Profile lifecycle ────────────────────────────────────────────────────

    /** Mudlet `resetProfile()` — reload the profile with a fresh Lua VM. */
    resetProfile(): void;
    /** Render a map area to a PNG inside the profile VFS. */
    exportAreaImageToVfs(
        areaId: number,
        filePath: string,
        zLevel?: number,
    ): { path: string } | { error: string };
}

/**
 * The host used before a real engine is bound.
 *
 * `ScriptingAPI` outlives any single engine (a profile switch destroys the
 * engine and builds a new one), and a handful of API methods can be reached
 * during that window — so rather than making every call site re-check for null,
 * the API always holds *a* host. Each method here returns exactly the fallback
 * the old `?.() ?? …` expressions produced, keeping behaviour identical while
 * collecting the "not wired yet" policy in one readable place.
 */
export const NULL_ENGINE_HOST: EngineHost = Object.freeze({
    runLinkCode: () => {},
    expandAlias: () => {},
    dispatchSendRequest: () => false,
    requestConnect: () => {},
    requestReconnect: () => false,
    processFlushBatch: () => {},
    flushPendingApplies: () => {},
    raiseEvent: () => {},

    installPackageFromVfsPath: () => ({ ok: false, error: 'no package installer available' }),
    uninstallPackageByName: () => false,
    getPackageNames: () => [],
    getPackageInfo: () => ({}),
    setPackageInfo: () => false,

    installModuleFromPath: () => ({ ok: false, error: 'no module installer available' }),
    uninstallModuleByName: () => false,
    syncModuleToFile: () => Promise.resolve(),
    saveSyncedModules: () => {},
    reloadModuleFromFile: () => false,
    setModuleSync: () => {},
    getModuleSync: () => false,
    setModulePriority: () => false,
    getModulePriority: () => 0,
    getModuleNames: () => [],
    getModulePath: () => null,
    setModuleInfo: () => false,
    getModuleInfoRecord: () => null,

    rewriteCss: (css: string) => css,
    rewriteHtml: (html: string) => html,
    readFileBytes: () => null,
    writeFileBytes: () => false,
    configDirectory: () => null,

    toggleScriptByName: () => false,
    toggleTriggerByName: () => false,
    toggleTimerByName: () => false,
    toggleAliasByName: () => false,
    toggleKeyByName: () => false,
    toggleToolBarByName: (name: string) => `toolbar '${name}' not found`,
    setTriggerStayOpenByName: () => false,

    keyNodeByNumericId: () => null,
    setForceMxpProcessorOn: () => {},
    existsByName: () => 0,
    setTempItemEnabled: () => false,
    isActiveByName: () => 0,
    ancestorsById: () => null,
    findItemsByName: () => [],
    isKnownItemType: (type: string) => KNOWN_ITEM_TYPES.has(type.toLowerCase()),
    // Standalone sequence: with no engine wired there are no permanent items to
    // collide with, but the ids still have to be distinct from each other.
    allocateItemId: (() => { let n = 1; return () => n++; })(),
    isAncestorsActiveById: () => null,
    getProfileStats: () => ({}),

    createPermScript: () => -1,
    createPermRegexTrigger: () => -1,
    createPermSubstringTrigger: () => -1,
    createTempComplexTrigger: () => -1,
    removeTemporaryTriggerById: () => false,
    createPermBeginOfLineStringTrigger: () => -1,
    createPermExactMatchTrigger: () => -1,
    createPermPromptTrigger: () => -1,
    createPermAlias: () => -1,
    createPermTimer: () => -1,
    createPermKey: () => -1,
    createTempButton: () => -1,
    createTempButtonToolbar: () => -1,

    setButtonStateByName: () => false,
    getButtonStateByName: () => null,
    buttonKindByName: () => 'missing' as const,
    setButtonStyleSheetByName: () => false,
    setScriptByName: () => -1,
    getScriptByName: () => null,
    removeScriptById: () => false,
    killByName: () => false,

    resetProfile: () => {},
    exportAreaImageToVfs: () => ({ error: 'exportAreaImage: no profile filesystem' }),
});
