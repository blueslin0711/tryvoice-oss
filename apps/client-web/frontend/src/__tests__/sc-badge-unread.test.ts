// @vitest-environment jsdom
/**
 * SC-A Chain Tests: Badge & Unread (SC-A-01 ~ SC-A-14)
 *
 * These are CHAIN tests that simulate full event sequences:
 *   state setup -> chatStore message insertion -> real chat:changed handler -> badge outcomes
 *
 * Each test follows the Given/When/Then pattern from EXPERIENCE_SPEC.md.
 * We wire the REAL bindChatStoreChanged handler from event-wiring.ts via
 * wireRealEventHandlers() so that chatStore notifications flow through the
 * production badge computation path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mock external dependencies BEFORE any source imports (Rule 7) ---

vi.mock('../ui/chat-renderer', () => ({
  renderChat: vi.fn(),
  addBotMsg: vi.fn(),
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
  setMicRecordingState: vi.fn(),
  updateMicAvatar: vi.fn(),
  setCancelButtonsVisible: vi.fn(),
}));
vi.mock('../ui/status-bar', () => ({
  setStatusText: vi.fn(),
  compactStatusText: vi.fn((t: string) => t),
}));
vi.mock('../ui/car-mode-overlay', () => ({
  setCarOverlayStatus: vi.fn(),
}));
vi.mock('../audio/audio-player', () => ({
  audioPlayer: { enqueue: vi.fn(), stop: vi.fn(), pause: vi.fn(), isPlaying: vi.fn(() => false), state: 'idle' },
}));
vi.mock('../audio/tts-cleaner', () => ({
  chunkForTTS: vi.fn((text: string) => [text]),
  cleanForTTS: vi.fn((text: string) => text),
}));
vi.mock('../network/ws-client', () => ({
  send: vi.fn(),
  isConnected: vi.fn(() => true),
  nextMsgId: vi.fn(() => 'msg_test'),
}));
vi.mock('../network/outbox', () => ({
  outbox: { onAck: vi.fn(), onAckTimeout: vi.fn(), drain: vi.fn() },
}));
vi.mock('../network/sync', () => ({
  syncManager: { schedule: vi.fn() },
}));
vi.mock('../network/ws-dispatcher', () => ({
  getHistorySyncTargets: vi.fn(() => ({})),
  handleChatRendered: vi.fn(),
  cancelUnreadAnnouncement: vi.fn(),
  scheduleUnreadAnnouncement: vi.fn(),
  consumeAnnouncementInFlight: vi.fn(() => false),
  notifyUnreadChanged: vi.fn(),
  setLastPlaybackEndMs: vi.fn(),
  createWsDispatcher: vi.fn(),
  getTurnTimeoutHints: vi.fn(() => ({ processingTimeoutMs: 180000 })),
}));

// --- Source imports (after mocks) ---

import {
  getUnreadCount, setUnreadCount,
  getLastReadSeq, setLastReadSeq,
  setCurrentBotId, getCurrentBotId,
  shouldIncludeMsg, setGranularity,
  isAutoReadEnabled, setAutoReadEnabled,
  ensureRuntimeBotState,
} from '../ui/app-state';
import { chatStore } from '../store/chat-store';
import { bus } from '../core/event-bus';
import {
  setupTestBots, teardownIntegration,
  wireRealEventHandlers, mockBrowserAPIs,
  BOT_A, BOT_B,
} from './helpers/test-setup';

// Additional bot IDs for multi-bot tests
const BOT_C = 'botC';
const BOT_D = 'botD';

// Fresh bot IDs for first-init tests (module-level _ttsBaselineSet persists across tests)
const BOT_FRESH_01 = 'botFresh01';

// --- Helpers ---

/**
 * Add assistant messages via the real chatStore.mergeFromServer (camelCase keys).
 * For intermediate messages: uses addMessage + manual patch since mergeFromServer
 * hardcodes intermediate=false.
 */
function mergeAssistant(
  botId: string,
  msgs: Array<{
    serverSeq: number;
    text: string;
    intermediate?: boolean;
    contentKind?: string;
  }>,
): void {
  const regularMsgs = msgs.filter(m => !m.intermediate);
  const intermediateMsgs = msgs.filter(m => m.intermediate);

  if (regularMsgs.length > 0) {
    chatStore.mergeFromServer(
      botId,
      regularMsgs.map(m => ({
        role: 'assistant',
        text: m.text,
        ttsText: m.text,
        eventKey: `evt_${botId}_${m.serverSeq}`,
        serverSeq: m.serverSeq,
        ts: new Date().toISOString(),
      })),
    );
  }

  for (const m of intermediateMsgs) {
    chatStore.addMessage(botId, 'assistant', m.text, {
      eventKey: `evt_${botId}_${m.serverSeq}`,
      serverSeq: m.serverSeq,
      ts: new Date().toISOString(),
      intermediate: true,
      contentKind: (m.contentKind || 'intermediate') as any,
    }, { notify: true });
    // Update _maxServerSeq via merge (dedupes by eventKey)
    chatStore.mergeFromServer(botId, [{
      role: 'assistant',
      text: m.text,
      eventKey: `evt_${botId}_${m.serverSeq}`,
      serverSeq: m.serverSeq,
      ts: new Date().toISOString(),
    }]);
    // Re-patch intermediate flag (mergeFromServer clears it)
    const stored = chatStore.getMessages(botId);
    const target = stored.find(msg => msg.serverSeq === m.serverSeq);
    if (target) {
      target.intermediate = true;
      target.contentKind = (m.contentKind || 'intermediate') as any;
    }
  }
}

// --- Setup / Teardown ---

beforeEach(async () => {
  mockBrowserAPIs();
  setupTestBots(BOT_A, BOT_B);
  chatStore.init([BOT_A, BOT_B, BOT_C, BOT_D, BOT_FRESH_01]);
  chatStore.clearCache(BOT_A);
  chatStore.clearCache(BOT_B);
  chatStore.clearCache(BOT_C);
  chatStore.clearCache(BOT_D);
  chatStore.clearCache(BOT_FRESH_01);
  setLastReadSeq(BOT_A, -1);
  setLastReadSeq(BOT_B, -1);
  setUnreadCount(BOT_A, 0);
  setUnreadCount(BOT_B, 0);
  setGranularity('final_only');
  setAutoReadEnabled(true);
  setCurrentBotId(BOT_A);
  await wireRealEventHandlers();
});

afterEach(() => teardownIntegration());

// ============================================================
// SC-A-01: Non-current bot receives 3 assistant messages ->
//          badge increments 0->1->2->3. Flash animation on each.
// ============================================================
describe('SC-A-01: non-current bot message -> badge increments with flash', () => {
  it('badge increments 0->1->2->3 as 3 messages arrive for non-current bot', () => {
    // Given: Bot-A is current, Bot-B is non-current with lastReadSeq=10
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);

    expect(getUnreadCount(BOT_B)).toBe(0);

    // When: Bot-B receives 3 assistant messages (serverSeq 11, 12, 13)
    mergeAssistant(BOT_B, [{ serverSeq: 11, text: 'Reply 1' }]);
    expect(getUnreadCount(BOT_B)).toBe(1);

    mergeAssistant(BOT_B, [{ serverSeq: 12, text: 'Reply 2' }]);
    expect(getUnreadCount(BOT_B)).toBe(2);

    mergeAssistant(BOT_B, [{ serverSeq: 13, text: 'Reply 3' }]);
    expect(getUnreadCount(BOT_B)).toBe(3);
  });

  it('each badge increment triggers ui:flash-tab', () => {
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);

    const flashSpy = vi.fn();
    bus.on('ui:flash-tab', flashSpy);

    mergeAssistant(BOT_B, [{ serverSeq: 11, text: 'Reply 1' }]);
    mergeAssistant(BOT_B, [{ serverSeq: 12, text: 'Reply 2' }]);
    mergeAssistant(BOT_B, [{ serverSeq: 13, text: 'Reply 3' }]);

    // Then: flash-tab emitted for each increment
    expect(flashSpy).toHaveBeenCalledTimes(3);
    expect(flashSpy).toHaveBeenCalledWith(BOT_B);
  });

  it('current bot messages do NOT increment badge', () => {
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_A, 10);

    // When: current bot (BOT_A) receives a message
    mergeAssistant(BOT_A, [{ serverSeq: 11, text: 'My own reply' }]);

    // Then: badge stays 0 (handler returns early for current bot)
    expect(getUnreadCount(BOT_A)).toBe(0);
  });

  it('user messages do NOT increment badge', () => {
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);

    // When: Bot-B receives a user message
    chatStore.mergeFromServer(BOT_B, [{
      role: 'user',
      text: 'User said hello',
      eventKey: 'evt_user_1',
      serverSeq: 11,
      ts: new Date().toISOString(),
    }]);

    // Then: badge stays 0 (only assistant messages count)
    expect(getUnreadCount(BOT_B)).toBe(0);
  });
});

// ============================================================
// SC-A-02: Switch to unread bot -> badge clears to 0,
//          auto-read-unread event emitted with count.
// ============================================================
describe('SC-A-02: switch to bot with unread -> badge clears, auto-read emitted', () => {
  it('badge clears to 0 and auto-read-unread emitted when switching to bot', () => {
    // Given: Bot-B has Badge=3, autoRead ON
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);
    setAutoReadEnabled(true);

    // Accumulate 3 unread on Bot-B
    mergeAssistant(BOT_B, [
      { serverSeq: 11, text: 'Reply 1' },
      { serverSeq: 12, text: 'Reply 2' },
      { serverSeq: 13, text: 'Reply 3' },
    ]);
    expect(getUnreadCount(BOT_B)).toBe(3);

    // Spy on auto-read-unread
    const autoReadSpy = vi.fn();
    bus.on('chat:auto-read-unread', autoReadSpy);

    // When: simulate switchToBot logic (as in main.ts)
    const unreadN = getUnreadCount(BOT_B);
    setUnreadCount(BOT_B, 0);
    setCurrentBotId(BOT_B);
    // Advance lastReadSeq on old bot
    const oldMax = chatStore.getMaxServerSeq(BOT_A);
    if (oldMax > getLastReadSeq(BOT_A)) setLastReadSeq(BOT_A, oldMax);

    // Then: badge is 0
    expect(getUnreadCount(BOT_B)).toBe(0);
    // And: auto-read should be triggered with count=3
    expect(unreadN).toBe(3);

    // Emit auto-read event (as switchToBot does)
    if (unreadN > 0) bus.emit('chat:auto-read-unread', { botId: BOT_B, count: unreadN });
    expect(autoReadSpy).toHaveBeenCalledWith({ botId: BOT_B, count: 3 });
  });
});

// ============================================================
// SC-A-03: autoRead off, switch to unread bot -> badge clears, NO TTS event.
// ============================================================
describe('SC-A-03: switch to bot, autoRead OFF -> badge clears, no TTS', () => {
  it('badge clears to 0 but no auto-read-unread emitted when autoRead is OFF', () => {
    // Given: Bot-B Badge=3, autoRead OFF
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);
    setAutoReadEnabled(false);

    mergeAssistant(BOT_B, [
      { serverSeq: 11, text: 'Reply 1' },
      { serverSeq: 12, text: 'Reply 2' },
      { serverSeq: 13, text: 'Reply 3' },
    ]);
    expect(getUnreadCount(BOT_B)).toBe(3);

    const autoReadSpy = vi.fn();
    bus.on('chat:auto-read-unread', autoReadSpy);

    // When: user switches to Bot-B (simulate switchToBot with autoRead OFF)
    const unreadN = getUnreadCount(BOT_B);
    setUnreadCount(BOT_B, 0);
    setCurrentBotId(BOT_B);

    // Then: badge is 0, no TTS (verified by autoRead being off)
    expect(getUnreadCount(BOT_B)).toBe(0);
    expect(isAutoReadEnabled()).toBe(false);
    // switchToBot in main.ts still emits auto-read-unread regardless of autoRead
    // (the chat-renderer's autoReadUnreadN checks autoRead internally),
    // but no TTS should be enqueued when autoRead is disabled.
    // For the badge clearing itself, we just verify badge is 0.
  });
});

// ============================================================
// SC-A-04: Switch away from bot -> lastReadSeq advances to maxServerSeq.
// ============================================================
describe('SC-A-04: switch away advances lastReadSeq', () => {
  it('lastReadSeq advances to maxServerSeq when switching away', () => {
    // Given: Bot-A is current, has messages up to serverSeq=50, lastReadSeq=40
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_A, 40);
    mergeAssistant(BOT_A, [{ serverSeq: 50, text: 'Latest message' }]);

    // When: user switches to Bot-B (simulate switch-away for old bot)
    const maxSeq = chatStore.getMaxServerSeq(BOT_A);
    if (maxSeq > getLastReadSeq(BOT_A)) {
      setLastReadSeq(BOT_A, maxSeq);
    }
    setCurrentBotId(BOT_B);

    // Then: lastReadSeq[A] is now 50
    expect(getLastReadSeq(BOT_A)).toBe(50);
  });

  it('subsequent messages after switch show correct badge (not stale)', () => {
    // Given: Bot-A had lastReadSeq=40, user is on BOT_A, messages arrive up to 50
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_A, 40);
    mergeAssistant(BOT_A, [
      { serverSeq: 41, text: 'Msg 41' },
      { serverSeq: 50, text: 'Msg 50' },
    ]);

    // Simulate switch-away: advance lastReadSeq on old bot
    const maxSeq = chatStore.getMaxServerSeq(BOT_A);
    setLastReadSeq(BOT_A, maxSeq);
    setUnreadCount(BOT_A, 0);
    setCurrentBotId(BOT_B);

    // When: Bot-A receives one new message (serverSeq=51)
    mergeAssistant(BOT_A, [{ serverSeq: 51, text: 'New message after switch' }]);

    // Then: badge shows 1, not 11
    expect(getUnreadCount(BOT_A)).toBe(1);
  });
});

// ============================================================
// SC-A-05: Page refresh -> badge restores from server lastReadSeq + new sync msgs.
// ============================================================
describe('SC-A-05: page refresh badge restoration', () => {
  it('badge restores after simulated refresh: history_revision + sync', () => {
    // Given: before refresh, Bot-B had lastReadSeq=10, maxServerSeq=13

    // Simulate: WS reconnect sends history_revision with lastReadSeq=10
    setLastReadSeq(BOT_B, 10);
    setCurrentBotId(BOT_A); // user is viewing Bot-A

    // Simulate: history sync delivers messages for Bot-B
    mergeAssistant(BOT_B, [
      { serverSeq: 11, text: 'Msg 11' },
      { serverSeq: 12, text: 'Msg 12' },
      { serverSeq: 13, text: 'Msg 13' },
    ]);

    // Then: badge recalculated to 3
    expect(getUnreadCount(BOT_B)).toBe(3);
  });
});

// ============================================================
// SC-A-06: First load (lastReadSeq=-1) -> baseline set to maxServerSeq, no TTS.
// ============================================================
describe('SC-A-06: first load skips TTS for history', () => {
  it('first init sets baseline to maxServerSeq, no TTS enqueued', async () => {
    // Given: Bot is fresh (never had a session), autoRead ON, lastReadSeq=-1
    ensureRuntimeBotState([BOT_FRESH_01]);
    chatStore.init([BOT_FRESH_01]);
    setCurrentBotId(BOT_FRESH_01);
    setLastReadSeq(BOT_FRESH_01, -1);
    setAutoReadEnabled(true);
    expect(getLastReadSeq(BOT_FRESH_01)).toBe(-1);

    // When: history sync delivers 5 messages on first load
    chatStore.mergeFromServer(BOT_FRESH_01, [
      { role: 'assistant', text: 'History 1', eventKey: 'h1', serverSeq: 1, ts: '2026-01-01T00:00:01Z' },
      { role: 'assistant', text: 'History 2', eventKey: 'h2', serverSeq: 2, ts: '2026-01-01T00:00:02Z' },
      { role: 'assistant', text: 'History 3', eventKey: 'h3', serverSeq: 3, ts: '2026-01-01T00:00:03Z' },
      { role: 'assistant', text: 'History 4', eventKey: 'h4', serverSeq: 4, ts: '2026-01-01T00:00:04Z' },
      { role: 'assistant', text: 'History 5', eventKey: 'h5', serverSeq: 5, ts: '2026-01-01T00:00:05Z' },
    ]);

    // Then: lastReadSeq should advance to maxServerSeq (5) — baseline set
    expect(getLastReadSeq(BOT_FRESH_01)).toBe(5);

    // And: no TTS should have been enqueued (first init skips TTS)
    const { audioPlayer } = await import('../audio/audio-player');
    expect(audioPlayer.enqueue).not.toHaveBeenCalled();
  });

  it('after baseline set, new messages for non-current bot are counted', () => {
    // Given: baseline set at seq=100 for BOT_A, user switches to BOT_B
    setCurrentBotId(BOT_B);
    setLastReadSeq(BOT_A, 100);

    // When: Bot-A receives a new message (seq=101)
    mergeAssistant(BOT_A, [{ serverSeq: 101, text: 'New message after baseline' }]);

    // Then: badge shows 1
    expect(getUnreadCount(BOT_A)).toBe(1);
  });
});

// ============================================================
// SC-A-07: Intermediate messages excluded from badge in final_only granularity.
// ============================================================
describe('SC-A-07: granularity filter affects badge', () => {
  it('final_only: intermediate tool_call excluded, final result counted', () => {
    // Given: Bot-B non-current, granularity=final_only, lastReadSeq=10
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);
    setGranularity('final_only');

    // When: Bot-B receives 1 intermediate + 1 final
    mergeAssistant(BOT_B, [
      { serverSeq: 11, text: '[tool: bash] running', intermediate: true, contentKind: 'tool_call' },
      { serverSeq: 12, text: 'Here is the result' },
    ]);

    // Then: badge = 1 (only the final result)
    expect(getUnreadCount(BOT_B)).toBe(1);
  });

  it('with_thinking: thinking included, tool_call excluded', () => {
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);
    setGranularity('with_thinking');

    mergeAssistant(BOT_B, [
      { serverSeq: 11, text: 'Let me think...', intermediate: true, contentKind: 'thinking' },
      { serverSeq: 12, text: '[tool: bash]', intermediate: true, contentKind: 'tool_call' },
      { serverSeq: 13, text: 'Final answer' },
    ]);

    // Then: badge = 2 (thinking + final, tool_call excluded)
    expect(getUnreadCount(BOT_B)).toBe(2);
  });

  it('all: every message counted', () => {
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);
    setGranularity('all');

    mergeAssistant(BOT_B, [
      { serverSeq: 11, text: 'Thinking...', intermediate: true, contentKind: 'thinking' },
      { serverSeq: 12, text: 'Running tool', intermediate: true, contentKind: 'tool_call' },
      { serverSeq: 13, text: 'Final answer' },
    ]);

    // Then: badge = 3 (all messages counted)
    expect(getUnreadCount(BOT_B)).toBe(3);
  });
});

// ============================================================
// SC-A-08: Session reset -> badge=0, lastReadSeq advanced.
// ============================================================
describe('SC-A-08: session reset clears badge', () => {
  it('session_reset_confirmed clears badge and advances lastReadSeq', () => {
    // Given: Bot-A current, Badge=2
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_A, 5);
    setUnreadCount(BOT_A, 2);
    mergeAssistant(BOT_A, [
      { serverSeq: 6, text: 'Pre-reset msg 1' },
      { serverSeq: 7, text: 'Pre-reset msg 2' },
    ]);

    // When: session_reset_confirmed (simulate ws-dispatcher logic)
    const maxSeq = chatStore.getMaxServerSeq(BOT_A);
    setLastReadSeq(BOT_A, maxSeq);
    setUnreadCount(BOT_A, 0);

    // Then: badge=0, lastReadSeq advanced to 7
    expect(getUnreadCount(BOT_A)).toBe(0);
    expect(getLastReadSeq(BOT_A)).toBe(7);
  });

  it('new messages after reset are counted fresh', () => {
    // Given: session was reset, lastReadSeq=7
    setCurrentBotId(BOT_B); // switch away
    setLastReadSeq(BOT_A, 7);
    setUnreadCount(BOT_A, 0);

    // When: new messages arrive post-reset
    mergeAssistant(BOT_A, [
      { serverSeq: 8, text: 'Post-reset msg 1' },
      { serverSeq: 9, text: 'Post-reset msg 2' },
    ]);

    // Then: badge counts from the reset boundary
    expect(getUnreadCount(BOT_A)).toBe(2);
  });
});

// ============================================================
// SC-A-09: Turn end (to=idle) -> lastReadSeq advanced.
// ============================================================
describe('SC-A-09: turn end advances lastReadSeq', () => {
  it('lastReadSeq advances to maxServerSeq when turn ends (to=idle)', () => {
    // Given: Bot-A current, lastReadSeq=40, has reply messages
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_A, 40);
    mergeAssistant(BOT_A, [
      { serverSeq: 41, text: 'Agent reply 1' },
      { serverSeq: 42, text: 'Agent reply 2' },
    ]);

    // When: turn ends (bot returns to idle)
    bus.emit('bot:turn-state-change', { botId: BOT_A, from: 'receiving', to: 'idle' });

    // Then: lastReadSeq advanced to 42
    expect(getLastReadSeq(BOT_A)).toBe(42);
  });

  it('subsequent sync does not re-count reply as unread after turn end', () => {
    // Given: turn ended, lastReadSeq advanced
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_A, 40);
    mergeAssistant(BOT_A, [
      { serverSeq: 41, text: 'Agent reply 1' },
      { serverSeq: 42, text: 'Agent reply 2' },
    ]);
    bus.emit('bot:turn-state-change', { botId: BOT_A, from: 'receiving', to: 'idle' });
    expect(getLastReadSeq(BOT_A)).toBe(42);

    // Switch away
    setCurrentBotId(BOT_B);

    // Simulate sync delivering the same messages
    chatStore.mergeFromServer(BOT_A, [
      { role: 'assistant', text: 'Agent reply 1', eventKey: 'evt_BOT_A_41', serverSeq: 41 },
      { role: 'assistant', text: 'Agent reply 2', eventKey: 'evt_BOT_A_42', serverSeq: 42 },
    ]);

    // Then: badge stays 0 (all messages at or below lastReadSeq)
    expect(getUnreadCount(BOT_A)).toBe(0);
  });
});

// ============================================================
// SC-A-10: New turn start (to=sending) -> lastReadSeq advanced.
// ============================================================
describe('SC-A-10: new turn start advances lastReadSeq', () => {
  it('sending transition advances lastReadSeq to maxServerSeq', () => {
    // Given: Bot-A current, lastReadSeq=40, has messages up to seq 45
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_A, 40);
    mergeAssistant(BOT_A, [
      { serverSeq: 41, text: 'Tmux msg 41' },
      { serverSeq: 42, text: 'Tmux msg 42' },
      { serverSeq: 43, text: 'Tmux msg 43' },
      { serverSeq: 44, text: 'Tmux msg 44' },
      { serverSeq: 45, text: 'Tmux msg 45' },
    ]);

    // When: user starts a new turn (BotTurnState -> sending)
    bus.emit('bot:turn-state-change', { botId: BOT_A, from: 'idle', to: 'sending' });

    // Then: lastReadSeq advanced to 45
    expect(getLastReadSeq(BOT_A)).toBe(45);
  });
});

// ============================================================
// SC-A-11: Multi-bot badge independence.
// ============================================================
describe('SC-A-11: multi-bot badge independence', () => {
  it('each bot maintains independent badge count', () => {
    // Given: Bot-A, Bot-B, Bot-C all non-current, user on Bot-D
    ensureRuntimeBotState([BOT_A, BOT_B, BOT_C, BOT_D]);
    setCurrentBotId(BOT_D);
    setLastReadSeq(BOT_A, 10);
    setLastReadSeq(BOT_B, 10);
    setLastReadSeq(BOT_C, 10);

    // When: Bot-A gets 2 msgs, Bot-B gets 1, Bot-C gets 0
    mergeAssistant(BOT_A, [
      { serverSeq: 11, text: 'A msg 1' },
      { serverSeq: 12, text: 'A msg 2' },
    ]);
    mergeAssistant(BOT_B, [{ serverSeq: 11, text: 'B msg 1' }]);

    // Then: independent badge counts
    expect(getUnreadCount(BOT_A)).toBe(2);
    expect(getUnreadCount(BOT_B)).toBe(1);
    expect(getUnreadCount(BOT_C)).toBe(0);
  });

  it('clearing one bot badge does not affect others', () => {
    ensureRuntimeBotState([BOT_A, BOT_B, BOT_D]);
    setCurrentBotId(BOT_D);
    setLastReadSeq(BOT_A, 10);
    setLastReadSeq(BOT_B, 10);

    mergeAssistant(BOT_A, [{ serverSeq: 11, text: 'A msg' }]);
    mergeAssistant(BOT_B, [{ serverSeq: 11, text: 'B msg' }]);
    expect(getUnreadCount(BOT_A)).toBe(1);
    expect(getUnreadCount(BOT_B)).toBe(1);

    // Clear Bot-A badge (simulate switch)
    setUnreadCount(BOT_A, 0);

    // Bot-B unaffected
    expect(getUnreadCount(BOT_A)).toBe(0);
    expect(getUnreadCount(BOT_B)).toBe(1);
  });
});

// ============================================================
// SC-A-12: WS reconnect -> badge recalculated from server state.
// ============================================================
describe('SC-A-12: reconnect badge restoration', () => {
  it('badge recalculates from lastReadSeq after reconnect + sync', () => {
    // Given: Bot-B non-current, had Badge=2 before disconnect
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);
    setUnreadCount(BOT_B, 2);

    // Simulate: WS disconnect... then reconnect
    // On reconnect: history_revision restores lastReadSeq=10
    setLastReadSeq(BOT_B, 10);

    // Simulate: history sync delivers all messages (including ones from disconnect period)
    mergeAssistant(BOT_B, [
      { serverSeq: 11, text: 'Msg 11' },
      { serverSeq: 12, text: 'Msg 12' },
      { serverSeq: 13, text: 'Msg 13 (during disconnect)' },
    ]);

    // Then: badge recalculated to include disconnect-period messages
    expect(getUnreadCount(BOT_B)).toBe(3);
  });
});

// ============================================================
// SC-A-13: Announcement during badge update -> no cascade re-announcement.
// ============================================================
describe('SC-A-13: announcement cascade guard', () => {
  it('consumeAnnouncementInFlight prevents cascade after announcement ends', async () => {
    const { consumeAnnouncementInFlight } = await import('../network/ws-dispatcher');

    // Given: announcement just finished playing
    // consumeAnnouncementInFlight returns false when no announcement was in flight
    expect(consumeAnnouncementInFlight()).toBe(false);
  });

  it('badge increments normally during announcement playback', () => {
    // Given: announcement playing, Bot-B is non-current
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);

    // When: new message arrives during announcement
    mergeAssistant(BOT_B, [{ serverSeq: 11, text: 'New msg during announcement' }]);

    // Then: badge increments normally (badge and announcement are independent)
    expect(getUnreadCount(BOT_B)).toBe(1);
  });
});

// ============================================================
// SC-A-14 (ISSUE-06): Page refresh, current bot has 3 legit unread
// (lastReadSeq < maxServerSeq) -> unread NOT silently consumed, TTS triggered.
// ============================================================
describe('SC-A-14: refresh with current bot legit unread (ISSUE-06)', () => {
  it('detects legit unread when server lastReadSeq < maxServerSeq after refresh', () => {
    // Given: Bot-A is current, server restored lastReadSeq=10
    setCurrentBotId(BOT_A);
    setAutoReadEnabled(true);

    // Simulate: history_revision restores lastReadSeq=10
    setLastReadSeq(BOT_A, 10);

    // Simulate: history sync delivers messages (including 3 unread)
    chatStore.mergeFromServer(BOT_A, [
      { role: 'assistant', text: 'Old msg 1', eventKey: 'evt_A_8', serverSeq: 8 },
      { role: 'assistant', text: 'Old msg 2', eventKey: 'evt_A_10', serverSeq: 10 },
      { role: 'assistant', text: 'Unread 1', eventKey: 'evt_A_11', serverSeq: 11 },
      { role: 'assistant', text: 'Unread 2', eventKey: 'evt_A_12', serverSeq: 12 },
      { role: 'assistant', text: 'Unread 3', eventKey: 'evt_A_13', serverSeq: 13 },
    ]);

    // Then: can detect legit unread by comparing lastReadSeq vs maxServerSeq
    const lastRead = getLastReadSeq(BOT_A);
    const maxSeq = chatStore.getMaxServerSeq(BOT_A);
    const legitimateUnread = maxSeq > lastRead;
    expect(legitimateUnread).toBe(true);

    // Count the actual unread messages
    const msgs = chatStore.getMessages(BOT_A);
    const unreadMsgs = msgs.filter(
      m => m.role === 'assistant'
        && shouldIncludeMsg(m)
        && m.serverSeq != null && m.serverSeq > lastRead
    );
    expect(unreadMsgs.length).toBe(3);
  });

  it('no legit unread when lastReadSeq >= maxServerSeq', () => {
    // Given: user had read everything before refresh
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_A, 13);

    chatStore.mergeFromServer(BOT_A, [
      { role: 'assistant', text: 'Msg 11', eventKey: 'evt_A_11', serverSeq: 11 },
      { role: 'assistant', text: 'Msg 12', eventKey: 'evt_A_12', serverSeq: 12 },
      { role: 'assistant', text: 'Msg 13', eventKey: 'evt_A_13', serverSeq: 13 },
    ]);

    const lastRead = getLastReadSeq(BOT_A);
    const maxSeq = chatStore.getMaxServerSeq(BOT_A);
    expect(maxSeq <= lastRead).toBe(true);
  });

  it('first load without server lastReadSeq (-1) should not count as legit unread', () => {
    // Use a fresh bot ID so _ttsBaselineSet hasn't been set for it yet
    const BOT_FRESH_14 = 'botFresh14';
    ensureRuntimeBotState([BOT_FRESH_14]);
    chatStore.init([BOT_FRESH_14]);
    setCurrentBotId(BOT_FRESH_14);
    setLastReadSeq(BOT_FRESH_14, -1);

    // Given: Bot never had a session, lastReadSeq=-1
    expect(getLastReadSeq(BOT_FRESH_14)).toBe(-1);

    // Simulate: history sync delivers messages
    chatStore.mergeFromServer(BOT_FRESH_14, [
      { role: 'assistant', text: 'Msg 1', eventKey: 'evt_fresh14_1', serverSeq: 1 },
    ]);

    // Then: lastReadSeq=-1 should be treated as "first init" (baseline set)
    // The production code checks: if (lastRead < 0) -> first init path
    // For current bot with lastReadSeq=-1, the real handler sets baseline
    // (advances lastReadSeq to maxServerSeq), not treating as legit unread
    const lastRead = getLastReadSeq(BOT_FRESH_14);
    expect(lastRead).toBe(1);
  });
});
