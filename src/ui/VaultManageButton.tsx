import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { getVault, getVaultUI } from '../vault/vaultAccess';
import { useVault } from '../vault/useVault';
import type { MudConnection } from '../storage';

interface VaultManageButtonProps {
    /** Every profile, so the manage list can name the ones with a saved login
     *  (the vault itself stores only ids — it has no idea what they are called). */
    connections: MudConnection[];
}

/**
 * "Saved logins" in the connection screen's header icon row — the one place to
 * lock the vault, change how it opens, drop a stored password, or delete the
 * whole thing.
 *
 * Renders nothing when no vault is installed, which is how a branded build gets
 * neither the button nor anything behind it (see `vault/vaultAccess`).
 */
export function VaultManageButton({ connections }: VaultManageButtonProps) {
    const snapshot = useVault();
    const [open, setOpen] = useState(false);
    const VaultUI = getVaultUI();
    if (!getVault() || !VaultUI) return null;

    const names: Record<string, string> = {};
    for (const c of connections) names[c.id] = c.name;

    // The icon is the same either way; the state goes in the tooltip rather than
    // into a second glyph, so the row doesn't shift shape as the vault locks.
    const count = snapshot.entryIds.length;
    const title = !snapshot.exists
        ? 'Saved logins — store game passwords encrypted on this device'
        : `Saved logins (${count}) — ${snapshot.locked ? 'locked' : 'unlocked for this visit'}`;

    return (
        <>
            <button
                className="connection-vault-btn"
                onClick={() => setOpen(true)}
                type="button"
                title={title}
                aria-label={title}
            >
                <KeyRound size={16} />
            </button>
            {open && (
                <VaultUI
                    mode={snapshot.exists ? 'manage' : 'setup'}
                    connectionNames={names}
                    onDone={() => setOpen(false)}
                />
            )}
        </>
    );
}
