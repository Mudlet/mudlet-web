import { useMemo } from 'react';
import { gameIconUrl } from '../../mud/games/gameIcons';
import { findGameForConnection } from '../../mud/games/gameLinks';
import type { MudConnection } from '../../storage';
import { auroraBackground, auroraFor } from './launcherModel';

/** The logo a profile is drawn with: its own icon (setProfileIcon) first, else
 *  its game's vendored logo. A profile made from the catalogue keeps the game's
 *  logo without storing a copy — matched by host too, so a renamed or second
 *  "Achaea (2)" is recognised. Null when there is neither. */
export function profileIconUrl(connection: MudConnection): string | null {
    return connection.icon ?? gameIconUrl(findGameForConnection(connection) ?? undefined);
}

interface Props {
    /** The logo to glow behind, or null for the name-derived aurora. */
    icon: string | null;
    /** Seeds the aurora when there is no icon. */
    name: string;
}

/**
 * The backdrop behind a profile or game: its logo blown up and blurred into a
 * glow when it has one, otherwise an aurora coloured from its name. Purely
 * decorative — callers draw the logo or name on top, and a scrim keeps that
 * readable whatever colours land here.
 */
export function ProfileArt({ icon, name }: Props) {
    const aurora = useMemo(() => (icon ? null : auroraFor(name)), [icon, name]);
    return (
        <div className="launcher-art" aria-hidden="true">
            {icon
                ? <div className="launcher-art__glow" style={{ backgroundImage: `url("${icon}")` }} />
                : (
                    <div className="launcher-art__aurora-base" style={{ background: aurora!.base }}>
                        <div className="launcher-art__aurora" style={{ background: auroraBackground(aurora!) }} />
                    </div>
                )}
            <div className="launcher-art__grain" />
        </div>
    );
}
