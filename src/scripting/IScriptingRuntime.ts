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

/** One step of a path into `_G`: the key, and whether Lua holds it as a string
 *  or a number (`myTable.name` vs `myTable[3]`). */
export interface VariablePathSegment {
    key: string;
    kind: 'string' | 'number';
}

/**
 * One edit the Variables view asks the runtime to make.
 *
 * `set` assigns `value`, read according to `valueType` — retyping to `table`
 * keeps an existing table's contents rather than emptying it. `move` renames
 * the last segment in place (which is also how the key type is changed), and
 * refuses to overwrite a key that already exists. `delete` assigns nil.
 */
export type VariableEdit =
    | { op: 'set'; path: VariablePathSegment[]; valueType: 'string' | 'number' | 'boolean' | 'table'; value: string }
    | { op: 'move'; path: VariablePathSegment[]; to: VariablePathSegment }
    | { op: 'delete'; path: VariablePathSegment[] };

/** A script's event-handler-list registration (Host::mEventHandlerMap entry):
 *  the name its handler function is looked up by, whether it may run right now
 *  (isActive() && ancestorsActive()), and the events it lists. No events means
 *  the script is not registered at all. */
export interface ScriptHandlerEntry {
    id: string;
    name: string;
    active: boolean;
    events: string[];
}

export interface IScriptingRuntime {
    load(code: string, name: string): void;
    /** Execute a code chunk once, without match context. Used for timers and
     *  keybindings. `chunkName` as for {@link runWithMatches}. */
    run(code: string, name: string, chunkName?: string): void;
    /** The error compiling `code` gives, without running it, or null when it
     *  compiles. `chunkName` is used as Lua's chunk name verbatim. */
    syntaxError?(code: string, chunkName: string): string | null;
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
    /**
     * Write one zMUD channel-102 report into the runtime's `channel102` table.
     * Both halves are the raw bytes the subnegotiation carried.
     */
    setChannel102Value(variable: number, value: number): void;
    /**
     * Write one ATCP message into the runtime's `atcp` table: `name` is the
     * dotless message name (`CharVitals`), `value` its string.
     */
    setAtcpValue(name: string, value: string): void;
    runWithMatches(
        code: string,
        name: string,
        matches: (string | undefined)[],
        multimatches?: (string | undefined)[][],
        namedGroups?: Record<string, string>,
        captureSpans?: CaptureSpan[],
        namedSpans?: Record<string, CaptureSpan>,
        fullMatchSpan?: CaptureSpan,
        /** Named captures per multimatches row, aligned with it. */
        multiNamedGroups?: (Record<string, string> | undefined)[],
        /** The chunk name Lua reports the code under — Mudlet's
         *  "Trigger: <name>" / "Alias: <name>". Without one, `name` is used
         *  as a file name ("@name"). Last, so the positional callers ahead of
         *  it are undisturbed. */
        chunkName?: string,
    ): void;
    /** Run `fn` with a fire's captures in place for selectCaptureGroup and the
     *  like, leaving the script-facing `matches` table alone — what a trigger
     *  whose command is sent, or which has no script, hands on (desktop's
     *  setCaptureGroups without the call that builds `matches`). */
    withCaptures?(
        matches: (string | undefined)[],
        captureSpans: CaptureSpan[] | undefined,
        namedSpans: Record<string, CaptureSpan> | undefined,
        fullMatchSpan: CaptureSpan | undefined,
        fn: () => void,
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
    /** Start an alias pass for `command`: {@link setCommand}, and drop what an
     *  enclosing pass kept for {@link settleCommandAfterAliasPass}. */
    setExpandedCommand?(command: string): void;
    /** End of an alias pass, at every depth: `command` holds the last command
     *  expanded unless a script set it (TLuaInterpreter::settleCommandAfterAliasPass). */
    settleCommandAfterAliasPass?(): void;
    /** Run `fn`, whose entry into the runtime is an alias's script — the only
     *  caller expandAlias() hands its own `command` back to. */
    asAliasScript?<T>(fn: () => T): T;
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
     * Bring scripts' event-handler-list registrations up to date: register,
     * re-register after a list change (to the end, as setEventHandlerList
     * does), rename, flip the active flag, or drop one (empty `events`).
     */
    syncScriptHandlers(entries: ScriptHandlerEntry[]): void;
    /** Publish one use of a server-defined MXP element as `mxp.<element>`. */
    setMxpElement(
        name: string,
        attrs: Record<string, string>,
        body?: { text: string; actions: string[] },
    ): void;
    /** Whether the capture globals are being built, when a pass a __gc
     *  finaliser starts is refused (TLuaInterpreter::buildingCaptureTables).
     *  Optional: a runtime with no finalisers never builds under one. */
    buildingCaptureTables?(): boolean;
    /** Rebuild saved Lua globals (a Mudlet `<VariablePackage>` tree) into `_G`. */
    restoreVariables(vars: MudletVariable[]): void;
    /** Snapshot the save-listed globals out of `_G` into a variable tree. */
    captureVariables(saveList: string[]): MudletVariable[];
    /** Enumerate `_G` for the Variables view: user globals as a full nested tree,
     *  built-ins flagged (and not recursed). */
    listGlobals(): LuaGlobalEntry[];
    /** Apply one Variables-view edit to `_G`. Returns null on success, or the
     *  reason it was refused. */
    editVariable(request: VariableEdit): string | null;
}
