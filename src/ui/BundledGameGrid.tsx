import { Button } from './components';
import type { BundledGame } from '../mud/games/bundledGames';
import { gameIconUrl } from '../mud/games/gameIcons';
import { PLAYABLE_GAMES, profilesForGame } from '../mud/games/gameLinks';
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

/** First sentence or so of the blurb, for the tile. The whole thing is on the
 *  tile's title, and the profile keeps it as its description. */
function teaser(description: string): string {
    const firstParagraph = description.split('\n\n')[0] ?? '';
    return firstParagraph.length > 140 ? `${firstParagraph.slice(0, 139).trimEnd()}…` : firstParagraph;
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
    return (
        <div className="bundled-games">
            <div className="bundled-games__header">
                <span className="bundled-games__title">Games</span>
                <span className="bundled-games__hint">Pick one to set up a profile for it</span>
            </div>
            <div className="bundled-games__grid" role="list">
                {PLAYABLE_GAMES.map(game => {
                    const icon = gameIconUrl(game);
                    const owned = profilesForGame(game, connections).length;
                    return (
                        <div
                            key={game.name}
                            role="listitem"
                            className="bundled-game-tile"
                            title={game.description || game.name}
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
                                    <span className="bundled-game-tile__teaser">{teaser(game.description)}</span>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
