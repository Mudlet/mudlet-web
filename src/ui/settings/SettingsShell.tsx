import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
    Accessibility,
    ChevronLeft,
    ChevronRight,
    CircleHelp,
    Globe,
    Info,
    Map as MapIcon,
    Monitor,
    Palette,
    Search,
    ShieldCheck,
    SlidersHorizontal,
    Terminal,
    Volume2,
    Wrench,
    type LucideIcon,
} from 'lucide-react';

/**
 * The sidebar-and-cards settings shell, ported from Mudlet's settings redesign
 * (`dlgProfilePreferences` on its `settings-redesign` branch): a category
 * sidebar down the left, a "Find in settings" field over a single reading
 * column of cards, subpages reached by drilling into a card, and search results
 * that gather the matching cards from every category under their own headings.
 *
 * Mudlet moves its real widgets between pages because Qt lets it. React does
 * not, so every card is mounted once, in declaration order, and hidden when it
 * is not on the page being shown — which is also what lets the search index be
 * read straight off the rendered DOM instead of being duplicated as strings.
 */

export type CategoryKey =
    | 'general'
    | 'appearance'
    | 'mainDisplay'
    | 'inputLine'
    | 'mapper'
    | 'media'
    | 'connection'
    | 'privacy'
    | 'accessibility'
    | 'advanced';

export interface CategoryDefinition {
    key: CategoryKey;
    /** Sidebar row, page title, and the heading a search result is filed under. */
    label: string;
    Icon: LucideIcon;
    /** Mudlet's one sidebar separator, above Connection: what sits below it is
     *  about the game and the machine rather than about the client. */
    separatorAbove?: boolean;
}

/** Sidebar order, icon and name — the one place a category is declared.
 *  Mirrors Mudlet's `categoryDefinitions()`, minus the categories the web
 *  client has nothing to put on (Editor, Chat and sharing, Shortcuts) and plus
 *  the one it does that Mudlet keeps on a toolbar instead (Sound and media). */
export const CATEGORIES: CategoryDefinition[] = [
    { key: 'general',       label: 'General',              Icon: SlidersHorizontal },
    { key: 'appearance',    label: 'Appearance',           Icon: Palette },
    { key: 'mainDisplay',   label: 'Main display',         Icon: Monitor },
    { key: 'inputLine',     label: 'Input line',           Icon: Terminal },
    { key: 'mapper',        label: 'Mapper',               Icon: MapIcon },
    { key: 'media',         label: 'Sound and media',      Icon: Volume2 },
    { key: 'connection',    label: 'Connection',           Icon: Globe, separatorAbove: true },
    { key: 'privacy',       label: 'Privacy and security', Icon: ShieldCheck },
    { key: 'accessibility', label: 'Accessibility',        Icon: Accessibility },
    { key: 'advanced',      label: 'Advanced',             Icon: Wrench },
];

/** A page reached by drilling into a card: the sidebar stays on the parent
 *  category and a breadcrumb with a back chevron leads out. */
export interface SubpageDefinition {
    /** Unique across the dialog; the shell's `subpage` state and a card's
     *  `subpage` field both name a subpage by this. */
    key: string;
    category: CategoryKey;
    /** What the breadcrumb calls it: "Connection › Game protocols". */
    title: string;
}

export interface CardDefinition {
    id: string;
    category: CategoryKey;
    /** Set to put the card on that subpage instead of on the category page. */
    subpage?: string;
    /** Omitted for a card that is a bare row rather than a titled group. */
    title?: string;
    /** One muted line under the title saying what the card is for. */
    description?: ReactNode;
    /** Where "Learn more" at the end of the description leads. */
    learnMore?: string;
    /** Words a player might type for a setting whose own text does not include
     *  them — folded into the card's search text, never shown. */
    keywords?: string;
    body: ReactNode;
}

interface SettingsShellProps {
    cards: CardDefinition[];
    subpages: SubpageDefinition[];
    category: CategoryKey;
    onCategory: (next: CategoryKey) => void;
    /** Which subpage is showing, or null for the category page. */
    subpage: string | null;
    onSubpage: (next: string | null) => void;
    /** The one sidebar row that is a link rather than a category — Mudlet's
     *  "Mudlet support", at the bottom under its own separator. Omit it and the
     *  row (and the offer under an empty search) goes away, which is how a
     *  branded build avoids pointing its players at someone else's wiki. */
    support?: { label: string; url: string };
    /** Opens the Help topic listing which desktop Mudlet preferences are absent
     *  here and why. Shown as a sidebar row, and offered again when a search
     *  finds nothing — the two moments a player is hunting for a setting that
     *  isn't there. Omitted like `support` by a branded build, which is not a
     *  subset of Mudlet as far as its own players are concerned. */
    differences?: { label: string; onOpen: () => void };
}

/** Query → the words every match has to contain. */
function needlesOf(query: string): string[] {
    return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesNeedles(haystack: string, needles: string[]): boolean {
    return needles.every(n => haystack.includes(n));
}

export function SettingsShell({ cards, subpages, category, onCategory, subpage, onSubpage, support, differences }: SettingsShellProps) {
    const [query, setQuery] = useState('');
    const [matches, setMatches] = useState<string[]>([]);
    // Where the search interrupted, so leaving the results by any door comes
    // back to the page the query was typed on.
    const returnToRef = useRef<{ category: CategoryKey; subpage: string | null }>({ category, subpage });
    const searchRef = useRef<HTMLInputElement>(null);
    const cardRefs = useRef(new Map<string, HTMLElement>());
    // Card id → everything it can be found by, read off the rendered DOM.
    const indexRef = useRef(new Map<string, string>());
    const highlightedRef = useRef<HTMLElement[]>([]);

    const searching = query.trim() !== '';
    const matchSet = new Set(matches);

    // The index is read from the real DOM, so it is rebuilt after every commit:
    // revealing a row (the wrap column that only appears once undo-wrap is on)
    // changes what its card can be found by. Cheap — a few dozen textContent
    // reads — and it keeps every label in exactly one place.
    useLayoutEffect(() => {
        const index = indexRef.current;
        index.clear();
        for (const card of cards) {
            const el = cardRefs.current.get(card.id);
            const text = `${card.title ?? ''} ${el?.textContent ?? ''} ${card.keywords ?? ''}`;
            index.set(card.id, text.toLowerCase().replace(/\s+/g, ' '));
        }
        const needles = needlesOf(query);
        const next = needles.length === 0
            ? []
            : cards.filter(c => matchesNeedles(index.get(c.id) ?? '', needles)).map(c => c.id);
        // Same result, same array — handing back a fresh one every commit loops.
        setMatches(prev => (prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next));
    });

    // Mark up the rows of every card the search kept: the ones the query
    // actually hit are tinted, and their neighbours are dimmed, so a card that
    // came back for one of its ten rows says which one. A card matched only by
    // its title, description or keywords has no row to single out, and is left
    // alone rather than dimmed whole.
    //
    // Only classes are touched, and only on elements React renders with a static
    // className, so a re-render cannot fight over them.
    useEffect(() => {
        for (const el of highlightedRef.current) el.classList.remove('settings-row--hit', 'settings-row--miss');
        highlightedRef.current = [];
        const needles = needlesOf(query);
        if (needles.length === 0) return;
        for (const id of matches) {
            const card = cardRefs.current.get(id);
            if (!card) continue;
            const rows = [...card.querySelectorAll<HTMLElement>(
                '.settings-row, .settings-checkbox, .settings-subpage-row',
            )];
            const hits = rows.filter(row => matchesNeedles((row.textContent ?? '').toLowerCase(), needles));
            if (hits.length === 0) continue;
            for (const row of rows) {
                if (hits.includes(row)) {
                    row.classList.add('settings-row--hit');
                } else if (hits.some(hit => row.contains(hit))) {
                    // A row wrapping a hit (the checkbox group inside its row)
                    // is neither the answer nor noise — leave it plain.
                    continue;
                } else {
                    row.classList.add('settings-row--miss');
                }
                highlightedRef.current.push(row);
            }
        }
    }, [matches, query]);

    // Ctrl/Cmd+F puts the cursor in the search field, as it does in Mudlet.
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
                e.preventDefault();
                searchRef.current?.focus();
                searchRef.current?.select();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, []);

    const startSearch = (next: string) => {
        if (!searching && next.trim() !== '') returnToRef.current = { category, subpage };
        setQuery(next);
    };

    const leaveSearch = () => {
        setQuery('');
        onCategory(returnToRef.current.category);
        onSubpage(returnToRef.current.subpage);
    };

    // Escape leaves the search rather than closing the dialog out from under a
    // half-typed query. A native listener on the field itself, not React's
    // onKeyDown: useModalFocus listens on the dialog element, which the event
    // reaches while bubbling *before* React dispatches from its root, so a
    // synthetic handler's stopPropagation() would come too late to stop it.
    const leaveSearchRef = useRef(leaveSearch);
    leaveSearchRef.current = leaveSearch;
    const searchingRef = useRef(searching);
    searchingRef.current = searching;
    useEffect(() => {
        const field = searchRef.current;
        if (!field) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || !searchingRef.current) return;
            e.stopPropagation();
            leaveSearchRef.current();
        };
        field.addEventListener('keydown', onKeyDown);
        return () => field.removeEventListener('keydown', onKeyDown);
    }, []);

    const visibleCategories = CATEGORIES.filter(c => cards.some(card => card.category === c.key));
    const activeCategory = visibleCategories.find(c => c.key === category) ?? visibleCategories[0];
    const subpageDef = subpage ? subpages.find(s => s.key === subpage) ?? null : null;

    const isVisible = (card: CardDefinition) =>
        searching
            ? matchSet.has(card.id)
            : card.category === activeCategory?.key && (card.subpage ?? null) === subpage;

    // A search result is filed under its category, or under "Category › Subpage"
    // when the card lives one level down.
    const groupHeadingOf = (card: CardDefinition) => {
        const cat = CATEGORIES.find(c => c.key === card.category);
        const sub = card.subpage ? subpages.find(s => s.key === card.subpage) ?? null : null;
        return {
            key: card.subpage ?? card.category,
            Icon: cat?.Icon ?? Wrench,
            text: sub ? `${cat?.label ?? card.category} › ${sub.title}` : cat?.label ?? card.category,
        };
    };

    let lastGroup: string | null = null;

    const title = searching
        ? 'Search results'
        : subpageDef
            ? `${activeCategory?.label ?? ''} › ${subpageDef.title}`
            : activeCategory?.label ?? '';

    return (
        <div className="settings-shell">
            <nav className="settings-sidebar" aria-label="Settings categories">
                <ul className="settings-sidebar__list" role="tablist" aria-orientation="vertical">
                    {visibleCategories.map(cat => (
                        <Fragment key={cat.key}>
                            {cat.separatorAbove && <li className="settings-sidebar__separator" aria-hidden="true" />}
                            <li>
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={!searching && cat.key === activeCategory?.key}
                                    title={cat.label}
                                    className={`settings-sidebar__item${!searching && cat.key === activeCategory?.key ? ' settings-sidebar__item--active' : ''}`}
                                    onClick={() => { setQuery(''); onSubpage(null); onCategory(cat.key); }}
                                >
                                    <cat.Icon size={16} className="settings-sidebar__icon" aria-hidden="true" />
                                    <span className="settings-sidebar__label">{cat.label}</span>
                                </button>
                            </li>
                        </Fragment>
                    ))}
                    {(differences || support) && <li className="settings-sidebar__separator" aria-hidden="true" />}
                    {differences && (
                        <li>
                            {/* Not a category either: it opens the manual over
                                the dialog rather than a page inside it. */}
                            <button
                                type="button"
                                className="settings-sidebar__item settings-sidebar__item--link"
                                onClick={differences.onOpen}
                                title={differences.label}
                            >
                                <Info size={16} className="settings-sidebar__icon" aria-hidden="true" />
                                <span className="settings-sidebar__label">{differences.label}</span>
                            </button>
                        </li>
                    )}
                    {support && (
                        <li>
                            {/* A link, not a category: it opens a browser tab
                                rather than a page, so it is never selected. */}
                            <a
                                className="settings-sidebar__item settings-sidebar__item--link"
                                href={support.url}
                                target="_blank"
                                rel="noreferrer noopener"
                                title={support.label}
                            >
                                <CircleHelp size={16} className="settings-sidebar__icon" aria-hidden="true" />
                                <span className="settings-sidebar__label">{support.label}</span>
                            </a>
                        </li>
                    )}
                </ul>
            </nav>
            <div className="settings-content">
                <div className="settings-search">
                    <Search size={15} className="settings-search__icon" aria-hidden="true" />
                    <input
                        ref={searchRef}
                        type="search"
                        className="settings-search__field"
                        placeholder="Find in settings"
                        aria-label="Find in settings"
                        value={query}
                        onChange={e => startSearch(e.target.value)}
                    />
                </div>
                <div className="settings-titlerow">
                    {searching && (
                        <button
                            type="button"
                            className="settings-back"
                            onClick={leaveSearch}
                            title="Back to the settings you were on"
                        >
                            <ChevronLeft size={16} aria-hidden="true" />
                            <span>Back</span>
                        </button>
                    )}
                    {!searching && subpageDef && (
                        <button
                            type="button"
                            className="settings-back"
                            onClick={() => onSubpage(null)}
                            title="Back to the category this page belongs to"
                            aria-label="Back to the category this page belongs to"
                        >
                            <ChevronLeft size={16} aria-hidden="true" />
                        </button>
                    )}
                    {!searching && activeCategory && (
                        <activeCategory.Icon size={17} className="settings-titlerow__icon" aria-hidden="true" />
                    )}
                    <h2 className="settings-titlerow__title">{title}</h2>
                </div>
                <div className="settings-pages mudix-native-scrollbar">
                    {cards.map(card => {
                        const visible = isVisible(card);
                        let header: ReactNode = null;
                        if (searching && visible) {
                            const group = groupHeadingOf(card);
                            if (group.key !== lastGroup) {
                                lastGroup = group.key;
                                header = (
                                    <h3 className="settings-group-header">
                                        <group.Icon size={14} aria-hidden="true" />
                                        <span>{group.text}</span>
                                    </h3>
                                );
                            }
                        }
                        return (
                            <Fragment key={card.id}>
                                {header}
                                <section
                                    ref={el => { if (el) cardRefs.current.set(card.id, el); else cardRefs.current.delete(card.id); }}
                                    hidden={!visible}
                                    className={`settings-card${card.title ? '' : ' settings-card--plain'}`}
                                    aria-label={card.title}
                                >
                                    {card.title && <h3 className="settings-card__title">{card.title}</h3>}
                                    {card.description && (
                                        <p className="settings-card__description">
                                            {card.description}
                                            {card.learnMore && (
                                                <>
                                                    {' '}
                                                    <a href={card.learnMore} target="_blank" rel="noreferrer noopener">Learn more</a>
                                                </>
                                            )}
                                        </p>
                                    )}
                                    <div className="settings-card__body">{card.body}</div>
                                </section>
                            </Fragment>
                        );
                    })}
                    {searching && matches.length === 0 && (
                        <p className="settings-search__empty">
                            No results in settings for "{query.trim()}"
                            {differences && (
                                <>
                                    <br />
                                    Some of desktop Mudlet's preferences aren't here —{' '}
                                    <button type="button" className="settings-search__empty-link" onClick={differences.onOpen}>
                                        see what's different
                                    </button>
                                </>
                            )}
                            {support && (
                                <>
                                    <br />
                                    Need help? Visit{' '}
                                    <a href={support.url} target="_blank" rel="noreferrer noopener">{support.label}</a>
                                </>
                            )}
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}

interface SubpageRowProps {
    label: string;
    /** What the row reports about the page behind it — Mudlet's "9 of 10 turned on". */
    summary: string;
    onOpen: () => void;
}

/** The chevron row a card carries when its settings live on a subpage. */
export function SubpageRow({ label, summary, onOpen }: SubpageRowProps) {
    return (
        <button type="button" className="settings-subpage-row" onClick={onOpen}>
            <span className="settings-subpage-row__label">{label}</span>
            <span className="settings-subpage-row__summary">{summary}</span>
            <ChevronRight size={16} aria-hidden="true" />
        </button>
    );
}
