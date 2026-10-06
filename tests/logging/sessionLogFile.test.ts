import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Issue #278, item 3: the file startLogging writes, as Mudlet's
// TConsoleModel::toggleLogging and TBuffer::bufferToHtml write it.

vi.mock('../../src/storage/logStorage', () => ({
    appendEntries: () => Promise.resolve(),
    createSession: () => Promise.resolve(),
    updateSession: () => Promise.resolve(),
}));

const { SessionLogger, logSessionLine } = await import('../../src/logging/SessionLogger');
const { AnsiAwareBuffer } = await import('../../src/mud/text/FormatState');

type Listener = (text?: string | InstanceType<typeof AnsiAwareBuffer>, type?: string, ts?: number) => void;

function fakeSession() {
    const listeners: Listener[] = [];
    return {
        session: {
            events: {
                on: (_name: string, fn: Listener) => { listeners.push(fn); return () => {}; },
            },
        },
        emit: (text: string | InstanceType<typeof AnsiAwareBuffer>, type = 'mud') => listeners.forEach(l => l(text, type)),
    };
}

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

describe('session log files', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 9, 1, 6, 16, 55));
    });
    afterEach(() => { vi.useRealTimers(); });

    it('formats the session line as Mudlet does', () => {
        expect(logSessionLine('starting', new Date(2026, 9, 1, 6, 16, 55)))
            .toBe('Log session starting at 06:16:55 on Thursday, 1 October 2026.');
        expect(logSessionLine('ending', new Date(2026, 0, 9, 23, 5, 7)))
            .toBe('Log session ending at 23:05:07 on Friday, 9 January 2026.');
    });

    it('writes a text log between a starting and an ending line', async () => {
        const { session, emit } = fakeSession();
        const { files, vfs } = fakeVfs();
        const logger = new SessionLogger(session as never, 'c', 'Prof', vfs);
        logger.start();
        const path = logger.startFileLog({ html: false })!;
        emit('ECHOED-LINE');
        logger.stopFileLog();
        expect(files.get(path)).toBe(
            'Log session starting at 06:16:55 on Thursday, 1 October 2026.\n'
            + 'ECHOED-LINE\n'
            + 'Log session ending at 06:16:55 on Thursday, 1 October 2026.\n');
        // Restarting comes back to the same file, after a rule.
        logger.startFileLog({ html: false });
        logger.stopFileLog();
        expect(files.get(path)).toContain(`October 2026.\n${'⎯'.repeat(80)}\nLog session starting at`);
        await logger.stop();
    });

    it('writes each HTML line as fully coloured spans ending in <br>', async () => {
        const { session, emit } = fakeSession();
        const { files, vfs } = fakeVfs();
        const logger = new SessionLogger(session as never, 'c', 'Prof', vfs);
        logger.start();
        const path = logger.startFileLog({
            html: true, foreground: { r: 192, g: 192, b: 192 }, background: { r: 0, g: 0, b: 0 },
        })!;
        expect(path.endsWith('.html')).toBe(true);
        emit('ECHOED-LINE');
        emit('\x1b[38;2;255;0;0mCECHO-RED\x1b[0m plain <tag>');
        emit('');
        logger.stopFileLog();
        const doc = files.get(path)!;
        expect(doc).toContain('color:rgb(192,192,192); background-color:rgb(0,0,0);}');
        expect(doc).toContain('white-space: nowrap');
        expect(doc).toContain(
            '  </head>\n'
            + '  <body><div>\n'
            + '<p>Log session starting at 06:16:55 on Thursday, 1 October 2026.</p>\n'
            + '<span style="color: rgb(192,192,192); background: rgb(0,0,0);">ECHOED-LINE</span><br>\n'
            + '<span style="color: rgb(255,0,0); background: rgb(0,0,0);">CECHO-RED</span>'
            + '<span style="color: rgb(192,192,192); background: rgb(0,0,0);"> plain &lt;tag&gt;</span><br>\n'
            + '<br>\n'
            + '<p>Log session ending at 06:16:55 on Thursday, 1 October 2026.</p>\n'
            + '  </div></body>\n'
            + '</html>\n');
        await logger.stop();
    });

    it('carries the old body forward with an <hr> when an HTML log restarts', async () => {
        const { session, emit } = fakeSession();
        const { files, vfs } = fakeVfs();
        const logger = new SessionLogger(session as never, 'c', 'Prof', vfs);
        logger.start();
        const path = logger.startFileLog({ html: true })!;
        emit('FIRST');
        logger.stopFileLog();
        logger.startFileLog({ html: true });
        emit('SECOND');
        logger.stopFileLog();
        const doc = files.get(path)!;
        expect(doc.match(/<html>/g)).toHaveLength(1);
        expect(doc.match(/<\/html>/g)).toHaveLength(1);
        const first = doc.indexOf('FIRST');
        const hr = doc.indexOf('  </div><hr><div>\n<p>Log session starting');
        const second = doc.indexOf('SECOND');
        expect(first).toBeGreaterThan(0);
        expect(hr).toBeGreaterThan(first);
        expect(second).toBeGreaterThan(hr);
        expect(doc.endsWith('</p>\n  </div></body>\n</html>\n')).toBe(true);
        await logger.stop();
    });
});
