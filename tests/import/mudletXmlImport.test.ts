import { describe, it, expect } from 'vitest';
import { parseMudletXml } from '../../src/import/mudletXmlImport';
import { isColorizing } from '../../src/storage/schema';

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

// Import used to never read isColorizerTrigger/mFgColor/mBgColor even though the
// exporter writes them, so the highlight was dropped on the way in and then
// overwritten with isColorizerTrigger="no" + transparent on the next link-mode
// flush — destroyed in the user's own profile, not merely ignored.
//
// The three map onto TTrigger's own split: mIsColorizerTrigger is a master
// switch, and mFgColor/mBgColor are state of their own that desktop defaults to
// red/yellow and exports whatever the switch says. A colour channel set to
// "transparent" is Mudlet's "keep" — leave that channel of the line alone.
// Mudlet: XMLimport.cpp:1373 (switch), :1404 (fg), :1407 (bg).
describe('parseMudletXml — trigger colorizer', () => {
    const trig = (attrs: string, fg: string, bg: string) => `
    <Trigger isActive="yes" isFolder="no" ${attrs}>
      <name>Stop (Key Lift)</name>
      <script></script>
      <mFgColor>${fg}</mFgColor>
      <mBgColor>${bg}</mBgColor>
      <regexCodeList><string>Key Lift</string></regexCodeList>
      <regexCodePropertyList><integer>0</integer></regexCodePropertyList>
    </Trigger>`;
    const parse = (xml: string) => parseMudletXml(`<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001"><TriggerPackage>${xml}</TriggerPackage></MudletPackage>`).triggers[0];

    it('imports both colours and the switch when the colorizer is on', () => {
        const t = parse(trig('isColorizerTrigger="yes"', '#ff0000', '#ffff00'));
        expect(t.colorize).toBe(true);
        expect(t.highlight).toEqual({ fg: '#ff0000', bg: '#ffff00' });
        expect(isColorizing(t)).toBe(true);
    });

    it('imports a single colour, leaving the other on "keep"', () => {
        expect(parse(trig('isColorizerTrigger="yes"', '#ff0000', 'transparent')).highlight)
            .toEqual({ fg: '#ff0000', bg: undefined });
    });

    it('keeps the colours when the switch is off, as TTrigger does', () => {
        const t = parse(trig('isColorizerTrigger="no"', '#ff0000', '#ffff00'));
        expect(t.colorize).toBe(false);
        expect(t.highlight).toEqual({ fg: '#ff0000', bg: '#ffff00' });
        expect(isColorizing(t)).toBe(false);
    });

    it('leaves highlight unset when both channels are "keep"', () => {
        expect(parse(trig('isColorizerTrigger="yes"', 'transparent', 'transparent')).highlight)
            .toBeUndefined();
    });

    it('treats a stored highlight with no switch as on, for profiles predating the field', () => {
        expect(isColorizing({ highlight: { fg: '#ff0000' } })).toBe(true);
        expect(isColorizing({})).toBe(false);
        // An explicit switch always wins over the fallback.
        expect(isColorizing({ colorize: false, highlight: { fg: '#ff0000' } })).toBe(false);
    });
});

