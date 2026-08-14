import { useState } from 'react';
import { Button } from './components';
import { BUNDLED_GAMES, type BundledGame } from '../mud/games/bundledGames';
import { gameIconUrl } from '../mud/games/gameIcons';
import type { MudConnection } from '../storage';

/** Deterministic tile colour for a game with no vendored logo, matching
 *  ConnectionGrid's so a game that becomes a profile keeps the same face. */
function avatarColor(name: string): string {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
    return `hsl(${Math.abs(h) % 360} 42% 38%)`;
}

/** The bundled games this client could actually dial. Mudlet's tutorial entry
 *  points at a local stub with no port and has nothing to connect to here. */
const PLAYABLE = BUNDLED_GAMES.filter(g => g.port > 0 && g.hostUrl)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

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

/** First sentence or so of the blurb, for the tile. The whole thing is on the
 *  tile's title, and the profile keeps it as its description. */
function teaser(description: string): string {
    const firstParagraph = description.split('\n\n')[0] ?? '';
    return firstParagraph.length > 140 ? `${firstParagraph.slice(0, 139).trimEnd()}…` : firstParagraph;
}

interface Props {
    /** Profiles that already exist, so a game someone has played is offered by
     *  its profile tile above rather than a second time down here. */
    connections: MudConnection[];
    busy: boolean;
    /** Create the profile and start playing. */
    onPlay: (game: BundledGame) => void;
}

/**
 * The games Mudlet ships with, offered the way Mudlet offers them: a browsable
 * list you can start playing without filling in a form. Picking one is what
 * turns it into a profile — until then nothing is stored, so the list is not a
 * pile of empty profiles a player has to tidy up.
 */
export function BundledGameGrid({ connections, busy, onPlay }: Props) {
    const [expanded, setExpanded] = useState(false);
    const taken = new Set(connections.map(c => c.name.toLowerCase()));
    const games = PLAYABLE.filter(g => !taken.has(g.name.toLowerCase()));
    if (games.length === 0) return null;

    // Long list, and it sits under the player's own profiles — those come
    // first, and the catalogue opens on request.
    const shown = expanded ? games : games.slice(0, 8);

    return (
        <div className="bundled-games">
            <div className="bundled-games__header">
                <span className="bundled-games__title">Games</span>
                <span className="bundled-games__hint">Pick one to start playing — it becomes a profile</span>
            </div>
            <div className="bundled-games__grid" role="list">
                {shown.map(game => {
                    const icon = gameIconUrl(game);
                    return (
                        <div
                            key={game.name}
                            role="listitem"
                            className="bundled-game-tile"
                            title={game.description || game.name}
                            // The logo does double duty: the crisp 120×30 badge
                            // Mudlet draws, and a faint full-bleed wash behind
                            // the whole tile for the game's colour. A game with
                            // no vendored icon leaves the property unset, which
                            // makes the background-image declaration invalid and
                            // draws nothing — no fallback needed.
                            style={icon ? ({ '--game-icon': `url("${icon}")` } as React.CSSProperties) : undefined}
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
                                {game.description && (
                                    <span className="bundled-game-tile__teaser">{teaser(game.description)}</span>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
            {games.length > shown.length && (
                <div className="bundled-games__more">
                    <Button variant="secondary" size="sm" onClick={() => setExpanded(true)}>
                        Show all {games.length} games
                    </Button>
                </div>
            )}
        </div>
    );
}
