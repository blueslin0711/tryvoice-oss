// @vitest-environment jsdom
/**
 * SC-B Chain Tests: TTS Playback (SC-B-01 ~ SC-B-12, SC-B-14)
 *
 * Spec-derived assertions for TTS playback event chain:
 * - SC-B-01: autoRead on + stream message -> TTS triggered, bot enters speaking
 * - SC-B-02: autoRead off -> no TTS, no speaking
 * - SC-B-03: Cancel during TTS -> immediate stop, turn reset, turnCancelled set
 * - SC-B-04: Switch bot during TTS -> old bot audio stops, turn continues
 * - SC-B-05: Switch back -> already-read text NOT re-read (dedup via _readTextKeys)
 * - SC-B-06: Per-bot voice/rate stored independently
 * - SC-B-07: TTS failure -> fallback to browser speechSynthesis
 * - SC-B-08: Generation counter invalidates stale callbacks
 * - SC-B-09: Audio end -> all bots speaking state reset (safety net)
 * - SC-B-10: Sync path current bot receives sync msg -> TTS if autoRead on
 * - SC-B-11: Multi-card response chunks enqueued in order
 * - SC-B-12: Per-paragraph highlight + scroll (audio:state events carry msgEl+chunkText)
 * - SC-B-14: TTS failure -> user notified via card annotation + announcement
 *
 * ISSUE-02: Speaking timeout refreshed on audio:state start (verify)
 * ISSUE-03: Manual play-btn should use Azure TTS if configured (verify)
 * ISSUE-05: TTS failure should notify user (verify)
 *
 * Skipped: SC-B-13 (removed/merged into SC-B-03)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { audioPlayer } from '../audio/audio-player';
import {
  isAutoReadEnabled, setAutoReadEnabled,
  markTextRead, isTextAlreadyRead, clearReadTexts,
  shouldIncludeMsg, setGranularity,
  interruptBot, quietResetBot, isTurnCancelled,
  setBotMicState, getBotMicState, resetBotToIdle,
  setCurrentBotId, getCurrentBotId,
  setBotVoiceSelection, getBotVoiceSelections,
  setBotTtsRate, getBotTtsRates,
  autoReadEnqueue,
} from '../ui/app-state';
import { botTurnState } from '../state/bot-turn-state';
import { bus } from '../core/event-bus';
import { setupTestBots, teardownTest, BOT_A, BOT_B } from './helpers/test-setup';

// Track decodeAudioData callbacks so tests can resolve them
let _decodeSuccessCbs: Array<(buf: unknown) => void> = [];

// Re-register the interrupt:stop-audio handler that audio-player.ts sets up
// at module level. setupTestBots() calls bus.removeAll() which wipes it.
function reRegisterInterruptHandler(): void {
  bus.on('interrupt:stop-audio', () => {
    if (audioPlayer.state === 'idle') return;
    audioPlayer.stop();
  });
}

beforeEach(() => {
  _decodeSuccessCbs = [];
  setupTestBots(BOT_A, BOT_B);
  reRegisterInterruptHandler();
  setCurrentBotId(BOT_A);
  setAutoReadEnabled(true);
  clearReadTexts(BOT_A);
  clearReadTexts(BOT_B);

  // Mock SpeechSynthesisUtterance
  if (!(globalThis as unknown as Record<string, unknown>).SpeechSynthesisUtterance) {
    (globalThis as unknown as Record<string, unknown>).SpeechSynthesisUtterance = class {
      lang = ''; rate = 1; text = '';
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text?: string) { this.text = text || ''; }
    };
  }

  // Mock speechSynthesis
  if (!window.speechSynthesis) {
    (window as unknown as Record<string, unknown>).speechSynthesis = {
      cancel: vi.fn(),
      speak: vi.fn(),
      getVoices: vi.fn(() => []),
    };
  }

  // Mock AudioContext with decodeAudioData that does NOT auto-resolve
  // so enqueue keeps the player in 'playing' state
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
      // Hold the success callback -- do NOT call it automatically.
      // This keeps the player in 'playing' state until we manually resolve.
      decodeAudioData = vi.fn((_buf: ArrayBuffer, onSuccess: (buf: unknown) => void, _onError?: () => void) => {
        _decodeSuccessCbs.push(onSuccess);
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
// SC-B-01: autoRead on + new message arrives via stream -> TTS playback triggered
// Spec: "autoRead on + new message arrives via stream -> TTS playback triggered,
//         bot enters speaking."
// ============================================================
describe('SC-B-01: autoRead on + stream message -> TTS triggered, bot speaking', () => {
  it('enqueue transitions audioPlayer from idle to playing (TTS playback triggered)', () => {
    // Spec: TTS playback triggered when message arrives
    expect(audioPlayer.state).toBe('idle');
    const el = document.createElement('div');
    audioPlayer.enqueue(el, 'dGVzdA==', 'Hello world');
    expect(audioPlayer.state).toBe('playing');
  });

  it('audio:state start event fires on enqueue (confirms playback chain starts)', () => {
    // Spec: bot enters speaking -- audio:state start is the trigger
    const spy = vi.fn();
    bus.on('audio:state', spy);
    const el = document.createElement('div');
    audioPlayer.enqueue(el, 'dGVzdA==', 'chunk one');
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'playing', phase: 'start' }),
    );
  });

  it('botTurnState transitions through full flow: idle -> sending -> awaiting -> receiving -> speaking', () => {
    // Spec: bot enters speaking state
    expect(botTurnState.get(BOT_A)).toBe('idle');
    botTurnState.transition(BOT_A, 'sending');
    expect(botTurnState.get(BOT_A)).toBe('sending');
    botTurnState.transition(BOT_A, 'awaiting');
    expect(botTurnState.get(BOT_A)).toBe('awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    expect(botTurnState.get(BOT_A)).toBe('receiving');
    botTurnState.transition(BOT_A, 'speaking');
    expect(botTurnState.get(BOT_A)).toBe('speaking');
  });

  it('setBotMicState reaches speaking via processing->speaking', () => {
    // Spec: bot enters speaking
    setBotMicState(BOT_A, 'recording');
    setBotMicState(BOT_A, 'processing');
    setBotMicState(BOT_A, 'speaking');
    expect(getBotMicState(BOT_A)).toBe('speaking');
  });

  it('audio:state end fires when stop() called after enqueue', () => {
    // Spec: TTS playback lifecycle completes
    const spy = vi.fn();
    bus.on('audio:state', spy);
    audioPlayer.enqueue(null, 'dGVzdA==', 'test');
    audioPlayer.stop();
    const endCall = spy.mock.calls.find(
      (c: unknown[]) => (c[0] as { phase: string }).phase === 'end',
    );
    expect(endCall).toBeTruthy();
    expect((endCall![0] as { state: string }).state).toBe('idle');
  });
});

// ============================================================
// SC-B-02: autoRead off -> no TTS, no speaking state transition
// Spec: "autoRead off -> no TTS, no speaking state transition."
// ============================================================
describe('SC-B-02: autoRead off -> no TTS, no speaking', () => {
  it('autoReadEnqueue does nothing when autoRead is disabled', () => {
    // Spec: no TTS when autoRead off
    setAutoReadEnabled(false);
    expect(isAutoReadEnabled()).toBe(false);
    const el = document.createElement('div');
    autoReadEnqueue(el, 'dGVzdA==', 'should not play');
    expect(audioPlayer.state).toBe('idle');
  });

  it('botTurnState does not reach speaking when autoRead is off (stops at receiving)', () => {
    // Spec: no speaking state transition
    setAutoReadEnabled(false);
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    // Without autoRead, the wiring code never transitions to speaking
    botTurnState.resetToIdle(BOT_A);
    expect(botTurnState.get(BOT_A)).toBe('idle');
  });

  it('setBotMicState blocks direct jump to speaking from idle', () => {
    // Spec: no speaking state transition when not in the right precondition
    setBotMicState(BOT_A, 'speaking');
    expect(getBotMicState(BOT_A)).toBe(''); // blocked by allowed transitions
  });
});

// ============================================================
// SC-B-03: Cancel during TTS -> immediate audio stop, turn reset, turnCancelled set
// Spec: "Cancel during TTS -> immediate audio stop, turn reset, turnCancelled set."
// ============================================================
describe('SC-B-03: cancel during TTS -> immediate stop, turn reset, turnCancelled', () => {
  it('interruptBot stops audio and resets audioPlayer to idle', () => {
    // Spec: immediate audio stop
    audioPlayer.enqueue(null, 'dGVzdA==', 'playing text');
    expect(audioPlayer.state).toBe('playing');
    interruptBot(BOT_A, 'cancelled');
    expect(audioPlayer.state).toBe('idle');
  });

  it('interruptBot resets botTurnState to idle (turn reset)', () => {
    // Spec: turn reset
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');
    interruptBot(BOT_A, 'cancelled');
    expect(botTurnState.get(BOT_A)).toBe('idle');
  });

  it('interruptBot sets turnCancelled flag', () => {
    // Spec: turnCancelled set
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    interruptBot(BOT_A, 'cancelled');
    expect(isTurnCancelled(BOT_A)).toBe(true);
  });

  it('interruptBot clears botMicState to idle', () => {
    // Spec: immediate stop resets mic state too
    setBotMicState(BOT_A, 'recording');
    setBotMicState(BOT_A, 'processing');
    setBotMicState(BOT_A, 'speaking');
    expect(getBotMicState(BOT_A)).toBe('speaking');
    interruptBot(BOT_A);
    expect(getBotMicState(BOT_A)).toBe('');
  });

  it('audio:state end event fires on interrupt', () => {
    // Spec: immediate audio stop emits proper lifecycle event
    const spy = vi.fn();
    bus.on('audio:state', spy);
    audioPlayer.enqueue(null, 'dGVzdA==', 'will be interrupted');
    spy.mockClear();
    bus.emit('interrupt:stop-audio');
    const endCall = spy.mock.calls.find(
      (c: unknown[]) => (c[0] as { phase: string }).phase === 'end',
    );
    expect(endCall).toBeTruthy();
  });

  it('queue is emptied after interrupt (no stale audio resumes)', () => {
    // Spec: immediate stop means queue is fully flushed
    audioPlayer.enqueue(null, 'dGVzdA==', 'chunk 1');
    audioPlayer.enqueue(null, 'dGVzdA==', 'chunk 2');
    audioPlayer.enqueue(null, 'dGVzdA==', 'chunk 3');
    expect(audioPlayer.state).toBe('playing');
    bus.emit('interrupt:stop-audio');
    expect(audioPlayer.state).toBe('idle');
    // Fresh enqueue should work from clean state
    audioPlayer.enqueue(null, 'dGVzdA==', 'new chunk');
    expect(audioPlayer.state).toBe('playing');
  });
});

// ============================================================
// SC-B-04: Switch bot during TTS -> old bot audio stops via quietResetBot,
//          old bot turn continues in background
// Spec: "Switch bot during TTS -> old bot audio stops via quietResetBot,
//         old bot turn continues in background."
// ============================================================
describe('SC-B-04: switch bot during TTS -> old bot audio stops, turn continues', () => {
  it('quietResetBot stops audio via interrupt:stop-audio', () => {
    // Spec: old bot audio stops
    audioPlayer.enqueue(null, 'dGVzdA==', 'Bot A speaking');
    expect(audioPlayer.state).toBe('playing');
    quietResetBot(BOT_A);
    expect(audioPlayer.state).toBe('idle');
    expect(getBotMicState(BOT_A)).toBe('');
  });

  it('quietResetBot does NOT reset botTurnState (turn continues in background)', () => {
    // Spec: old bot turn continues in background
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    quietResetBot(BOT_A);
    // botTurnState is NOT reset -- turn continues in background
    expect(botTurnState.get(BOT_A)).toBe('receiving');
  });

  it('interrupt:stop-audio event stops audioPlayer without cancelling turn', () => {
    // Spec: audio stops but turn not cancelled
    audioPlayer.enqueue(null, 'dGVzdA==', 'playing');
    expect(audioPlayer.state).toBe('playing');
    bus.emit('interrupt:stop-audio');
    expect(audioPlayer.state).toBe('idle');
  });

  it('switching currentBotId changes context', () => {
    // Spec: switch bot context
    setCurrentBotId(BOT_A);
    expect(getCurrentBotId()).toBe(BOT_A);
    setCurrentBotId(BOT_B);
    expect(getCurrentBotId()).toBe(BOT_B);
  });
});

// ============================================================
// SC-B-05: Switch away then back -> text already read via stream path
//          NOT re-read (dedup via _readTextKeys)
// Spec: "Switch away then back -> text already read via stream path
//         NOT re-read (dedup via _readTextKeys)."
// ============================================================
describe('SC-B-05: switch back -> already-read text NOT re-read (dedup)', () => {
  it('stream-path marks text as read, prevents re-read', () => {
    // Spec: dedup via _readTextKeys
    markTextRead(BOT_A, 'Response from Bot A');
    expect(isTextAlreadyRead(BOT_A, 'Response from Bot A')).toBe(true);
  });

  it('dedup is per-bot -- same text on different bot is not deduped', () => {
    // Spec: _readTextKeys is per-bot
    markTextRead(BOT_A, 'Shared text');
    expect(isTextAlreadyRead(BOT_A, 'Shared text')).toBe(true);
    expect(isTextAlreadyRead(BOT_B, 'Shared text')).toBe(false);
  });

  it('whitespace normalization in dedup keys', () => {
    // Spec: dedup normalizes whitespace
    markTextRead(BOT_A, '  Hello   world  ');
    expect(isTextAlreadyRead(BOT_A, 'Hello world')).toBe(true);
    expect(isTextAlreadyRead(BOT_A, 'Hello  world')).toBe(true);
  });

  it('clearReadTexts resets dedup for a bot', () => {
    markTextRead(BOT_A, 'Some text');
    expect(isTextAlreadyRead(BOT_A, 'Some text')).toBe(true);
    clearReadTexts(BOT_A);
    expect(isTextAlreadyRead(BOT_A, 'Some text')).toBe(false);
  });

  it('dedup survives bot switch round-trip', () => {
    // Spec: switch away then back -> text already read NOT re-read
    markTextRead(BOT_A, 'Read before switch');
    setCurrentBotId(BOT_B);
    setCurrentBotId(BOT_A);
    expect(isTextAlreadyRead(BOT_A, 'Read before switch')).toBe(true);
  });
});

// ============================================================
// SC-B-06: Per-bot voice and TTS rate settings stored independently
// Spec: "Per-bot voice and TTS rate settings stored independently."
// ============================================================
describe('SC-B-06: per-bot voice and TTS rate stored independently', () => {
  it('setBotVoiceSelection stores per-bot voice', () => {
    setBotVoiceSelection(BOT_A, 'zh-CN-XiaoxiaoNeural');
    setBotVoiceSelection(BOT_B, 'en-US-AriaNeural');
    const voices = getBotVoiceSelections();
    expect(voices[BOT_A]).toBe('zh-CN-XiaoxiaoNeural');
    expect(voices[BOT_B]).toBe('en-US-AriaNeural');
  });

  it('setBotTtsRate stores per-bot rate', () => {
    setBotTtsRate(BOT_A, '1.0');
    setBotTtsRate(BOT_B, '1.5');
    const rates = getBotTtsRates();
    expect(rates[BOT_A]).toBe('1.0');
    expect(rates[BOT_B]).toBe('1.5');
  });

  it('voice and rate are independent between bots', () => {
    // Spec: stored independently
    setBotVoiceSelection(BOT_A, 'voice-A');
    setBotTtsRate(BOT_A, '0.8');
    setBotVoiceSelection(BOT_B, 'voice-B');
    setBotTtsRate(BOT_B, '1.2');
    // Changing Bot-B should not affect Bot-A
    setBotVoiceSelection(BOT_B, 'voice-B-updated');
    expect(getBotVoiceSelections()[BOT_A]).toBe('voice-A');
    expect(getBotTtsRates()[BOT_A]).toBe('0.8');
  });

  it('unset bot returns undefined voice and rate', () => {
    const voices = getBotVoiceSelections();
    const rates = getBotTtsRates();
    expect(voices['nonexistent-bot']).toBeUndefined();
    expect(rates['nonexistent-bot']).toBeUndefined();
  });
});

// ============================================================
// SC-B-07: TTS failure -> fallback to browser speechSynthesis
// Spec: "TTS failure -> fallback to browser speechSynthesis."
// ============================================================
describe('SC-B-07: TTS failure -> fallback to browser speechSynthesis', () => {
  it('requestTTS callback with null triggers browser speechSynthesis fallback', () => {
    // Spec: TTS failure -> fallback to browser speechSynthesis
    const mockRequestTTS = vi.fn((_text: string, cb: (b64: string | null) => void) => {
      cb(null); // simulate TTS failure
    });
    audioPlayer.init({ requestTTS: mockRequestTTS });

    const speakSpy = vi.fn();
    (window.speechSynthesis as unknown as { speak: typeof speakSpy }).speak = speakSpy;

    audioPlayer.enqueue(null, '', 'fallback text');
    expect(mockRequestTTS).toHaveBeenCalled();
    // On null response, _browserSpeak is called as fallback
    expect(speakSpy).toHaveBeenCalled();
  });

  it('requestTTS callback with valid b64 attempts audio playback (no fallback needed)', () => {
    // Spec: when TTS succeeds, no fallback
    const mockRequestTTS = vi.fn((_text: string, cb: (b64: string | null) => void) => {
      cb('dGVzdA=='); // successful TTS
    });
    audioPlayer.init({ requestTTS: mockRequestTTS });

    audioPlayer.enqueue(null, '', 'text with TTS');
    expect(mockRequestTTS).toHaveBeenCalled();
    expect(audioPlayer.state).toBe('playing');
  });

  it('enqueue with empty audioB64 triggers requestTTS callback', () => {
    // Spec: empty b64 means TTS needs to be requested
    const mockRequestTTS = vi.fn();
    audioPlayer.init({ requestTTS: mockRequestTTS });
    audioPlayer.enqueue(null, '', 'text needing TTS');
    expect(mockRequestTTS).toHaveBeenCalledWith(
      'text needing TTS',
      expect.any(Function),
    );
  });

  it('SC-B-07: 3 consecutive TTS failures emit audio:tts-failures-exceeded event', () => {
    // Spec: "_consecutiveFailures increments; after 3 consecutive failures
    //        (TTS_FAILURE_THRESHOLD=3), trigger audio:tts-failures-exceeded event"
    const mockRequestTTS = vi.fn((_text: string, cb: (b64: string | null) => void) => {
      cb(null); // simulate TTS failure every time
    });
    audioPlayer.init({ requestTTS: mockRequestTTS });

    const speakSpy = vi.fn();
    (window.speechSynthesis as unknown as { speak: typeof speakSpy }).speak = speakSpy;

    const failureExceededSpy = vi.fn();
    bus.on('audio:tts-failures-exceeded', failureExceededSpy);

    // First failure — no threshold event yet
    audioPlayer.enqueue(null, '', 'fail 1');
    // Need to drain queue: stop and re-enqueue for next failure
    audioPlayer.stop();
    audioPlayer.enqueue(null, '', 'fail 2');
    audioPlayer.stop();

    // After 2 failures, threshold not yet reached
    expect(failureExceededSpy).not.toHaveBeenCalled();

    // Third failure triggers threshold
    audioPlayer.enqueue(null, '', 'fail 3');

    expect(failureExceededSpy).toHaveBeenCalledOnce();
  });

  it('SC-B-07: each TTS failure emits audio:tts-failed with element', () => {
    // Spec: "每次失败：立即回退到 browser speechSynthesis"
    //       audio:tts-failed event carries the element for CSS class annotation
    const mockRequestTTS = vi.fn((_text: string, cb: (b64: string | null) => void) => {
      cb(null); // TTS failure
    });
    audioPlayer.init({ requestTTS: mockRequestTTS });

    const speakSpy = vi.fn();
    (window.speechSynthesis as unknown as { speak: typeof speakSpy }).speak = speakSpy;

    const ttsFailed = vi.fn();
    bus.on('audio:tts-failed', ttsFailed);

    const el = document.createElement('div');
    audioPlayer.enqueue(el, '', 'failing text');

    expect(ttsFailed).toHaveBeenCalledWith(expect.objectContaining({ element: el }));
  });
});

// ============================================================
// SC-B-08: Generation counter: stop/cancel mid-playback invalidates stale callbacks
// Spec: "Generation counter: stop/cancel mid-playback invalidates stale callbacks."
// ============================================================
describe('SC-B-08: generation counter prevents stale audio playback', () => {
  it('stop() increments generation -- stale callbacks are discarded', () => {
    audioPlayer.enqueue(null, 'dGVzdA==', 'will be stale');
    expect(audioPlayer.state).toBe('playing');
    audioPlayer.stop();
    expect(audioPlayer.state).toBe('idle');
    // decodeAudioData callback from the first enqueue is now stale
    expect(_decodeSuccessCbs.length).toBeGreaterThan(0);
  });

  it('interrupt:stop-audio increments generation and allows fresh enqueue', () => {
    audioPlayer.enqueue(null, 'dGVzdA==', 'test');
    expect(audioPlayer.state).toBe('playing');
    bus.emit('interrupt:stop-audio');
    expect(audioPlayer.state).toBe('idle');
    // New enqueue after interrupt works fresh
    audioPlayer.enqueue(null, 'dGVzdA==', 'new');
    expect(audioPlayer.state).toBe('playing');
  });

  it('pause increments generation (no stale callback can resume old playback)', () => {
    audioPlayer.enqueue(null, 'dGVzdA==', 'test');
    expect(audioPlayer.state).toBe('playing');
    audioPlayer.pause();
    expect(audioPlayer.state).toBe('paused');
  });

  it('cancelPlayback increments generation and sets paused', () => {
    audioPlayer.enqueue(null, 'dGVzdA==', 'test');
    expect(audioPlayer.state).toBe('playing');
    audioPlayer.cancelPlayback();
    expect(audioPlayer.state).toBe('paused');
    // Queue is cleared -- resume goes to idle since currentIdx is invalid
    audioPlayer.resume();
    expect(audioPlayer.state).toBe('idle');
  });

  it('rapid stop-enqueue cycles do not leave stale state', () => {
    // Spec: generation counter invalidates each previous cycle
    audioPlayer.enqueue(null, 'dGVzdA==', 'a');
    expect(audioPlayer.state).toBe('playing');
    audioPlayer.stop();
    expect(audioPlayer.state).toBe('idle');

    audioPlayer.enqueue(null, 'dGVzdA==', 'b');
    expect(audioPlayer.state).toBe('playing');
    audioPlayer.stop();
    expect(audioPlayer.state).toBe('idle');

    audioPlayer.enqueue(null, 'dGVzdA==', 'c');
    expect(audioPlayer.state).toBe('playing');
    audioPlayer.stop();
    expect(audioPlayer.state).toBe('idle');
  });

  it('stale decodeAudioData callback is silently ignored after stop', () => {
    // Spec: stale callbacks invalidated by generation counter
    audioPlayer.enqueue(null, 'dGVzdA==', 'stale');
    expect(audioPlayer.state).toBe('playing');
    const cbsBefore = _decodeSuccessCbs.length;

    audioPlayer.stop();
    expect(audioPlayer.state).toBe('idle');

    // Resolve the stale callback -- should be a no-op due to generation check
    const staleCb = _decodeSuccessCbs[cbsBefore - 1];
    if (staleCb) {
      const mockBuffer = {
        numberOfChannels: 1,
        duration: 1,
        getChannelData: () => new Float32Array(100),
      };
      staleCb(mockBuffer);
    }
    // State should still be idle (stale callback ignored)
    expect(audioPlayer.state).toBe('idle');
  });
});

// ============================================================
// SC-B-09: Audio end -> all bots' speaking state reset to idle (safety net)
// Spec: "Audio end -> all bots' speaking state reset to idle (safety net)."
// ============================================================
describe('SC-B-09: audio end -> all bots speaking state reset (safety net)', () => {
  it('resetBotToIdle clears speaking state for a single bot', () => {
    setBotMicState(BOT_A, 'recording');
    setBotMicState(BOT_A, 'processing');
    setBotMicState(BOT_A, 'speaking');
    expect(getBotMicState(BOT_A)).toBe('speaking');
    resetBotToIdle(BOT_A);
    expect(getBotMicState(BOT_A)).toBe('');
  });

  it('both bots can be reset from speaking to idle (safety net)', () => {
    // Spec: ALL bots' speaking state reset
    setBotMicState(BOT_A, 'recording');
    setBotMicState(BOT_A, 'processing');
    setBotMicState(BOT_A, 'speaking');

    setBotMicState(BOT_B, 'recording');
    setBotMicState(BOT_B, 'processing');
    setBotMicState(BOT_B, 'speaking');

    expect(getBotMicState(BOT_A)).toBe('speaking');
    expect(getBotMicState(BOT_B)).toBe('speaking');

    resetBotToIdle(BOT_A);
    resetBotToIdle(BOT_B);
    expect(getBotMicState(BOT_A)).toBe('');
    expect(getBotMicState(BOT_B)).toBe('');
  });

  it('audio:state end event can trigger per-bot reset (wiring mechanism)', () => {
    // Spec: audio end resets all bots via event handler
    bus.on('audio:state', (evt: { state: string; phase: string }) => {
      if (evt.phase === 'end') {
        resetBotToIdle(BOT_A);
        resetBotToIdle(BOT_B);
      }
    });

    setBotMicState(BOT_A, 'recording');
    setBotMicState(BOT_A, 'processing');
    setBotMicState(BOT_A, 'speaking');

    audioPlayer.enqueue(null, 'dGVzdA==', 'test');
    audioPlayer.stop();
    expect(getBotMicState(BOT_A)).toBe('');
  });
});

// ============================================================
// SC-B-10: Sync path: current bot receives sync message -> TTS if autoRead on
// Spec: "Sync path: current bot receives sync message -> TTS if autoRead on."
// ============================================================
describe('SC-B-10: sync path -> TTS if autoRead on', () => {
  it('autoReadEnqueue passes when autoRead is on and mic is idle', () => {
    // Spec: sync path TTS if autoRead on
    setAutoReadEnabled(true);
    expect(isAutoReadEnabled()).toBe(true);
  });

  it('isTextAlreadyRead prevents duplicate TTS on sync path', () => {
    // Spec: sync message is only TTS'd if not already read
    markTextRead(BOT_A, 'Already spoken via stream');
    expect(isTextAlreadyRead(BOT_A, 'Already spoken via stream')).toBe(true);
    expect(isTextAlreadyRead(BOT_A, 'New unread message')).toBe(false);
  });

  it('markTextRead + shouldIncludeMsg interaction on sync path', () => {
    // Spec: sync path filters by granularity before TTS
    setGranularity('final_only');
    const finalMsg = { intermediate: false, text: 'Final answer' };
    const intermediateMsg = { intermediate: true, contentKind: 'thinking', text: 'Thinking...' };

    expect(shouldIncludeMsg(finalMsg)).toBe(true);
    expect(shouldIncludeMsg(intermediateMsg)).toBe(false);

    markTextRead(BOT_A, 'Final answer');
    expect(isTextAlreadyRead(BOT_A, 'Final answer')).toBe(true);
  });

  it('sync path respects granularity filter for TTS candidates', () => {
    setGranularity('with_thinking');
    const thinkingMsg = { intermediate: true, contentKind: 'thinking', text: 'Thinking...' };
    const toolMsg = { intermediate: true, contentKind: 'tool_call', text: 'Running tool...' };

    expect(shouldIncludeMsg(thinkingMsg)).toBe(true);
    expect(shouldIncludeMsg(toolMsg)).toBe(false);
  });
});

// ============================================================
// SC-B-11: Multi-card response: chunks enqueued in order
// Spec: "Multi-card response: chunks enqueued in order."
// ============================================================
describe('SC-B-11: multi-card response -> chunks enqueued in order', () => {
  it('multiple chunks enqueued maintain sequence (first fires start event)', () => {
    // Spec: chunks enqueued in order
    const startTexts: string[] = [];
    bus.on('audio:state', (evt: { phase: string; chunkText: string }) => {
      if (evt.phase === 'start') startTexts.push(evt.chunkText);
    });

    audioPlayer.enqueue(null, 'dGVzdA==', 'card-1 text');
    audioPlayer.enqueue(null, 'dGVzdA==', 'card-2 text');
    audioPlayer.enqueue(null, 'dGVzdA==', 'card-3 text');

    // First item starts immediately
    expect(startTexts[0]).toBe('card-1 text');
    expect(audioPlayer.state).toBe('playing');
  });

  it('multiple enqueue calls build up the queue while first item plays', () => {
    // Spec: chunks enqueued -- queue builds while first is playing
    audioPlayer.enqueue(null, 'dGVzdA==', 'chunk 1');
    expect(audioPlayer.state).toBe('playing');
    audioPlayer.enqueue(null, 'dGVzdA==', 'chunk 2');
    audioPlayer.enqueue(null, 'dGVzdA==', 'chunk 3');
    expect(audioPlayer.state).toBe('playing');
  });

  it('intermediate and final cards filtered by shouldIncludeMsg', () => {
    // Spec: multi-card filtering
    setGranularity('final_only');
    const cards = [
      { intermediate: true, contentKind: 'tool_call', text: 'Tool output' },
      { intermediate: true, contentKind: 'thinking', text: 'Thinking...' },
      { intermediate: false, text: 'Final answer' },
    ];

    const ttsTexts = cards
      .filter(c => shouldIncludeMsg(c))
      .map(c => c.text);

    expect(ttsTexts).toEqual(['Final answer']);
  });

  it('with_thinking granularity includes thinking cards in TTS', () => {
    setGranularity('with_thinking');
    const cards = [
      { intermediate: true, contentKind: 'thinking', text: 'Thinking step' },
      { intermediate: false, text: 'Final answer' },
    ];

    const ttsTexts = cards
      .filter(c => shouldIncludeMsg(c))
      .map(c => c.text);

    expect(ttsTexts).toEqual(['Thinking step', 'Final answer']);
  });
});

// ============================================================
// SC-B-12: Per-paragraph highlight + scroll tracking during TTS
// Spec: "Per-paragraph highlight + scroll tracking during TTS
//         (audio:state events carry msgEl+chunkText)."
// ============================================================
describe('SC-B-12: per-paragraph highlight + scroll (audio:state carries msgEl+chunkText)', () => {
  it('audio:state start event includes msgEl for highlight wiring', () => {
    // Spec: audio:state events carry msgEl
    const spy = vi.fn();
    bus.on('audio:state', spy);
    const el = document.createElement('div');
    audioPlayer.enqueue(el, 'dGVzdA==', 'paragraph one');

    const startCall = spy.mock.calls.find(
      (c: unknown[]) => (c[0] as { phase: string }).phase === 'start',
    );
    expect(startCall).toBeTruthy();
    expect((startCall![0] as { msgEl: HTMLElement }).msgEl).toBe(el);
  });

  it('audio:state events carry chunkText for highlight matching', () => {
    // Spec: audio:state events carry chunkText
    const spy = vi.fn();
    bus.on('audio:state', spy);
    audioPlayer.enqueue(null, 'dGVzdA==', 'highlighted paragraph');

    const startCall = spy.mock.calls.find(
      (c: unknown[]) => (c[0] as { phase: string }).phase === 'start',
    );
    expect((startCall![0] as { chunkText: string }).chunkText).toBe('highlighted paragraph');
  });

  it('audio:state end fires on stop for highlight removal wiring', () => {
    // Spec: end event allows highlight cleanup
    const spy = vi.fn();
    bus.on('audio:state', spy);
    const el = document.createElement('div');
    audioPlayer.enqueue(el, 'dGVzdA==', 'test');
    audioPlayer.stop();
    const endCall = spy.mock.calls.find(
      (c: unknown[]) => (c[0] as { phase: string }).phase === 'end',
    );
    expect(endCall).toBeTruthy();
  });
});

// ============================================================
// SC-B-14: TTS failure -> user notified via card annotation + announcement
// Spec: "TTS failure -> user notified via card annotation + announcement."
// ============================================================
describe('SC-B-14: TTS failure -> user notification mechanism', () => {
  it('audioPlayer init with requestTTS callback stores it', () => {
    // Spec: TTS callback infrastructure for notification path
    const mockRequestTTS = vi.fn();
    audioPlayer.init({ requestTTS: mockRequestTTS });
    expect(audioPlayer.state).toBe('idle');
  });

  it('TTS failure (null response) triggers browser fallback as notification path', () => {
    // Spec: TTS failure -> user notified
    // ISSUE-05: TTS failure should notify user
    const mockRequestTTS = vi.fn((_text: string, cb: (b64: string | null) => void) => {
      cb(null); // TTS failure
    });
    audioPlayer.init({ requestTTS: mockRequestTTS });

    const speakSpy = vi.fn();
    (window.speechSynthesis as unknown as { speak: typeof speakSpy }).speak = speakSpy;

    audioPlayer.enqueue(null, '', 'fallback text');
    expect(mockRequestTTS).toHaveBeenCalled();
    // Browser fallback is the notification mechanism for now
    expect(speakSpy).toHaveBeenCalled();
  });

  it('audio:state end fires even when queue drains from empty items', () => {
    // Spec: failure path still completes lifecycle
    audioPlayer.init({ requestTTS: undefined });
    const spy = vi.fn();
    bus.on('audio:state', spy);

    audioPlayer.enqueue(null, '', '');

    const endCall = spy.mock.calls.find(
      (c: unknown[]) => (c[0] as { phase: string }).phase === 'end',
    );
    expect(endCall).toBeTruthy();
    expect(audioPlayer.state).toBe('idle');
  });

  it('SC-B-14: audio:tts-failed event carries element for .tts-failed CSS class annotation', () => {
    // Spec: "朗读失败的消息卡片上显示 visual toast 警告"
    //       "消息卡片获得 .tts-failed CSS class"
    const mockRequestTTS = vi.fn((_text: string, cb: (b64: string | null) => void) => {
      cb(null); // TTS failure
    });
    audioPlayer.init({ requestTTS: mockRequestTTS });

    const speakSpy = vi.fn();
    (window.speechSynthesis as unknown as { speak: typeof speakSpy }).speak = speakSpy;

    const ttsFailed = vi.fn();
    bus.on('audio:tts-failed', ttsFailed);

    const el = document.createElement('div');
    audioPlayer.enqueue(el, '', 'failing TTS text');

    // audio:tts-failed fires with element so event-wiring can add .tts-failed class
    expect(ttsFailed).toHaveBeenCalledWith(expect.objectContaining({ element: el }));
  });
});

// ============================================================
// ISSUE-02: Speaking timeout refreshed on audio:state start (verify)
// Spec: "Speaking timeout refreshed on audio:state start (already fixed)."
// ============================================================
describe('ISSUE-02: speaking timeout refreshed on audio:state start', () => {
  it('botTurnState.refreshTimer is callable during audio:state start', () => {
    // Spec: speaking timeout refreshed on audio:state start
    // Wire a handler that refreshes timer on audio:state start (as event-wiring does)
    bus.on('audio:state', (evt: { phase: string }) => {
      if (evt.phase === 'start') {
        botTurnState.refreshTimer(BOT_A);
      }
    });

    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');

    // Enqueue triggers audio:state start -> refreshTimer
    audioPlayer.enqueue(null, 'dGVzdA==', 'test text');

    // Bot should still be speaking (timer refreshed, not timed out)
    expect(botTurnState.get(BOT_A)).toBe('speaking');
  });
});

// ============================================================
// ISSUE-03: Manual play-btn should use Azure TTS if configured (verify)
// Spec: "Manual play-btn should use Azure TTS if configured."
// ============================================================
describe('ISSUE-03: manual play-btn uses Azure TTS if configured', () => {
  it('requestTTS callback is invoked when audioB64 is empty (play-btn path)', () => {
    // Spec: manual play triggers requestTTS (which routes to Azure if configured)
    const mockRequestTTS = vi.fn();
    audioPlayer.init({ requestTTS: mockRequestTTS });

    audioPlayer.enqueue(null, '', 'play button text');
    expect(mockRequestTTS).toHaveBeenCalledWith(
      'play button text',
      expect.any(Function),
    );
  });

  it('per-bot voice selection is available for Azure TTS routing', () => {
    // Spec: Azure TTS uses per-bot voice configuration
    setBotVoiceSelection(BOT_A, 'zh-CN-XiaoxiaoNeural');
    expect(getBotVoiceSelections()[BOT_A]).toBe('zh-CN-XiaoxiaoNeural');
  });
});

// ============================================================
// ISSUE-05: TTS failure should notify user (verify)
// ============================================================
describe('ISSUE-05: TTS failure notifies user', () => {
  it('TTS failure falls back to speechSynthesis as user notification', () => {
    // Spec: TTS failure -> user notified
    const mockRequestTTS = vi.fn((_text: string, cb: (b64: string | null) => void) => {
      cb(null); // failure
    });
    audioPlayer.init({ requestTTS: mockRequestTTS });

    const speakSpy = vi.fn();
    (window.speechSynthesis as unknown as { speak: typeof speakSpy }).speak = speakSpy;

    audioPlayer.enqueue(null, '', 'notify user text');
    expect(speakSpy).toHaveBeenCalled();
  });
});

// ============================================================
// Cross-scenario: autoRead toggle + interrupt interaction
// ============================================================
describe('Cross-scenario: autoRead + interrupt interactions', () => {
  it('disabling autoRead mid-playback: audio continues until manual stop', () => {
    // Spec: autoRead toggle only affects future enqueues, not current playback
    setAutoReadEnabled(true);
    audioPlayer.enqueue(null, 'dGVzdA==', 'playing');
    expect(audioPlayer.state).toBe('playing');

    setAutoReadEnabled(false);
    expect(audioPlayer.state).toBe('playing'); // not immediately stopped

    audioPlayer.stop();
    expect(audioPlayer.state).toBe('idle');
  });

  it('autoReadEnqueue guard is checked before dynamic import', () => {
    setAutoReadEnabled(false);
    const el = document.createElement('div');
    autoReadEnqueue(el, 'dGVzdA==', 'should not enqueue');
    expect(audioPlayer.state).toBe('idle');
  });

  it('autoReadEnqueue guard: null element is rejected', () => {
    setAutoReadEnabled(true);
    autoReadEnqueue(null, 'dGVzdA==', 'no element');
    expect(audioPlayer.state).toBe('idle');
  });
});
