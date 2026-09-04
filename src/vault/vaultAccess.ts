/**
 * The seam between the app and the credential vault.
 *
 * The vault is a **stock-app feature only**. A branded build ships for one game,
 * so the problem it solves — ten profiles' logins piling up indistinguishably in
 * one origin's password-manager dropdown — does not exist there, and branded
 * builds keep credentials in memory for the page (`utils/sessionCredentials`)
 * rather than storing them at all.
 *
 * So the library entry (`src/index.ts` → `MudletWebApp`) must not reach the
 * vault, and this module is how: it is the only vault file the shared UI
 * imports, it names the vault and its modal through `import type` alone, and
 * `main.tsx` — which the standalone app loads and the library does not — is what
 * puts the real ones in. Nothing here pulls in crypto, WebAuthn or the modal, so
 * a consumer build contains none of it; every `getVault()` there is `null` and
 * the callers render nothing.
 */

import type { ComponentType } from 'react';
import type { CredentialVault, VaultSnapshot } from './CredentialVault';

/** Props of the vault's modal. Declared here, not in the component, so this
 *  module can describe the UI it hands out without importing it. */
export interface VaultUIProps {
    /** Which step to show: create a vault, open one, or manage one. */
    mode: 'setup' | 'unlock' | 'manage';
    /** Why an unlock is being asked for — e.g. the profile being opened. */
    reason?: string;
    /** Plaintext passwords to fold into a *new* vault, keyed by connection id. */
    seed?: Record<string, string>;
    /** Profile id → display name, for the saved-logins list. */
    connectionNames?: Record<string, string>;
    onDone: (result: 'created' | 'unlocked' | 'closed') => void;
}

export type VaultUI = ComponentType<VaultUIProps>;

/** What a consumer without a vault sees. Frozen and shared: `useSyncExternalStore`
 *  needs a stable identity from a snapshot that has not changed. */
export const NO_VAULT: VaultSnapshot = Object.freeze({
    exists: false,
    locked: false,
    entryIds: Object.freeze([]) as readonly string[],
    unlockers: Object.freeze([]) as VaultSnapshot['unlockers'],
});

let active: CredentialVault | null = null;
let activeUI: VaultUI | null = null;
const listeners = new Set<() => void>();
let unsubscribeActive: (() => void) | null = null;

/**
 * Make a vault (and the UI that drives it) available to the app. Called once
 * from `main.tsx`, before the first render, so credential reads on a cold
 * auto-connect never race the install.
 */
export function installVault(vault: CredentialVault, ui: VaultUI): void {
    unsubscribeActive?.();
    active = vault;
    activeUI = ui;
    // Re-broadcast the vault's own changes to anything that subscribed before it
    // existed, so a component mounted at boot re-renders when it arrives.
    unsubscribeActive = vault.subscribe(notify);
    notify();
}

/** Drop the installed vault. Tests only — the app installs once per page. */
export function uninstallVault(): void {
    unsubscribeActive?.();
    unsubscribeActive = null;
    active = null;
    activeUI = null;
    notify();
}

/** The app's vault, or `null` in a build that never installed one. */
export function getVault(): CredentialVault | null {
    return active;
}

/** The vault's modal, or `null` — render it only when this is non-null. */
export function getVaultUI(): VaultUI | null {
    return activeUI;
}

export function subscribeVault(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function vaultSnapshot(): VaultSnapshot {
    return active ? active.getSnapshot() : NO_VAULT;
}

/** A stored password, or `undefined` when there is no vault, no entry, or the
 *  vault is locked. All three mean the same thing to a caller: ask the user. */
export function vaultPassword(connectionId: string): string | undefined {
    return active?.getPassword(connectionId);
}

/** Whether this profile has a stored password — true even while locked, which
 *  is what tells the app an unlock is worth offering. */
export function vaultHasEntry(connectionId: string): boolean {
    return !!active?.hasEntry(connectionId);
}

/** Whether opening this profile should ask for an unlock first. */
export function vaultNeedsUnlock(connectionId: string): boolean {
    return !!active?.locked && !!active.hasEntry(connectionId);
}

function notify(): void {
    for (const listener of listeners) listener();
}
