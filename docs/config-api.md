# `setConfig` / `getConfig` Support

Mudlet's `setConfig(key, value)` / `getConfig(key)` are a flat key→value
preferences bag. Mudlet Web implements them as a **config registry** in
`ScriptingAPI` (`getConfig` / `setConfig`), with the base globals bound in
`LuaRuntime.ts` and the table-form / no-arg-dump variants layered on top by
bundled `Other.lua`.

## How it's wired

```
Lua: setConfig("enableMSDP", true) / getConfig("enableMSDP")
  → Other.lua wrappers (table form, no-arg "dump all")     src/scripting/lua/mudlet-lua/Other.lua
    → base globals  setConfig / getConfig                   src/scripting/lua/LuaRuntime.ts
      → ScriptingAPI.setConfig / .getConfig (registry)      src/scripting/ScriptingAPI.ts
        → ProfileSettings field  (protocols / mapper / autoClearInput /
                                  askTlsAvailable)
        → MudSession.echoSentText (live)
        → ProfileSettings.mapperPanelVisible  (mapperPanelVisible, live)
        → MapStore  (showMapInfo / hideMapInfo, live)
        → ProfileSettings.config bag  (persist-only + UI-consumed keys)
```

- **Base globals must be bound before the bundles load.** `Other.lua` captures
  `oldsetConfig = setConfig` / `oldgetConfig = getConfig` and wraps them; if the
  base global is nil the wrapper calls nil and throws. The binding block in
  `LuaRuntime.bootstrap` runs before the `doString`/`exec` of `LuaGlobal.lua`,
  so ordering holds.
- **Unknown key** → `getConfig` returns `nil`, `setConfig` returns `false`
  (matches Mudlet — no error).
- **Read-only key** → `setConfig` returns `false`.
- The no-arg `getConfig()` "dump all" and the table forms
  (`getConfig{...}` / `setConfig{...}`) are handled entirely in `Other.lua`,
  which calls the per-key base function once per entry — so the registry only
  ever deals with a single key.

## Key groups

### 1. Structured — routed to a real `ProfileSettings` field

These stay in sync with the Settings UI because they read/write the same field
the UI does. Protocol changes take effect on the **next connect** (same as
Mudlet); the rest are live.

| Config key | Backing field | Notes |
|---|---|---|
| `enableGMCP` | `protocols.gmcp` | next connect |
| `enableMSDP` | `protocols.msdp` | next connect |
| `enableMSP` | `protocols.msp` | next connect |
| `enableMSSP` | `protocols.mssp` | next connect |
| `enableMTTS` | `protocols.mtts` | next connect |
| `enableMXP` | `protocols.mxp` | next connect |
| `enableMNES` | `protocols.mnes` | next connect — restricted core variable set (telnet option 39) |
| `enableNEWENVIRON` / `enableNewEnviron` | `protocols.newEnviron` | next connect — extended NEW-ENVIRON variable set (telnet option 39). `enableNEWENVIRON` is Mudlet's canonical (all-caps) key; `enableNewEnviron` is a Mudlet Web alias. |
| `enableCHARSET` | `protocols.charset` | next connect — positive form of `specialForceCharsetNegotiationOff` (telnet CHARSET) |
| `enableNAWS` | `protocols.naws` | next connect — window-size negotiation (telnet option 31) |
| `specialForceMxpNegotiationOff` | `!protocols.mxp` | inverse flag |
| `specialForceCharsetNegotiationOff` | `!protocols.charset` | inverse flag |
| `specialForceCompressionOff` | `!protocols.mccp` | inverse flag — forces MCCP (option 86) off |
| `forceNewEnvironNegotiationOff` | `!(protocols.mnes \|\| protocols.newEnviron)` | inverse flag — disables both option-39 variants |
| `autoClearInputLine` | `autoClearInput` | live |
| `askTlsAvailable` | `askTlsAvailable` | live — whether an MSSP-advertised TLS port still earns a "switch to the secure port?" offer (Mudlet `Host::mAskTlsAvailable`). A **typed field, not a config-bag key**: the offer logic (`shouldOfferTlsUpgrade`) and the Settings → Network checkbox both read it, and declining an offer — or reverting a failed upgrade — clears it, so a script writing the bag instead would have been silently inert. Default `true`. |
| `mapRoomSize` | `mapper.roomSize` | positive number only; **unit-translated** — see [Map size units](#map-size-units) |
| `mapExitSize` | `mapper.lineWidth` | positive number only; **unit-translated** — see [Map size units](#map-size-units) |
| `mapRoundRooms` | `mapper.roomShape` | `true`→`roundedRectangle`, else `rectangle` |
| `mapShowRoomBorders` | `mapper.borders` | |
| `mapShowGrid` | `mapper.gridEnabled` | |
| `mapInfoColor` | `config.mapInfoColor` (`{r,g,b,a}`) | map-info widget **background** colour; `{r,g,b[,a]}` table, alpha defaults to 255. `MapPanel` paints `.map-info` with it; default is Mudlet's `{150,150,150,120}`. The Lua↔JS boundary marshals the table as an `"r,g,b,a"` string (Bridge.lua). |

### 2. Live — applied immediately to the session

| Config key | Effect |
|---|---|
| `showSentText` | Three-state echo mode stored in `MudSession.showSentText` (`'never'` / `'script'` / `'always'`). `never` suppresses the local echo of sent commands entirely; `script` (default) echoes unless a script passes `send(cmd, false)`; `always` echoes even then. Booleans / boolean-ish strings are accepted for back-compat (`true`→`script`, `false`→`never`); an unknown mode string is rejected (`setConfig`→`false`). Persisted to the `config` bag and re-applied on profile load (constructor of `ScriptingAPI`). **Credentials are exempt:** the auto-login password goes through `MudSession.sendSecret()`, which never echoes regardless of mode; user-typed passwords are also safe because `echoCommand` is gated on `shouldEchoCommand()` (false while the server is in password/echo-off mode). |
| `blankLinesBehaviour` | How empty server lines render in the main output (`'show'` / `'hide'` / `'replacewithspace'`). Stored live in `MudSession.blankLinesBehaviour` and read per-line by `ScriptingEngine.processFlushBatch`: `show` (default) renders the blank line as-is, `hide` suppresses it entirely, `replacewithspace` renders it as a single space (Mudlet's screen-reader workaround for QTBUG-105035 — see `TBuffer.cpp`). Scoped to `mud`-typed output, so echoes/errors are unaffected (matching Mudlet's TBuffer-only handling). An unknown mode string is rejected (`setConfig`→`false`). Persisted to the `config` bag and re-applied on profile load (`ScriptingAPI` constructor). **Mudlet Web note:** `show` already pads an empty line to `&nbsp;` so it keeps its height, so `show` and `replacewithspace` look near-identical in Mudlet Web; `hide` is the visibly distinct mode. |
| `mapperPanelVisible` | Shows (`true`) or hides (`false`) the map widget's **control bar** — area picker, z-level buttons, options menu — leaving the map itself alone. Mudlet's `Host::mShowPanel` / `dlgMapper::slot_setMapperPanelVisible`, which hides `dlgMapper`'s `widget_panel`; the map *window* is `openMapWidget`/`closeMapWidget`, a separate thing. Backed by `ProfileSettings.mapperPanelVisible` (default `true`), so it persists per profile like Mudlet's profile-XML `mShowPanel` and applies to every map panel of that profile. Also toggled by the collapse arrow `MapPanel` draws over the map — which stays visible when the bar is hidden, so a script can't lock the controls away. |
| `muteMediaAPI` | Mutes media triggered by the scripting API (`playSoundFile` / `playMusicFile` / `playVideoFile`). Forwarded to `SoundManager.setOriginMuted('api', …)` **and** `VideoManager.setOriginMuted('api', …)`: currently-playing API sources are silenced in place (gain → 0 / `<video>.muted`, position keeps advancing) and new API sources start silent; unmuting restores audibility mid-track — mirroring Mudlet toggling `QAudioOutput::setMuted` on the live `MediaProtocolAPI` players. Persisted to the `config` bag, re-applied on profile load, and re-synced whenever the bag changes (`ScriptingAPI.syncMediaMuteFromConfig`, subscribed in the constructor) so the Settings-modal toggle takes effect live. `getConfig` reports the live `SoundManager.isOriginMuted('api')`. |
| `showMapInfo` / `hideMapInfo` | Switch a `registerMapInfo` map-info overlay on/off **by label** (`setConfig("showMapInfo", "Short")`). **Set-only** — Mudlet has no `getConfig` counterpart, so `getConfig("showMapInfo")` reports an invalid option, and neither key appears in the no-arg dump. Routed to `MapStore.showMapInfo`/`.hideMapInfo`. Unlike `enableMapInfo(label)`, an unregistered label is **not** an error: Mudlet inserts the name straight into the `Host::mMapInfoContributors` set without consulting the contributor registry, so `setConfig` always returns `true` and the overlay lights up if and when something registers under that label. `MapStore` keeps that half of Mudlet's model in a `pendingMapInfoEnabled` set (it hangs `enabled` off the contributor itself). The set also outlives Lua teardown — an enabled script contributor parks its label there in `clearMapInfoContributors` so a reloaded script's re-registration comes back on, matching the host-level lifetime of Mudlet's set — while `killMapInfo` drops it, matching `removeContributor`. **Deviation:** Mudlet guards the whole branch on a live mapper widget and treats the key as unknown when there is none; Mudlet Web's `MapStore` always exists on the `WindowManager`, so the write lands whether or not a map panel is open. |
| `muteMediaGame` | Same as `muteMediaAPI` but for server-driven media — MSP `!!SOUND`/`!!MUSIC`, the MXP `<SOUND>`/`<MUSIC>` tags (which route through the same `handleMspCommand`), and MCMP, i.e. GMCP `Client.Media` (Mudlet's `MediaProtocolMSP`/`MediaProtocolGMCP`). Forwarded to `SoundManager.setOriginMuted('game', …)` and `VideoManager.setOriginMuted('game', …)`; the MSP and `Client.Media` dispatches in `ScriptingEngine` tag their plays with `origin: 'game'`. |

The Settings modal's **Media** tab exposes both, plus a derived **Mute all
media** row that writes the pair together (Mudlet's third toolbar action — it is
on only while both are, matching `mudlet::mediaMuted()`). The UI writes the
`config` bag directly rather than calling `setConfig`, which is why the
constructor's store subscription exists.

The same tab carries **Allow server to download and play media** — a typed
`ProfileSettings.allowServerMedia` field (not a config-bag key, and not
reachable from `setConfig`, matching Mudlet, which exposes `mAcceptServerMedia`
only through preferences and the profile XML). Undefined means allowed. It is a
*hard* block, not a mute: `ScriptingEngine.handleClientMedia` returns before any
filename is resolved or downloaded, so nothing reaches the profile's `media/`
folder. It gates GMCP `Client.Media` only — MSP has its own switch
(`protocols.msp`), exactly as Mudlet splits `mAcceptServerMedia` from
`mEnableMSP` in `TMedia::isMediaProtocolAllowed`. `Client.Media 1` stays in the
`Core.Supports.Set` handshake either way, again matching Mudlet.

### 2a. Config-bag keys consumed by the UI

Stored in the `ProfileSettings.config` bag (so `get`/`set` round-trip and the
Settings UI writes the same slot), but read back out by the React layer to drive
real behaviour:

| Config key | Effect | Read by |
|---|---|---|
| `commandLineHistorySaveSize` | Caps how many sent commands are persisted to `localStorage` for recall/Tab-completion. Default 500 (= in-memory `MAX_HISTORY`); history is shared across profiles. | `CommandBar` → `useCommandHistory` |
| `showTabConnectionIndicators` | When `true` (default), prefixes the window/tab title with a connection-status dot (🟢/🟡/🔴). The profile name is always shown. Mudlet Web has no tab strip, so this lives in the title. | `ProfileSession` |
| `fixUnnecessaryLinebreaks` | When `true` (default `false`) and the session is GA-driven, strips a single spurious leading newline from the start of each GA-terminated data block — Mudlet's "Fix unnecessary linebreaks on GA servers" (`mUSE_IRE_DRIVER_BUGFIX`, `cTelnet::gotPrompt`), for IRE-style servers that prepend a stray `<LF>` to every transmission. ANSI SGR escapes at the block start are skipped before the newline check. Forwarded to `MudClient.setFixUnnecessaryLinebreaks` via `MudSession`. **Deviation:** the very first transmission (before the first GA latches GA-driver mode) keeps its leading newline, since Mudlet Web emits whole lines eagerly and can't tell the session is GA-driven until that GA arrives. | `ProfileSession` → `MudSession` → `MudClient` |
| `enableBlinkText` | When `true`, ANSI blink (SGR 5/6) renders as a smooth opacity pulse; when `false` (default — matching Mudlet) blinking text is shown in italics instead. `FormatState.toHtml` always emits the `ansi-slow-blink`/`ansi-rapid-blink` classes; the effect toggles a `blink-text-enabled` class on the document root, and `App.css` picks the pulse-vs-italic presentation from it (so it covers the main output, user windows, and mini-consoles alike). | `ProfileSession` → `<html>` class → `App.css` |
| `announceIncomingText` | When `true` (default), mirrors MUD output to an off-screen `role="log" aria-live="polite"` region so a screen reader (NVDA, JAWS, VoiceOver, Orca) narrates each new line. | `ScreenReaderLog` |
| `f3SearchEnabled` | When `true` (default `false` — matching Mudlet), turns buffer search into a screen-reader flow: `F3`/`Shift+F3` reach it **with the find bar closed** (opening it), only the current hit stays tinted, focus parks on that hit, and the **whole matched line** is announced through a polite live region owned by the bar. Ported from `TConsole::setF3SearchEnabled` + `focusOnSearchResultAndAnnounce`, which creates the two `QShortcut`s, calls `clearSearchHighlights()` per search, moves its caret onto the hit, and `mudlet::announce()`s the buffer line. **Mudlet Web notes:** (1) Mudlet's search box lives permanently in the console toolbar, so its `F3` always has a target; ours is a transient overlay, which is why the key summons it. (2) Consequently the key is gated **only** at that bar-closed entry point — `F3` still steps an already-open bar with the setting off, so enabling a default-false key adds reach instead of taking a working shortcut away. (3) Announcing deliberately does **not** go through `ScreenReaderLog`: that region mirrors game output and is silenced by `announceIncomingText`, but a search result has to be spoken either way. (4) Focus lands on the current `<mark>` (`tabIndex = -1`, so it never joins the tab order) rather than opening `CaretReviewPanel` — a background rescan unwraps that very mark, so `paint` notices it held focus and hands it to the replacement. Announcing fires on an explicit step only, never on the query-change scan, which would otherwise rip focus out of the box after the first character typed. | `OutputArea` → `OutputSearchBar` / `outputSearch.ts` |
| `caretShortcut` | `'none'` (default) / `'tab'` / `'ctrltab'` / `'f6'`. The key that opens a keyboard-navigable, `role="document"` mirror of the scrollback (Mudlet's caret mode) for character/word/line screen-reader review; the same key (or `Esc`) returns to the command line. | `CaretReviewPanel` / `caretMode.ts` |
| `enableClosedCaption` | When `true` (default `false`), prints a short text line in the output whenever a sound, music track, or video starts or stops (Mudlet's `TMedia::printClosedCaption` format), for users who can't hear game audio. | `ScriptingEngine` (fed by `SoundManager`/`VideoManager` lifecycle hooks) |
| `advertiseScreenReader` | When `true` (default `false`), reports screen-reader use to the server via the MTTS SCREEN READER bit (TTYPE cycle) and the NEW-ENVIRON `SCREEN_READER` capability variable — some MUDs adjust output (e.g. trim ASCII art, add extra room-description detail) when this is set. Negotiation only runs at connect time, so a change takes effect on the **next connect** (like the protocol toggles in group 1). | `ProfileSession` → `MudSession` → `MudClient` → `TelnetNegotiator` → `computeMtts`/`buildNewEnvironVars` |
| `inputLineStrictUnixEndings` | When `true` (default `false`), a submitted command is terminated with a bare `\n` instead of the telnet-standard `\r\n` — Mudlet's `mUSE_UNIX_EOL`, which `cTelnet::sendData` reads per send to decide whether to append the CR. Some Unix-y servers treat the stray CR as part of the command. Live: the next command uses the new terminator. | `ProfileSession` → `MudSession` → `MudClient.send` |
| `specialForceGAOff` | When `true` (default `false`), an inbound `IAC GA` / `IAC EOR` stops meaning "prompt": the session never latches into GA-driven mode, no `prompt` event fires, and the marker becomes a plain newline in the data stream — matching the `else` branch of Mudlet's `mFORCE_GA_OFF` handling in `cTelnet::processSocketData`. For servers whose GA placement is wrong often enough that prompt detection does more harm than good. The newline substitution happens **inside the telnet sequence parser** (`createTelnetOptionParser`), so it lands exactly where the marker was and a `\xFF\xF9` byte pair inside a subnegotiation payload is never mistaken for one. Read once per connect (Mudlet snapshots the flag in `connectIt`; here a fresh `MudClient` is built per dial), so a change applies on the **next connect**. | `ProfileSession` → `MudSession` → `MudClient` |
| `versionInTTYPE` | When `true` (default `false`), the first TTYPE cycle value carries our version after the client name (`MUDLET-WEB 1.2.3`); the terminal-type and MTTS steps are untouched (`ctelnet.cpp` case 0). Off by default because the period is not a legal TTYPE character per RFC 1091 — Mudlet stopped sending it in 2024 — but servers running KaVir's protocol snippet parse a decimal version out of it and cap colour support at 16 without one. Negotiation runs at connect, so a change applies on the **next connect**. | `ProfileSession` → `MudSession` → `TelnetNegotiator.handleTtypeSubneg` |
| `promptForVersionInTTYPE` | Latch (default `false`) recording that the **KaVir auto-detect** has already had its say for this profile. `TelnetNegotiator` keeps a rolling window of the last 8 options the server sent a WILL/DO for (Mudlet's `mNegotiationOrder`); when it equals `[24, 31, 42, 69, 70, 200, 90, 91]` — the `expectedOrderForKaVirHandler` fingerprint — it raises `kavir.detected` once per connection. `ProfileSession` then sets this latch **and** `versionInTTYPE`, prints Mudlet's info message, and redials (TTYPE is only negotiated at connect, so using the setting means reconnecting — Mudlet's `autoEnableTTYPEVersion` does the same). Once latched the detector is disabled, so a user who turns `versionInTTYPE` back off is not overridden every connect. | `TelnetNegotiator` → `kavir.detected` → `ProfileSession` |
| `promptForMXPProcessorOn` | Latch (default `false`) recording that the **in-band MXP auto-detect** has fired for this profile. mudix already started MXP on an `ESC[<n>z` from a server that skipped the option-91 handshake; what this adds is the rest of Mudlet's `autoEnableMXPProcessor` — it now also forces the MXP processor on, which **locks the parser into secure mode**. That matters: such servers are IRE-style and never send mode switches, so in open mode every `<SEND>`/`<A>`/definition tag was being discarded as unsafe. Sets this latch and `specialForceMXPProcessorOn`, and prints Mudlet's info message. A later detection while already forced on is a silent re-initialisation (re-apply the lock, no message), matching `trackMXPElementDetection`. The gate on whether an in-band sequence may still auto-start MXP is Mudlet's `mForceMXPProcessorOn \|\| !mPromptedForMXPProcessorOn`, evaluated at connect — so turning `specialForceMXPProcessorOn` off after the fact sticks. | `TelnetNegotiator` → `mxp.negotiated(false)` → `ScriptingEngine.autoEnableMxpProcessor` |
| `controlCharacterHandling` | `'asis'` (default) / `'oem'` / `'picture'` — ported from Mudlet's `TTextEdit::replaceControlCharacterWith_Picture`/`_OEMFont`. `asis` renders control bytes invisibly (unchanged from before); `picture` maps codes 0-31/127 onto the Unicode Control Pictures block (e.g. ESC→␛); `oem` maps them onto CP437-style decorative glyphs (♥♦♣♠…). Tabs expand to the next 8-column tab stop in `asis`/`picture` (this also **fixes** a pre-existing bug where a raw tab rendered as an invisible zero-width box); `oem` mode does not tab-stop-expand, matching Mudlet. Applied on every render via a module-level mode (`src/mud/text/controlCharacterMode.ts`) kept in sync by `MudSession.setControlCharacterMode` — so it covers the main console, script/mini-console windows, and session logging alike. **Known gap:** a mode change repaints new output immediately but does not retroactively re-render already-displayed scrollback (Mudlet forces a full `refreshView()`; Mudlet Web has no equivalent bulk-repaint hook yet). | `ProfileSession` → `MudSession` → `FormatState`/`cellRender` |

### 3. Persist-only — round-trips but **not yet enforced**

Stored in the `ProfileSettings.config` bag (`CONFIG_PERSIST_ONLY` in
`ScriptingAPI.ts`) with type + enum validation, so `get`/`set` round-trip
faithfully and first reads return a Mudlet-ish default — but Mudlet Web does **not
act on them yet**. Each needs a real feature behind it (see "Not implemented"
below). String keys with an `enum` reject out-of-range writes (`setConfig`
returns `false`).

`ambiguousEAsianWidthCharacters` (`auto`/`wide`/`narrow`), `compactInputLine`,
`editorAutoComplete`, `logInHTML`, `show3dMapView`, `showRoomIdsOnMap`,
`showUpperLowerLevels`.

(`commandLineHistorySaveSize`, `showTabConnectionIndicators`,
`fixUnnecessaryLinebreaks`, `enableBlinkText`, `announceIncomingText`,
`f3SearchEnabled`, `caretShortcut`, `enableClosedCaption`,
`advertiseScreenReader`, `controlCharacterHandling`,
`inputLineStrictUnixEndings`, `specialForceGAOff`, `versionInTTYPE`,
`promptForVersionInTTYPE`, and `promptForMXPProcessorOn` also live in the
`config` bag but are now consumed by the UI / telnet layer — see group 2a.
`askTlsAvailable` moved out of the bag entirely — see group 1.)

### 4. Read-only

`setConfig` returns `false`; `getConfig` returns a synthetic value.

| Config key | `getConfig` returns |
|---|---|
| `logDirectory` | `/profiles/<connectionId>/log` (Mudlet Web logs to IndexedDB, not a real folder) |

`logDirectory` is the only read-only key. (`specialForceMXPProcessorOn` used to
be listed here, but it has always been writable in `setConfig` — Mudlet drives it
from both `dlgProfilePreferences` and `setConfig` — so it belongs in group 2.)

> **`specialForceMXPProcessorOn` is applied at connect**, in `ScriptingEngine`'s
> `client.connect` handler — deliberately, and in that order: `mxp.reset()` runs
> first and clears the secure-mode lock the flag implies, so re-applying it has
> to come after. Reading it at connect rather than on write matches Mudlet, whose
> preferences row carries *"Please reconnect to your game for the change to take
> effect"*, and it is also what restores the value across a profile load — nothing
> else pushes it onto the parser. `setConfig` additionally applies it immediately,
> so a script sees its own write take effect without reconnecting; the Settings
> checkbox writes the bag directly and therefore needs the reconnect, exactly as
> Mudlet's does.

## Map size units

`mapRoomSize` / `mapExitSize` are the one place where a config value does **not**
mean the same thing to Mudlet and to the map renderer, so `ScriptingAPI`
translates between the two spaces.

**Mudlet side** (`T2DMap.cpp`, `dlgMapper.cpp`, `Host.h`):

- `host.mRoomSize` (default `0.5`) is a *fraction of a grid cell*; a room is
  drawn `mRoomWidth * rSize` pixels wide.
- `host.mLineSize` (default `10.0`) is an *inverse* divisor: the exit pen is
  `exitWidth = 1 / eSize * mRoomWidth * rSize`. Bigger `mLineSize` → **thinner**
  exits, and exits scale with the room size. (That inversion is also why the
  preferences dialog shows `50 / mLineSize` in its 1–11 spinner.)
- `setConfig` writes through the preferences slots, so it takes the **spin-box
  scale**, while `getConfig` returns the **internal double**:

  | key | `setConfig(k, n)` does | `getConfig(k)` returns |
  |---|---|---|
  | `mapRoomSize` | `slot_roomSize(n)` → `setRoomSize(n / 10)` | `host.mRoomSize` |
  | `mapExitSize` | `slot_exitSize(n)` → `setExitSize(n)` | `host.mLineSize` |

  So `setConfig("mapRoomSize", 5); getConfig("mapRoomSize")` yields `0.5` in real
  Mudlet. That asymmetry is reproduced here deliberately — packages are written
  against observed Mudlet behaviour. Mudlet's defaults are `mapRoomSize = 5`
  and `mapExitSize = 10`.

**Renderer side** (`mudlet-map-renderer` `Settings`): `roomSize` (default `0.6`)
and `lineWidth` (default `0.025`) are both plain map-unit lengths, and
`lineWidth` is *independent* of `roomSize`.

**The translation**, with `R` = `mapper.roomSize` and `L` = `mapper.lineWidth`:

| direction | formula |
|---|---|
| `setConfig("mapRoomSize", n)` | `R = n / 10` (and `L` is rescaled by the same factor — see below) |
| `getConfig("mapRoomSize")` | `R` |
| `setConfig("mapExitSize", n)` | `L = R / n` |
| `getConfig("mapExitSize")` | `R / L` |

Because Mudlet's exit width is proportional to its room size and the renderer's
is not, `setConfig("mapRoomSize", …)` also scales `lineWidth` by the same ratio
(`setMudletRoomSize`). That keeps the effective `mapExitSize` constant across a
room-size change, and makes the combined table form order-independent —
`Other.lua` iterates `setConfig{...}` with `pairs()`, so `mapExitSize` may be
applied before or after `mapRoomSize`.

The Settings modal edits `roomSize` / `lineWidth` in **renderer** units
directly, as do the Mudlet Web-only `setMapRoomSize()` / `getMapRoomSize()`
globals (they have no Mudlet counterpart). Only the two `*Config` keys go
through the translation.

## Value coercion

`ScriptingAPI.configKeyKind(key)` reports which value type an option takes —
`'bool'`, `'num'`, `'str'`, `'any'`, `'readonly'`, or `null` for an unknown key.
The `Bridge.lua` wrapper needs it to tell Mudlet's **raise-on-wrong-type** apart
from its **`(nil, errMsg)` refuse-on-bad-value**: Mudlet reads each option with a
`getVerified*` helper, so a value of the wrong type raises while a value that is
merely out of range returns. `'any'` is for keys that legitimately take more than
one type and vet the value themselves — `showSentText` (its legacy boolean
alongside the three-mode enum) and `mapInfoColor` (an `{r,g,b[,a]}` table).

- **Booleans** (`configBool`): real booleans pass through; the strings
  `false`/`0`/`no`/`off` (any case) read as `false`; any other non-nil value is
  truthy. Matches how Lua scripts pass flags.
- **Strings**: a non-string raises, mirroring `getVerifiedString`. That covers
  the enum keys (`blankLinesBehaviour`, `caretShortcut`,
  `controlCharacterHandling`, `ambiguousEAsianWidthCharacters`) and the two
  map-info labels — an out-of-range *string* is still the refusal case below.
- **Numbers**: `Number(value)`; mapper sizes additionally require finite `> 0`
  (an out-of-range mapper size is ignored, but `setConfig` still returns `true`
  — Mudlet accepts any positive int there without clamping).
- **Enums**: `String(value)` validated against the allowed set; an invalid value
  is rejected (`setConfig` → `false`, no write).

## Not implemented (persist-only keys that need a real feature)

These round-trip through `get`/`set` but have no behavior yet. Promote them from
group 3 to group 1/2 as the underlying feature lands:

- **Rendering:** `ambiguousEAsianWidthCharacters`.
- **Input line / editor:** `compactInputLine`, `editorAutoComplete`.
- **Map:** `show3dMapView` (no 3D renderer), `showRoomIdsOnMap`,
  `showUpperLowerLevels` — the first has no 3D renderer at all; the other two
  need renderer support that `mudlet-map-renderer` 2.6.1 does not expose
  (no room-id labels, no dimmed z±1 planes), so they are blocked upstream
  rather than merely unwired.
- **Misc UI / logging:** `logInHTML`.

## Keys Mudlet has that Mudlet Web does not

Mudlet's own list is 60 `setConfig` keys plus `logDirectory` (get-only). These
are the ones with no key at all here — `getConfig` reports them as invalid and
`setConfig` refuses, rather than round-tripping like group 3:

- `ircHostName`, `ircHostPort`, `ircHostSecure`, `ircNickName`, `ircPassword`,
  `ircChannels` — **not applicable.** They configure Mudlet's built-in Qt IRC
  client (`dlgIRC`); Mudlet Web has no IRC client, so there is nothing to
  configure. Not planned. They are also absent from the `Other.lua` dump list,
  so they cost nothing there.
- `undoServerWrap`, `undoServerWrapWidth` — **wanted, not started.** Mudlet's
  re-joining of lines the *game* wrapped, so triggers see whole lines and
  wrapping follows the window instead (`TBuffer.cpp`: `endsAtServerWrapColumn`,
  `looksLikeWrappedProse`, a flush timer for the trailing segment, and the
  `recordLineLengthForWrapDetection` auto-detect that offers a clickable
  `echoLink` once a stable wrap column shows up). Width clamps to 20–500. Would
  belong in `LineAssembler` / `ScriptingEngine.processFlushBatch`. These two
  *are* in the `Other.lua` dump list, so until they land the no-arg
  `getConfig()` returns 49 keys where Mudlet returns 51 (a `nil` result simply
  doesn't get stored in the table).

## Tests

`tests/scripting/config-api.test.ts` drives the Lua globals end-to-end:
structured routing into `protocols`/`mapper`/`autoClearInput`/`askTlsAvailable`,
inverse `specialForce*Off` flags, live `showSentText` echo suppression, enum
rejection, read-only keys, unknown-key handling, `showMapInfo`/`hideMapInfo`
(including the pending-label and teardown-survival paths), and the `Other.lua`
table / no-arg-dump forms. The `askTlsAvailable` cases also assert the *negative*
— that the value does **not** land in the `config` bag — since writing the wrong
slot is exactly how that key was inert before.

`tests/mud/connection/specialOptionsConfig.test.ts` covers what the five
telnet-layer keys actually do on the wire, driving `MudClient` directly (through
a mock WebSocket, since option negotiation only runs on real socket frames —
`feedTelnet` goes straight to the text pipeline): CRLF vs bare-LF command
terminators and the live setter, `IAC GA`/`IAC EOR` becoming an in-place newline
with no `prompt` event (including that a `\xFF\xF9` pair inside a subnegotiation
payload is left alone), the TTYPE cycle carrying the version at step 0 only, the
KaVir fingerprint matching on the trailing window and firing once per connection
— and not at all when reordered, interrupted, or already latched — and the
in-band MXP gate under each combination of `promptForMXPProcessorOn` /
`specialForceMXPProcessorOn`.

`tests/scripting/force-mxp-processor.test.ts` pins the connect-time application
of `specialForceMXPProcessorOn`: unset stays off, a persisted `true` turns the
processor on, a bag write made after construction is picked up on the *next*
connect (not live — Mudlet requires the reconnect too), clearing the key turns it
back off, and the secure-mode lock survives the per-connect `mxp.reset()`.

The two auto-detects' *reactions* (the store writes, the console message, the
redial) live in `ProfileSession` and `ScriptingEngine.autoEnableMxpProcessor`;
the React half has no unit coverage (this repo has no component-test harness).

## Settings UI coverage

Which keys get a row is decided by **Mudlet's** `profile_preferences.ui`, not by
what happens to be implementable — a key Mudlet exposes gets a row, one it
doesn't (`promptForVersionInTTYPE`, `promptForMXPProcessorOn` — both
profile-XML-only latches there) does not.

mudix has no *Special Options* tab and doesn't need one. That Mudlet tab holds
five controls; the first, "Force compression off", is already mudix's positive
`MCCP` protocol toggle on **General**, and the other three interact with the
protocol switches beside it — Mudlet's own `mForceMXPProcessorOn` tooltip even
sends the user to "Choose protocols section of the General tab". So they live
there, above the existing "Protocol changes take effect the next time you
connect" hint (mudix's equivalent of `need_reconnect_for_specialoption`).

| Key | mudix tab | Mudlet home |
|---|---|---|
| `specialForceGAOff` | General | Special Options |
| `versionInTTYPE` | General | Special Options |
| `specialForceMXPProcessorOn` | General | Special Options |
| `inputLineStrictUnixEndings` | Input | `groupBox_input` (`USE_UNIX_EOL`) |
| `blankLinesBehaviour` | Accessibility | `tab_accessibility` |

The remaining group-3 keys have no row on purpose: a toggle that round-trips but
changes nothing is worse than no toggle. Add the row when the behaviour lands.

`tests/ui/outputSearch.test.ts` covers the DOM-level halves of
`f3SearchEnabled` — `searchStepDirection` (the shared F3 predicate),
`matchLineText` (announce the whole line, minus the timestamp column),
`focusCurrentHit`, and `shouldCloseSearchOnEscape` (see below). The React wiring
has no unit coverage (this repo has no component-test harness) and was verified
in the running app instead.

> **Not a config key, fixed alongside:** Escape used to close the find bar only
> while focus was in the find box itself, so the common case — reading results
> with focus back in the command line — left the bar stuck open. The bar now
> also listens on the document in the **bubble** phase, gated by
> `shouldCloseSearchOnEscape`: it skips an already-`defaultPrevented` event
> (which is how it layers under `CommandBar`, which preventDefaults Escape only
> while an autocomplete ghost shows — first press dismisses the ghost, second
> closes the bar) and requires the origin to be inside `.app`, the
> profile-session shell. Modals stop propagation on their own node and
> `CaretReviewPanel` uses capture + `stopImmediatePropagation`, so neither ever
> reaches the listener; floating script windows portal to `<body>` as
> `.floating-window-root`, outside `.app`, so they keep their own Escape.

## Adding a new config key

1. **Has a real backing field?** Add a `case` to both `getConfig` and
   `setConfig` in `ScriptingAPI.ts` routing to it (use the `getProtocol` /
   `getMapperField` helpers or `patchConnectionProfile`).
2. **No backing yet?** Add it to `CONFIG_PERSIST_ONLY` with its `type`
   (+ `enum` if applicable) and a sensible default, and list it under
   "Not implemented" here.
3. Add it to `configKeyKind` unless `CONFIG_PERSIST_ONLY` already covers it —
   check which `getVerified*` helper Mudlet reads the value with, and match it.
   If Mudlet treats the key as read-only, use the read-only `case` arm instead.
4. Extend `tests/scripting/config-api.test.ts`.

> **Check the default against Mudlet's header, not against what feels right.**
> A persist-only key's default is invisible until something reads it, so a wrong
> one sits there harmlessly and then changes behaviour the day the key is wired
> up. `versionInTTYPE` defaulted to `true` here while Mudlet's `mVersionInTTYPE`
> is `false` (Host.h) — inert for as long as nothing acted on it, and a
> version string sent to every server the moment something did.
>
> **A key with a real backing field must route to that field.** If the setting
> already exists as a typed `ProfileSettings` member — because the Settings UI or
> some subsystem reads it — then adding it to `CONFIG_PERSIST_ONLY` gives it a
> *second, unread* home in the `config` bag, and `get`/`set` will round-trip
> perfectly while doing nothing. That is what happened to `askTlsAvailable`.
> Before adding a bag entry, grep `storage/schema.ts` for the name.

> The completion catalogue already lists `getConfig` / `setConfig` generically
> (`luaCompletions.ts`); individual keys are not separate completions.
