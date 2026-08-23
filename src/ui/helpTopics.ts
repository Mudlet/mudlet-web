import migrating from '../../docs/help/migrating.md?raw';
import connecting from '../../docs/help/connecting.md?raw';
import storage from '../../docs/help/storage.md?raw';
import browsers from '../../docs/help/browsers.md?raw';

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
];

export const DEFAULT_HELP_TOPIC = HELP_TOPICS[0].id;

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
