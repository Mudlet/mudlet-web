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
        → ProfileSettings field  (protocols / mapper / autoClearInput)
        → MudSession.echoSentText (live)
        → ProfileSettings.mapperPanelVisible  (mapperPanelVisible, live)
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
| `caretShortcut` | `'none'` (default) / `'tab'` / `'ctrltab'` / `'f6'`. The key that opens a keyboard-navigable, `role="document"` mirror of the scrollback (Mudlet's caret mode) for character/word/line screen-reader review; the same key (or `Esc`) returns to the command line. | `CaretReviewPanel` / `caretMode.ts` |
| `enableClosedCaption` | When `true` (default `false`), prints a short text line in the output whenever a sound, music track, or video starts or stops (Mudlet's `TMedia::printClosedCaption` format), for users who can't hear game audio. | `ScriptingEngine` (fed by `SoundManager`/`VideoManager` lifecycle hooks) |
| `advertiseScreenReader` | When `true` (default `false`), reports screen-reader use to the server via the MTTS SCREEN READER bit (TTYPE cycle) and the NEW-ENVIRON `SCREEN_READER` capability variable — some MUDs adjust output (e.g. trim ASCII art, add extra room-description detail) when this is set. Negotiation only runs at connect time, so a change takes effect on the **next connect** (like the protocol toggles in group 1). | `ProfileSession` → `MudSession` → `MudClient` → `TelnetNegotiator` → `computeMtts`/`buildNewEnvironVars` |
| `controlCharacterHandling` | `'asis'` (default) / `'oem'` / `'picture'` — ported from Mudlet's `TTextEdit::replaceControlCharacterWith_Picture`/`_OEMFont`. `asis` renders control bytes invisibly (unchanged from before); `picture` maps codes 0-31/127 onto the Unicode Control Pictures block (e.g. ESC→␛); `oem` maps them onto CP437-style decorative glyphs (♥♦♣♠…). Tabs expand to the next 8-column tab stop in `asis`/`picture` (this also **fixes** a pre-existing bug where a raw tab rendered as an invisible zero-width box); `oem` mode does not tab-stop-expand, matching Mudlet. Applied on every render via a module-level mode (`src/mud/text/controlCharacterMode.ts`) kept in sync by `MudSession.setControlCharacterMode` — so it covers the main console, script/mini-console windows, and session logging alike. **Known gap:** a mode change repaints new output immediately but does not retroactively re-render already-displayed scrollback (Mudlet forces a full `refreshView()`; Mudlet Web has no equivalent bulk-repaint hook yet). | `ProfileSession` → `MudSession` → `FormatState`/`cellRender` |

### 3. Persist-only — round-trips but **not yet enforced**

Stored in the `ProfileSettings.config` bag (`CONFIG_PERSIST_ONLY` in
`ScriptingAPI.ts`) with type + enum validation, so `get`/`set` round-trip
faithfully and first reads return a Mudlet-ish default — but Mudlet Web does **not
act on them yet**. Each needs a real feature behind it (see "Not implemented"
below). String keys with an `enum` reject out-of-range writes (`setConfig`
returns `false`).

`ambiguousEAsianWidthCharacters` (`auto`/`wide`/`narrow`), `askTlsAvailable`,
`compactInputLine`,
`editorAutoComplete`, `f3SearchEnabled`,
`inputLineStrictUnixEndings`, `logInHTML`,
`promptForMXPProcessorOn`, `promptForVersionInTTYPE`, `show3dMapView`,
`showRoomIdsOnMap`, `showUpperLowerLevels`,
`specialForceGAOff`, `versionInTTYPE`.

(`commandLineHistorySaveSize`, `showTabConnectionIndicators`,
`fixUnnecessaryLinebreaks`, `enableBlinkText`, `announceIncomingText`,
`caretShortcut`, `enableClosedCaption`, `advertiseScreenReader`, and
`controlCharacterHandling` also live in the `config` bag but are now consumed
by the UI — see group 2a.)

### 4. Read-only

`setConfig` returns `false`; `getConfig` returns a synthetic value.

| Config key | `getConfig` returns |
|---|---|
| `logDirectory` | `/profiles/<connectionId>/log` (Mudlet Web logs to IndexedDB, not a real folder) |
| `specialForceMXPProcessorOn` | stored bool or `false` |

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

- **Booleans** (`configBool`): real booleans pass through; the strings
  `false`/`0`/`no`/`off` (any case) read as `false`; any other non-nil value is
  truthy. Matches how Lua scripts pass flags.
- **Numbers**: `Number(value)`; mapper sizes additionally require finite `> 0`
  (an out-of-range mapper size is ignored, but `setConfig` still returns `true`
  — Mudlet accepts any positive int there without clamping).
- **Enums**: `String(value)` validated against the allowed set; an invalid value
  is rejected (`setConfig` → `false`, no write).

## Not implemented (persist-only keys that need a real feature)

These round-trip through `get`/`set` but have no behavior yet. Promote them from
group 3 to group 1/2 as the underlying feature lands:

- **Rendering:** `ambiguousEAsianWidthCharacters`.
- **Input line / editor:** `compactInputLine`, `inputLineStrictUnixEndings`,
  `editorAutoComplete`, `f3SearchEnabled`.
- **Telnet edge switches:** `askTlsAvailable`, `specialForceGAOff`,
  `versionInTTYPE`, `promptForVersionInTTYPE`, `promptForMXPProcessorOn`.
- **Map:** `show3dMapView` (no 3D renderer), `showRoomIdsOnMap`,
  `showUpperLowerLevels`.
- **Misc UI / logging:** `logInHTML`.

## Tests

`tests/scripting/config-api.test.ts` drives the Lua globals end-to-end:
structured routing into `protocols`/`mapper`/`autoClearInput`, inverse
`specialForce*Off` flags, live `showSentText` echo suppression, enum rejection,
read-only keys, unknown-key handling, and the `Other.lua` table / no-arg-dump
forms.

## Adding a new config key

1. **Has a real backing field?** Add a `case` to both `getConfig` and
   `setConfig` in `ScriptingAPI.ts` routing to it (use the `getProtocol` /
   `getMapperField` helpers or `patchConnectionProfile`).
2. **No backing yet?** Add it to `CONFIG_PERSIST_ONLY` with its `type`
   (+ `enum` if applicable) and a sensible default, and list it under
   "Not implemented" here.
3. If Mudlet treats it as read-only, add it to the read-only `case` arm.
4. Extend `tests/scripting/config-api.test.ts`.

> The completion catalogue already lists `getConfig` / `setConfig` generically
> (`luaCompletions.ts`); individual keys are not separate completions.
