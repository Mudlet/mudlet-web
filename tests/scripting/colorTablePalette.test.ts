// @vitest-environment node
//
// mudlet-web#363 item 3 (and the color_table half of item 2): desktop's
// Host::updateAnsi16ColorsInTable rewrites color_table's sixteen ANSI entries —
// ansi_001, ansi_red and ansiRed alike — from the palette in force, when the
// profile loads and whenever the profile or the server (`ESC]P`/`ESC]R`)
// changes it. So `<ansi_red>` paints the colour the game's red does.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';
import { applyAnsiPalette, resetAllPaletteColors, setServerRedefineColorsAllowed } from '../../src/mud/text/colors';

const ESC = '\x1b';
const ST = `${ESC}\\`;

describe('color_table follows the ANSI palette (#363)', () => {
  let env: TestRuntime;
  const entry = (key: string) => env.run(`local c = color_table["${key}"] return c[1] .. "," .. c[2] .. "," .. c[3]`);

  afterEach(() => {
    env.dispose();
    setServerRedefineColorsAllowed(true);
    applyAnsiPalette(undefined);
    resetAllPaletteColors();
  });

  describe('with the profile palette set before the runtime loads', () => {
    beforeEach(async () => {
      applyAnsiPalette([undefined, '#ff8800']);
      env = await createTestRuntime();
    });

    it('seeds ansi_red, ansiRed and ansi_001 from it', () => {
      expect(entry('ansi_red')).toBe('255,136,0');
      expect(entry('ansiRed')).toBe('255,136,0');
      expect(entry('ansi_001')).toBe('255,136,0');
      // Untouched slots keep the built-in colours.
      expect(entry('ansi_light_red')).toBe('255,0,0');
      expect(entry('ansi_009')).toBe('255,0,0');
    });

    it('cecho("<ansi_red>") paints the profile red', () => {
      env.run('createBuffer("ct"); cecho("ct", "<ansi_red>x")');
      expect(env.run('selectString("ct", "x", 1) local r, g, b = getFgColor("ct") return r .. "," .. g .. "," .. b'))
        .toBe('255,136,0');
    });
  });

  describe('with the runtime already loaded', () => {
    beforeEach(async () => { env = await createTestRuntime(); });

    it('starts from the built-in colours', () => {
      expect(entry('ansi_red')).toBe('128,0,0');
      expect(entry('ansiLightBlack')).toBe('128,128,128');
    });

    it('follows a later profile palette change', () => {
      applyAnsiPalette([undefined, '#ff8800']);
      expect(entry('ansi_red')).toBe('255,136,0');
      expect(entry('ansiRed')).toBe('255,136,0');
      expect(entry('ansi_001')).toBe('255,136,0');
    });

    it('follows the server ESC]P and ESC]R', () => {
      setServerRedefineColorsAllowed(true);
      new AnsiAwareBuffer(`${ESC}]P1ff8800${ST}`);
      expect(entry('ansi_red')).toBe('255,136,0');
      expect(entry('ansiRed')).toBe('255,136,0');
      expect(entry('ansi_001')).toBe('255,136,0');
      new AnsiAwareBuffer(`${ESC}]P9123456${ST}`);
      expect(entry('ansi_light_red')).toBe('18,52,86');
      new AnsiAwareBuffer(`${ESC}]R${ST}`);
      expect(entry('ansi_red')).toBe('128,0,0');
      expect(entry('ansi_009')).toBe('255,0,0');
    });

    it('isAnsiFgColor follows the redefined red', () => {
      setServerRedefineColorsAllowed(true);
      new AnsiAwareBuffer(`${ESC}]P1ff8800${ST}`);
      env.api.beginLine(new AnsiAwareBuffer(`${ESC}[31mRR${ESC}[0m`));
      expect(env.run('selectString("RR", 1) local r, g, b = getFgColor() return r .. "," .. g .. "," .. b')).toBe('255,136,0');
      // Mudlet's numbering: 4 is red (1 light black, 2 black, 3 light red, ...).
      expect(env.run('selectString("RR", 1) return isAnsiFgColor(4)')).toBe(true);
    });

    it('stops following once the runtime is gone', () => {
      env.dispose();
      expect(() => applyAnsiPalette([undefined, '#ff8800'])).not.toThrow();
      env = { dispose: () => {} } as TestRuntime;
    });
  });
});
