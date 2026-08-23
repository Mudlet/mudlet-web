/**
 * Mudlet's `!osc8-docs` easter egg — the worked OSC 8 examples banner
 * (`TBuffer::injectOSC8DocumentationExamples`).
 *
 * A line printed through the echo family that holds the phrase is swallowed and
 * this banner goes into the MAIN console instead, whichever window the echo was
 * addressed to. It is the one page of OSC 8 documentation that can be read
 * without leaving the client, so every escape in it is load-bearing: the text is
 * a verbatim port of Mudlet's, kept one source line per array entry so the two
 * can be diffed after a re-sync.
 *
 * Not every printing path reaches it — what the game sends and what a trigger
 * echoes onto the matched line print the phrase as ordinary text, exactly as in
 * Mudlet, where those go through `commitLine()` rather than `appendLine()`.
 */

/** The phrase itself, split so that this file does not set off its own check
 *  when something echoes a line of it. */
export const OSC8_DOCS_PHRASE = "!osc8-" + "docs";

/** Once a second at most — an echo and the server response that repeats it must
 *  not print the banner twice. Mudlet's `mLastOSC8DocsInjectionTime` window. */
export const OSC8_DOCS_DEBOUNCE_MS = 1000;

const BANNER: readonly string[] = [
    "\n",
    "╔══════════════════════════════════════════════════════════════════════╗\n",
    "║              OSC 8 Hyperlink Examples - Try them all!                ║\n",
    "╚══════════════════════════════════════════════════════════════════════╝\n",
    "\n",
    "── FUNDAMENTALS ───────────────────────────────────────────────────────\n",
    "Basic: \u001b]8;;send:look\u001b\\\u001b[34mLook\u001b[0m\u001b]8;;\u001b\\ \u001b]8;;prompt:cast%20fireball\u001b\\\u001b[33mCast Spell\u001b[0m\u001b]8;;\u001b\\ \u001b]8;;https://mudlet.org\u001b\\\u001b[36mWebsite\u001b[0m\u001b]8;;\u001b\\\n",
    "       send:CMD  prompt:CMD (editable)  https://URL (browser)\n",
    "URLs:  \u001b]8;;https://mudlet.org/?id=42&lang=en\u001b\\\u001b[36mWith params\u001b[0m\u001b]8;;\u001b\\ \u001b]8;;https://mudlet.org/?%63%6F%6E%66%69%67=value\u001b\\\u001b[36mEncoded config\u001b[0m\u001b]8;;\u001b\\\n",
    "       query params preserved (?id=42&lang=en)  percent-encoded reserved names kept\n",
    "\n",
    "── JSON CONFIG (append ?config={...} to URI) ───────────────────────────\n",
    "Structure: send:cmd?config={\"style\":{...},\"menu\":[...],\"tooltip\":\"...\"}\n",
    "Example:   \u001b]8;;send:attack?config={\"style\":{\"color\":\"red\",\"bold\":true}}\u001b\\Attack\u001b]8;;\u001b\\ ← {\"style\":{\"color\":\"red\",\"bold\":true}}\n",
    "\n",
    "── STYLING ────────────────────────────────────────────────────────────\n",
    "Colors: \u001b]8;;send:c1?config={\"style\":{\"color\":\"red\"}}\u001b\\red\u001b]8;;\u001b\\ \u001b]8;;send:c2?config={\"style\":{\"color\":\"#0066ff\"}}\u001b\\#0066ff\u001b]8;;\u001b\\ \u001b]8;;send:c3?config={\"style\":{\"color\":\"rgb(0,200,100)\"}}\u001b\\rgb()\u001b]8;;\u001b\\ \u001b]8;;send:c4?config={\"style\":{\"bg\":\"yellow\",\"color\":\"black\"}}\u001b\\bg:yellow\u001b]8;;\u001b\\\n",
    "Text:   \u001b]8;;send:t1?config={\"style\":{\"bold\":true}}\u001b\\bold\u001b]8;;\u001b\\ \u001b]8;;send:t2?config={\"style\":{\"italic\":true}}\u001b\\italic\u001b]8;;\u001b\\ \u001b]8;;send:t3?config={\"style\":{\"underline\":true}}\u001b\\underline\u001b]8;;\u001b\\ \u001b]8;;send:t4?config={\"style\":{\"underline\":\"wavy\",\"text-decoration-color\":\"red\"}}\u001b\\wavy-red\u001b]8;;\u001b\\ \u001b]8;;send:t5?config={\"style\":{\"strikethrough\":true}}\u001b\\strike\u001b]8;;\u001b\\\n",
    "States: \u001b]8;;send:s1?config={\"style\":{\"color\":\"blue\",\"hover\":{\"color\":\"red\"}}}\u001b\\hover:red\u001b]8;;\u001b\\ \u001b]8;;send:s2?config={\"style\":{\"bg\":\"green\",\"active\":{\"bg\":\"darkgreen\"}}}\u001b\\active:dark\u001b]8;;\u001b\\ \u001b]8;;send:s3?config={\"style\":{\"link\":{\"color\":\"blue\"},\"visited\":{\"color\":\"purple\"}}}\u001b\\visited:purple\u001b]8;;\u001b\\\n",
    "\n",
    "── MENUS & TOOLTIPS ───────────────────────────────────────────────────\n",
    "Menu: \u001b]8;;send:attack?config={\"menu\":[{\"Strike\":\"send:strike\"},{\"Power\":\"send:power\"},\"-\",{\"Flee\":\"send:flee\"}]}\u001b\\⚔️ Combat\u001b]8;;\u001b\\ ← right-click (left=primary, \"-\"=separator)\n",
    "Tip:  \u001b]8;;send:item?config={\"tooltip\":\"Legendary sword +5 damage\",\"style\":{\"color\":\"orange\"}}\u001b\\🗡️ Flaming Blade\u001b]8;;\u001b\\ ← hover for tooltip\n",
    "Both: \u001b]8;;send:spell?config={\"menu\":[{\"Fire\":\"send:fireball\"},{\"Ice\":\"send:icebolt\"}],\"tooltip\":\"Magic spells\",\"style\":{\"color\":\"#9966ff\"}}\u001b\\✨ Magic\u001b]8;;\u001b\\\n",
    "\n",
    "── VISIBILITY (auto-hide/reveal) ──────────────────────────────────────\n",
    "Click-hide: \u001b]8;;send:h1?config={\"style\":{\"color\":\"yellow\"},\"visibility\":{\"action\":\"conceal\",\"delay\":2000}}\u001b\\I vanish 2s after click\u001b]8;;\u001b\\\n",
    "Expire:     \u001b]8;;send:h2?config={\"style\":{\"color\":\"cyan\"},\"visibility\":{\"action\":\"conceal\",\"expire\":{\"input\":true}}}\u001b\\Send any command to hide\u001b]8;;\u001b\\\n",
    "Reveal:     Wait... \u001b]8;;send:h3?config={\"style\":{\"color\":\"lime\",\"bold\":true},\"visibility\":{\"action\":\"reveal\",\"delay\":5000}}\u001b\\I APPEAR!\u001b]8;;\u001b\\ (5 seconds)\n",
    "Wide chars: \u001b]8;;send:h4?config={\"style\":{\"bg\":\"blue\"},\"visibility\":{\"action\":\"conceal\",\"delay\":2000}}\u001b\\🎉🚀💎\u001b]8;;\u001b\\ ← emojis handled correctly\n",
    "\n",
    "── SPOILERS (click-to-reveal) ─────────────────────────────────────────\n",
    "The answer is: \u001b]8;;send:sp1?config={\"spoiler\":true,\"disabled\":true}\u001b\\42\u001b]8;;\u001b\\  Secret code: \u001b]8;;https://www.mudlet.org?config={\"spoiler\":true,\"style\":{\"color\":\"yellow\"}}\u001b\\XYZZY\u001b]8;;\u001b\\  Emoji secret: \u001b]8;;send:sp3?config={\"spoiler\":true,\"disabled\":true}\u001b\\🔮💀🗝️\u001b]8;;\u001b\\\n",
    "\n",
    "── DISABLED LINKS ─────────────────────────────────────────────────────\n",
    "\u001b]8;;send:d1?config={\"disabled\":true,\"style\":{\"color\":\"gray\",\"strikethrough\":true}}\u001b\\Locked\u001b]8;;\u001b\\ \u001b]8;;send:d2?config={\"disabled\":true,\"style\":{\"color\":\"#666\"},\"tooltip\":\"Requires level 10\"}\u001b\\Premium\u001b]8;;\u001b\\ ← click/right-click blocked, tooltip works\n",
    "\n",
    "── SELECTION (stateful toggles) ───────────────────────────────────────\n",
    "Radio:    \u001b]8;;send:easy?config={\"selection\":{\"group\":\"diff\",\"value\":\"easy\",\"exclusive\":true},\"style\":{\"color\":\"#8f8\",\"selected\":{\"bg\":\"green\",\"bold\":true}}}\u001b\\Easy\u001b]8;;\u001b\\ \u001b]8;;send:hard?config={\"selection\":{\"group\":\"diff\",\"value\":\"hard\",\"exclusive\":true},\"style\":{\"color\":\"#f88\",\"selected\":{\"bg\":\"red\",\"bold\":true}}}\u001b\\Hard\u001b]8;;\u001b\\ (one at a time)\n",
    "Checkbox: \u001b]8;;send:b1?config={\"selection\":{\"group\":\"buffs\",\"value\":\"str\",\"exclusive\":false},\"style\":{\"selected\":{\"bg\":\"#f60\",\"bold\":true}}}\u001b\\[STR]\u001b]8;;\u001b\\ \u001b]8;;send:b2?config={\"selection\":{\"group\":\"buffs\",\"value\":\"dex\",\"exclusive\":false},\"style\":{\"selected\":{\"bg\":\"#08f\",\"bold\":true}}}\u001b\\[DEX]\u001b]8;;\u001b\\ \u001b]8;;send:b3?config={\"selection\":{\"group\":\"buffs\",\"value\":\"int\",\"exclusive\":false},\"style\":{\"selected\":{\"bg\":\"#a0f\",\"bold\":true}}}\u001b\\[INT]\u001b]8;;\u001b\\ (multi-select)\n",
    "Server receives: &selected=true/false in callback\n",
    "\n",
    "── COMPACT SYNTAX (shorthand) ─────────────────────────────────────────\n",
    "Full:  {\"style\":{\"color\":\"red\",\"bold\":true},\"tooltip\":\"info\"}\n",
    "Short: {\"s\":{\"c\":\"red\",\"b\":true},\"t\":\"info\"}  \u001b]8;;send:sh1?config={\"s\":{\"c\":\"red\",\"b\":true},\"t\":\"Shorthand!\"}\u001b\\Try me\u001b]8;;\u001b\\\n",
    "Keys: s=style c=color bg=bg b=bold i=italic u=underline t=tooltip m=menu\n",
    "\n",
    "── PRESETS (define once, reuse) ───────────────────────────────────────\n",
    "\u001b]8;;preset:btn?config={\"s\":{\"bg\":\"#07f\",\"c\":\"white\",\"b\":true},\"t\":\"Button preset\"}\u001b\\\u001b]8;;\u001b\\\u001b]8;;preset:warn?config={\"s\":{\"bg\":\"orange\",\"c\":\"black\",\"b\":true}}\u001b\\\u001b]8;;\u001b\\\u001b]8;;preset:danger?config={\"s\":{\"bg\":\"red\",\"c\":\"white\",\"b\":true}}\u001b\\\u001b]8;;\u001b\\Define: preset:NAME?config={...}  Use: ?preset=NAME\n",
    "Usage:  \u001b]8;;send:p1?preset=btn\u001b\\Button\u001b]8;;\u001b\\ \u001b]8;;send:p2?preset=warn\u001b\\Warning\u001b]8;;\u001b\\ \u001b]8;;send:p3?preset=danger\u001b\\Danger\u001b]8;;\u001b\\ \u001b]8;;send:p4?preset=btn&config={\"s\":{\"c\":\"yellow\"}}\u001b\\Override\u001b]8;;\u001b\\\n",
    "\n",
    "── REAL-WORLD EXAMPLE ─────────────────────────────────────────────────\n",
    "Nav: \u001b]8;;send:north?config={\"s\":{\"c\":\"#0af\",\"b\":true,\"h\":{\"u\":true}}}\u001b\\North\u001b]8;;\u001b\\ \u001b]8;;send:south?config={\"s\":{\"c\":\"#0af\",\"b\":true,\"h\":{\"u\":true}}}\u001b\\South\u001b]8;;\u001b\\ \u001b]8;;send:east?config={\"s\":{\"c\":\"#0af\",\"b\":true,\"h\":{\"u\":true}}}\u001b\\East\u001b]8;;\u001b\\ \u001b]8;;send:west?config={\"s\":{\"c\":\"#0af\",\"b\":true,\"h\":{\"u\":true}}}\u001b\\West\u001b]8;;\u001b\\\n",
    "Item: \u001b]8;;send:sword?config={\"style\":{\"color\":\"#f80\",\"bold\":true,\"hover\":{\"bg\":\"#fc9\",\"color\":\"black\"}},\"menu\":[{\"Equip\":\"send:equip\"},{\"Examine\":\"send:exam\"},\"-\",{\"Drop\":\"send:drop\"}],\"tooltip\":\"+5 Fire Damage\"}\u001b\\🗡️ Flaming Sword\u001b]8;;\u001b\\\n",
    "\n",
    "───────────────────────────────────────────────────────────────────────\n",
    "Docs: https://wiki.mudlet.org/w/Area_51#OSC_8:_Hyperlink_Protocol\n",
    "",
];

/** The banner as one blob, ready to hand to `Console.echo`. */
export function osc8DocumentationExamples(): string {
    return BANNER.join("");
}
