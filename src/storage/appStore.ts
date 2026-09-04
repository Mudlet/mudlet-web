import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { APP_DEFAULTS, type AppSchema, type MudConnection, type AliasNode, type ButtonNode, type KeyNode, type TimerNode, type TriggerNode, type ScriptNode, type ScriptEditorBounds, type ModalBounds, type ClientSettings, type ProfileSettings, type PackageManifest, type WindowLayoutSnapshot, type ProfileVariables, uniqueConnectionName } from './schema';
import type { MudletVariable } from '../import/mudletVariables';
import type { MudletImportResult } from '../import/mudletXmlImport';
import type { WindowOpenOptions } from '../ui/windows/types';
import { createDebouncedJsonStorage } from './debouncedStorage';
import { deleteProfileStorage, MIGRATION_BACKUP_KEY } from './profileStorage';
import { getVault } from '../vault/vaultAccess';

function getDescendantIds(id: string, items: { id: string; parentId: string | null }[]): string[] {
    const result: string[] = [];
    const queue = [id];
    while (queue.length > 0) {
        const current = queue.shift()!;
        for (const item of items) {
            if (item.parentId === current) {
                result.push(item.id);
                queue.push(item.id);
            }
        }
    }
    return result;
}

/** Moves item `id` (and its whole subtree) to a new parent, inserting before `insertBeforeId`. */
function moveInList<T extends { id: string; parentId: string | null }>(
    items: T[],
    id: string,
    newParentId: string | null,
    insertBeforeId: string | null,
): T[] {
    const subtreeIds = new Set([id, ...getDescendantIds(id, items)]);
    const subtree = items.filter(i => subtreeIds.has(i.id));
    const rest = items.filter(i => !subtreeIds.has(i.id));
    const moved = subtree.map(i => i.id === id ? { ...i, parentId: newParentId } : i);
    if (insertBeforeId === null) return [...rest, ...moved];
    const idx = rest.findIndex(i => i.id === insertBeforeId);
    if (idx === -1) return [...rest, ...moved];
    return [...rest.slice(0, idx), ...moved, ...rest.slice(idx)];
}

interface AppStore extends AppSchema {
    /** Adds a connection and returns its newly generated id (so callers can
     *  immediately attach per-profile data like saved login credentials). */
    addConnection: (data: Omit<MudConnection, 'id'>) => string;
    updateConnection: (id: string, data: Omit<MudConnection, 'id'>) => void;
    /** Partial update preserving fields the patch doesn't mention. Used for
     *  surgical edits (icon, login creds) that must not wipe the rest of the
     *  connection record. Keys set to `undefined` are removed. */
    patchConnection: (id: string, patch: Partial<Omit<MudConnection, 'id'>>) => void;
    removeConnection: (id: string) => void;
    /** Reorder the profile list to match `orderedIds`. Ids not present in the
     *  list are ignored; any existing connection missing from `orderedIds` is
     *  appended in its current relative order (so a stale list can't drop
     *  profiles). Backs drag-to-rearrange on the connection screen. */
    reorderConnections: (orderedIds: string[]) => void;
    patchClient: (patch: Partial<ClientSettings>) => void;
    patchConnectionProfile: (connectionId: string, patch: Partial<ProfileSettings>) => void;
    saveWindowHint: (connectionId: string, panelId: string, hint: WindowOpenOptions) => void;
    clearWindowHints: (connectionId: string) => void;
    saveDockExtents: (connectionId: string, extents: Record<string, number>) => void;
    saveLayoutSnapshot: (connectionId: string, snapshot: WindowLayoutSnapshot) => void;
    /** Replace the set of global names flagged to persist (Mudlet save-list).
     *  Edited from the Variables view; triggers a profile-data save. */
    setVariableSaveList: (connectionId: string, saveList: string[]) => void;
    /** Replace the captured variable values without disturbing the save-list
     *  reference — so the engine can refresh them on save without re-triggering
     *  the save subscription (which keys on the save-list, not values). */
    setVariableValues: (connectionId: string, values: MudletVariable[]) => void;
    addScript: (connectionId: string, data: Omit<ScriptNode, 'id'>) => string;
    updateScript: (connectionId: string, id: string, patch: Partial<Omit<ScriptNode, 'id'>>) => void;
    removeScript: (connectionId: string, id: string) => void;
    addAlias: (connectionId: string, data: Omit<AliasNode, 'id'>) => string;
    updateAlias: (connectionId: string, id: string, patch: Partial<Omit<AliasNode, 'id'>>) => void;
    updateAliases: (connectionId: string, patches: ReadonlyArray<{ id: string; patch: Partial<Omit<AliasNode, 'id'>> }>) => void;
    removeAlias: (connectionId: string, id: string) => void;
    addTrigger: (connectionId: string, data: Omit<TriggerNode, 'id'>) => string;
    updateTrigger: (connectionId: string, id: string, patch: Partial<Omit<TriggerNode, 'id'>>) => void;
    /** Bulk apply enabled/disabled (or any partial) to many triggers in one set(). */
    updateTriggers: (connectionId: string, patches: ReadonlyArray<{ id: string; patch: Partial<Omit<TriggerNode, 'id'>> }>) => void;
    removeTrigger: (connectionId: string, id: string) => void;
    removeTriggers: (connectionId: string, ids: ReadonlyArray<string>) => void;
    addTimer: (connectionId: string, data: Omit<TimerNode, 'id'>) => string;
    updateTimer: (connectionId: string, id: string, patch: Partial<Omit<TimerNode, 'id'>>) => void;
    updateTimers: (connectionId: string, patches: ReadonlyArray<{ id: string; patch: Partial<Omit<TimerNode, 'id'>> }>) => void;
    removeTimer: (connectionId: string, id: string) => void;
    removeTimers: (connectionId: string, ids: ReadonlyArray<string>) => void;
    removeAliases: (connectionId: string, ids: ReadonlyArray<string>) => void;
    addKeybinding: (connectionId: string, data: Omit<KeyNode, 'id'>) => string;
    updateKeybinding: (connectionId: string, id: string, patch: Partial<Omit<KeyNode, 'id'>>) => void;
    removeKeybinding: (connectionId: string, id: string) => void;
    removeKeybindings: (connectionId: string, ids: ReadonlyArray<string>) => void;
    addButton: (connectionId: string, data: Omit<ButtonNode, 'id'>) => string;
    updateButton: (connectionId: string, id: string, patch: Partial<Omit<ButtonNode, 'id'>>) => void;
    removeButton: (connectionId: string, id: string) => void;
    moveScript: (connectionId: string, id: string, newParentId: string | null, insertBeforeId: string | null) => void;
    moveAlias: (connectionId: string, id: string, newParentId: string | null, insertBeforeId: string | null) => void;
    moveTrigger: (connectionId: string, id: string, newParentId: string | null, insertBeforeId: string | null) => void;
    moveTimer: (connectionId: string, id: string, newParentId: string | null, insertBeforeId: string | null) => void;
    moveKeybinding: (connectionId: string, id: string, newParentId: string | null, insertBeforeId: string | null) => void;
    moveButton: (connectionId: string, id: string, newParentId: string | null, insertBeforeId: string | null) => void;
    saveScriptEditorBounds: (connectionId: string, bounds: ScriptEditorBounds) => void;
    saveModalBounds: (connectionId: string, key: string, bounds: ModalBounds) => void;
    installPackage: (connectionId: string, manifest: PackageManifest, data: MudletImportResult) => void;
    uninstallPackage: (connectionId: string, packageName: string) => void;
    updatePackageManifest: (connectionId: string, packageName: string, patch: Partial<Omit<PackageManifest, 'name'>>) => void;
    /** Replace the VFS-persisted automation slices for one connection in a single
     *  set(). Called once on profile open, after its VFS mounts, to seed the
     *  store from `.mudix/profile.json`. Missing keys reset to empty arrays. */
    hydrateConnectionData: (connectionId: string, data: PersistedConnectionData) => void;
}

/** The per-connection slices persisted in the profile VFS (see profileVfsData.ts). */
interface PersistedConnectionData {
    scripts?: ScriptNode[];
    aliases?: AliasNode[];
    triggers?: TriggerNode[];
    timers?: TimerNode[];
    keybindings?: KeyNode[];
    buttons?: ButtonNode[];
    packages?: PackageManifest[];
    // UI / settings / layout slices (one profile's entry from each shared map).
    // Only applied when present — an absent slice leaves the store value as-is.
    profile?: Partial<ProfileSettings>;
    windowHints?: Record<string, WindowOpenOptions>;
    dockExtents?: Record<string, number>;
    scriptEditorBounds?: ScriptEditorBounds;
    modalBounds?: Record<string, ModalBounds>;
    layoutSnapshot?: WindowLayoutSnapshot;
    variables?: ProfileVariables;
}

/** localStorage key + schema version for the persisted store. Exported so the
 *  cross-tab sync (crossTabSync.ts) can match `storage` events to this store and
 *  reject writes from a different schema version. */
export const MUDIX_STORE_NAME = 'mudix_v1';
export const MUDIX_STORE_VERSION = 21;

/** One-time localStorage key holding pre-v21 per-profile UI/layout/settings
 *  slices, stashed by the v21 migration so they can be moved into each profile's
 *  VFS (.mudix/profile.json) the first time it's opened. Kept separate from the
 *  persisted store blob so editing the connections list (which rewrites the
 *  blob) can't drop un-migrated profiles' data. Consumed per-profile by
 *  loadProfileData, then removed when empty. Defined next to the rest of the
 *  per-profile storage inventory so profile deletion can sweep it. */
export { MIGRATION_BACKUP_KEY };

/** The subset of AppSchema actually persisted to localStorage (see `partialize`).
 *  Only the global index lives here now — the connection list and global client
 *  settings. Every per-profile slice (automation + UI/settings/layout) lives in
 *  that profile's VFS instead, so each profile is single-writer across tabs. */
type PersistedAppSchema = Pick<AppSchema, 'connections' | 'client'>;

/**
 * Connection fields that are *stamped*, never edited.
 *
 * `updateConnection` full-replaces the record, which is right for everything a
 * form owns — emptying a field has to clear it — but wrong for the provenance
 * markers, which no form renders and which therefore cannot survive a
 * round-trip through one. `createdAt` (schema.ts) is the discriminator
 * `stockDefaults`/`isNewProfile` read to keep the starter UI off established
 * profiles, so losing it retroactively turns a new profile into a legacy one;
 * `mudletLinked`/`mudletImported` mark a Mudlet-originated profile as owning
 * its own package set, so losing those silently unlinks a linked folder.
 *
 * An explicit value in `data` still wins — same precedence `addConnection`
 * gives `data.createdAt`, so a profile import/copy can set them deliberately.
 * Unlinking goes through `patchConnection` (see App.tsx), which is unaffected.
 */
const PROVENANCE_FIELDS = ['createdAt', 'mudletLinked', 'mudletImported'] as const;

function carriedProvenance(prev: MudConnection, data: Omit<MudConnection, 'id'>): Partial<MudConnection> {
    const carried: Partial<MudConnection> = {};
    for (const key of PROVENANCE_FIELDS) {
        const value = data[key] ?? prev[key];
        if (value !== undefined) Object.assign(carried, { [key]: value });
    }
    return carried;
}

export const useAppStore = create<AppStore>()(
    persist(
        set => ({
            ...APP_DEFAULTS,
            addConnection: data => {
                const id = crypto.randomUUID();
                // createdAt is stamped here and only here: its absence is the
                // marker for "profile predates the field" that stockDefaults
                // reads to keep the starter UI off established profiles. An
                // explicit createdAt in `data` (profile import/copy) wins.
                const createdAt = data.createdAt ?? new Date().toISOString();
                // Renamed rather than refused: an import or a brand's seeded
                // profile has no form to send the user back to, and must not
                // fail on a name clash — but two profiles sharing a name would
                // collapse to one in getProfiles() and make every name-addressed
                // script API pick between them arbitrarily. The Add/Edit form
                // catches a clash before it gets here (see ConnectionFormModal),
                // so a user typing a name still sees it rather than a rename.
                set(s => ({
                    connections: [
                        ...s.connections,
                        { ...data, name: uniqueConnectionName(data.name, s.connections), createdAt, id },
                    ],
                }));
                return id;
            },
            updateConnection: (id, data) => set(s => ({
                connections: s.connections.map(c => c.id === id
                    ? {
                        ...data,
                        ...carriedProvenance(c, data),
                        name: uniqueConnectionName(data.name, s.connections, id),
                        id,
                    }
                    : c),
            })),
            reorderConnections: orderedIds => set(s => {
                const byId = new Map(s.connections.map(c => [c.id, c]));
                const seen = new Set<string>();
                const next: MudConnection[] = [];
                for (const id of orderedIds) {
                    const c = byId.get(id);
                    if (c && !seen.has(id)) { next.push(c); seen.add(id); }
                }
                // Preserve any connection the caller's list forgot about.
                for (const c of s.connections) if (!seen.has(c.id)) next.push(c);
                return { connections: next };
            }),
            patchConnection: (id, patch) => set(s => ({
                connections: s.connections.map(c => {
                    if (c.id !== id) return c;
                    const next = { ...c, ...patch };
                    // Only when the patch names one: the usual callers here are
                    // surgical (icon, login creds) and must not pay for a scan,
                    // nor be renamed by a field they never touched.
                    if (patch.name !== undefined) {
                        next.name = uniqueConnectionName(patch.name, s.connections, id);
                    }
                    for (const k of Object.keys(patch) as (keyof Omit<MudConnection, 'id'>)[]) {
                        if (patch[k] === undefined) delete next[k];
                    }
                    return next;
                }),
            })),
            removeConnection: id => set(s => {
                // Everything this profile owns outside the store — its VFS
                // database, map, linked-folder handle, logs and per-profile
                // localStorage keys — lives in IndexedDB and has to be erased
                // separately, or it becomes an unreachable orphan against the
                // origin's quota: the id is regenerated for the next profile,
                // so nothing in the UI can ever get back to it. All of it is
                // addressed by `id`, so no other profile is touched. See
                // storage/profileStorage for the inventory. Best-effort and
                // not awaited; the store update below is synchronous.
                void deleteProfileStorage(id).catch(() => {});
                // Same for a saved password in the credential vault. A locked
                // vault can't rewrite its ciphertext, so the entry is swept on
                // the next unlock instead (CredentialVault.pruneMissing).
                void getVault()?.forgetConnection(id).catch(() => {});
                const { [id]: _h, ...restHints } = s.connectionWindowHints;
                const { [id]: _e, ...restExtents } = s.connectionDockExtents;
                const { [id]: _sc, ...restScripts } = s.connectionScripts;
                const { [id]: _al, ...restAliases } = s.connectionAliases;
                const { [id]: _tr, ...restTriggers } = s.connectionTriggers;
                const { [id]: _ti, ...restTimers } = s.connectionTimers;
                const { [id]: _kb, ...restKeybindings } = s.connectionKeybindings;
                const { [id]: _bt, ...restButtons } = s.connectionButtons;
                const { [id]: _sb, ...restBounds } = s.connectionScriptEditorBounds;
                const { [id]: _mb, ...restModalBounds } = s.connectionModalBounds;
                const { [id]: _ui, ...restProfile } = s.connectionProfile;
                const { [id]: _ls, ...restLayoutSnapshots } = s.connectionLayoutSnapshots;
                const { [id]: _vr, ...restVariables } = s.connectionVariables;
                return {
                    connections: s.connections.filter(c => c.id !== id),
                    connectionProfile: restProfile,
                    connectionWindowHints: restHints,
                    connectionDockExtents: restExtents,
                    connectionScripts: restScripts,
                    connectionAliases: restAliases,
                    connectionTriggers: restTriggers,
                    connectionTimers: restTimers,
                    connectionKeybindings: restKeybindings,
                    connectionButtons: restButtons,
                    connectionScriptEditorBounds: restBounds,
                    connectionModalBounds: restModalBounds,
                    connectionPackages: ((): Record<string, PackageManifest[]> => {
                        const { [id]: _pk, ...rest } = s.connectionPackages;
                        return rest;
                    })(),
                    connectionLayoutSnapshots: restLayoutSnapshots,
                    connectionVariables: restVariables,
                };
            }),
            patchClient: patch => set(s => ({ client: { ...s.client, ...patch } })),
            patchConnectionProfile: (connectionId, patch) => set(s => {
                // Treat `undefined` as "remove the override" so callers can
                // restore fall-through to PROFILE_DEFAULTS (e.g. Mudlet's
                // resetBorderColor clearing outputBorderColor).
                const prev = s.connectionProfile[connectionId] ?? {};
                const next: Partial<ProfileSettings> = { ...prev, ...patch };
                for (const k of Object.keys(patch) as (keyof ProfileSettings)[]) {
                    if (patch[k] === undefined) delete next[k];
                }
                return { connectionProfile: { ...s.connectionProfile, [connectionId]: next } };
            }),
            saveWindowHint: (connectionId, panelId, hint) => set(s => ({
                connectionWindowHints: {
                    ...s.connectionWindowHints,
                    [connectionId]: { ...(s.connectionWindowHints[connectionId] ?? {}), [panelId]: hint },
                },
            })),
            clearWindowHints: (connectionId) => set(s => {
                const { [connectionId]: _, ...rest } = s.connectionWindowHints;
                return { connectionWindowHints: rest };
            }),
            saveDockExtents: (connectionId, extents) => set(s => ({
                connectionDockExtents: {
                    ...s.connectionDockExtents,
                    [connectionId]: extents,
                },
            })),
            saveLayoutSnapshot: (connectionId, snapshot) => set(s => ({
                connectionLayoutSnapshots: {
                    ...s.connectionLayoutSnapshots,
                    [connectionId]: snapshot,
                },
            })),
            addScript: (connectionId, data) => {
                const id = crypto.randomUUID();
                set(s => ({
                    connectionScripts: {
                        ...s.connectionScripts,
                        [connectionId]: [...(s.connectionScripts[connectionId] ?? []), { ...data, id }],
                    },
                }));
                return id;
            },
            updateScript: (connectionId, id, patch) => set(s => ({
                connectionScripts: {
                    ...s.connectionScripts,
                    [connectionId]: (s.connectionScripts[connectionId] ?? []).map(
                        sc => sc.id === id ? { ...sc, ...patch } : sc,
                    ),
                },
            })),
            removeScript: (connectionId, id) => set(s => {
                const current = s.connectionScripts[connectionId] ?? [];
                const toRemove = new Set([id, ...getDescendantIds(id, current)]);
                return {
                    connectionScripts: {
                        ...s.connectionScripts,
                        [connectionId]: current.filter(sc => !toRemove.has(sc.id)),
                    },
                };
            }),
            addAlias: (connectionId, data) => {
                const id = crypto.randomUUID();
                set(s => ({
                    connectionAliases: {
                        ...s.connectionAliases,
                        [connectionId]: [...(s.connectionAliases[connectionId] ?? []), { ...data, id }],
                    },
                }));
                return id;
            },
            updateAlias: (connectionId, id, patch) => set(s => ({
                connectionAliases: {
                    ...s.connectionAliases,
                    [connectionId]: (s.connectionAliases[connectionId] ?? []).map(
                        a => a.id === id ? { ...a, ...patch } : a,
                    ),
                },
            })),
            updateAliases: (connectionId, patches) => set(s => {
                if (patches.length === 0) return {};
                const byId = new Map(patches.map(p => [p.id, p.patch] as const));
                return {
                    connectionAliases: {
                        ...s.connectionAliases,
                        [connectionId]: (s.connectionAliases[connectionId] ?? []).map(
                            a => byId.has(a.id) ? { ...a, ...byId.get(a.id) } : a,
                        ),
                    },
                };
            }),
            removeAlias: (connectionId, id) => set(s => {
                const current = s.connectionAliases[connectionId] ?? [];
                const toRemove = new Set([id, ...getDescendantIds(id, current)]);
                return {
                    connectionAliases: {
                        ...s.connectionAliases,
                        [connectionId]: current.filter(a => !toRemove.has(a.id)),
                    },
                };
            }),
            removeAliases: (connectionId, ids) => set(s => {
                if (ids.length === 0) return {};
                const current = s.connectionAliases[connectionId] ?? [];
                const toRemove = new Set<string>();
                for (const id of ids) {
                    toRemove.add(id);
                    for (const d of getDescendantIds(id, current)) toRemove.add(d);
                }
                return {
                    connectionAliases: {
                        ...s.connectionAliases,
                        [connectionId]: current.filter(a => !toRemove.has(a.id)),
                    },
                };
            }),
            addTrigger: (connectionId, data) => {
                const id = crypto.randomUUID();
                set(s => ({
                    connectionTriggers: {
                        ...s.connectionTriggers,
                        [connectionId]: [...(s.connectionTriggers[connectionId] ?? []), { ...data, id }],
                    },
                }));
                return id;
            },
            updateTrigger: (connectionId, id, patch) => set(s => ({
                connectionTriggers: {
                    ...s.connectionTriggers,
                    [connectionId]: (s.connectionTriggers[connectionId] ?? []).map(
                        t => t.id === id ? { ...t, ...patch } : t,
                    ),
                },
            })),
            updateTriggers: (connectionId, patches) => set(s => {
                if (patches.length === 0) return {};
                const byId = new Map(patches.map(p => [p.id, p.patch] as const));
                return {
                    connectionTriggers: {
                        ...s.connectionTriggers,
                        [connectionId]: (s.connectionTriggers[connectionId] ?? []).map(
                            t => byId.has(t.id) ? { ...t, ...byId.get(t.id) } : t,
                        ),
                    },
                };
            }),
            removeTrigger: (connectionId, id) => set(s => {
                const current = s.connectionTriggers[connectionId] ?? [];
                const toRemove = new Set([id, ...getDescendantIds(id, current)]);
                return {
                    connectionTriggers: {
                        ...s.connectionTriggers,
                        [connectionId]: current.filter(t => !toRemove.has(t.id)),
                    },
                };
            }),
            removeTriggers: (connectionId, ids) => set(s => {
                if (ids.length === 0) return {};
                const current = s.connectionTriggers[connectionId] ?? [];
                const toRemove = new Set<string>();
                for (const id of ids) {
                    toRemove.add(id);
                    for (const d of getDescendantIds(id, current)) toRemove.add(d);
                }
                return {
                    connectionTriggers: {
                        ...s.connectionTriggers,
                        [connectionId]: current.filter(t => !toRemove.has(t.id)),
                    },
                };
            }),
            addTimer: (connectionId, data) => {
                const id = crypto.randomUUID();
                set(s => ({
                    connectionTimers: {
                        ...s.connectionTimers,
                        [connectionId]: [...(s.connectionTimers[connectionId] ?? []), { ...data, id }],
                    },
                }));
                return id;
            },
            updateTimer: (connectionId, id, patch) => set(s => ({
                connectionTimers: {
                    ...s.connectionTimers,
                    [connectionId]: (s.connectionTimers[connectionId] ?? []).map(
                        t => t.id === id ? { ...t, ...patch } : t,
                    ),
                },
            })),
            updateTimers: (connectionId, patches) => set(s => {
                if (patches.length === 0) return {};
                const byId = new Map(patches.map(p => [p.id, p.patch] as const));
                return {
                    connectionTimers: {
                        ...s.connectionTimers,
                        [connectionId]: (s.connectionTimers[connectionId] ?? []).map(
                            t => byId.has(t.id) ? { ...t, ...byId.get(t.id) } : t,
                        ),
                    },
                };
            }),
            removeTimer: (connectionId, id) => set(s => {
                const current = s.connectionTimers[connectionId] ?? [];
                const toRemove = new Set([id, ...getDescendantIds(id, current)]);
                return {
                    connectionTimers: {
                        ...s.connectionTimers,
                        [connectionId]: current.filter(t => !toRemove.has(t.id)),
                    },
                };
            }),
            removeTimers: (connectionId, ids) => set(s => {
                if (ids.length === 0) return {};
                const current = s.connectionTimers[connectionId] ?? [];
                const toRemove = new Set<string>();
                for (const id of ids) {
                    toRemove.add(id);
                    for (const d of getDescendantIds(id, current)) toRemove.add(d);
                }
                return {
                    connectionTimers: {
                        ...s.connectionTimers,
                        [connectionId]: current.filter(t => !toRemove.has(t.id)),
                    },
                };
            }),
            addKeybinding: (connectionId, data) => {
                const id = crypto.randomUUID();
                set(s => ({
                    connectionKeybindings: {
                        ...s.connectionKeybindings,
                        [connectionId]: [...(s.connectionKeybindings[connectionId] ?? []), { ...data, id }],
                    },
                }));
                return id;
            },
            updateKeybinding: (connectionId, id, patch) => set(s => ({
                connectionKeybindings: {
                    ...s.connectionKeybindings,
                    [connectionId]: (s.connectionKeybindings[connectionId] ?? []).map(
                        k => k.id === id ? { ...k, ...patch } : k,
                    ),
                },
            })),
            removeKeybinding: (connectionId, id) => set(s => {
                const current = s.connectionKeybindings[connectionId] ?? [];
                const toRemove = new Set([id, ...getDescendantIds(id, current)]);
                return {
                    connectionKeybindings: {
                        ...s.connectionKeybindings,
                        [connectionId]: current.filter(k => !toRemove.has(k.id)),
                    },
                };
            }),
            removeKeybindings: (connectionId, ids) => set(s => {
                if (ids.length === 0) return {};
                const current = s.connectionKeybindings[connectionId] ?? [];
                const toRemove = new Set<string>();
                for (const id of ids) {
                    toRemove.add(id);
                    for (const d of getDescendantIds(id, current)) toRemove.add(d);
                }
                return {
                    connectionKeybindings: {
                        ...s.connectionKeybindings,
                        [connectionId]: current.filter(k => !toRemove.has(k.id)),
                    },
                };
            }),
            addButton: (connectionId, data) => {
                const id = crypto.randomUUID();
                set(s => ({
                    connectionButtons: {
                        ...s.connectionButtons,
                        [connectionId]: [...(s.connectionButtons[connectionId] ?? []), { ...data, id }],
                    },
                }));
                return id;
            },
            updateButton: (connectionId, id, patch) => set(s => ({
                connectionButtons: {
                    ...s.connectionButtons,
                    [connectionId]: (s.connectionButtons[connectionId] ?? []).map(
                        b => b.id === id ? { ...b, ...patch } : b,
                    ),
                },
            })),
            removeButton: (connectionId, id) => set(s => {
                const current = s.connectionButtons[connectionId] ?? [];
                const toRemove = new Set([id, ...getDescendantIds(id, current)]);
                return {
                    connectionButtons: {
                        ...s.connectionButtons,
                        [connectionId]: current.filter(b => !toRemove.has(b.id)),
                    },
                };
            }),
            moveScript: (connectionId, id, newParentId, insertBeforeId) => set(s => ({
                connectionScripts: {
                    ...s.connectionScripts,
                    [connectionId]: moveInList(s.connectionScripts[connectionId] ?? [], id, newParentId, insertBeforeId),
                },
            })),
            moveAlias: (connectionId, id, newParentId, insertBeforeId) => set(s => ({
                connectionAliases: {
                    ...s.connectionAliases,
                    [connectionId]: moveInList(s.connectionAliases[connectionId] ?? [], id, newParentId, insertBeforeId),
                },
            })),
            moveTrigger: (connectionId, id, newParentId, insertBeforeId) => set(s => ({
                connectionTriggers: {
                    ...s.connectionTriggers,
                    [connectionId]: moveInList(s.connectionTriggers[connectionId] ?? [], id, newParentId, insertBeforeId),
                },
            })),
            moveTimer: (connectionId, id, newParentId, insertBeforeId) => set(s => ({
                connectionTimers: {
                    ...s.connectionTimers,
                    [connectionId]: moveInList(s.connectionTimers[connectionId] ?? [], id, newParentId, insertBeforeId),
                },
            })),
            moveKeybinding: (connectionId, id, newParentId, insertBeforeId) => set(s => ({
                connectionKeybindings: {
                    ...s.connectionKeybindings,
                    [connectionId]: moveInList(s.connectionKeybindings[connectionId] ?? [], id, newParentId, insertBeforeId),
                },
            })),
            moveButton: (connectionId, id, newParentId, insertBeforeId) => set(s => ({
                connectionButtons: {
                    ...s.connectionButtons,
                    [connectionId]: moveInList(s.connectionButtons[connectionId] ?? [], id, newParentId, insertBeforeId),
                },
            })),
            saveScriptEditorBounds: (connectionId, bounds) => set(s => ({
                connectionScriptEditorBounds: {
                    ...s.connectionScriptEditorBounds,
                    [connectionId]: bounds,
                },
            })),
            saveModalBounds: (connectionId, key, bounds) => set(s => ({
                connectionModalBounds: {
                    ...s.connectionModalBounds,
                    [connectionId]: { ...(s.connectionModalBounds[connectionId] ?? {}), [key]: bounds },
                },
            })),
            installPackage: (connectionId, manifest, data) => set(s => {
                // Replace any prior install of the same package name (re-install).
                const prior = (s.connectionPackages[connectionId] ?? []).filter(p => p.name !== manifest.name);
                const stripPkg = <T extends { packageName?: string }>(arr: T[]): T[] =>
                    arr.filter(n => n.packageName !== manifest.name);
                // Installing clears the uninstall tombstone (see uninstallPackage),
                // so default-package seeding treats it as present again.
                const prevProfile = s.connectionProfile[connectionId] ?? {};
                const removed = prevProfile.uninstalledPackages ?? [];
                const connectionProfile = removed.includes(manifest.name)
                    ? {
                        ...s.connectionProfile,
                        [connectionId]: { ...prevProfile, uninstalledPackages: removed.filter(n => n !== manifest.name) },
                    }
                    : s.connectionProfile;
                return {
                    connectionProfile,
                    connectionScripts:     { ...s.connectionScripts,     [connectionId]: [...stripPkg(s.connectionScripts[connectionId]     ?? []), ...data.scripts]  },
                    connectionAliases:     { ...s.connectionAliases,     [connectionId]: [...stripPkg(s.connectionAliases[connectionId]     ?? []), ...data.aliases]  },
                    connectionTriggers:    { ...s.connectionTriggers,    [connectionId]: [...stripPkg(s.connectionTriggers[connectionId]    ?? []), ...data.triggers] },
                    connectionTimers:      { ...s.connectionTimers,      [connectionId]: [...stripPkg(s.connectionTimers[connectionId]      ?? []), ...data.timers]   },
                    connectionKeybindings: { ...s.connectionKeybindings, [connectionId]: [...stripPkg(s.connectionKeybindings[connectionId] ?? []), ...data.keys]     },
                    connectionButtons:     { ...s.connectionButtons,     [connectionId]: [...stripPkg(s.connectionButtons[connectionId]     ?? []), ...data.buttons]  },
                    connectionPackages:    { ...s.connectionPackages,    [connectionId]: [...prior, manifest] },
                };
            }),
            updatePackageManifest: (connectionId, packageName, patch) => set(s => ({
                connectionPackages: {
                    ...s.connectionPackages,
                    [connectionId]: (s.connectionPackages[connectionId] ?? []).map(p =>
                        p.name === packageName ? { ...p, ...patch, name: p.name } : p,
                    ),
                },
            })),
            uninstallPackage: (connectionId, packageName) => set(s => {
                const stripPkg = <T extends { packageName?: string }>(arr: T[]): T[] =>
                    arr.filter(n => n.packageName !== packageName);
                // Tombstone the name so ensureDefaultPackages won't reinstall a
                // default the user deleted. Recorded unconditionally — names
                // that aren't defaults are inert, and this action is the choke
                // point every uninstall path (UI, Lua, GMCP) goes through.
                const prevProfile = s.connectionProfile[connectionId] ?? {};
                const removed = prevProfile.uninstalledPackages ?? [];
                const connectionProfile = removed.includes(packageName)
                    ? s.connectionProfile
                    : {
                        ...s.connectionProfile,
                        [connectionId]: { ...prevProfile, uninstalledPackages: [...removed, packageName] },
                    };
                return {
                    connectionProfile,
                    connectionScripts:     { ...s.connectionScripts,     [connectionId]: stripPkg(s.connectionScripts[connectionId]     ?? []) },
                    connectionAliases:     { ...s.connectionAliases,     [connectionId]: stripPkg(s.connectionAliases[connectionId]     ?? []) },
                    connectionTriggers:    { ...s.connectionTriggers,    [connectionId]: stripPkg(s.connectionTriggers[connectionId]    ?? []) },
                    connectionTimers:      { ...s.connectionTimers,      [connectionId]: stripPkg(s.connectionTimers[connectionId]      ?? []) },
                    connectionKeybindings: { ...s.connectionKeybindings, [connectionId]: stripPkg(s.connectionKeybindings[connectionId] ?? []) },
                    connectionButtons:     { ...s.connectionButtons,     [connectionId]: stripPkg(s.connectionButtons[connectionId]     ?? []) },
                    connectionPackages:    { ...s.connectionPackages,    [connectionId]: (s.connectionPackages[connectionId] ?? []).filter(p => p.name !== packageName) },
                };
            }),
            setVariableSaveList: (connectionId, saveList) => set(s => ({
                connectionVariables: {
                    ...s.connectionVariables,
                    [connectionId]: { saveList, values: s.connectionVariables[connectionId]?.values ?? [] },
                },
            })),
            setVariableValues: (connectionId, values) => set(s => ({
                connectionVariables: {
                    ...s.connectionVariables,
                    // Reuse the existing saveList array reference verbatim: the profile-save
                    // subscription compares saveList by identity, so refreshing values here
                    // must not mint a new array or it would reschedule a save on every flush.
                    [connectionId]: { saveList: s.connectionVariables[connectionId]?.saveList ?? [], values },
                },
            })),
            hydrateConnectionData: (connectionId, data) => set(s => {
                const patch: Partial<AppSchema> = {
                    connectionScripts:     { ...s.connectionScripts,     [connectionId]: data.scripts     ?? [] },
                    connectionAliases:     { ...s.connectionAliases,     [connectionId]: data.aliases     ?? [] },
                    connectionTriggers:    { ...s.connectionTriggers,    [connectionId]: data.triggers    ?? [] },
                    connectionTimers:      { ...s.connectionTimers,      [connectionId]: data.timers      ?? [] },
                    connectionKeybindings: { ...s.connectionKeybindings, [connectionId]: data.keybindings ?? [] },
                    connectionButtons:     { ...s.connectionButtons,     [connectionId]: data.buttons     ?? [] },
                    connectionPackages:    { ...s.connectionPackages,    [connectionId]: data.packages    ?? [] },
                    connectionVariables:   { ...s.connectionVariables,   [connectionId]: data.variables   ?? { saveList: [], values: [] } },
                };
                // UI/settings/layout slices: only set when the loaded data carries
                // them, so a v1 file (automation only) doesn't wipe live state.
                if (data.profile !== undefined)            patch.connectionProfile            = { ...s.connectionProfile,            [connectionId]: data.profile };
                if (data.windowHints !== undefined)        patch.connectionWindowHints        = { ...s.connectionWindowHints,        [connectionId]: data.windowHints };
                if (data.dockExtents !== undefined)        patch.connectionDockExtents        = { ...s.connectionDockExtents,        [connectionId]: data.dockExtents };
                if (data.scriptEditorBounds !== undefined) patch.connectionScriptEditorBounds = { ...s.connectionScriptEditorBounds, [connectionId]: data.scriptEditorBounds };
                if (data.modalBounds !== undefined)        patch.connectionModalBounds        = { ...s.connectionModalBounds,        [connectionId]: data.modalBounds };
                if (data.layoutSnapshot !== undefined)     patch.connectionLayoutSnapshots    = { ...s.connectionLayoutSnapshots,    [connectionId]: data.layoutSnapshot };
                return patch;
            }),
        }),
        {
            name: MUDIX_STORE_NAME,
            version: MUDIX_STORE_VERSION,
            // Coalesce rapid mutations (e.g. an enableTrigger that touches N
            // matching nodes, or a script edit firing on every keystroke) into
            // one JSON.stringify + localStorage write. createJSONStorage runs
            // the stringify before our adapter sees the value, so we implement
            // PersistStorage directly to defer serialization until flush time.
            storage: createDebouncedJsonStorage<PersistedAppSchema>(5000),
            // v21: every per-profile slice now lives in that profile's VFS
            // (.mudix/profile.json, see profileVfsData.ts) — the automation trees
            // (since v20) plus the UI/settings/layout slices (new in v21). Only
            // the global index stays in localStorage: the connection list and
            // global client settings. The VFS is mounted ahead of the session
            // render (App), so its data is available before the synchronous reads.
            partialize: ({ connections, client }) => ({ connections, client }),
            migrate: (saved, version) => {
                const s = saved as Partial<AppSchema> & { connections?: any[]; ui?: any };
                type V1Connection = { id: string; name: string; host: string; port: number; ssl: boolean };
                const connections: MudConnection[] = (s.connections ?? []).map(c => {
                    if (version < 2 && !('url' in c)) {
                        const v1 = c as V1Connection;
                        return { id: v1.id, name: v1.name, url: `${v1.ssl ? 'wss' : 'ws'}://${v1.host}:${v1.port}` };
                    }
                    return c as MudConnection;
                });

                // v18: split legacy `ui` (one shared UISettings) into client (theme only)
                // and per-connection profile overrides. Theme moves up to client; every
                // other field is copied verbatim into every existing connection's
                // override so users don't lose their current font/border/etc. settings.
                const legacyUi = s.ui ?? {};
                // Preserve the modern client slice (userProxyUrl, notificationsEnabled);
                // fall back to the pre-v18 `ui` object only for the theme of very old
                // saves. allowMudPackageInstall is intentionally dropped here — v21
                // moves it to per-profile (below).
                const savedClient = (s.client ?? {}) as Partial<ClientSettings> & { allowMudPackageInstall?: boolean };
                const client: ClientSettings = {
                    theme: savedClient.theme ?? legacyUi.theme ?? APP_DEFAULTS.client.theme,
                    ...(savedClient.userProxyUrl !== undefined ? { userProxyUrl: savedClient.userProxyUrl } : {}),
                    ...(savedClient.notificationsEnabled !== undefined ? { notificationsEnabled: savedClient.notificationsEnabled } : {}),
                };
                const persisted = (s as any).connectionProfile as Record<string, Partial<ProfileSettings>> | undefined;
                let connectionProfile: Record<string, Partial<ProfileSettings>>;
                if (persisted) {
                    connectionProfile = persisted;
                } else {
                    const seed: Partial<ProfileSettings> = {};
                    for (const k of ['showTimestamps','fontSize','outputBackground','outputFont','outputWrapAt','outputBackgroundColor','outputBorders','outputBorderColor','promptTimeoutMs'] as const) {
                        if (legacyUi[k] !== undefined) (seed as any)[k] = legacyUi[k];
                    }
                    connectionProfile = Object.fromEntries(connections.map(c => [c.id, { ...seed }]));
                }

                // v19: split single mapViewState into per-area mapViewStates +
                // mapLastAreaId so each area remembers its own last-viewed level.
                // (Zoom now lives in the map file and pan isn't remembered, so we
                // only carry the level forward.)
                if (version < 19) {
                    for (const prof of Object.values(connectionProfile) as any[]) {
                        const legacy = prof?.mapViewState;
                        if (!legacy) continue;
                        prof.mapViewStates = {
                            ...(prof.mapViewStates ?? {}),
                            [legacy.areaId]: { level: legacy.level },
                        };
                        prof.mapLastAreaId = legacy.areaId;
                        delete prof.mapViewState;
                    }
                }

                // v21: per-profile icon + login creds move onto the connection
                // record (they're read without mounting the profile); the global
                // package-install flag becomes per-profile; and every per-profile
                // UI/layout/settings slice moves into the VFS — stashed here in a
                // one-time backup that loadProfileData drains on first open.
                if (version < 21) {
                    for (const c of connections) {
                        const prof = connectionProfile[c.id] as Record<string, unknown> | undefined;
                        if (!prof) continue;
                        if (prof.icon !== undefined)             { c.icon = prof.icon as string;             delete prof.icon; }
                        if (prof.charLoginAccount !== undefined) { c.charLoginAccount = prof.charLoginAccount as string; delete prof.charLoginAccount; }
                        if (prof.charLoginPassword !== undefined){ c.charLoginPassword = prof.charLoginPassword as string; delete prof.charLoginPassword; }
                    }
                    if (savedClient.allowMudPackageInstall === false) {
                        for (const c of connections) {
                            connectionProfile[c.id] = { ...(connectionProfile[c.id] ?? {}), allowMudPackageInstall: false };
                        }
                    }
                    try {
                        const backup: Record<string, unknown> = {};
                        for (const c of connections) {
                            backup[c.id] = {
                                profile: connectionProfile[c.id],
                                windowHints: s.connectionWindowHints?.[c.id],
                                dockExtents: s.connectionDockExtents?.[c.id],
                                scriptEditorBounds: s.connectionScriptEditorBounds?.[c.id],
                                modalBounds: s.connectionModalBounds?.[c.id],
                                layoutSnapshot: s.connectionLayoutSnapshots?.[c.id],
                            };
                        }
                        localStorage.setItem(MIGRATION_BACKUP_KEY, JSON.stringify(backup));
                    } catch { /* backup is best-effort */ }
                }

                return {
                    ...APP_DEFAULTS,
                    connections,
                    client,
                    connectionProfile,
                    connectionWindowHints: s.connectionWindowHints ?? {},
                    connectionDockExtents: s.connectionDockExtents ?? {},
                    // v20: automation data (scripts/aliases/triggers/timers/keybindings/
                    // buttons/packages) moved out of localStorage into each profile's VFS
                    // (.mudix/profile.json). Any pre-v20 localStorage copies are
                    // intentionally dropped (fresh start) — they fall through to
                    // APP_DEFAULTS' empty maps above. The small UI/layout bounds below
                    // are read synchronously before the VFS mounts, so they stay here.
                    ...(version >= 10 ? {
                        connectionScriptEditorBounds: s.connectionScriptEditorBounds ?? {},
                        connectionModalBounds: s.connectionModalBounds ?? {},
                    } : {}),
                };
            },
        },
    ),
);
