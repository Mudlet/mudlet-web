import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../../src/storage/appStore';
import { isNewProfile } from '../../src/import/defaultPackages';

/**
 * `updateConnection` full-replaces the record, because a form that empties a
 * field has to be able to clear it. That is wrong for the fields no form ever
 * renders: `createdAt` (stamped by `addConnection`) and the `mudletLinked` /
 * `mudletImported` provenance markers. Round-tripping a connection through the
 * Add/Edit form used to drop all three — a single Save retroactively turned a
 * new profile into a legacy one (`isNewProfile` reads `createdAt`) and silently
 * unlinked a folder-linked profile. See issue #53.
 */
describe('updateConnection preserves stamped provenance', () => {
    beforeEach(() => {
        useAppStore.setState({ connections: [] });
    });

    /** What ConnectionFormModal.buildData() produces: form state only. */
    const formData = (over: Record<string, unknown> = {}) => ({
        name: 'Achaea',
        mode: 'mud' as const,
        host: 'achaea.com',
        port: 23,
        ...over,
    });

    it('keeps createdAt across an edit that changes nothing', () => {
        const id = useAppStore.getState().addConnection(formData());
        const createdAt = useAppStore.getState().connections[0].createdAt;
        expect(createdAt).toBeTruthy();

        useAppStore.getState().updateConnection(id, formData());

        expect(useAppStore.getState().connections[0].createdAt).toBe(createdAt);
    });

    it('keeps the profile "new" for stockDefaults after an edit', () => {
        const id = useAppStore.getState().addConnection(formData());
        expect(isNewProfile(useAppStore.getState().connections[0])).toBe(true);

        useAppStore.getState().updateConnection(id, formData({ port: 5000 }));

        expect(isNewProfile(useAppStore.getState().connections[0])).toBe(true);
    });

    it('keeps mudletLinked and mudletImported, which no form renders', () => {
        const id = useAppStore.getState().addConnection(
            formData({ mudletLinked: true, mudletImported: true }),
        );

        useAppStore.getState().updateConnection(id, formData());

        const after = useAppStore.getState().connections[0];
        expect(after.mudletLinked).toBe(true);
        expect(after.mudletImported).toBe(true);
    });

    it('still lets an explicit value win, as addConnection does', () => {
        const id = useAppStore.getState().addConnection(formData());

        useAppStore.getState().updateConnection(id, formData({
            createdAt: '2020-01-01T00:00:00.000Z',
            mudletLinked: false,
        }));

        const after = useAppStore.getState().connections[0];
        expect(after.createdAt).toBe('2020-01-01T00:00:00.000Z');
        expect(after.mudletLinked).toBe(false);
    });

    // The reason the full replace exists in the first place: the form owns
    // these, so emptying one must clear it rather than resurrect the old value.
    it('still clears form-owned fields the edit dropped', () => {
        const id = useAppStore.getState().addConnection(
            formData({ proxyUrl: 'wss://old.example', description: 'notes', tls: true }),
        );

        useAppStore.getState().updateConnection(id, formData());

        const after = useAppStore.getState().connections[0];
        expect(after.proxyUrl).toBeUndefined();
        expect(after.description).toBeUndefined();
        expect(after.tls).toBeUndefined();
    });
});
