# Bringing a Mudlet profile to the web

Mudlet Web reads desktop Mudlet's own profile format, so a profile you've built up
over years — triggers, aliases, scripts, keybindings, buttons, saved variables,
installed packages, your map, your colours and fonts — comes across as a unit.
There are three ways to do it, and the right one depends on your browser and on
whether you plan to keep using desktop Mudlet.

## Step 1 — find your profile folder

Desktop Mudlet keeps every profile in one place, on **every** platform:

| Platform | Path |
|---|---|
| Windows | `C:\Users\<you>\.config\mudlet\profiles\<profile name>` |
| macOS | `~/.config/mudlet/profiles/<profile name>` |
| Linux | `~/.config/mudlet/profiles/<profile name>` (or `$XDG_CONFIG_HOME/mudlet/profiles/…`) |

> On Windows this is **not** under `AppData` — Mudlet puts its config in a
> `.config` folder in your user directory, the same as on Linux. If you run
> Mudlet in portable mode, the folder is wherever your `portable.txt` points.

Inside you'll see `current/` (the saves — one XML per save, newest wins),
`map/` (your map files), and whatever packages and loose files the profile has
accumulated. **Pick the `<profile name>` folder itself**, not `profiles/` and not
`current/`.

Close desktop Mudlet before you start, so the newest save on disk is the one you
actually want.

## Step 2 — pick a route

| Route | Browser | What happens |
|---|---|---|
| **Import Mudlet folder…** | Chromium only | Copies the profile into the browser as a new web profile. Your folder on disk is never written to. |
| **Import .zip…** | Any browser | Same, from a zipped copy of the folder. The only route on Firefox, Safari, and phones. |
| **Link Mudlet folder…** | Chromium only | Doesn't copy — the folder on disk stays the source of truth. Mudlet Web reads the newest save on every open and writes its own timestamped save back. |

All three live in the button row under your profile list on the start screen.

### Import a folder (Chromium)

1. Click **Import Mudlet folder…**
2. Choose your `<profile name>` folder and grant read access.
3. The profile appears in the list. Open it.

### Import a `.zip` (any browser)

1. Zip the `<profile name>` folder (right-click → *Send to → Compressed folder* /
   *Compress*). Zip the folder itself, not its contents.
2. Get the zip onto the device with the browser — cloud drive, USB, whatever.
3. Click **Import .zip…** and pick it.

A zip exported by Mudlet Web can hold several profiles at once; importing it
brings all of them in.

### Link a folder (Chromium)

Use this when you want to keep playing in desktop Mudlet *and* on the web against
one profile. Click **Link Mudlet folder…** and pick the folder — linked profiles
show a link badge in the list.

Two things to know:

- The browser asks for permission each cold start. Clicking **Open** on the
  profile is what triggers the prompt, so opening a linked profile via a direct
  `?profile=` link won't work until you've opened it by hand once in that session.
- **Don't run both at once on the same folder.** Mudlet and Mudlet Web each write
  a full save; whoever saves last wins and the other's changes since that save are
  gone. Close one before opening the other.

## What comes across

- Triggers, aliases, timers, scripts, keybindings and buttons — folder structure
  intact, enabled/disabled state intact.
- Saved variables (Mudlet's `<VariablePackage>`), and the save-list that decides
  which ones persist.
- Installed packages, registered under the names Mudlet knew them by, so
  `getPackages()` and package managers like `mpkg` behave.
- Your map — the newest file in `map/`. It is read into Mudlet Web's own map
  store rather than the profile's filesystem, so there is no `map/` folder under
  `getMudletHomeDir()` afterwards.
- Profile settings: command separator, wrap width, borders, foreground /
  background / command / input colours, the full 16-colour ANSI palette, display
  font family and size, and the protocol toggles.
- Every other file in the profile folder, into the profile's own filesystem — so
  `io.open`, `lfs`, images, sounds and fonts keep working at the same paths.
  `current/` and `map/` are the two exceptions, handled as above.

## What doesn't

- **Passwords.** Desktop Mudlet keeps them in your operating system's keychain,
  not in the profile, so there is nothing to copy. Enter them again on first
  connect.
- **Modules.** Mudlet syncs modules to XML files elsewhere on your disk; a browser
  can't keep that link alive. Mudlet Web folds each module in as an ordinary
  installed package. If it can't find a module's file in the folder you imported,
  it asks whether to upload it or drop it.
- **Older saves.** Only the newest save in `current/` is read, and the rest are
  dropped rather than copied across. Desktop keeps them so you can roll back to
  one; Mudlet Web has no way to load an older save, and a profile's filesystem
  lives in browser storage that the browser may evict under pressure, so
  carrying several megabytes of unreachable saves would cost you the files you
  do use. Keep the original Mudlet folder if you want that history — importing
  does not consume it.
- **Anything fundamentally native.** Discord Rich Presence, the IRC client,
  `spawn`, and the system dictionary are bound as no-ops that log a warning, so a
  package that calls them still loads and runs — that one feature just does
  nothing.

## Going back to desktop Mudlet

**Export profiles…** on the start screen downloads a `.zip` holding one Mudlet
profile folder per selected profile — the same layout you imported. To use it in
desktop Mudlet, unzip a profile folder into `~/.config/mudlet/profiles/` (see the
table above) and start Mudlet; the profile shows up in its list.

The same zip imports straight back into Mudlet Web, on this address or another
one — which is also how you move a profile between browsers or machines.

## If something goes wrong

**"Import failed: …" on the start screen** — you probably picked the wrong
folder level. It has to be the folder that *contains* `current/`.

**Nothing imports, no error** — the profile has no readable save in `current/`.
Open it once in desktop Mudlet, save, and try again.

**The import worked but scripts error on open** — a package that assumes a native
Mudlet feature. Check the errors in the main window; see the API status list for
what's implemented, partial, or stubbed.

**Firefox or Safari, and the folder buttons are missing** — that's expected; those
browsers don't implement the File System Access API. Use the `.zip` route.
