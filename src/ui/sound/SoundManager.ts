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
    /** Position in the track, in milliseconds, at which playback ends (Mudlet's
     *  `finish`). Absent → the end of the file. Each pass of a loop ends there. */
    finish?: number;
    /** Loop count. 1 = play once (default). -1 = infinite. N>1 = N total plays. */
    loops?: number;
    /** Dedupe key — calling again with same key replaces the previous one. */
    key?: string;
    /** Group tag — stopMusic({tag=...}) and stopSounds() filter on this. */
    tag?: string;
    /** 1..100 — Mudlet's media priority (sounds only). A sound with a priority
     *  is refused while one of equal or higher priority is playing, and stops
     *  the lower-priority ones when it does play (TMedia::
     *  doesMediaHavePriorityToPlay). Absent → no priority, never refused. */
    priority?: number;
    /** Which mute gate governs this playback. Default 'api'. */
    origin?: MediaOrigin;
    /** Optional closed-caption text (Mudlet's media `caption`). Shown verbatim
     *  when closed captions are on; absent → a caption is synthesized from the
     *  kind + filename. */
    caption?: string;
}

export interface PlayMusicOptions extends PlaySoundOptions {
    /** If true and a music track with the same name (and key, when one is
     *  given) is already playing, do nothing. Mudlet's default is true; the
     *  callers supply it, so absent here means false. */
    continue?: boolean;
}


export interface StopMusicOptions {
    name?: string;
    key?: string;
    tag?: string;
    /** Fade-out duration in milliseconds. Overrides the source's own fadeout. */
    fadeout?: number;
    /** Mudlet's `fadeaway`: fade out before stopping — over `fadeout`, else
     *  the source's own fadeout, else {@link DEFAULT_FADEAWAY_MS} — and keep
     *  the media listed as playing until the fade is over. */
    fadeaway?: boolean;
}

/**
 * Which playing media a stop, pause or query applies to. Every field that is
 * set must match. `name` matches the name a source was played under, the path
 * it resolved to, or either's trailing filename; `priority` is a ceiling — a
 * query passes over a source whose own priority is above it, and a stop or
 * pause also spares one whose priority equals it (only lower priorities are
 * stopped, as on desktop). A source without a priority counts as 0; `origin`
 * narrows to script- or server-started media.
 */
export interface MediaFilter {
    name?: string;
    key?: string;
    tag?: string;
    priority?: number;
    origin?: MediaOrigin;
}

export interface StopSoundsOptions extends MediaFilter {
    /** Fade-out duration in milliseconds. Overrides the source's own fadeout. */
    fadeout?: number;
    /** See {@link StopMusicOptions.fadeaway}. */
    fadeaway?: boolean;
}

/** How long a `fadeaway` stop fades for when neither the stop nor the media
 *  names a fadeout — desktop's TMedia default. */
export const DEFAULT_FADEAWAY_MS = 5000;

/**
 * Turns a media name into the path that is actually played. The engine wires
 * one that finds the file in the profile VFS (so the media events carry its
 * full path, as desktop's do) and expands a `*`/`?` wildcard to one matching
 * file. Null means there is no such file: the request is refused there and
 * then, and never listed as playing. Without a resolver, the name is played as
 * given.
 */
export type MediaPathResolver = (name: string) => string | null;

interface ActiveSource {
    id: number;
    kind: 'sound' | 'music';
    /** The name the media was requested under — what queries report. */
    name: string;
    /** What that name resolved to — what is loaded and what events carry. */
    path: string;
    key?: string;
    tag?: string;
    origin: MediaOrigin;
    caption?: string;
    priority?: number;
    /**
     * `loading` from the play call until the file is decoded — it is listed as
     * playing already, as desktop lists a player from the moment it is asked
     * to play; `playing` once a source node runs; `paused` while held by
     * pauseSounds / pauseMusic, with no node at all.
     */
    state: 'loading' | 'playing' | 'paused';
    /** Set once decoded. */
    buffer?: AudioBuffer;
    /** The pass currently playing; replaced on each pass of a finite loop.
     *  Absent while loading or paused. */
    source?: AudioBufferSourceNode;
    gain: GainNode;
    fadein: number;
    fadeout: number;
    volume: number;
    /** Where each pass begins, in seconds. */
    startSec: number;
    /** Where each pass ends, in seconds; undefined → the end of the file. */
    finishSec?: number;
    /** -1 forever, else the passes still to play after the current one. */
    passesLeft: number;
    /** Context time the current pass's node started, and the track offset it
     *  started at — together they give the position to pause at. */
    passStartedAt: number;
    passOffset: number;
    /** Where a paused source picks up again, in seconds. */
    pausedAt: number;
    /** Whether a sysMediaStarted has gone out for it — a source stopped or
     *  paused before it ever started announces neither. */
    announced: boolean;
    /** Set once stop() has been called so the onended handler doesn't try to fade a stopped source. */
    stopping: boolean;
    /** Stopping, but still fading out — listed as playing until it ends. */
    fading: boolean;
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
    private resolver: MediaPathResolver | null = null;
    /**
     * Bumped by every {@link stopAll}. `play()` has to await a fetch + decode
     * before it can build a source, and a profile close (or resetProfile)
     * landing inside that window would otherwise start the sound *after*
     * teardown stopped everything — the manager has nothing to stop yet, so the
     * track begins playing over a closed profile with no way left to reach it.
     * A play captures the epoch before awaiting and abandons itself if it moved.
     */
    private epoch = 0;
    /** Set by {@link destroy}. Unlike an epoch bump this is permanent: the
     *  session is gone, so no in-flight or later play may start. */
    private destroyed = false;
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
     * happening. A paused source raises it again when it resumes, as a player
     * re-entering PlayingState does. Mudlet withholds it for preload-volume
     * loads; Mudlet Web has no preload volume (`preload()` only warms the
     * decode cache and never builds a source), so there is nothing to withhold
     * it for.
     */
    onMediaStarted?: (file: string, path: string, mediaType: MediaKind, key: string, tag: string) => void;
    /**
     * Raised when a tracked source ends — whether it played out naturally or
     * was stopped. ScriptingEngine wires this to raise Mudlet's
     * `sysMediaFinished(file, path, mediaType, key, tag)`. `stopAll()` nulls
     * each source's onended before stopping, so engine teardown never fires it.
     */
    onMediaFinished?: (file: string, path: string, mediaType: MediaKind, key: string, tag: string) => void;
    /** Raised when pauseSounds / pauseMusic hold a playing source — Mudlet's
     *  `sysMediaPaused`, with the same five arguments. */
    onMediaPaused?: (file: string, path: string, mediaType: MediaKind, key: string, tag: string) => void;
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

    setPathResolver(fn: MediaPathResolver | null): void {
        this.resolver = fn;
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
        const resumed = this.resumeMatching('music', opts);
        if (resumed !== undefined) return resumed;
        if (opts.continue) {
            const playing = this.playingMusic(opts.name, opts.key);
            if (playing) return playing.id;
        }
        // Mudlet music semantics: a new music track replaces the previous one
        // matching the same key (or, when no key, the same name).
        this.stopMusicMatching(opts.name, opts.key);
        return this.play('music', opts);
    }

    /** Mudlet `stopSounds([filter])` — stop the sounds matching `filter`
     *  (every sound when it is empty). Only priorities below the filter's are
     *  stopped. */
    stopSounds(opts: StopSoundsOptions = {}): void {
        const ctx = sharedContext;
        if (!ctx) return;
        for (const a of [...this.active.values()]) {
            if (a.kind !== 'sound' || !matchesFilter(a, opts, true)) continue;
            this.fadeAndStop(ctx, a, stopFade(a, opts));
        }
    }

    /**
     * Mudlet `pauseSounds([filter])`. A Web Audio source node can't be paused,
     * so a paused source drops its node and remembers its position; playing
     * the same name and key again ({@link play}) resumes it from there on a new
     * node. A string filters by tag, Mudlet's "channel". Music is untouched —
     * {@link pauseMusic} covers it.
     */
    pauseSounds(channel?: string | MediaFilter): void {
        this.pauseKind('sound', channel);
    }

    /** Mudlet `pauseMusic([filter])` — {@link pauseSounds} for music. */
    pauseMusic(channel?: string | MediaFilter): void {
        this.pauseKind('music', channel);
        this.updateMediaSessionState();
    }

    stopMusic(opts: StopMusicOptions & { origin?: MediaOrigin } = {}): void {
        const ctx = sharedContext;
        if (!ctx) return;
        for (const a of [...this.active.values()]) {
            if (a.kind !== 'music' || !matchesFilter(a, opts, true)) continue;
            this.fadeAndStop(ctx, a, stopFade(a, opts));
        }
        this.updateMediaSessionState();
    }

    /**
     * Mudlet getPlayingSounds / getPlayingMusic. Returns the sources of the
     * requested `kind` (default 'sound' — music is reported separately by
     * getPlayingMusic) that are playing — from the moment they are asked to
     * play until they end, a fade-out included — optionally filtered. Mudlet
     * lists only the media its Lua API started, so the Lua bindings pass
     * `origin: 'api'`. Volume is reported on Mudlet's 0..100 scale.
     */
    getPlaying(filter: MediaFilter = {}, kind: 'sound' | 'music' = 'sound'): MediaListing[] {
        return this.list(filter, kind, a => a.state !== 'paused' && (!a.stopping || a.fading));
    }

    /** Mudlet getPausedSounds / getPausedMusic — {@link getPlaying} for the
     *  sources pauseSounds / pauseMusic hold. */
    getPaused(filter: MediaFilter = {}, kind: 'sound' | 'music' = 'sound'): MediaListing[] {
        return this.list(filter, kind, a => a.state === 'paused' && !a.stopping);
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
        decodeBuffer(ctx, this.resolve(target) ?? target, this.loader).catch(() => {});
        return true;
    }

    /**
     * Mudlet `purgeMediaCache()` — stop every sound and music track, each
     * raising its sysMediaFinished as TMedia::stopAllMediaPlayers does, and
     * drop every decoded-audio buffer so the next play re-fetches and
     * re-decodes. Deleting the cached files themselves is the caller's part.
     * Always returns true.
     */
    purgeCache(): boolean {
        const ctx = sharedContext;
        if (ctx) {
            for (const a of [...this.active.values()]) this.fadeAndStop(ctx, a, 0);
            this.updateMediaSessionState();
        }
        decodeCache.clear();
        return true;
    }

    /** Stop everything this manager owns — including plays still awaiting a
     *  decode, which abandon themselves rather than starting afterwards. Call
     *  on engine teardown. */
    stopAll(): void {
        this.epoch++;
        const ctx = sharedContext;
        if (!ctx) return;
        for (const a of [...this.active.values()]) {
            if (!a.source) continue;
            try { a.source.onended = null; a.source.stop(); } catch { /* already stopped */ }
        }
        this.active.clear();
        this.updateMediaSessionState();
    }

    destroy(): void {
        this.destroyed = true;
        this.stopAll();
    }

    // ── internal ──────────────────────────────────────────────────────────────

    private resolve(name: string): string | null {
        if (!this.resolver) return name;
        try {
            return this.resolver(name);
        } catch {
            return name;
        }
    }

    private list(filter: MediaFilter, kind: 'sound' | 'music', keep: (a: ActiveSource) => boolean): MediaListing[] {
        const out: MediaListing[] = [];
        for (const a of this.active.values()) {
            if (a.kind !== kind || !keep(a) || !matchesFilter(a, filter, false)) continue;
            out.push({ name: a.name, key: a.key, tag: a.tag, volume: Math.round(a.volume * 100), priority: a.priority });
        }
        return out;
    }

    private async play(kind: 'sound' | 'music', opts: PlaySoundOptions): Promise<number> {
        if (this.destroyed) return -1;
        const ctx = getContext();
        if (!ctx) return -1;
        const name = opts.name;
        if (!name) return -1;
        const epoch = this.epoch;
        const origin: MediaOrigin = opts.origin ?? 'api';

        // Playing the name and key of a paused source picks it up where it was.
        const resumed = this.resumeMatching(kind, opts);
        if (resumed !== undefined) return resumed;

        // Priority (sounds only): refused while a sound of this origin with an
        // equal or higher priority is playing; otherwise it takes over from the
        // lower-priority ones, including those that have no priority at all.
        const priority = kind === 'sound' && opts.priority !== undefined && Number.isFinite(opts.priority)
            ? Math.max(1, Math.min(100, Math.round(opts.priority)))
            : undefined;
        if (priority !== undefined) {
            const rivals = [...this.active.values()]
                .filter(a => a.kind === 'sound' && a.origin === origin && !a.stopping && a.state !== 'paused');
            if (rivals.some(a => (a.priority ?? 0) >= priority)) return -1;
        }

        // A file that isn't there is refused before anything changes: it is
        // never listed, and it ends nothing it would have replaced.
        const path = this.resolve(name);
        if (path === null) return -1;

        if (priority !== undefined) {
            for (const a of [...this.active.values()]) {
                if (a.kind === 'sound' && a.origin === origin && !a.stopping && a.state !== 'paused') {
                    this.fadeAndStop(ctx, a, 0);
                }
            }
        }

        // A new request ends whatever of its kind sits paused: desktop hands a
        // request the paused player first, which stops what it held.
        for (const a of [...this.active.values()]) {
            if (a.kind === kind && a.origin === origin && a.state === 'paused') this.fadeAndStop(ctx, a, 0);
        }

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

        // -1 repeats forever and N>0 plays N passes; 0 and anything below -1
        // mean nothing, and fall back to a single pass as Mudlet does.
        const rawLoops = opts.loops ?? 1;
        const loops = rawLoops === -1 ? -1 : rawLoops >= 1 ? Math.floor(rawLoops) : 1;
        const startSec = Math.max(0, (opts.start ?? 0) / 1000);
        const finishSec = opts.finish !== undefined && Number.isFinite(opts.finish) && opts.finish / 1000 > startSec
            ? opts.finish / 1000
            : undefined;

        // Registered before the file is even fetched: desktop lists a player
        // from the play call on, so getPlayingSounds right after playSoundFile
        // must already see it.
        const gain = ctx.createGain();
        gain.connect(ctx.destination);
        const id = this.nextId++;
        const record: ActiveSource = {
            id,
            kind,
            name,
            path,
            key: opts.key,
            tag: opts.tag,
            origin,
            caption: opts.caption,
            priority,
            state: 'loading',
            gain,
            fadein: Math.max(0, opts.fadein ?? 0),
            fadeout: Math.max(0, opts.fadeout ?? 0),
            volume: clamp01((opts.volume ?? 50) / 100),
            startSec,
            finishSec,
            passesLeft: loops === -1 ? -1 : loops - 1,
            passStartedAt: 0,
            passOffset: startSec,
            pausedAt: startSec,
            announced: false,
            stopping: false,
            fading: false,
        };
        this.active.set(id, record);

        let buffer: AudioBuffer;
        try {
            buffer = await decodeBuffer(ctx, record.path, this.loader);
        } catch (e) {
            console.warn(`[sound] decode failed for "${name}":`, e);
            if (this.active.get(id) === record) this.active.delete(id);
            return -1;
        }
        // The fetch + decode above is the whole race window: a profile close or
        // resetProfile in here already ran its stop pass, so building a source
        // now would leave it playing unreachably. A stop aimed at this play
        // while it loaded has already dropped it, and a pause leaves it held
        // until it is resumed.
        if (this.destroyed || this.epoch !== epoch || this.active.get(id) !== record || record.stopping) return -1;
        record.buffer = buffer;
        if (record.state === 'paused') return id;

        // A muted origin plays silently from the start; unmuting later restores it.
        const target = this.effectiveGain(record);
        const now = ctx.currentTime;
        if (record.fadein > 0) {
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(target, now + record.fadein / 1000);
        } else {
            gain.gain.setValueAtTime(target, now);
        }

        if (!this.startPass(ctx, record, startSec)) {
            this.active.delete(id);
            return -1;
        }
        ensureKeepAlive();
        this.announceStart(record);
        if (kind === 'music') this.updateMediaSessionState(name);
        return id;
    }

    /**
     * Start a pass of `a` at `offsetSec` on a fresh node (a node can be started
     * once). Web Audio's loop flag only repeats forever, so it serves -1 alone,
     * looping between start and finish when a finish is set; a finite count
     * plays each pass on its own node, and each pass is reported with its own
     * sysMediaStarted / sysMediaFinished, as Mudlet's playlist does. A finish
     * ends each finite pass there.
     */
    private startPass(ctx: AudioContext, a: ActiveSource, offsetSec: number): boolean {
        const src = ctx.createBufferSource();
        src.buffer = a.buffer ?? null;
        src.connect(a.gain);
        if (a.passesLeft === -1) {
            src.loop = true;
            if (a.finishSec !== undefined) {
                src.loopStart = a.startSec;
                src.loopEnd = a.finishSec;
            }
        }
        const now = ctx.currentTime;
        try {
            if (a.passesLeft !== -1 && a.finishSec !== undefined) {
                src.start(now, offsetSec, Math.max(0, a.finishSec - offsetSec));
            } else {
                src.start(now, offsetSec);
            }
        } catch (e) {
            console.warn(`[sound] start failed for "${a.name}":`, e);
            return false;
        }
        a.source = src;
        a.state = 'playing';
        a.passStartedAt = now;
        a.passOffset = offsetSec;
        src.onended = () => this.onPassEnded(ctx, a, src);
        return true;
    }

    private onPassEnded(ctx: AudioContext, a: ActiveSource, src: AudioBufferSourceNode): void {
        // A node a pause or a later pass has replaced is no longer this
        // source's to report.
        if (a.source !== src || this.active.get(a.id) !== a) return;
        if (!a.stopping && a.passesLeft > 0) {
            a.passesLeft--;
            this.announceFinish(a);
            if (this.startPass(ctx, a, a.startSec)) {
                this.announceStart(a);
                return;
            }
            this.active.delete(a.id);
            if (a.kind === 'music') this.updateMediaSessionState();
            this.onMediaCaption?.({ kind: a.kind, name: a.name, key: a.key, caption: a.caption, action: 'stops' });
            return;
        }
        this.end(a, false);
    }

    /**
     * Take `a` off the books and report its end. A stop reports it inside the
     * call, as desktop's does, but prints the closing caption a turn later:
     * TMedia releases a stopped player one event-loop turn late, and that turn
     * is what prints it.
     */
    private end(a: ActiveSource, deferCaption: boolean): void {
        this.active.delete(a.id);
        if (a.kind === 'music') this.updateMediaSessionState();
        if (!a.announced) return;
        const caption = () =>
            this.onMediaCaption?.({ kind: a.kind, name: a.name, key: a.key, caption: a.caption, action: 'stops' });
        if (deferCaption) setTimeout(caption, 0);
        else caption();
        this.announceFinish(a);
    }

    /**
     * Mudlet's media events are (file, path, mediaType, key, tag): the played
     * file's name, then its full path. An absent key or tag is an empty
     * QString there, so it must be '' here and not undefined — a nil would
     * shift every argument after it in Lua.
     */
    private eventArgs(a: ActiveSource): [string, string, MediaKind, string, string] {
        return [baseName(a.path), a.path, a.kind, a.key ?? '', a.tag ?? ''];
    }

    private announceStart(a: ActiveSource): void {
        if (!a.announced) {
            this.onMediaCaption?.({ kind: a.kind, name: a.name, key: a.key, caption: a.caption, action: 'plays' });
        }
        a.announced = true;
        this.onMediaStarted?.(...this.eventArgs(a));
    }

    private announceFinish(a: ActiveSource): void {
        this.onMediaFinished?.(...this.eventArgs(a));
    }

    private pauseKind(kind: 'sound' | 'music', channel?: string | MediaFilter): void {
        const ctx = sharedContext;
        if (!ctx) return;
        const filter = typeof channel === 'string' ? { tag: channel } : channel ?? {};
        for (const a of [...this.active.values()]) {
            if (a.kind !== kind || a.stopping || a.state === 'paused' || !matchesFilter(a, filter, true)) continue;
            if (a.state === 'loading') {
                // Nothing has started yet: hold it at its start once decoded.
                a.state = 'paused';
                continue;
            }
            a.pausedAt = this.position(ctx, a);
            const src = a.source;
            a.source = undefined;
            a.state = 'paused';
            if (src) {
                src.onended = null;
                try { src.stop(); } catch { /* already stopped */ }
            }
            this.onMediaPaused?.(...this.eventArgs(a));
        }
    }

    /** Where in the track `a`'s current pass has got to, in seconds. */
    private position(ctx: AudioContext, a: ActiveSource): number {
        let pos = a.passOffset + Math.max(0, ctx.currentTime - a.passStartedAt);
        const end = a.finishSec ?? a.buffer?.duration;
        if (end !== undefined && pos >= end) {
            if (a.passesLeft === -1 && end > a.startSec) {
                pos = a.startSec + ((pos - a.startSec) % (end - a.startSec));
            } else {
                pos = end;
            }
        }
        return pos;
    }

    /** Resume the paused source a play request names — see {@link resume}. */
    private resumeMatching(kind: 'sound' | 'music', opts: PlaySoundOptions): number | undefined {
        return this.resume(kind, { name: opts.name, key: opts.key, tag: opts.tag, origin: opts.origin ?? 'api' });
    }

    /**
     * Resume a paused source of `kind` that the request matches, the way
     * desktop's isMediaMatch() picks one: each of name, key and tag that the
     * request gives must match, and it must give at least one. This is how a
     * server resumes over GMCP with a key or tag alone. Returns the source's
     * id, or undefined when nothing paused matches.
     */
    resume(kind: 'sound' | 'music', req: { name?: string; key?: string; tag?: string; origin?: MediaOrigin }): number | undefined {
        if (!req.name && !req.key && !req.tag) return undefined;
        const origin: MediaOrigin = req.origin ?? 'api';
        for (const a of this.active.values()) {
            if (a.kind !== kind || a.state !== 'paused' || a.stopping || a.origin !== origin) continue;
            if (req.name && a.name !== req.name && a.path !== req.name) continue;
            if (req.key && a.key !== req.key) continue;
            if (req.tag && a.tag !== req.tag) continue;
            const ctx = sharedContext;
            if (!ctx) return undefined;
            if (!a.buffer) {
                // Paused before it had loaded: let the pending play start it.
                a.state = 'loading';
                return a.id;
            }
            a.gain.gain.cancelScheduledValues(ctx.currentTime);
            a.gain.gain.setValueAtTime(this.effectiveGain(a), ctx.currentTime);
            if (!this.startPass(ctx, a, a.pausedAt)) {
                this.active.delete(a.id);
                return -1;
            }
            ensureKeepAlive();
            this.announceStart(a);
            if (kind === 'music') this.updateMediaSessionState(a.name);
            return a.id;
        }
        return undefined;
    }

    private fadeAndStop(ctx: AudioContext, a: ActiveSource, fadeMs: number): void {
        if (a.stopping) return;
        a.stopping = true;
        const src = a.source;
        if (!src) {
            // Still loading, or paused: there is no node to stop. A paused
            // source did start, so its end is reported like any other.
            this.end(a, true);
            return;
        }
        const now = ctx.currentTime;
        if (fadeMs <= 0) {
            // Ended here and now, so reported here and now rather than when
            // the node gets round to its onended.
            src.onended = null;
            try { src.stop(); } catch { /* already stopped */ }
            this.end(a, true);
            return;
        }
        a.fading = true;
        const cur = a.gain.gain.value;
        a.gain.gain.cancelScheduledValues(now);
        a.gain.gain.setValueAtTime(cur, now);
        a.gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
        try { src.stop(now + fadeMs / 1000); } catch { /* already stopped */ }
    }

    /** The music track a `continue` request would carry on with: the same
     *  name, and the same key when the request gives one. */
    private playingMusic(name: string, key: string | undefined): ActiveSource | undefined {
        for (const a of this.active.values()) {
            if (a.kind !== 'music' || a.stopping || a.state === 'paused') continue;
            if (a.name === name && (key === undefined || a.key === key)) return a;
        }
        return undefined;
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
            if (a.kind === 'music' && !a.stopping && a.state !== 'paused') return a.name;
        }
        return null;
    }
}

/** One entry of {@link SoundManager.getPlaying} / {@link SoundManager.getPaused}. */
export interface MediaListing {
    name: string;
    key?: string;
    tag?: string;
    volume: number;
    priority?: number;
}

function baseName(path: string): string {
    return path.split(/[\\/]/).pop() || path;
}

/** How long a stop fades `a` out for. A `fadeaway` stop always fades — over
 *  its own fadeout, else the source's, else desktop's five seconds. */
function stopFade(a: ActiveSource, opts: { fadeout?: number; fadeaway?: boolean }): number {
    if (opts.fadeaway) {
        if (opts.fadeout !== undefined && opts.fadeout > 0) return opts.fadeout;
        return a.fadeout > 0 ? a.fadeout : DEFAULT_FADEAWAY_MS;
    }
    return opts.fadeout !== undefined ? opts.fadeout : a.fadeout;
}

/**
 * Whether `a` is one `f` names. `forStop` is for a stop or pause, which spares
 * a source whose priority equals the filter's — desktop's TMedia stops only
 * the lower ones — where a query lists it.
 */
function matchesFilter(a: ActiveSource, f: MediaFilter, forStop: boolean): boolean {
    if (f.name && !nameMatches(a, f.name)) return false;
    if (f.key && a.key !== f.key) return false;
    if (f.tag && a.tag !== f.tag) return false;
    if (f.priority !== undefined) {
        const p = a.priority ?? 0;
        if (forStop ? p >= f.priority : p > f.priority) return false;
    }
    if (f.origin && a.origin !== f.origin) return false;
    return true;
}

function nameMatches(a: ActiveSource, name: string): boolean {
    if (a.name === name || a.path === name) return true;
    const want = baseName(name);
    return baseName(a.name) === want || baseName(a.path) === want;
}

function clamp01(v: number): number {
    if (!Number.isFinite(v)) return 0;
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
