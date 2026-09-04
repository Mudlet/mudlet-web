# Settings: divergence from desktop Mudlet

Every preference desktop Mudlet offers, and what Mudlet Web does with it.

Compared against `src/ui/profile_preferences.ui` in the Mudlet source tree
(`development`, `e52432fe5`) — all 12 preference pages, all 63 checkboxes, every group
box, combo, spin box and colour button. Where a setting lives somewhere other than that
file (a dynamically-built widget, a toolbar item), that is noted. The web side was read
from `src/ui/SettingsModal.tsx` and `src/ui/settings/SettingsShell.tsx`, and each
"missing" claim was checked against the rest of `src/` before being written down —
several turned out to be implemented but unexposed, which is a different problem with a
much cheaper fix.

This file answers "is it there?". The user-facing version of the same question — "what
will I notice?" — is [docs/help/settings.md](help/settings.md), which ships in the app's
Help modal and is linked from Settings itself.

## Legend

| | |
|---|---|
| ✅ | **Present** — the same setting, with the same effect |
| 📍 | **Elsewhere** — implemented, but reached from somewhere other than Settings |
| 🚧 | **Missing** — applies perfectly well to a browser; simply not built yet |
| ❌ | **N/A** — cannot exist in a browser, or has no meaning for a web client |

## Summary

Counts after the work described in "What was built" below. The figures the audit
opened with — 78 present, 8 elsewhere, 58 missing — are in that section.

| Desktop page | ✅ | 📍 | 🚧 | ❌ |
|---|---|---|---|---|
| General | 9 | — | 3 | 6 |
| Input line | 8 | — | — | 2 |
| Main display | 19 | — | — | 1 |
| Editor | 5 | — | 1 | — |
| Color view | 24 | — | — | — |
| Mapper | 7 | — | 13 | 1 |
| Mapper colors | 8 | — | 20 | — |
| Chat | — | — | — | 20 |
| Connection | 6 | 1 | — | 4 |
| Shortcuts | — | — | 1 | — |
| Accessibility | 7 | — | — | — |
| Special Options | 8 | 1 | 3 | 3 |
| **Total** | **101** | **2** | **41** | **37** |

Three things the totals don't show, and which matter more than the totals do:

- **Parity is not evenly spread.** Accessibility, Color view and Main display are
  complete. Mapper colors is still thin and Shortcuts is empty.
- **Most of what remains is one block.** The 16 map ANSI colours are 16 of the 41, and
  they are blocked on the renderer rather than on us.
- **Mudlet Web has settings desktop Mudlet does not** — see
  [Web-only settings](#web-only-settings). The divergence runs both ways, so "8 tabs
  against 12 pages" understated the overlap even before this.

### What was built

The audit's first pass counted 78 present, 8 reachable only from elsewhere, 58 missing
and 37 impossible. Acting on it closed 29 rows:

- **Reachable elsewhere is not reachable.** All but one of the 📍 rows are now in
  Settings: the map file actions, "show the default area" (previously Lua-only), and a
  door into the Logs browser where the log format and timestamp choices live. Only
  "Forget saved sign-in" stays elsewhere, because the credential vault manages logins
  one at a time rather than as a single switch.
- **Missing settings, built**: server data encoding, highlight history, disable password
  masking, react to all keybindings, the double-click word-break characters, ambiguous
  East Asian width, the SGR colour-space id, the map grid colour and width, browser
  spell checking, clearing stored media, a usage-analytics opt-out, and an Editor
  category carrying five of desktop's six rows.
- **Labels are Mudlet's own strings.** Every row above that has a desktop counterpart
  uses its exact wording, checked against `profile_preferences.ui` — so a player who
  knows the desktop dialog searches for the words they already know. Where a card
  groups rows, the group box's title is the card title, and where Mudlet splits a page
  into group boxes (Editor's Theme / Autocomplete / Display options) so does this.
- **The impossible ones now say so in the app.** Each affected category carries a "Not
  available in the browser" card naming the desktop setting and what the browser
  withholds. The shell indexes card text off the DOM, so searching the desktop wording
  finds the explanation.

What is still 🚧 and why, in short: the 16 map ANSI colours, room border, upper/lower
level and overlapping-room colours, and most Map view options need fields
`mudlet-map-renderer` does not expose. Interface language needs a translation layer.
The shortcut editor needs a shortcut registry that does not exist. Two are deliberately
left alone — desktop's timer-size debug threshold and "Report all Codepoint problems
immediately" configure diagnostics mudix does not have, so the setting would be a knob
attached to nothing; they become worth adding when the diagnostic does. Text analyzer,
log naming and "Show Line/Paragraphs" are simply not done yet.

---

## General

### Icon sizes

| Desktop | | Mudlet Web |
|---|---|---|
| Icon size toolbars | ❌ | The toolbar scales with the page; there is no icon-size control |
| Icon size in tree views | ❌ | Same |
| Show menu bar | ❌ | There is no menu bar — the browser's chrome is the window's |
| Show main toolbar | ✅ | Appearance → Toolbar → **Fullscreen mode**. On/off, rather than desktop's Never / Until a key is pressed / Always |

### Language & data encoding

| Desktop | | Mudlet Web |
|---|---|---|
| Interface language | 🚧 | English only. There is no translation layer at all, so this is a project rather than a setting |
| Server data encoding | ✅ | General → Data encoding. The CHARSET handler and `MudSession.setServerEncoding` were already finished; the combo box over `SUPPORTED_SERVER_ENCODINGS` is what was missing. Stored per profile and re-applied across reconnects |

### Miscellaneous

| Desktop | | Mudlet Web |
|---|---|---|
| Appearance (Dark / Light / System setting) | ✅ | Appearance → Theme, with all three of desktop's choices plus two extra looks (amber, sky). "System setting" is a stored choice that resolves to a palette at read time, so an OS flip repaints without a reload (`src/utils/systemTheme.ts`) |
| Auto save on exit | ❌ | There is no exit to save on. Profile data is written continuously (debounced `saveProfileData`), so the setting's "off" position has nothing to mean |
| Notify on new data | ✅ | General → Notifications |
| Mudlet handles `telnet://` / `telnets://` links | ❌ | `navigator.registerProtocolHandler` only accepts schemes on the HTML spec's safelist, and `telnet` is not on it. A page cannot claim the scheme |

### Game protocols

| Desktop | | Mudlet Web |
|---|---|---|
| Choose protocols | ✅ | Connection → Game protocols, and **more granular**: eleven options individually (CHARSET, GMCP, MCCP, MNES, MSDP, MSP, MSSP, MTTS, MXP, NAWS, NEW-ENVIRON) |
| Allow server to install script packages | ✅ | Privacy and security → Server permissions |
| Allow server to download and play media | ✅ | Same card |

### Log options

| Desktop | | Mudlet Web |
|---|---|---|
| Save log files in HTML instead of plain text | ✅ | Both are recorded for every line and the format is chosen at export (HTML, ZIP, JSON). General → Log options now opens the Logs browser, where that choice lives |
| Add timestamps at the beginning of log lines | ✅ | Timestamps are always recorded; the Logs browser toggles whether they show, and Settings now leads there |
| Save log files in: (folder) | ❌ | Logs live in IndexedDB. A page cannot write to a folder without a per-save user gesture, so an unattended per-line log file is not possible |
| Log format (combo) | 🚧 | No naming or format control |
| Log name | 🚧 | Sessions are named by timestamp |
| — | | *Web-only:* **Record session logs** on/off, per profile (desktop starts logging from its toolbar instead) |

---

## Input line

### Input

| Desktop | | Mudlet Web |
|---|---|---|
| Strict UNIX line endings | ✅ | Input line → Input |
| Auto clear the input line after you sent text | ✅ | Same card |
| Highlight history | ✅ | Input line → Input. A command recalled with Up/Down comes back selected |
| React to all keybindings on the same key | ✅ | Input line → Input. `KeyEngine` gained a run-every-match path for both temp and permanent keys; off by default, as on desktop |
| Disable password masking | ✅ | Input line → Input |
| Show sent commands | ✅ | Same card |
| Command separator | ✅ | Same card |
| Command line minimum height in pixels | ❌ | The command bar is a textarea that grows to fit what you type |
| — | | *Web-only:* **Command history size** |

### Spell checking

| Desktop | | Mudlet Web |
|---|---|---|
| System/Mudlet dictionary | ✅ | Input line → **Spell checking**, desktop's own group-box title. The row is worded differently on purpose — desktop's checkbox sits beside a dictionary picker, and there is no picker here: the browser's spellchecker is the only one a page can reach, and its word list belongs to the OS. Off by default, since a command line is full of game words no dictionary has. Never applied to the password field |
| User dictionary (Profile / Shared) | ❌ | A word list belongs to the spellchecker, and the browser's is the operating system's |

---

## Main display

### Font

| Desktop | | Mudlet Web |
|---|---|---|
| Font | ✅ | Main display → Font, with a picker that also offers fonts stored in the profile |
| Size | ✅ | Same card |
| Enable anti-aliasing | ❌ | Browsers do not expose font smoothing as a switch |

### Display Border

| Desktop | | Mudlet Web |
|---|---|---|
| Top / Bottom / Left / Right border | ✅ | Main display → Borders, all four |

### Word wrapping

| Desktop | | Mudlet Web |
|---|---|---|
| Wrap lines at | ✅ | Main display → Word wrapping |
| Indent wrapped lines by | ✅ | Same card |
| Indent hanging wrapped lines by | ✅ | Same card |
| Undo the game's own wrapping at | ✅ | Same card |

### Scrollback

| Desktop | | Mudlet Web |
|---|---|---|
| Main display size | ✅ | Main display → Scrollback |
| Use maximum lines possible | ✅ | Same card |

### Double-click

| Desktop | | Mudlet Web |
|---|---|---|
| Stop selecting a word on these characters | ✅ | Main display → Display options. The browser picks the word and `wordSelection.ts` narrows the selection afterwards — the browser’s own word rules are not configurable |

### Display options

| Desktop | | Mudlet Web |
|---|---|---|
| Fix unnecessary linebreaks on GA servers | ✅ | Moved to Connection → Compatibility, with the other server workarounds |
| Enable text analyzer | 🚧 | |
| Make 'Ambiguous' E. Asian width characters wide | ✅ | Main display → Display options, backed by Kuhn’s `mk_wcwidth_cjk` table in `wcwidth.ts`. Applies to lines drawn after the change |
| Echo Lua errors to the main console | ✅ | Advanced → Developer |
| Display control characters as | ✅ | Main display → Display options |
| Show connection status on tabs | ✅ | Appearance → Profile tabs |
| — | | *Web-only:* **Enable OSC 8 hyperlinks from the server**; **Search selected text on** (desktop keeps its search engine over on Special Options) |

---

## Editor

The whole page is absent, and the underlying options are hard-coded rather than merely
unexposed — each row below is a decision taken away from the player.

| Desktop | | Mudlet Web |
|---|---|---|
| Theme (colorsublime themes) | ✅ | Editor → Theme: Follow app theme / Atom One Dark / Atom One Light. Not desktop's downloadable colorsublime catalogue — the two palettes mudix already ships, pinnable, which is the part of that feature people use (a dark editor under a light interface, or the reverse) |
| Autocomplete Lua functions in code editor | ✅ | Editor → Display options. Held in a CodeMirror compartment, so a change reconfigures the open editor rather than remounting it |
| Show Spaces/Tabs | ✅ | Editor → Display options (`highlightWhitespace`) |
| Show Line/Paragraphs | 🚧 | |
| Show invisible Unicode control characters | ✅ | Editor → Display options (`highlightSpecialChars`) |
| Show Items’ ID number | ✅ | Editor → Display options; the id shows beside each name in the editor tree |

---

## Color view

The one page with **complete** parity, and then some.

| Desktop | | Mudlet Web |
|---|---|---|
| Foreground, Background | ✅ | Main display → Colors |
| Command line foreground / background | ✅ | Same card |
| Command foreground / background | ✅ | Same card |
| Server allowed to redefine these colors | ✅ | Same card |
| The 16 ANSI colours | ✅ | Main display → ANSI palette |
| Reset all colors to default | ✅ | Both cards have a reset, shown only once something is customised |

---

## Mapper

### Map files

| Desktop | | Mudlet Web |
|---|---|---|
| Save your current map / choose location | ✅ | Mapper → Map files → **Save now**. The map is persisted on every change anyway; `saveMap(path)` from Lua still writes a copy into profile files |
| Report map issues on screen | 🚧 | |
| Load another map file in | ✅ | Mapper → Map files → **Load map…**, offering profile files and a local upload. Still on the map panel’s menu too |
| Or load an older version | 🚧 | No version history is kept |
| Delete map | 🚧 | |
| Copy map to other profile(s) | 🚧 | |
| Map format version | 🚧 | Reads every version the binary reader supports; writes the reader's default |

### Map download

| Desktop | | Mudlet Web |
|---|---|---|
| Download latest map provided by your game | ✅ | Mapper → Map files → **Download**, gated on the GMCP `Client.Map` URL. Still on the map panel’s menu too |

### Map view

| Desktop | | Mudlet Web |
|---|---|---|
| Use high quality graphics in 2D view | ❌ | The canvas renderer is always antialiased |
| Draw rooms on upper and lower levels | 🚧 | |
| Invert zoom direction | 🚧 | |
| Show room borders | ✅ | Mapper → Map view |
| Use large area exit arrows in 2D view | 🚧 | |
| Show the default area in map area selection | ✅ | Mapper → Map view. `setDefaultAreaShown()` sets the same value |
| Room size | ✅ | Mapper → Map view |
| Exit size | ✅ | Same card |
| Border size | 🚧 | |
| Grid width | ✅ | Mapper → Map colors, as the renderer’s `gridSize` |
| — | | *Web-only:* **Room shape**, **Show grid**, **Simplify dense levels** (the level-of-detail tiers) |

### Symbols

| Desktop | | Mudlet Web |
|---|---|---|
| 2D Map Room Symbol Font | 🚧 | |
| Show symbol usage… | 🚧 | |
| Only use symbols (glyphs) from chosen font | 🚧 | |

---

## Mapper colors

Present as a card, but a thin one: three of the eight named colours, and none of the 16.

| Desktop | | Mudlet Web |
|---|---|---|
| Link color | ✅ | Mapper → Map colors, as **Exit lines** |
| Background color | ✅ | Same card |
| Map info background | ✅ | Same card — *plus an opacity slider desktop has no equivalent for* |
| Room border color | 🚧 | |
| Lower level color | 🚧 | |
| Upper level color | 🚧 | |
| Overlapping rooms border | 🚧 | |
| Grid color | ✅ | Mapper → Map colors |
| The 16 map ANSI colours | 🚧 | Sixteen rows, none of them present. The single largest block of missing settings in the client |
| Reset all colors to default | 🚧 | |

### Player room marker

| Desktop | | Mudlet Web |
|---|---|---|
| 2D map player room marker style | ✅ | Mapper → Player room marker |
| Outer ring color | ✅ | As **Outline** |
| Inner ring color | ✅ | As **Fill** |
| — | | *Web-only:* **Size**, **Thickness**, **Dashed outline** with dash/gap lengths, **Match room shape** |

---

## Chat

Absent, and correctly so — both halves need capabilities a browser tab does not have.

| Desktop | | Mudlet Web |
|---|---|---|
| Discord Rich Presence (11 controls) | ❌ | Rich Presence needs Discord's local IPC socket. The Lua API is bound as warning-emitting stubs, so packages that call it still install and run |
| MudMaster Chat / MMCP (9 controls) | ❌ | MMCP is peer-to-peer TCP: it listens on a port and dials other clients directly. A page can open neither a listening socket nor a raw outbound one |

---

## Connection

| Desktop | | Mudlet Web |
|---|---|---|
| TLS/SSL secure connection | ✅ | Privacy and security → TLS/SSL secure connection |
| Certificate: Issuer / Issued to / Expires / Serial | ✅ | Shown when the bridge can inspect the certificate. The stock Cloudflare Workers proxy **cannot** — the card says so, and points at self-hosting the Node proxy. Direct WebSocket connections are validated by the browser, which never exposes the certificate to script |
| Accept self-signed certificates | ✅ | Same card, same caveat |
| Accept expired certificates | ✅ | Same card, same caveat |
| Accept all certificate errors (unsecure) | ✅ | Same card, same caveat |
| Allow secure connection reminder | ✅ | Privacy and security |
| Forget saved sign-in | 📍 | Privacy and security → Passwords opens the credential vault, which manages saved logins individually |
| Connect to the game via proxy (address, port, username, password) | ❌ | **Means something different here.** A page cannot route a socket through a SOCKS or HTTP proxy; that is the user agent's business. Mudlet Web's "proxy" is the telnet↔WebSocket bridge without which telnet games are unreachable at all, and it is configured per-connection in the connection form rather than globally. See [Connecting to a MUD](help/connecting.md) |

---

## Shortcuts

| Desktop | | Mudlet Web |
|---|---|---|
| Main window shortcuts (rebinding editor) | 🚧 | The client's own shortcuts are fixed. Game keybindings are fully supported through the key engine and the editor; it is only Mudlet's *own* accelerators that cannot be rebound. Note the ceiling: combinations the browser has claimed (Ctrl+T, Ctrl+W, Ctrl+N…) never reach the page, so an editor here would have to say so rather than accept them |

---

## Accessibility

**Complete parity** — all seven, matching desktop row for row.

| Desktop | | Mudlet Web |
|---|---|---|
| Announce incoming text in screen reader | ✅ | Accessibility → Screen reader |
| Advertise screen reader use via NEW-ENVIRON, MNES, MTTS | ✅ | Same card |
| Enable closed caption for media | ✅ | Accessibility → Text and media |
| When the game sends blank lines | ✅ | Same card |
| Enable blinking text | ✅ | Same card |
| Switch between input line and main window using | ✅ | Accessibility → Keyboard |
| Enable F3 search shortcuts | ✅ | Same card |

---

## Special Options

| Desktop | | Mudlet Web |
|---|---|---|
| Force compression off | ✅ | Untick **MCCP** in Connection → Game protocols. The `specialForceCompressionOff` config key maps onto it, so scripts that set it keep working |
| Force new line on empty commands | 🚧 | |
| Force telnet GA signal interpretation off | ✅ | Connection → Compatibility |
| Send Mudlet version in terminal type | ✅ | Same card |
| Force MXP processing on | ✅ | Same card |
| Additional text wait time | ✅ | Connection → Network |
| Search Engine | ✅ | Main display → Display options |
| Clear stored media | ✅ | Sound and media → Clear stored media, reporting the file count and size and confirming before it deletes. Clears `media/` in the profile — the mirror of what the game asked to play — and nothing else |
| Disable automatic updates | ❌ | A web app is whatever the server last served; a reload is the update |
| Show icons on menus | ❌ | No menus |
| Expect Color Space Id in SGR...(3\|4)8;2;...m codes | ✅ | Main display → Display options. `FormatState` read only `38;2;r;g;b`; the T.416 `38;2;<id>;r;g;b` form shifted every channel and the leftover parameter was then read as its own SGR code |
| Store character login passwords in | 📍 | Privacy and security → Passwords. The web equivalent is the credential vault — encrypted on the device, unlocked by passkey or password — rather than a choice between the profile file and an OS keyring |
| Show debug messages for timers not smaller than | 🚧 | |
| Report all Codepoint problems immediately | 🚧 | |
| Crash report sending policy | ❌ | There is no crash reporter to gate — the browser reports its own crashes under its own settings. The nearest thing the web build *does* have is the usage beacon, which now has an opt-out: Privacy and security → Usage statistics. It needs its own localStorage key rather than a store field, because the Matomo snippet in `index.html` runs before any module loads |

---

## Web-only settings

Rows Mudlet Web has that desktop Mudlet does not, either because the browser makes them
necessary or because desktop keeps the equivalent somewhere other than preferences.

| Setting | Where | Why it exists |
|---|---|---|
| Desktop notifications | General → Notifications | Browser notification permission has to be asked for, so `showNotification()` needs a switch |
| Record session logs | General → Log options | Logging is continuous rather than started from a toolbar |
| Fullscreen mode | Appearance → Toolbar | Stands in for desktop's menu/toolbar visibility combos |
| Enable OSC 8 hyperlinks from the server | Main display → Display options | |
| Search selected text on | Main display → Display options | Desktop has this too, over on Special Options |
| Command history size | Input line → Input | |
| Room shape, Show grid, Simplify dense levels | Mapper → Map view | The LOD tiers are a web-renderer concern; desktop's map is native |
| Map info background opacity | Mapper → Map colors | |
| Player marker size / thickness / dash / gap / match room shape | Mapper → Player room marker | |
| Mute all media, Mute Mudlet sounds, Mute game sounds | Sound and media | Desktop keeps its mute switches on a toolbar |
| WebSocket subprotocol | Connection → Game protocols | No desktop equivalent — there is no WebSocket handshake on desktop |
| Connection security (live TLS status) | Privacy and security | Read-only counterpart to desktop's certificate box |

---

## What to fix first

Ranked by how many players hit it, not by how much work it is.

1. **Mapper colors** — 20 rows, 16 of them the map's own ANSI palette. Needs
   `mudlet-map-renderer` to expose per-index room colours first, so it starts upstream
   and is now much the largest thing left.
2. **Shortcut rebinding** — the largest item we could start ourselves, and the one with
   a real ceiling: combinations the browser has claimed never reach the page, so the
   editor would have to say so rather than accept them.
3. **The remaining Map view options** — draw upper/lower levels, invert zoom, large area
   exit arrows, border size, room symbols. Renderer-blocked like the colours.
4. **Log naming and format** — sessions are named by timestamp with no template.
5. **Text analyzer** — a dialog rather than a setting, which is why it keeps sliding.

Two rows are deliberately *not* on this list. "Show debug messages for timers not
smaller than" and "Report all Codepoint problems immediately" configure diagnostics
mudix does not have: there is no timer-size warning and no codepoint-problem reporting
to threshold. Adding the setting without the diagnostic would be a knob attached to
nothing — the work is the diagnostic, and it is a feature request rather than a
settings gap.

Everything else is either genuinely inapplicable, blocked upstream in the renderer, or
small enough to take when the surrounding page is next touched.
