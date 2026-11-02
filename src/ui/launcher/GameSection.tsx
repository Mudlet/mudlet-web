import { useEffect, useMemo, useRef, useState } from 'react';
import type { BundledGame } from '../../mud/games/bundledGames';
import { gameIconUrl } from '../../mud/games/gameIcons';
import { PLAYABLE_GAMES, profilesForGame } from '../../mud/games/gameLinks';
import { gameMatchesQuery } from '../../mud/games/websiteLinks';
import type { MudConnection } from '../../storage';
import { Input } from '../components';
import { ProfileArt } from './ProfileArt';

/** First sentence-or-so of a blurb, for a tile. */
export function gameTeaser(description: string, max = 90): string {
    const first = description.split('\n\n')[0] ?? '';
    return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

function GameTile({ game, owned, onSelect }: { game: BundledGame; owned: number; onSelect: (g: BundledGame) => void }) {
    const icon = gameIconUrl(game);
    return (
        <li className="launcher-tile launcher-tile--game">
            <button
                type="button"
                className="launcher-tile__main"
                onClick={() => onSelect(game)}
                aria-haspopup="dialog"
                aria-label={`About ${game.name}`}
            >
                <span className="launcher-tile__art">
                    <ProfileArt icon={icon} name={game.name} />
                    {icon
                        ? <img className="launcher-tile__logo" src={icon} alt="" loading="lazy" />
                        : <span className="launcher-tile__art-name">{game.name}</span>}
                    {owned > 0 && <span className="launcher-tile__badge">{owned === 1 ? 'Your profile' : `${owned} profiles`}</span>}
                </span>
                <span className="launcher-tile__body">
                    <span className="launcher-tile__name">{game.name}</span>
                    <span className="launcher-tile__sub launcher-tile__sub--teaser">{gameTeaser(game.description) || game.hostUrl}</span>
                </span>
            </button>
        </li>
    );
}

interface Props {
    /** The player's profiles — a tile says when one is already for its game. */
    connections: MudConnection[];
    onSelect: (game: BundledGame) => void;
}

/** Rows of games shown before "Browse all". */
const PREVIEW_ROWS = 2;

/** Fisher–Yates; returns a new array. */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/** How many columns an auto-fill grid currently lays out, so the preview can
 *  be exactly whole rows — a ragged last row reads as a list that ran out. */
function useGridColumns(ref: React.RefObject<HTMLElement | null>, fallback: number): number {
    const [cols, setCols] = useState(fallback);
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const measure = () => {
            const n = getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length;
            if (n > 0) setCols(n);
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref]);
    return cols;
}

/**
 * The bundled catalogue: a couple of rows by default, or every game in
 * a filterable grid behind "Browse all". Picking a game opens its details;
 * nothing is created until the player chooses Play there and submits the form.
 */
export function GameSection({ connections, onSelect }: Props) {
    const [browsing, setBrowsing] = useState(false);
    const [query, setQuery] = useState('');
    const gridRef = useRef<HTMLUListElement>(null);
    const cols = useGridColumns(gridRef, 4);
    // The preview is a different handful each visit, so the same first few
    // alphabetical games don't get all the exposure. Shuffled once per mount —
    // not per render, or the tiles would jump about while the player looks.
    // "Browse all" stays alphabetical: there the player is looking for one.
    const [shuffled] = useState(() => shuffle(PLAYABLE_GAMES));
    const games = useMemo(
        () => (browsing ? PLAYABLE_GAMES.filter(g => gameMatchesQuery(g, query)) : shuffled.slice(0, cols * PREVIEW_ROWS)),
        [browsing, query, cols, shuffled],
    );

    return (
        <section className="launcher-section" aria-labelledby="launcher-games-title">
            <div className="launcher-section__header">
                <h2 className="launcher-section__title" id="launcher-games-title">
                    Find a new game
                </h2>
                <div className="launcher-section__tools">
                    {browsing && (
                        <Input
                            type="search"
                            className="launcher-filter"
                            placeholder="Filter games…"
                            aria-label="Filter games by name, address or description"
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                        />
                    )}
                    <button
                        type="button"
                        className="launcher-ghost"
                        aria-expanded={browsing}
                        onClick={() => { setBrowsing(b => !b); setQuery(''); }}
                    >
                        {browsing ? 'Show less' : 'Browse all →'}
                    </button>
                </div>
            </div>
            {games.length === 0
                ? <p className="launcher-empty" role="status">No game matches that filter.</p>
                : (
                    <ul ref={gridRef} className={browsing ? 'launcher-grid launcher-grid--catalog' : 'launcher-grid'}>
                        {games.map(g => (
                            <GameTile key={g.name} game={g} owned={profilesForGame(g, connections).length} onSelect={onSelect} />
                        ))}
                    </ul>
                )}
        </section>
    );
}
