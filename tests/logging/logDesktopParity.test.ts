import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Issue #357: the file startLogging writes, against the real Mudlet's. Each
// block below is one item of the issue.

vi.mock('../../src/storage/logStorage', () => ({
    appendEntries: () => Promise.resolve(),
    createSession: () => Promise.resolve(),
    updateSession: () => Promise.resolve(),
}));

const { SessionLogger, hasSavedLogging } = await import('../../src/logging/SessionLogger');
const { AnsiAwareBuffer } = await import('../../src/mud/text/FormatState');
const { MudSession } = await import('../../src/mud/MudSession');
const { Console } = await import('../../src/mud/text/Console');

function fakeVfs() {
    const files = new Map<string, string>();
    return {
        files,
        vfs: {
            profilePath: '/p',
            mkdir: () => {},
            writeFile: (p: string, c: string) => { files.set(p, c); },
            exists: (p: string) => files.has(p),
            readFile: (p: string) => files.get(p) ?? '',
            deleteFile: (p: string) => { files.delete(p); },
        },
    };
}

/** A session with a real main console, and a logger writing a text log. */
function logging() {
    const session = new MudSession();
    const main = new Console();
    session.consoles.set('main', main);
    const { files, vfs } = fakeVfs();
    const logger = new SessionLogger(session, 'c', 'Prof', vfs);
    logger.start();
    const path = logger.startFileLog({ html: false })!;
    /** What processFlushBatch does with a server line: store it, then emit it. */
    const server = (text: string, isPrompt = false) => {
        const buf = new AnsiAwareBuffer(text);
        buf.isPrompt = isPrompt;
        main.appendLine(buf);
        session.events.emit('message', buf, 'mud', Date.now(), isPrompt);
        return buf;
    };
    /** The body of the log: everything between the start and end lines. */
    const body = () => {
        logger.stopFileLog();
        return files.get(path)!.split('\n').slice(1, -2);
    };
    return { session, main, files, vfs, logger, path, server, body };
}

describe('session log files match desktop (mudlet-web#357)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 9, 1, 6, 16, 55));
    });
    afterEach(() => { vi.useRealTimers(); });

    it('logs a command typed at a GA prompt on the prompt line', async () => {
        const { session, server, body, logger } = logging();
        server('HP 100> ', true);
        session.echoCommand('CMD1');
        server('You do it.');
        expect(body()).toEqual(['HP 100> CMD1', 'You do it.']);
        await logger.stop();
    });

    it('logs a second command after a prompt on a line of its own', async () => {
        const { session, server, body, logger } = logging();
        server('HP 100> ', true);
        session.echoCommand('one');
        session.echoCommand('two');
        expect(body()).toEqual(['HP 100> one', 'two']);
        await logger.stop();
    });

    it('logs the joined prompt line in HTML as one line', async () => {
        const session = new MudSession();
        session.consoles.set('main', new Console());
        const { files, vfs } = fakeVfs();
        const logger = new SessionLogger(session, 'c', 'Prof', vfs);
        logger.start();
        const path = logger.startFileLog({ html: true })!;
        const buf = new AnsiAwareBuffer('HP 100> ');
        buf.isPrompt = true;
        session.consoles.get('main')!.appendLine(buf);
        session.events.emit('message', buf, 'mud', Date.now(), true);
        session.echoCommand('CMD1');
        logger.stopFileLog();
        const doc = files.get(path)!;
        expect(doc).not.toContain('HP 100&gt; </span><br>');
        expect(doc).toMatch(/HP 100&gt; <\/span><span[^>]*>CMD1<\/span><br>/);
        await logger.stop();
    });

    it('writes appendLog text verbatim, ahead of the held-back line', async () => {
        const { session, logger, body } = logging();
        const echo = (text: string) => session.events.emit('message', new AnsiAwareBuffer(text), 'script');
        logger.appendLine('APP1-NO-NL');
        echo('ECHO1');
        logger.appendLine('<b>APP2</b>\n');
        logger.appendLine('');
        echo('ECHO2');
        logger.appendLine('APP3 \x1b[31mansi\x1b[0m\n');
        expect(body()).toEqual(['APP1-NO-NL<b>APP2</b>', 'ECHO1', 'APP3 \x1b[31mansi\x1b[0m', 'ECHO2']);
    });

    it('writes appendLog markup as-is in an HTML log', async () => {
        const session = new MudSession();
        const { files, vfs } = fakeVfs();
        const logger = new SessionLogger(session, 'c', 'Prof', vfs);
        logger.start();
        const path = logger.startFileLog({ html: true })!;
        logger.appendLine('<b>APP2</b>\n');
        logger.stopFileLog();
        expect(files.get(path)).toContain('</p>\n<b>APP2</b>\n<p>Log session ending');
        await logger.stop();
    });

    it('names the file after the start, and opens a new one per start', async () => {
        const session = new MudSession();
        const { files, vfs } = fakeVfs();
        const logger = new SessionLogger(session, 'c', 'Prof', vfs);
        logger.start();
        vi.setSystemTime(new Date(2026, 9, 1, 6, 17, 6));
        const first = logger.startFileLog({ html: false })!;
        expect(first).toBe('/p/log/2026-10-01#06-17-06.txt');
        logger.stopFileLog();
        vi.setSystemTime(new Date(2026, 9, 1, 6, 17, 30));
        const second = logger.startFileLog({ html: false })!;
        expect(second).toBe('/p/log/2026-10-01#06-17-30.txt');
        logger.stopFileLog();
        expect([...files.keys()].filter(k => k.startsWith('/p/log/'))).toEqual([first, second]);
        expect(files.get(second)).not.toContain('⎯');
        await logger.stop();
    });

    it('leaves an autolog sentinel while logging, which a stop removes', async () => {
        const { files, logger } = logging();
        expect(files.has('/p/autolog')).toBe(true);
        logger.stopFileLog();
        expect(files.has('/p/autolog')).toBe(false);
        await logger.stop();
    });

    it('resumes logging on the next profile load after closing while logging', async () => {
        const { files, vfs, logger, server, path } = logging();
        server('last line');
        await logger.stop();
        expect(files.has('/p/autolog')).toBe(true);
        // The held-back line still reaches the file.
        expect(files.get(path)).toContain('last line\n');

        // Phase 2: the profile opens again on the same filesystem.
        expect(hasSavedLogging(vfs)).toBe(true);
        const next = new SessionLogger(new MudSession(), 'c', 'Prof', vfs);
        next.start();
        vi.setSystemTime(new Date(2026, 9, 1, 6, 20, 0));
        next.startFileLog({ html: false });
        // startLogging(true) now finds the file log already on and answers -1.
        expect(next.filePath).toBe('/p/log/2026-10-01#06-20-00.txt');
        next.stopFileLog();
        expect(hasSavedLogging(vfs)).toBe(false);
        await next.stop();
    });

    it('keeps a line the next line\'s trigger deletes out of the log', async () => {
        const { session, main, server, body, logger } = logging();
        server('lineA keep');
        server('lineB modifies previous');
        server('lineC victim');
        // lineD's trigger moves to the previous line and deletes it — all
        // before lineD itself is emitted, as processFlushBatch runs it.
        const d = new AnsiAwareBuffer('lineD deletes previous');
        main.appendLine(d);
        main.moveTo(main.getLineNumber() - 1);
        main.deleteLine();
        main.moveToEnd();
        session.events.emit('message', d, 'mud', Date.now(), false);
        expect(main.getLines(0, 3)).toEqual(['lineA keep', 'lineB modifies previous', 'lineD deletes previous']);
        expect(body()).toEqual(['lineA keep', 'lineB modifies previous', 'lineD deletes previous']);
        await logger.stop();
    });

    it('still logs a line deleted only after it was written', async () => {
        const { main, server, body, logger } = logging();
        server('lineA');
        server('lineB');
        server('lineC');
        main.moveTo(0);
        main.deleteLine();
        expect(body()).toEqual(['lineA', 'lineB', 'lineC']);
        await logger.stop();
    });
});
