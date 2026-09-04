import { useState } from 'react';
import { Button } from './components';
import { getVault, getVaultUI } from '../vault/vaultAccess';
import { useVault } from '../vault/useVault';
import type { MudConnection } from '../storage';

interface VaultManageButtonProps {
    connections: MudConnection[];
    disabled?: boolean;
}

/**
 * "Saved logins" on the connection screen's tools row — the one place to lock
 * the vault, change how it opens, drop a stored password or delete the whole
 * thing.
 *
 * Renders nothing when no vault is installed, which is how a branded build gets
 * neither the button nor anything behind it (see `vault/vaultAccess`).
 */
export function VaultManageButton({ connections, disabled }: VaultManageButtonProps) {
    const snapshot = useVault();
    const [open, setOpen] = useState(false);
    const VaultUI = getVaultUI();
    if (!getVault() || !VaultUI) return null;

    const names: Record<string, string> = {};
    for (const c of connections) names[c.id] = c.name;

    return (
        <>
            <Button
                variant="secondary"
                size="sm"
                disabled={disabled}
                onClick={() => setOpen(true)}
                title="Passwords stored encrypted on this device, unlocked once per visit"
            >
                {snapshot.exists ? `Saved logins (${snapshot.entryIds.length})` : 'Saved logins…'}
            </Button>
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
