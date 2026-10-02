import { describe, it, expect } from 'vitest';
import { serializeMudletXml, type SerializeInput } from '../../src/import/mudletXmlExport';
import { parseMudletXml } from '../../src/import/mudletXmlImport';
import { domCodeToQtKey, qtKeyToDomCode, QT_KEYPAD_MODIFIER } from '../../src/mud/keybindings/qtKeys';
import type { KeyNode } from '../../src/storage/schema';

/**
 * Issue #261: key items on punctuation and F13+ were written with keyCode 0, so
 * desktop Mudlet never fired them after loading the export. `<keyCode>` must be
 * the Qt::Key desktop itself saves for that key — the inverse of the import's
 * qtKeyToDomCode.
 */

const EMPTY: SerializeInput = { scripts: [], aliases: [], triggers: [], timers: [], keys: [], buttons: [] };

function key(k: string, modifiers: string[] = []): KeyNode {
    return { id: k, name: `K_${k}`, enabled: true, isGroup: false, parentId: null, key: k, modifiers, code: '', language: 'lua' };
}

function exportedKeyCode(k: string): number {
    const xml = serializeMudletXml({ ...EMPTY, keys: [key(k)] });
    return Number(/<keyCode>(-?\d+)<\/keyCode>/.exec(xml)![1]);
}

describe('Mudlet XML export — <keyCode> (issue #261)', () => {
    // The values desktop Mudlet 5 wrote for the same keys in the issue's probe,
    // plus the rest of the punctuation row.
    it.each([
        ['F13', 16777276], ['F24', 16777287],
        ['BracketLeft', 91], ['BracketRight', 93], ['Minus', 45], ['Semicolon', 59],
        ['Slash', 47], ['Quote', 39], ['Equal', 61], ['Comma', 44], ['Period', 46],
        ['Backslash', 92], ['Backquote', 96],
        ['Pause', 16777224], ['PrintScreen', 16777225], ['NumLock', 16777253], ['ScrollLock', 16777254],
        ['CapsLock', 16777252], ['ContextMenu', 16777301],
        // Already covered before the fix — must not regress.
        ['KeyA', 65], ['Digit7', 55], ['F1', 16777264], ['Space', 32], ['Enter', 16777220],
        ['NumpadEnter', 16777221], ['Numpad3', 51], ['NumpadMultiply', 42], ['NumpadDivide', 47],
        ['NumpadEqual', 61],
    ])('%s → %i', (code, qt) => {
        expect(exportedKeyCode(code)).toBe(qt);
    });

    it('writes 0 for an unbound key item', () => {
        expect(exportedKeyCode('')).toBe(0);
    });

    it('round-trips every key the importer can produce through export → import', () => {
        const codes = new Set<string>();
        for (let qt = 0x20; qt <= 0x7E; qt++) codes.add(qtKeyToDomCode(qt));
        for (let qt = 0x01000000; qt <= 0x01000058; qt++) codes.add(qtKeyToDomCode(qt));
        for (let qt = 0x2A; qt <= 0x39; qt++) codes.add(qtKeyToDomCode(qt, QT_KEYPAD_MODIFIER));
        const keys = [...codes].filter(c => /^[A-Za-z]/.test(c)).map(c => key(c));
        expect(keys.length).toBeGreaterThan(80);
        const back = parseMudletXml(serializeMudletXml({ ...EMPTY, keys })).keys;
        expect(back.map(k => k.key)).toEqual(keys.map(k => k.key));
    });

    it('keeps the keypad flag on numpad symbols', () => {
        const xml = serializeMudletXml({ ...EMPTY, keys: [key('NumpadSubtract')] });
        expect(xml).toContain('<keyCode>45</keyCode>');
        expect(xml).toContain(`<keyModifier>${QT_KEYPAD_MODIFIER}</keyModifier>`);
    });
});

describe('domCodeToQtKey — canonical (unshifted) Qt key', () => {
    it.each([['Semicolon', 0x3B], ['Equal', 0x3D], ['Quote', 0x27], ['NumLock', 0x01000025]])(
        '%s → the key desktop records unshifted', (code, qt) => {
            expect(domCodeToQtKey(code)).toBe(qt);
        });
});

/**
 * Issue #279: the lock keys and the menu key sat one Qt code off. Values are
 * Qt's qnamespace.h — what desktop saves in `<keyCode>` and fires on.
 */
describe('Qt key table — lock and menu keys (issue #279)', () => {
    it.each([
        [16777252, 'CapsLock'],     // Key_CapsLock   0x01000024
        [16777253, 'NumLock'],      // Key_NumLock    0x01000025
        [16777254, 'ScrollLock'],   // Key_ScrollLock 0x01000026
        [16777301, 'ContextMenu'],  // Key_Menu       0x01000055
    ])('imports %i as %s, and exports it back unchanged', (qt, code) => {
        expect(qtKeyToDomCode(qt)).toBe(code);
        expect(domCodeToQtKey(code)).toBe(qt);
    });

    it('binds neither Key_Super_L nor the old off-by-one codes to these keys', () => {
        expect(qtKeyToDomCode(16777299)).not.toBe('ContextMenu');   // Key_Super_L
        expect(qtKeyToDomCode(16777255)).not.toBe('ScrollLock');    // 0x01000027, not a Qt key
    });

    it('a desktop package key on Key_CapsLock is imported bound to CapsLock', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?><MudletPackage version="1.001"><KeyPackage>
<Key isActive="yes" isFolder="no"><name>D_CapsLock</name><script></script><command></command><keyCode>16777252</keyCode><keyModifier>0</keyModifier></Key>
<Key isActive="yes" isFolder="no"><name>D_Menu</name><script></script><command></command><keyCode>16777301</keyCode><keyModifier>0</keyModifier></Key>
</KeyPackage></MudletPackage>`;
        expect(parseMudletXml(xml).keys.map(k => k.key)).toEqual(['CapsLock', 'ContextMenu']);
    });
});
