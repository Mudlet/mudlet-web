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
