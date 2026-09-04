import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from './components/Button';
import { Input } from './components/Input';
import { useModalFocus } from './components/useModalFocus';

interface CharLoginModalProps {
    /** Connection name, shown in the title for context. */
    connectionName?: string;
    /** Error from a previous failed attempt (Char.Login.Result success=false). */
    error?: string;
    /** Account/username to prefill. Not a secret — it lives on the connection
     *  record, and prefilling it is also what lets a password manager pick the
     *  matching password instead of listing every profile's. */
    initialAccount?: string;
    /** Password to prefill, from the unlocked vault. */
    initialPassword?: string;
    /** Initial state of the "save this password" checkbox. */
    initialSave?: boolean;
    /** Offer to save the password (default true). False where there is nothing
     *  to save it into: branded builds, which never persist credentials, and
     *  pages served without a secure context. */
    allowSave?: boolean;
    /** Wording under the checkbox — the caller knows whether ticking it will
     *  store into an existing vault or set one up first. */
    saveNote?: string;
    /** Send `account` + `password` to the server (Char.Login.Credentials).
     *  `save` asks the caller to put the password in the credential vault. */
    onSubmit: (account: string, password: string, save: boolean) => void;
    /** Decline GMCP login — sends the empty reply so the server falls back to
     *  its text login prompt. */
    onCancel: () => void;
    /** Where focus goes once the popup closes. The server raised this dialog,
     *  not a click, so there is no meaningful opener to return to — the caller
     *  points this at the command line so the player can type straight away. */
    restoreFocusTo?: () => HTMLElement | null | undefined;
}

/**
 * Credentials popup for GMCP `Char.Login` authentication. Rendered as a real
 * `<form>` with `autocomplete="username"` / `autocomplete="current-password"`
 * inputs so browser password managers can still fill and save for anyone who
 * prefers them.
 *
 * Saving is the credential vault's job (`vault/CredentialVault`): ticking the
 * box hands the password to the caller, which encrypts it under a key derived
 * from a passkey or a passphrase. That replaced an older checkbox that wrote
 * the password to localStorage in the clear and had to apologise for it in a
 * red warning right underneath — see issue #25.
 */
export function CharLoginModal({
    connectionName,
    error,
    initialAccount,
    initialPassword,
    initialSave,
    allowSave = true,
    saveNote,
    onSubmit,
    onCancel,
    restoreFocusTo,
}: CharLoginModalProps) {
    const [account, setAccount] = useState(initialAccount ?? '');
    const [password, setPassword] = useState(initialPassword ?? '');
    const [save, setSave] = useState(allowSave && (initialSave ?? !!initialPassword));
    const accountRef = useRef<HTMLInputElement>(null);
    const passwordRef = useRef<HTMLInputElement>(null);
    // Trap + restore only; this modal keeps its own Escape (window) and its own
    // initial focus (first empty field, for the password-manager flow).
    const modalRef = useModalFocus<HTMLDivElement>(undefined, {
        autoFocus: false, closeOnEscape: false, restoreFocusTo,
    });

    useEffect(() => {
        // Focus the first empty field so a fully-prefilled form is one Enter away.
        (account ? passwordRef : accountRef).current?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCancel();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onCancel]);

    const handleSubmit = (e: FormEvent) => {
        e.preventDefault();
        const trimmed = account.trim();
        if (!trimmed) {
            accountRef.current?.focus();
            return;
        }
        onSubmit(trimmed, password, save);
    };

    return (
        <>
            {/* No overlay-click dismissal: a login decision should be explicit
                (Cancel falls back to text login). Escape still cancels. */}
            <div className="modal-overlay" />
            <div ref={modalRef} className="modal char-login-modal" role="dialog" aria-modal="true" aria-label="Log in">
                <div className="modal-header">
                    <span className="modal-title">
                        Log in{connectionName ? ` — ${connectionName}` : ''}
                    </span>
                    <button className="modal-close" onClick={onCancel} type="button" aria-label="Cancel">
                        ✕
                    </button>
                </div>
                <div className="modal-body">
                    <form className="char-login-form" onSubmit={handleSubmit}>
                        <p className="char-login-hint">
                            This game supports secure login. Enter your credentials — your password
                            manager can fill them in.
                        </p>
                        {error && (
                            <div className="char-login-error" role="alert">
                                {error}
                            </div>
                        )}
                        <label className="char-login-field">
                            <span>Account</span>
                            <Input
                                ref={accountRef}
                                name="username"
                                type="text"
                                autoComplete="username"
                                spellCheck={false}
                                value={account}
                                onChange={e => setAccount(e.target.value)}
                                placeholder="account name"
                            />
                        </label>
                        <label className="char-login-field">
                            <span>Password</span>
                            <Input
                                ref={passwordRef}
                                name="password"
                                type="password"
                                autoComplete="current-password"
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                placeholder="password"
                            />
                        </label>
                        {allowSave && (
                            <label className="vault-save-row">
                                <input
                                    type="checkbox"
                                    checked={save}
                                    onChange={e => setSave(e.target.checked)}
                                />
                                <span>Save this password</span>
                            </label>
                        )}
                        {allowSave && save && saveNote && (
                            <p className="vault-save-note" role="note">{saveNote}</p>
                        )}
                        <div className="char-login-actions">
                            <Button type="button" variant="ghost" onClick={onCancel}>
                                Use text login
                            </Button>
                            <Button type="submit" variant="primary">
                                Log in
                            </Button>
                        </div>
                    </form>
                </div>
            </div>
        </>
    );
}
