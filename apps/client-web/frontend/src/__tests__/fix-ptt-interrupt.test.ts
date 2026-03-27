// @vitest-environment jsdom
/**
 * INV-WW-01: PTT recording start should only interrupt TTS playback (speaking state),
 * NOT Agent generation (receiving/awaiting states).
 *
 * Regression tests for the fix in recording/ptt-recorder.ts:
 * - PTT start during 'receiving' state must NOT call interruptBot
 * - PTT start during 'awaiting' state must NOT call interruptBot
 * - PTT start during 'speaking' state MUST call interruptBot with 'stopped_reading'
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { botTurnState } from '../state/bot-turn-state';
import { setupTestBots, teardownTest, mockBrowserAPIs, BOT_A } from './helpers/test-setup';

// Mock modules that ptt-recorder depends on
vi.mock('../ui/app-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/app-state')>();
  return {
    ...actual,
    interruptBot: vi.fn(),
    getCurrentBotId: vi.fn(() => BOT_A),
    getInputMode: vi.fn(() => 'ptt'),
    flushDeferredReads: vi.fn(),
    showToast: vi.fn(),
  };
});

vi.mock('../audio/audio-player', () => ({
  audioPlayer: {
    state: 'idle',
    cancelPlayback: vi.fn(),
    getAudioContext: vi.fn(),
    resetPause: vi.fn(),
    enqueue: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock('../network/ws-client', () => ({
  send: vi.fn(),
  nextMsgId: vi.fn(() => 'msg_test_1'),
  isConnected: vi.fn(() => true),
}));

vi.mock('../network/outbox', () => ({
  outbox: { enqueue: vi.fn() },
}));

vi.mock('../store/voice-history-store', () => ({
  voiceHistoryStore: { saveRecording: vi.fn(() => Promise.resolve()) },
}));

vi.mock('../audio/browser-stt', () => ({
  browserSTT: { ready: false, transcribe: vi.fn() },
}));

// Mock recording-utils to avoid real getUserMedia / MediaRecorder interactions
vi.mock('../recording/recording-utils', () => ({
  getMicStream: vi.fn(() => Promise.resolve({
    getTracks: () => [{ stop: vi.fn() }],
  })),
  newRecorder: vi.fn(() => ({
    recorder: {
      start: vi.fn(),
      stop: vi.fn(),
      state: 'inactive',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      onstop: null,
      onerror: null,
    },
    chunks: [],
  })),
  buildRecordingBlob: vi.fn(() => null),
  blobToBase64: vi.fn(() => Promise.resolve('')),
  createStreamAnalyser: vi.fn(() => ({
    analyser: { getFloatTimeDomainData: vi.fn() },
    buf: new Float32Array(256),
  })),
  computeRMS: vi.fn(() => 0),
  createSilenceDetector: vi.fn(() => ({ check: vi.fn(() => false), reset: vi.fn() })),
  createChunkedTranscriptionSession: vi.fn(() => ({
    submitChunk: vi.fn(),
    finalize: vi.fn(() => Promise.resolve(null)),
    cancel: vi.fn(),
    hasChunks: false,
  })),
  getChunkMinDurationMs: vi.fn(() => 1000),
  SILENCE_THRESHOLD: 0.01,
  SILENCE_TRIGGER_MS: 1500,
}));

beforeEach(() => {
  mockBrowserAPIs();
  setupTestBots(BOT_A);
  vi.clearAllMocks();
});

afterEach(() => teardownTest());

describe('INV-WW-01: PTT start — only interrupt TTS playback, not Agent generation', () => {
  it('does NOT call interruptBot when bot is in receiving state', async () => {
    const { interruptBot } = await import('../ui/app-state');
    const interruptSpy = vi.mocked(interruptBot);

    // Bot is receiving (Agent is generating a response)
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    expect(botTurnState.get(BOT_A)).toBe('receiving');

    const { startRecording } = await import('../recording/ptt-recorder');
    await startRecording();

    expect(interruptSpy).not.toHaveBeenCalled();
  });

  it('does NOT call interruptBot when bot is in awaiting state', async () => {
    const { interruptBot } = await import('../ui/app-state');
    const interruptSpy = vi.mocked(interruptBot);

    // Bot is awaiting (waiting for Agent to start generating)
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    expect(botTurnState.get(BOT_A)).toBe('awaiting');

    const { startRecording } = await import('../recording/ptt-recorder');
    await startRecording();

    expect(interruptSpy).not.toHaveBeenCalled();
  });

  it('DOES call interruptBot with stopped_reading when bot is in speaking state', async () => {
    const { interruptBot } = await import('../ui/app-state');
    const interruptSpy = vi.mocked(interruptBot);

    // Set bot turn state to speaking (TTS is playing) — must follow valid FSM path
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'tts');
    botTurnState.transition(BOT_A, 'speaking');
    expect(botTurnState.get(BOT_A)).toBe('speaking');

    const { startRecording } = await import('../recording/ptt-recorder');
    await startRecording();

    expect(interruptSpy).toHaveBeenCalledWith(BOT_A, 'stopped_reading');
  });
});
