import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    encodeReplay,
    parseReplay,
    replayDurationMs,
    replayFileName,
    replayLatin1ToBytes,
    replayBytesToLatin1,
    REPLAY_MAX_CHUNK,
} from '../../../src/mud/replay/replayFormat';
import { ReplayRecorder } from '../../../src/mud/replay/ReplayRecorder';
import { ReplayPlayer } from '../../../src/mud/replay/ReplayPlayer';
import { MudSession } from '../../../src/mud/MudSession';

const latin1 = (s: string) => replayLatin1ToBytes(s);

describe('replayFormat', () => {
    it('encodes the exact byte layout Mudlet writes (int32 BE offset + int32 BE length + payload)', () => {
        const bytes = encodeReplay([{ offsetMs: 1000, data: latin1('hi') }]);
        expect(Array.from(bytes)).toEqual([
            0x00, 0x00, 0x03, 0xe8, // offset 1000ms
            0x00, 0x00, 0x00, 0x02, // length 2
            0x68, 0x69,             // "hi"
        ]);
    });

    it('round-trips chunks through encode → parse', () => {
        const chunks = [
            { offsetMs: 0, data: latin1('Welcome to the MUD\r\n') },
            { offsetMs: 250, data: latin1('\xff\xfa\xc9Char 1\xff\xf0') },
            { offsetMs: 12345, data: latin1('A prompt> ') },
        ];
        const parsed = parseReplay(encodeReplay(chunks));
        expect(parsed).not.toBeNull();
        expect(parsed!.map(c => c.offsetMs)).toEqual([0, 250, 12345]);
        expect(parsed!.map(c => replayBytesToLatin1(c.data)))
            .toEqual(chunks.map(c => replayBytesToLatin1(c.data)));
    });

    it('splits payloads over Mudlet\'s 100000-byte buffer into continuation records', () => {
        const big = new Uint8Array(REPLAY_MAX_CHUNK + 1).fill(0x41);
        const parsed = parseReplay(encodeReplay([{ offsetMs: 777, data: big }]));
        expect(parsed).not.toBeNull();
        expect(parsed!.length).toBe(2);
        expect(parsed![0].offsetMs).toBe(777);
        expect(parsed![0].data.length).toBe(REPLAY_MAX_CHUNK);
        expect(parsed![1].offsetMs).toBe(0);
        expect(parsed![1].data.length).toBe(1);
    });

    it('drops empty payloads (a 0-length record reads as corruption in Mudlet)', () => {
        const bytes = encodeReplay([
            { offsetMs: 10, data: new Uint8Array(0) },
            { offsetMs: 20, data: latin1('x') },
        ]);
        const parsed = parseReplay(bytes)!;
        expect(parsed.length).toBe(1);
        expect(parsed[0].offsetMs).toBe(20);
    });

    it('reads the modified format (8-byte offsets, Mudlet PR #4400 era)', () => {
        // offset 500ms as int64 BE, length 3, "abc"
        const bytes = new Uint8Array([
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0xf4,
            0x00, 0x00, 0x00, 0x03,
            0x61, 0x62, 0x63,
        ]);
        const parsed = parseReplay(bytes);
        expect(parsed).not.toBeNull();
        expect(parsed!.length).toBe(1);
        expect(parsed![0].offsetMs).toBe(500);
        expect(replayBytesToLatin1(parsed![0].data)).toBe('abc');
    });

    it('rejects corrupt data in both layouts', () => {
        // Truncated payload: header promises 10 bytes, only 2 present.
        expect(parseReplay(new Uint8Array([0, 0, 0, 1, 0, 0, 0, 10, 0x68, 0x69]))).toBeNull();
        // Nonsense length field.
        expect(parseReplay(latin1('This is a plain text file, not a replay.'))).toBeNull();
    });

    it('plays on past a chunk with no bytes in it', () => {
        const bytes = new Uint8Array([
            0, 0, 0, 0, 0, 0, 0, 1, 0x61,
            0, 0, 0, 10, 0, 0, 0, 0,
            0, 0, 0, 10, 0, 0, 0, 1, 0x62,
        ]);
        const parsed = parseReplay(bytes)!;
        expect(parsed.map(c => [c.offsetMs, replayBytesToLatin1(c.data)])).toEqual([[0, 'a'], [10, ''], [10, 'b']]);
    });

    it('accepts an empty file as a zero-chunk replay (Mudlet does too)', () => {
        expect(parseReplay(new Uint8Array(0))).toEqual([]);
    });

    it('sums chunk offsets into the total duration', () => {
        expect(replayDurationMs([
            { offsetMs: 100, data: latin1('a') },
            { offsetMs: 900, data: latin1('b') },
        ])).toBe(1000);
    });

    it('names files in Mudlet\'s yyyy-MM-dd#HH-mm-ss.dat shape', () => {
        expect(replayFileName(new Date(2026, 6, 8, 14, 3, 9))).toBe('2026-07-08#14-03-09.dat');
    });
});

describe('ReplayRecorder', () => {
    afterEach(() => vi.restoreAllMocks());

    it('stamps each chunk with the time elapsed since the previous one', () => {
        const now = vi.spyOn(performance, 'now');
        now.mockReturnValue(1000);
        const recorder = new ReplayRecorder();
        now.mockReturnValue(1250);
        recorder.feed('first');
        now.mockReturnValue(1330);
        recorder.feed('second');
        recorder.feed(''); // empty frames are not recorded

        const parsed = parseReplay(recorder.encode())!;
        expect(parsed.map(c => c.offsetMs)).toEqual([250, 80]);
        expect(parsed.map(c => replayBytesToLatin1(c.data))).toEqual(['first', 'second']);
    });

    it('preserves high-bit bytes (telnet IAC) through the string round-trip', () => {
        const recorder = new ReplayRecorder();
        recorder.feed('\xff\xf9\x00\x80text');
        const parsed = parseReplay(recorder.encode())!;
        expect(Array.from(parsed[0].data)).toEqual([0xff, 0xf9, 0x00, 0x80, 0x74, 0x65, 0x78, 0x74]);
    });
});

describe('ReplayPlayer', () => {
    afterEach(() => vi.useRealTimers());

    it('delivers chunks on their recorded timeline and fires onDone once', () => {
        vi.useFakeTimers();
        const fed: string[] = [];
        let done = 0;
        const player = new ReplayPlayer(
            [
                { offsetMs: 100, data: latin1('one') },
                { offsetMs: 200, data: latin1('two') },
            ],
            { speed: () => 1, feed: d => fed.push(d), onDone: () => done++ },
        );
        player.start();
        expect(fed).toEqual([]);
        vi.advanceTimersByTime(100);
        expect(fed).toEqual(['one']);
        vi.advanceTimersByTime(199);
        expect(fed).toEqual(['one']);
        vi.advanceTimersByTime(1);
        expect(fed).toEqual(['one', 'two']);
        expect(done).toBe(1);
    });

    it('reads the speed divisor at each chunk\'s schedule time', () => {
        vi.useFakeTimers();
        const fed: string[] = [];
        let speed = 1;
        const player = new ReplayPlayer(
            [
                { offsetMs: 100, data: latin1('a') },
                { offsetMs: 100, data: latin1('b') },
            ],
            { speed: () => speed, feed: d => fed.push(d), onDone: () => {} },
        );
        player.start();
        speed = 4; // takes effect when the *next* chunk is scheduled
        vi.advanceTimersByTime(100); // 'a' was already scheduled at speed 1
        expect(fed).toEqual(['a']);
        vi.advanceTimersByTime(25); // 'b' scheduled at speed 4: 100/4 ms
        expect(fed).toEqual(['a', 'b']);
    });

    it('abort stops playback without firing onDone', () => {
        vi.useFakeTimers();
        const fed: string[] = [];
        let done = 0;
        const player = new ReplayPlayer(
            [{ offsetMs: 100, data: latin1('never') }],
            { speed: () => 1, feed: d => fed.push(d), onDone: () => done++ },
        );
        player.start();
        player.abort();
        vi.advanceTimersByTime(1000);
        expect(fed).toEqual([]);
        expect(done).toBe(0);
    });

    it('keeps playing when a chunk\'s feed throws', () => {
        vi.useFakeTimers();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const fed: string[] = [];
        const player = new ReplayPlayer(
            [
                { offsetMs: 0, data: latin1('boom') },
                { offsetMs: 0, data: latin1('after') },
            ],
            {
                speed: () => 1,
                feed: d => { if (d === 'boom') throw new Error('parse hiccup'); fed.push(d); },
                onDone: () => {},
            },
        );
        player.start();
        vi.runAllTimers();
        expect(fed).toEqual(['after']);
        errorSpy.mockRestore();
    });
});

describe('MudSession replay integration', () => {
    afterEach(() => vi.useRealTimers());

    it('plays a replay offline through the full telnet pipeline (text + GMCP)', async () => {
        vi.useFakeTimers();
        const session = new MudSession();
        const text: string[] = [];
        const gmcp: { path: string; value: unknown }[] = [];
        session.events.on('flushLines', groups => {
            for (const g of groups) text.push(g.text);
        });
        session.events.on('gmcp', payload => gmcp.push(payload));
        const lifecycle: string[] = [];
        session.events.on('replay.start', () => lifecycle.push('start'));
        session.events.on('replay.over', () => lifecycle.push('over'));

        const bytes = encodeReplay([
            { offsetMs: 0, data: latin1('Hello from the past\r\n') },
            { offsetMs: 50, data: latin1('\xff\xfa\xc9Char.Vitals {"hp": 42}\xff\xf0More text\r\n') },
        ]);
        expect(session.loadReplayData(bytes)).toBeNull();
        expect(session.isReplaying).toBe(true);
        await vi.runAllTimersAsync();

        expect(text.join('')).toContain('Hello from the past');
        expect(text.join('')).toContain('More text');
        expect(gmcp.length).toBe(1);
        expect(gmcp[0].value).toEqual({ hp: 42 });
        expect(lifecycle).toEqual(['start', 'over']);
        expect(session.isReplaying).toBe(false);
        session.destroy();
    });

    it('refuses a second replay while one is running and a corrupt file up front', () => {
        vi.useFakeTimers();
        const session = new MudSession();
        expect(session.loadReplayData(latin1('garbage not a replay'))).toMatch(/corrupt/);
        const bytes = encodeReplay([{ offsetMs: 1000, data: latin1('x') }]);
        expect(session.loadReplayData(bytes)).toBeNull();
        expect(session.loadReplayData(bytes)).toMatch(/already be in progress/);
        expect(session.abortReplay()).toBe(true);
        expect(session.isReplaying).toBe(false);
        session.destroy();
    });

    it('records the socket.incoming tap and round-trips through its own player', () => {
        const session = new MudSession();
        expect(session.startReplayRecording()).toBe(true);
        expect(session.startReplayRecording()).toBe(false); // already running
        session.events.emit('socket.incoming', 'A line of MUD output\r\n');
        session.events.emit('socket.incoming', '\xff\xf9'); // IAC GA
        const bytes = session.stopReplayRecording();
        expect(bytes).not.toBeNull();
        expect(session.stopReplayRecording()).toBeNull(); // no longer recording
        const parsed = parseReplay(bytes!)!;
        expect(parsed.length).toBe(2);
        expect(replayBytesToLatin1(parsed[0].data)).toBe('A line of MUD output\r\n');
        expect(replayBytesToLatin1(parsed[1].data)).toBe('\xff\xf9');
        session.destroy();
    });

    it('does not re-record a running replay (feedTelnet bypasses socket.incoming)', async () => {
        vi.useFakeTimers();
        const session = new MudSession();
        session.startReplayRecording();
        const bytes = encodeReplay([{ offsetMs: 0, data: latin1('replayed data\r\n') }]);
        expect(session.loadReplayData(bytes)).toBeNull();
        await vi.runAllTimersAsync();
        const recorded = session.stopReplayRecording()!;
        expect(parseReplay(recorded)).toEqual([]);
        session.destroy();
    });

    it('clamps replay speed to Mudlet\'s 1..1024 range and emits changes', () => {
        const session = new MudSession();
        const seen: number[] = [];
        session.events.on('replay.speed', s => seen.push(s));
        session.setReplaySpeed(4);
        session.setReplaySpeed(0);
        session.setReplaySpeed(99999);
        expect(seen).toEqual([4, 1, 1024]);
        expect(session.replaySpeed).toBe(1024);
        session.destroy();
    });
});
