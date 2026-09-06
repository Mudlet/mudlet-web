import { describe, it, expect, beforeEach } from 'vitest';
import { HostCommandRegistry } from '../../src/ui/commands/hostCommands';
import { placeCommands, type PlacedCommand, type TopMenu } from '../../src/ui/menu/menuModel';

// `addCommand` for the app embedding this client. A white-label host could
// declare buttons in its BrandConfig at boot and nothing after, so a command
// that appears on login, or greys out mid-request, meant re-rendering the whole
// client with a new brand object.

const BUILTIN: TopMenu[] = [
    { id: 'toolbox', label: 'Toolbox', items: [{ kind: 'action', id: 'scripts', label: 'Script editor', run: () => {} }] },
];

describe('the host command registry', () => {
    let registry: HostCommandRegistry;
    beforeEach(() => { registry = new HostCommandRegistry(); });

    it('gives back an id that reaches the command afterwards', () => {
        const id = registry.add({ name: 'Sheet', onClick: () => {} });
        expect(registry.setChecked(id, true)).toBe(true);
        expect(registry.list()[0].checked).toBe(true);
        expect(registry.remove(id)).toBe(true);
        expect(registry.list()).toHaveLength(0);
    });

    it('takes the caller’s own id, so removal needs nothing remembered', () => {
        registry.add({ id: 'roll', name: 'Roll d20', onClick: () => {} });
        expect(registry.remove('roll')).toBe(true);
    });

    it('answers false for an id nobody knows rather than throwing', () => {
        expect(registry.remove('nothing')).toBe(false);
        expect(registry.setEnabled('nothing', false)).toBe(false);
        expect(registry.update('nothing', { name: 'x' })).toBe(false);
    });

    it('never reuses a generated id', () => {
        const first = registry.add({ name: 'One', onClick: () => {} });
        registry.remove(first);
        expect(registry.add({ name: 'Two', onClick: () => {} })).not.toBe(first);
    });

    it('defaults to both bars, enabled and unchecked', () => {
        registry.add({ name: 'Sheet', onClick: () => {} });
        expect(registry.list()[0]).toMatchObject({ surfaces: 'both', enabled: true, checked: false });
    });

    it('tells its subscribers, and hands React a stable snapshot between changes', () => {
        let calls = 0;
        registry.subscribe(() => { calls++; });
        const before = registry.list();
        expect(registry.list()).toBe(before);      // no change, same reference

        const id = registry.add({ name: 'Sheet', onClick: () => {} });
        expect(calls).toBe(1);
        expect(registry.list()).not.toBe(before);

        registry.setEnabled(id, false);
        expect(calls).toBe(2);
    });

    it('stops telling a subscriber that unsubscribed', () => {
        let calls = 0;
        const off = registry.subscribe(() => { calls++; });
        registry.add({ name: 'One', onClick: () => {} });
        off();
        registry.add({ name: 'Two', onClick: () => {} });
        expect(calls).toBe(1);
    });

    // The whole point of the merge: a host app's command is not a second-class
    // citizen of a package's, and a menu cannot tell them apart.
    it('places into a menu through the same path a package does', () => {
        const ran: string[] = [];
        registry.add({ id: 'sheet', name: 'Character sheet', menuPath: 'Realm', onClick: () => ran.push('sheet') });
        const placed: PlacedCommand[] = registry.list().map(c => ({
            id: `host:${c.id}`, name: c.name, menuPath: c.menuPath,
            enabled: c.enabled, checked: c.checked, run: () => c.onClick(null),
        }));
        const realm = placeCommands(BUILTIN, placed).find(m => m.label === 'Realm')!;
        expect(realm.items.map(i => i.kind === 'action' && i.label)).toEqual(['Character sheet']);
        const entry = realm.items[0];
        if (entry.kind !== 'action') throw new Error('unreachable');
        entry.run();
        expect(ran).toEqual(['sheet']);
    });
});
