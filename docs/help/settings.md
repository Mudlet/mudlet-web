# How Settings differs from desktop Mudlet

Mudlet Web's Settings covers most of desktop Mudlet's preferences, but not all of them.
Some of the gaps are deliberate — a browser tab genuinely cannot do the thing. Others
are simply not built yet. This page says which is which, so you can stop looking for a
setting that isn't coming, and know to ask for one that is.

If you are following the [Mudlet manual](https://wiki.mudlet.org/w/Manual:Contents),
this is the page that explains why its preferences chapter describes things you can't
find here.

## Where things moved

Nothing is missing here — it just isn't where the desktop manual says it is.

| On desktop | Here |
|---|---|
| Special Options → Force GA off, MXP, terminal type | Connection → Compatibility |
| Special Options → Additional text wait time | Connection → Network |
| Special Options → Force compression off | Untick **MCCP** under Connection → Game protocols |
| Special Options → Search Engine | Main display → Display options |
| Main display → Fix unnecessary linebreaks | Connection → Compatibility |
| Main display → Echo Lua errors | Advanced → Developer |
| Special Options → Store login passwords in | Privacy and security → Passwords |
| Connection → Forget saved sign-in | Privacy and security → Passwords |
| Preferences → Mapper → map files, map download | The map panel's own menu |
| Preferences → log format and HTML logs | Chosen when you export, in the Logs browser |
| Toolbar mute buttons | Sound and media |

## What a browser can't do

These have no setting because there is nothing behind them to switch.

**No menu bar, no icon sizes.** The browser's own chrome is the window frame. Appearance
→ Toolbar → Fullscreen mode is the nearest thing: it hides Mudlet Web's toolbar so the
game fills the window.

**No `telnet://` link handling.** A web page may only register itself for protocols on a
fixed list the browser ships, and `telnet` isn't on it.

**No auto-save on exit, and no updates setting.** There is no exit — your profile is
saved continuously as you change it — and no installer: reloading the page is the
update.

**No SOCKS/HTTP proxy settings.** Routing a connection through a proxy is your browser's
or your system's job, not a page's. Mudlet Web's own proxy is a different thing entirely
— the telnet-to-WebSocket bridge that makes telnet games reachable at all. It's set per
game, in the connection's own form. See [Connecting to a MUD](./connecting.md).

**No log folder.** Logs are recorded into browser storage and exported on demand from
the Logs browser. A page can't write to a folder on your disk without asking each time,
so a continuously-written log file isn't possible.

**No Discord Rich Presence, and no MMCP chat.** Rich Presence needs a socket to the
Discord app on your machine; MMCP dials other clients directly over TCP. Neither is
available to a page. Packages that call them still install and run — those calls just do
nothing.

**No anti-aliasing switch, no "high quality graphics" map switch.** Text smoothing isn't
under a page's control, and the map is always drawn smoothly.

**No spell-check settings.** Your browser's own spellchecker is the only one available,
and it isn't currently switched on for the command line.

## What's missing but shouldn't be

These apply perfectly well to a browser. They are on the list.

**Most map colours.** Mapper → Map colors has the background, the exit lines, the grid
and the info overlay. Room borders, upper/lower level tints and the map's own
sixteen-colour palette aren't settable yet — the map renderer doesn't expose them.

**Script editor options.** There's no Editor page: autocomplete is always on, the editor
follows the app theme, and there's no whitespace or item-ID display.

**Shortcut rebinding.** Mudlet Web's own keyboard shortcuts are fixed. Your *game*
keybindings work normally — create them in the editor as you would on desktop. Note that
combinations the browser has claimed (Ctrl+T, Ctrl+W and friends) never reach the page
at all; see [Browsers and limits](./browsers.md).

**Some smaller ones.** Highlight history, password masking, reacting to every keybinding
on a key, the double-click word-break characters, wide "ambiguous" East Asian
characters, a text analyzer, purging stored media, and the timer/codepoint debug
thresholds.

## Asking for one

If a missing setting is in your way, say so — it's a good way to get it prioritised, and
several of the gaps above are small. Report it at
[github.com/Mudlet/mudlet-web/issues](https://github.com/Mudlet/mudlet-web/issues).

The full setting-by-setting comparison, including everything Mudlet Web has that desktop
doesn't, lives in `docs/settings-divergence.md` in the repository.
