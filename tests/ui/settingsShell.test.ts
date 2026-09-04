import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SettingsShell, type CardDefinition, type CategoryKey, type SubpageDefinition } from '../../src/ui/settings/SettingsShell';

// The shell mounts every card once and hides the ones that are not on the page
// being shown, because that is what lets the search index be read off the real
// DOM instead of duplicating every label as a string. Two things therefore have
// to hold: [hidden] must actually hide (an author `display` beats the UA sheet's
// rule, so the stylesheet has to say so — here we assert the attribute, which is
// what the stylesheet keys off), and a query has to reach the text of cards that
// are not currently on screen.
//
// (JSX is avoided so the file stays a plain .test.ts, matching the include glob.)

const SUBPAGES: SubpageDefinition[] = [
    { key: 'protocols', category: 'connection', title: 'Game protocols' },
];

const CARDS: CardDefinition[] = [
    {
        id: 'notifications',
        category: 'general',
        title: 'Notifications',
        body: createElement('div', { className: 'settings-row' }, 'Desktop notifications'),
    },
    {
        id: 'wrapping',
        category: 'mainDisplay',
        title: 'Word wrapping',
        // The synonyms a player might type: never rendered, always searchable.
        keywords: 'columns, line length',
        body: createElement(
            'div',
            null,
            createElement('div', { className: 'settings-row', key: 'a' }, 'Wrap lines at'),
            createElement('div', { className: 'settings-row', key: 'b' }, "Undo the game's own wrapping"),
        ),
    },
    {
        id: 'protocolList',
        category: 'connection',
        subpage: 'protocols',
        title: 'Protocols to offer the game',
        body: createElement('div', { className: 'settings-row' }, 'GMCP'),
    },
];

/** The shell is controlled; this holds the category/subpage state for it, and
 *  stands in for the chevron row a real card carries. */
function Harness() {
    const [category, setCategory] = useState<CategoryKey>('general');
    const [subpage, setSubpage] = useState<string | null>(null);
    return createElement(
        'div',
        null,
        createElement('button', {
            className: 'open-protocols',
            onClick: () => { setCategory('connection'); setSubpage('protocols'); },
        }, 'open'),
        createElement(SettingsShell, {
            cards: CARDS,
            subpages: SUBPAGES,
            category,
            onCategory: setCategory,
            subpage,
            onSubpage: setSubpage,
        }),
    );
}

let host: HTMLDivElement;
let root: Root;

const cardEl = (id: string): HTMLElement => {
    const titles: Record<string, string> = {
        notifications: 'Notifications',
        wrapping: 'Word wrapping',
        protocolList: 'Protocols to offer the game',
    };
    const el = host.querySelector<HTMLElement>(`.settings-card[aria-label="${titles[id]}"]`);
    if (!el) throw new Error(`no card for ${id}`);
    return el;
};

const shownCards = (): string[] =>
    [...host.querySelectorAll<HTMLElement>('.settings-card')]
        .filter(el => !el.hidden)
        .map(el => el.getAttribute('aria-label') ?? '');

const searchField = () => host.querySelector<HTMLInputElement>('.settings-search__field')!;

/** Type into the search field the way React sees a real keystroke. */
const search = (query: string) => {
    const field = searchField();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
        setValue.call(field, query);
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });
};

const clickCategory = (label: string) => {
    const item = [...host.querySelectorAll<HTMLElement>('.settings-sidebar__item')]
        .find(el => el.textContent === label);
    if (!item) throw new Error(`no sidebar row "${label}"`);
    act(() => { item.click(); });
};

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root.render(createElement(Harness)); });
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe('SettingsShell pages', () => {
    it('mounts every card but shows only the active category', () => {
        expect(host.querySelectorAll('.settings-card')).toHaveLength(CARDS.length);
        expect(shownCards()).toEqual(['Notifications']);
        expect(cardEl('wrapping').hidden).toBe(true);
    });

    it('follows the sidebar', () => {
        clickCategory('Main display');
        expect(shownCards()).toEqual(['Word wrapping']);
        expect(host.querySelector('.settings-titlerow__title')?.textContent).toBe('Main display');
    });

    it('keeps a subpage card off its own category page until it is opened', () => {
        clickCategory('Connection');
        // Nothing on the Connection category page in this fixture — the one card
        // there lives on the subpage.
        expect(shownCards()).toEqual([]);
        expect(host.querySelector('.settings-back')).toBeNull();

        act(() => { host.querySelector<HTMLElement>('.open-protocols')!.click(); });
        expect(shownCards()).toEqual(['Protocols to offer the game']);
        expect(host.querySelector('.settings-titlerow__title')?.textContent)
            .toBe('Connection › Game protocols');

        // The chevron beside the breadcrumb leads back up to the category.
        act(() => { host.querySelector<HTMLElement>('.settings-back')!.click(); });
        expect(host.querySelector('.settings-titlerow__title')?.textContent).toBe('Connection');
        expect(shownCards()).toEqual([]);
    });

    it('drops back to the category page when the sidebar moves', () => {
        act(() => { host.querySelector<HTMLElement>('.open-protocols')!.click(); });
        clickCategory('General');
        expect(shownCards()).toEqual(['Notifications']);
    });

    it('only lists the categories that have cards', () => {
        const labels = [...host.querySelectorAll('.settings-sidebar__item')].map(el => el.textContent);
        expect(labels).toEqual(['General', 'Main display', 'Connection']);
    });
});

describe('SettingsShell search', () => {
    it('finds a card on a page that is not showing, and files it under its category', () => {
        expect(shownCards()).toEqual(['Notifications']);
        search('wrap');
        expect(shownCards()).toEqual(['Word wrapping']);
        const headers = [...host.querySelectorAll('.settings-group-header')].map(el => el.textContent);
        expect(headers).toEqual(['Main display']);
        expect(host.querySelector('.settings-titlerow__title')?.textContent).toBe('Search results');
    });

    it('matches a card by a keyword that is nowhere in its text', () => {
        expect(cardEl('wrapping').textContent).not.toContain('columns');
        search('columns');
        expect(shownCards()).toEqual(['Word wrapping']);
    });

    it('names a subpage card by the page it lives on', () => {
        search('GMCP');
        expect(shownCards()).toEqual(['Protocols to offer the game']);
        const headers = [...host.querySelectorAll('.settings-group-header')].map(el => el.textContent);
        expect(headers).toEqual(['Connection › Game protocols']);
    });

    it('says nothing was found, without offering help there is no link for', () => {
        search('nothing matches this');
        const empty = host.querySelector('.settings-search__empty');
        expect(empty?.textContent).toContain('No results in settings for "nothing matches this"');
        expect(empty?.querySelector('a')).toBeNull();
    });

    it('needs every word of the query', () => {
        search('word wrap');
        expect(shownCards()).toEqual(['Word wrapping']);
        search('word gmcp');
        expect(shownCards()).toEqual([]);
        expect(host.querySelector('.settings-search__empty')).not.toBeNull();
    });

    const rowClasses = () =>
        [...cardEl('wrapping').querySelectorAll<HTMLElement>('.settings-row')]
            .map(el => (el.classList.contains('settings-row--hit') ? 'hit'
                : el.classList.contains('settings-row--miss') ? 'miss'
                : 'plain'));

    it('tints the rows that matched, and only while the query stands', () => {
        search('wrap');
        expect(host.querySelectorAll('.settings-row--hit')).toHaveLength(2);
        search('');
        expect(host.querySelectorAll('.settings-row--hit')).toHaveLength(0);
    });

    it('dims the rows of a matched card that the query did not hit', () => {
        search('undo');
        expect(rowClasses()).toEqual(['miss', 'hit']);
    });

    it('dims nothing on a card matched by its keywords, where no row is the answer', () => {
        search('columns');
        expect(shownCards()).toEqual(['Word wrapping']);
        expect(rowClasses()).toEqual(['plain', 'plain']);
    });

    it('clears the dimming with the query', () => {
        search('undo');
        expect(host.querySelectorAll('.settings-row--miss')).toHaveLength(1);
        search('');
        expect(host.querySelectorAll('.settings-row--miss')).toHaveLength(0);
    });

    it('comes back to the page the query was typed on', () => {
        clickCategory('Main display');
        search('gmcp');
        expect(shownCards()).toEqual(['Protocols to offer the game']);
        act(() => { host.querySelector<HTMLElement>('.settings-back')!.click(); });
        expect(host.querySelector('.settings-titlerow__title')?.textContent).toBe('Main display');
        expect(searchField().value).toBe('');
    });

    it('takes Escape for itself so the dialog around it stays open', () => {
        // useModalFocus listens on the dialog element, which the keydown reaches
        // while bubbling before React dispatches from its root — so the shell
        // has to stop the event on the field itself.
        let reachedAncestor = false;
        host.addEventListener('keydown', () => { reachedAncestor = true; });

        search('wrap');
        act(() => {
            searchField().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        expect(reachedAncestor).toBe(false);
        expect(searchField().value).toBe('');
        expect(shownCards()).toEqual(['Notifications']);

        // With no query the dialog's own Escape handling gets it back.
        act(() => {
            searchField().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        expect(reachedAncestor).toBe(true);
    });
});

// The one sidebar row that is a link rather than a category. A branded build
// passes no `support`, and then neither the row nor the offer under an empty
// search exists — it has no business pointing its players at Mudlet's wiki.
describe('SettingsShell support link', () => {
    const SUPPORT = { label: 'Mudlet support', url: 'https://wiki.mudlet.org' };

    function SupportHarness() {
        const [category, setCategory] = useState<CategoryKey>('general');
        const [subpage, setSubpage] = useState<string | null>(null);
        return createElement(SettingsShell, {
            cards: CARDS,
            subpages: SUBPAGES,
            category,
            onCategory: setCategory,
            subpage,
            onSubpage: setSubpage,
            support: SUPPORT,
        });
    }

    beforeEach(() => {
        act(() => { root.render(createElement(SupportHarness)); });
    });

    it('sits at the bottom of the sidebar as a link out', () => {
        const rows = [...host.querySelectorAll<HTMLElement>('.settings-sidebar__item')];
        const last = rows[rows.length - 1];
        expect(last.textContent).toBe('Mudlet support');
        expect(last.tagName).toBe('A');
        expect(last.getAttribute('href')).toBe(SUPPORT.url);
        // A link, never a selected page.
        expect(last.getAttribute('aria-selected')).toBeNull();
    });

    it('is offered when a search finds nothing', () => {
        const field = host.querySelector<HTMLInputElement>('.settings-search__field')!;
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        act(() => {
            setValue.call(field, 'zzzz');
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const link = host.querySelector<HTMLAnchorElement>('.settings-search__empty a');
        expect(link?.textContent).toBe('Mudlet support');
        expect(link?.href).toContain('wiki.mudlet.org');
    });
});
