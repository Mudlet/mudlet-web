// Web Audio backend for Mudlet's playSoundFile / playMusicFile / stopSounds /
// stopMusic. One AudioContext shared across managers (browsers cap them at a
// handful), one gesture-unlock listener for the whole document, and one
// AudioBuffer cache keyed by resolved path — decoding an mp3 is the slow part,
// so caching it lets repeated trigger fires sound instant.
//
// Background-tab reliability:
//   • Pure Web Audio survives tab backgrounding on every desktop browser; the
//     AudioContext's clock keeps running even when setTimeout is throttled.
//   • iOS Safari and some mobile Chrome variants suspend the context on hide.
//     A `visibilitychange` resume() handler covers those.
//   • Music tracks register MediaSession metadata so the OS sees this as a
//     media app — required on iOS for continued background audio and gives
//     OS-level transport controls for free.
//   • A persistent keepalive source plays real audio samples at ~-60 dB on
//     loop whenever any sound is active. Chromium tracks audio output for
//     its "page is actively playing media" flag, which bypasses the ~5s
//     transient-activation expiration that would otherwise silence
//     background-tab playback. A silent (gain=0) source gets throttled the
//     same as no audio at all — the samples have to be genuinely non-zero,
//     just attenuated past the audible floor.

import type { MediaCaptionInfo, MediaKind } from './closedCaption';
import { getBrand } from '../../branding';

type LoaderFn = (path: string) => Promise<ArrayBuffer | null>;

/** Which mute gate a playback belongs to. `api` = triggered by a Lua script
 *  (playSoundFile / playMusicFile); `game` = triggered by the server (MSP, and
 *  GMCP media). Mirrors Mudlet's muteMediaAPI / muteMediaGame split, where API
 *  media maps to MediaProtocolAPI and game media to MSP/GMCP. */
export type MediaOrigin = 'api' | 'game';

export interface PlaySoundOptions {
    name: string;
    /** 0..100 — Mudlet scale. Default 50. */
    volume?: number;
    /** Fade-in duration in milliseconds. */
    fadein?: number;
    /** Fade-out duration in milliseconds (on natural end or stop). */
    fadeout?: number;
    /** Start offset within the buffer, in milliseconds. */
    start?: number;
    /** Loop count. 1 = play once (default). -1 = infinite. N>1 = N total plays. */
    loops?: number;
    /** Dedupe key — calling again with same key replaces the previous one. */
    key?: string;
    /** Group tag — stopMusic({tag=...}) and stopSounds() filter on this. */
    tag?: string;
    /** Which mute gate governs this playback. Default 'api'. */
    origin?: MediaOrigin;
    /** Optional closed-caption text (Mudlet's media `caption`). Shown verbatim
     *  when closed captions are on; absent → a caption is synthesized from the
     *  kind + filename. */
    caption?: string;
}

export interface PlayMusicOptions extends PlaySoundOptions {
    /** If true and a music track with the same name+key is already playing, do nothing. */
    continue?: boolean;
}

export interface StopMusicOptions {
    name?: string;
    key?: string;
    tag?: string;
    /** Fade-out duration in milliseconds. Overrides the source's own fadeout. */
    fadeout?: number;
}

interface ActiveSource {
    id: number;
    kind: 'sound' | 'music';
    name: string;
    key?: string;
    tag?: string;
    origin: MediaOrigin;
    caption?: string;
    source: AudioBufferSourceNode;
    gain: GainNode;
    fadeout: number;
    volume: number;
    /** Set once stop() has been called so the onended handler doesn't try to fade a stopped source. */
    stopping: boolean;
}

// Gain applied to the keepalive source. ~-60 dB — inaudible on typical
// hardware but the underlying samples remain non-zero, which is what
// Chromium's audio-output activity tracking actually inspects.
const KEEPALIVE_GAIN = 0.001;

let sharedContext: AudioContext | null = null;
let sharedKeepAlive: AudioBufferSourceNode | null = null;
let unlockInstalled = false;
const decodeCache = new Map<string, Promise<AudioBuffer>>();

function getContext(): AudioContext | null {
    if (sharedContext) return sharedContext;
    const Ctor: typeof AudioContext | undefined =
        typeof window !== 'undefined'
            ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
            : undefined;
    if (!Ctor) return null;
    sharedContext = new Ctor({ latencyHint: 'interactive' });
    installUnlock();
    installVisibilityResume();
    return sharedContext;
}

function installUnlock(): void {
    if (unlockInstalled || typeof document === 'undefined') return;
    unlockInstalled = true;
    const unlock = () => {
        const ctx = sharedContext;
        if (!ctx) return;
        if (ctx.state === 'suspended') void ctx.resume();
        // iOS Safari only fully unlocks after a no-op buffer plays inside the gesture.
        try {
            const src = ctx.createBufferSource();
            src.buffer = ctx.createBuffer(1, 1, 22050);
            src.connect(ctx.destination);
            src.start(0);
            src.stop(ctx.currentTime + 0.001);
        } catch { /* ignore */ }
    };
    const opts = { capture: true, passive: true } as AddEventListenerOptions;
    document.addEventListener('pointerdown', unlock, opts);
    document.addEventListener('keydown', unlock, opts);
    document.addEventListener('touchstart', unlock, opts);
}

function installVisibilityResume(): void {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
        const ctx = sharedContext;
        if (!ctx) return;
        if (document.visibilityState === 'visible' && ctx.state === 'suspended') {
            void ctx.resume();
        }
    });
}

function ensureKeepAlive(): void {
    const ctx = sharedContext;
    if (!ctx || sharedKeepAlive) return;
    try {
        const src = ctx.createBufferSource();
        src.buffer = createKeepAliveBuffer(ctx);
        src.loop = true;
        const g = ctx.createGain();
        g.gain.value = KEEPALIVE_GAIN;
        src.connect(g).connect(ctx.destination);
        src.start();
        sharedKeepAlive = src;
    } catch { /* ignore — some browsers reject pre-gesture */ }
}

function createKeepAliveBuffer(ctx: AudioContext): AudioBuffer {
    // 1 s of 60 Hz sine. 60 Hz sits below most consumer playback chains'
    // usable response, and the -60 dB gain stage drops it further; the
    // point is just that the PCM samples are non-zero so the output
    // stream looks active to Chromium.
    const sr = ctx.sampleRate;
    const buf = ctx.createBuffer(1, sr, sr);
    const data = buf.getChannelData(0);
    const twoPiF = 2 * Math.PI * 60;
    for (let i = 0; i < data.length; i++) {
        data[i] = Math.sin(twoPiF * i / sr);
    }
    return buf;
}

function decodeBuffer(ctx: AudioContext, path: string, loader: LoaderFn): Promise<AudioBuffer> {
    let pending = decodeCache.get(path);
    if (pending) return pending;
    pending = (async () => {
        const bytes = await loader(path);
        if (!bytes) throw new Error(`sound: failed to load "${path}"`);
        // decodeAudioData detaches the buffer on some engines; pass a copy so a
        // cache miss followed by a hit doesn't surprise the second caller.
        const copy = bytes.slice(0);
        return await ctx.decodeAudioData(copy);
    })();
    pending.catch(() => decodeCache.delete(path));
    decodeCache.set(path, pending);
    return pending;
}

async function defaultLoader(path: string): Promise<ArrayBuffer | null> {
    if (/^https?:|^data:|^blob:/.test(path)) {
        const res = await fetch(path);
        if (!res.ok) return null;
        return await res.arrayBuffer();
    }
    return null;
}

export class SoundManager {
    private nextId = 1;
    private active = new Map<number, ActiveSource>();
    private loader: LoaderFn = defaultLoader;
    /** 0..1, applied as an extra multiplier on every source's gain. */
    private masterVolume = 1;
    /**
     * Persistent per-origin mute gates — Mudlet's muteMediaAPI / muteMediaGame.
     * A muted origin's sources keep playing (their position advances) but their
     * gain is pinned to 0, and new sources of that origin start silent; nothing
     * is stopped, so unmuting restores audibility mid-track. This mirrors Mudlet
     * toggling QAudioOutput::setMuted on the live players by protocol rather than
     * tearing them down.
     */
    private muted: Record<MediaOrigin, boolean> = { api: false, game: false };
    /**
     * Raised when a tracked source starts playing. ScriptingEngine wires this
     * to Mudlet's `sysMediaStarted(file, path, mediaType, key, tag)` — the same
     * five arguments TMedia.cpp appends when a player reaches PlayingState.
     *
     * Fired after `source.start()` has actually been accepted, so a decode
     * failure or a rejected start never announces a playback that isn't
     * happening. Mudlet withholds it for preload-volume loads; mudix has no
     * preload volume (`preload()` only warms the decode cache and never builds
     * a source), so there is nothing to withhold it for.
     */
    onMediaStarted?: (file: string, path: string, mediaType: MediaKind, key: string, tag: string) => void;
    /**
     * Raised when a tracked source ends — whether it played out naturally or
     * was stopped. ScriptingEngine wires this to raise Mudlet's
     * `sysMediaFinished(file, path, mediaType, key, tag)`. `stopAll()` nulls
     * each source's onended before stopping, so engine teardown never fires it.
     */
    onMediaFinished?: (file: string, path: string, mediaType: MediaKind, key: string, tag: string) => void;
    /**
     * Raised when a tracked source starts ('plays') or ends ('stops'), so the
     * engine can print a closed caption (Mudlet's enableClosedCaption). Fires
     * regardless of the caption setting — the consumer decides whether to show
     * it. Not fired by `stopAll()` (teardown nulls each onended first).
     */
    onMediaCaption?: (info: MediaCaptionInfo) => void;

    setLoader(fn: LoaderFn | null): void {
        // Different profiles can resolve the same VFS-relative path (e.g.
        // "media/hit.wav") to different bytes — clear the decoded-buffer cache
        // on every loader swap so cross-profile contamination is impossible.
        decodeCache.clear();
        this.loader = fn ?? defaultLoader;
    }

    setMasterVolume(value: number): void {
        const v = Number(value);
        this.masterVolume = Number.isFinite(v) ? Math.max(0, Math.min(1, v / 100)) : 1;
        const ctx = sharedContext;
        if (!ctx) return;
        const now = ctx.currentTime;
        for (const a of this.active.values()) {
            a.gain.gain.cancelScheduledValues(now);
            a.gain.gain.setValueAtTime(this.effectiveGain(a), now);
        }
    }

    /**
     * Mudlet `muteMediaAPI` / `muteMediaGame`. Sets the persistent mute gate for
     * a playback origin. While muted, that origin's currently-playing sources are
     * silenced in place (gain → 0, position keeps advancing) and any new ones
     * start silent — but nothing is stopped, so unmuting restores audibility
     * mid-track. `api` gates script playback (playSoundFile/playMusicFile);
     * `game` gates server-driven media (MSP / GMCP).
     */
    setOriginMuted(origin: MediaOrigin, muted: boolean): void {
        if (this.muted[origin] === muted) return;
        this.muted[origin] = muted;
        const ctx = sharedContext;
        if (!ctx) return;
        const now = ctx.currentTime;
        for (const a of this.active.values()) {
            if (a.origin !== origin || a.stopping) continue;
            a.gain.gain.cancelScheduledValues(now);
            a.gain.gain.setValueAtTime(this.effectiveGain(a), now);
        }
    }

    isOriginMuted(origin: MediaOrigin): boolean {
        return this.muted[origin];
    }

    /** Output gain for a source: its own volume scaled by the master volume,
     *  pinned to 0 while its origin is muted. */
    private effectiveGain(a: ActiveSource): number {
        return this.muted[a.origin] ? 0 : a.volume * this.masterVolume;
    }

    async playSound(opts: PlaySoundOptions): Promise<number> {
        return this.play('sound', opts);
    }

    async playMusic(opts: PlayMusicOptions): Promise<number> {
        if (opts.continue && this.isMusicPlaying(opts.name, opts.key)) return -1;
        // Mudlet music semantics: a new music track replaces the previous one
        // matching the same key (or, when no key, the same name).
        this.stopMusicMatching(opts.name, opts.key);
        return this.play('music', opts);
    }

    stopSounds(): void {
        const ctx = sharedContext;
        if (!ctx) return;
        for (const a of [...this.active.values()]) {
            if (a.kind === 'sound') this.fadeAndStop(ctx, a, a.fadeout);
        }
    }

    /**
     * Mudlet `pauseSounds([channel])`. Web Audio source nodes can be
     * scheduled to start but not paused once playing — they're transient by
     * design, with no equivalent of QMediaPlayer::pause(). We approximate
     * Mudlet's contract by stopping the matching sources outright (so the
     * mute happens immediately) and let the player retrigger them with
     * `playSoundFile` to resume. The optional `channel` filters by the
     * source's `tag` (matches Mudlet's "channel" semantics: a Tag string
     * passed to playSoundFile). Music sources are untouched — they have a
     * separate `stopMusic` codepath.
     */
    pauseSounds(channel?: string): void {
        const ctx = sharedContext;
        if (!ctx) return;
        for (const a of [...this.active.values()]) {
            if (a.kind !== 'sound') continue;
            if (channel && a.tag !== channel) continue;
            this.fadeAndStop(ctx, a, a.fadeout);
        }
    }

    /**
     * Mudlet `pauseMusic([settings])`. Web Audio source nodes can't truly
     * pause once started (same constraint as {@link pauseSounds}), so this is
     * an immediate fade-out + stop of the matching music sources — re-trigger
     * `playMusicFile` to "resume". The optional `channel`/tag filters which
     * music tracks are affected; sound effects are untouched.
     */
    pauseMusic(channel?: string): void {
        const ctx = sharedContext;
        if (!ctx) return;
        for (const a of [...this.active.values()]) {
            if (a.kind !== 'music') continue;
            if (channel && a.tag !== channel) continue;
            this.fadeAndStop(ctx, a, a.fadeout);
        }
        this.updateMediaSessionState();
    }

    stopMusic(opts: StopMusicOptions = {}): void {
        const ctx = sharedContext;
        if (!ctx) return;
        for (const a of [...this.active.values()]) {
            if (a.kind !== 'music') continue;
            if (opts.name && a.name !== opts.name) continue;
            if (opts.key && a.key !== opts.key) continue;
            if (opts.tag && a.tag !== opts.tag) continue;
            const fade = opts.fadeout !== undefined ? opts.fadeout : a.fadeout;
            this.fadeAndStop(ctx, a, fade);
        }
        this.updateMediaSessionState();
    }

    /**
     * Mudlet getPlayingSounds / getPlayingMusic. Returns the currently-playing
     * sources of the requested `kind` (default 'sound' — music is reported
     * separately by getPlayingMusic) optionally filtered by name/key/tag.
     * Volume is reported on Mudlet's 0..100 scale.
     */
    getPlaying(
        filter: { name?: string; key?: string; tag?: string } = {},
        kind: 'sound' | 'music' = 'sound',
    ): Array<{
        name: string; key?: string; tag?: string; volume: number;
    }> {
        const out: Array<{ name: string; key?: string; tag?: string; volume: number }> = [];
        for (const a of this.active.values()) {
            if (a.kind !== kind || a.stopping) continue;
            if (filter.name && a.name !== filter.name) continue;
            if (filter.key && a.key !== filter.key) continue;
            if (filter.tag && a.tag !== filter.tag) continue;
            out.push({ name: a.name, key: a.key, tag: a.tag, volume: Math.round(a.volume * 100) });
        }
        return out;
    }

    /**
     * Mudlet loadSoundFile. Preloads (decodes + caches) a sound so the first
     * playSoundFile has no decode latency. Fire-and-forget: warms `decodeCache`
     * via the same path playSound uses, so a later play of the same name hits
     * the cache. Returns false when no AudioContext is available yet.
     */
    preload(name: string): boolean {
        const target = (name ?? '').trim();
        if (!target) return false;
        const ctx = getContext();
        if (!ctx) return false;
        // Swallow rejection — decodeBuffer already evicts failed entries from
        // the cache, and preload is advisory.
        decodeBuffer(ctx, target, this.loader).catch(() => {});
        return true;
    }

    /**
     * Mudlet `purgeMediaCache()` — drop every decoded-audio buffer so the next
     * play of any file re-fetches and re-decodes it. Active playback is
     * untouched (the cache only fronts the decode step). Always returns true.
     */
    purgeCache(): boolean {
        decodeCache.clear();
        return true;
    }

    /** Stop everything this manager owns. Call on engine teardown. */
    stopAll(): void {
        const ctx = sharedContext;
        if (!ctx) return;
        for (const a of [...this.active.values()]) {
            try { a.source.onended = null; a.source.stop(); } catch { /* already stopped */ }
        }
        this.active.clear();
        this.updateMediaSessionState();
    }

    destroy(): void {
        this.stopAll();
    }

    // ── internal ──────────────────────────────────────────────────────────────

    private async play(kind: 'sound' | 'music', opts: PlaySoundOptions): Promise<number> {
        const ctx = getContext();
        if (!ctx) return -1;
        const name = opts.name;
        if (!name) return -1;

        // Replace any source with the same explicit key in this kind.
        if (opts.key) {
            for (const a of [...this.active.values()]) {
                if (a.kind === kind && a.key === opts.key) this.fadeAndStop(ctx, a, 0);
            }
        }

        if (ctx.state === 'suspended') {
            // Resume is async but cheap. If the gesture hasn't happened yet the
            // resume will just stay pending; the play below will still queue and
            // start automatically once unlock fires.
            void ctx.resume();
        }

        let buffer: AudioBuffer;
        try {
            buffer = await decodeBuffer(ctx, name, this.loader);
        } catch (e) {
            console.warn(`[sound] decode failed for "${name}":`, e);
            return -1;
        }

        const volume = clamp01((opts.volume ?? 50) / 100);
        const fadein = Math.max(0, opts.fadein ?? 0);
        const fadeout = Math.max(0, opts.fadeout ?? 0);
        const loops = opts.loops ?? 1;
        const startOffset = Math.max(0, (opts.start ?? 0) / 1000);
        const origin: MediaOrigin = opts.origin ?? 'api';

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        source.connect(gain).connect(ctx.destination);

        // A muted origin plays silently from the start; unmuting later restores it.
        const target = this.muted[origin] ? 0 : volume * this.masterVolume;
        const now = ctx.currentTime;
        if (fadein > 0) {
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(target, now + fadein / 1000);
        } else {
            gain.gain.setValueAtTime(target, now);
        }

        // Loops: -1 → infinite, 1 → one-shot, N>1 → repeat (N-1) more times.
        // Web Audio loop is binary; for finite N>1 we set loop=true and stop
        // the source after N*duration. Source.duration accounts for sampleRate
        // mismatches between buffer and context.
        if (loops === -1) {
            source.loop = true;
        } else if (loops > 1) {
            source.loop = true;
            const stopAt = now + (buffer.duration - startOffset) * loops;
            try { source.stop(stopAt); } catch { /* offset out of range, ignore */ }
        }

        try {
            source.start(now, startOffset);
        } catch (e) {
            console.warn(`[sound] start failed for "${name}":`, e);
            return -1;
        }

        const id = this.nextId++;
        const record: ActiveSource = {
            id,
            kind,
            name,
            key: opts.key,
            tag: opts.tag,
            origin,
            caption: opts.caption,
            source,
            gain,
            fadeout,
            volume,
            stopping: false,
        };
        this.active.set(id, record);
        ensureKeepAlive();
        this.onMediaCaption?.({ kind, name, key: opts.key, caption: opts.caption, action: 'plays' });
        // Mudlet's media events are (file, path, mediaType, key, tag): the URL's
        // trailing filename, then its full path. We resolve a path for playback,
        // so split the name the script passed in the same way. An absent key or
        // tag is an empty QString there, so it must be '' here and not
        // undefined — a nil would shift every argument after it in Lua.
        const filename = name.split(/[\\/]/).pop() || name;
        this.onMediaStarted?.(filename, name, kind, opts.key ?? '', opts.tag ?? '');

        source.onended = () => {
            this.active.delete(id);
            if (kind === 'music') this.updateMediaSessionState();
            this.onMediaCaption?.({ kind, name, key: opts.key, caption: opts.caption, action: 'stops' });
            this.onMediaFinished?.(filename, name, kind, opts.key ?? '', opts.tag ?? '');
        };

        if (kind === 'music') this.updateMediaSessionState(name);
        return id;
    }

    private fadeAndStop(ctx: AudioContext, a: ActiveSource, fadeMs: number): void {
        if (a.stopping) return;
        a.stopping = true;
        const now = ctx.currentTime;
        if (fadeMs > 0) {
            const cur = a.gain.gain.value;
            a.gain.gain.cancelScheduledValues(now);
            a.gain.gain.setValueAtTime(cur, now);
            a.gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
            try { a.source.stop(now + fadeMs / 1000); } catch { /* already stopped */ }
        } else {
            try { a.source.stop(); } catch { /* already stopped */ }
        }
    }

    private isMusicPlaying(name: string, key: string | undefined): boolean {
        for (const a of this.active.values()) {
            if (a.kind !== 'music') continue;
            if (key !== undefined) { if (a.key === key) return true; }
            else if (a.name === name) return true;
        }
        return false;
    }

    private stopMusicMatching(name: string, key: string | undefined): void {
        const ctx = sharedContext;
        if (!ctx) return;
        for (const a of [...this.active.values()]) {
            if (a.kind !== 'music') continue;
            const match = key !== undefined ? a.key === key : a.name === name;
            if (match) this.fadeAndStop(ctx, a, 0);
        }
    }

    private updateMediaSessionState(playingTitle?: string): void {
        if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
        const ms = navigator.mediaSession;
        const anyMusic = playingTitle ?? this.firstActiveMusicName();
        if (anyMusic) {
            try {
                ms.metadata = new MediaMetadata({
                    title: anyMusic.split('/').pop() ?? anyMusic,
                    artist: getBrand().appName,
                });
            } catch { /* MediaMetadata missing on older Safari */ }
            ms.playbackState = 'playing';
        } else {
            ms.playbackState = 'none';
        }
    }

    private firstActiveMusicName(): string | null {
        for (const a of this.active.values()) {
            if (a.kind === 'music' && !a.stopping) return a.name;
        }
        return null;
    }
}

function clamp01(v: number): number {
    if (!Number.isFinite(v)) return 0;
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
