import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EchoHandler } from '../../../src/mud/protocol/echo';
import { ECHO_WILL, ECHO_WONT, ECHO_DO, ECHO_DONT } from '../../../src/mud/protocol/constants';

function makeHandler() {
  const sent: string[] = [];
  const masks: boolean[] = [];
  let anomalies = 0;
  const handler = new EchoHandler(
    (data) => sent.push(data),
    (maskInput) => masks.push(maskInput),
    () => { anomalies++; },
  );
  handler.reset(); // establishes connectionStartAt, clears state
  return { handler, sent, masks, anomalies: () => anomalies };
}

// The rule is cTelnet's: the server taking ECHO is the server saying "do not
// show what is typed", and nothing else is consulted. mudix used to mask only
// for an ECHO that engaged AFTER the server had printed something, so that a
// full-server-echo MUD would not hide the player's name — but nothing was ever
// recorded as running into that, and the reading left a server which negotiates
// ECHO in its opening burst and then asks for a password with no masking at all,
// which is the error that matters.
describe('EchoHandler — masking follows the server taking ECHO', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('masks for a WILL ECHO in the opening burst, before any output', () => {
    const { handler, sent, masks } = makeHandler();

    handler.processData(ECHO_WILL);

    expect(handler.serverEchoing).toBe(true);
    expect(handler.passwordMode).toBe(true);
    expect(sent).toContain(ECHO_DO);          // acked on the wire
    expect(masks[masks.length - 1]).toBe(true);
  });

  it('masks for one that arrives after the server has printed output', () => {
    const { handler, masks } = makeHandler();

    handler.processData('By what name do you wish to be known? ');
    handler.processData(ECHO_WILL);

    expect(handler.serverEchoing).toBe(true);
    expect(handler.passwordMode).toBe(true);
    expect(masks[masks.length - 1]).toBe(true);

    // WONT ECHO ends it again.
    handler.processData(ECHO_WONT);
    expect(handler.passwordMode).toBe(false);
    expect(masks[masks.length - 1]).toBe(false);
  });

  it('commits on the negotiation itself, with no settling delay', () => {
    const { handler, masks } = makeHandler();

    handler.processData(ECHO_WILL);
    // Read before any timer could have run: cTelnet calls
    // setRemoteEchoingActive() in the WILL branch, so the state is already
    // there for a script that negotiates and asks in the same breath.
    expect(handler.passwordMode).toBe(true);
    expect(masks).toEqual([true]);
  });

  it('forces ECHO off when a server never sends the WONT that ends a prompt', () => {
    const { handler, sent } = makeHandler();

    handler.processData(ECHO_WILL);
    expect(handler.serverEchoing).toBe(true);

    // Past the 60s safety window Mudlet arms during the login phase: a server
    // that took ECHO and never gave it back would otherwise leave the input
    // masked for the rest of the session.
    vi.advanceTimersByTime(61_000);
    expect(handler.serverEchoing).toBe(false);
    expect(sent).toContain(ECHO_DONT);
  });
});
