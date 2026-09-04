/**
 * Edit-time detection of the alias that feeds itself: a pattern that matches
 * its own substitution, so sending the command re-triggers the alias.
 *
 * Desktop refuses the save outright — `if (aliasSubstitutionLoops(regex,
 * substitution)) { showAliasLoopWarning(...); return; }`
 * (dlgTriggerEditor.cpp:6174-6178, :15054, :15090), implemented at :6269 as an
 * unanchored match of the pattern against the substitution.
 *
 * Here it only warns. mudix already stops the damage at runtime — send()
 * refuses past `MAX_SEND_DEPTH` with a message naming the alias — and that
 * guard catches indirect loops (A → B → A) this one cannot see. Refusing the
 * save on top of it would block the direct case while still letting the
 * indirect one through, so the warning is what the runtime guard is missing:
 * feedback before the 25 junk lines rather than after them.
 *
 * The match runs through JS `RegExp`, not PCRE — near enough for a warning, and
 * a pattern that does not compile here produces none, mirroring desktop's
 * `if (!rx.isValid()) return false`.
 */
export function aliasSubstitutionLoops(pattern: string, substitution: string): boolean {
    if (!pattern || !substitution) return false;
    let rx: RegExp;
    try {
        rx = new RegExp(pattern);
    } catch {
        return false;
    }
    return rx.test(substitution);
}

/** The warning shown beside a looping alias, worded as desktop words it
 *  (`showAliasLoopWarning`, dlgTriggerEditor.cpp:6364-6369) minus the refusal. */
export function aliasLoopWarning(name: string): string {
    return `Alias "${name || 'this alias'}" has an infinite loop — the command matches its own pattern, so it will call itself until send() cuts it off.`;
}
