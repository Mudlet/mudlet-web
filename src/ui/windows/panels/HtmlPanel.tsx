import { useEffect, useRef } from 'react';
import type React from 'react';
import type { WindowManager } from '../WindowManager';
import type { LabelManager } from '../../labels/LabelManager';
import type { CommandLineManager } from '../../cmdline/CommandLineManager';
import type { ScrollBoxManager } from '../../scrollbox/ScrollBoxManager';
import { LabelOverlay } from '../../labels/LabelOverlay';
import { CommandLineOverlay } from '../../cmdline/CommandLineOverlay';
import { ScrollBoxOverlay } from '../../scrollbox/ScrollBoxOverlay';
import { backgroundImageStyle } from '../../output/backgroundImageStyle';
import { WindowCmdLine } from './WindowCmdLine';

interface HtmlPanelProps {
    id: string;
    manager: WindowManager;
    labels?: LabelManager;
    cmdLines?: CommandLineManager;
    scrollBoxes?: ScrollBoxManager;
    backgroundColor?: { r: number; g: number; b: number; a: number };
    backgroundImage?: { url: string; mode: number };
    cmdLineEnabled?: boolean;
    cmdLineStyleSheet?: string;
    cmdLineValue?: string;
    cmdLineValueSeq?: number;
}

export function HtmlPanel({ id, manager, labels, cmdLines, scrollBoxes, backgroundColor, backgroundImage, cmdLineEnabled, cmdLineStyleSheet, cmdLineValue, cmdLineValueSeq }: HtmlPanelProps) {
    const viewportRef = useRef<HTMLDivElement>(null);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!ref.current || !viewportRef.current) return;
        manager.register(id, ref.current, 'html');
        manager.registerViewport(id, viewportRef.current);
        return () => manager.unregister(id);
    }, [manager, id]);

    const bgImage = backgroundImageStyle(backgroundImage);
    const innerStyle: React.CSSProperties = (backgroundColor || bgImage)
        ? {
            ...INNER_STYLE,
            ...(backgroundColor ? { background: `rgba(${backgroundColor.r}, ${backgroundColor.g}, ${backgroundColor.b}, ${backgroundColor.a / 255})` } : {}),
            ...(bgImage ?? {}),
        }
        : INNER_STYLE;

    // See TextPanel — LabelOverlay must remain a direct viewport child so its
    // inset:0 spans the padding box (otherwise userwindow QSS padding offsets
    // labels positioned at the viewport origin).
    const htmlContent = <div ref={ref} className="window-html-panel" style={innerStyle} />;

    return (
        <div ref={viewportRef} data-mudix-window={id} style={WRAPPER_STYLE}>
            {cmdLineEnabled ? (
                <div style={STACK_STYLE}>
                    <div style={OUTPUT_FILL_STYLE}>{htmlContent}</div>
                    <WindowCmdLine
                        id={id}
                        manager={manager}
                        styleSheet={cmdLineStyleSheet}
                        seedValue={cmdLineValue}
                        seedSeq={cmdLineValueSeq}
                    />
                </div>
            ) : (
                htmlContent
            )}
            {labels && <LabelOverlay manager={labels} parent={id} />}
            {cmdLines && <CommandLineOverlay manager={cmdLines} parent={id} />}
            {scrollBoxes && labels && cmdLines && (
                <ScrollBoxOverlay manager={scrollBoxes} labels={labels} cmdLines={cmdLines} windows={manager} parent={id} />
            )}
        </div>
    );
}

const WRAPPER_STYLE: React.CSSProperties = { position: 'relative', height: '100%', width: '100%' };
const STACK_STYLE: React.CSSProperties   = { position: 'relative', height: '100%', width: '100%', display: 'flex', flexDirection: 'column' };
const OUTPUT_FILL_STYLE: React.CSSProperties = { position: 'relative', flex: '1 1 auto', minHeight: 0 };
const INNER_STYLE: React.CSSProperties = { height: '100%', width: '100%', overflow: 'auto' };
