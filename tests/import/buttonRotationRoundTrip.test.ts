// Issue #70 item 5: button rotation had no control and no home in the model,
// and the exporter hard-coded `<buttonRotation>0</buttonRotation>` — so a
// package authored in Mudlet lost its rotated buttons the first time mudix
// saved it back. The toolbar's filler offset (`<buttonFillerOffset>`, Mudlet
// #9332) had never been modelled at all.
import { describe, it, expect } from 'vitest';
import { serializeMudletXml, type SerializeInput } from '../../src/import/mudletXmlExport';
import { parseMudletXml } from '../../src/import/mudletXmlImport';
import { asButtonRotation, type ButtonNode } from '../../src/storage/schema';

const EMPTY: SerializeInput = { scripts: [], aliases: [], triggers: [], timers: [], keys: [], buttons: [] };

function button(p: Partial<ButtonNode>): ButtonNode {
    return {
        id: 'b', name: 'B', enabled: true, isGroup: false, parentId: null,
        code: '', language: 'lua', orientation: 'horizontal', location: 'top',
        columns: 0, isPushDown: false, buttonState: false, ...p,
    };
}

/** Round-trip a button tree through the exporter and back. */
function roundTrip(buttons: ButtonNode[]): ButtonNode[] {
    return parseMudletXml(serializeMudletXml({ ...EMPTY, buttons })).buttons;
}

describe('asButtonRotation', () => {
    it('keeps the two rotations the combo box offers', () => {
        expect(asButtonRotation(1)).toBe(1);
        expect(asButtonRotation(2)).toBe(2);
    });

    it('reads anything else as upright, the way qMax(0, currentIndex()) does', () => {
        for (const n of [0, 3, -1, 99, NaN]) expect(asButtonRotation(n)).toBe(0);
    });
});

describe('button rotation round-trip', () => {
    it('writes the stored rotation instead of a hard-coded zero', () => {
        const xml = serializeMudletXml({ ...EMPTY, buttons: [button({ rotation: 2 })] });
        expect(xml).toContain('<buttonRotation>2</buttonRotation>');
    });

    it('survives export and re-import', () => {
        expect(roundTrip([button({ rotation: 1 })])[0].rotation).toBe(1);
    });

    it('reads a rotation authored in Mudlet', () => {
        const xml = serializeMudletXml({ ...EMPTY, buttons: [button({})] })
            .replace('<buttonRotation>0</buttonRotation>', '<buttonRotation>2</buttonRotation>');
        expect(parseMudletXml(xml).buttons[0].rotation).toBe(2);
    });

    it('normalises an out-of-range value on the way in', () => {
        const xml = serializeMudletXml({ ...EMPTY, buttons: [button({})] })
            .replace('<buttonRotation>0</buttonRotation>', '<buttonRotation>7</buttonRotation>');
        expect(parseMudletXml(xml).buttons[0].rotation).toBe(0);
    });
});

describe('toolbar filler offset round-trip', () => {
    it('emits the element even when unset, so newer Mudlet reads a value', () => {
        const xml = serializeMudletXml({ ...EMPTY, buttons: [button({ isGroup: true, columns: 3 })] });
        expect(xml).toContain('<buttonFillerOffset>0</buttonFillerOffset>');
    });

    it('survives export and re-import', () => {
        const back = roundTrip([button({ isGroup: true, columns: 4, fillerOffset: 2 })]);
        expect(back[0].fillerOffset).toBe(2);
    });

    it('leaves the field off a toolbar that has no offset, rather than storing a zero', () => {
        expect(roundTrip([button({ isGroup: true, columns: 4 })])[0].fillerOffset).toBeUndefined();
    });
});
