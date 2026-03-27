// @vitest-environment jsdom
/**
 * INV-RENDER-01~02 mechanism tests
 *
 * INV-RENDER-01: ALL agent output (result, thinking, tool_call, intermediate)
 *                must render as role='assistant' (right-aligned, assistant bubble).
 *                Never display as user message.
 *
 * INV-RENDER-02: Messages rendered in chat must not briefly appear then vanish
 *                without user action. Merge/dedup must complete before render or
 *                be invisible (replace, not delete+rebuild).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock IndexedDB and localStorage before importing modules that use them
const _mockStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => _mockStorage.get(key) ?? null,
  setItem: (key: string, value: string) => { _mockStorage.set(key, value); },
  removeItem: (key: string) => { _mockStorage.delete(key); },
  clear: () => { _mockStorage.clear(); },
});
vi.stubGlobal('indexedDB', {
  open: () => {
    const req = { onsuccess: null as unknown, onerror: null as unknown, result: null };
    setTimeout(() => { if (typeof req.onerror === 'function') (req.onerror as () => void)(); }, 0);
    return req;
  },
});

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

import { chatStore } from '../store/chat-store';
import { addBotMsg } from '../ui/chat-renderer';
import { setGranularity } from '../ui/app-state';
import {
  setupTestBots, teardownTest, teardownIntegration,
  mockBrowserAPIs, wireRealWsDispatcher,
  BOT_A, BOT_B, wsMsg,
} from './helpers/test-setup';

const BOT = 'test-bot';

beforeEach(() => {
  mockBrowserAPIs();
  setupTestBots(BOT_A, BOT_B);
  chatStore.init([BOT, BOT_A, BOT_B]);
  chatStore.clearCache(BOT);
  chatStore.clearCache(BOT_A);
  chatStore.clearCache(BOT_B);
});
afterEach(() => teardownTest());

// ============================================================
// INV-RENDER-01: Agent Output Renders as Assistant
// Rule: ALL agent output (result, thinking, tool_call, intermediate)
//       must render as role='assistant'. Never display as user message.
//       Applies to both streaming and sync paths.
// ============================================================
describe('INV-RENDER-01: Agent output must render as role=assistant', () => {

  // -- chatStore addMessage path (sync/confirmed messages) --

  it('chatStore.addMessage preserves assistant role for all agent contentKinds', () => {
    // Spec: "ALL agent output ... must render as role=assistant"
    // Regression: if addMessage or _makeMsg overrides role based on contentKind
    //             or intermediate flag, messages end up with wrong role.
    const kinds = ['result', 'thinking', 'tool_call', 'intermediate'] as const;

    for (const kind of kinds) {
      const result = chatStore.addMessage(BOT, 'assistant', `Text for ${kind}`, {
        eventKey: `evt_kind_${kind}`,
        contentKind: kind,
        intermediate: kind !== 'result',
      }, { persist: false, notify: false });

      expect(result).not.toBeNull();
      expect(result!.msg.role).toBe('assistant');
    }

    // Also verify via getMessages — the retrieval path must agree
    const msgs = chatStore.getMessages(BOT);
    expect(msgs).toHaveLength(4);
    for (const msg of msgs) {
      expect(msg.role).toBe('assistant');
    }
  });

  // -- upsertMessage path (message_sync) --

  it('upsertMessage creates message with assistant role', () => {
    chatStore.upsertMessage(BOT, {
      eventKey: 'evt_upsert_01',
      role: 'assistant',
      text: 'Generating response...',
      serverSeq: 10,
    });

    const msgs = chatStore.getMessages(BOT);
    const msg = msgs.find(m => m.eventKey === 'evt_upsert_01');
    expect(msg).toBeDefined();
    expect(msg!.role).toBe('assistant');
  });
});

// ISSUE-16: (Removed) intermediate_step handler tests.
// intermediate_step WS handler has been removed — messages now arrive
// via message_sync / upsertMessage.

// ============================================================
// INV-RENDER-02: Rendered Messages Don't Flash-Disappear
// Rule: Messages rendered in chat must not briefly appear then vanish
//       without user action. Merge/dedup must complete before render or
//       be invisible (replace, not delete+rebuild).
// ============================================================
describe('INV-RENDER-02: Messages must not flash-disappear', () => {

  // -- Dedup: replace, not delete+rebuild --

  describe('mergeFromServer dedup — replace in place, no flicker', () => {

    it('same eventKey updates in-place, no duplicate created', () => {
      // Spec: "Merge/dedup must complete before render or be invisible (replace, not delete+rebuild)."
      // Regression: if Phase 2 creates a new entry instead of updating existing,
      //             users see duplicates or a flash of old + new.
      chatStore.mergeFromServer(BOT, [
        { role: 'assistant', text: 'Version 1', eventKey: 'evt_dedup', serverSeq: 5 },
      ], 1);

      chatStore.mergeFromServer(BOT, [
        { role: 'assistant', text: 'Version 2', eventKey: 'evt_dedup', serverSeq: 5 },
      ], 2);

      const msgs = chatStore.getMessages(BOT);
      const matches = msgs.filter(m => m.eventKey === 'evt_dedup');
      expect(matches).toHaveLength(1);
      expect(matches[0].text).toBe('Version 2');
    });

    it('three identical merges produce exactly one message per eventKey', () => {
      // Spec: "replace, not delete+rebuild"
      // Regression: if dedup logic has an off-by-one or race, repeated merges
      //             could accumulate duplicates.
      const payload = [
        { role: 'user', text: 'Q', eventKey: 'q_dup', serverSeq: 1 },
        { role: 'assistant', text: 'A', eventKey: 'a_dup', serverSeq: 2 },
      ];
      chatStore.mergeFromServer(BOT, payload, 1);
      chatStore.mergeFromServer(BOT, payload, 1);
      chatStore.mergeFromServer(BOT, payload, 1);

      const msgs = chatStore.getMessages(BOT);
      expect(msgs).toHaveLength(2);
    });

    it('mergeFromServer updates text content without removing and re-adding', () => {
      // Spec: "replace, not delete+rebuild"
      // Regression: if the update deletes then inserts, there's a frame where
      //             the message doesn't exist, causing a visual flash.
      chatStore.mergeFromServer(BOT, [
        { role: 'assistant', text: 'Original text', eventKey: 'evt_update', serverSeq: 10 },
      ], 1);

      const msgsBefore = chatStore.getMessages(BOT);
      expect(msgsBefore).toHaveLength(1);

      chatStore.mergeFromServer(BOT, [
        { role: 'assistant', text: 'Updated text', eventKey: 'evt_update', serverSeq: 10 },
      ], 2);

      const msgsAfter = chatStore.getMessages(BOT);
      expect(msgsAfter).toHaveLength(1);
      expect(msgsAfter[0].text).toBe('Updated text');
    });
  });

  // -- Cross-bot isolation --

  describe('cross-bot isolation during merge', () => {

    it('mergeFromServer on BOT_A does not affect BOT_B messages', () => {
      chatStore.addMessage(BOT_A, 'assistant', 'A reply', {
        eventKey: 'a_01', serverSeq: 1,
      }, { persist: false, notify: false });
      chatStore.addMessage(BOT_B, 'assistant', 'B reply', {
        eventKey: 'b_01', serverSeq: 1,
      }, { persist: false, notify: false });

      chatStore.mergeFromServer(BOT_A, [
        { role: 'user', text: 'New A msg', eventKey: 'a_02', serverSeq: 2 },
      ], 2);

      const bMsgs = chatStore.getMessages(BOT_B);
      expect(bMsgs).toHaveLength(1);
      expect(bMsgs[0].eventKey).toBe('b_01');
    });
  });
});

// ISSUE-17: (Removed) _sessionCreatedKeys/Phase 4 tests.
// Streaming infrastructure and Phase 4 cleanup have been removed —
// messages now arrive via message_sync / upsertMessage.
