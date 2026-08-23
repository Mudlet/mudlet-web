# Connecting to a MUD

A new connection asks for one of two modes, and the difference is worth
understanding because it decides whether you need a proxy.

## MUD Server (`host:port`) — needs a proxy

This is the classic telnet MUD: a hostname and a port, like `achaea.com:23`.

Browsers cannot open raw TCP sockets — there is no API for it, at any privilege
level. So Mudlet Web can't talk to a telnet MUD directly. A small **proxy** bridges
the gap: your browser opens a WebSocket to the proxy, and the proxy opens the TCP
connection to the MUD and pumps bytes both ways.

```
Browser  <-- WebSocket -->  Proxy  <-- TCP / telnet -->  MUD
```

Mudlet Web ships pointing at a default public proxy, so a `host:port` connection
works out of the box. Everything you send and receive passes through it — including
your password on login. If you'd rather that traffic didn't go through someone
else's server, run your own: the repository has a `proxy/` directory that runs with
`yarn && yarn start` and listens on `ws://localhost:3001`, and there's a Cloudflare
Worker deployment too. Set the address per-profile in the connection form, or
globally in Settings.

## WebSocket — no proxy

Some MUDs expose a native `ws://` or `wss://` endpoint. Choose **WebSocket** mode,
paste the URL, and the browser connects straight to the game. Nothing in the middle.

If your MUD offers one, prefer it: fewer moving parts, and one less party seeing
your traffic. Ask on your game's Discord or forums whether they have a WebSocket
endpoint — many do and don't advertise it.

## Encryption

A page served over `https://` can only open `wss://` connections, not `ws://` —
that's a browser rule, not a Mudlet Web one. In practice this means the proxy has
to be reachable over `wss://`, which the default one is.

Whether the hop from the proxy to the MUD is encrypted is a separate question and
depends on the MUD supporting TLS. Mudlet Web shows what it knows about the
certificate when it can, but a proxy in the middle limits what the browser can
verify — treat a telnet MUD's connection as unencrypted unless you know otherwise.

## Protocols

Once connected, the usual Mudlet protocol stack negotiates automatically: GMCP,
MSDP, MSSP, MCCP compression, MSP sound, CHARSET, and TTYPE/MTTS. You can turn
individual ones off per profile in Settings if a server misbehaves with one.
