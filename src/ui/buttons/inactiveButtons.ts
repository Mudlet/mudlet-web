/**
 * The buttons, per profile, that cannot be active whatever their switch says:
 * their Lua will not compile. Desktop's TAction::compileScript leaves such a
 * button with `mOK_code` false, so `Tree::activate` refuses it and the toolbar
 * builders (TToolBar/TEasyButtonBar::addActionButtons, ActionUnit's
 * constructToolbar) leave it off — a toolbar or menu that will not compile
 * takes its buttons with it.
 *
 * The ScriptingEngine owns the compile check and publishes its answer here;
 * the button bar reads it. Kept outside the store, since it is derived from the
 * buttons rather than part of them, and outside the engine, whose instance the
 * bar only holds by ref.
 */

const EMPTY: ReadonlySet<string> = new Set();

class InactiveButtonRegistry {
    private readonly byConnection = new Map<string, ReadonlySet<string>>();
    private readonly listeners = new Set<() => void>();

    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    };

    /** The ids for this profile. The same Set until they change, so it can be
     *  a useSyncExternalStore snapshot. */
    get = (connectionId: string): ReadonlySet<string> => this.byConnection.get(connectionId) ?? EMPTY;

    set(connectionId: string, ids: ReadonlySet<string>): void {
        const prev = this.get(connectionId);
        if (prev.size === ids.size && [...ids].every(id => prev.has(id))) return;
        if (ids.size === 0) this.byConnection.delete(connectionId);
        else this.byConnection.set(connectionId, ids);
        for (const fn of this.listeners) fn();
    }

    clear(connectionId: string): void {
        this.set(connectionId, EMPTY);
    }
}

export const inactiveButtons = new InactiveButtonRegistry();
