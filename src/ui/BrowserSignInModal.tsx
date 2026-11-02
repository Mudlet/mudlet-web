import { useEffect, useRef, useState } from 'react';
import { Button } from './components/Button';
import { useModalFocus } from './components/useModalFocus';
import { charLoginProviderName } from '../mud/protocol/charLoginFlow';
import type { SignInOffer } from '../mud/CharLoginController';

interface Props {
    connectionName: string;
    offer: SignInOffer;
    /** Close the dialog. For a server-driven offer the console link stays; for
     *  our own flow the sign-in keeps waiting until it completes or times out. */
    onClose: () => void;
    /** Client-driven flow only: drop it and let the game run its own sign-in. */
    onUseGameSignIn?: () => void;
}

/**
 * A GMCP `Char.Login` browser sign-in waiting for the player to open it.
 *
 * Mudlet launches the system browser itself. A web page may only open a tab
 * from a user gesture, so the address becomes this button — a plain link with
 * `noopener`, which no popup blocker stops and which gives the provider's page
 * no handle back on ours. The same link is in the console, for a player who
 * closes this.
 */
export function BrowserSignInModal({ connectionName, offer, onClose, onUseGameSignIn }: Props) {
    const ref = useModalFocus<HTMLDivElement>(onClose);
    const [opened, setOpened] = useState(false);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    // Set by the link's click, not only by a blur: the new tab can take focus
    // before the effect below has subscribed.
    const awayRef = useRef(false);
    // A game-linked page ends in plain text — StickMUD sends no GMCP at all
    // after Char.Login.URL, only "Signed in as …" — so nothing on the wire can
    // close this. The dialog's job is done once the player has opened the page
    // and come back, which is exactly what it asks them to do. Our own OAuth
    // flow keeps it open: that one closes itself when the code is captured.
    useEffect(() => {
        if (!opened || offer.flow !== 'server') return;
        const leave = () => { awayRef.current = true; };
        const back = () => {
            if (!awayRef.current || document.visibilityState !== 'visible' || !document.hasFocus()) return;
            onCloseRef.current();
        };
        window.addEventListener('blur', leave);
        window.addEventListener('focus', back);
        const onVisibility = () => (document.visibilityState === 'hidden' ? leave() : back());
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            window.removeEventListener('blur', leave);
            window.removeEventListener('focus', back);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [opened, offer.flow]);
    const provider = charLoginProviderName(offer.provider);
    const title = provider ? `Sign in with ${provider}` : 'Sign in';
    return (
        <>
            <div className="modal-overlay" onClick={onClose} />
            <div
                ref={ref}
                className="modal browser-signin-modal"
                role="dialog"
                aria-modal="true"
                aria-label={title}
            >
                <div className="modal-header">
                    <span className="modal-title">{title}</span>
                    <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
                </div>
                <div className="modal-body">
                    <p className="browser-signin-lead">
                        {connectionName} signs you in on a web page.
                        {' '}Continue in a new tab, then come back here.
                    </p>
                    {opened && (
                        <p className="browser-signin-note" role="status">
                            {offer.flow === 'client'
                                ? 'Waiting for you to finish signing in…'
                                : 'Finish signing in on that page; the game will continue here.'}
                        </p>
                    )}
                    <div className="browser-signin-actions">
                        {offer.flow === 'client' && onUseGameSignIn
                            ? (
                                <Button type="button" variant="ghost" onClick={onUseGameSignIn}>
                                    Use the game's sign-in instead
                                </Button>
                            )
                            : (
                                <Button type="button" variant="ghost" onClick={onClose}>
                                    Close
                                </Button>
                            )}
                        <a
                            className="btn btn--primary btn--md"
                            href={offer.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => { awayRef.current = true; setOpened(true); }}
                            autoFocus
                        >
                            {opened ? 'Open the sign-in page again' : 'Open the sign-in page'}
                        </a>
                    </div>
                </div>
            </div>
        </>
    );
}
