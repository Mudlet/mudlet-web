// Label accessibility as desktop's TLabel / TLabelModel has it: the role a
// screen reader is given, the name it reads, and — with the profile's
// accessibleLabels setting on — keyboard presses and live regions.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LabelManager, labelPlainName } from '../../src/ui/labels/LabelManager';
import { LabelOverlay } from '../../src/ui/labels/LabelOverlay';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
beforeEach(() => { document.body.replaceChildren(); });
afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
});

const make = () => {
    const m = new LabelManager();
    m.create('lbl', { x: 0, y: 0, width: 40, height: 20, fillBackground: false });
    return m;
};

async function render(m: LabelManager): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(LabelOverlay, { manager: m, parent: 'main' })));
    return host.querySelector<HTMLElement>('[data-mudlet-label="lbl"]')!;
}

/** Let the manager's coalesced notification reach the overlay. */
const settle = () => act(() => new Promise<void>(r => setTimeout(r, 20)));

describe('the accessible name (TLabelModel::effectiveAccessibleName)', () => {
    it('is the name set, else the text shown, else the tooltip', () => {
        const m = make();
        m.setHtml('lbl', '&nbsp;&nbsp;<b>Map</b> &amp; Exits');
        expect(m.getAccessibleName('lbl')).toBe('Map & Exits');
        m.setAccessibleName('lbl', 'Open the map');
        expect(m.getAccessibleName('lbl')).toBe('Open the map');
        m.setAccessibleName('lbl', '');
        m.setHtml('lbl', '');
        m.setTooltip('lbl', 'The <b>map</b>');
        expect(m.getAccessibleName('lbl')).toBe('The map');
        expect(m.getAccessibleName('nope')).toBeUndefined();
    });

    it('parts the words a line or block break parts', () => {
        expect(labelPlainName('one<br>two<div>three</div>')).toBe('one two three');
    });
});

describe('the role (Host::labelAccessibleRole)', () => {
    it('follows the click and release callbacks until a role is chosen', () => {
        const m = make();
        expect(m.getAccessibleRole('lbl')).toBe('text');
        m.setMouseUpCallback('lbl', () => {});
        expect(m.getAccessibleRole('lbl')).toBe('button');
        m.setAccessibleButton('lbl', false);
        expect(m.getAccessibleRole('lbl')).toBe('text');
        m.setAccessibleButton('lbl', undefined);
        m.setClickThrough('lbl', true);
        expect(m.getAccessibleRole('lbl')).toBe('text');
    });

    it('is a graphic for a picture with no text over it', () => {
        const m = make();
        m.setBackgroundImage('lbl', 'pic.png');
        expect(m.getAccessibleRole('lbl')).toBe('graphic');
    });
});

describe('the rendered label', () => {
    it('is a button to assistive technology, focusable only with accessibleLabels on', async () => {
        const m = make();
        m.setClickCallback('lbl', () => {});
        m.setAccessibleName('lbl', 'Close');
        const el = await render(m);
        expect(el.getAttribute('role')).toBe('button');
        expect(el.getAttribute('aria-label')).toBe('Close');
        expect(el.hasAttribute('tabindex')).toBe(false);
        m.setAccessibleLabels(true);
        await settle();
        expect(el.getAttribute('tabindex')).toBe('0');
    });

    it('is pressed with Space or Return as a left press and release, not with a modifier', async () => {
        const m = make();
        const log: string[] = [];
        m.setClickCallback('lbl', e => log.push(`click ${e.button}`));
        m.setMouseUpCallback('lbl', e => log.push(`release ${e.button}`));
        m.setAccessibleLabels(true);
        const el = await render(m);
        act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', ctrlKey: true, bubbles: true })); });
        act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', repeat: true, bubbles: true })); });
        expect(log).toEqual(['click LeftButton', 'release LeftButton']);
    });

    it('carries its live region only while accessibleLabels is on', async () => {
        const m = make();
        m.setLiveRegion('lbl', 'assertive');
        expect(m.getLiveRegion('lbl')).toBe('assertive');
        const el = await render(m);
        expect(el.hasAttribute('aria-live')).toBe(false);
        m.setAccessibleLabels(true);
        await settle();
        expect(el.getAttribute('aria-live')).toBe('assertive');
    });
});
