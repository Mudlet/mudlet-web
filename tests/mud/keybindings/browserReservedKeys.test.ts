import { describe, it, expect } from 'vitest';
import {
    classifyReservedKey,
    findReservedKeybindings,
    formatKeyCombo,
} from '../../../src/mud/keybindings/browserReservedKeys';
import type { KeyNode } from '../../../src/storage/schema';

function key(partial: Partial<KeyNode>): KeyNode {
    return {
        id: partial.id ?? 'k1',
        name: partial.name ?? 'test',
        enabled: partial.enabled ?? true,
        isGroup: partial.isGroup ?? false,
        parentId: partial.parentId ?? null,
        key: partial.key ?? '',
        modifiers: partial.modifiers ?? [],
        code: partial.code ?? '',
        language: partial.language ?? 'lua',
        command: partial.command,
    };
}

describe('classifyReservedKey', () => {
    it('flags Ctrl+T as a browser-owned new-tab shortcut', () => {
        expect(classifyReservedKey({ key: 'KeyT', modifiers: ['ctrl'] }, 'ctrl'))
            .toBe('open a new browser tab');
    });

    it('flags F12 with no modifiers (devtools)', () => {
        expect(classifyReservedKey({ key: 'F12', modifiers: [] }, 'ctrl')).toBe('open developer tools');
    });

    it('flags Ctrl+1 (jump to tab) but leaves plain digits alone', () => {
        expect(classifyReservedKey({ key: 'Digit1', modifiers: ['ctrl'] }, 'ctrl')).toBe('jump to browser tab 1');
        expect(classifyReservedKey({ key: 'Digit1', modifiers: [] }, 'ctrl')).toBeNull();
    });

    it('does NOT flag page-capturable shortcuts (Ctrl+R, Ctrl+S, F5, Ctrl+P)', () => {
        // These work while Mudlet Web is focused, exactly like Mudlet — no warning.
        expect(classifyReservedKey({ key: 'KeyR', modifiers: ['ctrl'] }, 'ctrl')).toBeNull();
        expect(classifyReservedKey({ key: 'KeyR', modifiers: ['ctrl', 'shift'] }, 'ctrl')).toBeNull();
        expect(classifyReservedKey({ key: 'KeyS', modifiers: ['ctrl'] }, 'ctrl')).toBeNull();
        expect(classifyReservedKey({ key: 'F5', modifiers: [] }, 'ctrl')).toBeNull();
        expect(classifyReservedKey({ key: 'KeyP', modifiers: ['ctrl'] }, 'ctrl')).toBeNull();
    });

    it('is modifier-exact — Ctrl+Shift+I is reserved, Ctrl+I is not', () => {
        expect(classifyReservedKey({ key: 'KeyI', modifiers: ['ctrl', 'shift'] }, 'ctrl'))
            .toBe('open developer tools');
        expect(classifyReservedKey({ key: 'KeyI', modifiers: ['ctrl'] }, 'ctrl')).toBeNull();
    });

    it('does not flag safe combos (Ctrl+Alt+K, plain F1)', () => {
        expect(classifyReservedKey({ key: 'KeyK', modifiers: ['ctrl', 'alt'] }, 'ctrl')).toBeNull();
        expect(classifyReservedKey({ key: 'F1', modifiers: [] }, 'ctrl')).toBeNull();
    });

    it('uses Cmd (meta) as the accelerator on macOS', () => {
        // Ctrl+T is not a macOS browser shortcut; Cmd+T is.
        expect(classifyReservedKey({ key: 'KeyT', modifiers: ['ctrl'] }, 'meta')).toBeNull();
        expect(classifyReservedKey({ key: 'KeyT', modifiers: ['meta'] }, 'meta')).toBe('open a new browser tab');
    });

    it('treats Ctrl+Tab as reserved on every platform', () => {
        expect(classifyReservedKey({ key: 'Tab', modifiers: ['ctrl'] }, 'meta')).toBe('switch browser tabs');
    });
});

describe('findReservedKeybindings', () => {
    it('collects reserved bindings and skips groups, keyless, and capturable nodes', () => {
        const keys: KeyNode[] = [
            key({ id: 'a', key: 'KeyT', modifiers: ['ctrl'] }),               // new tab — flagged
            key({ id: 'g', isGroup: true, key: 'KeyW', modifiers: ['ctrl'] }), // group — skipped
            key({ id: 'b', key: '', modifiers: ['ctrl'] }),                    // no key — skipped
            key({ id: 'r', key: 'KeyR', modifiers: ['ctrl'] }),               // capturable — skipped
            key({ id: 'd', key: 'F12', modifiers: [] }),                       // devtools — flagged
        ];
        const warnings = findReservedKeybindings(keys, 'ctrl');
        expect(warnings.map(w => w.node.id)).toEqual(['a', 'd']);
        expect(warnings[0].combo).toBe('Ctrl+T');
    });
});

describe('formatKeyCombo', () => {
    it('orders modifiers and reads letters/digits/function keys', () => {
        expect(formatKeyCombo({ key: 'KeyT', modifiers: ['ctrl'] })).toBe('Ctrl+T');
        expect(formatKeyCombo({ key: 'KeyI', modifiers: ['shift', 'ctrl'] })).toBe('Ctrl+Shift+I');
        expect(formatKeyCombo({ key: 'Digit9', modifiers: ['meta'] })).toBe('Cmd+9');
        expect(formatKeyCombo({ key: 'F12', modifiers: [] })).toBe('F12');
    });
});
