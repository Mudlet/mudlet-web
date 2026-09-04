import { describe, it, expect } from 'vitest';
import { HELP_TOPICS, searchHelpTopics, topicForHref } from '../../src/ui/helpTopics';
import { installVaultHelpTopic } from '../../src/vault/vaultHelpTopic';

// Its own file: `installVaultHelpTopic` mutates the shared HELP_TOPICS list, and
// Vitest isolates per file, so registering here can't skew the base manual's
// tests in tests/ui/helpTopics.test.ts.

describe('vault help topic', () => {
    it('is absent until a build installs it', () => {
        // The library never calls this, which is the whole point — a branded
        // build has no vault and must not document one.
        expect(HELP_TOPICS.some(t => t.id === 'saved-logins')).toBe(false);
    });

    it('registers next to the storage topic rather than at the end', () => {
        installVaultHelpTopic();
        const ids = HELP_TOPICS.map(t => t.id);
        expect(ids.indexOf('saved-logins')).toBe(ids.indexOf('storage') + 1);
    });

    it('is idempotent', () => {
        const before = HELP_TOPICS.length;
        installVaultHelpTopic();
        expect(HELP_TOPICS).toHaveLength(before);
    });

    it('bundles real markdown with an H1', () => {
        const topic = HELP_TOPICS.find(t => t.id === 'saved-logins')!;
        expect(topic.markdown.trimStart().startsWith('# ')).toBe(true);
        expect(topic.markdown.length).toBeGreaterThan(500);
    });

    it('resolves its relative links to bundled topics', () => {
        const topic = HELP_TOPICS.find(t => t.id === 'saved-logins')!;
        for (const [, href] of topic.markdown.matchAll(/\]\(([^)]+)\)/g)) {
            if (/^https?:/i.test(href) || href.startsWith('#')) continue;
            expect(topicForHref(href), `saved-logins.md links to ${href}`).not.toBeNull();
        }
    });

    it('is findable by the things someone would search for', () => {
        for (const term of ['passphrase', 'passkey', 'forgotten', 'encrypted']) {
            expect(searchHelpTopics(term).map(t => t.id), term).toContain('saved-logins');
        }
    });

    it('does not promise a password reset', () => {
        const topic = HELP_TOPICS.find(t => t.id === 'saved-logins')!;
        expect(topic.markdown).toMatch(/no password reset/i);
    });
});
