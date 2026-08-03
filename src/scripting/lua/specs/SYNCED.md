# Mudlet spec corpus — provenance

These `*_spec.lua` files are copied **verbatim** from Mudlet's
`src/mudlet-lua/tests/`. Keeping them byte-for-byte identical to upstream means
every failing spec is a genuine mudix↔Mudlet parity gap, and re-syncing is a
clean copy + diff.

- Upstream: https://github.com/Mudlet/Mudlet/tree/development/src/mudlet-lua/tests
- Synced from commit: `3bd0e173c71717df038f1e23d23e4f1bff1a4b15` (development, 2026-08-02)

## Files

All 33 `*_spec.lua` files from Mudlet's tests directory are synced verbatim. The
live pass/fail scoreboard (and which are asserted green) lives in
`docs/busted-e2e-plan.md`; `e2e/busted.spec.ts` runs them against the real app.

## Re-syncing

```bash
yarn sync:mudlet-specs                        # GitHub, development branch
yarn sync:mudlet-specs --dry-run              # report what would change
yarn sync:mudlet-specs --ref v4.20.0          # any branch/tag/sha
yarn sync:mudlet-specs --from /path/to/Mudlet --fetch   # local checkout
```

`scripts/sync-mudlet-specs.mjs` pins one commit, copies every `*_spec.lua`
verbatim (deleting any Mudlet retired — `--keep-removed` opts out), and rewrites
the header above. New specs need no wiring: `bustedHarness.ts` discovers them
from disk and `LuaRuntime.ts` bundles them via `import.meta.glob`. Do regenerate
the per-it() manifest afterwards (`yarn gen:busted-manifest`) — the drift guard
in `e2e/busted.spec.ts` fails until you do.

Don't edit the spec bodies — divergence from upstream should only ever come from
a deliberate re-sync, so a failing spec always means a real mudix gap.
