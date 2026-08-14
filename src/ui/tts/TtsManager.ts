// Web Speech API backend for Mudlet's text-to-speech family (ttsSpeak,
// ttsQueue, ttsSetRate, ...). Mirrors Mudlet's model: a single "current"
// utterance plus a script-managed queue that this class owns directly (rather
// than leaning on the browser's opaque internal queue) so ttsQueue/ttsGetQueue/
// ttsClearQueue can insert/read/remove at arbitrary 1-based indices the way the
// Mudlet API promises.
//
// Value ranges follow Mudlet/Qt, NOT the Web Speech API:
//   • rate, pitch: -1.0 .. 1.0  (0 = normal)
//   • volume:       0.0 .. 1.0  (1 = full)
// ttsGetRate/Pitch/Volume return the stored Mudlet-range value; the mapping to
// the Web Speech ranges (rate 0.1..10, pitch 0..2, volume 0..1) happens only at
// utterance-creation time. See mapRate/mapPitch below.
//
// State strings and events match Mudlet exactly so scripts written against the
// desktop client work unchanged:
//   ttsSpeechReady / ttsSpeechStarted / ttsSpeechPaused / ttsSpeechError /
//   ttsUnknownState — raised as events on every transition (ttsSpeechStarted
//   carries the spoken text as a second arg). ttsQueue raises ttsSpeechQueued
//   (text, index); the setters raise ttsRateChanged / ttsPitchChanged /
//   ttsVolumeChanged / ttsVoiceChanged.

export type TtsState =
    | 'ttsSpeechReady'
    | 'ttsSpeechStarted'
    | 'ttsSpeechPaused'
    | 'ttsSpeechError'
    | 'ttsUnknownState';

type EmitFn = (event: string, args: unknown[]) => void;

// Mudlet strips angle brackets so HTML-ish markup isn't read aloud literally.
// https://github.com/Mudlet/Mudlet/issues/4689
function sanitize(text: string): string {
    return text
        .replace(/&lt;/g, '')
        .replace(/&gt;/g, '')
        .replace(/[<>]/g, '')
        .trim();
}

// Mudlet rate/pitch are -1..1 centred on 0; Web Speech rate is 0.1..10 and
// pitch 0..2, both centred on 1. Map linearly so 0 → normal: rate spans
// 0.5x (slowest) .. 2x (fastest); pitch spans the full 0..2 Web Speech range.
function mapRate(rate: number): number {
    return rate >= 0 ? 1 + rate : 1 + rate * 0.5;
}
function mapPitch(pitch: number): number {
    return pitch + 1;
}

export class TtsManager {
    private readonly synth: SpeechSynthesis | null =
        typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;

    private pending: string[] = [];
    private current: string | null = null;
    private state: TtsState = 'ttsSpeechReady';

    // Mudlet/Qt-range settings (see file header). Qt defaults: rate 0, pitch 0,
    // volume 1.0.
    private rate = 0;
    private pitch = 0;
    private volume = 1;
    private voiceName: string | null = null;

    // Each utterance captures the generation it was created in. cancel()/skip()/
    // speak() bump the counter first, so the stale utterance's async end/error
    // callbacks (which the browser still fires after cancel()) compare unequal
    // and are ignored — without this, an interrupting speak() would advance the
    // queue twice.
    private gen = 0;
    private destroyed = false;
    private readonly onVoicesChanged = () => {};

    constructor(private readonly emit: EmitFn) {
        // Voices populate asynchronously in Chrome; warm the cache so the first
        // ttsGetVoices / setVoiceByName isn't empty.
        if (this.synth) {
            this.synth.getVoices();
            this.synth.addEventListener('voiceschanged', this.onVoicesChanged);
        }
    }

    // ── Speaking ────────────────────────────────────────────────────────────

    /** Mudlet ttsSpeak — speak `text` immediately, interrupting anything in
     *  progress. The queue is untouched and resumes once `text` finishes. */
    speak(text: string): void {
        if (!this.synth || this.destroyed) return;
        const clean = sanitize(text);
        if (!clean) return;
        this.gen++;
        if (this.synth.speaking || this.synth.pending) this.synth.cancel();
        this.beginUtterance(clean);
    }

    /** Mudlet ttsQueue — append `text` to the queue (or insert at 1-based
     *  `index`). Starts playback if nothing is currently speaking. */
    queue(text: string, index?: number): void {
        if (!this.synth || this.destroyed) return;
        const clean = sanitize(text);
        if (!clean) return;
        let at = index === undefined ? this.pending.length : Math.trunc(index) - 1;
        if (at < 0) at = 0;
        if (at > this.pending.length) at = this.pending.length;
        this.pending.splice(at, 0, clean);
        this.emit('ttsSpeechQueued', [clean, at]);
        if (this.current === null) this.advance();
    }

    /** Mudlet ttsSkip — stop the current utterance and move on to the next
     *  queued one (if any). */
    skip(): void {
        if (!this.synth || this.destroyed) return;
        this.gen++;
        this.synth.cancel();
        this.current = null;
        this.advance();
    }

    /** Mudlet ttsPause — pause the current utterance. */
    pause(): void {
        if (this.synth && !this.destroyed) this.synth.pause();
    }

    /** Mudlet ttsResume — resume a paused utterance. */
    resume(): void {
        if (this.synth && !this.destroyed) this.synth.resume();
    }

    // ── Queue inspection ──────────────────────────────────────────────────────

    /** Mudlet ttsClearQueue — drop the whole pending queue, or just the item at
     *  1-based `index`. Returns false when `index` is out of bounds (the
     *  currently-speaking utterance is never in the queue and is unaffected). */
    clearQueue(index?: number): boolean {
        if (index === undefined) {
            this.pending = [];
            return true;
        }
        const i = Math.trunc(index) - 1;
        if (i < 0 || i >= this.pending.length) return false;
        this.pending.splice(i, 1);
        return true;
    }

    /** Mudlet ttsGetQueue — the pending texts (1-based index returns one item,
     *  or false if out of bounds; no index returns the whole list). */
    getQueue(): string[];
    getQueue(index: number): string | false;
    getQueue(index?: number): string[] | string | false {
        if (index === undefined) return [...this.pending];
        const i = Math.trunc(index) - 1;
        if (i < 0 || i >= this.pending.length) return false;
        return this.pending[i];
    }

    // ── State / introspection ─────────────────────────────────────────────────

    /** Mudlet ttsGetState — one of the tts* state strings. */
    getState(): TtsState {
        if (!this.synth) return 'ttsUnknownState';
        return this.state;
    }

    /** Mudlet ttsGetCurrentLine — the text being spoken, or null when idle
     *  (Ready) / errored. The Lua wrapper maps null to (nil, reason). */
    getCurrentLine(): string | null {
        if (this.state === 'ttsSpeechReady' || this.state === 'ttsSpeechError') return null;
        return this.current;
    }

    /** Mudlet ttsGetVoices — the available voice names. */
    getVoices(): string[] {
        if (!this.synth) return [];
        return this.synth.getVoices().map(v => v.name);
    }

    /** Mudlet ttsGetCurrentVoice — the selected voice name, falling back to the
     *  engine's first available voice when none was set. */
    getCurrentVoice(): string {
        if (this.voiceName) return this.voiceName;
        return this.synth?.getVoices()[0]?.name ?? '';
    }

    getRate(): number { return this.rate; }
    getPitch(): number { return this.pitch; }
    getVolume(): number { return this.volume; }

    // ── Setters ───────────────────────────────────────────────────────────────

    /** Mudlet ttsSetRate — clamps to -1..1, stores it, raises ttsRateChanged. */
    setRate(rate: number): void {
        this.rate = Math.min(1, Math.max(-1, rate));
        this.emit('ttsRateChanged', [this.rate]);
    }

    /** Mudlet ttsSetPitch — clamps to -1..1, stores it, raises ttsPitchChanged. */
    setPitch(pitch: number): void {
        this.pitch = Math.min(1, Math.max(-1, pitch));
        this.emit('ttsPitchChanged', [this.pitch]);
    }

    /** Mudlet ttsSetVolume — clamps to 0..1, stores it, raises ttsVolumeChanged. */
    setVolume(volume: number): void {
        this.volume = Math.min(1, Math.max(0, volume));
        this.emit('ttsVolumeChanged', [this.volume]);
    }

    /** Mudlet ttsSetVoiceByName — selects a voice by name. Returns false when no
     *  voice matches; otherwise stores it and raises ttsVoiceChanged. */
    setVoiceByName(name: string): boolean {
        if (!this.synth) return false;
        const voice = this.synth.getVoices().find(v => v.name === name);
        if (!voice) return false;
        this.voiceName = voice.name;
        this.emit('ttsVoiceChanged', [voice.name]);
        return true;
    }

    /** Mudlet ttsSetVoiceByIndex — selects a voice by 1-based index. Returns
     *  false when out of bounds. */
    setVoiceByIndex(index: number): boolean {
        if (!this.synth) return false;
        const voices = this.synth.getVoices();
        const i = Math.trunc(index) - 1;
        if (i < 0 || i >= voices.length) return false;
        this.voiceName = voices[i].name;
        this.emit('ttsVoiceChanged', [voices[i].name]);
        return true;
    }

    destroy(): void {
        this.destroyed = true;
        this.pending = [];
        this.current = null;
        if (this.synth) {
            this.synth.cancel();
            this.synth.removeEventListener('voiceschanged', this.onVoicesChanged);
        }
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    private advance(): void {
        if (this.pending.length > 0) {
            this.beginUtterance(this.pending.shift()!);
        } else {
            this.current = null;
            this.setState('ttsSpeechReady');
        }
    }

    private beginUtterance(text: string): void {
        if (!this.synth) return;
        this.gen++;
        const gen = this.gen;
        this.current = text;

        const u = new SpeechSynthesisUtterance(text);
        u.rate = mapRate(this.rate);
        u.pitch = mapPitch(this.pitch);
        u.volume = this.volume;
        if (this.voiceName) {
            const voice = this.synth.getVoices().find(v => v.name === this.voiceName);
            if (voice) u.voice = voice;
        }

        // Left in as a re-affirmation only. The state is set below, when the
        // utterance is handed over, because that is when Mudlet reports it:
        // QTextToSpeech::say() leaves the engine Speaking by the time it
        // returns, and a script doing `ttsSpeak(x); ttsGetState()` expects to be
        // told what it just started. Waiting for the browser's asynchronous
        // onstart meant the answer was still "ready", and on a machine with no
        // audio device the event may never arrive at all.
        u.onstart = () => {
            if (gen !== this.gen) return;
            this.setState('ttsSpeechStarted', text);
        };
        u.onend = () => {
            if (gen !== this.gen) return;
            // Matches Mudlet: pass through Ready on every utterance boundary,
            // then dequeue the next (which transitions back to Started).
            this.setState('ttsSpeechReady');
            this.current = null;
            this.advance();
        };
        u.onerror = (e: SpeechSynthesisErrorEvent) => {
            if (gen !== this.gen) return;
            // cancel()/skip()/interrupting speak() surface as canceled/
            // interrupted — those are controlled stops, not failures.
            if (e.error === 'canceled' || e.error === 'interrupted') return;
            this.current = null;
            this.setState('ttsSpeechError');
        };
        u.onpause = () => {
            if (gen !== this.gen) return;
            this.setState('ttsSpeechPaused');
        };
        u.onresume = () => {
            if (gen !== this.gen) return;
            this.setState('ttsSpeechStarted', this.current ?? undefined);
        };

        this.synth.speak(u);
        this.setState('ttsSpeechStarted', text);
    }

    private setState(state: TtsState, text?: string): void {
        // Started repeats when the text changes: speaking over an utterance that
        // is still running starts a *different* one, and a handler tracking what
        // is being said has to hear about it. Every other state is a transition,
        // and repeating those would be noise.
        const repeated = state === this.state
            && !(state === 'ttsSpeechStarted' && text !== undefined && text !== this.lastStarted);
        if (repeated) return;
        this.state = state;
        if (state === 'ttsSpeechStarted') this.lastStarted = text;
        this.emit(state, text !== undefined ? [text] : []);
    }

    /** Text of the most recent ttsSpeechStarted, so speaking over a running
     *  utterance can tell a genuinely new one from a repeat. */
    private lastStarted: string | undefined;
}
