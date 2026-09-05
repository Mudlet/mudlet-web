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

The **Desktop** column is verbatim Mudlet, down to its capitalisation and its ASCII
ellipses — that is what makes it checkable against the `.ui`, and what lets a player
searching Settings for the words they know from the desktop dialog find them.

> **Re-running this comparison.** Walk the `.ui` line by line, tracking the current
> `<widget>` and the current `<property>`, and take the first `<string>` inside a `text`
> or `title` property. Do **not** run a single `/<string[^>]*>(.*?)<\/string>/` over the
> whole file: a self-closing `<string/>` (an empty label — several exist here) opens a
> match that runs on to the next `</string>` and swallows every widget in between.
> "Spell checking" and "Grid color:" are the two that vanish first, which is a quiet way
> to conclude a setting is absent when it is merely unparsed.

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

**Generated from the rows below** — run `node scripts/settings-audit-count.mjs
docs/settings-divergence.md` and paste the result here after changing any row. It was
maintained by hand at first and drifted four times, the last by five settings across four
pages, always in the flattering direction. The unit is a setting, not a row: a handful of
rows collapse a block of identical controls under one label, and the script knows which.

| Desktop page | ✅ | 📍 | 🚧 | ❌ |
|---|---|---|---|---|
| General | 9 | — | 1 | 8 |
| Input line | 8 | — | — | 2 |
| Main display | 19 | — | — | 1 |
| Editor | 6 | — | — | — |
| Color view | 24 | — | — | — |
| Mapper | 11 | — | 6 | 2 |
| Mapper colors | 8 | — | 20 | — |
| Chat | — | — | — | 20 |
| Connection | 10 | — | — | 4 |
| Shortcuts | — | — | 1 | — |
| Accessibility | 7 | — | — | — |
| Special Options | 9 | — | 2 | 3 |
| **Total** | **111** | **—** | **30** | **40** |

Two rows are marked ⚠️ rather than counted: "Border size", which the renderer merges into
`lineWidth` alongside exit size, and "Show symbol usage…", which is built but without the
two columns that would need per-glyph font-coverage testing. Neither is present or
absent.

Three things the totals don't show, and which matter more than the totals do:

- **Parity is not evenly spread.** Accessibility, Color view, Main display and Editor are
  complete. Mapper colors is still thin and Shortcuts is empty.
- **Most of what remains is blocked upstream — but check before you say so.** 24 of the
  30 need a field `mudlet-map-renderer` does not have, and each of those rows now names
  the field. An earlier pass called the whole map backlog blocked, which was wrong twice over:
  the room symbol font was the renderer's `fontFamily` all along, and "Border size" is
  merged into `lineWidth` rather than absent. Both are marked as such now, and the rule is
  that "blocked upstream" cites a field, not a memory.
- **Mudlet Web has settings desktop Mudlet does not** — see
  [Web-only settings](#web-only-settings). The divergence runs both ways, so "8 tabs
  against 12 pages" understated the overlap even before this.

### What was built

The audit's first pass counted 78 present, 8 reachable only from elsewhere, 58 missing
and 37 impossible. Acting on it closed 29 rows, and
[issue #128](https://github.com/Mudlet/mudlet-web/issues/128) closed four more:

- **Reachable elsewhere is not reachable.** The 📍 column is now empty. The map file
  actions, "show the default area" (previously Lua-only), a door into the Logs browser
  where the log format and timestamp choices live, and both vault rows are all in
  Settings. "Forget saved sign-in" was the last holdout and the weakest excuse: the
  vault modal did offer it, but only as one row in a list of every profile, where
  desktop puts the button on the profile's own page.
- **Missing settings, built**: server data encoding, highlight history, disable password
  masking, react to all keybindings, the double-click word-break characters, ambiguous
  East Asian width, the SGR colour-space id, the map grid colour and width, the room
  symbol font, browser spell checking, clearing stored media, a usage-analytics opt-out,
  deleting the map, "force new line on empty commands", and an Editor category carrying
  five of desktop's six rows.
- **One of those was a behaviour gap, not a missing switch.** mudix echoed empty
  commands unconditionally, so a GA game with the linebreak fix on still got the blank
  line that fix exists to remove. `MudSession` now applies Mudlet's own rule from
  `Host::send`, and the checkbox turns the echo back on.
- **Labels are Mudlet's own strings.** Every row above that has a desktop counterpart
  uses its exact wording, checked against `profile_preferences.ui` — so a player who
  knows the desktop dialog searches for the words they already know. Where a card
  groups rows, the group box's title is the card title, and where Mudlet splits a page
  into group boxes (Editor's Theme / Autocomplete / Display options) so does this.
- **The impossible ones stay out of the app.** They were briefly a "Not available in the
  browser" card at the foot of each affected category, naming the desktop setting and
  what the browser withholds. That was the wrong place for them: it spent screen in a
  dialog of things you can change on a list of things you cannot, and taught the desktop
  manual's vocabulary to players who had never met it. The reasons live in the ❌ rows of
  this file, and a player who does go looking finds the prose version in
  [docs/help/settings.md](help/settings.md) — the "Mudlet differences" topic linked from
  the Settings shell. So an ❌ row here is the whole record: write the reason, not a
  pointer to a card.

### What is left, and what is not planned

Everything still marked 🚧 is now a decision rather than a backlog: nothing here is
waiting only on someone finding the time.

[Issue #128](https://github.com/Mudlet/mudlet-web/issues/128) tracked the last five that
*were*, and four landed: the text analyzer, the editor's "Show Line/Paragraphs", "report
map issues on screen", and the symbol usage report — that one at ⚠️, since the two
columns saying whether a font can draw a symbol need per-glyph coverage testing a browser
does not offer. The fifth, **map format version**, is now an ❌: it was filed as ordinary
work here on the assumption that `mudlet-map-binary-reader` could write any format its
reader accepts, and it cannot — nor is it meant to. Saving a map for an older Mudlet is a
thing to do in desktop Mudlet, which still writes those formats.

**Not planned** (30). Not a judgement about whether they are worth having — a statement
that building them here is not the next move:

- *Blocked upstream in `mudlet-map-renderer`* (24). The 16 map ANSI colours (the
  environment palette, which the renderer reads from map data with no override), room
  border, upper/lower level and overlapping-room colours, drawing rooms on adjacent
  z-levels, the area-exit arrow size, invert zoom direction, and "only use glyphs from
  the chosen font". Each row names the field it would need. Most of this is one upstream
  change — a colour-override table plus a handful of flags — after which the UI here is
  small. Invert zoom is the odd one out: the renderer owns the wheel handler, so doing
  it here would mean swallowing the event and synthesising a replacement.
- *Needs a subsystem that does not exist* (2). Interface language wants a translation
  layer; the shortcut editor wants a shortcut registry. Both are projects in their own
  right, and the shortcut editor has a ceiling besides — combinations the browser has
  claimed can never be bound, so the editor would have to refuse them.
- *A knob attached to nothing* (2). Desktop's timer-size debug threshold and "Report all
  Codepoint problems immediately" configure diagnostics mudix does not emit. The warning
  is the feature; the threshold only becomes worth adding once there is something to
  threshold.
- *Cheaper as an export than as a setting* (2). Loading an older map version needs
  version history that is not stored, and copying a map to another profile crosses a
  profile boundary the export path deliberately mounts one at a time. Both are already
  reachable by exporting the map and importing it where you want it.

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
| Save log files in HTML format instead of plain text | ✅ | Both are recorded for every line and the format is chosen at export (HTML, ZIP, JSON). General → Log options now opens the Logs browser, where that choice lives |
| Add timestamps at the beginning of log lines | ✅ | Timestamps are always recorded; the Logs browser toggles whether they show, and Settings now leads there |
| Save log files in: (folder) | ❌ | Logs live in IndexedDB. A page cannot write to a folder without a per-save user gesture, so an unattended per-line log file is not possible |
| Log format (combo) | ❌ | Both halves of desktop's naming scheme describe a file being appended to on disk as you play. Nothing here is: a session is a row in IndexedDB keyed by its start time, and a *file* only exists at the moment you export one, where you pick the format then (HTML, ZIP, JSON). There is no name to template and no format to fix in advance |
| Log name | ❌ | Same reason — the session has an identity, not a filename |
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
| Enable text analyzer | ✅ | Main display → Display options. Puts **Analyse characters** on the output's right-click menu, as desktop does; the report is a dialog rather than a hover tooltip (a `title` is one OS-drawn line, and a dialog can be read and copied), and its table is transposed — one row per character instead of desktop's rows of sixteen across — so it scrolls rather than reflows |
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
| Show Line/Paragraphs | ✅ | Editor → Display options. A custom CodeMirror decoration: `highlightWhitespace()` covers spaces and tabs only. Draws the marks the desktop tooltip promises (¶ at each line end, ␄ at the end of the script) rather than what desktop currently does, which is rule a line under each row — `slot_changeShowLineFeedsAndParagraphs` sets edbee's `useLineSeparator`, and its own comment calls that a stand-in |
| Show invisible Unicode control characters | ✅ | Editor → Display options (`highlightSpecialChars`) |
| Show Items’ ID number | ✅ | Editor → Display options. Shown beside each name in the editor **tree**, where desktop puts it on the selected item's own form instead (`frameId` in `aliases_main_area.ui` and its siblings, revealed by `dlgTriggerEditor::showIDLabels`) — the tree shows every id at once, which is what makes two same-named items tellable apart, and desktop's placement shows one at a time. The number is the one the Lua API answers with (`ScriptingEngine.numericIdFor`), not the store's UUID: reading off an id you could then pass to `enableTrigger` is the whole point of the option |

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
| report map issues on screen | ✅ | Mapper → Map files. Lower-cased in the .ui, and left that way here: this column is verbatim Mudlet. `MapStore.auditExits()` walks the map after every load and posts what it finds on the main console, in Mudlet's `[ WARN ]` / `[ INFO ]` form, capped at 100 lines. Report-only on a `.dat`: the JSON import path already repaired as it parsed and its report is what is shown there, but rewriting a player's binary map to make a report tidier is not a trade worth making. Desktop's alternative when the switch is off is a report *file*; there is none here, so off means the audit does not run at all — which is also what keeps it free on a large map |
| Load another map file in | ✅ | Mapper → Map files → **Load map…**, offering profile files and a local upload. Still on the map panel’s menu too |
| Or load an older version | 🚧 | No version history is kept |
| Delete map: | ✅ | Mapper → Map files. Empties the store *and* drops the profile's IndexedDB slot — clearing only the store would let the next change re-save the old map from memory. Confirms first, and points at "Save now" as the way to keep a copy |
| Copy map to other profile(s) | 🚧 | Buildable here, not blocked upstream — but it crosses a profile boundary, and the export path mounts profiles one at a time on purpose (concurrent mounts multiply peak memory by the largest map). The cheap shape is write-then-import rather than two live VFS handles |
| Map format version | ❌ | **Not planned, by a decision upstream.** Desktop offers 17-20 so a map can be taken back to an older Mudlet. `mudlet-map-binary-reader` reads all of 16-20 but writes only 20 — every legacy version model's `write` throws "Writing Mudlet map version N is not supported (read-only)" — and that is deliberate: its author does not intend it to save in an older format. So there is nothing for a picker to pick, now or later, and `MapStore.toMudletMap()` stamps 20 because 20 is the only version there will be to write. Saving a map for an older Mudlet stays a job for desktop Mudlet, which still writes those formats. `saveMap(path, version)` keeps accepting and range-checking the argument, since the Lua signature is Mudlet's |

### Map download

| Desktop | | Mudlet Web |
|---|---|---|
| Download latest map provided by your game | ✅ | Mapper → Map files → **Download**, gated on the GMCP `Client.Map` URL. Still on the map panel’s menu too |

### Map view

| Desktop | | Mudlet Web |
|---|---|---|
| Use high quality graphics in 2D view | ❌ | The canvas renderer is always antialiased |
| Draw rooms on upper and lower levels | 🚧 | Needs a renderer field. Its nearest neighbours are not it: `neighborSpill` draws rooms from adjacent *areas*, and `uniformLevelSize` only sizes the viewport across z-levels |
| Invert zoom direction | 🚧 | Blocked upstream, not merely unbuilt: the renderer owns the wheel handler and its `Settings` has no zoom-direction field. mudix only snapshots the camera in a capture-phase listener, so inverting here would mean swallowing the event and synthesising a replacement |
| Show room borders | ✅ | Mapper → Map view |
| Use large area exit arrows in 2D view | 🚧 | Needs a renderer field. `areaExitLabels` / `areaExitLabelFontSize` size the text label beside an area exit, not the arrow |
| Show the default area in map area selection | ✅ | Mapper → Map view. `setDefaultAreaShown()` sets the same value |
| Room size | ✅ | Mapper → Map view |
| Exit size | ✅ | Same card |
| Border size | ⚠️ | **Merged, not missing.** The renderer has one `lineWidth` for exit connections *and* room borders, where Mudlet has `mRoomBorderSize` separately from exit size. "Exit size" moves both; splitting them needs a second field upstream |
| Grid width: | ✅ | Mapper → Map colors, as the renderer's `gridLineWidth`. Mudlet's `mMapGridLineSize` is line *thickness*, not spacing — this was wired to the renderer's `gridSize` (spacing) at first, which is a different setting with no Mudlet counterpart |
| — | | *Web-only:* **Room shape**, **Show grid**, **Simplify dense levels** (the level-of-detail tiers) |

### Symbols

| Desktop | | Mudlet Web |
|---|---|---|
| 2D Map Room Symbol Font | ✅ | Mapper → Symbols. The renderer's `fontFamily` was there all along and mudix pinned it to the bundled Bitstream Vera Sans Mono; a profile family now wins, with that font still behind it as the fallback |
| Show symbol usage… | ⚠️ | **Four of desktop's six columns.** Mapper → Symbols → **Show** opens the report: each symbol drawn in the map's own symbol font, its code points, how many rooms carry it, and which (first 32, as desktop caps it), commonest first. Missing are desktop's pair of sample cells — the symbol in the chosen font alone, and in any font — and the status icon saying which worked. All three answer "can this font draw this symbol", which needs `QFontMetrics::inFontUcs4`: a browser has no counterpart, and the renderer draws the string and lets the browser fall back, so the client cannot tell its own glyph from the fallback's |
| Only use symbols (glyphs) from chosen font | 🚧 | Needs per-glyph coverage testing the renderer does not expose — it draws the string and lets the browser fall back |

---

## Mapper colors

Present as a card, but a thin one: three of the eight named colours, and none of the 16.

| Desktop | | Mudlet Web |
|---|---|---|
| Link color | ✅ | Mapper → Map colors, as **Exit lines** |
| Background color | ✅ | Same card |
| Map info background | ✅ | Same card — *plus an opacity slider desktop has no equivalent for* |
| Room border color | 🚧 | Needs a renderer field. Room strokes are drawn from the room's environment colour (`frameMode` / `coloredMode` decide how), with no override |
| Lower level color | 🚧 | Needs a renderer field, and the level-drawing above it |
| Upper level color | 🚧 | Needs a renderer field, and the level-drawing above it |
| Overlapping rooms border | 🚧 | Needs a renderer field; the renderer does not mark overlapping rooms at all |
| Grid color | ✅ | Mapper → Map colors |
| The 16 map ANSI colours | 🚧 | Sixteen rows, none present, and the largest single block left. These are the environment colours rooms are filled with; the renderer takes them from the map data and `Settings` has no palette to override them with, so this starts upstream |
| Reset all colors to default | ✅ | Mapper → Map colors, appearing only once something is customised (the Main display colour cards behave the same way). Clears the profile's overrides rather than writing defaults back, so the renderer's own values are in charge again — which is what "default" has to mean when the defaults live upstream |

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
| Forget saved sign-in | ✅ | Privacy and security → Passwords, as its own row — desktop puts the button on the profile's own page, and the vault modal only offered it as one row in a list of every profile. Disabled while the vault is locked (a locked vault cannot rewrite its ciphertext) and says so on the button |
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
| Advertise screen reader use via protocols supporting this notice (NEW-ENVIRON, MNES, MTTS) | ✅ | Same card, with Mudlet's own wording |
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
| Force new line on empty commands | ✅ | Connection → Compatibility, beneath the linebreak fix it depends on and disabled without it. This was a behaviour gap as much as a missing switch: mudix echoed empty commands unconditionally, so a GA game with the fix on still got the blank line the fix exists to remove. Now mirrors `Host::send` (Host.cpp:1461) exactly |
| Force telnet GA signal interpretation off | ✅ | Connection → Compatibility |
| Send Mudlet version in terminal type | ✅ | Same card |
| Force MXP processing on | ✅ | Same card |
| Additional text wait time | ✅ | Connection → Network |
| Search Engine | ✅ | Main display → Display options |
| Clear stored media | ✅ | Sound and media → Clear stored media, reporting the file count and size and confirming before it deletes. Clears `media/` in the profile — the mirror of what the game asked to play — and nothing else |
| Disable automatic updates | ❌ | A web app is whatever the server last served; a reload is the update |
| Show icons on menus | ❌ | No menus |
| Expect Color Space Id in SGR...(3\|4)8;2;...m codes | ✅ | Main display → Display options. `FormatState` read only `38;2;r;g;b`; the T.416 `38;2;<id>;r;g;b` form shifted every channel and the leftover parameter was then read as its own SGR code |
| Store character login passwords in | ✅ | Privacy and security → Passwords — but **replaced rather than ported**, and the row says so. Desktop's combo is a choice between the profile file and an OS keyring; a page can reach neither, so there is one storage mode (the encrypted vault) and it reads as a stated value, not a control with a single option |
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

Three rows are deliberately *not* on this list. "Show debug messages for timers not
smaller than" and "Report all Codepoint problems immediately" configure diagnostics
mudix does not have: there is no timer-size warning and no codepoint-problem reporting
to threshold. Adding the setting without the diagnostic would be a knob attached to
nothing — the work is the diagnostic, and it is a feature request rather than a
settings gap. **Map format version** is the third, and it is not waiting on anything:
`mudlet-map-binary-reader` is not going to save in older formats, so there is no version
list for this client to offer. Desktop Mudlet still writes them.

Everything else is either genuinely inapplicable, blocked upstream in the renderer, or
small enough to take when the surrounding page is next touched.
