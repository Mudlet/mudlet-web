import type { TtsManager } from '../../../ui/tts/TtsManager';
import type { BindingContext } from './context';

/**
 * Mudlet's media globals: sound effects, music, video, and text-to-speech.
 *
 * All four share one calling convention. Lua may pass either a positional form
 * (`playSoundFile(name, volume)`) or a Mudlet-style options table; Bridge.lua
 * normalises positional → table before reaching these primitives, so every
 * `__`-prefixed binding here takes a single table argument.
 */

/**
 * Unwrap a wasmoon table proxy into a plain JS object.
 *
 * wasmoon hands Lua tables across as lazy proxies; `$detach(1)` materialises one
 * level, which is all these option tables ever need. A value that is already a
 * plain object (or absent) passes straight through.
 */
const detachOpts = (t: unknown): Record<string, unknown> => {
    if (!t || typeof t !== 'object') return {};
    const proxy = t as { $detach?: (dt: number) => Record<string, unknown> };
    return typeof proxy.$detach === 'function' ? proxy.$detach(1) : (t as Record<string, unknown>);
};

/** Optional numeric option: absent/nil/non-finite all read as "not supplied". */
const numOpt = (v: unknown): number | undefined => {
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
};

/** Optional string option; the empty string reads as "not supplied". */
const strOpt = (v: unknown): string | undefined => {
    if (v === undefined || v === null) return undefined;
    const s = String(v);
    return s.length > 0 ? s : undefined;
};

/**
 * Mudlet playSoundFile / playMusicFile / stopSounds / stopMusic and friends.
 * Web Audio backend lives on session.sounds.
 */
export function installSoundBindings({ lua, api }: BindingContext): void {
    const sounds = api.sounds;

    lua.global.set('__playSoundFile', (t: unknown) => {
        const o = detachOpts(t);
        void sounds.playSound({
            name: String(o.name ?? ''),
            volume: numOpt(o.volume),
            fadein: numOpt(o.fadein),
            fadeout: numOpt(o.fadeout),
            start: numOpt(o.start),
            loops: numOpt(o.loops),
            key: strOpt(o.key),
            tag: strOpt(o.tag),
            caption: strOpt(o.caption),
            origin: 'api',
        });
        return true;
    });
    lua.global.set('__playMusicFile', (t: unknown) => {
        const o = detachOpts(t);
        void sounds.playMusic({
            name: String(o.name ?? ''),
            volume: numOpt(o.volume),
            fadein: numOpt(o.fadein),
            fadeout: numOpt(o.fadeout),
            start: numOpt(o.start),
            loops: numOpt(o.loops),
            key: strOpt(o.key),
            tag: strOpt(o.tag),
            caption: strOpt(o.caption),
            continue: o.continue === true || o['continue'] === true,
            origin: 'api',
        });
        return true;
    });
    lua.global.set('stopSounds', () => { sounds.stopSounds(); });
    lua.global.set('__stopMusic', (t?: unknown) => {
        const o = detachOpts(t);
        sounds.stopMusic({
            name: strOpt(o.name),
            key: strOpt(o.key),
            tag: strOpt(o.tag),
            fadeout: numOpt(o.fadeout),
        });
    });
    // getPlayingSounds([filter]) — Bridge.lua normalises both the positional
    // (name[,key][,tag]) and the options-table forms into a single options
    // table, then re-indexes the JS 0-indexed array of {name,key,tag,volume}
    // into a 1-based Lua array.
    lua.global.set('__getPlayingSounds', (t?: unknown) => {
        const o = detachOpts(t);
        return sounds.getPlaying({
            name: strOpt(o.name),
            key: strOpt(o.key),
            tag: strOpt(o.tag),
        });
    });
    // getPlayingMusic([filter]) — sister of getPlayingSounds for the music
    // channel. Same {name,key,tag} filter and {name,key,tag,volume} shape.
    lua.global.set('__getPlayingMusic', (t?: unknown) => {
        const o = detachOpts(t);
        return sounds.getPlaying({
            name: strOpt(o.name),
            key: strOpt(o.key),
            tag: strOpt(o.tag),
        }, 'music');
    });
    // getPausedSounds / getPausedMusic — mudix's Web Audio backend stops
    // sources instead of pausing them (see SoundManager.pauseSounds), so
    // nothing ever sits in a paused state. These always report empty.
    lua.global.set('__getPausedSounds', () => [] as unknown[]);
    lua.global.set('__getPausedMusic', () => [] as unknown[]);
    // pauseMusic([channel/tag]) — fade-out + stop matching music tracks.
    lua.global.set('pauseMusic', (channel?: unknown) => {
        sounds.pauseMusic(typeof channel === 'string' && channel ? channel : undefined);
    });
    // loadSoundFile(name[, url]) | ({name=...}) — preload/decode so the first
    // playSoundFile has no decode latency. Bridge.lua normalises to a name.
    lua.global.set('__loadSoundFile', (t: unknown) => {
        const o = detachOpts(t);
        return sounds.preload(String(o.name ?? ''));
    });
    // loadMusicFile(name[, url]) | ({name=...}) — same preload/decode path as
    // loadSoundFile (the decode cache is keyed by path, not by sound/music
    // kind). Bridge.lua normalises both call shapes to a name.
    lua.global.set('__loadMusicFile', (t: unknown) => {
        const o = detachOpts(t);
        return sounds.preload(String(o.name ?? ''));
    });
    // Mudlet purgeMediaCache() — drop every decoded-audio buffer.
    lua.global.set('purgeMediaCache', () => sounds.purgeCache());
}

/**
 * Mudlet playVideoFile / pauseVideos / stopVideos.
 * Same VFS-or-URL loader as sounds; videos mount on the main viewport.
 * playVideoFile(path [, volume, loops]) | playVideoFile{name=..., ...}.
 */
export function installVideoBindings({ lua, api }: BindingContext): void {
    const videos = api.videos;

    lua.global.set('__playVideoFile', (t: unknown) => {
        const o = detachOpts(t);
        const path = String(o.name ?? '');
        if (!path) return;
        void videos.play(path, {
            name: path,
            volume: numOpt(o.volume),
            loops: numOpt(o.loops),
            width: strOpt(o.width),
            height: strOpt(o.height),
            caption: strOpt(o.caption),
            origin: 'api',
        });
    });
    // loadVideoFile(name) | ({name=...}) — preload/cache so the first
    // playVideoFile has no fetch latency. Bridge.lua normalises to a name.
    lua.global.set('__loadVideoFile', (t: unknown) => {
        const o = detachOpts(t);
        const path = String(o.name ?? '');
        if (!path) return false;
        void videos.preload(path);
        return true;
    });
    lua.global.set('pauseVideos', () => { videos.pauseAll(); });
    lua.global.set('stopVideos',  () => { videos.stopAll(); });
    // getPlayingVideos / getPausedVideos — list active <video> elements by
    // their play state, optionally filtered by name. Returns 0-indexed JS
    // arrays of {name, path, volume}; Bridge.lua re-indexes to 1-based.
    lua.global.set('__getPlayingVideos', (t?: unknown) => {
        const o = detachOpts(t);
        return videos.getByState(false, { name: strOpt(o.name) });
    });
    lua.global.set('__getPausedVideos', (t?: unknown) => {
        const o = detachOpts(t);
        return videos.getByState(true, { name: strOpt(o.name) });
    });
}

/**
 * Mudlet ttsSpeak / ttsQueue / ttsSetRate / … — Web Speech API backend.
 *
 * The manager is constructed by the runtime (it needs the runtime's own event
 * emitter) and passed in, so this module stays free of runtime internals.
 *
 * These globals are bound BEFORE LuaGlobal.lua loads Other.lua, so its
 * `if not ttsSpeak` guard sees real implementations and skips installing the
 * no-op dummy stubs.
 */
export function installTtsBindings({ lua }: BindingContext, tts: TtsManager): void {
    lua.global.set('ttsSpeak', (text: unknown) => { tts.speak(String(text ?? '')); });
    lua.global.set('ttsQueue', (text: unknown, index?: unknown) => {
        tts.queue(String(text ?? ''), index === undefined ? undefined : Number(index));
    });
    lua.global.set('ttsClearQueue', (index?: unknown) =>
        tts.clearQueue(index === undefined ? undefined : Number(index)));
    lua.global.set('ttsPause', () => { tts.pause(); });
    lua.global.set('ttsResume', () => { tts.resume(); });
    lua.global.set('ttsSkip', () => { tts.skip(); });
    lua.global.set('ttsGetState', () => tts.getState());
    lua.global.set('ttsGetCurrentVoice', () => tts.getCurrentVoice());
    lua.global.set('ttsSetVoiceByName', (name: unknown) => tts.setVoiceByName(String(name ?? '')));
    lua.global.set('ttsSetVoiceByIndex', (index: unknown) => tts.setVoiceByIndex(Number(index)));
    lua.global.set('ttsSetRate', (rate: unknown) => { tts.setRate(Number(rate)); });
    lua.global.set('ttsSetPitch', (pitch: unknown) => { tts.setPitch(Number(pitch)); });
    lua.global.set('ttsSetVolume', (volume: unknown) => { tts.setVolume(Number(volume)); });
    lua.global.set('ttsGetRate', () => tts.getRate());
    lua.global.set('ttsGetPitch', () => tts.getPitch());
    lua.global.set('ttsGetVolume', () => tts.getVolume());
    // Array / nil-returning forms — Bridge.lua re-indexes the 0-based JS
    // arrays to 1-based Lua tables and maps a null current line to (nil, msg).
    lua.global.set('__ttsGetVoices', () => tts.getVoices());
    lua.global.set('__ttsGetQueue', (index?: unknown) =>
        index === undefined ? tts.getQueue() : tts.getQueue(Number(index)));
    lua.global.set('__ttsGetCurrentLine', () => tts.getCurrentLine() ?? false);
}
