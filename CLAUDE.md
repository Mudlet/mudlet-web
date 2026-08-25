# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
yarn dev         # Start Vite dev server
yarn build       # TypeScript check + production build (tsc && vite build)
yarn preview     # Preview production build
yarn typecheck   # Type-check (tsc -p tsconfig.test.json — covers src + tests)
yarn test        # Run the Vitest suite once
yarn test:watch  # Vitest in watch mode
```

Tests live in `tests/` and run through Vite (so `?raw` Lua imports, `import.meta.glob`, and
JSON imports resolve exactly as in the app build). The default environment is `happy-dom`;
Lua/runtime suites opt into the `node` environment per-file (`// @vitest-environment node`) so
wasmoon/pcre2 WASM loads from the filesystem. See `tests/setup.ts` and `vitest.config.ts`.

A standalone telnet→WebSocket proxy lives in `proxy/` (run `yarn` then `yarn start` there);
deploys to GitHub Pages via `.github/workflows/deploy.yml` on push to `master`.

## What This Is

Mudlet Web is a **web-based MUD (Multi-User Dungeon) client** built with React + TypeScript — the browser edition of Mudlet. It connects to MUD servers over WebSocket (directly or through a telnet proxy) with full telnet/GMCP/MSDP/MSSP/MCCP/MSP support, renders ANSI-colored output, runs **Mudlet Lua scripting** in the browser, and aims for drop-in compatibility with Mudlet packages, maps, and the XML profile format. It ships a custom dock/float multi-panel UI, a per-profile virtual filesystem, an in-browser SQLite database, and session logging.

> **Naming.** The project was renamed from *mudix* to *Mudlet Web*. Internal identifiers deliberately kept the old name: the `mudix_*` storage keys (localStorage + IndexedDB) and the `.mudix/` VFS directory (renaming orphans existing users' profiles), the `__mudix_*` Lua globals in `Bridge.lua` (name-paired with their JS call sites), and the `.mudix-*` CSS classes (a documented brand-styling API). Don't rename these opportunistically. The library entry points *did* follow the rename: the package is `@mudlet/mudlet-web` (npm), the app root export is `MudletWebApp` (`src/MudletWebApp.tsx`), and no `MudixApp` alias is kept.

Key libraries: `wasmoon-lua5.1` (WASM-compiled Lua 5.1), `pcre2-wasm-universal` (PCRE regex for triggers/aliases), `@sqlite.org/sqlite-wasm` (the `db:*` API), `@zenfs/core` + `@zenfs/dom` (the profile VFS), `mudlet-map-binary-reader`/`-renderer`/`-editor` (map files), `zustand` (state), `pako`/`fflate` (compression), `@codemirror/*` (the script editor), `dompurify` + `marked` (HTML/markdown panels).

## Architecture Overview

### Event-Driven Core

`MudSession` owns a `MudClient`, a typed `EventBus` (`src/core/EventBus.ts`), the `Console` registry, the `WindowManager`, and the `SessionLogger`. All MUD activity flows through `session.events`:

```
MudClient (WebSocket — direct or via telnet proxy)
  → telnet/protocol parsing (GMCP, MSDP, MSSP, MCCP, MSP, CHARSET, TTYPE/MTTS)
  → MudSession.events (flushLines, message, prompt, gmcp, msdp, mssp, msp,
                       status, ping, client.connect/disconnect, *.negotiated, ...)
    → ScriptingEngine (Lua handlers, alias/trigger/timer/key engines)
    → React components (OutputArea, Toolbar, panels)
    → SessionLogger (persists output to IndexedDB)
```

### Connection & Protocols

`MudClient` (`src/mud/connection/MudClient.ts`) speaks telnet over a WebSocket using binary frames. Two connection modes (`MudConnection.mode` in `storage/schema.ts`):
- **`websocket`** — connect directly to a `ws(s)://` URL (servers that expose a native WebSocket endpoint).
- **`mud`** — connect to a raw `host:port` through the telnet→WebSocket **proxy** (`proxy/server.ts`, default URL overridable per-profile). The browser can't open raw TCP, so the proxy bridges it.

Protocol handlers live in `src/mud/protocol/`: **GMCP** (201), **MSDP**, **MSSP** (server status), **MCCP** (compression via pako), **MSP** (sound), plus telnet **CHARSET**, **TTYPE/MTTS**, **ECHO**, and GA/EOR prompt detection. `index.ts` re-exports the option codes and stream factories `MudClient` wires together. The client latches into "GA-driven" prompt mode once a server sends IAC GA/EOR; otherwise it flushes trailing partial lines after `promptTimeoutMs` (default 300ms).

### Command Processing Pipeline

```
User input (CommandBar)
  → App.handleSend()
  → ScriptingEngine.processInput(text)
      → AliasEngine.processTemp()   // JS temp aliases
      → AliasEngine.matchPerm()     // JS permanent aliases
      → LuaRuntime.processInput()   // PCRE regex aliases in Lua
  → if not consumed: session.send(text)
```

### Scripting Architecture

**`ScriptingEngine`** orchestrates runtimes via the **`IScriptingRuntime`** interface (`load`, `emitEvent`, `processInput`, `runWithMatches`, `destroy`). Only Lua is implemented today but the interface is designed for extension. The engine also owns the JS-side automation engines (`AliasEngine`, `TriggerEngine`, `TimerEngine`, `KeyEngine`), the per-profile VFS lifecycle, and profile-data load/save.

**`LuaRuntime`** uses wasmoon-lua5.1 to run Lua 5.1 in the browser. The API surface is **Mudlet-native global functions**, not a namespaced table — the goal is drop-in compatibility with real Mudlet scripts and packages:

```lua
send(text)                        -- send command to MUD
echo / cecho / decho / hecho      -- output (plain, Mudlet-color, decimal-RGB, hex-RGB)
tempTimer(secs, code) / tempAlias / tempTrigger / tempRegexTrigger
openUserWindow / cecho to window / setWindowWrap / ...
gmcp / msdp                        -- auto-populated tables from GMCP/MSDP packets
matches / multimatches             -- capture groups inside trigger/alias handlers
db:* (sqlite), io.* / lfs (VFS), rex (PCRE)
```

> **Do not invent a `mudix.*` table** — older docs reference one, but it was never bound. Use the Mudlet-native globals. See `MUDLET_API.md` for the full implementation checklist and `luaCompletions.ts` for the autocomplete catalogue (every new global must be added there too).

Bundled Mudlet Lua (`src/scripting/lua/mudlet-lua/`) is loaded at startup: `LuaGlobal.lua`, GUI/Geyser, the generic mapper, string/table/db utilities, plus shims (`Luasql.lua` → sqlite-wasm, `VFS.lua`, `Yajl.lua`, `utf8.lua`, `rex` via `pcre2-wasm`). **Order matters**: JS globals must be bound *before* `LuaGlobal.lua` runs, because Other.lua installs `if not X then X = dummy` stubs that would otherwise shadow real bindings. Never bind a global named `debug` — bundled code calls `debug.getinfo/traceback`.

**`ScriptingAPI`** is the bridge layer — it translates Lua calls into MUD sends, window/overlay operations, timer scheduling, file I/O, SQL, sound/TTS/video, etc. It holds references to `MudSession`, `WindowManager`, and the profile's `ProfileVFS`.

Scripts/aliases/triggers/timers/keys/buttons are stored per-connection in Zustand as Mudlet-style trees (`isGroup` + `parentId`; see `storage/schema.ts`). When the active connection changes, the old `LuaRuntime` is destroyed and a fresh one is created, loading each script sequentially. **Teardown ordering**: stop the timer engine (the only autonomous Lua caller) before `lua_close`.

### Window/Docking System

The UI uses a **custom dock/float layout** (`src/ui/layout/`) — dockview was removed. `ContentLayout` is the root: it renders the main `OutputArea`, the docked-panel regions, and the floating layer.

- **`DockArea`** — panels docked to the four sides (left/right/top/bottom) with resizable extents.
- **`FloatingWindowLayer`** — free-floating windows (`ScriptWindow`) rendered via portals; draggable/resizable.
- **`SplitGroupPanel` / `TabGroupPanel`** — group multiple panels into splits or tab stacks.
- **`dockDetect.ts`** — drag-to-dock hit-testing; **`WindowContextMenu`** — per-window actions.

**`WindowManager`** (`src/ui/windows/WindowManager.ts`): Adapter between the scripting API and the layout. Owns the panel registry, buffers writes before a panel mounts, and queues deferred opens. Panel types: `TextPanel` (script-written ANSI text), `HtmlPanel` (raw HTML injection), `MapPanel` (Mudlet binary map renderer). It also backs map APIs via a live `MapControl` handle registered by `MapPanel`.

Overlay-based Geyser widgets (mini-consoles, labels, gauges, command lines) are separate from docked panels — they're absolutely-positioned HTML in overlay layers (`LabelManager`, `CommandLineManager`) mirroring Mudlet's pixel coordinates. Layout is serialized per-connection to Zustand (debounced); live refs (`session`, `manager`) are re-injected on restore since they can't be serialized.

### Storage

**`AppStore`** (`src/storage/appStore.ts`): Zustand with `persist` middleware → `localStorage` key `mudix_v1`. Schema versioning with migration logic. The full per-connection state lives in the in-memory store, but `partialize` persists to `localStorage` **only** the global index + the small UI/layout slices read synchronously before any VFS mounts: `connections`, `client`, `connectionProfile`, `connectionWindowHints`, `connectionDockExtents`, `connectionScriptEditorBounds`, `connectionModalBounds`, `connectionLayoutSnapshots`.

**Per-profile automation data in the VFS** (`src/storage/profileVfsData.ts`): the bulky tree slices — `connectionScripts`, `connectionAliases`, `connectionTriggers`, `connectionTimers`, `connectionKeybindings`, `connectionButtons`, `connectionPackages` — are **not** in localStorage. They're persisted to a single hidden JSON file (`.mudix/profile.json`) inside each profile's own VFS. `ScriptingEngine` owns the lifecycle: `loadProfileData()` seeds the store on profile open (after the VFS mounts, before default-package install), and a debounced `saveProfileData()` writes back whenever those slices change. The store API and all consumers are unchanged — only the persistence layer differs.

**`mapStorage`** (`src/storage/mapStorage.ts`): Separate IndexedDB (`mudix_maps` DB) for Mudlet binary map data. Async `saveMap(ArrayBuffer)` / `loadMap()`.

**`logStorage`** (`src/storage/logStorage.ts`): Separate IndexedDB (`mudix_logs` DB, `sessions` + `entries` stores) for persisted gameplay logs. `SessionLogger` (`src/logging/SessionLogger.ts`) subscribes to `session.events('message')` — the choke point all output (including echoed commands) flows through — snapshots each line's `toHtml()` + plain text, and batch-writes. Browsable via `LogBrowserModal` (toolbar **Logs** button); export helpers in `logExport.ts`. Per-profile toggle: `ProfileSettings.loggingEnabled` (default on).

### Profile VFS (virtual filesystem)

Each profile gets its own **`ProfileVFS`** (`src/scripting/vfs/ProfileVFS.ts`), built on **ZenFS**, mounted at `/profiles/<connectionId>`. It backs Lua file I/O (`io.*`, `lfs`, `table.save/load`), package storage, fonts, sounds, and `getMudletHomeDir()`. Two backends:
- **IndexedDB** (default) — `@zenfs/core` IndexedDB store.
- **Linked local folder** — `@zenfs/dom` `WebAccess` over a `FileSystemDirectoryHandle` chosen via the File System Access API. The handle is persisted (`folderHandleStore`) and re-used on cold start only when permission is already `granted` (prompts need a user gesture). `folderSync.ts` handles two-way sync and `MergeConflictModal` resolves divergence. `atime` tracking is disabled (`no_atime`) — it otherwise turned every file read into a synchronous IDB write.

A **service worker** (`public/vfs-sw.js`, registered in `main.tsx`) serves VFS files as real HTTP assets at `<scope>__vfs/<connectionId>/<path>` so CSS `url(...)`, images, and fonts can reference profile files. The page is the source of truth; each SW request round-trips to the client over a `MessageChannel` (`vfsBridge.ts`). `cssRewrite.ts` rewrites VFS-relative URLs in stylesheets to that prefix.

### SQLite & Database API

`@sqlite.org/sqlite-wasm` (`src/db/sqliteClient.ts`) backs Mudlet's `db:*` Lua API. Bundled `DB.lua` runs against a `Luasql.lua` shim that targets sqlite-wasm; `sqlRowEncoder.ts` marshals rows between Lua and JS.

### Packages & Import

Mudlet Web installs **Mudlet packages/modules** (`.mpackage`/`.zip`/XML). `src/import/` handles it: `mudletXmlImport`/`mudletXmlExport` (the Mudlet XML format for scripts/aliases/triggers/etc.), `packageInstaller` (unpack into the VFS + register tree nodes), `packageRepository` + `PackageRepositoryModal` (browse the public Mudlet package repo — fetch the manifest from `raw.githubusercontent.com`, **not** the stale github.io mirror), `remotePackageInstall` (install from URL / `sysInstall` GUI payloads), and `defaultPackages` (seed bundled defaults — `run-lua-code`, a mapper, `mpkg`, `gui-drop`, the starter UI — on profile open, mirroring Mudlet's `setupPreInstallPackages`).

`src/import/defaults/` is a vendored mirror of Mudlet's `src/packages/`, synced by `scripts/sync-mudlet-lua.mjs` alongside the Lua tree (see `src/scripting/lua/mudlet-lua/SYNCED.md`). It holds **every** package Mudlet preinstalls, one directory each — vendoring is not preinstalling. `defaultPackages.ts` alone decides what a profile gets, and only the archives it imports via `?url` are bundled at all; `scripts/copy-lib-assets.mjs` reads those imports back out to populate `dist-lib`, so that pairing needs no manual upkeep.

> **Mapper defaults.** `centerview()` is the *only* thing that moves the map view, and only a mapper package calls it — a profile with no mapper never follows the player, and two mappers both fire on the same movement. So `stockDefaults(host)` always returns exactly one, mirroring `setupPreInstallPackages` in Mudlet's `mudlet.cpp`: `mudlet-mapper.xml` (the IRE/`mmp` mapper, vendored in `import/defaults/`) for the `IRE_MAPPER_GAMES` hosts — achaea/aetolia/lusternia/imperian/starmourn **and stickmud.com** — and `generic_mapper` for everyone else. The choice is a plain conditional, not a declarative rule: `DefaultPackage` has no host or precedence fields to arbitrate. Brands override by exact list (`brand.packages`, see `resolveDefaultPackages`) rather than by displacement.

### Media: Sound, TTS, Video

`SoundManager` (MSP + Mudlet `playSoundFile`/`stopSounds`), `TtsManager` (Web Speech `ttsSpeak`/`ttsQueue`...), and `VideoManager` (`playVideoFile` and music utilities) implement Mudlet's media APIs against browser primitives; file paths resolve through the profile VFS.

### JS API Parity with Mudlet

Every Mudlet API feature needs a JS/Lua equivalent in `ScriptingAPI`, but it should be structured idiomatically for this client — not a 1:1 copy of Mudlet's API surface.
