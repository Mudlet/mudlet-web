import type { FormEvent } from 'react';
import { useBrandLogin } from './useBrandLogin';
import type { LandingProps } from '../branding';

export interface BrandLoginFieldsProps extends Pick<LandingProps, 'openProfile' | 'ensureBrandProfile'> {
    /** Show the password field (default true). Set false for brands that only
     *  need a character/profile name — e.g. an offline-only demo. */
    showPassword?: boolean;
    /** Show the "open offline" button (default true). */
    showOffline?: boolean;
    accountLabel?: string;
    passwordLabel?: string;
    connectLabel?: string;
    offlineLabel?: string;
    accountPlaceholder?: string;
    passwordPlaceholder?: string;
    /** Extra class appended to the root `<form>`. */
    className?: string;
    autoFocus?: boolean;
}

/**
 * Unstyled login form for custom branded landings: account (+ optional
 * password) input, Connect submit, optional Open-offline button. No CSS is
 * applied — every element carries a stable `mudlet-login-*` class for the
 * brand's own stylesheet to target. Wraps `useBrandLogin`; for full control
 * over markup, call that hook directly instead of using this component.
 */
export function BrandLoginFields({
    openProfile,
    ensureBrandProfile,
    showPassword = true,
    showOffline = true,
    accountLabel = 'Account',
    passwordLabel = 'Password',
    connectLabel = 'Connect',
    offlineLabel = 'Open offline',
    accountPlaceholder,
    passwordPlaceholder,
    className,
    autoFocus = true,
}: BrandLoginFieldsProps) {
    const { account, setAccount, password, setPassword, enter } = useBrandLogin({ openProfile, ensureBrandProfile });

    const handleSubmit = (e: FormEvent) => {
        e.preventDefault();
        enter(true);
    };

    return (
        <form
            className={['mudlet-login-fields', className].filter(Boolean).join(' ')}
            onSubmit={handleSubmit}
        >
            <label className="mudlet-login-field mudlet-login-account">
                <span>{accountLabel}</span>
                <input
                    name="username"
                    autoComplete="username"
                    spellCheck={false}
                    value={account}
                    onChange={e => setAccount(e.target.value)}
                    placeholder={accountPlaceholder}
                    autoFocus={autoFocus}
                />
            </label>
            {showPassword && (
                <label className="mudlet-login-field mudlet-login-password">
                    <span>{passwordLabel}</span>
                    <input
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder={passwordPlaceholder}
                    />
                </label>
            )}
            <button type="submit" className="mudlet-login-submit">{connectLabel}</button>
            {showOffline && (
                <button
                    type="button"
                    className="mudlet-login-offline"
                    onClick={() => enter(false)}
                    title="Open the profile without connecting — scripts and settings stay available"
                >
                    {offlineLabel}
                </button>
            )}
        </form>
    );
}
