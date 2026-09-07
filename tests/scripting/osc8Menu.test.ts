import { describe, it, expect, beforeEach } from 'vitest';
import { openOsc8Menu } from '../../src/ui/output/osc8Menu';
import type { MenuItem } from '../../src/mud/text/hyperlinkConfig';

const MENU: MenuItem[] = [
  { label: 'Strike', action: 'send:strike' },
  { separator: true },
  { label: 'Flee', action: 'send:flee' },
];

describe('openOsc8Menu', () => {
  beforeEach(() => { document.getElementById('mudlet-popup-menu')?.remove(); });

  it('renders the title, items and separators', () => {
    openOsc8Menu(new MouseEvent('contextmenu', { clientX: 5, clientY: 5 }), MENU, { text: 'Combat' }, () => {});
    const menu = document.getElementById('mudlet-popup-menu')!;
    expect(menu).toBeTruthy();
    expect(menu.textContent).toContain('Combat');
    expect(menu.textContent).toContain('Strike');
    expect(menu.textContent).toContain('Flee');
    // header + 2 items + 1 separator
    expect(menu.querySelectorAll('div').length).toBe(4);
  });

  it('runs the selected item action and closes the menu', () => {
    const run: string[] = [];
    openOsc8Menu(new MouseEvent('contextmenu', { clientX: 0, clientY: 0 }), MENU, undefined, (uri) => run.push(uri));
    const menu = document.getElementById('mudlet-popup-menu')!;
    const strike = Array.from(menu.querySelectorAll('div')).find((d) => d.textContent === 'Strike')!;
    strike.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(run).toEqual(['send:strike']);
    expect(document.getElementById('mudlet-popup-menu')).toBeNull(); // closed
  });

  it('replaces an already-open menu rather than stacking', () => {
    openOsc8Menu(new MouseEvent('contextmenu'), MENU, undefined, () => {});
    openOsc8Menu(new MouseEvent('contextmenu'), MENU, undefined, () => {});
    expect(document.querySelectorAll('#mudlet-popup-menu').length).toBe(1);
  });
});
