// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { toPlainText } from '../../src/ui/textedit/TextEditManager';

// Issue #359 — Geyser probes that diverged from Mudlet desktop.
let rt: TestRuntime | null = null;
afterEach(() => { rt?.dispose(); rt = null; });

const geometry = (code: string) =>
    rt!.run(`local x, y, w, h = getWindowGeometry(${JSON.stringify(code)}); return x .. ',' .. y .. ',' .. w .. ',' .. h`);

describe('setWindow and the moveWindow cache', () => {
    it('applies a moveWindow back to the coordinates held before setWindow', async () => {
        rt = await createTestRuntime();
        rt.run('createLabel("Z", 300, 300, 200, 100, 1)');
        rt.run('moveWindow("Z", 300, 300)');
        rt.run('setWindow("main", "Z", 0, 0, true)');
        expect(geometry('Z')).toBe('0,0,200,100');
        rt.run('moveWindow("Z", 300, 300)');
        expect(geometry('Z')).toBe('300,300,200,100');
    });

    it('applies it for a miniconsole too', async () => {
        rt = await createTestRuntime();
        rt.run('createMiniConsole("M", 10, 160, 200, 100)');
        rt.run('moveWindow("M", 10, 160)');
        rt.run('setWindow("main", "M", 0, 0, true)');
        rt.run('moveWindow("M", 10, 160)');
        expect(geometry('M')).toBe('10,160,200,100');
    });

    it('keeps Geyser widgets in place through changeContainer and back', async () => {
        rt = await createTestRuntime();
        rt.run(`
            c = Geyser.Container:new({ name = "c", x = 0, y = 0, width = 400, height = 400 })
            LL = Geyser.Label:new({ name = "LL", x = 30, y = 30, width = 100, height = 50 }, c)
            MM = Geyser.MiniConsole:new({ name = "MM", x = 10, y = 160, width = 200, height = 100 }, c)
            SB = Geyser.ScrollBox:new({ name = "SB", x = 500, y = 0, width = 500, height = 500 })
        `);
        rt.run('c:changeContainer(SB)');
        expect(geometry('LL')).toBe('30,30,100,50');
        expect(geometry('MM')).toBe('10,160,200,100');
        rt.run('c:changeContainer(Geyser)');
        expect(geometry('LL')).toBe('30,30,100,50');
        expect(geometry('MM')).toBe('10,160,200,100');
    });
});

describe('setBackgroundImage', () => {
    const PNG = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
        0, 0, 0, 4, 0, 0, 0, 4, 8, 6, 0, 0, 0,
    ]);
    async function withFiles() {
        rt = await createTestRuntime();
        const files: Record<string, Uint8Array> = {
            'img.png': PNG,
            'notes.txt': new TextEncoder().encode('just some text'),
        };
        rt.api.setHost({ ...rt.api.engineHost, readFileBytes: (p: string) => files[p] ?? null });
        rt.run('createLabel("B", 0, 0, 50, 50, 1)');
    }
    const result = (code: string) => rt!.run(`local ok, msg = ${code}; return tostring(ok) .. '|' .. tostring(msg)`);
    const labelImage = () => rt!.session.labels.list('main').find(l => l.name === 'B')?.backgroundImage;

    it('draws on a label when a mode is given, numeric or named', async () => {
        await withFiles();
        expect(result('setBackgroundImage("B", "img.png")')).toBe('true|nil');
        rt!.run('resetBackgroundImage("B")');
        expect(result('setBackgroundImage("B", "img.png", 1)')).toBe('true|nil');
        expect(labelImage()).toBeTruthy();
        rt!.run('resetBackgroundImage("B")');
        expect(result('setBackgroundImage("B", "img.png", "center")')).toBe('true|nil');
        expect(labelImage()).toBeTruthy();
    });

    it('refuses a label image that is missing or not an image, keeping the old one', async () => {
        await withFiles();
        rt!.run('setBackgroundImage("B", "img.png")');
        const before = labelImage();
        const msg = (p: string) => `nil|console or label 'B' not found, or '${p}' could not be loaded as an image`;
        expect(result('setBackgroundImage("B", "missing.png")')).toBe(msg('missing.png'));
        expect(result('setBackgroundImage("B", "notes.txt", 2)')).toBe(msg('notes.txt'));
        expect(labelImage()).toEqual(before);
    });

    it('answers (nil, msg) for a name nothing answers to', async () => {
        await withFiles();
        expect(result('setBackgroundImage("nobody", "img.png")'))
            .toBe("nil|console or label 'nobody' not found, or 'img.png' could not be loaded as an image");
        expect(result('setBackgroundImage("nobody", "img.png", 3)'))
            .toBe("nil|console or label 'nobody' not found, or 'img.png' could not be loaded as an image");
    });

    it('still sets a miniconsole and the main console with a mode', async () => {
        await withFiles();
        rt!.run('createMiniConsole("MC", 0, 0, 100, 100)');
        expect(result('setBackgroundImage("MC", "img.png", 2)')).toBe('true|nil');
        expect(result('setBackgroundImage("img.png", 3)')).toBe('true|nil');
        expect(result('setBackgroundImage("main", "img.png", "tile")')).toBe('true|nil');
    });
});

describe('getTextEditText', () => {
    const hex = (lua: string) => {
        rt!.run(`setTextEditText("T", ${lua})`);
        return rt!.run('return (getTextEditText("T"):gsub(".", function(c) return string.format("%02x", c:byte()) end))');
    };

    it('normalises line endings, separators, NBSP and a leading BOM like QPlainTextEdit', async () => {
        rt = await createTestRuntime();
        rt.run('createTextEdit("T", 0, 0, 100, 100)');
        expect(hex('"a\\r\\nb"')).toBe('610a62');
        expect(hex('"a\\rb"')).toBe('610a62');
        expect(hex('"a\\226\\128\\168b"')).toBe('610a62');
        expect(hex('"a\\226\\128\\169b"')).toBe('610a62');
        expect(hex('"a\\194\\160b"')).toBe('612062');
        expect(hex('"\\239\\187\\191x"')).toBe('78');
        expect(hex('"a\\nb"')).toBe('610a62');
    });

    it('only strips a byte order mark at the start', () => {
        expect(toPlainText('﻿a﻿b')).toBe('a﻿b');
    });
});
