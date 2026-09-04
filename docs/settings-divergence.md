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

| Desktop page | ✅ | 📍 | 🚧 | ❌ |
|---|---|---|---|---|
| General | 6 | 2 | 4 | 6 |
| Input line | 4 | — | 4 | 2 |
| Main display | 16 | — | 3 | 1 |
| Editor | — | — | 6 | — |
| Color view | 24 | — | — | — |
| Mapper | 3 | 4 | 13 | 1 |
| Mapper colors | 6 | — | 22 | — |
| Chat | — | — | — | 20 |
| Connection | 6 | 1 | — | 4 |
| Shortcuts | — | — | 1 | — |
| Accessibility | 7 | — | — | — |
| Special Options | 6 | 1 | 5 | 3 |
| **Total** | **78** | **8** | **58** | **37** |

Three things the totals don't show, and which matter more than the totals do:

- **Parity is not evenly spread.** Accessibility and Color view are complete. Editor,
  Shortcuts and Mapper colors are close to empty. A player who never opens the script
  editor and never recolours the map sees a near-complete client; one who does sees a
  conspicuously thin one.
- **A third of the "missing" count is two blocks.** The 16 map ANSI colours and the six
  Editor rows are 22 of the 58. The long tail is genuinely long-tail.
- **Mudlet Web has settings desktop Mudlet does not** — see
  [Web-only settings](#web-only-settings). The divergence runs both ways, so "8 tabs
  against 12 pages" understates the overlap.

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
| Server data encoding | 🚧 | **The engine already has this.** `MudClient.setServerEncoding()` and the full CHARSET handler are wired up and reachable from Lua (`setServerEncoding()`); nothing in Settings calls them. A player on a game that needs Latin-2 has to write a script |

### Miscellaneous

| Desktop | | Mudlet Web |
|---|---|---|
| Appearance (Dark / Light / System setting) | ✅ | Appearance → Theme, with two extra looks (amber, sky) — but **no "System setting"**, so a light-mode OS still opens dark. Tracked as issue #71 item 2 |
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
| Save log files in HTML instead of plain text | 📍 | Both are recorded for every line; the choice is made at export time, from the Logs browser (HTML, ZIP, JSON) |
| Add timestamps at the beginning of log lines | 📍 | Timestamps are always recorded; the Logs browser has a live show/hide toggle |
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
| Highlight history | 🚧 | Recalled commands are not visually distinguished |
| React to all keybindings on the same key | 🚧 | `KeyEngine` returns on the first match — desktop's behaviour with the box **unticked**. The default matches; only the choice is missing |
| Disable password masking | 🚧 | |
| Show sent commands | ✅ | Same card |
| Command separator | ✅ | Same card |
| Command line minimum height in pixels | ❌ | The command bar is a textarea that grows to fit what you type |
| — | | *Web-only:* **Command history size** |

### Spell checking

| Desktop | | Mudlet Web |
|---|---|---|
| System/Mudlet dictionary | 🚧 | No Hunspell in the bundle — but the command bar sets `spellCheck={false}` explicitly, so the *browser's own* spellchecker is one prop away. The cheapest real win on this page |
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
| Stop selecting a word on these characters | 🚧 | Double-click selection uses the browser's word rules, which are not tunable from script |

### Display options

| Desktop | | Mudlet Web |
|---|---|---|
| Fix unnecessary linebreaks on GA servers | ✅ | Moved to Connection → Compatibility, with the other server workarounds |
| Enable text analyzer | 🚧 | |
| Make 'Ambiguous' E. Asian width characters wide | 🚧 | `src/mud/text/wcwidth.ts` fixes ambiguous-width characters at **narrow**. Games that draw box art out of them misalign, with nothing to turn |
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
| Theme (colorsublime themes) | 🚧 | The CodeMirror editor follows the app theme (`src/ui/codemirror/theme.ts` — One Dark / One Light). No separate picker |
| Autocomplete Lua functions in code editor | 🚧 | Hard-coded on: `autocompletion({ activateOnTyping: true })`, `LuaEditor.tsx:118` |
| Show Spaces/Tabs | 🚧 | |
| Show Line/Paragraphs | 🚧 | |
| Show invisible Unicode control characters | 🚧 | |
| Show Items' ID number | 🚧 | The script tree shows names only |

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
| Save your current map / choose location | 📍 | The map is persisted to the profile's IndexedDB slot on every change; `saveMap(path)` from Lua writes a copy into profile files |
| Report map issues on screen | 🚧 | |
| Load another map file in | 📍 | Map panel menu → **Load map…**, which offers both profile files and a local upload |
| Or load an older version | 🚧 | No version history is kept |
| Delete map | 🚧 | |
| Copy map to other profile(s) | 🚧 | |
| Map format version | 🚧 | Reads every version the binary reader supports; writes the reader's default |

### Map download

| Desktop | | Mudlet Web |
|---|---|---|
| Download latest map provided by your game | 📍 | Map panel menu → **Download map from game**, gated on the GMCP `Client.Map` URL |

### Map view

| Desktop | | Mudlet Web |
|---|---|---|
| Use high quality graphics in 2D view | ❌ | The canvas renderer is always antialiased |
| Draw rooms on upper and lower levels | 🚧 | |
| Invert zoom direction | 🚧 | |
| Show room borders | ✅ | Mapper → Map view |
| Use large area exit arrows in 2D view | 🚧 | |
| Show the default area in map area selection | 📍 | Settable only from Lua (`setDefaultAreaShown()`). The value is in `MapperSettings.showDefaultArea` with no row to reach it |
| Room size | ✅ | Mapper → Map view |
| Exit size | ✅ | Same card |
| Border size | 🚧 | |
| Grid width | 🚧 | |
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
| Grid color | 🚧 | |
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
| Clear stored media | 🚧 | Downloaded media accumulates in the profile with no purge control; deleting the files by hand from the file browser is the only route |
| Disable automatic updates | ❌ | A web app is whatever the server last served; a reload is the update |
| Show icons on menus | ❌ | No menus |
| Expect Color Space Id in SGR…(3\|4)8;2;…m codes | 🚧 | **Verified against the parser.** `FormatState.ts` reads `38;2;r;g;b` only; a server sending the colour-space-id form (`38;2;<id>;r;g;b`) renders in the wrong colours with nothing to turn. Desktop makes this a checkbox for exactly that reason |
| Store character login passwords in | 📍 | Privacy and security → Passwords. The web equivalent is the credential vault — encrypted on the device, unlocked by passkey or password — rather than a choice between the profile file and an OS keyring |
| Show debug messages for timers not smaller than | 🚧 | |
| Report all Codepoint problems immediately | 🚧 | |
| Crash report sending policy | ❌ | There is no crash reporter. **But** the deployed build loads an analytics beacon unconditionally with no opt-out anywhere in Settings — the nearest thing to this row, and it is missing. Tracked as issue #71 item 4 |

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

1. **Server data encoding** — the engine is finished; this is a combo box wired to
   `setServerEncoding()`. Every player on a non-English game is affected, and today the
   workaround is to write a script.
2. **"System setting" appearance** — one entry in the theme picker plus a
   `prefers-color-scheme` listener. Every light-mode user opens the app dark (#71-2).
3. **Mapper colors** — 22 missing rows, and the card that does exist is thin enough to
   read as an oversight rather than a decision.
4. **Ambiguous East Asian width** — silently misdraws box art, with no way out.
5. **SGR colour-space id** — silently misdraws colour, with no way out.
6. **Editor options** — six settings, all currently hard-coded.
7. **Browser spellcheck on the command line** — one prop, already deliberately off.
8. **An analytics opt-out** — desktop gates its equivalent behind an explicit policy
   choice; the web build has none.

Everything else is either genuinely inapplicable, or small enough to take when the
surrounding page is next touched.
