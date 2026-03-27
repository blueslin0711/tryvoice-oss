// @vitest-environment jsdom
/**
 * INV-BADGE-01~05: Badge mechanism invariant tests.
 *
 * Assertions are derived SOLELY from EXPERIENCE_SPEC definitions.
 * All tests exercise real code paths via wireRealEventHandlers().
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
  audioPlayer: { enqueue: vi.fn(), stop: vi.fn(), pause: vi.fn(), isPlaying: vi.fn(() => false) },
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
  setGranularity, setAutoReadEnabled,
  ensureRuntimeBotState,
} from '../ui/app-state';
import { chatStore } from '../store/chat-store';
import { bus } from '../core/event-bus';
import * as wsSend from '../network/ws-client';
import {
  setupTestBots, teardownIntegration,
  wireRealEventHandlers, mockBrowserAPIs,
  BOT_A, BOT_B,
} from './helpers/test-setup';

// Fresh bot IDs for first-init tests (module-level _ttsBaselineSet persists across tests)
const BOT_FRESH_01 = 'botFresh01';
const BOT_FRESH_02 = 'botFresh02';

// --- Helpers ---

/**
 * Merge assistant messages via the real chatStore.mergeFromServer (camelCase keys).
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
  chatStore.init([BOT_A, BOT_B]);
  chatStore.clearCache(BOT_A);
  chatStore.clearCache(BOT_B);
  setLastReadSeq(BOT_A, -1);
  setLastReadSeq(BOT_B, -1);
  setUnreadCount(BOT_A, 0);
  setUnreadCount(BOT_B, 0);
  setGranularity('final_only');
  setAutoReadEnabled(false);
  setCurrentBotId(BOT_A);
  await wireRealEventHandlers();
});

afterEach(() => teardownIntegration());

// ============================================================
// INV-BADGE-01: Server-Authoritative LastReadSeq
// Rule: lastReadSeq persists on server (SQLite), restored via
// history_revision WS on reconnect. Server value only advances,
// never retreats.
// ============================================================
describe('INV-BADGE-01: Server-authoritative lastReadSeq — only advances, never retreats', () => {
  it('messages with serverSeq > lastReadSeq are counted as unread', () => {
    // Spec: "unread counting" uses serverSeq > lastReadSeq comparison.
    // Regression: if comparison operator changes (>= instead of >), counts inflate.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);

    mergeAssistant(BOT_B, [
      { serverSeq: 11, text: 'Reply 1' },
      { serverSeq: 12, text: 'Reply 2' },
      { serverSeq: 13, text: 'Reply 3' },
    ]);

    expect(getUnreadCount(BOT_B)).toBe(3);
  });

  it('messages with serverSeq <= lastReadSeq are NOT counted as unread', () => {
    // Spec: only serverSeq > lastReadSeq counts. Messages at or below the watermark are read.
    // Regression: if the guard is removed, old history replays inflate badge.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);

    mergeAssistant(BOT_B, [
      { serverSeq: 8, text: 'Old msg 1' },
      { serverSeq: 9, text: 'Old msg 2' },
      { serverSeq: 10, text: 'Exactly at watermark' },
    ]);

    expect(getUnreadCount(BOT_B)).toBe(0);
  });

  it('lastReadSeq never retreats when a stale value is encountered', () => {
    // Spec: "Server value only advances, never retreats."
    // Regression: if _advanceLastReadSeq drops the > guard, stale WS payloads regress the pointer.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_A, 10);

    // Advance to 15 via turn boundary
    mergeAssistant(BOT_A, [{ serverSeq: 15, text: 'Msg 15' }]);
    bus.emit('bot:turn-state-change', { botId: BOT_A, from: 'idle', to: 'sending' });
    expect(getLastReadSeq(BOT_A)).toBe(15);

    // Merge a stale message (serverSeq=5) — maxServerSeq stays 15
    chatStore.mergeFromServer(BOT_A, [{
      role: 'assistant', text: 'Stale', eventKey: 'evt_stale_5', serverSeq: 5,
    }]);
    // Trigger another advance attempt
    bus.emit('bot:turn-state-change', { botId: BOT_A, from: 'idle', to: 'sending' });

    // Must NOT retreat below 15
    expect(getLastReadSeq(BOT_A)).toBe(15);
  });

  it('advancing lastReadSeq sends mark_read to server for persistence', () => {
    // Spec: "lastReadSeq persists on server" — advance must send mark_read WS message.
    // Regression: if WS send is removed, server falls behind and reconnect shows stale badges.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_A, 5);
    mergeAssistant(BOT_A, [{ serverSeq: 10, text: 'Msg 10' }]);

    bus.emit('bot:turn-state-change', { botId: BOT_A, from: 'idle', to: 'sending' });

    expect(wsSend.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mark_read', botId: BOT_A, seq: 10 }),
    );
  });
});

// ============================================================
// INV-BADGE-02: Unified Granularity Filter
// Rule: Same shouldIncludeMsg() filter for display, TTS, and
// unread counting. Tool placeholders ([tool:...]), intermediate
// steps, system messages must not count as unread in final_only mode.
// ============================================================
describe('INV-BADGE-02: Unified granularity filter — shouldIncludeMsg() drives badge counting', () => {
  it('intermediate tool_call messages do NOT count in final_only mode', () => {
    // Spec: "Tool placeholders ([tool:...]), intermediate steps ... must not count as unread in final_only mode."
    // Regression: if shouldIncludeMsg stops filtering tool_call, users see inflated badges.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);
    setGranularity('final_only');

    mergeAssistant(BOT_B, [
      { serverSeq: 11, text: '[tool: bash] running', intermediate: true, contentKind: 'tool_call' },
      { serverSeq: 12, text: 'Final answer' },
    ]);

    expect(getUnreadCount(BOT_B)).toBe(1);
  });

  it('tool placeholder text [tool:...] without intermediate flag does NOT count in final_only', () => {
    // Spec: "Tool placeholders ([tool:...])" explicitly excluded in final_only.
    // Regression: mergeFromServer strips intermediate flag; if text-based fallback is removed,
    // tool placeholders leak into badge count.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);
    setGranularity('final_only');

    // Non-intermediate message whose text starts with [tool:
    chatStore.mergeFromServer(BOT_B, [{
      role: 'assistant',
      text: '[tool: search] Looking up data...',
      eventKey: 'evt_tool_11',
      serverSeq: 11,
      ts: new Date().toISOString(),
    }]);
    // Plus a normal final message
    chatStore.mergeFromServer(BOT_B, [{
      role: 'assistant',
      text: 'Here are the results',
      eventKey: 'evt_final_12',
      serverSeq: 12,
      ts: new Date().toISOString(),
    }]);

    // Only the final message counts
    expect(getUnreadCount(BOT_B)).toBe(1);
  });

  it('intermediate thinking messages ARE counted in with_thinking mode', () => {
    // Spec: shouldIncludeMsg uses unified granularity. In with_thinking mode,
    // thinking contentKind is included.
    // Regression: if with_thinking excludes thinking, badge underreports for power users.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);
    setGranularity('with_thinking');

    mergeAssistant(BOT_B, [
      { serverSeq: 11, text: 'Let me think...', intermediate: true, contentKind: 'thinking' },
      { serverSeq: 12, text: 'Final answer' },
    ]);

    expect(getUnreadCount(BOT_B)).toBe(2);
  });

  it('intermediate thinking messages are NOT counted in with_steps mode', () => {
    // Spec: with_steps includes only 'intermediate' contentKind, not thinking.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);
    setGranularity('with_steps');

    mergeAssistant(BOT_B, [
      { serverSeq: 11, text: 'Let me think...', intermediate: true, contentKind: 'thinking' },
      { serverSeq: 12, text: 'Final answer' },
    ]);

    // Thinking is not included in with_steps — only final answer counts
    expect(getUnreadCount(BOT_B)).toBe(1);
  });

  it('intermediate non-thinking messages are NOT counted in with_steps mode', () => {
    // Spec: with_steps includes intermediate contentKind but not tool_call.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);
    setGranularity('with_steps');

    mergeAssistant(BOT_B, [
      { serverSeq: 11, text: 'Running bash...', intermediate: true, contentKind: 'tool_call' },
      { serverSeq: 12, text: 'Final answer' },
    ]);

    // Only the final answer should count (tool_call excluded even in with_steps)
    expect(getUnreadCount(BOT_B)).toBe(1);
  });

  it('sourceChannel=terminal messages are excluded from badge count', () => {
    // Spec INV-BADGE-02: "Badge counting and TTS paths additionally exclude
    // sourceChannel === 'terminal' messages ... terminal-sourced messages display
    // in chat but do NOT increment badge or trigger TTS."
    // Regression: if terminal filter is removed, tmux/terminal activity inflates badge.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);
    setGranularity('final_only');

    // Terminal-sourced message
    chatStore.mergeFromServer(BOT_B, [{
      role: 'assistant',
      text: 'Terminal output line',
      eventKey: 'evt_terminal_11',
      serverSeq: 11,
      ts: new Date().toISOString(),
      sourceChannel: 'terminal',
    }]);
    // Normal web-sourced message
    chatStore.mergeFromServer(BOT_B, [{
      role: 'assistant',
      text: 'Normal reply',
      eventKey: 'evt_web_12',
      serverSeq: 12,
      ts: new Date().toISOString(),
      sourceChannel: 'web',
    }]);

    // Only the web-sourced message should count
    expect(getUnreadCount(BOT_B)).toBe(1);
  });
});

// ============================================================
// INV-BADGE-03: Non-Current Bot Badge Increments Per Message
// Rule: For non-current bots, each assistant message with
// serverSeq > lastReadSeq passing shouldIncludeMsg() increments
// badge by exactly 1.
// ============================================================
describe('INV-BADGE-03: Non-current bot badge increments per qualifying message', () => {
  it('sequential merges increment badge 1 -> 2 -> 3', () => {
    // Spec: "each assistant message ... increments badge by exactly 1."
    // Regression: if handler stops re-counting on each chat:changed, badges freeze.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);

    mergeAssistant(BOT_B, [{ serverSeq: 11, text: 'Reply 1' }]);
    expect(getUnreadCount(BOT_B)).toBe(1);

    mergeAssistant(BOT_B, [{ serverSeq: 12, text: 'Reply 2' }]);
    expect(getUnreadCount(BOT_B)).toBe(2);

    mergeAssistant(BOT_B, [{ serverSeq: 13, text: 'Reply 3' }]);
    expect(getUnreadCount(BOT_B)).toBe(3);
  });

  it('current bot receives messages but badge stays 0', () => {
    // Spec: "For non-current bots" — implies current bot does NOT accumulate badge.
    // Regression: if the current-bot guard is removed, badge appears on the active chat.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_A, 10);

    mergeAssistant(BOT_A, [
      { serverSeq: 11, text: 'Reply 1' },
      { serverSeq: 12, text: 'Reply 2' },
      { serverSeq: 13, text: 'Reply 3' },
    ]);

    expect(getUnreadCount(BOT_A)).toBe(0);
  });

  it('only assistant messages count — user messages do not increment badge', () => {
    // Spec: "each assistant message" — user messages are not counted.
    // Regression: if role filter is removed, user's own messages inflate badge.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);

    // Merge a user message followed by an assistant message
    chatStore.mergeFromServer(BOT_B, [
      {
        role: 'user',
        text: 'My question',
        eventKey: 'evt_user_11',
        serverSeq: 11,
        ts: new Date().toISOString(),
      },
    ]);
    mergeAssistant(BOT_B, [{ serverSeq: 12, text: 'Bot reply' }]);

    // Only the assistant message counts
    expect(getUnreadCount(BOT_B)).toBe(1);
  });

  it('batch merge of multiple messages counts all qualifying ones', () => {
    // Spec: "each assistant message with serverSeq > lastReadSeq passing shouldIncludeMsg()"
    // Regression: if only last message in batch is counted, badge underreports.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 5);

    mergeAssistant(BOT_B, [
      { serverSeq: 6, text: 'Reply A' },
      { serverSeq: 7, text: 'Reply B' },
      { serverSeq: 8, text: 'Reply C' },
      { serverSeq: 9, text: 'Reply D' },
      { serverSeq: 10, text: 'Reply E' },
    ]);

    expect(getUnreadCount(BOT_B)).toBe(5);
  });

  it('sourceChannel=terminal messages do NOT increment badge for non-current bot', () => {
    // Spec INV-BADGE-03: "Badge counting additionally excludes sourceChannel === 'terminal'
    // messages (terminal-sourced messages do not count as unread)."
    // Regression: if terminal filter is missing, background terminal activity inflates badge.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 10);

    // 3 terminal messages + 1 normal message
    chatStore.mergeFromServer(BOT_B, [
      { role: 'assistant', text: 'term 1', eventKey: 'evt_t1', serverSeq: 11, sourceChannel: 'terminal' },
      { role: 'assistant', text: 'term 2', eventKey: 'evt_t2', serverSeq: 12, sourceChannel: 'terminal' },
      { role: 'assistant', text: 'term 3', eventKey: 'evt_t3', serverSeq: 13, sourceChannel: 'terminal' },
      { role: 'assistant', text: 'normal', eventKey: 'evt_n1', serverSeq: 14, sourceChannel: 'web' },
    ]);

    // Only the web-sourced message should count
    expect(getUnreadCount(BOT_B)).toBe(1);
  });
});

// ============================================================
// INV-BADGE-04: First Load Doesn't Re-Read History
// Rule: First load distinguishes:
//   (a) no server lastReadSeq (< 0) → init baseline to maxServerSeq, skip TTS
//   (b) server provides lastReadSeq (≥ 0) → handle legitimate unread
// ============================================================
describe('INV-BADGE-04: First load — no server lastReadSeq initializes baseline, skips TTS', () => {
  it('lastReadSeq=-1 sets baseline to maxServerSeq and skips TTS', async () => {
    // Spec: "(a) no server lastReadSeq (< 0) → init baseline to maxServerSeq, skip TTS"
    // Regression: if first-init check is removed, entire history is read aloud on first load.
    ensureRuntimeBotState([BOT_FRESH_01]);
    chatStore.init([BOT_FRESH_01]);
    setCurrentBotId(BOT_FRESH_01);
    setLastReadSeq(BOT_FRESH_01, -1);
    setAutoReadEnabled(true);
    expect(getLastReadSeq(BOT_FRESH_01)).toBe(-1);

    // Seed 5 history messages (simulating first load from server)
    chatStore.mergeFromServer(BOT_FRESH_01, [
      { role: 'assistant', text: 'History 1', eventKey: 'h1', serverSeq: 1, ts: '2026-01-01T00:00:01Z' },
      { role: 'assistant', text: 'History 2', eventKey: 'h2', serverSeq: 2, ts: '2026-01-01T00:00:02Z' },
      { role: 'assistant', text: 'History 3', eventKey: 'h3', serverSeq: 3, ts: '2026-01-01T00:00:03Z' },
      { role: 'assistant', text: 'History 4', eventKey: 'h4', serverSeq: 4, ts: '2026-01-01T00:00:04Z' },
      { role: 'assistant', text: 'History 5', eventKey: 'h5', serverSeq: 5, ts: '2026-01-01T00:00:05Z' },
    ]);

    // After first init, lastReadSeq should advance to maxServerSeq (5)
    expect(getLastReadSeq(BOT_FRESH_01)).toBe(5);

    // No TTS should have been enqueued (first init skips TTS)
    const { audioPlayer } = await import('../audio/audio-player');
    expect(audioPlayer.enqueue).not.toHaveBeenCalled();

    // mark_read should be sent to persist the baseline on server
    expect(wsSend.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mark_read', botId: BOT_FRESH_01, seq: 5 }),
    );
  });

  it('lastReadSeq >= 0 allows legitimate unread to accumulate (non-current bot)', () => {
    // Spec: "(b) server provides lastReadSeq (≥ 0) → handle legitimate unread."
    // Regression: if all bots get baseline treatment, real unreads after reconnect are lost.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 3); // Server provided lastReadSeq=3

    mergeAssistant(BOT_B, [
      { serverSeq: 1, text: 'Old msg' },
      { serverSeq: 2, text: 'Old msg' },
      { serverSeq: 3, text: 'Already read' },
      { serverSeq: 4, text: 'New unread 1' },
      { serverSeq: 5, text: 'New unread 2' },
    ]);

    // Only messages with serverSeq > 3 should be unread
    expect(getUnreadCount(BOT_B)).toBe(2);
  });

  it('lastReadSeq=0 is treated as server-provided (not first init)', () => {
    // Spec: "no server lastReadSeq (< 0)" triggers baseline. 0 is a valid server value.
    // Regression: if check uses <= 0 instead of < 0, seq=0 bots lose unread on reconnect.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 0); // Server says lastReadSeq=0

    mergeAssistant(BOT_B, [
      { serverSeq: 1, text: 'Unread msg 1' },
      { serverSeq: 2, text: 'Unread msg 2' },
    ]);

    // Both messages should be unread since serverSeq > 0
    expect(getUnreadCount(BOT_B)).toBe(2);
  });
});

// ============================================================
// INV-BADGE-05: Turn Boundary Advances LastReadSeq
// Rule: lastReadSeq advances to maxServerSeq at:
//   (1) new turn start (to=sending)
//   (2) turn end (to=idle)
//   (3) switch away from bot
// ============================================================
describe('INV-BADGE-05: Turn boundaries advance lastReadSeq to maxServerSeq', () => {
  it('to=sending advances lastReadSeq to maxServerSeq', () => {
    // Spec: "(1) new turn start (to=sending)" advances lastReadSeq.
    // Regression: if sending-path advance is removed, messages arriving before
    // the turn get retroactively announced by TTS.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_A, 5);
    mergeAssistant(BOT_A, [{ serverSeq: 10, text: 'Background msg' }]);

    bus.emit('bot:turn-state-change', { botId: BOT_A, from: 'idle', to: 'sending' });

    expect(getLastReadSeq(BOT_A)).toBe(10);
    expect(wsSend.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mark_read', botId: BOT_A, seq: 10 }),
    );
  });

  it('to=idle advances lastReadSeq to maxServerSeq', () => {
    // Spec: "(2) turn end (to=idle)" advances lastReadSeq.
    // Regression: if idle-path advance is removed, cancelled messages are re-read on next sync.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_A, 5);
    mergeAssistant(BOT_A, [
      { serverSeq: 6, text: 'Reply during turn' },
      { serverSeq: 7, text: 'Another reply' },
    ]);

    bus.emit('bot:turn-state-change', { botId: BOT_A, from: 'receiving', to: 'idle' });

    expect(getLastReadSeq(BOT_A)).toBe(7);
  });

  it('to=sending on non-current bot does NOT advance lastReadSeq', () => {
    // Spec: advance happens for current bot context. Non-current bot turn changes
    // should not change that bot's lastReadSeq (it advances on switch-away or explicit read).
    // Regression: if bot identity check is missing, background bot states leak into each other.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 5);
    mergeAssistant(BOT_B, [{ serverSeq: 10, text: 'Background msg' }]);

    const seqBefore = getLastReadSeq(BOT_B);
    bus.emit('bot:turn-state-change', { botId: BOT_B, from: 'idle', to: 'sending' });
    const seqAfter = getLastReadSeq(BOT_B);

    // Non-current bot: lastReadSeq should NOT advance on turn state change
    // (it only advances via switch-away or explicit user action)
    expect(seqAfter).toBe(seqBefore);
  });

  it('multiple sequential turn boundaries accumulate advancement', () => {
    // Spec: each boundary event advances to the current maxServerSeq at that point.
    // Regression: if advance is one-shot (only works once), subsequent turns miss updates.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_A, 0);

    // First turn: messages arrive, turn starts
    mergeAssistant(BOT_A, [{ serverSeq: 5, text: 'First batch' }]);
    bus.emit('bot:turn-state-change', { botId: BOT_A, from: 'idle', to: 'sending' });
    expect(getLastReadSeq(BOT_A)).toBe(5);

    // Turn ends
    bus.emit('bot:turn-state-change', { botId: BOT_A, from: 'receiving', to: 'idle' });
    expect(getLastReadSeq(BOT_A)).toBe(5); // no new msgs, stays at 5

    // Second turn: new messages arrive
    mergeAssistant(BOT_A, [{ serverSeq: 12, text: 'Second batch' }]);
    bus.emit('bot:turn-state-change', { botId: BOT_A, from: 'idle', to: 'sending' });
    expect(getLastReadSeq(BOT_A)).toBe(12);

    // Turn ends with more messages
    mergeAssistant(BOT_A, [{ serverSeq: 15, text: 'Mid-turn msg' }]);
    bus.emit('bot:turn-state-change', { botId: BOT_A, from: 'receiving', to: 'idle' });
    expect(getLastReadSeq(BOT_A)).toBe(15);
  });
});

// ============================================================
// ISSUE-06: Page refresh — current bot legit unread not silently consumed (regression)
// SPEC: "When server provides lastReadSeq >= 0 and maxServerSeq > lastReadSeq,
// first load should treat as a 'switch-in' — trigger autoReadUnreadN or
// preserve lastReadSeq (not unconditionally advance)."
// Status: FIXED. Also tested in sc-badge-unread.test.ts SC-A-14.
// This is the mechanism-level regression test.
// ============================================================
describe('ISSUE-06: page refresh — legit unread not silently consumed', () => {
  it('server lastReadSeq >= 0 with messages beyond it → unread counted for non-current bot', () => {
    // SPEC: "lastReadSeq >= 0 && maxServerSeq > lastReadSeq → handle legitimate unread"
    // Regression: old code unconditionally advanced lastReadSeq to maxServerSeq on first init
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, 5); // Server says lastReadSeq=5

    // 3 messages beyond the watermark
    mergeAssistant(BOT_B, [
      { serverSeq: 6, text: 'Unread 1' },
      { serverSeq: 7, text: 'Unread 2' },
      { serverSeq: 8, text: 'Unread 3' },
    ]);

    // Non-current bot: all 3 are unread
    expect(getUnreadCount(BOT_B)).toBe(3);
    // lastReadSeq should NOT have advanced (non-current bot)
    expect(getLastReadSeq(BOT_B)).toBe(5);
  });

  it('server lastReadSeq < 0 (no server value) for non-current bot → baseline set, badge=0', () => {
    // SPEC: "(a) lastRead < 0 → push to maxServerSeq, skip TTS"
    // For non-current bot with no server lastReadSeq, the first-init
    // path sets baseline to maxServerSeq so history isn't counted as unread.
    // INV-BADGE-04 tests this for current bot; here we verify non-current.
    // The baseline is set in the chat:changed handler when lastReadSeq < 0.
    setCurrentBotId(BOT_A);
    setLastReadSeq(BOT_B, -1); // No server value

    mergeAssistant(BOT_B, [
      { serverSeq: 1, text: 'History 1' },
      { serverSeq: 2, text: 'History 2' },
    ]);

    // For non-current bot with lastReadSeq=-1, the badge handler
    // initializes baseline so history doesn't appear as unread.
    // Unread count should be 0 (history, not new messages).
    expect(getUnreadCount(BOT_B)).toBe(0);
  });
});
