import { describe, it, expect, beforeEach } from 'vitest';
import { VideoManager } from '../../src/ui/video/VideoManager';

// Mudlet's mute toggles reach video too: setMediaPlayersMuted builds a
// TMediaData with mediaType unset, and findMediaPlayersByCriteria maps that to
// the combined sound+music+video lists for the API and GMCP protocols
// (TMedia.cpp). It mutes the audio output, not the player — the picture keeps
// running — which is what <video>.muted does here.

/** http(s) sources skip the VFS loader + blob path, so no loader is needed. */
const SRC = 'https://example.invalid/clip.mp4';

function makeManager() {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const mgr = new VideoManager();
    mgr.setMountPoint(() => mount);
    return { mgr, mount };
}

/** The single <video> the manager mounted. */
function videoIn(mount: HTMLElement): HTMLVideoElement {
    const el = mount.querySelector('video');
    if (!el) throw new Error('no <video> was mounted');
    return el as HTMLVideoElement;
}

describe('VideoManager per-origin mute gates', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('plays unmuted by default and reports both origins audible', async () => {
        const { mgr, mount } = makeManager();
        expect(mgr.isOriginMuted('api')).toBe(false);
        expect(mgr.isOriginMuted('game')).toBe(false);
        await mgr.play(SRC, { name: 'clip', volume: 80 });
        const el = videoIn(mount);
        expect(el.muted).toBe(false);
        expect(el.volume).toBeCloseTo(0.8);
    });

    it('silences a playing video in place and restores it on unmute', async () => {
        const { mgr, mount } = makeManager();
        await mgr.play(SRC, { name: 'clip', volume: 80 });
        const el = videoIn(mount);

        mgr.setOriginMuted('api', true);
        expect(el.muted).toBe(true);
        // Nothing is stopped or torn down — the element stays mounted and its
        // requested volume is untouched, so unmuting resumes mid-clip.
        expect(mount.contains(el)).toBe(true);
        expect(el.volume).toBeCloseTo(0.8);
        expect(mgr.getByState(false, {}).length + mgr.getByState(true, {}).length).toBe(1);

        mgr.setOriginMuted('api', false);
        expect(el.muted).toBe(false);
    });

    it('starts a new video muted while its origin is muted', async () => {
        const { mgr, mount } = makeManager();
        mgr.setOriginMuted('api', true);
        await mgr.play(SRC, { name: 'clip' });
        expect(videoIn(mount).muted).toBe(true);
    });

    it('keeps the two origins independent', async () => {
        const { mgr, mount } = makeManager();
        await mgr.play(SRC, { name: 'script-clip', origin: 'api' });
        await mgr.play(SRC, { name: 'server-clip', origin: 'game' });
        const [apiEl, gameEl] = Array.from(mount.querySelectorAll('video')) as HTMLVideoElement[];

        mgr.setOriginMuted('game', true);
        expect(apiEl.muted).toBe(false);
        expect(gameEl.muted).toBe(true);

        mgr.setOriginMuted('api', true);
        expect(apiEl.muted).toBe(true);
    });

    it('defaults an unlabelled play to the api origin', async () => {
        const { mgr, mount } = makeManager();
        await mgr.play(SRC, { name: 'clip' });
        mgr.setOriginMuted('game', true);
        expect(videoIn(mount).muted).toBe(false);
        mgr.setOriginMuted('api', true);
        expect(videoIn(mount).muted).toBe(true);
    });
});
