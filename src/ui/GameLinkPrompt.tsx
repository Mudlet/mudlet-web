import { Button } from './components';
import { useModalFocus } from './components/useModalFocus';
import { gameIconUrl } from '../mud/games/gameIcons';
import type { BundledGame } from '../mud/games/bundledGames';
import type { MudConnection } from '../storage';

interface Props {
    game: BundledGame;
    /** Existing profiles for this game — never empty; with none the caller goes
     *  straight to the prefilled Add form and this never renders. */
    profiles: MudConnection[];
    busy: boolean;
    /** Play an existing profile — opens it and dials. */
    onPlay: (connection: MudConnection) => void;
    /** Open an existing profile without dialing, as the launcher tiles do. */
    onOpen: (connection: MudConnection) => void;
    /** Set up another profile for the game (opens the prefilled Add form). */
    onCreate: () => void;
    onClose: () => void;
}

/**
 * Where a `?play=<game>` link lands when the player already has profiles for
 * that game. The link can't know whether they've played it before, so it asks
 * rather than guessing: dialing an existing profile would bypass the one they
 * just made, and making a new one every visit would litter the launcher with
 * duplicates.
 *
 * A click on the game's own tile doesn't come through here — the profiles are
 * already on screen right above it, so that click goes straight to the form.
 */
export function GameLinkPrompt({ game, profiles, busy, onPlay, onOpen, onCreate, onClose }: Props) {
    const ref = useModalFocus<HTMLDivElement>(onClose, { autoFocus: true, closeOnEscape: true });
    const icon = gameIconUrl(game);
    const title = `Play ${game.name}`;

    return (
        <>
            <div className="modal-overlay" onClick={onClose} />
            <div ref={ref} className="modal game-link-modal" role="dialog" aria-modal="true" aria-label={title}>
                <div className="modal-header">
                    <span className="modal-title">{title}</span>
                    <button className="modal-close" onClick={onClose} type="button" aria-label="Close">✕</button>
                </div>
                <div className="modal-body game-link-body">
                    {icon && (
                        <img className="connection-avatar game-link-logo" src={icon} alt="" aria-hidden="true" />
                    )}
                    <p className="game-link-intro">
                        {profiles.length === 1
                            ? <>You already have a profile for <strong>{game.name}</strong>.</>
                            : <>You already have {profiles.length} profiles for <strong>{game.name}</strong>.</>}
                        {' '}Carry on with one of them, or set up another.
                    </p>
                    <ul className="game-link-list">
                        {profiles.map(profile => (
                            <li key={profile.id} className="game-link-row">
                                <span className="game-link-row__text">
                                    <span className="game-link-row__name">{profile.name}</span>
                                    <span className="connection-addr">
                                        {profile.mode === 'websocket'
                                            ? profile.url
                                            : `${profile.host}:${profile.port}`}
                                    </span>
                                </span>
                                <span className="game-link-row__actions">
                                    <Button variant="ghost" size="sm" onClick={() => onOpen(profile)} disabled={busy}
                                        title="Open the profile without connecting">
                                        Open
                                    </Button>
                                    <Button variant="primary" size="sm" onClick={() => onPlay(profile)} disabled={busy}>
                                        Play
                                    </Button>
                                </span>
                            </li>
                        ))}
                    </ul>
                    <div className="game-link-actions">
                        <Button variant="secondary" onClick={onCreate} disabled={busy}>
                            New {game.name} profile…
                        </Button>
                        <Button variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                    </div>
                </div>
            </div>
        </>
    );
}
