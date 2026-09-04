/**
 * The script editor's item-level undo stack.
 *
 * Mudlet's editor deletes immediately and never asks; what makes that safe is
 * that every delete path builds an `EditorDeleteItemCommand` and pushes it onto
 * the editor's own `EditorUndoStack` (dlgTriggerEditor.cpp:3714 for triggers,
 * and the same at :3089 aliases, :3237 buttons, :3441 scripts, :3575 keys,
 * :3848 timers), reachable from Ctrl+Z. This is that stack, minus the parts
 * Mudlet only needs because of how it stores items:
 *
 *  * Mudlet snapshots each deleted item to XML and re-imports it on undo, which
 *    mints fresh ids — hence the id remapping, the `remapItemID` plumbing and
 *    the child-id fix-up loops all over `EditorDeleteItemCommand::undo()`.
 *    mudix's nodes are plain objects with stable string ids, so the very same
 *    objects go back and none of that is needed.
 *  * Mudlet restores parents before children (a topological sort) because a
 *    child needs a live parent pointer. Here the tree is a flat array plus
 *    `parentId`, so restoring the whole subtree at its recorded indices
 *    reproduces it in one step, in any order.
 */
import type { AliasNode, ButtonNode, KeyNode, ScriptNode, TimerNode, TriggerNode } from '../../../storage/schema';
import type { RestoredNode } from '../../../storage/appStore';

/** The six editor views that hold deletable items. Mirrors Mudlet's
 *  EditorViewType minus the varUnit view, which has no delete command. */
export type EditorItemCategory = 'scripts' | 'aliases' | 'triggers' | 'timers' | 'keys' | 'buttons';

export type EditorItemNode = ScriptNode | AliasNode | TriggerNode | TimerNode | KeyNode | ButtonNode;

/** Mudlet caps the editor stack at 50 commands (`setUndoLimit(50)`,
 *  dlgTriggerEditor.cpp:457). */
export const EDITOR_UNDO_LIMIT = 50;

/**
 * One reversible edit to the item tree.
 *
 * `delete` and `insert` are the same record read in opposite directions: both
 * hold every node involved plus the index it occupied, so undoing one is
 * redoing the other. Mudlet only ever pushes deletions here, but a paste that
 * cannot be undone makes Ctrl+Z do something unrelated to what the user just
 * did — so pastes and duplicates go on the same stack.
 */
export interface EditorItemCommand {
    kind: 'delete' | 'insert';
    category: EditorItemCategory;
    /** Every node the command covers — the item and its whole subtree — each
     *  with the index it occupied in the category's flat list. */
    entries: ReadonlyArray<RestoredNode<EditorItemNode>>;
    /** Undo-menu wording, e.g. `delete trigger "qa-sub"`. Mirrors
     *  `EditorDeleteItemCommand::generateText`. */
    label: string;
}

const SINGULAR: Record<EditorItemCategory, string> = {
    scripts: 'script', aliases: 'alias', triggers: 'trigger',
    timers: 'timer', keys: 'key', buttons: 'button',
};

const PLURAL: Record<EditorItemCategory, string> = {
    scripts: 'scripts', aliases: 'aliases', triggers: 'triggers',
    timers: 'timers', keys: 'keys', buttons: 'buttons',
};

/**
 * The item plus every descendant, paired with the index each occupies in
 * `items` — exactly the set the store's `removeX` actions drop (they take the
 * same `id` + `getDescendantIds` closure), so the capture and the removal can
 * never disagree.
 *
 * Mudlet's `captureTriggerAndChildren` lambda (dlgTriggerEditor.cpp:3616) does
 * the same walk, recording `positionInParent` because its tree is real
 * parent/child widgets. Here sibling order lives in the flat array, so the flat
 * index is the position worth keeping.
 */
export function captureDeletion<T extends { id: string; parentId: string | null }>(
    items: readonly T[],
    id: string,
): RestoredNode<T>[] {
    const ids = new Set<string>([id]);
    // Repeat until no new descendants appear: a child may sit before its parent
    // in the array, so a single pass could miss it.
    for (let added = true; added;) {
        added = false;
        for (const item of items) {
            if (item.parentId !== null && ids.has(item.parentId) && !ids.has(item.id)) {
                ids.add(item.id);
                added = true;
            }
        }
    }
    const entries: RestoredNode<T>[] = [];
    items.forEach((node, index) => { if (ids.has(node.id)) entries.push({ index, node }); });
    return entries;
}

/** `delete trigger "qa-sub"` / `delete 4 triggers`, following
 *  `EditorDeleteItemCommand::generateText` — including its choice to count the
 *  captured descendants, not just the item the user picked. */
export function describeDeletion(
    category: EditorItemCategory,
    entries: ReadonlyArray<{ node: { name: string } }>,
): string {
    return describeCommand('delete', category, entries);
}

/** The same wording for the other direction — `paste trigger "qa-sub"`. */
export function describeInsertion(
    category: EditorItemCategory,
    entries: ReadonlyArray<{ node: { name: string } }>,
): string {
    return describeCommand('paste', category, entries);
}

function describeCommand(
    verb: string,
    category: EditorItemCategory,
    entries: ReadonlyArray<{ node: { name: string } }>,
): string {
    if (entries.length === 1) {
        return `${verb} ${SINGULAR[category]} "${entries[0].node.name}"`;
    }
    return `${verb} ${entries.length} ${PLURAL[category]}`;
}

/** Push onto a stack held at Mudlet's 50-command limit, dropping the oldest. */
export function pushBounded<T>(stack: readonly T[], command: T): T[] {
    const next = [...stack, command];
    return next.length > EDITOR_UNDO_LIMIT ? next.slice(next.length - EDITOR_UNDO_LIMIT) : next;
}
