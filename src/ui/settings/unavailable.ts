import type { CategoryKey } from './SettingsShell';

/**
 * Desktop Mudlet preferences that cannot exist in a browser, listed in Settings
 * so a player following the desktop manual finds an answer where they went
 * looking rather than nothing at all (issue #64).
 *
 * Two rules keep this list honest and short:
 *
 * - **Only genuine impossibility.** A setting we simply haven't built yet does
 *   not belong here — it belongs in the backlog. The reason line has to name
 *   the thing the browser withholds, not our schedule. Settings blocked on the
 *   map renderer library are missing, not impossible, and are tracked in
 *   `docs/settings-divergence.md` instead.
 * - **The desktop wording.** `name` is the label Mudlet uses, so a search for
 *   the words a player already knows lands here. The shell reads its search
 *   index off the rendered DOM, so these rows are findable for free.
 *
 * Filed under the category the setting would have lived in, so browsing a
 * category shows its absences and a search result files itself correctly.
 */
export interface UnavailableSetting {
    category: CategoryKey;
    /** Desktop Mudlet's own label for the setting. */
    name: string;
    /** Why a browser cannot have it. One sentence, no apology. */
    reason: string;
}

export const UNAVAILABLE_SETTINGS: UnavailableSetting[] = [
    {
        category: 'general',
        name: 'Auto save on exit',
        reason: 'There is no exit to save on — this profile is written as you change it.',
    },
    {
        category: 'general',
        name: 'Save log files in a folder',
        reason: 'Logs are kept in browser storage and exported from the Logs browser. A page cannot write to a folder on your disk without asking each time, so a continuously-written log file is not possible.',
    },
    {
        category: 'general',
        name: 'Handling telnet:// links',
        reason: 'A page may only claim protocols on a fixed list the browser ships, and telnet is not on it.',
    },
    {
        category: 'appearance',
        name: 'Icon sizes, show menu bar, show main toolbar',
        reason: 'There is no menu bar and no icon set to size — the browser\'s own chrome is the window frame. Fullscreen mode above hides Mudlet Web\'s toolbar.',
    },
    {
        category: 'mainDisplay',
        name: 'Enable anti-aliasing',
        reason: 'Browsers do not expose font smoothing to a page.',
    },
    {
        category: 'inputLine',
        name: 'Command line minimum height in pixels',
        reason: 'The command line grows to fit what you type instead of being sized.',
    },
    {
        category: 'inputLine',
        name: 'User dictionary (profile / shared)',
        reason: 'Spell checking uses the browser\'s own dictionary, which belongs to your operating system rather than to this profile.',
    },
    {
        category: 'mapper',
        name: 'Use high quality graphics in 2D view',
        reason: 'The map is always drawn antialiased; there is no lower-quality mode to switch away from.',
    },
    {
        category: 'connection',
        name: 'Connect to the game via proxy',
        reason: 'Routing a connection through a SOCKS or HTTP proxy is your browser\'s or your system\'s job, not a page\'s. Mudlet Web\'s own proxy is a different thing — the telnet-to-WebSocket bridge set per game in its connection form.',
    },
    {
        category: 'advanced',
        name: 'Discord Rich Presence',
        reason: 'Rich Presence needs a socket to the Discord app on your machine. Scripts that call it still run; those calls do nothing.',
    },
    {
        category: 'advanced',
        name: 'MudMaster chat (MMCP)',
        reason: 'MMCP listens on a port and dials other clients directly over TCP. A page can open neither a listening socket nor a raw outbound one.',
    },
    {
        category: 'advanced',
        name: 'Disable automatic updates',
        reason: 'There is no installer — Mudlet Web is whatever the server last served, and reloading the page is the update.',
    },
    {
        category: 'advanced',
        name: 'Show icons on menus',
        reason: 'There are no menus to put icons on.',
    },
    {
        category: 'advanced',
        name: 'Crash report sending policy',
        reason: 'There is no crash reporter to gate. Your browser reports its own crashes under its own settings.',
    },
];

/** The settings filed under one category, in declaration order. */
export function unavailableIn(category: CategoryKey): UnavailableSetting[] {
    return UNAVAILABLE_SETTINGS.filter(s => s.category === category);
}

/** Every category that has at least one — the cards to render. */
export function categoriesWithUnavailable(): CategoryKey[] {
    return [...new Set(UNAVAILABLE_SETTINGS.map(s => s.category))];
}
