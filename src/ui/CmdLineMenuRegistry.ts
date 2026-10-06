export interface CmdLineMenuEntry {
    /** Stable id used by removeCommandLineMenuEvent. */
    uniqueName: string;
    /** Event name passed to raiseEvent on click. */
    eventName: string;
    /** Label rendered in the context menu. Defaults to uniqueName. */
    displayName: string;
}

/**
 * Backs Mudlet's addCommandLineMenuEvent / removeCommandLineMenuEvent /
 * getCommandLineMenuEvents. Right-clicking the command bar shows entries from
 * this registry; clicking one raises the registered event with the current
 * command-line text as the first argument.
 *
 * Every command line has a menu of its own, as on desktop (each TCommandLine
 * holds its own map): an entry added to a createCommandLine() line is not on the
 * main bar's menu, and removing it by the main bar's name finds nothing. The
 * main command bar is `'main'`, the default throughout.
 */
export class CmdLineMenuRegistry {
    /** Command line name → that line's entries, by unique name. */
    private menus = new Map<string, Map<string, CmdLineMenuEntry>>();
    private subscribers = new Set<() => void>();
    private dispatcher: ((eventName: string, args: unknown[]) => void) | null = null;

    subscribe(cb: () => void): () => void {
        this.subscribers.add(cb);
        return () => this.subscribers.delete(cb);
    }

    private notify(): void {
        for (const cb of this.subscribers) cb();
    }

    setDispatcher(fn: ((eventName: string, args: unknown[]) => void) | null): void {
        this.dispatcher = fn;
    }

    private menu(cmdLine: string): Map<string, CmdLineMenuEntry> {
        let menu = this.menus.get(cmdLine);
        if (!menu) {
            menu = new Map();
            this.menus.set(cmdLine, menu);
        }
        return menu;
    }

    add(uniqueName: string, eventName: string, displayName?: string, cmdLine = 'main'): boolean {
        if (!uniqueName || !eventName) return false;
        this.menu(cmdLine).set(uniqueName, {
            uniqueName,
            eventName,
            displayName: displayName && displayName.length > 0 ? displayName : uniqueName,
        });
        this.notify();
        return true;
    }

    remove(uniqueName: string, cmdLine = 'main'): boolean {
        const ok = this.menus.get(cmdLine)?.delete(uniqueName) ?? false;
        if (ok) this.notify();
        return ok;
    }

    list(cmdLine = 'main'): CmdLineMenuEntry[] {
        return [...(this.menus.get(cmdLine)?.values() ?? [])];
    }

    /** Forget a command line's menu, along with the command line. */
    drop(cmdLine: string): void {
        if (this.menus.delete(cmdLine)) this.notify();
    }

    /** Raise the entry's event, passing the current command-line text. */
    dispatch(uniqueName: string, cmdLineText: string, cmdLine = 'main'): void {
        const entry = this.menus.get(cmdLine)?.get(uniqueName);
        if (!entry) return;
        this.dispatcher?.(entry.eventName, [cmdLineText]);
    }
}
