/**
 * Human-readable names for the certificate faults a proxy can report.
 *
 * The wire codes are OpenSSL/Node verify codes (the Node proxy) plus a couple
 * of synthetic ones for runtimes that can't tell us more (the Cloudflare
 * Worker). Anything unrecognised falls back to the raw code so a newer proxy
 * can report faults this build has never heard of without losing information.
 */
const CERT_CODE_LABELS: Record<string, string> = {
    CERT_HAS_EXPIRED: 'the certificate has expired',
    CERT_NOT_YET_VALID: 'the certificate is not valid yet',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'the certificate is self-signed',
    SELF_SIGNED_CERT_IN_CHAIN: 'the certificate chain ends in a self-signed certificate',
    ERR_TLS_CERT_ALTNAME_INVALID: 'the certificate was issued for a different host',
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'the issuing authority is not trusted',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the certificate signature could not be verified',
    TLS_HANDSHAKE_FAILED: 'the secure handshake failed',
};

export function describeCertCode(code: string): string {
    return CERT_CODE_LABELS[code] ?? code;
}

/**
 * Whether a reported fault is a verdict on the peer's *certificate*.
 *
 * Only these can be waived — by Mudlet's three tolerance checkboxes, or by
 * anything else. `TLS_HANDSHAKE_FAILED` is deliberately absent: it is the
 * synthetic code the Cloudflare Worker proxy reports when the TLS layer died
 * before a single byte was decrypted (`worker/index.js` `reportTlsFailure`),
 * which happens when the far end never spoke TLS at all — the classic case
 * being TLS pointed at a game's plaintext port — or when the socket failed to
 * open. No certificate is involved either way, so calling it a certificate
 * problem sends the user hunting for a misconfiguration that does not exist.
 *
 * A rejected *certificate* cannot even reach us from that runtime: measured
 * against workerd, the socket simply goes silent, which surfaces as
 * `tls.timeout` rather than `tls.error`.
 *
 * Anything unrecognised is treated as a certificate fault, because every code a
 * proxy reports other than the synthetic one is an OpenSSL verify code.
 */
const NON_CERTIFICATE_FAULTS = new Set(['TLS_HANDSHAKE_FAILED', 'TLS_ERROR']);

export function isCertificateFault(code: string): boolean {
    return !NON_CERTIFICATE_FAULTS.has(code);
}

/** Which of Mudlet's three tolerance checkboxes would clear a given fault, or
 *  null when no checkbox can — the fault is not about a certificate. */
export function toleranceForCode(code: string): 'expired' | 'selfSigned' | 'all' | null {
    if (!isCertificateFault(code)) return null;
    if (code === 'CERT_HAS_EXPIRED') return 'expired';
    if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') return 'selfSigned';
    return 'all';
}

const TOLERANCE_LABEL: Record<'expired' | 'selfSigned' | 'all', string> = {
    expired: 'Accept expired certificates',
    selfSigned: 'Accept self-signed certificates',
    all: 'Accept all certificate errors',
};

/** What the UI needs to know about a failed handshake, in prose. */
export interface TlsFailureExplanation {
    /** What went wrong, as one sentence. */
    summary: string;
    /** What to do about it, or null when nothing honest can be suggested.
     *  Never names a control that isn't rendered. */
    remedy: string | null;
    /** True when the fault is about the peer's certificate at all. */
    certificateFault: boolean;
}

/**
 * Turn a `tls.error` into a diagnosis and a remedy that exists.
 *
 * Both used to be composed from the certificate vocabulary regardless of what
 * failed: connecting with TLS to a plaintext port was reported as a certificate
 * refusal and the user was told to tick "Accept all certificate errors" in
 * Settings → Network — a control that is not rendered on the default
 * Cloudflare-Worker proxy (`proxyCanInspectCertificates` is false for every
 * `*.workers.dev` host, so that panel says "Certificate options unavailable"
 * instead), and that would not have helped if it were.
 *
 * Desktop Mudlet reports the underlying socket/SSL error verbatim and only
 * offers the ignore-certificate settings when they apply; its answer to a
 * `QAbstractSocket::SslHandshakeFailedError` is "Secure connections not
 * supported by this game on this port; try turning the option off"
 * (`src/ctelnet.cpp:865`). This is that, phrased for the controls this client
 * actually has.
 */
export function describeTlsFailure(info: {
    code: string;
    message?: string;
    codes?: string[];
    /** False when the proxy runtime cannot inspect certificates at all, and so
     *  cannot offer — or render — the tolerance options. */
    certInspection?: boolean;
}): TlsFailureExplanation {
    const codes = info.codes?.length ? info.codes : [info.code];
    const certCodes = codes.filter(isCertificateFault);

    if (certCodes.length === 0) {
        // No certificate was involved. Say what the proxy actually reported —
        // Mudlet shows the socket error text verbatim — and point at the two
        // things that genuinely fix it.
        const detail = info.message?.trim();
        return {
            certificateFault: false,
            summary: detail
                ? `The secure handshake didn't complete: ${detail}.`
                : "The secure handshake didn't complete — nothing on that port answered as a TLS server.",
            remedy: 'No certificate was involved, so the certificate options cannot help. If the game '
                + 'does not offer TLS on this port, turn off “Secure connection (TLS)” in '
                + 'Settings → Network, or connect on its TLS port — usually a different one from the '
                + 'plaintext port.',
        };
    }

    const summary = `The game's certificate was refused because ${certCodes.map(describeCertCode).join('; ')}.`;
    if (info.certInspection === false) {
        // The tolerance checkboxes are not rendered for this proxy, so naming
        // them would send the user looking for a control that isn't there.
        return {
            certificateFault: true,
            summary,
            remedy: 'This proxy runs on Cloudflare Workers, which cannot override a certificate '
                + 'failure, so there is no setting here that would accept it. A self-hosted Node '
                + 'proxy can.',
        };
    }
    // The narrowest set of settings that would clear every reported fault.
    const hints = [...new Set(certCodes.map(c => TOLERANCE_LABEL[toleranceForCode(c)!]))];
    return {
        certificateFault: true,
        summary,
        remedy: `You can allow it with “${hints.join('” and “')}” in Settings → Network.`,
    };
}
