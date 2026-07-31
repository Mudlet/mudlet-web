// Mudlet `playVideoFile / pauseVideos / stopVideos`. mudix mounts <video>
// elements as absolutely-positioned overlay children of the main viewport.
// Video files are looked up through the same loader callback the SoundManager
// uses, so VFS paths and http(s) URLs both work.
//
// This is intentionally minimal — Mudlet's spec is just "play a video file";
// per-channel routing and z-ordering can be added later. Each play creates
// (or replaces) a single video element keyed by name; pauseVideos pauses all,
// stopVideos pauses + removes them.

import type { MediaCaptionInfo } from '../sound/closedCaption';
import type { MediaOrigin } from '../sound/SoundManager';

type LoaderFn = (path: string) => Promise<ArrayBuffer | null>;

export interface PlayVideoOptions {
    name: string;
    /** 0..100 — Mudlet scale. Default 50. */
    volume?: number;
    /** Loop count. 1 = play once (default). -1 = infinite. */
    loops?: number;
    /** CSS units; default fills the viewport. */
    width?: string;
    height?: string;
    /** Optional closed-caption text (Mudlet's media `caption`). */
    caption?: string;
    /** Which mute gate governs this playback. Default 'api' — the only way to
     *  reach a video today is Lua's `playVideoFile`, but GMCP `Client.Media`
     *  defines a video type, so the gate is parameterised like the sounds'. */
    origin?: MediaOrigin;
}

interface ActiveVideo {
    name: string;
    /** Original path/URL the video was played from (for getPlayingVideos). */
    path: string;
    origin: MediaOrigin;
    element: HTMLVideoElement;
    objectUrl: string | null;
}

export class VideoManager {
    private loader: LoaderFn | null = null;
    /** Returns the DOM element that videos should be attached to. Set by
     *  WindowManager.observeMain so videos drop onto the main viewport. */
    private getMount: (() => HTMLElement | null) | null = null;
    private active = new Map<string, ActiveVideo>();
    /** Buffers fetched ahead of play via loadVideoFile, keyed by VFS path. */
    private prefetched = new Map<string, ArrayBuffer>();
    /**
     * Per-origin mute gates, the video half of {@link SoundManager}'s. A muted
     * origin's videos keep playing (picture and position both advance) with the
     * element muted, and new ones start muted — nothing is stopped, so unmuting
     * restores audio mid-clip. `volume` is left alone so `getPlayingVideos`
     * still reports what the script asked for.
     */
    private muted: Record<MediaOrigin, boolean> = { api: false, game: false };
    /** Fires when a video ends naturally or is stopped — mirrors Mudlet's
     *  sysMediaFinished. */
    onEnded: ((name: string, path: string) => void) | null = null;
    /** Raised when a video starts ('plays') or finishes ('stops') so the engine
     *  can print a closed caption (Mudlet's enableClosedCaption). */
    onMediaCaption: ((info: MediaCaptionInfo) => void) | null = null;

    setLoader(fn: LoaderFn | null): void {
        this.loader = fn;
    }

    setMountPoint(fn: (() => HTMLElement | null) | null): void {
        this.getMount = fn;
    }

    /** Mudlet `muteMediaAPI` / `muteMediaGame`, applied to video playback. See
     *  {@link muted}; the sound-side twin is `SoundManager.setOriginMuted`. */
    setOriginMuted(origin: MediaOrigin, muted: boolean): void {
        if (this.muted[origin] === muted) return;
        this.muted[origin] = muted;
        for (const v of this.active.values()) {
            if (v.origin === origin) v.element.muted = muted;
        }
    }

    isOriginMuted(origin: MediaOrigin): boolean {
        return this.muted[origin];
    }

    /**
     * Mudlet `loadVideoFile`. Preloads (fetches + caches) a VFS-backed video so
     * the first playVideoFile has no fetch latency. http(s)/data/blob URLs need
     * no preloading (the element fetches them directly) and report success.
     * Returns false when no loader is wired or the fetch fails.
     */
    async preload(path: string): Promise<boolean> {
        const target = (path ?? '').trim();
        if (!target) return false;
        if (/^https?:|^data:|^blob:/.test(target)) return true;
        if (this.prefetched.has(target)) return true;
        const buf = await this.loader?.(target) ?? null;
        if (!buf) return false;
        this.prefetched.set(target, buf);
        return true;
    }

    async play(path: string, opts: PlayVideoOptions): Promise<boolean> {
        const mount = this.getMount?.() ?? null;
        if (!mount) return false;
        const name = opts.name || path.split(/[/\\]/).pop() || path;
        const origin: MediaOrigin = opts.origin ?? 'api';
        this.stopByName(name);

        let src: string;
        let objectUrl: string | null = null;
        if (/^https?:|^data:|^blob:/.test(path)) {
            src = path;
        } else {
            const buf = this.prefetched.get(path) ?? await this.loader?.(path) ?? null;
            if (!buf) return false;
            const blob = new Blob([buf as BlobPart], { type: 'video/mp4' });
            objectUrl = URL.createObjectURL(blob);
            src = objectUrl;
        }

        const el = document.createElement('video');
        el.src = src;
        el.autoplay = true;
        el.controls = false;
        el.playsInline = true;
        el.loop = (opts.loops ?? 1) < 0;
        el.volume = Math.max(0, Math.min(1, (opts.volume ?? 50) / 100));
        // A muted origin plays silently from the start; unmuting later restores it.
        el.muted = this.muted[origin];
        el.style.position = 'absolute';
        el.style.top = '0';
        el.style.left = '0';
        el.style.width = opts.width ?? '100%';
        el.style.height = opts.height ?? '100%';
        el.style.objectFit = 'contain';
        el.style.zIndex = '500';
        el.style.background = 'transparent';
        el.style.pointerEvents = 'none';

        const entry: ActiveVideo = { name, path, origin, element: el, objectUrl };
        el.addEventListener('ended', () => {
            // For finite loops > 1, replay manually until counter exhausts.
            const desired = opts.loops ?? 1;
            if (desired > 1) {
                const left = Number(el.dataset.loopsLeft ?? desired) - 1;
                if (left > 0) {
                    el.dataset.loopsLeft = String(left);
                    el.currentTime = 0;
                    void el.play();
                    return;
                }
            }
            this.stopByName(name);
            this.onMediaCaption?.({ kind: 'video', name, caption: opts.caption, action: 'stops' });
            this.onEnded?.(name, path);
        });
        mount.appendChild(el);
        this.active.set(name, entry);
        this.onMediaCaption?.({ kind: 'video', name, caption: opts.caption, action: 'plays' });
        try {
            await el.play();
        } catch {
            // Autoplay may be blocked by user-gesture policy; the element still
            // exists and the user can recover via pause/resume scripts.
        }
        return true;
    }

    pauseAll(): void {
        for (const v of this.active.values()) v.element.pause();
    }

    /**
     * Mudlet `getPlayingVideos([settings])` / `getPausedVideos([settings])`.
     * Lists the videos currently in the requested play state, optionally
     * filtered by name. Volume is reported on Mudlet's 0..100 scale.
     */
    getByState(
        wantPaused: boolean,
        filter: { name?: string } = {},
    ): Array<{ name: string; path: string; volume: number }> {
        const out: Array<{ name: string; path: string; volume: number }> = [];
        for (const v of this.active.values()) {
            if (v.element.paused !== wantPaused) continue;
            if (filter.name && v.name !== filter.name) continue;
            out.push({ name: v.name, path: v.path, volume: Math.round(v.element.volume * 100) });
        }
        return out;
    }

    stopAll(): void {
        for (const name of Array.from(this.active.keys())) this.stopByName(name);
    }

    private stopByName(name: string): void {
        const v = this.active.get(name);
        if (!v) return;
        try { v.element.pause(); } catch { /* element may already be detached */ }
        v.element.remove();
        if (v.objectUrl) URL.revokeObjectURL(v.objectUrl);
        this.active.delete(name);
    }

    destroy(): void {
        this.stopAll();
        this.prefetched.clear();
        this.loader = null;
        this.getMount = null;
        this.onEnded = null;
    }
}
