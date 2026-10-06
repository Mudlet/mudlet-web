# Bringing a Mudlet profile to the web

Mudlet Web reads desktop Mudlet's own profile format, so a profile you've built up
over years — triggers, aliases, scripts, keybindings, buttons, saved variables,
installed packages, your map, your colours and fonts — comes across as a unit.
There are a few ways to do it, and the right one depends on your browser and on
whether you plan to keep using desktop Mudlet.

## The quick way — export from desktop Mudlet

If your desktop Mudlet has it, this is one click and works in every browser:

1. Open the profile in desktop Mudlet.
2. Choose **Toolbox → Export to Mudlet Web** and save the `.zip` it offers.
3. In Mudlet Web, click **Import .zip…** under your profile list and pick that file.

The export saves the profile first, so nothing you changed since the last save
is left behind, and it takes the map as it is in memory. It also brings your
**modules** along — they live outside the profile folder on desktop, which is
why the routes below have to ask you for them.

The rest of this page is for doing it by hand.

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
- Connection settings: the game's address and port, secure connection (TLS) and
  its certificate exceptions, your character name, the profile description, and
  the *auto-open* and *auto-reconnect* checkboxes.
- Modules, which stay modules — with their priority and sync setting. A module
  installed from an `.mpackage` keeps its images and other files.
- Every other file in the profile folder, into the profile's own filesystem — so
  `io.open`, `lfs`, images, sounds and fonts keep working at the same paths.
  `current/` and `map/` are handled as above, and saved passwords are left
  out (see below).

## What doesn't

- **Passwords.** Desktop Mudlet usually keeps them in your operating system's
  keychain. When it can't, it keeps them inside the profile folder — and those
  files are deliberately left behind, by desktop's export and by the import
  alike, rather than copied anywhere a script could read them. Enter your
  password again on first connect.
- **The link between a module and its file.** Mudlet syncs a module to a file
  elsewhere on your disk; a browser can't keep that link alive, so the module's
  file is copied into the new profile and syncs there instead. If a module's file
  isn't in what you imported — a folder you picked or zipped yourself rarely has
  it — Mudlet Web asks you to upload its `.xml` or `.mpackage`, or to drop it.
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
profile folder per selected profile — the same layout you imported. In desktop
Mudlet, open the **Connect** window, click **Import** and pick the file, or drop
it on that window. Each profile is added to **My games** with its connection
details filled in; one whose name is already taken gets a number, so nothing you
have is overwritten. Click **Connect** to play.

What comes across:

- **Everything in the profile** — scripts, aliases, triggers, timers, keys,
  buttons, saved variables, settings, packages, the map and your files.
- **Modules** load as modules again, from the copy inside the profile folder. One
  set to sync keeps syncing, to that copy.
- **The connection**: server address and port, secure connection, character
  name, description, and both connect options. Passwords are not exported:
  enter yours again in desktop Mudlet.
- **Session logs** land in the profile's `log` folder.

Desktop Mudlet can't connect through a WebSocket address (`ws://` or `wss://`),
so a profile that used one is imported without a server address and the import
says so: enter the game's telnet address and port before connecting.

Unzipping a profile folder into `~/.config/mudlet/profiles/` (see the table
above) works too. Modules need a desktop Mudlet that has the **Import** button
to find their files that way; older versions list them but can't load them.

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
