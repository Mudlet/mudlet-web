import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { CommandLineManager, CmdLineState } from './CommandLineManager';
import { cmdLineQssToScopedCss, cssEscape } from '../labels/qtCss';
import { useCmdLineSelection } from './useCmdLineSelection';
import { useSubCommandLineKeys } from './useSubCommandLineKeys';
import './CommandLineOverlay.css';

interface CommandLineOverlayProps {
    manager: CommandLineManager;
    parent: string;
}

export function CommandLineOverlay({ manager, parent }: CommandLineOverlayProps) {
    const [cmdLines, setCmdLines] = useState<CmdLineState[]>(() => manager.list(parent));
    useEffect(() => manager.subscribe(parent, setCmdLines), [manager, parent]);
    // Each cmd line's own z-index (below) is shared with this parent's
    // nested windows / labels / scroll boxes (see overlayLayerOrder.ts)
    // instead of the whole wrapper carrying one block z-index, so
    // raiseWindow/lowerWindow on any of them can genuinely interleave
    // per-widget, matching Mudlet's single Qt widget stack.
    const [, setLayerTick] = useState(0);
    useEffect(() => manager.overlayZ.subscribe(parent, () => setLayerTick(t => t + 1)), [manager, parent]);
    if (cmdLines.length === 0) return null;
    return (
        <div className="cmdline-overlay">
            {cmdLines.map(c => (
                <CommandLine key={c.name} c={c} manager={manager} zIndex={manager.overlayZ.getZ(parent, 'cmdlines', c.name)} />
            ))}
        </div>
    );
}

function CommandLine({ c, manager, zIndex }: { c: CmdLineState; manager: CommandLineManager; zIndex: number }) {
    const [value, setValue] = useState(c.value);
    const valueRef = useRef(value);
    valueRef.current = value;
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const lastSeedSeq = useRef<number>(c.valueSeq);
    const requestSelection = useCmdLineSelection(inputRef, value);
    /** The seed a selectCmdLineText arrived after, while that seed was still
     *  on its way here — see the control below. */
    const selectAfterSeed = useRef<number | null>(null);

    // Apply script-pushed seeds (printCmdLine / clearCmdLine / appendCmdLine).
    // The caret goes to the end, unless a selectCmdLineText came after this
    // very seed, in which case it is all selected once the text is in.
    useEffect(() => {
        if (c.valueSeq === lastSeedSeq.current) return;
        lastSeedSeq.current = c.valueSeq;
        setValue(c.value);
        requestSelection(selectAfterSeed.current === c.valueSeq ? 'all' : 'end', false);
        selectAfterSeed.current = null;
    }, [c.valueSeq, c.value, requestSelection]);

    // Probe for getCmdLine([name]) — reads live typed text.
    useEffect(() => {
        return manager.registerValueProbe(c.name, () => valueRef.current);
    }, [c.name, manager]);

    // Imperative control — selectCmdLineText highlights the input contents.
    // A printCmdLine just before it has not reached the input yet (its seed is
    // applied on a later render), and selecting now would be undone when it
    // does — so the selection waits for that seed (issue #284).
    useEffect(() => {
        return manager.registerControl(c.name, {
            selectAll: () => {
                const seq = manager.get(c.name)?.valueSeq;
                if (seq !== undefined && seq !== lastSeedSeq.current) selectAfterSeed.current = seq;
                else requestSelection('all', false);
            },
        });
    }, [c.name, manager, requestSelection]);

    // History, Tab completion, Shift+Enter, Escape and what Enter leaves
    // behind, as on every desktop TCommandLine (#342).
    const { onKeyDown, onChange } = useSubCommandLineKeys({
        model: manager.model(c.name),
        host: () => manager.cmdLineHost,
        inputRef,
        valueRef,
        setValue,
        dispatch: command => { manager.submit(c.name, command); },
        takeScripted: () => {
            const now = manager.get(c.name);
            if (!now || now.valueSeq === lastSeedSeq.current) return null;
            lastSeedSeq.current = now.valueSeq;
            selectAfterSeed.current = null;
            return now.value;
        },
    });

    if (!c.visible) return null;

    const scope = `textarea[data-mudlet-cmdline-overlay="${cssEscape(c.name)}"]`;
    const scopedCss = c.styleSheet ? cmdLineQssToScopedCss(c.styleSheet, scope) : '';

    const style: React.CSSProperties = {
        left: c.x, top: c.y, width: c.width, height: c.height,
        zIndex,
    };

    return (
        <>
            {scopedCss && <style>{scopedCss}</style>}
            <textarea
                ref={inputRef}
                data-mudlet-cmdline-overlay={c.name}
                className="cmdline-overlay-input"
                style={style}
                rows={1}
                value={value}
                disabled={!c.enabled}
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
