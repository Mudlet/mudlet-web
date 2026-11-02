import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConnectionScreen } from '../../src/ui/ConnectionScreen';
import { ConfirmProvider } from '../../src/ui/components';
import { setBrand } from '../../src/branding';
import { useAppStore, type MudConnection } from '../../src/storage';
import { useRecordLastPlayed } from '../../src/hooks/useRecordLastPlayed';
import { EventBus } from '../../src/core/EventBus';
import { shuffle } from '../../src/ui/launcher/GameSection';
import { PLAYABLE_GAMES } from '../../src/mud/games/gameLinks';
import type { MudSession } from '../../src/mud/MudSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const conn = (id: string, extra: Partial<MudConnection> = {}): MudConnection =>
    ({ id, name: id, mode: 'mud', host: `${id.toLowerCase()}.example.org`, port: 23, ...extra });

async function renderScreen(connections: MudConnection[], overrides: Record<string, unknown> = {}) {
    const props = {
        connections,
        connecting: false,
        connectingId: null,
        onConnect: vi.fn(),
        onOpen: vi.fn(),
        onAdd: vi.fn(() => 'new-id'),
        onUpdate: vi.fn(),
        onDelete: vi.fn(),
        onOpenSettings: vi.fn(),
        ...overrides,
    };
    await act(async () => {
        root.render(createElement(ConfirmProvider, null, createElement(ConnectionScreen, props as never)));
    });
    return props;
}

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector(sel) as T | null;
const byLabel = (label: string) => q<HTMLButtonElement>(`[aria-label="${label}"]`);
/** The preview shows a random handful; Browse all lists every game. */
async function openGame(name: string) {
    const browse = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.startsWith('Browse all'));
    if (browse) await act(async () => { browse.click(); });
    await act(async () => { byLabel(`About ${name}`)!.click(); });
}
const press = (el: Element, key: string) =>
    act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    document.body.innerHTML = '';
    setBrand();
});

describe('launcher banner', () => {
    it('features the most recently played profile', async () => {
        await renderScreen([
            conn('Old', { lastConnectedAt: 1_000 }),
            conn('Recent', { lastConnectedAt: Date.now() - 60_000 }),
            conn('Never'),
        ]);
        const hero = q('.launcher-hero')!;
        expect(hero.getAttribute('aria-label')).toBe('Continue playing Recent');
        // The banner's profile isn't repeated in the grid below it.
        const tiles = [...container.querySelectorAll('.launcher-tile--profile .launcher-tile__name')].map(e => e.textContent);
        expect(tiles).toEqual(['Old', 'Never']);
    });

    it('connects and opens offline from the banner', async () => {
        const props = await renderScreen([conn('Achaea')]);
        await act(async () => { byLabel('Connect to Achaea')!.click(); });
        expect(props.onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: 'Achaea' }));
        await act(async () => { byLabel('Open Achaea offline')!.click(); });
        expect(props.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'Achaea' }));
    });

    it('greets a first visit with no banner and a way to add a profile', async () => {
        await renderScreen([]);
        expect(q('.launcher-hero')).toBeNull();
        expect(q('.launcher-welcome')?.textContent).toContain('Welcome to');
        // e2e specs find "add a profile" by this class fragment.
        expect(q('[class*="tile__add"]')).not.toBeNull();
    });
});

describe('game catalogue', () => {
    it('previews whole rows of games, and Browse all lists every one alphabetically', async () => {
        await renderScreen([]);
        const names = () => [...container.querySelectorAll('.launcher-tile--game .launcher-tile__name')].map(e => e.textContent);
        expect(names().length % 4).toBe(0);
        const browse = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.startsWith('Browse all'))!;
        await act(async () => { browse.click(); });
        expect(names()).toEqual(PLAYABLE_GAMES.map(g => g.name));
    });

    it('shuffle reorders without losing or duplicating anything', () => {
        const items = Array.from({ length: 20 }, (_, i) => i);
        let seed = 1;
        const out = shuffle(items, () => ((seed = (seed * 16807) % 2147483647) / 2147483647));
        expect(out).not.toEqual(items);
        expect([...out].sort((a, b) => a - b)).toEqual(items);
        expect(items[0]).toBe(0); // input untouched
    });

    it('opens a game\'s details from its tile and closes them on Escape', async () => {
        await renderScreen([]);
        await openGame('Aardwolf');
        const dialog = document.querySelector('[role="dialog"]')!;
        expect(dialog.textContent).toContain('Aardwolf');
        await press(dialog, 'Escape');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('Play opens the Add form prefilled with the game', async () => {
        await renderScreen([]);
        await openGame('Aardwolf');
        const play = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
            .find(b => b.textContent?.includes('Play Aardwolf'))!;
        await act(async () => { play.click(); });
        expect(document.querySelector<HTMLInputElement>('#cs-host')?.value).toBe('aardmud.org');
    });

    it('is left out of a branded build, search included', async () => {
        setBrand({ mud: { mode: 'mud', host: 'one.example.org', port: 23 } });
        await renderScreen([conn('Mine')]);
        expect(container.textContent).not.toContain('Find a new game');
        const input = q<HTMLInputElement>('.launcher-search__input')!;
        await act(async () => {
            input.focus();
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            set.call(input, 'aard');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
    });
});

describe('"Where to?" search', () => {
    async function type(text: string) {
        const input = q<HTMLInputElement>('.launcher-search__input')!;
        await act(async () => {
            input.focus();
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            set.call(input, text);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        return input;
    }

    it('connects the highlighted profile on Enter', async () => {
        const props = await renderScreen([conn('Achaea main', { host: 'achaea.com' })]);
        const input = await type('achaea');
        const options = container.querySelectorAll('[role="option"]');
        expect(options[0].textContent).toContain('Achaea main');
        expect(options[0].getAttribute('aria-selected')).toBe('true');
        await press(input, 'Enter');
        expect(props.onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: 'Achaea main' }));
    });

    it('moves through results with the arrow keys and opens a game', async () => {
        await renderScreen([conn('Achaea main', { host: 'achaea.com' })]);
        const input = await type('achaea');
        await press(input, 'ArrowDown');
        const active = container.querySelector('[role="option"][aria-selected="true"]')!;
        expect(input.getAttribute('aria-activedescendant')).toBe(active.id);
        expect(active.textContent).toContain('Details');
        await press(input, 'Enter');
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Achaea');
    });

    it('turns a typed address into a prefilled new profile', async () => {
        await renderScreen([]);
        const input = await type('mud.example.org:4000');
        await press(input, 'Enter');
        expect(document.querySelector<HTMLInputElement>('#cs-host')?.value).toBe('mud.example.org');
        expect(document.querySelector<HTMLInputElement>('#cs-port')?.value).toBe('4000');
    });

    it('Escape clears the box', async () => {
        await renderScreen([conn('Achaea')]);
        const input = await type('ach');
        await press(input, 'Escape');
        expect(input.value).toBe('');
        expect(container.querySelector('[role="listbox"]')).toBeNull();
    });

    it('"/" focuses the box from elsewhere on the screen', async () => {
        await renderScreen([conn('Achaea')]);
        (document.activeElement as HTMLElement | null)?.blur();
        await press(document.body, '/');
        expect(document.activeElement).toBe(q('.launcher-search__input'));
    });
});

describe('last played', () => {
    function Harness({ session, id }: { session: MudSession; id: string }) {
        useRecordLastPlayed(session, id);
        return null;
    }

    it('is stamped when the game connection is established, not when the socket opens', async () => {
        const id = useAppStore.getState().addConnection({ name: 'Stamp test', mode: 'mud', host: 'stamp.example.org', port: 23 });
        const events = new EventBus();
        const session = { events } as unknown as MudSession;
        await act(async () => { root.render(createElement(Harness, { session, id })); });
        const stamp = () => useAppStore.getState().connections.find(c => c.id === id)?.lastConnectedAt;

        (events as unknown as { emit: (e: string) => void }).emit('client.connect');
        expect(stamp()).toBeUndefined();
        (events as unknown as { emit: (e: string) => void }).emit('client.established');
        expect(stamp()).toBeTypeOf('number');
        useAppStore.getState().removeConnection(id);
    });

    it('survives an edit through the connection form', () => {
        const store = useAppStore.getState();
        const id = store.addConnection({ name: 'Edit test', mode: 'mud', host: 'edit.example.org', port: 23 });
        store.patchConnection(id, { lastConnectedAt: 12345 });
        // The form never renders the field, so it doesn't send it back.
        store.updateConnection(id, { name: 'Edit test 2', mode: 'mud', host: 'edit.example.org', port: 23 });
        expect(useAppStore.getState().connections.find(c => c.id === id)?.lastConnectedAt).toBe(12345);
        useAppStore.getState().removeConnection(id);
    });
});

describe('profile order', () => {
    it('keeps the grid in the player\'s order while the banner shows the last played', async () => {
        await renderScreen([conn('C'), conn('A', { lastConnectedAt: 5 }), conn('B')]);
        expect(q('.launcher-hero')!.getAttribute('aria-label')).toBe('Continue playing A');
        const names = [...container.querySelectorAll('.launcher-tile--profile .launcher-tile__name')].map(e => e.textContent);
        expect(names).toEqual(['C', 'B']);
    });

    it('"Move earlier" in the ⋯ menu reorders, leaving the banner\'s profile in its slot', async () => {
        const list = [conn('C'), conn('A', { lastConnectedAt: 5 }), conn('B')];
        useAppStore.setState({ connections: list });
        await renderScreen(list);
        await act(async () => { byLabel('More actions for B')!.click(); });
        const item = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu__item')].find(b => b.textContent === 'Move earlier')!;
        await act(async () => { item.click(); });
        expect(useAppStore.getState().connections.map(c => c.id)).toEqual(['B', 'A', 'C']);
        useAppStore.setState({ connections: [] });
    });
});
