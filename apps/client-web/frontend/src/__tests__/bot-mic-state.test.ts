// @vitest-environment jsdom
/**
 * Tests for three-layer state management:
 *   Layer 1: MicState (global singleton)              — INV-MIC-01~03
 *   Layer 2: BotTurnState (per-bot)                   — INV-TURN-01~05
 *   Layer 3: RemoteAgentState (per-bot, informational)
 *   + Projection layer                                — INV-MIC-04
 *   + WS dispatcher guards                            — INV-TURN-06~07
 *   + Legacy API compatibility
 *   + ISSUE-01 documentation
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getBotMicState, setBotMicState, resetBotToIdle, getBotStatusReason,
  classifyServerStatus, interruptBot, isTurnCancelled, clearTurnCancelled,
  setCurrentBotId, setAutoReadEnabled,
} from '../ui/app-state';
import { micState } from '../state/mic-state';
import { botTurnState } from '../state/bot-turn-state';
import { remoteAgentState, classifyToAgentState } from '../state/remote-agent-state';
import { projectCssClass } from '../state/state-projection';
import { bus } from '../core/event-bus';
import { flush as flushLogBuffer, setLogLevel } from '../logging/logger';
import {
  setupTestBots, teardownTest, teardownIntegration,
  mockBrowserAPIs, wireRealWsDispatcher, wsMsg,
} from './helpers/test-setup';

// Module-level mocks for ws-dispatcher integration tests (INV-TURN-06, INV-TURN-07).
// These are hoisted by vitest and apply file-wide, but only affect modules that
// import these dependencies. The unit tests above don't import ws-dispatcher.
vi.mock('../ui/chat-renderer', () => ({
  addBotMsg: vi.fn(() => null),
  completeStreamAudio: vi.fn(),
  scrollToLatestSessionBoundary: vi.fn(() => false),
  renderChat: vi.fn(),
  autoReadUnreadN: vi.fn(),
  updateDeliveryStatusDOM: vi.fn(),
  scrollToReadingIfNeeded: vi.fn(),
  updatePlayButtons: vi.fn(),
}));
vi.mock('../ui/mic-ui', () => ({
  setMicRecordingState: vi.fn(),
  setCancelButtonsVisible: vi.fn(),
  setCancelReplyActive: vi.fn(),
  setVoiceRipple: vi.fn(),
  playVoiceFeedback: vi.fn(),
  updateBadges: vi.fn(),
  updateMicAvatar: vi.fn(),
}));
vi.mock('../ui/status-bar', () => ({
  setStatusText: vi.fn(),
  compactStatusText: vi.fn((raw: string) => raw),
}));
vi.mock('../ui/car-mode-overlay', () => ({
  setCarOverlayStatus: vi.fn(),
}));
vi.mock('../settings/slide-reset', () => ({
  onResetConfirmed: vi.fn(),
  onResetFailed: vi.fn(),
}));
vi.mock('../network/sync', () => ({
  syncManager: { schedule: vi.fn() },
}));
vi.mock('../audio/audio-player', () => ({
  audioPlayer: { state: 'idle', resetPause: vi.fn(), enqueue: vi.fn(), stop: vi.fn() },
}));
vi.mock('../platform/local-notifications', () => ({
  notifyNewMessage: vi.fn(),
}));
vi.mock('../ui/user-input-card', () => ({
  showUserInputCard: vi.fn(),
  dismissUserInputCard: vi.fn(),
}));
vi.mock('../audio/tts-chunker', () => ({
  chunkForTTS: vi.fn((t: string) => [t]),
}));

const BOT = 'main';
const BOT2 = 'second';

beforeEach(() => {
  mockBrowserAPIs();
  vi.useFakeTimers();
  resetBotToIdle(BOT);
  resetBotToIdle(BOT2);
  clearTurnCancelled(BOT);
  clearTurnCancelled(BOT2);
  micState._reset();
  botTurnState._reset();
  remoteAgentState._reset();
  botTurnState.ensureBot(BOT);
  botTurnState.ensureBot(BOT2);
  remoteAgentState.ensureBot(BOT);
  remoteAgentState.ensureBot(BOT2);
  setCurrentBotId(BOT);
  setAutoReadEnabled(true);
  bus.removeAll();
  setLogLevel('debug');
  flushLogBuffer();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ============================================================
// Layer 1: MicState
// ============================================================
// Source: src/state/mic-state.ts
describe('MicState (Layer 1)', () => {
  // INV-MIC-01: At most one Bot in acquiring/recording.
  // Starting new recording when active must be rejected.
  it('INV-MIC-01: startRecording rejected when mic already active', () => {
    micState.startRecording({ botId: BOT, mode: 'ptt' });
    const ok = micState.startRecording({ botId: BOT2, mode: 'wakeword' });
    expect(ok).toBe(false);
    expect(micState.context?.botId).toBe(BOT); // first recording preserved
  });

  it('INV-MIC-01: startRecording rejected from recording state', () => {
    micState.startRecording({ botId: BOT, mode: 'ptt' });
    micState.setRecording();
    const ok = micState.startRecording({ botId: BOT2, mode: 'wakeword' });
    expect(ok).toBe(false);
    expect(micState.state).toBe('recording');
    expect(micState.context?.botId).toBe(BOT);
  });

  // INV-MIC-02: micState.context non-null iff state !== idle.
  it('INV-MIC-02: context non-null in every non-idle state, null on idle', () => {
    // idle: context null
    expect(micState.context).toBeNull();

    // acquiring: context set
    micState.startRecording({ botId: BOT, mode: 'ptt' });
    expect(micState.context).not.toBeNull();
    expect(micState.context?.botId).toBe(BOT);

    // recording: context preserved
    micState.setRecording();
    expect(micState.context?.botId).toBe(BOT);

    // stopping: context preserved
    micState.setStopping();
    expect(micState.context?.botId).toBe(BOT);

    // saving: context preserved
    micState.setSaving();
    expect(micState.context?.botId).toBe(BOT);

    // idle: context nullified
    micState.setIdle();
    expect(micState.context).toBeNull();
  });

  // INV-MIC-03: cancelRecording() always succeeds from any state, emits cancelled:true.
  it('INV-MIC-03: cancelRecording from acquiring emits cancelled:true', () => {
    const handler = vi.fn();
    bus.on('mic:state-change', handler);
    micState.startRecording({ botId: BOT, mode: 'ptt' });
    handler.mockClear();
    micState.cancelRecording();
    expect(micState.state).toBe('idle');
    expect(micState.context).toBeNull();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      from: 'acquiring', to: 'idle', cancelled: true,
    }));
  });

  it('INV-MIC-03: cancelRecording from recording emits cancelled:true', () => {
    const handler = vi.fn();
    bus.on('mic:state-change', handler);
    micState.startRecording({ botId: BOT, mode: 'wakeword' });
    micState.setRecording();
    handler.mockClear();
    micState.cancelRecording();
    expect(micState.state).toBe('idle');
    expect(micState.context).toBeNull();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      from: 'recording', to: 'idle', cancelled: true,
    }));
  });

  it('INV-MIC-03: cancelRecording from stopping emits cancelled:true', () => {
    const handler = vi.fn();
    bus.on('mic:state-change', handler);
    micState.startRecording({ botId: BOT, mode: 'ptt' });
    micState.setRecording();
    micState.setStopping();
    handler.mockClear();
    micState.cancelRecording();
    expect(micState.state).toBe('idle');
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      from: 'stopping', to: 'idle', cancelled: true,
    }));
  });

  it('INV-MIC-03: cancelRecording from saving emits cancelled:true', () => {
    const handler = vi.fn();
    bus.on('mic:state-change', handler);
    micState.startRecording({ botId: BOT, mode: 'ptt' });
    micState.setRecording();
    micState.setStopping();
    micState.setSaving();
    handler.mockClear();
    micState.cancelRecording();
    expect(micState.state).toBe('idle');
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      from: 'saving', to: 'idle', cancelled: true,
    }));
  });

  it('INV-MIC-03: cancelRecording is safe no-op when already idle', () => {
    const handler = vi.fn();
    bus.on('mic:state-change', handler);
    micState.cancelRecording(); // should not throw or emit
    expect(micState.state).toBe('idle');
    expect(handler).not.toHaveBeenCalled();
  });

  // Full lifecycle (validates transition table)
  it('full lifecycle: idle → acquiring → recording → stopping → saving → idle', () => {
    micState.startRecording({ botId: BOT, mode: 'ptt' });
    expect(micState.setRecording()).toBe(true);
    expect(micState.state).toBe('recording');
    expect(micState.setStopping()).toBe(true);
    expect(micState.state).toBe('stopping');
    expect(micState.setSaving()).toBe(true);
    expect(micState.state).toBe('saving');
    expect(micState.setIdle()).toBe(true);
    expect(micState.state).toBe('idle');
    expect(micState.context).toBeNull();
  });

  it('emits mic:state-change with from/to on transitions', () => {
    const handler = vi.fn();
    bus.on('mic:state-change', handler);
    micState.startRecording({ botId: BOT, mode: 'ptt' });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      from: 'idle', to: 'acquiring',
    }));
  });
});

// ============================================================
// Layer 2: BotTurnState
// ============================================================
// Source: src/state/bot-turn-state.ts
describe('BotTurnState (Layer 2)', () => {
  // INV-TURN-01: Transitions follow ALLOWED table. Disallowed rejected (except resetToIdle).
  it('INV-TURN-01: legal full voice path succeeds', () => {
    expect(botTurnState.transition(BOT, 'listening')).toBe(true);
    expect(botTurnState.transition(BOT, 'stt')).toBe(true);
    expect(botTurnState.transition(BOT, 'sending')).toBe(true);
    expect(botTurnState.transition(BOT, 'awaiting')).toBe(true);
    expect(botTurnState.transition(BOT, 'receiving')).toBe(true);
    expect(botTurnState.transition(BOT, 'speaking')).toBe(true);
    expect(botTurnState.transition(BOT, 'idle')).toBe(true);
  });

  it('INV-TURN-01: text input path idle → sending → awaiting succeeds', () => {
    expect(botTurnState.transition(BOT, 'sending')).toBe(true);
    expect(botTurnState.transition(BOT, 'awaiting')).toBe(true);
    expect(botTurnState.get(BOT)).toBe('awaiting');
  });

  it('INV-TURN-01: idle → speaking is blocked', () => {
    expect(botTurnState.transition(BOT, 'speaking')).toBe(false);
    expect(botTurnState.get(BOT)).toBe('idle');
  });

  it('INV-TURN-01: listening → awaiting is blocked', () => {
    botTurnState.transition(BOT, 'listening');
    expect(botTurnState.transition(BOT, 'awaiting')).toBe(false);
    expect(botTurnState.get(BOT)).toBe('listening');
  });

  it('INV-TURN-01: transition(botId, idle) bypasses ALLOWED table from any state', () => {
    // Spec: transition(botId, 'idle') bypasses ALLOWED check (line 102 guard)
    botTurnState.transition(BOT, 'sending');
    expect(botTurnState.transition(BOT, 'idle')).toBe(true);
    expect(botTurnState.get(BOT)).toBe('idle');

    botTurnState.transition(BOT, 'listening');
    botTurnState.transition(BOT, 'stt');
    expect(botTurnState.transition(BOT, 'idle')).toBe(true);
    expect(botTurnState.get(BOT)).toBe('idle');
  });

  it('INV-TURN-01: receiving → listening is blocked', () => {
    botTurnState.transition(BOT, 'sending');
    botTurnState.transition(BOT, 'awaiting');
    botTurnState.transition(BOT, 'receiving');
    expect(botTurnState.transition(BOT, 'listening')).toBe(false);
    expect(botTurnState.get(BOT)).toBe('receiving');
  });

  // INV-TURN-02: resetToIdle always succeeds from any state.
  it('INV-TURN-02: resetToIdle from speaking', () => {
    botTurnState.transition(BOT, 'sending');
    botTurnState.transition(BOT, 'awaiting');
    botTurnState.transition(BOT, 'receiving');
    botTurnState.transition(BOT, 'speaking');
    botTurnState.resetToIdle(BOT);
    expect(botTurnState.get(BOT)).toBe('idle');
  });

  it('INV-TURN-02: resetToIdle from listening', () => {
    botTurnState.transition(BOT, 'listening');
    botTurnState.resetToIdle(BOT);
    expect(botTurnState.get(BOT)).toBe('idle');
  });

  it('INV-TURN-02: resetToIdle from awaiting', () => {
    botTurnState.transition(BOT, 'sending');
    botTurnState.transition(BOT, 'awaiting');
    botTurnState.resetToIdle(BOT);
    expect(botTurnState.get(BOT)).toBe('idle');
  });

  it('INV-TURN-02: resetToIdle from stt', () => {
    botTurnState.transition(BOT, 'listening');
    botTurnState.transition(BOT, 'stt');
    botTurnState.resetToIdle(BOT);
    expect(botTurnState.get(BOT)).toBe('idle');
  });

  it('INV-TURN-02: resetToIdle from sending', () => {
    botTurnState.transition(BOT, 'sending');
    botTurnState.resetToIdle(BOT);
    expect(botTurnState.get(BOT)).toBe('idle');
  });

  it('INV-TURN-02: resetToIdle from receiving', () => {
    botTurnState.transition(BOT, 'sending');
    botTurnState.transition(BOT, 'awaiting');
    botTurnState.transition(BOT, 'receiving');
    botTurnState.resetToIdle(BOT);
    expect(botTurnState.get(BOT)).toBe('idle');
  });

  it('INV-TURN-02: resetToIdle from idle is safe no-op', () => {
    const handler = vi.fn();
    bus.on('bot:turn-state-change', handler);
    botTurnState.resetToIdle(BOT);
    expect(botTurnState.get(BOT)).toBe('idle');
    expect(handler).not.toHaveBeenCalled(); // no event when already idle
  });

  // INV-TURN-03: Processing timeout 180s, timer resets on response_chunk.
  it('INV-TURN-03: processing timeout fires after 180s', () => {
    const handler = vi.fn();
    bus.on('bot:processing-timeout', handler);

    botTurnState.transition(BOT, 'sending');
    botTurnState.transition(BOT, 'awaiting');
    vi.advanceTimersByTime(180_000);

    expect(botTurnState.get(BOT)).toBe('idle');
    expect(handler).toHaveBeenCalledWith(BOT);
  });

  it('INV-TURN-03: sending state also has processing timeout at 180s', () => {
    const handler = vi.fn();
    bus.on('bot:processing-timeout', handler);

    botTurnState.transition(BOT, 'sending');
    vi.advanceTimersByTime(180_000);

    expect(botTurnState.get(BOT)).toBe('idle');
    expect(handler).toHaveBeenCalledWith(BOT);
  });

  it('INV-TURN-03: refreshTimer resets the processing timeout clock', () => {
    const handler = vi.fn();
    bus.on('bot:processing-timeout', handler);

    botTurnState.transition(BOT, 'sending');
    botTurnState.transition(BOT, 'awaiting');
    botTurnState.transition(BOT, 'receiving');

    // Advance 170s (short of the 180s timeout)
    vi.advanceTimersByTime(170_000);
    expect(botTurnState.get(BOT)).toBe('receiving');

    // refreshTimer resets the clock — simulates response_chunk arriving
    botTurnState.refreshTimer(BOT);

    // Advance another 170s — still within 180s from last refresh
    vi.advanceTimersByTime(170_000);
    expect(botTurnState.get(BOT)).toBe('receiving');
    expect(handler).not.toHaveBeenCalled();

    // Advance the remaining 10s to hit the new 180s window
    vi.advanceTimersByTime(10_000);
    expect(botTurnState.get(BOT)).toBe('idle');
    expect(handler).toHaveBeenCalledWith(BOT);
  });

  // INV-TURN-04: Speaking timeout 120s.
  it('INV-TURN-04: speaking timeout fires after 120s', () => {
    const handler = vi.fn();
    bus.on('bot:speaking-timeout', handler);

    botTurnState.transition(BOT, 'sending');
    botTurnState.transition(BOT, 'awaiting');
    botTurnState.transition(BOT, 'receiving');
    botTurnState.transition(BOT, 'speaking');
    vi.advanceTimersByTime(120_000);

    expect(botTurnState.get(BOT)).toBe('idle');
    expect(handler).toHaveBeenCalledWith(BOT);
  });

  it('INV-TURN-04: speaking timeout does not fire before 120s', () => {
    const handler = vi.fn();
    bus.on('bot:speaking-timeout', handler);

    botTurnState.transition(BOT, 'sending');
    botTurnState.transition(BOT, 'awaiting');
    botTurnState.transition(BOT, 'receiving');
    botTurnState.transition(BOT, 'speaking');

    vi.advanceTimersByTime(119_999);
    expect(botTurnState.get(BOT)).toBe('speaking');
    expect(handler).not.toHaveBeenCalled();
  });

  it('timeout clears when state changes before expiry', () => {
    const handler = vi.fn();
    bus.on('bot:processing-timeout', handler);

    botTurnState.transition(BOT, 'sending');
    botTurnState.transition(BOT, 'awaiting');
    botTurnState.transition(BOT, 'receiving');
    botTurnState.transition(BOT, 'speaking');

    vi.advanceTimersByTime(119_999);
    expect(botTurnState.get(BOT)).toBe('speaking');
    expect(handler).not.toHaveBeenCalled();
  });

  // INV-TURN-05: Multi-bot state independence.
  it('INV-TURN-05: Bot A speaking while Bot B in awaiting — both independent', () => {
    botTurnState.transition(BOT, 'sending');
    botTurnState.transition(BOT, 'awaiting');
    botTurnState.transition(BOT, 'receiving');
    botTurnState.transition(BOT, 'speaking');

    botTurnState.transition(BOT2, 'sending');
    botTurnState.transition(BOT2, 'awaiting');

    expect(botTurnState.get(BOT)).toBe('speaking');
    expect(botTurnState.get(BOT2)).toBe('awaiting');
  });

  it('INV-TURN-05: resetToIdle on Bot A does not affect Bot B', () => {
    botTurnState.transition(BOT, 'sending');
    botTurnState.transition(BOT, 'awaiting');

    botTurnState.transition(BOT2, 'sending');
    botTurnState.transition(BOT2, 'awaiting');
    botTurnState.transition(BOT2, 'receiving');

    botTurnState.resetToIdle(BOT);
    expect(botTurnState.get(BOT)).toBe('idle');
    expect(botTurnState.get(BOT2)).toBe('receiving');
  });

  it('emits bot:turn-state-change on transitions', () => {
    const handler = vi.fn();
    bus.on('bot:turn-state-change', handler);
    botTurnState.transition(BOT, 'listening');
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      botId: BOT, from: 'idle', to: 'listening',
    }));
  });

  it('same state transition is no-op (no event emitted)', () => {
    botTurnState.transition(BOT, 'listening');
    const handler = vi.fn();
    bus.on('bot:turn-state-change', handler);
    expect(botTurnState.transition(BOT, 'listening')).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
});

// ============================================================
// Layer 3: RemoteAgentState
// ============================================================
// Source: src/state/remote-agent-state.ts
describe('RemoteAgentState (Layer 3)', () => {
  it('starts idle', () => {
    expect(remoteAgentState.get(BOT)).toBe('idle');
  });

  it('updates state without transition guard', () => {
    remoteAgentState.update(BOT, 'queued');
    expect(remoteAgentState.get(BOT)).toBe('queued');
    remoteAgentState.update(BOT, 'generating');
    expect(remoteAgentState.get(BOT)).toBe('generating');
  });

  it('emits agent:state-change', () => {
    const handler = vi.fn();
    bus.on('agent:state-change', handler);
    remoteAgentState.update(BOT, 'processing');
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      botId: BOT, from: 'idle', to: 'processing',
    }));
  });

  it('resetToIdle works', () => {
    remoteAgentState.update(BOT, 'generating');
    remoteAgentState.resetToIdle(BOT);
    expect(remoteAgentState.get(BOT)).toBe('idle');
  });

  it('same state update is no-op', () => {
    remoteAgentState.update(BOT, 'processing');
    const handler = vi.fn();
    bus.on('agent:state-change', handler);
    remoteAgentState.update(BOT, 'processing');
    expect(handler).not.toHaveBeenCalled();
  });
});

// ============================================================
// classifyToAgentState
// ============================================================
// Source: src/state/remote-agent-state.ts
describe('classifyToAgentState', () => {
  it('classifies queued', () => {
    expect(classifyToAgentState('已排队')).toBe('queued');
    expect(classifyToAgentState('前面还有一条在处理')).toBe('queued');
  });

  it('classifies processing', () => {
    expect(classifyToAgentState('思考中...')).toBe('processing');
    expect(classifyToAgentState('处理中...')).toBe('processing');
    expect(classifyToAgentState('识别中...')).toBe('processing');
  });

  it('classifies generating', () => {
    expect(classifyToAgentState('生成语音中')).toBe('generating');
    expect(classifyToAgentState('生成回复')).toBe('generating');
    expect(classifyToAgentState('生成中')).toBe('generating');
  });

  it('returns null for non-processing status', () => {
    expect(classifyToAgentState('已切换到 Alexa')).toBeNull();
    expect(classifyToAgentState('会话已重置')).toBeNull();
  });
});

// ============================================================
// Projection — projectCssClass
// ============================================================
// Source: src/state/state-projection.ts
describe('Projection — projectCssClass', () => {
  it('returns recording when mic is active for bot', () => {
    micState.startRecording({ botId: BOT, mode: 'ptt' });
    micState.setRecording();
    expect(projectCssClass(BOT)).toBe('recording');
    expect(projectCssClass(BOT2)).toBe(''); // different bot
  });

  it('returns processing when mic is stopping and bot turn is active', () => {
    micState.startRecording({ botId: BOT, mode: 'ptt' });
    micState.setRecording();
    botTurnState.transition(BOT, 'listening');
    micState.setStopping();
    expect(projectCssClass(BOT)).toBe('processing');
  });

  it('returns processing for stt/sending/awaiting/receiving turn states', () => {
    botTurnState.transition(BOT, 'sending');
    expect(projectCssClass(BOT)).toBe('processing');
    botTurnState.transition(BOT, 'awaiting');
    expect(projectCssClass(BOT)).toBe('processing');
    botTurnState.transition(BOT, 'receiving');
    expect(projectCssClass(BOT)).toBe('processing');
  });

  it('returns speaking for speaking turn state', () => {
    botTurnState.transition(BOT, 'sending');
    botTurnState.transition(BOT, 'awaiting');
    botTurnState.transition(BOT, 'receiving');
    botTurnState.transition(BOT, 'speaking');
    expect(projectCssClass(BOT)).toBe('speaking');
  });

  // INV-MIC-04: When current bot turn = idle, no recording/processing/speaking animation.
  it('INV-MIC-04: returns empty string when bot turn is idle', () => {
    // Verify no CSS class animation when bot is in idle state
    expect(projectCssClass(BOT)).toBe('');
    expect(projectCssClass(BOT2)).toBe('');
  });

  it('INV-MIC-04: mic stopping with idle bot turn returns empty (no stale animation)', () => {
    // This tests the guard: mic saving but botTurnState already reset to idle
    // should NOT show 'processing' — prevents stale yellow animation
    micState.startRecording({ botId: BOT, mode: 'ptt' });
    micState.setRecording();
    micState.setStopping();
    // botTurnState is still idle (never transitioned)
    expect(projectCssClass(BOT)).toBe('');
  });
});

// ============================================================
// Legacy API compatibility (setBotMicState / getBotMicState)
// ============================================================
// Source: src/ui/app-state.ts
describe('Legacy API — setBotMicState transition guard', () => {
  describe('legal transitions', () => {
    it("'' → 'recording'", () => {
      setBotMicState(BOT, 'recording');
      expect(getBotMicState(BOT)).toBe('recording');
    });

    it("'' → 'processing'", () => {
      setBotMicState(BOT, 'processing');
      expect(getBotMicState(BOT)).toBe('processing');
    });

    it("'recording' → 'processing'", () => {
      setBotMicState(BOT, 'recording');
      setBotMicState(BOT, 'processing');
      expect(getBotMicState(BOT)).toBe('processing');
    });

    it("'processing' → 'speaking'", () => {
      setBotMicState(BOT, 'processing');
      setBotMicState(BOT, 'speaking');
      expect(getBotMicState(BOT)).toBe('speaking');
    });
  });

  describe('illegal transitions are rejected', () => {
    it("'' → 'speaking' is blocked", () => {
      setBotMicState(BOT, 'speaking');
      expect(getBotMicState(BOT)).toBe('');
    });

    it("'recording' → 'speaking' is blocked", () => {
      setBotMicState(BOT, 'recording');
      flushLogBuffer();
      setBotMicState(BOT, 'speaking');
      expect(getBotMicState(BOT)).toBe('recording');
    });
  });

  describe('resetBotToIdle', () => {
    for (const state of ['recording', 'processing', 'speaking'] as const) {
      it(`resets from '${state}' to ''`, () => {
        if (state === 'speaking') {
          setBotMicState(BOT, 'processing');
          setBotMicState(BOT, 'speaking');
        } else {
          setBotMicState(BOT, state);
        }
        expect(getBotMicState(BOT)).toBe(state);
        resetBotToIdle(BOT);
        expect(getBotMicState(BOT)).toBe('');
      });
    }
  });

  describe('processing timeout', () => {
    it('fires after 180s and emits bot:processing-timeout', () => {
      const handler = vi.fn();
      bus.on('bot:processing-timeout', handler);
      setBotMicState(BOT, 'processing');
      vi.advanceTimersByTime(180_000);
      expect(getBotMicState(BOT)).toBe('');
      expect(handler).toHaveBeenCalledWith(BOT);
    });
  });

  describe('speaking timeout', () => {
    it('fires after 120s and emits bot:speaking-timeout', () => {
      const handler = vi.fn();
      bus.on('bot:speaking-timeout', handler);
      setBotMicState(BOT, 'processing');
      setBotMicState(BOT, 'speaking');
      vi.advanceTimersByTime(120_000);
      expect(getBotMicState(BOT)).toBe('');
      expect(handler).toHaveBeenCalledWith(BOT);
    });
  });
});

// Source: src/ui/app-state.ts
describe('Legacy API — setBotMicState with reason', () => {
  it('processing with thinking reason', () => {
    setBotMicState('main', 'processing', 'thinking');
    expect(getBotStatusReason('main')).toBe('thinking');
  });

  it('idle with not_heard reason', () => {
    setBotMicState('main', 'processing');
    setBotMicState('main', '', 'not_heard');
    expect(getBotStatusReason('main')).toBe('not_heard');
  });

  it('same state with different reason updates reason', () => {
    setBotMicState('main', 'processing', 'recognizing');
    expect(getBotStatusReason('main')).toBe('recognizing');
    setBotMicState('main', 'processing', 'thinking');
    expect(getBotStatusReason('main')).toBe('thinking');
  });
});

// Source: src/ui/app-state.ts
describe('Legacy API — classifyServerStatus', () => {
  it('classifies thinking', () => {
    expect(classifyServerStatus('思考中...')).toBe('thinking');
  });

  it('classifies generating', () => {
    expect(classifyServerStatus('生成语音中')).toBe('generating');
  });

  it('classifies processing', () => {
    expect(classifyServerStatus('处理中...')).toBe('processing');
    expect(classifyServerStatus('已排队')).toBe('processing');
  });

  it('classifies recognizing', () => {
    expect(classifyServerStatus('识别中...')).toBe('recognizing');
  });

  it('returns null for non-processing status', () => {
    expect(classifyServerStatus('已切换到 Alexa')).toBeNull();
  });
});

// ============================================================
// interruptBot
// ============================================================
// Source: src/ui/app-state.ts
describe('interruptBot', () => {
  it('resets any state to idle', () => {
    setBotMicState('main', 'recording');
    setBotMicState('main', 'processing');
    interruptBot('main', 'stopped_reading');
    expect(getBotMicState('main')).toBe('');
    expect(getBotStatusReason('main')).toBe('stopped_reading');
  });

  it('resets Layer 2 turn state', () => {
    botTurnState.transition(BOT, 'sending');
    botTurnState.transition(BOT, 'awaiting');
    interruptBot(BOT, 'cancelled');
    expect(botTurnState.get(BOT)).toBe('idle');
  });

  it('resets Layer 3 agent state', () => {
    remoteAgentState.update(BOT, 'processing');
    interruptBot(BOT, 'cancelled');
    expect(remoteAgentState.get(BOT)).toBe('idle');
  });

  it('cancels mic if recording for this bot', () => {
    micState.startRecording({ botId: BOT, mode: 'ptt' });
    micState.setRecording();
    interruptBot(BOT);
    expect(micState.state).toBe('idle');
  });

  it('does not cancel mic if recording for different bot', () => {
    micState.startRecording({ botId: BOT2, mode: 'wakeword' });
    micState.setRecording();
    interruptBot(BOT);
    expect(micState.state).toBe('recording'); // BOT2's recording preserved
  });

  it('sets turn cancelled flag', () => {
    expect(isTurnCancelled('main')).toBe(false);
    interruptBot('main');
    expect(isTurnCancelled('main')).toBe(true);
  });

  it('emits interrupt:stop-audio event', () => {
    const spy = vi.fn();
    bus.on('interrupt:stop-audio', spy);
    interruptBot('main');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('is idempotent', () => {
    setBotMicState('main', 'recording');
    setBotMicState('main', 'processing');
    interruptBot('main', 'cancelled');
    interruptBot('main', 'stopped_reading');
    expect(getBotMicState('main')).toBe('');
    expect(getBotStatusReason('main')).toBe('stopped_reading');
  });
});

// ============================================================
// Turn cancellation
// ============================================================
// Source: src/ui/app-state.ts
describe('turn cancellation', () => {
  it('clearTurnCancelled resets flag', () => {
    interruptBot('main');
    expect(isTurnCancelled('main')).toBe(true);
    clearTurnCancelled('main');
    expect(isTurnCancelled('main')).toBe(false);
  });

  it('resetBotToIdle does not clear turn flag', () => {
    interruptBot('main');
    resetBotToIdle('main');
    expect(isTurnCancelled('main')).toBe(true);
  });
});

// ============================================================
// INV-TURN-06: Only current bot enters speaking (getCurrentBotId guard)
// INV-TURN-07: autoRead off → audio_chunk/speak don't trigger speaking
// ============================================================
// Source: src/network/ws-dispatcher.ts (audio_chunk handler, speak handler)
describe('INV-TURN-06 & INV-TURN-07: ws-dispatcher speaking guards', () => {
  let dispatch: (data: Record<string, unknown>) => void;

  beforeEach(async () => {
    dispatch = await wireRealWsDispatcher();
  });
  afterEach(() => teardownIntegration());

  // INV-TURN-06: Only current bot enters speaking.
  // audio_chunk for a non-current bot should NOT trigger speaking transition.
  it('INV-TURN-06: audio_chunk for non-current bot does not enter speaking', () => {
    // BOT is current (set in global beforeEach). Put BOT2 into receiving state.
    setCurrentBotId(BOT);
    botTurnState.transition(BOT2, 'sending');
    botTurnState.transition(BOT2, 'awaiting');
    botTurnState.transition(BOT2, 'receiving');

    // Dispatch audio_chunk for BOT2 (not the current bot)
    dispatch(wsMsg('audio_chunk', BOT2, { data: 'fakeAudioBase64' }));

    // BOT2 should remain in 'receiving', NOT transition to 'speaking'
    expect(botTurnState.get(BOT2)).toBe('receiving');
  });

  it('INV-TURN-06: audio_chunk for current bot enters speaking', () => {
    setCurrentBotId(BOT);
    setAutoReadEnabled(true);
    botTurnState.transition(BOT, 'sending');
    botTurnState.transition(BOT, 'awaiting');
    botTurnState.transition(BOT, 'receiving');

    dispatch(wsMsg('audio_chunk', BOT, { data: 'fakeAudioBase64' }));

    expect(botTurnState.get(BOT)).toBe('speaking');
  });

  // INV-TURN-07: autoRead off → audio_chunk/speak don't trigger speaking.
  it('INV-TURN-07: audio_chunk with autoRead off does not enter speaking', () => {
    setCurrentBotId(BOT);
    setAutoReadEnabled(false);
    botTurnState.transition(BOT, 'sending');
    botTurnState.transition(BOT, 'awaiting');
    botTurnState.transition(BOT, 'receiving');

    dispatch(wsMsg('audio_chunk', BOT, { data: 'fakeAudioBase64' }));

    // Should NOT transition to speaking when autoRead is disabled
    expect(botTurnState.get(BOT)).toBe('receiving');
  });

  it('INV-TURN-07: streaming speak with autoRead off does not enter speaking', () => {
    setCurrentBotId(BOT);
    setAutoReadEnabled(false);
    botTurnState.transition(BOT, 'sending');
    botTurnState.transition(BOT, 'awaiting');
    botTurnState.transition(BOT, 'receiving');

    dispatch(wsMsg('speak', BOT, { text: 'hello', streaming: true }));

    // Should NOT transition to speaking when autoRead is disabled
    expect(botTurnState.get(BOT)).toBe('receiving');
  });

  it('INV-TURN-07: streaming speak with autoRead on enters speaking for current bot', () => {
    setCurrentBotId(BOT);
    setAutoReadEnabled(true);
    botTurnState.transition(BOT, 'sending');
    botTurnState.transition(BOT, 'awaiting');
    botTurnState.transition(BOT, 'receiving');

    dispatch(wsMsg('speak', BOT, { text: 'hello', streaming: true }));

    expect(botTurnState.get(BOT)).toBe('speaking');
  });
});

// ============================================================
// ISSUE-01: BotTurnState/AudioPlayer coupling
// ============================================================
// Source: src/state/bot-turn-state.ts, src/audio/audio-player.ts
describe.skip('ISSUE-01: BotTurnState speaking state is coupled with audio playback', () => {
  // Architecture limitation: BotTurnState.speaking is entered when audio_chunk
  // arrives (ws-dispatcher) but exits only via timeout or explicit resetToIdle.
  // There is no event-driven feedback from AudioPlayer completion back to
  // BotTurnState. This means:
  //
  // 1. If audio finishes playing before audio_complete arrives, BotTurnState
  //    stays in 'speaking' until the server sends audio_complete or timeout fires.
  //
  // 2. If AudioPlayer is interrupted (user taps cancel), BotTurnState still
  //    shows 'speaking' until interruptBot() is called.
  //
  // Ideal: AudioPlayer 'idle' event should trigger BotTurnState → idle transition.
  // Current workaround: 120s speaking timeout (INV-TURN-04) catches stuck states.
  //
  // This describe.skip documents the limitation. Do NOT implement a fix here —
  // it requires an architecture change to add AudioPlayer → BotTurnState feedback.

  it('audio finish should reset speaking to idle (not implemented)', () => {
    // This test would verify that when AudioPlayer finishes playing,
    // BotTurnState transitions from 'speaking' to 'idle' automatically.
    // Currently this does not happen — only timeout or explicit reset works.
    expect(true).toBe(false); // Red — indicates the coupling issue exists
  });
});
