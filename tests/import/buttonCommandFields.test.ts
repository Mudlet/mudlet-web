// Issue #186 item 2: a plain (non-push-down) button's command is desktop's
// <commandButtonDown> — the only field desktop's editor offers for it and the
// only one TAction::execute sends. The importer read <commandButtonUp> into
// `command`, so a plain button from a Mudlet profile or package clicked the
// wrong command (or nothing at all), and the exporter wrote it back the same
// wrong way.
import { describe, it, expect } from 'vitest';
import { serializeMudletXml, type SerializeInput } from '../../src/import/mudletXmlExport';
import { parseMudletXml } from '../../src/import/mudletXmlImport';
import type { ButtonNode } from '../../src/storage/schema';

const EMPTY: SerializeInput = { scripts: [], aliases: [], triggers: [], timers: [], keys: [], buttons: [] };

function button(p: Partial<ButtonNode>): ButtonNode {
    return {
        id: 'b', name: 'B', enabled: true, isGroup: false, parentId: null,
        code: '', language: 'lua', orientation: 'horizontal', location: 'top',
        columns: 0, isPushDown: false, buttonState: false, ...p,
    };
}

const action = (pushButton: boolean) => `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <ActionPackage>
    <Action isActive="yes" isFolder="no" isPushButton="${pushButton ? 'yes' : 'no'}">
      <name>B1</name>
      <packageName/>
      <script></script>
      <commandButtonUp>RESULT b1up</commandButtonUp>
      <commandButtonDown>RESULT b1down</commandButtonDown>
    </Action>
  </ActionPackage>
</MudletPackage>`;

describe('button command fields', () => {
    it('reads a plain button\'s command from commandButtonDown', () => {
        const [b] = parseMudletXml(action(false)).buttons;
        expect(b.command).toBe('RESULT b1down');
        expect(b.commandDown).toBeUndefined();
    });

    it('keeps both fields of a push-down button', () => {
        const [b] = parseMudletXml(action(true)).buttons;
        expect(b.command).toBe('RESULT b1up');
        expect(b.commandDown).toBe('RESULT b1down');
    });

    it('writes a plain button\'s command as commandButtonDown', () => {
        const xml = serializeMudletXml({ ...EMPTY, buttons: [button({ command: 'look' })] });
        expect(xml).toContain('<commandButtonDown>look</commandButtonDown>');
        expect(xml).toMatch(/<commandButtonUp\s*\/>|<commandButtonUp><\/commandButtonUp>/);
    });

    it('round-trips both kinds', () => {
        const back = parseMudletXml(serializeMudletXml({
            ...EMPTY,
            buttons: [
                button({ id: 'p', name: 'P', command: 'look' }),
                button({ id: 'd', name: 'D', isPushDown: true, command: 'up', commandDown: 'down' }),
            ],
        })).buttons;
        const plain = back.find(b => b.name === 'P')!;
        expect(plain.command).toBe('look');
        expect(plain.commandDown).toBeUndefined();
        expect(back.find(b => b.name === 'D')).toMatchObject({ command: 'up', commandDown: 'down' });
    });
});
