import type { BindingContext } from './context';

/**
 * Enable/disable/exists/kill for the six automation node types (scripts,
 * triggers, aliases, timers, keys, buttons), plus the perm* constructors that
 * create them from Lua and the toolbar/button state accessors.
 *  
 * Every one of these is a thin forward into ScriptingAPI, which in turn routes
 * through the engine callbacks so mutations land in the appStore tree.
 */
export function installAutomationBindings({ lua, api }: BindingContext): void {
    // ── Script enable/disable ─────────────────────────────────────────────
    // Mudlet looks scripts up by name; toggling the flag cascades the
    // store subscription which loads/unloads Lua handlers synchronously.
    // Mudlet `enableScript(name)` / `disableScript(name)`. A missing name is a
    // caller bug and raises (in the Bridge.lua wrapper), but a name that simply
    // matches nothing answers (nil, message) — Other_spec pins that split, and
    // it lets a script probe for an optional package without pcall.
    lua.global.set('__enableScript', (name: unknown) => api.enableScript(String(name ?? '')));
    lua.global.set('__disableScript', (name: unknown) => api.disableScript(String(name ?? '')));
    // Rollback hook for permScript: a body that raises as it is compiled in
    // must leave nothing behind, and Mudlet deletes the half-built TScript for
    // exactly that reason. Takes the numeric id permScript just returned so it
    // can only ever remove the one it created, never a same-named sibling.
    lua.global.set('__mudix_removeScriptById', (id: unknown) => api.removeScriptById(Number(id)));
    // Mudlet permScript(name, parent, luaCode) — creates a persisted script
    // under an existing script group (parent="" → root). Returns the new
    // script's id (UUID string) or -1 on failure. The Bridge.lua wrapper
    // coerces nil args before calling.
    lua.global.set('__mudix_permScript', (name: unknown, parent: unknown, code: unknown) =>
        api.permScript(String(name ?? ''), String(parent ?? ''), String(code ?? '')));
    // Mudlet permRegexTrigger(name, parent, regexes, luaCode). The Bridge.lua
    // wrapper flattens the regex table to a \x01-delimited string (wasmoon's
    // JS proxy for Lua tables doesn't iterate reliably from JS); we split it
    // back here. An empty regexes string means "create a group".
    lua.global.set('__mudix_permRegexTrigger', (name: unknown, parent: unknown, regexesStr: unknown, code: unknown) => {
        const s = String(regexesStr ?? '');
        const regexes = s.length === 0 ? [] : s.split('\x01');
        return api.permRegexTrigger(String(name ?? ''), String(parent ?? ''), regexes, String(code ?? ''));
    });
    // Mudlet permSubstringTrigger(name, parent, patterns, luaCode). Same
    // flatten/split convention as permRegexTrigger — Bridge.lua hands a
    // \x01-delimited string and we split it back here.
    lua.global.set('__mudix_permSubstringTrigger', (name: unknown, parent: unknown, patternsStr: unknown, code: unknown) => {
        const s = String(patternsStr ?? '');
        const patterns = s.length === 0 ? [] : s.split('\x01');
        return api.permSubstringTrigger(String(name ?? ''), String(parent ?? ''), patterns, String(code ?? ''));
    });
    // Mudlet permBeginOfLineStringTrigger(name, parent, patterns, luaCode).
    // Same flatten/split convention as permSubstringTrigger; each pattern
    // matches only at the start of the line. Empty patterns → trigger group.
    lua.global.set('__mudix_permBeginOfLineStringTrigger', (name: unknown, parent: unknown, patternsStr: unknown, code: unknown) => {
        const s = String(patternsStr ?? '');
        const patterns = s.length === 0 ? [] : s.split('\x01');
        return api.permBeginOfLineStringTrigger(String(name ?? ''), String(parent ?? ''), patterns, String(code ?? ''));
    });
    // Mudlet permExactMatchTrigger(name, parent, patterns, luaCode). Same
    // flatten/split convention as permSubstringTrigger; each pattern matches
    // only on full-line equality. Empty patterns → trigger group.
    lua.global.set('__mudix_permExactMatchTrigger', (name: unknown, parent: unknown, patternsStr: unknown, code: unknown) => {
        const s = String(patternsStr ?? '');
        const patterns = s.length === 0 ? [] : s.split('\x01');
        return api.permExactMatchTrigger(String(name ?? ''), String(parent ?? ''), patterns, String(code ?? ''));
    });
    // Mudlet permPromptTrigger(name, parent, luaCode). Persistent trigger
    // that fires on every server prompt line (GA/EOR); no text pattern.
    lua.global.set('__mudix_permPromptTrigger', (name: unknown, parent: unknown, code: unknown) =>
        api.permPromptTrigger(String(name ?? ''), String(parent ?? ''), String(code ?? '')));
    // Mudlet permAlias(name, parent, regex, luaCode). Pattern is a single
    // PCRE string (Mudlet's TAlias.mRegexCode). Returns the new id or -1.
    lua.global.set('__mudix_permAlias', (name: unknown, parent: unknown, pattern: unknown, code: unknown) =>
        api.permAlias(String(name ?? ''), String(parent ?? ''), String(pattern ?? ''), String(code ?? '')));
    // Mudlet permTimer(name, parent, seconds, luaCode). One-shot timer
    // creation; the persistent-timer scheduler picks it up via the
    // store-subscription pipeline.
    lua.global.set('__mudix_permTimer', (name: unknown, parent: unknown, delay: unknown, code: unknown) =>
        api.permTimer(String(name ?? ''), String(parent ?? ''), Number(delay) || 0, String(code ?? '')));
    // Mudlet permKey(name, parent, modifier, key, luaCode). modifier is the
    // Qt::KeyboardModifier int; -1 means "no modifier" (group form). key is
    // either a Qt::Key int or a string keycode — the JS side translates.
    lua.global.set('__mudix_permKey', (name: unknown, parent: unknown, mod: unknown, key: unknown, code: unknown) => {
        // A Qt::Key int must stay a NUMBER: stringifying it here made it look
        // like a DOM code, so "F9" was stored as the literal "16777272" and
        // getKeyCode could never map it back.
        const k = typeof key === 'number' ? key : String(key ?? '');
        return api.permKey(
            String(name ?? ''),
            String(parent ?? ''),
            Number.isFinite(mod as number) ? Number(mod) : -1,
            k,
            String(code ?? ''),
        );
    });
    // Mudlet button/toolbar APIs operate on the persistent ButtonNode tree.
    // tempButton / tempButtonToolbar create transient entries; setButtonState
    // / getButtonState / setButtonStyleSheet / showToolBar / hideToolBar
    // mutate or read existing entries by name.
    lua.global.set('__mudix_tempButton', (toolbar: unknown, name: unknown, code: unknown, orientation?: unknown) =>
        api.tempButton(
            String(toolbar ?? ''),
            String(name ?? ''),
            String(code ?? ''),
            Number(orientation) || 0,
        ));
    lua.global.set('__mudix_tempButtonToolbar', (name: unknown, orientation?: unknown, location?: unknown) =>
        api.tempButtonToolbar(
            String(name ?? ''),
            Number(orientation) || 0,
            Number(location) || 0,
        ));
    lua.global.set('setButtonState', (name: unknown, state: unknown) =>
        api.setButtonState(String(name ?? ''), !!state));
    lua.global.set('getButtonState', (name: unknown) =>
        api.getButtonState(String(name ?? '')));
    lua.global.set('setButtonStyleSheet', (name: unknown, css: unknown) =>
        api.setButtonStyleSheet(String(name ?? ''), String(css ?? '')));
    lua.global.set('showToolBar', (name: unknown) =>
        api.setToolBarVisibility(String(name ?? ''), true));
    lua.global.set('hideToolBar', (name: unknown) =>
        api.setToolBarVisibility(String(name ?? ''), false));
    // Mudlet setScript(name, luaCode[, pos]) — replace the source of an
    // existing script. pos is 1-indexed; missing/non-numeric falls back to
    // 1. Returns true or -1.
    lua.global.set('setScript', (name: unknown, code: unknown, pos?: unknown) => {
        const n = typeof pos === 'number' && Number.isFinite(pos) ? pos : 1;
        return api.setScript(String(name ?? ''), String(code ?? ''), n);
    });
    // Mudlet getScript(name [, pos]) → code, count. JS returns {code,count}
    // or null; the Bridge.lua wrapper unpacks it to the two return values.
    lua.global.set('__getScript', (name: unknown, pos?: unknown) => {
        const n = typeof pos === 'number' && Number.isFinite(pos) ? pos : 1;
        return api.getScript(String(name ?? ''), n);
    });
    // A numeric argument targets a script-created temp trigger/alias by id.
    const itemTarget = (v: unknown): string | number =>
        (typeof v === 'number' ? v : String(v ?? ''));
    lua.global.set('enableTrigger', (name: unknown) => api.enableTrigger(itemTarget(name)));
    lua.global.set('disableTrigger', (name: unknown) => api.disableTrigger(itemTarget(name)));
    // Mudlet setTriggerStayOpen(name, lines). Keeps every trigger sharing
    // the name open for `lines` more lines this run only (transient chain
    // state, not the persisted fireLength); pass 0 to close after this line.
    lua.global.set('setTriggerStayOpen', (name: unknown, lines: unknown) =>
        api.setTriggerStayOpen(String(name ?? ''), Number(lines)));
    lua.global.set('enableTimer', (name: string) => api.enableTimer(String(name ?? '')));
    lua.global.set('disableTimer', (name: string) => api.disableTimer(String(name ?? '')));
    lua.global.set('enableAlias', (name: unknown) => api.enableAlias(itemTarget(name)));
    lua.global.set('disableAlias', (name: unknown) => api.disableAlias(itemTarget(name)));
    // A numeric argument targets a script-created temp key by id.
    const keyTarget = (v: unknown): string | number =>
        (typeof v === 'number' ? v : String(v ?? ''));
    lua.global.set('enableKey', (name: unknown) => api.enableKey(keyTarget(name)));
    lua.global.set('disableKey', (name: unknown) => api.disableKey(keyTarget(name)));

    // Mudlet `exists(nameOrId, type)`. With a string, returns the count of
    // items matching the name; with a number, returns 1 if a perm item
    // with that monotonic id lives in the named collection (else 0).
    // Type strings: "alias", "trigger", "timer", "key"/"keybind",
    // "button", "script". Unknown types return 0.
    lua.global.set('exists', (nameOrId: unknown, type: unknown) => {
        const key = typeof nameOrId === 'number'
            ? nameOrId
            : String(nameOrId ?? '');
        return api.exists(key, String(type ?? ''));
    });

    // Mudlet isActive(name|id, type [, checkAncestors]) → count of active
    // items matching the name (1/0 for an id). A number is treated as an id,
    // a string as a name (same convention as `exists`). With checkAncestors
    // every ancestor group must also be enabled for an item to count.
    lua.global.set('isActive', (nameOrId: unknown, type: unknown, checkAncestors?: unknown) => {
        const key = typeof nameOrId === 'number'
            ? nameOrId
            : String(nameOrId ?? '');
        return api.isActive(key, String(type ?? ''), !!checkAncestors);
    });

    // Mudlet tree-walkers. JS returns 0-indexed arrays / nested objects /
    // null-on-miss; Bridge.lua re-indexes to 1-based, rebuilds the nested
    // getProfileStats table, and shapes the misses as (false, errMsg).
    lua.global.set('__ancestors', (id: unknown, type: unknown) =>
        api.ancestors(Number(id), String(type ?? '')) ?? false);
    lua.global.set('__findItems', (name: unknown, type: unknown, exact?: unknown, cs?: unknown) =>
        api.findItems(String(name ?? ''), String(type ?? ''), exact !== false, cs !== false));
    // Backs the "invalid item type" refusals the tree-walking APIs share, so
    // each doesn't have to keep its own copy of the family list.
    lua.global.set('__isKnownItemType', (type: unknown) => api.isKnownItemType(String(type ?? '')));
    lua.global.set('__isAncestorsActive', (id: unknown, type: unknown) => {
        const r = api.isAncestorsActive(Number(id), String(type ?? ''));
        return r === null ? null : r;
    });
    lua.global.set('__getProfileStats', () => api.getProfileStats());
}

