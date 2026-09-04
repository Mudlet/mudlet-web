import { describe, it, expect } from 'vitest';
import { sanitizeControlChars, desanitizeControlChars } from '../../src/import/mudletControlChars';
import { serializeMudletXml, type SerializeInput } from '../../src/import/mudletXmlExport';
import { parseMudletXml } from '../../src/import/mudletXmlImport';
import { buildLinkedWriteback } from '../../src/import/mudletWriteback';
import type { ScriptNode, TriggerNode } from '../../src/storage/schema';

// Mudlet scripts embed raw ANSI escapes (`\27[1;32m`) freely, and XML 1.0 cannot
// carry a control character at all — not raw, and not as a numeric reference.
// Desktop placeholder-encodes them on save and decodes on load; without the same
// treatment the serializer emits a document Chrome's DOMParser truncates and Qt
// rejects outright, and the linked-profile write-back lands that in the user's own
// Mudlet folder.
//
// These assertions are deliberately serializer-level. The suite runs on happy-dom,
// which *accepts* the invalid document Chrome truncates, so no amount of
// parse-then-inspect testing would catch a regression here.

const EMPTY: SerializeInput = { scripts: [], aliases: [], triggers: [], timers: [], keys: [], buttons: [] };

const ESC = '\x1B';
const CODE_WITH_ESC = `echo("${ESC}[1;32mgreen${ESC}[0m")`;

function script(p: Partial<ScriptNode> = {}): ScriptNode {
    return {
        id: 's', name: 'ansi', enabled: true, isGroup: false, parentId: null,
        code: CODE_WITH_ESC, language: 'lua', eventHandlers: [], ...p,
    };
}

function trigger(p: Partial<TriggerNode> = {}): TriggerNode {
    return {
        id: 't', name: 'T', enabled: true, isGroup: false, parentId: null,
        patterns: [{ text: 'plain', type: 'substring' }],
        code: '', language: 'lua', fireLength: 0, multipleMatches: false,
        multiline: false, delta: 0, isFilter: false, ...p,
    };
}

/** Every control character XML 1.0 forbids. Tab, LF and CR are legal and excluded. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

describe('control-character codec', () => {
    it('encodes each forbidden byte to U+FFFC + its Control Pictures glyph', () => {
        expect(sanitizeControlChars(ESC)).toBe('￼␛');   // ESC  -> SYMBOL FOR ESCAPE
        expect(sanitizeControlChars('\x01')).toBe('￼␁'); // SOH
        expect(sanitizeControlChars('\x7F')).toBe('￼␡'); // DEL  -> SYMBOL FOR DELETE
        expect(sanitizeControlChars('\x00')).toBe('￼␀'); // NUL  -> SYMBOL FOR NULL
    });

    it('leaves tab, newline and carriage return alone — XML 1.0 permits them raw', () => {
        expect(sanitizeControlChars('a\tb\nc\rd')).toBe('a\tb\nc\rd');
    });

    it('round-trips every forbidden byte', () => {
        let all = '';
        for (let c = 0; c <= 0x1F; c++) all += String.fromCharCode(c);
        all += '\x7F';
        const encoded = sanitizeControlChars(all);
        expect(FORBIDDEN.test(encoded.replace(/[\t\n\r]/g, ''))).toBe(false);
        expect(desanitizeControlChars(encoded)).toBe(all);
    });

    it('leaves ordinary text untouched in both directions', () => {
        const s = 'echo("hi") -- ünïcode ✓';
        expect(sanitizeControlChars(s)).toBe(s);
        expect(desanitizeControlChars(s)).toBe(s);
    });
});

describe('serializeMudletXml — control characters', () => {
    it('emits no character XML 1.0 forbids, for any node field', () => {
        const xml = serializeMudletXml({
            ...EMPTY,
            scripts: [script()],
            triggers: [trigger({ name: `name${ESC}`, patterns: [{ text: `pat${ESC}`, type: 'substring' }] })],
        });
        expect(FORBIDDEN.test(xml)).toBe(false);
        expect(xml).toContain('￼␛');
    });

    it('produces a document that parses, with the escape recovered on import', () => {
        const xml = serializeMudletXml({ ...EMPTY, scripts: [script()] });
        const back = parseMudletXml(xml);
        expect(back.scripts).toHaveLength(1);
        expect(back.scripts[0].code).toBe(CODE_WITH_ESC);
    });

    it('recovers escapes in names and trigger patterns too, which desktop does not decode', () => {
        const xml = serializeMudletXml({
            ...EMPTY,
            triggers: [trigger({ name: `name${ESC}`, patterns: [{ text: `pat${ESC}`, type: 'substring' }] })],
        });
        const back = parseMudletXml(xml);
        expect(back.triggers[0].name).toBe(`name${ESC}`);
        expect(back.triggers[0].patterns[0].text).toBe(`pat${ESC}`);
    });
});

describe('buildLinkedWriteback — control characters', () => {
    const BASE = `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <HostPackage><Host><name>P</name></Host></HostPackage>
  <ScriptPackage></ScriptPackage>
  <KeyPackage></KeyPackage>
</MudletPackage>`;

    it('writes a script holding an ESC without truncating anything after it', () => {
        const out = buildLinkedWriteback(
            BASE,
            { ...EMPTY, scripts: [script()], triggers: [trigger({ name: 'survivor' })] },
            { hidden: [], variables: [] },
        );
        expect(out).not.toContain('parsererror');
        expect(FORBIDDEN.test(out)).toBe(false);
        // The <KeyPackage> and everything else after the offending script must be
        // present: truncation is exactly what the raw escape used to cause.
        expect(out).toContain('<KeyPackage');
        expect(out).toContain('survivor');
        expect(out).toContain('<Host>');

        const back = parseMudletXml(out);
        expect(back.scripts[0].code).toBe(CODE_WITH_ESC);
        expect(back.triggers.map(t => t.name)).toContain('survivor');
    });
});
