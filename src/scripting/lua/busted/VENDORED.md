# Vendored busted (test corpus)

This directory holds a **pure-Lua subset of [busted]** plus its runtime
dependencies, vendored so Mudlet Web can run Mudlet's own `*_spec.lua` suite against
its `LuaRuntime`. It is **only bundled when `VITE_BUSTED=1`** (see
`LuaRuntime.ts`) so production builds tree-shake it out.

[busted]: https://github.com/lunarmodules/busted

## Versions / provenance

| Package   | Version | Upstream |
|-----------|---------|----------|
| busted    | 2.3.0   | https://github.com/lunarmodules/busted (`busted/` subdir) |
| luassert  | 1.8.0   | https://github.com/lunarmodules/luassert (`src/`) |
| say       | 1.3     | https://github.com/lunarmodules/say (`src/say/init.lua`) |
| mediator  | —       | https://github.com/Olivine-Labs/mediator_lua (`src/mediator.lua`) |

`busted/runner.lua`, `busted/modules/**`, `busted/outputHandlers/**`,
`busted/languages/**`, and `busted/luajit.lua` are intentionally **omitted** —
they assume a CLI process (arg parsing, `io.stdout`, `os.exit`, file globbing).
`runBusted.lua` drives busted through its programmatic core API instead, the
same approach Mudlet took for its in-client `runTests` command.

## Shims (Mudlet Web environment differs from a Lua CLI)

`busted/core` and friends `require` a handful of modules that don't exist or
behave differently in wasmoon. These are thin local stand-ins, NOT full ports:

- `system.lua` — luasystem timing (`gettime`/`monotime`/`sleep`). Backed by
  `os.clock()`; busted only uses these to stamp durations, which `runBusted`
  doesn't assert on.
- `pl/tablex.lua`, `pl/utils.lua`, `pl/path.lua`, `pl/pretty.lua` — the narrow
  slice of [penlight] busted's core touches (`tablex.copy`, `utils.split`,
  `path.dirname`, `pretty.write`, plus the fixtures-only path helpers). Full
  penlight would drag in `pl.compat` and a large host-FS surface.

[penlight]: https://github.com/lunarmodules/Penlight

## Layout / require resolution

Files are served read-only via the VFS at `/lua/<relative-path>` and resolved by
the `package.loaders[2]` VFS loader, with `package.path` extended to include
`/lua/?.lua;/lua/?/init.lua`. So:

- `require('busted.core')`  → `/lua/busted/core.lua`
- `require('luassert')`     → `/lua/luassert/init.lua`
- `require('say')`          → `/lua/say/init.lua`
- `require('mediator')`     → `/lua/mediator.lua`
- `require('runBusted')`    → `/lua/runBusted.lua`

## Spec corpus

The actual `*_spec.lua` files live in a sibling `../specs/` directory, copied
verbatim from Mudlet's `src/mudlet-lua/tests/`. Record the upstream commit there
when syncing so drift is visible.
