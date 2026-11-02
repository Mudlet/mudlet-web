import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Server } from 'lucide-react';
import type { BundledGame } from '../../mud/games/bundledGames';
import { gameIconUrl } from '../../mud/games/gameIcons';
import { connectionDisplayAddr, type MudConnection } from '../../storage';
import { ProfileArt, profileIconUrl } from './ProfileArt';
import { searchLauncher, type TypedAddress } from './launcherModel';

type Option =
    | { kind: 'profile'; id: string; connection: MudConnection }
    | { kind: 'game'; id: string; game: BundledGame }
    | { kind: 'address'; id: string; address: TypedAddress };

interface Props {
    connections: MudConnection[];
    /** Catalogue to search — empty in a branded build, which has none. */
    games: readonly BundledGame[];
    disabled?: boolean;
    onConnect: (c: MudConnection) => void;
    onSelectGame: (g: BundledGame) => void;
    onAddress: (a: TypedAddress) => void;
}

/** Whether a "/" keypress should be taken as "focus the search box" — not
 *  while typing into some other field. */
function isTypingTarget(el: Element | null): boolean {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

/**
 * "Where to?" — one box that finds a profile, a catalogue game, or takes a
 * server address as typed. An ARIA combobox: arrows move through the options,
 * Enter takes one, Escape clears. "/" focuses it from anywhere on the screen.
 */
export function LauncherSearch({ connections, games, disabled, onConnect, onSelectGame, onAddress }: Props) {
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const [open, setOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const results = useMemo(() => searchLauncher(query, connections, games), [query, connections, games]);
    const options = useMemo<Option[]>(() => [
        ...results.profiles.map(c => ({ kind: 'profile' as const, id: `p-${c.id}`, connection: c })),
        ...results.games.map(g => ({ kind: 'game' as const, id: `g-${g.name}`, game: g })),
        ...(results.address ? [{ kind: 'address' as const, id: 'addr', address: results.address }] : []),
    ], [results]);

    useEffect(() => { setActive(0); }, [query]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
            if (isTypingTarget(document.activeElement)) return;
            // A dialog over the launcher owns the keyboard.
            if (document.querySelector('[aria-modal="true"]')) return;
            e.preventDefault();
            inputRef.current?.focus();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, []);

    const choose = (o: Option) => {
        setQuery('');
        setOpen(false);
        if (o.kind === 'profile') onConnect(o.connection);
        else if (o.kind === 'game') onSelectGame(o.game);
        else onAddress(o.address);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Escape') {
            if (query || open) { e.preventDefault(); setQuery(''); setOpen(false); }
            return;
        }
        if (options.length === 0) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(i => (i + 1) % options.length); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); setActive(i => (i - 1 + options.length) % options.length); }
        else if (e.key === 'Enter') { e.preventDefault(); const o = options[active]; if (o) choose(o); }
    };

    const showList = open && query.trim() !== '';
    const listId = 'launcher-search-list';
    let lastKind: Option['kind'] | null = null;
    const groupLabel: Record<Option['kind'], string> = { profile: 'Your profiles', game: 'Games', address: 'Server' };

    return (
        <div className="launcher-search">
            <Search size={18} className="launcher-search__icon" aria-hidden="true" />
            <input
                ref={inputRef}
                type="text"
                className="launcher-search__input"
                placeholder="Where to? Search profiles, games, or type host:port"
                role="combobox"
                aria-label="Search profiles and games, or type a server address"
                aria-expanded={showList}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={showList && options[active] ? `launcher-opt-${options[active].id}` : undefined}
                value={query}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                onChange={e => { setQuery(e.target.value); setOpen(true); }}
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
                onKeyDown={onKeyDown}
            />
            {!query && <kbd className="launcher-search__kbd" aria-hidden="true">/</kbd>}
            {showList && (
                <ul className="launcher-search__list" id={listId} role="listbox" aria-label="Search results">
                    {options.length === 0 && <li className="launcher-search__none" role="presentation">Nothing matches “{query.trim()}”.</li>}
                    {options.map((o, i) => {
                        const header = o.kind !== lastKind ? groupLabel[o.kind] : null;
                        lastKind = o.kind;
                        return (
                            <li key={o.id} role="presentation">
                                {header && <div className="launcher-search__group" aria-hidden="true">{header}</div>}
                                <div
                                    id={`launcher-opt-${o.id}`}
                                    role="option"
                                    aria-selected={i === active}
                                    className={`launcher-search__option${i === active ? ' is-active' : ''}`}
                                    // mousedown, not click: the input's blur would close the list first.
                                    onMouseDown={e => { e.preventDefault(); choose(o); }}
                                    onMouseEnter={() => setActive(i)}
                                >
                                    <OptionBody option={o} />
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

function OptionBody({ option: o }: { option: Option }) {
    if (o.kind === 'profile') {
        const icon = profileIconUrl(o.connection);
        return (
            <>
                <SearchThumb icon={icon} name={o.connection.name} />
                <span className="launcher-search__label">{o.connection.name}</span>
                <span className="launcher-search__hint">{connectionDisplayAddr(o.connection)}</span>
                <span className="launcher-search__verb">Connect</span>
            </>
        );
    }
    if (o.kind === 'game') {
        const icon = gameIconUrl(o.game);
        return (
            <>
                <SearchThumb icon={icon} name={o.game.name} />
                <span className="launcher-search__label">{o.game.name}</span>
                <span className="launcher-search__hint">{o.game.hostUrl}</span>
                <span className="launcher-search__verb">Details</span>
            </>
        );
    }
    return (
        <>
            <span className="launcher-search__thumb launcher-search__thumb--server"><Server size={15} aria-hidden="true" /></span>
            <span className="launcher-search__label">Connect to {o.address.label}</span>
            <span className="launcher-search__verb">New profile</span>
        </>
    );
}

/** Up to two letters standing for a name: the initials of its first two
 *  words ("My test MUD" → "MT"), or its first two letters when it is one word
 *  ("alteraeon.com" → "AL"). */
export function nameInitials(name: string): string {
    // Not on dots: "alteraeon.com" is one name, not "alteraeon" + "com".
    const words = name.trim().split(/[\s_-]+/).filter(Boolean);
    if (words.length === 0) return '?';
    const letters = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
    return letters.toUpperCase();
}

/** A result's thumbnail: its logo, or — like the grid's tiles — its aurora
 *  with the name on it, shortened to initials to fit the small box. */
function SearchThumb({ icon, name }: { icon: string | null; name: string }) {
    if (icon) return <img className="launcher-search__thumb" src={icon} alt="" />;
    return (
        <span className="launcher-search__thumb launcher-search__thumb--art" aria-hidden="true">
            <ProfileArt icon={null} name={name} />
            <span className="launcher-search__thumb-text">{nameInitials(name)}</span>
        </span>
    );
}
