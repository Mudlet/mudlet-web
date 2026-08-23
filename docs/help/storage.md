# Where your data lives

Mudlet Web has no server. Everything — profiles, scripts, packages, maps, logs,
saved variables, files your scripts write — is stored **in your browser**, on this
device, for this web address. Nothing is uploaded anywhere.

That's good for privacy and bad for durability, so it's worth knowing exactly what
it means.

## The two storage modes

**Browser storage (the default).** Each profile gets its own virtual filesystem
backed by IndexedDB, plus a small amount of layout state in local storage. It works
in every browser and needs no permissions.

**A folder on your disk (Chromium only).** You can point a profile at a real
directory instead, using the File System Access API. Files your scripts write land
in that folder as ordinary files you can open, edit, back up, and sync with
whatever tool you like. This is also how a [linked Mudlet profile](./migrating.md)
works.

## How you lose it

Browser storage is not a filing cabinet. Data disappears when:

- **You clear site data or cookies** for this address. "Clear browsing data" in
  most browsers takes IndexedDB with it unless you exclude it.
- **You're in a private / incognito window.** Everything is discarded when the
  window closes.
- **The browser reclaims space.** Under storage pressure a browser may evict a
  site's data. Rare, but real.
- **You switch browser, device, or address.** Storage is scoped to one origin in
  one browser profile. Chrome and Firefox on the same machine see nothing of each
  other's data.

## Backing up

**Export profiles…** on the start screen downloads a `.zip` containing one Mudlet
profile folder per profile you select — scripts, aliases, triggers, timers, keys,
buttons, saved variables, packages, your map, your files, and optionally your logs.

It's a real Mudlet profile folder, so it's three things at once: a backup, the way
to move a profile to another browser or machine, and the way to take it back to
desktop Mudlet.

Do it before clearing browser data, before switching devices, and every so often
just because. If you've linked a profile to a folder on disk, that folder is
already a live copy — back it up like any other folder.

## One profile per tab

Each profile is locked to a single tab. Open the same profile somewhere else and
you'll get a "waiting" screen until the first tab lets go — two tabs writing one
filesystem would corrupt it.

Different profiles in different tabs is fine and fully supported. They're isolated
from each other and can still talk to each other with `raiseGlobalEvent`.

## Logs

Session logs go to their own database and are browsable from the **Logs** button in
the toolbar, where you can also export them. Logging is on by default and can be
turned off per profile in Settings.
