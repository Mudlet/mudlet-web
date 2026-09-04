import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConnectionFormModal } from '../../src/ui/ConnectionFormModal';
import { useAppStore } from '../../src/storage/appStore';
import { validatePort, DEFAULT_MUD_PORT, type MudConnection } from '../../src/storage/schema';

/**
 * The connection form used to hand the Port field to `parseInt`, which is not a
 * validator: it stops at the first character it cannot read and returns what it
 * got so far. `1e3` was saved as port 1, `0x50` as 0 and `23abc` as 23 — a
 * different port from the one typed, stored without a word — and `0`, `-1`,
 * `65536`, `99999` were stored verbatim, only for the proxy to reject them and
 * the client to blame the infrastructure ("proxy unreachable"). See issue #54.
 *
 * Mudlet refuses both classes at the dialog:
 * `src/dlgConnectionProfiles.cpp:2140-2160`.
 *
 * (JSX is avoided so the file stays a plain .test.ts, matching the include glob.)
 */
describe('validatePort', () => {
    it('accepts an in-range port', () => {
        expect(validatePort('23')).toEqual({ ok: true, port: 23 });
        expect(validatePort('1')).toEqual({ ok: true, port: 1 });
        expect(validatePort('65535')).toEqual({ ok: true, port: 65535 });
        expect(validatePort('  4000  ')).toEqual({ ok: true, port: 4000 });
    });

    it('falls back to the placeholder port for an empty field', () => {
        expect(validatePort('')).toEqual({ ok: true, port: DEFAULT_MUD_PORT });
        expect(validatePort('   ')).toEqual({ ok: true, port: DEFAULT_MUD_PORT });
    });

    // The silent coercions: parseInt read a prefix and returned a real, wrong port.
    it.each(['1e3', '0x50', '23abc', '23.5', '-1', '+23', ' 2 3'])(
        'refuses %j rather than reading a prefix off it',
        (typed) => {
            const result = validatePort(typed);
            expect(result.ok).toBe(false);
            expect(result).toMatchObject({ reason: 'notANumber' });
        },
    );

    it.each(['0', '65536', '99999'])('refuses out-of-range %j', (typed) => {
        const result = validatePort(typed);
        expect(result.ok).toBe(false);
        expect(result).toMatchObject({ reason: 'outOfRange' });
    });

    it('uses Mudlet\'s own wording', () => {
        expect(validatePort('23abc')).toMatchObject({
            message: 'You have to enter a number. Other characters are not permitted.',
        });
        expect(validatePort('99999')).toMatchObject({
            message: 'Port number must be above zero and below 65535.',
        });
    });
});

describe('the connection form refuses to save a bad port', () => {
    let host: HTMLDivElement;
    let root: Root;
    let saved: Omit<MudConnection, 'id'>[];

    const vaultSaver = { canSave: false, save: () => {}, note: '', element: null };

    const render = () => act(() => {
        root.render(createElement(ConnectionFormModal, {
            connection: null,
            firstConnection: false,
            busy: false,
            onAdd: (data: Omit<MudConnection, 'id'>) => { saved.push(data); return 'new-id'; },
            onUpdate: () => {},
            onClose: () => {},
            vaultSaver,
        }));
    });

    /** Type into a controlled React input the way a user would. */
    const type = (id: string, value: string) => {
        const el = host.querySelector<HTMLInputElement>(`#${id}`)!;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        act(() => {
            setter.call(el, value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };

    const submit = () => act(() => {
        host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const saveButton = () =>
        [...host.querySelectorAll('button')].find(b => b.textContent === 'Add') as HTMLButtonElement;

    beforeEach(() => {
        useAppStore.setState({ connections: [] });
        saved = [];
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        render();
        type('cs-name', 'qa-conn-port');
        type('cs-host', 'example.com');
    });

    afterEach(() => {
        act(() => root.unmount());
        host.remove();
    });

    it('saves a valid port exactly as typed', () => {
        type('cs-port', '4000');
        expect(saveButton().disabled).toBe(false);
        submit();
        expect(saved).toHaveLength(1);
        expect(saved[0].port).toBe(4000);
    });

    it.each(['1e3', '0x50', '23abc', '0', '-1', '65536', '99999'])(
        'disables Add and stores nothing for %j',
        (typed) => {
            type('cs-port', typed);
            expect(saveButton().disabled).toBe(true);
            submit();
            expect(saved).toEqual([]);
        },
    );

    it('says why, next to the field, the way the name clash does', () => {
        type('cs-port', '1e3');
        const error = host.querySelector('#cs-port-error');
        expect(error?.textContent)
            .toBe('You have to enter a number. Other characters are not permitted.');
        expect(host.querySelector<HTMLInputElement>('#cs-port')!.getAttribute('aria-invalid'))
            .toBe('true');
    });

    // The preview built the URL with the coerced port, which is exactly what
    // made the typo invisible — `example.com:1` for a typed `1e3`.
    it('hides the "Connects via" preview rather than previewing a coerced port', () => {
        type('cs-port', '4000');
        expect(host.querySelector('.proxy-url-preview-url')?.textContent).toContain('&port=4000');

        type('cs-port', '1e3');
        expect(host.querySelector('.proxy-url-preview')).toBeNull();
    });
});
