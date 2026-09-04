import { useState } from 'react';
import WORKER_CODE from '../../worker/index.js?raw';
import { useAppStore } from '../storage';
import { Button, Input } from './components';
import { useModalFocus } from './components/useModalFocus';
import { getBrand } from '../branding';
import {
    listAccounts,
    deployWorker,
    enableWorkersDevRoute,
    getWorkersSubdomain,
    buildWorkerWssUrl,
    CloudflareApiError,
    type CloudflareAccount,
} from '../services/cloudflare';

interface Props {
    onClose: () => void;
    onUseProxy: (wssUrl: string) => void;
}

// Pre-filled template URL. permissionGroupKeys is a URL-encoded JSON array;
// user-token URLs also require accountId=*&zoneId=all for the page to honor the
// permission scoping. We include account_settings:read so the wizard can call
// GET /accounts to auto-fill the user's Account ID — without it, listAccounts
// returns CF error 6003.
// Docs: https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
const TOKEN_PERMISSIONS = [
    { key: 'workers_scripts',  type: 'edit' },
    { key: 'account_settings', type: 'read' },
];
// A function, not a const: the token's name carries the brand, which is only
// set once <MudletWebApp> has been rendered.
const tokenPageUrl = () =>
    'https://dash.cloudflare.com/profile/api-tokens'
    + '?permissionGroupKeys=' + encodeURIComponent(JSON.stringify(TOKEN_PERMISSIONS))
    + '&accountId=*&zoneId=all'
    + '&name=' + encodeURIComponent(`${getBrand().appName} Proxy Deploy`);

const DEFAULT_WORKER_NAME = 'mudix-proxy';
const WORKER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
// Cloudflare account IDs are 32-char lowercase hex.
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;

type Stage = 'input' | 'deploying' | 'need-subdomain' | 'success';

interface Progress {
    label: string;
    state: 'pending' | 'active' | 'done';
}

const STEPS = [
    'Upload worker script',
    'Enable workers.dev route',
    'Look up subdomain',
] as const;

export function ProxyWizardModal({ onClose, onUseProxy }: Props) {
    const patchClient = useAppStore(s => s.patchClient);
    const [stage, setStage] = useState<Stage>('input');
    const [token, setToken] = useState('');
    const [workerName, setWorkerName] = useState(DEFAULT_WORKER_NAME);
    const [accountId, setAccountId] = useState('');
    const [accounts, setAccounts] = useState<CloudflareAccount[]>([]);
    const [autofillState, setAutofillState] = useState<'idle' | 'loading' | 'failed'>('idle');
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState<Progress[]>(
        STEPS.map(label => ({ label, state: 'pending' })),
    );
    // Trap focus in the wizard; Escape closes except mid-deploy (matching the
    // overlay, which also ignores clicks while deploying).
    const ref = useModalFocus<HTMLDivElement>(stage === 'deploying' ? undefined : onClose);
    const [deployedUrl, setDeployedUrl] = useState<string>('');

    const nameValid = WORKER_NAME_PATTERN.test(workerName);
    const tokenValid = token.trim().length >= 20;
    const accountIdValid = ACCOUNT_ID_PATTERN.test(accountId.trim().toLowerCase());
    const canDeploy = tokenValid && nameValid && accountIdValid;

    const setStepState = (idx: number, state: Progress['state']) => {
        setProgress(prev => prev.map((p, i) => i === idx ? { ...p, state } : p));
    };

    // Auto-fill Account ID using the freshly-pasted token. Requires the token
    // to include account_settings:read (provided by our prefill). Failures are
    // silent — the manual input stays available either way.
    const tryAutofillAccount = async () => {
        if (autofillState === 'loading') return;
        setAutofillState('loading');
        try {
            const list = await listAccounts(token.trim());
            setAccounts(list);
            if (list.length === 1) {
                setAccountId(list[0].id);
                setAutofillState('idle');
            } else if (list.length === 0) {
                setAutofillState('failed');
            } else {
                setAutofillState('idle');
            }
        } catch {
            setAutofillState('failed');
        }
    };

    const handleDeploy = async () => {
        setError(null);
        setStage('deploying');
        setProgress(STEPS.map(label => ({ label, state: 'pending' })));

        const trimmedToken = token.trim();
        const trimmedAccountId = accountId.trim().toLowerCase();

        // Step 1: upload script
        setStepState(0, 'active');
        try {
            await deployWorker(trimmedToken, trimmedAccountId, workerName, WORKER_CODE);
            setStepState(0, 'done');
        } catch (e) {
            setStepState(0, 'pending');
            setStage('input');
            setError(humanizeError(e, 'Worker upload failed'));
            return;
        }

        // Step 2: enable *.workers.dev route
        setStepState(1, 'active');
        try {
            await enableWorkersDevRoute(trimmedToken, trimmedAccountId, workerName);
            setStepState(1, 'done');
        } catch (e) {
            setStepState(1, 'pending');
            setStage('input');
            setError(humanizeError(e, 'Enabling workers.dev route failed'));
            return;
        }

        // Step 3: look up subdomain
        setStepState(2, 'active');
        try {
            const subdomain = await getWorkersSubdomain(trimmedToken, trimmedAccountId);
            if (!subdomain) {
                // Worker is uploaded — just no account-wide subdomain claimed yet.
                // Don't reset earlier step states; let the user finish setup on the
                // dashboard and retry only the lookup.
                setStepState(2, 'pending');
                setStage('need-subdomain');
                return;
            }
            setStepState(2, 'done');
            const wssUrl = buildWorkerWssUrl(workerName, subdomain);
            setDeployedUrl(wssUrl);
            // Remember this URL across sessions so ConnectionScreen suggests it
            // as the default for new connections.
            patchClient({ userProxyUrl: wssUrl });
            setStage('success');
        } catch (e) {
            setStepState(2, 'pending');
            setStage('input');
            setError(humanizeError(e, 'Subdomain lookup failed'));
        }
    };

    const handleRetrySubdomain = async () => {
        setError(null);
        setStage('deploying');
        setStepState(2, 'active');
        try {
            const subdomain = await getWorkersSubdomain(token.trim(), accountId.trim().toLowerCase());
            if (!subdomain) {
                setStepState(2, 'pending');
                setStage('need-subdomain');
                return;
            }
            setStepState(2, 'done');
            const wssUrl = buildWorkerWssUrl(workerName, subdomain);
            setDeployedUrl(wssUrl);
            patchClient({ userProxyUrl: wssUrl });
            setStage('success');
        } catch (e) {
            setStepState(2, 'pending');
            setStage('need-subdomain');
            setError(humanizeError(e, 'Subdomain lookup failed'));
        }
    };

    const handleUseProxy = () => {
        onUseProxy(deployedUrl);
        onClose();
    };

    return (
        <>
            <div className="modal-overlay" onClick={stage === 'deploying' ? undefined : onClose} />
            <div ref={ref} className="modal proxy-wizard-modal" role="dialog" aria-modal="true" aria-label="Deploy proxy wizard">
                <div className="modal-header">
                    <span className="modal-title">Deploy proxy to Cloudflare</span>
                    <button
                        className="modal-close"
                        onClick={onClose}
                        disabled={stage === 'deploying'}
                        aria-label="Close"
                    >×</button>
                </div>
                <div className="modal-body proxy-info-body">
                    {stage === 'input' && (
                        <>
                            <p className="proxy-info-intro">
                                Paste a Cloudflare API token and your Account ID — we'll deploy the proxy Worker
                                to your account. The token is used once and discarded, never stored.
                            </p>
                            <p className="proxy-info-intro proxy-info-intro--note">
                                <strong>Note:</strong> Cloudflare's API blocks direct browser requests, so the deploy
                                calls (including your token) transit the default {getBrand().appName} proxy. If you don't want that,
                                use the manual setup instead.
                            </p>
                            <ol className="proxy-info-steps">
                                <li>
                                    Open the <a className="proxy-info-link" href={tokenPageUrl()} target="_blank" rel="noreferrer">pre-filled token page</a> (name + Workers Scripts: Edit), click <strong>Continue to summary → Create Token</strong>
                                </li>
                                <li>
                                    Copy your <strong>Account ID</strong> from the <a className="proxy-info-link" href="https://dash.cloudflare.com/?to=/:account/workers-and-pages" target="_blank" rel="noreferrer">Workers &amp; Pages</a> page (right sidebar)
                                </li>
                                <li>Paste both below and click <strong>Deploy</strong></li>
                            </ol>
                            <div className="wizard-field">
                                <label className="wizard-label" htmlFor="cf-token">API token</label>
                                <Input
                                    id="cf-token"
                                    type="password"
                                    value={token}
                                    onChange={e => {
                                        setToken(e.target.value);
                                        if (accounts.length || autofillState !== 'idle') {
                                            setAccounts([]);
                                            setAutofillState('idle');
                                        }
                                    }}
                                    onPaste={e => {
                                        // The paste's value lands in the input on the next tick;
                                        // defer the blur so the autofill (which runs on blur and
                                        // reads `token` state) sees the pasted text.
                                        const el = e.currentTarget as HTMLInputElement;
                                        setTimeout(() => el.blur(), 0);
                                    }}
                                    onBlur={() => {
                                        if (tokenValid && !accountId && accounts.length === 0) {
                                            tryAutofillAccount();
                                        }
                                    }}
                                    placeholder="paste token here"
                                    spellCheck={false}
                                    noAutofill
                                />
                            </div>
                            <div className="wizard-field">
                                <label className="wizard-label" htmlFor="cf-account-id">
                                    Account ID
                                    {autofillState === 'loading' && (
                                        <span className="wizard-hint wizard-hint--inline">  detecting…</span>
                                    )}
                                </label>
                                {accounts.length > 1 ? (
                                    <select
                                        id="cf-account-id"
                                        className="settings-select"
                                        value={accountId}
                                        onChange={e => setAccountId(e.target.value)}
                                    >
                                        <option value="">— select account —</option>
                                        {accounts.map(a => (
                                            <option key={a.id} value={a.id}>{a.name} ({a.id.slice(0, 8)}…)</option>
                                        ))}
                                    </select>
                                ) : (
                                    <Input
                                        id="cf-account-id"
                                        value={accountId}
                                        onChange={e => setAccountId(e.target.value.trim())}
                                        placeholder="32-character hex string"
                                        spellCheck={false}
                                        noAutofill
                                    />
                                )}
                                {accountId.length > 0 && !accountIdValid && (
                                    <span className="wizard-hint wizard-hint--error">
                                        Account ID is 32 hexadecimal characters.
                                    </span>
                                )}
                            </div>
                            <div className="wizard-field">
                                <label className="wizard-label" htmlFor="cf-worker-name">Worker name</label>
                                <Input
                                    id="cf-worker-name"
                                    value={workerName}
                                    onChange={e => setWorkerName(e.target.value.toLowerCase())}
                                    placeholder={DEFAULT_WORKER_NAME}
                                    spellCheck={false}
                                    noAutofill
                                />
                                {!nameValid && workerName.length > 0 && (
                                    <span className="wizard-hint wizard-hint--error">
                                        Lowercase letters, numbers, hyphens; must start with a letter or number.
                                    </span>
                                )}
                                {nameValid && (
                                    <span className="wizard-hint">
                                        Existing worker with this name will be overwritten.
                                    </span>
                                )}
                            </div>
                            {error && <div className="wizard-error">{error}</div>}
                            <div className="wizard-actions">
                                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                                <Button variant="primary" disabled={!canDeploy} onClick={handleDeploy}>
                                    Deploy
                                </Button>
                            </div>
                        </>
                    )}

                    {stage === 'deploying' && (
                        <>
                            <p className="proxy-info-intro">Deploying your proxy…</p>
                            <ul className="wizard-progress">
                                {progress.map((p, i) => (
                                    <li key={i} className={`wizard-progress-step wizard-progress-step--${p.state}`}>
                                        <span className="wizard-progress-icon" aria-hidden="true">
                                            {p.state === 'done' ? '✓' : p.state === 'active' ? '…' : '○'}
                                        </span>
                                        <span>{p.label}</span>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}

                    {stage === 'need-subdomain' && (
                        <>
                            <p className="proxy-info-intro">
                                <strong>Worker uploaded — one more step.</strong> Your account doesn't have a
                                <code> workers.dev</code> subdomain yet. Cloudflare requires you to pick one once
                                per account.
                            </p>
                            <ol className="proxy-info-steps">
                                <li>
                                    Open <a className="proxy-info-link" href="https://dash.cloudflare.com/?to=/:account/workers-and-pages" target="_blank" rel="noreferrer">Workers &amp; Pages</a> in the Cloudflare dashboard
                                </li>
                                <li>Cloudflare will prompt you to choose a subdomain (e.g. <code>yourname.workers.dev</code>)</li>
                                <li>Come back here and click <strong>Retry</strong></li>
                            </ol>
                            {error && <div className="wizard-error">{error}</div>}
                            <div className="wizard-actions">
                                <Button variant="ghost" onClick={onClose}>Close</Button>
                                <Button variant="primary" onClick={handleRetrySubdomain}>Retry</Button>
                            </div>
                        </>
                    )}

                    {stage === 'success' && (
                        <>
                            <p className="proxy-info-intro">
                                <strong>Worker deployed.</strong> Your proxy is live at:
                            </p>
                            <div className="wizard-result-url"><code>{deployedUrl}</code></div>
                            <p className="proxy-info-intro">
                                Click below to use it for new connections. The first request may take a couple of seconds while Cloudflare propagates the route.
                            </p>
                            <div className="wizard-actions">
                                <Button variant="ghost" onClick={onClose}>Close</Button>
                                <Button variant="primary" onClick={handleUseProxy}>Use this proxy</Button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </>
    );
}

function humanizeError(err: unknown, fallback: string): string {
    if (err instanceof CloudflareApiError) {
        if (err.status === 401 || err.status === 403) {
            return `${err.message} (check that the token has Workers Scripts: Edit permission for this account).`;
        }
        if (err.status === 404) {
            return `${err.message} (check that the Account ID is correct).`;
        }
        return err.message;
    }
    if (err instanceof TypeError && /fetch/i.test(err.message)) {
        return 'Network request to Cloudflare API failed. Check your connection or browser extensions that may block CORS.';
    }
    if (err instanceof Error) return err.message || fallback;
    return fallback;
}
