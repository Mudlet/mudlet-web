// @vitest-environment node

// System events checked against desktop Mudlet PTB side by side
// (Mudlet/mudlet-web#354), through the real Lua runtime: closeMudlet returning
// before the profile closes, a user window's own font size, the arguments and
// order of sysConsoleSizeChanged, unzipAsync's directory and late errors, and
// the rules addFileWatch follows. The engine-level half (resetProfile and the
// protocol events) is in sysEventDrift.test.ts; the echo refusal is in
// tests/mud/protocol/echo.test.ts.

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { configure, InMemory, mkdirSync, existsSync, statSync } from '@zenfs/core';
import { createTestRuntime, TEST_CONNECTION_ID, type TestRuntime } from '../createTestRuntime';
import { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';
import { useAppStore } from '../../src/storage/appStore';
import { StopwatchManager, isRefusal } from '../../src/scripting/StopwatchManager';

/** A stand-in for the `.main-viewport` element. Its content box shrinks with
 *  the padding the border insets write onto it, as a real one's does. */
function fakeViewport(width: number, height: number): HTMLElement {
    const style: Record<string, string> = {};
    const px = (v: string | undefined) => parseFloat(v ?? '') || 0;
    return {
        getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height }),
        get clientWidth() { return width - px(style.paddingLeft) - px(style.paddingRight); },
        get clientHeight() { return height - px(style.paddingTop) - px(style.paddingBottom); },
        style,
        addEventListener() {},
        removeEventListener() {},
    } as unknown as HTMLElement;
}

describe('closeMudlet returns before the profile closes (#354)', () => {
    let env: TestRuntime;
    beforeEach(async () => {
        env = await createTestRuntime();
        env.api.setHost({
            ...env.api.engineHost,
            raiseEvent: (event: string, args: unknown[]) => env.rt.emitEvent(event, args),
            raiseExitEvent: () => env.rt.emitEvent('sysExitEvent', []),
        });
    });
    afterEach(() => {
        vi.useRealTimers();
        env.dispose();
    });

    it('runs the rest of the calling script, and its sends, before sysExitEvent', () => {
        vi.useFakeTimers();
        const order: string[] = [];
        vi.spyOn(env.api, 'disconnect').mockImplementation(() => { order.push('disconnect'); });
        env.api.setCloseProfileCallback(() => order.push('close'));
        env.run(`L = {}
          registerAnonymousEventHandler("sysExitEvent", function()
            L[#L + 1] = "exit handler AFTER=" .. tostring(AFTER)
          end)`);
        env.run('L[#L + 1] = "before"; closeMudlet(); L[#L + 1] = "after closeMudlet"; AFTER = true');
        expect(env.run('return table.concat(L, "|")')).toBe('before|after closeMudlet');
        expect(order).toEqual([]);

        vi.runAllTimers();
        expect(env.run('return table.concat(L, "|")')).toBe('before|after closeMudlet|exit handler AFTER=true');
        expect(order).toEqual(['disconnect', 'close']);
    });
});

describe('resetProfile drops the stopwatches that are not persistent (#354)', () => {
    it('keeps a persistent watch and frees the rest', () => {
        const watches = new StopwatchManager();
        expect(watches.create('swN', true)).toBe(1);
        expect(watches.create('swPers', true)).toBe(2);
        expect(watches.setPersistence('swPers', true)).toBe(true);

        watches.removeNonPersistent();

        const gone = watches.getTime('swN');
        expect(isRefusal(gone) && gone.refused).toBe("stopwatch with name 'swN' not found");
        expect(isRefusal(watches.getTime('swPers'))).toBe(false);
        expect(Object.keys(watches.getAll())).toEqual(['2']);
        // The freed id is the lowest one again.
        expect(watches.create('next', false)).toBe(1);
    });
});

describe('Lua-side window events match desktop (#354)', () => {
    let env: TestRuntime;
    beforeEach(async () => {
        env = await createTestRuntime();
        env.session.windows.setConnectionId(TEST_CONNECTION_ID);
        useAppStore.getState().patchConnectionProfile(TEST_CONNECTION_ID,
            { outputBorders: undefined, showTimestamps: false, fontSize: 11 });
        env.session.windows.onRaiseEvent = (event, args) => env.rt.emitEvent(event, args);
        env.api.setHost({ ...env.api.engineHost, raiseEvent: (event: string, args: unknown[]) => env.rt.emitEvent(event, args) });
        env.run(`R = {}
          for _, ev in ipairs({"sysConsoleSizeChanged", "sysWindowResizeEvent", "sysFontChangeEvent"}) do
            registerAnonymousEventHandler(ev, function(e, ...)
              local parts = {e}
              for i = 1, select("#", ...) do parts[#parts + 1] = tostring((select(i, ...))) end
              R[#R + 1] = table.concat(parts, " ")
            end)
          end`);
    });
    afterEach(() => {
        useAppStore.getState().patchConnectionProfile(TEST_CONNECTION_ID,
            { outputBorders: undefined, showTimestamps: false, fontSize: 11 });
        env.dispose();
    });

    const events = () => env.run('return table.concat(R, "|")') as string;

    describe('user window font size', () => {
        it('is 10 on creation, whatever main is in, and does not follow main', () => {
            env.run('openUserWindow("uwA", false, false, "f")');
            expect(env.run('return getFontSize("uwA")')).toBe(10);
            expect(events()).toMatch(/^sysFontChangeEvent uwA .+ 10$/);

            env.run('R = {}; setFontSize("main", 15)');
            expect(env.run('return getFontSize("main")')).toBe(15);
            expect(env.run('return getFontSize("uwA")')).toBe(10);
            expect(events()).not.toMatch(/uwA/);

            env.run('openUserWindow("uwB", false, false, "f")');
            expect(env.run('return getFontSize("uwB")')).toBe(10);
        });

        it('still takes a size a script sets on it', () => {
            env.run('openUserWindow("uwC", false, false, "f"); setFontSize("uwC", 14)');
            expect(env.run('return getFontSize("uwC")')).toBe(14);
        });
    });

    describe('sysConsoleSizeChanged', () => {
        it('carries the timestamp gutter as a 4th argument, 0 while timestamps are hidden', () => {
            env.session.windows.registerMainViewport(fakeViewport(800, 160));
            env.session.windows.primeMainResize();
            expect(events().split('|').filter(e => e.startsWith('sysConsoleSizeChanged')))
                .toEqual(['sysConsoleSizeChanged main 100 10 0']);
        });

        it('reports the 13 columns of desktop\'s "hh:mm:ss.zzz " gutter while timestamps show', () => {
            useAppStore.getState().patchConnectionProfile(TEST_CONNECTION_ID, { showTimestamps: true });
            env.session.windows.registerMainViewport(fakeViewport(800, 160));
            env.session.windows.primeMainResize();
            expect(events().split('|').filter(e => e.startsWith('sysConsoleSizeChanged')))
                .toEqual(['sysConsoleSizeChanged main 100 10 13']);
        });

        it('comes before sysWindowResizeEvent on a resize', () => {
            env.session.windows.registerMainViewport(fakeViewport(800, 160));
            env.session.windows.primeMainResize();
            expect(events().split('|').map(e => e.split(' ')[0]))
                .toEqual(['sysConsoleSizeChanged', 'sysWindowResizeEvent']);
        });

        it('comes before sysWindowResizeEvent after setBorderTop / setBorderLeft', () => {
            env.session.windows.registerMainViewport(fakeViewport(800, 160));
            env.session.windows.primeMainResize();
            env.run('R = {}; setBorderTop(32)');
            env.run('setBorderLeft(16)');
            expect(events().split('|')).toEqual([
                'sysConsoleSizeChanged main 100 8 0',
                'sysWindowResizeEvent 800 128 main',
                'sysConsoleSizeChanged main 98 8 0',
                'sysWindowResizeEvent 784 128 main',
            ]);
        });
    });
});

const PROFILE = '/profiles/sysev354';

describe('profile files match desktop (#354)', () => {
    let t: TestRuntime;

    beforeAll(async () => {
        await configure({ mounts: { '/': InMemory } });
        mkdirSync(PROFILE, { recursive: true });
        // The constructor is private: mount() insists on IndexedDB or a linked
        // folder, neither of which exists under node.
        const Ctor = ProfileVFS as unknown as new (id: string, fs: unknown, source: string) => ProfileVFS;
        const vfs = new Ctor('sysev354', {}, 'idb');
        t = await createTestRuntime({ vfs });
        t.api.setHost({ ...t.api.engineHost, raiseEvent: (event: string, args: unknown[]) => t.rt.emitEvent(event, args) });
        t.run(`H = getMudletHomeDir()
          function put(path, text) local f = assert(io.open(path, "w")); f:write(text); f:close() end
          P = {}
          registerAnonymousEventHandler("sysPathChanged", function(_, path)
            P[#P + 1] = path:sub(#H + 2)
          end)
          U = {}
          for _, ev in ipairs({"sysUnzipDone", "sysUnzipError"}) do
            registerAnonymousEventHandler(ev, function(e, zip, dir)
              U[#U + 1] = e .. " " .. zip:sub(#H + 2) .. " " .. dir:sub(#H + 2)
            end)
          end`);
    });
    afterAll(() => t.dispose());

    /** Deliver what the timer queue holds — the notices a watch or an unzip
     *  queued — as the pump a running profile has would. */
    const pump = () => t.api.timers.pumpDue();
    const changed = (): string[] => {
        pump();
        const out = String(t.run('local s = table.concat(P, "|"); P = {}; return s'));
        return out === '' ? [] : out.split('|');
    };

    describe('unzipAsync with a missing or invalid zip', () => {
        beforeEach(() => { t.run('U = {}'); });

        it('creates the extract directory and reports the missing zip after it has returned', () => {
            expect(t.run('return unzipAsync(H .. "/nozip.zip", H .. "/out-missing")')).toBe(true);
            expect(existsSync(`${PROFILE}/out-missing`)).toBe(true);
            expect(statSync(`${PROFILE}/out-missing`).isDirectory()).toBe(true);
            // Nothing yet: the call has returned and the error is still queued.
            expect(t.run('return #U')).toBe(0);
            pump();
            expect(t.run('return table.concat(U, "|")')).toBe('sysUnzipError nozip.zip out-missing/');
        });

        it('creates the extract directory for a file that is not a zip, and reports it later', () => {
            t.run('put(H .. "/bad.zip", "this is not a zip")');
            expect(t.run('return unzipAsync(H .. "/bad.zip", H .. "/out-bad/")')).toBe(true);
            expect(statSync(`${PROFILE}/out-bad`).isDirectory()).toBe(true);
            expect(t.run('return #U')).toBe(0);
            pump();
            expect(t.run('return table.concat(U, "|")')).toBe('sysUnzipError bad.zip out-bad/');
        });
    });

    describe('addFileWatch / sysPathChanged follow QFileSystemWatcher', () => {
        beforeEach(() => {
            changed();
        });

        it('a watched directory reports children added or removed, not writes into them', () => {
            t.run(`lfs.mkdir(H .. "/wd"); lfs.mkdir(H .. "/wd/sub"); put(H .. "/wd/old.txt", "1")`);
            changed();
            expect(t.run('return addFileWatch(H .. "/wd")')).toBe(true);

            t.run('put(H .. "/wd/old.txt", "2")');
            expect(changed()).toEqual([]);
            t.run('put(H .. "/wd/sub/inner.txt", "x")');
            expect(changed()).toEqual([]);

            t.run('put(H .. "/wd/new.txt", "x")');
            expect(changed()).toEqual(['wd']);
            t.run('os.remove(H .. "/wd/new.txt")');
            expect(changed()).toEqual(['wd']);
            t.run('removeFileWatch(H .. "/wd")');
        });

        it('a watched file that is deleted reports once and loses its watch', () => {
            t.run('put(H .. "/wf.txt", "1")');
            expect(t.run('return addFileWatch(H .. "/wf.txt")')).toBe(true);
            t.run('put(H .. "/wf.txt", "2")');
            expect(changed()).toEqual(['wf.txt']);

            t.run('os.remove(H .. "/wf.txt")');
            expect(changed()).toEqual(['wf.txt']);
            t.run('put(H .. "/wf.txt", "again")');
            expect(changed()).toEqual([]);
            expect(t.run('return removeFileWatch(H .. "/wf.txt")')).toBe(false);
        });

        it('adding a watch on a path already watched answers false', () => {
            t.run('put(H .. "/twice.txt", "1")');
            expect(t.run('return addFileWatch(H .. "/twice.txt")')).toBe(true);
            expect(t.run('return addFileWatch(H .. "/twice.txt")')).toBe(false);
            expect(t.run('return removeFileWatch(H .. "/twice.txt")')).toBe(true);
            expect(t.run('return removeFileWatch(H .. "/twice.txt")')).toBe(false);
        });

        it('a missing path is still refused with desktop\'s message', () => {
            expect(t.run('local ok, err = addFileWatch(H .. "/nope"); return tostring(ok) .. "|" .. err'))
                .toBe(`nil|path '${PROFILE}/nope' does not exist`);
        });
    });
});
