/**
 * The credential vault: per-profile login passwords, encrypted at rest under a
 * key the browser cannot produce on its own.
 *
 * Why this exists rather than a "remember my password" checkbox: the app store
 * is plaintext localStorage, so the old checkbox had to ship a warning telling
 * the user that the convenience it had just offered was unsafe (issue #25). And
 * handing the job to the browser's password manager doesn't work either —
 * managers scope credentials by *origin*, so ten profiles on one host produce
 * ten indistinguishable entries in one dropdown, every time, for every game.
 *
 * The vault inverts that. Secrets live here, encrypted; the single thing the
 * password manager is asked to remember is the vault's unlock passphrase — one
 * entry per origin, never ambiguous — or nothing at all when the unlocker is a
 * passkey. Envelope encryption (see `vaultCrypto`) lets a vault carry several
 * unlockers at once, so a passkey can be primary with a passphrase as the
 * recovery path.
 *
 * **Scope of the protection.** Ciphertext at rest defends against everything
 * that reads storage without running in the page: disk images, backups, profile
 * sync, another user on the machine, an extension trawling localStorage. It does
 * not defend against script running in the page *while the vault is unlocked* —
 * no in-page vault can, and neither can a password manager with an open vault.
 * The unlocked state is per page load and lives only in memory.
 *
 * State changes notify `subscribe` listeners so React can render off
 * `getSnapshot` through `useSyncExternalStore`.
 */

import {
    cryptoAvailable, decryptJson, deriveKeyFromPassphrase, deriveKeyFromPrf, encryptJson,
    fromBase64, generateMasterKey, PBKDF2_ITERATIONS, randomBytes, toBase64,
    unwrapMasterKey, wrapMasterKey,
} from './vaultCrypto';
import { evaluateVaultPrf, passkeysAvailable, registerVaultPasskey, type PasskeyRegistration } from './passkeyPrf';
import {
    loadVaultRecord, saveVaultRecord, type PasskeyUnlocker, type VaultRecord, type VaultUnlocker,
} from './vaultRecord';

/** What a listener needs to render. Immutable; identity changes on every
 *  mutation so `useSyncExternalStore` re-renders exactly when something did. */
export interface VaultSnapshot {
    /** A vault has been set up on this device. */
    exists: boolean;
    /** Set up but not opened this page load. `false` when `exists` is false. */
    locked: boolean;
    /** Profiles with a stored password — readable while locked. */
    entryIds: readonly string[];
    /** Unlock methods, without their key material. */
    unlockers: readonly { id: string; kind: VaultUnlocker['kind']; label: string; createdAt: string }[];
}

/** Failure modes worth telling apart in the UI. */
export type VaultErrorCode =
    | 'unavailable'      // no WebCrypto (insecure origin)
    | 'no-vault'
    | 'locked'
    | 'no-prf'           // authenticator registered but refuses PRF
    | 'no-passkey'       // vault has no passkey unlocker, or none answered
    | 'last-unlocker';   // refused: removing it would strand the vault

export class VaultError extends Error {
    constructor(public code: VaultErrorCode, message: string) {
        super(message);
        this.name = 'VaultError';
    }
}

interface VaultIO {
    load(): VaultRecord | null;
    save(record: VaultRecord | null): void;
}

const EMPTY_SNAPSHOT: VaultSnapshot = { exists: false, locked: false, entryIds: [], unlockers: [] };

function newId(): string {
    return toBase64(randomBytes(9));
}

export class CredentialVault {
    private record: VaultRecord | null;
    /** Recovered at unlock, dropped at lock. Never persisted. */
    private masterKey: CryptoKey | null = null;
    /** Decrypted secrets while unlocked, keyed by connection id. */
    private secrets: Record<string, string> | null = null;
    private listeners = new Set<() => void>();
    private snapshot: VaultSnapshot = EMPTY_SNAPSHOT;

    constructor(private io: VaultIO = { load: loadVaultRecord, save: saveVaultRecord }) {
        this.record = io.load();
        this.snapshot = this.buildSnapshot();
    }

    // ── reads ────────────────────────────────────────────────────────────

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    getSnapshot = (): VaultSnapshot => this.snapshot;

    /** Whether this browser can do vault crypto at all (secure context). */
    get available(): boolean { return cryptoAvailable(); }

    /** Whether a passkey unlocker can even be offered here. */
    get passkeysSupported(): boolean { return passkeysAvailable(); }

    get exists(): boolean { return this.record !== null; }

    get locked(): boolean { return this.record !== null && this.masterKey === null; }

    /** True when this profile has a stored password — answerable while locked,
     *  which is what lets the app decide whether an unlock is worth asking for. */
    hasEntry(connectionId: string): boolean {
        return !!this.record?.entryIds.includes(connectionId);
    }

    /** The stored password, or `undefined` when there is none *or* the vault is
     *  locked. Callers treat both the same way: fall back to asking the user. */
    getPassword(connectionId: string): string | undefined {
        return this.secrets?.[connectionId];
    }

    // ── lifecycle ────────────────────────────────────────────────────────

    /**
     * Create a vault whose first unlocker is a passphrase.
     *
     * `seed` migrates any passwords that were already sitting in plaintext on
     * the connection records — the caller strips them from the store once this
     * resolves, so the plaintext copy does not outlive its replacement.
     */
    async createWithPassphrase(passphrase: string, seed?: Record<string, string>): Promise<void> {
        this.requireAvailable();
        const master = await generateMasterKey();
        const unlocker = await this.buildPassphraseUnlocker(master, passphrase, 'Passphrase');
        await this.installNewVault(master, [unlocker], seed);
    }

    /**
     * Create a vault whose first unlocker is a passkey. Two authenticator
     * prompts: one to register the credential, one to evaluate PRF for its KEK
     * (Chrome does not return PRF output at registration).
     *
     * Throws `no-prf` when the authenticator cannot do PRF — the caller falls
     * back to `createWithPassphrase`.
     */
    async createWithPasskey(appName: string, label: string, seed?: Record<string, string>): Promise<void> {
        this.requireAvailable();
        const prfSalt = randomBytes(32);
        const registration = await registerVaultPasskey(appName, label);
        if (!registration) {
            throw new VaultError('no-prf', 'This device registered a passkey but will not derive keys with it.');
        }
        const master = await generateMasterKey();
        const unlocker = await this.buildPasskeyUnlocker(master, registration, prfSalt, label);
        await this.installNewVault(master, [unlocker], seed, toBase64(prfSalt));
    }

    /** Open the vault with a passphrase. `false` = wrong passphrase (the only
     *  outcome a user can act on); anything else throws. */
    async unlockWithPassphrase(passphrase: string): Promise<boolean> {
        const record = this.requireRecord();
        for (const u of record.unlockers) {
            if (u.kind !== 'passphrase') continue;
            try {
                const kek = await deriveKeyFromPassphrase(passphrase, fromBase64(u.salt), u.iterations);
                const master = await unwrapMasterKey(kek, u.wrapped);
                await this.adoptMasterKey(master);
                return true;
            } catch {
                // Wrong passphrase for this unlocker — try the next. A vault can
                // hold more than one, and only "none matched" is a failure.
            }
        }
        return false;
    }

    /** Open the vault with a registered passkey. Throws on cancel (WebAuthn's
     *  own error) or when no passkey unlocker exists. */
    async unlockWithPasskey(): Promise<boolean> {
        const record = this.requireRecord();
        const passkeys = record.unlockers.filter((u): u is PasskeyUnlocker => u.kind === 'passkey');
        if (passkeys.length === 0) throw new VaultError('no-passkey', 'This vault has no passkey.');
        const result = await evaluateVaultPrf(
            passkeys.map(u => ({ credentialId: u.credentialId })),
            fromBase64(record.prfSalt),
        );
        if (!result) return false;
        const unlocker = passkeys.find(u => u.credentialId === result.credentialId);
        if (!unlocker) return false;
        const kek = await deriveKeyFromPrf(result.secret);
        const master = await unwrapMasterKey(kek, unlocker.wrapped);
        await this.adoptMasterKey(master);
        return true;
    }

    /** Drop the master key and every decrypted secret. The record stays. */
    lock(): void {
        if (!this.masterKey && !this.secrets) return;
        this.masterKey = null;
        this.secrets = null;
        this.emit();
    }

    /** Remove the vault and everything in it, irreversibly. */
    deleteVault(): void {
        this.record = null;
        this.masterKey = null;
        this.secrets = null;
        this.io.save(null);
        this.emit();
    }

    // ── secrets ──────────────────────────────────────────────────────────

    /** Store (or, with `null`, forget) one profile's password. Requires unlocked. */
    async setPassword(connectionId: string, password: string | null): Promise<void> {
        const secrets = this.requireUnlocked();
        if (password) secrets[connectionId] = password;
        else delete secrets[connectionId];
        await this.persistSecrets();
    }

    /**
     * Forget every trace of a profile — called when the profile is deleted.
     *
     * A locked vault cannot rewrite its ciphertext, so the entry is left in
     * place and swept on the next unlock by {@link pruneMissing}. Returning
     * `false` says so; nothing leaks either way, since a deleted profile's
     * password is unreachable.
     */
    async forgetConnection(connectionId: string): Promise<boolean> {
        if (!this.record?.entryIds.includes(connectionId)) return true;
        if (this.locked) return false;
        await this.setPassword(connectionId, null);
        return true;
    }

    /** Drop stored passwords for profiles that no longer exist. No-op while
     *  locked; the caller runs it right after an unlock. */
    async pruneMissing(existingConnectionIds: Iterable<string>): Promise<void> {
        if (!this.record || this.locked || !this.secrets) return;
        const keep = new Set(existingConnectionIds);
        const stale = Object.keys(this.secrets).filter(id => !keep.has(id));
        if (stale.length === 0) return;
        for (const id of stale) delete this.secrets[id];
        await this.persistSecrets();
    }

    // ── unlockers ────────────────────────────────────────────────────────

    /** Add a passphrase to an already-open vault (recovery path for a
     *  passkey-first vault, or a new phrase alongside the old one). */
    async addPassphrase(passphrase: string, label = 'Passphrase'): Promise<void> {
        const master = this.requireMaster();
        const record = this.requireRecord();
        const unlocker = await this.buildPassphraseUnlocker(master, passphrase, label);
        this.writeRecord({ ...record, unlockers: [...record.unlockers, unlocker] });
    }

    /** Add a passkey to an already-open vault. */
    async addPasskey(appName: string, label: string): Promise<void> {
        const master = this.requireMaster();
        const record = this.requireRecord();
        const registration = await registerVaultPasskey(appName, label);
        if (!registration) {
            throw new VaultError('no-prf', 'This device registered a passkey but will not derive keys with it.');
        }
        const unlocker = await this.buildPasskeyUnlocker(master, registration, fromBase64(record.prfSalt), label);
        this.writeRecord({ ...record, unlockers: [...record.unlockers, unlocker] });
    }

    /** Remove an unlock method. Refuses to remove the last one — that would
     *  leave a vault nobody can open, which is data loss wearing a button. */
    removeUnlocker(id: string): void {
        const record = this.requireRecord();
        if (record.unlockers.length <= 1) {
            throw new VaultError(
                'last-unlocker',
                'Removing the only way in would lock the vault for good — delete the vault instead.',
            );
        }
        const unlockers = record.unlockers.filter(u => u.id !== id);
        if (unlockers.length === record.unlockers.length) return;
        this.writeRecord({ ...record, unlockers });
    }

    /** Replace every passphrase unlocker with one derived from `next`. The
     *  vault must be open, so this is "change", not "reset" — a forgotten
     *  passphrase is recovered with a passkey or not at all. */
    async changePassphrase(next: string, label = 'Passphrase'): Promise<void> {
        const master = this.requireMaster();
        const record = this.requireRecord();
        const unlocker = await this.buildPassphraseUnlocker(master, next, label);
        this.writeRecord({
            ...record,
            unlockers: [...record.unlockers.filter(u => u.kind !== 'passphrase'), unlocker],
        });
    }

    // ── internals ────────────────────────────────────────────────────────

    private requireAvailable(): void {
        if (!cryptoAvailable()) {
            throw new VaultError(
                'unavailable',
                'Web Crypto is unavailable — the vault needs a secure context (https or localhost).',
            );
        }
    }

    private requireRecord(): VaultRecord {
        if (!this.record) throw new VaultError('no-vault', 'No vault has been set up.');
        return this.record;
    }

    private requireMaster(): CryptoKey {
        this.requireRecord();
        if (!this.masterKey) throw new VaultError('locked', 'The vault is locked.');
        return this.masterKey;
    }

    private requireUnlocked(): Record<string, string> {
        this.requireMaster();
        if (!this.secrets) throw new VaultError('locked', 'The vault is locked.');
        return this.secrets;
    }

    private async buildPassphraseUnlocker(master: CryptoKey, passphrase: string, label: string): Promise<VaultUnlocker> {
        const salt = randomBytes(16);
        const kek = await deriveKeyFromPassphrase(passphrase, salt, PBKDF2_ITERATIONS);
        return {
            id: newId(), kind: 'passphrase', label, createdAt: new Date().toISOString(),
            wrapped: await wrapMasterKey(kek, master),
            salt: toBase64(salt), iterations: PBKDF2_ITERATIONS,
        };
    }

    private async buildPasskeyUnlocker(
        master: CryptoKey, registration: PasskeyRegistration, prfSalt: Uint8Array, label: string,
    ): Promise<VaultUnlocker> {
        const evaluated = await evaluateVaultPrf([registration], prfSalt);
        if (!evaluated) throw new VaultError('no-prf', 'The authenticator did not return a key.');
        const kek = await deriveKeyFromPrf(evaluated.secret);
        return {
            id: newId(), kind: 'passkey', label, createdAt: new Date().toISOString(),
            wrapped: await wrapMasterKey(kek, master),
            credentialId: registration.credentialId,
        };
    }

    private async installNewVault(
        master: CryptoKey, unlockers: VaultUnlocker[], seed?: Record<string, string>, prfSalt?: string,
    ): Promise<void> {
        this.masterKey = master;
        this.secrets = { ...(seed ?? {}) };
        this.record = {
            version: 1,
            prfSalt: prfSalt ?? toBase64(randomBytes(32)),
            unlockers,
            entryIds: Object.keys(this.secrets),
            payload: await encryptJson(master, this.secrets),
        };
        this.io.save(this.record);
        this.emit();
    }

    private async adoptMasterKey(master: CryptoKey): Promise<void> {
        const record = this.requireRecord();
        this.masterKey = master;
        this.secrets = record.payload ? await decryptJson<Record<string, string>>(master, record.payload) : {};
        this.emit();
    }

    private async persistSecrets(): Promise<void> {
        const master = this.requireMaster();
        const record = this.requireRecord();
        const secrets = this.secrets ?? {};
        this.writeRecord({
            ...record,
            entryIds: Object.keys(secrets),
            payload: await encryptJson(master, secrets),
        });
    }

    private writeRecord(record: VaultRecord): void {
        this.record = record;
        this.io.save(record);
        this.emit();
    }

    private buildSnapshot(): VaultSnapshot {
        if (!this.record) return EMPTY_SNAPSHOT;
        return {
            exists: true,
            locked: this.masterKey === null,
            entryIds: [...this.record.entryIds],
            unlockers: this.record.unlockers.map(u => ({
                id: u.id, kind: u.kind, label: u.label, createdAt: u.createdAt,
            })),
        };
    }

    private emit(): void {
        this.snapshot = this.buildSnapshot();
        for (const listener of this.listeners) listener();
    }
}

/** The app's vault. One per page — the unlocked state is deliberately shared
 *  across profiles, so opening a second game after unlocking the first asks for
 *  nothing. */
export const credentialVault = new CredentialVault();
