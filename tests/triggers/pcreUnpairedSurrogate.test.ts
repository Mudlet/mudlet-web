// @vitest-environment node
//
// Mudlet hands pcre2 a line as UTF-8 (QString::toUtf8), which leaves an
// unpaired surrogate out, so the text either side of one is matched together
// (Regex_spec "matches text an unpaired surrogate splits in the line"). pcre2
// runs in 16-bit mode here, where the same line is invalid UTF-16 and used to
// fail every match on it.
import { describe, it, expect, beforeAll } from 'vitest';
import Pcre2, { pcreSubject } from '../../src/mud/triggers/pcre/Pcre2';

describe('pcreSubject, the line Mudlet\'s pcre2 sees', () => {
  beforeAll(async () => { await Pcre2.init(); });

  it('matches the text on either side of it as one', () => {
    const re = new Pcre2('abcd');
    const m = re.match(pcreSubject('zqab\uD800cd'));
    expect(m?.[0].match).toBe('abcd');
    // offsets are into the subject the surrogate has left
    expect(m?.[0].start).toBe(2);
    re.destroy();
  });

  it('does the same for a low surrogate, and in a global match', () => {
    const re = new Pcre2('ab');
    expect(re.matchAll(pcreSubject('a\uDC00b ab')).map(m => m[0].match)).toEqual(['ab', 'ab']);
    re.destroy();
  });

  it('leaves a well-formed pair alone', () => {
    const re = new Pcre2('a(.)b');
    expect(re.match(pcreSubject('a\u{1F600}b'))?.[1].match).toBe('\u{1F600}');
    re.destroy();
  });
});
