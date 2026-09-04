import migrating from '../../docs/help/migrating.md?raw';
import connecting from '../../docs/help/connecting.md?raw';
import storage from '../../docs/help/storage.md?raw';
import browsers from '../../docs/help/browsers.md?raw';
import settings from '../../docs/help/settings.md?raw';

// The user-facing manual. Deliberately small: Mudlet's own scripting and gameplay
// documentation lives at wiki.mudlet.org and duplicating it here would only rot.
// What belongs here is what the wiki *can't* cover — the things that are true
// because this Mudlet runs in a browser.
//
// Each topic is one markdown file under docs/help/, imported raw so GitHub and
// the in-app viewer render the same source. Cross-topic links are written as
// relative paths (`./storage.md`) so they work in both places; HelpModal maps
// them back to `file` below.

export interface HelpTopic {
    /** Stable id used in state and (eventually) deep links. */
    id: string;
    /** Sidebar label. Kept short — the markdown's own H1 is the real title. */
    title: string;
    /** One line under the label, so the sidebar answers "which one do I want?" */
    blurb: string;
    /** Basename in docs/help/, for resolving relative links between topics. */
    file: string;
    markdown: string;
}

export const HELP_TOPICS: HelpTopic[] = [
    {
        id: 'migrating',
        title: 'Bring a Mudlet profile over',
        blurb: 'Move a desktop profile to the browser — and back again',
        file: 'migrating.md',
        markdown: migrating,
    },
    {
        id: 'connecting',
        title: 'Connecting to a MUD',
        blurb: 'The two connection modes, and why telnet needs a proxy',
        file: 'connecting.md',
        markdown: connecting,
    },
    {
        id: 'storage',
        title: 'Where your data lives',
        blurb: 'Browser storage, disk folders, and backing up',
        file: 'storage.md',
        markdown: storage,
    },
    {
        id: 'browsers',
        title: 'Browsers and limits',
        blurb: 'What works where, and what differs from desktop Mudlet',
        file: 'browsers.md',
        markdown: browsers,
    },
    {
        id: 'settings',
        title: 'Settings and desktop Mudlet',
        blurb: 'Which preferences moved, which can’t exist here, and which are pending',
        file: 'settings.md',
        markdown: settings,
    },
];

export const DEFAULT_HELP_TOPIC = HELP_TOPICS[0].id;

/**
 * Add a topic that only some builds have.
 *
 * The manual is otherwise a fixed list, but a few features are stock-app-only —
 * the credential vault above all — and a branded build must not carry
 * documentation for something it doesn't ship. Those topics are registered from
 * `main.tsx` at boot, alongside the feature itself, so they never enter the
 * library's module graph. See `vault/vaultAccess` for the same seam.
 *
 * Idempotent, and ordered by `after` rather than appended, so an added topic
 * lands next to the one it relates to instead of at the bottom.
 */
export function registerHelpTopic(topic: HelpTopic, opts?: { after?: string }): void {
    if (HELP_TOPICS.some(t => t.id === topic.id)) return;
    const at = opts?.after ? HELP_TOPICS.findIndex(t => t.id === opts.after) : -1;
    if (at >= 0) HELP_TOPICS.splice(at + 1, 0, topic);
    else HELP_TOPICS.push(topic);
}

/** Resolve a markdown link href to a topic id, or null if it isn't one of ours.
 *  Handles `./storage.md`, `storage.md`, `docs/help/storage.md` and a `#anchor`
 *  suffix — the shapes a relative link between these files can take. */
export function topicForHref(href: string): string | null {
    if (/^[a-z]+:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return null;
    const path = href.split('#')[0].split('?')[0];
    const base = path.slice(path.lastIndexOf('/') + 1);
    return HELP_TOPICS.find(t => t.file === base)?.id ?? null;
}

/** Topics whose title, blurb or body mention `query`. Empty query = everything. */
export function searchHelpTopics(query: string): HelpTopic[] {
    const q = query.trim().toLowerCase();
    if (!q) return HELP_TOPICS;
    return HELP_TOPICS.filter(t =>
        t.title.toLowerCase().includes(q) ||
        t.blurb.toLowerCase().includes(q) ||
        t.markdown.toLowerCase().includes(q));
}
