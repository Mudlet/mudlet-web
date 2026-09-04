import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useAppStore } from '../storage';
import { getVault, getVaultUI } from '../vault/vaultAccess';
import { pruneVaultEntries } from '../utils/storedCredentials';
import { useVault } from '../vault/useVault';

/**
 * "Save this password" for the two places that offer it — the GMCP login popup
 * and the connection editor.
 *
 * Saving can need a detour: the vault may not exist yet (set one up) or may be
 * locked (unlock it). Rather than making every caller sequence that, `save()`
 * parks the password and returns, the returned `element` renders whichever step
 * is needed, and the write happens once it succeeds.
 *
 * In a build with no vault installed `canSave` is false and `element` is null —
 * callers then don't offer the checkbox at all (see `vault/vaultAccess`).
 */
export interface VaultSaver {
    /** True when a vault can be written to, now or after a setup/unlock step. */
    canSave: boolean;
    /** Store (or, with `null`, forget) a profile's password, prompting first if
     *  the vault needs setting up or unlocking. */
    save: (connectionId: string, password: string | null) => void;
    /** Explains where a ticked checkbox will put the password. */
    note: string;
    /** Render this next to the form — the setup/unlock modal, when one is due.
     *  Mount it somewhere that outlives the form: saving usually closes it. */
    element: ReactNode;
}

export function useVaultSaver(): VaultSaver {
    const snapshot = useVault();
    const connections = useAppStore(s => s.connections);
    const patchConnection = useAppStore(s => s.patchConnection);
    const [prompt, setPrompt] = useState<'setup' | 'unlock' | null>(null);
    const pending = useRef<{ connectionId: string; password: string } | null>(null);
    const vault = getVault();
    const VaultUI = getVaultUI();

    const save = useCallback((connectionId: string, password: string | null) => {
        const v = getVault();
        if (!v) return;
        if (!password) {
            // Clearing needs the vault open too, but a locked vault holding a
            // password the user just asked to drop is not worth a prompt: the
            // entry is swept the next time the vault opens (pruneMissing).
            void v.forgetConnection(connectionId);
            return;
        }
        if (!v.exists) { pending.current = { connectionId, password }; setPrompt('setup'); return; }
        if (v.locked) { pending.current = { connectionId, password }; setPrompt('unlock'); return; }
        void v.setPassword(connectionId, password);
    }, []);

    /** Passwords still sitting in plaintext on connection records, from before
     *  the vault existed. Folded into a vault at creation and deleted from the
     *  store immediately after, so the cleartext copy never outlives its
     *  replacement. */
    const legacySeed = (): Record<string, string> => {
        const seed: Record<string, string> = {};
        for (const c of connections) if (c.charLoginPassword) seed[c.id] = c.charLoginPassword;
        return seed;
    };

    const finish = (result: 'created' | 'unlocked' | 'closed') => {
        setPrompt(null);
        const queued = pending.current;
        pending.current = null;
        if (result === 'closed') return;
        // The vault is open now, so entries left behind by profiles deleted while
        // it was locked can finally be swept.
        pruneVaultEntries();
        if (result === 'created') {
            for (const c of connections) {
                if (c.charLoginPassword) patchConnection(c.id, { charLoginPassword: undefined });
            }
        }
        if (queued) void getVault()?.setPassword(queued.connectionId, queued.password);
    };

    const names: Record<string, string> = {};
    for (const c of connections) names[c.id] = c.name;

    return {
        canSave: !!vault && vault.available,
        save,
        note: snapshot.exists
            ? 'Kept in your encrypted saved logins, unlocked once per visit.'
            : 'Sets up encrypted saved logins the first time — a passkey, or one passphrase your password manager can remember.',
        element: prompt && VaultUI
            ? (
                <VaultUI
                    mode={prompt}
                    seed={prompt === 'setup' ? legacySeed() : undefined}
                    connectionNames={names}
                    onDone={finish}
                />
            )
            : null,
    };
}
