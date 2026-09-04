# Bundled Mudlet Lua — provenance

This tree is a **verbatim mirror of Mudlet's `src/mudlet-lua/lua/`** (plus the
Lua translation catalogue Mudlet keeps at `translations/lua/mudlet-lua.json`).
`LuaRuntime.ts` globs it into the read-only `/lua/` VFS namespace, which is where
`LuaGlobal.lua`'s `dofile()` paths and `require()` resolve — so a file added here
is loadable with no further wiring.

`scripts/sync-mudlet-lua.mjs` mirrors **two** upstream directories at one commit,
and this file is the provenance record for both:

| Upstream | Vendored at | What it is |
|----------|-------------|------------|
| `src/mudlet-lua/lua/` | `src/scripting/lua/mudlet-lua/` | this tree — the Lua runtime, served at `/lua/` |
| `src/packages/` | `src/import/defaults/` | the packages Mudlet preinstalls, one directory each |

A third piece of Mudlet is vendored on its own schedule and by its own script:
`src/TGameDetails.h` — the catalogue of games Mudlet ships with — becomes
`src/mud/games/bundledGames.ts` via `node scripts/sync-mudlet-games.mjs`. It is
separate because it is one C++ header parsed into data rather than files copied,
and because it moves far less often. Re-run it when the pin below moves.

They were one tree until Mudlet moved every default package into `src/packages/`
([#9626](https://github.com/Mudlet/Mudlet/pull/9626)). Note the second is only a
*supply* of packages: vendoring one does not preinstall it, and nothing there is
bundled unless `src/import/defaultPackages.ts` imports it. That file alone decides
what a profile gets.

- Upstream: https://github.com/Mudlet/Mudlet/tree/development/src/mudlet-lua/lua
- Synced from commit: `de6795b19562d1d549f7e7742f31c27660c81304` (2026-08-24)
- Vendored files: 83 (plus 2 mudix-only)

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
patch file under `scripts/mudlet-lua-patches/<tree>/` — but check first that
upstream doesn't already do what you're about to add. An early version of this
tree carried a `GeyserMiniConsole.lua` patch re-adding
`Geyser.MiniConsole:cechoLink/dechoLink/hechoLink` thirty lines below where
upstream already defines them.

A package is the one place where "override after loading" isn't available — its
scripts are installed into the profile, not loaded from this tree — so those do
take patches, under `scripts/mudlet-lua-patches/packages/`. Currently one:

| Patch | Why |
|-------|-----|
| `mudlet-base-ui/mudlet-base-ui.xml` | Its load script ran `setConfig("enableMSDP", true)` unconditionally, and a package script runs at *every* profile open — so a player who turned MSDP off in the preferences had that choice quietly rewritten at the next reload, contradicting both `PROTOCOL_DEFAULTS` and the setting's own help text. The patch seeds the preference once, behind a flag in the same settings file the package's other one-time state lives in. Desktop Mudlet doesn't hit this: `setupPreInstallPackages` doesn't preinstall the starter UI, so nothing rewrites the checkbox there. |

The last one was `packages/gui-drop/gui-drop.xml` (a dropped image whose filename
starts with a digit generated a script that couldn't compile, losing the drop);
[Mudlet#9628](https://github.com/Mudlet/Mudlet/pull/9628) landed the same fix
upstream, so the patch went and `defaultPackages.ts` installs the
`gui-drop.mpackage` archive again rather than the loose XML. That's the general
shape: a patch can't reach inside an `.mpackage` (the sync must round-trip the
zip byte-for-byte), so a package needing one is installed from its loose XML
until upstream takes the fix. `tests/import/guiDropNaming.test.ts` still guards
the behaviour, reading the naming block out of the vendored package itself.

`mudlet-base-ui` is in that state now, so `defaultPackages.ts` points at its
loose `mudlet-base-ui.xml`. The XML brings no `config.lua`, so the install has
no icon, title or description — and no version, which is why `BASE_UI` declares
one (`1.6.1+mudix.1`) for `ensureDefaultPackages` to stamp on: without it the
version check can't tell an old install of a loose-XML package from a current
one, and the patched build would never reach a profile that already had the
archive. `tests/import/baseUiMsdpSeed.test.ts` guards the change over whatever
asset `defaultPackages.ts` actually imports, so a re-sync that drops the patch —
or a switch back to the unpatched archive — fails there.

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
| `src/packages/README.md` | Documents Mudlet's own preinstall wiring (`mudlet.qrc`, `setupPreInstallPackages`); mudix decides in `defaultPackages.ts`. |

## Re-syncing

```bash
yarn sync:mudlet-lua                        # GitHub, development branch
yarn sync:mudlet-lua --dry-run              # report what would change
yarn sync:mudlet-lua --ref v4.20.0          # any branch/tag/sha
yarn sync:mudlet-lua --from /path/to/Mudlet --fetch   # local checkout
```

`scripts/sync-mudlet-lua.mjs` pins one commit, copies every non-excluded file of
both trees verbatim (deleting any Mudlet retired — `--keep-removed` opts out),
re-applies any patches, and rewrites the header above. A patch that stops
applying is a hard failure, not a silent skip: the script exits non-zero, because
at that point the file is pristine upstream and the mudix change it carried is
gone from the tree.

The one thing the script can't do for you, and warns about: a package Mudlet
newly preinstalls is *vendored* but not *installed* until it's wired into
`src/import/defaultPackages.ts` — and see the mapper-defaults note in `CLAUDE.md`,
since exactly one mapper package may be default. `scripts/copy-lib-assets.mjs`
then needs no maintenance: it reads that file's `?url` imports and copies exactly
those into `dist-lib`, so an archive can't be imported and left out of the
library build.

Also keep `../specs/SYNCED.md` on the same commit.
