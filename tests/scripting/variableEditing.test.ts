// @vitest-environment node

// Issue #70 item 3: the Variables view was read-only. Every row exposed one
// control — the save-across-sessions checkbox — so creating, renaming,
// retyping, editing or deleting a variable could only be done from Lua.
// Desktop puts all of it in ui/vars_main_area.ui (lineEdit_var_name:73,
// comboBox_variable_key_type:105, checkBox_variable_hidden:142,
// comboBox_variable_value_type:165) plus dlgTriggerEditor::addVar (:5211).
//
// This covers the runtime half: the edits land in the live `_G`, so a running
// script sees them immediately rather than only after the next profile save.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

let t: TestRuntime;

beforeEach(async () => { t = await createTestRuntime(); });
afterEach(() => { t.dispose(); });

const seg = (key: string, kind: 'string' | 'number' = 'string') => ({ key, kind });

describe('editVariable — set', () => {
    it('creates a string global', () => {
        expect(t.rt.editVariable({ op: 'set', path: [seg('qaVar')], valueType: 'string', value: 'hello' })).toBe(null);
        expect(t.run('return qaVar')).toBe('hello');
    });

    it('creates a number, and refuses a value that is not one', () => {
        expect(t.rt.editVariable({ op: 'set', path: [seg('qaNum')], valueType: 'number', value: '42' })).toBe(null);
        expect(t.run('return qaNum')).toBe(42);

        const failure = t.rt.editVariable({ op: 'set', path: [seg('qaNum')], valueType: 'number', value: 'seven' });
        expect(failure).toContain('is not a number');
        // The refusal leaves the old value alone.
        expect(t.run('return qaNum')).toBe(42);
    });

    it('creates a boolean', () => {
        t.rt.editVariable({ op: 'set', path: [seg('qaOn')], valueType: 'boolean', value: 'true' });
        t.rt.editVariable({ op: 'set', path: [seg('qaOff')], valueType: 'boolean', value: 'false' });
        expect(t.run('return qaOn')).toBe(true);
        expect(t.run('return qaOff')).toBe(false);
    });

    it('creates an empty table', () => {
        t.rt.editVariable({ op: 'set', path: [seg('qaTbl')], valueType: 'table', value: '' });
        expect(t.run('return type(qaTbl)')).toBe('table');
        expect(t.run('return next(qaTbl) == nil')).toBe(true);
    });

    it('keeps a table\'s contents when it is retyped to table again', () => {
        t.run('qaKeep = { a = 1 }');
        t.rt.editVariable({ op: 'set', path: [seg('qaKeep')], valueType: 'table', value: '' });
        expect(t.run('return qaKeep.a')).toBe(1);
    });

    it('writes into a nested table, by string and by numeric key', () => {
        t.run('qaNest = { inner = {} }');
        t.rt.editVariable({ op: 'set', path: [seg('qaNest'), seg('inner'), seg('name')], valueType: 'string', value: 'deep' });
        t.rt.editVariable({ op: 'set', path: [seg('qaNest'), seg('inner'), seg('3', 'number')], valueType: 'number', value: '7' });
        expect(t.run('return qaNest.inner.name')).toBe('deep');
        expect(t.run('return qaNest.inner[3]')).toBe(7);
        // The numeric key really is a number, not the string "3".
        expect(t.run('return qaNest.inner["3"] == nil')).toBe(true);
    });

    it('refuses to walk through something that is not a table', () => {
        t.run('qaFlat = "text"');
        expect(t.rt.editVariable({ op: 'set', path: [seg('qaFlat'), seg('x')], valueType: 'string', value: 'y' }))
            .toContain('is not a table');
    });

    it('refuses a numeric key that is not a number', () => {
        expect(t.rt.editVariable({ op: 'set', path: [seg('qaBad', 'number')], valueType: 'string', value: 'x' }))
            .toContain('cannot be a numeric key');
    });

    it('refuses an empty name and an empty path', () => {
        expect(t.rt.editVariable({ op: 'set', path: [seg('')], valueType: 'string', value: 'x' }))
            .toContain('needs a name');
        expect(t.rt.editVariable({ op: 'set', path: [], valueType: 'string', value: 'x' }))
            .toContain('no variable given');
    });

    it('refuses to write over the client\'s own globals', () => {
        expect(t.rt.editVariable({ op: 'set', path: [seg('__mudix_thing')], valueType: 'string', value: 'x' }))
            .toContain('belong to the client');
    });

    it('carries a value containing a NUL byte through intact', () => {
        // JSON escapes it, so no raw NUL crosses the wasmoon bridge.
        t.rt.editVariable({ op: 'set', path: [seg('qaNul')], valueType: 'string', value: 'a\u0000b' });
        expect(t.run('return #qaNul')).toBe(3);
        expect(t.run('return qaNul:byte(2)')).toBe(0);
    });
});

describe('editVariable — move', () => {
    it('renames a global, keeping its value', () => {
        t.run('qaOld = { n = 5 }');
        expect(t.rt.editVariable({ op: 'move', path: [seg('qaOld')], to: seg('qaNew') })).toBe(null);
        expect(t.run('return qaOld == nil')).toBe(true);
        expect(t.run('return qaNew.n')).toBe(5);
    });

    it('changes a key from string to number in place', () => {
        t.run('qaKeys = { ["3"] = "as-string" }');
        t.rt.editVariable({ op: 'move', path: [seg('qaKeys'), seg('3')], to: seg('3', 'number') });
        expect(t.run('return qaKeys["3"] == nil')).toBe(true);
        expect(t.run('return qaKeys[3]')).toBe('as-string');
    });

    it('refuses to overwrite a name that is already taken', () => {
        t.run('qaA = 1 qaB = 2');
        expect(t.rt.editVariable({ op: 'move', path: [seg('qaA')], to: seg('qaB') })).toContain('already exists');
        expect(t.run('return qaA')).toBe(1);
        expect(t.run('return qaB')).toBe(2);
    });

    it('is a no-op when the name has not changed', () => {
        t.run('qaSame = 3');
        expect(t.rt.editVariable({ op: 'move', path: [seg('qaSame')], to: seg('qaSame') })).toBe(null);
        expect(t.run('return qaSame')).toBe(3);
    });
});

describe('editVariable — delete', () => {
    it('sets a global to nil', () => {
        t.run('qaGone = "here"');
        expect(t.rt.editVariable({ op: 'delete', path: [seg('qaGone')] })).toBe(null);
        expect(t.run('return qaGone == nil')).toBe(true);
    });

    it('removes one key without disturbing its siblings', () => {
        t.run('qaTable = { keep = 1, drop = 2 }');
        t.rt.editVariable({ op: 'delete', path: [seg('qaTable'), seg('drop')] });
        expect(t.run('return qaTable.drop == nil')).toBe(true);
        expect(t.run('return qaTable.keep')).toBe(1);
    });
});

describe('listGlobals sees the edits', () => {
    it('shows a variable created through editVariable, with its type', () => {
        t.rt.editVariable({ op: 'set', path: [seg('qaListed')], valueType: 'number', value: '9' });
        const entry = t.rt.listGlobals().find(g => g.name === 'qaListed');
        expect(entry).toMatchObject({ valueType: 'number', value: '9', saveable: true });
        expect(entry!.builtin).toBeUndefined();
    });

    it('stops showing one that was deleted', () => {
        t.run('qaTemp = 1');
        expect(t.rt.listGlobals().some(g => g.name === 'qaTemp')).toBe(true);
        t.rt.editVariable({ op: 'delete', path: [seg('qaTemp')] });
        expect(t.rt.listGlobals().some(g => g.name === 'qaTemp')).toBe(false);
    });
});
