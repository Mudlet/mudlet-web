import type { ComponentType, ReactNode } from 'react';
import type { ConnectionMode, MudConnection } from './storage/schema';
import mudletLogoUrl from './assets/mudlet-logo.svg?url';

/**
 * White-label branding for Mudlet Web builds. A branded client (a client
 * shipped for one specific MUD) passes a `BrandConfig` to
 * `<MudletWebApp brand={...}/>`; the config is held in a module-level singleton so
 * non-React code (proxy resolution, document title, default packages) can read
 * it without prop drilling. The default brand is stock Mudlet Web — rendering
 * `<MudletWebApp/>` with no brand reproduces it exactly.
 */

/** The one MUD a branded build targets. Setting this switches the client into
 *  branded mode: exactly one profile (seeded from these fields on first
 *  launch), no profile creation/selection UI — the landing is a login form
 *  (the built-in `BrandLoginScreen`, or the brand's own `Landing`) — and
 *  login credentials are kept in memory only, never persisted. */
export interface BrandMudTarget {
    mode: ConnectionMode;
    /** `mud` mode (via telnet proxy). */
    host?: string;
    port?: number;
    /** `websocket` mode (native WS endpoint). */
    url?: string;
    /** Display name for seeded profiles; defaults to the brand's `appName`. */
    name?: string;
    /** Seeded profiles dial automatically when opened. */
    autoConnect?: boolean;
}

/** A package bundled with the brand, installed on first profile open through
 *  the same pipeline as the stock defaults (see `ensureDefaultPackages`). */
export interface BrandPackage {
    /** Must match the manifest name produced by installPackageFromBytes. */
    name: string;
    /** Filename passed to the installer (drives manifest.name + on-disk dir). */
    filename: string;
    /** Resolved URL to the asset (e.g. an `?url` import in the brand's repo). */
    url: string;
    /** Package version. When set, a profile whose installed copy has a
     *  different manifest version reinstalls fresh on the next open — bump it
     *  (together with the package's config.lua) to ship updates to players.
     *  Unset = install once, never touch again. */
    version?: string;
    /** Whether the user may uninstall this package (default true). When false
     *  the uninstall control is hidden, Lua `uninstallPackage()` refuses it,
     *  and it reinstalls on the next profile open even if removed by other
     *  means. A removable package the user uninstalls stays uninstalled. */
    removable?: boolean;
}

/** A brand-defined color theme. Rendered as a `:root[data-theme=<id>]` CSS
 *  rule injected at startup, after the bundled stylesheets — so unset
 *  variables inherit the dark base (`:root` in App.css), and a theme reusing
 *  a stock id (`dark`, `light`, …) overrides that stock theme's values. */
export interface BrandTheme {
    /** Theme id stored in settings and stamped on `data-theme`. */
    id: string;
    /** Name shown in the theme picker. */
    label: string;
    /** CSS custom properties, e.g. `{ '--accent': '#c09648' }`. See the
     *  `:root` block in App.css for the full token list; anything unset
     *  falls through to the dark base. */
    variables: Record<string, string>;
    /** `'light'` also switches the browser's `color-scheme` (native form
     *  controls, scrollbars) and the script editor's syntax colors. */
    colorScheme?: 'dark' | 'light';
}

/** Stock built-in themes, as shown in the settings picker. */
export const STOCK_THEMES: { value: string; label: string }[] = [
    { value: 'dark', label: 'Dark (Teal)' },
    { value: 'amber', label: 'Dark (Amber)' },
    { value: 'sky', label: 'Dark (Sky Blue)' },
    { value: 'light', label: 'Light (Qt)' },
    { value: 'graylight', label: 'Light (Gray)' },
];

/** Ids of the stock toolbar buttons, for `BrandToolbarConfig.hide`.
 *  `connection` is the Reconnect/Disconnect pair; `close` closes the profile;
 *  `record` toggles Mudlet-format replay recording. */
export type StockToolbarButton =
    | 'scripts' | 'files' | 'map' | 'logs' | 'docs' | 'help' | 'reportBug' | 'settings'
    | 'record' | 'connection' | 'close';

/** What a brand toolbar button can do when clicked. */
export interface BrandToolbarContext {
    connectionId: string;
    /** Send a command as if the user typed it (echoed, alias-processed). */
    send(text: string): void;
    /** Raise a Mudlet event in the profile's Lua runtime — script handlers
     *  registered via registerAnonymousEventHandler etc. receive it. */
    raiseEvent(event: string, ...args: unknown[]): void;
}

export interface BrandToolbarButton {
    /** Stable id (also the React key). */
    id: string;
    label: string;
    /** Optional icon node rendered before the label. */
    icon?: ReactNode;
    /** Tooltip. */
    title?: string;
    onClick(ctx: BrandToolbarContext): void;
}

export interface BrandToolbarConfig {
    /** Stock buttons to remove. */
    hide?: StockToolbarButton[];
    /** Brand buttons, appended after the stock app buttons. */
    buttons?: BrandToolbarButton[];
    /** Extra class on the toolbar root (`.mudix-toolbar`) so brand CSS can
     *  restyle it. */
    className?: string;
}

/** Contract for a brand-supplied landing screen, rendered instead of the stock
 *  connection picker whenever no profile is open. */
export interface LandingProps {
    connections: MudConnection[];
    /** Open a profile; `connect` dials immediately instead of opening offline. */
    openProfile: (connectionId: string, connect: boolean) => void;
    /** Find-or-create the brand's managed profile and return its connection
     *  id to pass to `openProfile`. In `profileMode: 'perLogin'`, `account`
     *  selects (or names) the per-account profile, matched case-insensitively;
     *  otherwise the single shared profile is used. Never pass credentials
     *  into storage — use `setSessionCredentials` from
     *  `utils/sessionCredentials` for the password. */
    ensureBrandProfile: (account?: string) => string;
    openSettings: () => void;
}

export interface BrandConfig {
    /** App name: wordmark, document title, About dialog. */
    appName: string;
    /** Logo shown beside the wordmark in the toolbar. Resolved URL — in a brand
     *  repo, an `?url` import of your own asset.
     *
     *  **Not inherited.** The stock value is Mudlet's own logo, so passing any
     *  `brand` at all clears it unless that brand sets `logoUrl` itself; a
     *  white-label client never ships the Mudlet mark by accident. Set it to
     *  your own asset to show one, or leave it unset for a wordmark alone. */
    logoUrl?: string;
    /** Short tagline under the About wordmark. Empty string hides it. */
    tagline?: string;
    /** Descriptive paragraph in the About dialog. Empty string hides it. */
    aboutText?: string;
    /** "View source" link in the About dialog. `undefined` hides the link. */
    repoUrl?: string;
    /** Brand-hardcoded telnet proxy. Sits below explicit user overrides in the
     *  precedence chain (connection > user settings > brand > built-in), but
     *  branded builds never expose the per-connection proxy field, so this
     *  effectively wins. */
    proxyUrl?: string;
    /** The single MUD this build targets. Setting it enables branded mode —
     *  see the type's doc. Leave unset for a stock (open) client. */
    mud?: BrandMudTarget;
    /** How branded builds map logins to profiles (default `'single'`):
     *  - `'single'`   — one shared profile regardless of the account entered.
     *  - `'perLogin'` — find-or-create a profile per account name entered at
     *    the login form (compared case-insensitively, stored as the profile
     *    name) — each login keeps its own scripts, layout and files. There is
     *    still no picker: selection happens by logging in. */
    profileMode?: 'single' | 'perLogin';
    /**
     * The exact set of packages preinstalled into every profile on first open,
     * replacing the stock defaults rather than adding to them:
     *
     * - unset — no opinion; the stock defaults install (`run-lua-code` plus one
     *   mapper, chosen per game — see `stockDefaults`).
     * - `[]` — nothing is preinstalled.
     * - a list — exactly these, and none of the stock ones.
     *
     * So a brand shipping its own mapper just lists it here and ours never
     * appears; nothing arbitrates between them at install time, which is why the
     * list is exact rather than additive (two mappers would both drive
     * `centerview` off the same movement).
     */
    packages?: BrandPackage[];
    /** Brand-defined themes, offered in the picker alongside (or instead of)
     *  the stock ones. A theme reusing a stock id overrides it. */
    themes?: BrandTheme[];
    /** Theme ids offered in the settings picker, in this order. Unset = all
     *  stock themes plus every brand theme. Use to trim the choice down
     *  (e.g. `['puszcza', 'dark']`) — ids may be stock or brand-defined. */
    availableThemes?: string[];
    /** Theme active on first launch (before the user ever picks one). Also
     *  the fallback when the current theme isn't in `availableThemes`. */
    defaultTheme?: string;
    /** Toolbar customization: hide stock buttons, add brand buttons (which
     *  can send commands or raise script events), restyle via className. */
    toolbar?: BrandToolbarConfig;
    /** Custom landing screen replacing the stock connection picker. */
    Landing?: ComponentType<LandingProps>;
}

export const DEFAULT_BRAND: BrandConfig = {
    appName: 'Mudlet Web',
    logoUrl: mudletLogoUrl,
    tagline: 'Mudlet, in your browser.',
    aboutText:
        'Mudlet Web connects to MUD servers over WebSocket with full telnet, GMCP and MSDP ' +
        'support, renders ANSI output, and runs Mudlet Lua scripting right in the browser — ' +
        'with drop-in support for existing Mudlet packages, maps and profiles, and nothing ' +
        'to install.',
    repoUrl: 'https://github.com/Mudlet/mudlet-web',
};

let current: BrandConfig = DEFAULT_BRAND;

/** Install the active brand. Called once by `MudletWebApp` before first render;
 *  unspecified fields fall back to the stock Mudlet Web brand. Idempotent. */
export function setBrand(brand?: Partial<BrandConfig>): void {
    current = { ...DEFAULT_BRAND, ...brand };
    // `logoUrl` is the one field that does NOT fall through: the stock value is
    // Mudlet's own logo, and a white-label client that merely renamed itself
    // must not ship it. Opting in is explicit — set `logoUrl` in your brand.
    if (brand && !('logoUrl' in brand)) current.logoUrl = undefined;
}

export function getBrand(): BrandConfig {
    return current;
}

/** Whether the active brand pins a MUD — i.e. the client runs in branded mode
 *  (single profile, login-form landing, no persisted credentials). */
export function isBrandedMode(): boolean {
    return !!current.mud;
}

/** Whether the user may uninstall the named package. Only brand-bundled
 *  packages marked `removable: false` are locked; everything else — stock
 *  defaults included — is removable. */
export function isPackageRemovable(name: string): boolean {
    return current.packages?.find(p => p.name === name)?.removable !== false;
}

/** Theme options for the settings picker: brand themes first (one overriding
 *  a stock id replaces it in place), narrowed and ordered by
 *  `availableThemes` when set. */
export function getThemeChoices(): { value: string; label: string }[] {
    const brandThemes = (current.themes ?? []).map(t => ({ value: t.id, label: t.label }));
    const merged = [
        ...brandThemes,
        ...STOCK_THEMES.filter(s => !brandThemes.some(b => b.value === s.value)),
    ];
    if (!current.availableThemes) return merged;
    return current.availableThemes
        .map(id => merged.find(m => m.value === id))
        .filter((m): m is { value: string; label: string } => !!m);
}

/** Whether a theme id renders on a light base — drives `color-scheme` and the
 *  script editor's syntax palette. Brand themes declare it via `colorScheme`. */
export function isLightTheme(id: string): boolean {
    const brand = current.themes?.find(t => t.id === id);
    if (brand) return brand.colorScheme === 'light';
    return id === 'light' || id === 'graylight';
}

/** Stylesheet text for the brand's themes — one `:root[data-theme=<id>]` rule
 *  each. Injected after the bundled CSS so it wins ties (see MudletWebApp). */
export function brandThemesCss(): string {
    return (current.themes ?? []).map(t => {
        const scheme = t.colorScheme ? `color-scheme: ${t.colorScheme};\n    ` : '';
        const vars = Object.entries(t.variables).map(([k, v]) => `${k}: ${v};`).join('\n    ');
        return `:root[data-theme="${t.id}"] {\n    ${scheme}${vars}\n}`;
    }).join('\n');
}

/** Connection-record seed for the brand's MUD, or null when the brand doesn't
 *  pin one. Used to create the managed profile(s) in branded mode; `account`
 *  names a per-login profile (see `profileMode: 'perLogin'`). */
export function brandConnectionData(brand: BrandConfig, account?: string): Omit<MudConnection, 'id'> | null {
    const mud = brand.mud;
    if (!mud) return null;
    const common = {
        name: account?.trim() || mud.name || brand.appName,
        autoReconnect: mud.autoConnect || undefined,
    };
    if (mud.mode === 'mud') {
        return { ...common, mode: 'mud', host: mud.host ?? '', port: mud.port ?? 23, url: undefined };
    }
    return { ...common, mode: 'websocket', url: mud.url ?? '', host: undefined, port: undefined };
}

/** The existing managed profile a login maps to, if any. In `'perLogin'` mode
 *  a non-empty `account` matches the profile named after it (trimmed,
 *  case-insensitive); otherwise — `'single'` mode, or no account entered —
 *  the one shared profile (the first connection) is used. */
export function matchBrandProfile(
    connections: MudConnection[],
    brand: BrandConfig,
    account?: string,
): MudConnection | undefined {
    const acct = account?.trim().toLowerCase();
    if (brand.profileMode === 'perLogin' && acct) {
        return connections.find(c => c.name.trim().toLowerCase() === acct);
    }
    return connections[0];
}
