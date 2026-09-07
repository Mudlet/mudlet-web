/**
 * Closed captions for media (Mudlet's `enableClosedCaption`). When enabled,
 * each sound / music / video that starts or stops prints a short text line into
 * the main output so deaf / hard-of-hearing players know audio fired — and, via
 * the normal output path, screen-reader users hear it announced.
 *
 * Faithful to Mudlet `TMedia::printClosedCaption` (TMedia.cpp:2084-2110):
 * captions cover audio + video ONLY — there is no image media type, so images
 * are never captioned. This module holds the pure formatter; the SoundManager /
 * VideoManager raise the lifecycle events and ScriptingEngine prints the line.
 */

/** Media families Mudlet captions. Notably no `image` — images never flow
 *  through the media player and so are never captioned. */
export type MediaKind = 'sound' | 'music' | 'video';

/** The player-lifecycle verb shown in the caption. Mudlet also has pauses/fades,
 *  but Mudlet Web's Web Audio model collapses those into a stop, so we expose the two
 *  transitions that map cleanly. */
export type CaptionAction = 'plays' | 'stops';

export interface MediaCaptionInfo {
    kind: MediaKind;
    /** The path or name handed to the player; the trailing segment is shown. */
    name: string;
    /** Media key, when one was supplied. */
    key?: string;
    /** Explicit caption from the media packet / Lua `caption` arg, if any. */
    caption?: string;
    action: CaptionAction;
}

/**
 * Format one caption line, mirroring Mudlet's text exactly:
 *   - with an explicit caption:           `[<caption> <action>]`
 *   - else, with a key:   `[<kind> <key> "<file>" <action>]`
 *   - else:                       `[<kind> "<file>" <action>]`
 * `<file>` is the trailing path segment of `name` (Mudlet shows the bare
 * filename, not the resolved path).
 */
export function formatClosedCaption(info: MediaCaptionInfo): string {
    const action = info.action;
    const caption = info.caption?.trim();
    if (caption) return `[${caption} ${action}]`;

    const filename = info.name.split(/[\\/]/).pop() || info.name;
    const key = info.key?.trim();
    if (key) return `[${info.kind} ${key} "${filename}" ${action}]`;
    return `[${info.kind} "${filename}" ${action}]`;
}
