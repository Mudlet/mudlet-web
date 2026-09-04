/**
 * Passkey-backed vault unlocking, via the WebAuthn **PRF extension**.
 *
 * PRF turns an authenticator into a keyed pseudo-random function: given a salt,
 * the credential returns the same 32 secret bytes every time, and those bytes
 * never leave the authenticator's control without a user-verification gesture
 * (Touch ID, Windows Hello, a security key's PIN). We use them as the KEK for
 * one vault unlocker — so "unlock" is a fingerprint rather than a typed secret,
 * and the browser's password manager holds a single passkey for the app instead
 * of one saved login per game.
 *
 * There is no server here. The challenges are client-side randomness and the
 * signature is never verified: we are deriving a key, not authenticating. That
 * is why registration invents a local user handle.
 *
 * Support is feature-detected at registration: `create()` reports `prf.enabled`,
 * and an authenticator that says no cannot back a vault, so the caller falls
 * back to a passphrase.
 */

import { randomBytes, toBase64, fromBase64 } from './vaultCrypto';

/** Registered credential, as persisted in the vault record. */
export interface PasskeyRegistration {
    /** Raw credential id, base64 — replayed in `allowCredentials` at unlock. */
    credentialId: string;
}

interface PrfExtensionResults {
    enabled?: boolean;
    results?: { first?: ArrayBuffer };
}

function prfResults(cred: PublicKeyCredential): PrfExtensionResults | undefined {
    return (cred.getClientExtensionResults() as { prf?: PrfExtensionResults }).prf;
}

/** True when the browser exposes WebAuthn at all. PRF support is only knowable
 *  after a registration attempt, so this is a pre-filter, not a guarantee. */
export function passkeysAvailable(): boolean {
    return typeof window !== 'undefined'
        && typeof window.PublicKeyCredential === 'function'
        && !!navigator.credentials?.create;
}

/** True when this device has a built-in authenticator (Touch ID, Hello, Android
 *  screen lock) — used only to word the offer, never to gate it: security keys
 *  do PRF too. */
export async function platformAuthenticatorAvailable(): Promise<boolean> {
    if (!passkeysAvailable()) return false;
    try {
        return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
        return false;
    }
}

/**
 * Register a new passkey for the vault and check that it can do PRF.
 *
 * Returns `null` when the credential was created but the authenticator refused
 * PRF — the caller must then fall back to a passphrase. Throws when the user
 * cancels or registration fails outright.
 */
export async function registerVaultPasskey(appName: string, label: string): Promise<PasskeyRegistration | null> {
    const cred = await navigator.credentials.create({
        publicKey: {
            challenge: randomBytes(32) as unknown as BufferSource,
            // rp.id defaults to the current origin's effective domain, which is
            // exactly the scoping we want: a vault passkey made on one host is
            // never offered on another.
            rp: { name: appName },
            user: {
                // No account system — the handle is local bookkeeping so the
                // authenticator has something to file the credential under.
                id: randomBytes(16) as unknown as BufferSource,
                name: label,
                displayName: label,
            },
            pubKeyCredParams: [
                { type: 'public-key', alg: -7 },    // ES256
                { type: 'public-key', alg: -257 },  // RS256
            ],
            authenticatorSelection: {
                // Discoverable so the unlock prompt can list it by name, but not
                // required: authenticators with full credential storage refuse
                // 'required' once full, and we replay the id anyway.
                residentKey: 'preferred',
                // The whole point is a gesture that proves presence *and* user
                // identity before the KEK is released.
                userVerification: 'required',
            },
            extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
            timeout: 120_000,
        },
    }) as PublicKeyCredential | null;
    if (!cred) return null;
    // Chrome reports capability at registration but withholds the PRF output
    // until an assertion; Safari may return results here. Either way `enabled`
    // is the reliable capability signal.
    if (!prfResults(cred)?.enabled) return null;
    return { credentialId: toBase64(cred.rawId) };
}

/**
 * Evaluate the vault's PRF salt against whichever registered passkey the user
 * presents, and return the 32 secret bytes it answers with.
 *
 * All known credentials go into one `allowCredentials` list so a vault holding
 * a laptop's Touch ID *and* a phone opens from either in a single prompt. That
 * works because the salt belongs to the vault, not to a credential: one
 * assertion cannot evaluate a different salt per credential, and the KEKs stay
 * distinct regardless, since PRF output is keyed by the credential's own secret.
 *
 * Returns `null` when the authenticator answered without a PRF result. A cancel
 * or timeout throws, as WebAuthn does.
 */
export async function evaluateVaultPrf(
    registrations: PasskeyRegistration[],
    prfSalt: Uint8Array,
): Promise<{ credentialId: string; secret: Uint8Array } | null> {
    if (registrations.length === 0) return null;
    const assertion = await navigator.credentials.get({
        publicKey: {
            challenge: randomBytes(32) as unknown as BufferSource,
            allowCredentials: registrations.map(r => ({
                type: 'public-key' as const,
                id: fromBase64(r.credentialId) as unknown as BufferSource,
            })),
            userVerification: 'required',
            extensions: {
                prf: { eval: { first: prfSalt as unknown as BufferSource } },
            } as AuthenticationExtensionsClientInputs,
            timeout: 120_000,
        },
    }) as PublicKeyCredential | null;
    const first = assertion && prfResults(assertion)?.results?.first;
    if (!assertion || !first) return null;
    return { credentialId: toBase64(assertion.rawId), secret: new Uint8Array(first) };
}
