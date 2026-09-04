# Mudlet spec corpus — provenance

These `*_spec.lua` files are copied **verbatim** from Mudlet's
`src/mudlet-lua/tests/`. Keeping them byte-for-byte identical to upstream means
every failing spec is a genuine mudix↔Mudlet parity gap, and re-syncing is a
clean copy + diff.

- Upstream: https://github.com/Mudlet/Mudlet/tree/development/src/mudlet-lua/tests
- Synced from commit: `de6795b19562d1d549f7e7742f31c27660c81304` (2026-08-24)

## Files

All 45 `*_spec.lua` files from Mudlet's tests directory are synced verbatim,
together with the `fixtures/` several of them read — a map to import, packages
to install. A spec without its fixture fails on a missing file rather than on a
parity gap, so the fixtures are as much part of the corpus as the specs.
`LuaRuntime.ts` serves both at `/lua/specs/…`, which is where a spec's
`debug.getinfo(1, "S").source` points it.

Not copied: `.busted`, the readmes, and `fixtures/packages/build-fixtures.sh` —
Mudlet's own runner housekeeping. The `fixtures/packages/sources/` tree that
script zips *is* copied, because one fixture (the XML-only package) has no
archive and the spec installs that file directly.

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

## Who runs it

Nobody has to: `.github/workflows/sync-mudlet-specs.yml` runs the sync daily,
opens `chore/sync-mudlet-specs` as a PR when the pin has moved, merges it once
CI is green, and opens a triage issue when it isn't. The commit hash in the
header above is therefore never more than a day behind Mudlet unless a red
corpus is waiting on somebody — which is the point: a new upstream spec is a
parity report, and the open PR is where it gets answered (fix the gap, or record
an `e2e/knownDivergences.ts` entry on that branch — the next day's sync stacks
onto it rather than replacing it).

Running `yarn sync:mudlet-specs` by hand is still fine, and is the way to sync
against a tag or a local checkout.
