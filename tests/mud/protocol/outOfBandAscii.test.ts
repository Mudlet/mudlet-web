import { describe, it, expect } from 'vitest';
import { SessionCodec } from '../../../src/mud/protocol/charset';

// Mudlet holds ASCII as no encoding at all and reads an out-of-band message
// (MSSP, MSDP) as UTF-8 then (cTelnet::setMSSPVariables), so a game that sends
// UTF-8 there anyway still gets its text through.
describe('SessionCodec.decodeOutOfBand under ASCII', () => {
  it('reads the body as UTF-8', () => {
    const codec = new SessionCodec();
    expect(codec.trySetEncoding('ascii')).toBe(true);
    expect(codec.decodeOutOfBand('\xCF\x80')).toBe('π');
    expect(codec.decodeOutOfBand('plain')).toBe('plain');
  });

  it('still reads the game text itself as ASCII', () => {
    const codec = new SessionCodec();
    codec.trySetEncoding('ascii');
    expect(codec.decode('\xCF\x80')).not.toBe('π');
  });
});
