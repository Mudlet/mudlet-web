/**
 * The styles desktop's modern 3D mapper draws in (MapStyle::ids()), in the
 * order its setConfig refusal names them. Mudlet Web has no 3D view to draw
 * them with, but the choice is ordinary profile data: getConfig/setConfig
 * read and write it, and the profile save carries it as `<Host mapStyle="…">`,
 * so a profile moved to desktop opens in the style it was set to.
 */
export const MAP_STYLES: readonly string[] = [
    'tiles', 'blueprint', 'terminal', 'transit', 'hologram', 'inkwash', 'diorama',
];

/** MapStyle::defaultId(): what a new profile, and a save that names none or an
 *  unknown one, starts on. */
export const DEFAULT_MAP_STYLE = 'tiles';
