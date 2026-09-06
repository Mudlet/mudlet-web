/**
 * The keyboard-shortcut table in Settings.
 *
 * Rebinding is done by pressing the keys, not by typing their names: a field
 * that wanted "Ctrl+Alt+L" spelled out would accept "control-alt-L" and
 * "Ctrl Alt L" and quietly bind neither. Arming a row swallows the next
 * keypress instead, and the same reader that dispatches the shortcuts turns it
 * into the sequence — so what the row shows afterwards is exactly what will
 * fire.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '../components';
import {
    availableShortcuts, SHORTCUT_GROUPS, defaultShortcut, effectiveShortcut,
    type AppCommandId, type AppShortcutDef, type ShortcutOverrides,
} from '../commands/appShortcuts';
import { canonicalSequence, formatSequence, stepFromEvent } from '../commands/keyMatch';
import './ShortcutEditor.css';

interface Props {
    overrides: ShortcutOverrides | undefined;
    platform: string;
    /** Write one command's binding. An empty string clears it; `undefined`
     *  puts it back to the platform default. */
    onChange: (id: AppCommandId, shortcut: string | undefined) => void;
    /** Put every binding back to its default. */
    onResetAll: () => void;
}

/** Which command already holds `shortcut`, or null when it is free. Compared
 *  canonically, so "Alt+E" does not slip past "alt+e". */
function holderOf(
    shortcut: string,
    ignore: AppCommandId,
    overrides: ShortcutOverrides | undefined,
    platform: string,
): AppShortcutDef | null {
    const wanted = canonicalSequence(shortcut)?.join(',');
    if (!wanted) return null;
    for (const def of availableShortcuts()) {
        if (def.id === ignore) continue;
        const theirs = canonicalSequence(effectiveShortcut(def, overrides, platform))?.join(',');
        if (theirs === wanted) return def;
    }
    return null;
}

export function ShortcutEditor({ overrides, platform, onChange, onResetAll }: Props) {
    /** The row currently listening for a keypress, if any. */
    const [arming, setArming] = useState<AppCommandId | null>(null);
    /** Why the last capture was refused, shown under the row that refused it. */
    const [clash, setClash] = useState<{ id: AppCommandId; message: string } | null>(null);
    const armedRef = useRef<AppCommandId | null>(null);
    armedRef.current = arming;

    useEffect(() => {
        if (!arming) return;
        const onKeyDown = (e: KeyboardEvent) => {
            // Escape clears the binding, which is what Mudlet's own page says
            // it does ("To disable shortcut input 'Esc' key"). Clicking the
            // armed row again is the way out for someone who armed it by
            // accident. Every other key is capture material, including the ones
            // the browser would otherwise act on, which is why this runs in the
            // capture phase and stops the event.
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') {
                const armed = armedRef.current;
                setArming(null);
                setClash(null);
                if (armed) onChange(armed, '');
                return;
            }
            const step = stepFromEvent(e);
            if (step === null) return;    // still holding modifiers down

            const id = armedRef.current;
            if (!id) return;
            const shortcut = formatSequence([step]);
            const held = holderOf(shortcut, id, overrides, platform);
            if (held) {
                setClash({ id, message: `${shortcut} is already ${held.label}.` });
                return;
            }
            setClash(null);
            setArming(null);
            onChange(id, shortcut);
        };
        // On `window`, not `document`. The capture path runs window first, and
        // the shortcut dispatcher listens on document — so this stopPropagation
        // is what keeps an armed row from also *running* the command it is
        // trying to rebind. Pressing Alt+E to move the script editor's key
        // would otherwise open the script editor over the dialog.
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [arming, overrides, platform, onChange]);

    // Only the commands this build exposes: a brand that hid the script editor
    // must not be offered a key for it here, or the shortcut becomes a way back
    // into something it deliberately removed. A group that empties out that way
    // is not drawn at all.
    const rows = availableShortcuts();
    const groups = SHORTCUT_GROUPS.filter(g => rows.some(def => def.group === g));

    return (
        <div className="shortcut-editor">
            {groups.map(group => (
                <div className="shortcut-group" key={group}>
                    <div className="shortcut-group__title">{group}</div>
                    {rows.filter(def => def.group === group).map(def => {
                        const current = effectiveShortcut(def, overrides, platform);
                        const isDefault = current === defaultShortcut(def, platform);
                        const steps = canonicalSequence(current);
                        return (
                            <div className="shortcut-row" key={def.id}>
                                <span className="shortcut-row__label">{def.label}</span>
                                <button
                                    type="button"
                                    className={`shortcut-row__key${arming === def.id ? ' shortcut-row__key--arming' : ''}`}
                                    aria-label={`Shortcut for ${def.label}`}
                                    onClick={() => { setClash(null); setArming(id => (id === def.id ? null : def.id)); }}
                                >
                                    {arming === def.id
                                        ? 'Press a key…'
                                        : steps ? formatSequence(steps) : <span className="shortcut-row__none">Not set</span>}
                                </button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    title="Clear this shortcut"
                                    disabled={current === ''}
                                    onClick={() => { setClash(null); setArming(null); onChange(def.id, ''); }}
                                >
                                    Clear
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    title="Back to the default"
                                    disabled={isDefault}
                                    onClick={() => { setClash(null); setArming(null); onChange(def.id, undefined); }}
                                >
                                    Reset
                                </Button>
                                {clash?.id === def.id && (
                                    <div className="shortcut-row__clash" role="alert">{clash.message}</div>
                                )}
                            </div>
                        );
                    })}
                </div>
            ))}
            <div className="shortcut-editor__footer">
                <Button variant="ghost" size="sm" onClick={() => { setArming(null); setClash(null); onResetAll(); }}>
                    Reset all shortcuts
                </Button>
            </div>
        </div>
    );
}
