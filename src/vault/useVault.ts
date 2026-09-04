import { useSyncExternalStore } from 'react';
import { subscribeVault, vaultSnapshot } from './vaultAccess';
import type { VaultSnapshot } from './CredentialVault';

/**
 * Render off the credential vault's state. Returns the "no vault" snapshot in
 * builds that never installed one (see `vaultAccess`), so every consumer can
 * call this unconditionally and simply render nothing when `exists` is false
 * and the vault cannot be created.
 */
export function useVault(): VaultSnapshot {
    return useSyncExternalStore(subscribeVault, vaultSnapshot, vaultSnapshot);
}
