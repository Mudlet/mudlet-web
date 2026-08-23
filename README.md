<div align="center">

# 🗺️ Mudlet Web

### Mudlet in your browser — the full Mudlet Lua scripting stack, running entirely client-side.

[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)](https://vite.dev)
[![Lua 5.1](https://img.shields.io/badge/Lua-5.1%20(WASM)-000080?logo=lua&logoColor=white)](https://www.lua.org)

*No installs. No native dependencies. Open a tab and play.*

</div>

---

## What is Mudlet Web?

**Mudlet Web** is a browser edition of [Mudlet](https://www.mudlet.org/), the [MUD](https://en.wikipedia.org/wiki/Multi-user_dungeon) (Multi-User Dungeon) client. It speaks the full telnet protocol stack that modern MUDs use, renders rich ANSI output, and runs **real Lua scripting** compiled to WebAssembly — with an API built for **drop-in compatibility** with Mudlet packages, maps, and profiles.

If you have Mudlet scripts, triggers, aliases, or maps, Mudlet Web aims to run them unchanged — anywhere you have a web browser. It is not a rewrite of desktop Mudlet and doesn't replace it: some things a native client can do simply aren't available inside a browser sandbox (see [Limitations](#️-limitations--known-constraints)).

## ✨ Features

### 🔌 Connectivity
- **Direct WebSocket** connections to MUDs that expose a `ws(s)://` endpoint.
- **Telnet via proxy** — connect to any classic `host:port` MUD through the bundled telnet→WebSocket proxy.
- Full protocol support: **GMCP**, **MSDP**, **MSSP**, **MCCP** (compression), **MSP** (sound), telnet **CHARSET**, **TTYPE/MTTS**, and GA/EOR prompt detection.

### 📜 Mudlet Lua scripting
- A complete **Lua 5.1** runtime (WASM) with Mudlet-native globals — `send`, `echo`/`cecho`/`decho`/`hecho`, `tempTimer`, `tempTrigger`, `tempAlias`, and [hundreds more](docs/MUDLET_API.md).
- **Triggers, aliases, timers, keybindings, and buttons** organized in Mudlet-style folder trees.
- **PCRE regex** powered by `pcre2-wasm` — the same engine flavour as desktop Mudlet.
- Bundled Mudlet standard library: Geyser GUI toolkit, the generic mapper, string/table utilities, and the `db:*` database API.
- A built-in **CodeMirror** script editor with autocompletion for the entire API surface.

### 🗺️ Maps & GUI
- Renders **Mudlet binary maps** with a built-in viewer and editor.
- **Geyser** mini-consoles, labels, gauges, and command lines as pixel-positioned overlays.
- A **custom dock/float window system** — split, tab, dock to any edge, or tear off into free-floating windows.

### 💾 Storage & persistence
- A **per-profile virtual filesystem** (ZenFS) backed by IndexedDB — or linked to a **real folder on your disk** via the File System Access API, with two-way sync.
- An in-browser **SQLite** database for the Mudlet `db:*` API.
- **Session logging** to IndexedDB, browsable and exportable.
- Install Mudlet **packages and modules** (`.mpackage` / `.zip` / XML) — including browsing the public Mudlet package repository.

### 🎨 Polish
- Multiple themes (dark, light, amber, sky), custom fonts, configurable colors and backgrounds.
- Text-to-speech, sound, and video playback wired to Mudlet's media APIs.

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) 20+ and [yarn](https://yarnpkg.com/).

### Run the client

```bash
git clone <repo-url> mudlet-web
cd mudlet-web
yarn
yarn dev
```

Open the printed local URL (usually `http://localhost:5173`) in your browser, then create a connection on the start screen.

### Run the telnet proxy (for `host:port` MUDs)

The browser cannot open raw TCP sockets, so connecting to a classic telnet MUD needs the small bundled proxy:

```bash
cd proxy
yarn
yarn start    # listens on ws://localhost:3001 by default
```

Then choose **MUD (host:port)** mode when creating a connection. Servers that expose a native WebSocket endpoint don't need the proxy — use **WebSocket** mode and point it straight at the `ws(s)://` URL.

### Already play in desktop Mudlet?

Your existing profile comes across whole — triggers, aliases, scripts, keybindings, buttons, saved variables, installed packages, your map, and your colours and fonts. **[docs/help/migrating.md](docs/help/migrating.md)** walks through it: where the profile folder lives on each platform, the three ways in (copy a folder, import a `.zip`, or link the folder and keep using both), what doesn't come across, and how to export back to desktop Mudlet.

The same guide — plus [connecting](docs/help/connecting.md), [storage and backups](docs/help/storage.md), and [browsers and limits](docs/help/browsers.md) — is built into the app behind the **Help** button, on the start screen and in the toolbar.

## 🛠️ Development

```bash
yarn dev         # Start the Vite dev server
yarn build       # Type-check + production build
yarn preview     # Preview the production build
yarn typecheck   # Type-check only (src + tests)
yarn test        # Run the Vitest suite
yarn test:watch  # Vitest in watch mode
```

Production builds deploy to **GitHub Pages** automatically on push to `master`.

## 🧱 Architecture at a glance

```
MudClient (WebSocket — direct or via telnet proxy)
  → telnet/protocol parsing (GMCP · MSDP · MSSP · MCCP · MSP · CHARSET · TTYPE)
  → MudSession.events  (a typed EventBus — the spine of the app)
      ├─ ScriptingEngine → LuaRuntime (WASM)  +  alias/trigger/timer/key engines
      ├─ React UI         (output area, dock/float panels, toolbar)
      └─ SessionLogger    (persists output to IndexedDB)
```

| Layer | Lives in | Notes |
|---|---|---|
| **Connection** | `src/mud/connection`, `src/mud/protocol` | Telnet over binary WebSocket frames |
| **Scripting** | `src/scripting` | wasmoon Lua 5.1, Mudlet-native API, bundled Mudlet Lua |
| **UI / Windows** | `src/ui` | Custom dock/float layout, CodeMirror editor, overlays |
| **Maps** | `src/map`, `MapPanel` | Mudlet binary map reader/renderer/editor |
| **Storage** | `src/storage`, `src/scripting/vfs`, `src/db` | Zustand + per-profile VFS + SQLite + IndexedDB logs |
| **Import** | `src/import` | Mudlet XML & package install/export |

A deeper tour of the internals lives in [`CLAUDE.md`](./CLAUDE.md); the full Mudlet API implementation status is tracked in [`MUDLET_API.md`](docs/MUDLET_API.md).

## 🏷️ Branded builds

Mudlet Web is also published as an npm library for shipping a **white-label client for one specific MUD** — your own name, login screen, theme, toolbar, and bundled Lua packages, without forking the repo. See [`docs/BRANDED_BUILDS.md`](docs/BRANDED_BUILDS.md) for the setup guide, or [embervale-web](https://github.com/Delwing/embervale-web) for a live example.

> The package is published as [`@mudlet/mudlet-web`](https://www.npmjs.com/package/@mudlet/mudlet-web). It was previously `@delwing/mudix` (now deprecated) — the app root export was renamed `MudixApp` → `MudletWebApp` with the move.

## ⚠️ Limitations & known constraints

Mudlet Web runs inside a browser sandbox, which trades some of desktop Mudlet's native reach for zero-install portability. Worth knowing before you switch:

- **Telnet MUDs need the proxy.** Browsers can't open raw TCP sockets, so classic `host:port` MUDs are reachable only through the bundled telnet→WebSocket proxy. Servers with a native `ws(s)://` endpoint connect directly.
- **One profile per tab.** There's no desktop-Mudlet-style multi-profile tabbing *within* a tab — you open one connection per browser tab (`loadProfile()` and in-tab profile switching are no-op stubs). You can still run **different profiles in separate tabs**: each profile is locked to a single tab (opening the same one elsewhere shows a "waiting" screen until the first tab releases it), every profile's data is isolated in its own filesystem, and profiles can signal each other across tabs via Mudlet's `raiseGlobalEvent`.
- **Storage is browser-scoped.** Profiles, scripts, maps, and logs live in the browser's IndexedDB/localStorage for the app's origin. Clearing site data wipes them — unless you **link a real disk folder** for that profile (see below). Different browsers/machines don't share state automatically.
- **Disk-folder linking is Chromium-only.** The "link a folder on disk" feature uses the File System Access API, which Firefox and Safari don't implement. Those browsers fall back to IndexedDB-only storage.
- **Secure context required.** The VFS service worker (which serves profile images/fonts/CSS) needs HTTPS or `localhost`.
- **Clipboard access is best-effort.** The browser's OS clipboard is asynchronous and gated on a user gesture (and a secure context), whereas desktop Mudlet's `getClipboardText`/`setClipboardText` are synchronous. Mudlet Web keeps a session-local text-clipboard mirror as the authoritative value and syncs it to the real OS clipboard opportunistically — so `setClipboardText` may not reach the system clipboard without a user gesture, and `getClipboardText` returns the last value Mudlet Web knows about (an external copy made elsewhere shows up on the *next* call, once the async read completes). This mirror is separate from the rich-text buffer used by `copy()`/`paste()`.
- **Some Mudlet APIs are stubbed or partial.** Anything fundamentally native is bound as a warning-emitting no-op so imported packages still load, but does nothing: **Discord** Rich Presence, **IRC** client, OS `spawn`/subprocess, and the system dictionary. A few synchronous Mudlet calls (`invokeFileDialog`, `getImageSize`) don't map cleanly onto the browser's async pickers/loaders and are still in progress. See [`MUDLET_API.md`](docs/MUDLET_API.md) for the per-function status (✅ / ⚠️ / 🚧 / ❌).
- **The main window is the viewport.** Calls like `setMainWindowSize` are no-ops — the browser window is the main window.
- **The Lua↔JS boundary has a per-call cost.** Each crossing between the Lua VM and JS is cheap individually but adds up — a script that makes thousands of tiny boundary calls in a tight loop (e.g. iterating every room in a large area one `getRoom*` call at a time) will feel noticeably slower than in native Mudlet. The hot paths you actually hit constantly (line/trigger processing, GMCP) are batched and stay fast; prefer bulk/batched APIs over per-item calls when you can.

## 🤝 Contributing

When adding a Mudlet API function, implement the JS-side method in `ScriptingAPI`, bind the Lua global in `LuaRuntime`, and add the autocomplete entry in `luaCompletions.ts`. Run `yarn typecheck` and `yarn test` before opening a PR.

## License

Mudlet Web is licensed under the **GNU General Public License, version 2 or (at your option) any later version** — see [LICENSE](./LICENSE). This matches [Mudlet](https://github.com/Mudlet/Mudlet)'s license (GPL-2.0-or-later): Mudlet Web bundles Mudlet's Lua runtime files (`src/scripting/lua/mudlet-lua/` — LuaGlobal, Geyser, the generic mapper, DB utilities, and more), copyright the Mudlet contributors, so every distribution is a combined work with that GPL code.

Lua scripts and packages that Mudlet Web merely *runs* (your profile scripts, installed `.mpackage`s, branded-build packages) are separate works and are not required to be GPL — the same way the Mudlet ecosystem treats its packages.

Mudlet Web also bundles **Bitstream Vera Sans Mono** (`src/assets/fonts/bitstream-vera-sans-mono/`) as the default console output and command-line font, matching Mudlet's own default console typeface. It's under the separate, permissive [Bitstream Vera license](src/assets/fonts/bitstream-vera-sans-mono/COPYRIGHT.TXT) (free redistribution and embedding; just don't sell the font standalone or rename a modified copy while keeping "Bitstream"/"Vera" in the name).

**Ubuntu** and **Ubuntu Mono** (`src/assets/fonts/ubuntu/`, regular/bold/italic/bold-italic each) are bundled for the same reason: Mudlet registers both families into Qt's font database at startup, so packages written for Mudlet — including the bundled `mudlet-base-ui` — ask for them by name for labels, headers, and miniconsole stylesheets. They're under the [Ubuntu Font Licence 1.0](src/assets/fonts/ubuntu/LICENCE.txt) (free redistribution and embedding; modified copies must be renamed).

<div align="center">
<sub>Built with React, TypeScript, and a lot of WebAssembly. Happy MUDding. 🐉</sub>
</div>
