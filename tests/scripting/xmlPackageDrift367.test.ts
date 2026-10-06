// @vitest-environment node
//
// Issue #367: Mudlet package XML that drifted from desktop Mudlet PTB.
//
//  1. A colorizer trigger's mFgColor/mBgColor painted only as #rrggbb; desktop
//     reads them with QColor::fromString (names, #rgb, #aarrggbb, 9/12 digits).
//  2. Items marked isTempTrigger="yes" / isTempTimer="yes" were dropped on
//     import. Desktop loads them: the trigger exists and fires, the timer fires
//     once and is gone — and neither is written back to a save.
//  3. A timer folder's own script ran on the folder's interval. Desktop's
//     TTimer::execute never runs a folder; only the timers inside it fire.
//  4. eventHandlerList entries were trimmed; desktop registers them verbatim.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {},
            // Timer bodies land in the test's log (see `ran` below).
            run: (code: string) => { (globalThis as { __ran367?: string[] }).__ran367?.push(code); },
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
        }),
    },
}));

const { MudSession } = await import('../../src/mud/MudSession');
const { AliasEngine } = await import('../../src/mud/aliases/AliasEngine');
const { TriggerEngine, highlightColor } = await import('../../src/mud/triggers/TriggerEngine');
const { TimerEngine } = await import('../../src/mud/timers/TimerEngine');
const { KeyEngine } = await import('../../src/mud/keybindings/KeyEngine');
const { ScriptingEngine } = await import('../../src/scripting/ScriptingEngine');
const { useAppStore } = await import('../../src/storage/appStore');
const { parseMudletXml } = await import('../../src/import/mudletXmlImport');
const { serializeMudletXml } = await import('../../src/import/mudletXmlExport');
const { serializeProfileData } = await import('../../src/storage/profileVfsData');
import type { TimerNode, TriggerNode } from '../../src/storage/schema';

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
    querySelectorAll: () => [] as unknown[],
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;
const { Window } = await import('happy-dom');
g.DOMParser = new Window().DOMParser;

const CONN = 'drift-367-conn';

const trigger = (name: string, attrs: string, extra = '') => `
    <Trigger isActive="yes" isFolder="no" ${attrs} isMultiline="no" isPerlSlashGOption="no" isColorizerTrigger="yes" isFilterTrigger="no" isSoundTrigger="no" isColorTrigger="no" isColorTriggerFg="no" isColorTriggerBg="no">
      <name>${name}</name>
      <script>echo("${name}")</script>
      <triggerType>0</triggerType>
      <conditonLineDelta>0</conditonLineDelta>
      <mStayOpen>0</mStayOpen>
      <mCommand></mCommand>
      <packageName></packageName>
      ${extra}
      <mSoundFile></mSoundFile>
      <colorTriggerFgColor>#000000</colorTriggerFgColor>
      <colorTriggerBgColor>#000000</colorTriggerBgColor>
      <regexCodeList><string>${name} line</string></regexCodeList>
      <regexCodePropertyList><integer>0</integer></regexCodePropertyList>
    </Trigger>`;

const PACKAGE = `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <TriggerPackage>
    ${trigger('TT_temp', 'isTempTrigger="yes"', '<mFgColor>red</mFgColor><mBgColor>darkblue</mBgColor>')}
    ${trigger('TT_perm', 'isTempTrigger="no"', '<mFgColor>#0f0</mFgColor><mBgColor>#00f</mBgColor>')}
  </TriggerPackage>
  <TimerPackage>
    <Timer isActive="yes" isFolder="no" isTempTimer="yes" isOffsetTimer="no">
      <name>TF_tmp</name>
      <script>echo("TF_tmp")</script>
      <command>tf_tmp_command</command>
      <packageName></packageName>
      <time>00:00:01.000</time>
    </Timer>
    <TimerGroup isActive="yes" isFolder="yes" isTempTimer="no" isOffsetTimer="no">
      <name>TF_folder</name>
      <script>echo("TF_folder")</script>
      <command></command>
      <packageName></packageName>
      <time>00:00:01.000</time>
      <Timer isActive="yes" isFolder="no" isTempTimer="no" isOffsetTimer="no">
        <name>TF_child</name>
        <script>echo("TF_child")</script>
        <command></command>
        <packageName></packageName>
        <time>00:00:01.000</time>
      </Timer>
    </TimerGroup>
  </TimerPackage>
  <ScriptPackage>
    <Script isActive="yes" isFolder="no">
      <name>r16ws</name>
      <packageName></packageName>
      <script>-- handler</script>
      <eventHandlerList>
        <string> r16wsevt </string>
        <string></string>
      </eventHandlerList>
    </Script>
  </ScriptPackage>
</MudletPackage>`;

describe('XML package parity with desktop (mudlet-web#367)', () => {
    describe('1. colorizer colours are read as QColor reads them', () => {
        it.each([
            ['#ff0000', [255, 0, 0]],
            ['red', [255, 0, 0]],
            ['DarkBlue', [0, 0, 139]],
            ['#0f0', [0, 255, 0]],
            ['#00f', [0, 0, 255]],
            ['#80ff0000', [255, 0, 0]],
            ['#4000ff00', [0, 255, 0]],
            ['#fff000000', [255, 0, 0]],
            ['#000000fff', [0, 0, 255]],
        ])('%s paints %j', (spec, [r, g, b]) => {
            expect(highlightColor(spec)).toEqual({ space: 'rgb', r, g, b });
        });

        it.each(['', '#ff', 'not-a-colour', 'rgb(1,2,3)'])('%j paints nothing', spec => {
            expect(highlightColor(spec)).toBeNull();
        });
    });

    describe('2. temporary items load, and are never saved', () => {
        const result = parseMudletXml(PACKAGE);

        it('keeps an isTempTrigger="yes" trigger, marked temporary', () => {
            const temp = result.triggers.find(t => t.name === 'TT_temp');
            expect(temp).toMatchObject({ temporary: true, enabled: true, highlight: { fg: 'red', bg: 'darkblue' } });
            expect(result.triggers.find(t => t.name === 'TT_perm')?.temporary).toBeUndefined();
        });

        it('keeps an isTempTimer="yes" timer, as a one-shot temporary', () => {
            expect(result.timers.find(t => t.name === 'TF_tmp')).toMatchObject({ temporary: true, repeat: false, enabled: true, seconds: 1 });
            expect(result.timers.find(t => t.name === 'TF_child')).toMatchObject({ repeat: true });
            expect(result.timers.find(t => t.name === 'TF_child')?.temporary).toBeUndefined();
        });

        it('leaves temporaries, and anything under them, out of the XML export', () => {
            const kid: TriggerNode = { ...result.triggers.find(t => t.name === 'TT_perm')!, id: 'kid', name: 'TT_kid',
                parentId: result.triggers.find(t => t.name === 'TT_temp')!.id };
            const xml = serializeMudletXml({
                scripts: [], aliases: [], keys: [], buttons: [],
                triggers: [...result.triggers, kid], timers: result.timers,
            });
            expect(xml).toContain('<name>TT_perm</name>');
            expect(xml).not.toContain('TT_temp');
            expect(xml).not.toContain('TT_kid');
            expect(xml).not.toContain('TF_tmp');
            expect(xml).toContain('<name>TF_child</name>');
        });

        it('leaves temporary timers out of the profile save', () => {
            useAppStore.setState(st => ({
                connectionTimers: { ...st.connectionTimers, [CONN]: result.timers },
                connectionTriggers: { ...st.connectionTriggers, [CONN]: result.triggers },
            }));
            const saved = JSON.parse(serializeProfileData(CONN)) as { timers: TimerNode[]; triggers: TriggerNode[] };
            expect(saved.timers.map(t => t.name)).toEqual(['TF_folder', 'TF_child']);
            expect(saved.triggers.map(t => t.name)).toEqual(['TT_perm']);
        });
    });

    describe('3. timers at runtime', () => {
        let engine: InstanceType<typeof ScriptingEngine>;
        let ran: string[];
        let sent: string[];

        beforeEach(async () => {
            if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
                useAppStore.setState(s => ({
                    connections: [...s.connections, { id: CONN, name: 'Drift', url: 'ws://localhost' }],
                }));
            }
            useAppStore.setState(st => ({
                connectionTimers: { ...st.connectionTimers, [CONN]: parseMudletXml(PACKAGE).timers },
            }));
            engine = new ScriptingEngine(
                new MudSession(), new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
            );
            ran = [];
            sent = [];
            (globalThis as { __ran367?: string[] }).__ran367 = ran;
            const internals = engine as unknown as {
                hostSend: (cmd: string) => void;
                applyTimersFromStore: () => void;
            };
            await vi.waitFor(() => expect((engine as unknown as { runtimes: { lua: unknown } }).runtimes.lua).toBeTruthy());
            internals.hostSend = (cmd: string) => { sent.push(cmd); };
            vi.useFakeTimers();
            internals.applyTimersFromStore();
        });

        afterEach(() => {
            try { engine.destroy(); } catch { /* teardown best-effort */ }
            vi.useRealTimers();
        });

        it('never runs a folder\'s own script; its child fires every second', () => {
            vi.advanceTimersByTime(3000);
            expect(ran.filter(c => c.includes('TF_folder'))).toEqual([]);
            expect(ran.filter(c => c.includes('TF_child'))).toHaveLength(3);
        });

        it('fires a temporary timer once, script only, then removes it', () => {
            vi.advanceTimersByTime(3000);
            expect(ran.filter(c => c.includes('TF_tmp'))).toHaveLength(1);
            expect(sent).toEqual([]);
            const names = (useAppStore.getState().connectionTimers[CONN] ?? []).map(t => t.name);
            expect(names).not.toContain('TF_tmp');
        });
    });

    describe('4. eventHandlerList entries are kept verbatim', () => {
        it('registers " r16wsevt " with its spaces, and drops only an empty name', () => {
            const script = parseMudletXml(PACKAGE).scripts.find(s => s.name === 'r16ws');
            expect(script?.eventHandlers).toEqual([' r16wsevt ']);
        });
    });
});
