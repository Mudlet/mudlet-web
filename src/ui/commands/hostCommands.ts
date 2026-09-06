/**
 * `addCommand` for the application embedding this client.
 *
 * A package written in Lua can already place a command on the toolbar and the
 * menu bar and change it afterwards. A white-label host had no equivalent: it
 * could declare buttons in its `BrandConfig` at boot and nothing after, so a
 * command that appears when the player logs in, or greys out while a request is
 * in flight, meant re-rendering the whole client with a new brand object.
 *
 * This is the same contract from JavaScript. It is a module-level singleton
 * rather than a React context on purpose — a host app's command usually lives
 * next to the state that decides whether it should be there, which is rarely a
 * component inside the client's tree.
 *
 * Ids are strings and never reused, so a removed command's id answers as
 * unknown for good rather than coming back as something else.
 */
import type { ReactNode } from 'react';
import type { BrandToolbarContext } from '../../branding';
import type { CommandSurface } from './addonCommands';

export interface HostCommandRequest {
    /** The caller's own id, if it wants one — `commands.remove('roll')` then
     *  works without holding on to what `add` returned. Absent gets a generated
     *  one. Placing a second command under an id that is taken replaces it. */
    id?: string;
    /** Shown on the button and the menu entry. */
    name: string;
    /** An image URL, or any node — an inline SVG needs no round trip through a
     *  file. Sized to the text by the stylesheet either way. */
    icon?: ReactNode;
    tooltip?: string;
    /** Where on the menu bar: '/'-separated, the first segment naming a
     *  top-level menu (an existing title joins it, a new one opens a menu at
     *  the end of the bar). Absent puts it among the other package tools. */
    menuPath?: string;
    /** Qt-style key sequence, e.g. "Ctrl+Alt+K". */
    shortcut?: string;
    /** Which bars it appears on. Absent means both. */
    surfaces?: CommandSurface;
    enabled?: boolean;
    checked?: boolean;
    /**
     * Run when the command is picked. The context is the same one brand
     * toolbar buttons get: `send` a command as if typed, `raiseEvent` for the
     * profile's Lua handlers, and the open profile's id.
     *
     * Called with null when no profile is open — a command can be placed before
     * the player has picked one, and refusing to fire silently would be worse
     * than letting the host decide.
     */
    onClick: (ctx: BrandToolbarContext | null) => void;
}

export interface HostCommand extends HostCommandRequest {
    id: string;
    surfaces: CommandSurface;
    enabled: boolean;
    checked: boolean;
}

export class HostCommandRegistry {
    private readonly commands = new Map<string, HostCommand>();
    private next = 1;
    private readonly listeners = new Set<() => void>();
    /** The snapshot handed to React. Rebuilt on change rather than on read, so
     *  `useSyncExternalStore` sees a stable reference between changes and does
     *  not re-render on every commit. */
    private snapshot: readonly HostCommand[] = [];

    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    };

    /** Every placed command, in placement order — which is drawing order. */
    list = (): readonly HostCommand[] => this.snapshot;

    private changed(): void {
        this.snapshot = [...this.commands.values()];
        for (const fn of this.listeners) fn();
    }

    /** Place a command. Returns its id, for everything below. */
    add(request: HostCommandRequest): string {
        const id = request.id ?? `cmd-${this.next++}`;
        this.commands.set(id, {
            ...request,
            id,
            surfaces: request.surfaces ?? 'both',
            enabled: request.enabled ?? true,
            checked: request.checked ?? false,
        });
        this.changed();
        return id;
    }

    /** False for an id nobody knows, rather than throwing — one sequence covers
     *  every command, so an unknown id names nothing at all. */
    remove(id: string): boolean {
        if (!this.commands.delete(id)) return false;
        this.changed();
        return true;
    }

    /** Change anything about a placed command except its id. */
    update(id: string, patch: Partial<HostCommandRequest>): boolean {
        const command = this.commands.get(id);
        if (!command) return false;
        this.commands.set(id, { ...command, ...patch });
        this.changed();
        return true;
    }

    setEnabled(id: string, enabled: boolean): boolean { return this.update(id, { enabled }); }
    setChecked(id: string, checked: boolean): boolean { return this.update(id, { checked }); }
    setIcon(id: string, icon: string): boolean { return this.update(id, { icon }); }
    setTooltip(id: string, tooltip: string): boolean { return this.update(id, { tooltip }); }

    /** Drop everything. For a host tearing its own UI down; the client never
     *  calls this, since these commands outlive any one profile. */
    clear(): void {
        if (this.commands.size === 0) return;
        this.commands.clear();
        this.changed();
    }
}

/** The one registry the client reads. Exported from the package root as
 *  `commands`. */
export const hostCommands = new HostCommandRegistry();
