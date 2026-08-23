import { describe, it, expect } from 'vitest';
import { HELP_TOPICS, DEFAULT_HELP_TOPIC, topicForHref, searchHelpTopics } from '../../src/ui/helpTopics';

describe('help topics', () => {
    it('bundles every topic markdown file', () => {
        expect(HELP_TOPICS.length).toBeGreaterThan(0);
        for (const t of HELP_TOPICS) {
            expect(t.markdown.trim().length, `${t.file} is empty`).toBeGreaterThan(0);
            expect(t.markdown.trimStart().startsWith('# '), `${t.file} has no H1`).toBe(true);
        }
    });

    it('has unique ids and files, and a default that exists', () => {
        expect(new Set(HELP_TOPICS.map(t => t.id)).size).toBe(HELP_TOPICS.length);
        expect(new Set(HELP_TOPICS.map(t => t.file)).size).toBe(HELP_TOPICS.length);
        expect(HELP_TOPICS.some(t => t.id === DEFAULT_HELP_TOPIC)).toBe(true);
    });

    // The markdown is also read on GitHub, so cross-links are written as relative
    // paths. Every one has to resolve to a bundled topic or the in-app viewer
    // renders a dead link.
    it('resolves every relative markdown link to a topic', () => {
        for (const t of HELP_TOPICS) {
            for (const [, href] of t.markdown.matchAll(/\]\(([^)]+)\)/g)) {
                if (/^https?:/i.test(href) || href.startsWith('#')) continue;
                expect(topicForHref(href), `${t.file} links to ${href}`).not.toBeNull();
            }
        }
    });

    it('maps hrefs to topics only for our own files', () => {
        expect(topicForHref('./storage.md')).toBe('storage');
        expect(topicForHref('storage.md')).toBe('storage');
        expect(topicForHref('docs/help/storage.md#backing-up')).toBe('storage');
        expect(topicForHref('https://example.com/storage.md')).toBeNull();
        expect(topicForHref('#a-heading')).toBeNull();
        expect(topicForHref('./MUDLET_API.md')).toBeNull();
    });

    it('searches titles, blurbs and bodies', () => {
        expect(searchHelpTopics('')).toHaveLength(HELP_TOPICS.length);
        expect(searchHelpTopics('   ')).toHaveLength(HELP_TOPICS.length);
        // Body-only term: "proxy" is nowhere in the connecting topic's title/blurb.
        expect(searchHelpTopics('proxy').map(t => t.id)).toContain('connecting');
        expect(searchHelpTopics('zzzznotathing')).toHaveLength(0);
    });
});
