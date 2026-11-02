/**
 * "Keep unlocked on this device": the vault opens by itself on later visits.
 *
 * The master key is wrapped under a *device key* — an AES-GCM key created with
 * `extractable: false` and kept in IndexedDB, which stores a `CryptoKey` by
 * structured clone. Script on this origin can ask the browser to use it but can
 * never read its bytes, so the wrapped copy is useless anywhere but this
 * browser profile: not in a backup, not on another machine, not to an extension
 * that copies localStorage (where the vault record lives).
 *
 * What it gives up, and what the player is told: anyone who can use this
 * browser profile can open the vault, as with the browser's own saved
 * passwords. Script in the page could already use an unlocked vault, so that
 * exposure is unchanged. Someone copying the profile directory off the disk may
 * recover the key, since browsers do not all encrypt IndexedDB at rest. Hence
 * opt-in, and an expiry ({@link REMEMBER_UNLOCK_DAYS}) that re-asking renews.
 *
 * Kept in its own database so dropping it never touches anything else, and so
 * no backup or storage sweep that names the app's other databases picks it up.
 */

import { type Ciphertext, unwrapMasterKey, wrapMasterKey } from './vaultCrypto';

/** How long a remembered unlock lasts before the vault asks again. */
export const REMEMBER_UNLOCK_DAYS = 30;

/** One remembered unlock — at most one per browser profile, like the vault. */
export interface RememberedUnlock {
    /** Non-extractable; never leaves IndexedDB as bytes. */
    deviceKey: CryptoKey;
    /** The vault master key, encrypted under `deviceKey`. */
    wrapped: Ciphertext;
    /** Which vault this opens — its `prfSalt`, random per vault. A vault
     *  deleted and set up again must not be "opened" by a stale entry. */
    vaultTag: string;
    /** Epoch ms after which it is discarded unused. */
    expiresAt: number;
}

export interface DeviceUnlockStore {
    load(): Promise<RememberedUnlock | null>;
    save(entry: RememberedUnlock): Promise<void>;
    clear(): Promise<void>;
}

/** Wrap `master` under a fresh device key. */
export async function rememberMasterKey(
    master: CryptoKey, vaultTag: string, now = Date.now(),
): Promise<RememberedUnlock> {
    const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return {
        deviceKey,
        wrapped: await wrapMasterKey(deviceKey, master),
        vaultTag,
        expiresAt: now + REMEMBER_UNLOCK_DAYS * 24 * 60 * 60 * 1000,
    };
}

/** The master key back, or `null` when the entry is for another vault, has
 *  expired, or will not decrypt. */
export async function recallMasterKey(
    entry: RememberedUnlock, vaultTag: string, now = Date.now(),
): Promise<CryptoKey | null> {
    if (entry.vaultTag !== vaultTag || entry.expiresAt <= now) return null;
    try {
        return await unwrapMasterKey(entry.deviceKey, entry.wrapped);
    } catch {
        return null;
    }
}

const DB_NAME = 'mudlet_vault_device';
const STORE_NAME = 'unlock';
const ENTRY_KEY = 'current';

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest | null): Promise<T | undefined> {
    const db = await openDb();
    try {
        return await new Promise<T | undefined>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, mode);
            const req = op(tx.objectStore(STORE_NAME));
            tx.oncomplete = () => resolve(req?.result as T | undefined);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

/** The IndexedDB-backed store, or `null` where there is no IndexedDB. */
export function idbDeviceUnlockStore(): DeviceUnlockStore | null {
    if (typeof indexedDB === 'undefined') return null;
    return {
        load: async () => (await run<RememberedUnlock>('readonly', s => s.get(ENTRY_KEY))) ?? null,
        save: async (entry) => { await run('readwrite', s => s.put(entry, ENTRY_KEY)); },
        clear: async () => { await run('readwrite', s => s.delete(ENTRY_KEY)); },
    };
}
