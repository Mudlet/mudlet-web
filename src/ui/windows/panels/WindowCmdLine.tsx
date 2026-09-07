import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { WindowManager } from '../WindowManager';
import { cmdLineQssToScopedCss, cssEscape } from '../../labels/qtCss';

interface WindowCmdLineProps {
    id: string;
    manager: WindowManager;
    styleSheet?: string;
    /** Latest script-pushed value (clearCmdLine, printCmdLine, appendCmdLine).
     *  Applied to the input one-shot whenever `seedSeq` changes. */
    seedValue?: string;
    seedSeq?: number;
}

/**
 * Per-userwindow command line `<input>`. Backs Mudlet's enableCommandLine /
 * setCmdLineAction / setCmdLineStyleSheet on a userwindow. The component owns
 * the typed value as React state (so script-side seeds via printCmdLine /
 * clearCmdLine can drive it through the seedSeq bump) and registers a probe
 * with WindowManager so getCmdLine([name]) can read the live text.
 *
 * Enter dispatches to the bound Lua callback (setCmdLineAction). When no
 * callback is bound, Enter is a no-op — userwindow command lines don't
 * automatically send to the MUD the way the main command bar does.
 */
export function WindowCmdLine({ id, manager, styleSheet, seedValue, seedSeq }: WindowCmdLineProps) {
    const [value, setValue] = useState(seedValue ?? '');
    const valueRef = useRef(value);
    valueRef.current = value;
    const inputRef = useRef<HTMLInputElement>(null);
    const lastSeedSeq = useRef<number | undefined>(seedSeq);

    // Apply script-pushed seeds (printCmdLine / clearCmdLine / appendCmdLine).
    // We trigger only on seq changes so a user typing the same characters
    // a script just wrote isn't bulldozed back.
    useEffect(() => {
        if (seedSeq === lastSeedSeq.current) return;
        lastSeedSeq.current = seedSeq;
        const next = seedValue ?? '';
        setValue(next);
        // Move caret to end after the input commits.
        requestAnimationFrame(() => {
            const el = inputRef.current;
            if (el && document.activeElement === el) {
                el.setSelectionRange(next.length, next.length);
            }
        });
    }, [seedSeq, seedValue]);

    // Probe so ScriptingAPI.getCmdLine(windowName) reports the live value.
    useEffect(() => {
        return manager.registerCmdLineValueProbe(id, () => valueRef.current);
    }, [id, manager]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const text = valueRef.current;
        const cb = manager.getCmdLineAction(id);
        if (cb) {
            try { cb(text); } catch (err) { console.warn(`[WindowCmdLine ${id}] action threw:`, err); }
            // Mudlet auto-clears a userwindow command line after Enter when an
            // action is bound (mirrors TCommandLine::handleEnter for sub-cmd
            // lines). Without this, scripts written for Mudlet that don't
            // explicitly clearCmdLine would leave the prior text in the input.
            setValue('');
        }
    };

    const scope = `input[data-mudlet-cmdline="${cssEscape(id)}"]`;
    const scopedCss = styleSheet ? cmdLineQssToScopedCss(styleSheet, scope) : '';

    return (
        <>
            {scopedCss && <style>{scopedCss}</style>}
            <input
                ref={inputRef}
                data-mudlet-cmdline={id}
                className="window-cmdline"
                value={value}
                onChange={e => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
            />
        </>
    );
}
