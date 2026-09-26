# Future work: full TBuffer-style line assembly (live partial lines)

## Status

**Shipped (done):** partial-line buffering in `MudClient` (a.k.a. "Approach A").
`processIncomingData` holds the trailing text after the last `\n` in
`pendingLineTail` and only emits whole lines downstream; the tail is flushed on
an `IAC GA`/`EOR` prompt marker or the idle timer. This runs even in GA-driver
mode, except that once GA-driven the idle timer no longer flushes the tail: only
a `\n` or the next prompt marker ends a line, as in Mudlet. Each GA/EOR ends the
line at the exact byte it arrives, even mid-frame (`MudClient.processIncomingData`
cuts the frame at every marker), and a telnet sequence split across frames is
held until the next frame completes it. It fixes the reported Discworld bug where a room line split across two
WebSocket frames rendered as two lines (the split fell mid-word: `Str` + `en`).
Tests: `tests/mud/connection/lineAssembly.test.ts`.

**Not done (this note):** the full Mudlet `TBuffer` port — carrying an *open*
partial line live through the render + trigger pipeline so a line that is still
streaming in is displayed and grows in place, finalizing (and firing triggers)
only when its terminator arrives.

## Why bother (and why it was deferred)

The shipped fix already makes every normal MUD line correct, because a line
split across frames is reassembled before it is emitted. The **only** behaviour
the TBuffer port adds on top is the rare case of a single line streamed in
chunks over more than `promptTimeoutMs` (300 ms) with no `\n` and no GA in
between: Mudlet shows that line growing live; Approach A delays it until the
terminator (GA-driven mode) or, before GA has latched, splits it when the idle
timer fires mid-line. This is
uncommon, so the work was deferred. Do it if we want pixel-exact Mudlet parity
for live-streamed output.

## How Mudlet actually does it (verified against `src/ctelnet.cpp`, `development`)

- `cTelnet::processSocketData` walks the socket read byte-by-byte, accumulating
  text into `cleandata`. On `IAC GA`/`IAC EOR` it appends a `\n` to `cleandata`
  and calls `gotPrompt`; any leftover after the last GA in the read goes to
  `gotRest`.
- `gotRest` in **GA-driver** mode (`mGA_Driver == true`) does
  `mMudData += mud_data; postData(); mMudData = "";` — it posts the fragment
  **verbatim, immediately, with no newline buffering**. (Our old GA fast-path
  was a faithful port of this — *not* a bug.) In non-GA mode it buffers up to
  the last `\n` and uses a posting timer for the tail (our non-GA branch).
- The single-line *rendering* correctness comes entirely from **`TBuffer`**
  (`postData` → `TConsole::printOnDisplay`): it keeps an **open current line**
  and finalizes/wraps a line only at `\n`. Two verbatim posts of `...Str` then
  `en Withel...` append into the **same** open TBuffer line. The GA path's
  appended `\n` (in `processSocketData`) is what finalizes a prompt line.

Our pipeline has no equivalent open-line carry for network output:
`ScriptingEngine.processFlushBatch` splits each emitted chunk on `\n` and emits
the trailing partial as a finished `message`, and `OutputRenderer.handleMessage`
always creates a *new* line element for `type === 'mud'`. (Our own
`Console.write()` does carry a partial — but the network path doesn't use it.)

## Implementation sketch

Goal: emit an incomplete MUD line as a live "preview" that updates in place, and
finalize it (run triggers, log, render as a final line) only when a `\n` or a
prompt marker completes it.

Files and the role each plays:

1. **`MudClient`** — decide the source of the live partial. Cleanest is to let
   the pipeline own assembly: emit raw chunks and signal prompt boundaries
   (`prompt` event on GA/EOR; an idle-timer `prompt` for GA-less MUDs). The
   reattachment point is `processIncomingData`. If we keep Approach A's
   buffering, instead emit a *preview* of `pendingLineTail` each time it grows.
2. **`ScriptingEngine.processFlushBatch`** — maintain `mudOpenText` (raw incl.
   ANSI) for the open line. Prepend it to each `mud` group, split on `\n`,
   finalize complete lines as today (triggers + `message` + advance
   `mudCarryState` + MXP per-line parse). For the trailing un-terminated
   segment: if `promptPending`, finalize it as a prompt line; otherwise store it
   in `mudOpenText` and emit it as a **preview** (no triggers, no carry advance).
3. **`OutputRenderer`** — add a MUD preview path mirroring the existing
   `script-partial`/`script` `partialLineEl` machinery: a `mud-partial` message
   creates/updates the open line element; the next final `mud` message finalizes
   that element in place instead of creating a new node.
4. **`SessionLogger`** — add `mud-partial` to `SKIP_TYPES` so previews aren't
   logged; only the finalized `mud` line is persisted.
5. **`events.ts`** — type the preview (either a new `mud-partial` `message` type
   or a dedicated event).

### Gotchas (these are where the time goes)

- **Trigger timing:** triggers must fire exactly once, on the *complete* line —
  never on a preview. The `output` event and `processLineTriggers` must be gated
  to finalized lines.
- **Prompt in a separate frame:** the prompt text and its `IAC GA` can arrive in
  different WebSocket frames. If the pipeline owns assembly, a GA-only frame sets
  `promptPending` but produces no `flushLines` batch, so a held line can get
  stuck or glued to the next room's first line. Keeping Approach A's
  MudClient-side tail buffering avoids this edge (the tail is flushed precisely
  on the GA), which is why a hybrid — A for assembly/prompts + a live preview of
  the held tail — may be lower-risk than a pure pipeline rewrite.
- **MXP:** `this.mxp.parseLine` is stateful per line. Parse only *complete*
  lines once; if previews are parsed for display, they must not advance parser
  state (re-parse on finalize).
- **SGR carry:** `mudCarryState` must advance only when a line is finalized, not
  on previews.
- **`message` already carries `isPrompt`** as a 5th arg — reuse it.

### Test coverage to add

Extend `tests/mud/connection/lineAssembly.test.ts` (or a new
`tests/scripting/` test that drives `processFlushBatch`/`feedTriggers`):
- a line streamed in 3 chunks with no `\n` renders/grows as one line and fires
  its trigger once, on completion;
- a prompt whose text and GA arrive in separate frames renders as one prompt
  line and isn't glued to the next line;
- previews are not logged (SessionLogger), only the finalized line is.
