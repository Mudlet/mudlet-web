/**
 * Desktop's environment kits (EnvironmentKit.cpp): the kind of ground an
 * environment is, for the 3D map styles that draw rooms by it rather than by
 * colour alone. A game names the kit for an environment with
 * setMapEnvironmentKit; until it does, one is guessed from the colour the
 * environment is drawn in. Mudlet Web draws no 3D map, but the names are map
 * data — kept in the map's user data, so they travel with the map file — and
 * the guess is what a script reads back, so both follow desktop exactly.
 */

/** The kits, in the order desktop's refusal lists them. */
export const ENVIRONMENT_KITS = ['plain', 'water', 'road', 'forest', 'building'] as const;
export type EnvironmentKit = typeof ENVIRONMENT_KITS[number];

/** The map user data key the named kits are saved under, as a JSON object of
 *  environment id to kit name. */
export const ENVIRONMENT_KIT_USER_DATA_KEY = 'system.mapStyle.environmentKits';

export const isEnvironmentKit = (name: unknown): name is EnvironmentKit =>
    typeof name === 'string' && (ENVIRONMENT_KITS as readonly string[]).includes(name);

/**
 * EnvironmentKit::guess: blue is water, green forest, grey, brown and tan
 * road, anything else a building. Nearly black is a road and nearly white a
 * building, as neither has a hue to go by. Worked in HSL, as QColor::toHsl.
 */
export function guessEnvironmentKit([r255, g255, b255]: readonly [number, number, number]): EnvironmentKit {
    const r = r255 / 255, g = g255 / 255, b = b255 / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const chroma = max - min;
    const lightness = (max + min) / 2;
    if (lightness < 0.1) return 'road';
    if (lightness > 0.92) return 'building';
    const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));
    // Saturation alone overstates it near black and white, where a little
    // tint is still a grey.
    if (saturation < 0.15 || chroma < 0.08) return 'road';
    let hue: number;
    if (max === r) hue = ((g - b) / chroma) % 6;
    else if (max === g) hue = (b - r) / chroma + 2;
    else hue = (r - g) / chroma + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
    if (hue >= 170 && hue < 250) return 'water';
    if (hue >= 70 && hue < 170) return 'forest';
    // Brown and tan are a dull or dark orange; a bright one is a painted building.
    if (hue >= 15 && hue < 50 && (saturation < 0.6 || lightness < 0.4)) return 'road';
    return 'building';
}

/** What is saved: an empty object when nothing is, null when what is saved is
 *  not a JSON object (EnvironmentKit's storedObject). */
function storedObject(saved: string | undefined): Record<string, unknown> | null {
    if (saved === undefined) return {};
    try {
        const parsed: unknown = JSON.parse(saved);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/** QString::toInt: a whole 32-bit number, surrounding spaces allowed. */
function environmentIdOf(key: string): number | null {
    if (!/^\s*[+-]?\d+\s*$/.test(key)) return null;
    const n = Number(key);
    return n >= -2147483648 && n <= 2147483647 ? n : null;
}

/** EnvironmentKit::stored: the kits the map names. An entry that cannot be
 *  read — a key that is not a number, a name that is not a kit — is left out,
 *  as is everything when what is saved is not a JSON object. */
export function storedEnvironmentKits(saved: string | undefined): Map<number, EnvironmentKit> {
    const kits = new Map<number, EnvironmentKit>();
    const object = storedObject(saved);
    if (!object) return kits;
    for (const [key, value] of Object.entries(object)) {
        const id = environmentIdOf(key);
        if (id !== null && isEnvironmentKit(value)) kits.set(id, value);
    }
    return kits;
}

/**
 * EnvironmentKit::store: set or, with no kit, clear one environment's kit,
 * keeping every other entry as it was, even one that cannot be read. Answers
 * the new saved value — undefined when nothing is left, which removes the key —
 * or null, refusing, when what is saved is not a JSON object, rather than
 * overwrite it.
 */
export function storeEnvironmentKit(
    saved: string | undefined, environmentId: number, kit: EnvironmentKit | null,
): { value: string | undefined } | null {
    const object = storedObject(saved);
    if (!object) return null;
    const key = String(environmentId);
    if (kit) object[key] = kit;
    else delete object[key];
    const keys = Object.keys(object);
    if (keys.length === 0) return { value: undefined };
    // QJsonObject keeps its keys sorted, and writes them so; a plain
    // JSON.stringify would put the numeric ones first in numeric order.
    keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { value: `{${keys.map(k => `${JSON.stringify(k)}:${JSON.stringify(object[k])}`).join(',')}}` };
}
