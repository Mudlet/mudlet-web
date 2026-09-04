import { describe, it, expect } from 'vitest';
import { MudSession } from '../../../src/mud/MudSession';
import {
    Console,
    DEFAULT_CONSOLE_BUFFER_SIZE,
    MIN_CONSOLE_BUFFER_SIZE,
    MAX_CONSOLE_BUFFER_SIZE,
    consoleBatchDeleteSize,
} from '../../../src/mud/text/Console';

describe('Console scrollback defaults', () => {
    it('starts at Mudlet\'s buffer size, not a tenth of it', () => {
        const con = new Console();
        expect(con.maxLines).toBe(DEFAULT_CONSOLE_BUFFER_SIZE);
        expect(con.maxLines).toBe(10_000);
        // TBuffer.h ships mBatchDeleteSize as a tenth of mLinesLimit.
        expect(con.batchDeleteSize).toBe(DEFAULT_CONSOLE_BUFFER_SIZE / 10);
    });

    it('keeps that many lines before evicting', () => {
        const con = new Console();
        for (let i = 0; i < DEFAULT_CONSOLE_BUFFER_SIZE; i++) con.echo(`line ${i}\n`);
        // getLineCount() is the 0-indexed last line, so nothing has been dropped.
        expect(con.getLineCount()).toBe(DEFAULT_CONSOLE_BUFFER_SIZE - 1);
        expect(con.getLines(0, 1)).toEqual(['line 0']);
    });
});

describe('MudSession.setConsoleBufferSize', () => {
    /** A session with a stand-in main console — ScriptingAPI registers the real
     *  one, and asks for the resolved size the same way. */
    function sessionWithMain(): { session: MudSession; main: Console } {
        const session = new MudSession();
        const main = new Console();
        session.consoles.set('main', main);
        session.applyConsoleBufferSize(main);
        return { session, main };
    }

    it('defaults to Mudlet\'s buffer size with a 5% batch', () => {
        const { session, main } = sessionWithMain();
        expect(session.consoleBufferSize).toBe(DEFAULT_CONSOLE_BUFFER_SIZE);
        expect(main.maxLines).toBe(DEFAULT_CONSOLE_BUFFER_SIZE);
        expect(main.batchDeleteSize).toBe(consoleBatchDeleteSize(DEFAULT_CONSOLE_BUFFER_SIZE));
        expect(main.batchDeleteSize).toBe(2000);
    });

    it('resizes the live main console', () => {
        const { session, main } = sessionWithMain();
        session.setConsoleBufferSize(50_000);
        expect(session.consoleBufferSize).toBe(50_000);
        expect(main.maxLines).toBe(50_000);
        expect(main.batchDeleteSize).toBe(10_000);
    });

    it('clamps to Mudlet\'s floor and mudix\'s ceiling', () => {
        const { session, main } = sessionWithMain();
        session.setConsoleBufferSize(1);
        expect(main.maxLines).toBe(MIN_CONSOLE_BUFFER_SIZE);
        session.setConsoleBufferSize(Number.MAX_SAFE_INTEGER);
        expect(main.maxLines).toBe(MAX_CONSOLE_BUFFER_SIZE);
    });

    it('uses the maximum when the profile asks for it, whatever the size says', () => {
        const { session, main } = sessionWithMain();
        session.setConsoleBufferSize(2500, true);
        expect(session.consoleBufferSize).toBe(MAX_CONSOLE_BUFFER_SIZE);
        expect(main.maxLines).toBe(MAX_CONSOLE_BUFFER_SIZE);
    });

    it('applies a size set before the main console exists', () => {
        const session = new MudSession();
        session.setConsoleBufferSize(3000);
        const main = new Console();
        session.consoles.set('main', main);
        session.applyConsoleBufferSize(main);
        expect(main.maxLines).toBe(3000);
        expect(main.batchDeleteSize).toBe(600);
    });

    it('actually caps the buffer at the configured size', () => {
        const { session, main } = sessionWithMain();
        session.setConsoleBufferSize(200);
        for (let i = 0; i < 1000; i++) main.echo(`line ${i}\n`);
        expect(main.getLineCount() + 1).toBeLessThanOrEqual(200);
        // The oldest lines are the ones that went.
        expect(main.getLines(0, 1)[0]).not.toBe('line 0');
    });

    it('leaves named user windows on their own size', () => {
        const { session } = sessionWithMain();
        const sub = new Console();
        session.consoles.set('info', sub);
        session.setConsoleBufferSize(50_000);
        expect(sub.maxLines).toBe(DEFAULT_CONSOLE_BUFFER_SIZE);
    });
});
