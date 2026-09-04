import savedLogins from '../../docs/help/saved-logins.md?raw';
import { registerHelpTopic } from '../ui/helpTopics';

/**
 * The manual page for the credential vault.
 *
 * It lives here rather than in `ui/helpTopics.ts` for the same reason the vault
 * itself does: a branded build ships for one game, has no vault, and must not
 * carry a help topic explaining a feature its players cannot find. Registered
 * from `main.tsx` at boot — the standalone app's entry, never the library's.
 */
export function installVaultHelpTopic(): void {
    registerHelpTopic({
        id: 'saved-logins',
        title: 'Saved logins',
        blurb: 'Encrypted game passwords, and why there is no reset',
        file: 'saved-logins.md',
        markdown: savedLogins,
    }, { after: 'storage' });
}
