import { useState } from 'react';
import App from './App';
import { ConfirmProvider } from './ui/components';
import { setBrand, getBrand, getThemeChoices, brandThemesCss, type BrandConfig } from './branding';
import { useAppStore, MUDIX_STORE_NAME } from './storage/appStore';
import { registerVfsServiceWorker } from './scripting/vfs/vfsBridge';
import { primeAppShellCache } from './utils/appShellCache';
import { installPinchZoomGuard } from './ui/preventPinchZoom';

// Page-level side effects, run once regardless of how many times MudletWebApp
// mounts (StrictMode double-invokes initializers). Living here — not in
// main.tsx — so library consumers get them without extra wiring.
let bootstrapped = false;
function bootstrapPage(): void {
    if (bootstrapped) return;
    bootstrapped = true;
    // Kick off SW registration eagerly; it doesn't block render. The first
    // request for a /__vfs/* asset awaits the SW being active via vfs:read
    // message handling on the page side. Once it is registered, tell it what
    // this build loaded so the app can be opened offline from the first visit.
    void registerVfsServiceWorker().then(ok => { if (ok) void primeAppShellCache(); });
    // Block accidental page pinch-zoom on the app chrome (the map keeps its own).
    installPinchZoomGuard();
    applyBrandTheming();
}

/** Brand theming, applied once at startup:
 *  - inject the brand's theme CSS after the bundled stylesheets (so it wins
 *    ties, and a brand theme reusing a stock id overrides it);
 *  - on a first launch (no persisted store yet), start on the brand's
 *    default theme;
 *  - if the persisted theme isn't offered by this brand (e.g. the brand
 *    narrowed `availableThemes` in an update), fall back to the default. */
function applyBrandTheming(): void {
    const brand = getBrand();
    const css = brandThemesCss();
    if (css && typeof document !== 'undefined') {
        const style = document.createElement('style');
        style.id = 'mudix-brand-themes';
        style.textContent = css;
        document.head.appendChild(style);
    }
    const choices = getThemeChoices();
    const fallback = brand.defaultTheme ?? choices[0]?.value;
    if (!fallback) return;
    const store = useAppStore.getState();
    const firstLaunch = typeof localStorage !== 'undefined' && localStorage.getItem(MUDIX_STORE_NAME) === null;
    if ((brand.defaultTheme && firstLaunch) || !choices.some(c => c.value === store.client.theme)) {
        store.patchClient({ theme: fallback });
    }
}

/**
 * Public root component — the entry point for both the stock app (`main.tsx`)
 * and branded builds consuming Mudlet Web as a library. The brand is installed into
 * the module-level singleton synchronously on first render, before any child
 * reads `getBrand()`. The brand is fixed for the lifetime of the app; changing
 * the prop later has no effect.
 */
export function MudletWebApp({ brand }: { brand?: Partial<BrandConfig> }) {
    // useState initializer = runs once, synchronously, before children render.
    useState(() => {
        setBrand(brand);
        bootstrapPage();
        return null;
    });
    return (
        <ConfirmProvider>
            <App />
        </ConfirmProvider>
    );
}
