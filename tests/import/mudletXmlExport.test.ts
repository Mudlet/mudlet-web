import { describe, it, expect } from 'vitest';
import { serializeMudletXml, type SerializeInput } from '../../src/import/mudletXmlExport';
import { parseMudletXml } from '../../src/import/mudletXmlImport';
import type { ScriptNode, TimerNode, TriggerNode } from '../../src/storage/schema';

const EMPTY: SerializeInput = { scripts: [], aliases: [], triggers: [], timers: [], keys: [], buttons: [] };

function trigger(p: Partial<TriggerNode>): TriggerNode {
    return {
        id: 't', name: 'T', enabled: true, isGroup: false, parentId: null,
        patterns: [{ text: 'HP: (\\d+)', type: 'regex' }],
        code: 'echo("x")', language: 'lua', fireLength: 0, multipleMatches: false,
        multiline: false, delta: 0, isFilter: false, ...p,
    };
}

describe('serializeMudletXml — Mudlet format', () => {
    it('emits trigger flags as ATTRIBUTES, not child elements (the Mudlet shape)', () => {
        const xml = serializeMudletXml({ ...EMPTY, triggers: [trigger({ enabled: false, multiline: true, isFilter: true })] });
        // attributes Mudlet reads
        expect(xml).toContain('isActive="no"');
        expect(xml).toContain('isMultiline="yes"');
        expect(xml).toContain('isFilterTrigger="yes"');
        expect(xml).toContain('isTempTrigger="no"');
        expect(xml).toContain('isColorTriggerFg="no"');
        // NOT the old broken element form
        expect(xml).not.toContain('<isMultiline>');
        expect(xml).not.toContain('<isTempTrigger>');
    });

    it('emits the trigger child elements Mudlet expects, including color fields', () => {
        const xml = serializeMudletXml({ ...EMPTY, triggers: [trigger({})] });
        for (const tag of ['name', 'script', 'triggerType', 'conditonLineDelta', 'mStayOpen',
            'mCommand', 'packageName', 'mFgColor', 'mBgColor', 'mSoundFile',
            'colorTriggerFgColor', 'colorTriggerBgColor', 'regexCodeList', 'regexCodePropertyList']) {
            expect(xml).toContain(`<${tag}`);
        }
    });

    it('round-trips trigger flags through mudix import (export → import preserves them)', () => {
        const xml = serializeMudletXml({ ...EMPTY, triggers: [trigger({ multiline: true, multipleMatches: true, isFilter: true })] });
        const back = parseMudletXml(xml).triggers[0];
        expect(back).toMatchObject({ multiline: true, multipleMatches: true, isFilter: true });
    });

    it('orders script children name → packageName → script → eventHandlerList', () => {
        const script: ScriptNode = {
            id: 's', name: 'S', enabled: true, isGroup: false, parentId: null,
            code: '-- x', language: 'lua', eventHandlers: ['sysLoadEvent'],
        };
        const xml = serializeMudletXml({ ...EMPTY, scripts: [script] });
        expect(xml.indexOf('<packageName')).toBeLessThan(xml.indexOf('<script>'));
        expect(xml.indexOf('<script>')).toBeLessThan(xml.indexOf('<eventHandlerList'));
    });

    it('emits timer flags isTempTimer/isOffsetTimer as attributes', () => {
        const timer: TimerNode = {
            id: 'tm', name: 'Tm', enabled: true, isGroup: false, parentId: null,
            seconds: 5, code: '', language: 'lua', repeat: true,
        };
        const xml = serializeMudletXml({ ...EMPTY, timers: [timer] });
        expect(xml).toContain('isTempTimer="no"');
        expect(xml).toContain('isOffsetTimer="no"');
        expect(xml).not.toContain('<isTempTimer>');
    });
});

// triggerType, the sound trigger and the legacy colour-trigger state used to be
// hardcoded on the way out — triggerType always "0", mSoundFile always empty,
// the two colour-trigger colours always "#000000" and all four flags "no" —
// which erased them from the user's own profile on the next link-mode flush.
// Mudlet: XMLexport.cpp:1007-1008 (flags), :1017 (triggerType), :1024
// (mSoundFile), :1025-1026 (colours).
describe('serializeMudletXml — trigger fields that used to be hardcoded', () => {
    const full = (p: Partial<TriggerNode> = {}) => trigger({
        triggerType: 7,
        soundTrigger: true,
        soundFile: '/home/me/ding.wav',
        colorTrigger: true,
        colorTriggerFgColor: '#ff8800',
        colorTriggerBgColor: '#001122',
        ...p,
    });

    it('writes each field from the node instead of a constant', () => {
        const xml = serializeMudletXml({ ...EMPTY, triggers: [full()] });
        expect(xml).toContain('isSoundTrigger="yes"');
        expect(xml).toContain('isColorTrigger="yes"');
        expect(xml).toContain('<triggerType>7</triggerType>');
        expect(xml).toContain('<mSoundFile>/home/me/ding.wav</mSoundFile>');
        expect(xml).toContain('<colorTriggerFgColor>#ff8800</colorTriggerFgColor>');
        expect(xml).toContain('<colorTriggerBgColor>#001122</colorTriggerBgColor>');
    });

    it('round-trips them all back through the importer', () => {
        const back = parseMudletXml(serializeMudletXml({ ...EMPTY, triggers: [full()] })).triggers[0];
        expect(back).toMatchObject({
            triggerType: 7,
            soundTrigger: true,
            soundFile: '/home/me/ding.wav',
            colorTrigger: true,
            colorTriggerFgColor: '#ff8800',
            colorTriggerBgColor: '#001122',
        });
    });

    it("emits Mudlet's own defaults for a trigger that carries none of them", () => {
        const xml = serializeMudletXml({ ...EMPTY, triggers: [trigger({})] });
        expect(xml).toContain('isSoundTrigger="no"');
        expect(xml).toContain('isColorTrigger="no"');
        expect(xml).toContain('<triggerType>0</triggerType>');
        expect(xml).toContain('<mSoundFile></mSoundFile>');
        // QColor() default-constructs invalid and .name() is "#000000".
        expect(xml).toContain('<colorTriggerFgColor>#000000</colorTriggerFgColor>');
        expect(xml).toContain('<colorTriggerBgColor>#000000</colorTriggerBgColor>');
    });

    // isColorTriggerFg/Bg are derived on export from mColorTriggerFgAnsi/BgAnsi
    // (XMLexport.cpp:1009-1010), and no Mudlet reader restores those, so a
    // trigger loaded from a file always writes "no" in desktop too.
    it('still writes the two derived colour flags as "no"', () => {
        const xml = serializeMudletXml({ ...EMPTY, triggers: [full()] });
        expect(xml).toContain('isColorTriggerFg="no"');
        expect(xml).toContain('isColorTriggerBg="no"');
    });
});
// The colorizer switch is its own field, mirroring TTrigger: mIsColorizerTrigger
// is what turns colorization on, while mFgColor/mBgColor are state of their own
// that desktop writes whatever the switch says. Deriving the switch from the
// colours' presence — as the exporter used to — erased a disabled trigger's
// colours from the user's own profile on the next link-mode flush.
describe('serializeMudletXml — trigger colorizer switch', () => {
    const coloured = (p: Partial<TriggerNode>) =>
        trigger({ highlight: { fg: '#ff0000', bg: '#ffff00' }, ...p });

    it('writes the switch from `colorize`, not from the colours', () => {
        expect(serializeMudletXml({ ...EMPTY, triggers: [coloured({ colorize: true })] }))
            .toContain('isColorizerTrigger="yes"');
        expect(serializeMudletXml({ ...EMPTY, triggers: [coloured({ colorize: false })] }))
            .toContain('isColorizerTrigger="no"');
    });

    it('keeps both colours on disk while the switch is off', () => {
        const xml = serializeMudletXml({ ...EMPTY, triggers: [coloured({ colorize: false })] });
        expect(xml).toContain('<mFgColor>#ff0000</mFgColor>');
        expect(xml).toContain('<mBgColor>#ffff00</mBgColor>');
    });

    it('round-trips switch and colours independently', () => {
        for (const colorize of [true, false]) {
            const xml = serializeMudletXml({ ...EMPTY, triggers: [coloured({ colorize })] });
            const back = parseMudletXml(xml).triggers[0];
            expect(back.colorize).toBe(colorize);
            expect(back.highlight).toEqual({ fg: '#ff0000', bg: '#ffff00' });
        }
    });

    it('writes "transparent" for a channel left on "keep"', () => {
        const xml = serializeMudletXml({
            ...EMPTY,
            triggers: [trigger({ colorize: true, highlight: { fg: '#ff0000' } })],
        });
        expect(xml).toContain('<mBgColor>transparent</mBgColor>');
        expect(parseMudletXml(xml).triggers[0].highlight).toEqual({ fg: '#ff0000', bg: undefined });
    });

    it('still says yes for a trigger saved before the switch existed', () => {
        const xml = serializeMudletXml({ ...EMPTY, triggers: [coloured({})] });
        expect(xml).toContain('isColorizerTrigger="yes"');
    });
});
