import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TlsAlertBanner } from '../../src/ui/TlsAlertBanner';
import type { TlsStatus } from '../../src/mud/events';

/**
 * The banner the user actually sees after a failed secure connect. It used to
 * read "The game's certificate was refused because the secure handshake
 * failed. You can allow it with “Accept all certificate errors” in
 * Settings → Network." for a TLS connect to a plaintext port — a certificate
 * diagnosis with no certificate in it, pointing at a checkbox that panel does
 * not render on the default Cloudflare-Worker proxy. See issue #52.
 *
 * (JSX is avoided so the file stays a plain .test.ts, matching the include glob.)
 */
describe('TlsAlertBanner', () => {
    let host: HTMLDivElement;
    let root: Root;

    const show = (status: TlsStatus) => act(() => {
        root.render(createElement(TlsAlertBanner, {
            status, onRevert: () => {}, onDismiss: () => {},
        }));
    });

    const text = () => host.querySelector('.tls-alert-body')?.textContent ?? '';

    beforeEach(() => {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(() => {
        act(() => root.unmount());
        host.remove();
    });

    it('does not call a failed handshake a certificate problem', () => {
        show({
            kind: 'error',
            info: {
                code: 'TLS_HANDSHAKE_FAILED',
                codes: ['TLS_HANDSHAKE_FAILED'],
                message: 'connection closed before any data was received',
                cert: null,
                certInspection: false,
            },
        });

        expect(text()).not.toContain("certificate was refused");
        expect(text()).not.toContain('Accept all certificate errors');
        expect(text()).toContain('Secure connection (TLS)');
        expect(text()).toContain('TLS port');
    });

    it('still names the setting that would clear a real certificate fault', () => {
        show({
            kind: 'error',
            info: {
                code: 'CERT_HAS_EXPIRED',
                codes: ['CERT_HAS_EXPIRED'],
                message: 'expired',
                cert: null,
                certInspection: true,
            },
        });

        expect(text()).toContain('the certificate has expired');
        expect(text()).toContain('Accept expired certificates');
    });

    it('leaves the timeout wording alone', () => {
        show({ kind: 'timeout', host: 'achaea.com', port: 443 });
        expect(text()).toContain('Nothing answered on the secure port 443');
    });
});
