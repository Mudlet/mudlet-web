import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './App.css';
import './ui/components/components.css';
import { MudletWebApp } from './MudletWebApp';
import { credentialVault } from './vault/CredentialVault';
import { VaultModal } from './ui/VaultModal';
import { installVault } from './vault/vaultAccess';
import { installVaultHelpTopic } from './vault/vaultHelpTopic';

// The stock app is just MudletWebApp with no brand — branded builds import
// MudletWebApp from the library entry and pass their own BrandConfig. Page
// bootstrap (VFS service worker, pinch-zoom guard) happens inside MudletWebApp.
//
// The credential vault is wired up here and nowhere else. It exists to keep many
// profiles' saved logins apart, which a single-game branded build has no use
// for, so the library entry must not pull it in — and these two imports are the
// only ones anywhere that name it, which is what keeps it out of `dist-lib`
// entirely rather than merely unused there. See `vault/vaultAccess`.
installVault(credentialVault, VaultModal);
installVaultHelpTopic();

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <MudletWebApp />
    </StrictMode>,
);
