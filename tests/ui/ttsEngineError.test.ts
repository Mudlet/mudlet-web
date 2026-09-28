// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TtsManager } from '../../src/ui/tts/TtsManager';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// Without a speech engine, Chrome fires an utterance's `error` synchronously
// inside speechSynthesis.speak(). The state has to end on ttsSpeechError, as
// Mudlet's does, not be overwritten with ttsSpeechStarted afterwards — and the
// failed line must not wedge the queue behind it.

interface FakeUtterance { text: string; onerror?: (e: { error: string }) => void; onend?: () => void }

function installSynth(behaviour: (u: FakeUtterance) => void) {
  const spoken: string[] = [];
  const synth = {
    speaking: false,
    pending: false,
    speak: (u: FakeUtterance) => { spoken.push(u.text); behaviour(u); },
    cancel: () => {},
    pause: () => {},
    resume: () => {},
    getVoices: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  vi.stubGlobal('window', { speechSynthesis: synth });
  vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} });
  return spoken;
}

describe('TtsManager after an engine error', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reports ttsSpeechError when speak() fails synchronously', () => {
    installSynth(u => u.onerror?.({ error: 'synthesis-failed' }));
    const events: string[] = [];
    const tts = new TtsManager(e => events.push(e));
    tts.speak('hello');
    expect(tts.getState()).toBe('ttsSpeechError');
    expect(events).toEqual(['ttsSpeechStarted', 'ttsSpeechError']);
    expect(tts.getCurrentLine()).toBeNull();
    tts.destroy();
  });

  it('moves on to the next queued line after an error', () => {
    const spoken = installSynth(u => { if (u.text === 'broken') u.onerror?.({ error: 'synthesis-failed' }); });
    const tts = new TtsManager(() => {});
    tts.queue('playing');     // starts speaking, never finishes here
    tts.queue('next');        // waits behind it
    tts.speak('broken');      // interrupts, and fails
    expect(spoken).toEqual(['playing', 'broken', 'next']);
    expect(tts.getState()).toBe('ttsSpeechStarted');
    expect(tts.getCurrentLine()).toBe('next');
    expect(tts.getQueue()).toEqual([]);
    tts.destroy();
  });

  it('stays on ttsSpeechError when every queued line fails', () => {
    const spoken = installSynth(u => u.onerror?.({ error: 'synthesis-failed' }));
    const tts = new TtsManager(() => {});
    tts.queue('one');
    tts.queue('two');
    expect(spoken).toEqual(['one', 'two']);
    expect(tts.getState()).toBe('ttsSpeechError');
    expect(tts.getQueue()).toEqual([]);
    tts.destroy();
  });

  it('a cancellation is still not an error', () => {
    installSynth(u => u.onerror?.({ error: 'interrupted' }));
    const tts = new TtsManager(() => {});
    tts.speak('hello');
    expect(tts.getState()).toBe('ttsSpeechStarted');
    tts.destroy();
  });
});

describe('tts setters take numeric strings, as Mudlet does', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('ttsSetRate/Pitch/Volume coerce a numeric string', () => {
    expect(env.run('ttsSetRate("0.3") return ttsGetRate()')).toBeCloseTo(0.3);
    expect(env.run('ttsSetPitch("-0.5") return ttsGetPitch()')).toBeCloseTo(-0.5);
    expect(env.run('ttsSetVolume(" 0.25 ") return ttsGetVolume()')).toBeCloseTo(0.25);
  });

  it('still raises for a string that is not a number', () => {
    expect(() => env.run('ttsSetRate("fast")')).toThrow(/ttsSetRate: bad argument #1 type \(number expected, got string!\)/);
  });
});
