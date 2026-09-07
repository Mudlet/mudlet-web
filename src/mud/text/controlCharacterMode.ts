/**
 * The active profile's `controlCharacterHandling` display mode (Mudlet
 * `setConfig`/`getConfig`: `"asis"` / `"oem"` / `"picture"`). Mirrors Mudlet's
 * `Host::mControlCharacter` — a single per-profile value read at paint time by
 * every console/mini-console/text window. Mudlet Web renders exactly one active
 * connection's output at a time, so a module-level value (kept in sync by
 * `MudSession.setControlCharacterMode`) covers the main output, script
 * windows, and logging/copy paths without threading a parameter through all
 * of them.
 */
export type ControlCharacterMode = 'asis' | 'oem' | 'picture';

let currentMode: ControlCharacterMode = 'asis';

export function getControlCharacterMode(): ControlCharacterMode {
    return currentMode;
}

export function setControlCharacterMode(mode: ControlCharacterMode): void {
    currentMode = mode;
}
