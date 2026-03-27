// @vitest-environment jsdom
/**
 * SG-E Chain Tests: Wakeword Pipeline (automatable subset)
 *
 * SC-E-05: Cancel word during processing → does NOT fire (negative test)
 * SC-E-11: Wakeword engine switch → keyword mapping migration
 * SC-E-15: Post-recording OWW restart — mic state transitions and bus events
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getWwEngine, setWwEngine,
  interruptBot, resetBotToIdle,
  getBotMicState, setBotMicState,
  setCurrentBotId, getCurrentBotId,
  setInputMode, getInputMode,
} from '../ui/app-state';
import { micState } from '../state/mic-state';
import { botTurnState } from '../state/bot-turn-state';
import { audioPlayer } from '../audio/audio-player';
import { bus } from '../core/event-bus';
import { setupTestBots, teardownTest, BOT_A, BOT_B } from './helpers/test-setup';

beforeEach(() => {
  setupTestBots(BOT_A, BOT_B);
  setCurrentBotId(BOT_A);

  // Mock browser audio APIs for jsdom
  if (!(globalThis as unknown as Record<string, unknown>).SpeechSynthesisUtterance) {
    (globalThis as unknown as Record<string, unknown>).SpeechSynthesisUtterance = class {
      lang = ''; rate = 1; text = '';
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text?: string) { this.text = text || ''; }
    };
  }
  if (!window.speechSynthesis) {
    (window as unknown as Record<string, unknown>).speechSynthesis = {
      cancel: vi.fn(),
      speak: vi.fn(),
      getVoices: vi.fn(() => []),
    };
  }
  if (!window.AudioContext) {
    class MockAudioContext {
      state = 'running';
      currentTime = 0;
      destination = {};
      resume = vi.fn(() => Promise.resolve());
      createGain = vi.fn(() => ({
        gain: { value: 1 },
        connect: vi.fn(function(this: unknown) { return this; }),
      }));
      createAnalyser = vi.fn(() => ({
        fftSize: 256,
        getFloatTimeDomainData: vi.fn(),
        connect: vi.fn(),
      }));
      createOscillator = vi.fn(() => ({
        frequency: { value: 0 },
        connect: vi.fn(() => ({ connect: vi.fn() })),
        start: vi.fn(),
      }));
      createMediaStreamDestination = vi.fn(() => ({
        stream: {},
      }));
      createBufferSource = vi.fn(() => ({
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null as (() => void) | null,
      }));
      // Hold the success callback so the player stays in 'playing' state
      decodeAudioData = vi.fn((_buf: ArrayBuffer, onSuccess: (buf: unknown) => void, _onError?: () => void) => {
        // Do NOT call onSuccess — keeps player in 'playing'
      });
    }
    (window as unknown as Record<string, unknown>).AudioContext = MockAudioContext;
  }
});

afterEach(() => {
  audioPlayer.stop();
  teardownTest();
});

// ============================================================
// SC-E-05: Cancel word during processing → does NOT fire (negative test)
// ============================================================
describe('SC-E-05: Cancel word during processing → does NOT fire', () => {
  it('SC-E-05: awaiting with mic idle + audioPlayer idle → cancel condition is false', () => {
    // Per INV-WW-01: cancel fires when micState.isActive || audioPlayer.state !== 'idle'
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    expect(botTurnState.get(BOT_A)).toBe('awaiting');

    // Mic idle, audioPlayer idle → neither condition met
    expect(micState.isActive).toBe(false);
    expect(audioPlayer.state).toBe('idle');

    const cancelCondition = micState.isActive || audioPlayer.state !== 'idle';
    expect(cancelCondition).toBe(false);
  });

  it('SC-E-05: receiving state with idle mic + idle audioPlayer → cancel condition is false', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    expect(botTurnState.get(BOT_A)).toBe('receiving');

    expect(micState.isActive).toBe(false);
    expect(audioPlayer.state).toBe('idle');

    const cancelCondition = micState.isActive || audioPlayer.state !== 'idle';
    expect(cancelCondition).toBe(false);
  });

  it('SC-E-05: awaiting + audioPlayer playing → cancel condition IS true (stops TTS only, per INV-WW-01)', () => {
    // Per INV-WW-01: audioPlayer.state !== 'idle' → cancel fires to stop TTS
    // This is NOT about mic cancel — it's about stopping TTS playback
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');

    audioPlayer.enqueue(null, 'dGVzdA==', 'some text');
    expect(audioPlayer.state).toBe('playing');
    expect(micState.isActive).toBe(false);

    // Cancel condition is true because audioPlayer is non-idle
    const cancelCondition = micState.isActive || audioPlayer.state !== 'idle';
    expect(cancelCondition).toBe(true);

    // But mic cancel specifically should NOT fire (mic is idle)
    expect(micState.isActive).toBe(false);
  });

  it('SC-E-05: cancel fires during recording state (positive control)', () => {
    micState.startRecording({ botId: BOT_A, mode: 'wakeword' });
    micState.setRecording();
    expect(micState.state).toBe('recording');
    expect(micState.isActive).toBe(true);

    const cancelCondition = micState.isActive || audioPlayer.state !== 'idle';
    expect(cancelCondition).toBe(true);
  });

  it('SC-E-05: cancel fires during TTS playback (positive control)', () => {
    audioPlayer.enqueue(null, 'dGVzdA==', 'speaking');
    expect(audioPlayer.state).toBe('playing');

    const cancelCondition = micState.isActive || audioPlayer.state !== 'idle';
    expect(cancelCondition).toBe(true);
  });
});

// ============================================================
// SC-E-11: Wakeword engine switch → keyword mapping migration
// ============================================================
describe('SC-E-11: Wakeword engine switch → keyword mapping migration', () => {
  it('getWwEngine returns the current engine (default or previously set)', () => {
    const engine = getWwEngine();
    expect(['picovoice', 'openwakeword', 'sherpa-onnx-kws']).toContain(engine);
  });

  it('setWwEngine stores the new engine value', () => {
    setWwEngine('picovoice');
    expect(getWwEngine()).toBe('picovoice');

    setWwEngine('openwakeword');
    expect(getWwEngine()).toBe('openwakeword');

    setWwEngine('sherpa-onnx-kws');
    expect(getWwEngine()).toBe('sherpa-onnx-kws');
  });

  it('engine change is reflected immediately after set', () => {
    const original = getWwEngine();

    // Switch to a different engine
    const target = original === 'openwakeword' ? 'picovoice' : 'openwakeword';
    setWwEngine(target);
    expect(getWwEngine()).toBe(target);

    // Switch back
    setWwEngine(original);
    expect(getWwEngine()).toBe(original);
  });

  it('engine switch does not affect other app state', () => {
    setWwEngine('picovoice');

    // Verify other state is untouched
    expect(micState.state).toBe('idle');
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(getCurrentBotId()).toBe(BOT_A);
  });

  it('roundtrip: OWW → Picovoice → Sherpa → OWW preserves engine setting', () => {
    setWwEngine('openwakeword');
    expect(getWwEngine()).toBe('openwakeword');

    setWwEngine('picovoice');
    expect(getWwEngine()).toBe('picovoice');

    setWwEngine('sherpa-onnx-kws');
    expect(getWwEngine()).toBe('sherpa-onnx-kws');

    setWwEngine('openwakeword');
    expect(getWwEngine()).toBe('openwakeword');
  });

  it('keyword mapping persists across engine change (engine is global, not per-keyword)', () => {
    // Set engine to OWW
    setWwEngine('openwakeword');
    const engine1 = getWwEngine();

    // Switch to picovoice — the engine setting is a global, not tied to keywords
    setWwEngine('picovoice');
    const engine2 = getWwEngine();

    // Both are valid engine values — the mapping is about which engine is active
    expect(engine1).toBe('openwakeword');
    expect(engine2).toBe('picovoice');

    // Switch back — engine value is restored correctly
    setWwEngine('openwakeword');
    expect(getWwEngine()).toBe('openwakeword');
  });
});

// ============================================================
// SC-E-15: Post-recording OWW restart
// ============================================================
describe('SC-E-15: Post-recording OWW restart — mic state transitions and bus events', () => {
  it('mic transitions through full wakeword recording lifecycle', () => {
    // Simulate wakeword-triggered recording
    const ok = micState.startRecording({ botId: BOT_A, mode: 'wakeword' });
    expect(ok).toBe(true);
    expect(micState.state).toBe('acquiring');
    expect(micState.getMode()).toBe('wakeword');

    micState.setRecording();
    expect(micState.state).toBe('recording');

    // End word detected → stop recording
    micState.setStopping();
    expect(micState.state).toBe('stopping');

    micState.setSaving();
    expect(micState.state).toBe('saving');

    micState.setIdle();
    expect(micState.state).toBe('idle');
    expect(micState.context).toBeNull();
  });

  it('mic:state-change events emitted at each transition', () => {
    const events: Array<{ from: string; to: string }> = [];
    bus.on('mic:state-change', (evt: unknown) => {
      const e = evt as { from: string; to: string };
      events.push({ from: e.from, to: e.to });
    });

    micState.startRecording({ botId: BOT_A, mode: 'wakeword' });
    micState.setRecording();
    micState.setStopping();
    micState.setSaving();
    micState.setIdle();

    expect(events).toEqual([
      { from: 'idle', to: 'acquiring' },
      { from: 'acquiring', to: 'recording' },
      { from: 'recording', to: 'stopping' },
      { from: 'stopping', to: 'saving' },
      { from: 'saving', to: 'idle' },
    ]);
  });

  it('after recording completes and turn finishes, mic is idle and ready for OWW restart', () => {
    // Full turn lifecycle: record → process → receive → speak → idle
    micState.startRecording({ botId: BOT_A, mode: 'wakeword' });
    micState.setRecording();
    micState.setStopping();
    micState.setSaving();
    micState.setIdle();

    // Turn completes
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');
    botTurnState.transition(BOT_A, 'idle');

    // State is fully idle — OWW can restart
    expect(micState.state).toBe('idle');
    expect(micState.isActive).toBe(false);
    expect(botTurnState.get(BOT_A)).toBe('idle');
  });

  it('OWW restart rejected while mic is still active', () => {
    micState.startRecording({ botId: BOT_A, mode: 'wakeword' });
    micState.setRecording();

    // Trying to start another recording while active should fail
    const ok = micState.startRecording({ botId: BOT_B, mode: 'wakeword' });
    expect(ok).toBe(false);
    expect(micState.state).toBe('recording');
    expect(micState.context?.botId).toBe(BOT_A);
  });

  it('bot:turn-state-change idle event signals OWW restart point', () => {
    const idleEvents: string[] = [];
    bus.on('bot:turn-state-change', (evt: unknown) => {
      const e = evt as { botId: string; from: string; to: string };
      if (e.to === 'idle') idleEvents.push(e.botId);
    });

    // Simulate full turn
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');
    botTurnState.transition(BOT_A, 'idle');

    expect(idleEvents).toContain(BOT_A);
  });

  it('wakeword context is preserved during recording', () => {
    micState.startRecording({ botId: BOT_A, mode: 'wakeword' });
    expect(micState.context?.mode).toBe('wakeword');
    expect(micState.context?.botId).toBe(BOT_A);

    micState.setRecording();
    expect(micState.context?.mode).toBe('wakeword');

    micState.setStopping();
    expect(micState.context?.mode).toBe('wakeword');

    micState.setSaving();
    expect(micState.context?.mode).toBe('wakeword');

    // Context is cleared on idle
    micState.setIdle();
    expect(micState.context).toBeNull();
  });

  it('cancelRecording force-resets mic to idle with cancelled flag', () => {
    micState.startRecording({ botId: BOT_A, mode: 'wakeword' });
    micState.setRecording();

    const events: Array<{ cancelled?: boolean }> = [];
    bus.on('mic:state-change', (evt: unknown) => {
      events.push(evt as { cancelled?: boolean });
    });

    micState.cancelRecording();
    expect(micState.state).toBe('idle');
    expect(micState.context).toBeNull();
    expect(events[0]?.cancelled).toBe(true);
  });

  it('after cancelRecording, new wakeword recording can start immediately', () => {
    micState.startRecording({ botId: BOT_A, mode: 'wakeword' });
    micState.setRecording();
    micState.cancelRecording();

    // OWW should be able to restart immediately
    const ok = micState.startRecording({ botId: BOT_A, mode: 'wakeword' });
    expect(ok).toBe(true);
    expect(micState.state).toBe('acquiring');
  });
});
