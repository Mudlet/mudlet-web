import { useLayoutEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WindowManager } from '../windows/WindowManager';

interface PopoutWindowProps {
    id: string;
    title: string;
    width: number;
    height: number;
    manager: WindowManager;
    /** Called when the popout should be re-docked into the main window — either
     *  because the user closed the child window, or the browser blocked it. */
    onClosed: () => void;
}

/**
 * Detaches a panel into a separate browser window.
 *
 * The whole window system is built on a single persistent portal-target div per
 * panel (WindowManager.getOrCreatePortalTarget) that physically moves between
 * dock slots and floating frames while the React component rendered into it
 * never unmounts. A popout is just one more place to move that div: into a
 * `window.open()` child document. Because the component stays mounted in the
 * main React tree, scrollback, buffered writes, and the live renderer/viewport
 * registrations all survive the move.
 *
 * Cross-window events: React 19 attaches its event delegation to the root
 * container passed to createRoot — which lives in the main window — so synthetic
 * events never reach panel content sitting in another window. We fix this by
 * mounting a throwaway React root on the child window's body and appending the
 * portal target as a descendant (the same appendChild-into-a-ref'd-div pattern
 * DockedPanel/ScriptWindow use). The throwaway root registers React's listeners
 * on the child document; when a native event fires there, React resolves the
 * target node's fiber (the `__reactFiber$` key matches because both roots share
 * the one React bundle) and dispatches synthetic events up the *main* tree, so
 * the panel's existing onChange/onKeyDown/onClick handlers fire normally.
 */
export function PopoutWindow({ id, title, width, height, manager, onClosed }: PopoutWindowProps) {
    // Keep the latest onClosed in a ref so the mount effect (which must not
    // re-run on every render) always calls the current callback.
    const onClosedRef = useRef(onClosed);
    onClosedRef.current = onClosed;

    useLayoutEffect(() => {
        const target = manager.getPortalTarget(id);
        if (!target) { onClosedRef.current(); return; }

        const w = Math.max(240, Math.round(width)  || 640);
        const h = Math.max(180, Math.round(height) || 480);
        const child = window.open(
            '',
            `mudlet-popout-${id}`,
            `popup=yes,width=${w},height=${h}`,
        );
        // Popup blocked (no user gesture, or blocker) — fall back to docked.
        if (!child) { onClosedRef.current(); return; }

        const doc = child.document;
        doc.title = title;
        doc.body.style.margin = '0';
        doc.body.style.height = '100vh';
        doc.body.style.overflow = 'hidden';
        // Carry theme attributes (data-theme, class, color-scheme) so CSS vars
        // resolve identically; stylesheets are mirrored below.
        const srcRoot = document.documentElement;
        doc.documentElement.className = srcRoot.className;
        for (const attr of Array.from(srcRoot.attributes)) {
            if (attr.name === 'class') continue;
            try { doc.documentElement.setAttribute(attr.name, attr.value); } catch { /* ignore */ }
        }

        const stopMirroring = mirrorStyles(document, doc);

        // Throwaway root → registers React 19's event delegation on the child
        // document. EventHost appends the portal target into a React-owned div
        // (descendant of the root container) so events bubble to the listeners.
        const evRoot: Root = createRoot(doc.body);
        evRoot.render(<EventHost target={target} />);

        // Re-dock when the user closes the child window. pagehide fires while
        // the document still exists, so we can rescue the target node first.
        const rescue = () => {
            if (target.parentNode) manager.getPortalHolding().appendChild(target);
        };
        const handlePageHide = () => {
            rescue();
            onClosedRef.current();
        };
        child.addEventListener('pagehide', handlePageHide);

        return () => {
            child.removeEventListener('pagehide', handlePageHide);
            stopMirroring();
            // Re-adopt the target into the main document *before* tearing down
            // the child window, then let evRoot clean up its own wrapper.
            rescue();
            try { evRoot.unmount(); } catch { /* window may already be gone */ }
            try { child.close(); } catch { /* ignore */ }
        };
        // Mount/unmount only — title and size changes are handled in separate
        // effects so reopening the window (and reparenting the target) is avoided.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, manager]);

    return null;
}

/** Mounted in the child window's throwaway root: owns a flex container and
 *  appendChilds the shared portal target into it (mirrors DockedPanel). */
function EventHost({ target }: { target: HTMLDivElement }) {
    const slotRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const slot = slotRef.current;
        if (!slot) return;
        slot.appendChild(target);
        return () => {
            if (target.parentNode === slot) slot.removeChild(target);
        };
    }, [target]);
    return <div ref={slotRef} style={{ position: 'fixed', inset: 0, display: 'flex' }} />;
}

/**
 * Copy every <style> and <link rel="stylesheet"> from the source head into the
 * destination head and keep them in sync (Vite injects/removes <style> tags on
 * HMR in dev). Returns a teardown that disconnects the observer and removes the
 * mirrored nodes.
 */
function mirrorStyles(src: Document, dst: Document): () => void {
    const mirrored = new Map<Element, Element>();

    const isStyleNode = (n: Node): n is Element =>
        n instanceof Element &&
        (n.tagName === 'STYLE' ||
            (n.tagName === 'LINK' && (n as HTMLLinkElement).rel === 'stylesheet'));

    const copy = (node: Element) => {
        const clone = node.cloneNode(true) as Element;
        dst.head.appendChild(clone);
        mirrored.set(node, clone);
    };

    src.head.querySelectorAll('style, link[rel="stylesheet"]').forEach(copy);

    const observer = new MutationObserver(records => {
        for (const rec of records) {
            rec.addedNodes.forEach(n => { if (isStyleNode(n) && !mirrored.has(n)) copy(n); });
            rec.removedNodes.forEach(n => {
                if (!(n instanceof Element)) return;
                const clone = mirrored.get(n);
                if (clone) { clone.remove(); mirrored.delete(n); }
            });
        }
    });
    observer.observe(src.head, { childList: true });

    return () => {
        observer.disconnect();
        mirrored.forEach(clone => clone.remove());
        mirrored.clear();
    };
}
