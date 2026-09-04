import { describe, it, expect } from 'vitest';
import {
    describeTlsFailure,
    isCertificateFault,
    toleranceForCode,
} from '../../../src/mud/protocol/tlsCodes';

/**
 * Connecting with TLS to a *plaintext* port used to be reported as a
 * certificate refusal, with a remedy that does not exist.
 *
 * `worker/index.js` `reportTlsFailure` emits the synthetic
 * `TLS_HANDSHAKE_FAILED` with `certInspection: false`; the UI then composed
 * "The game's certificate was refused because the secure handshake failed" and
 * offered "Accept all certificate errors" in Settings → Network — a checkbox
 * that panel never renders on a Worker proxy (`proxyCanInspectCertificates()`
 * is false for every `*.workers.dev` host), and that would not have helped if
 * it did: there is no certificate in that failure at all.
 *
 * Desktop Mudlet reports the underlying socket/SSL error verbatim and only
 * offers the ignore-certificate settings when they apply — its answer to a
 * SslHandshakeFailedError is "Secure connections not supported by this game on
 * this port; try turning the option off" (src/ctelnet.cpp:865). See issue #52.
 */
describe('isCertificateFault', () => {
    it('treats the synthetic handshake code as not a certificate verdict', () => {
        expect(isCertificateFault('TLS_HANDSHAKE_FAILED')).toBe(false);
    });

    it('treats OpenSSL verify codes — including unknown ones — as certificate faults', () => {
        expect(isCertificateFault('CERT_HAS_EXPIRED')).toBe(true);
        expect(isCertificateFault('DEPTH_ZERO_SELF_SIGNED_CERT')).toBe(true);
        // A newer proxy may report a code this build has never heard of; every
        // one a proxy sends other than the synthetic ones is a verify code.
        expect(isCertificateFault('CERT_REVOKED')).toBe(true);
    });
});

describe('toleranceForCode', () => {
    it('maps each certificate fault to the narrowest checkbox that clears it', () => {
        expect(toleranceForCode('CERT_HAS_EXPIRED')).toBe('expired');
        expect(toleranceForCode('SELF_SIGNED_CERT_IN_CHAIN')).toBe('selfSigned');
        expect(toleranceForCode('ERR_TLS_CERT_ALTNAME_INVALID')).toBe('all');
    });

    // It used to fall through to 'all', which is what produced the advice to
    // tick "Accept all certificate errors" for a non-certificate failure.
    it('offers no checkbox for a failure that is not about a certificate', () => {
        expect(toleranceForCode('TLS_HANDSHAKE_FAILED')).toBeNull();
    });
});

describe('describeTlsFailure', () => {
    /** Exactly what the Cloudflare Worker proxy sends for TLS on port 23. */
    const workerHandshakeFailure = {
        code: 'TLS_HANDSHAKE_FAILED',
        codes: ['TLS_HANDSHAKE_FAILED'],
        message: 'connection closed before any data was received',
        certInspection: false,
    };

    it('does not blame a certificate when no certificate was involved', () => {
        const { summary, remedy, certificateFault } = describeTlsFailure(workerHandshakeFailure);

        expect(certificateFault).toBe(false);
        expect(summary).not.toMatch(/certificate was refused/);
        expect(summary).toContain('secure handshake');
        // Mudlet shows the socket error text verbatim; so do we.
        expect(summary).toContain('connection closed before any data was received');
        expect(remedy).not.toBeNull();
    });

    it('offers the two remedies that exist: turn TLS off, or use the TLS port', () => {
        const { remedy } = describeTlsFailure(workerHandshakeFailure);

        expect(remedy).toContain('Secure connection (TLS)');
        expect(remedy).toContain('TLS port');
        // The checkbox this used to advertise is not rendered on this proxy.
        expect(remedy).not.toContain('Accept all certificate errors');
    });

    it('still explains a real certificate fault, and names the setting that clears it', () => {
        const { summary, remedy, certificateFault } = describeTlsFailure({
            code: 'CERT_HAS_EXPIRED',
            codes: ['CERT_HAS_EXPIRED'],
            message: 'certificate expired on Jan 1 2021',
            certInspection: true,
        });

        expect(certificateFault).toBe(true);
        expect(summary).toBe("The game's certificate was refused because the certificate has expired.");
        expect(remedy).toBe('You can allow it with “Accept expired certificates” in Settings → Network.');
    });

    it('names the narrowest set of settings covering every reported fault', () => {
        const { remedy } = describeTlsFailure({
            code: 'CERT_HAS_EXPIRED',
            codes: ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT'],
            certInspection: true,
        });

        expect(remedy).toBe(
            'You can allow it with “Accept expired certificates” and “Accept self-signed certificates” '
            + 'in Settings → Network.',
        );
    });

    // A certificate fault from a proxy that cannot override one — the Settings
    // panel renders "Certificate options unavailable" and no checkboxes there,
    // so pointing at one would be pointing at nothing.
    it('never advertises a checkbox a proxy without certificate inspection cannot render', () => {
        const { remedy } = describeTlsFailure({
            code: 'CERT_HAS_EXPIRED',
            codes: ['CERT_HAS_EXPIRED'],
            certInspection: false,
        });

        expect(remedy).not.toMatch(/Accept expired certificates/);
        expect(remedy).toContain('Cloudflare Workers');
        expect(remedy).toContain('Node proxy');
    });

    it('falls back to the single code when the proxy sends no list', () => {
        expect(describeTlsFailure({ code: 'TLS_HANDSHAKE_FAILED' }).certificateFault).toBe(false);
        expect(describeTlsFailure({ code: 'CERT_HAS_EXPIRED' }).certificateFault).toBe(true);
    });
});
