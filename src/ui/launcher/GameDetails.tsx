import { ExternalLink, Play, X } from 'lucide-react';
import type { BundledGame } from '../../mud/games/bundledGames';
import { gameIconUrl } from '../../mud/games/gameIcons';
import { profilesForGame } from '../../mud/games/gameLinks';
import { parseWebsiteLinks } from '../../mud/games/websiteLinks';
import type { MudConnection } from '../../storage';
import { useModalFocus } from '../components/useModalFocus';
import { ProfileArt } from './ProfileArt';

interface Props {
    game: BundledGame;
    connections: MudConnection[];
    busy: boolean;
    /** Set up a profile for the game — the prefilled Add form. */
    onPlay: (game: BundledGame) => void;
    /** Connect one of the player's existing profiles for this game. */
    onConnect: (c: MudConnection) => void;
    onClose: () => void;
}

/**
 * A game's details: a card centred over the launcher (a bottom sheet on
 * phones), the same whether the game was picked from the grid, the full
 * catalogue or the search box. Centred rather than a side drawer — on a wide
 * screen a drawer opens at the window's edge, far from the tile that opened
 * it. Focus is held inside while it's open and handed back on close.
 */
export function GameDetails({ game, connections, busy, onPlay, onConnect, onClose }: Props) {
    const ref = useModalFocus<HTMLDivElement>(onClose);
    const icon = gameIconUrl(game);
    const links = parseWebsiteLinks(game.websiteInfo);
    const owned = profilesForGame(game, connections);
    const paragraphs = game.description.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const titleId = 'launcher-game-title';

    return (
        <>
            <div className="launcher-game-backdrop" onClick={onClose} />
            <div ref={ref} className="launcher-game" role="dialog" aria-modal="true" aria-labelledby={titleId}>
                <div className="launcher-game__art">
                    <ProfileArt icon={icon} name={game.name} />
                    <div className="launcher-game__fade" />
                    {icon && <img className="launcher-game__logo" src={icon} alt="" />}
                    <button type="button" className="launcher-game__close" onClick={onClose} aria-label="Close">
                        <X size={18} aria-hidden="true" />
                    </button>
                </div>
                <div className="launcher-game__body">
                    <div className="launcher-game__side">
                        <h2 className="launcher-game__title" id={titleId}>{game.name}</h2>
                        <div className="launcher-game__meta">
                            <span className="launcher-mono">{game.hostUrl}:{game.port}</span>
                            {game.tlsEnabled && <span className="launcher-pill">TLS</span>}
                            {game.ownUi && (
                                <span className="launcher-pill" title="The game installs its own interface when you connect">Own UI</span>
                            )}
                        </div>

                        <button type="button" className="launcher-connect launcher-connect--block" onClick={() => onPlay(game)} disabled={busy}>
                            <Play size={14} aria-hidden="true" fill="currentColor" />
                            {owned.length > 0 ? 'New profile' : `Play ${game.name}`}
                        </button>

                        {owned.length > 0 && (
                            <div className="launcher-game__owned">
                                <span className="launcher-kicker">Your {owned.length === 1 ? 'profile' : 'profiles'}</span>
                                {owned.map(c => (
                                    <button key={c.id} type="button" className="launcher-game__owned-row" onClick={() => onConnect(c)} disabled={busy}
                                        aria-label={`Connect to ${c.name}`}>
                                        <span>{c.name}</span>
                                        <span className="launcher-game__owned-go">Connect →</span>
                                    </button>
                                ))}
                            </div>
                        )}

                        {links.length > 0 && (
                            <div className="launcher-game__links">
                                {links.map(link => (
                                    <a key={link.href} href={link.href} target="_blank" rel="noreferrer noopener">
                                        {link.label}
                                        <ExternalLink size={13} aria-hidden="true" />
                                    </a>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="launcher-game__desc">
                        {paragraphs.map((p, i) => <p key={i}>{p}</p>)}
                    </div>
                </div>
            </div>
        </>
    );
}
