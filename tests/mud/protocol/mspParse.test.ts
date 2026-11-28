import { describe, it, expect } from 'vitest';
import { MspParser } from '../../../src/mud/protocol/msp';

// The MSP spec separates parameters by "one or more spaces" and lets the url
// be quoted (Media_spec "an MSP sound is played whatever the spacing, and with
// a quoted url or one that has a query").
describe('MSP parameters', () => {
  const parse = (text: string) => new MspParser().feed(text).commands;

  it('reads parameters whatever the spacing between them', () => {
    expect(parse('!!SOUND(a.wav  V=50   U=ftp://x/spaced/)')).toEqual([
      { kind: 'sound', file: 'a.wav', volume: 50, url: 'ftp://x/spaced/' },
    ]);
  });

  it('takes the quotes off a quoted url', () => {
    expect(parse('!!SOUND(a.wav U="ftp://x/quoted/")')[0].url).toBe('ftp://x/quoted/');
    expect(parse("!!MUSIC(a.mid U='http://x/a b/' V=20)")[0]).toEqual(
      { kind: 'music', file: 'a.mid', url: 'http://x/a b/', volume: 20 });
  });

  it('keeps a query in the url', () => {
    expect(parse('!!SOUND(a.wav U=ftp://x/query?set=1&v=2/)')[0].url).toBe('ftp://x/query?set=1&v=2/');
  });
});
