/**
 * Render a caught value for a user-facing error line.
 *
 * `String(err)` is the usual shorthand, but it collapses every non-`Error`
 * object to the literal text "[object Object]" — which is exactly what the
 * script error log showed for errors that never went through Lua's own
 * `error()`. Those come from a JS exception escaping the wasm boundary: the
 * metamethod trampolines wasmoon installs for JS objects (`__index`,
 * `__newindex`, `__tostring`) don't wrap the call, so a throw inside a getter
 * unwinds straight past Lua into whoever called `resume`. Nothing rewrites it
 * into a Lua error string on the way, so the value arrives raw — and a raw
 * plain object rendered with `String` says nothing at all.
 *
 * Errors keep rendering as their bare `message` (unchanged); everything else is
 * described by what it actually is.
 *
 * Pass `label` (the entity or event the failure is attributed to) to also
 * record the live value in devtools when it is opaque — such a value carries no
 * stack of its own, so the object itself is the only handle on where it came
 * from.
 */
export function describeThrown(err: unknown, label?: string): string {
    if (err instanceof Error) return err.message || err.name;
    if (typeof err === 'string') return err;
    if (err === null) return 'null';
    if (err === undefined) return 'undefined';
    if (typeof err !== 'object') return String(err);

    if (label !== undefined) {
        console.error(`[mudix] non-Error value thrown out of ${label}:`, err);
    }

    const ctor = (err as { constructor?: { name?: string } }).constructor?.name;
    const tag = ctor && ctor !== 'Object' ? `${ctor} ` : '';
    try {
        const json = JSON.stringify(err);
        // "{}" means every own property was non-enumerable or unserialisable
        // (DOM objects, most host classes) — the key list is more use there.
        if (json !== undefined && json !== '{}') return tag + json;
    } catch {
        // cyclic, or a toJSON that throws
    }
    const keys = Object.keys(err as object);
    if (keys.length > 0) return `${tag}{${keys.join(', ')}}`;
    return tag !== '' ? tag.trim() : Object.prototype.toString.call(err);
}
