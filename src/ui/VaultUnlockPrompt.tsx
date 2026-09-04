import { getVaultUI } from '../vault/vaultAccess';

interface VaultUnlockPromptProps {
    /** Why the app is asking right now — shown above the unlock controls. */
    reason: string;
    onDone: (result: 'created' | 'unlocked' | 'closed') => void;
}

/**
 * The unlock step on its own.
 *
 * Kept separate from `useVaultSaver` because unlocking is asked for on the read
 * path — a profile with a saved login is being opened — where there is nothing
 * to save and no vault to create. Renders nothing in a build that installed no
 * vault UI, which is how a branded build gets none of this.
 */
export function VaultUnlockPrompt({ reason, onDone }: VaultUnlockPromptProps) {
    const VaultUI = getVaultUI();
    if (!VaultUI) return null;
    return <VaultUI mode="unlock" reason={reason} onDone={onDone} />;
}
