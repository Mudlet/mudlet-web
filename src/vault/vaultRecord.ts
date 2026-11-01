/**
 * On-disk shape of the credential vault, and its (synchronous) persistence.
 *
 * The record lives in `localStorage` rather than IndexedDB on purpose: it is
 * small, and everything sensitive in it is already AES-GCM ciphertext, so the
 * weakness that made plaintext `charLoginPassword` a bad idea — localStorage is
 * readable by anything running on the page — costs nothing here. In exchange
 * the vault's *shape* (does one exist, which profiles have a saved password) is
 * readable synchronously during the first render, with no async init race and
 * no loading state in every consumer.
 *
 * It is deliberately NOT part of the Zustand store: `mudix_v1` is exported,
 * imported and reset by profile tooling, and vault material must not travel
 * with a profile export.
 */

import type { Ciphertext } from './vaultCrypto';

export const VAULT_STORAGE_KEY = 'mudlet_vault_v1';

interface UnlockerBase {
    /** Stable local id, so the manage UI can remove one unambiguously. */
    id: string;
    /** User-facing name ("Passphrase", "MacBook Touch ID"). */
    label: string;
    createdAt: string;
    /** The vault's master key, wrapped by the KEK this unlocker derives. */
    wrapped: Ciphertext;
}

export interface PassphraseUnlocker extends UnlockerBase {
    kind: 'passphrase';
    /** PBKDF2 salt, base64. */
    salt: string;
    /** PBKDF2 iteration count *as used*, so the cost can be raised for new
     *  vaults without stranding existing ones. */
    iterations: number;
}

export interface PasskeyUnlocker extends UnlockerBase {
    kind: 'passkey';
    /** WebAuthn credential id, base64. */
    credentialId: string;
}

export type VaultUnlocker = PassphraseUnlocker | PasskeyUnlocker;

export interface VaultRecord {
    version: 1;
    /** 32-byte PRF salt shared by every passkey unlocker, base64. See
     *  `evaluateVaultPrf` for why it is per-vault and not per-credential. */
    prfSalt: string;
    unlockers: VaultUnlocker[];
    /** Connection ids that have a stored password. Plaintext by design — it is
     *  what lets a *locked* vault answer "does this profile have a saved login?"
     *  so the app knows whether to offer an unlock at all. */
    entryIds: string[];
    /** AES-GCM under the master key over `Record<connectionId, password>`.
     *  `null` before the first secret is stored. */
    payload: Ciphertext | null;
    /** Profiles holding a saved GMCP `Char.Login` sign-in token (see
     *  {@link VaultSignIn}). Plaintext for the same reason as `entryIds`: a
     *  locked vault has to be able to say a profile has something worth
     *  unlocking for. Absent in a record written before sign-ins existed. */
    signInIds?: string[];
    /** AES-GCM under the master key over `Record<connectionId, VaultSignIn>`.
     *  A field of its own rather than more keys in `payload`, so a build from
     *  before sign-ins existed still reads its passwords unchanged, and carries
     *  this across its own writes untouched (it spreads the record). */
    signInPayload?: Ciphertext | null;
}

/**
 * A saved GMCP `Char.Login` v2 sign-in: the reconnect token a game issued with
 * `Char.Login.Token`, the account it names, and what is needed to replay it
 * safely — or to resume the same provider once it stops working.
 *
 * Mudlet keeps the same entry in the OS keychain (`GMCPAuthenticator`'s
 * metadata + token keys). The token is a bearer secret — it signs the account
 * in without a password — so it lives encrypted here or not at all.
 */
export interface VaultSignIn {
    /** The account the token was issued for; `Char.Login.Reconnect` names it. */
    account: string;
    /** Provider id (`discord`, `google`, …) learned from `Char.Login.URL`, so a
     *  dead token can turn into a resume of that provider's sign-in. */
    provider?: string;
    /** The bearer token. Absent in a resume hint left behind by a dead one. */
    token?: string;
    /** The token may only be replayed over an encrypted game connection — the
     *  issuing server's requirement, stored because the connection that set it
     *  is long gone by replay time. Missing reads as true, never widening. */
    secureOnly?: boolean;
}

function isCiphertext(v: unknown): v is Ciphertext {
    const c = v as Ciphertext | null;
    return !!c && typeof c.iv === 'string' && typeof c.ct === 'string';
}

/** Parse defensively — a corrupt record must degrade to "no vault", never to a
 *  crash on boot that locks the user out of the app as well as the vault. */
export function parseVaultRecord(raw: string | null): VaultRecord | null {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw) as VaultRecord;
        if (v?.version !== 1 || !Array.isArray(v.unlockers) || typeof v.prfSalt !== 'string') return null;
        const unlockers = v.unlockers.filter(u =>
            u && typeof u.id === 'string' && isCiphertext(u.wrapped)
            && (u.kind === 'passphrase' ? typeof u.salt === 'string' : u.kind === 'passkey' && typeof u.credentialId === 'string'));
        if (unlockers.length === 0) return null;
        return {
            version: 1,
            prfSalt: v.prfSalt,
            unlockers,
            entryIds: Array.isArray(v.entryIds) ? v.entryIds.filter(id => typeof id === 'string') : [],
            payload: isCiphertext(v.payload) ? v.payload : null,
            signInIds: Array.isArray(v.signInIds) ? v.signInIds.filter(id => typeof id === 'string') : [],
            signInPayload: isCiphertext(v.signInPayload) ? v.signInPayload : null,
        };
    } catch {
        return null;
    }
}

export function loadVaultRecord(): VaultRecord | null {
    try {
        return parseVaultRecord(localStorage.getItem(VAULT_STORAGE_KEY));
    } catch {
        // Storage disabled (private mode, blocked cookies) — no vault, no throw.
        return null;
    }
}

export function saveVaultRecord(record: VaultRecord | null): void {
    try {
        if (record) localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(record));
        else localStorage.removeItem(VAULT_STORAGE_KEY);
    } catch {
        // Quota or disabled storage. The in-memory vault keeps working for this
        // page; the caller surfaces the failure through the next load returning
        // nothing rather than by exploding mid-save.
    }
}
