// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as net from 'net';
import * as tls from 'tls';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { armGameKeepAlive, GAME_KEEPALIVE_DELAY_MS } from '../../proxy/gameSocket';

/** Issue #454: a game host that dies without closing left the proxy's socket to
 *  it half-open for good, so the browser never saw a disconnect. Keepalive on
 *  that socket is what turns the silence into an error and a close. */
describe('proxy game socket keepalive (issue #454)', () => {
    const cleanup: (() => void)[] = [];
    afterEach(() => {
        while (cleanup.length) cleanup.pop()!();
        vi.restoreAllMocks();
    });

    async function listen(): Promise<number> {
        const server = net.createServer(sock => { cleanup.push(() => sock.destroy()); });
        cleanup.push(() => server.close());
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        return (server.address() as net.AddressInfo).port;
    }

    it.each([
        ['plain', false, net.Socket],
        ['TLS', true, tls.TLSSocket],
    ] as const)('arms keepalive on the %s game socket', async (_label, useTls, kind) => {
        const port = await listen();
        const setKeepAlive = vi.spyOn(net.Socket.prototype, 'setKeepAlive');
        const socket = armGameKeepAlive(useTls
            ? tls.connect({ host: '127.0.0.1', port })
            : net.connect(port, '127.0.0.1'));
        // A TLS dial to a plain listener fails its handshake; that's fine here.
        socket.on('error', () => {});
        cleanup.push(() => socket.destroy());

        expect(socket).toBeInstanceOf(kind);
        expect(setKeepAlive).toHaveBeenCalledWith(true, GAME_KEEPALIVE_DELAY_MS);
        expect(setKeepAlive.mock.contexts).toContain(socket);
    });

    it('starts probing after a minute of silence, as desktop does within minutes', () => {
        expect(GAME_KEEPALIVE_DELAY_MS).toBe(60_000);
    });

    it('server.ts arms keepalive on both of its game dials', () => {
        const source = readFileSync(resolve(__dirname, '../../proxy/server.ts'), 'utf8');
        expect(source.match(/\bnet\.connect\(/g)?.length).toBe(1);
        expect(source.match(/\btls\.connect\(/g)?.length).toBe(1);
        expect(source).toMatch(/armGameKeepAlive\(net\.connect\(/);
        expect(source).toMatch(/armGameKeepAlive\(secure\)/);
    });
});
