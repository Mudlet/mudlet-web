# Mudlet design language in Mudlet Web

Mudlet's desktop UI is being redesigned on the `ui/design-language` branch of
[MorquinDevlar/Mudlet](https://github.com/MorquinDevlar/Mudlet/tree/ui/design-language)
(the reasoning is `docs/design-language.md` there, the working reference
`.agents/skills/design-language/SKILL.md`, the code `src/uiDesign.{h,cpp}`).
Mudlet Web follows it so the two clients read as one product.

**Followed by hand, not synced.** The branch is not merged into Mudlet yet and
is still moving, so nothing here is generated from it and no workflow watches
it. When it changes, read the diff and bring what matters across manually.

| | |
| --- | --- |
| Last brought across from | `MorquinDevlar/Mudlet@a8a3a3a` (`ui/design-language`, on Mudlet `development` at `4b237a5c`) |

## What was carried over, and where it lives

| Desktop | Mudlet Web |
| --- | --- |
| `uiDesign::themeTokens()` — page/card/pane/field, the softened text, the contrast-walked muted, disabled and accent inks, border, separator, washes, state colours | `src/ui/design/themeTokens.ts`, a line-for-line transcription with the same constants. `applyThemeTokens()` runs on every theme change (`App.tsx`) and writes the tokens inline on `:root` |
| The four palette roles (Window, Base, WindowText, Highlight) | A theme's `--bg`, `--bg-input`, `--text`, `--accent`. Stock and brand themes name only those; everything else is derived. A theme can opt out with `--design-derive: off` |
| The edbee themes desktop pairs with the appearance (Mudlet Dark / Mudlet Light) | `--code-bg`, `--code-text`, `--code-line`, `--code-selection`, used by the CodeMirror chrome (`ui/codemirror/theme.ts`) |
| Desktop's DarkTheme palette and Fusion light | The stock `dark`/`amber`/`sky` themes use DarkTheme's `#353535`/`#191919`/white (keeping their own accents); `light` uses Fusion's `#efefef`/white/black |
| `themedGlyphFile()` — the tick, dash, dot and chevron inked per theme | `--mark-*` / `--chevron-*` data-URI properties written by the same token pass |
| Radius scale (`scmRadiusChip` 4, `scmRadiusInput` 5, `scmRadiusPanel` 8, toolbar button 6) | `--radius-chip`, `--radius-input`, `--radius-panel`, `--radius-bar-button` in `App.css` |
| Type scale (Caption 0.85 / Body 1 / Title 1.15 / Display 1.45) | `--type-caption/body/title/display` — 12/14/16/20px off the launcher's 14px body |
| One stylesheet builder per control | `src/ui/design/design.css` (choice marks, drop-downs, flat bar, split button, card, notice, tabs, chip, rows, sidebar) and `src/ui/components/components.css` (buttons, fields, toggle) |
| Lucide glyphs in `src/icons/*.svg` at stroke 1.5 | `src/ui/design/glyphs.tsx`: desktop's file names mapped to the `lucide-react` icon with the same path data; `<Glyph name="toolbar-connect" />` |

## Surfaces brought in

- **Main toolbar and menu bar** — flat bar on the page with a seam, desktop's toolbar glyphs, split buttons, menus on the card tone.
- **Context menus, menu-bar drop-downs, the compact hamburger menu** — the menu recipe.
- **Settings** — pane-tone sidebar with pill rows and the accent bar, cards, Display-step page title, prominent search field, search spotlight.
- **Script editor** — desktop's window structure: a flat toolbar across the top (Add / Add Group / Save / Activate / Delete named for the kind, undo and redo, import and export), an icon rail with the label toggle on its seam, "Search items…" heading the tree, the kind as the tree's root, state dots in place of check boxes (filled on, ring off, ring-and-dot when a group above is off; click toggles), switched-off rows struck through, the package glyph on a package's top folder, label-column form rows, event handlers as a chip row with a dashed "+ Add event", the code pane under a "Lua script" heading with the caret's line and column running down to a status bar that counts items and active ones; no child-count chips; the run output only appears once there is some. Window title "<profile> - Editor". The per-kind forms below Name (trigger patterns, timers, keys, buttons) keep their own layout for now.
- **Window shells** (`.modal`, `.resizable-modal`, confirm dialog) — the window is the page; the header is a title bar (`--bg-titlebar`, the step under the page the platform draws desktop's in: `#262626` on dark) with no rule, so a toolbar under it reads as desktop's does rather than as a boxed strip.
- **Console foot** — one seam over the command line, no frame.
- **Shared controls** — buttons (face, primary as accent wash), fields, check boxes and radios, selects, the toggle, scrollbars.
- **Launcher** — kept its own geometry (it was redesigned on its own); colours follow the tokens, focus glows removed, its tool buttons on the flat bar recipe. It fills the window the way the console does, so it sits on `--bg-deep` (the palette's Base, `#191919`, on a dark theme; the page on a light one) rather than on a dialog's grey page.

Not yet brought in: the map panel and editor, the log browser, the file
browser and previews, package dialogs beyond what the shared rules reach, and
user windows. They pick up the derived tokens already; a surface-specific pass
is still to do.

## Deliberate differences

- **Primary button on the launcher** stays a solid accent fill — it sits on game
  artwork, where desktop's accent wash would not read.
- **The command line keeps an accent frame while focused**, where desktop draws
  none, so keyboard focus stays visible.
- **Check marks use a heavier stroke** than the 1.5 chrome glyphs: drawn at 9px
  in a 13px box, Lucide's stroke is a hairline.
- **The console keeps its own colours** (`--console-bg`, `--console-text`): it
  is drawn in the profile's colours, not the theme's, as on desktop.

## Bringing a change across

1. Diff the branch since the commit in the table above, starting with
   `src/uiDesign.{h,cpp}` and `docs/design-language.md`.
2. Constants and the token recipe go into `themeTokens.ts`; keep
   `tests/ui/designTokens.test.ts` passing — it pins the port to desktop's
   documented tables and checks every stock theme against the contrast floors.
3. A changed builder goes into `design.css` or `components.css`; a renamed or
   new icon into `glyphs.tsx`, matched by path data, not by eye.
4. Update the commit in the table above.
