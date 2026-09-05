import { useState } from 'react';
import { Button, Input, FormField, Toggle } from './components';
import { useModalFocus } from './components/useModalFocus';
import { ProxyInfoModal } from './ProxyInfoModal';
import { ProxyWhyModal } from './ProxyWhyModal';
import { connectionNameTaken, connectionUrl, DEFAULT_MUD_PORT, DEFAULT_PROXY_URL, proxyCanInspectCertificates, useAppStore, validateHost, validatePort, validateProxyUrl, validateWsUrl, type ConnectionMode, type MudConnection } from '../storage';
import type { VaultSaver } from './useVaultSaver';
import { useVault } from '../vault/useVault';

/** Preview of the proxy URL the profile will dial. Runs the fields through
 *  `connectionUrl()` itself rather than a parallel copy of it, so the preview
 *  cannot drift from what Connect actually does — it used to be a hand-kept
 *  duplicate carrying a "keep the two in step" note. */
function buildPreviewUrl(
    host: string, port: number, proxyUrl: string, fallback: string,
    tls: { on: boolean; expired: boolean; selfSigned: boolean; all: boolean },
): string {
    return connectionUrl({
        id: '', name: '', mode: 'mud',
        host: host.trim(),
        port,
        proxyUrl: proxyUrl.trim() || fallback,
        tls: tls.on || undefined,
        sslIgnoreExpired: tls.on && tls.expired ? true : undefined,
        sslIgnoreSelfSigned: tls.on && tls.selfSigned ? true : undefined,
        sslIgnoreAll: tls.on && tls.all ? true : undefined,
    });
}

function modeOf(c: Pick<MudConnection, 'mode'>): ConnectionMode {
    return c.mode ?? 'websocket';
}

/** Split a host string that may carry a trailing port (`host:port` or
 *  `host port`) into its parts, so pasting a full address moves the port into
 *  the Port field. Returns `port: undefined` when no trailing numeric port is
 *  present, leaving the Port field untouched.
 *
 *  An IPv6 literal is all colons and hex, so the old non-greedy `(.*?)[\s:]+(\d+)$`
 *  matched its own tail: typing `2001:db8::1` left host `2001:db8` and port 1,
 *  and saved it that way (issue #56). Only the bracketed form `[::1]:4000` has
 *  an unambiguous port, so that is the only IPv6 shape that gets split. */
export function splitHostPort(value: string): { host: string; port?: string } {
    const trimmed = value.trim();
    const bracketed = trimmed.match(/^\[([^\]]+)\][\s:]+(\d+)$/);
    if (bracketed) return { host: `[${bracketed[1]}]`, port: bracketed[2] };
    // Two or more colons is an IPv6 literal being typed, not host:port.
    if ((trimmed.match(/:/g)?.length ?? 0) >= 2) return { host: value };
    const match = trimmed.match(/^(.*?)[\s:]+(\d+)$/);
    if (match && match[1].trim() !== '') {
        return { host: match[1].trim(), port: match[2] };
    }
    return { host: value };
}

interface Props {
    /** The connection to edit, or null to add a new one. */
    connection: MudConnection | null;
    /** Field values to start a new connection from, when `connection` is null —
     *  a bundled game's host/port/blurb, so picking a game fills the form in
     *  rather than dialing straight away. Ignored when editing. */
    preset?: Omit<MudConnection, 'id'> | null;
    /** Whether this is the very first connection (drives the title copy). */
    firstConnection: boolean;
    /** Overrides the generated dialog title (e.g. "Add Achaea"). */
    title?: string;
    busy: boolean;
    onAdd: (data: Omit<MudConnection, 'id'>) => string;
    onUpdate: (id: string, data: Omit<MudConnection, 'id'>) => void;
    onClose: () => void;
    /** Where a typed password goes. Owned by the screen above, not by this
     *  modal: saving may need a vault setup or unlock step, and this form closes
     *  on submit — a prompt rendered from here would unmount with it. */
    vaultSaver: VaultSaver;
}

export function ConnectionFormModal({ connection, preset, firstConnection, title: titleOverride, busy, onAdd, onUpdate, onClose, vaultSaver }: Props) {
    const userProxyUrl = useAppStore(s => s.client.userProxyUrl);
    const effectiveDefaultProxy = userProxyUrl || DEFAULT_PROXY_URL;

    const isEditing = connection !== null;

    // What the fields start from: the connection being edited, or the preset a
    // bundled game supplied, or nothing at all for a blank Add.
    const initial = connection ?? preset ?? null;

    const [mode, setMode] = useState<ConnectionMode>(initial ? modeOf(initial) : 'mud');
    const [name, setName] = useState(initial?.name ?? '');
    const [host, setHost] = useState(initial?.host ?? '');
    const [port, setPort] = useState(String(initial?.port ?? 23));
    const [proxyUrl, setProxyUrl] = useState(initial?.proxyUrl ?? '');
    const [url, setUrl] = useState(initial?.url ?? '');
    const [autoReconnect, setAutoReconnect] = useState(initial?.autoReconnect ?? false);
    const [tls, setTls] = useState(initial?.tls ?? false);
    const [sslIgnoreExpired, setSslIgnoreExpired] = useState(initial?.sslIgnoreExpired ?? false);
    const [sslIgnoreSelfSigned, setSslIgnoreSelfSigned] = useState(initial?.sslIgnoreSelfSigned ?? false);
    const [sslIgnoreAll, setSslIgnoreAll] = useState(initial?.sslIgnoreAll ?? false);
    // A Cloudflare-Worker proxy cannot inspect certificates, so the tolerance
    // options below would be silently ignored. Derived from the live field so
    // editing the proxy URL updates the form without a save/reopen.
    const certOptionsSupported = proxyCanInspectCertificates(proxyUrl.trim() || effectiveDefaultProxy);
    const [account, setAccount] = useState(initial?.charLoginAccount ?? '');
    // Never prefilled from the vault: this form is reachable without unlocking
    // it, and a blank field that means "unchanged" beats one that misrepresents
    // what is stored. An empty box therefore leaves a saved password alone; the
    // "Forget" button next to it is how you remove one.
    const [password, setPassword] = useState('');
    // Whether the vault already holds one for this profile. Answerable while
    // the vault is locked, so the field can say "saved" without opening it.
    const vaultEntries = useVault().entryIds;
    const savedId = connection?.id;
    const hasSavedPassword = !!savedId && vaultEntries.includes(savedId);
    const [description, setDescription] = useState(initial?.description ?? '');

    const [proxyModalOpen, setProxyModalOpen] = useState(false);
    const [proxyWhyOpen, setProxyWhyOpen] = useState(false);

    const ref = useModalFocus<HTMLDivElement>(onClose, { autoFocus: true, closeOnEscape: true });

    // Profile names have to be unique, and the store would otherwise quietly
    // rename this one to "<name> (2)" — right for an import that has nobody to
    // ask, wrong for someone typing a name who deserves to be told. Compared
    // ignoring case because that is how the scripting API resolves a profile
    // name, so two differing only in case would be indistinguishable to it.
    const connections = useAppStore(s => s.connections);
    const nameTaken = connectionNameTaken(name, connections, connection?.id);

    // `parseInt` used to stand in for validation here, which meant `1e3` was
    // stored as 1, `0x50` as 0 and `23abc` as 23 — a different port from the one
    // typed, saved without a word, and an out-of-range one was stored verbatim
    // only for the proxy to reject it later as "proxy unreachable". Mudlet
    // refuses both at the dialog (dlgConnectionProfiles.cpp:2140-2160); so do we.
    const portCheck = validatePort(port);
    // The same gap the port had, in the other three address fields: `canSubmit`
    // only ever checked non-emptiness, so a host with spaces, a `ws://` prefix,
    // a path, or 1200 characters of anything was stored verbatim and only
    // failed later as the proxy's generic connect error — and a websocket URL
    // of `http://example.com` or `not a url` failed as a browser-internal
    // string on Connect. Both are decidable here (issue #56).
    const hostCheck = validateHost(host, tls);
    const urlCheck = validateWsUrl(url);
    const proxyCheck = validateProxyUrl(proxyUrl);
    // An empty field is not an error yet — it is a form you have not finished.
    const showHostError = !hostCheck.ok && hostCheck.reason !== 'empty';
    const showUrlError = !urlCheck.ok && urlCheck.reason !== 'empty';

    const canSubmit = !nameTaken && proxyCheck.ok && (mode === 'mud'
        ? name.trim() !== '' && hostCheck.ok && portCheck.ok
        : name.trim() !== '' && urlCheck.ok);

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
            // The password is not written here any more — it goes to the
            // credential vault in handleSubmit. Clearing the field also clears
            // any pre-vault plaintext copy still on the record (issue #25).
            charLoginPassword: undefined,
            description: description.trim() || undefined,
        };
        if (mode === 'mud') {
            return {
                name: name.trim(),
                mode: 'mud',
                host: host.trim(),
                // Only reachable with a valid port — `canSubmit` gates it — so
                // the fallback is for the type, not for a silent coercion.
                port: portCheck.ok ? portCheck.port : DEFAULT_MUD_PORT,
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
        let id: string;
        if (isEditing) { id = connection.id; onUpdate(id, buildData()); }
        else { id = onAdd(buildData()); }
        // A typed password is a new one to store; an empty field means "leave
        // whatever is saved alone", so only an explicit Forget removes it.
        if (account.trim() && password) vaultSaver.save(id, password);
        onClose();
    };

    const title = titleOverride ?? (connection
        ? `Edit connection — ${connection.name}`
        : firstConnection ? 'Add your first connection' : 'Add connection');

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

                        <FormField label="Name" htmlFor="cs-name">
                            <Input
                                id="cs-name"
                                value={name}
                                onChange={e => setName(e.target.value)}
                                placeholder="My MUD"
                                spellCheck={false}
                                aria-invalid={nameTaken || undefined}
                                aria-describedby={nameTaken ? 'cs-name-error' : undefined}
                                noAutofill
                            />
                            {nameTaken && (
                                <div id="cs-name-error" className="field__error" role="alert">
                                    Another profile is already called “{name.trim()}”.
                                </div>
                            )}
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
                                        aria-invalid={showHostError || undefined}
                                        aria-describedby={showHostError ? 'cs-host-error' : undefined}
                                        noAutofill
                                    />
                                    {showHostError && (
                                        <div id="cs-host-error" className="field__error" role="alert">
                                            {hostCheck.message}
                                        </div>
                                    )}
                                </FormField>
                                <FormField label="Port" htmlFor="cs-port">
                                    <Input
                                        id="cs-port"
                                        value={port}
                                        onChange={e => setPort(e.target.value)}
                                        placeholder="23"
                                        spellCheck={false}
                                        inputMode="numeric"
                                        aria-invalid={!portCheck.ok || undefined}
                                        aria-describedby={portCheck.ok ? undefined : 'cs-port-error'}
                                        noAutofill
                                    />
                                    {!portCheck.ok && (
                                        <div id="cs-port-error" className="field__error" role="alert">
                                            {portCheck.message}
                                        </div>
                                    )}
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
                                    aria-invalid={showUrlError || undefined}
                                    aria-describedby={showUrlError ? 'cs-url-error' : undefined}
                                    noAutofill
                                />
                                {showUrlError && (
                                    <div id="cs-url-error" className="field__error" role="alert">
                                        {urlCheck.message}
                                    </div>
                                )}
                                {/* Well-formed but unusable from this page. A
                                    warning, not an error: it is correct on an
                                    http:// dev server, and docs/help/connecting.md
                                    explains the rule but the form never did. */}
                                {urlCheck.ok && urlCheck.insecure && (
                                    <div className="field__hint">
                                        This page is served over https://, and a browser refuses a plain
                                        ws:// socket from one. Use wss:// unless you are testing locally.
                                    </div>
                                )}
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
                                aria-invalid={!proxyCheck.ok || undefined}
                                aria-describedby={proxyCheck.ok ? undefined : 'cs-proxy-error'}
                                noAutofill
                            />
                            {!proxyCheck.ok && (
                                <div id="cs-proxy-error" className="field__error" role="alert">
                                    {proxyCheck.message}
                                </div>
                            )}
                            {proxyCheck.ok && proxyCheck.insecure && (
                                <div className="field__hint">
                                    This page is served over https://, so a plain ws:// proxy is blocked as
                                    mixed content and can only ever fail.
                                </div>
                            )}
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

                        {/* Hidden while the port is invalid: a preview built from a
                            coerced port is the very thing that made the typo
                            invisible. */}
                        {mode === 'mud' && host.trim() && portCheck.ok && (
                            <div className="proxy-url-preview">
                                <span className="proxy-url-preview-label">Connects via</span>
                                <code className="proxy-url-preview-url">{buildPreviewUrl(host, portCheck.port, proxyUrl, effectiveDefaultProxy, {
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
                                        placeholder={hasSavedPassword ? 'saved — type to replace' : 'password'}
                                        disabled={!vaultSaver.canSave}
                                    />
                                </FormField>
                            </div>
                            <span className="connection-creds-hint">
                                Auto-login: sent to GMCP login, or typed at the name/password prompts on
                                text-login MUDs.
                            </span>
                            {vaultSaver.canSave
                                ? (
                                    <div className="vault-save-row">
                                        <span className="vault-save-note">{vaultSaver.note}</span>
                                        {hasSavedPassword && (
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => { setPassword(''); if (savedId) vaultSaver.save(savedId, null); }}
                                            >
                                                Forget
                                            </Button>
                                        )}
                                    </div>
                                )
                                : (
                                    <p className="vault-save-note" role="note">
                                        This build doesn't store passwords — enter one at the game's login
                                        prompt instead.
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
