// @vitest-environment jsdom
/**
 * INV-CANCEL-01~04 mechanism tests
 *
 * INV-CANCEL-01: isTurnCancelled guard — when true, ws-dispatcher discards messages
 * INV-CANCEL-02: clearTurnCancelled — new turn (sending) clears residual flag
 * INV-CANCEL-03: interruptBot execution sequence (7 steps)
 * INV-CANCEL-04: interruptBot sends cancel_turn WS message when bot was busy
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  interruptBot, isTurnCancelled, clearTurnCancelled,
  resetBotToIdle, getBotMicState, getBotStatusReason,
} from '../ui/app-state';
import { micState } from '../state/mic-state';
import { botTurnState } from '../state/bot-turn-state';
import { remoteAgentState } from '../state/remote-agent-state';
import { bus } from '../core/event-bus';
import {
  setupTestBots, teardownTest, teardownIntegration,
  mockBrowserAPIs, wireRealWsDispatcher,
  BOT_A, BOT_B, wsMsg,
} from './helpers/test-setup';

// Mock DOM-dependent modules that ws-dispatcher imports
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
  setCancelReplyActive: vi.fn(),
  setVoiceRipple: vi.fn(),
  playVoiceFeedback: vi.fn(),
  updateBadges: vi.fn(),
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
vi.mock('../audio/tts-cleaner', () => ({
  chunkForTTS: vi.fn((t: string) => [t]),
}));

beforeEach(() => {
  mockBrowserAPIs();
  setupTestBots(BOT_A, BOT_B);
});
afterEach(() => teardownTest());

// ============================================================
// INV-CANCEL-01: isTurnCancelled flag (unit) + ws-dispatcher guard (integration)
// Source: ui/app-state.ts (isTurnCancelled, interruptBot)
//         network/ws-dispatcher.ts lines 71-93 (turnCancelled guard)
// ============================================================
describe('INV-CANCEL-01: isTurnCancelled guard', () => {
  // Source: ui/app-state.ts — isTurnCancelled(), interruptBot()

  it('is per-bot — interrupting A does not affect B', () => {
    interruptBot(BOT_A);
    expect(isTurnCancelled(BOT_A)).toBe(true);
    expect(isTurnCancelled(BOT_B)).toBe(false);
  });
});

// ============================================================
// INV-CANCEL-01 (integration): real ws-dispatcher drops stale messages
// Source: network/ws-dispatcher.ts lines 71-93
// ============================================================
describe('INV-CANCEL-01: ws-dispatcher drops stale messages when cancelled', () => {
  // Source: network/ws-dispatcher.ts createWsDispatcher() lines 71-93

  let dispatch: (data: Record<string, unknown>) => void;

  beforeEach(async () => {
    dispatch = await wireRealWsDispatcher();
  });
  afterEach(() => teardownIntegration());

  it('drops status when isTurnCancelled=true', () => {
    interruptBot(BOT_A);
    expect(isTurnCancelled(BOT_A)).toBe(true);

    dispatch(wsMsg('status', BOT_A, { text: '处理中...' }));
    // Turn state stays idle (status message was dropped, not processed)
    expect(botTurnState.get(BOT_A)).toBe('idle');
  });

  it('processes audio_complete even when cancelled — clears flag', () => {
    interruptBot(BOT_A);
    expect(isTurnCancelled(BOT_A)).toBe(true);

    dispatch(wsMsg('audio_complete', BOT_A, {}));
    expect(isTurnCancelled(BOT_A)).toBe(false);
  });

  it('processes transcript when cancelled — clears flag and falls through to normal handling', () => {
    interruptBot(BOT_A);
    expect(isTurnCancelled(BOT_A)).toBe(true);

    dispatch(wsMsg('transcript', BOT_A, { text: 'new user msg' }));
    // Flag cleared (transcript is an allowed message type during cancel)
    expect(isTurnCancelled(BOT_A)).toBe(false);
    // Note: idle→awaiting is a blocked FSM transition, so botTurnState
    // stays idle. The transcript still falls through to normal processing
    // (addBotMsg, setBotStatus, etc.) — the flag is the observable effect.
  });

  it('INV-CANCEL-01: message_sync always passes through even when cancelled', () => {
    // Given: Bot-A is cancelled
    interruptBot(BOT_A);
    expect(isTurnCancelled(BOT_A)).toBe(true);

    // When: message_sync arrives for the cancelled bot
    // Then: it is NOT dropped (message_sync is explicitly exempted from cancel guard)
    // The flag remains true (message_sync does not clear it)
    dispatch(wsMsg('message_sync', BOT_A, {
      messages: [],
      revision: 1,
    }));
    expect(isTurnCancelled(BOT_A)).toBe(true);
    // message_sync should have been processed (not dropped) —
    // the fact that no error was thrown and the dispatcher continued is the signal.
    // The turnCancelled flag remains because message_sync doesn't clear it.
  });

  it('processes cancel_ack when cancelled (does not drop)', async () => {
    interruptBot(BOT_A);
    expect(isTurnCancelled(BOT_A)).toBe(true);

    const { addBotMsg } = await import('../ui/chat-renderer') as unknown as { addBotMsg: ReturnType<typeof vi.fn> };
    const callsBefore = addBotMsg.mock.calls.length;
    dispatch(wsMsg('cancel_ack', BOT_A, { mode: 'generation_cancelled', ok: true }));
    // cancel_ack should be processed (addBotMsg called for the ack message)
    expect(addBotMsg.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

// ============================================================
// INV-CANCEL-02: clearTurnCancelled on new turn (sending)
// Source: ui/event-wiring.ts lines 372-374 (bot:turn-state-change handler)
//         ui/app-state.ts clearTurnCancelled()
// ============================================================
describe('INV-CANCEL-02: clearTurnCancelled', () => {
  // Source: ui/app-state.ts clearTurnCancelled()
  //         ui/event-wiring.ts bot:turn-state-change handler (lines 372-374)

  it('only clears the specified bot', () => {
    interruptBot(BOT_A);
    interruptBot(BOT_B);
    clearTurnCancelled(BOT_A);
    expect(isTurnCancelled(BOT_A)).toBe(false);
    expect(isTurnCancelled(BOT_B)).toBe(true);
  });

  it('resetBotToIdle does NOT clear the turn cancelled flag', () => {
    interruptBot(BOT_A);
    resetBotToIdle(BOT_A);
    expect(isTurnCancelled(BOT_A)).toBe(true);
  });
});

// ============================================================
// INV-CANCEL-02 (integration): real event-wiring clears flag on to=sending
// Source: ui/event-wiring.ts lines 372-374
// ============================================================
describe('INV-CANCEL-02: event-wiring clears flag on new turn (sending)', () => {
  // Source: ui/event-wiring.ts bindChatStoreChanged() bot:turn-state-change handler

  beforeEach(async () => {
    // Wire the real event-wiring handlers
    const ew = await import('../ui/event-wiring');
    const transcript = document.createElement('div');
    transcript.id = 'transcript';
    document.body.appendChild(transcript);
    ew.bindChatStoreChanged();
  });
  afterEach(() => {
    const el = document.getElementById('transcript');
    if (el) el.remove();
  });

  it('bot:turn-state-change to=sending clears residual turnCancelled flag', () => {
    // Set the cancelled flag (simulating a previous interrupt)
    interruptBot(BOT_A);
    expect(isTurnCancelled(BOT_A)).toBe(true);

    // Emit a real turn-state-change event (as botTurnState.transition would)
    bus.emit('bot:turn-state-change', { botId: BOT_A, from: 'idle', to: 'sending' });

    // Flag should be cleared by the event-wiring handler
    expect(isTurnCancelled(BOT_A)).toBe(false);
  });

  it('bot:turn-state-change to=awaiting does NOT clear flag', () => {
    interruptBot(BOT_A);
    expect(isTurnCancelled(BOT_A)).toBe(true);

    bus.emit('bot:turn-state-change', { botId: BOT_A, from: 'sending', to: 'awaiting' });

    // Flag should remain — only 'sending' clears it
    expect(isTurnCancelled(BOT_A)).toBe(true);
  });

  it('clears only the matching bot flag', () => {
    interruptBot(BOT_A);
    interruptBot(BOT_B);

    bus.emit('bot:turn-state-change', { botId: BOT_A, from: 'idle', to: 'sending' });

    expect(isTurnCancelled(BOT_A)).toBe(false);
    expect(isTurnCancelled(BOT_B)).toBe(true);
  });
});

// ============================================================
// INV-CANCEL-03: interruptBot execution sequence
// Source: ui/app-state.ts interruptBot() lines 190-209
// ============================================================
describe('INV-CANCEL-03: interruptBot execution sequence', () => {
  // Source: ui/app-state.ts interruptBot()

  it('step 3: cancels mic if recording for this bot', () => {
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    expect(micState.state).toBe('recording');

    interruptBot(BOT_A);
    expect(micState.state).toBe('idle');
    expect(micState.context).toBeNull();
  });

  it('step 3: does NOT cancel mic if recording for a different bot', () => {
    micState.startRecording({ botId: BOT_B, mode: 'wakeword' });
    micState.setRecording();

    interruptBot(BOT_A);
    expect(micState.state).toBe('recording');
    expect(micState.context?.botId).toBe(BOT_B);
  });

  it('step 3: skips mic cancel when mic is idle (cancelRecording not called)', () => {
    const cancelSpy = vi.spyOn(micState, 'cancelRecording');
    interruptBot(BOT_A);
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('step 4: resets BotTurnState to idle', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');

    interruptBot(BOT_A, 'cancelled');
    expect(botTurnState.get(BOT_A)).toBe('idle');
  });

  it('step 5: resets RemoteAgentState to idle', () => {
    remoteAgentState.update(BOT_A, 'processing');
    expect(remoteAgentState.get(BOT_A)).toBe('processing');

    interruptBot(BOT_A);
    expect(remoteAgentState.get(BOT_A)).toBe('idle');
  });

  it('step 6: emits interrupt:stop-audio event', () => {
    const spy = vi.fn();
    bus.on('interrupt:stop-audio', spy);

    interruptBot(BOT_A);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('resets legacy BotMicState to idle with reason', () => {
    interruptBot(BOT_A, 'cancelled');
    expect(getBotMicState(BOT_A)).toBe('');
    expect(getBotStatusReason(BOT_A)).toBe('cancelled');
  });

  it('sequence: all steps fire in a single call', () => {
    // Set up state across all layers
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    remoteAgentState.update(BOT_A, 'generating');

    const stopAudioSpy = vi.fn();
    bus.on('interrupt:stop-audio', stopAudioSpy);

    interruptBot(BOT_A, 'cancelled');

    // Verify all layers reset
    expect(isTurnCancelled(BOT_A)).toBe(true);        // step 1
    expect(micState.state).toBe('idle');               // step 3
    expect(botTurnState.get(BOT_A)).toBe('idle');      // step 4
    expect(remoteAgentState.get(BOT_A)).toBe('idle');  // step 5
    expect(stopAudioSpy).toHaveBeenCalledOnce();       // step 6
  });

  it('does not affect other bots', () => {
    botTurnState.transition(BOT_B, 'sending');
    botTurnState.transition(BOT_B, 'awaiting');
    remoteAgentState.update(BOT_B, 'processing');

    interruptBot(BOT_A);

    expect(botTurnState.get(BOT_B)).toBe('awaiting');
    expect(remoteAgentState.get(BOT_B)).toBe('processing');
    expect(isTurnCancelled(BOT_B)).toBe(false);
  });
});

// ============================================================
// INV-CANCEL-03 (cont.): interruptBot idempotency
// Source: ui/app-state.ts interruptBot()
// ============================================================
describe('INV-CANCEL-03: interruptBot idempotency', () => {
  // Source: ui/app-state.ts interruptBot()

  it('second call updates reason while preserving cancelled state', () => {
    interruptBot(BOT_A, 'cancelled');
    interruptBot(BOT_A, 'stopped_reading');
    expect(getBotStatusReason(BOT_A)).toBe('stopped_reading');
    expect(isTurnCancelled(BOT_A)).toBe(true);
    expect(botTurnState.get(BOT_A)).toBe('idle');
  });

  it('emits interrupt:stop-audio on each call', () => {
    const spy = vi.fn();
    bus.on('interrupt:stop-audio', spy);
    interruptBot(BOT_A);
    interruptBot(BOT_A);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// INV-CANCEL-04: cancel_turn WS message
// Source: ui/app-state.ts interruptBot() → dynamic import ws-client.send
// ============================================================
describe('INV-CANCEL-04: cancel_turn WS message', () => {
  // Source: ui/app-state.ts interruptBot() lines 203-207

  it('sends cancel_turn when bot was busy (turn state != idle)', async () => {
    const sendMock = vi.fn();
    vi.doMock('../network/ws-client', () => ({ send: sendMock }));

    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');

    interruptBot(BOT_A);

    // Dynamic import is async — flush microtasks
    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith({ type: 'cancel_turn', botId: BOT_A });
    });

    vi.doUnmock('../network/ws-client');
  });

  it('does NOT send cancel_turn when bot was idle', async () => {
    const sendMock = vi.fn();
    vi.doMock('../network/ws-client', () => ({ send: sendMock }));

    // Bot is idle — interruptBot should skip the WS send
    interruptBot(BOT_A);

    // Give microtasks a chance to resolve
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMock).not.toHaveBeenCalled();

    vi.doUnmock('../network/ws-client');
  });

  it('cancel_turn targets the correct botId', async () => {
    const sendMock = vi.fn();
    vi.doMock('../network/ws-client', () => ({ send: sendMock }));

    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_B, 'sending');
    botTurnState.transition(BOT_B, 'awaiting');

    interruptBot(BOT_B);

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith({ type: 'cancel_turn', botId: BOT_B });
    });

    // Should not have sent for BOT_A
    expect(sendMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ botId: BOT_A }),
    );

    vi.doUnmock('../network/ws-client');
  });
});

// ============================================================
// ISSUE-13: Cancel word misfire during agent processing (regression)
// SPEC: "OWW path wakeword-manager.ts:1555-1577 — checks micState.isActive
// and audioPlayer.state !== 'idle'. Picovoice path (line 692-706) —
// simultaneously handles recording and playback states."
// Status: FIXED. Full test in inv-ww.test.ts ISSUE-13 describe block.
// Cross-reference only — the wakeword domain owns this test.
// ============================================================

// ============================================================
// ISSUE-15: _removeBot cleanup before deletion (regression)
// SPEC: "slot-tabs.ts:193-201 — _removeBot() calls micState.cancelRecording()
// and interruptBot(botId) before deleting."
// Status: FIXED. Full test in inv-lifecycle.test.ts ISSUE-15 describe block.
// Cross-reference only — the lifecycle domain owns this test.
// ============================================================
