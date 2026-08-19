# Mudlet spec corpus — provenance

These `*_spec.lua` files are copied **verbatim** from Mudlet's
`src/mudlet-lua/tests/`. Keeping them byte-for-byte identical to upstream means
every failing spec is a genuine mudix↔Mudlet parity gap, and re-syncing is a
clean copy + diff.

- Upstream: https://github.com/Mudlet/Mudlet/tree/development/src/mudlet-lua/tests
- Synced from commit: `49bf1ce74ec2d5f3e9cf3146678fe97100c6ef20` (2026-08-19)

## Files

All 44 `*_spec.lua` files from Mudlet's tests directory are synced verbatim,
together with the `fixtures/` several of them read — a map to import, packages
to install. A spec without its fixture fails on a missing file rather than on a
parity gap, so the fixtures are as much part of the corpus as the specs.
`LuaRuntime.ts` serves both at `/lua/specs/…`, which is where a spec's
`debug.getinfo(1, "S").source` points it.

Not copied: `.busted`, the readmes, and `fixtures/packages/sources/` with its
`build-fixtures.sh` — those rebuild the package archives, and it is the built
archives the specs install.

`e2e/busted.spec.ts` runs the corpus against the real app.

## Re-syncing

```bash
yarn sync:mudlet-specs                        # GitHub, development branch
yarn sync:mudlet-specs --dry-run              # report what would change
yarn sync:mudlet-specs --ref v4.20.0          # any branch/tag/sha
yarn sync:mudlet-specs --from /path/to/Mudlet --fetch   # local checkout
```

`scripts/sync-mudlet-specs.mjs` pins one commit, copies every `*_spec.lua`
verbatim (deleting any Mudlet retired — `--keep-removed` opts out), and rewrites
the header above. New specs need no wiring at all: `bustedHarness.ts` discovers them
from disk, `LuaRuntime.ts` bundles them via `import.meta.glob`, and the e2e suite
records and asserts whatever it finds — there is no manifest to regenerate, since
the test names and their results come from the same run.

Don't edit the spec bodies — divergence from upstream should only ever come from
a deliberate re-sync, so a failing spec always means a real mudix gap.
