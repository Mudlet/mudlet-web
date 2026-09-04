import { Button } from './components/Button';
import type { TlsStatus } from '../mud/events';
import { describeTlsFailure } from '../mud/protocol/tlsCodes';

interface Props {
    status: TlsStatus;
    /** The plaintext port to fall back to, when one was remembered. */
    revertPort?: number;
    onRevert: () => void;
    onDismiss: () => void;
}

/**
 * Explains a TLS connection that didn't work, and offers the way back.
 *
 * Mudlet reacts to a certificate failure by opening Preferences on the
 * connection tab with the offending checkbox highlighted; the browser
 * equivalent is to say which setting would allow it and let the user undo the
 * port change in one click. What it must not do — and used to — is describe
 * every failure as a certificate refusal and then advise a checkbox this proxy
 * never renders; see `describeTlsFailure`.
 */
export function TlsAlertBanner({ status, revertPort, onRevert, onDismiss }: Props) {
    if (status.kind === 'established') return null;

    const explanation = status.kind === 'error' ? describeTlsFailure(status.info) : null;

    return (
        <div className="tls-alert-banner" role="alert">
            <div className="tls-alert-body">
                <strong className="tls-alert-title">Secure connection failed</strong>
                {status.kind === 'timeout' ? (
                    <span>
                        Nothing answered on the secure port {status.port}. Your proxy may be too old to
                        support TLS, or the game refused the connection.
                    </span>
                ) : (
                    <span>
                        {explanation?.summary}
                        {explanation?.remedy && <> {explanation.remedy}</>}
                    </span>
                )}
            </div>
            <div className="tls-alert-actions">
                {revertPort !== undefined && (
                    <Button type="button" variant="primary" onClick={onRevert}>
                        Revert to port {revertPort}
                    </Button>
                )}
                <Button type="button" variant="ghost" onClick={onDismiss} aria-label="Dismiss">
                    Dismiss
                </Button>
            </div>
        </div>
    );
}
