import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ResizableModal } from '../../src/ui/ResizableModal';

// ResizableModal is declared inside panels (the map editor from MapPanel, the
// package modals from ScriptEditorPanel). `position: fixed` escapes layout but
// NOT an ancestor's stacking context, so while the modal rendered in place its
// z:40 only ranked against that panel's siblings — a label or floating window
// above the panel painted straight over the open map editor. It must render
// into its document's <body> so the z:40 band applies as written.
//
// (JSX is avoided so the file stays a plain .test.ts, matching the include glob.)

let host: HTMLDivElement;
let root: Root;

const modalProps = (children: string) =>
    ({ title: 'Map Editor', onClose: () => {}, defaultW: 400, defaultH: 300, children });

const renderModal = (child = 'body-content') =>
    act(() => {
        root.render(createElement(ResizableModal, modalProps(child)));
    });

beforeEach(() => {
    host = document.createElement('div');
    // A panel's stacking context: exactly what used to trap the modal.
    host.style.position = 'relative';
    host.style.zIndex = '30';
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe('ResizableModal portalling', () => {
    it('renders into document.body, not inside the stacking context it was declared in', () => {
        renderModal();

        const modal = document.querySelector('.resizable-modal');
        expect(modal).not.toBeNull();
        // The actual fix: escaped the panel subtree entirely.
        expect(modal!.parentElement).toBe(document.body);
        expect(host.contains(modal)).toBe(false);
    });

    it('leaves nothing painted behind at the declaration site', () => {
        renderModal();

        // Only the hidden anchor that names the document to portal into.
        expect(host.querySelector('.resizable-modal')).toBeNull();
        expect(host.textContent).toBe('');
    });

    it('still renders its children and title', () => {
        renderModal('editor goes here');

        const modal = document.querySelector('.resizable-modal')!;
        expect(modal.textContent).toContain('editor goes here');
        expect(modal.getAttribute('aria-label')).toBe('Map Editor');
        expect(modal.getAttribute('role')).toBe('dialog');
    });

    it('portals into its OWN document, so a popped-out panel keeps its modal', () => {
        // PopoutWindow moves a panel's DOM into a child window while its React
        // tree stays in the main one. A hardcoded `document.body` would yank the
        // modal back into the main window; the anchor's ownerDocument must win.
        const popout = document.implementation.createHTMLDocument('popout');
        const popoutHost = popout.createElement('div');
        popout.body.appendChild(popoutHost);
        const popoutRoot = createRoot(popoutHost);

        act(() => {
            popoutRoot.render(createElement(ResizableModal, modalProps('in the popout')));
        });

        expect(popout.querySelector('.resizable-modal')).not.toBeNull();
        expect(popout.querySelector('.resizable-modal')!.parentElement).toBe(popout.body);
        // and it did NOT leak into the main document
        expect(document.querySelector('.resizable-modal')).toBeNull();

        act(() => popoutRoot.unmount());
    });
});
