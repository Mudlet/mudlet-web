/**
 * Where a sound comes from, and which way the player faces — the placement half
 * of Mudlet's Client.Media 2 (TMedia::canonicalMediaDirection,
 * mediaDirectionBearing and stereoPan).
 *
 * A direction is kept as desktop keeps it: a compass word ("north",
 * "northeast", ...), one of the words relative to the player ("ahead",
 * "behind", "left", "right"), "up" / "down", or whole degrees as a string
 * ("0" to "359", 0 being north and 90 east).
 */

/** The pan range, TMediaData::MediaPanLeft / MediaPanRight. */
export const MEDIA_PAN_LEFT = -100;
export const MEDIA_PAN_RIGHT = 100;

const WORDS: Record<string, string> = {
    n: 'north', north: 'north', ne: 'northeast', northeast: 'northeast',
    e: 'east', east: 'east', se: 'southeast', southeast: 'southeast',
    s: 'south', south: 'south', sw: 'southwest', southwest: 'southwest',
    w: 'west', west: 'west', nw: 'northwest', northwest: 'northwest',
    u: 'up', up: 'up', d: 'down', down: 'down',
    ahead: 'ahead', behind: 'behind', left: 'left', right: 'right',
};

/** Qt's qRound: half away from zero. */
function qRound(v: number): number {
    return v >= 0 ? Math.floor(v + 0.5) : Math.ceil(v - 0.5);
}

/** A direction spelled as TMedia keeps it, or '' when it names none. A number
 *  (or a string reading as one) is whole degrees, wrapped onto 0..359. */
export function canonicalMediaDirection(direction: string | number): string {
    if (typeof direction === 'number') {
        if (!Number.isFinite(direction)) return '';
        const whole = qRound(direction % 360);
        return String(((whole % 360) + 360) % 360);
    }
    const key = direction.trim().toLowerCase();
    if (Object.hasOwn(WORDS, key)) return WORDS[key];
    // QString::toDouble: the whole string must read as a number
    if (key === '' || !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(key)) return '';
    return canonicalMediaDirection(Number(key));
}

/** The bearing of a canonical direction in degrees, and whether it is relative
 *  to the way the player faces; null for up, down and anything unknown. */
export function mediaDirectionBearing(direction: string): { bearing: number; relative: boolean } | null {
    const fixed: Record<string, [number, boolean]> = {
        north: [0, false], northeast: [45, false], east: [90, false], southeast: [135, false],
        south: [180, false], southwest: [225, false], west: [270, false], northwest: [315, false],
        ahead: [0, true], right: [90, true], behind: [180, true], left: [270, true],
    };
    if (Object.hasOwn(fixed, direction)) {
        const [bearing, relative] = fixed[direction];
        return { bearing, relative };
    }
    if (direction === '' || !/^\d+$/.test(direction)) return null;
    return { bearing: Number(direction), relative: false };
}

/** Whether `facing` is a way a player can turn to: a compass word or degrees,
 *  not up, down or a word relative to the player. */
export function isListenerFacing(facing: string): boolean {
    const b = mediaDirectionBearing(facing);
    return b !== null && !b.relative;
}

/**
 * The stereo pan (-100..100) a sound is heard at — TMedia::stereoPan. A pan of
 * its own wins; otherwise its direction is turned by the way the player faces,
 * clockwise of which is to the right. Ahead and behind both centre, as stereo
 * cannot tell front from back. Undefined when the sound is not placed at all.
 */
export function stereoPan(pan: number | undefined, direction: string | undefined, facing: string): number | undefined {
    if (pan !== undefined) return pan;
    const placed = direction ? mediaDirectionBearing(direction) : null;
    if (!placed) return undefined;
    const facingBearing = placed.relative ? 0 : (mediaDirectionBearing(facing)?.bearing ?? 0);
    return qRound(MEDIA_PAN_RIGHT * Math.sin((placed.bearing - facingBearing) * Math.PI / 180));
}

/** A direction as a caption shows it, after the caption text:
 *  TMedia::mediaDirectionCaption. */
export function mediaDirectionCaption(direction: string): string {
    return /^\d+$/.test(direction) ? `${direction} degrees` : direction;
}
