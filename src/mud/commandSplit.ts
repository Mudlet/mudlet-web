/**
 * The command-separator split from Mudlet's `Host::send`.
 *
 * One line typed (or one `command` field on an alias/key/trigger/timer/button)
 * can carry several commands, joined by the profile's separator — `;;` by
 * default. Mudlet splits with `Qt::SkipEmptyParts`, so `n;;;;s` is two commands
 * rather than three, and a line that is nothing but separators collapses to
 * nothing at all.
 *
 * An empty result is meaningful: Mudlet answers it by putting a bare line feed
 * on the wire, so pressing Enter on an empty command line still reaches the
 * game (menus, "more" prompts). Callers handle that case themselves — see
 * {@link ScriptingEngine.hostSend} — which is why this returns `[]` rather than
 * quietly inventing an empty command.
 */
export function splitCommands(text: string, separator: string): string[] {
    if (!separator) return text ? [text] : [];
    return text.split(separator).filter(part => part !== '');
}

/**
 * The rest of Host::send's loop on top of the split: each part has its line
 * feeds removed, but only after the empty parts were skipped. So a part that
 * was nothing but a line feed survives as an EMPTY command — which is what an
 * echoed command's trailing line feed (see MudSession.echoSentCommand) leaves
 * after a final separator, or as the whole of an empty one, and what a `^$`
 * alias then fires on.
 */
export function splitSentCommands(text: string, separator: string): string[] {
    return splitCommands(text, separator).map(part => part.replace(/\n/g, ''));
}
