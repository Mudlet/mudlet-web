# Browsers and limits

Mudlet Web runs the same Lua, the same trigger engine, and the same Geyser toolkit
as desktop Mudlet — but inside a browser sandbox. Most of what's different follows
from that.

## Browser support

| | Chrome / Edge / Brave / Opera | Firefox | Safari |
|---|---|---|---|
| Playing, scripting, maps, packages | yes | yes | yes |
| Import a profile from a `.zip` | yes | yes | yes |
| Import or link a profile **folder** | yes | no | no |
| Store a profile in a folder on disk | yes | no | no |

The folder features need the File System Access API, which only Chromium-based
desktop browsers implement. Everywhere else, profiles live in browser storage and
you move them around as `.zip` files — nothing else is lost.

Mudlet Web must be served over **HTTPS** (or `localhost`). The service worker that
serves profile images, fonts and CSS to your scripts won't register otherwise.

Phones and tablets work, with a layout that adapts to the smaller screen. Expect
the usual on-screen-keyboard friction with keybinding-heavy setups.

## Installing it, and opening it offline

Mudlet Web is installable: Chrome, Edge and Android offer **Install** from the
address bar or the browser menu, and Safari on iOS has *Add to Home Screen*. It
then opens in its own window, with no address bar.

Once you have loaded it a couple of times it also opens **without a network**.
The app itself is kept in browser storage, so an aeroplane or a dead Wi-Fi still
gets you your profiles, scripts, triggers, map and logs — everything except the
one thing that genuinely needs the network, which is the game. Connecting will
fail until you are back online.

Updates still arrive the moment you are: the page itself is fetched fresh
whenever it can be, so reloading online is all it takes to move to a new version.

## Things that behave differently

**Keyboard shortcuts the browser has claimed.** A keybinding on Ctrl+T or Ctrl+W
will open a tab or close one — the browser sees those first and a web page cannot
override them. Pick combinations the browser doesn't use.

**The window is the window.** `setMainWindowSize` and friends are no-ops; the
browser viewport is the main window. Everything inside it — docks, floats, splits,
tab groups — works.

**The clipboard is asynchronous.** Browsers gate clipboard access on a user gesture
and a secure context, while Mudlet's `getClipboardText`/`setClipboardText` are
synchronous. Mudlet Web keeps its own clipboard value as the authoritative one and
syncs it to the system clipboard when the browser allows, so a `setClipboardText`
outside a gesture may not reach the OS, and an external copy shows up on the next
read rather than immediately.

**Native features are stubs.** Discord Rich Presence, the IRC client, launching
subprocesses, and the system dictionary are bound as no-ops that log a warning.
Packages that use them still install and run — those specific calls just do
nothing.

**Lots of tiny Lua-to-JS calls add up.** Crossing between the Lua VM and the
browser is cheap once and noticeable ten thousand times. The paths you hit
constantly — line processing, triggers, GMCP — are batched and fast. A script that
walks every room in a huge map one `getRoom*` call at a time will feel slower than
on desktop. Prefer the bulk APIs where they exist.

**Telnet MUDs go through a proxy.** See [Connecting to a MUD](./connecting.md).

The per-function implementation status for the whole Mudlet API — done, partial,
stubbed, missing — is tracked in `docs/MUDLET_API.md` in the repository.
