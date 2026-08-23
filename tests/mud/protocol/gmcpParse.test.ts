import { describe, it, expect, vi } from 'vitest';
import { createGmcpStream, encodeGmcp, encodeGmcpRaw } from '../../../src/mud/protocol/gmcp';
import { GMCP_COMMAND_CODE } from '../../../src/mud/protocol/constants';

/** Build the subnegotiation body createGmcpStream consumes: the GMCP option
 *  byte (201) followed by the message text. (IAC SB / IAC SE framing is
 *  stripped upstream before the stream sees it.) */
function frame(text: string): string {
  return String.fromCharCode(GMCP_COMMAND_CODE) + text;
}

/** The Latin-1 byte-string MudClient hands the stream: one char per wire byte. */
function utf8Frame(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = String.fromCharCode(GMCP_COMMAND_CODE);
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

describe('GMCP payload parsing', () => {
  it('parses a normal message with a JSON body', () => {
    const seen: Array<{ path: string; value: unknown }> = [];
    const stream = createGmcpStream({ onEnvelope: e => seen.push(e) });
    stream(frame('Char.Vitals {"hp":42}'));
    expect(seen).toEqual([{ path: 'Char.Vitals', value: { hp: 42 } }]);
  });

  it('accepts a bodyless message (no space) instead of dropping it', () => {
    // GMCP spec: the data part is optional. The server's canonical Core.Ping
    // reply has no body at all.
    const seen: Array<{ path: string; value: unknown }> = [];
    const stream = createGmcpStream({ onEnvelope: e => seen.push(e) });
    stream(frame('Core.Ping'));
    expect(seen).toEqual([{ path: 'Core.Ping', value: '' }]);
  });

  it('accepts a message with a trailing space but empty body', () => {
    const seen: Array<{ path: string; value: unknown }> = [];
    const stream = createGmcpStream({ onEnvelope: e => seen.push(e) });
    stream(frame('Core.Ping '));
    expect(seen).toEqual([{ path: 'Core.Ping', value: '' }]);
  });

  it('accepts an explicit empty-string body', () => {
    const seen: Array<{ path: string; value: unknown }> = [];
    const stream = createGmcpStream({ onEnvelope: e => seen.push(e) });
    stream(frame('Core.Ping ""'));
    expect(seen).toEqual([{ path: 'Core.Ping', value: '' }]);
  });

  // Client.GUI predates the JSON body — Mudlet's cTelnet::setGMCPVariables
  // treats "does not parse as JSON" as the signal to try the older
  // `<version>\n<url>` form, and returns before setGMCPTable so that shape
  // never reaches the Lua gmcp table.
  it('routes a non-JSON Client.GUI body to onClientGui instead of dropping it', () => {
    const seen: unknown[] = [];
    const gui: unknown[] = [];
    const stream = createGmcpStream({ onEnvelope: e => seen.push(e), onClientGui: p => gui.push(p) });
    stream(frame('Client.GUI 39\nhttps://example.com/gui.mpackage'));
    expect(gui).toEqual(['39\nhttps://example.com/gui.mpackage']);
    // Legacy shape stays off the envelope path — no gmcp table entry, no events.
    expect(seen).toEqual([]);
  });

  it('sends a JSON Client.GUI body to both the envelope and onClientGui', () => {
    const order: string[] = [];
    const gui: unknown[] = [];
    const stream = createGmcpStream({
      onEnvelope: () => order.push('envelope'),
      onClientGui: p => { order.push('clientGui'); gui.push(p); },
    });
    stream(frame('Client.GUI {"version":"39","url":"https://example.com/gui.mpackage"}'));
    expect(gui).toEqual([{ version: '39', url: 'https://example.com/gui.mpackage' }]);
    // Envelope first: scripts see the payload before the install acts on it.
    expect(order).toEqual(['envelope', 'clientGui']);
  });

  it('still drops a non-JSON body from any other module', () => {
    // The fallback is Client.GUI-only; everything else with an unparseable
    // body is a server bug and stays dropped-with-a-warning.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: Array<{ path: string; value: unknown }> = [];
    const stream = createGmcpStream({ onEnvelope: e => seen.push(e) });
    stream(frame('Char.Vitals hp=42'));
    expect(seen).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  // GMCP bodies are JSON, which is always UTF-8 regardless of the session's
  // text encoding (cTelnet::setGMCPVariables). The bytes arrive here as a
  // Latin-1 byte-string, so without decoding, "•" reached scripts as the three
  // mojibake chars "â\x80¢" and Lua pattern matches against it failed.
  it('decodes a UTF-8 body rather than passing raw bytes through', () => {
    const seen: Array<{ path: string; value: unknown }> = [];
    const stream = createGmcpStream({ onEnvelope: e => seen.push(e) });
    stream(utf8Frame('Game.Players.Info {"route":"Tristeza • Port of Darkhill","emoji":"⛵"}'));
    expect(seen).toEqual([
      { path: 'Game.Players.Info', value: { route: 'Tristeza • Port of Darkhill', emoji: '⛵' } },
    ]);
  });

  it('UTF-8-encodes outgoing bodies into the byte-string sendBytes expects', () => {
    // Framing bytes stay raw; only the body is transcoded, and it round-trips
    // back through the inbound parser.
    const seen: Array<{ path: string; value: unknown }> = [];
    const stream = createGmcpStream({ onEnvelope: e => seen.push(e) });
    for (const wire of [encodeGmcp('Char.Name', { name: 'Zoë' }), encodeGmcpRaw('Char.Name {"name":"Zoë"}')]) {
      expect(wire.startsWith('\xFF\xFA' + String.fromCharCode(GMCP_COMMAND_CODE))).toBe(true);
      expect(wire.endsWith('\xFF\xF0')).toBe(true);
      stream(wire.slice(2, -2));
    }
    expect(seen).toEqual([
      { path: 'Char.Name', value: { name: 'Zoë' } },
      { path: 'Char.Name', value: { name: 'Zoë' } },
    ]);
  });
});
