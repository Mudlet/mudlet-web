import { useMemo, useState } from 'react';
import { Button, Input } from './components';
import type { BundledGame } from '../mud/games/bundledGames';
import { gameIconUrl } from '../mud/games/gameIcons';
import { PLAYABLE_GAMES, profilesForGame } from '../mud/games/gameLinks';
import { gameMatchesQuery, parseWebsiteLinks } from '../mud/games/websiteLinks';
import type { MudConnection } from '../storage';

/** Deterministic tile colour for a game with no vendored logo, matching
 *  ConnectionGrid's so a game that becomes a profile keeps the same face. */
function avatarColor(name: string): string {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
    return `hsl(${Math.abs(h) % 360} 42% 38%)`;
}

/** The connection record a game turns into. Mudlet's catalogue is host/port, so
 *  these are proxied `mud` profiles — the same thing the Add form builds. */
export function connectionFromGame(game: BundledGame): Omit<MudConnection, 'id'> {
    return {
        name: game.name,
        mode: 'mud',
        host: game.hostUrl,
        port: game.port,
        tls: game.tlsEnabled || undefined,
        description: game.description || undefined,
    };
}

const TEASER_CHARS = 140;

/** First sentence or so of the blurb, for the collapsed tile. */
function teaser(description: string): string {
    const firstParagraph = description.split('\n\n')[0] ?? '';
    return firstParagraph.length > TEASER_CHARS
        ? `${firstParagraph.slice(0, TEASER_CHARS - 1).trimEnd()}…`
        : firstParagraph;
}

/** Whether the collapsed tile is hiding anything worth expanding for. */
function hasMoreThanTeaser(description: string): boolean {
    return description.trim().length > teaser(description).length;
}

interface Props {
    /** The player's profiles, so a tile can say they already have one for this
     *  game. It stays listed either way — alts and test profiles are ordinary,
     *  and a catalogue that reshuffles as profiles come and go is harder to
     *  find things in than a fixed one. */
    connections: MudConnection[];
    busy: boolean;
    /** Set up a profile for the game — opens the Add form with the game's
     *  connection details filled in, as Mudlet's connection dialog does. */
    onPlay: (game: BundledGame) => void;
}

/**
 * The games Mudlet ships with, offered the way Mudlet offers them: a browsable
 * list, where picking one fills the connection form in for you. Nothing is
 * stored until that form is submitted, so the list is not a pile of empty
 * profiles a player has to tidy up.
 */
export function BundledGameGrid({ connections, busy, onPlay }: Props) {
    const [query, setQuery] = useState('');
    // Which tiles have their full blurb showing. The whole description used to
    // live only in the tile's `title`, which a touch device never shows and a
    // browser truncates for the longest entries (Abandoned Realms runs to 1439
    // characters), so it is an in-page disclosure instead.
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

    const games = useMemo(
        () => PLAYABLE_GAMES.filter(g => gameMatchesQuery(g, query)),
        [query],
    );

    const toggleExpanded = (name: string) => setExpanded(prev => {
        const next = new Set(prev);
        if (!next.delete(name)) next.add(name);
        return next;
    });

    return (
        <div className="bundled-games">
            <div className="bundled-games__header">
                <span className="bundled-games__title" id="bundled-games-title">Games</span>
                <span className="bundled-games__hint">Pick one to set up a profile for it</span>
                <Input
                    type="search"
                    className="bundled-games__search"
                    placeholder="Filter games…"
                    aria-label="Filter games by name, address or description"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                />
            </div>
            {games.length === 0
                ? (
                    <p className="bundled-games__empty" role="status">
                        No game matches that filter.
                    </p>
                )
                : (
                    <div className="bundled-games__grid" role="list" aria-labelledby="bundled-games-title">
                        {games.map(game => {
                            const icon = gameIconUrl(game);
                            const owned = profilesForGame(game, connections).length;
                            const links = parseWebsiteLinks(game.websiteInfo);
                            const isOpen = expanded.has(game.name);
                            const expandable = hasMoreThanTeaser(game.description);
                            return (
                                <div
                                    key={game.name}
                                    role="listitem"
                                    className="bundled-game-tile"
                                >
                                    <div className="bundled-game-tile__header">
                                        {icon
                                            ? (
                                                <img
                                                    className="connection-avatar bundled-game-tile__avatar"
                                                    src={icon}
                                                    alt=""
                                                    aria-hidden="true"
                                                    loading="lazy"
                                                />
                                            )
                                            : (
                                                <span
                                                    className="connection-avatar connection-avatar--name bundled-game-tile__avatar"
                                                    style={{ backgroundColor: avatarColor(game.name) }}
                                                    aria-hidden="true"
                                                >
                                                    <span className="connection-avatar-text">{game.name}</span>
                                                </span>
                                            )}
                                        <Button variant="primary" onClick={() => onPlay(game)} disabled={busy}>
                                            Play
                                        </Button>
                                    </div>
                                    <div className="bundled-game-tile__body">
                                        <span className="connection-name bundled-game-tile__name">{game.name}</span>
                                        <span className="connection-addr">
                                            {game.hostUrl}:{game.port}{game.tlsEnabled ? ' (TLS)' : ''}
                                        </span>
                                        {owned > 0 && (
                                            <span className="bundled-game-tile__owned">
                                                {owned === 1 ? 'You have a profile for this' : `You have ${owned} profiles for this`}
                                            </span>
                                        )}
                                        {game.description && (
                                            <span className={`bundled-game-tile__teaser${isOpen ? ' bundled-game-tile__teaser--open' : ''}`}>
                                                {isOpen ? game.description : teaser(game.description)}
                                            </span>
                                        )}
                                        {expandable && (
                                            <button
                                                type="button"
                                                className="bundled-game-tile__more"
                                                aria-expanded={isOpen}
                                                onClick={() => toggleExpanded(game.name)}
                                            >
                                                {isOpen ? `Less about ${game.name}` : `More about ${game.name}`}
                                            </button>
                                        )}
                                        {links.length > 0 && (
                                            <span className="bundled-game-tile__links">
                                                {links.map(link => (
                                                    <a
                                                        key={link.href}
                                                        href={link.href}
                                                        target="_blank"
                                                        rel="noreferrer noopener"
                                                    >
                                                        {link.label}
                                                    </a>
                                                ))}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
        </div>
    );
}
