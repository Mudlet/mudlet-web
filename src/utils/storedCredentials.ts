import { useAppStore } from '../storage';
import { getSessionCredentials } from './sessionCredentials';
import { getVault, vaultPassword } from '../vault/vaultAccess';

/**
 * Where auto-login credentials come from, in priority order — one place so the
 * GMCP `Char.Login` path and the text-login state machine can never disagree
 * about which password they are about to send.
 *
 * 1. **In-memory** (`sessionCredentials`) — a branded build's login form. Those
 *    builds never persist anything, so this is the only source they have.
 * 2. **The credential vault**, when one is installed and unlocked.
 * 3. **`charLoginPassword` on the connection record** — the pre-vault plaintext
 *    field. Never written any more (see issue #25) and no longer offered in the
 *    UI, but still read so that an existing saved login keeps working until the
 *    user sets a vault up, at which point it is migrated and deleted
 *    (`useVaultSaver`).
 *
 * The account name is not a secret and stays on the connection record either
 * way: prefilling it is also what lets a browser password manager pick the one
 * matching password instead of offering every profile's.
 */
export interface StoredLogin {
    account: string;
    password: string;
}

export function readStoredLogin(connectionId: string): StoredLogin {
    const mem = getSessionCredentials(connectionId);
    if (mem) return { account: mem.account, password: mem.password };
    const conn = useAppStore.getState().connections.find(c => c.id === connectionId);
    return {
        account: conn?.charLoginAccount ?? '',
        password: vaultPassword(connectionId) ?? conn?.charLoginPassword ?? '',
    };
}

/**
 * Drop vault entries for profiles that no longer exist.
 *
 * Deleting a profile can't rewrite the vault when it is locked — there is no
 * key to re-encrypt the remaining secrets with — so `forgetConnection` leaves
 * the entry behind and the sweep happens here instead, on the next unlock.
 */
export function pruneVaultEntries(): void {
    const ids = useAppStore.getState().connections.map(c => c.id);
    void getVault()?.pruneMissing(ids);
}
