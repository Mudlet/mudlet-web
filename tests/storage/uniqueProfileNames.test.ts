import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../../src/storage/appStore';
import { connectionNameTaken, uniqueConnectionName, type MudConnection } from '../../src/storage/schema';

/**
 * Profile names have to be unique, because `getProfiles()` is keyed by name and
 * every name-addressed script API (`getProfileInformation`, `setProfileInformation`,
 * …) resolves through one. Two profiles sharing a name would collapse to one
 * entry there and make those calls pick between them arbitrarily.
 *
 * The Add/Edit form refuses a clash outright so the user renames deliberately;
 * the store renames instead, because the paths that reach it directly — an
 * imported Mudlet folder or zip, a brand's seeded profile, a bundled game — have
 * nobody to ask and must not fail.
 */
const conns = (...names: string[]): MudConnection[] =>
    names.map((name, i) => ({ id: `id-${i}`, name, url: 'ws://x' }));

describe('connectionNameTaken', () => {
    it('ignores case, matching how the scripting API resolves a name', () => {
        expect(connectionNameTaken('achaea', conns('Achaea'))).toBe(true);
        expect(connectionNameTaken('ACHAEA', conns('Achaea'))).toBe(true);
        expect(connectionNameTaken('Aetolia', conns('Achaea'))).toBe(false);
    });

    it('ignores surrounding whitespace', () => {
        expect(connectionNameTaken('  Achaea  ', conns('Achaea'))).toBe(true);
    });

    it('does not count the profile being renamed against itself', () => {
        const existing = conns('Achaea');
        expect(connectionNameTaken('Achaea', existing, existing[0].id)).toBe(false);
    });

    // Otherwise an empty Name field would report "already taken" the moment a
    // second profile existed, instead of the form's own "required" handling.
    it('says nothing about an empty name', () => {
        expect(connectionNameTaken('', conns('Achaea'))).toBe(false);
        expect(connectionNameTaken('   ', conns('Achaea'))).toBe(false);
    });
});

describe('uniqueConnectionName', () => {
    it('leaves a free name alone', () => {
        expect(uniqueConnectionName('Aetolia', conns('Achaea'))).toBe('Aetolia');
    });

    it('counts up until it finds a gap', () => {
        expect(uniqueConnectionName('Achaea', conns('Achaea'))).toBe('Achaea (2)');
        expect(uniqueConnectionName('Achaea', conns('Achaea', 'Achaea (2)'))).toBe('Achaea (3)');
        // The gap is used rather than skipped past.
        expect(uniqueConnectionName('Achaea', conns('Achaea', 'Achaea (3)'))).toBe('Achaea (2)');
    });
});

describe('the store never holds two profiles with one name', () => {
    beforeEach(() => {
        useAppStore.setState({ connections: [] });
    });

    it('renames on add rather than refusing — an import has nobody to ask', () => {
        const store = useAppStore.getState();
        store.addConnection({ name: 'Achaea', url: 'ws://x' });
        const secondId = store.addConnection({ name: 'achaea', url: 'ws://y' });

        const names = useAppStore.getState().connections.map(c => c.name);
        expect(names).toEqual(['Achaea', 'achaea (2)']);
        // The id the caller was handed still resolves — a rename must not cost
        // the import its handle on what it just created.
        expect(useAppStore.getState().connections.find(c => c.id === secondId)).toBeTruthy();
    });

    it('renames on update, but lets a profile keep its own name', () => {
        const store = useAppStore.getState();
        store.addConnection({ name: 'Achaea', url: 'ws://x' });
        const second = store.addConnection({ name: 'Aetolia', url: 'ws://y' });

        // Saving Aetolia's form untouched must not turn it into "Aetolia (2)".
        useAppStore.getState().updateConnection(second, { name: 'Aetolia', url: 'ws://y' });
        expect(useAppStore.getState().connections.map(c => c.name)).toEqual(['Achaea', 'Aetolia']);

        useAppStore.getState().updateConnection(second, { name: 'Achaea', url: 'ws://y' });
        expect(useAppStore.getState().connections.map(c => c.name)).toEqual(['Achaea', 'Achaea (2)']);
    });

    it('guards a name patched in, and leaves other patches alone', () => {
        const store = useAppStore.getState();
        store.addConnection({ name: 'Achaea', url: 'ws://x' });
        const second = store.addConnection({ name: 'Aetolia', url: 'ws://y' });

        // The common case: a surgical patch that never mentions the name.
        useAppStore.getState().patchConnection(second, { icon: 'data:image/png;base64,AA' });
        expect(useAppStore.getState().connections.map(c => c.name)).toEqual(['Achaea', 'Aetolia']);

        useAppStore.getState().patchConnection(second, { name: 'Achaea' });
        expect(useAppStore.getState().connections.map(c => c.name)).toEqual(['Achaea', 'Achaea (2)']);
    });
});
