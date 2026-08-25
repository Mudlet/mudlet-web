import type { ProfileVFS } from '../scripting/vfs/ProfileVFS';
import { useAppStore } from '../storage/appStore';
import { getBrand } from '../branding';
import { installPackageFromBytes } from './packageInstaller';
// `./defaults/` is a vendored mirror of Mudlet's `src/packages/` — every package
// it preinstalls, one directory each, holding the `.mpackage` archive and the
// sources it was built from (see scripts/sync-mudlet-lua.mjs). Vendoring is not
// preinstalling: what a profile actually gets is decided below, and only the
// archives imported here reach a build at all.
//
// These imports stay external in the library build (vite.lib.config.ts matches
// `/import/defaults/`) and ship in dist-lib, so the consumer's Vite emits them as
// real assets — lib mode would otherwise inline each as a base64 data URI, and
// mudlet-mapper.xml alone is ~490 kB. scripts/copy-lib-assets.mjs puts them there.
import runLuaCodeUrl from './defaults/run-lua-code/run-lua-code.mpackage?url';
import genericMapperUrl from './defaults/generic_mapper/generic_mapper.mpackage?url';
// Mudlet's starter interface.
import baseUiUrl from './defaults/mudlet-base-ui/mudlet-base-ui.mpackage?url';
// The IRE mapper: the one preinstalled package Mudlet doesn't keep in
// `src/packages/` — upstream publishes it as a bare `src/mudlet-mapper.xml`, so
// the sync pulls it in from the repo root and drops it here loose. Plain XML,
// not a zip: the installer parses it into tree nodes and writes nothing to the VFS.
import mudletMapperUrl from './defaults/mudlet-mapper.xml?url';
// Mudlet preinstalls gui-drop as `gui-drop.mpackage`, and so do we. mudix ran
// off the loose `gui-drop.xml` beside it for a while, because a `.mpackage` is a
// zip the sync script round-trips byte-for-byte and the digit-prefix fix it
// needed couldn't be patched inside one; Mudlet/Mudlet#9628 landed that fix
// upstream, so the archive is back.
import guiDropUrl from './defaults/gui-drop/gui-drop.mpackage?url';
// Mudlet's command-line package manager, preinstalled for every game.
import mpkgUrl from './defaults/mpkg/mpkg.mpackage?url';

interface DefaultPackage {
    /** Must match the manifest name produced by installPackageFromBytes. */
    name: string;
    /** Filename passed to the installer (drives manifest.name + on-disk dir). */
    filename: string;
    /** Vite-resolved URL to the bundled asset. */
    url: string;
    /** When set, an installed copy with a different manifest version is
     *  reinstalled fresh — how brands ship package updates to players. */
    version?: string;
}

const RUN_LUA_CODE: DefaultPackage = {
    name: 'run-lua-code', filename: 'run-lua-code.mpackage', url: runLuaCodeUrl,
};
/** Mudlet's IRE/`mmp` mapper. Drives the map from `gmcp.Room.Info` with no setup. */
const MUDLET_MAPPER: DefaultPackage = {
    name: 'mudlet-mapper', filename: 'mudlet-mapper.xml', url: mudletMapperUrl,
};
/** Mudlet's fallback mapper: works anywhere, but needs `map basics` configuring.
 *  `version` is declared so bumping the vendored archive reinstalls it into
 *  profiles that already have the old one — safe because the mapper keeps its
 *  state in `<profile>/map downloads/`, outside the package dir a reinstall wipes. */
const GENERIC_MAPPER: DefaultPackage = {
    name: 'generic_mapper', filename: 'generic_mapper.mpackage', url: genericMapperUrl, version: '2.1.11',
};

/** Mudlet's starter interface: an adjustable dock with the map, tabbed chat and
 *  gauges, built only from what the game actually sends (GMCP/MSDP/prompt
 *  scraping) — nothing appears until there's something to show. `baseui hide`
 *  removes it and is remembered, and it stands aside on its own when a game
 *  pushes a GUI via `Client.GUI`. `version` is declared for the same reason the
 *  mapper's is: so a bumped archive reaches profiles that have the old one. */
const BASE_UI: DefaultPackage = {
    name: 'mudlet-base-ui', filename: 'mudlet-base-ui.mpackage', url: baseUiUrl, version: '1.6.1',
};

/** Drop an image file onto a console and it becomes a Geyser label inside an
 *  Adjustable.Container, positioned where it landed; the package then writes a
 *  `GUIDropManager` script node that recreates it on the next profile open.
 *  Inert until something is actually dropped. `version` is declared for the same
 *  reason the mapper's is — and here it also carries the fixed archive to
 *  profiles still holding the versionless loose-XML install. */
const GUI_DROP: DefaultPackage = {
    name: 'gui-drop', filename: 'gui-drop.mpackage', url: guiDropUrl, version: '1.3',
};

/** Mudlet's package manager: `mpkg install/remove/search/show/list/update`
 *  against the official package repository. It downloads the repository catalog
 *  on load (and every 12h) and installs from it through the normal
 *  `installPackage(url)` path, so everything it does runs on APIs we already
 *  have — the one browser wrinkle is its github.com/raw repository url, which
 *  {@link githubRawUrl} redirects for it.
 *
 *  Deliberately declares no `version`: mpkg upgrades *itself* out of the
 *  repository the moment the published version outruns the installed one. A
 *  declared version would make every profile open see the newer self-installed
 *  copy as a mismatch and reinstall the older vendored archive over it, which
 *  mpkg would then upgrade again — a downgrade loop, once per session, forever. */
const MPKG: DefaultPackage = {
    name: 'mpkg', filename: 'mpkg.mpackage', url: mpkgUrl,
};

/**
 * Games that get the IRE mapper instead of the generic one — verbatim from the
 * `mudlet-mapper.xml` row of `defaultScripts` in mudlet.cpp.
 */
export const IRE_MAPPER_GAMES = [
    'aetolia.com', 'achaea.com', 'lusternia.com',
    'imperian.com', 'starmourn.com', 'stickmud.com',
];

/**
 * Games whose own bundled loader installs a full interface, so the starter UI is
 * not preinstalled for them — it would only fight the game's GUI for the same
 * screen space. Mirrors the `providesOwnUi` entries of `TGameDetails.h`'s
 * `scmDefaultGames`, including each game's `alternateHostUrls`.
 */
export const GAMES_WITH_OWN_UI = [
    'carrionfields.net',    // CF-loader installs CFGUI
    'medievia.com',         // MedBootstrap installs MedUI
    'icesus.org',           // icesus-loader installs Icesus' own interface
    // mg-loader installs MorgenGrauen's own interface:
    'mud.morgengrauen.info', 'mg.mud.de', 'mg.morgengrauen.info', 'morgengrauen.info',
];

/** Every bundled default, whatever the host — for tests and tooling. */
export const ALL_DEFAULTS: DefaultPackage[] = [RUN_LUA_CODE, MUDLET_MAPPER, GENERIC_MAPPER, MPKG, GUI_DROP, BASE_UI];

/**
 * The stock defaults for a profile on `host`.
 *
 * Mudlet ships these as Qt resources in `src/mudlet.qrc` and installs them on
 * profile open. We mirror that (and `setupPreInstallPackages`'s per-game
 * choices): each file is bundled as a static asset and installed once per
 * profile via the normal package pipeline, so it appears in the package list and
 * the user can uninstall it if they want.
 *
 * Exactly one mapper, always. `centerview()` is the only thing that moves the
 * map view and only a mapper calls it, so a profile with no mapper never follows
 * the player — and two mappers would both fire on the same movement.
 *
 * The starter UI is the one conditional pick: Mudlet skips it for players who
 * aren't new (`experiencedMudletPlayer()` — any profile folder older than six
 * months) because "veterans will have their own layouts already", and for games
 * whose own loader installs a full interface. mudix has no profile-age signal to
 * mirror the first, so `createdAt` stands in for it — see {@link isNewProfile}.
 */
export function stockDefaults(host?: string, conn?: { createdAt?: string }): DefaultPackage[] {
    const isIreMapperGame = !!host && IRE_MAPPER_GAMES.some(g => g.toLowerCase() === host);
    const packages = [RUN_LUA_CODE, isIreMapperGame ? MUDLET_MAPPER : GENERIC_MAPPER, MPKG, GUI_DROP];
    const gameHasOwnUi = !!host && GAMES_WITH_OWN_UI.some(g => g === host);
    if (isNewProfile(conn) && !gameHasOwnUi) packages.push(BASE_UI);
    return packages;
}

/**
 * Whether a profile is new enough to be offered the starter UI.
 *
 * `addConnection` stamps `createdAt` on every profile it creates, so a profile
 * without one was made before the field existed — i.e. someone has already been
 * using it, quite possibly with a layout of their own. That's mudix's stand-in
 * for Mudlet's "no profile folder older than six months" check: it errs the safe
 * way, since dropping a dock, gauges and a chat window onto an established
 * profile is far more disruptive than withholding them from a new one.
 *
 * No profile at all (tooling, a preview, `stockDefaults()` with no argument)
 * counts as new — nothing established is at risk.
 */
export function isNewProfile(conn?: { createdAt?: string }): boolean {
    return !conn || conn.createdAt !== undefined;
}

/** A default or brand package as the install loop sees it. */
export type InstallablePackage = DefaultPackage & { removable?: boolean };

/**
 * The packages to preinstall into a profile.
 *
 * A brand's list is exact and replaces the stock defaults rather than adding to
 * them — `[]` preinstalls nothing, and a brand shipping its own mapper simply
 * doesn't list ours. Unset means no opinion: the stock defaults for this game.
 */
export function resolveDefaultPackages(
    brandPackages: InstallablePackage[] | undefined,
    host?: string,
    conn?: { createdAt?: string },
): InstallablePackage[] {
    return brandPackages ?? stockDefaults(host, conn);
}

/** Hostname `stockDefaults` matches its game lists against, lowercased. */
export function connectionHost(conn: { mode?: string; host?: string; url?: string } | undefined): string | undefined {
    if (!conn) return undefined;
    // 'mud' mode stores host/port directly; 'websocket' mode only has a URL, so
    // pull the hostname out of it (a malformed URL simply doesn't match).
    if (conn.host) return conn.host.trim().toLowerCase() || undefined;
    if (!conn.url) return undefined;
    try {
        return new URL(conn.url).hostname.toLowerCase() || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Install any default packages the profile doesn't already have. Idempotent:
 * a package is skipped if its manifest name is already in `connectionPackages`
 * — so existing profiles also pick up newly-added defaults on next open.
 *
 * Which packages those are: `brand.packages` when a brand declares one (an
 * exact list — `[]` installs nothing), otherwise `stockDefaults(host)`.
 *
 * Profiles imported or linked from Mudlet are exempt entirely — their own
 * package set is authoritative, so nothing is added (returns `[]`).
 *
 * A default the user explicitly uninstalled stays uninstalled: the store's
 * `uninstallPackage` tombstones the name in the profile's
 * `uninstalledPackages` (Mudlet's `deletedDefaultMuds` equivalent), and this
 * skips tombstoned names — except brand packages marked `removable: false`,
 * which always come back.
 *
 * Failures are logged and swallowed: a broken default must never block the
 * profile from opening.
 *
 * Returns the manifest names that were actually (re)installed this call — a
 * fresh install into a profile that never had the package, or a version-bump
 * reinstall. The caller raises sysInstallPackage for each of these once the
 * runtime has loaded far enough for the package's own handlers to be
 * registered; a package whose scripts gate one-time setup on that event
 * (rather than the every-open sysLoadEvent) needs it fired here, since these
 * installs never go through the normal installPackageFromVfsPath path.
 */
export async function ensureDefaultPackages(connectionId: string, vfs: ProfileVFS): Promise<string[]> {
    const state = useAppStore.getState();
    const conn = state.connections.find(c => c.id === connectionId);
    // A profile imported or linked from Mudlet brings its own package set, which
    // is authoritative: Mudlet only preinstalls the stock defaults into brand-new
    // profiles (setupPreInstallPackages), so their absence here is a deliberate
    // state to preserve, not a gap to backfill. Adding a mapper or run-lua-code
    // the source profile never had would diverge from Mudlet and, for a second
    // mapper, fight the profile's own over centerview(). Install nothing.
    if (conn?.mudletImported || conn?.mudletLinked) return [];
    const installedPackages = state.connectionPackages[connectionId] ?? [];
    const removedByUser = new Set(state.connectionProfile[connectionId]?.uninstalledPackages ?? []);
    // BrandPackage is shape-compatible with DefaultPackage, plus `removable`.
    const host = connectionHost(conn);
    const defaults = resolveDefaultPackages(getBrand().packages, host, conn);
    const installed: string[] = [];
    for (const def of defaults) {
        const current = installedPackages.find(p => p.name === def.name);
        // Installed and current (no declared version, or versions match) —
        // leave it alone. A version mismatch falls through to a clean
        // reinstall: how brands ship package updates to players.
        if (current && (!def.version || current.version === def.version)) continue;
        if (!current && def.removable !== false && removedByUser.has(def.name)) continue;
        try {
            const res = await fetch(def.url);
            if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${def.url}`);
            const buf = new Uint8Array(await res.arrayBuffer());
            const { manifest, data } = installPackageFromBytes(def.filename, buf, vfs);
            useAppStore.getState().installPackage(connectionId, manifest, data);
            installed.push(manifest.name);
        } catch (err) {
            console.warn(`[default-packages] failed to install ${def.name}:`, err);
        }
    }
    if (installed.length) await vfs.flush();
    return installed;
}
