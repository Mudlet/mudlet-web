import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useMudSession } from '../../src/hooks/useMudSession';
import { Toolbar } from '../../src/ui/Toolbar';
import { ProfileSession } from '../../src/ProfileSession';
import type { TlsStatus } from '../../src/mud/events';

// Exercise ProfileSession's TLS state without starting a Lua runtime or opening settings storage.
vi.mock('../../src/hooks/useEngines', () => {
    const engineRef = { current: null };
    return { useEngines: () => ({ engineRef }) };
});
vi.mock('../../src/ui/SettingsModal', () => ({
    SettingsModal: ({ tlsStatus }: { tlsStatus: TlsStatus | null }) =>
        createElement('div', { 'data-tls-kind': tlsStatus?.kind ?? 'none' }),
}));

import { BrowserMockWebSocket, OFFER, PROXY, marker, visibility } from '../support/resumableSocket';

describe('retained sessions in the toolbar and TLS settings', () => {
    let root: Root;
    let host: HTMLElement;
    let connectUrl: ((url: string) => void) | null = null;

    const Probe = (): ReturnType<typeof createElement> => {
        const { status, connect } = useMudSession();
        connectUrl = connect;
        return createElement(Toolbar, {
            connectionName: 'QA',
            status,
            ping: null,
            onDisconnect: () => {}, onReconnect: () => connect(PROXY), onNewConnection: () => {},
            onOpenMap: () => {}, onOpenScripts: () => {}, onOpenFiles: () => {},
            onOpenNotepad: () => {}, onOpenLogs: () => {}, onOpenDocs: () => {},
            onOpenHelp: () => {}, onOpenSettings: () => {}, onOpenAbout: () => {},
            onFocusInputLine: () => {},
            replayRecording: false, onToggleReplayRecording: () => {},
            replaySpeed: null, onReplaySpeedChange: () => {}, onReplayStop: () => {},
        });
    };

    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('WebSocket', BrowserMockWebSocket);
        BrowserMockWebSocket.all = [];
        visibility('hidden');                  // so a loss does not start an automatic attempt by itself
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(() => {
        act(() => { root.unmount(); });        // destroys the hook's session
        host.remove();
        vi.unstubAllGlobals();
        visibility('visible');
        connectUrl = null;
    });

    /** The status block's dot, as the toolbar labels the current state. */
    const dot = (): HTMLElement | null => host.querySelector('.status-dot');
    const dotLabel = (): string => dot()?.getAttribute('aria-label') ?? '';
    const dotStatus = (): string => dot()?.className ?? '';

    it.each([false, true])('never shows connected while detached and Connect resumes, with backend connected = %s', backendConnected => {
        act(() => { root.render(createElement(Probe)); });
        expect(dotLabel()).toBe('disconnected');
        act(() => { connectUrl?.(PROXY); });
        const ws = BrowserMockWebSocket.all[0];
        act(() => { ws.onopen?.({}); ws.text(OFFER); ws.text(marker()); });   // the offer precedes any game.connected
        if (backendConnected) act(() => { ws.text({ type: 'game.connected' }); });
        act(() => { ws.drop(); });                                            // the relay still holds the session
        expect(dotLabel()).toBe('connecting');
        expect(dotStatus()).toContain('status-connecting');
        act(() => { host.querySelector<HTMLButtonElement>('[aria-label="Connection actions"]')?.click(); });
        const connect = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
            .find(item => item.textContent?.trim().startsWith('Connect'));
        expect(connect).toBeDefined();
        act(() => { connect?.click(); });
        expect(BrowserMockWebSocket.all).toHaveLength(2);
        const dial = BrowserMockWebSocket.all[1];
        expect(dial.controls()).toEqual([]);           // still opening; repeated Connect must not dial again
        act(() => { connectUrl?.(PROXY); });
        act(() => { dial.onopen?.({}); dial.text({ type: 'session.resumed', input: '0', backendConnected }); });
        expect(dotLabel()).toBe(backendConnected ? 'connected' : 'connecting');
        expect(BrowserMockWebSocket.all).toHaveLength(2);      // still nothing dials a second backend
        act(() => { dial.text({ type: 'game.connected' }); });
        expect(dotLabel()).toBe('connected');
        expect(dotStatus()).toContain('status-connected');
        expect(BrowserMockWebSocket.all).toHaveLength(2);
    });

    it('keeps the existing TLS verdict in profile settings while its transport is detached', () => {
        act(() => { root.render(createElement(ProfileSession, {
            connection: { id: 'resume-tls', name: 'QA', mode: 'mud', host: 'game.test', port: 23, tls: true, proxyUrl: 'wss://relay.test/relay' },
            autoConnect: true, vfs: null, settingsOpen: true,
            onToggleSettings: () => {}, onCloseProfile: () => {},
        })); });
        const ws = BrowserMockWebSocket.all[0];
        act(() => {
            ws.onopen?.({}); ws.text(OFFER); ws.text(marker());
            ws.text({ type: 'tls.established', protocol: 'TLSv1.3' });
        });
        expect(host.querySelector('[data-tls-kind]')?.getAttribute('data-tls-kind')).toBe('established');
        act(() => { ws.drop(); });
        expect(host.querySelector('[data-tls-kind]')?.getAttribute('data-tls-kind')).toBe('established');
    });
});
