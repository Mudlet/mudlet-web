/**
 * Mudlet map format-version gate.
 *
 * Mudlet's own reader checks the leading format-version int *before* it parses
 * anything and tells the player, on the main console, exactly why a map file
 * was refused (`TMap::readMap`, src/TMap.cpp:1531-1573). `mudlet-map-binary-reader`
 * has no equivalent: it throws a bare `Error("Unsupported Mudlet map version
 * N. Supported version(s): 16, 17, 18, 19, 20.")` that every map entry point
 * used to swallow into a `console.warn`, leaving the player with a blank map
 * window and nothing to act on.
 *
 * So the version is read here, on this side of the library, and classified into
 * the same cases Mudlet reports — with Mudlet's wording, since the player is
 * being told the same thing.
 */

import { getBrand } from '../branding';

/**
 * Highest format version this build can read.
 *
 * Mudlet desktop's `mMaxVersion` (src/TMap.h:351) is also 20; here the ceiling
 * comes from `mudlet-map-binary-reader`, which registers version models for
 * 16-20 only (see its `getSupportedVersions`, not exported — hence the literal;
 * `tests/map/mapVersionMessages.test.ts` pins these constants against the
 * library's actual behaviour so a dependency bump cannot silently desync them).
 */
export const MAP_MAX_SUPPORTED_VERSION = 20;

/**
 * Lowest format version this build can read. Desktop Mudlet reads much older
 * maps (down to version 1, warning from below 4 — src/TMap.cpp:1561), so a map
 * we reject here is not necessarily lost: desktop can still open it and re-save
 * it in the current format.
 */
export const MAP_MIN_SUPPORTED_VERSION = 16;

/** Mudlet's own sanity bounds on the leading int (src/TMap.cpp:1531). */
const PLAUSIBLE_MIN = 1;
const PLAUSIBLE_MAX = 127;

/** Why a map buffer was refused, in the three shapes Mudlet distinguishes. */
export type MapVersionFault = 'not-a-map' | 'too-new' | 'too-old';

/**
 * A map buffer whose format version this build cannot read.
 *
 * `messages` carries the console lines to post, already in Mudlet's
 * `"[ PREFIX ] - body"` form (see `cTelnet::postMessage`, src/ctelnet.cpp:4436,
 * which colours off that prefix); `summary` is the one-line version for UI that
 * has a small error slot rather than a console.
 */
export class MapVersionError extends Error {
    constructor(
        readonly fault: MapVersionFault,
        readonly version: number,
        readonly messages: string[],
        readonly summary: string,
    ) {
        super(summary);
        this.name = 'MapVersionError';
    }
}

/**
 * The format version a Mudlet `.dat` buffer declares: the very first value in
 * the stream, a Qt `qint32` written big-endian by `QDataStream`
 * (`mudlet-map-binary-reader`'s own `readMapVersion` reads the same four bytes
 * through `QInt.read`). Returns `NaN` when the buffer is too short to hold one.
 */
export function readMapFormatVersion(buf: ArrayBuffer): number {
    if (buf.byteLength < 4) return NaN;
    return new DataView(buf).getInt32(0, /* littleEndian */ false);
}

/** `The file is: "x".` tail Mudlet appends when it knows the file name. */
function fileClause(source?: string): string {
    return source ? ` The file is:\n"${source}".` : '';
}

/**
 * Throw {@link MapVersionError} when `buf` declares a format version this build
 * cannot read, mirroring `TMap::readMap`'s pre-parse gate (src/TMap.cpp:1531-1573).
 * Returns the version otherwise.
 *
 * `source` is the file name / origin to quote in the message, when the caller
 * has one (Mudlet always does; here a buffer can come from IndexedDB or a
 * download, in which case the clause is simply left off).
 */
export function assertReadableMapVersion(buf: ArrayBuffer, source?: string): number {
    const version = readMapFormatVersion(buf);
    const shown = Number.isNaN(version) ? '?' : String(version);
    const app = getBrand().appName;

    // src/TMap.cpp:1532 — the leading int is not a plausible format version at
    // all, so this is very unlikely to be a map file in the first place.
    if (Number.isNaN(version) || version < PLAUSIBLE_MIN || version > PLAUSIBLE_MAX) {
        throw new MapVersionError('not-a-map', version, [
            '[ ALERT ] - File does not seem to be a Mudlet Map file. The part that indicates\n'
            + `its format version seems to be "${shown}" and that doesn't make sense.`
            + fileClause(source),
            '[ INFO ]  - Ignoring this unlikely map file.',
        ], `File does not seem to be a Mudlet Map file — its format version reads as "${shown}".`);
    }

    // src/TMap.cpp:1547 — written by a newer Mudlet than this build knows. The
    // case that will actually happen: the day Mudlet ships format 21, every map
    // saved by it lands here until the reader dependency is bumped.
    if (version > MAP_MAX_SUPPORTED_VERSION) {
        throw new MapVersionError('too-new', version, [
            `[ ALERT ] - Map file is too new. Its format version "${version}" is higher than this version of\n`
            + `${app} can handle (${MAP_MAX_SUPPORTED_VERSION})!`
            + fileClause(source),
            `[ INFO ]  - You will need to update your ${app} to read the map file.`,
        ], `Map file is too new: format version ${version} is higher than this version of `
            + `${app} can handle (${MAP_MAX_SUPPORTED_VERSION}).`);
    }

    // src/TMap.cpp:1563 — Mudlet's "really old" alert, except that desktop goes
    // on to try the parse and we cannot: the library has no model below 16, and
    // reading an old layout as a new one desyncs the stream into nonsense. So
    // the message points at the client that *can* still read it.
    if (version < MAP_MIN_SUPPORTED_VERSION) {
        throw new MapVersionError('too-old', version, [
            `[ ALERT ] - Map file is really old. Its format version "${version}" is so ancient that\n`
            + `this version of ${app} cannot read it (the oldest it handles is ${MAP_MIN_SUPPORTED_VERSION})!`
            + fileClause(source),
            '[ INFO ]  - Desktop Mudlet still reads this format: open the map there and save it\n'
            + `to bring it up to date, then load it in ${app}.`,
        ], `Map file is really old: format version ${version} is older than this version of `
            + `${app} can read (the oldest it handles is ${MAP_MIN_SUPPORTED_VERSION}).`);
    }

    return version;
}
