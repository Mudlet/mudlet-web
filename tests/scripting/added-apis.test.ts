// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { TriggerEngine } from '../../src/mud/triggers/TriggerEngine';
import { AliasEngine } from '../../src/mud/aliases/AliasEngine';
import { TimerEngine } from '../../src/mud/timers/TimerEngine';
import { KeyEngine } from '../../src/mud/keybindings/KeyEngine';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';

// tempLineTrigger's counting logic lives in TriggerEngine.addTempLine, which is
// exercised here directly (the dispatch pipeline that drives processTemp from
// network input lives in ScriptingEngine and isn't wired into createTestRuntime).
describe('tempLineTrigger — TriggerEngine.addTempLine', () => {
  it('fires on `howMany` lines starting `from` lines ahead, then self-expires', () => {
    const te = new TriggerEngine();
    const fired: string[] = [];
    te.addTempLine(1, 2, (m) => fired.push(m[0] ?? ''));
    te.processTemp('line-1');
    te.processTemp('line-2');
    te.processTemp('line-3'); // already expired
    expect(fired).toEqual(['line-1', 'line-2']);
  });

  it('skips `from - 1` lines before the first fire', () => {
    const te = new TriggerEngine();
    const fired: string[] = [];
    te.addTempLine(3, 1, (m) => fired.push(m[0] ?? ''));
    te.processTemp('a');
    te.processTemp('b');
    te.processTemp('c'); // from=3 → third line fires
    te.processTemp('d');
    expect(fired).toEqual(['c']);
  });

  it('does not tick on the line it was created on (created mid-handler)', () => {
    const te = new TriggerEngine();
    const fired: string[] = [];
    te.addTemp('spawn', () => {
      te.addTempLine(1, 1, (m) => fired.push(m[0] ?? ''));
    }, 'substring');
    te.processTemp('spawn'); // creation line — the new line trigger must skip it
    te.processTemp('next');  // from=1 → fires here
    te.processTemp('after');
    expect(fired).toEqual(['next']);
  });

  it('early disposal cancels remaining fires', () => {
    const te = new TriggerEngine();
    const fired: string[] = [];
    const kill = te.addTempLine(1, 5, (m) => fired.push(m[0] ?? ''));
    te.processTemp('1');
    kill();
    te.processTemp('2');
    expect(fired).toEqual(['1']);
  });
});

describe('tempLineTrigger — Lua binding', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('registers from Lua and runs the code on the next line', () => {
    env.run('tempLineTrigger(1, 1, [[echo("FIRED\\n")]])');
    env.api.triggers.processTemp('a line of output');
    expect(env.mainOutput.join('')).toContain('FIRED');
  });

  it('stops after `howMany` fires', () => {
    env.run('tempLineTrigger(1, 2, [[echo("X\\n")]])');
    env.api.triggers.processTemp('1');
    env.api.triggers.processTemp('2');
    env.api.triggers.processTemp('3');
    const xs = env.mainOutput.join('').match(/X/g) ?? [];
    expect(xs.length).toBe(2);
  });
});

describe('echoPopup / insertPopup / setPopup', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('echoPopup writes its text to the target window', () => {
    env.run('createBuffer("tb"); echoPopup("tb", "MENU\\n", {"look"}, {"Look here"})');
    expect(env.run('return (getCurrentLine("tb"))')).toBe('MENU');
  });

  it('insertPopup inserts its text at the cursor', () => {
    env.run('createBuffer("tb"); cecho("tb", "ABCD\\n"); moveCursor("tb", 2, 0)');
    env.run('insertPopup("tb", "XX", {"look"}, {"Look"})');
    expect(env.run('return (getCurrentLine("tb"))')).toBe('ABXXCD');
  });

  it('setPopup returns false with no selection and true once a selection exists', () => {
    env.run('createBuffer("tb"); cecho("tb", "<red>Hello<reset>\\n")');
    expect(env.run('return (setPopup("tb", {"look"}, {"Look"}))')).toBe(false);
    env.run('selectCurrentLine("tb")');
    expect(env.run('return (setPopup("tb", {"look"}, {"Look"}))')).toBe(true);
  });
});

describe('wrapLine', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('returns true for an in-range line and false out of range', () => {
    env.run('createBuffer("tb"); cecho("tb", "Hello\\n")');
    // one line at index 0; getLineCount is the line *count* (Mudlet semantics),
    // so a single line reports 1 and the last index is getLineCount()-1.
    expect(env.run('return (getLineCount("tb"))')).toBe(1);
    expect(env.run('return (wrapLine("tb", 0))')).toBe(true);
    expect(env.run('return (wrapLine("tb", 0))')).toBe(true); // idempotent re-render
    expect(env.run('return (wrapLine("tb", 5))')).toBe(false);
    expect(env.run('return (wrapLine("tb", -1))')).toBe(false);
  });

  it('targets the last line via getLineCount and does not throw', () => {
    env.run('createBuffer("tb"); cecho("tb", "one\\n"); cecho("tb", "two\\n")');
    expect(() => env.run('wrapLine("tb", getLineCount("tb") - 1)')).not.toThrow();
  });
});

// No socket is wired in the test runtime, so the send/feed paths exercise the
// full Lua → ScriptingAPI → MudSession chain and confirm the "not connected"
// branch returns cleanly rather than throwing.
describe('sendMSDP / sendSocket / feedTelnet / disconnect — wiring', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  // Mudlet reports a refused send as (nil, errMsg) rather than a bare false,
  // and names the reason — scripts branch on the message.
  it('sendMSDP / sendSocket return nil and a reason when disconnected', () => {
    expect(env.run('local _, e = sendMSDP("ROOM") return e'))
      .toMatch(/not connected to game server/);
    expect(env.run('local _, e = sendMSDP("REPORT", "HP", "MP") return e'))
      .toMatch(/not connected to game server/);
    expect(env.run('local _, e = sendSocket("\\255\\250\\240") return e'))
      .toMatch(/unable to send/);
  });

  it('feedTelnet and disconnect are callable without a connection', () => {
    expect(() => env.run('feedTelnet("hi\\n"); disconnect()')).not.toThrow();
  });
});

describe('getTimestamp', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('returns an "hh:mm:ss.zzz" string for an in-range (1-based) line', () => {
    env.run('createBuffer("tb"); cecho("tb", "hi\\n")');
    const ts = env.run('return (getTimestamp("tb", 1))');
    expect(ts).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it('returns nil for an out-of-range line or a missing window', () => {
    env.run('createBuffer("tb"); cecho("tb", "hi\\n")');
    expect(env.run('return (getTimestamp("tb", 99))')).toBe(null);
    expect(env.run('return (getTimestamp("nope", 1))')).toBe(null);
  });
});

describe('getLabelSizeHint', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  // No DOM in the node harness, so getSizeHint falls back to the label's
  // configured geometry — which is exactly what we asserted createLabel set.
  it('returns the label width and height', () => {
    env.run('createLabel("L", 0, 0, 120, 40, false)');
    expect(env.run('local w, h = getLabelSizeHint("L"); return w')).toBe(120);
    expect(env.run('local w, h = getLabelSizeHint("L"); return h')).toBe(40);
  });

  it('returns nil for a non-existent label', () => {
    expect(env.run('return (getLabelSizeHint("nope"))')).toBe(null);
  });
});

// No map panel is mounted in the test runtime, so no MapControl is registered.
// These confirm the Lua → ScriptingAPI → WindowManager chain is wired and
// degrades cleanly (Mudlet's "no map" path) rather than throwing.
describe('getMapZoom / setMapZoom / updateMap — wiring', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  // Mudlet keeps the zoom on the area (TArea::mLast2DMapZoom), so it answers
  // with no mapper mounted — an area that has never been zoomed reads back the
  // default, and setting one succeeds whether or not a panel is showing it.
  it('answer from the area with no panel open, and do not throw', () => {
    expect(env.run('return (getMapZoom())')).toBe(20);
    expect(env.run('return (setMapZoom(5))')).toBe(true);
    expect(() => env.run('updateMap()')).not.toThrow();
  });

  it('rejects a zoom below the Mudlet minimum of 3.0', () => {
    expect(env.run('return (setMapZoom(2))')).toBeNull();
    expect(env.run('return (setMapZoom(0))')).toBeNull();
  });
});

describe('connectToServer — port validation', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('rejects out-of-range ports before attempting a connection', () => {
    // Mudlet's contract is (nil, errMsg) naming the bad port.
    expect(env.run('local _, e = connectToServer("example.org", 0) return e'))
      .toMatch(/invalid port number 0/);
    expect(env.run('local _, e = connectToServer("example.org", 99999) return e'))
      .toMatch(/invalid port number 99999/);
  });
});

// setMsdpValue is the bridge from a decoded MSDP variable into the Lua `msdp`
// global (mirrors setGmcpValue → gmcp). The receive pipeline's parsing is
// covered in tests/mud/protocol/msdp.test.ts; here we confirm the value lands
// in the expected Lua shape.
describe('msdp global — setMsdpValue', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('exposes an empty msdp table before any packet', () => {
    expect(env.run('return type(msdp)')).toBe('table');
  });

  it('writes a scalar variable to the flat top-level key', () => {
    env.rt.setMsdpValue('HEALTH', '5000');
    expect(env.run('return msdp.HEALTH')).toBe('5000');
  });

  it('writes nested table values reachable by key', () => {
    env.rt.setMsdpValue('ROOM', { VNUM: '6008', EXITS: { n: '6011' } });
    expect(env.run('return msdp.ROOM.VNUM')).toBe('6008');
    expect(env.run('return msdp.ROOM.EXITS.n')).toBe('6011');
  });

  it('replaces the whole top-level key on update (no sibling merge)', () => {
    env.rt.setMsdpValue('ROOM', { VNUM: '1' });
    env.rt.setMsdpValue('ROOM', { NAME: 'elsewhere' });
    expect(env.run('return msdp.ROOM.VNUM')).toBe(null);
    expect(env.run('return msdp.ROOM.NAME')).toBe('elsewhere');
  });
});

// setMsspValue is the bridge from a decoded MSSP variable into the Lua `mssp`
// global (mirrors setMsdpValue → msdp). Subnegotiation parsing is covered in
// tests/mud/protocol/mssp.test.ts; here we confirm the value lands in the
// expected flat Lua shape.
describe('mssp global — setMsspValue', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('exposes an empty mssp table before any packet', () => {
    expect(env.run('return type(mssp)')).toBe('table');
  });

  it('writes scalar status fields to flat top-level keys', () => {
    env.rt.setMsspValue('PLAYERS', '52');
    env.rt.setMsspValue('UPTIME', '1234567890');
    expect(env.run('return mssp.PLAYERS')).toBe('52');
    expect(env.run('return mssp.UPTIME')).toBe('1234567890');
  });

  it('replaces an existing value on update', () => {
    env.rt.setMsspValue('PLAYERS', '52');
    env.rt.setMsspValue('PLAYERS', '60');
    expect(env.run('return mssp.PLAYERS')).toBe('60');
  });
});

// Mapper data completeness: room/area user-data, grid mode, getAreaTableSwap
// and resetRoomArea. All are pure MapStore operations; these drive the real
// Lua globals end-to-end (wasmoon → MapStore → back) on an empty in-memory map.
describe('room user data — getAllRoomUserData / clearRoomUserData(Item) / resetRoomArea', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('round-trips and clears all room user data', () => {
    env.run('addRoom(10)');
    env.run('setRoomUserData(10, "name", "Square")');
    env.run('setRoomUserData(10, "terrain", "grass")');
    expect(env.run('return (getAllRoomUserData(10)).name')).toBe('Square');
    expect(env.run('return (getAllRoomUserData(10)).terrain')).toBe('grass');
    // clear one item
    expect(env.run('return (clearRoomUserDataItem(10, "terrain"))')).toBe(true);
    expect(env.run('return (getAllRoomUserData(10)).terrain')).toBe(null);
    // clear the rest
    expect(env.run('return (clearRoomUserData(10))')).toBe(true);
    expect(env.run('return next(getAllRoomUserData(10))')).toBe(null);
    // a second clear finds nothing
    expect(env.run('return (clearRoomUserData(10))')).toBe(false);
  });

  it('reports the miss for a non-existent room', () => {
    // Mudlet reports every one of these misses as (nil, errMsg).
    expect(env.run('return (getAllRoomUserData(999))')).toBeNull();
    expect(env.run('return (clearRoomUserData(999))')).toBeNull();
    expect(env.run('return (clearRoomUserDataItem(999, "x"))')).toBeNull();
    expect(env.run('return (resetRoomArea(999))')).toBeNull();
  });

  it('resetRoomArea moves a room to the void area (-1)', () => {
    // addRoom's areaID must name an existing area — Mudlet does not create one
    // on demand, it parks the room in -1 and reports the failed placement.
    const aid = env.run('return (addAreaName("Vault"))') as number;
    env.run(`addRoom(20, ${aid})`);
    expect(env.run('return getRoomArea(20)')).toBe(aid);
    expect(env.run('return (resetRoomArea(20))')).toBe(true);
    expect(env.run('return getRoomArea(20)')).toBe(-1);
  });
});

describe('area user data + grid mode + getAreaTableSwap', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('round-trips and clears area user data', () => {
    const aid = env.run('return (addAreaName("Forest"))') as number;
    expect(typeof aid).toBe('number');
    expect(env.run(`return (setAreaUserData(${aid}, "music", "birds.mp3"))`)).toBe(true);
    expect(env.run(`return (getAreaUserData(${aid}, "music"))`)).toBe('birds.mp3');
    expect(env.run(`return (getAllAreaUserData(${aid})).music`)).toBe('birds.mp3');
    expect(env.run(`return (clearAreaUserDataItem(${aid}, "music"))`)).toBe(true);
    expect(env.run(`return (getAreaUserData(${aid}, "music"))`)).toBeNull();
    expect(env.run(`return (clearAreaUserData(${aid}))`)).toBe(false); // already empty
  });

  it('reports the miss for a non-existent area', () => {
    expect(env.run('return (getAreaUserData(999, "k"))')).toBeNull();
    expect(env.run('return (getAllAreaUserData(999))')).toBeNull();
    expect(env.run('return (setAreaUserData(999, "k", "v"))')).toBeNull();
    expect(env.run('return (getGridMode(999))')).toBeNull();
    expect(env.run('return (setGridMode(999, true))')).toBe(false);
  });

  it('toggles grid mode on an area', () => {
    const aid = env.run('return (addAreaName("Cave"))') as number;
    expect(env.run(`return (getGridMode(${aid}))`)).toBe(false);
    expect(env.run(`return (setGridMode(${aid}, true))`)).toBe(true);
    expect(env.run(`return (getGridMode(${aid}))`)).toBe(true);
  });

  it('getAreaTableSwap keys areas by integer id', () => {
    const aid = env.run('return (addAreaName("Plains"))') as number;
    expect(env.run(`return (getAreaTableSwap())[${aid}]`)).toBe('Plains');
  });
});

describe('special exits — clearSpecialExits / lockSpecialExit / hasSpecialExitLock', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('locks and unlocks a special exit (toID arg ignored)', () => {
    env.run('addRoom(1); addRoom(2); addSpecialExit(1, 2, "enter portal")');
    expect(env.run('return (hasSpecialExitLock(1, 2, "enter portal"))')).toBe(false);
    expect(env.run('return (lockSpecialExit(1, 2, "enter portal", true))')).toBe(true);
    expect(env.run('return (hasSpecialExitLock(1, 99, "enter portal"))')).toBe(true); // toID ignored
    // reflected in getSpecialExits lock flag
    expect(env.run('return (getSpecialExits(1))[2]["enter portal"]')).toBe('1');
    expect(env.run('return (lockSpecialExit(1, 2, "enter portal", false))')).toBe(true);
    expect(env.run('return (hasSpecialExitLock(1, 2, "enter portal"))')).toBe(false);
  });

  it('reports errors for an unknown room or command', () => {
    env.run('addRoom(1)');
    expect(env.run('return (hasSpecialExitLock(1, 2, "nope"))')).toBe(null);      // no such command
    expect(env.run('return (hasSpecialExitLock(999, 2, "x"))')).toBe(null);       // no such room
    expect(env.run('return (lockSpecialExit(999, 2, "x", true))')).toBeNull();    // no such room
  });

  it('clears all special exits on a room', () => {
    env.run('addRoom(1); addRoom(2); addRoom(3)');
    env.run('addSpecialExit(1, 2, "enter portal"); addSpecialExit(1, 3, "climb rope")');
    expect(env.run('return (next(getSpecialExitsSwap(1)))')).not.toBe(null);
    expect(env.run('return (clearSpecialExits(1))')).toBe(true);
    expect(env.run('return (next(getSpecialExitsSwap(1)))')).toBe(null);
    expect(env.run('return (clearSpecialExits(999))')).toBe(false);
  });
});

describe('getAllRoomEntrances', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('lists rooms with a stock or special exit into the room, sorted & deduped', () => {
    env.run('addRoom(1); addRoom(2); addRoom(3)');
    env.run('setExit(2, 1, "north")');         // 2 -> 1 (stock)
    env.run('addSpecialExit(3, 1, "fall")');   // 3 -> 1 (special)
    expect(env.run('return #getAllRoomEntrances(1)')).toBe(2);
    expect(env.run('return (getAllRoomEntrances(1))[1]')).toBe(2);
    expect(env.run('return (getAllRoomEntrances(1))[2]')).toBe(3);
    // a room nothing points to
    expect(env.run('return #getAllRoomEntrances(2)')).toBe(0);
  });

  it('reports the miss for an unknown room', () => {
    expect(env.run('return (getAllRoomEntrances(999))')).toBeNull();
  });
});

describe('getAreaExits', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('returns area-crossing exits in both summary and full forms', () => {
    const a1 = env.run('return (addAreaName("A"))') as number;
    const a2 = env.run('return (addAreaName("B"))') as number;
    env.run(`addRoom(1, ${a1}); addRoom(2, ${a2})`);
    env.run('setExit(1, 2, "east")'); // crosses from area A to area B
    expect(env.run(`return #getAreaExits(${a1})`)).toBe(1);
    expect(env.run(`return (getAreaExits(${a1}))[1]`)).toBe(1);
    expect(env.run(`return (getAreaExits(${a1}, true))[1].east`)).toBe(2);
    // the destination area has no outgoing cross-area exits
    expect(env.run(`return #getAreaExits(${a2})`)).toBe(0);
  });

  it('reports the miss for an unknown area', () => {
    expect(env.run('return (getAreaExits(999))')).toBeNull();
  });
});

describe('1-indexed mapper wrappers — getAreaRooms1 / getRoomsByPosition1 / getExitStubsNames', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('getAreaRooms1 / getRoomsByPosition1 are 1-indexed', () => {
    const a = env.run('return (addAreaName("Z"))') as number;
    env.run(`addRoom(10, ${a}); addRoom(11, ${a})`);
    env.run('setRoomCoordinates(10, 5, 5, 0)');
    expect(env.run(`return #getAreaRooms1(${a})`)).toBe(2);
    expect(env.run(`return (getAreaRooms1(${a}))[1]`)).toBe(10);
    const p = env.run(`return (getRoomsByPosition1(${a}, 5, 5, 0))[1]`);
    expect(p).toBe(10);
  });

  it('getExitStubsNames maps stub codes to direction names (1-indexed)', () => {
    env.run('addRoom(1)');
    env.run('setExitStub(1, "north", true); setExitStub(1, 4, true)'); // north + east
    expect(env.run('return (getExitStubsNames(1))[1]')).toBe('north');
    expect(env.run('return (getExitStubsNames(1))[2]')).toBe('east');
    expect(env.run('return (getExitStubsNames(999))')).toBeNull();
  });
});

describe('getCustomLines1 / removeCustomLine', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('getCustomLines1 returns an empty table for a room with no lines, nil for a miss', () => {
    env.run('addRoom(1)');
    expect(env.run('return next(getCustomLines1(1))')).toBe(null); // empty table
    expect(env.run('return (getCustomLines1(999))')).toBe(null);   // missing room
  });

  it('removeCustomLine is false when the room or line is absent', () => {
    env.run('addRoom(1)');
    expect(env.run('return (removeCustomLine(1, "north"))')).toBe(false); // no such line
    expect(env.run('return (removeCustomLine(999, "north"))')).toBe(false); // no such room
  });
});

describe('searchRoom / searchRoomUserData / searchAreaUserData', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('searchRoom by id returns the name, by name returns matches', () => {
    env.run('addRoom(1); setRoomName(1, "Town Square")');
    env.run('addRoom(2); setRoomName(2, "Town Gate")');
    env.run('addRoom(3); setRoomName(3, "Forest")');
    expect(env.run('return (searchRoom(1))')).toBe('Town Square');
    expect(env.run('return (searchRoom(999))')).toBeNull();
    // case-insensitive substring by default
    expect(env.run('return (searchRoom("town"))[1]')).toBe('Town Square');
    expect(env.run('return (searchRoom("town"))[2]')).toBe('Town Gate');
    expect(env.run('return (searchRoom("town"))[3]')).toBe(null);
    // exact match
    expect(env.run('return (searchRoom("Forest", false, true))[3]')).toBe('Forest');
    expect(env.run('return next(searchRoom("Town", false, true))')).toBe(null); // no exact "Town"
  });

  it('searchRoomUserData covers the keys / values / matching-ids forms', () => {
    env.run('addRoom(1); setRoomUserData(1, "terrain", "grass")');
    env.run('addRoom(2); setRoomUserData(2, "terrain", "water")');
    env.run('addRoom(3); setRoomUserData(3, "terrain", "grass")');
    expect(env.run('return (searchRoomUserData())[1]')).toBe('terrain');     // all keys
    expect(env.run('return (searchRoomUserData("terrain"))[1]')).toBe('grass'); // values, sorted
    expect(env.run('return (searchRoomUserData("terrain"))[2]')).toBe('water');
    expect(env.run('return (searchRoomUserData("terrain", "grass"))[1]')).toBe(1); // matching ids
    expect(env.run('return (searchRoomUserData("terrain", "grass"))[2]')).toBe(3);
  });

  it('searchAreaUserData mirrors searchRoomUserData for areas', () => {
    const a = env.run('return (addAreaName("A"))') as number;
    env.run(`setAreaUserData(${a}, "music", "birds.mp3")`);
    expect(env.run('return (searchAreaUserData())[1]')).toBe('music');
    expect(env.run('return (searchAreaUserData("music"))[1]')).toBe('birds.mp3');
    expect(env.run(`return (searchAreaUserData("music", "birds.mp3"))[1]`)).toBe(a);
  });
});

describe('connectExitStub', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('explicit (fromID, toID, direction) form connects both ways and clears the stubs', () => {
    env.run('addRoom(1); addRoom(2)');
    env.run('setExitStub(1, "north", true); setExitStub(2, "south", true)');
    expect(env.run('return (connectExitStub(1, 2, "north"))')).toBe(true);
    expect(env.run('return (getRoomExits(1)).north')).toBe(2);
    expect(env.run('return (getRoomExits(2)).south')).toBe(1);
    expect(env.run('return #getExitStubs1(1)')).toBe(0);
  });

  it('toID-only form connects the single matching reverse-stub pair', () => {
    env.run('addRoom(3); addRoom(4)');
    env.run('setExitStub(3, "east", true); setExitStub(4, "west", true)');
    expect(env.run('return (connectExitStub(3, 4))')).toBe(true);
    expect(env.run('return (getRoomExits(3)).east')).toBe(4);
    expect(env.run('return (getRoomExits(4)).west')).toBe(3);
  });

  it('direction-only form finds the nearest in-area room with a reverse stub', () => {
    const a = env.run('return (addAreaName("C"))') as number;
    env.run(`addRoom(5, ${a}); addRoom(6, ${a})`);
    env.run('setRoomCoordinates(5, 0, 0, 0); setRoomCoordinates(6, 1, 0, 0)'); // 6 is east of 5
    env.run('setExitStub(5, "east", true); setExitStub(6, "west", true)');
    expect(env.run('return (connectExitStub(5, "east"))')).toBe(true);
    expect(env.run('return (getRoomExits(5)).east')).toBe(6);
  });

  it('reports an error when there is no stub in the given direction', () => {
    env.run('addRoom(1); addRoom(2)');
    expect(env.run('return (connectExitStub(1, 2, "up"))')).toBeNull();
  });
});

// getRooms / getRoomCoordinates go through the raw lua_* marshalling path
// (issue #2). These guard that the raw build keeps the exact shapes the
// generic path produced: getRooms → { [roomId] = name } (wasmoon stringifies
// the integer object keys), getRoomCoordinates → three unpacked values.
describe('raw map getters — getRooms / getRoomCoordinates', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('getRooms returns { [roomId] = name } keyed by INTEGER id (Mudlet parity)', () => {
    env.run('addRoom(7); setRoomName(7, "Plaza")');
    env.run('addRoom(8); setRoomName(8, "Alley")');
    // Mudlet keys getRooms() by integer room id; the raw marshalling builds
    // integer keys directly (the generic path used to stringify them).
    expect(env.run('return getRooms()[7]')).toBe('Plaza');
    expect(env.run('return getRooms()[8]')).toBe('Alley');
    // The string form is NOT present — keys are genuine integers.
    expect(env.run('return getRooms()["7"]')).toBeNull();
    expect(env.run('local n=0 for _ in pairs(getRooms()) do n=n+1 end return n')).toBe(2);
  });

  it('getRoomCoordinates unpacks to x, y, z (and three nils on a miss)', () => {
    env.run('addRoom(9); setRoomCoordinates(9, 3, -4, 2)');
    expect(env.run('return (select(1, getRoomCoordinates(9)))')).toBe(3);
    expect(env.run('return (select(2, getRoomCoordinates(9)))')).toBe(-4);
    expect(env.run('return (select(3, getRoomCoordinates(9)))')).toBe(2);
    // Mudlet pushes nothing for an unknown room, so all three destructure to nil.
    expect(env.run('return (getRoomCoordinates(999))')).toBeNull();
    expect(env.run('return (select(3, getRoomCoordinates(999)))')).toBeNull();
  });
});

describe('deleteMap', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('wipes all rooms', () => {
    env.run('addRoom(1); addRoom(2)');
    expect(env.run('return (roomExists(1))')).toBe(true);
    expect(env.run('return (deleteMap())')).toBe(true);
    expect(env.run('return (roomExists(1))')).toBe(false);
    expect(env.run('return (roomExists(2))')).toBe(false);
  });
});

describe('setRoomHidden / getRoomHidden / getHiddenRooms', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('round-trips the hidden flag and lists hidden rooms per area', () => {
    const a = env.run('return (addAreaName("HX"))') as number;
    env.run(`addRoom(1, ${a}); addRoom(2, ${a}); addRoom(3, ${a})`);
    expect(env.run('return (getRoomHidden(1))')).toBe(false);
    expect(env.run('return (setRoomHidden(1, true))')).toBe(true);
    expect(env.run('return (setRoomHidden(3, true))')).toBe(true);
    expect(env.run('return (getRoomHidden(1))')).toBe(true);
    expect(env.run('return (getRoomHidden(2))')).toBe(false);
    expect(env.run(`return #getHiddenRooms(${a})`)).toBe(2);
    expect(env.run(`return (getHiddenRooms(${a}))[1]`)).toBe(1);
    expect(env.run(`return (getHiddenRooms(${a}))[2]`)).toBe(3);
    // Unhiding removes it from the list
    expect(env.run('return (setRoomHidden(1, false))')).toBe(true);
    expect(env.run(`return #getHiddenRooms(${a})`)).toBe(1);
    expect(env.run(`return (getHiddenRooms(${a}))[1]`)).toBe(3);
  });

  it('reports errors for unknown room or area', () => {
    expect(env.run('return (setRoomHidden(999, true))')).toBeNull();
    expect(env.run('return (getRoomHidden(999))')).toBeNull();
    expect(env.run('return (getHiddenRooms(999))')).toBeNull();
  });

  it('round-trips through binary save+load via the v20 fallback userData key', () => {
    env.run('addRoom(1); addRoom(2); setRoomHidden(1, true)');
    const map = env.api.map.toMudletMapForSave();
    expect(map.rooms[1].userData['system.fallback_hidden']).toBe('true');
    expect(map.rooms[2].userData['system.fallback_hidden']).toBeUndefined();
    // The live room must not have the fallback key smeared on it
    expect(env.api.map.toMudletMap().rooms[1].userData['system.fallback_hidden']).toBeUndefined();

    // Round-trip back: clear the store, reload from the save snapshot, and
    // verify the hidden flag was lifted back into the side-table.
    env.api.map.deleteMap();
    env.api.map.loadFromBinary(map);
    expect(env.api.map.getRoomHidden(1)).toBe(true);
    expect(env.api.map.getRoomHidden(2)).toBe(false);
    // The userData entry must have been taken out (not left on the room).
    expect(env.api.map.getRoomUserData(1, 'system.fallback_hidden')).toBeUndefined();
  });
});

describe('gotoRoom', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  // Mudlet's gotoRoom never walks the path itself — it fills the speedWalk*
  // tables and calls the mapper package's doSpeedWalk, which owns the pacing,
  // balance checks and off-path recovery.
  it('hands the path to the mapper doSpeedWalk instead of sending it', () => {
    env.run('addRoom(1); addRoom(2); addRoom(3); setExit(1, 2, "north"); setExit(2, 3, "north"); centerview(1)');
    env.run('walked = nil; function doSpeedWalk() walked = table.concat(speedWalkDir, ",") end');
    const before = env.mainOutput.length;
    expect(env.run('return (gotoRoom(3))')).toBe(true);
    expect(env.run('return #speedWalkDir')).toBe(2);
    expect(env.run('return walked')).toBe('n,n');
    // The mapper decides when to send, so gotoRoom itself echoed nothing.
    expect(env.mainOutput.slice(before).join('')).toBe('');
    env.run('doSpeedWalk = nil');
  });

  // Mudlet raises "attempt to call a nil value" here and the player doesn't
  // move; mudix keeps the pre-delegation behaviour so a profile with no mapper
  // package installed still walks.
  it('falls back to sending the moves when no mapper defines doSpeedWalk', () => {
    env.run('addRoom(1); addRoom(2); setExit(1, 2, "north"); centerview(1)');
    const before = env.mainOutput.length;
    expect(env.run('return (gotoRoom(2))')).toBe(true);
    expect(env.run('return #speedWalkDir')).toBe(1);
    // the move command ("n" for a north exit) was echoed to the main window
    // (Mudlet-style: bare command, no "> " prefix, wrapped in the echo color)
    expect(env.mainOutput.length).toBeGreaterThan(before);
    const echoed = env.mainOutput.slice(before).join('').replace(/\[[0-9;]*m/g, '');
    expect(echoed).toContain('n');
  });

  it('fails when the current room is unknown', () => {
    env.run('addRoom(1); addRoom(2); setExit(1, 2, "north")'); // no centerview
    // Mudlet's gotoRoom reports a bad argument as (nil, errMsg); only the
    // no-path-found case uses warnArgumentValue's false form.
    expect(env.run('return (gotoRoom(2))')).toBeNull();
  });

  it('fails for an invalid target room', () => {
    env.run('addRoom(1); centerview(1)');
    expect(env.run('return (gotoRoom(999))')).toBeNull();
  });
});

// The map's double-click-to-walk gesture (Mudlet T2DMap::initiateSpeedWalk →
// Host::startSpeedWalk). MapPanel resolves the clicked room and calls
// WindowManager.startSpeedWalk, which lands in the Lua entry point below.
describe('map double-click speedwalk', () => {
  let env: TestRuntime;
  beforeEach(async () => {
    env = await createTestRuntime();
    // The wiring ScriptingEngine does for the real app.
    env.session.windows.onStartSpeedWalk = (from, to) => env.rt.startSpeedWalk(from, to);
  });
  afterEach(() => env.dispose());

  it('pathfinds from the player room and hands the route to doSpeedWalk', () => {
    env.run('addRoom(1); addRoom(2); addRoom(3); setExit(1, 2, "east"); setExit(2, 3, "east"); centerview(1)');
    env.run('walked = nil; function doSpeedWalk() walked = table.concat(speedWalkDir, ",") end');
    expect(env.session.windows.startSpeedWalk(3)).toBe(true);
    expect(env.run('return walked')).toBe('e,e');
  });

  it('ignores a double-click on a room that is not in the map', () => {
    env.run('addRoom(1); centerview(1)');
    expect(env.session.windows.startSpeedWalk(999)).toBe(false);
  });

  it('reports the mapper message when no path exists', () => {
    env.run('addRoom(1); addRoom(2); centerview(1)'); // no exits between them
    env.run('walked = nil; function doSpeedWalk() walked = "walked" end');
    const before = env.mainOutput.length;
    expect(env.session.windows.startSpeedWalk(2)).toBe(true);
    expect(env.run('return walked')).toBeNull();
    expect(env.mainOutput.slice(before).join('')).toContain('Cannot find a path from 1 to 2');
  });

  // An unknown player room pathfinds from -1 (Mudlet: from the missing profile
  // entry, room 0) and so finds nothing — reported, not silently dropped.
  it('reports rather than walks when the player room is unknown', () => {
    env.run('addRoom(1); addRoom(2); setExit(1, 2, "east")'); // no centerview
    const before = env.mainOutput.length;
    expect(env.session.windows.startSpeedWalk(2)).toBe(true);
    expect(env.mainOutput.slice(before).join('')).toContain('Cannot find a path from -1 to 2');
  });

  // mudlet.custom_speedwalk hands the endpoints to a mapper that does its own
  // pathfinding; Mudlet computes no path at all in that case.
  it('honours mudlet.custom_speedwalk', () => {
    env.run('addRoom(1); addRoom(2); centerview(1)'); // no path between them
    env.run('mudlet = mudlet or {}; mudlet.custom_speedwalk = true');
    env.run('endpoints = nil; function doSpeedWalk() endpoints = speedWalkFrom .. "->" .. speedWalkTo end');
    expect(env.session.windows.startSpeedWalk(2)).toBe(true);
    expect(env.run('return endpoints')).toBe('1->2');
    env.run('mudlet.custom_speedwalk = nil');
  });
});

describe('stopwatches — setStopWatchName / getStopWatchBrokenDownTime', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('getStopWatchBrokenDownTime decomposes elapsed time', () => {
    env.run('createStopWatch("w1", false)');           // named, not running
    env.run('adjustStopWatch("w1", 3661.5)');          // 1h 1m 1s 500ms
    expect(env.run('return (getStopWatchBrokenDownTime("w1")).hours')).toBe(1);
    expect(env.run('return (getStopWatchBrokenDownTime("w1")).minutes')).toBe(1);
    expect(env.run('return (getStopWatchBrokenDownTime("w1")).seconds')).toBe(1);
    expect(env.run('return (getStopWatchBrokenDownTime("w1")).milliSeconds')).toBe(500);
    expect(env.run('return (getStopWatchBrokenDownTime(99999))')).toBeNull();
  });

  it('setStopWatchName assigns and rejects duplicates / unknown watches', () => {
    const id = env.run('return (createStopWatch())') as number;
    expect(env.run(`return (setStopWatchName(${id}, "combat"))`)).toBe(true);
    // resolvable by the new name now
    expect(env.run('return type(getStopWatchBrokenDownTime("combat"))')).toBe('table');
    const id2 = env.run('return (createStopWatch())') as number;
    expect(env.run(`return (setStopWatchName(${id2}, "combat"))`)).toBeNull(); // duplicate
    expect(env.run('return (setStopWatchName(88888, "x"))')).toBeNull();        // unknown
  });
});

describe('media — loadMusicFile / purgeMediaCache', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('loadMusicFile returns a boolean and does not throw (no AudioContext in node)', () => {
    // node test env has no AudioContext, so preload returns false — the point is
    // it round-trips a boolean cleanly through both call shapes.
    expect(env.run('return (loadMusicFile("song.mp3"))')).toBe(false);
    expect(env.run('return (loadMusicFile({name = "song.mp3"}))')).toBe(false);
  });

  it('purgeMediaCache returns true', () => {
    expect(env.run('return (purgeMediaCache())')).toBe(true);
  });
});

// createCommandLine overlay primitive — registry + dispatcher routing for the
// cmd-line APIs that grew a third branch (main bar / userwindow / overlay).
describe('createCommandLine — overlay primitive + routing', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('creates an overlay cmd line and registers it under the cmdLines manager', () => {
    expect(env.run('return (createCommandLine("c1", 10, 20, 200, 24))')).toBe(true);
    expect(env.session.cmdLines.has('c1')).toBe(true);
    // Re-create with the same name returns false (Mudlet semantics).
    expect(env.run('return (createCommandLine("c1", 0, 0, 100, 20))')).toBe(false);
  });

  it('moveWindow / resizeWindow / hideWindow / showWindow / raiseWindow / lowerWindow target overlay cmd lines', () => {
    env.run('createCommandLine("c2", 10, 10, 100, 20)');
    env.run('moveWindow("c2", 200, 300)');
    env.run('resizeWindow("c2", 250, 32)');
    const list = env.session.cmdLines.list('main');
    const c = list.find(c => c.name === 'c2')!;
    expect(c.x).toBe(200);
    expect(c.y).toBe(300);
    expect(c.width).toBe(250);
    expect(c.height).toBe(32);
    expect(env.run('return (showWindow("c2"))')).toBe(true);
    // hideWindow has no return value in Mudlet; verify by inspecting state.
    env.run('hideWindow("c2")');
    expect(c.visible).toBe(false);
    expect(env.run('return (raiseWindow("c2"))')).toBe(true);
    expect(env.run('return (lowerWindow("c2"))')).toBe(true);
  });

  it('printCmdLine / appendCmdLine / clearCmdLine / getCmdLine round-trip through the overlay', () => {
    env.run('createCommandLine("c3", 0, 0, 100, 20)');
    env.run('printCmdLine("c3", "hello")');
    expect(env.run('return (getCmdLine("c3"))')).toBe('hello');
    env.run('appendCmdLine("c3", " world")');
    expect(env.run('return (getCmdLine("c3"))')).toBe('hello world');
    env.run('clearCmdLine("c3")');
    expect(env.run('return (getCmdLine("c3"))')).toBe('');
  });

  it('enableCommandLine / disableCommandLine toggle the input enabled flag', () => {
    env.run('createCommandLine("c4", 0, 0, 100, 20)');
    expect(env.run('return (disableCommandLine("c4"))')).toBe(true);
    const c = env.session.cmdLines.list('main').find(c => c.name === 'c4')!;
    expect(c.enabled).toBe(false);
    expect(env.run('return (enableCommandLine("c4"))')).toBe(true);
    expect(c.enabled).toBe(true);
  });

  it('setCmdLineStyleSheet stores the QSS string on the overlay', () => {
    env.run('createCommandLine("c5", 0, 0, 100, 20)');
    expect(env.run('return (setCmdLineStyleSheet("c5", "background: red;"))')).toBe(true);
    const c = env.session.cmdLines.list('main').find(c => c.name === 'c5')!;
    expect(c.styleSheet).toBe('background: red;');
  });

  it('setCmdLineAction binds an Enter callback that fires from the registered control', () => {
    env.run('createCommandLine("c6", 0, 0, 100, 20)');
    env.run('captured = nil; setCmdLineAction("c6", function(text) captured = text end)');
    const action = env.session.cmdLines.getAction('c6');
    expect(action).toBeTruthy();
    action!('hi from input');
    expect(env.run('return captured')).toBe('hi from input');
    // resetCmdLineAction clears the binding.
    env.run('resetCmdLineAction("c6")');
    expect(env.session.cmdLines.getAction('c6')).toBe(null);
  });

  it('deleteCommandLine destroys the overlay and fires sysCommandLineDeleted', () => {
    env.run('createCommandLine("c7", 0, 0, 100, 20)');
    // Register a Lua-side handler so we can verify the event raise lands.
    env.run([
      'sawDeletedName = nil',
      'registerAnonymousEventHandler("sysCommandLineDeleted", function(_, name) sawDeletedName = name end)',
    ].join('\n'));
    expect(env.run('return (deleteCommandLine("c7"))')).toBe(true);
    expect(env.session.cmdLines.has('c7')).toBe(false);
    expect(env.run('return sawDeletedName')).toBe('c7');
    // Re-deleting an already-removed name is false.
    expect(env.run('return (deleteCommandLine("c7"))')).toBe(false);
  });
});

// lockExit / hasExitLock — now JS-bound; pathfinding reads room.exitLocks.
describe('lockExit / hasExitLock', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('locks and unlocks a stock-direction exit by name', () => {
    env.run('addRoom(100); addRoom(101); setExit(100, 101, "north")');
    expect(env.run('return (hasExitLock(100, "north"))')).toBe(false);
    expect(env.run('return (lockExit(100, "north", true))')).toBe(true);
    expect(env.run('return (hasExitLock(100, "north"))')).toBe(true);
    expect(env.run('return (lockExit(100, "north", false))')).toBe(true);
    expect(env.run('return (hasExitLock(100, "north"))')).toBe(false);
  });

  it('accepts the 1-12 integer direction code', () => {
    env.run('addRoom(200)');
    expect(env.run('return (lockExit(200, 4, true))')).toBe(true); // 4 = east
    expect(env.run('return (hasExitLock(200, "east"))')).toBe(true);
    expect(env.run('return (hasExitLock(200, 4))')).toBe(true);
  });

  it('rejects an unknown direction or missing room', () => {
    env.run('addRoom(300)');
    expect(env.run('return (lockExit(300, "sideways", true))')).toBe(false);
    expect(env.run('return (lockExit(9999, "north", true))')).toBe(false);
    expect(env.run('return (hasExitLock(9999, "north"))')).toBeNull();
  });

  it('honoured by pathfinding (locked direction is routed around)', () => {
    // Build a tiny 3-room corridor: 1 →north→ 2 →north→ 3
    env.run('addRoom(1); addRoom(2); addRoom(3); setExit(1, 2, "north"); setExit(2, 3, "north")');
    // First confirm the unlocked path exists.
    const before = env.run('return getPath(1, 3)') as boolean;
    expect(before).toBe(true);
    // Locking the only outbound exit from room 1 should make the path fail.
    env.run('lockExit(1, "north", true)');
    expect(env.run('return getPath(1, 3)')).toBe(false);
  });
});


// ── New Mudlet-API batch (media getters, profile info, tree-walker miss paths,
//    getProfileStats shape, getPackageInfo) ──────────────────────────────────
// These exercise the wasmoon binding + Bridge.lua wrappers end to end. The
// tree-walking and package/module-info *data* paths live in ScriptingEngine
// (not wired into createTestRuntime), so here we assert the binding shapes and
// the documented miss behaviour; the engine logic is covered by typecheck.
describe('Mudlet-API batch — Lua bindings', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('getCommandSeparator defaults to ";;"', () => {
    expect(env.run('return getCommandSeparator()')).toBe(';;');
  });

  it('profile information set/get/clear round-trips', () => {
    expect(env.run('return getProfileInformation()')).toBe('');
    expect(env.run('return (setProfileInformation("a hardy adventurer"))')).toBe(true);
    expect(env.run('return getProfileInformation()')).toBe('a hardy adventurer');
    expect(env.run('return (clearProfileInformation())')).toBe(true);
    expect(env.run('return getProfileInformation()')).toBe('');
  });

  it('profile icon: empty by default, reset is a no-op success', () => {
    expect(env.run('return getProfileIcon()')).toBe('');
    expect(env.run('return (resetProfileIcon())')).toBe(true);
  });

  it('setProfileIcon fails (nil, errMsg) with no path or no filesystem', () => {
    // Blank path → refused before the filesystem is consulted, in Mudlet's
    // words (Miscallaneous_spec pins the message).
    expect(env.run('local ok = setProfileIcon(""); return ok')).toBeNull();
    expect(env.run('local _, err = setProfileIcon(""); return err'))
      .toBe('a blank string is not a valid icon file path');
    // A path but no VFS (the test runtime is built with vfs=null).
    expect(env.run('local ok = setProfileIcon("hero.png"); return ok')).toBeNull();
    expect(env.run('local _, err = setProfileIcon("hero.png"); return err')).toContain('no profile filesystem');
  });

  it('setProfileIcon reads the VFS image and inlines it as a data: URI', () => {
    // Inject a fake VFS so the binding's readBinaryFile path runs without IDB.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // "‰PNG" signature bytes
    (env.rt as unknown as { vfs: unknown }).vfs = {
      profilePath: '/profiles/test',
      // "missing.png" is absent; everything else reads back the PNG bytes.
      exists: (p: string) => p !== 'missing.png',
      readBinaryFile: (p: string) => {
        if (p === 'missing.png') throw new Error('ENOENT');
        return png;
      },
      // setProfileIcon also drops a copy at <profile>/profileicon for a linked
      // Mudlet folder; the test only cares that it doesn't throw.
      writeBinaryFile: () => {},
      deleteFile: () => {},
    };
    expect(env.run('return (setProfileIcon("hero.png"))')).toBe(true);
    expect(env.run('return select(2, setProfileIcon("hero.png"))')).toBe('hero.png');
    expect(env.run('return getProfileIcon()')).toBe('data:image/png;base64,iVBORw==');
    // Extension drives the MIME type.
    env.run('setProfileIcon("hero.svg")');
    expect(env.run('return getProfileIcon()')).toContain('data:image/svg+xml;base64,');
    // Missing file → (nil, errMsg); the previous icon is untouched.
    expect(env.run('local ok = setProfileIcon("missing.png"); return ok')).toBeNull();
    expect(env.run('local _, err = setProfileIcon("missing.png"); return err')).toContain("doesn't exist");
    // resetProfileIcon clears back to empty.
    expect(env.run('return (resetProfileIcon())')).toBe(true);
    expect(env.run('return getProfileIcon()')).toBe('');
  });

  it('holdingModifiers exact-matches the (empty) held set in node', () => {
    // No DOM in the node harness → nothing is held → only the 0 (None) mask matches.
    expect(env.run('return holdingModifiers(0)')).toBe(true);
    expect(env.run('return holdingModifiers(0x04000000)')).toBe(false);
  });

  it('media getters return empty lists when nothing is playing', () => {
    expect(env.run('return #getPlayingMusic()')).toBe(0);
    expect(env.run('return #getPlayingVideos()')).toBe(0);
    expect(env.run('return #getPausedVideos()')).toBe(0);
    expect(env.run('return #getPausedSounds()')).toBe(0);
    expect(env.run('return #getPausedMusic()')).toBe(0);
  });

  it('pauseMusic takes no arguments or a filter table, never a bare channel', () => {
    // Mudlet's signature (TLuaInterpreterMedia.cpp): pauseSounds/pauseMusic
    // accept nothing or a table, and reject anything else. mudix used to take a
    // bare channel string; Media_spec pins the upstream contract, so the string
    // form is gone rather than quietly accepted alongside it.
    expect(() => env.run('pauseMusic(); pauseMusic({tag = "ambient"})')).not.toThrow();
    expect(() => env.run('pauseMusic("ambient")')).toThrow(/needs to be a table/);
    expect(() => env.run('pauseSounds(5)')).toThrow(/needs to be a table/);
  });

  it('getProfileStats returns a fully-populated zeroed table', () => {
    expect(env.run('return getProfileStats().triggers.total')).toBe(0);
    expect(env.run('return getProfileStats().triggers.patterns.active')).toBe(0);
    expect(env.run('return getProfileStats().aliases.temp')).toBe(0);
    expect(env.run('return getProfileStats().gifs.active')).toBe(0);
    expect(env.run('return getProfileStats().scripts.active')).toBe(0);
  });

  it('getPackageInfo returns an (empty) table, or "" for an absent key', () => {
    expect(env.run('return type(getPackageInfo("nope"))')).toBe('table');
    expect(env.run('return getPackageInfo("nope", "author")')).toBe('');
  });

  it('findItems returns an empty table with no engine wiring', () => {
    expect(env.run('return type(findItems("x", "alias"))')).toBe('table');
    expect(env.run('return #findItems("x", "alias")')).toBe(0);
  });

  it('ancestors / isAncestorsActive report the documented miss shape', () => {
    expect(env.run('return (ancestors(123, "trigger"))')).toBe(false);
    // nil, not false: for isAncestorsActive false is a real answer ("an
    // ancestor is disabled"), so the miss has to look different from it.
    expect(env.run('return (isAncestorsActive(123, "trigger"))')).toBeNull();
    expect(env.run('local _, err = isAncestorsActive(123, "trigger"); return err'))
      .toContain('does not exist');
    // A type there is no family for is told apart from a plain miss.
    expect(env.run('local _, err = isAncestorsActive(1, "sandwich"); return err'))
      .toContain("invalid item type 'sandwich' given");
  });

  it('setModuleInfo / setPackageInfo are callable (no-op without an install)', () => {
    // Both return false here because the engine setter callbacks aren't wired
    // in this harness; the point is the binding exists and doesn't throw.
    expect(() => env.run('setModuleInfo("m", "k", "v"); setPackageInfo("p", "k", "v")')).not.toThrow();
  });
});

// ── New batch: trigger constructors, map menus/labels, auditAreas, overline,
//    utf8 helpers, and the misc forwarders ─────────────────────────────────────

describe('trigger constructors — permPromptTrigger / permBeginOfLineStringTrigger / tempAnsiColorTrigger', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  // The perm* tree-creation callbacks live in ScriptingEngine (not wired here),
  // so these return -1 — the point is the Lua binding + Bridge.lua wrapper run
  // cleanly and produce the documented miss value.
  // Mudlet's perm* raise when creation fails rather than returning the -1 the
  // JS layer reports — mudlet-lua's permGroup pcalls them and turns the raise
  // into a `false` return. This harness doesn't wire ScriptingEngine's CRUD
  // callback, so every creation fails; the argument marshalling still runs
  // before the failure, which is what these cover.
  it('permPromptTrigger / permBeginOfLineStringTrigger raise without engine wiring', () => {
    expect(() => env.run('return (permPromptTrigger("p", "", [[echo("x")]]))'))
      .toThrow(/permPromptTrigger: cannot create trigger/);
    expect(() => env.run('return (permBeginOfLineStringTrigger("b", "", {"hp"}, [[echo("x")]]))'))
      .toThrow(/permBeginOfLineStringTrigger: cannot create trigger/);
    expect(() => env.run('return (permBeginOfLineStringTrigger("g", "", {}, ""))'))
      .toThrow(/permBeginOfLineStringTrigger: cannot create trigger/); // empty → group
  });

  it('tempAnsiColorTrigger registers and returns a numeric id', () => {
    const id = env.run('return (tempAnsiColorTrigger(31, -1, [[echo("hit\\n")]]))');
    expect(typeof id).toBe('number');
    // A second registration yields a distinct id.
    const id2 = env.run('return (tempAnsiColorTrigger(-1, -1, function() end))');
    expect(id2).not.toBe(id);
  });
});

describe('map menus — addMapMenu / getMapMenus / removeMapMenu', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('registers, lists (keyed by display name → parent), and removes submenus', () => {
    env.run('addMapMenu("combat", nil, "Combat")');
    env.run('addMapMenu("sub", "combat")');
    // Mudlet's getMapMenus() shape: { [displayName] = parentName }, where a
    // top-level menu's value is the string "top-level". A menu registered
    // without a display name keys by its unique name (they're the same string).
    expect(env.run('return (getMapMenus()).Combat')).toBe('top-level');
    expect(env.run('return (getMapMenus()).combat')).toBeNull();
    expect(env.run('return (getMapMenus()).sub')).toBe('combat');
    // getMapMenus(true) keys by unique name instead, so entries can be matched
    // to the `parent` getMapEvents reports.
    expect(env.run('return (getMapMenus(true)).combat["display name"]')).toBe('Combat');
    expect(env.run('return (getMapMenus(true)).combat.parent')).toBe('top-level');
    expect(env.api.map.getMapMenus().length).toBe(2);
    expect(env.run('return next(getMapMenus()) ~= nil')).toBe(true);
    // removal
    env.run('removeMapMenu("sub")');
    expect(env.run('return (getMapMenus()).sub')).toBe(null);
    expect(env.api.map.getMapMenus().length).toBe(1);
  });
});

describe('map labels — createMapLabel / createMapImageLabel / deleteMapLabel', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('creates a text label, queryable by id and by text, then deletes it', () => {
    const a = env.run('return (addAreaName("Lbl"))') as number;
    const id = env.run(`return (createMapLabel(${a}, "Town", 1, 2, 0, 255, 0, 0, 0, 0, 0, 1, 12, true, false))`);
    expect(id).toBe(0); // first label in the area
    expect(env.run(`return (getMapLabels(${a}))[0]`)).toBe('Town');
    expect(env.run(`return (getMapLabel(${a}, 0)).Text`)).toBe('Town');
    expect(env.run(`return (getMapLabel(${a}, 0)).X`)).toBe(1);
    expect(env.run(`return (getMapLabel(${a}, 0)).FgColor.r`)).toBe(255);
    // by-text lookup returns matches keyed by id
    expect(env.run(`return (getMapLabel(${a}, "Town"))[0].Text`)).toBe('Town');
    // delete
    expect(env.run(`return (deleteMapLabel(${a}, 0))`)).toBe(true);
    expect(env.run(`return next(getMapLabels(${a}))`)).toBe(null);
    expect(env.run(`return (deleteMapLabel(${a}, 0))`)).toBe(false); // already gone
  });

  it('createMapImageLabel stores the image path in Pixmap; both reject a missing area', () => {
    const a = env.run('return (addAreaName("Img"))') as number;
    const id = env.run(`return (createMapImageLabel(${a}, "pic.png", 0, 0, 0, 32, 32, 1, true, true))`);
    expect(id).toBe(0);
    expect(env.run(`return (getMapLabel(${a}, 0)).Pixmap`)).toBe('pic.png');
    expect(env.run(`return (getMapLabel(${a}, 0)).Width`)).toBe(32);
    expect(env.run('return (createMapLabel(999, "x", 0,0,0, 0,0,0, 0,0,0, 1, 12, true, false))')).toBe(-1);
    expect(env.run('return (createMapImageLabel(999, "p", 0,0,0, 1,1, 1, true, true))')).toBe(-1);
  });
});

describe('auditAreas', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  // The public API keeps area membership and room.area in lock-step (addRoom /
  // setRoomArea auto-create and re-file), so an inconsistency is injected
  // white-box to exercise the repair + reporting path.
  it('drops a dangling room id from an area list and reports it', () => {
    const a = env.run('return (addAreaName("Aud"))') as number;
    env.run(`addRoom(1, ${a}); addRoom(2, ${a})`);
    const store = env.api.map as unknown as { areas: Map<number, { rooms: number[] }> };
    store.areas.get(a)!.rooms.push(999); // 999 isn't a real room
    env.run('_audit = auditAreas()');
    expect(env.run('return _audit.fixedAreas') as number).toBeGreaterThanOrEqual(1);
    expect(env.run('return #_audit.danglingRefs')).toBe(1);
    expect(env.run('return _audit.danglingRefs[1]')).toBe(999);
    expect(env.run('return _audit.checkedRooms')).toBe(2);
    // The dangling id was removed; the two real rooms remain.
    expect(env.run(`return #getAreaRooms1(${a})`)).toBe(2);
  });

  it('is a clean no-op on a consistent map (no fixes, no orphans)', () => {
    const a = env.run('return (addAreaName("OK"))') as number;
    env.run(`addRoom(1, ${a}); addRoom(2, ${a})`);
    env.run('_a2 = auditAreas()');
    expect(env.run('return _a2.fixedAreas')).toBe(0);
    expect(env.run('return #_a2.orphanRooms')).toBe(0);
    expect(env.run('return #_a2.danglingRefs')).toBe(0);
  });
});

describe('setOverline — ANSI SGR 53/55 rendering', () => {
  it('SGR 53 turns overline on and 55 turns it off in the rendered HTML', () => {
    const buf = new AnsiAwareBuffer('\x1b[53mUP\x1b[55mDOWN');
    const html = buf.toHtml();
    expect(html).toContain('overline');
    // The post-55 run must not carry the overline decoration.
    expect(html).toMatch(/overline[^<]*<\/span>[^]*DOWN/);
  });

  it('plain text with no overline has no overline decoration', () => {
    expect(new AnsiAwareBuffer('plain').toHtml()).not.toContain('overline');
  });
});

describe('setOverline — Lua binding round-trips through getTextFormat', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('applies to the current selection and is read back by getTextFormat', () => {
    env.run('createBuffer("tb"); cecho("tb", "Hello\\n"); selectCurrentLine("tb")');
    env.run('setOverline("tb", true)');
    expect(env.run('return (getTextFormat("tb")).overline')).toBe(true);
  });

  it('setTextFormat carries the overline flag through to getTextFormat', () => {
    env.run('createBuffer("tb2"); cecho("tb2", "X\\n"); selectCurrentLine("tb2")');
    // setTextFormat(win, r1,g1,b1, r2,g2,b2, bold, underline, italics, strikeout, overline, reverse)
    env.run('setTextFormat("tb2", 0,0,0, 255,255,255, false, false, false, false, true, false)');
    expect(env.run('return (getTextFormat("tb2")).overline')).toBe(true);
  });
});

describe('utf8.patternEscape', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('utf8.patternEscape escapes Lua pattern magic characters', () => {
    expect(env.run('return (utf8.patternEscape("a.b*c"))')).toBe('a%.b%*c');
  });
});

describe('misc forwarders — appendLog / getProfileTabNumber / getProfiles / ioprint / clearVisitedLinks / closeMudlet / loadVideoFile', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('getProfileTabNumber is always 1 (single-profile web app)', () => {
    expect(env.run('return getProfileTabNumber()')).toBe(1);
    expect(env.run('return getProfileTabNumber("anything")')).toBe(1);
  });

  it('getProfiles is keyed by name with a loaded entry for the active profile', () => {
    // Keyed by connection name ("Test" — the harness's seeded connection), and
    // the active profile is marked loaded (it holds the current tab). Detailed
    // field/cross-tab coverage lives in getProfiles.test.ts.
    expect(env.run('return getProfiles().Test ~= nil')).toBe(true);
    expect(env.run('return getProfiles().Test.loaded')).toBe(true);
  });

  it('appendLog reports nothing at all, logger or not', () => {
    // Mudlet's appendLog returns no values: whether the text reached a log is
    // not something the caller is told (Miscallaneous_spec asserts the arity).
    expect(env.run('return select("#", appendLog("a manual line"))')).toBe(0);
  });

  it('ioprint / clearVisitedLinks / closeMudlet are callable without throwing', () => {
    expect(() => env.run('ioprint("hello", 42, nil)')).not.toThrow();
    expect(() => env.run('clearVisitedLinks()')).not.toThrow();
    // closeMudlet → disconnect() (no socket) + close callback (unwired) — clean.
    expect(() => env.run('closeMudlet()')).not.toThrow();
  });

  it('loadVideoFile is fire-and-forget and takes the table form only', () => {
    // preload is async, so the binding returns true once the request is
    // accepted (mirrors playVideoFile). Unlike its sound and music siblings the
    // video load has no positional form — a bare filename is refused rather
    // than quietly preloading nothing (Media_spec pins the message).
    expect(env.run('return (loadVideoFile({name = "https://example.org/x.webm"}))')).toBe(true);
    expect(env.run('return (loadVideoFile({name = "clip.mp4"}))')).toBe(true);
    expect(env.run('local ok, e = pcall(loadVideoFile, "clip.mp4") return e'))
      .toContain('loadVideoFile: needs to be a table');
    expect(env.run('local ok, e = pcall(loadVideoFile, {}) return e'))
      .toContain('loadVideoFile: missing name');
  });
});

// getClipboardText / setClipboardText — the session text clipboard (separate
// from copy/paste's rich-text buffer). No DOM/navigator in this harness, so the
// best-effort OS-clipboard sync is a no-op and the in-process mirror is the
// authoritative value the round-trip asserts.
describe('getClipboardText / setClipboardText — session text clipboard', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('round-trips text through the session mirror', () => {
    expect(env.run('return getClipboardText()')).toBe('');
    expect(env.run('return (setClipboardText("hello world"))')).toBe(true);
    expect(env.run('return getClipboardText()')).toBe('hello world');
    // Overwrites on a second set.
    env.run('setClipboardText("second")');
    expect(env.run('return getClipboardText()')).toBe('second');
  });

  it('coerces non-string args and never throws without a clipboard API', () => {
    expect(() => env.run('setClipboardText(nil)')).not.toThrow();
    expect(env.run('return getClipboardText()')).toBe('');
    env.run('setClipboardText(42)');
    expect(env.run('return getClipboardText()')).toBe('42');
  });

  it('is distinct from the rich-text copy/paste clipboard', () => {
    // Setting the text clipboard must not populate the copy() buffer.
    env.run('setClipboardText("text-only")');
    // appendBuffer pulls from the rich-text clipboard (empty here) — a no-op,
    // so the text clipboard value is unaffected.
    env.run('appendBuffer()');
    expect(env.run('return getClipboardText()')).toBe('text-only');
  });
});

// createScrollBox / deleteScrollBox — overlay scrollable container (Geyser.ScrollBox).
// Mirrors the createCommandLine coverage: asserts manager state via session.scrollBoxes.
describe('createScrollBox / deleteScrollBox — overlay container + routing', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('creates a scroll box on main and rejects a duplicate name', () => {
    expect(env.run('return (createScrollBox("sb1", 10, 20, 300, 200))')).toBe(true);
    expect(env.session.scrollBoxes.has('sb1')).toBe(true);
    const sb = env.session.scrollBoxes.get('sb1')!;
    expect([sb.parent, sb.x, sb.y, sb.width, sb.height, sb.visible]).toEqual(['main', 10, 20, 300, 200, true]);
    // Re-create with the same name returns false (Mudlet semantics).
    expect(env.run('return (createScrollBox("sb1", 0, 0, 100, 100))')).toBe(false);
  });

  it('honours an explicit parent viewport argument', () => {
    expect(env.run('return (createScrollBox("uw", "sb2", 5, 5, 120, 90))')).toBe(true);
    expect(env.session.scrollBoxes.get('sb2')!.parent).toBe('uw');
    // The 6-arg form lists under the named parent, not main.
    expect(env.session.scrollBoxes.list('uw').map(s => s.name)).toEqual(['sb2']);
    expect(env.session.scrollBoxes.list('main').some(s => s.name === 'sb2')).toBe(false);
  });

  it('moveWindow / resizeWindow / hideWindow / showWindow / raiseWindow / lowerWindow target scroll boxes', () => {
    env.run('createScrollBox("sb3", 0, 0, 100, 100)');
    env.run('moveWindow("sb3", 40, 60)');
    env.run('resizeWindow("sb3", 250, 180)');
    const sb = env.session.scrollBoxes.get('sb3')!;
    expect([sb.x, sb.y, sb.width, sb.height]).toEqual([40, 60, 250, 180]);
    expect(env.run('return (showWindow("sb3"))')).toBe(true);
    env.run('hideWindow("sb3")');
    expect(env.session.scrollBoxes.get('sb3')!.visible).toBe(false);
    // raiseWindow / lowerWindow reorder the box in the shared overlay
    // z-registry (overlayLayerOrder.ts) — compare against a sibling box.
    env.run('createScrollBox("sb3sib", 0, 0, 100, 100)');
    const z = (n: string) => env.session.scrollBoxes.overlayZ.getZ('main', 'scrollboxes', n);
    expect(env.run('return (raiseWindow("sb3"))')).toBe(true);
    expect(z('sb3')).toBeGreaterThan(z('sb3sib'));
    expect(env.run('return (lowerWindow("sb3"))')).toBe(true);
    expect(z('sb3')).toBeLessThan(z('sb3sib'));
  });

  it('windowType reports "scrollbox"', () => {
    env.run('createScrollBox("sb4", 0, 0, 100, 100)');
    expect(env.run('return (windowType("sb4"))')).toBe('scrollbox');
  });

  it('deleteScrollBox destroys the box and fires sysScrollBoxDeleted', () => {
    env.run('createScrollBox("sb5", 0, 0, 100, 100)');
    env.run([
      'sawDeletedName = nil',
      'registerAnonymousEventHandler("sysScrollBoxDeleted", function(_, name) sawDeletedName = name end)',
    ].join('\n'));
    expect(env.run('return (deleteScrollBox("sb5"))')).toBe(true);
    expect(env.session.scrollBoxes.has('sb5')).toBe(false);
    expect(env.run('return sawDeletedName')).toBe('sb5');
    // Re-deleting an already-removed name is false (and fires nothing).
    expect(env.run('return (deleteScrollBox("sb5"))')).toBe(false);
  });
});

// tempComplexRegexTrigger is Bridge.lua over the temp regex-trigger primitive.
// Firing is driven via api.triggers.processTemp (same as the tempLineTrigger
// Lua-binding tests above). The highlight path reads the live main-console line
// and needs the full render pipeline, so it isn't exercised here.
describe('tempComplexRegexTrigger — Lua binding', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('returns a numeric id and runs the code, with capture groups in matches', () => {
    const id = env.run(String.raw`return tempComplexRegexTrigger("", "^hello ([a-z]+)$", [==[ seen = matches[2] ]==], 0, 0, 0, 0, 0)`);
    expect(typeof id).toBe('number');
    expect(id as number).toBeGreaterThan(0);
    env.api.triggers.processTemp('hello world');
    expect(env.run('return seen')).toBe('world');
  });

  it('expireAfter self-removes after N fires', () => {
    env.run(String.raw`count = 0; tempComplexRegexTrigger("", "^tick$", [==[ count = count + 1 ]==], 0, 0, 0, 0, 0, nil, nil, nil, 0, 0, 2)`);
    env.api.triggers.processTemp('tick');
    env.api.triggers.processTemp('tick');
    env.api.triggers.processTemp('tick'); // already expired
    expect(env.run('return count')).toBe(2);
  });

  it('re-calling with an existing name replaces the prior trigger', () => {
    env.run(String.raw`hits = ""`);
    env.run(String.raw`tempComplexRegexTrigger("dup", "^ping$", [==[ hits = hits .. "A" ]==], 0, 0, 0, 0, 0)`);
    env.run(String.raw`tempComplexRegexTrigger("dup", "^ping$", [==[ hits = hits .. "B" ]==], 0, 0, 0, 0, 0)`);
    env.api.triggers.processTemp('ping');
    expect(env.run('return hits')).toBe('B'); // only the replacement fires
  });

  it('killTrigger(name) removes a named temp complex trigger', () => {
    env.run(String.raw`fired = false; tempComplexRegexTrigger("byname", "^go$", [==[ fired = true ]==], 0, 0, 0, 0, 0)`);
    expect(env.run('return (killTrigger("byname"))')).toBe(true);
    env.api.triggers.processTemp('go');
    expect(env.run('return fired')).toBe(false);
  });

  it('killTrigger(id) removes by numeric id', () => {
    const id = env.run(String.raw`fired2 = false; return tempComplexRegexTrigger("", "^go$", [==[ fired2 = true ]==], 0, 0, 0, 0, 0)`) as number;
    expect(env.run(`return (killTrigger(${id}))`)).toBe(true);
    env.api.triggers.processTemp('go');
    expect(env.run('return fired2')).toBe(false);
  });

  it('accepts (and warns once for) unsupported flags without throwing or blocking the fire', () => {
    // multiline=1, filter=1, fireLength=3 are not honoured on a temp trigger;
    // the call must still register and fire the callback.
    expect(() => env.run(String.raw`okfire = false; tempComplexRegexTrigger("cx", "^run$", [==[ okfire = true ]==], 1, 0, 0, 1, 0, nil, nil, nil, 3, 1, nil)`)).not.toThrow();
    env.api.triggers.processTemp('run');
    expect(env.run('return okfire')).toBe(true);
  });
});

// exportAreaImage / resetProfile route through engine-owned callbacks (VFS write
// / runtime reinit) that aren't wired into createTestRuntime, so here we only
// verify the Lua bindings parse and degrade gracefully. The render→VFS path and
// the full profile reinit are exercised in the running app.
describe('exportAreaImage — Lua binding', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('returns (nil, errMsg) when no exporter/VFS is wired', () => {
    expect(env.run('return (exportAreaImage(1, "area1.png"))')).toBeNull();
    const msg = env.run('local _, m = exportAreaImage(1, "area1.png"); return m');
    expect(typeof msg).toBe('string');
    expect((msg as string).length).toBeGreaterThan(0);
  });

  it('rejects a non-numeric areaID', () => {
    expect(env.run('return (exportAreaImage("nope", "a.png"))')).toBeNull();
  });

  it('delegates to ScriptingAPI.exportAreaImage with coerced args', () => {
    const calls: Array<[number, string, number | undefined]> = [];
    env.api.setHost({
      ...env.api.engineHost,
      exportAreaImageToVfs: (areaId, filePath, zLevel) => {
        calls.push([areaId, filePath, zLevel]);
        return { path: `/profiles/test/${filePath}` };
      },
    });
    const [ok, path] = [
      env.run('return (exportAreaImage(7, "maps/area7.png", 2))'),
      env.run('local _, p = exportAreaImage(7, "maps/area7.png", 2); return p'),
    ];
    expect(ok).toBe(true);
    expect(path).toBe('/profiles/test/maps/area7.png');
    // Both calls ran; args coerced to (number, string, number).
    expect(calls[0]).toEqual([7, 'maps/area7.png', 2]);
  });
});

describe('resetProfile — Lua binding', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('is callable and invokes the wired callback without throwing', () => {
    let called = 0;
    env.api.setHost({ ...env.api.engineHost, resetProfile: () => { called++; } });
    expect(() => env.run('resetProfile()')).not.toThrow();
    expect(called).toBe(1);
  });

  it('is a no-op (no throw) when no engine is bound', () => {
    env.api.setHost(null);
    expect(() => env.run('resetProfile()')).not.toThrow();
  });
});

// getProfileStats's `temp` numbers come from these live engine counts (temp
// items aren't in the persisted tree). ScriptingEngine.getProfileStats folds
// tempCount into total/active; here we cover the source-of-truth getters.
describe('engine tempCount — live session-scoped temp items', () => {
  it('AliasEngine.tempCount tracks addTemp and disposal', () => {
    const e = new AliasEngine();
    expect(e.tempCount).toBe(0);
    const dispose = e.addTemp('^x$', () => {});
    e.addTemp('^y$', () => {});
    expect(e.tempCount).toBe(2);
    dispose();
    expect(e.tempCount).toBe(1);
  });

  it('TriggerEngine.tempCount tracks addTemp, addTempLine, and self-expiry', () => {
    const e = new TriggerEngine();
    expect(e.tempCount).toBe(0);
    const dispose = e.addTemp('hit', () => {}, 'substring');
    e.addTempLine(1, 1, () => {});
    expect(e.tempCount).toBe(2);
    dispose();
    expect(e.tempCount).toBe(1);
    // The line trigger fires once then self-expires, dropping the count to 0.
    e.processTemp('any');
    expect(e.tempCount).toBe(0);
  });

  it('TimerEngine.tempCount tracks addTemp and killTimer', () => {
    const e = new TimerEngine();
    expect(e.tempCount).toBe(0);
    const id = e.addTemp(100, () => {});
    expect(e.tempCount).toBe(1);
    e.killTimer(id);
    expect(e.tempCount).toBe(0);
  });

  it('KeyEngine.tempCount tracks addTemp and killKey', () => {
    const e = new KeyEngine();
    expect(e.tempCount).toBe(0);
    const id = e.addTemp('KeyA', [], () => {});
    expect(e.tempCount).toBe(1);
    e.killKey(id);
    expect(e.tempCount).toBe(0);
  });
});
