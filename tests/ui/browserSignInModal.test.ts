// A game-linked sign-in page (Char.Login.URL) ends in plain text: StickMUD
// sends no GMCP at all after the link, only "Signed in as …". So the dialog
// closes when the player opens the page and comes back, as it asks them to.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserSignInModal } from '../../src/ui/BrowserSignInModal';
import type { SignInOffer } from '../../src/mud/CharLoginController';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function render(flow: SignInOffer['flow']) {
    const onClose = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const offer: SignInOffer = { url: 'https://game.example/login', provider: 'discord', flow };
    await act(async () => {
        root.render(createElement(BrowserSignInModal, { connectionName: 'StickMUD', offer, onClose }));
    });
    return onClose;
}

async function openLink() {
    const link = container.querySelector('a[href="https://game.example/login"]') as HTMLAnchorElement;
    // Don't let happy-dom navigate.
    link.addEventListener('click', e => e.preventDefault());
    await act(async () => { link.click(); });
}

async function fire(type: 'blur' | 'focus') {
    await act(async () => { window.dispatchEvent(new Event(type)); });
}

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
});

describe('BrowserSignInModal', () => {
    it('closes when the player comes back after opening a game-linked page', async () => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        const onClose = await render('server');
        await openLink();
        expect(onClose).not.toHaveBeenCalled();
        await fire('blur');
        await fire('focus');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('stays open on focus changes before the page was opened', async () => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        const onClose = await render('server');
        await fire('blur');
        await fire('focus');
        expect(onClose).not.toHaveBeenCalled();
    });

    it('stays open for our own OAuth flow, which closes itself on capture', async () => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        const onClose = await render('client');
        await openLink();
        await fire('blur');
        await fire('focus');
        expect(onClose).not.toHaveBeenCalled();
    });
});
