// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { parseImageSize } from '../../src/scripting/lua/imageSize';

describe('parseImageSize (getImageSize header parser)', () => {
  it('reads PNG dimensions from the IHDR header', () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // signature
    new DataView(png.buffer).setUint32(16, 320); // width
    new DataView(png.buffer).setUint32(20, 200); // height
    expect(parseImageSize(png)).toEqual({ width: 320, height: 200 });
  });

  it('reads GIF dimensions (little-endian)', () => {
    const gif = new Uint8Array(24);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // "GIF89a"
    const dv = new DataView(gif.buffer);
    dv.setUint16(6, 64, true);
    dv.setUint16(8, 48, true);
    expect(parseImageSize(gif)).toEqual({ width: 64, height: 48 });
  });

  it('reads JPEG dimensions from the SOF0 marker', () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8,             // SOI
      0xff, 0xe0, 0x00, 0x10, // APP0 segment, length 16
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 14 bytes of APP0 payload
      0xff, 0xc0, 0x00, 0x11, // SOF0, length 17
      0x08, 0x00, 0x90, 0x01, 0x60, // precision, height=144, width=352
    ]);
    expect(parseImageSize(jpeg)).toEqual({ width: 352, height: 144 });
  });

  it('returns null for unrecognised / truncated data', () => {
    expect(parseImageSize(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(parseImageSize(new Uint8Array(24))).toBeNull();
  });
});

describe('setMergeTables (GMCP merge keys)', () => {
  let rt: TestRuntime;
  beforeAll(async () => { rt = await createTestRuntime(); });
  afterAll(() => rt.dispose());

  it('merges registered keys into the existing gmcp sub-table', () => {
    rt.run('setMergeTables("Char.Status")');
    rt.run('__mudix_set_gmcp("Char.Status", {hp = 10, mp = 5})');
    rt.run('__mudix_set_gmcp("Char.Status", {hp = 20})');
    // mp survives the second update because the key is a merge key.
    expect(rt.run('return gmcp.Char.Status.mp')).toBe(5);
    expect(rt.run('return gmcp.Char.Status.hp')).toBe(20);
    expect(rt.run('return table.contains(mudlet.mergeTables, "Char.Status")')).toBe(true);
  });

  it('replaces (does not merge) keys that were never registered', () => {
    rt.run('__mudix_set_gmcp("Char.Vitals", {hp = 1, mp = 2})');
    rt.run('__mudix_set_gmcp("Char.Vitals", {hp = 9})');
    expect(rt.run('return gmcp.Char.Vitals.mp')).toBeNull();
    expect(rt.run('return gmcp.Char.Vitals.hp')).toBe(9);
  });
});

describe('addMouseEvent / getMouseEvents / removeMouseEvent', () => {
  let rt: TestRuntime;
  beforeAll(async () => { rt = await createTestRuntime(); });
  afterAll(() => rt.dispose());

  it('registers, lists, refuses duplicates, and removes entries', () => {
    expect(rt.run('return addMouseEvent("m1", "onM1", "Do M1", "tip")')).toBe(true);
    // Duplicate uniqueName is refused, with the reason — UI_spec pins the
    // wording, and a bare false left a script guessing.
    expect(rt.run(`
      local ok, err = addMouseEvent("m1", "other")
      return tostring(ok) .. "|" .. tostring(err)
    `)).toBe("nil|mouse event 'm1' already exists");
    expect(rt.run('return getMouseEvents().m1["event name"]')).toBe('onM1');
    expect(rt.run('return getMouseEvents().m1["display name"]')).toBe('Do M1');
    expect(rt.run('return getMouseEvents().m1["tooltip text"]')).toBe('tip');
    expect(rt.run('return removeMouseEvent("m1")')).toBe(true);
    expect(rt.run('return getMouseEvents().m1')).toBeNull();
  });
});

describe('addCustomLine', () => {
  let rt: TestRuntime;
  beforeAll(async () => { rt = await createTestRuntime(); });
  afterAll(() => rt.dispose());

  it('adds a point-list custom line that round-trips through getCustomLines', () => {
    rt.run('addRoom(1)');
    // A custom line decorates an exit the room already has — Mudlet refuses a
    // direction with no exit (a stub counts), so give it one first.
    rt.run('setExitStub(1, "north", true)');
    expect(rt.run('return addCustomLine(1, {{0,0,0},{5,5,0}}, "north", "dot line", {255,0,0}, true)')).toBe(true);
    // Keyed by the SHORT direction name, which is what Mudlet's dirToString
    // normalises to and what its saved maps carry.
    expect(rt.run('return getCustomLines(1).n.attributes.style')).toBe('dot line');
    expect(rt.run('return getCustomLines(1).n.attributes.arrow')).toBe(true);
    expect(rt.run('return getCustomLines(1).n.attributes.color.r')).toBe(255);
    // points are 0-indexed in getCustomLines
    expect(rt.run('return getCustomLines(1).n.points[1].x')).toBe(5);
  });

  it('rejects an unknown pen-style name', () => {
    rt.run('addRoom(2)');
    rt.run('setExitStub(2, "north", true)');
    // Mudlet reports the refusal as (nil, errMsg), not a bare false.
    expect(rt.run('local _, e = addCustomLine(2, {{0,0,0}}, "north", "squiggle", {0,0,0}, false) return e'))
      .toMatch(/not a valid line style/);
  });
});

describe('setWindowWrapIndent / setWindowWrapHangingIndent', () => {
  let rt: TestRuntime;
  beforeAll(async () => { rt = await createTestRuntime(); });
  afterAll(() => rt.dispose());

  it('accepts the main window and rejects an unknown named window', () => {
    expect(rt.run('return setWindowWrapIndent("main", 4)')).toBe(true);
    expect(rt.run('return setWindowWrapHangingIndent("main", 2)')).toBe(true);
    expect(rt.run('return setWindowWrapIndent("nope", 4)')).toBe(false);
  });
});

describe('setWindowWrap / getWindowWrap (main window)', () => {
  let rt: TestRuntime;
  beforeAll(async () => { rt = await createTestRuntime(); });
  afterAll(() => rt.dispose());

  it('defaults the main window to 0 (wrap disabled)', () => {
    expect(rt.run('return getWindowWrap("main")')).toBe(0);
  });

  it('round-trips an explicit wrap width', () => {
    expect(rt.run('return setWindowWrap("main", 80)')).toBe(true);
    expect(rt.run('return getWindowWrap("main")')).toBe(80);
  });

  // A window zero columns wide can show nothing, and used to hang Mudlet as
  // soon as the next line reached it (upstream #9622), so 0 is refused rather
  // than taken as "wrapping off" — and the width that was there survives.
  it('refuses a wrap width below one and keeps the old width', () => {
    rt.run('setWindowWrap("main", 80)');
    expect(rt.run('return (setWindowWrap("main", 0))')).toBeNull();
    expect(rt.run('local _, e = setWindowWrap("main", 0) return e')).toContain('greater than zero');
    expect(rt.run('return getWindowWrap("main")')).toBe(80);
  });

  // Mudlet reports a console call against a window that doesn't exist as
  // (nil, 'window "X" not found') — UI_spec asserts that message verbatim for
  // the whole family (getLineCount, moveCursor, insertText, ...).
  it('reports a not-found message for an unknown named window', () => {
    expect(rt.run('local _, e = getWindowWrap("nope") return e'))
      .toBe('window "nope" not found');
  });
});

describe('setLinkStyle / resetLinkStyle', () => {
  let rt: TestRuntime;
  beforeAll(async () => { rt = await createTestRuntime(); });
  afterAll(() => rt.dispose());

  it('applies + clears on an existing label, reports a missing one', () => {
    rt.run('createLabel("lbl1", 0, 0, 50, 20, 1)');
    expect(rt.run('return setLinkStyle("lbl1", "#ff0000", "#00ff00", true)')).toBe(true);
    expect(rt.run('return resetLinkStyle("lbl1")')).toBe(true);
    // A miss is (nil, message), not a bare false — UI_spec asserts the wording,
    // and a bare false gave a script no way to say what went wrong.
    expect(rt.run(`
      local ok, err = setLinkStyle("nolabel", "#fff", "#000")
      return tostring(ok) .. "|" .. tostring(err)
    `)).toBe("nil|label 'nolabel' not found");
  });
});

describe('receiveMSP', () => {
  let rt: TestRuntime;
  beforeAll(async () => { rt = await createTestRuntime(); });
  afterAll(() => rt.dispose());

  // Mudlet refuses receiveMSP unless MSP was negotiated with the server
  // (ctelnet::isMSPEnabled — the negotiated latch, not the profile's enableMSP
  // config). This runtime has no connection, so the Lua global reports that.
  it('refuses through Lua while MSP has not been negotiated', () => {
    expect(rt.run('local _, e = receiveMSP("!!SOUND(test.wav V=80)") return e'))
      .toMatch(/MSP is not currently enabled/);
  });

  // The parsing behind the gate is unchanged; exercise it directly.
  it('parses an MSP payload (true) and ignores plain text (false)', () => {
    expect(rt.api.receiveMSP('!!SOUND(test.wav V=80)')).toBe(true);
    expect(rt.api.receiveMSP('just some text')).toBe(false);
  });
});

describe('setWindow (element reparenting)', () => {
  let rt: TestRuntime;
  beforeAll(async () => { rt = await createTestRuntime(); });
  afterAll(() => rt.dispose());

  it('moves a label into a userwindow at the given position, and back to main', () => {
    rt.run('openUserWindow("sw_uw")');
    rt.run('createLabel("sw_lbl", 5, 5, 50, 50, 1)');
    expect(rt.run('return setWindow("sw_uw", "sw_lbl", 10, 20, true)')).toBe(true);

    const inWin = rt.session.labels.list('sw_uw');
    expect(inWin.map(l => l.name)).toContain('sw_lbl');
    expect(inWin[0].x).toBe(10);
    expect(inWin[0].y).toBe(20);
    expect(rt.session.labels.list('main').map(l => l.name)).not.toContain('sw_lbl');

    // x/y/show are optional (default 0, 0, true)
    expect(rt.run('return setWindow("main", "sw_lbl")')).toBe(true);
    expect(rt.session.labels.list('main').map(l => l.name)).toContain('sw_lbl');
    expect(rt.session.labels.list('sw_uw')).toHaveLength(0);
  });

  it('show=false keeps the element hidden after the move', () => {
    rt.run('createLabel("sw_hidden", 0, 0, 10, 10, 1)');
    expect(rt.run('return setWindow("sw_uw", "sw_hidden", 0, 0, false)')).toBe(true);
    const lbl = rt.session.labels.list('sw_uw').find(l => l.name === 'sw_hidden');
    expect(lbl?.visible).toBe(false);
  });

  it('rejects an unknown target window and an unknown element', () => {
    // A name that matches nothing is (nil, message) — the two cases are worded
    // differently so a script can tell which half of the call was wrong. An
    // illegal-but-real move still returns a bare false (see the next test).
    expect(rt.run(`
      local ok, err = setWindow("sw_nope", "sw_lbl")
      return tostring(ok) .. "|" .. tostring(err)
    `)).toBe("nil|window 'sw_nope' not found");
    expect(rt.run(`
      local ok, err = setWindow("sw_uw", "sw_no_such_element")
      return tostring(ok) .. "|" .. tostring(err)
    `)).toBe("nil|element 'sw_no_such_element' not found");
  });

  it('reparents a miniconsole but refuses a userwindow base', () => {
    rt.run('createMiniConsole("sw_mini", 0, 0, 100, 100)');
    expect(rt.run('return setWindow("sw_uw", "sw_mini", 3, 4, true)')).toBe(true);
    expect(rt.run('return setWindow("main", "sw_uw")')).toBe(false);
  });

  it('reparents an overlay command line', () => {
    rt.run('createCommandLine("sw_cl", 0, 0, 100, 20)');
    expect(rt.run('return setWindow("sw_uw", "sw_cl", 1, 2, true)')).toBe(true);
    expect(rt.session.cmdLines.list('sw_uw').map(c => c.name)).toContain('sw_cl');
  });

  it('reparents a scroll box but refuses a cycle', () => {
    rt.run('createScrollBox("sw_outer", 0, 0, 100, 100)');
    rt.run('createScrollBox("sw_outer", "sw_inner", 0, 0, 50, 50)');
    // inner -> uw is fine; outer -> inner would make outer its own ancestor
    expect(rt.run('return setWindow("sw_uw", "sw_inner")')).toBe(true);
    expect(rt.run('return setWindow("sw_inner", "sw_inner")')).toBe(false);
    rt.run('return setWindow("sw_outer", "sw_inner")'); // restore nesting
    expect(rt.run('return setWindow("sw_inner", "sw_outer")')).toBe(false);
  });
});
