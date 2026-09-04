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

// The importer read none of the sound / colour-trigger / triggerType state, so
// every one of these was silently dropped and then written back as the
// exporter's constant — destroying it in a linked profile rather than merely
// ignoring it. Mudlet: XMLimport.cpp:1358 (isSoundTrigger), :1359
// (isColorTrigger), :1380 (triggerType), :1393/:1395 (colour-trigger colours),
// :1406 (mSoundFile); the kind numbering is TTrigger.h:49-56.
describe('parseMudletXml — trigger sound, colour-trigger and triggerType', () => {
    const parse = (body: string) => parseMudletXml(`<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001"><TriggerPackage>${body}</TriggerPackage></MudletPackage>`).triggers[0];

    const loaded = parse(`
    <Trigger isActive="yes" isFolder="no" isSoundTrigger="yes" isColorTrigger="yes"
             isColorTriggerFg="yes" isColorTriggerBg="no">
      <name>Ding</name>
      <script></script>
      <triggerType>7</triggerType>
      <mSoundFile>/home/me/ding.wav</mSoundFile>
      <colorTriggerFgColor>#ff8800</colorTriggerFgColor>
      <colorTriggerBgColor>#001122</colorTriggerBgColor>
      <regexCodeList><string>You are hungry</string></regexCodeList>
      <regexCodePropertyList><integer>0</integer></regexCodePropertyList>
    </Trigger>`);

    it('imports the sound trigger switch and its file', () => {
        expect(loaded.soundTrigger).toBe(true);
        expect(loaded.soundFile).toBe('/home/me/ding.wav');
    });

    it('imports the legacy colour-trigger switch and both of its colours', () => {
        expect(loaded.colorTrigger).toBe(true);
        expect(loaded.colorTriggerFgColor).toBe('#ff8800');
        expect(loaded.colorTriggerBgColor).toBe('#001122');
    });

    it('imports the node-level triggerType, not just the per-pattern kinds', () => {
        // 7 is REGEX_PROMPT; the single pattern is still kind 0 (substring).
        expect(loaded.triggerType).toBe(7);
        expect(loaded.patterns).toEqual([{ text: 'You are hungry', type: 'substring' }]);
    });

    it('leaves all of them unset for a plain trigger', () => {
        const plain = parse(`
    <Trigger isActive="yes" isFolder="no">
      <name>Plain</name><script></script><triggerType>0</triggerType>
      <mSoundFile></mSoundFile>
      <colorTriggerFgColor>#000000</colorTriggerFgColor>
      <colorTriggerBgColor>#000000</colorTriggerBgColor>
      <regexCodeList><string>hi</string></regexCodeList>
      <regexCodePropertyList><integer>0</integer></regexCodePropertyList>
    </Trigger>`);
        expect(plain.soundTrigger).toBeUndefined();
        expect(plain.soundFile).toBeUndefined();
        expect(plain.colorTrigger).toBeUndefined();
        expect(plain.triggerType).toBeUndefined();
        // The colours have no "absent" spelling — '#000000' IS desktop's unset
        // value — so they are kept verbatim and written straight back out.
        expect(plain.colorTriggerFgColor).toBe('#000000');
        expect(plain.colorTriggerBgColor).toBe('#000000');
    });
});
