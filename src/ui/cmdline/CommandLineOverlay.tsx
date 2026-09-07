import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { CommandLineManager, CmdLineState } from './CommandLineManager';
import { cmdLineQssToScopedCss, cssEscape } from '../labels/qtCss';
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
    const inputRef = useRef<HTMLInputElement>(null);
    const lastSeedSeq = useRef<number>(c.valueSeq);

    // Apply script-pushed seeds (printCmdLine / clearCmdLine / appendCmdLine).
    useEffect(() => {
        if (c.valueSeq === lastSeedSeq.current) return;
        lastSeedSeq.current = c.valueSeq;
        setValue(c.value);
        requestAnimationFrame(() => {
            const el = inputRef.current;
            if (el && document.activeElement === el) {
                el.setSelectionRange(c.value.length, c.value.length);
            }
        });
    }, [c.valueSeq, c.value]);

    // Probe for getCmdLine([name]) — reads live typed text.
    useEffect(() => {
        return manager.registerValueProbe(c.name, () => valueRef.current);
    }, [c.name, manager]);

    // Imperative control — selectCmdLineText highlights the input contents.
    useEffect(() => {
        return manager.registerControl(c.name, {
            selectAll: () => inputRef.current?.select(),
        });
    }, [c.name, manager]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const text = valueRef.current;
        const cb = manager.getAction(c.name);
        if (cb) {
            try { cb(text); } catch (err) { console.warn(`[CommandLine ${c.name}] action threw:`, err); }
            // Match WindowCmdLine: clear after Enter when an action is bound.
            setValue('');
        }
    };

    if (!c.visible) return null;

    const scope = `input[data-mudlet-cmdline-overlay="${cssEscape(c.name)}"]`;
    const scopedCss = c.styleSheet ? cmdLineQssToScopedCss(c.styleSheet, scope) : '';

    const style: React.CSSProperties = {
        left: c.x, top: c.y, width: c.width, height: c.height,
        zIndex,
    };

    return (
        <>
            {scopedCss && <style>{scopedCss}</style>}
            <input
                ref={inputRef}
                data-mudlet-cmdline-overlay={c.name}
                className="cmdline-overlay-input"
                style={style}
                value={value}
                disabled={!c.enabled}
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
