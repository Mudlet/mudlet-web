/**
 * Copy / paste / duplicate for editor items.
 *
 * Mudlet round-trips the item and its subtree through XML — `slot_copyXml`
 * (dlgTriggerEditor.cpp:11777) exports it to `mpHost->mpEditorDialog`'s
 * clipboard buffer and `slot_pasteXml` (:11913) imports it back, which is why
 * the paste mints fresh ids there too. mudix's nodes are plain objects, so the
 * same job is a structured clone with remapped ids; the clipboard is an
 * in-memory snapshot rather than XML text, which keeps it exact (no lossy
 * element set) at the cost of not surviving a page reload — Mudlet's doesn't
 * outlive its editor either.
 */
import type { EditorItemCategory, EditorItemNode } from './editorUndo';

export interface EditorClipboard {
    category: EditorItemCategory;
    /** The copied item followed by its descendants, in tree order. */
    nodes: EditorItemNode[];
    /** What the context menu says it will paste, e.g. `trigger "qa-sub"`. */
    label: string;
}

/**
 * The item plus every descendant, root first and the rest in `items` order.
 *
 * Root-first matters because {@link cloneSubtree} and the paste placement both
 * treat the first element as the item the user picked. Every producer happens
 * to keep parents ahead of children today, but the walk below explicitly does
 * not rely on that — so neither does this.
 */
export function collectSubtree<T extends { id: string; parentId: string | null }>(
    items: readonly T[],
    rootId: string,
): T[] {
    const ids = new Set<string>([rootId]);
    // Repeat until closed: a child can sit before its parent in the flat array.
    for (let added = true; added;) {
        added = false;
        for (const item of items) {
            if (item.parentId !== null && ids.has(item.parentId) && !ids.has(item.id)) {
                ids.add(item.id);
                added = true;
            }
        }
    }
    const found = items.filter(i => ids.has(i.id));
    const rootIndex = found.findIndex(i => i.id === rootId);
    if (rootIndex <= 0) return found;
    return [found[rootIndex], ...found.slice(0, rootIndex), ...found.slice(rootIndex + 1)];
}

/**
 * Copy `nodes` (a subtree, root first) under `newParentId` with fresh ids.
 *
 * `packageName` is dropped: uninstalling a package removes every item carrying
 * its name, so a copy that kept the tag would be deleted along with the
 * original the next time that package went away — and the package's own
 * manifest never listed the copy in the first place.
 *
 * `existingNames` are the names already in use among the new siblings; a
 * collision gets a " (copy)" suffix so the paste is visible in the tree rather
 * than looking like nothing happened.
 */
export function cloneSubtree<T extends EditorItemNode>(
    nodes: readonly T[],
    newParentId: string | null,
    existingNames: ReadonlySet<string>,
    newId: () => string = () => crypto.randomUUID(),
): T[] {
    if (nodes.length === 0) return [];
    // The root is the one node whose parent is outside the set — not simply
    // `nodes[0]`, so a caller that hands over an unordered subtree still gets
    // the right node re-parented and the right one uniqued.
    const ids = new Set(nodes.map(n => n.id));
    const rootId = (nodes.find(n => n.parentId === null || !ids.has(n.parentId)) ?? nodes[0]).id;
    const idMap = new Map<string, string>();
    for (const n of nodes) idMap.set(n.id, newId());

    // Root first, so the caller can select `clones[0]` and place the block from
    // it — mirroring what collectSubtree hands back.
    const ordered = [nodes.find(n => n.id === rootId)!, ...nodes.filter(n => n.id !== rootId)];
    return ordered.map((n, i) => {
        const clone = structuredClone(n) as T;
        clone.id = idMap.get(n.id)!;
        clone.parentId = n.id === rootId
            ? newParentId
            : (n.parentId !== null ? idMap.get(n.parentId) ?? newParentId : newParentId);
        delete (clone as { packageName?: string }).packageName;
        if (i === 0 && existingNames.has(clone.name)) clone.name = uniqueName(clone.name, existingNames);
        return clone;
    });
}

function uniqueName(name: string, taken: ReadonlySet<string>): string {
    const base = `${name} (copy)`;
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
        const candidate = `${name} (copy ${n})`;
        if (!taken.has(candidate)) return candidate;
    }
}
