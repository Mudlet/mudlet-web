import type { BindingContext } from './context';

/**
 * Mudlet package and module management: install/uninstall, the module sync and
 * priority accessors, and the manifest info getters/setters.
 *  
 * Modules differ from packages by being backed by a file on disk that can be
 * synced back; the requireModule helper below centralises the 'does this module
 * exist' guard the Mudlet API applies before every module operation.
 */
export function installPackageBindings({ lua, api }: BindingContext): void {
    // ── Packages ──────────────────────────────────────────────────────────
    // Mudlet's installPackage takes a filesystem path; an override in
    // Other.lua wraps this to also accept http(s):// URLs by routing
    // through downloadFile + sysDownloadDone. Our impl reads the path
    // from the profile VFS, commits the parsed nodes to the store, and
    // raises sysInstall(Package). Returns { ok, error }; the Bridge.lua
    // wrapper reshapes it into Mudlet's (ok, errorMessage) multi-return
    // (wasmoon JS calls can only push one Lua value).
    lua.global.set('__installPackage', (path: string) => api.installPackage(String(path ?? '')));
    // Mudlet `uninstallPackage(name)` → true on success, nil when no package
    // with that name is installed.
    lua.global.set('uninstallPackage', (name: string) => {
        return api.uninstallPackage(String(name ?? '')) ? true : null;
    });
    // Mudlet getPackages() — list of installed package names. JS arrays land
    // in Lua 0-indexed via wasmoon, so a Bridge.lua wrapper rebuilds it to a
    // 1-indexed sequence.
    lua.global.set('__getPackages', () => api.getPackages());

    // ── Modules ───────────────────────────────────────────────────────────
    // Mudlet's module APIs are the package APIs' siblings: installModule
    // takes a VFS path, modules persist their XML on disk, and uninstall
    // unlinks rather than deleting source files. Negative priorities load
    // before profile scripts; non-negative load after.
    //
    // Mudlet `installModule(path)` → (true) on success, (false, errorMessage)
    // on failure. Returns { ok, error }; the Bridge.lua wrapper reshapes it
    // into the documented multi-return.
    lua.global.set('__installModule', (path: unknown) =>
        api.installModule(String(path ?? '')));
    lua.global.set('uninstallModule', (name: unknown) =>
        api.uninstallModule(String(name ?? '')));
    // Mudlet `reloadModule(name)` doesn't return anything; we still flag
    // failures via the printError call inside ScriptingEngine.
    lua.global.set('reloadModule', (name: unknown) => {
        api.reloadModule(String(name ?? ''));
    });
    lua.global.set('__mudix_syncModule', (name: unknown) => {
        // Fire-and-forget; Lua callers don't get a promise. The underlying
        // flush is async but the in-app effect (sysSyncOnModule) will fire
        // on success.
        void api.syncModule(String(name ?? '')).catch(() => {});
    });
    // Mudlet `enableModuleSync(name)` / `disableModuleSync(name)` → true on
    // success, (nil, errMsg) when the name isn't an installed module.
    //
    // Reported, not raised. These all route through Host::changeModuleSync,
    // whose refusal reaches Lua via warnArgumentValue — so an unknown module is
    // a value the caller can branch on, not an error that unwinds the script.
    // Raising instead (as this used to) meant a script asking about a module the
    // user had not installed died on the spot; the two messages are Mudlet's own,
    // and callers do read them.
    //
    // Returned as a JS Error for the Bridge.lua wrapper to shape, since a JS
    // binding cannot itself return Lua's (nil, msg) pair — see moduleDenial.
    const moduleDenial = (name: string): string | null => {
        if (name === '') return 'module name cannot be an empty string';
        if (!api.getModuleInfo(name)) return `module name '${name}' not found`;
        return null;
    };
    lua.global.set('__enableModuleSync', (name: unknown) => {
        const n = String(name ?? '');
        return moduleDenial(n) ?? (api.enableModuleSync(n), null);
    });
    lua.global.set('__disableModuleSync', (name: unknown) => {
        const n = String(name ?? '');
        return moduleDenial(n) ?? (api.disableModuleSync(n), null);
    });
    lua.global.set('__getModuleSyncDenial', (name: unknown) => moduleDenial(String(name ?? '')));
    lua.global.set('__getModuleSyncValue', (name: unknown) => api.getModuleSync(String(name ?? '')));
    lua.global.set('__setModulePriority', (name: unknown, priority: unknown) => {
        const n = String(name ?? '');
        const denial = moduleDenial(n);
        if (denial) return denial;
        const p = Math.trunc(Number(priority ?? 0));
        api.setModulePriority(n, Number.isFinite(p) ? p : 0);
        return null;
    });
    // getModulePriority reports an unknown module as a VALUE failure
    // (warnArgumentValue) rather than raising, unlike its setter; the null is
    // shaped into (nil, "module doesn't exist") by Bridge.lua.
    lua.global.set('__getModulePriority', (name: unknown) => {
        const n = String(name ?? '');
        return api.getModuleInfo(n) ? api.getModulePriority(n) : null;
    });
    lua.global.set('__getModules', () => api.getModules());
    // Mudlet getModuleInfo(name [, key]). The Bridge.lua wrapper handles the
    // optional `key` projection; here we just return the manifest table or
    // `nil` when no module by that name exists.
    lua.global.set('__getModuleInfo', (name: unknown) =>
        api.getModuleInfo(String(name ?? '')));
    // Mudlet setModuleInfo(name, key, value) → stores a custom info field.
    lua.global.set('setModuleInfo', (name: unknown, key: unknown, value: unknown) =>
        api.setModuleInfo(String(name ?? ''), String(key ?? ''), String(value ?? '')));
    // Mudlet getPackageInfo(name [, key]). The Bridge.lua wrapper handles the
    // optional `key` projection; here we return the merged info table.
    lua.global.set('__getPackageInfo', (name: unknown) =>
        api.getPackageInfo(String(name ?? '')));
    // Mudlet setPackageInfo(name, key, value) → stores a custom info field.
    lua.global.set('setPackageInfo', (name: unknown, key: unknown, value: unknown) =>
        api.setPackageInfo(String(name ?? ''), String(key ?? ''), String(value ?? '')));
    // Mudlet getModulePath(name) → absolute VFS path of the module's XML, or
    // nil. Like getModuleInfo, returns nil gracefully for an unknown module
    // (no requireModule raise) so probing scripts don't error.
    lua.global.set('__getModulePath', (name: unknown) =>
        api.getModulePath(String(name ?? '')) ?? null);
}

