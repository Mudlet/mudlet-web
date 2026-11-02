// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { CredentialVault, VaultError } from '../../src/vault/CredentialVault';
import { REMEMBER_UNLOCK_DAYS, type DeviceUnlockStore, type RememberedUnlock } from '../../src/vault/deviceUnlock';
import { parseVaultRecord, type VaultRecord } from '../../src/vault/vaultRecord';
import {
    decryptJson, deriveKeyFromPassphrase, encryptJson, generateMasterKey, randomBytes,
    unwrapMasterKey, wrapMasterKey,
} from '../../src/vault/vaultCrypto';

// Node's global WebCrypto is the same SubtleCrypto the browser gives us, so the
// vault's real crypto runs here — no mocking, and a format change that would
// strand an existing vault fails the round-trip tests below.

/** localStorage stand-in: the vault only ever loads once and saves whole. */
function memoryIO() {
    const box: { record: VaultRecord | null } = { record: null };
    return {
        box,
        io: {
            load: () => box.record,
            save: (r: VaultRecord | null) => {
                // Round-trip through JSON the way real storage does, so a value
                // that only survives by reference (a CryptoKey, a Uint8Array)
                // would be caught here rather than after a reload.
                box.record = r ? (JSON.parse(JSON.stringify(r)) as VaultRecord) : null;
            },
        },
    };
}

const PASS = 'correct horse battery';

describe('vaultCrypto', () => {
    it('round-trips JSON under a derived key', async () => {
        const salt = randomBytes(16);
        const key = await deriveKeyFromPassphrase(PASS, salt, 1000);
        const box = await encryptJson(key, { a: 1, b: 'two' });
        expect(await decryptJson(key, box)).toEqual({ a: 1, b: 'two' });
    });

    it('fails to decrypt under the wrong key rather than returning garbage', async () => {
        const good = await deriveKeyFromPassphrase(PASS, randomBytes(16), 1000);
        const bad = await deriveKeyFromPassphrase('wrong', randomBytes(16), 1000);
        const box = await encryptJson(good, { secret: true });
        await expect(decryptJson(bad, box)).rejects.toThrow();
    });

    it('uses a fresh nonce per encryption', async () => {
        const key = await deriveKeyFromPassphrase(PASS, randomBytes(16), 1000);
        const a = await encryptJson(key, { x: 1 });
        const b = await encryptJson(key, { x: 1 });
        expect(a.iv).not.toEqual(b.iv);
        expect(a.ct).not.toEqual(b.ct);
    });

    it('wraps and unwraps a master key', async () => {
        const master = await generateMasterKey();
        const kek = await deriveKeyFromPassphrase(PASS, randomBytes(16), 1000);
        const recovered = await unwrapMasterKey(kek, await wrapMasterKey(kek, master));
        // Same key material: what one encrypts the other must decrypt.
        const box = await encryptJson(master, { ping: 'pong' });
        expect(await decryptJson(recovered, box)).toEqual({ ping: 'pong' });
    });
});

describe('CredentialVault', () => {
    let store: ReturnType<typeof memoryIO>;
    let vault: CredentialVault;

    beforeEach(async () => {
        store = memoryIO();
        vault = new CredentialVault(store.io);
    });

    it('starts with no vault', () => {
        expect(vault.exists).toBe(false);
        expect(vault.locked).toBe(false);
        expect(vault.getSnapshot().entryIds).toEqual([]);
    });

    it('creates a vault and stores a password', async () => {
        await vault.createWithPassphrase(PASS);
        expect(vault.exists).toBe(true);
        expect(vault.locked).toBe(false);
        await vault.setPassword('c1', 'hunter2');
        expect(vault.getPassword('c1')).toBe('hunter2');
        expect(vault.hasEntry('c1')).toBe(true);
    });

    it('never writes a password in the clear', async () => {
        await vault.createWithPassphrase(PASS);
        await vault.setPassword('c1', 'hunter2');
        const raw = JSON.stringify(store.box.record);
        expect(raw).not.toContain('hunter2');
        expect(raw).not.toContain(PASS);
        // The connection id is deliberately NOT secret — a locked vault has to
        // be able to say which profiles have a saved login.
        expect(raw).toContain('c1');
    });

    it('migrates plaintext passwords handed to it at creation', async () => {
        await vault.createWithPassphrase(PASS, { c1: 'old-one', c2: 'old-two' });
        expect(vault.getPassword('c1')).toBe('old-one');
        expect(vault.getPassword('c2')).toBe('old-two');
        expect([...vault.getSnapshot().entryIds].sort()).toEqual(['c1', 'c2']);
        expect(JSON.stringify(store.box.record)).not.toContain('old-one');
    });

    it('forgets everything about the secrets when locked, but not that they exist', async () => {
        await vault.createWithPassphrase(PASS);
        await vault.setPassword('c1', 'hunter2');
        vault.lock();
        expect(vault.locked).toBe(true);
        expect(vault.getPassword('c1')).toBeUndefined();
        // Still answerable — this is what tells the app an unlock is worth asking for.
        expect(vault.hasEntry('c1')).toBe(true);
    });

    it('reopens a persisted vault with the passphrase', async () => {
        await vault.createWithPassphrase(PASS);
        await vault.setPassword('c1', 'hunter2');

        const reloaded = new CredentialVault(store.io);
        expect(reloaded.exists).toBe(true);
        expect(reloaded.locked).toBe(true);
        expect(await reloaded.unlockWithPassphrase(PASS)).toBe(true);
        expect(reloaded.getPassword('c1')).toBe('hunter2');
    });

    it('rejects the wrong passphrase without throwing', async () => {
        await vault.createWithPassphrase(PASS);
        vault.lock();
        expect(await vault.unlockWithPassphrase('nope')).toBe(false);
        expect(vault.locked).toBe(true);
    });

    it('refuses to touch secrets while locked', async () => {
        await vault.createWithPassphrase(PASS);
        vault.lock();
        await expect(vault.setPassword('c1', 'x')).rejects.toBeInstanceOf(VaultError);
    });

    it('opens with either of two passphrases', async () => {
        await vault.createWithPassphrase(PASS);
        await vault.setPassword('c1', 'hunter2');
        await vault.addPassphrase('second way in', 'Backup');
        vault.lock();

        expect(await vault.unlockWithPassphrase('second way in')).toBe(true);
        expect(vault.getPassword('c1')).toBe('hunter2');
        vault.lock();
        expect(await vault.unlockWithPassphrase(PASS)).toBe(true);
    });

    it('replaces every passphrase on a change', async () => {
        await vault.createWithPassphrase(PASS);
        await vault.setPassword('c1', 'hunter2');
        await vault.changePassphrase('a brand new phrase');
        vault.lock();

        expect(await vault.unlockWithPassphrase(PASS)).toBe(false);
        expect(await vault.unlockWithPassphrase('a brand new phrase')).toBe(true);
        expect(vault.getPassword('c1')).toBe('hunter2');
    });

    it('will not remove the only way in', async () => {
        await vault.createWithPassphrase(PASS);
        const only = vault.getSnapshot().unlockers[0];
        expect(() => vault.removeUnlocker(only.id)).toThrow(VaultError);
        expect(vault.getSnapshot().unlockers).toHaveLength(1);
    });

    it('removes an unlocker once a second one exists', async () => {
        await vault.createWithPassphrase(PASS);
        await vault.addPassphrase('second way in', 'Backup');
        const first = vault.getSnapshot().unlockers[0];
        vault.removeUnlocker(first.id);
        expect(vault.getSnapshot().unlockers).toHaveLength(1);
        vault.lock();
        expect(await vault.unlockWithPassphrase(PASS)).toBe(false);
        expect(await vault.unlockWithPassphrase('second way in')).toBe(true);
    });

    it('drops entries for profiles that no longer exist', async () => {
        await vault.createWithPassphrase(PASS, { keep: 'a', gone: 'b' });
        await vault.pruneMissing(['keep']);
        expect(vault.getSnapshot().entryIds).toEqual(['keep']);
        expect(vault.getPassword('gone')).toBeUndefined();
    });

    it('defers forgetting a deleted profile while locked', async () => {
        await vault.createWithPassphrase(PASS, { gone: 'b' });
        vault.lock();
        expect(await vault.forgetConnection('gone')).toBe(false);
        expect(vault.hasEntry('gone')).toBe(true);
    });

    it('deletes the vault and its storage', async () => {
        await vault.createWithPassphrase(PASS, { c1: 'x' });
        vault.deleteVault();
        expect(vault.exists).toBe(false);
        expect(store.box.record).toBeNull();
        expect(vault.hasEntry('c1')).toBe(false);
    });

    it('notifies subscribers when the state changes', async () => {
        let hits = 0;
        vault.subscribe(() => { hits++; });
        await vault.createWithPassphrase(PASS);
        const afterCreate = hits;
        expect(afterCreate).toBeGreaterThan(0);
        vault.lock();
        expect(hits).toBeGreaterThan(afterCreate);
        // A no-op lock must not churn React.
        const afterLock = hits;
        vault.lock();
        expect(hits).toBe(afterLock);
    });

    it('gives a fresh snapshot identity per change and a stable one otherwise', async () => {
        await vault.createWithPassphrase(PASS);
        const before = vault.getSnapshot();
        expect(vault.getSnapshot()).toBe(before);
        await vault.setPassword('c1', 'x');
        expect(vault.getSnapshot()).not.toBe(before);
    });
});

describe('CredentialVault — GMCP sign-ins', () => {
    let store: ReturnType<typeof memoryIO>;
    let vault: CredentialVault;

    beforeEach(() => {
        store = memoryIO();
        vault = new CredentialVault(store.io);
    });

    const SIGN_IN = { account: 'rahj', provider: 'discord', token: 'tok-SECRET-1', secureOnly: true };

    it('cannot store with no vault or a locked one', async () => {
        expect(vault.canStore).toBe(false);
        await vault.createWithPassphrase(PASS);
        expect(vault.canStore).toBe(true);
        vault.lock();
        expect(vault.canStore).toBe(false);
        await expect(vault.setSignIn('c1', SIGN_IN)).rejects.toBeInstanceOf(VaultError);
    });

    it('stores a sign-in encrypted, and lists only profiles holding a token', async () => {
        await vault.createWithPassphrase(PASS);
        await vault.setSignIn('c1', SIGN_IN);
        await vault.setSignIn('c2', { account: 'other', provider: 'google' });
        expect(vault.getSignIn('c1')).toEqual(SIGN_IN);
        expect(vault.hasSignIn('c1')).toBe(true);
        // A resume hint alone is not worth an unlock prompt.
        expect(vault.hasSignIn('c2')).toBe(false);
        expect(vault.getSnapshot().signInIds).toEqual(['c1']);
        const raw = JSON.stringify(store.box.record);
        expect(raw).not.toContain('tok-SECRET-1');
        expect(raw).not.toContain('rahj');
    });

    it('survives a reload and an unlock, alongside the passwords', async () => {
        await vault.createWithPassphrase(PASS);
        await vault.setPassword('c1', 'hunter2');
        await vault.setSignIn('c1', SIGN_IN);
        const reopened = new CredentialVault(store.io);
        expect(reopened.locked).toBe(true);
        expect(reopened.hasSignIn('c1')).toBe(true);
        expect(reopened.getSignIn('c1')).toBeUndefined();
        expect(await reopened.unlockWithPassphrase(PASS)).toBe(true);
        expect(reopened.getSignIn('c1')).toEqual(SIGN_IN);
        expect(reopened.getPassword('c1')).toBe('hunter2');
    });

    it('a password write does not roll back a sign-in written meanwhile', async () => {
        await vault.createWithPassphrase(PASS);
        await Promise.all([vault.setPassword('c1', 'pw'), vault.setSignIn('c1', SIGN_IN)]);
        const reopened = new CredentialVault(store.io);
        await reopened.unlockWithPassphrase(PASS);
        expect(reopened.getPassword('c1')).toBe('pw');
        expect(reopened.getSignIn('c1')).toEqual(SIGN_IN);
    });

    it('forgets a sign-in with its profile, and prunes it with missing profiles', async () => {
        await vault.createWithPassphrase(PASS);
        await vault.setSignIn('c1', SIGN_IN);
        await vault.setSignIn('gone', SIGN_IN);
        expect(await vault.forgetConnection('c1')).toBe(true);
        expect(vault.getSignIn('c1')).toBeUndefined();
        await vault.pruneMissing(['c1']);
        expect(vault.getSignIn('gone')).toBeUndefined();
        expect(vault.getSnapshot().signInIds).toEqual([]);
    });

    it('reads a record written before sign-ins existed', () => {
        const legacy = parseVaultRecord(JSON.stringify({
            version: 1, prfSalt: 'AAAA', entryIds: ['c1'], payload: null,
            unlockers: [{ id: 'u', kind: 'passphrase', label: 'P', createdAt: '', salt: 'AA', iterations: 1, wrapped: { iv: 'a', ct: 'b' } }],
        }));
        expect(legacy?.signInIds).toEqual([]);
        expect(legacy?.signInPayload).toBeNull();
    });
});

describe('parseVaultRecord', () => {
    it('treats junk as "no vault" rather than throwing', () => {
        expect(parseVaultRecord(null)).toBeNull();
        expect(parseVaultRecord('not json')).toBeNull();
        expect(parseVaultRecord('{}')).toBeNull();
        expect(parseVaultRecord(JSON.stringify({ version: 2, prfSalt: 'x', unlockers: [] }))).toBeNull();
    });

    it('rejects a record whose unlockers are all unusable', () => {
        const raw = JSON.stringify({
            version: 1, prfSalt: 'abc', entryIds: ['c1'], payload: null,
            unlockers: [{ id: 'a', kind: 'passphrase' }],   // no wrapped key
        });
        expect(parseVaultRecord(raw)).toBeNull();
    });

    it('keeps a valid record', async () => {
        const store = memoryIO();
        const vault = new CredentialVault(store.io);
        await vault.createWithPassphrase(PASS, { c1: 'x' });
        const parsed = parseVaultRecord(JSON.stringify(store.box.record));
        expect(parsed?.entryIds).toEqual(['c1']);
        expect(parsed?.unlockers).toHaveLength(1);
    });
});

/** IndexedDB stand-in. Holds the entry by reference, as structured clone keeps
 *  a CryptoKey usable — which a JSON round-trip could not. */
function memoryDevice() {
    const box: { entry: RememberedUnlock | null } = { entry: null };
    const store: DeviceUnlockStore = {
        load: async () => box.entry,
        save: async (e) => { box.entry = e; },
        clear: async () => { box.entry = null; },
    };
    return { box, store };
}

describe('keep unlocked on this device', () => {
    const DAY = 24 * 60 * 60 * 1000;

    async function rememberedVault() {
        const { io } = memoryIO();
        const device = memoryDevice();
        const first = new CredentialVault(io, device.store);
        await first.createWithPassphrase(PASS);
        await first.setPassword('c1', 'hunter2');
        await first.rememberOnThisDevice();
        return { io, device, first };
    }

    it('opens the vault on the next visit without asking', async () => {
        const { io, device, first } = await rememberedVault();
        expect(first.getSnapshot().rememberedUntil).toBeGreaterThan(Date.now() + (REMEMBER_UNLOCK_DAYS - 1) * DAY);
        const next = new CredentialVault(io, device.store);
        expect(next.locked).toBe(true);
        expect(await next.restoreOnThisDevice()).toBe(true);
        expect(next.locked).toBe(false);
        expect(next.getPassword('c1')).toBe('hunter2');
        expect(next.getSnapshot().rememberedUntil).toBe(device.box.entry!.expiresAt);
    });

    it('keeps the device key unreadable', async () => {
        const { device } = await rememberedVault();
        expect(device.box.entry!.deviceKey.extractable).toBe(false);
        await expect(crypto.subtle.exportKey('raw', device.box.entry!.deviceKey)).rejects.toThrow();
    });

    it('drops an expired entry and stays locked', async () => {
        const { io, device } = await rememberedVault();
        device.box.entry = { ...device.box.entry!, expiresAt: Date.now() - 1 };
        const next = new CredentialVault(io, device.store);
        expect(await next.restoreOnThisDevice()).toBe(false);
        expect(next.locked).toBe(true);
        expect(device.box.entry).toBeNull();
    });

    it('does not open a vault set up again since', async () => {
        const { device } = await rememberedVault();
        // A different vault on the same device: its own record, the old entry.
        const other = memoryIO();
        await new CredentialVault(other.io, null).createWithPassphrase('another passphrase');
        const replaced = new CredentialVault(other.io, device.store);
        expect(await replaced.restoreOnThisDevice()).toBe(false);
        expect(replaced.locked).toBe(true);
        expect(device.box.entry).toBeNull();
    });

    it('forgets on lock, on request, and when the vault is deleted', async () => {
        const locked = await rememberedVault();
        locked.first.lock();
        await Promise.resolve();
        expect(locked.device.box.entry).toBeNull();

        const asked = await rememberedVault();
        await asked.first.forgetOnThisDevice();
        expect(asked.device.box.entry).toBeNull();
        expect(asked.first.locked).toBe(false);
        expect(asked.first.getSnapshot().rememberedUntil).toBeNull();

        const deleted = await rememberedVault();
        deleted.first.deleteVault();
        await Promise.resolve();
        expect(deleted.device.box.entry).toBeNull();
    });

    it('cannot remember without a device store, and refuses while locked', async () => {
        const plain = new CredentialVault(memoryIO().io, null);
        expect(plain.canRemember).toBe(false);
        await plain.createWithPassphrase(PASS);
        await expect(plain.rememberOnThisDevice()).rejects.toThrow(VaultError);
        const { first } = await rememberedVault();
        first.lock();
        await expect(first.rememberOnThisDevice()).rejects.toThrow(VaultError);
    });
});

