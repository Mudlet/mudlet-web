// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { timeZoneAbbreviation, timeZoneId, timeZoneOffset } from '../../src/utils/timeZone';

// getTime(true, fmt) reads fmt the way QDateTime::toString does, and os.date
// formats the way glibc's strftime does — both as desktop Mudlet on Linux.

describe('getTime(true, fmt) — Qt format quoting and the zone tokens', () => {
  let env: TestRuntime;
  // 18:57:05.123 local time, a Saturday.
  const when = new Date(2026, 8, 26, 18, 57, 5, 123);

  beforeEach(async () => {
    env = await createTestRuntime();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(when);
  });
  afterEach(() => {
    vi.useRealTimers();
    env.dispose();
  });

  const fmt = (f: string) => env.run(`return getTime(true, ${JSON.stringify(f)})`);

  it('treats quoted text as literal and a doubled quote as a quote', () => {
    expect(fmt("'at' hh 'o''clock'")).toBe("at 18 o'clock");
    expect(fmt("'Time:' hh:mm")).toBe('Time: 18:57');
    expect(fmt("hh''mm")).toBe("18'57");
  });

  it('runs an unterminated quote to the end of the format', () => {
    expect(fmt("hh 'mm ss")).toBe('18 mm ss');
  });

  it('only switches hh to 12-hour for an unquoted AM/PM token', () => {
    expect(fmt("hh 'am'")).toBe('18 am');
    expect(fmt('hh:mm ap')).toBe('06:57 pm');
    expect(fmt('h AP')).toBe('6 PM');
  });

  it('keeps the other tokens', () => {
    expect(fmt('yyyy-MM-dd ddd MMM ss.zzz')).toBe('2026-09-26 Sat Sep 05.123');
  });

  it('formats t as the zone abbreviation and tt/ttt/tttt as offset and id', () => {
    expect(fmt('t')).toBe(timeZoneAbbreviation(when));
    expect(fmt('tt')).toBe(timeZoneOffset(when));
    expect(fmt('ttt')).toBe(timeZoneOffset(when, true));
    expect(fmt('tttt')).toBe(timeZoneId());
    expect(fmt("hh 't'")).toBe('18 t');
  });
});

describe('os.date — glibc strftime parity', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  const day5 = 86400 * 5;

  it('space-pads the day in %c, as glibc does', () => {
    expect(env.run(`return os.date("!%c", ${day5})`)).toBe('Tue Jan  6 00:00:00 1970');
    expect(env.run(`return os.date("!%Ec", ${day5})`)).toBe('Tue Jan  6 00:00:00 1970');
  });

  it('uses the glibc %c layout for the default format', () => {
    const d = new Date(day5 * 1000);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const p2 = (n: number) => String(n).padStart(2, '0');
    const expected = `${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} `
      + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}`;
    expect(env.run(`return os.date(nil, ${day5})`)).toBe(expected);
    expect(env.run(`return os.date("%c", ${day5})`)).toBe(expected);
    expect(env.run('return os.date()')).toMatch(/^\w{3} \w{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/);
  });

  it('substitutes %s with the epoch seconds', () => {
    expect(env.run('return os.date("%s", 0)')).toBe('0');
    expect(env.run('return os.date("%s", 1790000000)')).toBe('1790000000');
    // glibc's %s is mktime() over the broken-down time, so under "!" the UTC
    // fields are read back as local time.
    expect(env.run('return os.date("!%s", 0)'))
      .toBe(String(env.run('return os.time(os.date("!*t", 0))')));
  });

  it('prints the zone abbreviation for %Z', () => {
    expect(env.run(`return os.date("%Z", ${day5})`)).toBe(timeZoneAbbreviation(new Date(day5 * 1000)));
    expect(env.run('return os.date("!%Z", 0)')).toBe('GMT');
  });

  it('implements the GNU %P, %k and %l', () => {
    expect(env.run('return os.date("!%P|%k|%l", 3600 * 13)')).toBe('pm|13| 1');
    expect(env.run('return os.date("!%P|%k|%l", 0)')).toBe('am| 0|12');
  });

  it('leaves %% and the rest of the format alone', () => {
    expect(env.run('return os.date("!%%s %Y-%m-%d %H:%M", 0)')).toBe('%s 1970-01-01 00:00');
    expect(env.run('return os.date("!*t", 0).year')).toBe(1970);
    expect(env.run('return os.date("plain", 0)')).toBe('plain');
  });

  it('still raises for a bad time argument', () => {
    expect(() => env.run('return os.date("%c", {})')).toThrow(/bad argument #2/);
  });
});
