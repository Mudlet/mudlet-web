import { describe, it, expect } from 'vitest';
import { SessionCodec } from '../../../src/mud/protocol/charset';

// cTelnet::gotPrompt ends a prompt with a byte of its own, which cannot continue
// a UTF-8 sequence: one the prompt cut short earns its replacement mark on the
// prompt line, and the line after starts afresh.
describe('SessionCodec.decode at the end of a prompt', () => {
  it('marks a UTF-8 sequence the prompt cut short, and keeps nothing for the next line', () => {
    const codec = new SessionCodec();
    expect(codec.decode('prompt:\xE2', true)).toBe('prompt:�');
    expect(codec.decode('after')).toBe('after');
  });

  it('still holds a cut-short sequence over for the next frame when no prompt ends it', () => {
    const codec = new SessionCodec();
    expect(codec.decode('a\xE2\x82')).toBe('a');
    expect(codec.decode('\xAC')).toBe('€');
  });

  it('does the same for an encoding it frames itself', () => {
    const codec = new SessionCodec();
    expect(codec.trySetEncoding('gbk')).toBe(true);
    expect(codec.decode('p\xB0', true)).toBe('p�');
    expect(codec.decode('x')).toBe('x');
  });
});
