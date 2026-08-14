/**
 * The one source of item ids in a profile.
 *
 * Mudlet hands every trigger, alias, timer, key, button and script its id from
 * a single running number — temporary and permanent alike — so `tempAlias()`
 * followed by `permAlias()` followed by `tempAlias()` yields n, n+1, n+2. mudix
 * grew a counter per engine plus one for the permanent tree, which meant a
 * temporary item and a permanent one could be handed the *same* id: two
 * different things answering to one number, which `killAlias(id)` and
 * `exists(name)` then could not tell apart.
 *
 * Injected rather than constructed in place (see {@link ScriptingEngine}, which
 * hands its own sequence to each engine) so every engine in a profile draws
 * from the same one, while a bare engine built for a unit test still works with
 * a private sequence of its own.
 */
export class ItemIdSequence {
    private n = 1;

    next(): number {
        return this.n++;
    }

    /** Ensure future ids exceed `id` — used when an id arrives from outside the
     *  sequence (a restored profile, say) so it can never be handed out twice. */
    reserve(id: number): void {
        if (Number.isFinite(id) && id >= this.n) this.n = Math.trunc(id) + 1;
    }
}
