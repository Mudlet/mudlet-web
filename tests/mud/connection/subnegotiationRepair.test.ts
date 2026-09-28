import { describe, it, expect, vi } from 'vitest';
import { SubnegotiationRepair } from '../../../src/mud/connection/SubnegotiationRepair';

// Mudlet's cTelnet::processSocketData ends a subnegotiation at an IAC that is
// not followed by SE or IAC, and reads the IAC as the next command (#4385).
describe('SubnegotiationRepair', () => {
  const IAC = '\xFF', SB = '\xFA', SE = '\xF0', DO = '\xFD', GMCP = '\xC9', MSSP = '\x46';

  it('writes back the IAC SE a subnegotiation ran into the next command without', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new SubnegotiationRepair();
    expect(r.process(`${IAC}${SB}${GMCP}A.B {}${IAC}${DO}${MSSP}text`))
      .toBe(`${IAC}${SB}${GMCP}A.B {}${IAC}${SE}${IAC}${DO}${MSSP}text`);
  });

  it('leaves a complete subnegotiation, and an escaped IAC inside one, alone', () => {
    const r = new SubnegotiationRepair();
    const ok = `${IAC}${SB}${GMCP}x${IAC}${IAC}y${IAC}${SE}${IAC}${DO}${MSSP}`;
    expect(r.process(ok)).toBe(ok);
  });

  it('recovers across a frame boundary, with the IAC in one read and the command in the next', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new SubnegotiationRepair();
    const joined = r.process(`${IAC}${SB}${GMCP}A.B {}${IAC}`) + r.process(`${DO}${MSSP}`);
    expect(joined).toBe(`${IAC}${SB}${GMCP}A.B {}${IAC}${SE}${IAC}${DO}${MSSP}`);
  });

  it('starts a new subnegotiation when the interrupting command is IAC SB', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new SubnegotiationRepair();
    expect(r.process(`${IAC}${SB}${GMCP}a${IAC}${SB}${GMCP}b${IAC}${SE}`))
      .toBe(`${IAC}${SB}${GMCP}a${IAC}${SE}${IAC}${SB}${GMCP}b${IAC}${SE}`);
  });
});
