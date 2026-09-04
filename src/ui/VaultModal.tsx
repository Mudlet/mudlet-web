import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button, Input, useConfirm } from './components';
import { useModalFocus } from './components/useModalFocus';
import { getBrand } from '../branding';
import { getVault, type VaultUIProps } from '../vault/vaultAccess';
import { useVault } from '../vault/useVault';
import { VaultError } from '../vault/CredentialVault';
import { passkeysAvailable } from '../vault/passkeyPrf';
import { describeThrown } from '../utils/describeThrown';

/**
 * The credential vault's whole UI: set it up, unlock it, manage it.
 *
 * Reached only through the stock app: `main.tsx` installs it as the vault UI,
 * and nothing else imports it — see `vault/vaultAccess` for why a branded build
 * must not carry any of this.
 *
 * Two details here are load-bearing rather than decorative:
 *
 * - The passphrase fields are a real `<form>` with `autocomplete` set and a
 *   read-only username field, because the browser's password manager *should*
 *   save this one. That is the whole trade the vault makes: one unambiguous
 *   entry for the app instead of one entry per game in a dropdown that cannot
 *   tell them apart.
 * - Every authenticator call hangs off a click. WebAuthn wants a user gesture,
 *   and a passkey prompt that appears on its own reads as a phishing attempt
 *   even when it isn't.
 */

/** Long enough to be worth the 600k PBKDF2 rounds; short enough that people
 *  actually let their manager save it rather than picking something memorable. */
const MIN_PASSPHRASE = 8;

export function VaultModal({ mode, reason, seed, connectionNames, onDone }: VaultUIProps) {
    const snapshot = useVault();
    const vault = getVault();
    const [view, setView] = useState<VaultUIProps['mode']>(mode);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [passphrase, setPassphrase] = useState('');
    const [confirm, setConfirm] = useState('');
    const passphraseRef = useRef<HTMLInputElement>(null);
    // Named apart from the setup form's confirm-passphrase field.
    const askConfirm = useConfirm();
    const close = () => onDone('closed');
    // Setting up or unlocking from inside the manage view is a step within it,
    // not the end of the errand — report the result to the caller only when the
    // modal was opened *for* that step, and otherwise fall back to the list.
    const settle = (result: 'created' | 'unlocked') => {
        if (mode === 'manage') { setView('manage'); setError(null); }
        else onDone(result);
    };
    const modalRef = useModalFocus<HTMLDivElement>(close, { autoFocus: false, closeOnEscape: true });

    // Passkeys are offered when the browser has WebAuthn at all; whether the
    // authenticator can actually do PRF is only knowable after registering, so
    // that failure is reported rather than predicted.
    const canOfferPasskey = passkeysAvailable();
    const hasPasskey = snapshot.unlockers.some(u => u.kind === 'passkey');
    const hasPassphrase = snapshot.unlockers.some(u => u.kind === 'passphrase');
    const seedCount = seed ? Object.keys(seed).length : 0;

    useEffect(() => {
        // Focus the passphrase field when it is the only way in; when a passkey
        // is available the primary action is a button, and stealing focus into a
        // text field buries it.
        if (view === 'unlock' && !hasPasskey) passphraseRef.current?.focus();
    }, [view, hasPasskey]);

    const run = async (fn: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await fn();
        } catch (e) {
            // A cancelled passkey prompt is a NotAllowedError, indistinguishable
            // from a timeout — neither is worth an alarming message.
            const name = (e as { name?: string } | null)?.name;
            if (name === 'NotAllowedError' || name === 'AbortError') setError('Cancelled.');
            else if (e instanceof VaultError) setError(e.message);
            else setError(describeThrown(e));
        } finally {
            setBusy(false);
        }
    };

    // ── actions ──────────────────────────────────────────────────────────

    const createWithPasskey = () => run(async () => {
        if (!vault) return;
        await vault.createWithPasskey(getBrand().appName, `${getBrand().appName} vault`, seed);
        settle('created');
    });

    const createWithPassphrase = (e: FormEvent) => {
        e.preventDefault();
        if (passphrase.length < MIN_PASSPHRASE) {
            setError(`Use at least ${MIN_PASSPHRASE} characters.`);
            return;
        }
        if (passphrase !== confirm) {
            setError('The two passphrases do not match.');
            return;
        }
        void run(async () => {
            if (!vault) return;
            await vault.createWithPassphrase(passphrase, seed);
            setPassphrase('');
            setConfirm('');
            settle('created');
        });
    };

    const unlockWithPasskey = () => run(async () => {
        if (!vault) return;
        if (await vault.unlockWithPasskey()) settle('unlocked');
        else setError('That passkey could not unlock the vault.');
    });

    const unlockWithPassphrase = (e: FormEvent) => {
        e.preventDefault();
        void run(async () => {
            if (!vault) return;
            if (await vault.unlockWithPassphrase(passphrase)) {
                setPassphrase('');
                settle('unlocked');
            } else {
                setError('Wrong passphrase.');
                passphraseRef.current?.select();
            }
        });
    };

    /**
     * The only exit from a vault nobody can open.
     *
     * There is no reset, because a reset would mean the passwords were
     * recoverable without the key — which is the property the vault exists to
     * have. So the honest offer is to throw the vault away and start again, and
     * the confirm dialog says exactly that rather than implying recovery.
     *
     * `afterwards` differs by where this was reached from: the unlock prompt has
     * a caller waiting on an answer, the manage view just re-renders empty.
     */
    const discardVault = async (afterwards: 'close' | 'stay') => {
        const ok = await askConfirm({
            title: 'Delete saved logins',
            message: snapshot.entryIds.length === 1
                ? 'The one password in here cannot be recovered without a way to unlock it — deleting is the only way forward. You can set up saved logins again straight away.'
                : `The ${snapshot.entryIds.length} passwords in here cannot be recovered without a way to unlock it — deleting is the only way forward. You can set up saved logins again straight away.`,
            tone: 'danger',
            buttons: [
                { label: 'Cancel', value: false, variant: 'ghost' },
                { label: 'Delete saved logins', value: true, variant: 'danger' },
            ],
            dismissValue: false,
        });
        if (!ok) return;
        vault?.deleteVault();
        setError(null);
        setPassphrase('');
        if (afterwards === 'close') onDone('closed');
        else setView('manage');
    };

    // ── shared bits ──────────────────────────────────────────────────────

    /* The field the password manager is meant to key on. Visually hidden rather
       than `display:none`, which managers skip. */
    const usernameField = (
        <input
            className="vault-username"
            type="text"
            name="username"
            autoComplete="username"
            readOnly
            tabIndex={-1}
            aria-label="Vault"
            value={`${getBrand().appName} vault`}
        />
    );

    const errorBox = error && <div className="char-login-error" role="alert">{error}</div>;

    const body = () => {
        if (!vault) {
            return <p className="vault-hint">Saved logins are not available in this build.</p>;
        }
        if (!vault.available) {
            return (
                <p className="vault-hint">
                    Saved logins need a secure page (https, or localhost). This one is served over
                    plain http, so the browser withholds the crypto the vault is built on.
                </p>
            );
        }
        if (view === 'setup') return setupView();
        if (view === 'unlock') return unlockView();
        return manageView();
    };

    // ── setup ────────────────────────────────────────────────────────────

    const setupView = () => (
        <div className="vault-body">
            <p className="vault-hint">
                Passwords are encrypted on this device and unlocked once per visit. Your browser's
                password manager only ever sees the one way in below — not a separate login for
                every game, which is what makes its list impossible to tell apart.
            </p>
            {seedCount > 0 && (
                <p className="vault-hint vault-hint--note">
                    {seedCount === 1 ? 'One password' : `${seedCount} passwords`} currently saved in
                    the clear will move into the vault, and the plaintext copy will be deleted.
                </p>
            )}
            {errorBox}
            {canOfferPasskey && (
                <>
                    <div className="vault-option">
                        <Button variant="primary" onClick={createWithPasskey} disabled={busy}>
                            Use a passkey
                        </Button>
                        <span className="vault-option-hint">
                            Touch ID, Windows Hello, your phone or a security key. Nothing to
                            remember, and nothing for the password manager to confuse.
                        </span>
                    </div>
                    <div className="vault-or"><span>or</span></div>
                </>
            )}
            <form className="vault-form" onSubmit={createWithPassphrase}>
                {usernameField}
                <label className="char-login-field">
                    <span>Passphrase</span>
                    <Input
                        ref={passphraseRef}
                        name="new-password"
                        type="password"
                        autoComplete="new-password"
                        value={passphrase}
                        onChange={e => setPassphrase(e.target.value)}
                        placeholder={`at least ${MIN_PASSPHRASE} characters`}
                    />
                </label>
                <label className="char-login-field">
                    <span>Confirm</span>
                    <Input
                        name="confirm-password"
                        type="password"
                        autoComplete="new-password"
                        value={confirm}
                        onChange={e => setConfirm(e.target.value)}
                    />
                </label>
                <p className="vault-hint vault-hint--small">
                    There is no reset. If a passphrase is the only way in and you forget it, the
                    saved passwords are gone — add a passkey later for a second way in.
                </p>
                <div className="char-login-actions">
                    <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
                    <Button type="submit" variant={canOfferPasskey ? 'secondary' : 'primary'} disabled={busy}>
                        Use a passphrase
                    </Button>
                </div>
            </form>
        </div>
    );

    // ── unlock ───────────────────────────────────────────────────────────

    const unlockView = () => (
        <div className="vault-body">
            <p className="vault-hint">
                {reason ?? 'Unlock your saved logins for this visit.'}
            </p>
            {errorBox}
            {hasPasskey && (
                <div className="vault-option">
                    <Button variant="primary" onClick={unlockWithPasskey} disabled={busy}>
                        Unlock with a passkey
                    </Button>
                </div>
            )}
            {hasPasskey && hasPassphrase && <div className="vault-or"><span>or</span></div>}
            {hasPassphrase && (
                <form className="vault-form" onSubmit={unlockWithPassphrase}>
                    {usernameField}
                    <label className="char-login-field">
                        <span>Passphrase</span>
                        <Input
                            ref={passphraseRef}
                            name="password"
                            type="password"
                            autoComplete="current-password"
                            value={passphrase}
                            onChange={e => setPassphrase(e.target.value)}
                        />
                    </label>
                    <div className="char-login-actions">
                        <Button type="button" variant="ghost" onClick={close}>Not now</Button>
                        <Button type="submit" variant={hasPasskey ? 'secondary' : 'primary'} disabled={busy}>
                            Unlock
                        </Button>
                    </div>
                </form>
            )}
            {!hasPassphrase && (
                <div className="char-login-actions">
                    <Button type="button" variant="ghost" onClick={close}>Not now</Button>
                </div>
            )}
            {/* Reachable from inside a session, where the connection screen's
                manage view is not — without it, someone who has forgotten their
                passphrase mid-login has nowhere to go but this same dead form on
                every reconnect. */}
            <button type="button" className="vault-forgot" onClick={() => void discardVault('close')}>
                {hasPasskey
                    ? "Can't get in? Delete these saved logins and start over"
                    : 'Forgotten your passphrase?'}
            </button>
        </div>
    );

    // ── manage ───────────────────────────────────────────────────────────

    const entries = useMemo(
        () => snapshot.entryIds.map(id => ({ id, name: connectionNames?.[id] })),
        [snapshot.entryIds, connectionNames],
    );

    const manageView = () => (
        <div className="vault-body">
            {!snapshot.exists && (
                <>
                    <p className="vault-hint">No saved logins yet.</p>
                    <div className="char-login-actions">
                        <Button variant="primary" onClick={() => { setError(null); setView('setup'); }}>
                            Set up saved logins
                        </Button>
                    </div>
                </>
            )}
            {snapshot.exists && (
                <>
                    {errorBox}
                    <div className="vault-status">
                        <span className={`vault-badge${snapshot.locked ? ' vault-badge--locked' : ''}`}>
                            {snapshot.locked ? 'Locked' : 'Unlocked'}
                        </span>
                        {snapshot.locked
                            ? (
                                <Button size="sm" onClick={() => { setError(null); setView('unlock'); }}>
                                    Unlock
                                </Button>
                            )
                            : <Button size="sm" onClick={() => vault?.lock()}>Lock now</Button>}
                    </div>

                    <div className="vault-section">
                        <div className="form-section-title form-section-title--sub">Ways in</div>
                        <ul className="vault-list">
                            {snapshot.unlockers.map(u => (
                                <li key={u.id}>
                                    <span className="vault-list-name">{u.label}</span>
                                    <span className="vault-list-kind">
                                        {u.kind === 'passkey' ? 'passkey' : 'passphrase'}
                                    </span>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled={busy || snapshot.unlockers.length <= 1}
                                        title={snapshot.unlockers.length <= 1
                                            ? 'The only way in — delete the vault instead.'
                                            : undefined}
                                        onClick={() => { try { vault?.removeUnlocker(u.id); } catch (e) { setError(describeThrown(e)); } }}
                                    >
                                        Remove
                                    </Button>
                                </li>
                            ))}
                        </ul>
                        {!snapshot.locked && canOfferPasskey && (
                            <Button
                                size="sm"
                                disabled={busy}
                                onClick={() => run(async () => {
                                    await vault?.addPasskey(getBrand().appName, `${getBrand().appName} vault`);
                                })}
                            >
                                Add a passkey
                            </Button>
                        )}
                        {!snapshot.locked && (
                            <form
                                className="vault-inline-form"
                                onSubmit={e => {
                                    e.preventDefault();
                                    if (passphrase.length < MIN_PASSPHRASE) {
                                        setError(`Use at least ${MIN_PASSPHRASE} characters.`);
                                        return;
                                    }
                                    void run(async () => {
                                        await vault?.changePassphrase(passphrase);
                                        setPassphrase('');
                                    });
                                }}
                            >
                                {usernameField}
                                <Input
                                    name="new-password"
                                    type="password"
                                    autoComplete="new-password"
                                    value={passphrase}
                                    onChange={e => setPassphrase(e.target.value)}
                                    placeholder={hasPassphrase ? 'new passphrase' : 'add a passphrase'}
                                />
                                <Button size="sm" type="submit" disabled={busy || !passphrase}>
                                    {hasPassphrase ? 'Change' : 'Add'}
                                </Button>
                            </form>
                        )}
                    </div>

                    <div className="vault-section">
                        <div className="form-section-title form-section-title--sub">
                            Saved logins ({entries.length})
                        </div>
                        {entries.length === 0
                            ? <p className="vault-hint vault-hint--small">None yet — save one from a game's login prompt.</p>
                            : (
                                <ul className="vault-list">
                                    {entries.map(entry => (
                                        <li key={entry.id}>
                                            <span className="vault-list-name">
                                                {entry.name ?? <em>deleted profile</em>}
                                            </span>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                disabled={busy || snapshot.locked}
                                                title={snapshot.locked ? 'Unlock the vault to change what it holds.' : undefined}
                                                onClick={() => run(async () => { await vault?.setPassword(entry.id, null); })}
                                            >
                                                Remove
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                    </div>

                    <div className="vault-section vault-section--danger">
                        {/* Deliberately NOT disabled while locked: a forgotten
                            passphrase leaves this as the only way out, and the
                            confirm dialog is where the consequence is spelled
                            out. */}
                        <Button
                            size="sm"
                            variant="danger"
                            disabled={busy}
                            onClick={() => void discardVault('stay')}
                        >
                            Delete the vault and every password in it
                        </Button>
                    </div>
                </>
            )}
        </div>
    );

    const title = view === 'setup' ? 'Set up saved logins'
        : view === 'unlock' ? 'Unlock saved logins'
            : 'Saved logins';

    return (
        <>
            <div className="modal-overlay" onClick={close} />
            <div ref={modalRef} className="modal vault-modal" role="dialog" aria-modal="true" aria-label={title}>
                <div className="modal-header">
                    <span className="modal-title">{title}</span>
                    <button className="modal-close" onClick={close} type="button" aria-label="Close">✕</button>
                </div>
                <div className="modal-body">{body()}</div>
            </div>
        </>
    );
}
