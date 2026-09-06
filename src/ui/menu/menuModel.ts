/**
 * The shape of the client's own menu bar, and where a package's menu commands
 * land in it.
 *
 * Mudlet shows a command in two places: on the toolbar and on the menu bar. The
 * toolbar half has been here since addCommand landed; this is the other half,
 * and it is the reason `menuPath` exists at all — a path with nowhere to lead
 * was accepted and then quietly dropped.
 *
 * The menus themselves mirror main_window.ui (Games, Toolbox, Options, Window,
 * Help, About) as far as a browser tab has anything to put under them. Entries
 * Mudlet has and a web client cannot (always-on-top, minimise, reattach
 * detached windows, IRC) are absent rather than present-and-dead.
 */
import type { ReactNode } from 'react';

/**
 * A command asking to be placed, from whichever source. Packages place them
 * with `addCommand` from Lua and a host app with the exported `commands`
 * registry; by the time they reach here the difference is gone, which is the
 * point — a white-label client's own command should sit in a menu exactly the
 * way a package's does.
 */
export interface PlacedCommand {
    /** Unique across sources, so the two cannot collide: `lua:3`, `host:7`. */
    id: string;
    name: string;
    /** An image URL from a package's setCommandIcon, or any node a host app
     *  passed. */
    icon?: ReactNode;
    tooltip?: string;
    /** Where on the menu bar. Empty means {@link DEFAULT_ADDON_MENU}. */
    menuPath?: string;
    shortcut?: string;
    enabled?: boolean;
    checked?: boolean;
    run: () => void;
}

export interface MenuAction {
    kind: 'action';
    /** Stable within its menu — the React key, and what the tests match on. */
    id: string;
    label: string;
    /** Qt-style key sequence, drawn right-aligned. Display only: the registry
     *  reserves a package's key, but nothing dispatches it yet. */
    shortcut?: string;
    /** Drawn with a tick. `undefined` means the entry is not checkable at all,
     *  which is not the same as unchecked — only the first gets no tick column
     *  reserved by the screen reader. */
    checked?: boolean;
    disabled?: boolean;
    /** A package's icon path, or a node from a host app or a brand. Sized to
     *  the label by the stylesheet either way. */
    icon?: ReactNode;
    run: () => void;
}

export interface MenuSeparator {
    kind: 'separator';
    id: string;
}

export interface MenuSubmenu {
    kind: 'submenu';
    id: string;
    label: string;
    items: MenuNode[];
}

export type MenuNode = MenuAction | MenuSeparator | MenuSubmenu;

export interface TopMenu {
    id: string;
    label: string;
    items: MenuNode[];
}

/** How a package writes a nested path. Mudlet's menus nest, so the path has to
 *  be able to say so; '/' is the one separator no menu title uses. */
const PATH_SEPARATOR = '/';

/**
 * Where a menu command with no path of its own goes. Toolbox is where Mudlet
 * keeps the things packages bring (the package and module managers, the script
 * editor), so a command that named no menu is at least among its own kind
 * rather than opening a top-level menu holding one entry.
 */
export const DEFAULT_ADDON_MENU = 'Toolbox';

/** Menu titles are matched the way a person would read them: a package asking
 *  for "toolbox" means the Toolbox menu, not a second one beside it. */
function sameTitle(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
}

/**
 * The menu bar with `commands` placed in it, leaving `menus` untouched.
 *
 * A path's first segment names a top-level menu — an existing one when the
 * title matches, a new one at the end of the bar otherwise — and each further
 * segment a submenu under it. Commands arrive in placement order, which is the
 * order they are drawn in: a package that adds three commands gets them in the
 * order it added them, under or beside whatever was already there.
 */
export function placeCommands(
    menus: TopMenu[],
    commands: readonly PlacedCommand[],
): TopMenu[] {
    if (commands.length === 0) return menus;

    const out: TopMenu[] = menus.map(m => ({ ...m, items: [...m.items] }));
    // Menus that have already had the rule drawn between what the client put
    // there and what packages added. One per menu, not one per command.
    const parted = new Set<string>();

    for (const command of commands) {
        const segments = (command.menuPath ?? '').split(PATH_SEPARATOR)
            .map(s => s.trim())
            .filter(s => s.length > 0);
        const title = segments.shift() ?? DEFAULT_ADDON_MENU;

        let menu = out.find(m => sameTitle(m.label, title));
        if (!menu) {
            menu = { id: `addon-menu:${title.toLowerCase()}`, label: title, items: [] };
            out.push(menu);
        }
        if (!parted.has(menu.id)) {
            parted.add(menu.id);
            if (menu.items.length > 0) {
                menu.items.push({ kind: 'separator', id: `${menu.id}:addon-rule` });
            }
        }

        let items = menu.items;
        for (const segment of segments) {
            let sub = items.find(
                (n): n is MenuSubmenu => n.kind === 'submenu' && sameTitle(n.label, segment),
            );
            if (!sub) {
                sub = { kind: 'submenu', id: `${menu.id}:${segment.toLowerCase()}`, label: segment, items: [] };
                items.push(sub);
            }
            items = sub.items;
        }

        items.push({
            kind: 'action',
            id: `addon-command:${command.id}`,
            label: command.name,
            shortcut: command.shortcut || undefined,
            // A command is checkable only once something has checked it: an
            // unchecked one draws no tick, same as Mudlet's default QAction.
            checked: command.checked ? true : undefined,
            disabled: command.enabled === false,
            icon: command.icon || undefined,
            run: command.run,
        });
    }

    return out;
}
