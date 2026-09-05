/**
 * Mudlet's addon command API — the commands a package places on the client's
 * own surfaces (`addCommand`, `removeCommand`, `enableCommand`, …).
 *
 * This holds the state and the answers; the argument contract in front of it
 * lives in Bridge.lua, because the refusals name the Lua type of what they were
 * given ("surfaces has to be a list of surface names and this one holds a
 * boolean") and a value's Lua type is exactly what does not survive the trip
 * across wasmoon.
 *
 * What "reserved" means here is worth being straight about. On desktop Mudlet
 * answers "is this key free?" by asking Qt what is currently wired to the
 * window. There is no widget tree to ask in a browser tab, so the keys Mudlet
 * itself holds are written down below instead — a mirror of another
 * application's keyboard map, and it will need revisiting when Mudlet moves a
 * shortcut. The alternative was to reserve nothing, which is technically true
 * of a client with no menu bar and useless to a package author: a shortcut
 * accepted here and refused on desktop is a bug report either way, and the
 * quiet version (Qt disables BOTH bindings when two things claim one key) is
 * the worse of the two to debug.
 */

/** Where a command can be placed. Absent means both, never neither. */
export type CommandSurface = 'menu' | 'toolbar' | 'both';

export interface AddonCommand {
    id: number;
    name: string;
    icon: string;
    tooltip: string;
    menuPath: string;
    shortcut: string;
    surfaces: CommandSurface;
    enabled: boolean;
    checked: boolean;
    pulse: { colour: string; altColour: string; intervalMs: number } | null;
}

/** A request as Bridge.lua hands it over, already type-checked there. */
export interface CommandRequest {
    name: string;
    icon?: string;
    tooltip?: string;
    menuPath?: string;
    shortcut?: string;
    surfaces?: CommandSurface;
}

/**
 * Keys Mudlet holds itself, and the name it would quote back for each.
 *
 * Two groups, because the spec pins that both are answered and they come from
 * different places on desktop. The profile-switching keys are never on a menu
 * action at all, and hiding the menu bar moves every other one onto a plain
 * QShortcut — so answering from what happens to be wired up handed Ctrl+1 to a
 * package and left the player with two things on one key.
 *
 * Names are the English ones. Mudlet translates them, and the spec only checks
 * that a holder was quoted at all, precisely because it cannot check the text.
 */
/** The menu commands whose key differs by platform (mudlet.cpp:1462-1512):
 *  historically Alt on Windows and Linux, which is uncomfortable on macOS, so
 *  the same commands sit on Ctrl there. Listed by the letter they share. */
const PLATFORM_MENU_KEYS: ReadonlyArray<readonly [string, string]> = [
    ['e', 'Script editor'], ['m', 'Map'], ['l', 'Input line'], ['p', 'Preferences'],
    ['n', 'Notepad'], ['o', 'Package manager'], ['i', 'Module manager'],
    ['v', 'Multi-view'], ['k', 'Mute'], ['c', 'Connect'], ['d', 'Disconnect'],
    ['r', 'Reconnect'], ['w', 'Close profile'],
];

/** Same key on every platform. */
const FIXED_SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
    ['ctrl+alt+t', 'Toggle timestamps'],
    ['ctrl+alt+r', 'Toggle replay'],
    ['ctrl+alt+l', 'Toggle logging'],
    ['ctrl+alt+s', 'Emergency stop'],
];

/** What Mudlet holds on this platform, and the name it would quote back. */
function reservedShortcuts(platform: string): ReadonlyMap<string, string> {
    const mac = platform === 'mac';
    const reserved = new Map<string, string>(FIXED_SHORTCUTS);
    for (const [letter, name] of PLATFORM_MENU_KEYS) {
        reserved.set(`${mac ? 'ctrl' : 'alt'}+${letter}`, name);
    }
    if (mac) {
        // The two that move to Ctrl+Alt there, the plain Ctrl spelling being
        // taken by the menu commands above.
        reserved.set('ctrl+alt+v', 'Multi-view');
        reserved.set('ctrl+alt+c', 'Connect');
    }
    // Qt::CTRL is Cmd on macOS, giving the Cmd+1..9 convention there and
    // Ctrl+1..9 elsewhere — reserved either way.
    for (let i = 1; i <= 9; i++) reserved.set(`ctrl+${i}`, `Switch to profile ${i}`);
    reserved.set(mac ? 'meta+tab' : 'ctrl+tab', 'Next profile');
    reserved.set(mac ? 'meta+shift+tab' : 'ctrl+shift+tab', 'Previous profile');
    return reserved;
}

/** The buffer search's key, held only while the search is switched on. Its
 *  own reservation because it comes and goes with a preference, which the spec
 *  exercises from both ends. */
const SEARCH_SHORTCUT = 'f3';
const SEARCH_HOLDER = 'Buffer search';

/** Qt's QKeySequence holds four steps and silently drops the rest, so a longer
 *  sequence binds a key nobody asked for. */
export const MAX_SHORTCUT_STEPS = 4;

/** Normalised for comparison only — case and spacing carry no meaning in a Qt
 *  key sequence, so "Ctrl+Alt+L" and "ctrl+alt+l" are one key. */
export function normaliseShortcut(shortcut: string): string {
    return shortcut.replace(/\s+/g, '').toLowerCase();
}

export class AddonCommandRegistry {
    private readonly commands = new Map<number, AddonCommand>();
    /** Monotonic and never reused: an id that has been removed must answer as
     *  unknown for good, not come back as a different command. */
    private nextId = 1;
    private listeners = new Set<() => void>();
    /** Whether the buffer search currently holds its key. Pushed in rather than
     *  read out, so this file needs no store dependency. */
    private searchActive = false;
    /** Which platform's key map Mudlet would be answering from. Pushed in for
     *  the same reason. */
    private reserved: ReadonlyMap<string, string> = reservedShortcuts('');

    setPlatform(platform: string): void {
        this.reserved = reservedShortcuts(platform);
    }

    subscribe(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    }

    private notify(): void {
        for (const fn of this.listeners) fn();
    }

    list(): AddonCommand[] {
        return [...this.commands.values()];
    }

    get(id: number): AddonCommand | undefined {
        return this.commands.get(id);
    }

    /**
     * Who holds `shortcut`, or null when it is free. `null` for an empty
     * shortcut too — asking for no key is not a clash.
     *
     * A command of THIS profile is named outright; Mudlet's own keys answer
     * with the reserved name. The spec tells the two apart deliberately: a
     * package author can fix a clash with their own command, and needs to know
     * when they cannot.
     */
    holderOf(shortcut: string, ignoreId?: number): string | null {
        const key = normaliseShortcut(shortcut);
        if (!key) return null;
        if (this.searchActive && key === SEARCH_SHORTCUT) return SEARCH_HOLDER;
        const reserved = this.reserved.get(key);
        if (reserved) return reserved;
        for (const command of this.commands.values()) {
            if (command.id === ignoreId) continue;
            if (normaliseShortcut(command.shortcut) === key) return command.name;
        }
        return null;
    }

    /** Commands currently on `shortcut` — what the buffer search needs to know
     *  before it takes its key back. */
    commandsOn(shortcut: string): AddonCommand[] {
        const key = normaliseShortcut(shortcut);
        return this.list().filter(c => normaliseShortcut(c.shortcut) === key);
    }

    get searchHoldsItsKey(): boolean { return this.searchActive; }
    get searchShortcut(): string { return SEARCH_SHORTCUT; }

    /** Told by the config layer, because the search is a preference rather than
     *  anything this registry owns. */
    setSearchActive(active: boolean): void {
        if (this.searchActive === active) return;
        this.searchActive = active;
        this.notify();
    }

    add(request: CommandRequest): number {
        const id = this.nextId++;
        this.commands.set(id, {
            id,
            name: request.name,
            icon: request.icon ?? '',
            tooltip: request.tooltip ?? '',
            menuPath: request.menuPath ?? '',
            shortcut: request.shortcut ?? '',
            surfaces: request.surfaces ?? 'both',
            enabled: true,
            checked: false,
            pulse: null,
        });
        this.notify();
        return id;
    }

    remove(id: number): boolean {
        if (!this.commands.delete(id)) return false;
        this.notify();
        return true;
    }

    setEnabled(id: number, enabled: boolean): boolean {
        return this.mutate(id, c => { c.enabled = enabled; });
    }

    setChecked(id: number, checked: boolean): boolean {
        return this.mutate(id, c => { c.checked = checked; });
    }

    setIcon(id: number, icon: string): boolean {
        return this.mutate(id, c => { c.icon = icon; });
    }

    setTooltip(id: number, tooltip: string): boolean {
        return this.mutate(id, c => { c.tooltip = tooltip; });
    }

    setPulse(id: number, pulse: AddonCommand['pulse']): boolean {
        return this.mutate(id, c => { c.pulse = pulse; });
    }

    /** Whether the command has a button to colour — the pulse needs one, and a
     *  menu-only command has none. */
    hasButton(id: number): boolean {
        const surfaces = this.commands.get(id)?.surfaces;
        return surfaces === 'toolbar' || surfaces === 'both';
    }

    private mutate(id: number, apply: (command: AddonCommand) => void): boolean {
        const command = this.commands.get(id);
        if (!command) return false;
        apply(command);
        this.notify();
        return true;
    }

    /** The commands with a button, in placement order — what the toolbar draws.
     *  A disabled command keeps its button and is drawn unavailable, which is
     *  what enableCommand/disableCommand are for; a removed one is gone. */
    buttons(): AddonCommand[] {
        return this.list().filter(c => c.surfaces === 'toolbar' || c.surfaces === 'both');
    }

    /** Profile teardown. */
    clear(): void {
        if (this.commands.size === 0) return;
        this.commands.clear();
        this.notify();
    }
}
