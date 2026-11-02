// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CredentialVault } from '../../src/vault/CredentialVault';
import { installVault, uninstallVault } from '../../src/vault/vaultAccess';
import type { VaultRecord } from '../../src/vault/vaultRecord';
import { VaultModal, describeVaultContents } from '../../src/ui/VaultModal';
import { ConfirmProvider } from '../../src/ui/components/ConfirmDialog';

// The manage view has to show GMCP Char.Login sign-ins next to the passwords:
// it is the one place a player can see that a game will sign them in silently,
// and remove that from any profile without opening it. (JSX avoided so the file
// stays a plain .test.ts, matching the suite's include glob.)

function memoryIO() {
    let record: VaultRecord | null = null;
    return {
        load: () => record,
        save: (r: VaultRecord | null) => { record = r ? JSON.parse(JSON.stringify(r)) as VaultRecord : null; },
    };
}

const render = () => renderToStaticMarkup(createElement(ConfirmProvider, null, createElement(VaultModal, {
    mode: 'manage',
    connectionNames: { c1: 'Achaea', c2: 'StickMUD' },
    onDone: () => {},
})));

describe('vault manage view — saved sign-ins', () => {
    let vault: CredentialVault;

    beforeAll(async () => {
        vault = new CredentialVault(memoryIO());
        await vault.createWithPassphrase('correct horse battery');
        await vault.setPassword('c1', 'hunter2');
        await vault.setSignIn('c2', { account: 'rahj', provider: 'discord', token: 'tok', secureOnly: true });
        // A resume hint holds no secret and is not worth listing.
        await vault.setSignIn('c1', { account: 'rahj', provider: 'google' });
        installVault(vault, () => null);
    });
    afterAll(() => uninstallVault());

    it('lists profiles with a saved sign-in token, by name', () => {
        const html = render();
        expect(html).toContain('Saved sign-ins (1)');
        expect(html).toContain('aria-label="Remove the saved sign-in for StickMUD"');
        expect(html).not.toContain('Remove the saved sign-in for Achaea');
    });

    it('keeps the list while locked, with removal disabled', () => {
        vault.lock();
        const html = render();
        expect(html).toContain('Saved sign-ins (1)');
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Remove the saved sign-in for StickMUD"/);
    });

    it('omits the section when there is none', async () => {
        await vault.unlockWithPassphrase('correct horse battery');
        await vault.setSignIn('c2', null);
        expect(render()).not.toContain('Saved sign-ins');
    });
});

describe('describeVaultContents', () => {
    it('names what deleting the vault would lose', () => {
        expect(describeVaultContents(1, 0)).toBe('The one password in here');
        expect(describeVaultContents(3, 0)).toBe('The 3 passwords in here');
        expect(describeVaultContents(0, 0)).toBe('The 0 passwords in here');
        expect(describeVaultContents(0, 1)).toBe('The one saved sign-in in here');
        expect(describeVaultContents(2, 3)).toBe('The 2 passwords and 3 saved sign-ins in here');
    });
});
