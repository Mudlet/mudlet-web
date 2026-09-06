/**
 * The client's own keyboard shortcuts — Mudlet's menu accelerators, and the
 * handful of things this client has that Mudlet does not.
 *
 * Mudlet's are fixed, compiled into the menu actions. These are defaults: the
 * settings dialog can move any of them, and the stored override is what the
 * dispatcher and the menu labels both read. That is the one place this
 * deliberately goes further than Mudlet — in a browser a shortcut can collide
 * with something the browser or an extension already holds, and a player who
 * cannot reach the script editor because Alt+E is spoken for has no recourse
 * unless the binding moves.
 *
 * The keys themselves are Mudlet's, including the platform split: the menu
 * group is Alt on Windows and Linux and Ctrl on macOS (mudlet.cpp:1462-1512),
 * where Alt is a text-entry modifier. Commands Mudlet has no key for start
 * unbound rather than being given one this client invented — a player who wants
 * one can say so, and a default that disagreed with Mudlet's would be a trap
 * for anyone who uses both.
 *
 * Mudlet's profile-switching keys (Ctrl+1…9, Ctrl+Tab) are absent by design:
 * multiple profiles here are multiple browser tabs, and the browser owns those
 * keys. `addonCommands.ts` still reserves them against packages, because a
 * package written for desktop Mudlet will expect them to be taken.
 */

import { detectAccel } from '../../mud/keybindings/browserReservedKeys';
import { getBrand, type StockToolbarButton } from '../../branding';

/** Everything the client can be asked to do from the keyboard. */
export type AppCommandId =
    | 'connect' | 'disconnect' | 'reconnect' | 'closeProfile'
    | 'scriptEditor' | 'map' | 'files' | 'logs' | 'toggleReplay'
    | 'preferences' | 'toggleTimestamps' | 'mute' | 'toggleLogging'
    | 'fullscreen' | 'toggleButtonBar'
    | 'inputLine' | 'docs' | 'help' | 'about';

export interface AppShortcutDef {
    id: AppCommandId;
    label: string;
    /**
     * The stock button this command belongs to, where it has one. A brand that
     * hid the button has removed the feature, so the shortcut goes with it —
     * both the binding and its row in the settings. A key that still opened the
     * script editor after the brand took the script editor away would be a back
     * door into something they deliberately removed.
     */
    stock?: StockToolbarButton;
    /** The menu this command lives in, so the settings list is grouped the way
     *  the menu bar is rather than as one flat run of nineteen rows. */
    group: 'Games' | 'Toolbox' | 'Options' | 'Window' | 'Help';
    /** Mudlet's key on Windows and Linux, and on macOS. Empty on both where
     *  Mudlet has no key for it. */
    defaultKey: string;
    defaultKeyMac: string;
}

/** Mudlet's menu group: Alt+<letter> on Windows and Linux, Ctrl+<letter> on
 *  macOS. Written out rather than generated so each entry is greppable. */
export const APP_SHORTCUTS: readonly AppShortcutDef[] = [
    { id: 'connect', label: 'Connect', group: 'Games', stock: 'connection', defaultKey: 'Alt+C', defaultKeyMac: 'Ctrl+Alt+C' },
    { id: 'disconnect', label: 'Disconnect', group: 'Games', stock: 'connection', defaultKey: 'Alt+D', defaultKeyMac: 'Ctrl+D' },
    { id: 'reconnect', label: 'Reconnect', group: 'Games', stock: 'connection', defaultKey: 'Alt+R', defaultKeyMac: 'Ctrl+R' },
    { id: 'closeProfile', label: 'Close profile', group: 'Games', stock: 'close', defaultKey: 'Alt+W', defaultKeyMac: 'Ctrl+W' },

    { id: 'scriptEditor', label: 'Script editor', group: 'Toolbox', stock: 'scripts', defaultKey: 'Alt+E', defaultKeyMac: 'Ctrl+E' },
    { id: 'map', label: 'Map', group: 'Toolbox', stock: 'map', defaultKey: 'Alt+M', defaultKeyMac: 'Ctrl+M' },
    { id: 'files', label: 'Files', group: 'Toolbox', stock: 'files', defaultKey: '', defaultKeyMac: '' },
    { id: 'logs', label: 'Logs', group: 'Toolbox', stock: 'logs', defaultKey: '', defaultKeyMac: '' },
    { id: 'toggleReplay', label: 'Record replay', group: 'Toolbox', stock: 'record', defaultKey: 'Ctrl+Alt+R', defaultKeyMac: 'Ctrl+Alt+R' },

    { id: 'preferences', label: 'Preferences', group: 'Options', stock: 'settings', defaultKey: 'Alt+P', defaultKeyMac: 'Ctrl+P' },
    { id: 'toggleTimestamps', label: 'Show timestamps', group: 'Options', defaultKey: 'Ctrl+Alt+T', defaultKeyMac: 'Ctrl+Alt+T' },
    { id: 'mute', label: 'Mute all media', group: 'Options', stock: 'mute', defaultKey: 'Alt+K', defaultKeyMac: 'Ctrl+K' },
    { id: 'toggleLogging', label: 'Record session logs', group: 'Options', defaultKey: 'Ctrl+Alt+L', defaultKeyMac: 'Ctrl+Alt+L' },

    // F11 is the browser's own fullscreen key and is very likely handled above
    // the page — this client may never see the keypress. It is written down
    // anyway, because what the player wants to know is "which key makes this
    // fullscreen", and the answer is F11 whichever layer acts on it. Where the
    // press does reach us, the entry runs the Fullscreen API and the menu's
    // tick stays right; where it does not, the browser does the same thing.
    { id: 'fullscreen', label: 'Fullscreen', group: 'Window', defaultKey: 'F11', defaultKeyMac: 'F11' },
    { id: 'toggleButtonBar', label: 'Button bar', group: 'Window', defaultKey: '', defaultKeyMac: '' },
    // Mudlet's Alt+L focuses the command line. It is in the Window group here
    // because that is what it moves the keyboard to.
    { id: 'inputLine', label: 'Focus the command line', group: 'Window', defaultKey: 'Alt+L', defaultKeyMac: 'Ctrl+L' },

    { id: 'docs', label: 'Lua scripting reference', group: 'Help', stock: 'docs', defaultKey: '', defaultKeyMac: '' },
    { id: 'help', label: 'Help', group: 'Help', stock: 'help', defaultKey: '', defaultKeyMac: '' },
    { id: 'about', label: 'About', group: 'Help', defaultKey: '', defaultKeyMac: '' },
];

/**
 * The commands this build actually exposes.
 *
 * A brand that hid a stock button removed the feature, and a shortcut is
 * another door onto the same room — so the binding goes with the button, and so
 * does its row in the settings. Otherwise a white-label client that took the
 * script editor away would still open it on Alt+E, and offer to rebind it.
 *
 * Commands with no `stock` id (timestamps, logging, fullscreen, the bars, the
 * command line, About) belong to no button and are always available.
 */
export function availableShortcuts(): readonly AppShortcutDef[] {
    const hidden = new Set(getBrand().toolbar?.hide ?? []);
    if (hidden.size === 0) return APP_SHORTCUTS;
    return APP_SHORTCUTS.filter(def => !def.stock || !hidden.has(def.stock));
}

/** The order the settings list draws the groups in — the menu bar's own. */
export const SHORTCUT_GROUPS: readonly AppShortcutDef['group'][] =
    ['Games', 'Toolbox', 'Options', 'Window', 'Help'];

/** Which key map this machine gets, in the same spelling `getOS()` uses so the
 *  addon-command registry and this agree on what "mac" means. */
export function shortcutPlatform(): string {
    return detectAccel() === 'meta' ? 'mac' : 'other';
}

/** What the client would use with nothing overridden. `platform` is what
 *  `getOS()` reports: 'mac' picks Mudlet's macOS key. */
export function defaultShortcut(def: AppShortcutDef, platform: string): string {
    return platform === 'mac' ? def.defaultKeyMac : def.defaultKey;
}

/** What a stored override means. A key that is present and empty is a binding
 *  the player deliberately cleared, which is not the same as never having
 *  touched it — clearing has to survive a default changing under them. */
export type ShortcutOverrides = Readonly<Record<string, string>>;

/** The key actually in force for `def`. */
export function effectiveShortcut(
    def: AppShortcutDef,
    overrides: ShortcutOverrides | undefined,
    platform: string,
): string {
    const override = overrides?.[def.id];
    return override === undefined ? defaultShortcut(def, platform) : override;
}

/** A reader for one command's key, for the menu entries that draw it beside
 *  their label. Undefined rather than empty for an unbound command, so a menu
 *  entry can leave the column blank rather than drawing nothing-in-particular. */
export function shortcutLookup(
    overrides: ShortcutOverrides | undefined,
    platform: string,
): (id: AppCommandId) => string | undefined {
    // Only what this build exposes: a menu entry a brand kept must not advertise
    // a key beside it that another of its decisions has switched off.
    const byId = new Map(availableShortcuts().map(def => [def.id, effectiveShortcut(def, overrides, platform)]));
    return id => byId.get(id) || undefined;
}

/** Every command with a key, as `{id, label, shortcut}`. Commands with no key
 *  are left out — there is nothing to dispatch or to warn about. */
export function boundShortcuts(
    overrides: ShortcutOverrides | undefined,
    platform: string,
): { id: AppCommandId; label: string; shortcut: string }[] {
    return availableShortcuts()
        .map(def => ({ id: def.id, label: def.label, shortcut: effectiveShortcut(def, overrides, platform) }))
        .filter(entry => entry.shortcut.length > 0);
}
