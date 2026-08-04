// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

/**
 * gui-drop derives a Lua variable name from the dropped image's filename, and
 * `GUIDropManager.createDropManager` emits it into generated source as
 * `GUIDropImages.<name> = ...`. If that name isn't a valid Lua identifier the
 * generated chunk doesn't compile, `setScript` rejects it, and the drop is lost —
 * permanently, because the bad entry stays in `GUIDropImages` and is re-emitted
 * on every later drop.
 *
 * Upstream's guard only rewrote names made *entirely* of digits, so
 * `20260803_164803.jpg` — what phone cameras produce — slipped through. mudix
 * carries the fix as scripts/mudlet-lua-patches/packages/gui-drop/, pending
 * Mudlet/Mudlet#9628; drop the patch once that lands upstream.
 *
 * The naming block is lifted out of the vendored package itself rather than
 * restated here, so this fails if a re-sync ever loses the patch.
 */
const GUI_DROP_XML = 'src/import/defaults/gui-drop/gui-drop.xml';

/** The container-name derivation from `GUIDropManager.ImageDrop`, verbatim. */
function namingBlock(): string {
    const xml = readFileSync(GUI_DROP_XML, 'utf8');
    const start = xml.indexOf('--convert filename to be a feasible variablename');
    const end = xml.indexOf('local labelname', start);
    expect(start, `naming block not found in ${GUI_DROP_XML}`).toBeGreaterThan(-1);
    expect(end, `end of naming block not found in ${GUI_DROP_XML}`).toBeGreaterThan(start);
    // The package is XML, so its Lua arrives entity-encoded.
    return xml.slice(start, end)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

describe('gui-drop container naming', () => {
    let rt: TestRuntime;
    beforeAll(async () => { rt = await createTestRuntime(); });
    afterAll(() => rt.dispose());

    /** What ImageDrop would name the container for `imgName` (sans extension). */
    const nameFor = (imgName: string) => rt.run(`
        GUIDropImages = {}
        local imgName = ${JSON.stringify(imgName)}
        ${namingBlock()}
        return containername
    `) as string;

    /** Whether the line createDropManager generates actually compiles. */
    const compiles = (name: string) =>
        rt.run(`return loadstring("GUIDropImages.${name} = 1") ~= nil`) as boolean;

    it('never produces a name that breaks the generated script', () => {
        for (const imgName of [
            '20260803_164803',  // the phone-camera shape that regressed
            '2026',             // all digits
            '3dmap',            // digit then letters
            'sunset',           // ordinary
            'my-map v2',        // punctuation and a space, stripped
        ]) {
            const name = nameFor(imgName);
            expect(name, `${imgName} produced an empty name`).not.toBe('');
            expect(compiles(name), `GUIDropImages.${name} does not compile (from ${imgName})`).toBe(true);
        }
    });

    it('prefixes a leading digit rather than mangling the name', () => {
        // Recognisable names matter: this one becomes a script node the user is
        // expected to edit by hand afterwards.
        expect(nameFor('20260803_164803')).toBe('_20260803_164803');
        expect(nameFor('3dmap')).toBe('_3dmap');
    });

    it('still leaves ordinary names alone, and all-digit ones defaulted', () => {
        expect(nameFor('sunset')).toBe('sunset');
        expect(nameFor('my-map v2')).toBe('mymapv2');
        // Upstream's own rule for a name with nothing but digits, kept as-is.
        expect(nameFor('2026')).toBe('defaultName');
    });
});
