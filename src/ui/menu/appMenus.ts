/**
 * The client's own menus — Mudlet's menu bar (main_window.ui) as far as a
 * browser tab has anything to put under it.
 *
 * The titles and their order are Mudlet's: Games, Toolbox, Options, Window,
 * Help, About. What hangs under them is not, and deliberately so — Mudlet's
 * "Reattach detached windows", "Always on top" and "Minimize" describe a
 * desktop window this client does not own, and an entry that cannot work is
 * worse than an absent one. What is here is what the toolbar already does,
 * reachable a second way, plus the two things the toolbar has no room for
 * (timestamps, About).
 *
 * A brand can hide any stock toolbar button; the same decision hides the menu
 * entry, so a brand that removed a feature does not find it again in a menu.
 * Menus that empty out that way are dropped rather than drawn blank.
 */
import type { StockToolbarButton } from '../../branding';
import type { AppCommandId } from '../commands/appShortcuts';
import type { MenuNode, TopMenu } from './menuModel';

export interface AppMenuContext {
    /** The brand's stock-button filter, shared with the toolbar row. */
    show: (id: StockToolbarButton) => boolean;
    appName: string;
    /** The Games menu's entries — the same list the toolbar's Connect split
     *  button holds, passed in rather than rebuilt here. The two are one
     *  control on two surfaces. */
    connectionItems: MenuNode[];
    replayRecording: boolean;
    /** Playback speed of the running replay, or null when none is playing. */
    replaySpeed: number | null;
    /** The document is in real fullscreen, and whether the browser allows it. */
    fullscreen: boolean;
    fullscreenAvailable: boolean;
    /** Mudlet's main-toolbar visibility. The menu bar's own switch is NOT here:
     *  an entry that hides the menu it is in leaves no way back to itself, so
     *  that one lives in the settings only. */
    showToolbar: boolean;
    showTimestamps: boolean;
    /** Mudlet's three media mute entries — the same list the toolbar's Mute
     *  split button holds, passed in rather than rebuilt so the two surfaces
     *  cannot come to describe the gates differently. */
    muteItems: MenuNode[];
    /** The key bound to a command right now, for the menu to draw beside its
     *  label — the entry ids below ARE the command ids, so the lookup needs no
     *  second table to go wrong. */
    shortcutFor: (id: AppCommandId) => string | undefined;

    onOpenScripts: () => void;
    onOpenMap: () => void;
    onOpenFiles: () => void;
    onOpenLogs: () => void;
    onToggleReplayRecording: () => void;
    onReplayStop: () => void;
    onOpenSettings: () => void;
    onToggleTimestamps: () => void;
    onToggleFullscreen: () => void;
    onToggleToolbar: () => void;
    onOpenDocs: () => void;
    onOpenHelp: () => void;
    onOpenAbout: () => void;
    onReportBug: () => void;
}

/** A separator that has nothing on one side of it separates nothing, and two in
 *  a row draw a double rule. Both happen as soon as a brand hides a button, so
 *  they are tidied here rather than guarded at every entry. */
function tidy(nodes: (MenuNode | null)[]): MenuNode[] {
    const kept = nodes.filter((n): n is MenuNode => n !== null);
    const out: MenuNode[] = [];
    for (const node of kept) {
        if (node.kind === 'separator' && (out.length === 0 || out[out.length - 1].kind === 'separator')) continue;
        out.push(node);
    }
    while (out.length > 0 && out[out.length - 1].kind === 'separator') out.pop();
    return out;
}

/** Menus with nothing left in them are not drawn — an empty title opening an
 *  empty box is a bug report waiting to happen. */
function menu(id: string, label: string, nodes: (MenuNode | null)[]): TopMenu | null {
    const items = tidy(nodes);
    return items.length > 0 ? { id, label, items } : null;
}

export function buildAppMenus(ctx: AppMenuContext): TopMenu[] {
    const sep = (id: string): MenuNode => ({ kind: 'separator', id });
    const item = (
        id: AppCommandId | 'stopReplay' | 'reportBug',
        label: string,
        run: () => void,
        extra?: { checked?: boolean; disabled?: boolean },
    ): MenuNode => ({
        kind: 'action',
        id,
        label,
        run,
        shortcut: ctx.shortcutFor(id as AppCommandId),
        ...extra,
    });

    const menus: (TopMenu | null)[] = [
        menu('games', 'Games', ctx.connectionItems),
        menu('toolbox', 'Toolbox', [
            ctx.show('scripts') ? item('scriptEditor', 'Script editor', ctx.onOpenScripts) : null,
            ctx.show('map') ? item('map', 'Map', ctx.onOpenMap) : null,
            ctx.show('files') ? item('files', 'Files', ctx.onOpenFiles) : null,
            ctx.show('logs') ? item('logs', 'Logs', ctx.onOpenLogs) : null,
            sep('toolbox-1'),
            ctx.show('record')
                ? item('toggleReplay', 'Record replay', ctx.onToggleReplayRecording, { checked: ctx.replayRecording })
                : null,
            // Only while one is playing: Mudlet greys the entry out, but there
            // it sits beside a replay picker that gives the greyed entry
            // context. On its own it would be a permanently dead line.
            ctx.replaySpeed !== null ? item('stopReplay', 'Stop replay', ctx.onReplayStop) : null,
        ]),
        menu('options', 'Options', [
            ctx.show('settings') ? item('preferences', 'Preferences…', ctx.onOpenSettings) : null,
            item('toggleTimestamps', 'Show timestamps', ctx.onToggleTimestamps, { checked: ctx.showTimestamps }),
            sep('options-1'),
            ...(ctx.show('mute') ? ctx.muteItems : []),
        ]),
        menu('window', 'Window', [
            // Really fullscreen — the browser's own, over the whole screen.
            // Greyed out rather than absent where the browser refuses it (an
            // iframe without `allow="fullscreen"`), so an embedded client still
            // shows what the entry is and why nothing happens.
            item('fullscreen', 'Fullscreen', ctx.onToggleFullscreen, {
                checked: ctx.fullscreen,
                disabled: !ctx.fullscreenAvailable,
            }),
            sep('window-1'),
            item('toggleButtonBar', 'Button bar', ctx.onToggleToolbar, { checked: ctx.showToolbar }),
        ]),
        menu('help', 'Help', [
            ctx.show('help') ? item('help', 'Help', ctx.onOpenHelp) : null,
            ctx.show('docs') ? item('docs', 'Lua scripting reference', ctx.onOpenDocs) : null,
        ]),
        menu('about', 'About', [
            item('about', `About ${ctx.appName}`, ctx.onOpenAbout),
            ctx.show('reportBug') ? item('reportBug', 'Report an issue', ctx.onReportBug) : null,
        ]),
    ];

    return menus.filter((m): m is TopMenu => m !== null);
}
