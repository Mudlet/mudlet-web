# Bundled Mudlet Lua — provenance

This tree is a **verbatim mirror of Mudlet's `src/mudlet-lua/lua/`** (plus the
Lua translation catalogue Mudlet keeps at `translations/lua/mudlet-lua.json`).
`LuaRuntime.ts` globs it into the read-only `/lua/` VFS namespace, which is where
`LuaGlobal.lua`'s `dofile()` paths and `require()` resolve — so a file added here
is loadable with no further wiring.

- Upstream: https://github.com/Mudlet/Mudlet/tree/development/src/mudlet-lua/lua
- Synced from commit: `3bd0e173c71717df038f1e23d23e4f1bff1a4b15` (2026-08-02)
- Vendored files: 50 (plus 2 mudix-only, 0 patched)

**Keep this commit and `../specs/SYNCED.md`'s in step.** The specs are Mudlet's
own tests for exactly this code; running a newer corpus against an older tree
reports failures that are pure version skew, not mudix gaps. Re-sync both
together, pinning `--ref` to the same sha.

## Don't edit these files

Where mudix has to behave differently from desktop Mudlet, the fix goes **after
the tree loads**, not into it — `LuaRuntime.installMudletLuaOverrides()`, the
same tactic `installFastColorEcho()` uses for GUIUtils. That keeps the mirror
byte-identical, so a re-sync can never silently revert a mudix change, and
`git diff` after one shows only what Mudlet itself did.

Currently overridden:

| What | Why |
|------|-----|
| `mudlet.supports.mmcp = false` (`Other.lua`) | MMCP is peer-to-peer chat over a direct TCP socket, which a browser tab can't open. `mmcp.*` *is* bound, as no-op stubs (`Bridge.lua`), so feature-detecting scripts have to see it unsupported or they'll call into them. |
| `dispatchEventToFunctions`'s `pcall` (`Other.lua`) | It guards every event handler with `pcall`, and Lua 5.1 can't yield across `pcall`'s C frame — a handler suspending on `invokeFileDialog` dies there. `setfenv` re-points *that one function's* `pcall` at the coroutine-aware `__mudix_pcall_co`; every other global falls through to `_G`. Covered by `tests/scripting/invokeFileDialog.test.ts`, whose anonymous-event-handler case fails if the override is removed. |

If an override ever proves impossible from the outside, the escape hatch is a
patch file under `scripts/mudlet-lua-patches/` — but check first that upstream
doesn't already do what you're about to add. An early version of this tree
carried a `GeyserMiniConsole.lua` patch re-adding
`Geyser.MiniConsole:cechoLink/dechoLink/hechoLink` thirty lines below where
upstream already defines them.

## mudix-only files (no upstream counterpart)

| File | Why |
|------|-----|
| `3rdparty/lulpeg.lua` | Pure-Lua LPeg. Mudlet links the C `lpeg` library; wasmoon has no way to. |
| `SYNCED.md` | This file. |

## Not vendored

| Upstream path | Why |
|---------------|-----|
| `CoreMudlet.lua` | LuaDoc-only; its whole body sits inside `if false then` and never executes. |
| `config.ld`, `ldoc.css` | LDoc doc-generation config, not runtime. |
| `.gitignore` | Repo housekeeping. |

## Re-syncing

```bash
yarn sync:mudlet-lua                        # GitHub, development branch
yarn sync:mudlet-lua --dry-run              # report what would change
yarn sync:mudlet-lua --ref v4.20.0          # any branch/tag/sha
yarn sync:mudlet-lua --from /path/to/Mudlet --fetch   # local checkout
```

`scripts/sync-mudlet-lua.mjs` pins one commit, copies every non-excluded file
verbatim (deleting any Mudlet retired — `--keep-removed` opts out), re-applies
any patches, and rewrites the header above. A patch that stops applying is a hard
failure, not a silent skip: the script exits non-zero, because at that point the
file is pristine upstream and the mudix change it carried is gone from the tree.

Two things the script can't do for you, and warns about:

- a new `.mpackage` that Mudlet preinstalls needs wiring into
  `src/import/defaultPackages.ts` (and see the mapper-defaults note in
  `CLAUDE.md` — exactly one mapper package may be default);
- a `.mpackage` reached via a `?url` import also needs a line in
  `scripts/copy-lib-assets.mjs`, since the library build externalizes those.

Both apply to `base-ui/mudlet-base-ui.mpackage` and
`generic-mapper/generic_mapper.mpackage`, the two archives this tree ships as
default packages.
