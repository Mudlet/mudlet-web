// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// Exercises the luautf8 (starwing) extensions added to utf8.lua:
// charpos, next, insert, remove, escape, fold, ncasecmp, width, widthindex.
// These are pure Lua over the bundled Stepets helpers, so the runtime layer is
// the right place to verify them end-to-end.
describe('utf8 extensions', () => {
  let rt: TestRuntime;
  beforeAll(async () => { rt = await createTestRuntime(); });
  afterAll(() => rt.dispose());

  const run = (code: string) => rt.run(code);

  it('insert: before the n-th char, or appends without n', () => {
    expect(run('return utf8.insert("abc", 2, "X")')).toBe('aXbc');
    expect(run('return utf8.insert("abc", "Z")')).toBe('abcZ');
    expect(run('return utf8.insert("abc", -1, "Y")')).toBe('abYc');
  });

  it('remove: range, to-end, and last-char defaults', () => {
    expect(run('return utf8.remove("abcd", 2, 3)')).toBe('ad');
    expect(run('return utf8.remove("abcd", 2)')).toBe('a');
    expect(run('return utf8.remove("abcd")')).toBe('abc');
    expect(run('return utf8.remove("abcd", -2, -1)')).toBe('ab');
  });

  it('charpos: byte offset + codepoint of the n-th character (multibyte aware)', () => {
    // "héllo": h=byte1, é=bytes2-3 (U+00E9), l=byte4 ...
    expect(run('local p = utf8.charpos("héllo", 3); return p')).toBe(4);
    expect(run('local _, c = utf8.charpos("héllo", 2); return c')).toBe(0xe9);
  });

  it('next: walks characters by byte offset, nil past the end', () => {
    expect(run('local p = utf8.next("ab", 0); return p')).toBe(1);
    expect(run('local p = utf8.next("ab", 1); return p')).toBe(2);
    // luautf8 returns nothing at all past the end.
    expect(run('return select("#", utf8.next("ab", 2))')).toBe(0);
    expect(run('local _, c = utf8.next("ab", 1); return c')).toBe(98);
  });

  it('escape: decimal, braced, and hex sequences', () => {
    expect(run('return utf8.escape("%65%66")')).toBe('AB');
    expect(run('return utf8.escape("%x{48}%x{49}")')).toBe('HI');
    expect(run('return utf8.escape("%{97}b")')).toBe('ab');
  });

  it('fold + ncasecmp: case-insensitive (ASCII)', () => {
    expect(run('return utf8.fold("ABc")')).toBe('abc');
    expect(run('return utf8.ncasecmp("abc", "ABC")')).toBe(0);
    expect(run('return utf8.ncasecmp("a", "b")')).toBe(-1);
    expect(run('return utf8.ncasecmp("b", "a")')).toBe(1);
  });

  it('width: ASCII = 1/char, CJK wide = 2', () => {
    expect(run('return utf8.width("abc")')).toBe(3);
    expect(run('return utf8.width("中")')).toBe(2);
    expect(run('return utf8.width("a中b")')).toBe(4);
  });

  it('widthindex: the character index at a display column', () => {
    // "中中": first wide char spans columns 1-2, second spans 3-4.
    expect(run('local idx = utf8.widthindex("中中", 3); return idx')).toBe(2);
  });
});
