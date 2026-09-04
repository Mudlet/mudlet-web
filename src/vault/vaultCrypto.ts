/**
 * WebCrypto primitives for the credential vault.
 *
 * Envelope encryption: one random 256-bit AES-GCM **master key** encrypts the
 * secrets blob, and every *unlocker* (a passphrase, a passkey) wraps a copy of
 * that master key with a key-encryption key it derives on its own. Adding or
 * removing an unlock method therefore rewraps one small blob instead of
 * re-encrypting the secrets, and two methods can coexist without either being
 * able to read the other's derivation input.
 *
 * Everything here is pure WebCrypto over plain values — no storage, no DOM —
 * so the format can be tested end-to-end without IndexedDB or a browser.
 */

/** AES-GCM ciphertext plus its nonce, both base64 for JSON storage. */
export interface Ciphertext {
    /** 12-byte GCM nonce, freshly random for every encryption. */
    iv: string;
    /** Ciphertext with the 16-byte GCM tag appended (WebCrypto's layout). */
    ct: string;
}

/**
 * PBKDF2 work factor for passphrase unlockers. OWASP's 2023 floor for
 * PBKDF2-HMAC-SHA256; ~0.3s on a mid-range laptop, which is the right trade for
 * something typed once per page rather than once per keystroke. Stored *in* the
 * record so the number can be raised later without stranding existing vaults.
 */
export const PBKDF2_ITERATIONS = 600_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

function subtle(): SubtleCrypto {
    const c = globalThis.crypto;
    // Non-secure origins (plain http:// other than localhost) get `crypto` but
    // not `crypto.subtle`. Worth naming precisely: "vault unavailable" with no
    // reason sends people hunting through browser settings.
    if (!c?.subtle) {
        throw new Error('Web Crypto is unavailable — the vault needs a secure context (https or localhost).');
    }
    return c.subtle;
}

/** True when this context can do vault crypto at all. */
export function cryptoAvailable(): boolean {
    return !!globalThis.crypto?.subtle;
}

export function randomBytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    globalThis.crypto.getRandomValues(out);
    return out;
}

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i]);
    return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

/** A fresh master key. Extractable — it has to be, to be wrapped by unlockers. */
export async function generateMasterKey(): Promise<CryptoKey> {
    return subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/**
 * Stretch a passphrase into a key-encryption key. The KEK never encrypts
 * secrets directly — it only wraps the master key — so changing the passphrase
 * costs one rewrap.
 */
export async function deriveKeyFromPassphrase(
    passphrase: string,
    salt: Uint8Array,
    iterations = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
    const material = await subtle().importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey(
        { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

/**
 * Stretch a WebAuthn PRF result into a key-encryption key. The PRF output is
 * already 32 uniformly-random bytes bound to the authenticator, so this is a
 * domain-separating HKDF rather than a cost function — there is nothing to
 * brute-force without the authenticator.
 */
export async function deriveKeyFromPrf(prfOutput: ArrayBuffer | Uint8Array): Promise<CryptoKey> {
    const raw = prfOutput instanceof Uint8Array ? prfOutput : new Uint8Array(prfOutput);
    const material = await subtle().importKey('raw', raw as unknown as BufferSource, 'HKDF', false, ['deriveKey']);
    return subtle().deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(0) as unknown as BufferSource,
            info: enc.encode('mudlet-web/vault/prf-kek/v1'),
        },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

export async function encryptBytes(key: CryptoKey, plaintext: Uint8Array): Promise<Ciphertext> {
    const iv = randomBytes(12);
    const ct = await subtle().encrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        key,
        plaintext as unknown as BufferSource,
    );
    return { iv: toBase64(iv), ct: toBase64(ct) };
}

/** Decrypt, or throw — GCM authentication failure is how a wrong passphrase is detected. */
export async function decryptBytes(key: CryptoKey, box: Ciphertext): Promise<Uint8Array> {
    const plain = await subtle().decrypt(
        { name: 'AES-GCM', iv: fromBase64(box.iv) as unknown as BufferSource },
        key,
        fromBase64(box.ct) as unknown as BufferSource,
    );
    return new Uint8Array(plain);
}

export async function encryptJson(key: CryptoKey, value: unknown): Promise<Ciphertext> {
    return encryptBytes(key, enc.encode(JSON.stringify(value)));
}

export async function decryptJson<T>(key: CryptoKey, box: Ciphertext): Promise<T> {
    return JSON.parse(dec.decode(await decryptBytes(key, box))) as T;
}

/** Wrap the master key for one unlocker. */
export async function wrapMasterKey(kek: CryptoKey, master: CryptoKey): Promise<Ciphertext> {
    const raw = new Uint8Array(await subtle().exportKey('raw', master));
    return encryptBytes(kek, raw);
}

/** Recover the master key from an unlocker's wrapped copy. Throws on a bad KEK. */
export async function unwrapMasterKey(kek: CryptoKey, wrapped: Ciphertext): Promise<CryptoKey> {
    const raw = await decryptBytes(kek, wrapped);
    return subtle().importKey('raw', raw as unknown as BufferSource, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}
