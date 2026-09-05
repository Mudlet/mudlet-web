/**
 * `start` is the offset of the capture in the source line; `length` is the
 * capture's byte length. Used by `selectCaptureGroup` to re-select the actual
 * occurrence rather than the first textual match of the captured substring.
 */
import type { MudletVariable } from '../import/mudletVariables';

export type CaptureSpan = { start: number; length: number };

/** One `_G` entry (or nested table entry), as surfaced to the Variables view.
 *  `saveable` is false for functions/userdata/threads (shown but not flaggable,
 *  like Mudlet). `value` is a string preview for scalars; `isTable` marks a
 *  table and `children` carries its contents (populated for user globals,
 *  omitted for built-ins, which aren't recursed). `builtin` flags entries that
 *  existed at runtime boot (the default Lua + Mudlet API namespace) — hidden by
 *  default, like Mudlet. `keyKind` ('string' | 'number') distinguishes table
 *  keys for nested rows. */
export interface LuaGlobalEntry {
    name: string;
    valueType: string;
    saveable: boolean;
    value?: string;
    isTable?: boolean;
    children?: LuaGlobalEntry[];
    builtin?: boolean;
    keyKind?: string;
}

export interface IScriptingRuntime {
    load(code: string, name: string): void;
    /** Execute a code chunk once, without match context. Used for timers and keybindings. */
    run(code: string, name: string): void;
    /** Dispatch an event to user-registered handlers. Handlers run synchronously. */
    emitEvent(event: string, args: unknown[]): void;
    /**
     * Write a single GMCP message into the runtime's `gmcp` table. The leaf
     * at `path` is replaced; sibling subtrees are preserved (Mudlet parity).
     */
    setGmcpValue(path: string, value: unknown): void;
    /**
     * Write a single MSDP variable into the runtime's `msdp` table. `path` is
     * the flat top-level variable name; the top-level key is replaced.
     */
    setMsdpValue(path: string, value: unknown): void;
    /**
     * Write a single MSSP status variable into the runtime's `mssp` table.
     * `name` is the flat variable name; the value is a scalar string.
     */
    setMsspValue(name: string, value: string): void;
    runWithMatches(
        code: string,
        name: string,
        matches: (string | undefined)[],
        multimatches?: (string | undefined)[][],
        namedGroups?: Record<string, string>,
        captureSpans?: CaptureSpan[],
        namedSpans?: Record<string, CaptureSpan>,
        fullMatchSpan?: CaptureSpan,
    ): void;
    destroy(): void;
    /** Bytes behind a path in the runtime's read-only bundled namespace, or null
     *  when it has none / the path is not one of them. Optional because it is a
     *  property of how a runtime ships its own library, not of running scripts:
     *  the Lua runtime serves `/lua/...` this way. */
    readBuiltinBytes?(path: string): Uint8Array | null;
    setCurrentLine(line: string, isPrompt: boolean): void;
    /** The line {@link setCurrentLine} last recorded. The engine reads it back
     *  to restore the outer line after a nested feedTriggers. */
    getCurrentLine(): string;
    /**
     * Mirror the last command-bar input into the Lua `command` global, matching
     * Mudlet's AliasUnit::processDataStream. Read by scripts/keys such as the
     * stock "Repeat Last Command" key (`send(command)`).
     */
    setCommand(command: string): void;
    /**
     * Evaluate a Lua-function trigger pattern. Side effects (raiseEvent, etc.)
     * always run; the trigger "matches" only when the body returns truthy.
     */
    evalTriggerPattern(code: string): boolean;

    /** Run a package's `config.lua` in an empty environment and report what it
     *  set, or why it never finished — the way Mudlet reads a manifest.
     *
     *  Optional: a runtime that cannot run one leaves the installer to read the
     *  manifest by pattern, which is enough for a well-formed config.lua and
     *  cannot tell a manifest that would raise from one that would not. */
    readPackageConfig?(source: string): { ok: true; info: Record<string, string> } | { ok: false; reason: string };
    /**
     * Raise sysDataSendRequest and report whether a handler called
     * denyCurrentSend().
     */
    dispatchSendRequest(text: string): boolean;
    /**
     * Start a speedwalk between two rooms (Mudlet Host::startSpeedWalk): find
     * the path and hand it to the mapper package's `doSpeedWalk`. Driven by the
     * map's double-click-to-walk gesture via WindowManager.startSpeedWalk.
     */
    startSpeedWalk(from: number, to: number): void;
    /**
     * Kill every event handler registered by `wrapScript` for the given
     * script id. Called when a script is removed or disabled so its handlers
     * stop firing without waiting for a full runtime reload.
     */
    killScriptHandlers(scriptId: string): void;
    /**
     * True when a script-created (temp) alias/trigger with this id is live and of
     * the given type. Backs exists(id, "alias"/"trigger") for temp items, which
     * (unlike permanent items) don't live in the persisted store.
     */
    tempItemExists(id: number, type: string): boolean;
    /** A live temp item of `type` carrying this script-supplied name (Mudlet's
     *  tempComplexRegexTrigger is the one temp API that takes one), or null. */
    tempItemIdByName(name: string, type: string): number | null;
    /** Publish one use of a server-defined MXP element as `mxp.<element>`. */
    setMxpElement(name: string, attrs: Record<string, string>): void;
    /** Whether a live temp item is enabled — backs `isActive(id, type)`. */
    tempItemEnabled(id: number): boolean;
    /** enable/disable a live temp item by id — backs enableTrigger/disableTrigger
     *  (and the alias pair) when handed the numeric id rather than a name. */
    setTempItemEnabled(id: number, enabled: boolean): boolean;
    /** Free every temp item killed since the last call, or only those of `type`.
     *  A killed item stops firing immediately but stays findable until here,
     *  which is Mudlet's deferred per-unit cleanup: aliases are reaped when
     *  nested alias processing unwinds, triggers when the line batch finishes. */
    reapKilledTempItems(type?: 'alias' | 'trigger'): void;
    /** Rebuild saved Lua globals (a Mudlet `<VariablePackage>` tree) into `_G`. */
    restoreVariables(vars: MudletVariable[]): void;
    /** Snapshot the save-listed globals out of `_G` into a variable tree. */
    captureVariables(saveList: string[]): MudletVariable[];
    /** Enumerate `_G` for the Variables view: user globals as a full nested tree,
     *  built-ins flagged (and not recursed). */
    listGlobals(): LuaGlobalEntry[];
}
