/**
 * DOM ids for the two places a keyboard user needs to reach directly on the
 * session screen. They are shared because the skip links in `ProfileSession`
 * live several components away from the elements they target — the console is
 * rendered into a detached host by `ContentLayout`, the command line by
 * `CommandBar` — so a literal in each file would silently drift apart.
 */
export const MAIN_OUTPUT_ID = 'mudlet-output';
export const COMMAND_INPUT_ID = 'mudlet-command-input';
