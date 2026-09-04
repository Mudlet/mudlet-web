// The store half of the editor's delete-undo: the six `restoreX` actions that
// put deleted nodes back where they came from.
//
// Mudlet's EditorDeleteItemCommand::undo() re-imports each item from an XML
// snapshot at its recorded `positionInParent`, then has to fix up ids and
// parent references because the re-import mints new ones. mudix's ids are
// stable, so the original node objects go back at the indices they occupied in
// the flat per-connection array — which is where sibling order lives here.
import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../../src/storage';
import type { TriggerNode } from '../../src/storage/schema';

const CONN = 'conn-restore';

const node = (id: string, parentId: string | null = null): TriggerNode => ({
    id, name: id, enabled: true, isGroup: false, parentId, language: 'lua',
    code: '', patterns: [], fireLength: 0, multipleMatches: false,
    multiline: false, delta: 0, isFilter: false,
} as TriggerNode);

const ids = () => useAppStore.getState().connectionTriggers[CONN].map(t => t.id);

/** What the editor captures before deleting: every node in the subtree, with
 *  the index it occupied. */
function capture(rootId: string) {
    const list = useAppStore.getState().connectionTriggers[CONN];
    const set = new Set<string>([rootId]);
    for (let added = true; added;) {
        added = false;
        for (const n of list) {
            if (n.parentId !== null && set.has(n.parentId) && !set.has(n.id)) { set.add(n.id); added = true; }
        }
    }
    return list.flatMap((n, index) => set.has(n.id) ? [{ index, node: n }] : []);
}

describe('restoreTriggers', () => {
    beforeEach(() => {
        useAppStore.setState({
            connectionTriggers: { [CONN]: [
                node('a'), node('g'), node('g-child', 'g'), node('g-grandchild', 'g-child'), node('z'),
            ] },
        } as never);
    });

    it('puts a leaf back at the index it sat at', () => {
        const captured = capture('a');
        useAppStore.getState().removeTrigger(CONN, 'a');
        expect(ids()).toEqual(['g', 'g-child', 'g-grandchild', 'z']);

        useAppStore.getState().restoreTriggers(CONN, captured);
        expect(ids()).toEqual(['a', 'g', 'g-child', 'g-grandchild', 'z']);
    });

    it('restores a whole subtree at its original positions', () => {
        const captured = capture('g');
        expect(captured.map(e => e.node.id)).toEqual(['g', 'g-child', 'g-grandchild']);

        useAppStore.getState().removeTrigger(CONN, 'g');
        expect(ids()).toEqual(['a', 'z']);

        useAppStore.getState().restoreTriggers(CONN, captured);
        expect(ids()).toEqual(['a', 'g', 'g-child', 'g-grandchild', 'z']);
        // ...and the parent links are intact, so the tree rebuilds as it was.
        const byId = new Map(useAppStore.getState().connectionTriggers[CONN].map(t => [t.id, t]));
        expect(byId.get('g-child')!.parentId).toBe('g');
        expect(byId.get('g-grandchild')!.parentId).toBe('g-child');
    });

    it('restores an inner node to its exact index, not the end', () => {
        const captured = capture('g-child');
        useAppStore.getState().removeTrigger(CONN, 'g-child');
        expect(ids()).toEqual(['a', 'g', 'z']);

        useAppStore.getState().restoreTriggers(CONN, captured);
        expect(ids()).toEqual(['a', 'g', 'g-child', 'g-grandchild', 'z']);
    });

    it('cannot duplicate a node that is already present', () => {
        const captured = capture('a');
        useAppStore.getState().removeTrigger(CONN, 'a');
        useAppStore.getState().restoreTriggers(CONN, captured);
        useAppStore.getState().restoreTriggers(CONN, captured);
        expect(ids()).toEqual(['a', 'g', 'g-child', 'g-grandchild', 'z']);
    });

    it('leaves the list untouched when there is nothing to restore', () => {
        const before = useAppStore.getState().connectionTriggers[CONN];
        useAppStore.getState().restoreTriggers(CONN, []);
        expect(useAppStore.getState().connectionTriggers[CONN]).toBe(before);
    });
});

describe('the other five restore actions', () => {
    it('are wired to their own slices', () => {
        const s = useAppStore.getState();
        const entry = (id: string) => [{ index: 0, node: { id, name: id, enabled: true, isGroup: false, parentId: null, language: 'lua', code: '' } }];
        useAppStore.setState({
            connectionScripts: { [CONN]: [] }, connectionAliases: { [CONN]: [] },
            connectionTimers: { [CONN]: [] }, connectionKeybindings: { [CONN]: [] },
            connectionButtons: { [CONN]: [] },
        } as never);
        s.restoreScripts(CONN, entry('s1') as never);
        s.restoreAliases(CONN, entry('a1') as never);
        s.restoreTimers(CONN, entry('t1') as never);
        s.restoreKeybindings(CONN, entry('k1') as never);
        s.restoreButtons(CONN, entry('b1') as never);
        const now = useAppStore.getState();
        expect(now.connectionScripts[CONN].map(n => n.id)).toEqual(['s1']);
        expect(now.connectionAliases[CONN].map(n => n.id)).toEqual(['a1']);
        expect(now.connectionTimers[CONN].map(n => n.id)).toEqual(['t1']);
        expect(now.connectionKeybindings[CONN].map(n => n.id)).toEqual(['k1']);
        expect(now.connectionButtons[CONN].map(n => n.id)).toEqual(['b1']);
    });
});
