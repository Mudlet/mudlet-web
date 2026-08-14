// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { buildGif } from '../gifFixture';

// Drives the Mudlet QMovie-family globals (setMovie / startMovie / pauseMovie /
// setMovieFrame / setMovieSpeed / scaleMovie) through the real Lua runtime the
// way a Mudlet script would, with the VFS bytes reader stubbed to serve a
// generated two-frame GIF.

const GIF_PATH = '/profiles/test-connection/movie.gif';
const GIF_BYTES = buildGif({
    width: 2, height: 2,
    palette: [[255, 0, 0], [0, 0, 255]],
    frames: [
        { width: 2, height: 2, indices: [0, 0, 0, 0], delayCs: 10 },
        { width: 2, height: 2, indices: [1, 1, 1, 1], delayCs: 10 },
    ],
    loopCount: 0,
});

// Swap just the host's file-bytes reader, keeping every other host member.
function setBytesReader(fn: (path: string) => Uint8Array | null): void {
    rtRef!.api.setHost({ ...rtRef!.api.engineHost, readFileBytes: fn });
}
let rtRef: TestRuntime | null = null;

describe('label movie APIs (QMovie family)', () => {
    let rt: TestRuntime;

    beforeAll(async () => {
        rt = await createTestRuntime();
        rtRef = rt;
        setBytesReader((path) => (path === GIF_PATH ? GIF_BYTES : null));
        rt.run(`createLabel("movieLabel", 0, 0, 50, 50, 0)`);
    });
    afterAll(() => {
        // Stops the player's timer so nothing ticks after the suite.
        rt.session.labels.clearAll();
        rt.dispose();
    });

    it('setMovie decodes the GIF, installs it, and starts playback', () => {
        expect(rt.run(`return setMovie("movieLabel", "${GIF_PATH}")`)).toBe(true);
        const movie = rt.session.labels.getMovie('movieLabel');
        expect(movie).not.toBeNull();
        expect(movie!.frameCount).toBe(2);
        expect(movie!.isPlaying).toBe(true);
        expect(movie!.gif.plays).toBe(Infinity);
    });

    // Every refusal is (nil, message): a bare false could not be told from
    // setMovieFrame's legitimate "no such frame" answer, and the reason a movie
    // was rejected is the whole point of asking.
    it('rejects missing labels, missing files, and non-GIF bytes', () => {
        expect(rt.run(`return (setMovie("noSuchLabel", "${GIF_PATH}"))`)).toBeNull();
        expect(rt.run(`local _, e = setMovie("noSuchLabel", "${GIF_PATH}") return e`))
            .toBe("label 'noSuchLabel' does not exist");
        expect(rt.run(`return (setMovie("movieLabel", "/nope.gif"))`)).toBeNull();
        expect(rt.run(`local _, e = setMovie("movieLabel", "/nope.gif") return e`))
            .toBe("no valid movie found at '/nope.gif'");
        setBytesReader(() => new Uint8Array([1, 2, 3]));
        expect(rt.run(`return (setMovie("movieLabel", "/garbage.bin"))`)).toBeNull();
        setBytesReader((path) => (path === GIF_PATH ? GIF_BYTES : null));
    });

    it('rejects WebP/APNG when the browser has no ImageDecoder (node env)', () => {
        // A sniffable PNG header — but this environment lacks WebCodecs, so
        // the async path must refuse rather than install a dead player.
        setBytesReader(() => new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
            0, 0, 0, 5, 0, 0, 0, 7, 8, 6, 0, 0, 0,
        ]));
        expect(rt.run(`return (setMovie("movieLabel", "/anim.png"))`)).toBeNull();
        setBytesReader((path) => (path === GIF_PATH ? GIF_BYTES : null));
    });

    it('pauseMovie / startMovie toggle playback', () => {
        expect(rt.run(`return pauseMovie("movieLabel")`)).toBe(true);
        expect(rt.session.labels.getMovie('movieLabel')!.isPlaying).toBe(false);
        expect(rt.run(`return startMovie("movieLabel")`)).toBe(true);
        expect(rt.session.labels.getMovie('movieLabel')!.isPlaying).toBe(true);
        // A label with no movie is (nil, "no movie found at label ...") —
        // distinct from a label that isn't there at all.
        rt.run(`createLabel("bareLabel", 0, 0, 10, 10, 0)`);
        expect(rt.run(`return (pauseMovie("bareLabel"))`)).toBeNull();
        expect(rt.run(`local _, e = pauseMovie("bareLabel") return e`))
            .toBe("no movie found at label 'bareLabel'");
        expect(rt.run(`return (startMovie("bareLabel"))`)).toBeNull();
    });

    it('setMovieFrame jumps within bounds, false outside', () => {
        expect(rt.run(`return setMovieFrame("movieLabel", 1)`)).toBe(true);
        expect(rt.session.labels.getMovie('movieLabel')!.currentFrame).toBe(1);
        expect(rt.run(`return setMovieFrame("movieLabel", 5)`)).toBe(false);
    });

    it('setMovieSpeed stores the playback speed', () => {
        expect(rt.run(`return setMovieSpeed("movieLabel", 200)`)).toBe(true);
        expect(rt.session.labels.getMovie('movieLabel')!.speed).toBe(200);
    });

    it('scaleMovie switches between autoscale and frozen scale', () => {
        expect(rt.run(`return scaleMovie("movieLabel")`)).toBe(true);
        expect(rt.session.labels.getMovie('movieLabel')!.scale).toEqual({ mode: 'auto' });
        expect(rt.run(`return scaleMovie("movieLabel", false)`)).toBe(true);
        expect(rt.session.labels.getMovie('movieLabel')!.scale)
            .toEqual({ mode: 'fixed', width: 50, height: 50 });
        expect(rt.run(`return (scaleMovie("bareLabel"))`)).toBeNull();
    });

    it('echoing to the label replaces the movie (QLabel setText semantics)', () => {
        expect(rt.session.labels.getMovie('movieLabel')).not.toBeNull();
        rt.run(`echo("movieLabel", "text content")`);
        expect(rt.session.labels.getMovie('movieLabel')).toBeNull();
    });
});
