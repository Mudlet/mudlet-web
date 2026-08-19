import { describe, it, expect } from 'vitest';
import { parseMudletXml } from '../../src/import/mudletXmlImport';

// Mudlet's TScript model lets a script carry both its own body AND child
// scripts, and its XML export nests the children directly inside the parent
// <Script isFolder="no"> (no <children> wrapper, no ScriptGroup). Packages like
// Muxlet rely on this — their theme registration lives in scripts nested under a
// non-folder "themes" script. The importer must recurse into those children
// regardless of isFolder, or they're silently dropped and never loaded.
describe('parseMudletXml — nested scripts under a non-folder parent', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <ScriptPackage>
    <Script isActive="yes" isFolder="no">
      <name>globals</name>
      <script>Mux = {}</script>
      <packageName/>
      <eventHandlerList></eventHandlerList>
    </Script>
    <Script isActive="yes" isFolder="no">
      <name>themes</name>
      <script>-- parent body</script>
      <packageName/>
      <eventHandlerList></eventHandlerList>
      <Script isActive="yes" isFolder="no">
        <name>dark</name>
        <script>register("dark")</script>
        <packageName/>
        <eventHandlerList></eventHandlerList>
      </Script>
      <Script isActive="yes" isFolder="no">
        <name>light</name>
        <script>register("light")</script>
        <packageName/>
        <eventHandlerList></eventHandlerList>
      </Script>
    </Script>
  </ScriptPackage>
</MudletPackage>`;

    it('imports children nested under a non-folder <Script>', () => {
        const { scripts } = parseMudletXml(xml);
        const names = scripts.map(s => s.name);
        expect(names).toEqual(['globals', 'themes', 'dark', 'light']);
    });

    it('keeps the children after their parent and links parentId', () => {
        const { scripts } = parseMudletXml(xml);
        const themes = scripts.find(s => s.name === 'themes')!;
        const dark = scripts.find(s => s.name === 'dark')!;
        const light = scripts.find(s => s.name === 'light')!;
        // DFS pre-order: parent precedes its children so the parent's body runs
        // first (Mudlet semantics), and the children carry the parent's id.
        expect(scripts.indexOf(themes)).toBeLessThan(scripts.indexOf(dark));
        expect(dark.parentId).toBe(themes.id);
        expect(light.parentId).toBe(themes.id);
        expect(dark.code).toContain('register("dark")');
    });
});

// "No key bound" has three spellings across Mudlet's history: Qt::Key(0),
// Qt::Key_unknown (0x01ffffff, current), and -1 — the sentinel
// dlgTriggerEditor stored for a freshly-created key back when mKeyCode was a
// plain int. TKey::validateKeyBinding treats all three as unset, so an import
// must import them silently rather than reporting a broken key code. MAG
// (Mudlet Aardwolf GUI) ships six such keys and warned six times on install.
describe('parseMudletXml — keys with no binding set', () => {
    const key = (name: string, code: string) => `
    <Key isActive="yes" isFolder="no">
      <name>${name}</name>
      <packageName/>
      <script></script>
      <command></command>
      <keyCode>${code}</keyCode>
      <keyModifier>0</keyModifier>
    </Key>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <KeyPackage>${key('N', '-1')}${key('S', '0')}${key('U', '33554431')}${key('bound', '78')}${key('weird', '999999')}</KeyPackage>
</MudletPackage>`;

    it('imports unbound keys with no key and no warning', () => {
        const { keys, warnings } = parseMudletXml(xml);
        for (const name of ['N', 'S', 'U']) {
            expect(keys.find(k => k.name === name)!.key).toBe('');
        }
        expect(warnings.filter(w => /"[NSU]"/.test(w))).toEqual([]);
    });

    it('still maps real key codes and still warns on unmappable ones', () => {
        const { keys, warnings } = parseMudletXml(xml);
        expect(keys.find(k => k.name === 'bound')!.key).toBe('KeyN');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('"weird"');
    });
});
