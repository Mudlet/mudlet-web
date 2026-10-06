import { useEffect, useRef, useState } from 'react';
import type { WindowManager } from '../WindowManager';
import { cmdLineQssToScopedCss, cssEscape } from '../../labels/qtCss';
import { useSubCommandLineKeys } from '../../cmdline/useSubCommandLineKeys';
import { SubCommandLine } from '../../cmdline/subCommandLine';

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
 * callback is bound, the text is sent to the game as typed input, the way
 * Mudlet's TCommandLine::enterCommand falls back to Host::send. History, Tab
 * completion, Shift+Enter, Escape and what Enter leaves behind follow desktop's
 * TCommandLine (see useSubCommandLineKeys).
 */
export function WindowCmdLine({ id, manager, styleSheet, seedValue, seedSeq }: WindowCmdLineProps) {
    const [value, setValue] = useState(seedValue ?? '');
    const valueRef = useRef(value);
    valueRef.current = value;
    const inputRef = useRef<HTMLTextAreaElement>(null);
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

    // Only a window enableCommandLine gave a line renders this, so the model
    // is there; the fallback covers a render racing a deleteCommandLine.
    const fallbackModel = useRef<SubCommandLine | null>(null);
    const model = manager.cmdLineModel(id) ?? (fallbackModel.current ??= new SubCommandLine(id));
    const { onKeyDown, onChange } = useSubCommandLineKeys({
        model,
        host: () => manager.cmdLineHost,
        inputRef,
        valueRef,
        setValue,
        dispatch: command => { manager.submitCmdLine(id, command); },
        takeScripted: () => {
            const seed = manager.cmdLineSeed(id);
            if (!seed || seed.seq === (lastSeedSeq.current ?? 0)) return null;
            lastSeedSeq.current = seed.seq;
            return seed.value;
        },
    });

    const scope = `textarea[data-mudlet-cmdline="${cssEscape(id)}"]`;
    const scopedCss = styleSheet ? cmdLineQssToScopedCss(styleSheet, scope) : '';

    return (
        <>
            {scopedCss && <style>{scopedCss}</style>}
            <textarea
                ref={inputRef}
                data-mudlet-cmdline={id}
                className="window-cmdline"
                rows={1}
                value={value}
                onChange={onChange}
                onKeyDown={onKeyDown}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
            />
        </>
    );
}
