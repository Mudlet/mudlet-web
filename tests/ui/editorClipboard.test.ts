// Issue #70 item 11: the editor had no copy, paste or duplicate — the item
// context menu offered only Export as Package…, Delete, Add <type> and Add
// Group. Desktop has Copy and Paste actions that round-trip an item and its
// subtree (dlgTriggerEditor.cpp:900-926, slot_copyXml :11777, slot_pasteXml
// :11913), and paste lands the copy as the sibling *after* the target.
import { describe, it, expect } from 'vitest';
import { cloneSubtree, collectSubtree } from '../../src/ui/windows/panels/editorClipboard';
import type { TriggerNode } from '../../src/storage/schema';

function trig(id: string, name: string, parentId: string | null, over: Partial<TriggerNode> = {}): TriggerNode {
    return {
        id, name, parentId, isGroup: false, enabled: true, language: 'lua', code: '',
        patterns: [{ type: 'substring', text: name }],
        fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false,
        ...over,
    };
}

// root
//  ├ head (group)
//  │   ├ kid-a
//  │   └ kid-b
//  └ other
const TREE: TriggerNode[] = [
    trig('head', 'head', null, { isGroup: true }),
    trig('kid-a', 'kid-a', 'head'),
    trig('kid-b', 'kid-b', 'head'),
    trig('other', 'other', null),
];

let n = 0;
const ids = () => `new-${++n}`;

describe('collectSubtree', () => {
    it('takes the item and every descendant, in list order', () => {
        expect(collectSubtree(TREE, 'head').map(t => t.id)).toEqual(['head', 'kid-a', 'kid-b']);
    });

    it('takes a leaf alone', () => {
        expect(collectSubtree(TREE, 'other').map(t => t.id)).toEqual(['other']);
    });

    it('closes over a child that sits before its parent in the array', () => {
        const reordered = [TREE[1], TREE[0], TREE[2]];
        expect(collectSubtree(reordered, 'head').map(t => t.id).sort()).toEqual(['head', 'kid-a', 'kid-b']);
    });
});

describe('cloneSubtree', () => {
    it('mints a fresh id for every node and rewires the parents to match', () => {
        n = 0;
        const clones = cloneSubtree(collectSubtree(TREE, 'head'), null, new Set(), ids);
        expect(clones.map(c => c.id)).toEqual(['new-1', 'new-2', 'new-3']);
        expect(clones[0].parentId).toBe(null);
        expect(clones[1].parentId).toBe('new-1');
        expect(clones[2].parentId).toBe('new-1');
    });

    it('re-parents the root without touching the descendants', () => {
        n = 0;
        const clones = cloneSubtree(collectSubtree(TREE, 'head'), 'somewhere-else', new Set(), ids);
        expect(clones[0].parentId).toBe('somewhere-else');
        expect(clones[1].parentId).toBe('new-1');
    });

    it('deep-copies, so editing a clone cannot reach the original', () => {
        const [clone] = cloneSubtree([TREE[3]], null, new Set(), ids);
        clone.patterns[0].text = 'changed';
        expect(TREE[3].patterns[0].text).toBe('other');
    });

    it('drops packageName, so uninstalling the package cannot delete the copy', () => {
        const owned = trig('p1', 'from-pkg', null, { packageName: 'some-package' });
        const [clone] = cloneSubtree([owned], null, new Set(), ids);
        expect('packageName' in clone).toBe(false);
    });

    it('keeps the name when nothing among the new siblings uses it', () => {
        const [clone] = cloneSubtree([TREE[3]], null, new Set(['head']), ids);
        expect(clone.name).toBe('other');
    });

    it('suffixes only the root when the name collides', () => {
        n = 0;
        const clones = cloneSubtree(collectSubtree(TREE, 'head'), null, new Set(['head', 'kid-a']), ids);
        expect(clones[0].name).toBe('head (copy)');
        // A descendant keeps its name — it lands beside its own siblings, not
        // beside the ones the collision was measured against.
        expect(clones[1].name).toBe('kid-a');
    });

    it('counts up when the copy name is taken too', () => {
        const [clone] = cloneSubtree([TREE[3]], null, new Set(['other', 'other (copy)', 'other (copy 2)']), ids);
        expect(clone.name).toBe('other (copy 3)');
    });

    it('returns nothing for an empty subtree', () => {
        expect(cloneSubtree([], null, new Set(), ids)).toEqual([]);
    });
});
