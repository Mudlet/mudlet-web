import { useState } from 'react';
import { Button, Input, FormField, Toggle } from './components';
import { useModalFocus } from './components/useModalFocus';
import { ProxyInfoModal } from './ProxyInfoModal';
import { ProxyWhyModal } from './ProxyWhyModal';
import { DEFAULT_PROXY_URL, proxyCanInspectCertificates, useAppStore, type ConnectionMode, type MudConnection } from '../storage';
import { BUNDLED_GAMES, findBundledGame } from '../mud/games/bundledGames';

/** The bundled games worth offering: one with no port is not something this
 *  form could dial (Mudlet's tutorial runs against a local stub). Sorted by
 *  name so the list reads as a directory rather than as upstream's file order. */
const OFFERED_GAMES = BUNDLED_GAMES.filter(g => g.port > 0 && g.hostUrl)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

/** Preview of the proxy URL the profile will dial. Mirrors `connectionUrl()` in
 *  storage/schema.ts — keep the two in step. */
function buildPreviewUrl(
    host: string, port: string, proxyUrl: string, fallback: string,
    tls: { on: boolean; expired: boolean; selfSigned: boolean; all: boolean },
): string {
    const base = (proxyUrl.trim() || fallback).replace(/\/$/, '');
    const p = parseInt(port, 10);
    let url = `${base}?host=${encodeURIComponent(host.trim())}&port=${isNaN(p) ? 23 : p}`;
    if (tls.on) {
        url += '&tls=1';
        if (tls.expired) url += '&tlsIgnoreExpired=1';
        if (tls.selfSigned) url += '&tlsIgnoreSelfSigned=1';
        if (tls.all) url += '&tlsIgnoreAll=1';
    }
    return url;
}

function modeOf(c: MudConnection): ConnectionMode {
    return c.mode ?? 'websocket';
}

/** Split a host string that may carry a trailing port (`host:port` or
 *  `host port`) into its parts, so pasting a full address moves the port into
 *  the Port field. Returns `port: undefined` when no trailing numeric port is
 *  present, leaving the Port field untouched. */
function splitHostPort(value: string): { host: string; port?: string } {
    const match = value.trim().match(/^(.*?)[\s:]+(\d+)$/);
    if (match && match[1].trim() !== '') {
        return { host: match[1].trim(), port: match[2] };
    }
    return { host: value };
}

interface Props {
    /** The connection to edit, or null to add a new one. */
    connection: MudConnection | null;
    /** Whether this is the very first connection (drives the title copy). */
    firstConnection: boolean;
    busy: boolean;
    onAdd: (data: Omit<MudConnection, 'id'>) => string;
    onUpdate: (id: string, data: Omit<MudConnection, 'id'>) => void;
    onClose: () => void;
}

export function ConnectionFormModal({ connection, firstConnection, busy, onAdd, onUpdate, onClose }: Props) {
    const userProxyUrl = useAppStore(s => s.client.userProxyUrl);
    const effectiveDefaultProxy = userProxyUrl || DEFAULT_PROXY_URL;

    const isEditing = connection !== null;

    const [mode, setMode] = useState<ConnectionMode>(connection ? modeOf(connection) : 'mud');
    const [name, setName] = useState(connection?.name ?? '');
    const [host, setHost] = useState(connection?.host ?? '');
    const [port, setPort] = useState(String(connection?.port ?? 23));
    const [proxyUrl, setProxyUrl] = useState(connection?.proxyUrl ?? '');
    const [url, setUrl] = useState(connection?.url ?? '');
    const [autoReconnect, setAutoReconnect] = useState(connection?.autoReconnect ?? false);
    const [tls, setTls] = useState(connection?.tls ?? false);
    const [sslIgnoreExpired, setSslIgnoreExpired] = useState(connection?.sslIgnoreExpired ?? false);
    const [sslIgnoreSelfSigned, setSslIgnoreSelfSigned] = useState(connection?.sslIgnoreSelfSigned ?? false);
    const [sslIgnoreAll, setSslIgnoreAll] = useState(connection?.sslIgnoreAll ?? false);
    // A Cloudflare-Worker proxy cannot inspect certificates, so the tolerance
    // options below would be silently ignored. Derived from the live field so
    // editing the proxy URL updates the form without a save/reopen.
    const certOptionsSupported = proxyCanInspectCertificates(proxyUrl.trim() || effectiveDefaultProxy);
    const [account, setAccount] = useState(connection?.charLoginAccount ?? '');
    const [password, setPassword] = useState(connection?.charLoginPassword ?? '');
    const [description, setDescription] = useState(connection?.description ?? '');

    const [proxyModalOpen, setProxyModalOpen] = useState(false);
    const [proxyWhyOpen, setProxyWhyOpen] = useState(false);
    // Which bundled game the fields were last filled from; '' means the user is
    // typing their own. Only tracked so the picker shows what was chosen — the
    // fields stay editable afterwards, and nothing re-reads the catalogue.
    const [game, setGame] = useState('');

    /** Fill the form from Mudlet's bundled catalogue. Everything the entry knows
     *  is copied in, description included, so the profile starts out looking the
     *  way it would in Mudlet — and the user can still edit any of it. */
    const pickGame = (gameName: string) => {
        setGame(gameName);
        const picked = findBundledGame(gameName);
        if (!picked) return;
        setMode('mud');
        setName(picked.name);
        setHost(picked.hostUrl);
        setPort(String(picked.port));
        setTls(picked.tlsEnabled);
        setDescription(picked.description);
    };

    const ref = useModalFocus<HTMLDivElement>(onClose, { autoFocus: true, closeOnEscape: true });

    const canSubmit = mode === 'mud'
        ? name.trim() !== '' && host.trim() !== ''
        : name.trim() !== '' && url.trim() !== '';

    const buildData = (): Omit<MudConnection, 'id'> => {
        const acct = account.trim();
        // Common fields carried on every connection, incl. the optional login
        // creds (cleared when the fields are emptied; password in plaintext) and
        // the icon, which the form doesn't edit but must preserve on update.
        const common = {
            proxyUrl: proxyUrl.trim() || undefined,
            autoReconnect: autoReconnect || undefined,
            icon: connection?.icon,
            charLoginAccount: acct || undefined,
            charLoginPassword: acct && password ? password : undefined,
            description: description.trim() || undefined,
        };
        if (mode === 'mud') {
            const parsedPort = parseInt(port, 10);
            return {
                name: name.trim(),
                mode: 'mud',
                host: host.trim(),
                port: isNaN(parsedPort) ? 23 : parsedPort,
                // TLS is a proxy-mode concept only — in websocket mode the URL
                // scheme decides it, so these are deliberately not carried over.
                tls: tls || undefined,
                sslIgnoreExpired: tls && sslIgnoreExpired ? true : undefined,
                sslIgnoreSelfSigned: tls && sslIgnoreSelfSigned ? true : undefined,
                sslIgnoreAll: tls && sslIgnoreAll ? true : undefined,
                preTlsPort: connection?.preTlsPort,
                ...common,
            };
        }
        return {
            name: name.trim(),
            mode: 'websocket',
            url: url.trim(),
            ...common,
        };
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSubmit) return;
        if (isEditing) onUpdate(connection.id, buildData());
        else onAdd(buildData());
        onClose();
    };

    const title = connection
        ? `Edit connection — ${connection.name}`
        : firstConnection ? 'Add your first connection' : 'Add connection';

    return (
        <>
            <div className="modal-overlay" onClick={onClose} />
            <div ref={ref} className="modal connection-form-modal" role="dialog" aria-modal="true" aria-label={title}>
                <div className="modal-header">
                    <span className="modal-title">{title}</span>
                    <button className="modal-close" onClick={onClose} type="button" aria-label="Close">✕</button>
                </div>
                <div className="modal-body">
                    <form className="connection-form connection-form--modal" onSubmit={handleSubmit}>
                        <div className="connection-mode-toggle">
                            <button
                                type="button"
                                className={`connection-mode-btn${mode === 'mud' ? ' active' : ''}`}
                                onClick={() => setMode('mud')}
                            >
                                MUD Server
                            </button>
                            <button
                                type="button"
                                className={`connection-mode-btn${mode === 'websocket' ? ' active' : ''}`}
                                onClick={() => setMode('websocket')}
                            >
                                WebSocket
                            </button>
                        </div>

                        {!isEditing && (
                            <FormField label="Game" htmlFor="cs-game">
                                <select
                                    id="cs-game"
                                    className="input"
                                    value={game}
                                    onChange={e => pickGame(e.target.value)}
                                >
                                    <option value="">Choose a game, or fill in the fields below…</option>
                                    {OFFERED_GAMES.map(g => (
                                        <option key={g.name} value={g.name}>{g.name}</option>
                                    ))}
                                </select>
                            </FormField>
                        )}

                        <FormField label="Name" htmlFor="cs-name">
                            <Input
                                id="cs-name"
                                value={name}
                                onChange={e => setName(e.target.value)}
                                placeholder="My MUD"
                                spellCheck={false}
                                noAutofill
                            />
                        </FormField>

                        <FormField label="Description" htmlFor="cs-description">
                            <textarea
                                id="cs-description"
                                className="input connection-form-description"
                                value={description}
                                onChange={e => setDescription(e.target.value)}
                                placeholder="Optional notes about this profile"
                                rows={2}
                                spellCheck={false}
                            />
                        </FormField>

                        {mode === 'mud' ? (
                            <div className="connection-host-row">
                                <FormField label="Host" htmlFor="cs-host">
                                    <Input
                                        id="cs-host"
                                        value={host}
                                        onChange={e => {
                                            const { host: h, port: p } = splitHostPort(e.target.value);
                                            setHost(h);
                                            if (p !== undefined) setPort(p);
                                        }}
                                        placeholder="mud.example.com"
                                        spellCheck={false}
                                        noAutofill
                                    />
                                </FormField>
                                <FormField label="Port" htmlFor="cs-port">
                                    <Input
                                        id="cs-port"
                                        value={port}
                                        onChange={e => setPort(e.target.value)}
                                        placeholder="23"
                                        spellCheck={false}
                                        noAutofill
                                    />
                                </FormField>
                            </div>
                        ) : (
                            <FormField label="URL" htmlFor="cs-url">
                                <Input
                                    id="cs-url"
                                    value={url}
                                    onChange={e => setUrl(e.target.value)}
                                    placeholder="wss://mud.example.com:4000"
                                    spellCheck={false}
                                    noAutofill
                                />
                            </FormField>
                        )}

                        <div className="field">
                            <div className="proxy-label-row">
                                <label className="field__label" htmlFor="cs-proxy">Proxy URL</label>
                                <div className="proxy-label-actions">
                                    {proxyUrl && (
                                        <button type="button" className="proxy-reset-btn" onClick={() => setProxyUrl('')}>
                                            Use default
                                        </button>
                                    )}
                                    <button type="button" className="proxy-reset-btn" onClick={() => setProxyWhyOpen(true)}>
                                        Why do I need that?
                                    </button>
                                    <button type="button" className="proxy-reset-btn" onClick={() => setProxyModalOpen(true)}>
                                        Host your own
                                    </button>
                                </div>
                            </div>
                            <Input
                                id="cs-proxy"
                                value={proxyUrl}
                                onChange={e => setProxyUrl(e.target.value)}
                                placeholder={effectiveDefaultProxy || 'wss://mudix-proxy.yourname.workers.dev'}
                                spellCheck={false}
                                noAutofill
                            />
                            <span className="proxy-hint">
                                {mode === 'websocket'
                                    ? 'Used for HTTP requests blocked by CORS'
                                    : proxyUrl
                                        ? 'Custom proxy'
                                        : userProxyUrl
                                            ? `Your proxy: ${userProxyUrl}`
                                            : DEFAULT_PROXY_URL
                                                ? `Default: ${DEFAULT_PROXY_URL}`
                                                : 'No default proxy configured'}
                            </span>
                        </div>

                        {mode === 'mud' && (
                            <div className="tls-settings">
                                <div className="connection-autoconnect-row">
                                    <label className="connection-autoconnect-label" htmlFor="cs-tls">
                                        <span className="connection-autoconnect-title">Secure connection (TLS)</span>
                                        <span className="connection-autoconnect-hint">
                                            The proxy encrypts the link to the game. The game must offer a TLS port —
                                            usually a different one from its plaintext port.
                                        </span>
                                    </label>
                                    <Toggle id="cs-tls" checked={tls} onChange={setTls} />
                                </div>
                                {tls && !certOptionsSupported && (
                                    <div className="tls-cert-options tls-cert-options--unavailable">
                                        <span className="tls-cert-options-title">Certificate options unavailable</span>
                                        <span className="tls-cert-options-hint">
                                            This proxy runs on Cloudflare Workers, which cannot inspect the game's
                                            certificate or override a validation failure. The connection is still
                                            encrypted, but it only succeeds if the game's certificate is valid and
                                            publicly trusted. To accept an expired or self-signed certificate, use a
                                            self-hosted Node proxy.
                                        </span>
                                    </div>
                                )}
                                {tls && certOptionsSupported && (
                                    <div className="tls-cert-options">
                                        <span className="tls-cert-options-title">If the certificate can't be verified</span>
                                        <label className="tls-cert-option">
                                            <input
                                                type="checkbox"
                                                checked={sslIgnoreExpired}
                                                disabled={sslIgnoreAll}
                                                onChange={e => setSslIgnoreExpired(e.target.checked)}
                                            />
                                            <span>Accept expired certificates</span>
                                        </label>
                                        <label className="tls-cert-option">
                                            <input
                                                type="checkbox"
                                                checked={sslIgnoreSelfSigned}
                                                disabled={sslIgnoreAll}
                                                onChange={e => setSslIgnoreSelfSigned(e.target.checked)}
                                            />
                                            <span>Accept self-signed certificates</span>
                                        </label>
                                        <label className="tls-cert-option">
                                            <input
                                                type="checkbox"
                                                checked={sslIgnoreAll}
                                                onChange={e => setSslIgnoreAll(e.target.checked)}
                                            />
                                            <span className="tls-cert-option-danger">
                                                Accept all certificate errors (unsecure)
                                            </span>
                                        </label>
                                        <span className="tls-cert-options-hint">
                                            Accepting all errors keeps the traffic encrypted but no longer proves you're
                                            talking to the right server.
                                        </span>
                                    </div>
                                )}
                            </div>
                        )}

                        {mode === 'mud' && host.trim() && (
                            <div className="proxy-url-preview">
                                <span className="proxy-url-preview-label">Connects via</span>
                                <code className="proxy-url-preview-url">{buildPreviewUrl(host, port, proxyUrl, effectiveDefaultProxy, {
                                    on: tls, expired: sslIgnoreExpired, selfSigned: sslIgnoreSelfSigned, all: sslIgnoreAll,
                                })}</code>
                            </div>
                        )}

                        <div className="connection-autoconnect-row">
                            <label className="connection-autoconnect-label" htmlFor="cs-autoreconnect">
                                <span className="connection-autoconnect-title">Auto-connect on profile open</span>
                                <span className="connection-autoconnect-hint">
                                    Dial automatically when this profile is opened, instead of opening offline.
                                </span>
                            </label>
                            <Toggle
                                id="cs-autoreconnect"
                                checked={autoReconnect}
                                onChange={setAutoReconnect}
                                aria-label="Auto-connect on profile open"
                            />
                        </div>

                        <div className="connection-creds">
                            <div className="form-section-title form-section-title--sub">Login (optional)</div>
                            <div className="connection-creds-row">
                                <FormField label="Account" htmlFor="cs-account">
                                    <Input
                                        id="cs-account"
                                        name="username"
                                        autoComplete="username"
                                        value={account}
                                        onChange={e => setAccount(e.target.value)}
                                        placeholder="account name"
                                        spellCheck={false}
                                    />
                                </FormField>
                                <FormField label="Password" htmlFor="cs-password">
                                    <Input
                                        id="cs-password"
                                        name="password"
                                        type="password"
                                        autoComplete="current-password"
                                        value={password}
                                        onChange={e => setPassword(e.target.value)}
                                        placeholder="password"
                                    />
                                </FormField>
                            </div>
                            <span className="connection-creds-hint">
                                Auto-login: sent to GMCP login, or typed at the name/password prompts on
                                text-login MUDs.
                            </span>
                            {(account.trim() || password) && (
                                <p className="cred-warning" role="note">
                                    ⚠ Saves unencrypted in your browser's storage. Any script running on
                                    this page — an installed package, or an XSS bug — could read it.
                                </p>
                            )}
                        </div>

                        <div className="connection-form-actions">
                            <Button
                                type="submit"
                                variant="primary"
                                disabled={!canSubmit || busy}
                            >
                                {isEditing ? 'Save' : 'Add'}
                            </Button>
                            <Button type="button" variant="secondary" onClick={onClose}>
                                Cancel
                            </Button>
                        </div>
                    </form>
                </div>
            </div>
            {proxyModalOpen && (
                <ProxyInfoModal
                    onClose={() => setProxyModalOpen(false)}
                    onUseProxy={(url) => setProxyUrl(url)}
                />
            )}
            {proxyWhyOpen && (
                <ProxyWhyModal
                    onClose={() => setProxyWhyOpen(false)}
                    onHostYourOwn={() => { setProxyWhyOpen(false); setProxyModalOpen(true); }}
                />
            )}
        </>
    );
}
