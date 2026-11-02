// Mudlet opens a Char.Login.URL page by itself. A browser allows that only
// shortly after a user gesture; outside it, the sign-in dialog takes over.
import { describe, it, expect, vi } from 'vitest';
import { openSignInPage } from '../../src/ui/openSignInPage';

function fakeWindow(isActive: boolean | undefined, opened: 'tab' | 'blocked' | 'throws' = 'tab') {
    const tab = { opener: {} as unknown, location: { href: 'about:blank' }, close: vi.fn() };
    const open = vi.fn(() => {
        if (opened === 'throws') throw new Error('blocked');
        return opened === 'tab' ? tab : null;
    });
    const navigator = isActive === undefined ? {} : { userActivation: { isActive } };
    return { win: { navigator, open } as unknown as Window, tab, open };
}

describe('openSignInPage', () => {
    it('opens the page in a new tab cut off from ours while the gesture is live', () => {
        const { win, tab, open } = fakeWindow(true);
        expect(openSignInPage('https://game.example/login', win)).toBe(true);
        expect(open).toHaveBeenCalledWith('about:blank', '_blank');
        expect(tab.opener).toBeNull();
        expect(tab.location.href).toBe('https://game.example/login');
    });

    it('does not try without user activation, or where it cannot be read', () => {
        for (const active of [false, undefined]) {
            const { win, open } = fakeWindow(active);
            expect(openSignInPage('https://game.example/login', win)).toBe(false);
            expect(open).not.toHaveBeenCalled();
        }
    });

    it('reports a blocked popup so the dialog can take over', () => {
        expect(openSignInPage('https://x.example', fakeWindow(true, 'blocked').win)).toBe(false);
        expect(openSignInPage('https://x.example', fakeWindow(true, 'throws').win)).toBe(false);
    });
});
