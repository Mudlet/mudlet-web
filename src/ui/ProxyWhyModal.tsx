import { useModalFocus } from './components/useModalFocus';
import { getBrand } from '../branding';

interface Props {
    onClose: () => void;
    onHostYourOwn: () => void;
}

export function ProxyWhyModal({ onClose, onHostYourOwn }: Props) {
    const ref = useModalFocus<HTMLDivElement>(onClose);
    return (
        <>
            <div className="modal-overlay" onClick={onClose} />
            <div ref={ref} className="modal proxy-why-modal" role="dialog" aria-modal="true" aria-label="Why a proxy is needed">
                <div className="modal-header">
                    <span className="modal-title">Why do I need a proxy?</span>
                    <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
                </div>
                <div className="modal-body proxy-info-body">
                    <p className="proxy-info-intro">
                        MUD servers speak <strong>telnet over raw TCP</strong>. Browsers — for security reasons —
                        only allow <strong>WebSocket</strong> and HTTP, not raw TCP sockets. There's no way for a
                        web app to talk to a telnet MUD directly.
                    </p>
                    <p className="proxy-info-intro">
                        A proxy bridges the gap: your browser opens a WebSocket to the proxy, and the proxy opens a
                        TCP connection to the MUD server, forwarding bytes in both directions.
                    </p>
                    <div className="proxy-why-diagram">
                        <span className="proxy-why-node">Browser</span>
                        <span className="proxy-why-arrow">⇄ WebSocket ⇄</span>
                        <span className="proxy-why-node">Proxy</span>
                        <span className="proxy-why-arrow">⇄ TCP / telnet ⇄</span>
                        <span className="proxy-why-node">MUD</span>
                    </div>
                    <p className="proxy-info-intro">
                        {getBrand().appName} ships with a default proxy so things just work. If you'd rather not route traffic
                        through someone else's server, you can{' '}
                        <button type="button" className="proxy-info-link proxy-why-inline-btn" onClick={onHostYourOwn}>
                            host your own
                        </button>{' '}
                        — it's a single Cloudflare Worker and takes about a minute.
                    </p>
                    <p className="proxy-info-intro proxy-why-note">
                        If your MUD natively offers a WebSocket endpoint (e.g. <code>wss://…</code>), switch to{' '}
                        <strong>WebSocket</strong> mode at the top of the form and skip the proxy entirely.
                    </p>
                </div>
            </div>
        </>
    );
}
