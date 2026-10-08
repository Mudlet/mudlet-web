import * as net from 'net';

/** How long the game socket may sit idle before the kernel starts probing it.
 *  Node arms the probes themselves at 1 s apart, 10 of them (libuv's
 *  `uv_tcp_keepalive`), so a game host that vanished without closing — a
 *  crash, a power loss, a partition, a NAT that forgot the flow — is found
 *  about 70 s after the last traffic. Desktop Mudlet keeps the same watch on
 *  its socket (issue #454). */
export const GAME_KEEPALIVE_DELAY_MS = 60_000;

/** Turn on TCP keepalive for a socket to the game. Without it a peer that
 *  disappeared silently leaves the socket half-open until the proxy next
 *  writes to it: no error, no close, and so nothing for the browser to react
 *  to. With it, failed probes raise ETIMEDOUT, the socket closes, and the
 *  proxy reports that as a WebSocket close the client reconnects from. */
export function armGameKeepAlive<T extends net.Socket>(socket: T): T {
    socket.setKeepAlive(true, GAME_KEEPALIVE_DELAY_MS);
    return socket;
}
