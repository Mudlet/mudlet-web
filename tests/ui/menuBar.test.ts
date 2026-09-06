import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MenuBar } from '../../src/ui/menu/MenuBar';
import { placeCommands, type PlacedCommand, type TopMenu } from '../../src/ui/menu/menuModel';
import { buildAppMenus, type AppMenuContext } from '../../src/ui/menu/appMenus';
import { AddonCommandRegistry } from '../../src/ui/commands/addonCommands';

// addCommand has always taken a menuPath and, until the menu bar existed, had
// nowhere to lead — a package could place a command, be told nothing was wrong,
// and find it nowhere. These cover where a path leads and what the bar does
// with a pointer and a keyboard.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BUILTIN: TopMenu[] = [
    { id: 'games', label: 'Games', items: [{ kind: 'action', id: 'disconnect', label: 'Disconnect', run: () => {} }] },
    { id: 'toolbox', label: 'Toolbox', items: [{ kind: 'action', id: 'scripts', label: 'Script editor', run: () => {} }] },
];

/** A registry holding one command per request, reduced to the `PlacedCommand`
 *  shape the toolbar hands over — so the tests exercise the real conversion
 *  rather than hand-built literals. Packages and host apps both arrive here. */
function commands(...requests: Parameters<AddonCommandRegistry['add']>[0][]) {
    const registry = new AddonCommandRegistry();
    for (const request of requests) registry.add(request);
    const place = (clicked?: string[]): PlacedCommand[] => registry.menuItems().map(c => ({
        id: `lua:${c.id}`,
        name: c.name, icon: c.icon, tooltip: c.tooltip, menuPath: c.menuPath,
        shortcut: c.shortcut, enabled: c.enabled, checked: c.checked,
        run: () => clicked?.push(`lua:${c.id}`),
    }));
    return { registry, place, list: place() };
}

describe('placeCommands', () => {
    it('joins a menu whose title the path names, however it was capitalised', () => {
        const { list } = commands({ name: 'Speech', menuPath: 'toolbox', surfaces: 'menu' });
        const menus = placeCommands(BUILTIN, list);
        const toolbox = menus.find(m => m.id === 'toolbox')!;
        expect(toolbox.items.map(i => i.kind)).toEqual(['action', 'separator', 'action']);
        expect(menus).toHaveLength(2);
    });

    it('draws one rule between the client’s entries and the packages’, not one per command', () => {
        const { list } = commands(
            { name: 'One', menuPath: 'Toolbox', surfaces: 'menu' },
            { name: 'Two', menuPath: 'Toolbox', surfaces: 'menu' },
        );
        const toolbox = placeCommands(BUILTIN, list).find(m => m.id === 'toolbox')!;
        expect(toolbox.items.filter(i => i.kind === 'separator')).toHaveLength(1);
        expect(toolbox.items.map(i => i.kind)).toEqual(['action', 'separator', 'action', 'action']);
    });

    it('opens a new menu at the end of the bar for a title nothing matches', () => {
        const { list } = commands({ name: 'Voices', menuPath: 'Speech', surfaces: 'menu' });
        const menus = placeCommands(BUILTIN, list);
        expect(menus.map(m => m.label)).toEqual(['Games', 'Toolbox', 'Speech']);
        // Nothing of the client's to separate from, so no leading rule.
        expect(menus[2].items.map(i => i.kind)).toEqual(['action']);
    });

    it('nests a deeper path, and a second command down the same path shares the submenu', () => {
        const { list } = commands(
            { name: 'Male', menuPath: 'Speech/Voices', surfaces: 'menu' },
            { name: 'Female', menuPath: 'Speech/Voices', surfaces: 'menu' },
        );
        const speech = placeCommands(BUILTIN, list)[2];
        expect(speech.items).toHaveLength(1);
        const sub = speech.items[0];
        expect(sub.kind).toBe('submenu');
        if (sub.kind !== 'submenu') throw new Error('unreachable');
        expect(sub.label).toBe('Voices');
        expect(sub.items.map(i => i.kind === 'action' && i.label)).toEqual(['Male', 'Female']);
    });

    it('puts a command that named no menu among the other package tools', () => {
        const { list } = commands({ name: 'Pathless', surfaces: 'menu' });
        const menus = placeCommands(BUILTIN, list);
        expect(menus.map(m => m.label)).toEqual(['Games', 'Toolbox']);
        expect(menus[1].items).toHaveLength(3);
    });

    it('carries the command’s own state onto its entry', () => {
        const { registry, place, list: before } = commands({ name: 'Toggle', menuPath: 'Toolbox', surfaces: 'menu' });
        const plain = placeCommands(BUILTIN, before)[1].items[2];
        // Not merely unchecked: an entry nothing has ever checked is not a
        // checkable entry, and saying otherwise makes a screen reader announce a
        // state the package never asked for.
        expect(plain.kind === 'action' && plain.checked).toBeUndefined();

        registry.setChecked(1, true);
        registry.setEnabled(1, false);
        const after = placeCommands(BUILTIN, place())[1].items[2];
        expect(after.kind === 'action' && after.checked).toBe(true);
        expect(after.kind === 'action' && after.disabled).toBe(true);
    });

    it('runs the command it was drawn for', () => {
        const clicked: string[] = [];
        const { place } = commands({ name: 'Fire', menuPath: 'Toolbox', surfaces: 'menu' });
        const entry = placeCommands(BUILTIN, place(clicked))[1].items[2];
        if (entry.kind !== 'action') throw new Error('unreachable');
        entry.run();
        expect(clicked).toEqual(['lua:1']);
    });

    // Packages and host apps place through the same function, so a menu cannot
    // come to treat one as a second-class citizen of the other.
    it('places a host app’s command beside a package’s, in placement order', () => {
        const ran: string[] = [];
        const menus = placeCommands(BUILTIN, [
            { id: 'lua:1', name: 'From a package', menuPath: 'Realm', run: () => ran.push('lua') },
            { id: 'host:sheet', name: 'From the host', menuPath: 'Realm', run: () => ran.push('host') },
        ]);
        const realm = menus.find(m => m.label === 'Realm')!;
        expect(realm.items.map(i => i.kind === 'action' && i.label))
            .toEqual(['From a package', 'From the host']);
        for (const item of realm.items) if (item.kind === 'action') item.run();
        expect(ran).toEqual(['lua', 'host']);
    });

    it('leaves the menus it was given alone', () => {
        const { list } = commands({ name: 'Speech', menuPath: 'Toolbox', surfaces: 'menu' });
        placeCommands(BUILTIN, list);
        expect(BUILTIN[1].items).toHaveLength(1);
    });
});

describe('buildAppMenus', () => {
    const context = (over: Partial<AppMenuContext> = {}): AppMenuContext => ({
        show: () => true,
        appName: 'Mudlet Web',
        connectionItems: [
            { kind: 'action', id: 'connect', label: 'Connect', run: () => {} },
            { kind: 'separator', id: 'connection-1' },
            { kind: 'action', id: 'disconnect', label: 'Disconnect', run: () => {}, disabled: false },
            { kind: 'action', id: 'reconnect', label: 'Reconnect', run: () => {} },
            { kind: 'separator', id: 'connection-2' },
            { kind: 'action', id: 'close-profile', label: 'Close profile', run: () => {} },
        ],
        replayRecording: false,
        replaySpeed: null,
        fullscreen: false,
        fullscreenAvailable: true,
        showToolbar: true,
        muteItems: [
            { kind: 'action', id: 'mute-all', label: 'Mute all media', run: () => {} },
            { kind: 'action', id: 'mute-api', label: 'Mute sounds from this client', run: () => {} },
            { kind: 'action', id: 'mute-game', label: 'Mute sounds from the game', run: () => {} },
        ],
        showTimestamps: false,
        shortcutFor: id => (id === 'scriptEditor' ? 'Alt+E' : undefined),
        onOpenScripts: () => {}, onOpenMap: () => {}, onOpenFiles: () => {}, onOpenLogs: () => {},
        onToggleReplayRecording: () => {}, onReplayStop: () => {}, onOpenSettings: () => {},
        onToggleTimestamps: () => {}, onToggleFullscreen: () => {}, onToggleToolbar: () => {},
        onOpenDocs: () => {},
        onOpenHelp: () => {}, onOpenAbout: () => {}, onReportBug: () => {},
        ...over,
    });

    it('is Mudlet’s menu bar, in Mudlet’s order', () => {
        expect(buildAppMenus(context()).map(m => m.label))
            .toEqual(['Games', 'Toolbox', 'Options', 'Window', 'Help', 'About']);
    });

    // The Games menu and the toolbar's Connect split button are one control on
    // two surfaces, so the menu draws the list it was handed rather than
    // rebuilding it — the two cannot drift into naming different actions.
    it('draws the connection list it was handed as the Games menu', () => {
        const games = buildAppMenus(context())[0];
        expect(games.items.map(i => i.kind === 'action' && i.label))
            .toEqual(['Connect', false, 'Disconnect', 'Reconnect', false, 'Close profile']);
    });

    it('drops the Games menu when a brand has left nothing in the list', () => {
        expect(buildAppMenus(context({ connectionItems: [] })).map(m => m.label))
            .not.toContain('Games');
    });

    it('carries the mute gates it was handed into the Options menu', () => {
        const options = buildAppMenus(context()).find(m => m.label === 'Options')!;
        const labels = options.items.map(i => i.kind === 'action' && i.label);
        expect(labels).toContain('Mute all media');
        // A brand that hid the Mute button loses the entries too, and the rule
        // that would have separated them goes with them.
        const muteless = buildAppMenus(context({ show: id => id !== 'mute' }))
            .find(m => m.label === 'Options')!;
        expect(muteless.items.map(i => i.kind === 'action' && i.label)).not.toContain('Mute all media');
        expect(muteless.items[muteless.items.length - 1].kind).not.toBe('separator');
    });

    it('drops a menu a brand has emptied, rather than opening a blank box', () => {
        const menus = buildAppMenus(context({ show: id => id !== 'help' && id !== 'docs' }));
        expect(menus.map(m => m.label)).not.toContain('Help');
    });

    it('never draws a rule with nothing on one side of it', () => {
        // Hiding the four Toolbox tools leaves the separator first in the list.
        const tools = new Set(['scripts', 'map', 'files', 'logs']);
        const menus = buildAppMenus(context({ show: id => !tools.has(id) }));
        for (const m of menus) {
            expect(m.items[0].kind).not.toBe('separator');
            expect(m.items[m.items.length - 1].kind).not.toBe('separator');
        }
    });

    // "Fullscreen mode" used to be a profile setting that hid the toolbar and
    // gave the player 44px back. Fullscreen now means the browser's own.
    it('offers real fullscreen, and greys it out where the browser refuses it', () => {
        const window = (over: Partial<AppMenuContext>) =>
            buildAppMenus(context(over)).find(m => m.label === 'Window')!;
        const entry = (over: Partial<AppMenuContext>) => window(over).items[0];

        expect(entry({}).kind === 'action' && entry({}).id).toBe('fullscreen');
        expect(entry({ fullscreen: true }).kind === 'action'
            && (entry({ fullscreen: true }) as { checked?: boolean }).checked).toBe(true);
        const refused = entry({ fullscreenAvailable: false }) as { disabled?: boolean };
        expect(refused.disabled).toBe(true);
    });

    it('toggles the button bar from the Window menu but never the menu bar', () => {
        // An entry that hides the menu it is in leaves no way back to itself,
        // so the menu bar's own switch is a setting and not a menu entry.
        const items = buildAppMenus(context()).find(m => m.label === 'Window')!.items;
        const labels = items.map(i => i.kind === 'action' && i.label);
        expect(labels).toContain('Button bar');
        expect(labels).not.toContain('Menu bar');

        const bar = items.find(i => i.kind === 'action' && i.label === 'Button bar')!;
        expect(bar.kind === 'action' && bar.checked).toBe(true);
        const hidden = buildAppMenus(context({ showToolbar: false }))
            .find(m => m.label === 'Window')!.items
            .find(i => i.kind === 'action' && i.label === 'Button bar')!;
        expect(hidden.kind === 'action' && hidden.checked).toBe(false);
    });

    it('offers Stop replay only while a replay is running', () => {
        const labels = (speed: number | null) => buildAppMenus(context({ replaySpeed: speed }))[1]
            .items.map(i => i.kind === 'action' && i.label);
        expect(labels(null)).not.toContain('Stop replay');
        expect(labels(2)).toContain('Stop replay');
    });
});

describe('the menu bar', () => {
    let container: HTMLElement;
    let root: Root;

    beforeEach(() => {
        document.body.replaceChildren();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
    });

    const ran: string[] = [];
    const menus = (): TopMenu[] => [
        { id: 'games', label: 'Games', items: [
            { kind: 'action', id: 'disconnect', label: 'Disconnect', run: () => ran.push('disconnect') },
            { kind: 'separator', id: 'rule' },
            { kind: 'action', id: 'close', label: 'Close profile', run: () => ran.push('close') },
        ] },
        { id: 'toolbox', label: 'Toolbox', items: [
            { kind: 'action', id: 'scripts', label: 'Script editor', run: () => ran.push('scripts') },
            { kind: 'submenu', id: 'speech', label: 'Speech', items: [
                { kind: 'action', id: 'voices', label: 'Voices', run: () => ran.push('voices') },
            ] },
        ] },
    ];

    const render = () => act(() => { root.render(createElement(MenuBar, { menus: menus() })); });
    const title = (label: string) => Array.from(document.querySelectorAll<HTMLElement>('.menu-title'))
        .find(el => el.textContent === label)!;
    const entries = () => Array.from(document.querySelectorAll<HTMLElement>('.menu-list .menu-item'));

    beforeEach(() => { ran.length = 0; render(); });

    it('opens nothing until a title is clicked', () => {
        expect(document.querySelector('.menu-list')).toBeNull();
        act(() => { title('Games').click(); });
        expect(entries().map(e => e.textContent)).toContain('Disconnect');
    });

    it('switches menus on hover once it is open, and not before', () => {
        // React synthesises onPointerEnter from a delegated pointerover, so a
        // real `pointerenter` event reaches nothing.
        const hover = (label: string) => act(() => {
            title(label).dispatchEvent(new Event('pointerover', { bubbles: true }));
        });
        hover('Toolbox');
        expect(document.querySelector('.menu-list')).toBeNull();

        act(() => { title('Games').click(); });
        hover('Toolbox');
        expect(title('Toolbox').getAttribute('aria-expanded')).toBe('true');
        expect(title('Games').getAttribute('aria-expanded')).toBe('false');
    });

    it('runs an entry and closes on the way out', () => {
        act(() => { title('Games').click(); });
        act(() => { entries().find(e => e.textContent === 'Close profile')!.click(); });
        expect(ran).toEqual(['close']);
        expect(document.querySelector('.menu-list')).toBeNull();
    });

    it('marks the separator as one rather than leaving it an anonymous div', () => {
        act(() => { title('Games').click(); });
        expect(document.querySelector('.menu-sep')!.getAttribute('role')).toBe('separator');
    });

    it('takes focus into the menu when the keyboard opened it, and gives it back on Escape', () => {
        const games = title('Games');
        act(() => {
            games.focus();
            games.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        });
        expect(document.activeElement?.textContent).toBe('Disconnect');

        act(() => {
            document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        expect(document.querySelector('.menu-list')).toBeNull();
        expect(document.activeElement).toBe(games);
    });

    it('walks the bar with the arrow keys, carrying the open menu along', () => {
        const games = title('Games');
        act(() => {
            games.focus();
            games.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        });
        act(() => {
            document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        });
        expect(title('Toolbox').getAttribute('aria-expanded')).toBe('true');
    });

    it('leaves a submenu shut until it is asked for', () => {
        act(() => { title('Games').click(); });
        expect(document.querySelector('.menu-list--flyout')).toBeNull();
        act(() => { title('Toolbox').click(); });
        const speech = entries().find(e => e.textContent?.startsWith('Speech'))!;
        expect(speech.getAttribute('aria-expanded')).toBe('false');
        act(() => { speech.click(); });
        expect(document.querySelector('.menu-list--flyout')).not.toBeNull();
    });
});
